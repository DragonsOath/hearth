import { describe, expect, it } from "vitest";
import { PREMIUM_FEATURES } from "../../../packages/core/src/premium";
import { newSigningKey, readLicense } from "../../../apps/server/src/premium/license";
import { handle, memoryStore, servicePublicKey } from "./licence";

const service = newSigningKey();
const OWNER_ID = "295516420";
const env = {
  SIGNING_KEY: service.privatePem,
  OWNER_KEY: "",
  GITHUB_CLIENT_ID: "client-test",
  GITHUB_CLIENT_SECRET: "secret-test",
  OWNER_GITHUB_ID: OWNER_ID,
  SESSION_KEY: "session-key-for-tests-only",
};
const BASE = "https://licence.test";
const INSTALL = "a1b2c3d4-0000-4000-8000-000000000001";
let now = Date.parse("2026-11-17T12:00:00Z");
const clock = () => now;

/** GitHub, faked: the code "owner" signs in as the owner, anything else as someone else. */
const github = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input);
  if (u.endsWith("/login/oauth/access_token")) {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return Response.json({ access_token: `tok-${code}` });
  }
  if (u === "https://api.github.com/user") {
    const auth = new Headers(init?.headers).get("authorization");
    return Response.json({ id: auth === "Bearer tok-owner" ? Number(OWNER_ID) : 12345 });
  }
  return new Response("no", { status: 404 });
}) as typeof fetch;

const call = (store: ReturnType<typeof memoryStore>, req: Request) =>
  handle(req, env, store, clock, github);

/** Signs in through the GitHub round trip; returns the cookie header to send after. */
async function signIn(store: ReturnType<typeof memoryStore>, who = "owner") {
  const login = await call(store, new Request(`${BASE}/codes/login`));
  expect(login.status).toBe(302);
  const to = new URL(login.headers.get("location")!);
  expect(to.origin).toBe("https://github.com");
  const state = to.searchParams.get("state")!;
  const stateCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const back = await call(
    store,
    new Request(`${BASE}/codes/callback?code=${who}&state=${state}`, {
      headers: { cookie: stateCookie },
    }),
  );
  return { back, cookie: (back.headers.get("set-cookie") ?? "").split(";")[0]! };
}

const api = (cookie: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  new Request(`${BASE}/codes/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie, "content-type": "application/json", "x-hearth-owner": "1", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("the owner's code site", () => {
  it("lets only the owner's GitHub account in", async () => {
    const store = memoryStore();
    // A stranger sees only the sign-in button, and the tools answer 401.
    const page = await call(store, new Request(`${BASE}/codes`));
    expect(await page.text()).toContain("Sign in with GitHub");
    expect((await call(store, api("", "state"))).status).toBe(401);
    // Someone else's GitHub account is turned away, with no cookie.
    const other = await signIn(store, "someone");
    expect(other.back.status).toBe(403);
    expect(other.cookie).not.toContain("hearth-owner=");
    // A forged cookie doesn't work either.
    const forged = `__Host-hearth-owner=${OWNER_ID}.${now + 3_600_000}.forged`;
    expect((await call(store, api(forged, "state"))).status).toBe(401);
    // The owner gets in.
    const me = await signIn(store);
    expect(me.back.status).toBe(302);
    expect((await call(store, api(me.cookie, "state"))).status).toBe(200);
    // A sign-in without its own state is refused.
    const noState = await call(store, new Request(`${BASE}/codes/callback?code=owner&state=x`));
    expect(noState.status).toBe(400);
  });

  it("refuses changes that don't come from the page", async () => {
    const store = memoryStore();
    const { cookie } = await signIn(store);
    const noHeader = new Request(`${BASE}/codes/api/campaign`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "x", months: null }),
    });
    expect((await call(store, noHeader)).status).toBe(403);
    const elsewhere = api(cookie, "campaign", { name: "x" }, { origin: "https://evil.test" });
    expect((await call(store, elsewhere)).status).toBe(403);
  });

  it("gives Founder codes from a campaign, up to its cap, and each redeems once into Premium for good", async () => {
    const store = memoryStore();
    const { cookie } = await signIn(store);
    const camp = (await (
      await call(store, api(cookie, "campaign", { name: "Around the Fire", months: null, cap: 2 }))
    ).json()) as { id: string };
    const give = async (note: string) =>
      call(store, api(cookie, "give", { campaignId: camp.id, note }));
    const first = (await (await give("ashfox")).json()) as { code: string; message: string };
    expect(first.code).toMatch(/^HRTH-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(first.message).toContain(first.code);
    expect(first.message).toContain("Founder");
    expect((await give("emberlynn")).status).toBe(200);
    // The cap: two given, the third is refused.
    const third = await give("late");
    expect(third.status).toBe(409);
    expect(await third.text()).toContain("all 2");

    // Someone's Hearth redeems it: Premium for good, every feature, marked as a gift.
    const r = await call(
      store,
      new Request(`${BASE}/v1/redeem`, {
        method: "POST",
        body: JSON.stringify({ code: first.code, install: INSTALL }),
      }),
    );
    expect(r.status).toBe(200);
    const { licence, gifted } = (await r.json()) as { licence: string; gifted: boolean };
    expect(gifted).toBe(true);
    const p = readLicense(licence, { [service.keyId]: await servicePublicKey(service.privatePem) });
    expect(p.features).toEqual([...PREMIUM_FEATURES]);
    expect(p.end).toBeUndefined();
    expect(p.label).toBe("Founder");
    // The same code on another Hearth: used up.
    const again = await call(
      store,
      new Request(`${BASE}/v1/redeem`, {
        method: "POST",
        body: JSON.stringify({ code: first.code, install: "a1b2c3d4-0000-4000-8000-000000000002" }),
      }),
    );
    expect(again.status).toBe(409);

    // The list shows who has which code and what happened.
    const state = (await (await call(store, api(cookie, "state"))).json()) as {
      campaigns: { given: number; redeemed: number }[];
      codes: { note: string; status: string; hint: string; id: string }[];
    };
    expect(state.campaigns[0]).toMatchObject({ given: 2, redeemed: 1 });
    const ash = state.codes.find((c) => c.note === "ashfox")!;
    expect(ash.status).toBe("redeemed");
    expect(ash.hint).toBe(first.code.slice(5, 10));
    expect(JSON.stringify(state)).not.toContain(first.code);
    expect(state.codes.find((c) => c.note === "emberlynn")!.status).toBe("waiting");

    // Taking Premium back puts the licence on the list every Hearth checks.
    await call(store, api(cookie, "take-back", { id: ash.id }));
    const revoked = (await (await call(store, new Request(`${BASE}/v1/revoked`))).json()) as {
      revoked: string[];
    };
    expect(revoked.revoked).toHaveLength(1);
    const after = (await (await call(store, api(cookie, "state"))).json()) as {
      codes: { note: string; status: string }[];
    };
    expect(after.codes.find((c) => c.note === "ashfox")!.status).toBe("taken back");
  });

  it("gives month codes that end, and a switched-off code or campaign gives nothing", async () => {
    const store = memoryStore();
    const { cookie } = await signIn(store);
    const camp = (await (
      await call(store, api(cookie, "campaign", { name: "Reviewers", months: 3 }))
    ).json()) as { id: string };
    const g = (await (
      await call(store, api(cookie, "give", { campaignId: camp.id, note: "reviewer" }))
    ).json()) as { code: string; id: string };
    await call(store, api(cookie, "code-active", { id: g.id, active: false }));
    const off = await call(
      store,
      new Request(`${BASE}/v1/redeem`, {
        method: "POST",
        body: JSON.stringify({ code: g.code, install: INSTALL }),
      }),
    );
    expect(off.status).toBe(409);
    await call(store, api(cookie, "code-active", { id: g.id, active: true }));
    const on = await call(
      store,
      new Request(`${BASE}/v1/redeem`, {
        method: "POST",
        body: JSON.stringify({ code: g.code, install: INSTALL }),
      }),
    );
    const p = readLicense(((await on.json()) as { licence: string }).licence, {
      [service.keyId]: await servicePublicKey(service.privatePem),
    });
    expect(Math.round((Date.parse(p.end!) - Date.parse(p.start)) / 86_400_000)).toBe(91);
    await call(store, api(cookie, "campaign-active", { id: camp.id, active: false }));
    expect((await call(store, api(cookie, "give", { campaignId: camp.id }))).status).toBe(409);
  });

  it("makes a licence key for one of the owner's own Hearths, for good", async () => {
    const store = memoryStore();
    const { cookie } = await signIn(store);
    const res = await call(
      store,
      api(cookie, "licence", { install: INSTALL, label: "Home server" }),
    );
    const { licence } = (await res.json()) as { licence: string };
    const p = readLicense(licence, { [service.keyId]: await servicePublicKey(service.privatePem) });
    expect(p).toMatchObject({ install: INSTALL, label: "Home server" });
    expect(p.end).toBeUndefined();
    expect(p.features).toEqual([...PREMIUM_FEATURES]);
    const bad = await call(store, api(cookie, "licence", { install: "nope" }));
    expect(bad.status).toBe(400);
  });

  it("stays shut until its GitHub sign-in is set up", async () => {
    const store = memoryStore();
    const res = await handle(
      new Request(`${BASE}/codes`),
      { SIGNING_KEY: service.privatePem, OWNER_KEY: "" },
      store,
      clock,
      github,
    );
    expect(await res.text()).toContain("isn't set up yet");
    now += 0;
  });
});
