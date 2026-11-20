import { describe, expect, it } from "vitest";
import { newSigningKey } from "../../../apps/server/src/premium/license";
import {
  claimedLine,
  emberAnnounced,
  emberTold,
  emberView,
  ENDED_ANSWER_MS,
  HOLD_MINUTES,
  memoryFounderStore,
  pending,
  seePost,
  type Offer,
  type PostSeen,
} from "./founder";
import { handle, memoryStore } from "./licence";
import { threadOf } from "./owner";

const DAY = 86_400_000;
const START = Date.parse("2026-12-01T18:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const post = (n: number, over: Partial<PostSeen> = {}): PostSeen => ({
  postId: `post-${n}`,
  userId: `user-${n}`,
  userName: `person${n}`,
  postedAt: iso(START + n * 60_000),
  accountAt: iso(START - 30 * DAY),
  hasImage: true,
  ...over,
});

const OFFER: Offer = {
  campaignId: "camp",
  forumId: "forum",
  startsAt: iso(START),
  minAgeDays: 7,
  pinnedThreadId: "pinned",
  statusMessageId: null,
  statusLine: null,
  active: true,
  holdMinutes: HOLD_MINUTES,
  claimsAnnounced: 0,
  introPosted: false,
  endedAt: null,
};

async function offer(over: Partial<Offer> = {}) {
  const f = memoryFounderStore();
  await f.putOffer({ ...OFFER, ...over });
  return f;
}

describe("the Founder offer's line", () => {
  it("puts every post with a screenshot in line, holding no spot, however many come", async () => {
    const f = await offer();
    for (const n of [1, 2, 3])
      expect(await seePost(f, 2, post(n))).toEqual({ status: "counted", number: n, cap: 2 });
    // Seen before: nothing more, on any later pass.
    expect(await seePost(f, 2, post(1))).toEqual({ status: "known" });
    const v = await emberView(f, async () => 2);
    expect(v).toMatchObject({ claimed: 0, waiting: 3, line: "Founder spots claimed: 0 of 2" });
    expect(v.introPending).toBe(true);
  });

  it("counts spots on redemption, announces each, and closes itself on the last", async () => {
    const f = await offer();
    const used = new Set<string>();
    for (const n of [1, 2]) {
      await seePost(f, 2, post(n));
      const e = (await f.entry(`post-${n}`))!;
      await f.putEntry({
        ...e,
        status: "sent",
        codeId: `code-${n}`,
        heldUntil: iso(START + 7 * DAY),
      });
    }
    // Two more in line, one of them after their DMs were closed.
    await seePost(f, 2, post(3));
    await seePost(f, 2, post(4));
    const e4 = (await f.entry("post-4"))!;
    await f.putEntry({ ...e4, status: "dm-closed" });
    const codeUsed = async (id: string) => used.has(id);
    used.add("code-1");
    let v = await emberView(f, async () => 2, codeUsed, START + DAY);
    expect(v).toMatchObject({ claimed: 1, announced: 0, line: "Founder spots claimed: 1 of 2" });
    expect(claimedLine(1, 2)).toBe("Another Founder spot claimed! 1 left.");
    await emberAnnounced(f, 1, 2, codeUsed, START + DAY);
    used.add("code-2");
    v = await emberView(f, async () => 2, codeUsed, START + DAY);
    expect(v).toMatchObject({ claimed: 2, announced: 1 });
    expect(claimedLine(2, 2)).toBe("All 2 Founder spots are gone.");
    await emberAnnounced(f, 2, 2, codeUsed, START + 2 * DAY);
    expect(await f.offer()).toMatchObject({ active: false, endedAt: iso(START + 2 * DAY) });
    // Everyone still in line hears the spots are gone.
    expect((await pending(f)).map((x) => [x.postId, x.denial])).toEqual([
      ["post-3", { why: "full", cap: 2 }],
      ["post-4", { why: "full", cap: 2 }],
    ]);
    // Closed: later entries hear the spots are gone, once; a Founder hears they are one.
    const later = START + 3 * DAY;
    expect(await seePost(f, 2, post(9), codeUsed, later)).toEqual({
      status: "denied",
      denial: { why: "full", cap: 2 },
    });
    expect(await seePost(f, 2, post(9), codeUsed, later)).toEqual({ status: "known" });
    expect(await seePost(f, 2, post(8, { userId: "user-1" }), codeUsed, later)).toMatchObject({
      denial: { why: "founder" },
    });
    // 7 days after it ended she goes quiet, and stops looking.
    const quiet = START + 2 * DAY + ENDED_ANSWER_MS + 1;
    expect(await seePost(f, 2, post(7), codeUsed, quiet)).toMatchObject({ status: "ignored" });
    expect((await emberView(f, async () => 2, codeUsed, later)).watching).toBe(true);
    expect((await emberView(f, async () => 2, codeUsed, quiet)).watching).toBe(false);
  });

  it("answers 'the offer has ended' after he stops it", async () => {
    const f = await offer({ active: false, endedAt: iso(START + DAY) });
    expect(await seePost(f, 25, post(5), undefined, START + 2 * DAY)).toEqual({
      status: "denied",
      denial: { why: "ended" },
    });
    // Chatter without a picture still gets nothing.
    expect(
      await seePost(f, 25, post(6, { hasImage: false }), undefined, START + 2 * DAY),
    ).toMatchObject({
      status: "ignored",
    });
  });

  it("turns away with a reason (never silently), and says nothing to posts that aren't entries", async () => {
    const f = await offer();
    const at = START + 60 * DAY;
    // Not entries: no picture and no mention of the offer, or posted before it started.
    expect(await seePost(f, 25, post(1, { hasImage: false }), undefined, at)).toEqual({
      status: "ignored",
      why: "not an entry",
    });
    expect(await seePost(f, 25, post(3, { postedAt: iso(START - 60_000) }))).toMatchObject({
      why: "before start",
    });
    // Asking about it without a picture: told how to enter; adding one later puts them in line.
    expect(
      await seePost(f, 25, post(2, { hasImage: false, mentionsFounder: true }), undefined, at),
    ).toEqual({ status: "denied", denial: { why: "no-image" } });
    expect(await seePost(f, 25, post(2, { hasImage: false, mentionsFounder: true }))).toEqual({
      status: "known",
    });
    expect(await seePost(f, 25, post(2))).toEqual({ status: "counted", number: 1, cap: 25 });
    // Too new: the date they can post again (7 days after the account was made).
    expect(await seePost(f, 25, post(4, { accountAt: iso(START - 6 * DAY) }))).toEqual({
      status: "denied",
      denial: { why: "too-new", from: iso(START + DAY) },
    });
    // Already in line: their place.
    expect(await seePost(f, 25, post(5, { userId: "user-2" }))).toEqual({
      status: "denied",
      denial: { why: "in-line", number: 1 },
    });
    // Turned-away posts hold no spot.
    expect((await seePost(f, 25, post(6))).status).toBe("counted");
    expect((await f.entry("post-6"))!.number).toBe(2);
    // A rejected account may try again with a new post.
    const e = (await f.entry("post-6"))!;
    await f.putEntry({ ...e, status: "skipped" });
    expect((await seePost(f, 25, post(7, { userId: "user-6" }))).status).toBe("counted");

    // Each is waiting to be told, once (post-2 is in line now, so its old reason is gone).
    const told = await pending(f);
    expect(told.map((x) => [x.postId, x.denial.why])).toEqual([
      ["post-4", "too-new"],
      ["post-5", "in-line"],
    ]);
    await emberTold(
      f,
      told.map((x) => x.postId),
      START + DAY,
    );
    expect(await pending(f)).toEqual([]);
  });

  it("says which: holding a code, a Founder already, DMs closed, or the code expired", async () => {
    const f = await offer();
    const used = new Set<string>();
    const codeUsed = async (id: string) => used.has(id);
    for (const n of [1, 2, 3, 4]) await seePost(f, 25, post(n));
    const sent = async (n: number, heldUntil: number) => {
      const e = (await f.entry(`post-${n}`))!;
      await f.putEntry({ ...e, status: "sent", codeId: `code-${n}`, heldUntil: iso(heldUntil) });
    };
    await sent(1, START + 7 * DAY);
    await sent(2, START + 7 * DAY);
    used.add("code-2");
    await sent(3, START + DAY);
    const e4 = (await f.entry("post-4"))!;
    await f.putEntry({ ...e4, status: "dm-closed" });
    const again = async (n: number) =>
      seePost(f, 25, post(10 + n, { userId: `user-${n}` }), codeUsed, START + 2 * DAY);
    expect(await again(1)).toMatchObject({ denial: { why: "has-code" } });
    expect(await again(2)).toMatchObject({ denial: { why: "founder" } });
    expect(await again(3)).toMatchObject({ denial: { why: "expired" } });
    expect(await again(4)).toMatchObject({ denial: { why: "dms-closed" } });
  });

  it("reads a post's id from a Discord link", () => {
    expect(threadOf("https://discord.com/channels/1569095537272295595/1569127294042116999")).toBe(
      "1569127294042116999",
    );
    expect(
      threadOf(
        "https://discord.com/channels/1569095537272295595/1569127294042116999/1569127294042117000",
      ),
    ).toBe("1569127294042116999");
    expect(threadOf("nope")).toBeNull();
  });
});

describe("the Founder queue on the owner's page", () => {
  const service = newSigningKey();
  const env = {
    SIGNING_KEY: service.privatePem,
    OWNER_KEY: "",
    GITHUB_CLIENT_ID: "c",
    GITHUB_CLIENT_SECRET: "s",
    OWNER_GITHUB_ID: "1",
    SESSION_KEY: "k",
    SITE_ORIGIN: "https://site.test",
    GUILD_ID: "900",
    FORUM_ID: "1000",
    TEST_FORUM_ID: "2000",
  };

  async function signedIn(at: number) {
    const { createHmac } = await import("node:crypto");
    const exp = String(at + 3_600_000);
    const sig = createHmac("sha256", "k").update(`1.${exp}`).digest("base64url");
    return `__Host-hearth-owner=1.${exp}.${sig}`;
  }

  it("approves within the cap, holds spots for their time, and lets him send an expired one again", async () => {
    const store = memoryStore();
    const founder = memoryFounderStore();
    const sent: { userId: string; code: string; hold?: string }[] = [];
    const told: { userId: string; denial: { why: string; reason?: string } }[] = [];
    let dmsOpen = true;
    let clock = START;
    const ember = {
      async sendFounderCode(a: { userId: string; postId: string; code: string; hold?: string }) {
        if (!dmsOpen) return { sent: false };
        sent.push(a);
        return { sent: true };
      },
      async sendCode() {
        return { status: "not-found" as const };
      },
      async tellFounder(a: { userId: string; denial: { why: string; reason?: string } }) {
        told.push(a);
        return { via: dmsOpen ? ("dm" as const) : ("thread" as const) };
      },
    };
    const call = async (path: string, body?: unknown) =>
      handle(
        new Request(`https://site.test/codes/api/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            cookie: await signedIn(clock),
            "x-hearth-owner": "1",
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
        store,
        () => clock,
        fetch,
        { founder, ember },
      );
    const redeem = (code: string, install: string) =>
      handle(
        new Request("https://site.test/v1/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, install }),
        }),
        env,
        store,
        () => clock,
      );

    // Two spots, tried in #founder-test: codes hold 30 minutes there.
    const camp = (await (
      await call("campaign", { name: "Around the Fire launch", months: null, cap: 2 })
    ).json()) as { id: string };
    expect((await call("founder-start", { campaignId: camp.id, where: "test" })).status).toBe(200);
    expect(await founder.offer()).toMatchObject({ forumId: "2000", holdMinutes: 30 });
    for (const n of [1, 2, 3, 4]) await seePost(founder, 2, post(n, { postedAt: iso(START + n) }));

    expect(await (await call("founder-approve", { postId: "post-1" })).json()).toEqual({
      sent: true,
    });
    expect(sent[0]).toMatchObject({ userId: "user-1", hold: "30 minutes" });
    dmsOpen = false;
    // Closed DMs: nothing held.
    expect(await (await call("founder-approve", { postId: "post-2" })).json()).toEqual({
      sent: false,
    });
    dmsOpen = true;
    expect(await (await call("founder-approve", { postId: "post-2" })).json()).toEqual({
      sent: true,
    });
    // Two held: the third waits, however long the line.
    const full = await call("founder-approve", { postId: "post-3" });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toContain("claimed or held");

    // One redeems: claimed. The other's hold runs out: expired, its spot back.
    expect((await redeem(sent[0]!.code, "install-1")).status).toBe(200);
    clock = START + 31 * 60_000;
    expect((await redeem(sent[1]!.code, "install-2")).status).toBe(409);
    let view = (await (await call("founder")).json()) as {
      claimed: number;
      held: number;
      line: string;
      entries: { postId: string; standing: string | null }[];
    };
    expect(view).toMatchObject({ claimed: 1, held: 0, line: "Founder spots claimed: 1 of 2" });
    expect(view.entries.find((e) => e.postId === "post-2")!.standing).toBe("expired");

    // He approves the next in line, or sends the expired one again; never more than the cap.
    expect((await call("founder-approve", { postId: "post-3" })).status).toBe(200);
    expect((await call("founder-approve", { postId: "post-2" })).status).toBe(409);
    // Reject needs a reason; Ember tells them, and it shows on his page.
    expect((await call("founder-reject", { postId: "post-4", reason: " " })).status).toBe(400);
    expect(
      await (
        await call("founder-reject", {
          postId: "post-4",
          reason: "We can only accept one entry per person.",
        })
      ).json(),
    ).toEqual({ via: "dm" });
    expect(told).toEqual([
      {
        userId: "user-4",
        postId: "post-4",
        denial: { why: "rejected", reason: "We can only accept one entry per person." },
      },
    ]);
    expect(await founder.entry("post-4")).toMatchObject({ status: "skipped", toldAt: iso(clock) });
    expect((await call("founder-reject", { postId: "post-4", reason: "x" })).status).toBe(409);

    view = (await (await call("founder")).json()) as typeof view;
    expect(view).toMatchObject({ claimed: 1, held: 1 });
    // No code is ever in the view. Live: the redeemed one, the held one, and the expired one
    // (dead by its date; switched off if sent again). The undelivered one is off.
    expect(JSON.stringify(view)).not.toContain(sent[0]!.code);
    const live = (await store.codes()).filter((c) => c.active);
    expect(live).toHaveLength(3);
    // Nothing redeemed is approved twice.
    expect((await call("founder-approve", { postId: "post-1" })).status).toBe(409);
  });

  it("is closed to anyone not signed in as the owner", async () => {
    const res = await handle(
      new Request("https://site.test/codes/api/founder-approve", {
        method: "POST",
        headers: { "x-hearth-owner": "1" },
        body: JSON.stringify({ postId: "post-1" }),
      }),
      env,
      memoryStore(),
      () => START,
      fetch,
      { founder: memoryFounderStore() },
    );
    expect(res.status).toBe(401);
  });

  it("sends anyone on another address to the code page's own address", async () => {
    const res = await handle(
      new Request("https://licence.test/codes"),
      env,
      memoryStore(),
      () => START,
      fetch,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://site.test/codes");
  });
});
