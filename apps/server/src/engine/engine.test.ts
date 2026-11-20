import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { lookPersonaInstruction } from "@dragon-control/core";
import { Engine } from "./service";
import { EngineStore, TransitionError } from "./store";
import { slugify } from "./projects";
import {
  ClaudeCode,
  Codex,
  FakeRunner,
  FULL_ACCESS_NOTE,
  askNote,
  HEARTH_TOOLS_NOTE,
  summarizeTool,
  type RunOptions,
  type Runner,
} from "./runners";
import { Terminals } from "./terminal";
import { fakeOllamaFetch } from "./ollama";

// The engine's tables, and the later changes to them (other tables in those files are skipped).
const SCHEMA = [
  ...readFileSync(path.join(__dirname, "../../drizzle/0054_engine.sql"), "utf8").split(
    "--> statement-breakpoint",
  ),
  ...readFileSync(path.join(__dirname, "../../drizzle/0062_project_color.sql"), "utf8")
    .split("--> statement-breakpoint")
    .filter((s) => s.includes("`engine_")),
].join("\n");

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(SCHEMA);
  return d;
}

const engines: Engine[] = [];
afterEach(() => {
  while (engines.length) engines.pop()!.stop();
});

function engine(extra: { pcName?: () => string; ollamaFetch?: typeof fetch } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "hearth-engine-"));
  const events: Record<string, unknown>[] = [];
  const e = new Engine({
    db: db(),
    dataDir: dir,
    workspaces: path.join(dir, "projects"),
    session: async () => ({}),
    cookieName: "dc_session",
    fakeRunner: true,
    ...extra,
  });
  const send = e["send"].bind(e);
  e["send"] = (ev: Record<string, unknown>) => {
    events.push(ev);
    send(ev);
  };
  engines.push(e);
  return { e, events, dir };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("engine store", () => {
  it("allows only the transitions EMBER allows, and records each one", () => {
    const s = new EngineStore(db());
    const t = s.addTask({
      title: "t",
      prompt: "p",
      project: "sandbox",
      engine: "claude-code",
      model: null,
      maxAttempts: 2,
      needsApproval: false,
      approvalReason: null,
      source: "test",
      actor: "owner",
    });
    expect(t.state).toBe("queued");
    expect(() => s.transition(t.id, "succeeded", { actor: "x" })).toThrow(TransitionError);
    s.transition(t.id, "running", { actor: "worker" });
    s.transition(t.id, "succeeded", { actor: "worker" });
    expect(() => s.transition(t.id, "queued", { actor: "x" })).toThrow(TransitionError);
    expect(s.events(t.id).map((e) => e.to_state)).toEqual(["queued", "running", "succeeded"]);
  });

  it("keeps cleared tasks, only hiding them from the queue view", () => {
    const s = new EngineStore(db());
    const t = s.addTask({
      title: "t",
      prompt: "p",
      project: "sandbox",
      engine: "claude-code",
      model: null,
      maxAttempts: 2,
      needsApproval: false,
      approvalReason: null,
      source: "test",
      actor: "owner",
    });
    s.transition(t.id, "cancelled", { actor: "owner" });
    expect(s.clearFinished("owner")).toBe(1);
    expect(s.list()).toHaveLength(0);
    expect(s.get(t.id)?.archived).toBe(1);
  });
});

describe("engine", () => {
  it("answers a chat message in the project's conversation, and keeps the conversation going", async () => {
    const { e, events } = engine();
    e.start();
    const r = await e.request({ text: "hello there", project: "sandbox" });
    expect(r.route).toBe("task");
    await until(() => e.store.messages("sandbox").some((m) => m.role === "ember"));
    const msgs = e.store.messages("sandbox");
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ["you", "hello there"],
      ["ember", "Heard you: hello there"],
    ]);
    expect(events.some((ev) => ev.type === "task_done")).toBe(true);
    // The next message continues the same conversation.
    const sid = e.store.setting<string | null>("session:sandbox:claude-code", null);
    expect(sid).toMatch(/^fake-/);
    await e.request({ text: "and again", project: "sandbox" });
    await until(() => e.store.messages("sandbox").filter((m) => m.role === "ember").length === 2);
    expect(e.store.setting("session:sandbox:claude-code", null)).toBe(sid);
  });

  it("renames a project and changes its description; the scratch project keeps its name", () => {
    const { e } = engine();
    const p = e.projects.create("Garden planner", "Plan the vegetable beds.");
    const after = e.projects.edit(p.slug, { name: "Garden 2026", description: "Beds and fence." });
    expect(after).toMatchObject({
      slug: p.slug,
      name: "Garden 2026",
      description: "Beds and fence.",
    });
    expect(after.path).toBe(p.path);
    expect(() => e.projects.edit(p.slug, { name: "  " })).toThrow(/needs a name/);
    expect(() => e.projects.edit("sandbox", { name: "x" })).toThrow(/keeps its name/);
  });

  it("keeps a project's color for its card on Home, and clears it", () => {
    const { e } = engine();
    const p = e.projects.create("Garden planner", "Plan the vegetable beds.", undefined, "green");
    expect(p.color).toBe("green");
    expect(e.projects.list().find((x) => x.slug === p.slug)?.color).toBe("green");
    expect(e.projects.edit(p.slug, { color: "purple" }).color).toBe("purple");
    // A rename leaves the color alone; null takes it off.
    expect(e.projects.edit(p.slug, { name: "Garden 2026" }).color).toBe("purple");
    expect(e.projects.edit(p.slug, { color: null }).color).toBeUndefined();
    expect(e.projects.create("Plain", "No color.").color).toBeUndefined();
  });

  it("deletes a project for good: folder, conversation, tasks; never the Sandbox or busy ones", async () => {
    const { e, events } = engine();
    e.start();
    const p = e.projects.create("Old idea", "Throw away.");
    await e.request({ text: "make a note", project: p.slug });
    await until(() => e.store.messages(p.slug).some((m) => m.role === "ember"));
    expect(existsSync(p.path)).toBe(true);

    e.deleteProject(p.slug);
    expect(existsSync(p.path)).toBe(false);
    expect(e.projects.has(p.slug)).toBe(false);
    expect(e.store.messages(p.slug)).toEqual([]);
    expect(e.store.list().some((t) => t.project === p.slug)).toBe(false);
    expect(e.store.setting(`session:${p.slug}:claude-code`, null)).toBeNull();
    expect(events).toContainEqual({ type: "project_deleted", project: p.slug });
    // The same name can be used again.
    expect(e.projects.create("Old idea", "Again.").slug).toBe(p.slug);

    expect(() => e.deleteProject("sandbox")).toThrow(/Sandbox can't be deleted/);
    expect(() => e.deleteProject("nope")).toThrow(/unknown project/);
    const busy = e.projects.create("Busy", "Working.");
    // A task waiting for approval holds it.
    e.store.addTask({
      title: "x",
      prompt: "x",
      project: busy.slug,
      engine: "claude-code",
      model: null,
      maxAttempts: 1,
      needsApproval: true,
      approvalReason: "test",
      source: "test",
      actor: "owner",
    });
    expect(() => e.deleteProject(busy.slug)).toThrow(/1 task queued or running/);
    expect(existsSync(busy.path)).toBe(true);
  });

  it("keeps the project's memory files current for Claude Code and Codex", async () => {
    const { e } = engine();
    e.start();
    const p = e.projects.create("Garden planner", "Plan the vegetable beds.");
    await e.request({ text: "start the plan", project: p.slug });
    await until(() => e.store.messages(p.slug).some((m) => m.role === "ember"));
    const claude = readFileSync(path.join(p.path, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Plan the vegetable beds.");
    expect(claude).toContain("@.hearth/recent-chat.md");
    expect(readFileSync(path.join(p.path, "AGENTS.md"), "utf8")).toContain(
      ".hearth/recent-chat.md",
    );
    expect(readFileSync(path.join(p.path, ".hearth", "chat.md"), "utf8")).toContain(
      "start the plan",
    );
    expect(existsSync(path.join(p.path, ".git"))).toBe(true);
  });

  it("holds work with risky words for the owner's approval", async () => {
    const { e } = engine();
    e.start();
    const r: { reply: string; task?: { id: number; state: string } } = await e.request({
      text: "please sudo restart the box",
      project: "sandbox",
    });
    expect(r.task?.state).toBe("awaiting_approval");
    expect(r.reply).toMatch(/waiting for your approval: risky words/);
    e.queue.act(r.task!.id, "approve", "owner");
    await until(() => e.store.get(r.task!.id)?.state === "succeeded");
  });

  it("the agent is never held back; the owner only chooses what it asks first (11-06)", async () => {
    const { e } = engine();
    e.start();
    const argvFor = () =>
      (new ClaudeCode("claude") as unknown as { build(o: unknown): string[] }).build({
        prompt: "x",
        cwd: ".",
        attachments: [],
        project: e.queue.settingsFor("sandbox"),
      });
    // A new install asks before every change, with the full agent.
    expect(e.queue.status().ask_level).toBe("strict");
    const s = e.queue.settingsFor("sandbox");
    expect(s.permissionMode).toBe("bypassPermissions");
    expect(s.allowedTools).toEqual([]);
    expect(argvFor().join(" ")).toContain(askNote("strict"));
    expect(argvFor()).not.toContain("--allowedTools");
    // Strict and Moderate also hold a message with risky words until the owner approves it.
    const held: { task?: { state: string } } = await e.request({
      text: "please sudo restart the box",
      project: "sandbox",
    });
    expect(held.task?.state).toBe("awaiting_approval");
    e.queue.setAskLevel("moderate");
    expect(argvFor().join(" ")).toContain(askNote("moderate"));
    // Free: only serious steps are asked about, in the reply; no word holds.
    e.queue.setAskLevel("free");
    expect(e.queue.status().full_access).toBe(true);
    expect(argvFor().join(" ")).toContain(FULL_ACCESS_NOTE);
    const r: { task?: { state: string } } = await e.request({
      text: "please sudo restart the box",
      project: "sandbox",
    });
    expect(r.task?.state).not.toBe("awaiting_approval");
    // The old switch maps onto the levels.
    e.queue.setFullAccess(false);
    expect(e.queue.askLevel).toBe("strict");
    e.queue.setFullAccess(true);
    expect(e.queue.askLevel).toBe("free");
    // Each rule says when to stop and ask.
    expect(askNote("strict")).toMatch(/before every change/);
    expect(askNote("moderate")).toMatch(/before anything risky/);
    expect(askNote("free")).toMatch(/only before serious consequences/);
  });

  it("an install that had Full access on keeps asking only before serious steps", async () => {
    const { e } = engine();
    (e.queue as unknown as { store: { setSetting(k: string, v: unknown): void } }).store.setSetting(
      "full_access",
      true,
    );
    expect(e.queue.askLevel).toBe("free");
  });

  it("the War Room gets the Lair's Hearth tools for each run, and the key ends with the run", async () => {
    const { e } = engine();
    const opened: string[] = [];
    let released = 0;
    e.hearthTools = async (name) => {
      opened.push(name);
      return {
        url: "http://127.0.0.1:1/api/mcp",
        key: "agent-key-123",
        release: async () => void (released += 1),
      };
    };
    const runners = (e.queue as unknown as { runners: Record<string, Runner> }).runners;
    const fake = runners["claude-code"]!;
    const seen: RunOptions[] = [];
    runners["claude-code"] = {
      name: "claude-code",
      binary: "fake",
      run: (o) => {
        seen.push(o);
        // The config file exists while it runs, with the key in a header, never on the command line.
        expect(readFileSync(o.hearth!.config, "utf8")).toContain("Bearer agent-key-123");
        return fake.run(o);
      },
    };
    e.start();
    await e.request({ text: "hello", project: "sandbox" });
    await until(() => released === 1);
    expect(opened).toEqual(["claude-code"]);
    expect(seen[0]!.hearth!.url).toBe("http://127.0.0.1:1/api/mcp");
    expect(existsSync(seen[0]!.hearth!.config)).toBe(false);

    const o = { ...seen[0]!, resume: null, model: null };
    const claude = (new ClaudeCode("claude") as unknown as { build(o: unknown): string[] }).build(
      o,
    );
    expect(claude[claude.indexOf("--mcp-config") + 1]).toBe(o.hearth!.config);
    expect(claude).not.toContain("--strict-mcp-config");
    expect(claude.join(" ")).toContain(HEARTH_TOOLS_NOTE);
    expect(claude.join(" ")).not.toContain("agent-key-123");
    const codex = new Codex("codex") as unknown as {
      build(o: unknown): string[];
      env(o: unknown): NodeJS.ProcessEnv;
    };
    const args = codex.build(o).join(" ");
    expect(args).toContain('mcp_servers.hearth.url="http://127.0.0.1:1/api/mcp"');
    expect(args).not.toContain("agent-key-123");
    expect(codex.env(o).HEARTH_AGENT_KEY).toBe("agent-key-123");
    expect(codex.build({ ...o, hearth: undefined }).join(" ")).not.toContain("mcp_servers.hearth");
  });

  it("Turn on persona: every War Room agent gets the picture's persona; off, nothing changes", async () => {
    const { e } = engine();
    let persona: string | undefined = "Test persona for Gamer Ember";
    e.persona = async () => persona;
    const runners = (e.queue as unknown as { runners: Record<string, Runner> }).runners;
    const fake = runners["claude-code"]!;
    const seen: RunOptions[] = [];
    runners["claude-code"] = {
      name: "claude-code",
      binary: "fake",
      run: (o) => {
        seen.push(o);
        return fake.run(o);
      },
    };
    e.start();
    await e.request({ text: "hello", project: "sandbox" });
    await until(() => seen.length === 1);
    expect(seen[0]!.persona).toBe("Test persona for Gamer Ember");
    const o = { ...seen[0]!, resume: null, model: null };
    const claude = (new ClaudeCode("claude") as unknown as { build(o: unknown): string[] })
      .build(o)
      .join(" ");
    expect(claude).toContain(lookPersonaInstruction("Test persona for Gamer Ember"));
    const codex = new Codex("codex") as unknown as { input(o: unknown): string };
    expect(codex.input({ ...o, resume: "thread-1" })).toContain("Test persona for Gamer Ember");

    persona = undefined;
    await until(() => e.store.messages("sandbox").some((m) => m.role === "ember"));
    await e.request({ text: "again", project: "sandbox" });
    await until(() => seen.length === 2);
    expect(seen[1]!.persona).toBeUndefined();
    const off = { ...seen[1]!, resume: null, model: null };
    expect(
      (new ClaudeCode("claude") as unknown as { build(o: unknown): string[] }).build(off).join(" "),
    ).not.toContain("Voice and character");
    expect(codex.input({ ...off, resume: "thread-1" })).toBe("again");
  });

  it("never counts work that was running at a restart as done", () => {
    const { e } = engine();
    const t = e.queue.add("long job", { project: "sandbox", source: "test", actor: "owner" });
    e.store.transition(t.id, "running", { actor: "worker" });
    e.queue.recover();
    expect(e.store.get(t.id)?.state).toBe("interrupted");
  });

  it("pauses, and the kill switch stops new work", async () => {
    const { e } = engine();
    e.queue.killSwitch("owner");
    e.start();
    const t = e.queue.add("wait", { project: "sandbox", source: "test", actor: "owner" });
    await new Promise((r) => setTimeout(r, 300));
    expect(e.store.get(t.id)?.state).toBe("queued");
    expect(e.queue.status()).toMatchObject({ paused: true, pause_reason: "kill switch" });
  });

  it("refuses files outside a project and serves previews only with their key", () => {
    const { e } = engine();
    expect(() => e.projects.resolve("sandbox", "../../etc/passwd")).toThrow(/outside/);
    const key = e.newPreview(e.projects.get("sandbox").path).base.split("/")[2]!;
    expect(e.previewFile(key, "CLAUDE.md")).toMatch(/CLAUDE\.md$/);
    expect(e.previewFile(key, "../x")).toBeNull();
    expect(e.previewFile("wrong", "CLAUDE.md")).toBeNull();
  });

  it("Ollama: set up from its models, then answers like Claude Code, in its own conversation", async () => {
    const { e } = engine({ ollamaFetch: fakeOllamaFetch() });
    e.start();
    expect(e.config().engines.ollama).toMatchObject({ label: "Ollama", enabled: false });
    expect(e.config().engines.ollama!.note).toContain("Settings, Ember, Ollama");
    const off = (await e.request({ text: "hi", project: "sandbox", engine: "ollama" })) as {
      route: string;
    };
    expect(off.route).toBe("error");
    await expect(e.setOllama({ url: "http://ai-box", model: "chat-only:7b" })).rejects.toThrow(
      /can't use tools/,
    );
    await expect(e.setOllama({ url: "http://ai-box", model: "qwen3-coder:30b" })).rejects.toThrow(
      /memory window/,
    );
    await expect(e.setOllama({ url: "http://ai-box:11999", model: null })).rejects.toThrow(
      /can't reach/,
    );
    await e.setOllama({ url: "http://ai-box", model: null });
    const st = await e.prepareOllama("qwen3-coder:30b");
    expect(st.model).toBe("qwen3-coder-30b-hearth");
    expect(e.ollamaConfig()).toEqual({
      url: "http://ai-box:11434",
      model: "qwen3-coder-30b-hearth",
    });
    expect(e.config().engines.ollama!.enabled).toBe(true);
    await e.request({ text: "hello ollama", project: "sandbox", engine: "ollama" });
    await until(() =>
      e.store.messages("sandbox").some((m) => m.text === "Heard you: hello ollama"),
    );
    expect(e.store.setting<string | null>("session:sandbox:ollama", null)).toMatch(/^fake-/);
    expect(e.store.setting("session:sandbox:claude-code", null)).toBeNull();
  });

  it("switching AIs keeps the conversation: each one is handed what it missed", async () => {
    const { e } = engine({ ollamaFetch: fakeOllamaFetch() });
    e.start();
    await e.setOllama({ url: "http://ai-box", model: null });
    await e.prepareOllama("qwen3-coder:30b");
    const reply = (text: string) =>
      until(() => e.store.messages("sandbox").some((m) => m.text === `Heard you: ${text}`));
    const last = () => FakeRunner.prompts[FakeRunner.prompts.length - 1]!;

    await e.request({ text: "plan the garden beds", project: "sandbox" });
    await reply("plan the garden beds");
    expect(last()).toBe("plan the garden beds");

    // Ollama joins: it gets the conversation so far, then the new message.
    await e.request({ text: "what did we plan?", project: "sandbox", engine: "ollama" });
    await reply("what did we plan?");
    expect(last()).toContain("Owner: plan the garden beds");
    expect(last()).toContain("Claude Code: Heard you: plan the garden beds");
    expect(last().endsWith("what did we plan?")).toBe(true);

    // Back to Claude Code: its own session has the start, so it gets only what Ollama said.
    await e.request({ text: "carry on", project: "sandbox", engine: "claude-code" });
    await reply("carry on");
    expect(last()).toContain("Owner: what did we plan?");
    expect(last()).toContain("Ollama: Heard you: what did we plan?");
    expect(last()).not.toContain("Owner: plan the garden beds");

    // Nothing new from another AI: the message goes as it is.
    await e.request({ text: "and then?", project: "sandbox", engine: "claude-code" });
    await reply("and then?");
    expect(last()).toBe("and then?");
  });

  it("shows the PC's name set in Hearth, not the computer's own name", () => {
    const { e } = engine({ pcName: () => "Home Server" });
    expect(e.config().machine).toBe("Home Server");
  });

  it("names projects and tool steps plainly", () => {
    expect(slugify("Mom's Color by Numbers!")).toBe("mom-s-color-by-numbers");
    expect(summarizeTool("Bash", { command: "ls -la\nwc" })).toBe("Bash: ls -la wc");
  });

  it("runs a live terminal that remembers its screen for the next page", async () => {
    const terms = new Terminals();
    try {
      const t = await terms.get("sandbox:test", [process.execPath, "-i"], tmpdir(), 80, 24);
      const seen: string[] = [];
      t.clients.add({
        readyState: 1,
        OPEN: 1,
        send: (d: Buffer | string) => seen.push(String(d)),
      } as never);
      t.write("21*2" + String.fromCharCode(13));
      await until(() => seen.join("").includes("42"), 10000);
      // Asking again for the same project gives the same running session, with its screen.
      expect(await terms.get("sandbox:test", [process.execPath, "-i"], tmpdir(), 80, 24)).toBe(t);
      expect(String(t.replay())).toContain("42");
    } finally {
      terms.stopAll();
    }
  });
});

describe("/rc", () => {
  it("a plain /rc turns Remote Control off when it is on", async () => {
    const { e } = engine();
    let stopped = false;
    const fake = { url: "https://claude.ai/code/x", stop: () => (stopped = true) };
    (e.remotes as unknown as { get: (p: string) => unknown }).get = () =>
      stopped ? undefined : fake;
    await e.request({ text: "/rc" });
    expect(stopped).toBe(true);
    const last = e.store.messages("sandbox", 5).at(-1);
    expect(last?.text).toContain("Remote Control is off");
  });
});
