import { describe, expect, it } from "vitest";
import type { Env } from "./ember.ts";
import {
  denialLine,
  founderPass,
  sendFounderCode,
  tellDenied,
  type Denial,
  type FounderDesk,
} from "./founder.ts";

const env: Env = {
  APP_ID: "100",
  PUBLIC_KEY: "",
  GUILD_ID: "200",
  FORUM_ID: "300",
  BOT_TOKEN: "test-token",
  SHOWCASE_URL: "https://example.test/hearth",
  PANEL_REQUESTS_URL: "https://example.test/panels",
};
const idAt = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);
const START = Date.parse("2026-12-01T18:00:00Z");
const OLD_USER = idAt(START - 90 * 86_400_000);

/** Discord, faked: some posts in the test forum, DMs (closed for some people), and what Ember sent. */
function discord(
  posts: {
    id: string;
    user: string;
    image: boolean;
    answered?: boolean;
    text?: string;
    title?: string;
    laterImage?: boolean;
  }[],
  dmsClosed: string[] = [],
) {
  const sent: { url: string; method: string; body?: unknown }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") sent.push({ url, method, body });
    if (url.endsWith("/threads/active"))
      return Response.json({
        threads: posts.map((p) => ({
          id: p.id,
          name: p.title ?? "My Lair",
          parent_id: "test-forum",
          owner_id: p.user,
        })),
      });
    if (url.endsWith("/users/@me/channels"))
      return Response.json({ id: `dm${(body as { recipient_id: string }).recipient_id}` });
    const d = /channels\/dm(\d+)\/messages$/.exec(url);
    if (d)
      return dmsClosed.includes(d[1]!)
        ? Response.json({ code: 50007, message: "Cannot send messages" }, { status: 403 })
        : Response.json({ id: "dm-msg" });
    const m = /channels\/(\d+)\/messages\?limit/.exec(url);
    if (m) {
      const p = posts.find((x) => x.id === m[1])!;
      return Response.json([
        ...(p.laterImage
          ? [{ id: "8", author: { id: p.user }, attachments: [{ filename: "lair.webp" }] }]
          : []),
        ...(p.answered ? [{ id: "9", author: { id: "100" } }] : []),
        {
          id: p.id,
          author: { id: p.user, username: `u${p.user.slice(-3)}` },
          content: p.text ?? "",
          attachments: p.image ? [{ content_type: "image/png", filename: "lab.png" }] : [],
        },
      ]);
    }
    if (method === "POST" && url.endsWith("/messages")) return Response.json({ id: "status-1" });
    return new Response(null, { status: 204 });
  };
  return { f, sent };
}

describe("Ember Bot's side of the Founder offer", () => {
  it("puts posts in line, reads every post (even ones she cheered), and sees pictures added later", async () => {
    const a = idAt(START + 60_000);
    const b = idAt(START + 120_000);
    const c = idAt(START + 180_000);
    const d = idAt(START + 240_000);
    const e = idAt(START + 300_000);
    const { f, sent } = discord([
      { id: a, user: OLD_USER, image: true },
      {
        id: b,
        user: OLD_USER.replace(/.$/, "7"),
        image: false,
        text: "How do I get a founder spot?",
      },
      { id: c, user: OLD_USER.replace(/.$/, "8"), image: false, title: "Founder entry" },
      { id: d, user: OLD_USER.replace(/.$/, "9"), image: false, text: "Just saying hi" },
      { id: e, user: OLD_USER.replace(/.$/, "6"), image: false, answered: true, laterImage: true },
    ]);
    let asked: Parameters<FounderDesk["seePosts"]>[0] = [];
    const desk: FounderDesk = {
      view: async () => ({
        active: true,
        forumId: "test-forum",
        startsAt: new Date(START).toISOString(),
        pinnedThreadId: "pinned",
        statusMessageId: null,
        line: "Founder spots: 0 of 2",
        changed: true,
      }),
      seePosts: async (ps) => {
        asked = ps;
        return ps.map((p) =>
          p.postId === a || p.postId === e
            ? { status: "counted" as const, number: p.postId === a ? 1 : 2, cap: 2 }
            : { status: "ignored" as const, why: "not an entry" },
        );
      },
      wroteStatus: async (id, line) => {
        expect([id, line]).toEqual(["status-1", "Founder spots: 0 of 2"]);
      },
    };
    expect(await founderPass({ ...env, QUEUE_ID: "queue" }, desk, f)).toBe(2);
    // Asked about every post in one call, the one she already cheered included.
    expect(asked.map((p) => p.postId)).toEqual([a, b, c, d, e]);
    expect(asked.map((p) => [p.hasImage, p.mentionsFounder])).toEqual([
      [true, false],
      [false, true],
      [false, true],
      [false, false],
      [true, false],
    ]);
    expect(Date.parse(asked[0]!.accountAt)).toBe(START - 90 * 86_400_000);
    const replies = sent.filter(
      (s) => s.method === "POST" && s.url.includes(`/channels/${a}/messages`),
    );
    expect((replies[0]!.body as { content: string }).content).toBe(
      "Got it! You're #1 in line. Make sure your DMs are open for this server so I can send your code.",
    );
    // Only the posts in line go to the owner's queue.
    expect(sent.filter((s) => s.url.endsWith("/channels/queue/messages"))).toHaveLength(2);
    expect(sent.some((s) => s.url.endsWith("/channels/pinned/messages"))).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/HRTH-/);
  });

  it("tells everyone turned away why: by DM, or in their post when DMs are closed", async () => {
    const a = idAt(START + 60_000);
    const b = idAt(START + 120_000);
    const open = OLD_USER.replace(/.$/, "1");
    const closed = OLD_USER.replace(/.$/, "2");
    const { f, sent } = discord([], [closed]);
    const told: string[][] = [];
    let waiting: { postId: string; userId: string; denial: Denial }[] = [
      { postId: a, userId: open, denial: { why: "too-new", from: "2026-12-08T18:00:00.000Z" } },
      { postId: b, userId: closed, denial: { why: "in-line", number: 3 } },
    ];
    const desk: FounderDesk = {
      view: async () => ({
        active: false,
        forumId: "test-forum",
        startsAt: new Date(START).toISOString(),
        pinnedThreadId: null,
        statusMessageId: null,
        line: null,
        changed: false,
        watching: false,
      }),
      seePosts: async () => [],
      pending: async () => waiting,
      told: async (ids) => {
        told.push(ids);
        waiting = waiting.filter((w) => !ids.includes(w.postId));
      },
      wroteStatus: async () => {},
    };
    await founderPass(env, desk, f);
    const dm = sent.find((s) => s.url.endsWith(`/channels/dm${open}/messages`))!;
    expect((dm.body as { content: string }).content).toBe(
      "Your Discord account needs to be 7 days old for a Founder spot. You can post again from <t:1796752800:D>.",
    );
    const inPost = sent.find((s) => s.url.endsWith(`/channels/${b}/messages`))!;
    expect((inPost.body as { content: string }).content).toBe(
      `<@${closed}> I tried to DM you, but your DMs are closed. Turn on Direct Messages for this server (right-click the server icon, Privacy Settings), then post again.`,
    );
    expect(told).toEqual([[a, b]]);
    // Told once: the next pass sends nothing.
    sent.length = 0;
    await founderPass(env, desk, f);
    expect(sent).toHaveLength(0);
  });

  it("has a line for every reason, the owner's own word for word", async () => {
    const lines = (
      [
        { why: "in-line", number: 4 },
        { why: "has-code" },
        { why: "founder" },
        { why: "dms-closed" },
        { why: "expired" },
        { why: "full", cap: 25 },
        { why: "ended" },
        { why: "no-image" },
        { why: "rejected", reason: "The screenshot isn't of a Hearth Lair." },
      ] satisfies Denial[]
    ).map(denialLine);
    expect(lines).toEqual([
      "You're already in line (#4), no need to post again!",
      "You already have a Founder code, check your DMs from me!",
      "You're already a Founder! 👑",
      "You're already in line. Your DMs were closed when I tried to send your code, so open them and the owner will send it again.",
      "Your earlier code expired. The owner can send you another while spots are left.",
      "All 25 Founder spots are gone, thank you so much for sharing your Lair! 🔥",
      "The Founder offer has ended, thank you so much for sharing your Lair! 🔥",
      "To enter, post a screenshot of your Hearth Lair in this thread and you're in line!",
      "Sorry, your Founder post wasn't approved: The screenshot isn't of a Hearth Lair.\n\nThank you so much for sharing your Lair! 🔥",
    ]);
    // The owner's rejection, sent from his page: he hears which way it went.
    const { f } = discord([], ["55"]);
    const rejected = { why: "rejected" as const, reason: "No." };
    expect(await tellDenied(env, f, { userId: "44", postId: "1", denial: rejected })).toEqual({
      via: "dm",
    });
    expect(await tellDenied(env, f, { userId: "55", postId: "1", denial: rejected })).toEqual({
      via: "thread",
    });
  });

  it("keeps answering for 7 days after the offer ends (watching), then stops looking", async () => {
    const a = idAt(START + 60_000);
    const { f, sent } = discord([{ id: a, user: OLD_USER, image: true }]);
    let watching = true;
    let asked = 0;
    const desk: FounderDesk = {
      view: async () => ({
        active: false,
        watching,
        forumId: "test-forum",
        startsAt: new Date(START).toISOString(),
        pinnedThreadId: null,
        statusMessageId: null,
        line: null,
        changed: false,
      }),
      seePosts: async (ps) => {
        asked += ps.length;
        return ps.map(() => ({ status: "denied" as const, denial: { why: "ended" as const } }));
      },
      wroteStatus: async () => {},
    };
    await founderPass(env, desk, f);
    expect(asked).toBe(1);
    // A denied post gets nothing public: her DM comes from pending().
    expect(sent.filter((s) => s.method === "POST")).toHaveLength(0);
    watching = false;
    await founderPass(env, desk, f);
    expect(asked).toBe(1);
  });

  it("announces the offer, tells the owner privately, and counts down each redemption once", async () => {
    const a = idAt(START + 60_000);
    const { f, sent } = discord([{ id: a, user: OLD_USER, image: true }]);
    let announced = 0;
    let intro = false;
    const view = {
      active: true,
      forumId: "test-forum",
      startsAt: new Date(START).toISOString(),
      pinnedThreadId: "pinned",
      statusMessageId: "s",
      line: "Founder spots claimed: 2 of 25",
      changed: false,
      testing: false,
      introPending: true,
      claimed: 2,
      announced: 0,
      cap: 25,
      waiting: 1,
    };
    const desk: FounderDesk = {
      view: async () => ({ ...view, introPending: !intro, announced }),
      seePosts: async (ps) => ps.map(() => ({ status: "counted" as const, number: 7, cap: 25 })),
      wroteStatus: async () => {},
      postedIntro: async () => {
        intro = true;
      },
      announced: async (n) => {
        announced = n;
      },
    };
    const live = { ...env, GENERAL_ID: "general", QUEUE_ID: "queue" };
    await founderPass(live, desk, f);
    const to = (ch: string) =>
      sent
        .filter((s) => s.url.endsWith(`/channels/${ch}/messages`))
        .map((s) => (s.body as { content: string }).content);
    const general = to("general");
    expect(general[0]).toContain("Founder giveaway: 25 free lifetime Founder licences!");
    expect(general[0]).toContain("<#test-forum>");
    expect(general.slice(1)).toEqual([
      "Another Founder spot claimed! 24 left.",
      "Another Founder spot claimed! 23 left.",
    ]);
    const queue = to("queue");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toContain("New Founder screenshot to check from @u");
    expect(queue[0]).toContain(`https://discord.com/channels/200/${a}`);
    expect(queue[0]).toContain("https://hearth.dragonsoath.com/codes");
    expect(announced).toBe(2);
    // The next pass says nothing again.
    sent.length = 0;
    await founderPass(live, desk, f);
    expect(to("general")).toHaveLength(0);
    // Never a code anywhere, and nothing mentions anyone in the public posts.
    expect(JSON.stringify(sent)).not.toMatch(/HRTH-/);
  });

  it("while testing, posts in #founder-test's pinned post instead of #general", async () => {
    const { f, sent } = discord([]);
    const desk: FounderDesk = {
      view: async () => ({
        active: true,
        forumId: "test-forum",
        startsAt: new Date(START).toISOString(),
        pinnedThreadId: "pinned",
        statusMessageId: "s",
        line: "x",
        changed: false,
        testing: true,
        introPending: false,
        claimed: 25,
        announced: 24,
        cap: 25,
      }),
      seePosts: async (ps) => ps.map(() => ({ status: "known" as const })),
      wroteStatus: async () => {},
      announced: async () => {},
    };
    await founderPass({ ...env, GENERAL_ID: "general" }, desk, f);
    const posts = sent.filter((s) => s.method === "POST");
    expect(posts.map((s) => s.url)).toEqual([
      "https://discord.com/api/v10/channels/pinned/messages",
    ]);
    expect((posts[0]!.body as { content: string }).content).toBe("All 25 Founder spots are gone.");
  });

  it("does nothing when no offer is running", async () => {
    const { f, sent } = discord([]);
    const desk: FounderDesk = {
      view: async () => ({
        active: false,
        forumId: null,
        startsAt: null,
        pinnedThreadId: null,
        statusMessageId: null,
        line: null,
        changed: false,
      }),
      seePosts: async (ps) => ps.map(() => ({ status: "known" as const })),
      wroteStatus: async () => {},
    };
    expect(await founderPass(env, desk, f)).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("DMs the code, or asks in the post (without the code) when DMs are closed", async () => {
    const calls: { url: string; body: { content?: string } }[] = [];
    const make = (closed: boolean) => async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
      if (url.includes("/channels/dm-1/messages"))
        return closed
          ? Response.json(
              { code: 50007, message: "Cannot send messages to this user" },
              { status: 403 },
            )
          : Response.json({ id: "m" });
      return Response.json({ id: "m" });
    };
    const code = "HRTH-ABCDE-FGHJK-MNPQR-STVWX";
    expect(await sendFounderCode(env, make(false), { userId: "42", postId: "post", code })).toEqual(
      {
        sent: true,
      },
    );
    expect(calls.find((c) => c.url.includes("dm-1"))!.body.content).toContain(code);
    calls.length = 0;
    expect(await sendFounderCode(env, make(true), { userId: "42", postId: "post", code })).toEqual({
      sent: false,
    });
    const inPost = calls.find((c) => c.url.includes("/channels/post/messages"))!;
    expect(inPost.body.content).toContain("DMs are closed");
    expect(inPost.body.content).not.toContain(code);
  });
});
