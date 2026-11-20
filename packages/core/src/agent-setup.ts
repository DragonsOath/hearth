/**
 * Connecting Ember to an AI service during setup (the welcome's "Connect your AI" step, and the
 * AI Agent page). The AI service supplies the thinking; Hearth's own tools and approvals decide
 * what Ember may look at or do. No credential ever passes through here: Claude Code keeps its own
 * sign-in on the machine Hearth runs on. Hearth starts that sign-in from its own page and passes
 * only the sign-in link and the one-time code; it never sees a token.
 */

/** Claude Code's sign-in for the account Hearth runs as (from `claude auth status`). No secrets. */
export interface ClaudeAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  /** How it is signed in: a Claude subscription, the Anthropic Console (API billing), or none. */
  method?: string;
  email?: string;
  organization?: string;
  subscription?: string;
  detail: string;
}

/** A sign-in Hearth started: Anthropic's own sign-in link, and how long it waits for the code. */
export interface ClaudeSignInStart {
  id: string;
  url: string;
  expiresAt: string;
}

export type ClaudeSignInResult =
  { ok: true; status: ClaudeAuthStatus } | { ok: false; detail: string; expired?: boolean };

/** One part of a connection test, in plain words. */
export interface AgentCheck {
  ok: boolean;
  detail: string;
}

/** What setup needs to say how to sign in, for the machine Hearth runs on. No secrets. */
export interface AgentSetupInfo {
  /** The account Hearth runs as: the one that must be signed in to the AI program. */
  runsAs: string;
  /** The Claude Code program Hearth runs ("claude", or DC_CLAUDE_PATH). */
  claudeCommand: string;
}

/**
 * A connection test, step by step. Each later step only runs when the one before passed, and
 * says so; installed but not signed in, and signed in but not able to use Hearth's tools, are
 * different answers.
 */
export interface AgentConnectionTest {
  provider: string;
  /** The program is on this machine and runs. */
  installed: AgentCheck;
  /** It answered a question: signed in, with usage available. Absent when not installed. */
  answered?: AgentCheck;
  /** Ember used Hearth's own tools through it and reported what they said. Absent when it did not answer. */
  tools?: AgentCheck;
  /** What the test itself cost, when the service reports it. */
  costUsd?: number;
  testedAt: string;
}

/** Turns an AI program's own error into what to do about it. Never echoes more than a short line. */
export function explainAgentError(
  error: string,
  opts: { provider: string; runsAs: string },
): string {
  const e = error.toLowerCase();
  const short = error.replace(/\s+/g, " ").trim().slice(0, 160);
  if (
    /not (logged|signed) in|please (run )?\/?login|log ?in (first|again)|unauthori[sz]ed|authenticat|invalid api key|oauth|credentials? (are )?(missing|expired)|401/.test(
      e,
    )
  )
    return `${opts.provider} is installed but isn't signed in for the account Hearth runs as (${opts.runsAs}), or its sign-in has expired. Sign in with the Connect button here (no terminal needed), then test again.`;
  if (
    /credit balance|insufficient|billing|payment|quota|usage limit|limit reached|out of credits|402/.test(
      e,
    )
  )
    return `${opts.provider} is signed in, but its account has no usage left right now (a plan limit or an empty credit balance). Check your ${opts.provider} plan or billing, then test again.`;
  if (/rate.?limit|too many requests|overloaded|529|429|try again later/.test(e))
    return `${opts.provider} is busy or rate-limited right now. Wait a minute, then test again.`;
  if (/did not finish within|timed? ?out|timeout/.test(e))
    return `${opts.provider} didn't answer in time. Check this computer's internet connection, then test again.`;
  if (/enotfound|econnrefused|network|getaddrinfo|socket hang up|fetch failed/.test(e))
    return `${opts.provider} couldn't reach its service. Check this computer's internet connection, then test again.`;
  return `${opts.provider} couldn't answer: ${short}`;
}
