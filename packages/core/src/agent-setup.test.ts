import { describe, expect, it } from "vitest";
import { explainAgentError } from "./agent-setup";

const opts = { provider: "Claude Code", runsAs: "hearth" };

describe("explaining an AI program's errors", () => {
  it("names the account to sign in as when it isn't signed in", () => {
    for (const raw of [
      "Invalid API key · Please run /login",
      "Not logged in. Please log in first.",
      "OAuth token has expired",
      "Error: 401 Unauthorized",
    ])
      expect(explainAgentError(raw, opts), raw).toMatch(
        /isn't signed in for the account Hearth runs as \(hearth\)/,
      );
  });

  it("tells usage limits, rate limits, timeouts, and network trouble apart", () => {
    expect(explainAgentError("Credit balance is too low", opts)).toMatch(/no usage left/);
    expect(explainAgentError("Claude AI usage limit reached", opts)).toMatch(/no usage left/);
    expect(explainAgentError("429 Too Many Requests", opts)).toMatch(/busy or rate-limited/);
    expect(explainAgentError("Overloaded", opts)).toMatch(/busy or rate-limited/);
    expect(explainAgentError("Claude Code did not finish within 90s.", opts)).toMatch(
      /didn't answer in time/,
    );
    expect(explainAgentError("getaddrinfo ENOTFOUND api.anthropic.com", opts)).toMatch(
      /couldn't reach its service/,
    );
  });

  it("keeps anything else to one short line", () => {
    const long = `Something odd happened ${"x".repeat(500)}`;
    const said = explainAgentError(long, opts);
    expect(said.startsWith("Claude Code couldn't answer: Something odd happened")).toBe(true);
    expect(said.length).toBeLessThan(220);
  });
});
