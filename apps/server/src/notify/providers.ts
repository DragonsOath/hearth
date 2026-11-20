import nodemailer from "nodemailer";
import { channelIdFrom, type ChannelKind } from "@dragon-control/core";
import { sendDiscordBot } from "./discord-bot";
import { relaySend } from "./hearth-bot";
import { sendTelegram, TELEGRAM_TOKEN } from "./telegram";
import { readPushVault, sendPush } from "./push";

/**
 * How a message reaches each kind of channel. One send per channel, with
 * its own timeout; a failure is reported to the caller, never thrown past
 * it, so one broken channel cannot stop the others (the pattern from
 * Claude Mail Service's notify fan-out).
 */

export interface Message {
  title: string;
  /** Plain text paragraphs. */
  lines: string[];
  severity: "info" | "warning" | "critical";
  link?: string;
}

export type ChannelConfig = Record<string, string | number | boolean>;

/** Discord asked to slow down: try again after this long. */
export class RateLimitedError extends Error {
  override name = "Rate limited";
  constructor(readonly retryAfterMs: number) {
    super(`Discord asked to wait ${Math.ceil(retryAfterMs / 1000)} s before the next message.`);
  }
}

/** A file attached to a Discord message (a poster), referred to as attachment://name. */
export interface Attachment {
  name: string;
  type: string;
  bytes: Buffer;
}

/**
 * A rich Discord message (media announcements): the embed payload plus attached pictures, sent as
 * multipart form data. Errors never include the webhook address.
 */
/** The Discord message to edit is gone (deleted in Discord). */
export class MessageGoneError extends Error {
  constructor() {
    super("That message was deleted in Discord.");
  }
}

export async function sendDiscordRich(
  url: string,
  payload: Record<string, unknown>,
  files: Attachment[] = [],
  /**
   * `wait`: Discord answers with the message, and its id comes back (to edit it later).
   * `messageId`: edits that message instead of posting a new one (a movie night that changed).
   */
  opts: { wait?: boolean; messageId?: string } = {},
): Promise<string | undefined> {
  const target = new URL(url);
  if (opts.messageId) target.pathname += `/messages/${encodeURIComponent(opts.messageId)}`;
  else if (opts.wait) target.searchParams.set("wait", "true");
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      ...payload,
      attachments: files.map((f, i) => ({ id: i, filename: f.name })),
    }),
  );
  files.forEach((f, i) =>
    form.append(`files[${i}]`, new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name),
  );
  let res: Response;
  try {
    res = await fetch(target, {
      method: opts.messageId ? "PATCH" : "POST",
      body: form,
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
  } catch {
    throw new Error("Discord did not answer.");
  }
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const header = Number(res.headers.get("retry-after"));
    const secs = body.retry_after ?? (Number.isFinite(header) ? header : 5);
    throw new RateLimitedError(Math.max(1000, secs * 1000));
  }
  // Editing a message someone deleted in Discord: post a new one instead (the webhook is fine).
  if (res.status === 404 && opts.messageId) throw new MessageGoneError();
  if (res.status === 404 || res.status === 401)
    throw new Error(
      "Discord no longer knows this webhook. It may have been deleted: add it again.",
    );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `Discord refused the message (${res.status}${body.message ? `: ${body.message}` : ""}).`,
    );
  }
  if (!opts.wait && !opts.messageId) return undefined;
  const sent = (await res.json().catch(() => ({}))) as { id?: unknown };
  return typeof sent.id === "string" ? sent.id : opts.messageId;
}

export interface Provider {
  /**
   * Checks settings before they are saved; returns a reason, or undefined
   * when fine. `secret` is undefined when it is not being changed.
   */
  validate(config: ChannelConfig, secret: string | undefined): string | undefined;
  /** A one-line description shown under the channel, never containing a secret. */
  describe(config: ChannelConfig): string;
  /** Browser push says which devices' browsers forgot it (`gone`), to drop them. */
  send(
    message: Message,
    config: ChannelConfig,
    secret: string | undefined,
  ): Promise<void | { gone?: string[] }>;
}

const TIMEOUT_MS = 10_000;
const UA = "DragonControl/0.1 (+self-hosted homelab control plane)";
const COLOURS = { info: 0x8c8478, warning: 0xc8a96e, critical: 0xb5534a };

const text = (m: Message) => [...m.lines, ...(m.link ? [m.link] : [])].join("\n\n");

async function post(url: string, body: string, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { "user-agent": UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`The server answered ${res.status} ${res.statusText}`.trim());
  }
}

function httpUrl(value: string | undefined): URL | undefined {
  try {
    const u = new URL(value ?? "");
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

const emailAddress = (v: unknown) => typeof v === "string" && /^[^\s@]+@[^\s@]+$/.test(v.trim());

export const PROVIDERS: Record<ChannelKind, Provider> = {
  email: {
    validate(c) {
      if (!emailAddress(c.to)) return "Enter the address to send to.";
      if (!emailAddress(c.from)) return "Enter the address to send from.";
      if (!c.host) return "Enter the mail server.";
      const port = Number(c.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "Enter a valid port.";
      return undefined;
    },
    describe: (c) => `${String(c.to)} via ${String(c.host)}`,
    async send(m, c, password) {
      const transport = nodemailer.createTransport({
        host: String(c.host),
        port: Number(c.port),
        secure: c.security === "tls",
        requireTLS: c.security === "starttls",
        ignoreTLS: c.security === "none",
        auth: c.username ? { user: String(c.username), pass: password ?? "" } : undefined,
        tls: { rejectUnauthorized: c.certificate !== "self-signed" },
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS,
      });
      await transport.sendMail({
        from: String(c.from),
        to: String(c.to),
        subject: m.title,
        text: text(m),
        headers: { "X-Dragon-Control-Severity": m.severity },
      });
    },
  },

  discord: {
    validate(_c, url) {
      if (url === undefined) return undefined;
      const u = httpUrl(url);
      if (
        !u ||
        u.protocol !== "https:" ||
        !/(^|\.)discord(app)?\.com$/.test(u.hostname) ||
        !u.pathname.startsWith("/api/webhooks/")
      ) {
        return "That does not look like a Discord webhook address.";
      }
      return undefined;
    },
    describe: () => "Webhook",
    async send(m, _c, url) {
      await post(
        url!,
        JSON.stringify({
          username: "Hearth",
          embeds: [
            {
              title: m.title.slice(0, 256),
              description: m.lines.join("\n\n").slice(0, 4000),
              color: COLOURS[m.severity],
              ...(m.link ? { url: m.link } : {}),
            },
          ],
          allowed_mentions: { parse: [] },
        }),
        { "content-type": "application/json" },
      );
    },
  },

  "discord-bot": {
    validate(c, token) {
      if (token !== undefined && !/^[\w.-]{50,100}$/.test(token.trim()))
        return "That does not look like a bot token. In Discord: your app, Bot, Reset Token, Copy.";
      if (!channelIdFrom(String(c.channel ?? "")))
        return "Paste the channel's link: in Discord, right-click the channel and choose Copy Link.";
      return undefined;
    },
    describe: (c) => (c.channelName ? `#${String(c.channelName)}` : "Your bot"),
    async send(m, c, token) {
      await sendDiscordBot(token!, channelIdFrom(String(c.channel))!, {
        embeds: [
          {
            title: m.title.slice(0, 256),
            description: m.lines.join("\n\n").slice(0, 4000),
            color: COLOURS[m.severity],
            ...(m.link ? { url: m.link } : {}),
          },
        ],
        allowed_mentions: { parse: [] },
      });
    },
  },

  "hearth-bot": {
    validate(c) {
      if (!channelIdFrom(String(c.channel ?? ""))) return "Pick the channel to post in.";
      return undefined;
    },
    describe: (c) => (c.channelName ? `#${String(c.channelName)} · Hearth bot` : "Hearth bot"),
    async send(m, c, cred) {
      await relaySend(cred!, channelIdFrom(String(c.channel))!, {
        embeds: [
          {
            title: m.title.slice(0, 256),
            description: m.lines.join("\n\n").slice(0, 4000),
            color: COLOURS[m.severity],
            ...(m.link ? { url: m.link } : {}),
          },
        ],
        allowed_mentions: { parse: [] },
      });
    },
  },

  ntfy: {
    validate(c) {
      if (!httpUrl(String(c.server ?? ""))) return "Enter the ntfy server address.";
      if (!c.topic || !/^[A-Za-z0-9_-]{1,64}$/.test(String(c.topic))) {
        return "Topics use letters, numbers, dashes, and underscores.";
      }
      return undefined;
    },
    describe: (c) => `${String(c.topic)} on ${httpUrl(String(c.server))?.host ?? String(c.server)}`,
    async send(m, c, token) {
      const base = String(c.server).replace(/\/+$/, "");
      await post(`${base}/${encodeURIComponent(String(c.topic))}`, m.lines.join("\n\n"), {
        // ntfy reads the title from a header, which must be plain ASCII.
        title: m.title.replace(/[^\x20-\x7e]/g, ""),
        priority: m.severity === "critical" ? "5" : m.severity === "warning" ? "4" : "3",
        tags:
          m.severity === "critical"
            ? "rotating_light"
            : m.severity === "warning"
              ? "warning"
              : "white_check_mark",
        ...(m.link ? { click: m.link } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      });
    },
  },

  push: {
    validate: () => undefined,
    describe: (c) => {
      const n = Number(c.devices ?? 0);
      return n === 1 ? "On for 1 device" : `On for ${n} devices`;
    },
    async send(m, _c, secret) {
      const vault = readPushVault(secret);
      if (!vault) throw new Error("Browser push isn't set up on any device yet.");
      // Push services want a contact for the sender: Hearth's public site, never the owner.
      return { gone: await sendPush(vault, m, "https://hearth.dragonsoath.com") };
    },
  },

  telegram: {
    validate(_c, token) {
      if (token !== undefined && !TELEGRAM_TOKEN.test(token.trim()))
        return "That doesn't look like a bot token. @BotFather gives one like 123456789:AA... (numbers, a colon, then letters).";
      return undefined;
    },
    describe: (c) =>
      `${c.chatName ? `${String(c.chatName)} · ` : ""}@${String(c.botName ?? "your bot")}`,
    async send(m, c, token) {
      if (!c.chat) throw new Error("No chat yet: send your bot a message, then set it up again.");
      await sendTelegram(token!, String(c.chat), m);
    },
  },

  webhook: {
    validate(_c, url) {
      if (url === undefined) return undefined;
      return httpUrl(url) ? undefined : "Enter an http or https address.";
    },
    describe: () => "JSON webhook",
    async send(m, _c, url) {
      await post(
        url!,
        JSON.stringify({
          source: "dragon-control",
          title: m.title,
          message: m.lines.join("\n\n"),
          severity: m.severity,
          link: m.link ?? null,
        }),
        { "content-type": "application/json" },
      );
    },
  },
};

/**
 * A Discord webhook's own picture (what Discord shows beside its posts), read with the webhook
 * itself: its address in Discord's picture store, or none when it uses Discord's default.
 */
export async function discordWebhookPicture(url: string): Promise<string | undefined> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("Discord did not answer.");
  }
  if (res.status === 404 || res.status === 401)
    throw new Error(
      "Discord no longer knows this webhook. It may have been deleted: add it again.",
    );
  if (!res.ok) throw new Error(`Discord answered ${res.status}.`);
  const w = (await res.json().catch(() => ({}))) as { id?: unknown; avatar?: unknown };
  if (typeof w.id !== "string" || typeof w.avatar !== "string") return undefined;
  if (!/^\d+$/.test(w.id) || !/^[a-z0-9_]+$/i.test(w.avatar)) return undefined;
  return `https://cdn.discordapp.com/avatars/${w.id}/${w.avatar}.png?size=128`;
}

/** Changes a Discord webhook's own picture (the webhook's token allows it; no bot needed). */
export async function setDiscordWebhookPicture(
  url: string,
  mime: string,
  base64: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: { "user-agent": UA, "content-type": "application/json" },
      body: JSON.stringify({ avatar: `data:${mime};base64,${base64}` }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
  } catch {
    throw new Error("Discord did not answer.");
  }
  if (res.status === 404 || res.status === 401)
    throw new Error(
      "Discord no longer knows this webhook. It may have been deleted: add it again.",
    );
  if (res.status === 429) throw new Error("Discord asked to wait a moment. Try again shortly.");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      `Discord refused the picture (${res.status}${body.message ? `: ${body.message}` : ""}).`,
    );
  }
}
