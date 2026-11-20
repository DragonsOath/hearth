import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeAuthStatus, ClaudeSignInResult, ClaudeSignInStart } from "@dragon-control/core";

/**
 * Signing Claude Code in from Hearth's own page, for the account Hearth runs as, with no terminal.
 *
 * Claude Code's own supported sign-in (`claude auth login`) is an OAuth authorization-code flow
 * with PKCE. Its redirect goes to Anthropic's own page, which shows a one-time code; the secret
 * half of the exchange (the PKCE verifier) stays inside the Claude Code process. So Hearth:
 *
 * 1. starts `claude auth login` as its own account and reads the sign-in link it prints;
 * 2. shows that link: the owner signs in at Anthropic and gets a one-time code;
 * 3. passes the code the owner pastes to the waiting process, which exchanges it with Anthropic
 *    and stores its credentials in Hearth's own account (as Claude Code always does);
 * 4. confirms with `claude auth status`.
 *
 * Hearth never sees a token: it handles only the link and the one-time code, and its answers to
 * the browser carry neither tokens nor raw program output. Credentials stay in Claude Code's own
 * file in Hearth's account, which Ember's tools treat as secret and never read.
 */

export type { ClaudeAuthStatus };
type SignInStart = ClaudeSignInStart;
type SignInResult = ClaudeSignInResult;

const SIGN_IN_MINUTES = 10;
/** Only Anthropic's own sign-in pages are ever shown as the link. */
const ANTHROPIC_HOSTS =
  /^(claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com|[a-z0-9-]+\.anthropic\.com)$/;

/** Anything that looks like a credential, removed from text before it leaves the server. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[removed]")
    .replace(/(access|refresh)[_-]?token["':=\s]+[A-Za-z0-9._-]{12,}/gi, "$1 token [removed]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[removed]");
}

/** The sign-in link from Claude Code's output, only if it is Anthropic's own HTTPS page. */
export function signInLink(output: string): string | undefined {
  for (const m of output.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const u = new URL(m[0]);
      if (u.protocol === "https:" && ANTHROPIC_HOSTS.test(u.hostname) && /oauth/.test(u.pathname))
        return u.toString();
    } catch {
      // not a URL
    }
  }
  return undefined;
}

/** A pasted one-time code: what Anthropic's page shows (letters, digits, and a few marks). */
export function cleanCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw.trim();
  return /^[A-Za-z0-9#._~-]{8,1024}$/.test(code) ? code : undefined;
}

interface Pending {
  id: string;
  child: ChildProcess;
  dir: string;
  output: string;
  expires: number;
  timer: NodeJS.Timeout;
  done?: Promise<number | null>;
}

export class ClaudeSignIn {
  private pending?: Pending;

  constructor(
    private readonly command = process.env.DC_CLAUDE_PATH || "claude",
    /** Arguments before Claude Code's own (tests run a stand-in script through Node). */
    private readonly prefix: string[] = [],
  ) {}

  private env() {
    // No browser on a server: Claude Code prints the link instead, which Hearth shows.
    return { ...process.env, BROWSER: "true", NO_COLOR: "1" };
  }

  /** Is Claude Code installed and signed in for this account? Reads `claude auth status --json`. */
  status(): Promise<ClaudeAuthStatus> {
    return new Promise((resolve) => {
      execFile(
        this.command,
        [...this.prefix, "auth", "status", "--json"],
        { timeout: 20_000, windowsHide: true, env: this.env() },
        (error, stdout) => {
          const err = error as (Error & { code?: string | number }) | null;
          if (err && (err.code === "ENOENT" || err.code === 127))
            return resolve({
              installed: false,
              loggedIn: false,
              detail: "Claude Code is not installed on this machine, or not on its PATH.",
            });
          try {
            const s = JSON.parse(stdout) as Record<string, unknown>;
            const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : undefined);
            const loggedIn = s.loggedIn === true;
            const method = str("authMethod");
            const email = str("email") ?? str("emailAddress");
            const organization = str("orgName") ?? str("organizationName");
            const subscription = str("subscriptionType");
            resolve({
              installed: true,
              loggedIn,
              ...(method ? { method } : {}),
              ...(email ? { email } : {}),
              ...(organization ? { organization } : {}),
              ...(subscription ? { subscription } : {}),
              detail: loggedIn
                ? `Signed in${email ? ` as ${email}` : ""}${method === "console" ? " (Anthropic Console, billed per use)" : method && method !== "none" ? " (Claude subscription)" : ""}.`
                : "Installed, not signed in yet.",
            });
          } catch {
            resolve({
              installed: true,
              loggedIn: false,
              detail:
                "Claude Code did not report its sign-in status; it may be too old for this. Update Claude Code, then try again.",
            });
          }
        },
      );
    });
  }

  private stop() {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    clearTimeout(p.timer);
    if (p.child.exitCode === null) p.child.kill();
    // Its empty working folder goes once it has exited (a running process still holds it).
    const remove = () => {
      try {
        rmSync(p.dir, { recursive: true, force: true });
      } catch {
        // Left in the temporary folder; nothing in it.
      }
    };
    if (p.child.exitCode !== null || !p.done) remove();
    else void p.done.then(remove);
  }

  /**
   * Starts Claude Code's sign-in for this account and returns Anthropic's sign-in link. One at a
   * time: starting again replaces an unfinished one.
   */
  async start(opts: { console?: boolean } = {}): Promise<SignInStart> {
    this.stop();
    const dir = mkdtempSync(path.join(tmpdir(), "hearth-signin-"));
    const child = spawn(
      this.command,
      [...this.prefix, "auth", "login", ...(opts.console ? ["--console"] : ["--claudeai"])],
      { cwd: dir, env: this.env(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const id = randomUUID();
    const expires = Date.now() + SIGN_IN_MINUTES * 60_000;
    const p: Pending = {
      id,
      child,
      dir,
      output: "",
      expires,
      timer: setTimeout(() => {
        if (this.pending?.id === id) this.stop();
      }, SIGN_IN_MINUTES * 60_000),
    };
    this.pending = p;
    child.stdin?.on("error", () => undefined);
    p.done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    const url = await new Promise<string>((resolve, reject) => {
      const onData = (b: Buffer) => {
        p.output += b.toString("utf8");
        const link = signInLink(p.output);
        if (link) {
          cleanup();
          resolve(link);
        }
      };
      const fail = (why: string) => {
        cleanup();
        this.stop();
        reject(new Error(why));
      };
      const t = setTimeout(
        () =>
          fail("Claude Code did not start its sign-in. Check it is up to date, then try again."),
        30_000,
      );
      const onError = (e: Error) =>
        fail(
          /ENOENT/.test(e.message)
            ? "Claude Code is not installed on this machine, or not on its PATH."
            : `Claude Code could not start: ${e.message}`,
        );
      const onClose = () =>
        fail(
          `Claude Code ended before showing a sign-in link: ${redactSecrets(p.output.trim().split("\n").at(-1) ?? "").slice(0, 200) || "no message"}`,
        );
      const cleanup = () => {
        clearTimeout(t);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
        // Keep collecting what it says next, for the result of the code exchange.
        child.stdout?.on("data", (x: Buffer) => (p.output += x.toString("utf8")));
        child.stderr?.on("data", (x: Buffer) => (p.output += x.toString("utf8")));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", onError);
      child.on("close", onClose);
    });
    return { id, url, expiresAt: new Date(expires).toISOString() };
  }

  /** Gives the waiting sign-in the one-time code from Anthropic's page, then checks the result. */
  async complete(id: string, rawCode: unknown): Promise<SignInResult> {
    const p = this.pending;
    if (!p || p.id !== id || Date.now() > p.expires || p.child.exitCode !== null)
      return {
        ok: false,
        expired: true,
        detail: "That sign-in is no longer waiting (it expired or was replaced). Start again.",
      };
    const code = cleanCode(rawCode);
    if (!code)
      return {
        ok: false,
        detail:
          "That doesn't look like the code from Anthropic's page. Copy the whole code shown after you sign in, and paste it here.",
      };
    const before = p.output.length;
    p.child.stdin?.write(`${code}\n`);
    const exit = await Promise.race([
      p.done!,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 60_000)),
    ]);
    const said = redactSecrets(p.output.slice(before).trim());
    this.stop();
    if (exit === "timeout")
      return { ok: false, detail: "Claude Code did not finish signing in. Start again." };
    const status = await this.status();
    if (exit === 0 && status.loggedIn) return { ok: true, status };
    const why = /400|invalid|expired/i.test(said)
      ? "Anthropic did not accept that code. Codes work once and expire quickly: start again and use the new code."
      : `Signing in did not finish${said ? `: ${said.split("\n").at(-1)!.slice(0, 200)}` : "."}`;
    return { ok: false, detail: why };
  }

  cancel(id?: string) {
    if (!id || this.pending?.id === id) this.stop();
  }

  /** Signs Claude Code out for this account (to switch accounts, or after a problem). */
  signOut(): Promise<ClaudeAuthStatus> {
    this.stop();
    return new Promise((resolve) => {
      execFile(
        this.command,
        [...this.prefix, "auth", "logout"],
        { timeout: 20_000, windowsHide: true, env: this.env() },
        () => void this.status().then(resolve),
      );
    });
  }
}

/** What the rest of Hearth uses: the real sign-in, or the browser tests' stand-in. */
export type ClaudeSignInLike = Pick<
  ClaudeSignIn,
  "status" | "start" | "complete" | "cancel" | "signOut"
>;

/** The test code the stand-in accepts (browser tests only, DC_FAKE_AGENT=1). */
export const TEST_SIGN_IN_CODE = "TESTCODE123#TESTSTATE";

/**
 * A stand-in for the browser tests: the same steps without Claude Code or Anthropic. Its link
 * points at a page that does not exist, and only the test code signs it in.
 */
export function fakeClaudeSignIn(): ClaudeSignInLike {
  let loggedIn = false;
  let pending: string | undefined;
  const status = async (): Promise<ClaudeAuthStatus> =>
    loggedIn
      ? {
          installed: true,
          loggedIn: true,
          method: "claude.ai",
          email: "owner@example.com",
          detail: "Signed in as owner@example.com (Claude subscription).",
        }
      : { installed: true, loggedIn: false, detail: "Installed, not signed in yet." };
  return {
    status,
    async start() {
      pending = randomUUID();
      return {
        id: pending,
        url: "https://claude.com/cai/oauth/authorize?code=true&client_id=test&state=test",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
    async complete(id, code) {
      if (id !== pending)
        return {
          ok: false,
          expired: true,
          detail: "That sign-in is no longer waiting. Start again.",
        };
      if (cleanCode(code) !== TEST_SIGN_IN_CODE)
        return {
          ok: false,
          detail:
            "Anthropic did not accept that code. Codes work once and expire quickly: start again and use the new code.",
        };
      pending = undefined;
      loggedIn = true;
      return { ok: true, status: await status() };
    },
    cancel() {
      pending = undefined;
    },
    async signOut() {
      loggedIn = false;
      return status();
    },
  };
}
