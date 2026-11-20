import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeSignIn, cleanCode, redactSecrets, signInLink } from "./claude-signin";

/**
 * The real sign-in, against a stand-in for `claude` that behaves the way Claude Code 2.1 does
 * without a terminal (checked on the home server): `auth login` prints Anthropic's link and waits for the
 * code on standard input, then exits 0, or 1 with "Login failed"; `auth status --json` reports.
 */
const FAKE = `
const fs = require("fs");
const [cmd, sub] = process.argv.slice(2);
const state = process.env.FAKE_CLAUDE_STATE;
if (cmd === "auth" && sub === "status") {
  const li = fs.existsSync(state);
  console.log(JSON.stringify(li
    ? { loggedIn: true, authMethod: "claude.ai", email: "owner@example.com" }
    : { loggedIn: false, authMethod: "none" }));
  process.exit(li ? 0 : 1);
}
if (cmd === "auth" && sub === "logout") { try { fs.unlinkSync(state); } catch {} process.exit(0); }
if (cmd === "auth" && sub === "login") {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s");
  process.stdout.write("Paste code here if prompted > ");
  let d = "";
  process.stdin.on("data", (c) => {
    d += c;
    if (!d.includes("\\n")) return;
    if (d.trim() === "GOODCODE123#state") {
      fs.writeFileSync(state, "sk-ant-oat01-THISISASECRETTOKENVALUE");
      console.log("Login successful. Token sk-ant-oat01-THISISASECRETTOKENVALUE stored.");
      process.exit(0);
    }
    console.log("Login failed: Request failed with status code 400");
    process.exit(1);
  });
}
`;

let dir: string;
let signIn: ClaudeSignIn;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"));
  const script = path.join(dir, "claude.cjs");
  writeFileSync(script, FAKE);
  process.env.FAKE_CLAUDE_STATE = path.join(dir, "signed-in");
  signIn = new ClaudeSignIn(process.execPath, [script]);
});

afterEach(() => {
  signIn.cancel();
  delete process.env.FAKE_CLAUDE_STATE;
  rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code sign-in from Hearth", () => {
  it("reads the status, starts the sign-in, and finishes it with the code", async () => {
    expect(await signIn.status()).toMatchObject({ installed: true, loggedIn: false });
    const started = await signIn.start();
    expect(new URL(started.url).hostname).toBe("claude.com");
    const done = await signIn.complete(started.id, " GOODCODE123#state \n");
    expect(done).toMatchObject({
      ok: true,
      status: { loggedIn: true, email: "owner@example.com" },
    });
    // Nothing the program said (including a token) is passed on.
    expect(JSON.stringify(done)).not.toContain("sk-ant");
    expect((await signIn.signOut()).loggedIn).toBe(false);
  });

  it("explains a code Anthropic refuses, and an old sign-in", async () => {
    const started = await signIn.start();
    const bad = await signIn.complete(started.id, "WRONGCODE1#state");
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.detail).toMatch(/did not accept that code/);
    const late = await signIn.complete(started.id, "GOODCODE123#state");
    expect(late).toMatchObject({ ok: false, expired: true });
  });

  it("starting again replaces an unfinished sign-in", async () => {
    const first = await signIn.start();
    const second = await signIn.start();
    expect((await signIn.complete(first.id, "GOODCODE123#state")).ok).toBe(false);
    expect((await signIn.complete(second.id, "GOODCODE123#state")).ok).toBe(true);
  });

  it("says so when Claude Code is not installed", async () => {
    const missing = new ClaudeSignIn(path.join(dir, "no-such-claude"));
    expect(await missing.status()).toMatchObject({ installed: false, loggedIn: false });
    await expect(missing.start()).rejects.toThrow(/not installed/);
  });
});

describe("sign-in helpers", () => {
  it("only accepts Anthropic's own HTTPS sign-in links", () => {
    expect(signInLink("visit: https://claude.com/cai/oauth/authorize?x=1 now")).toBe(
      "https://claude.com/cai/oauth/authorize?x=1",
    );
    expect(signInLink("visit: https://evil.example/oauth/authorize")).toBeUndefined();
    expect(signInLink("visit: http://claude.com/oauth/authorize")).toBeUndefined();
  });
  it("accepts a code-shaped value only, and removes secrets from text", () => {
    expect(cleanCode("abcDEF123#state")).toBe("abcDEF123#state");
    expect(cleanCode("abc def")).toBeUndefined();
    expect(cleanCode("x\ny")).toBeUndefined();
    expect(redactSecrets("token sk-ant-oat01-abc_DEF-123 here")).not.toContain("sk-ant");
  });
});
