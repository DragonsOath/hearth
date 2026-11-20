import { describe, expect, it } from "vitest";
import { fakeClaudeSignIn, TEST_SIGN_IN_CODE } from "./claude-signin";
import { ChatLogin, LOGIN_COMMAND, signedOutHint } from "./login-chat";

describe("/login from the chat (11-04)", () => {
  it("gives Anthropic's link, takes the code as the next message, and signs Claude Code in", async () => {
    const audit: string[] = [];
    const s = fakeClaudeSignIn();
    const login = new ChatLogin(
      () => s,
      async (a) => void audit.push(a),
    );
    expect(LOGIN_COMMAND.test("/login")).toBe(true);
    expect(LOGIN_COMMAND.test("/login please")).toBe(false);
    expect(await login.signedOut()).toBe(true);

    const started = await login.start("lair:c1");
    expect(started.url).toMatch(/^https:\/\/claude\.com\//);
    expect(started.text).toMatch(/paste it here as your next message/);
    // Only that conversation's next message, and only something shaped like a code.
    expect(login.expects("lair:c2", TEST_SIGN_IN_CODE)).toBe(false);
    expect(login.expects("lair:c1", "what is the weather like")).toBe(false);
    expect(login.expects("lair:c1", TEST_SIGN_IN_CODE)).toBe(true);

    const done = await login.finish(TEST_SIGN_IN_CODE);
    expect(done.text).toMatch(/^Claude Code is signed in as owner@example\.com/);
    expect(await login.signedOut()).toBe(false);
    expect(login.expects("lair:c1", TEST_SIGN_IN_CODE)).toBe(false);
    expect(audit).toEqual([
      "Started signing Claude Code in from the chat",
      "Signed Claude Code in from the chat (owner@example.com)",
    ]);
  });

  it("says plainly when the code is wrong, and how to start again", async () => {
    const s = fakeClaudeSignIn();
    const login = new ChatLogin(() => s);
    await login.start("w");
    expect((await login.finish("WRONGCODE1234567#X")).text).toMatch(
      /did not accept that code.*Type \/login to start again\.$/,
    );
    expect((await login.finish(TEST_SIGN_IN_CODE)).text).toMatch(/No sign-in is waiting/);
  });

  it("points a failed answer at /login when Claude Code is signed out", () => {
    expect(signedOutHint("Not logged in · Please run /login")).toMatch(/type \/login/);
    expect(signedOutHint("OAuth token has expired")).toMatch(/type \/login/);
    expect(signedOutHint("timeout")).toBe("");
  });
});
