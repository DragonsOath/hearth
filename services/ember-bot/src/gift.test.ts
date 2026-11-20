import { describe, expect, it } from "vitest";
import type { Env } from "./ember.ts";
import { sendFounderCode } from "./founder.ts";
import { giftDm, sendCode, type Picture } from "./gift.ts";

const env: Env = {
  APP_ID: "100",
  PUBLIC_KEY: "",
  GUILD_ID: "200",
  FORUM_ID: "300",
  BOT_TOKEN: "test-token",
  SHOWCASE_URL: "https://example.test/hearth",
  PANEL_REQUESTS_URL: "https://example.test/panels",
};
const PIC: Picture = { type: "image/webp", data: new Uint8Array([1, 2, 3]).buffer };
const member = (
  id: string,
  username: string,
  global_name: string | null,
  nick: string | null = null,
) => ({
  user: { id, username, global_name },
  nick,
});

/** Discord, faked: a server's members, DMs open or closed, and what Ember sent. */
function discord(members: ReturnType<typeof member>[], dmsOpen = true) {
  const sent: { url: string; body: BodyInit | null | undefined; type: string | null }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/members/search")) {
      const q = new URL(url).searchParams.get("query")!.toLowerCase();
      return Response.json(
        members.filter((m) =>
          [m.user.username, m.user.global_name, m.nick].some((n) =>
            (n ?? "").toLowerCase().startsWith(q),
          ),
        ),
      );
    }
    const one = /members\/(\d+)$/.exec(url);
    if (one) {
      const m = members.find((x) => x.user.id === one[1]);
      return m ? Response.json(m) : new Response(null, { status: 404 });
    }
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: "dm-1" });
    if (method === "POST" && url.endsWith("/channels/dm-1/messages")) {
      sent.push({ url, body: init?.body, type: new Headers(init?.headers).get("content-type") });
      return dmsOpen ? Response.json({ id: "m" }) : Response.json({ code: 50007 }, { status: 403 });
    }
    if (method === "POST") {
      sent.push({ url, body: init?.body, type: "application/json" });
      return Response.json({ id: "p" });
    }
    return new Response(null, { status: 404 });
  };
  return { f, sent };
}

const SAM = "123456789012345678";

describe("Send with Ember", () => {
  it("finds the person by username, display name or nickname, and DMs Premium Ember with the code", async () => {
    const { f, sent } = discord([
      member(SAM, "sam_k", "Sam"),
      member("223456789012345678", "samwise", null),
    ]);
    const r = await sendCode(env, f, {
      to: "@Sam",
      code: "HRTH-AAAAA-BBBBB-CCCCC-DDDDD",
      months: 3,
      picture: PIC,
    });
    expect(r).toEqual({ status: "sent", name: "Sam" });
    expect(sent).toHaveLength(1);
    const form = sent[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const payload = JSON.parse(String(form.get("payload_json"))) as {
      content: string;
      attachments: unknown[];
    };
    expect(payload.content).toContain("HRTH-AAAAA-BBBBB-CCCCC-DDDDD");
    expect(payload.content).toContain("for 3 months");
    expect(payload.content).toContain("Settings, Premium");
    expect(payload.attachments).toEqual([{ id: 0, filename: "premium-ember.webp" }]);
    const file = form.get("files[0]") as File;
    expect(file.name).toBe("premium-ember.webp");
    expect(file.type).toBe("image/webp");
    // By id too.
    expect(
      (
        await sendCode(env, discord([member(SAM, "sam_k", "Sam")]).f, {
          to: SAM,
          code: "X",
          months: null,
        })
      ).status,
    ).toBe("sent");
  });

  it("never guesses: nobody, several people, or closed DMs all come back unsent", async () => {
    const two = [member(SAM, "sam1", "Sam"), member("223456789012345678", "sam2", "Sam")];
    expect(await sendCode(env, discord([]).f, { to: "ghost", code: "X", months: null })).toEqual({
      status: "not-found",
    });
    const amb = await sendCode(env, discord(two).f, { to: "sam", code: "X", months: null });
    expect(amb).toEqual({ status: "ambiguous", names: ["Sam (@sam1)", "Sam (@sam2)"] });
    // A partial name with one match is still a question, not a send.
    const { f, sent } = discord([member(SAM, "samantha", null)]);
    expect((await sendCode(env, f, { to: "sam", code: "X", months: null })).status).toBe(
      "ambiguous",
    );
    expect(sent).toHaveLength(0);
    const closed = await sendCode(env, discord([member(SAM, "sam", null)], false).f, {
      to: "sam",
      code: "X",
      months: null,
    });
    expect(closed).toEqual({ status: "dm-closed", name: "sam" });
  });

  it("says Premium for good when there are no months, and keeps her secret in the words", () => {
    const t = giftDm("HRTH-1", null);
    expect(t).toContain("Hearth Premium, for good!");
    expect(t).toContain("secret Premium me");
    expect(giftDm("HRTH-1", 1)).toContain("for 1 month!");
  });

  it("sends a Founder approval with Premium Ember too", async () => {
    const { f, sent } = discord([]);
    expect(
      await sendFounderCode(env, f, { userId: SAM, postId: "post", code: "HRTH-F", picture: PIC }),
    ).toEqual({ sent: true });
    expect(sent[0]!.body).toBeInstanceOf(FormData);
  });
});
