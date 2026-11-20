/**
 * The official Hearth bot's relay (docs/design/HEARTH_BOT.md). One Discord bot, run by the Hearth
 * project, that anyone adds to their server with one click: no developer site, no token. Each
 * person's Hearth registers here once, links the servers its owner adds the bot to, and from then
 * on posts through the relay and hears button presses back over a socket it opens itself.
 *
 * This file is the relay's logic with its storage and Discord passed in, so it is tested without
 * Cloudflare; worker.ts binds it to D1, a Durable Object, and the real Discord.
 */

export interface Env {
  /** The bot's application id and public key (Discord Developer Portal, General Information). */
  APP_ID: string;
  PUBLIC_KEY: string;
  /** Secrets: the bot token, the OAuth client secret, and the key that signs link states. */
  BOT_TOKEN: string;
  CLIENT_SECRET: string;
  STATE_KEY: string;
  /** This relay's own address, for Discord's OAuth return ("https://bot.example.com"). */
  BASE_URL: string;
}

export interface Store {
  addInstall(id: string, secretHash: string): Promise<void>;
  installSecretHash(id: string): Promise<string | undefined>;
  linkGuild(guildId: string, installId: string, name: string): Promise<void>;
  guildsOf(installId: string): Promise<{ id: string; name: string }[]>;
  installOf(guildId: string): Promise<string | undefined>;
  unlinkGuild(guildId: string): Promise<void>;
}

/** Delivers a button press to an install's open socket; false when it is not connected. */
export type Deliver = (installId: string, event: PressEvent) => Promise<boolean>;

export interface PressEvent {
  type: "press";
  /** Interaction token: the install answers the presser with it (POST /v1/reply). */
  token: string;
  customId: string;
  name: string;
  userId: string;
  guildId: string;
}

/** What a bot posting from Hearth may do: see channels, post, embed, attach, read history. */
export const PERMISSIONS = 1024 + 2048 + 16384 + 32768 + 65536;
const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://github.com/DragonsOath/hearth, 1) HearthRelay";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const problem = (message: string, status: number) => json({ error: message }, status);

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const enc = new TextEncoder();

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** Equal strings, in constant time for equal lengths. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Discord signs every interaction; anything else is refused (Discord checks that we check). */
export async function verifyDiscord(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", unhex(publicKey), { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      unhex(signature),
      enc.encode(timestamp + body),
    );
  } catch {
    return false;
  }
}

/** A link state: which install asked to add the bot, until when, signed so it cannot be forged. */
export async function signState(env: Env, installId: string, now: number): Promise<string> {
  const exp = Math.floor(now / 1000) + 30 * 60;
  return `${installId}.${exp}.${await hmac(env.STATE_KEY, `${installId}.${exp}`)}`;
}
export async function readState(env: Env, state: string, now: number): Promise<string | undefined> {
  const [id, exp, sig] = state.split(".");
  if (!id || !exp || !sig) return undefined;
  if (Number(exp) < now / 1000) return undefined;
  return same(sig, await hmac(env.STATE_KEY, `${id}.${exp}`)) ? id : undefined;
}

export interface Deps {
  env: Env;
  store: Store;
  deliver: Deliver;
  fetch: typeof fetch;
  now?: () => number;
  /** A new random id or secret. */
  random?: (bytes: number) => string;
}

const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

/** Which install is calling: Authorization: Bearer <installId>.<secret>. */
async function caller(req: Request, d: Deps): Promise<string | undefined> {
  const m = /^Bearer\s+([a-f0-9]{16})\.([a-f0-9]{64})$/i.exec(
    req.headers.get("authorization") ?? "",
  );
  if (!m) return undefined;
  const want = await d.store.installSecretHash(m[1]!);
  return want && same(want, await sha256(m[2]!)) ? m[1]! : undefined;
}

function bot(d: Deps, method: string, path: string, body?: BodyInit, type?: string) {
  return d.fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bot ${d.env.BOT_TOKEN}`,
      "user-agent": UA,
      ...(type ? { "content-type": type } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

/** The guild a channel is in, if the bot can see it. */
async function guildOfChannel(d: Deps, channelId: string): Promise<string | undefined> {
  const r = await bot(d, "GET", `/channels/${encodeURIComponent(channelId)}`);
  if (!r.ok) return undefined;
  return ((await r.json()) as { guild_id?: string }).guild_id;
}

const page = (title: string, text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;background:#14100c;color:#f3e9dc;display:grid;place-items:center;min-height:90vh;text-align:center"><div><h1 style="color:#ff9124">${title}</h1><p>${text}</p></div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

export async function handle(req: Request, d: Deps): Promise<Response> {
  const url = new URL(req.url);
  const now = d.now?.() ?? Date.now();
  const random = d.random ?? randomHex;
  const p = url.pathname;

  // Discord: button presses (and its PING when the endpoint is saved).
  if (p === "/interactions" && req.method === "POST") {
    const body = await req.text();
    const ok = await verifyDiscord(
      d.env.PUBLIC_KEY,
      req.headers.get("x-signature-ed25519") ?? "",
      req.headers.get("x-signature-timestamp") ?? "",
      body,
    );
    if (!ok) return new Response("Bad signature", { status: 401 });
    const i = JSON.parse(body) as Record<string, unknown>;
    if (i.type === 1) return json({ type: 1 });
    const data = i.data as { custom_id?: string; component_type?: number } | undefined;
    if (i.type !== 3 || !data?.custom_id || data.component_type !== 2)
      return json({ type: 4, data: { content: "Hearth does not do that.", flags: 64 } });
    const guildId = String(i.guild_id ?? "");
    const member = i.member as
      | { nick?: string | null; user?: { id: string; username: string; global_name?: string } }
      | undefined;
    const user = member?.user;
    const install = guildId ? await d.store.installOf(guildId) : undefined;
    const sent =
      install && user
        ? await d.deliver(install, {
            type: "press",
            token: String(i.token),
            customId: data.custom_id,
            name: (member?.nick || user.global_name || user.username).slice(0, 60),
            userId: user.id,
            guildId,
          })
        : false;
    if (!sent)
      return json({
        type: 4,
        data: {
          content: "The host's Hearth is not connected right now. Try again in a little while.",
          flags: 64,
        },
      });
    // "Thinking…", seen only by the presser; their Hearth answers within seconds.
    return json({ type: 5, data: { flags: 64 } });
  }

  // A Hearth registers once: an id and a secret, kept in its vault.
  if (p === "/v1/register" && req.method === "POST") {
    const id = random(8);
    const secret = random(32);
    await d.store.addInstall(id, await sha256(secret));
    return json({ installId: id, secret });
  }

  // Back from "Add to Discord": Discord says which server; it is linked to that Hearth.
  if (p === "/v1/linked" && req.method === "GET") {
    const install = await readState(d.env, url.searchParams.get("state") ?? "", now);
    const code = url.searchParams.get("code");
    if (!install || !code)
      return page(
        "That link has expired",
        "Go back to Hearth and press Add Hearth to my server again.",
      );
    const r = await d.fetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
      body: new URLSearchParams({
        client_id: d.env.APP_ID,
        client_secret: d.env.CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${d.env.BASE_URL}/v1/linked`,
      }),
    });
    const t = (await r.json().catch(() => ({}))) as { guild?: { id: string; name: string } };
    if (!r.ok || !t.guild)
      return page("Discord did not finish", "Go back to Hearth and try again.");
    await d.store.linkGuild(t.guild.id, install, t.guild.name);
    return page(
      "Hearth is in your server",
      `${escapeHtml(t.guild.name)} is linked. You can close this tab and go back to Hearth.`,
    );
  }

  if (!p.startsWith("/v1/")) return problem("Not found.", 404);
  const install = await caller(req, d);
  if (!install) return problem("Unknown Hearth. Register first.", 401);

  // The "Add Hearth to my server" link for this Hearth.
  if (p === "/v1/invite" && req.method === "GET") {
    const q = new URLSearchParams({
      client_id: d.env.APP_ID,
      scope: "bot applications.commands",
      permissions: String(PERMISSIONS),
      response_type: "code",
      redirect_uri: `${d.env.BASE_URL}/v1/linked`,
      state: await signState(d.env, install, now),
    });
    return json({ url: `https://discord.com/oauth2/authorize?${q}` });
  }

  // The servers this Hearth linked, and their text channels.
  if (p === "/v1/channels" && req.method === "GET") {
    const out: { id: string; name: string; server: string }[] = [];
    for (const g of await d.store.guildsOf(install)) {
      const r = await bot(d, "GET", `/guilds/${g.id}/channels`);
      if (r.status === 403 || r.status === 404) {
        // The bot was removed from that server: forget the link.
        await d.store.unlinkGuild(g.id);
        continue;
      }
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
    return json({ channels: out });
  }

  // Post (or edit) in a channel of a server this Hearth linked; the body goes to Discord as is.
  const msg = /^\/v1\/channels\/(\d{5,25})\/messages(?:\/(\d{5,25}))?$/.exec(p);
  if (msg && (req.method === "POST" || req.method === "PATCH")) {
    const guild = await guildOfChannel(d, msg[1]!);
    if (!guild || (await d.store.installOf(guild)) !== install)
      return problem("That channel is not in a server you added Hearth to.", 403);
    const path = `/channels/${msg[1]}/messages${msg[2] ? `/${msg[2]}` : ""}`;
    const r = await bot(
      d,
      req.method,
      path,
      await req.arrayBuffer(),
      req.headers.get("content-type") ?? "application/json",
    );
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
    });
  }

  // The answer only the presser sees ("You're in…").
  if (p === "/v1/reply" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { token?: string; text?: string };
    if (!b.token || !b.text) return problem("token and text are needed.", 400);
    const r = await d.fetch(
      `${API}/webhooks/${d.env.APP_ID}/${encodeURIComponent(b.token)}/messages/@original`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify({ content: b.text.slice(0, 2000) }),
      },
    );
    return json({ ok: r.ok }, r.ok ? 200 : 502);
  }

  return problem("Not found.", 404);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The install id of a socket request, once its Authorization checks out. */
export async function socketCaller(req: Request, d: Deps): Promise<string | undefined> {
  return caller(req, d);
}
