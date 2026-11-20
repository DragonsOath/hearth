import { execFile, spawn } from "node:child_process";
import { CLAUDE_MODELS, isProjectColor } from "@dragon-control/core";
import { randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type http from "node:http";
import { cpus, freemem, homedir, hostname, loadavg, tmpdir, totalmem, uptime } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { DatabaseSync } from "node:sqlite";
import {
  cleanEnv,
  findBinary,
  askNote,
  isAskLevel,
  HEARTH_TOOLS_NOTE,
  killTree,
  SYSTEM_NOTE,
} from "./runners";
import { loadPty, ptyLoaded, Terminals } from "./terminal";
import { Remotes, remoteTitle } from "./remote";
import { CODE_ENTERED, type ChatLogin, LOGIN_COMMAND, signedOutHint } from "../agent/login-chat";
import { LINK_HEADER, LINK_SECRET } from "../pcs/link";
import { contentType, ProjectError, Projects } from "./projects";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_RISKY,
  EngineQueue,
  publicTask,
  QueueError,
  type EngineInfo,
} from "./queue";
import { EngineStore } from "./store";
import {
  OLLAMA_DEFAULT_URL,
  normalizeOllamaUrl,
  ollamaEnv,
  ollamaStatus,
  prepareOllamaModel,
  type OllamaConfig,
  type OllamaStatus,
} from "./ollama";
import { Usage } from "./usage";
import { findCompanion } from "./companion";
import { GitHub, GitHubError, fakeGhApi, ghApi, repoOfRemote } from "./github";

/**
 * Hearth's engine: the real Claude Code and Codex, working in project folders on the machine
 * Hearth runs on (ported from EMBER). The War Room drives it; remote access comes from Remote
 * Control (/rc) in the Claude app, never from another machine reaching in.
 *
 *   /api/engine/*            the engine's routes (signed-in owner only, like every /api route)
 *   /api/engine/ws           live events (task progress, replies, queue changes)
 *   /engine-preview/<key>/*  sandboxed previews of a project's files (the key is the permission)
 */

export interface EngineOptions {
  db: DatabaseSync;
  /** Where projects live (default: "Hearth Projects" in the home folder). */
  workspaces?: string;
  /** Hearth's data folder (held uploads go in engine-uploads/). */
  dataDir: string;
  /** This PC's name in Hearth (Remote Control sessions carry it). */
  pcName?: () => string;
  /** Looks up a signed-in session from its cookie value (for WebSocket upgrades). */
  session: (cookie: string | undefined) => Promise<unknown>;
  cookieName: string;
  /** Program paths when not found automatically. */
  claudeBinary?: string;
  codexBinary?: string;
  /** Tests: a stand-in for Claude Code. */
  fakeRunner?: boolean;
  /** Tests and demos: how Ollama is reached (a stand-in under DC_FAKE_AGENT). */
  ollamaFetch?: typeof fetch;
}

const RC_CMD = /^\/(?:rc|remote-control)(?:\s+(\w+))?\s*$/i;

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function sameOrigin(headers: http.IncomingHttpHeaders): boolean {
  const origin = headers.origin;
  if (!origin) return false;
  const host = String(headers["x-forwarded-host"] ?? headers.host ?? "");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export class Engine {
  readonly store: EngineStore;
  readonly projects: Projects;
  readonly queue: EngineQueue;
  private readonly sockets = new Set<WebSocket>();
  readonly terminals = new Terminals();
  readonly remotes: Remotes;
  /** Projects where /rc was typed while Claude was busy: it turns on when that reply finishes. */
  private readonly rcPending = new Set<string>();
  /** /login from the chat (the Lair's, shared: one sign-in at a time; set in index.ts). */
  chatLogin?: ChatLogin;
  /** Hearth's tools lent to a live Remote Control session, ended with it. */
  private readonly rcTools = new Map<string, () => Promise<void>>();
  private readonly previews = new Map<string, { root: string; until: number }>();
  private readonly uploads: string;
  readonly engines: Record<string, EngineInfo>;
  readonly usage: Usage;
  /**
   * Hearth's tools for each War Room run, the same as the Lair's (set once Hearth's agent service
   * exists; index.ts). Absent: the War Room runs with its own tools and the memory add-on only.
   */
  hearthTools?: (engine: string) => Promise<{
    url: string;
    key: string;
    release: () => Promise<void>;
    renew?: () => Promise<void>;
  } | null>;
  /** "Turn on persona": the chosen picture's persona, for War Room runs (set in app.ts). */
  persona?: () => Promise<string | undefined>;
  /** Told when the owner sets Ollama up here, so your Hearth can pass it on to your other PCs. */
  onOllamaChange?: (cfg: OllamaConfig) => void;
  /** The account's other PCs, one Markdown line each, for the Homelab snapshot (set in app.ts). */
  accountPcs?: () => Promise<string[]>;
  /** The GitHub panel's reads (the gh tool on this machine); null when gh is not installed. */
  readonly github: GitHub | null;

  constructor(readonly opts: EngineOptions) {
    this.store = new EngineStore(opts.db);
    const workspaces = opts.workspaces ?? path.join(homedir(), "Hearth Projects");
    mkdirSync(workspaces, { recursive: true });
    this.projects = new Projects(this.store, workspaces);
    this.uploads = path.join(opts.dataDir, "engine-uploads");
    const claude = opts.fakeRunner ? process.execPath : findBinary("claude", opts.claudeBinary);
    const codex = opts.fakeRunner ? null : findBinary("codex", opts.codexBinary);
    this.engines = {
      "claude-code": {
        label: "Claude Code",
        binary: claude,
        enabled: Boolean(claude),
        models: CLAUDE_MODELS.filter((m) => m.value !== "default").map((m) => m.value),
      },
      codex: { label: "Codex", binary: codex, enabled: Boolean(codex), models: [] },
      // Claude Code with a free model from Ollama as its brain: the same tools and access.
      ollama: {
        label: "Ollama",
        binary: claude,
        enabled: Boolean(claude && this.ollamaConfig()?.model),
        models: [],
      },
    };
    this.queue = new EngineQueue(
      this.store,
      this.projects,
      {
        engines: this.engines,
        ollama: () => this.ollamaConfig(),
        companion: () => findCompanion(),
        hearth: (engine) => this.hearthTools?.(engine) ?? Promise.resolve(null),
        persona: () => this.persona?.() ?? Promise.resolve(undefined),
        uploads: this.uploads,
        timeoutMinutes: 60,
        maxAttempts: 2,
        dailyCap: 300,
        permissionMode: "acceptEdits",
        allowedTools: DEFAULT_ALLOWED_TOOLS,
        codexSandbox: "danger-full-access",
        risky: DEFAULT_RISKY,
      },
      (ev) => this.broadcast(ev),
    );
    if (opts.fakeRunner) this.queue.useFake();
    this.usage = new Usage(this.store, this.engines, (ev) => this.broadcast(ev), opts.fakeRunner);
    const gh = opts.fakeRunner ? null : findBinary("gh");
    this.github = opts.fakeRunner ? new GitHub(fakeGhApi) : gh ? new GitHub(ghApi(gh)) : null;
    this.queue.onRateLimit = (info) => this.usage.onClaudeReport(info);
    this.remotes = new Remotes(this.terminals, {
      message: (project, role, text, meta) =>
        this.send({ type: "message", message: this.store.addMessage(project, role, text, meta) }),
      ask: (project, p) => {
        const m = this.store.addMessage(
          project,
          "ask",
          p.title,
          JSON.stringify({ kind: "rc", project, ...p }),
        );
        this.send({ type: "message", message: m });
        return m.id;
      },
      askClosed: (id, answered) => {
        const m = this.store.message(id);
        if (!m) return;
        const meta = JSON.parse(m.meta ?? "{}") as Record<string, unknown>;
        this.store.setMessageMeta(id, JSON.stringify({ ...meta, answered }));
        this.send({ type: "ask_answered", id, answered });
      },
      changed: () => this.send({ type: "remote", remote: this.remotes.public() }),
      saveSession: (project, sid) => this.store.setSetting(`session:${project}:claude-code`, sid),
      active: (project, on) => {
        const now = new Set(this.store.setting<string[]>("rc:active", []));
        if (on) now.add(project);
        else now.delete(project);
        this.store.setSetting("rc:active", [...now].sort());
      },
      ended: (project) => {
        void this.endTools(project);
        this.send({
          type: "message",
          message: this.store.addMessage(
            project,
            "sys",
            "Remote Control ended. Messages here go to Claude Code as before, same conversation.",
            "rc",
          ),
        });
        this.send({ type: "remote", remote: this.remotes.public() });
      },
    });
    this.queue.beforeRun = (p) => this.projects.syncContext(p);
  }

  start() {
    this.queue.recover();
    this.queue.start();
    // Remote Control sessions that were on before a restart come back on.
    void loadPty().then(() => {
      for (const slug of this.store.setting<string[]>("rc:active", []))
        if (this.projects.has(slug) && !this.remotes.get(slug))
          void this.startRemote(slug).catch(() => undefined);
    });
  }

  stop() {
    this.queue.stop();
    this.remotes.stopAll();
    this.terminals.stopAll();
    for (const s of this.sockets) s.close();
  }

  broadcast(ev: Record<string, unknown>) {
    if (ev.type === "task_done") {
      // A finished chat turn: the agent's answer goes into the conversation as its reply; any
      // other finish is one line in the chat.
      const t = ev.task as {
        id: number;
        project: string;
        engine: string;
        model: string | null;
        state: string;
        title: string;
        conversation: boolean;
        result: string | null;
        error: string | null;
      };
      const label = this.engines[t.engine]?.label ?? t.engine;
      const m =
        t.conversation && t.state === "succeeded"
          ? this.store.addMessage(
              t.project,
              "ember",
              t.result || "(done, no reply text)",
              `${label} · ${t.model ?? "default"}`,
              t.id,
            )
          : this.store.addMessage(
              t.project,
              "sys",
              `Task #${t.id} ${t.state}: ${t.title}` +
                (t.result || t.error
                  ? `\n${(t.result || t.error || "").trim().split("\n")[0]!.slice(0, 400)}`
                  : "") +
                // Signed out: say how to sign back in, right here (11-04).
                (t.state === "failed" && signedOutHint(t.error || t.result)
                  ? `\n${signedOutHint(t.error || t.result)}`
                  : ""),
              "task",
              t.id,
            );
      this.send({ type: "message", message: m });
      // /rc typed while this reply was running: turn it on now.
      if (this.rcPending.has(t.project) && !this.claudeBusy(t.project))
        void this.startRemote(t.project).then((note) =>
          this.send({
            type: "message",
            message: this.store.addMessage(
              t.project,
              "ember",
              note,
              "Claude Code · Remote Control",
            ),
          }),
        );
    }
    this.send(ev);
  }

  private send(ev: Record<string, unknown>) {
    const text = JSON.stringify(ev);
    for (const s of this.sockets) if (s.readyState === s.OPEN) s.send(text);
  }

  /* ---------- the live terminal ---------- */

  /** Which program a terminal request runs, and where (null when the project or program is unknown). */
  terminalFor(q: URLSearchParams) {
    const slug = q.get("project") ?? "";
    const engine = q.get("engine") ?? "claude-code";
    const info = this.engines[engine];
    if (!info?.binary) return null;
    let cwd: string;
    try {
      cwd = this.projects.get(slug).path;
    } catch {
      return null;
    }
    // In tests the stand-in "Claude Code" is Node itself, so the terminal is its prompt.
    const argv = engine === "codex" ? [info.binary, "-C", cwd] : [info.binary];
    // Ollama's terminal is Claude Code pointed at Ollama, on the chosen model.
    const ollama = engine === "ollama" ? this.ollamaConfig() : null;
    if (engine === "ollama") {
      if (!ollama?.model) return null;
      if (!this.opts.fakeRunner) argv.push("--model", ollama.model);
    }
    if (this.opts.fakeRunner) argv.push("-i");
    return {
      key: `${slug}:${engine}`,
      argv,
      cwd,
      label: info.label,
      ...(ollama ? { env: ollamaEnv(ollama) } : {}),
      cols: Number(q.get("cols") ?? 120),
      rows: Number(q.get("rows") ?? 32),
    };
  }

  /** Connects a page to a terminal session: output out, keys and size in. */
  async attachTerminal(ws: WebSocket, req: NonNullable<ReturnType<Engine["terminalFor"]>>) {
    const start = () => this.terminals.get(req.key, req.argv, req.cwd, req.cols, req.rows, req.env);
    let term: Awaited<ReturnType<typeof start>>;
    try {
      term = await start();
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      ws.send(JSON.stringify({ t: "error", message: `Couldn't start ${req.label}: ${why}` }));
      ws.close();
      return;
    }
    const replay = term.replay();
    if (replay) ws.send(replay);
    term.clients.add(ws);
    term.resize(req.cols, req.rows);
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        term.write(Buffer.from(raw as Buffer).toString("utf8"));
        return;
      }
      let d: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
      try {
        d = JSON.parse(String(raw)) as typeof d;
      } catch {
        return;
      }
      if (d.t === "in" && typeof d.d === "string") term.write(d.d);
      else if (d.t === "resize") term.resize(Number(d.cols), Number(d.rows));
      else if (d.t === "restart") {
        term.clients.delete(ws);
        this.terminals.end(req.key);
        void start().then((fresh) => {
          term = fresh;
          term.clients.add(ws);
        });
      }
    });
    ws.on("close", () => term.clients.delete(ws));
  }

  /**
   * Deletes a project for good (right-click its tab, then confirm). Waits for nothing: refused
   * while it has tasks queued or running, so no work is cut off half done.
   */
  deleteProject(slug: string) {
    const active = this.store.activeIn(slug);
    if (active)
      throw new ProjectError(
        `It has ${active} task${active === 1 ? "" : "s"} queued or running. Stop ${active === 1 ? "it" : "them"} first.`,
      );
    this.projects.get(slug);
    this.rcPending.delete(slug);
    this.remotes.get(slug)?.stop();
    for (const engine of Object.keys(this.engines)) this.terminals.end(`${slug}:${engine}`);
    this.projects.remove(slug);
    this.broadcast({ type: "project_deleted", project: slug });
  }

  /** Set by Hearth: run when the War Room opens (makes the Homelab project when it is due). */
  beforeOpen?: () => Promise<void>;

  /* ---------- what the War Room shows ---------- */

  /* ---------- Ollama ---------- */

  /** Ollama's address and model, as the owner set them (null until set up). */
  ollamaConfig(): OllamaConfig | null {
    const c = this.store.setting<Partial<OllamaConfig> | null>("ollama", null);
    return c?.url ? { url: c.url, model: c.model ?? null } : null;
  }

  private ollamaFetch(): typeof fetch {
    return this.opts.ollamaFetch ?? fetch;
  }

  /** What Ollama has, and whether each model can work for Hearth. */
  ollamaStatus(url?: string): Promise<OllamaStatus> {
    const cfg = this.ollamaConfig();
    return ollamaStatus(
      {
        url: url ? normalizeOllamaUrl(url) : (cfg?.url ?? OLLAMA_DEFAULT_URL),
        model: cfg?.model ?? null,
      },
      this.ollamaFetch(),
    );
  }

  /** Saves the address and model. The model must be there, use tools, and have room to think. */
  async setOllama(input: { url?: string; model?: string | null }): Promise<OllamaStatus> {
    const url = normalizeOllamaUrl(input.url ?? this.ollamaConfig()?.url ?? "");
    const model = input.model === undefined ? (this.ollamaConfig()?.model ?? null) : input.model;
    const status = await ollamaStatus({ url, model }, this.ollamaFetch());
    if (!status.reachable) throw new QueueError(status.problem ?? "Ollama isn't reachable.");
    if (model) {
      const m = status.models.find((x) => x.name === model);
      if (!m) throw new QueueError(`Ollama doesn't have a model called ${model}.`);
      if (!m.tools)
        throw new QueueError(
          `${model} can't use tools, so it could only talk, not do anything. Pick a model that can use tools.`,
        );
      if (!m.contextOk)
        throw new QueueError(
          `${model} has too small a memory window for Hearth. Use "Make a Hearth copy" for it.`,
        );
    }
    this.store.setSetting("ollama", { url, model });
    this.engines.ollama!.enabled = Boolean(this.engines.ollama!.binary && model);
    if (this.opts.fakeRunner) this.queue.useFake();
    else this.queue.refreshRunners();
    this.broadcast({ type: "config", config: this.config() });
    this.onOllamaChange?.({ url, model });
    return { ...status, model };
  }

  /** Makes a copy of a model with a big enough memory window, and uses it. */
  async prepareOllama(model: string): Promise<OllamaStatus> {
    const cfg = this.ollamaConfig() ?? { url: OLLAMA_DEFAULT_URL, model: null };
    const name = await prepareOllamaModel(cfg, model, this.ollamaFetch());
    return this.setOllama({ url: cfg.url, model: name });
  }

  config() {
    return {
      // The name set for this PC in Hearth (PCs and devices), else the computer's own name.
      machine: this.opts.pcName?.() ?? hostname(),
      projects: Object.fromEntries(this.projects.list().map((p) => [p.slug, p])),
      engines: Object.fromEntries(
        Object.entries(this.engines).map(([k, e]) => [
          k,
          {
            label: e.label,
            enabled: e.enabled,
            installed: Boolean(e.binary),
            note: !e.binary
              ? k === "ollama"
                ? "Ollama runs through Claude Code, which isn't installed on this computer."
                : `${e.label} isn't installed on this computer.`
              : k === "ollama" && !e.enabled
                ? "Set up Ollama first: Settings, Ember, Ollama."
                : "",
            models: e.models,
          },
        ]),
      ),
      routing: { default: "claude", quick_model: "haiku" },
      voice: { speak_replies: false, choices: [] },
      // What this engine can do yet (the rest of EMBER arrives in stages).
      capabilities: {
        terminal: ptyLoaded(),
        remote:
          ptyLoaded() && Boolean(this.engines["claude-code"]?.binary) && !this.opts.fakeRunner,
        github: Boolean(this.github),
        usage: true,
        voice: false,
      },
    };
  }

  state() {
    return {
      config: this.config(),
      tasks: this.store.list().map(publicTask),
      queue: this.queue.status(),
      skills: [],
      remote: this.remotes.public(),
      usage: this.usage.snapshot(),
    };
  }

  tiles() {
    const mem = 1 - freemem() / totalmem();
    const [l1 = 0, l5 = 0, l15 = 0] = loadavg();
    const st = this.queue.status();
    const up = uptime();
    return [
      {
        label: "CPU",
        value: `${cpus().length} threads`,
        detail: cpus()[0]?.model ?? "",
        ok: null,
        pct: null,
        type: "cpu",
      },
      {
        label: "Memory",
        value: `${Math.round(mem * 100)}%`,
        detail: `${((totalmem() - freemem()) / 2 ** 30).toFixed(1)} / ${(totalmem() / 2 ** 30).toFixed(0)} GB`,
        ok: null,
        pct: mem * 100,
        type: "memory",
      },
      {
        label: "Load",
        value: l1.toFixed(2),
        detail: `5m ${l5.toFixed(2)} · 15m ${l15.toFixed(2)}`,
        ok: null,
        pct: null,
        type: "load",
      },
      {
        label: "Uptime",
        value:
          up > 86400
            ? `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h`
            : `${Math.floor(up / 3600)}h`,
        detail: this.opts.pcName?.() ?? hostname(),
        ok: null,
        pct: null,
        type: "uptime",
      },
      {
        label: "Queue",
        value: `${st.counts.running}·${st.counts.queued}`,
        detail: "running · waiting",
        ok: null,
        pct: null,
        type: "queue",
      },
    ];
  }

  /** A one-shot reply with no tools (still counts toward the account's usage). */
  quick(text: string): Promise<string> {
    const bin = this.engines["claude-code"]?.binary;
    if (!bin || this.opts.fakeRunner) return Promise.resolve(`Quick answer: ${text}`);
    return new Promise((resolve) => {
      const child = spawn(
        bin,
        [
          "-p",
          "--output-format",
          "json",
          "--model",
          "haiku",
          "--tools",
          "",
          "--no-session-persistence",
          "--system-prompt",
          "Answer briefly and plainly.",
        ],
        { env: cleanEnv(), cwd: homedir(), windowsHide: true },
      );
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      const t = setTimeout(() => child.pid && killTree(child.pid, true), 90_000);
      child.on("close", () => {
        clearTimeout(t);
        try {
          resolve(String((JSON.parse(out) as { result?: string }).result ?? "No reply."));
        } catch {
          resolve("The quick answer didn't come back.");
        }
      });
      child.on("error", () => resolve("Claude Code couldn't be started."));
      child.stdin.end(text);
    });
  }

  /** What you typed in a project's chat: a message to that project's ongoing conversation. */
  async request(body: {
    text?: string;
    project?: string;
    agent?: string;
    engine?: string;
    model?: string;
    require_approval?: boolean;
    attachments?: string[];
    source?: string;
  }) {
    const text = (body.text ?? "").trim();
    if (!text) throw new QueueError("empty request");
    const project = body.project && this.projects.has(body.project) ? body.project : "sandbox";
    const atts = body.attachments ?? [];
    // /login (11-04): Claude Code's sign-in from the chat; the code comes as the next message.
    const login = this.chatLogin;
    const step = !login
      ? undefined
      : LOGIN_COMMAND.test(text)
        ? "start"
        : login.expects(`war-room:${project}`, text)
          ? "code"
          : undefined;
    if (login && step) {
      // The code itself is never kept: only that one was entered.
      this.store.addMessage(project, "you", step === "code" ? CODE_ENTERED : text, "typed");
      const r =
        step === "start" ? await login.start(`war-room:${project}`) : await login.finish(text);
      const m = this.store.addMessage(
        project,
        "ember",
        r.url ? `${r.text}\n\n[Open Anthropic's sign-in](${r.url})` : r.text,
        "Hearth · sign-in",
      );
      this.send({ type: "message", message: m });
      return { route: "local", reason: "sign-in", reply: "", speak: "" };
    }
    const rc = RC_CMD.exec(text);
    if (rc) return this.remoteCommand(project, (rc[1] ?? "on").toLowerCase());
    const mine = this.store.addMessage(
      project,
      "you",
      text + (atts.length ? `\n📎 ${atts.length} attachment(s)` : ""),
      body.source ?? "typed",
    );
    void mine;
    // Remote Control is on: the message goes into that live session.
    const live = this.remotes.get(project);
    if (live) {
      let typed = text;
      if (atts.length) typed += `\n\nAttached files: ${atts.join(", ")}`;
      live.send(typed);
      return { route: "remote", reason: "remote control", reply: "", speak: "" };
    }
    if (body.agent === "quick" && !atts.length) {
      const reply = await this.quick(text);
      const m = this.store.addMessage(project, "ember", reply, "quick · Claude Code haiku");
      this.broadcast({ type: "message", message: m });
      return { route: "quick", reason: "quick answer", reply: "", speak: reply };
    }
    let task;
    try {
      task = this.queue.add(text, {
        project,
        conversation: true,
        source: body.source ?? "typed",
        actor: "owner",
        model: body.model || null,
        requireApproval: Boolean(body.require_approval),
        engine: body.engine || null,
        attachments: atts,
      });
    } catch (e) {
      const reply = `I couldn't queue that: ${(e as Error).message}`;
      this.store.addMessage(project, "ember", reply, "error");
      return { route: "error", reason: "queue", reply };
    }
    const st = this.queue.status();
    const ahead = this.store
      .list()
      .filter((x) => (x.state === "queued" || x.state === "running") && x.id !== task.id).length;
    let reply = "";
    if (task.state === "awaiting_approval")
      reply = `Task ${task.id} is waiting for your approval: ${task.approval_reason}.`;
    else if (st.paused)
      reply = `Queued as task ${task.id}, but the queue is paused (${st.pause_reason || "paused"}), so it hasn't started. ${
        /daily cap/.test(st.pause_reason)
          ? "Press 'Allow 20 more today' to continue."
          : "Press Resume to start it."
      }`;
    else if (ahead)
      reply = `Waiting for ${ahead} earlier request${ahead > 1 ? "s" : ""} to finish first.`;
    if (reply) this.store.addMessage(project, "ember", reply, "task · queue", task.id);
    return {
      route: "task",
      reason: "sent to the agent",
      reply,
      speak: reply,
      task: publicTask(task),
    };
  }

  /** Remote Control (/rc): the project's conversation, live in the Claude app too. */
  private async remoteCommand(project: string, arg: string) {
    this.store.addMessage(project, "you", "/rc" + (arg === "on" ? "" : ` ${arg}`), "typed");
    const r = this.remotes.get(project);
    let reply: string;
    // A plain /rc switches it: on when it's off, off when it's on (as in Claude Code).
    if (
      ["stop", "off", "end"].includes(arg) ||
      (arg === "on" && (r || this.rcPending.has(project)))
    ) {
      const pending = this.rcPending.delete(project);
      reply = r
        ? "Remote Control is off. Type /rc to turn it back on."
        : pending
          ? "OK, Remote Control won't turn on."
          : "Remote Control isn't on for this project.";
      r?.stop();
    } else if (arg === "status" && !r) {
      reply = "Remote Control isn't on for this project. Type /rc to start it.";
    } else if (r) {
      reply = r.url ? `Remote Control is on: ${r.url}` : "Remote Control is still connecting…";
    } else if (this.claudeBusy(project)) {
      this.rcPending.add(project);
      reply =
        `Remote Control will turn on by itself as soon as Claude finishes task #${this.claudeBusy(project)!.id} ` +
        "(two copies of the same conversation can't run at once).";
    } else {
      reply = await this.startRemote(project);
    }
    const m = this.store.addMessage(project, "ember", reply, "Claude Code · Remote Control");
    this.send({ type: "message", message: m });
    this.send({ type: "remote", remote: this.remotes.public() });
    return { route: "local", reason: "remote control", reply: "", speak: "" };
  }

  private claudeBusy(project: string) {
    return this.store
      .list()
      .find(
        (t) =>
          t.project === project &&
          t.engine === "claude-code" &&
          Boolean(t.conversation) &&
          (t.state === "running" || t.state === "queued"),
      );
  }

  private async startRemote(project: string): Promise<string> {
    this.rcPending.delete(project);
    const binary = this.engines["claude-code"]?.binary;
    if (!binary || this.opts.fakeRunner)
      return "Remote Control needs Claude Code on this computer.";
    if (await this.chatLogin?.signedOut())
      return "Claude Code isn't signed in on this computer, so Remote Control can't start. Type /login to sign it in, then /rc.";
    try {
      const p = this.projects.get(project);
      this.projects.syncContext(project);
      // Hearth's tools for as long as the session runs, as every War Room run has (agent parity).
      const tools = await this.hearthTools?.("claude-code").catch(() => null);
      let extra: string[] = [];
      if (tools) {
        const dir = mkdtempSync(path.join(tmpdir(), "hearth-rc-tools-"));
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
        extra = ["--mcp-config", config];
        // The key would end after 20 minutes; the session can run for hours.
        const renew = setInterval(() => void tools.renew?.().catch(() => undefined), 10 * 60_000);
        this.rcTools.set(project, async () => {
          clearInterval(renew);
          rmSync(dir, { recursive: true, force: true });
          await tools.release();
        });
      }
      const full = this.queue.fullAccess;
      await this.remotes.start({
        slug: project,
        name: p.name || project,
        // Shown in the Claude app as "Hearth • <PC> • War Room • <project>" (11-04).
        title: remoteTitle(this.opts.pcName?.() ?? hostname(), "War Room", p.name || project),
        note: [
          SYSTEM_NOTE.replace("from Hearth's War Room", "from Hearth's War Room or the Claude app"),
          full ? askNote(this.queue.askLevel) : "",
          tools ? HEARTH_TOOLS_NOTE : "",
        ]
          .filter(Boolean)
          .join(" "),
        extra,
        permissionMode: full ? "bypassPermissions" : "acceptEdits",
        cwd: p.path,
        sid: this.store.setting<string | null>(`session:${project}:claude-code`, null),
        binary,
        allowedTools: full ? [] : [...DEFAULT_ALLOWED_TOOLS, ...(tools ? ["mcp__hearth"] : [])],
      });
      return "Starting Remote Control for this project's conversation…";
    } catch (e) {
      await this.endTools(project);
      return `Couldn't start Remote Control: ${(e as Error).message}`;
    }
  }

  private async endTools(project: string) {
    const end = this.rcTools.get(project);
    this.rcTools.delete(project);
    await end?.().catch(() => undefined);
  }

  /** Answers a card: for Remote Control, presses that option in the live session. */
  answerAsk(id: number, action: string): { note: string } {
    const m = this.store.message(id);
    if (!m || m.role !== "ask") throw new QueueError("No such question.");
    const meta = JSON.parse(m.meta ?? "{}") as {
      kind?: string;
      project?: string;
      answered?: string;
      options?: { key: string; label: string }[];
    };
    if (meta.answered) throw new QueueError("That was already answered.");
    const r = meta.kind === "rc" && meta.project ? this.remotes.get(meta.project) : null;
    const opt = meta.options?.find((o) => o.key === action);
    if (!r || r.askId !== id || !opt) throw new QueueError("That prompt is no longer open.");
    r.answer(opt.key, opt.label);
    return { note: `You chose: ${opt.label}` };
  }

  holdUpload(project: string, name: string, data: Buffer) {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.uploads, day);
    mkdirSync(dir, { recursive: true });
    const safe = path.basename(name).replace(/[\\/:*?"<>|]/g, "_") || "file";
    const file = `${randomBytes(4).toString("hex")}-${safe}`;
    writeFileSync(path.join(dir, file), data);
    void project;
    return { path: `uploads/${day}/${file}`, name: safe };
  }

  newPreview(root: string) {
    const nowMs = Date.now();
    for (const [k, v] of this.previews) if (v.until < nowMs) this.previews.delete(k);
    const key = randomBytes(18).toString("base64url");
    this.previews.set(key, { root: path.resolve(root), until: nowMs + 4 * 3600_000 });
    return { base: `/engine-preview/${key}/`, expires_in: 4 * 3600 };
  }

  previewFile(key: string, rel: string): string | null {
    const hit = this.previews.get(key);
    if (!hit || hit.until < Date.now()) return null;
    const f = path.resolve(hit.root, decodeURIComponent(rel || "index.html"));
    const inside = path.relative(hit.root, f);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return null;
    if (inside.split(path.sep).includes(".git")) return null;
    return existsSync(f) && statSync(f).isFile() ? f : null;
  }
}

/* ---------- routes ---------- */

/** Hearth's own voice (Settings, Ember, Voice): the War Room hears and speaks through it. */
export interface EngineVoice {
  /** Whether a speech machine is set up; without one, the War Room uses the browser's own. */
  config(): Promise<{ host?: string }>;
  transcribe(audio: Buffer, rate: number): Promise<string>;
  speak(text: string): Promise<Buffer>;
  /** Whether the built-in voice's helper is loaded (holding memory). */
  voiceLoaded?(): boolean;
  /** Stops it now, so its memory comes back; it starts again when voice is used. */
  releaseBuiltin?(): unknown;
}

/** A reply cut into sentences, so the first one plays while the next is being made. */
export function sentencesOf(text: string): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

export function registerEngine(app: FastifyInstance, engine: Engine, voice?: EngineVoice) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof QueueError || e instanceof ProjectError)
      return reply.code(400).send({ error: e.message, message: e.message });
    throw e;
  };
  const slugOf = (r: FastifyRequest) => (r.params as { slug: string }).slug;

  app.get("/api/engine/health", async () => ({ ok: true }));
  app.get("/api/engine/state", async () => {
    // Someone opened the War Room: Codex's limits are checked (at most every five minutes).
    void engine.usage.refreshCodex();
    // ...and if this machine has become a homelab, its Homelab project is there already.
    await engine.beforeOpen?.().catch(() => undefined);
    return engine.state();
  });
  // Just the plan usage (the Lair's header shows it): what the engines last reported, no call made.
  app.get("/api/engine/usage", async () => engine.usage.snapshot());
  app.get("/api/engine/tiles", async () => engine.tiles());
  app.get("/api/engine/tasks", async () => engine.store.list().map(publicTask));
  app.get<{ Params: { id: string } }>("/api/engine/tasks/:id", async (r, reply) => {
    const t = engine.store.get(Number(r.params.id));
    if (!t) return reply.code(404).send({ error: "no such task" });
    return { task: publicTask(t), log: engine.store.logs(t.id), events: engine.store.events(t.id) };
  });
  app.post<{ Params: { id: string; action: string } }>(
    "/api/engine/tasks/:id/:action",
    async (r, reply) => {
      try {
        return publicTask(engine.queue.act(Number(r.params.id), r.params.action, "owner"));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
  app.post<{ Params: { id: string; action: string } }>(
    "/api/engine/asks/:id/:action",
    async (r, reply) => {
      try {
        return engine.answerAsk(Number(r.params.id), r.params.action);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
  app.post<{ Body: Record<string, unknown> }>("/api/engine/tasks", async (r, reply) => {
    const b = r.body ?? {};
    try {
      return publicTask(
        engine.queue.add(String(b.prompt ?? ""), {
          project: String(b.project ?? "sandbox"),
          source: String(b.source ?? "queue-panel"),
          actor: "owner",
          model: (b.model as string) || null,
          engine: (b.engine as string) || null,
          requireApproval: Boolean(b.require_approval),
          attachments: (b.attachments as string[]) ?? [],
        }),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });
  // Ollama: what it has, and the address and model Hearth uses (Settings, Ember, Ollama).
  app.get<{ Querystring: { url?: string } }>("/api/engine/ollama", async (r, reply) => {
    try {
      return await engine.ollamaStatus(r.query.url);
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.put<{ Body: { url?: string; model?: string | null } }>(
    "/api/engine/ollama",
    async (r, reply) => {
      try {
        return await engine.setOllama({ url: r.body?.url, model: r.body?.model });
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
  app.post<{ Body: { model?: string } }>("/api/engine/ollama/prepare", async (r, reply) => {
    try {
      if (!r.body?.model) throw new QueueError("Say which model.");
      return await engine.prepareOllama(r.body.model);
    } catch (e) {
      return fail(reply, e);
    }
  });
  // The War Room's Full access switch, for Settings (the War Room reads it from the queue status).
  app.get("/api/engine/access", async () => ({
    full: engine.queue.askLevel === "free",
    level: engine.queue.askLevel,
  }));
  app.post<{ Params: { action: string } }>("/api/engine/queue/:action", async (r, reply) => {
    const q = engine.queue;
    switch (r.params.action) {
      case "pause":
        q.setPaused(true, "by you");
        break;
      case "resume":
        q.setPaused(false);
        break;
      case "kill":
        q.killSwitch("owner");
        break;
      case "full-on":
        q.setFullAccess(true);
        break;
      case "full-off":
        q.setFullAccess(false);
        break;
      // What the AI asks before acting: ask-strict, ask-moderate, ask-free.
      case "ask-strict":
      case "ask-moderate":
      case "ask-free": {
        const level = r.params.action.slice(4);
        if (isAskLevel(level)) q.setAskLevel(level);
        break;
      }
      case "more":
        engine.store.bumpUsage("cap_extra", 20);
        if (q.paused && /daily cap/.test(q.status().pause_reason)) q.setPaused(false);
        break;
      case "clear": {
        const cleared = engine.store.clearFinished("owner");
        engine.broadcast({ type: "cleared" });
        return { ...q.status(), cleared };
      }
      default:
        return reply.code(404).send({ error: "unknown queue action" });
    }
    return q.status();
  });
  app.post<{ Body: Record<string, unknown> }>("/api/engine/request", async (r, reply) => {
    try {
      return await engine.request(r.body as Parameters<Engine["request"]>[0]);
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get("/api/engine/projects", async () => engine.projects.list());

  // Coming in later stages: say so plainly instead of failing.
  const later = (what: string) => async (_r: FastifyRequest, reply: FastifyReply) =>
    reply.code(501).send({
      error: `${what} comes in a later stage of the engine.`,
      message: `${what} comes in a later stage of the engine.`,
    });
  // The GitHub panel: your repos and pull requests, read live with gh (read only).
  const gh = async <T>(reply: FastifyReply, f: (g: GitHub) => Promise<T>) => {
    if (!engine.github)
      return reply.code(503).send({
        error: "github-missing",
        message:
          "The GitHub tool (gh) isn't installed on this computer. Install it from cli.github.com, then sign in once with: gh auth login",
      });
    try {
      return await f(engine.github);
    } catch (e) {
      return reply
        .code(e instanceof GitHubError ? 502 : 500)
        .send({ error: "github", message: (e as Error).message });
    }
  };
  app.get<{ Querystring: { fresh?: string } }>("/api/engine/github/overview", (r, reply) =>
    gh(reply, (g) => g.overview(r.query.fresh === "1")),
  );
  app.get<{ Querystring: { repo?: string; fresh?: string } }>(
    "/api/engine/github/repo",
    (r, reply) => gh(reply, (g) => g.repoPage(String(r.query.repo ?? ""), r.query.fresh === "1")),
  );
  app.get<{ Querystring: { repo?: string; n?: string; fresh?: string } }>(
    "/api/engine/github/pr",
    (r, reply) =>
      gh(reply, (g) =>
        g.prPage(String(r.query.repo ?? ""), Number(r.query.n), r.query.fresh === "1"),
      ),
  );
  // The project's own repository, from its git remote (none: the panel opens on your GitHub).
  app.get<{ Querystring: { project?: string } }>("/api/engine/github/project", async (r) => {
    try {
      const p = engine.projects.get(String(r.query.project ?? ""));
      const url = await new Promise<string>((resolve) =>
        execFile(
          "git",
          ["-C", p.path, "remote", "get-url", "origin"],
          { windowsHide: true, timeout: 10_000 },
          (err, out) => resolve(err ? "" : String(out)),
        ),
      );
      const repo = repoOfRemote(url);
      return repo ? { repo } : {};
    } catch {
      return {};
    }
  });
  // What the AI did on GitHub, step by step (filled as the engine learns to follow it).
  app.get("/api/engine/github/feed", async () => ({ items: [] }));
  app.post<{ Body: { engine?: string } }>("/api/engine/usage/refresh", async (r) =>
    engine.usage.refresh(r.body?.engine ?? "claude-code"),
  );
  // Spoken replies in the voice chosen in Settings. Without a voice set up, the browser speaks.
  app.post<{ Body: { text?: string } }>("/api/engine/voice/tts", async (r, reply) => {
    const text = String(r.body?.text ?? "").slice(0, 8000);
    if (!voice || !text.trim()) return reply.code(204).send();
    const audio = await voice.speak(text);
    return reply.type("audio/wav").header("cache-control", "no-store").send(audio);
  });
  // The built-in voice's memory: whether its helper is loaded, and freeing it now (10-26).
  app.get("/api/engine/voice/memory", async () => ({ loaded: voice?.voiceLoaded?.() ?? false }));
  app.post("/api/engine/voice/memory/release", async () => {
    voice?.releaseBuiltin?.();
    return { loaded: voice?.voiceLoaded?.() ?? false };
  });
  app.post("/api/engine/skills/:id/run", later("Skills"));
  // Your Claude artifacts: copies of the claude.ai artifacts in your account, kept on your main
  // Hearth (every PC and device reads them there). claude.ai has no API for them, so Claude Code
  // (which can read them) saves them here when you ask it to "sync my Claude artifacts":
  // <data>/claude-artifacts/index.json and one folder per artifact. Read only from here.
  const claudeDir = () => path.join(engine.opts.dataDir, "claude-artifacts");
  app.get("/api/engine/claude-artifacts", async () => {
    try {
      return JSON.parse(readFileSync(path.join(claudeDir(), "index.json"), "utf8")) as unknown;
    } catch {
      return { synced_at: null, artifacts: [] };
    }
  });
  app.post("/api/engine/claude-artifacts/preview", async () => {
    mkdirSync(claudeDir(), { recursive: true });
    return engine.newPreview(claudeDir());
  });
  app.get<{ Querystring: { path?: string; download?: string } }>(
    "/api/engine/claude-artifacts/file",
    async (r, reply) => {
      const root = path.resolve(claudeDir());
      const f = path.resolve(root, r.query.path ?? "");
      const inside = path.relative(root, f);
      if (
        !inside ||
        inside.startsWith("..") ||
        path.isAbsolute(inside) ||
        !existsSync(f) ||
        !statSync(f).isFile()
      )
        return reply.code(404).send({ error: "not found", message: "No such file." });
      reply.header("content-type", contentType(f));
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "sandbox; default-src 'none'");
      if (r.query.download)
        reply.header("content-disposition", `attachment; filename="${path.basename(f)}"`);
      return reply.send(createReadStream(f));
    },
  );
  app.get("/api/engine/voice", async () => ({
    stt: Boolean(voice && (await voice.config()).host),
  }));
  app.post<{ Body: { text?: string } }>("/api/engine/voice/sentences", async (r) => ({
    sentences: sentencesOf(String(r.body?.text ?? "")),
  }));
  app.post<{ Body: { name?: string; description?: string; color?: string } }>(
    "/api/engine/projects",
    async (r, reply) => {
      try {
        const color = r.body?.color;
        if (color !== undefined && !isProjectColor(color))
          throw new ProjectError(`'${String(color)}' is not a project color`);
        const p = engine.projects.create(
          r.body?.name ?? "",
          r.body?.description ?? "",
          undefined,
          color,
        );
        engine.broadcast({ type: "projects", projects: [p] });
        return p;
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
  app.patch<{
    Params: { slug: string };
    Body: { name?: string; description?: string; color?: string | null };
  }>("/api/engine/projects/:slug", async (r, reply) => {
    try {
      const color = r.body?.color;
      if (color !== undefined && color !== null && !isProjectColor(color))
        throw new ProjectError(`'${String(color)}' is not a project color`);
      const p = engine.projects.edit(r.params.slug, {
        ...(typeof r.body?.name === "string" ? { name: r.body.name } : {}),
        ...(typeof r.body?.description === "string" ? { description: r.body.description } : {}),
        ...(color !== undefined ? { color } : {}),
      });
      engine.broadcast({ type: "projects", projects: [p] });
      return p;
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.delete<{ Params: { slug: string } }>("/api/engine/projects/:slug", async (r, reply) => {
    try {
      engine.deleteProject(r.params.slug);
      return { deleted: r.params.slug };
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get<{ Params: { slug: string }; Querystring: { limit?: string } }>(
    "/api/engine/projects/:slug/messages",
    async (r) => engine.store.messages(r.params.slug, Math.min(1000, Number(r.query.limit) || 150)),
  );
  app.get<{ Params: { slug: string } }>("/api/engine/projects/:slug/files", async (r, reply) => {
    try {
      return engine.projects.files(r.params.slug);
    } catch (e) {
      return fail(reply, e);
    }
  });
  app.get<{ Params: { slug: string }; Querystring: { path?: string; download?: string } }>(
    "/api/engine/projects/:slug/file",
    async (r, reply) => {
      try {
        const f = engine.projects.resolve(r.params.slug, r.query.path ?? "");
        reply.header("content-type", contentType(f));
        reply.header("x-content-type-options", "nosniff");
        // Never runs as a page from here.
        reply.header("content-security-policy", "sandbox; default-src 'none'");
        if (r.query.download)
          reply.header("content-disposition", `attachment; filename="${path.basename(f)}"`);
        return reply.send(createReadStream(f));
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
  app.post<{ Params: { slug: string } }>("/api/engine/projects/:slug/preview", async (r, reply) => {
    try {
      return engine.newPreview(engine.projects.get(slugOf(r)).path);
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Raw bytes in (uploads): their own scope, so Hearth's JSON parser is not involved.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 30 * 1024 * 1024 },
      (_r, b, done) => done(null, b),
    );
    const nameOf = (r: FastifyRequest) =>
      decodeURIComponent(String(r.headers["x-filename"] ?? "file"));
    // What you said (16 kHz, 16-bit mono from the War Room's microphone) to text.
    scope.post("/api/engine/voice/stt", async (r, reply) => {
      if (!voice) return later("Talking to the War Room")(r, reply);
      const audio = r.body as Buffer;
      if (!Buffer.isBuffer(audio) || !audio.length) return { text: "" };
      return { text: (await voice.transcribe(audio, 16000)).trim() };
    });
    scope.post<{ Querystring: { project?: string } }>("/api/engine/attachments", async (r) =>
      engine.holdUpload(r.query.project ?? "sandbox", nameOf(r), r.body as Buffer),
    );
    scope.post<{ Params: { slug: string } }>(
      "/api/engine/projects/:slug/upload",
      async (r, reply) => {
        try {
          const rel = engine.projects.saveUpload(r.params.slug, nameOf(r), r.body as Buffer);
          engine.broadcast({ type: "files", project: r.params.slug });
          return { path: rel };
        } catch (e) {
          return fail(reply, e);
        }
      },
    );
  });

  // Previews: the key is the permission (frames are sandboxed, so they carry no sign-in).
  app.get<{ Params: { key: string; "*": string } }>("/engine-preview/:key/*", async (r, reply) => {
    const f = engine.previewFile(r.params.key, r.params["*"]);
    if (!f) return reply.code(404).send("Not found");
    reply.header("content-type", contentType(f));
    reply.header(
      "content-security-policy",
      "sandbox allow-scripts allow-forms allow-modals allow-popups",
    );
    reply.header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(f));
  });

  // The live connection: the owner's page only (session cookie and same origin).
  const wss = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const [url, search] = (req.url ?? "").split("?") as [string, string | undefined];
    if (url !== "/api/engine/ws" && url !== "/api/engine/ws/term") {
      if (app.server.listenerCount("upgrade") === 1) socket.destroy();
      return;
    }
    const refuse = (code: number, text: string) =>
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
        socket.destroy(),
      );
    void (async () => {
      // From your Hearth over this PC's link (docs/design/ONE_ACCOUNT.md), or the owner's page.
      if (req.headers[LINK_HEADER] !== LINK_SECRET) {
        if (!sameOrigin(req.headers)) return refuse(403, "Forbidden");
        const session = await engine.opts
          .session(cookieValue(req.headers.cookie, engine.opts.cookieName))
          .catch(() => null);
        if (!session) return refuse(401, "Unauthorized");
      }
      if (url === "/api/engine/ws/term") {
        const term = engine.terminalFor(new URLSearchParams(search ?? ""));
        if (!term) return refuse(404, "Not Found");
        wss.handleUpgrade(req, socket, head, (ws) => void engine.attachTerminal(ws, term));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        engine["sockets"].add(ws);
        ws.on("close", () => engine["sockets"].delete(ws));
        ws.send(JSON.stringify({ type: "hello", queue: engine.queue.status() }));
      });
    })();
  });
  app.addHook("onClose", async () => {
    engine.stop();
    wss.close();
  });
}
