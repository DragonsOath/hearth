import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { lookPersonaInstruction } from "@dragon-control/core";
import { COMPANION_NOTE, codexCompanionArgs } from "./companion";
import { type OllamaConfig, ollamaEnv } from "./ollama";

/**
 * Runs Claude Code, Codex, or Claude Code on Ollama headless in a project folder (ported from EMBER's executor) and turns
 * their JSON stream into progress lines. One process per task, in its own process group, so
 * stopping a task stops everything it started. Works on Linux and Windows.
 *
 * Claude Code runs as the full Claude Code: its own tools, and the owner's own settings,
 * add-ons and MCP servers (Hearth's memory among them), exactly as in a terminal.
 */

export const SYSTEM_NOTE =
  "You are Claude Code running inside Hearth, the owner's homelab control center. The owner is chatting with " +
  "you from Hearth's War Room; treat each message like one typed into a Claude Code terminal in this project " +
  "folder, and continue the conversation naturally. You can't ask questions mid-run, so make sensible choices " +
  "and say what you assumed; if you genuinely need the owner's decision, ask it at the end of your reply and " +
  "stop. If a command is refused, skip that step, finish the rest, and say what was skipped. Keep the final " +
  "reply short and plain: what you did, and which file to open to see it.";

/**
 * Hearth's own guide for the AI (docs/HEARTH_FOR_AI.md): its pages, buttons and settings, so
 * "why is memory so high" gets "press Free voice memory" (10-26). Found beside the built
 * server (apps/server/dist) or the source (apps/server/src/engine); none in odd layouts.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const HEARTH_GUIDE_PATH = [
  path.join(here, "..", "..", "..", "docs", "HEARTH_FOR_AI.md"),
  path.join(here, "..", "..", "..", "..", "docs", "HEARTH_FOR_AI.md"),
].find((p) => existsSync(p));
/**
 * The full manual (docs/HEARTH_MANUAL.md): every page, panel, button and setting, too long to send
 * with each message. The guide says where it is, so the AI reads the part it needs.
 */
export const HEARTH_MANUAL_PATH = HEARTH_GUIDE_PATH
  ? path.join(path.dirname(HEARTH_GUIDE_PATH), "HEARTH_MANUAL.md")
  : undefined;
let guideText: string | undefined;
export function hearthGuide(): string {
  if (guideText === undefined) {
    try {
      guideText = HEARTH_GUIDE_PATH ? readFileSync(HEARTH_GUIDE_PATH, "utf8") : "";
      if (guideText && HEARTH_MANUAL_PATH && existsSync(HEARTH_MANUAL_PATH))
        guideText +=
          `\n\nThe full manual, with every page, panel, button and setting, is ${HEARTH_MANUAL_PATH}. ` +
          "The hearth_help tool returns its sections with live facts; read the manual directly " +
          "when hearth_help is not available or found nothing. " +
          'Answer "What can Hearth do?" from its first section.\n';
    } catch {
      guideText = "";
    }
  }
  return guideText;
}

/**
 * The guide as a file for --append-system-prompt-file (War Room agents): the guide plus where the
 * manual is, written once to the temp folder.
 */
let guideFile: string | undefined;
export function hearthGuideFile(): string | undefined {
  if (guideFile !== undefined) return guideFile || undefined;
  const text = hearthGuide();
  if (!text) {
    guideFile = "";
    return undefined;
  }
  try {
    const f = path.join(tmpdir(), `hearth-guide-${process.pid}.md`);
    writeFileSync(f, text);
    guideFile = f;
  } catch {
    guideFile = HEARTH_GUIDE_PATH ?? "";
  }
  return guideFile || undefined;
}

/**
 * What the AI asks before acting (11-06): the agent is never held back; the owner only
 * chooses what it stops to ask about first, in its reply. Strict: every change. Moderate: what
 * could be risky. Free: only what could be devastating or can't be put back.
 */
export const ASK_LEVELS = ["strict", "moderate", "free"] as const;
export type AskLevel = (typeof ASK_LEVELS)[number];
export const isAskLevel = (v: unknown): v is AskLevel =>
  typeof v === "string" && (ASK_LEVELS as readonly string[]).includes(v);

const ASK_HOW =
  "stop first: in your reply, say exactly what you would do and what could go wrong, and ask " +
  "the owner. Continue only after they say yes.";

export function askNote(level: AskLevel): string {
  const base = "You can use every tool and run any command without a permission prompt. ";
  if (level === "strict")
    return (
      base +
      "The owner chose to be asked before every change. Reading, searching, and looking need no " +
      "question. Before anything that changes something (writing or editing a file, a command " +
      "that changes state, a setting in any app, installing, starting, stopping, restarting, or " +
      "deleting anything), " +
      ASK_HOW
    );
  if (level === "moderate")
    return (
      base +
      "The owner chose to be asked before anything risky. Routine, easily undone work (reading, " +
      "editing files in the working folder, running builds and tests) needs no question. Before " +
      "anything risky (restarting or stopping services or containers, changing an app's " +
      "settings, installing or removing software, deleting or overwriting data, changing system, " +
      "network, firewall, VPN or proxy configuration, pushing code, or using sudo), " +
      ASK_HOW
    );
  return (
    base +
    "The owner chose to be asked only before serious consequences. Before anything that could be " +
    "devastating or cannot be put back (deleting or overwriting data, wiping or formatting, " +
    "removing containers or volumes, dropping databases, force-pushing, changing system, " +
    "network, firewall, VPN or proxy configuration, or using sudo), " +
    ASK_HOW +
    " Everything else needs no question."
  );
}

/** The old Full access note: the Free level. */
export const FULL_ACCESS_NOTE = askNote("free");

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const LIMIT_RE = /usage limit|rate limit|limit reached|quota|too many requests|overloaded/i;
const AUTH_RE =
  /not logged in|please run \/login|authentication|invalid api key|unauthori[sz]ed|oauth/i;

export type LineKind = "system" | "text" | "tool" | "output" | "error" | "result" | "raw";

export interface ExecResult {
  exitCode: number | null;
  isError: boolean;
  result: string;
  sessionId: string | null;
  costUsd: number | null;
  turns: number | null;
  /** limit | auth | timeout | cancelled | crash | agent | check | blocked */
  errorKind: string | null;
  error: string;
  sawResult: boolean;
  stderr: string;
  /** Tool calls the permission rules refused, and the names of those tools. */
  denials: string[];
  deniedTools: string[];
  lastTool: string;
  lastToolName: string;
}

export const emptyResult = (): ExecResult => ({
  exitCode: null,
  isError: true,
  result: "",
  sessionId: null,
  costUsd: null,
  turns: null,
  errorKind: null,
  error: "",
  sawResult: false,
  stderr: "",
  denials: [],
  deniedTools: [],
  lastTool: "",
  lastToolName: "",
});

export interface ProjectSettings {
  path: string;
  permissionMode: string;
  allowedTools: string[];
  codexSandbox: string;
  /** The full agent: every tool, no prompts; it asks in its reply as askLevel says. */
  fullAccess?: boolean;
  /** What it asks the owner before acting (the owner's choice; Free when absent). */
  askLevel?: AskLevel;
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  model: string | null;
  project: ProjectSettings;
  resume: string | null;
  attachments: string[];
  timeoutMs: number;
  signal: AbortSignal;
  onLine: (kind: LineKind, text: string) => void;
  onStart: (pid: number) => void;
  onSession?: (id: string) => void;
  onRateLimit?: (info: Record<string, unknown>) => void;
  /** Hearth's tools for this run (the same as the Lair's): its address, key, and config file. */
  hearth?: { url: string; key: string; config: string };
  /** "Turn on persona": the chosen picture's persona, as the Lair uses it (style only). */
  persona?: string;
}

/** What the agent is told about Hearth's tools when it has them. */
export const HEARTH_TOOLS_NOTE =
  "You also have Hearth's own tools (the hearth MCP server): the homelab's live state, findings, the to-do list, host administration, and app_api, which sends any request to a connected app's own API (Sonarr, Radarr, Lidarr, Chaptarr, qBittorrent, Plex, Jellyfin, Home Assistant and the rest) with its Secure Vault key, which you never see. Use them for homelab work instead of hunting for keys or config files. Changes inside apps: with Full access on, app_api does what the owner asked directly; otherwise propose a plan (propose_job) for the owner to approve. When something needs Full access and it is off, tell the owner: " +
  "\"This action requires Full access. If that's what you want, turn on Full access in Settings, Ember, Full access (/settings#full-access), or tick Full access under the War Room's message box, then ask me again.\"";

/** The child starts as its own session: none of the parent Claude session's variables. */
export function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !(k.startsWith("CLAUDE") || k === "ANTHROPIC_API_KEY"),
    ),
  );
}

/** Where a program is: an explicit path, the PATH, or the usual install folders. */
export function findBinary(name: string, given?: string): string | null {
  if (given) return existsSync(given) ? given : null;
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(homedir(), ".local", "bin"),
    path.join(homedir(), ".npm-global", "bin"),
    ...(win ? [path.join(process.env.APPDATA ?? "", "npm")] : ["/usr/local/bin", "/usr/bin"]),
  ].filter(Boolean);
  for (const d of dirs)
    for (const e of exts) {
      const f = path.join(d, name + e);
      if (existsSync(f)) return f;
    }
  return null;
}

/** Stops a task's whole process tree. */
export function killTree(pid: number, force = false) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

export function summarizeTool(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const i = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "description"]) {
    if (i[key]) return `${name}: ${String(i[key]).replace(/\n/g, " ").slice(0, 240)}`;
  }
  if (name === "TodoWrite" && Array.isArray(i.todos))
    return (
      "TodoWrite: " +
      (i.todos as { status?: string; content?: string }[])
        .map((t) => `[${(t.status ?? "").slice(0, 1)}] ${t.content ?? ""}`)
        .join("; ")
    ).slice(0, 400);
  return name;
}

function toolResultText(block: Record<string, unknown>): string {
  let c = block.content;
  if (Array.isArray(c)) c = c.map((x: { text?: string }) => x?.text ?? "").join(" ");
  return String(c ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Runner {
  name: string;
  binary: string;
  run(o: RunOptions): Promise<ExecResult>;
}

abstract class StreamRunner implements Runner {
  abstract name: string;
  constructor(readonly binary: string) {}
  protected abstract build(o: RunOptions): string[];
  protected abstract handle(ev: Record<string, unknown>, res: ExecResult, o: RunOptions): void;
  protected finish(_res: ExecResult) {}
  /** What goes in on stdin: the message (Codex adds Hearth's guide to a new conversation). */
  protected input(o: RunOptions): string {
    return o.prompt;
  }
  /** The program's environment (Ollama adds where its models are). */
  protected env(_o?: RunOptions): NodeJS.ProcessEnv {
    return cleanEnv();
  }

  run(o: RunOptions): Promise<ExecResult> {
    const res = emptyResult();
    let child: ChildProcess;
    try {
      child = spawn(this.binary, this.build(o), {
        cwd: o.cwd,
        env: this.env(o),
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group on Linux (so the group can be stopped); no console window on Windows.
        detached: process.platform !== "win32",
        windowsHide: true,
        // .cmd shims on Windows need a shell to start.
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.binary),
      });
    } catch (e) {
      res.errorKind = "crash";
      res.error = `could not start ${this.binary}: ${(e as Error).message}`;
      return Promise.resolve(res);
    }
    return new Promise((resolve) => {
      const stderr: string[] = [];
      let settled = false;
      let stopTimer: NodeJS.Timeout | undefined;
      const stop = (kind: "timeout" | "cancelled") => {
        if (res.errorKind) return;
        res.errorKind = kind;
        res.error =
          kind === "cancelled"
            ? "stopped by the owner"
            : `timed out after ${Math.round(o.timeoutMs / 1000)} s`;
        if (child.pid) killTree(child.pid);
        stopTimer = setTimeout(() => child.pid && killTree(child.pid, true), 15_000);
      };
      const timer = setTimeout(() => stop("timeout"), o.timeoutMs);
      const onAbort = () => stop("cancelled");
      o.signal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (e) => {
        if (settled) return;
        res.errorKind = "crash";
        res.error = `could not start ${this.binary}: ${e.message}`;
      });
      if (child.pid) o.onStart(child.pid);
      child.stdin?.end(this.input(o));
      child.stderr?.on("data", (c: Buffer) => {
        stderr.push(c.toString());
        if (stderr.length > 200) stderr.splice(0, 100);
      });
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          const t = line.trim();
          if (t) o.onLine("raw", t.slice(0, 2000));
          return;
        }
        try {
          this.handle(ev, res, o);
        } catch {
          /* one odd event never stops the run */
        }
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(stopTimer);
        o.signal.removeEventListener("abort", onAbort);
        res.exitCode = code;
        res.stderr = stderr.join("").slice(-4000);
        this.finish(res);
        if (res.errorKind === null) {
          if (!res.sawResult) {
            res.errorKind = "crash";
            res.error = (res.stderr.trim() || `exited ${code} without a final result`).slice(-1000);
          } else if (res.isError || code !== 0) {
            const text = `${res.result} ${res.stderr}`;
            res.errorKind = LIMIT_RE.test(text) ? "limit" : AUTH_RE.test(text) ? "auth" : "agent";
            res.error = (res.result || res.stderr || `exit ${code}`).slice(-1000);
          }
        }
        resolve(res);
      });
    });
  }
}

export class ClaudeCode extends StreamRunner {
  name = "claude-code";

  protected build(o: RunOptions): string[] {
    // Attachments are listed in the prompt; Claude opens them (images too) with its Read tool.
    const a = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      o.project.permissionMode,
      "--append-system-prompt",
      [
        SYSTEM_NOTE,
        o.project.fullAccess ? askNote(o.project.askLevel ?? "free") : "",
        o.hearth ? HEARTH_TOOLS_NOTE : "",
        o.persona ? lookPersonaInstruction(o.persona) : "",
      ]
        .filter(Boolean)
        .join(" "),
    ];
    // Hearth's tools, beside the owner's own add-ons (not strict: their settings still load).
    if (o.hearth) a.push("--mcp-config", o.hearth.config);
    // Hearth's guide, read from its file (too long and multi-line for an argument on Windows).
    const guide = hearthGuideFile();
    if (guide) a.push("--append-system-prompt-file", guide);
    if (o.model) a.push("--model", o.model);
    if (o.resume) a.push("--resume", o.resume);
    if (o.project.allowedTools.length) a.push("--allowedTools", o.project.allowedTools.join(","));
    return a;
  }

  protected handle(ev: Record<string, unknown>, res: ExecResult, o: RunOptions) {
    const t = ev.type;
    if (t === "system" && ev.subtype === "init") {
      res.sessionId = (ev.session_id as string) ?? null;
      if (res.sessionId) o.onSession?.(res.sessionId);
      o.onLine(
        "system",
        `session ${res.sessionId} · model ${String(ev.model)} · ${String(ev.permissionMode)}`,
      );
    } else if (t === "assistant") {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as Record<
        string,
        unknown
      >[];
      for (const b of content) {
        if (b.type === "text" && String(b.text ?? "").trim())
          o.onLine("text", String(b.text).trim());
        else if (b.type === "tool_use") {
          res.lastTool = summarizeTool(String(b.name ?? "tool"), b.input);
          res.lastToolName = String(b.name ?? "");
          o.onLine("tool", res.lastTool);
        }
      }
    } else if (t === "user") {
      const content = (ev.message as { content?: unknown })?.content;
      for (const b of (Array.isArray(content) ? content : []) as Record<string, unknown>[]) {
        if (b.type !== "tool_result") continue;
        const txt = toolResultText(b);
        if (b.is_error && txt.includes("Permission to use") && txt.includes("denied")) {
          res.denials.push(res.lastTool || "a tool call");
          if (res.lastToolName && !res.deniedTools.includes(res.lastToolName))
            res.deniedTools.push(res.lastToolName);
        }
        o.onLine(b.is_error ? "error" : "output", txt.slice(0, 600) || "(no output)");
      }
    } else if (t === "rate_limit_event") {
      o.onRateLimit?.((ev.rate_limit_info as Record<string, unknown>) ?? {});
    } else if (t === "result") {
      res.sawResult = true;
      res.isError = Boolean(ev.is_error) || ev.subtype !== "success";
      res.result = String(ev.result ?? "");
      res.sessionId = (ev.session_id as string) ?? res.sessionId;
      res.costUsd = (ev.total_cost_usd as number) ?? null;
      res.turns = (ev.num_turns as number) ?? null;
      o.onLine(
        "result",
        `${String(ev.subtype)} · ${res.turns} turns · ${Math.round(Number(ev.duration_ms ?? 0) / 1000)} s`,
      );
    }
  }
}

/**
 * Ollama: the same Claude Code, with a free model on the owner's hardware as its brain. Same
 * tools, permissions, Full access and guide as Claude Code; only the model and the cost differ.
 */
export class OllamaClaude extends ClaudeCode {
  override name = "ollama";
  constructor(
    binary: string,
    private readonly config: () => OllamaConfig | null,
  ) {
    super(binary);
  }

  protected override env(): NodeJS.ProcessEnv {
    const cfg = this.config();
    return cfg ? { ...cleanEnv(), ...ollamaEnv(cfg) } : cleanEnv();
  }

  protected override build(o: RunOptions): string[] {
    const model = this.config()?.model;
    if (!model) throw new Error("Ollama has no model chosen yet (Settings, Ember, Ollama).");
    // Always the Ollama model: a Claude model name means nothing to Ollama.
    return [...super.build({ ...o, model: null }), "--model", model];
  }

  protected override finish(res: ExecResult) {
    // Claude Code prices tokens as if Anthropic served them; Ollama costs nothing.
    res.costUsd = 0;
  }
}

/** Codex settings that add Hearth's tools as its "hearth" tool server (key from the environment). */
export function codexHearthArgs(o: RunOptions): string[] {
  if (!o.hearth) return [];
  return [
    "-c",
    `mcp_servers.hearth.url=${JSON.stringify(o.hearth.url)}`,
    "-c",
    'mcp_servers.hearth.bearer_token_env_var="HEARTH_AGENT_KEY"',
  ];
}

/** `codex exec --json`: thread.started, item.started/completed, turn.completed/failed. */
export class Codex extends StreamRunner {
  name = "codex";

  /**
   * `companion`: the Hearth memory program, when Claude Code has the Hearth add-on. Codex then
   * gets the same memory tools (agent parity).
   */
  constructor(
    binary: string,
    private readonly companion: () => string | null = () => null,
  ) {
    super(binary);
  }

  // Codex has no system prompt option here: a new conversation starts with the guide, which then
  // stays in its history.
  protected override input(o: RunOptions): string {
    const guide = hearthGuide();
    const memory = this.companion() ? ` ${COMPANION_NOTE}` : "";
    const tools = o.hearth ? ` ${HEARTH_TOOLS_NOTE}` : "";
    // The persona goes with every turn: it can be switched on or changed mid-conversation.
    const persona = o.persona ? `${lookPersonaInstruction(o.persona)}\n\n` : "";
    return o.resume || !guide
      ? `${persona}${o.prompt}`
      : `${SYSTEM_NOTE} ${askNote(o.project.askLevel ?? "free")}${memory}${tools}\n\n<hearth-guide>\n${guide}\n</hearth-guide>\n\n${persona}${o.prompt}`;
  }

  /** Hearth's key for its tools goes in the environment, never on the command line. */
  protected override env(o?: RunOptions): NodeJS.ProcessEnv {
    return o?.hearth ? { ...cleanEnv(), HEARTH_AGENT_KEY: o.hearth.key } : cleanEnv();
  }

  protected build(o: RunOptions): string[] {
    const sandbox = o.project.codexSandbox;
    if (o.resume) {
      const a = [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "-c",
        `sandbox_mode="${sandbox}"`,
        ...codexCompanionArgs(this.companion()),
        ...codexHearthArgs(o),
      ];
      if (o.model) a.push("-c", `model="${o.model}"`);
      return [...a, o.resume, "-"];
    }
    const a = [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      o.cwd,
      "-s",
      sandbox,
      ...codexCompanionArgs(this.companion()),
      ...codexHearthArgs(o),
    ];
    if (o.model) a.push("-m", o.model);
    // Codex sees images directly when attached with -i.
    for (const img of o.attachments.filter((x) =>
      IMAGE_EXT.some((e) => x.toLowerCase().endsWith(e)),
    ))
      a.push("-i", path.join(o.cwd, img));
    return [...a, "-"];
  }

  protected handle(ev: Record<string, unknown>, res: ExecResult, o: RunOptions) {
    const t = ev.type;
    const item = (ev.item ?? {}) as Record<string, unknown>;
    const it = item.type;
    if (t === "thread.started") {
      res.sessionId = (ev.thread_id as string) ?? null;
      if (res.sessionId) o.onSession?.(res.sessionId);
      o.onLine("system", `codex thread ${res.sessionId}`);
    } else if (t === "item.started" && it === "command_execution") {
      o.onLine("tool", `Bash: ${String(item.command ?? "").slice(0, 240)}`);
    } else if (t === "item.completed") {
      if (it === "agent_message" && String(item.text ?? "").trim()) {
        res.result = String(item.text).trim();
        o.onLine("text", res.result);
      } else if (it === "command_execution") {
        const out = String(item.aggregated_output ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const bad = item.exit_code !== 0 && item.exit_code != null;
        o.onLine(
          bad ? "error" : "output",
          (out.slice(0, 600) || "(no output)") + (bad ? ` [exit ${String(item.exit_code)}]` : ""),
        );
      } else if (it === "file_change") {
        const paths = ((item.changes ?? []) as { kind?: string; path?: string }[])
          .map((c) => `${c.kind ?? ""} ${c.path ?? ""}`)
          .join(", ");
        o.onLine("tool", `Edit: ${paths.slice(0, 300)}`);
      } else if (it === "mcp_tool_call" || it === "web_search" || it === "todo_list") {
        o.onLine("tool", `${String(it)}: ${JSON.stringify(item).slice(0, 240)}`);
      } else if (it === "error") {
        o.onLine("error", String(item.message ?? "").slice(0, 600));
      }
    } else if (t === "turn.completed") {
      res.sawResult = true;
      res.isError = false;
      const u = (ev.usage ?? {}) as Record<string, unknown>;
      o.onLine(
        "result",
        `turn completed · ${String(u.input_tokens ?? "?")} in / ${String(u.output_tokens ?? "?")} out tokens`,
      );
    } else if (t === "turn.failed") {
      res.sawResult = true;
      res.isError = true;
      res.result =
        res.result || String((ev.error as { message?: string })?.message ?? "turn failed");
      o.onLine("error", res.result.slice(0, 600));
    } else if (t === "error") {
      res.error = String(ev.message ?? "");
      o.onLine("error", res.error.slice(0, 600));
    }
  }

  protected override finish(res: ExecResult) {
    if (res.sawResult && res.isError && !res.result) res.result = res.error;
  }
}

/** Tests: a stand-in for Claude Code that answers at once, through the same stream handling. */
export class FakeRunner implements Runner {
  /** Every prompt a stand-in was given, newest last (tests read the handover from it). */
  static prompts: string[] = [];
  name = "claude-code";
  binary = "fake";
  run(o: RunOptions): Promise<ExecResult> {
    FakeRunner.prompts.push(o.prompt);
    const res = emptyResult();
    o.onStart(0);
    const sid = o.resume ?? `fake-${Date.now()}`;
    res.sessionId = sid;
    o.onSession?.(sid);
    o.onLine("system", `session ${sid} · model fake · ${o.project.permissionMode}`);
    o.onLine("tool", "Read: CLAUDE.md");
    // A handover comes first; it answers the owner's new message after it.
    const asked = o.prompt.split("The owner's new message:\n\n").pop()!;
    const reply = `Heard you: ${asked.split("\n")[0]}`;
    o.onLine("text", reply);
    res.sawResult = true;
    res.isError = false;
    res.result = reply;
    res.exitCode = 0;
    o.onLine("result", "success · 1 turns · 0 s");
    return new Promise((resolve) => setTimeout(() => resolve(res), 150));
  }
}
