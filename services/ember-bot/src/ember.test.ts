import { describe, expect, it } from "vitest";
import { announcement, emberHeadsUp, highlights } from "./announce.ts";
import {
  cheerNewPosts,
  commandReply,
  gushFor,
  handleInteraction,
  idTime,
  registerCommands,
  type Env,
} from "./ember.ts";

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = hex(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, pub };
}

const env = (over: Partial<Env> = {}): Env => ({
  APP_ID: "100",
  PUBLIC_KEY: "",
  GUILD_ID: "200",
  FORUM_ID: "300",
  BOT_TOKEN: "test-token",
  SHOWCASE_URL: "https://example.test/hearth",
  PANEL_REQUESTS_URL: "https://example.test/panels",
  ...over,
});

async function signed(pair: CryptoKeyPair, body: string): Promise<Request> {
  const ts = "1700000000";
  const sig = hex(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      new TextEncoder().encode(ts + body),
    ),
  );
  return new Request("https://ember.test/", {
    method: "POST",
    headers: { "x-signature-ed25519": sig, "x-signature-timestamp": ts },
    body,
  });
}

/** A Discord id made at a given time. */
const idAt = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n);

describe("interactions", () => {
  it("refuses a request that Discord did not sign", async () => {
    const { pub } = await keys();
    const req = new Request("https://ember.test/", {
      method: "POST",
      headers: { "x-signature-ed25519": "00", "x-signature-timestamp": "1" },
      body: '{"type":1}',
    });
    expect((await handleInteraction(req, env({ PUBLIC_KEY: pub }))).status).toBe(401);
  });

  it("answers Discord's ping and a slash command when signed", async () => {
    const { pair, pub } = await keys();
    const ping = await handleInteraction(
      await signed(pair, '{"type":1}'),
      env({ PUBLIC_KEY: pub }),
    );
    expect(await ping.json()).toEqual({ type: 1 });
    const cmd = await handleInteraction(
      await signed(pair, '{"type":2,"data":{"name":"install"}}'),
      env({ PUBLIC_KEY: pub }),
    );
    const out = (await cmd.json()) as { type: number; data: { content: string } };
    expect(out.type).toBe(4);
    expect(out.data.content).toContain("https://example.test/hearth");
  });

  it("has a friendly answer for every command and an unknown one", () => {
    for (const name of ["install", "help", "request-panel", "about", "nope"])
      expect(commandReply(name, env()).length).toBeGreaterThan(20);
    expect(commandReply("request-panel", env())).toContain("https://example.test/panels");
    // How requests work, once its page is public (11-10); nothing about it before.
    expect(commandReply("request-panel", env())).not.toContain("How requests");
    expect(
      commandReply("request-panel", env({ HOW_REQUESTS_URL: "https://example.test/how" })),
    ).toContain("https://example.test/how");
  });

  it("registers the commands on the Hearth server only", async () => {
    let url = "";
    let method = "";
    await registerCommands(env(), async (u, init) => {
      url = u;
      method = init?.method ?? "";
      return new Response("[]");
    });
    expect(url).toBe("https://discord.com/api/v10/applications/100/guilds/200/commands");
    expect(method).toBe("PUT");
  });
});

describe("cheering on posts", () => {
  it("picks the reply for the post's tag and names the poster", () => {
    expect(gushFor(["Hidden Gem"], "42", () => 0)).toContain("Hidden gem alert");
    expect(gushFor(["My Setup"], "42", () => 1)).toContain("<@42>");
    expect(gushFor(["Unknown tag"], "42", () => 0)).toContain("satchel");
  });

  it("reads when an id was made", () => {
    expect(idTime(idAt(1_800_000_000_000))).toBe(1_800_000_000_000);
  });

  it("answers each new post once, with a fire reaction, and skips old or answered ones", async () => {
    const now = 1_800_000_000_000;
    const fresh = idAt(now - 60_000);
    const answered = idAt(now - 120_000);
    const old = idAt(now - 3 * 86_400_000);
    const calls: { url: string; method: string; body?: string }[] = [];
    const fake = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (url.endsWith("/guilds/200/threads/active"))
        return Response.json({
          threads: [
            { id: fresh, parent_id: "300", owner_id: "7", applied_tags: ["t1"] },
            { id: answered, parent_id: "300", owner_id: "8" },
            { id: old, parent_id: "300", owner_id: "9" },
            { id: idAt(now), parent_id: "999", owner_id: "9" },
          ],
        });
      if (url.endsWith("/channels/300"))
        return Response.json({ available_tags: [{ id: "t1", name: "Wall Screen" }] });
      if (url.includes(`/channels/${answered}/messages?`))
        return Response.json([{ author: { id: "100" } }]);
      if (url.includes("/messages?")) return Response.json([{ author: { id: "7" } }]);
      return new Response("{}");
    };
    expect(await cheerNewPosts(env(), fake, now, () => 0)).toBe(1);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toContain(`/channels/${fresh}/messages`);
    expect(posts[0]!.body).toContain("wall screen");
    expect(calls.some((c) => c.method === "PUT" && c.url.includes(`${fresh}/reactions/`))).toBe(
      true,
    );
  });

  it("does nothing when Discord can't be reached", async () => {
    expect(await cheerNewPosts(env(), async () => new Response("", { status: 500 }), 0)).toBe(0);
  });
});

describe("release announcements", () => {
  const notes = [
    "## Highlights",
    "- **Home Rows** for Jellyfin",
    "- Download Health",
    "- Switch AIs mid-conversation.",
    "- A fourth thing",
    "## Fixes",
    "- Something small",
  ].join("\n");

  it("takes the top three highlights as plain text", () => {
    expect(highlights(notes)).toEqual([
      "Home Rows for Jellyfin",
      "Download Health",
      "Switch AIs mid-conversation",
    ]);
    expect(highlights("No list here")).toEqual([]);
  });

  it("writes Ember's heads-up with a link to the announcements channel", () => {
    const msg = emberHeadsUp("0.9.0", notes, "555", () => 0);
    expect(msg).toBe(
      "Special delivery! 🔥 Hearth 0.9.0 just landed, with Home Rows for Jellyfin, Download Health and Switch AIs mid-conversation. The full letter's waiting in <#555>!",
    );
    expect(emberHeadsUp("0.9.0", "", undefined, () => 1)).toContain("#announcements");
  });

  it("keeps the full announcement inside Discord's limit", () => {
    const long = announcement("1.0.0", "Big one", "x".repeat(5000));
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(long.startsWith("## 🔥 Hearth 1.0.0: Big one")).toBe(true);
  });
});
