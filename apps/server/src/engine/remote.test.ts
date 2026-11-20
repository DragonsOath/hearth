import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findBypassWarning,
  findPrompt,
  highlighted,
  Remotes,
  type Prompt,
  type RemoteHub,
} from "./remote";
import { Terminals } from "./terminal";

const until = async (ok: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("Remote Control: reading Claude Code's screen", () => {
  it("finds a permission prompt, its details, and its numbered options", () => {
    const lines = [
      "some earlier output",
      "────────────────────────────────────────",
      " Bash command",
      "   docker restart sonarr",
      "   Restart the Sonarr container",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for docker restart commands in",
      "      /home/alex/project",
      "   3. No, and tell Claude what to do differently (esc)",
      "",
    ];
    const p = findPrompt(lines)!;
    expect(p.title).toBe("Bash command");
    expect(p.details).toContain("docker restart sonarr");
    expect(p.question).toBe("Do you want to proceed?");
    expect(p.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
    expect(p.options[1]!.label).toContain("/home/alex/project");
  });

  it("finds nothing when no question is on screen", () => {
    expect(findPrompt(["just working", "❯ 1. not a question"])).toBeNull();
    expect(findBypassWarning(["just working"])).toBeNull();
  });

  it("finds Claude Code's one-time Bypass Permissions warning, even squashed", () => {
    const p = findBypassWarning([
      " WARNING: Claude Code running in Bypass Permissions mode",
      " By proceeding, you accept all responsibility for actions taken while running in",
      " Bypass Permissions mode.",
      " ❯ 1. No, exit",
      "   2. Yes, I accept",
      " Enter to confirm · Esc to cancel",
    ])!;
    expect(p.options).toEqual([
      { key: "1", label: "No, exit" },
      { key: "2", label: "Yes, I accept" },
    ]);
    expect(p.enter).toBe(true);
    expect(
      findBypassWarning(["BypassPermissionsmode", "Yes,Iaccept Entertoconfirm"]),
    ).not.toBeNull();
    // Newer Claude Code shows it without numbers; the highlight says where Enter lands.
    const plain = [" Bypass Permissions mode", " ❯ No, exit", "   Yes, I accept"];
    const options = findBypassWarning(plain)!.options;
    expect(highlighted(plain, options)).toBe(0);
    expect(highlighted([" No, exit", " ❯ Yes, I accept"], options)).toBe(1);
  });
});

// A stand-in for Claude Code: shows a session address, then answers each typed message by
// writing both sides into its transcript, the way the real one does.
const FAKE_CLAUDE = `
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const resume = args.includes("--resume");
const sid = args[args.indexOf(resume ? "--resume" : "--session-id") + 1];
const file = path.join(process.env.FAKE_TRANSCRIPTS, process.cwd().replace(/[^A-Za-z0-9]/g, "-"), sid + ".jsonl");
// Like Claude Code: resuming a conversation it never kept quits at once.
if (resume && !fs.existsSync(file)) {
  process.stdout.write("No conversation found with session ID: " + sid + "\\r\\n");
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
let warned = Boolean(process.env.FAKE_BYPASS);
// Like Claude Code 2.1.3xx: no numbers; arrows move the highlight, Enter picks it ("No, exit" quits).
let at = 0;
if (warned)
  process.stdout.write("WARNING: Claude Code running in Bypass Permissions mode\\r\\n\\u276f No, exit\\r\\n  Yes, I accept\\r\\nEnter to confirm\\r\\n");
else if (process.env.FAKE_REDRAW)
  // Like a resumed session: the link is redrawn with a cursor jump, so the raw output misses a letter.
  process.stdout.write("https://claude.ai/cXde/session_REDRAW1\\r\\x1b[19Co\\r\\n");
else process.stdout.write("Remote Control active: https://claude.ai/code/session_TEST123\\r\\n");
let buf = "";
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (warned) {
    if (buf.includes("\\x1b[B")) at = 1;
    if (buf.includes("\\x1b[A")) at = 0;
    if (buf.includes("\\r")) {
      if (at === 0) process.exit(0);
      warned = false;
      process.stdout.write("\\x1b[2J\\x1b[HRemote Control active: https://claude.ai/code/session_TEST123\\r\\n");
    }
    buf = "";
    return;
  }
  if (!buf.includes("\\r")) return;
  const text = buf.replace(/\\x1b\\[20[01]~/g, "").replace(/\\r/g, "").trim();
  buf = "";
  const line = (o) => fs.appendFileSync(file, JSON.stringify(o) + "\\n");
  line({ type: "user", uuid: "u" + Date.now(), message: { content: text } });
  line({ type: "assistant", uuid: "a" + Date.now(), message: { content: [{ type: "text", text: "echo: " + text }] } });
  line({ type: "user", uuid: "p" + Date.now(), message: { content: "typed on the phone" } });
});
`;

describe("Remote Control: a live session", () => {
  const terms = new Terminals();
  afterEach(() => terms.stopAll());

  it("connects, mirrors both sides of the conversation, and skips what Hearth typed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-rc-"));
    const cwd = path.join(dir, "project");
    const transcripts = path.join(dir, "transcripts");
    mkdirSync(cwd);
    const script = path.join(dir, "fake-claude.cjs");
    writeFileSync(script, FAKE_CLAUDE);
    process.env.FAKE_TRANSCRIPTS = transcripts;

    const said: [string, string][] = [];
    let changed = 0;
    let active: boolean | undefined;
    const hub: RemoteHub = {
      message: (_p, role, text) => said.push([role, text]),
      ask: (_p: string, _q: Prompt) => 1,
      askClosed: () => undefined,
      changed: () => changed++,
      saveSession: () => undefined,
      active: (_p, on) => (active = on),
      ended: () => undefined,
    };
    const remotes = new Remotes(terms, hub);
    const r = await remotes.start({
      slug: "garden",
      name: "Garden",
      cwd,
      sid: null,
      binary: process.execPath,
      launch: [script],
      allowedTools: ["Read"],
      transcripts,
    });
    expect(active).toBe(true);
    await until(() => r.url === "https://claude.ai/code/session_TEST123");
    expect(changed).toBeGreaterThan(0);
    expect(said[0]![1]).toContain("Remote Control is on for **Garden**");

    r.send("plan the beds");
    await until(() => said.some(([, t]) => t === "echo: plan the beds"));
    await until(() => said.some(([, t]) => t === "typed on the phone"));
    // What Hearth typed is already in the chat, so its echo from the transcript is skipped.
    expect(said.filter(([role, t]) => role === "you" && t === "plan the beds")).toHaveLength(0);
    expect(said).toContainEqual(["you", "typed on the phone"]);
    expect(remotes.public()).toEqual([expect.objectContaining({ project: "garden" })]);
    r.stop();
  }, 30000);

  it("starts afresh when the saved conversation was never kept, instead of quitting", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-rc-"));
    const cwd = path.join(dir, "project");
    const transcripts = path.join(dir, "transcripts");
    mkdirSync(cwd);
    const script = path.join(dir, "fake-claude.cjs");
    writeFileSync(script, FAKE_CLAUDE);
    process.env.FAKE_TRANSCRIPTS = transcripts;
    const hub: RemoteHub = {
      message: () => undefined,
      ask: () => 1,
      askClosed: () => undefined,
      changed: () => undefined,
      saveSession: () => undefined,
      active: () => undefined,
      ended: () => undefined,
    };
    // A session saved when the last start ended at the Full access warning: no transcript.
    const r = await new Remotes(terms, hub).start({
      slug: "garden",
      name: "Garden",
      cwd,
      sid: "fce53db7-d34e-445b-8d64-e347c785b27a",
      binary: process.execPath,
      launch: [script],
      allowedTools: [],
      transcripts,
    });
    await until(() => r.url === "https://claude.ai/code/session_TEST123");
    expect(r.closed).toBe(false);
    r.stop();
  }, 30000);

  it("asks the owner about the one-time Bypass Permissions warning, then connects", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-rc-"));
    const cwd = path.join(dir, "project");
    const transcripts = path.join(dir, "transcripts");
    mkdirSync(cwd);
    const script = path.join(dir, "fake-claude.cjs");
    writeFileSync(script, FAKE_CLAUDE);
    process.env.FAKE_TRANSCRIPTS = transcripts;
    process.env.FAKE_BYPASS = "1";
    try {
      const asked: Prompt[] = [];
      const closed: string[] = [];
      const hub: RemoteHub = {
        message: () => undefined,
        ask: (_p, q) => (asked.push(q), 7),
        askClosed: (_id, answered) => void closed.push(answered),
        changed: () => undefined,
        saveSession: () => undefined,
        active: () => undefined,
        ended: () => undefined,
      };
      const r = await new Remotes(terms, hub).start({
        slug: "garden",
        name: "Garden",
        cwd,
        sid: null,
        binary: process.execPath,
        launch: [script],
        allowedTools: [],
        permissionMode: "bypassPermissions",
        transcripts,
      });
      await until(() => asked.length > 0);
      expect(asked[0]!.question).toBe("Accept Bypass Permissions mode?");
      // Hearth never accepts it by itself: no address until the owner answers.
      expect(r.url).toBeNull();
      r.answer("2", "Yes, I accept");
      await until(() => r.url === "https://claude.ai/code/session_TEST123");
      await until(() => closed.includes("Yes, I accept"));
      r.stop();
    } finally {
      delete process.env.FAKE_BYPASS;
    }
  }, 30000);

  it("finds the link on the rendered screen when the raw output is missing letters", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-rc-"));
    const cwd = path.join(dir, "project");
    const transcripts = path.join(dir, "transcripts");
    mkdirSync(cwd);
    const script = path.join(dir, "fake-claude.cjs");
    writeFileSync(script, FAKE_CLAUDE);
    process.env.FAKE_TRANSCRIPTS = transcripts;
    process.env.FAKE_REDRAW = "1";
    try {
      const said: string[] = [];
      const hub: RemoteHub = {
        message: (_p, _role, text) => said.push(text),
        ask: () => 1,
        askClosed: () => undefined,
        changed: () => undefined,
        saveSession: () => undefined,
        active: () => undefined,
        ended: () => undefined,
      };
      const r = await new Remotes(terms, hub).start({
        slug: "garden",
        name: "Garden",
        cwd,
        sid: null,
        binary: process.execPath,
        launch: [script],
        allowedTools: ["Read"],
        transcripts,
      });
      await until(() => r.url === "https://claude.ai/code/session_REDRAW1");
      expect(said[0]).toContain("Remote Control is on for **Garden**");
      r.stop();
    } finally {
      delete process.env.FAKE_REDRAW;
    }
  }, 30000);
});
