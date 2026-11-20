import type { Env, Fetch } from "./ember.ts";

/**
 * Codes delivered by Ember (11-19, the owner): on his code page, "Send with Ember" next to Make code.
 * He types a Discord name; Ember finds that person in the Hearth Discord server and DMs them Premium Ember (the
 * secret picture only code holders see) with the code and how to redeem it. Founder approvals use
 * the same DM. The picture never lives in this repository: the licence service keeps it in its
 * private database and hands it over with each send. Nothing here is posted in a channel.
 */

const API = "https://discord.com/api/v10";

/** Premium Ember: the picture's bytes and type, from the licence service. */
export interface Picture {
  type: string;
  data: ArrayBuffer;
}

export type SendResult =
  | { status: "sent"; name: string }
  | { status: "not-found" }
  | { status: "ambiguous"; names: string[] }
  | { status: "dm-closed"; name: string };

export const PICTURE_NAME = "premium-ember.webp";

const secretLine =
  "P.S. You're seeing the secret Premium me, the one with the crown and the golden key. 👑 Only code holders ever meet her, so let's keep it between us! 🤫";

/** Ember's DM for a code the owner gave (months null: Premium for good). */
export const giftDm = (code: string, months: number | null) =>
  `Special delivery! 📬 I've got something shiny for you: ${
    months
      ? `**Hearth Premium for ${months} ${months === 1 ? "month" : "months"}!**`
      : "**Hearth Premium, for good!**"
  }\n\nHere's your code:\n\n**${code}**\n\nIn Hearth, open Settings, Premium, and enter it under Redeem a code. It works once, on one Hearth. Welcome to Premium, I'm so happy you're here! 🔥\n\n${secretLine}`;

export { secretLine };

interface Member {
  nick?: string | null;
  user?: { id?: string; username?: string; global_name?: string | null };
}

const shown = (m: Member) => m.user?.global_name || m.nick || m.user?.username || "someone";

/**
 * Who a Discord name means in the Hearth Discord server: their username, display name or server nickname, any
 * case, with or without @. A numeric user id works too. Several close matches and no exact one:
 * their names, so the owner can type the right one. Never guesses.
 */
export async function findMember(
  env: Env,
  fetch: Fetch,
  to: string,
): Promise<{ id: string; name: string } | { none: true } | { names: string[] }> {
  const raw = to.trim().replace(/^@/, "");
  const h = { authorization: `Bot ${env.BOT_TOKEN}` };
  if (!raw) return { none: true };
  if (/^\d{15,22}$/.test(raw)) {
    const r = await fetch(`${API}/guilds/${env.GUILD_ID}/members/${raw}`, { headers: h });
    if (!r.ok) return { none: true };
    const m = (await r.json()) as Member;
    return { id: raw, name: shown(m) };
  }
  const r = await fetch(
    `${API}/guilds/${env.GUILD_ID}/members/search?query=${encodeURIComponent(raw)}&limit=10`,
    { headers: h },
  );
  if (!r.ok) throw new Error(`Discord answered ${r.status} looking for that name.`);
  const list = ((await r.json()) as Member[]).filter((m) => m.user?.id);
  const want = raw.toLowerCase();
  const exact = list.filter((m) =>
    [m.user?.username, m.user?.global_name, m.nick].some((n) => (n ?? "").toLowerCase() === want),
  );
  if (exact.length === 1) return { id: exact[0]!.user!.id!, name: shown(exact[0]!) };
  const near = exact.length > 1 ? exact : list;
  if (!near.length) return { none: true };
  return { names: near.map((m) => `${shown(m)} (@${m.user?.username ?? "?"})`) };
}

/**
 * Opens a DM and sends it, with Premium Ember attached when there is a picture. False when
 * Discord won't deliver to them (DMs closed, or not in the server): error 50007.
 */
export async function dm(
  env: Env,
  fetch: Fetch,
  userId: string,
  content: string,
  picture?: Picture | null,
): Promise<boolean> {
  const auth = `Bot ${env.BOT_TOKEN}`;
  const open = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!open.ok) throw new Error(`Discord answered ${open.status} opening a DM.`);
  const { id } = (await open.json()) as { id: string };
  const payload = { content, allowed_mentions: { parse: [] } };
  let r: Response;
  if (picture) {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({ ...payload, attachments: [{ id: 0, filename: PICTURE_NAME }] }),
    );
    form.append("files[0]", new Blob([picture.data], { type: picture.type }), PICTURE_NAME);
    r = await fetch(`${API}/channels/${id}/messages`, {
      method: "POST",
      headers: { authorization: auth },
      body: form,
    });
  } else {
    r = await fetch(`${API}/channels/${id}/messages`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  if (r.ok) return true;
  const err = (await r.json().catch(() => ({}))) as { code?: number };
  if (err.code === 50007) return false;
  throw new Error(`Discord answered ${r.status} sending the DM.`);
}

/** "Send with Ember": find them, then DM Premium Ember and the code. */
export async function sendCode(
  env: Env,
  fetch: Fetch,
  a: { to: string; code: string; months: number | null; picture?: Picture | null },
): Promise<SendResult> {
  const who = await findMember(env, fetch, a.to);
  if ("none" in who) return { status: "not-found" };
  if ("names" in who) return { status: "ambiguous", names: who.names };
  const sent = await dm(env, fetch, who.id, giftDm(a.code, a.months), a.picture);
  return sent ? { status: "sent", name: who.name } : { status: "dm-closed", name: who.name };
}
