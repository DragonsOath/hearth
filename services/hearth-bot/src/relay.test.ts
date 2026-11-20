import { describe, expect, it } from "vitest";
import { handle, type Deps, type PressEvent, type Store } from "./relay";

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function setup() {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
  const installs = new Map<string, string>();
  const guilds = new Map<string, { install: string; name: string }>();
  const store: Store = {
    addInstall: async (id, h) => void installs.set(id, h),
    installSecretHash: async (id) => installs.get(id),
    linkGuild: async (g, i, name) => void guilds.set(g, { install: i, name }),
    guildsOf: async (i) =>
      [...guilds].filter(([, v]) => v.install === i).map(([id, v]) => ({ id, name: v.name })),
    installOf: async (g) => guilds.get(g)?.install,
    unlinkGuild: async (g) => void guilds.delete(g),
  };
  const delivered: PressEvent[] = [];
  let online = true;
  const discord: { method: string; url: string; body?: string }[] = [];
  let n = 0;
  const deps: Deps = {
    env: {
      APP_ID: "42",
      PUBLIC_KEY: publicKey,
      BOT_TOKEN: "bot-token",
      CLIENT_SECRET: "client-secret",
      STATE_KEY: "state-key",
      BASE_URL: "https://relay.test",
    },
    store,
    deliver: async (_i, e) => {
      if (!online) return false;
      delivered.push(e);
      return true;
    },
    random: (bytes) => (++n).toString(16).padStart(bytes * 2, "a"),
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      discord.push({
        method: init?.method ?? "GET",
        url,
        ...(typeof init?.body === "string" || init?.body instanceof URLSearchParams
          ? { body: String(init.body) }
          : {}),
      });
      if (url.endsWith("/oauth2/token"))
        return Response.json({ guild: { id: "900000001", name: "Friends" } });
      if (url.includes("/guilds/900000001/channels"))
        return Response.json([
          { id: "700000002", name: "movie-chat", type: 0, position: 2 },
          { id: "700000001", name: "general", type: 0, position: 1 },
          { id: "700000003", name: "Voice", type: 2, position: 3 },
        ]);
      if (url.endsWith("/channels/700000001"))
        return Response.json({ id: "700000001", guild_id: "900000001" });
      if (url.endsWith("/channels/700000009"))
        return Response.json({ id: "700000009", guild_id: "900000009" });
      if (url.includes("/messages")) return Response.json({ id: "m1" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  };
  const call = (method: string, path: string, init: RequestInit = {}) =>
    handle(new Request(`https://relay.test${path}`, { method, ...init }), deps);
  const sign = async (body: string) => {
    const ts = "1700000000";
    const sig = hex(
      await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(ts + body)),
    );
    return { "x-signature-ed25519": sig, "x-signature-timestamp": ts };
  };
  return {
    deps,
    call,
    sign,
    delivered,
    discord,
    guilds,
    setOnline: (v: boolean) => (online = v),
  };
}

describe("the official Hearth bot's relay", () => {
  it("registers a Hearth, links the server its owner adds the bot to, and lists its channels", async () => {
    const { call, discord, guilds } = await setup();
    const reg = (await (await call("POST", "/v1/register")).json()) as {
      installId: string;
      secret: string;
    };
    const auth = { authorization: `Bearer ${reg.installId}.${reg.secret}` };
    expect((await call("GET", "/v1/invite")).status).toBe(401);
    const invite = (await (await call("GET", "/v1/invite", { headers: auth })).json()) as {
      url: string;
    };
    const u = new URL(invite.url);
    expect(u.searchParams.get("client_id")).toBe("42");
    expect(u.searchParams.get("redirect_uri")).toBe("https://relay.test/v1/linked");
    // Discord sends the owner back with a code; the server is linked to that Hearth.
    const state = u.searchParams.get("state")!;
    const back = await call("GET", `/v1/linked?code=abc&state=${encodeURIComponent(state)}`);
    expect(await back.text()).toContain("Friends is linked");
    expect(guilds.get("900000001")?.install).toBe(reg.installId);
    expect(discord.find((x) => x.url.endsWith("/oauth2/token"))?.body).toContain(
      "client_secret=client-secret",
    );
    // A forged state links nothing.
    const forged = await call("GET", `/v1/linked?code=abc&state=${reg.installId}.9999999999.00`);
    expect(await forged.text()).toContain("expired");
    // Its text channels, in Discord's order.
    const ch = (await (await call("GET", "/v1/channels", { headers: auth })).json()) as {
      channels: { name: string }[];
    };
    expect(ch.channels.map((c) => c.name)).toEqual(["general", "movie-chat"]);
  });

  it("posts only in servers that Hearth linked", async () => {
    const { call, guilds } = await setup();
    const reg = (await (await call("POST", "/v1/register")).json()) as {
      installId: string;
      secret: string;
    };
    guilds.set("900000001", { install: reg.installId, name: "Friends" });
    const auth = { authorization: `Bearer ${reg.installId}.${reg.secret}` };
    const ok = await call("POST", "/v1/channels/700000001/messages", {
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    });
    expect(await ok.json()).toEqual({ id: "m1" });
    const other = await call("POST", "/v1/channels/700000009/messages", {
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    });
    expect(other.status).toBe(403);
    const wrong = await call("POST", "/v1/channels/700000001/messages", {
      headers: { authorization: `Bearer ${reg.installId}.${"0".repeat(64)}` },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  it("hands a button press to the owner's Hearth, says so when it is offline, and refuses unsigned calls", async () => {
    const { call, sign, delivered, guilds, setOnline } = await setup();
    guilds.set("900000001", { install: "aaaaaaaaaaaaaaa1", name: "Friends" });
    const ping = JSON.stringify({ type: 1 });
    expect(
      await (await call("POST", "/interactions", { headers: await sign(ping), body: ping })).json(),
    ).toEqual({ type: 1 });
    expect((await call("POST", "/interactions", { body: ping })).status).toBe(401);
    const press = JSON.stringify({
      type: 3,
      token: "itok",
      guild_id: "900000001",
      data: { custom_id: "mn:in:n1", component_type: 2 },
      member: { nick: "Sammy", user: { id: "5", username: "sam" } },
    });
    const r = await call("POST", "/interactions", { headers: await sign(press), body: press });
    expect(await r.json()).toEqual({ type: 5, data: { flags: 64 } });
    expect(delivered[0]).toMatchObject({ customId: "mn:in:n1", name: "Sammy", token: "itok" });
    setOnline(false);
    const off = await call("POST", "/interactions", { headers: await sign(press), body: press });
    expect(JSON.stringify(await off.json())).toContain("not connected right now");
  });
});
