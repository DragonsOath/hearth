import WebSocket from "ws";
import { MessageGoneError, RateLimitedError, type Attachment } from "./providers";

/**
 * The owner's own Discord bot (a "Discord (your bot)" destination): it posts in one channel, and
 * unlike a webhook its messages can carry buttons. Button presses arrive over Discord's gateway,
 * a connection Hearth opens to Discord (nothing is opened on the owner's network). The token
 * stays in the vault; it is never logged or put in an error.
 */

const API = "https://discord.com/api/v10";

/**
 * Browser tests: a stand-in Discord (DC_FAKE_DISCORD_BOT=1) with one server and two channels, so
 * the setup screen and RSVP posts can be tested without a real bot or token.
 */
const FAKE = process.env.DC_FAKE_DISCORD_BOT === "1";
export const FAKE_CHANNELS = [
  { id: "1565080201413795884", name: "movie-chat", server: "Friends" },
  { id: "1565080201413795885", name: "general", server: "Friends" },
];
let fakeSeq = 1000;
const UA = "DiscordBot (https://github.com/DragonsOath/hearth, 1) Hearth";
const TIMEOUT_MS = 30_000;

async function call(
  token: string,
  method: string,
  path: string,
  body?: FormData | Record<string, unknown>,
): Promise<Response> {
  const json = body !== undefined && !(body instanceof FormData);
  try {
    return await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bot ${token}`,
        "user-agent": UA,
        ...(json ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: json ? JSON.stringify(body) : (body as FormData) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("Discord did not answer.");
  }
}

async function refused(res: Response, what: string): Promise<never> {
  if (res.status === 429) {
    const b = (await res.json().catch(() => ({}))) as { retry_after?: number };
    throw new RateLimitedError(Math.max(1000, (b.retry_after ?? 5) * 1000));
  }
  if (res.status === 401)
    throw new Error(
      "Discord did not accept the bot token. Reset it in Discord and paste it again.",
    );
  if (res.status === 403)
    throw new Error(
      "The bot cannot post in that channel. Check it is in the server and can see the channel.",
    );
  const b = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(`Discord refused ${what} (${res.status}${b.message ? `: ${b.message}` : ""}).`);
}

/** The bot's name, to show it is connected (and that the token is right). */
export async function botUser(token: string): Promise<{ id: string; name: string }> {
  const res = await call(token, "GET", "/users/@me");
  if (!res.ok) await refused(res, "the token");
  const u = (await res.json()) as { id: string; username: string; global_name?: string };
  return { id: u.id, name: u.global_name || u.username };
}

/** What a bot needs: post, embed, attach pictures, see channels, and read their history. */
export const BOT_PERMISSIONS = 1024 + 2048 + 16384 + 32768 + 65536;

/**
 * Everything the setup screen shows once a token is pasted: the bot's name, the link that adds it
 * to a server with the permissions it needs, and the channels it can already post in.
 */
export async function lookupBot(
  token: string,
): Promise<{ name: string; invite: string; channels: BotChannel[] }> {
  if (FAKE) {
    if (!token.startsWith("fake"))
      throw new Error(
        "Discord did not accept the bot token. Reset it in Discord and paste it again.",
      );
    return {
      name: "Hearth",
      invite: `https://discord.com/oauth2/authorize?client_id=1&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`,
      channels: FAKE_CHANNELS,
    };
  }
  const user = await botUser(token);
  const res = await call(token, "GET", "/oauth2/applications/@me");
  const app = res.ok ? ((await res.json()) as { id?: string }) : {};
  const invite = `https://discord.com/oauth2/authorize?client_id=${app.id ?? user.id}&scope=bot+applications.commands&permissions=${BOT_PERMISSIONS}`;
  return { name: user.name, invite, channels: await botChannels(token) };
}

/** A channel's name ("movie-chat"), when the bot can see it. */
export async function channelInfo(
  token: string,
  channelId: string,
): Promise<{ name: string; guildId?: string }> {
  if (FAKE) {
    const c = FAKE_CHANNELS.find((x) => x.id === channelId);
    if (!c)
      throw new Error(
        "The bot cannot post in that channel. Check it is in the server and can see the channel.",
      );
    return { name: c.name };
  }
  const res = await call(token, "GET", `/channels/${encodeURIComponent(channelId)}`);
  if (!res.ok) await refused(res, "the channel");
  const c = (await res.json()) as { name?: string; guild_id?: string };
  return { name: c.name ?? "channel", ...(c.guild_id ? { guildId: c.guild_id } : {}) };
}

/** A text channel the bot can see, for the channel picker and for #name links. */
export interface BotChannel {
  id: string;
  name: string;
  server: string;
}

/** The text channels in every server the bot is in. */
export async function botChannels(token: string): Promise<BotChannel[]> {
  const res = await call(token, "GET", "/users/@me/guilds");
  if (!res.ok) await refused(res, "the server list");
  const guilds = (await res.json()) as { id: string; name: string }[];
  const out: BotChannel[] = [];
  for (const g of guilds.slice(0, 20)) {
    const r = await call(token, "GET", `/guilds/${g.id}/channels`);
    if (!r.ok) continue;
    const chans = (await r.json()) as {
      id: string;
      name: string;
      type: number;
      position: number;
    }[];
    for (const c of chans
      .filter((x) => x.type === 0 || x.type === 5)
      .sort((a, b) => a.position - b.position))
      out.push({ id: c.id, name: c.name, server: g.name });
  }
  return out;
}

/**
 * Posts (or edits) a message in a channel as the bot: the same embed payload a webhook gets,
 * with pictures attached, and buttons when given. Webhook-only fields are left out.
 */
export async function sendDiscordBot(
  token: string,
  channelId: string,
  payload: Record<string, unknown>,
  files: Attachment[] = [],
  opts: { messageId?: string; components?: unknown[] } = {},
): Promise<string> {
  if (FAKE) return opts.messageId ?? `fake-${++fakeSeq}`;
  const form = messageForm(payload, files, opts.components);
  const path = `/channels/${encodeURIComponent(channelId)}/messages${
    opts.messageId ? `/${encodeURIComponent(opts.messageId)}` : ""
  }`;
  const res = await call(token, opts.messageId ? "PATCH" : "POST", path, form);
  if (res.status === 404 && opts.messageId) throw new MessageGoneError();
  if (!res.ok) await refused(res, "the message");
  const sent = (await res.json().catch(() => ({}))) as { id?: unknown };
  return typeof sent.id === "string" ? sent.id : (opts.messageId ?? "");
}

/**
 * A bot message as Discord takes it: the embed payload (webhook-only fields left out), buttons
 * when given, and the pictures attached.
 */
export function messageForm(
  payload: Record<string, unknown>,
  files: Attachment[] = [],
  components?: unknown[],
): FormData {
  const { username: _u, avatar_url: _a, ...rest } = payload;
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      ...rest,
      ...(components ? { components } : {}),
      attachments: files.map((f, i) => ({ id: i, filename: f.name })),
    }),
  );
  files.forEach((f, i) =>
    form.append(`files[${i}]`, new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name),
  );
  return form;
}

/** A button someone pressed under one of the bot's messages. */
export interface ButtonPress {
  customId: string;
  /** How the server shows them: their server nickname, else their Discord name. */
  name: string;
  userId: string;
}

/** What the person who pressed sees (only them). */
export type PressReply = { text: string };

/** Reads a gateway INTERACTION_CREATE: a button press, or nothing Hearth handles. */
export function pressOf(d: Record<string, unknown>): ButtonPress | undefined {
  if (d.type !== 3) return undefined;
  const data = d.data as { custom_id?: string; component_type?: number } | undefined;
  if (!data?.custom_id || data.component_type !== 2) return undefined;
  const member = d.member as
    | { nick?: string | null; user?: { id: string; username: string; global_name?: string } }
    | undefined;
  const user = member?.user ?? (d.user as { id: string; username: string; global_name?: string });
  if (!user) return undefined;
  return {
    customId: data.custom_id,
    name: (member?.nick || user.global_name || user.username).slice(0, 60),
    userId: user.id,
  };
}

/** Answers a press within Discord's 3 seconds: a note only that person sees. */
async function reply(id: string, itoken: string, text: string) {
  await fetch(
    `${API}/interactions/${encodeURIComponent(id)}/${encodeURIComponent(itoken)}/callback`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ type: 4, data: { content: text.slice(0, 2000), flags: 64 } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  ).catch(() => undefined);
}

/**
 * One gateway connection per bot token: heartbeats, a fresh identify after any drop (with a
 * growing wait), and button presses handed to `onPress`. No privileged intents are asked for;
 * button presses arrive without any.
 */
export class DiscordGateway {
  private readonly bots = new Map<string, Connection>();
  constructor(
    private readonly onPress: (p: ButtonPress) => Promise<PressReply>,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  /** Keeps exactly these tokens connected. */
  sync(tokens: string[]) {
    if (FAKE) return;
    const want = new Set(tokens.filter(Boolean));
    for (const [t, c] of this.bots)
      if (!want.has(t)) {
        c.stop();
        this.bots.delete(t);
      }
    for (const t of want)
      if (!this.bots.has(t)) {
        const c = new Connection(t, this.onPress, this.log);
        this.bots.set(t, c);
        c.start();
      }
  }

  stop() {
    for (const c of this.bots.values()) c.stop();
    this.bots.clear();
  }
}

class Connection {
  private ws?: WebSocket;
  private beat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private seq: number | null = null;
  private stopped = false;
  private failures = 0;
  constructor(
    private readonly token: string,
    private readonly onPress: (p: ButtonPress) => Promise<PressReply>,
    private readonly log: (msg: string) => void,
  ) {}

  start() {
    if (this.stopped) return;
    const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    this.ws = ws;
    ws.on("message", (raw) => void this.handle(raw.toString()));
    ws.on("close", (code) => this.dropped(code));
    ws.on("error", () => undefined);
  }

  private send(op: number, d: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  private async handle(text: string) {
    let m: { op: number; d: Record<string, unknown> | null; s: number | null; t: string | null };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.s !== null && m.s !== undefined) this.seq = m.s;
    if (m.op === 10) {
      const every = Number(m.d?.heartbeat_interval) || 41_250;
      clearInterval(this.beat);
      this.beat = setInterval(() => this.send(1, this.seq), every);
      this.send(2, {
        token: this.token,
        intents: 0,
        properties: { os: process.platform, browser: "hearth", device: "hearth" },
      });
    } else if (m.op === 1) this.send(1, this.seq);
    else if (m.op === 7 || m.op === 9) this.ws?.close(4000);
    else if (m.op === 0 && m.t === "READY") {
      this.failures = 0;
      const u = (m.d?.user ?? {}) as { username?: string };
      this.log(`Discord bot ${u.username ?? ""} connected`);
    } else if (m.op === 0 && m.t === "INTERACTION_CREATE" && m.d) {
      const press = pressOf(m.d);
      if (!press) return;
      const r = await this.onPress(press).catch((e: unknown) => ({
        text: e instanceof Error ? e.message : "Something went wrong.",
      }));
      await reply(String(m.d.id), String(m.d.token), r.text);
    }
  }

  private dropped(code: number) {
    clearInterval(this.beat);
    if (this.stopped) return;
    // A bad token: stop trying until it is changed (Discord would only refuse again).
    if (code === 4004) {
      this.log("Discord refused the bot token; the bot is not connected");
      return;
    }
    this.failures++;
    const wait = Math.min(5 * 60_000, 2_000 * 2 ** Math.min(this.failures, 8));
    this.retry = setTimeout(() => this.start(), wait);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.beat);
    clearTimeout(this.retry);
    this.ws?.close(1000);
  }
}
