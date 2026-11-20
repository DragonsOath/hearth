import { cleanCode, type ClaudeSignInLike } from "./claude-signin";

/**
 * /login in the Lair and the War Room (11-04: "if I got logged out randomly how would I get
 * back in"). Claude Code refuses /login over Remote Control, and a signed-out Claude Code cannot
 * start a session at all, so Hearth signs it in itself, from the chat: the same sign-in as the
 * AI Agent page. /login answers with Anthropic's own sign-in link; the owner signs in there and
 * pastes the one-time code as their next message, which Hearth hands to Claude Code and never
 * keeps: the conversation records only that a code was entered.
 */

export const LOGIN_COMMAND = /^\/login\s*$/i;

/** Claude Code's own words when it is signed out (or its sign-in expired). */
const SIGNED_OUT =
  /not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication_error|credentials? (?:have|has) expired/i;

/** Said after a failed answer that failed because Claude Code is signed out. */
export const SIGNED_OUT_HINT =
  "Claude Code isn't signed in on this computer: type /login here to sign it back in.";

export const signedOutHint = (error?: string | null) =>
  error && SIGNED_OUT.test(error) ? SIGNED_OUT_HINT : "";

/** What the chat shows for a code, instead of the code itself. */
export const CODE_ENTERED = "(the one-time sign-in code)";

const WAIT_MINUTES = 10;

export interface ChatLoginReply {
  text: string;
  /** Anthropic's sign-in page, shown as a button (only Anthropic's own HTTPS pages). */
  url?: string;
}

export class ChatLogin {
  private waiting?: { id: string; where: string; until: number };

  constructor(
    private readonly signIn: () => ClaudeSignInLike | undefined,
    private readonly audit: (action: string) => Promise<void> = async () => undefined,
  ) {}

  /** Claude Code is installed here but not signed in (checked before Remote Control starts). */
  async signedOut(): Promise<boolean> {
    const st = await this.signIn()
      ?.status()
      .catch(() => undefined);
    return Boolean(st?.installed && !st.loggedIn);
  }

  /** Starts the sign-in for one conversation (a Lair conversation id, or a War Room project). */
  async start(where: string): Promise<ChatLoginReply> {
    const s = this.signIn();
    if (!s) return { text: "Signing in from Hearth isn't available on this computer." };
    const now = await s.status().catch(() => undefined);
    if (now && !now.installed)
      return {
        text: "Claude Code isn't installed on this computer, so there is nothing to sign in.",
      };
    try {
      const started = await s.start();
      this.waiting = { id: started.id, where, until: Date.parse(started.expiresAt) };
      await this.audit("Started signing Claude Code in from the chat");
      const was = now?.loggedIn
        ? `Claude Code is signed in${now.email ? ` as ${now.email}` : ""} right now; signing in again switches it to the account you use. `
        : "";
      return {
        text: `${was}Open Anthropic's sign-in page, sign in, and authorize Claude Code. Anthropic then shows a one-time code: paste it here as your next message. It works once, within ${WAIT_MINUTES} minutes, and Hearth never keeps it.`,
        url: started.url,
      };
    } catch (e) {
      return { text: `I couldn't start the sign-in: ${(e as Error).message}` };
    }
  }

  /** The owner's next message in that conversation looks like the code Anthropic showed. */
  expects(where: string, text: string): boolean {
    const w = this.waiting;
    const t = text.trim();
    return Boolean(
      w &&
      w.where === where &&
      Date.now() < w.until &&
      !/\s/.test(t) &&
      t.length >= 16 &&
      cleanCode(t),
    );
  }

  /** Hands the code to Claude Code and says how it went. */
  async finish(text: string): Promise<ChatLoginReply> {
    const w = this.waiting;
    const s = this.signIn();
    this.waiting = undefined;
    if (!w || !s) return { text: "No sign-in is waiting. Type /login to start one." };
    const r = await s.complete(w.id, text.trim());
    await this.audit(
      r.ok
        ? `Signed Claude Code in from the chat${r.status.email ? ` (${r.status.email})` : ""}`
        : "Signing Claude Code in from the chat did not finish",
    );
    if (r.ok)
      return {
        text: `Claude Code is signed in${r.status.email ? ` as ${r.status.email}` : ""}. Carry on, or type /rc to open this conversation in the Claude app.`,
      };
    // Claude Code's sign-in ends either way: a new one starts with /login.
    return { text: `${r.detail.replace(/\s*Start again\.?$/, "")} Type /login to start again.` };
  }
}
