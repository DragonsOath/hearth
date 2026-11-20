/**
 * The launch-day Founder offer (Flint, 11-17; the owner's flow, 11-20): Ember Bot puts every post
 * with a Lair screenshot in #around-the-fire in line, the owner approves or skips each on his code
 * page, and Ember Bot DMs the approved person a one-use Founder code with Premium Ember.
 *
 * Spots count when a code is redeemed, not when someone posts: a sent code holds its spot for 7
 * days (its redeem-by date), then expires and the spot returns. Never more than the campaign's cap
 * (25) codes live at once: redeemed, plus sent and still held. Posts waiting in line hold nothing.
 * Each redemption is announced ("Another Founder spot claimed! 24 left."), and the last one closes
 * the offer. This file is the record; Ember Bot does the Discord side (services/ember-bot).
 *
 * No silent refusals (the owner, 11-20): every post turned away is recorded with its reason
 * (a Denial), and Ember DMs the person that reason once (in their post when their DMs are closed).
 * A denied post holds no spot and never goes to #founder-queue. For 7 days after the offer ends
 * she still answers new entries with "the offer has ended" (or "the spots are gone"), then goes
 * quiet.
 */

export interface Offer {
  /** The campaign its codes come from (Founder, its cap is the number of spots). */
  campaignId: string;
  /** The forum Ember Bot watches: #around-the-fire, or #founder-test while testing. */
  forumId: string;
  /** Posts made before this don't count (ISO). */
  startsAt: string;
  /** How old a Discord account must be when it posts. */
  minAgeDays: number;
  /** The pinned post Ember Bot keeps "Founder spots: 7 of 25" in, and her message there. */
  pinnedThreadId: string | null;
  statusMessageId: string | null;
  /** The last line Ember Bot wrote there (so she only edits when it changes). */
  statusLine: string | null;
  active: boolean;
  /** How long a sent code holds its spot (7 days; a short time in #founder-test). */
  holdMinutes: number;
  /** How many redemptions Ember Bot has announced so far. */
  claimsAnnounced: number;
  /** Whether Ember Bot posted the offer's announcement. */
  introPosted: boolean;
  /** When it stopped or closed itself (ISO); null while it runs. */
  endedAt: string | null;
}

/** After the offer ends, Ember answers new entries this long, then goes quiet. */
export const ENDED_ANSWER_MS = 7 * 86_400_000;

/**
 * Why a post was turned away, in a form Ember turns into her line (services/ember-bot,
 * founder.ts, denialLine). The owner's own reason is sent word for word.
 */
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

/** A sent code holds its spot this long (live), or this long while testing in #founder-test. */
export const HOLD_MINUTES = 7 * 24 * 60;
export const TEST_HOLD_MINUTES = 30;

/**
 * skipped: the owner rejected it (with his reason). late: still in line when every spot was
 * claimed. denied: turned away when Ember saw it (too new, already in line, the offer ended...).
 * A sent code is redeemed, held or expired: see standing(), read from the code itself.
 */
export type EntryStatus = "waiting" | "sent" | "dm-closed" | "skipped" | "late" | "denied";

export interface Entry {
  /** The forum post (a thread; its first message has the same id). */
  postId: string;
  userId: string;
  userName: string;
  postedAt: string;
  /** Their spot when counted ("You're #7 of 25"). */
  number: number;
  status: EntryStatus;
  /** The code sent (its id only; the code itself is never kept). */
  codeId: string | null;
  decidedAt: string | null;
  /** When a sent code stops holding the spot (ISO); null until sent. */
  heldUntil: string | null;
  /** Why it was turned away (JSON of a Denial); null otherwise. */
  reason: string | null;
  /** When Ember told them why (ISO); null until she has. */
  toldAt: string | null;
}

/** An entry that is out of the line (rejected, too late, or turned away). */
const out = (e: Entry) => e.status === "skipped" || e.status === "late" || e.status === "denied";

export interface FounderStore {
  offer(): Promise<Offer | null>;
  putOffer(o: Offer): Promise<void>;
  entries(): Promise<Entry[]>;
  entry(postId: string): Promise<Entry | null>;
  putEntry(e: Entry): Promise<void>;
}

/** What a sent entry's code is doing now. */
export type Standing = "redeemed" | "held" | "expired";

/** Where the offer stands: spots claimed (redeemed), held (sent, not yet), and the rest. */
export async function standing(
  entries: Entry[],
  codeUsed: (codeId: string) => Promise<boolean>,
  now: number,
): Promise<{ claimed: number; held: number; waiting: number; of: Map<string, Standing> }> {
  const of = new Map<string, Standing>();
  let claimed = 0;
  let held = 0;
  for (const e of entries) {
    if (e.status !== "sent" || !e.codeId) continue;
    if (await codeUsed(e.codeId)) {
      of.set(e.postId, "redeemed");
      claimed++;
    } else if (e.heldUntil && Date.parse(e.heldUntil) > now) {
      of.set(e.postId, "held");
      held++;
    } else of.set(e.postId, "expired");
  }
  const waiting = entries.filter((e) => e.status === "waiting").length;
  return { claimed, held, waiting, of };
}

export const statusLine = (claimed: number, cap: number) =>
  claimed >= cap
    ? `Founder spots: all ${cap} claimed. Thank you, everyone! 🔥`
    : `Founder spots claimed: ${claimed} of ${cap}`;

export interface PostSeen {
  postId: string;
  userId: string;
  userName: string;
  /** When the post was made (ISO). */
  postedAt: string;
  /** When the account was made (ISO, read from its Discord id). */
  accountAt: string;
  /** A picture from them anywhere in their post (added later in the thread counts too). */
  hasImage: boolean;
  /** They wrote "Founder" in the post's title or their messages. */
  mentionsFounder?: boolean;
}

export type EntryResult =
  | { status: "counted"; number: number; cap: number }
  /** Turned away and recorded: Ember tells them why (pending()). */
  | { status: "denied"; denial: Denial }
  /** Not an entry: before the offer, no offer, or a post that isn't about it. Nothing is said. */
  | { status: "ignored"; why: "no offer" | "before start" | "not an entry" }
  /** This post was handled on an earlier pass. */
  | { status: "known" };

/**
 * Ember Bot saw a post: does it go in line? One per Discord account (a rejected account may try
 * again with a new post), accounts at least minAgeDays old, and a screenshot. Being in line holds
 * no spot: the owner approves, and spots count when codes are redeemed. Anything turned away is
 * recorded with its reason, so Ember tells them once. A post told it needs a screenshot is looked
 * at again when one is added.
 */
export async function seePost(
  store: FounderStore,
  cap: number,
  p: PostSeen,
  codeUsed: (codeId: string) => Promise<boolean> = async () => false,
  now = Date.now(),
): Promise<EntryResult> {
  const offer = await store.offer();
  if (!offer) return { status: "ignored", why: "no offer" };
  const ended = !offer.active;
  if (ended && (!offer.endedAt || now - Date.parse(offer.endedAt) > ENDED_ANSWER_MS))
    return { status: "ignored", why: "no offer" };
  const before = await store.entry(p.postId);
  if (
    before &&
    !(before.status === "denied" && before.reason?.includes('"no-image"') && p.hasImage)
  )
    return { status: "known" };
  if (Date.parse(p.postedAt) < Date.parse(offer.startsAt))
    return { status: "ignored", why: "before start" };
  // A post without a picture is an entry only when it talks about the offer.
  if (!p.hasImage && !p.mentionsFounder) return { status: "ignored", why: "not an entry" };

  const all = (await store.entries()).filter((e) => e.postId !== p.postId);
  const deny = async (denial: Denial): Promise<EntryResult> => {
    await store.putEntry({
      postId: p.postId,
      userId: p.userId,
      userName: p.userName,
      postedAt: p.postedAt,
      number: 0,
      status: "denied",
      codeId: null,
      decidedAt: new Date(now).toISOString(),
      heldUntil: null,
      reason: JSON.stringify(denial),
      toldAt: null,
    });
    return { status: "denied", denial };
  };

  // Already in line, holding a code, or a Founder: say which.
  const mine = all.find((e) => e.userId === p.userId && !out(e));
  if (mine) {
    if (mine.status === "waiting") return deny({ why: "in-line", number: mine.number });
    if (mine.status === "dm-closed") return deny({ why: "dms-closed" });
    const st = (await standing([mine], codeUsed, now)).of.get(mine.postId);
    return deny(
      st === "redeemed"
        ? { why: "founder" }
        : st === "held"
          ? { why: "has-code" }
          : { why: "expired" },
    );
  }
  if (ended) return deny(offer.claimsAnnounced >= cap ? { why: "full", cap } : { why: "ended" });
  if (!p.hasImage) return deny({ why: "no-image" });
  const old = Date.parse(p.accountAt) + offer.minAgeDays * 86_400_000;
  if (Date.parse(p.postedAt) < old)
    return deny({ why: "too-new", from: new Date(old).toISOString() });

  const n = all.filter((e) => e.status !== "late" && e.status !== "denied").length + 1;
  await store.putEntry({
    postId: p.postId,
    userId: p.userId,
    userName: p.userName,
    postedAt: p.postedAt,
    number: n,
    status: "waiting",
    codeId: null,
    decidedAt: null,
    heldUntil: null,
    reason: null,
    toldAt: null,
  });
  return { status: "counted", number: n, cap };
}

/** Everyone turned away who hasn't been told yet, oldest first (a few per pass). */
export async function pending(store: FounderStore, max = 8) {
  return (await store.entries())
    .filter((e) => e.reason && !e.toldAt && out(e))
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
    .slice(0, max)
    .map((e) => ({ postId: e.postId, userId: e.userId, denial: JSON.parse(e.reason!) as Denial }));
}

/** Ember told them (by DM, or in their post). */
export async function emberTold(store: FounderStore, postIds: string[], now = Date.now()) {
  for (const id of postIds) {
    const e = await store.entry(id);
    if (e && !e.toldAt) await store.putEntry({ ...e, toldAt: new Date(now).toISOString() });
  }
}

export function memoryFounderStore(): FounderStore {
  let offer: Offer | null = null;
  const entries = new Map<string, Entry>();
  return {
    async offer() {
      return offer ? { ...offer } : null;
    },
    async putOffer(o) {
      offer = { ...o };
    },
    async entries() {
      return [...entries.values()].map((e) => ({ ...e }));
    },
    async entry(id) {
      const e = entries.get(id);
      return e ? { ...e } : null;
    },
    async putEntry(e) {
      entries.set(e.postId, { ...e });
    },
  };
}

/** What Ember Bot asks on each pass (through the service binding; see worker.ts). */
export interface EmberView {
  active: boolean;
  forumId: string | null;
  startsAt: string | null;
  pinnedThreadId: string | null;
  statusMessageId: string | null;
  /** The line the pinned post should show now, and whether it differs from what she last wrote. */
  line: string | null;
  changed: boolean;
  /** In #founder-test: announcements go in its pinned post, not #general. */
  testing: boolean;
  /** The offer's announcement is still to be posted. */
  introPending: boolean;
  /** Redemptions so far, and how many she already announced. */
  claimed: number;
  announced: number;
  cap: number;
  /** Posts waiting for the owner (the daily reminder). */
  waiting: number;
  /** How long a code holds its spot, in words for her DM ("7 days"). */
  hold: string;
  /** Whether she looks at new posts: while it runs, and 7 days after it ends. */
  watching: boolean;
}

export const holdWords = (minutes: number) =>
  minutes % 1440 === 0
    ? `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`
    : minutes % 60 === 0
      ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
      : `${minutes} minutes`;

export async function emberView(
  founder: FounderStore,
  capOf: (campaignId: string) => Promise<number | null>,
  codeUsed: (codeId: string) => Promise<boolean> = async () => false,
  now = Date.now(),
  testForumId?: string,
): Promise<EmberView> {
  const o = await founder.offer();
  if (!o)
    return {
      active: false,
      forumId: null,
      startsAt: null,
      pinnedThreadId: null,
      statusMessageId: null,
      line: null,
      changed: false,
      testing: false,
      introPending: false,
      claimed: 0,
      announced: 0,
      cap: 0,
      waiting: 0,
      hold: holdWords(HOLD_MINUTES),
      watching: false,
    };
  const cap = (await capOf(o.campaignId)) ?? 25;
  const st = await standing(await founder.entries(), codeUsed, now);
  const line = statusLine(st.claimed, cap);
  return {
    active: o.active,
    forumId: o.forumId,
    startsAt: o.startsAt,
    pinnedThreadId: o.pinnedThreadId,
    statusMessageId: o.statusMessageId,
    line,
    changed: line !== o.statusLine,
    testing: Boolean(testForumId) && o.forumId === testForumId,
    introPending: o.active && !o.introPosted,
    claimed: st.claimed,
    announced: o.claimsAnnounced,
    cap,
    waiting: o.active ? st.waiting : 0,
    hold: holdWords(o.holdMinutes),
    watching: o.active || (o.endedAt !== null && now - Date.parse(o.endedAt) <= ENDED_ANSWER_MS),
  };
}

/** Ember wrote (or edited) her line in the pinned post. */
export async function emberWroteStatus(founder: FounderStore, messageId: string, line: string) {
  const o = await founder.offer();
  if (o) await founder.putOffer({ ...o, statusMessageId: messageId, statusLine: line });
}

/** Ember posted the offer's announcement. */
export async function emberPostedIntro(founder: FounderStore) {
  const o = await founder.offer();
  if (o) await founder.putOffer({ ...o, introPosted: true });
}

/**
 * Ember announced redemptions up to n. The last spot closes the offer: nothing more is counted,
 * everyone still in line (or whose code went unredeemed) is told the spots are gone, and so are
 * later posts for 7 days.
 */
export async function emberAnnounced(
  founder: FounderStore,
  n: number,
  cap: number,
  codeUsed: (codeId: string) => Promise<boolean> = async () => false,
  now = Date.now(),
) {
  const o = await founder.offer();
  if (!o) return;
  const closing = n >= cap && o.active;
  await founder.putOffer({
    ...o,
    claimsAnnounced: Math.max(o.claimsAnnounced, n),
    ...(closing ? { active: false, endedAt: new Date(now).toISOString() } : {}),
  });
  if (!closing) return;
  const entries = await founder.entries();
  const st = await standing(entries, codeUsed, now);
  for (const e of entries) {
    const left =
      e.status === "waiting" || e.status === "dm-closed" || st.of.get(e.postId) === "expired";
    if (left)
      await founder.putEntry({
        ...e,
        status: "late",
        decidedAt: new Date(now).toISOString(),
        reason: JSON.stringify({ why: "full", cap } satisfies Denial),
        toldAt: null,
      });
  }
}

/** Her lines for #general (or the test post): one per redemption, then the last one. */
export const claimedLine = (n: number, cap: number) =>
  n >= cap
    ? `All ${cap} Founder spots are gone.`
    : `Another Founder spot claimed! ${cap - n} left.`;
