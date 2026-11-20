import { idTime, type Env, type Fetch } from "./ember.ts";
import { dm, secretLine, type Picture } from "./gift.ts";

/**
 * The launch-day Founder offer (Flint, 11-17; the owner's flow, 11-20), Ember's side. On each pass
 * she:
 * - posts the offer's announcement once, in #general (in #founder-test's pinned post while testing);
 * - looks at new posts in the offer's forum and asks the licence service whether each goes in line
 *   (the record and the rules are there: services/hearth-licence, founder.ts), answers with their
 *   place, and tells the owner in #founder-queue (private to him and her);
 * - announces each redemption ("Another Founder spot claimed! 24 left."), then "All 25 Founder
 *   spots are gone." (the licence service then closes the offer);
 * - keeps "Founder spots claimed: 7 of 25" in the pinned post;
 * - once a day at 18:00 UTC, reminds the owner if screenshots are still waiting;
 * - tells everyone turned away why, by DM (in their post when their DMs are closed). No silent
 *   refusals (the owner, 11-20). For 7 days after the offer ends she still answers new entries.
 * When the owner approves, she DMs that person Premium Ember and their code. A code is never posted
 * in a channel, and nothing for the owner is posted anywhere public. No AI: every line is written
 * ahead of time in her voice.
 */

const API = "https://discord.com/api/v10";
const FIRE = "%F0%9F%94%A5";

/** The licence service's FounderDesk, through a service binding (never over the internet). */
export interface FounderDesk {
  view(): Promise<{
    active: boolean;
    forumId: string | null;
    startsAt: string | null;
    pinnedThreadId: string | null;
    statusMessageId: string | null;
    line: string | null;
    changed: boolean;
    /** In #founder-test: her posts go in its pinned post, not #general. */
    testing?: boolean;
    introPending?: boolean;
    claimed?: number;
    announced?: number;
    cap?: number;
    /** Screenshots waiting for the owner. */
    waiting?: number;
    /** Whether to look at new posts: while it runs, and 7 days after it ends. */
    watching?: boolean;
  }>;
  /** This pass's new posts, in one call: does each go in line? */
  seePosts(
    posts: {
      postId: string;
      userId: string;
      userName: string;
      postedAt: string;
      accountAt: string;
      hasImage: boolean;
      mentionsFounder: boolean;
    }[],
  ): Promise<
    (
      | { status: "counted"; number: number; cap: number }
      | { status: "denied"; denial: Denial }
      | { status: "ignored"; why: string }
      | { status: "known" }
    )[]
  >;
  /** Everyone turned away who hasn't been told yet, and marking them told. */
  pending?(): Promise<{ postId: string; userId: string; denial: Denial }[]>;
  told?(postIds: string[]): Promise<void>;
  wroteStatus(messageId: string, line: string): Promise<void>;
  postedIntro?(): Promise<void>;
  /** She announced redemptions up to n (the last one closes the offer). */
  announced?(n: number): Promise<void>;
}

/** Why a post was turned away (the licence service's record: services/hearth-licence, founder.ts). */
export type Denial =
  | { why: "too-new"; from: string }
  | { why: "in-line"; number: number }
  | { why: "has-code" }
  | { why: "founder" }
  | { why: "dms-closed" }
  | { why: "expired" }
  | { why: "full"; cap: number }
  | { why: "ended" }
  | { why: "no-image" }
  | { why: "rejected"; reason: string };

/** A date Discord shows in the reader's own time zone. */
const day = (iso: string) => `<t:${Math.floor(Date.parse(iso) / 1000)}:D>`;

/** Her DM for each reason (the owner's approved lines, 11-20). His own reason goes word for word. */
export function denialLine(d: Denial): string {
  switch (d.why) {
    case "too-new":
      return `Your Discord account needs to be 7 days old for a Founder spot. You can post again from ${day(d.from)}.`;
    case "in-line":
      return `You're already in line (#${d.number}), no need to post again!`;
    case "has-code":
      return "You already have a Founder code, check your DMs from me!";
    case "founder":
      return "You're already a Founder! 👑";
    case "dms-closed":
      return "You're already in line. Your DMs were closed when I tried to send your code, so open them and the owner will send it again.";
    case "expired":
      return "Your earlier code expired. The owner can send you another while spots are left.";
    case "full":
      return `All ${d.cap} Founder spots are gone, thank you so much for sharing your Lair! 🔥`;
    case "ended":
      return "The Founder offer has ended, thank you so much for sharing your Lair! 🔥";
    case "no-image":
      return "To enter, post a screenshot of your Hearth Lair in this thread and you're in line!";
    case "rejected":
      return `Sorry, your Founder post wasn't approved: ${d.reason}\n\nThank you so much for sharing your Lair! 🔥`;
  }
}

/** In their post, when the DM with the reason couldn't be delivered. */
export const dmsClosedPostLine = (user: string) =>
  `<@${user}> I tried to DM you, but your DMs are closed. Turn on Direct Messages for this server (right-click the server icon, Privacy Settings), then post again.`;

/** The owner's code page, where the queue is. */
export const QUEUE_URL = "https://hearth.dragonsoath.com/codes";

/** The offer's announcement (the owner's words, 11-20). forum: the channel to post in. */
export const introMessage = (forum: string, cap: number) =>
  `🔥 Founder giveaway: ${cap} free lifetime Founder licences!

The first ${cap} people to share their Hearth Lair get Hearth Premium for life, free.

How to claim yours:
1. Turn on DMs for this server, so Ember can send your code: right-click the server icon, Privacy Settings, then turn on Direct Messages. No open DMs, no code.
2. Post a screenshot of your Hearth Lair in <#${forum}>.
3. Once your post is checked, Ember DMs you your Founder code. Redeem it in Hearth under Settings, Premium.

The fine print:
- One per person. Your Discord account must be at least 7 days old.
- Your code holds your spot for 7 days. Redeem it before then, or the spot goes to the next person.
- I'll post here every time a spot is claimed, until all ${cap} are gone.

Good luck, and show us those Lairs! 🔥`;

/** Each redemption, then the last one. */
export const claimedLine = (n: number, cap: number) =>
  n >= cap
    ? `All ${cap} Founder spots are gone.`
    : `Another Founder spot claimed! ${cap - n} left.`;

/** For the owner only, in #founder-queue. Never a code. */
export const queueLine = (guild: string, forum: string, postId: string, name: string) =>
  `New Founder screenshot to check from @${name} in <#${forum}>\nPost: https://discord.com/channels/${guild}/${postId}\nQueue: ${QUEUE_URL}`;
export const reminderLine = (n: number) =>
  `${n === 1 ? "1 Founder screenshot is" : `${n} Founder screenshots are`} still waiting for you: ${QUEUE_URL}`;

export const countedLine = (n: number) =>
  `Got it! You're #${n} in line. Make sure your DMs are open for this server so I can send your code.`;
export const dmMessage = (code: string, hold = "7 days") =>
  `Special delivery! 📬 Here's your Hearth Founder code:\n\n**${code}**\n\nIn Hearth, open Settings, Premium, and enter it under Redeem a code. It works once, on one Hearth, and it's Premium for good. It holds your spot for ${hold}, so redeem it soon! Thank you for being one of the first by the fire! 🔥\n\n${secretLine}`;
export const dmClosedLine = (user: string) =>
  `<@${user}> I have a delivery for you, but your DMs are closed! 📬 Open them for this server (tap the server name, then Privacy Settings, then Direct Messages) and I'll try again.`;

interface Thread {
  id: string;
  name?: string;
  parent_id?: string;
  owner_id?: string;
  applied_tags?: string[];
}
interface Message {
  id: string;
  author?: { id?: string; username?: string; global_name?: string | null };
  content?: string;
  attachments?: { content_type?: string; filename?: string }[];
}

const auth = (env: Env) => ({
  authorization: `Bot ${env.BOT_TOKEN}`,
  "content-type": "application/json",
});

const isImage = (a: { content_type?: string; filename?: string }) =>
  (a.content_type ?? "").startsWith("image/") ||
  /\.(png|jpe?g|webp|gif|avif|heic)$/i.test(a.filename ?? "");

/**
 * One pass of the offer: puts new posts in line, tells anyone turned away why, and keeps the
 * pinned line current. Runs before the usual cheer, so a counted post's reply is its place in line
 * and the cheer pass then sees she already answered. Returns how many posts she put in line.
 */
export async function founderPass(env: Env, desk: FounderDesk, fetch: Fetch): Promise<number> {
  const view = await desk.view();
  if (!view.forumId) return 0;
  const h = auth(env);
  let answered = 0;
  const cap = view.cap ?? 25;
  // Her public posts: #general, or the pinned post while testing in #founder-test.
  const board = view.testing ? view.pinnedThreadId : env.GENERAL_ID || null;
  const post = (channel: string, content: string) =>
    fetch(`${API}/channels/${channel}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });

  if (view.introPending && board && desk.postedIntro) {
    if ((await post(board, introMessage(view.forumId, cap))).ok) await desk.postedIntro();
  }

  if ((view.watching ?? view.active) && view.startsAt) {
    const start = Date.parse(view.startsAt);
    const active = await fetch(`${API}/guilds/${env.GUILD_ID}/threads/active`, { headers: h });
    const threads = active.ok ? ((await active.json()) as { threads: Thread[] }).threads : [];
    const fresh = threads
      .filter(
        (t) => t.parent_id === view.forumId && t.owner_id !== env.APP_ID && idTime(t.id) >= start,
      )
      .sort((a, b) => idTime(a.id) - idTime(b.id));
    // Every post is read each pass and the licence service's record says which are new (her usual
    // cheer replies to posts too, so a reply from her doesn't mean the offer has seen it). A
    // screenshot added later in their thread counts.
    const seen: { id: string; user: string; name: string }[] = [];
    const posts = [];
    for (const t of fresh) {
      const msgs = await fetch(`${API}/channels/${t.id}/messages?limit=50`, { headers: h });
      if (!msgs.ok) continue;
      const list = (await msgs.json()) as Message[];
      // A forum post's first message has the same id as the post.
      const first = list.find((m) => m.id === t.id);
      const user = first?.author?.id ?? t.owner_id;
      if (!user) continue;
      const theirs = list.filter((m) => m.author?.id === user);
      const name = first?.author?.global_name || first?.author?.username || "someone";
      seen.push({ id: t.id, user, name });
      posts.push({
        postId: t.id,
        userId: user,
        userName: name,
        postedAt: new Date(idTime(t.id)).toISOString(),
        accountAt: new Date(idTime(user)).toISOString(),
        hasImage: theirs.some((m) => (m.attachments ?? []).some(isImage)),
        mentionsFounder: /founder/i.test(
          [t.name ?? "", ...theirs.map((m) => m.content ?? "")].join("\n"),
        ),
      });
    }
    const results = posts.length ? await desk.seePosts(posts) : [];
    for (const [i, r] of results.entries()) {
      const { id, user, name } = seen[i]!;
      if (r.status !== "counted") continue;
      await fetch(`${API}/channels/${id}/messages/${id}/reactions/${FIRE}/@me`, {
        method: "PUT",
        headers: h,
      });
      const sent = await fetch(`${API}/channels/${id}/messages`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          content: countedLine(r.number),
          allowed_mentions: { users: [user] },
        }),
      });
      if (sent.ok) answered++;
      // The owner hears about each one in his private channel (never a code, never public).
      if (env.QUEUE_ID) await post(env.QUEUE_ID, queueLine(env.GUILD_ID, view.forumId, id, name));
    }
  }

  // Everyone turned away hears why, once. A failure is tried again on the next pass.
  if (desk.pending && desk.told) {
    const told: string[] = [];
    for (const x of await desk.pending()) {
      try {
        await tellDenied(env, fetch, x);
        told.push(x.postId);
      } catch {
        // Discord had a problem: next pass.
      }
    }
    if (told.length) await desk.told(told);
  }

  // Each redemption, announced once; the last one closes the offer (the licence service does).
  if (board && desk.announced && (view.claimed ?? 0) > (view.announced ?? 0)) {
    for (let n = (view.announced ?? 0) + 1; n <= (view.claimed ?? 0); n++) {
      if (!(await post(board, claimedLine(n, cap))).ok) break;
      await desk.announced(n);
    }
  }

  // The pinned post's line: edit hers, or add it the first time.
  if (view.pinnedThreadId && view.line && (view.changed || !view.statusMessageId)) {
    const body = JSON.stringify({ content: view.line, allowed_mentions: { parse: [] } });
    let id = view.statusMessageId;
    const edited = id
      ? await fetch(`${API}/channels/${view.pinnedThreadId}/messages/${id}`, {
          method: "PATCH",
          headers: h,
          body,
        })
      : undefined;
    if (!edited?.ok) {
      const made = await fetch(`${API}/channels/${view.pinnedThreadId}/messages`, {
        method: "POST",
        headers: h,
        body,
      });
      id = made.ok ? ((await made.json()) as { id: string }).id : null;
    }
    if (id) await desk.wroteStatus(id, view.line);
  }
  return answered;
}

/**
 * Tells someone why their post was turned away: a DM, or, when their DMs are closed, a short reply
 * in their post asking them to open DMs and post again. Throws when neither reached them.
 */
export async function tellDenied(
  env: Env,
  fetch: Fetch,
  a: { userId: string; postId: string; denial: Denial },
): Promise<{ via: "dm" | "thread" }> {
  if (await dm(env, fetch, a.userId, denialLine(a.denial))) return { via: "dm" };
  const r = await fetch(`${API}/channels/${a.postId}/messages`, {
    method: "POST",
    headers: auth(env),
    body: JSON.stringify({
      content: dmsClosedPostLine(a.userId),
      allowed_mentions: { users: [a.userId] },
    }),
  });
  if (!r.ok) throw new Error(`Discord answered ${r.status} replying in their post.`);
  return { via: "thread" };
}

/**
 * The owner approved a post: Ember DMs that person their code. If their DMs are closed she asks
 * them, in their post, to open them (without the code), and says it wasn't sent.
 */
export async function sendFounderCode(
  env: Env,
  fetch: Fetch,
  a: { userId: string; postId: string; code: string; hold?: string; picture?: Picture | null },
): Promise<{ sent: boolean }> {
  const h = auth(env);
  // Premium Ember comes with it (gift.ts); 50007 (DMs closed, or they left) is false here.
  if (await dm(env, fetch, a.userId, dmMessage(a.code, a.hold), a.picture)) return { sent: true };
  await fetch(`${API}/channels/${a.postId}/messages`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      content: dmClosedLine(a.userId),
      allowed_mentions: { users: [a.userId] },
    }),
  });
  return { sent: false };
}
