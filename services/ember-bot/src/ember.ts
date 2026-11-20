/**
 * Ember Bot: Hearth's cheerful messenger on the public Hearth Discord server. It is separate from
 * the official Hearth bot (services/hearth-bot), which lives in owners' own servers.
 *
 * Ember does three things, and nothing that costs money to run:
 * - answers a few slash commands (Discord calls this Worker over HTTP, signed);
 * - every few minutes, cheers on new posts in the around-the-fire forum: a fire reaction and a
 *   reply that fits the post's tag, once per post;
 * - release announcements are composed in announce.ts and posted by a GitHub Action.
 *
 * Her replies are written ahead of time in her voice (the Messenger Ember persona), never by AI,
 * so they cost nothing and never say anything unexpected.
 */

export interface Env {
  APP_ID: string;
  PUBLIC_KEY: string;
  GUILD_ID: string;
  /** The around-the-fire forum channel. */
  FORUM_ID: string;
  /** Secret (wrangler secret put BOT_TOKEN), never in a file. */
  BOT_TOKEN: string;
  /** Where people learn about and get Hearth. */
  SHOWCASE_URL: string;
  /** The Panel requests board. */
  PANEL_REQUESTS_URL: string;
  /** How requests are chosen and what the labels mean (docs/HOW_REQUESTS_WORK.md), once public. */
  HOW_REQUESTS_URL?: string;
  /** #general: the Founder offer's announcement and its countdown (empty: not posted). */
  GENERAL_ID?: string;
  /** #founder-queue, private to the owner and Ember: a line per new Founder screenshot. */
  QUEUE_ID?: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://discord.com/api/v10";
const FIRE = "%F0%9F%94%A5";
const enc = new TextEncoder();

function unhex(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
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

// ---------------------------------------------------------------------------------------------
// Slash commands

export const COMMANDS = [
  { name: "install", description: "How to get Hearth" },
  { name: "help", description: "Where to get help with Hearth" },
  { name: "request-panel", description: "Ask for a Hearth panel for an app you run" },
  { name: "about", description: "What Hearth is, in one breath" },
] as const;

export function commandReply(name: string, env: Env): string {
  switch (name) {
    case "install":
      return `Special delivery! 📬 Everything about getting Hearth is here: ${env.SHOWCASE_URL}\nNew releases land in the announcements channel first, so follow it and you'll never miss one.`;
    case "help":
      return "Stuck? Make a post in the help forum: one question per post, what you tried, and any error message. And please blur passwords, keys and IP addresses in screenshots first! 🔥";
    case "request-panel":
      return `Want a full panel for an app you run, or a feature on one? Drop it on the Panel requests board, and if someone already asked, add your vote instead: ${env.PANEL_REQUESTS_URL}${env.HOW_REQUESTS_URL ? `\nHow requests are chosen, and what the labels mean: ${env.HOW_REQUESTS_URL}` : ""}`;
    case "about":
      return "Hearth is one home for your whole homelab: servers, Docker, media, storage and home automation in one place. Its AI admin explains problems in plain English and fixes them with your OK. Free, with optional Premium extras. 🔥";
    default:
      return "Hmm, that letter isn't in my satchel. Try /install, /help, /request-panel or /about.";
  }
}

/** Answers one interaction request. Returns the HTTP response Discord expects. */
export async function handleInteraction(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  const ok = await verifyDiscord(
    env.PUBLIC_KEY,
    req.headers.get("x-signature-ed25519") ?? "",
    req.headers.get("x-signature-timestamp") ?? "",
    body,
  );
  if (!ok) return new Response("Bad signature.", { status: 401 });
  const i = JSON.parse(body) as { type: number; data?: { name?: string } };
  if (i.type === 1) return Response.json({ type: 1 }); // Discord's ping when the URL is saved.
  if (i.type === 2) {
    return Response.json({
      type: 4,
      data: { content: commandReply(i.data?.name ?? "", env), allowed_mentions: { parse: [] } },
    });
  }
  return new Response("Unsupported.", { status: 400 });
}

/** Puts the commands on the Hearth server (one bulk overwrite, so repeating it is harmless). */
export async function registerCommands(env: Env, fetch: Fetch): Promise<boolean> {
  const r = await fetch(`${API}/applications/${env.APP_ID}/guilds/${env.GUILD_ID}/commands`, {
    method: "PUT",
    headers: auth(env),
    body: JSON.stringify(COMMANDS.map((c) => ({ ...c, type: 1 }))),
  });
  return r.ok;
}

// ---------------------------------------------------------------------------------------------
// Cheering on around-the-fire posts

/** Her replies by tag. The first tag on a post that has a set decides; otherwise "default". */
export const GUSH: Record<string, string[]> = {
  "Hidden Gem": [
    "Wait, you found THAT? 📬 Hidden gem alert! I'm tucking this one in my satchel for Hidden Gem of the Week.",
    "Ooh, a secret passage! I didn't think anyone would find this one so soon. Thanks for sharing it with everyone. ✨",
    "Psst, everybody, come look! {user} just found a hidden gem. 💎🔥",
  ],
  "Ember Moment": [
    "Did I really say that? 😳 I stand by it. Mostly. Thanks for sharing!",
    "Okay, that one made me flicker. 🔥 Signed, sealed, slightly embarrassed.",
  ],
  "Wall Screen": [
    "That wall screen is gorgeous! The whole house gets to enjoy the fire now. 🔥",
    "Look at that glow! Every hallway deserves a wall screen like this. ✨",
  ],
  "The Forge": [
    "Look at you, working the Forge like a pro! This is exactly what it's for. ✨",
    "Fresh from the Forge and looking great! 🔨🔥",
  ],
  Lair: [
    "What a cozy Lair! I'd happily deliver letters here every day. 🔥",
    "Now THAT is a Lair. Thanks for letting us peek inside! 📬",
  ],
  "Home Rows": [
    "These rows are beautiful! Movie night just got a lot easier to pick. 🍿🔥",
    "Ooh, a perfectly arranged home screen. Chef's kiss. ✨",
  ],
  "My Setup": [
    "Oh wow, look at this lab! 🔥 Every container lined up like letters in my satchel. Thanks for sharing it with the hearth!",
    "Special delivery: one gorgeous homelab! 📬 Thanks for showing us around, {user}.",
    "This setup is lovely. Grab a seat by the fire and tell us your favourite part! 🔥",
  ],
  default: [
    "Ooh, this one's going straight in my satchel. Thanks for sharing it with the hearth! 📬🔥",
    "Signed, sealed, delivered: one fantastic post! Thanks, {user}. ✨",
  ],
};

export function gushFor(tags: string[], user: string, pick: (n: number) => number): string {
  const key = tags.find((t) => GUSH[t]) ?? "default";
  const set = GUSH[key]!;
  return set[pick(set.length) % set.length]!.replaceAll("{user}", `<@${user}>`);
}

/** When a Discord id was made (ids carry their own timestamp). */
export function idTime(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

interface Thread {
  id: string;
  parent_id?: string;
  owner_id?: string;
  applied_tags?: string[];
}

function auth(env: Env): Record<string, string> {
  return { authorization: `Bot ${env.BOT_TOKEN}`, "content-type": "application/json" };
}

/**
 * One pass: every around-the-fire post from the last day that Ember has not answered gets a fire
 * reaction and one reply. Whether she answered is read from the post itself, so a restart or a
 * missed pass never makes her answer twice. Returns how many posts she answered.
 */
export async function cheerNewPosts(
  env: Env,
  fetch: Fetch,
  now: number,
  pick: (n: number) => number = (n) => Math.floor(Math.random() * n),
): Promise<number> {
  const h = auth(env);
  const active = await fetch(`${API}/guilds/${env.GUILD_ID}/threads/active`, { headers: h });
  if (!active.ok) return 0;
  const { threads } = (await active.json()) as { threads: Thread[] };
  const fresh = threads.filter(
    (t) =>
      t.parent_id === env.FORUM_ID && t.owner_id !== env.APP_ID && now - idTime(t.id) < 86_400_000,
  );
  if (!fresh.length) return 0;

  const forum = await fetch(`${API}/channels/${env.FORUM_ID}`, { headers: h });
  const tags: { id: string; name: string }[] = forum.ok
    ? (((await forum.json()) as { available_tags?: { id: string; name: string }[] })
        .available_tags ?? [])
    : [];
  const tagName = new Map(tags.map((t) => [t.id, t.name]));

  let answered = 0;
  for (const t of fresh) {
    const msgs = await fetch(`${API}/channels/${t.id}/messages?limit=50`, { headers: h });
    if (!msgs.ok) continue;
    const list = (await msgs.json()) as { author?: { id?: string } }[];
    if (list.some((m) => m.author?.id === env.APP_ID)) continue;

    // A forum post's first message has the same id as the post.
    await fetch(`${API}/channels/${t.id}/messages/${t.id}/reactions/${FIRE}/@me`, {
      method: "PUT",
      headers: h,
    });
    const names = (t.applied_tags ?? []).map((id) => tagName.get(id)).filter(Boolean) as string[];
    const user = t.owner_id ?? "";
    const r = await fetch(`${API}/channels/${t.id}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        content: gushFor(names, user, pick),
        allowed_mentions: { users: user ? [user] : [] },
      }),
    });
    if (r.ok) answered++;
  }
  return answered;
}
