import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Terminals } from "../engine/terminal";
import { remoteTitle } from "../engine/remote";
import { LairRemotes, type LairRemoteDeps } from "./lair-remote";

const until = async (ok: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

// A stand-in for Claude Code: notes how it was started (and the instructions file it was given),
// shows a session address, answers each typed message in its transcript, and asks a permission
// question when told "ask".
const FAKE_CLAUDE = `
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const sid = args.includes("--session-id") ? at("--session-id") : at("--resume");
fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify({ args, system: fs.readFileSync(at("--append-system-prompt-file"), "utf8"), mcp: fs.readFileSync(at("--mcp-config"), "utf8") }));
const file = path.join(process.env.FAKE_TRANSCRIPTS, process.cwd().replace(/[^A-Za-z0-9]/g, "-"), sid + ".jsonl");
fs.mkdirSync(path.dirname(file), { recursive: true });
process.stdout.write("Remote Control active: https://claude.ai/code/session_LAIR1\\r\\n");
const line = (o) => fs.appendFileSync(file, JSON.stringify(o) + "\\n");
let buf = "";
let asking = false;
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (asking && /^[0-9]$/.test(buf)) {
    asking = false;
    process.stdout.write("\\x1b[2J\\x1b[H");
    line({ type: "assistant", uuid: "k" + Date.now(), message: { content: [{ type: "text", text: "pressed " + buf }] } });
    buf = "";
    return;
  }
  if (!buf.includes("\\r")) return;
  const text = buf.replace(/\\x1b\\[20[01]~/g, "").replace(/\\r/g, "").trim();
  buf = "";
  if (text === "trylogin") {
    line({ type: "user", uuid: "l" + Date.now(), message: { content: "<local-command-stdout>/login isn't available over Remote Control.</local-command-stdout>" } });
    return;
  }
  if (text === "ask") {
    asking = true;
    process.stdout.write("\\x1b[2J\\x1b[H" + "─".repeat(40) + "\\r\\n Bash command\\r\\n   docker restart sonarr\\r\\n\\r\\n Do you want to proceed?\\r\\n ❯ 1. Yes\\r\\n   2. No\\r\\n\\r\\n");
    return;
  }
  line({ type: "user", uuid: "u" + Date.now(), message: { content: text } });
  line({ type: "assistant", uuid: "a" + Date.now(), message: { content: [{ type: "text", text: "echo: " + text }] } });
  line({ type: "user", uuid: "p" + Date.now(), message: { content: "typed on the phone" } });
});
`;

describe("Remote Control in the Lair", () => {
  const made: LairRemotes[] = [];
  const terms = new Terminals();
  afterEach(() => {
    for (const m of made) m.stopAll();
    terms.stopAll();
  });

  function setup(over: Partial<LairRemoteDeps> = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-lair-rc-"));
    const cwd = path.join(dir, "lair");
    const transcripts = path.join(dir, "transcripts");
    mkdirSync(cwd);
    const script = path.join(dir, "fake-claude.cjs");
    writeFileSync(script, FAKE_CLAUDE);
    process.env.FAKE_TRANSCRIPTS = transcripts;
    process.env.FAKE_ARGS = path.join(dir, "args.json");
    const said: { conv: string; role: string; text: string }[] = [];
    const settings = new Map<string, unknown>();
    const released: string[] = [];
    let renewed = 0;
    const deps: LairRemoteDeps = {
      terminals: () => terms,
      binary: () => process.execPath,
      pcName: () => "Homeserver",
      setup: async (id) => ({
        system: `You are Ember.\n\nThe conversation so far:\nOwner: is Plex up? (${id})`,
        mcpUrl: "http://127.0.0.1:7600/api/mcp",
        key: "dca_test_key_for_lair_remote_control",
        renew: async () => void renewed++,
        release: async () => void released.push(id),
        full: false,
        cwd,
        name: "Main",
      }),
      say: async (conv, role, text) => void said.push({ conv, role, text }),
      setting: async (k, d) => (settings.has(k) ? (settings.get(k) as never) : d),
      setSetting: async (k, v) => void settings.set(k, v),
      launch: [script],
      transcripts,
      ...over,
    };
    const lair = new LairRemotes(deps);
    made.push(lair);
    const args = () =>
      JSON.parse(readFileSync(process.env.FAKE_ARGS!, "utf8")) as {
        args: string[];
        system: string;
        mcp: string;
      };
    return { lair, deps, said, settings, released, args, renewed: () => renewed };
  }

  it("names it Hearth • PC • Lair • Main, as Alex asked (11-04)", () => {
    expect(remoteTitle("Homeserver", "Lair", "Main")).toBe("Hearth • Homeserver • Lair • Main");
    expect(remoteTitle("Homeserver", "War Room", " Garden  plans ")).toBe(
      "Hearth • Homeserver • War Room • Garden plans",
    );
  });

  it("turns on with /rc: Ember's instructions, Hearth's tools, both sides mirrored", async () => {
    const { lair, said, settings, args } = setup();
    expect(await lair.handle("c1", "hello")).toBeUndefined();
    expect((await lair.handle("c1", "/rc"))?.reply).toMatch(/Starting Remote Control/);
    await until(() => lair.status("c1")?.url === "https://claude.ai/code/session_LAIR1");
    expect(lair.status("c1")).toMatchObject({
      title: "Hearth • Homeserver • Lair • Main",
      connecting: false,
    });
    await until(() => said.some((m) => m.text.includes("Remote Control is on. In the Claude app")));
    expect(said.find((m) => m.text.startsWith("Remote Control is on."))?.text).toContain(
      "Hearth • Homeserver • Lair • Main",
    );
    const a = args();
    expect(a.args[a.args.indexOf("--remote-control") + 1]).toBe(
      "Hearth • Homeserver • Lair • Main",
    );
    expect(a.args).toContain("acceptEdits");
    expect(a.args.join(" ")).toContain("mcp__dragon-control");
    expect(a.system).toContain("The conversation so far:");
    expect(JSON.parse(a.mcp).mcpServers["dragon-control"].url).toBe(
      "http://127.0.0.1:7600/api/mcp",
    );
    expect(settings.get("lair_rc_active")).toEqual(["c1"]);

    // While it is on, the owner's messages go into the session; replies and the phone come back.
    expect(await lair.handle("c1", "check the queue")).toEqual({ reply: "" });
    await until(() => said.some((m) => m.role === "agent" && m.text === "echo: check the queue"));
    await until(() => said.some((m) => m.role === "you" && m.text === "typed on the phone"));
    // /login in the Claude app is refused there: Hearth says where it works.
    await lair.handle("c1", "trylogin");
    await until(() =>
      said.some((m) => m.role === "note" && m.text.includes("Type /login here in Hearth")),
    );
    // What the owner typed in Hearth is stored once, not again from the transcript.
    expect(said.filter((m) => m.role === "you" && m.text === "check the queue")).toHaveLength(1);
  }, 30000);

  it("shows Claude Code's question and presses the number the owner types", async () => {
    const { lair, said } = setup();
    await lair.handle("c2", "/rc");
    await until(() => Boolean(lair.status("c2")?.url));
    await lair.handle("c2", "ask");
    await until(() => said.some((m) => m.text.startsWith("Claude Code is asking: Bash command")));
    const q = said.find((m) => m.text.startsWith("Claude Code is asking"))!.text;
    expect(q).toContain("docker restart sonarr");
    expect(q).toContain("1. Yes");
    expect(q).toContain("Answer here, or in the Claude app.");
    await lair.handle("c2", "1");
    await until(() => said.some((m) => m.text === "pressed 1"));
    await until(() => said.some((m) => m.text === "Answered: Yes."));
  }, 30000);

  it("turns off with /rc again: one note, the key released, and not restored after", async () => {
    const { lair, said, settings, released } = setup();
    await lair.handle("c3", "/rc");
    await until(() => Boolean(lair.status("c3")?.url));
    expect((await lair.handle("c3", "/rc"))?.reply).toBe(
      "Remote Control is off. Type /rc to turn it back on.",
    );
    await until(() => released.includes("c3"));
    await until(() => !(settings.get("lair_rc_active") as string[]).includes("c3"));
    expect(said.some((m) => m.text.startsWith("Remote Control ended"))).toBe(false);
    expect(lair.status("c3")).toBeUndefined();
    // Off: an ordinary message is Ember's again.
    expect(await lair.handle("c3", "hello")).toBeUndefined();
  }, 30000);

  it("comes back on after a restart, and says plainly why when it cannot start", async () => {
    const first = setup();
    await first.lair.handle("c4", "/rc");
    await until(() => Boolean(first.lair.status("c4")?.url));
    // Hearth stops: the session ends without being switched off, so it is still listed.
    first.lair.stopAll();
    await until(() => !first.lair.status("c4"));
    expect(first.settings.get("lair_rc_active")).toEqual(["c4"]);
    const again = new LairRemotes({
      ...first.deps,
      setting: async (k, d) => (first.settings.has(k) ? (first.settings.get(k) as never) : d),
    });
    made.push(again);
    await again.restore();
    await until(() => Boolean(again.status("c4")?.url));

    const refused = setup({
      setup: async () => {
        throw new Error(
          "Remote Control is part of Claude Code, and Ember runs on Ollama right now.",
        );
      },
    });
    expect((await refused.lair.handle("c5", "/rc"))?.reply).toMatch(/Ember runs on Ollama/);
    expect(refused.lair.status("c5")).toBeUndefined();
  }, 40000);
});
