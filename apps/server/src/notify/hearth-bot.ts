import WebSocket from "ws";
import {
  FAKE_CHANNELS,
  messageForm,
  type BotChannel,
  type ButtonPress,
  type PressReply,
} from "./discord-bot";
import { MessageGoneError, RateLimitedError, type Attachment } from "./providers";

/**
 * The official Hearth bot (docs/design/HEARTH_BOT.md): one bot run by the Hearth project, added
 * to a server with one click. This Hearth registers with the bot's relay once (an id and a
 * secret, kept in the vault), posts through it, and keeps a socket open to it for button presses.
 * Nothing is opened on the owner's network: every connection goes out from here.
 */

/** The official relay (services/hearth-bot, deployed 2026-10-29). DC_HEARTH_BOT_URL overrides it; set it empty to hide the official bot. */
const DEFAULT_RELAY = "https://hearth-bot.dragonsoath.com";
const FAKE = process.env.DC_FAKE_DISCORD_BOT === "1";

export function relayBase(): string {
  if (FAKE) return "https://relay.invalid";
  return (process.env.DC_HEARTH_BOT_URL ?? DEFAULT_RELAY).replace(/\/+$/, "");
}

/** Whether the official bot can be offered here. */
export const hearthBotAvailable = () => Boolean(relayBase());

const TIMEOUT_MS = 30_000;

async function relay(
  cred: string | undefined,
  method: string,
  path: string,
  body?: FormData | string,
  type?: string,
): Promise<Response> {
  const base = relayBase();
  if (!base) throw new Error("The Hearth bot is not available yet.");
  try {
    return await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cred ? { authorization: `Bearer ${cred}` } : {}),
        ...(type ? { "content-type": type } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The Hearth bot did not answer. Try again in a moment.");
  }
}

async function refused(res: Response, what: string): Promise<never> {
  if (res.status === 429) throw new RateLimitedError(5000);
  if (res.status === 401)
    throw new Error("The Hearth bot does not know this Hearth. Set it up again.");
  if (res.status === 403)
    throw new Error("That channel is not in a server you added Hearth to. Add Hearth there first.");
  const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  throw new Error(
    `The Hearth bot refused ${what} (${res.status}${b.error || b.message ? `: ${b.error ?? b.message}` : ""}).`,
  );
}

let fakeSeq = 2000;

/** Registers this Hearth with the relay: "<id>.<secret>", to keep in the vault. */
export async function relayRegister(): Promise<string> {
  if (FAKE) return `${"a".repeat(16)}.${"b".repeat(64)}`;
  const res = await relay(undefined, "POST", "/v1/register");
  if (!res.ok) await refused(res, "the sign-up");
  const r = (await res.json()) as { installId: string; secret: string };
  return `${r.installId}.${r.secret}`;
}

/** The "Add Hearth to my server" link, tied to this Hearth. */
export async function relayInvite(cred: string): Promise<string> {
  if (FAKE) return "https://discord.com/oauth2/authorize?client_id=1&scope=bot";
  const res = await relay(cred, "GET", "/v1/invite");
  if (!res.ok) await refused(res, "the link");
  return ((await res.json()) as { url: string }).url;
}

/** The text channels in the servers this Hearth added the bot to. */
export async function relayChannels(cred: string): Promise<BotChannel[]> {
  if (FAKE) return FAKE_CHANNELS;
  const res = await relay(cred, "GET", "/v1/channels");
  if (!res.ok) await refused(res, "the channel list");
  return ((await res.json()) as { channels: BotChannel[] }).channels;
}

/**
 * Why a post was refused, in words brokenReason knows: Discord's own "Missing Access" (the bot
 * can't see a private channel), or the relay's "not in a server you added Hearth to", which for a
 * channel in a linked server also means private.
 */
export function postRefusal(body: string, channelId: string, linked?: string[]): string {
  if (
    /Missing Access|Missing Permissions|"code":\s*5000[13]/i.test(body) ||
    linked?.includes(channelId)
  )
    return "Missing Access: that channel is private to Hearth.";
  return "That channel is not in a server you added Hearth to. Add Hearth there first.";
}

/** Posts (or edits) a message through the official bot. */
export async function relaySend(
  cred: string,
  channelId: string,
  payload: Record<string, unknown>,
  files: Attachment[] = [],
  opts: { messageId?: string; components?: unknown[] } = {},
): Promise<string> {
  if (FAKE) return opts.messageId ?? `fake-${++fakeSeq}`;
  const path = `/v1/channels/${encodeURIComponent(channelId)}/messages${
    opts.messageId ? `/${encodeURIComponent(opts.messageId)}` : ""
  }`;
  const res = await relay(
    cred,
    opts.messageId ? "PATCH" : "POST",
    path,
    messageForm(payload, files, opts.components),
  );
  if (res.status === 404 && opts.messageId) throw new MessageGoneError();
  if (res.status === 403) {
    // Two different fixes look the same from here (11-14): Hearth isn't in that server, or it is
    // and the channel is private. The relay lists the channels of every server Hearth is in.
    const body = await res.text().catch(() => "");
    const linked = await relayChannels(cred).catch(() => undefined);
    throw new Error(
      postRefusal(
        body,
        channelId,
        linked?.map((c) => c.id),
      ),
    );
  }
  if (!res.ok) await refused(res, "the message");
  const sent = (await res.json().catch(() => ({}))) as { id?: unknown };
  return typeof sent.id === "string" ? sent.id : (opts.messageId ?? "");
}

/** The answer only the presser sees. */
async function relayReply(cred: string, token: string, text: string) {
  await relay(cred, "POST", "/v1/reply", JSON.stringify({ token, text }), "application/json").catch(
    () => undefined,
  );
}

/** Keeps this Hearth's socket to the relay open while an official-bot destination is set up. */
export class HearthBotLink {
  private ws?: WebSocket;
  private cred?: string;
  private retry?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private failures = 0;
  constructor(
    private readonly onPress: (p: ButtonPress) => Promise<PressReply>,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  /** Connected with this credential, or closed when there is none. */
  sync(cred: string | undefined) {
    if (FAKE || !relayBase()) return;
    if (cred === this.cred) return;
    this.close();
    this.cred = cred;
    if (cred) this.open();
  }

  private open() {
    const cred = this.cred;
    if (!cred) return;
    const url = `${relayBase().replace(/^http/, "ws")}/v1/socket`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${cred}` } });
    this.ws = ws;
    ws.on("open", () => {
      this.failures = 0;
      this.log("Connected to the Hearth bot");
      clearInterval(this.ping);
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    });
    ws.on("message", (raw) => void this.handle(String(raw)));
    ws.on("close", () => this.dropped(ws));
    ws.on("error", () => undefined);
  }

  private async handle(text: string) {
    if (text === "pong" || !this.cred) return;
    let e: { type?: string; token?: string; customId?: string; name?: string; userId?: string };
    try {
      e = JSON.parse(text);
    } catch {
      return;
    }
    if (e.type !== "press" || !e.token || !e.customId) return;
    const r = await this.onPress({
      customId: e.customId,
      name: String(e.name ?? "Someone"),
      userId: String(e.userId ?? ""),
    }).catch((err: unknown) => ({
      text: err instanceof Error ? err.message : "Something went wrong.",
    }));
    await relayReply(this.cred, e.token, r.text);
  }

  private dropped(ws: WebSocket) {
    clearInterval(this.ping);
    if (ws !== this.ws || !this.cred) return;
    this.failures++;
    const wait = Math.min(5 * 60_000, 2_000 * 2 ** Math.min(this.failures, 8));
    this.retry = setTimeout(() => this.open(), wait);
  }

  private close() {
    clearTimeout(this.retry);
    clearInterval(this.ping);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
  }

  stop() {
    this.cred = undefined;
    this.close();
  }
}
