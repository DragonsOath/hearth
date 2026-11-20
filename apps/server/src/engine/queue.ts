import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Codex,
  ClaudeCode,
  FakeRunner,
  OllamaClaude,
  emptyResult,
  killTree,
  type ExecResult,
  type ProjectSettings,
  type RunOptions,
  type Runner,
  type AskLevel,
  isAskLevel,
} from "./runners";
import type { OllamaConfig } from "./ollama";
import { now, TransitionError, type EngineStore, type Message, type Task } from "./store";
import type { Projects } from "./projects";

/**
 * The engine's task queue (ported from EMBER). Rules that never bend:
 *  - a task counts as succeeded only with evidence: exit code 0 and a final result that is not an error;
 *  - a task found running when Hearth starts was interrupted, never done: it waits for the owner to
 *    retry, resume or cancel it, and any leftover agent process is stopped;
 *  - usage-limit and sign-in errors pause the queue instead of retrying;
 *  - three failures in a row pause the queue.
 */

const STOP_RE =
  /\b(I stopped|stopped before|stopping here|couldn'?t (start|build|continue|proceed)|can'?t (start|build|continue|proceed)|blocked|was refused|were refused|was denied)\b/i;

export class QueueError extends Error {}

export interface EngineInfo {
  label: string;
  binary: string | null;
  enabled: boolean;
  models: string[];
}

export interface QueueConfig {
  engines: Record<string, EngineInfo>;
  /** Ollama's address and model (Claude Code runs on it); null until set up. */
  ollama?: () => OllamaConfig | null;
  /** The Hearth memory program from Claude Code's add-on, given to Codex too; null without it. */
  companion?: () => string | null;
  /** Hearth's tools for a run (the Lair's tools), when Hearth's agent service is running. */
  hearth?: (
    engine: string,
  ) => Promise<{ url: string; key: string; release: () => Promise<void> } | null>;
  /** "Turn on persona": the chosen picture's persona for every run (none when off). */
  persona?: () => Promise<string | undefined>;
  /** Folder where held uploads wait until they are given to a task. */
  uploads: string;
  timeoutMinutes: number;
  maxAttempts: number;
  dailyCap: number;
  /** Like Claude Code in a terminal: commands and edits in the project folder without asking. */
  permissionMode: string;
  allowedTools: string[];
  codexSandbox: string;
  /** A task whose text matches one of these waits for the owner's approval first. */
  risky: RegExp[];
}

export const DEFAULT_ALLOWED_TOOLS = [
  "Bash",
  "PowerShell",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  // Hearth's memory (the homelab add-on), so every session can recall and save.
  "mcp__plugin_dragon-control_dragon-control",
];

export const DEFAULT_RISKY = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bsystemctl\b/i,
  /\bdocker\b/i,
  /\bgit\s+push\b/i,
  /\bdeploy\b/i,
  /\bdelete\b/i,
  /\bdrop\s+table\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
];

export const titleOf = (prompt: string) => {
  const line = prompt.trim().split("\n")[0] ?? "task";
  return line.slice(0, 90) + (line.length > 90 ? "…" : "");
};

export type Broadcast = (event: Record<string, unknown>) => void;

export class EngineQueue {
  readonly running = new Map<number, AbortController>();
  private runners: Record<string, Runner> = {};
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private ticking = false;
  /** Nothing runs until start(), so startup recovery always comes first. */
  private started = false;
  /** Rate-limit details from Claude's last run (the usage monitor reads them). */
  onRateLimit?: (info: Record<string, unknown>) => void;
  /** Runs before each task: the project's memory files are brought up to date. */
  beforeRun?: (project: string) => void;

  constructor(
    private readonly store: EngineStore,
    private readonly projects: Projects,
    readonly cfg: QueueConfig,
    private readonly broadcast: Broadcast,
  ) {
    this.refreshRunners();
  }

  refreshRunners() {
    const c = this.cfg.engines["claude-code"]?.binary;
    const x = this.cfg.engines.codex?.binary;
    const o = this.cfg.engines.ollama?.binary;
    const ollama = this.cfg.ollama ?? (() => null);
    this.runners = {
      ...(c ? { "claude-code": new ClaudeCode(c) } : {}),
      ...(x ? { codex: new Codex(x, this.cfg.companion) } : {}),
      ...(o ? { ollama: new OllamaClaude(o, ollama) } : {}),
    };
  }

  /** Tests: Claude Code is a stand-in that answers at once. */
  useFake() {
    // Ollama goes through the same stand-in once it is set up (it is Claude Code underneath).
    this.runners = { "claude-code": new FakeRunner(), ollama: new FakeRunner() };
  }

  /* ---------- state ---------- */

  get paused() {
    return this.store.setting("paused", false);
  }

  /**
   * The agent is never held back (11-06): War Room and Lair always run the full Claude Code,
   * Codex, or Ollama. What the owner chooses is what it asks before acting (askLevel).
   */
  get fullAccess() {
    return true;
  }

  /** What the AI asks before acting. Before 11-06 it was a switch: on is Free, off is Strict. */
  get askLevel(): AskLevel {
    const level = this.store.setting<string | null>("ask_level", null);
    if (isAskLevel(level)) return level;
    return this.store.setting("full_access", false) ? "free" : "strict";
  }

  setAskLevel(level: AskLevel) {
    this.store.setSetting("ask_level", level);
    this.emitStatus();
  }

  /** The old switch: on is Free, off is Strict. */
  setFullAccess(on: boolean) {
    this.setAskLevel(on ? "free" : "strict");
  }

  capToday() {
    return this.cfg.dailyCap + this.store.usage("cap_extra");
  }

  status() {
    return {
      paused: this.paused,
      pause_reason: this.store.setting("pause_reason", ""),
      counts: this.store.counts(),
      running: [...this.running.keys()],
      tasks_today: this.store.usage("task_start"),
      daily_cap: this.capToday(),
      fail_streak: this.store.setting("fail_streak", 0),
      full_access: this.askLevel === "free",
      ask_level: this.askLevel,
    };
  }

  private emitTask(t?: Task) {
    if (t) this.broadcast({ type: "task", task: publicTask(t) });
  }
  private emitStatus() {
    this.broadcast({ type: "queue", status: this.status() });
  }

  setPaused(paused: boolean, reason = "") {
    this.store.setSetting("paused", paused);
    this.store.setSetting("pause_reason", paused ? reason : "");
    if (!paused) this.store.setSetting("fail_streak", 0);
    this.emitStatus();
    this.wake();
  }

  /* ---------- start and stop ---------- */

  /** Hearth started: anything left "running" was interrupted, never done. */
  recover() {
    for (const t of this.store.byState("running")) {
      let killed = "";
      if (t.pid && killTree(t.pid, true)) killed = `; stopped leftover agent process ${t.pid}`;
      this.store.transition(t.id, "interrupted", {
        actor: "recovery",
        detail: "Hearth restarted while this task was running; not counted as done" + killed,
        fields: { error: "interrupted by a Hearth restart", finished_at: now(), pid: null },
      });
      this.store.log(
        t.id,
        "error",
        "Interrupted: Hearth restarted while this task was running. Retry, resume or cancel it.",
      );
    }
  }

  start() {
    this.started = true;
    this.timer = setInterval(() => this.wake(), 2000);
    this.wake();
  }

  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const [id, ctl] of this.running) {
      const t = this.store.get(id);
      if (t?.pid) killTree(t.pid, true);
      ctl.abort();
      try {
        this.store.transition(id, "interrupted", {
          actor: "shutdown",
          detail: "Hearth was stopped while this task was running; not counted as done",
          fields: { error: "interrupted by Hearth stopping", finished_at: now(), pid: null },
        });
        this.store.log(id, "error", "Interrupted: Hearth stopped while this task was running.");
      } catch {
        /* already settled */
      }
    }
  }

  wake() {
    if (!this.started || this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      this.tick();
    } finally {
      this.ticking = false;
    }
  }

  /* ---------- the owner's actions ---------- */

  settingsFor(project: string): ProjectSettings {
    const p = this.projects.get(project);
    const extra = this.store.setting<string[]>(`allow:${project}`, []);
    if (this.fullAccess)
      return {
        path: p.path,
        permissionMode: "bypassPermissions",
        allowedTools: [],
        codexSandbox: this.cfg.codexSandbox,
        fullAccess: true,
        askLevel: this.askLevel,
      };
    return {
      path: p.path,
      permissionMode: this.cfg.permissionMode,
      allowedTools: [...new Set([...this.cfg.allowedTools, ...extra])],
      codexSandbox: this.cfg.codexSandbox,
    };
  }

  engineFor(
    project: string,
    engine?: string | null,
    model?: string | null,
  ): [string, string | null] {
    const p = this.projects.get(project);
    const name = engine || p.engine || "claude-code";
    const e = this.cfg.engines[name];
    if (!e) throw new QueueError(`unknown engine '${name}'`);
    if (!e.binary) throw new QueueError(`${e.label} isn't installed on this computer`);
    if (!e.enabled) throw new QueueError(`${e.label} is switched off in Hearth`);
    if (model && e.models.length && !e.models.includes(model))
      throw new QueueError(`'${model}' is not a ${e.label} model (${e.models.join(", ")})`);
    return [name, model || (name === p.engine ? p.model : null)];
  }

  /**
   * Held uploads (uploads/...) are copied into the project's attachments/<date>/ folder; paths
   * already inside the project's attachments/ are kept. Returns project-relative paths.
   */
  checkAttachments(project: string, paths: string[]): string[] {
    const root = path.resolve(this.projects.get(project).path);
    const held = path.resolve(this.cfg.uploads);
    return paths.map((rel) => {
      if (rel.startsWith("uploads/")) {
        const src = path.resolve(path.dirname(held), rel);
        if (!src.startsWith(held + path.sep) || !existsSync(src))
          throw new QueueError(`upload not found: ${rel}`);
        const base = path.basename(src);
        const name = base.includes("-") ? base.slice(base.indexOf("-") + 1) : base;
        const destDir = path.join(root, "attachments", path.basename(path.dirname(src)));
        mkdirSync(destDir, { recursive: true });
        let dest = path.join(destDir, name);
        const dot = name.lastIndexOf(".");
        for (let n = 2; existsSync(dest) && !sameFile(dest, src); n++)
          dest = path.join(
            destDir,
            dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`,
          );
        if (!existsSync(dest)) copyFileSync(src, dest);
        return path.relative(root, dest).split(path.sep).join("/");
      }
      const f = path.resolve(root, rel);
      if (!rel.startsWith("attachments/") || !f.startsWith(root + path.sep) || !existsSync(f))
        throw new QueueError(`attachment not found in this project: ${rel}`);
      return rel;
    });
  }

  add(
    prompt: string,
    o: {
      project: string;
      source: string;
      actor: string;
      title?: string;
      requireApproval?: boolean;
      model?: string | null;
      engine?: string | null;
      attachments?: string[];
      conversation?: boolean;
    },
  ): Task {
    prompt = prompt.trim();
    if (!prompt) throw new QueueError("empty task");
    this.projects.get(o.project);
    const [engine, model] = this.engineFor(o.project, o.engine, o.model);
    const attachments = this.checkAttachments(o.project, o.attachments ?? []);
    if (attachments.length)
      prompt +=
        "\n\nAttached files (paths relative to this project folder; open them with your file tools):\n" +
        attachments.map((a) => `- ${a}`).join("\n");
    const reasons: string[] = [];
    if (o.requireApproval) reasons.push("approval requested");
    // Free: the AI asks in its reply before serious steps, instead of a word match. Strict and
    // Moderate also hold a message with risky words until the owner approves it.
    const hits = (this.askLevel === "free" ? [] : this.cfg.risky)
      .filter((r) => r.test(prompt))
      .map((r) => r.source.replace(/\\b/g, "").replace(/\\s\+/g, " "));
    if (hits.length) reasons.push("risky words: " + hits.join(", "));
    const t = this.store.addTask({
      title: o.title ?? titleOf(prompt),
      prompt,
      project: o.project,
      engine,
      model,
      maxAttempts: this.cfg.maxAttempts,
      needsApproval: reasons.length > 0,
      approvalReason: reasons.join("; ") || null,
      source: o.source,
      actor: o.actor,
      attachments,
      conversation: o.conversation,
    });
    this.emitTask(t);
    this.emitStatus();
    this.wake();
    return t;
  }

  act(id: number, action: string, actor: string): Task {
    const t = this.store.get(id);
    if (!t) throw new QueueError(`no task ${id}`);
    try {
      if (action === "approve")
        this.store.transition(id, "queued", {
          actor,
          detail: "approved",
          fields: { approved_by: actor, approved_at: now() },
        });
      else if (action === "cancel") {
        const ctl = this.running.get(id);
        if (t.state === "running" && ctl) {
          ctl.abort(); // the runner records the cancellation
          this.store.note(id, actor, "cancel requested");
        } else
          this.store.transition(id, "cancelled", {
            actor,
            detail: "cancelled",
            fields: { finished_at: now() },
          });
      } else if (action === "retry" || action === "resume") {
        const resume = action === "resume" && Boolean(t.session_id);
        this.store.transition(id, "queued", {
          actor,
          detail: resume ? "resume previous session" : "retry from scratch",
          fields: { resume: resume ? 1 : 0, attempts: 0, error: null },
        });
      } else if (action === "up" || action === "down" || action === "top")
        this.store.move(id, action);
      else throw new QueueError(`unknown action ${action}`);
    } catch (e) {
      if (e instanceof TransitionError) throw new QueueError(e.message);
      throw e;
    }
    this.emitTask(this.store.get(id));
    this.emitStatus();
    this.wake();
    return this.store.get(id)!;
  }

  killSwitch(actor: string) {
    this.setPaused(true, "kill switch");
    for (const [id, ctl] of this.running) {
      this.store.note(id, actor, "kill switch");
      ctl.abort();
    }
  }

  /* ---------- the worker ---------- */

  private tick() {
    if (this.paused || this.running.size >= 1) return;
    const busy = new Set([...this.running.keys()].map((i) => this.store.get(i)?.project ?? ""));
    const t = this.store.nextQueued(busy);
    if (!t) return;
    if (this.store.usage("task_start") >= this.capToday()) {
      this.setPaused(true, `daily cap of ${this.capToday()} task starts reached`);
      return;
    }
    const ctl = new AbortController();
    this.running.set(t.id, ctl);
    void this.runTask(t, ctl);
  }

  private async runTask(task: Task, ctl: AbortController) {
    const id = task.id;
    let settings: ProjectSettings;
    try {
      settings = this.settingsFor(task.project);
      if (!existsSync(settings.path))
        throw new QueueError(`project folder ${settings.path} does not exist`);
    } catch (e) {
      this.running.delete(id);
      this.store.transition(id, "running", { actor: "worker", detail: "start" });
      this.store.transition(id, "failed", {
        actor: "worker",
        detail: (e as Error).message,
        fields: { error: (e as Error).message, finished_at: now() },
      });
      this.emitTask(this.store.get(id));
      return;
    }
    let resume = task.resume && task.session_id ? task.session_id : null;
    const convoKey = `session:${task.project}:${task.engine}`;
    // Continue the project's conversation, like the terminal.
    if (task.conversation && !resume) resume = this.store.setting<string | null>(convoKey, null);
    const t = this.store.transition(id, "running", {
      actor: "worker",
      detail: `attempt ${task.attempts + 1} in ${settings.path}` + (resume ? " (resume)" : ""),
      fields: {
        attempts: task.attempts + 1,
        started_at: now(),
        heartbeat_at: now(),
        finished_at: null,
        resume: 0,
      },
    });
    this.store.bumpUsage("task_start");
    this.emitTask(t);
    this.emitStatus();

    const onLine = (kind: string, text: string) => {
      const entry = this.store.log(id, kind, text);
      this.broadcast({ type: "log", entry });
    };
    const beat = setInterval(() => this.store.update(id, { heartbeat_at: now() }), 5000);
    try {
      this.beforeRun?.(task.project);
    } catch {
      /* the project's memory files are a help, never a blocker */
    }
    const runner = this.runners[task.engine];
    const label = this.cfg.engines[task.engine]?.label ?? task.engine;
    onLine(
      "system",
      `starting ${label} in ${settings.path} with ${task.model ?? "its default model"}`,
    );
    let res: ExecResult;
    const attachments = task.attachments ? (JSON.parse(task.attachments) as string[]) : [];
    // Hearth's tools, the same as the Lair's, for this run only (never fatal when missing).
    const tools = runner ? await this.cfg.hearth?.(task.engine).catch(() => null) : null;
    let hearth: RunOptions["hearth"];
    if (tools) {
      const dir = mkdtempSync(path.join(tmpdir(), "hearth-tools-"));
      const config = path.join(dir, "mcp.json");
      writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            hearth: {
              type: "http",
              url: tools.url,
              headers: { Authorization: `Bearer ${tools.key}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      hearth = { url: tools.url, key: tools.key, config };
    }
    const persona = await this.cfg.persona?.().catch(() => undefined);
    const runOnce = (from: string | null) =>
      runner!.run({
        ...(hearth ? { hearth } : {}),
        ...(persona ? { persona } : {}),
        prompt: task.conversation ? this.withHandoff(task, Boolean(from), onLine) : task.prompt,
        cwd: settings.path,
        model: task.model,
        project: settings,
        resume: from,
        attachments,
        timeoutMs: this.cfg.timeoutMinutes * 60_000,
        signal: ctl.signal,
        onLine,
        onStart: (pid) => this.store.update(id, { pid }),
        onSession: (sid) => this.store.update(id, { session_id: sid }),
        onRateLimit: (info) => {
          this.store.setSetting("rate_limit", info);
          this.onRateLimit?.(info);
        },
      });
    try {
      if (!runner) {
        res = {
          ...emptyResult(),
          errorKind: "crash",
          error: `${label} isn't installed on this computer`,
        };
      } else {
        res = await runOnce(resume);
        if (
          resume &&
          task.conversation &&
          res.errorKind &&
          !res.sawResult &&
          res.errorKind !== "cancelled"
        ) {
          // The saved conversation couldn't be resumed (expired or removed): start a fresh one.
          onLine("system", "previous conversation unavailable; starting a fresh one");
          this.store.setSetting(convoKey, null);
          res = await runOnce(null);
        }
        if (task.conversation && res.sessionId && res.sawResult)
          this.store.setSetting(convoKey, res.sessionId);
      }
    } catch (e) {
      res = {
        ...emptyResult(),
        errorKind: "crash",
        error: `runner error: ${(e as Error).message}`,
      };
    } finally {
      clearInterval(beat);
      if (hearth) rmSync(path.dirname(hearth.config), { recursive: true, force: true });
      await tools?.release().catch(() => undefined);
    }
    this.finish(id, res, onLine);
  }

  /**
   * Switching AIs keeps the conversation (11-07: "if I switch over I want the new LLM to have
   * the same context as the previous one"). Each AI keeps its own session, so before a turn it is
   * given what was said in the project's conversation since it last answered: the owner's
   * messages and the other AIs' answers. A fresh session gets the conversation so far.
   */
  private withHandoff(task: Task, resuming: boolean, onLine: (k: string, t: string) => void) {
    const list = this.store.messages(task.project, 80);
    // The owner's newest message is this turn's prompt: it goes on its own, after the rest.
    let cut = list.length;
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i]!.role === "you") {
        cut = i;
        break;
      }
    const before = list.slice(0, cut).filter((m) => m.role !== "ask");
    const engineOf = (m: Message) =>
      m.task_id !== null ? (this.store.get(m.task_id)?.engine ?? null) : null;
    const own = (m: Message) => m.role === "ember" && engineOf(m) === task.engine;
    // What it already saw: everything up to its own last answer.
    let from = 0;
    for (let i = before.length - 1; i >= 0; i--)
      if (own(before[i]!)) {
        from = i + 1;
        break;
      }
    const missed = before.slice(from);
    const others = missed.some((m) => m.role === "ember" && !own(m));
    // A session it continues already holds its own turns: only the other AIs' turns are news.
    if (!missed.length || (resuming && !others)) return task.prompt;
    const name = (m: Message) =>
      m.role === "you"
        ? "Owner"
        : m.role === "sys"
          ? "Hearth"
          : (m.meta?.split(" · ")[0]?.trim() || "Assistant").replace(/^quick$/, "Quick answer");
    const lines: string[] = [];
    let size = 0;
    for (let i = missed.length - 1; i >= 0 && size < 24_000; i--) {
      const m = missed[i]!;
      const text = m.text.length > 3000 ? `${m.text.slice(0, 3000)} [cut]` : m.text;
      lines.unshift(`${name(m)}: ${text}`);
      size += text.length;
    }
    onLine(
      "system",
      `handing over ${lines.length} earlier message${lines.length === 1 ? "" : "s"} from this conversation`,
    );
    return [
      resuming
        ? "While you were away, the owner went on with this project's conversation with other AIs in Hearth's War Room. Here is what was said since your last answer; you did not see it:"
        : "This is the project's conversation so far in Hearth's War Room (some of it with other AIs). You are joining it now; you did not see it:",
      "<earlier-conversation>",
      lines.join("\n\n"),
      "</earlier-conversation>",
      "Carry on from there. The owner's new message:",
      task.prompt,
    ].join("\n\n");
  }

  private finish(id: number, res: ExecResult, onLine: (k: string, t: string) => void) {
    if (this.stopping) return;
    const common = {
      finished_at: now(),
      pid: null,
      exit_code: res.exitCode,
      session_id: res.sessionId,
      cost_usd: res.costUsd,
      result: res.result || null,
    };
    let state: "succeeded" | "failed" | "cancelled" = "failed";
    let detail = res.error;
    if (res.errorKind === null) {
      if (res.denials.length && STOP_RE.test(res.result)) {
        // It finished cleanly but says it stopped because a command was refused: not done.
        res.errorKind = "blocked";
        detail =
          "blocked: a command it needed was refused (" +
          res.denials
            .slice(0, 3)
            .map((d) => d.slice(0, 120))
            .join("; ") +
          "). Allow it, then retry.";
      } else {
        state = "succeeded";
        detail = "exit 0, final result received";
        if (res.denials.length)
          detail += `; ${res.denials.length} command(s) were refused along the way`;
      }
    } else if (res.errorKind === "cancelled") state = "cancelled";
    if (res.deniedTools.length && state !== "cancelled")
      this.store.setSetting(`denied:${id}`, {
        tools: res.deniedTools,
        calls: res.denials.slice(0, 5),
      });
    let t: Task;
    try {
      t = this.store.transition(id, state, {
        actor: "worker",
        detail,
        fields: { ...common, error: state === "succeeded" ? null : detail },
      });
    } catch {
      // Someone else already settled this task (recovery or shutdown); keep their verdict.
      this.running.delete(id);
      return;
    }
    onLine(state === "succeeded" ? "system" : "error", `${state}: ${detail}`);
    this.running.delete(id);

    if (state === "succeeded") this.store.setSetting("fail_streak", 0);
    else if (state === "failed") {
      const streak = this.store.setting("fail_streak", 0) + 1;
      this.store.setSetting("fail_streak", streak);
      if (res.errorKind === "limit" || res.errorKind === "auth")
        this.setPaused(
          true,
          `${res.errorKind === "limit" ? "usage limit" : "sign-in problem"}: ${detail.slice(0, 160)}`,
        );
      else if (streak >= 3) this.setPaused(true, "three failures in a row");
      else if (
        t.attempts < t.max_attempts &&
        ["crash", "timeout", "agent"].includes(res.errorKind ?? "")
      ) {
        this.store.transition(id, "queued", {
          actor: "auto-retry",
          detail: `attempt ${t.attempts} of ${t.max_attempts} failed; retrying`,
        });
        onLine("system", "queued again for an automatic retry");
      }
    }
    const final = this.store.get(id)!;
    this.emitTask(final);
    this.emitStatus();
    this.broadcast({ type: "task_done", task: publicTask(final) });
    this.wake();
  }
}

function sameFile(a: string, b: string) {
  try {
    return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** A task as the War Room sees it (booleans for its flags). */
export function publicTask(t: Task) {
  return { ...t, conversation: Boolean(t.conversation) };
}
