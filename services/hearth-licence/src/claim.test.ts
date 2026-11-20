import { describe, expect, it } from "vitest";
import { newSigningKey } from "../../../apps/server/src/premium/license";
import { earned } from "./claim";
import { handle, memoryStore } from "./licence";

// The sponsor claim page (11-19): GitHub sign-in, the person's own sponsorships of Dragon's Oath,
// and a one-use code shown once. Founder once per account; Supporter once a month.

const service = newSigningKey();
const env = {
  SIGNING_KEY: service.privatePem,
  OWNER_KEY: "",
  GITHUB_CLIENT_ID: "client-test",
  GITHUB_CLIENT_SECRET: "secret-test",
  OWNER_GITHUB_ID: "295516420",
  SESSION_KEY: "session-key-for-tests-only",
};
const BASE = "https://licence.test";
let now = Date.parse("2026-11-20T12:00:00Z");
const clock = () => now;

const ORG = { login: "DragonsOath" };
type S = Parameters<typeof earned>[0];
const people: Record<string, { id: number; login: string; s: S }> = {
  founder: {
    id: 1001,
    login: "founder-fan",
    s: [
      {
        isOneTimePayment: true,
        sponsorable: ORG,
        tier: { monthlyPriceInDollars: 60, isOneTime: true },
      },
    ],
  },
  supporter: {
    id: 1002,
    login: "monthly-fan",
    s: [
      {
        isActive: true,
        isOneTimePayment: false,
        sponsorable: ORG,
        tier: { monthlyPriceInDollars: 5 },
      },
    ],
  },
  other: {
    id: 1003,
    login: "someone",
    s: [
      {
        isActive: true,
        sponsorable: { login: "another-project" },
        tier: { monthlyPriceInDollars: 50 },
      },
    ],
  },
};
const asked: string[] = [];
const github = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = String(input);
  if (u.endsWith("/login/oauth/access_token")) {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return Response.json({ access_token: `tok-${code}` });
  }
  if (u === "https://api.github.com/graphql") {
    const who = new Headers(init?.headers).get("authorization")!.replace("Bearer tok-", "");
    asked.push(who);
    const p = people[who]!;
    return Response.json({
      data: { viewer: { databaseId: p.id, login: p.login, sponsorshipsAsSponsor: { nodes: p.s } } },
    });
  }
  return new Response("no", { status: 404 });
}) as typeof fetch;

async function claimAs(
  store: ReturnType<typeof memoryStore>,
  who: string,
  extras: Parameters<typeof handle>[5] = {},
) {
  const login = await handle(new Request(`${BASE}/codes/claim/login`), env, store, clock, github);
  expect(login.status).toBe(302);
  const to = new URL(login.headers.get("location")!);
  expect(to.searchParams.get("scope")).toBe("read:user");
  expect(to.searchParams.get("redirect_uri")).toBe(`${BASE}/codes/callback`);
  const state = to.searchParams.get("state")!;
  const res = await handle(
    new Request(`${BASE}/codes/callback?code=${who}&state=${state}`, {
      headers: { cookie: login.headers.get("set-cookie")!.split(";")[0]! },
    }),
    env,
    store,
    clock,
    github,
    extras,
  );
  return { status: res.status, html: await res.text() };
}
const codeIn = (html: string) =>
  /HRTH-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}/.exec(html)?.[0];

describe("sponsor claim page", () => {
  it("is open to anyone, with a GitHub sign-in", async () => {
    const res = await handle(new Request(`${BASE}/codes/claim`), env, memoryStore(), clock, github);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/codes/claim/login");
  });

  it("decides Founder and Supporter from sponsorships of Dragon's Oath only", () => {
    expect(earned(people.founder!.s, 60)).toBe("founder");
    expect(earned(people.founder!.s, 99)).toBeNull();
    expect(earned(people.supporter!.s, 60)).toBe("supporter");
    expect(earned(people.other!.s, 60)).toBeNull();
    expect(
      earned([{ isActive: false, sponsorable: ORG, tier: { monthlyPriceInDollars: 5 } }], 60),
    ).toBeNull();
  });

  it("gives a Founder one code, once, noted with the GitHub account, redeemable", async () => {
    const store = memoryStore();
    const first = await claimAs(store, "founder");
    expect(first.status).toBe(200);
    const code = codeIn(first.html)!;
    expect(code).toBeTruthy();
    expect(first.html).toContain("Founder");
    const made = [...store.all.codes.values()];
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ campaignId: "sponsor-founder", days: null, maxUses: 1 });
    expect(made[0]!.note).toBe("GitHub @founder-fan (id 1001)");
    // Again: no second code, the first one's letters to recognise it.
    const again = await claimAs(store, "founder");
    expect(codeIn(again.html)).toBeUndefined();
    expect(again.html).toContain(`HRTH-${code.slice(5, 10)}`);
    expect(store.all.codes.size).toBe(1);
  });

  it("shows Premium Ember only with a code, never before", async () => {
    const pic = { type: "image/webp", data: new Uint8Array([82, 73, 70, 70]).buffer };
    const premiumEmber = async () => pic;
    const start = await handle(
      new Request(`${BASE}/codes/claim`),
      env,
      memoryStore(),
      clock,
      github,
      {
        premiumEmber,
      },
    );
    expect(await start.text()).not.toContain("<img");
    const none = await claimAs(memoryStore(), "other", { premiumEmber });
    expect(none.html).not.toContain("data:image");
    const got = await claimAs(memoryStore(), "founder", { premiumEmber });
    expect(got.html).toContain('class="premium-ember" src="data:image/webp;base64,UklGRg=="');
  });

  it("gives a Supporter a month, and the next one 28 days later", async () => {
    const store = memoryStore();
    const first = await claimAs(store, "supporter");
    expect(codeIn(first.html)).toBeTruthy();
    expect([...store.all.codes.values()][0]).toMatchObject({
      campaignId: "sponsor-supporter",
      days: 30,
    });
    now += 10 * 86_400_000;
    const early = await claimAs(store, "supporter");
    expect(codeIn(early.html)).toBeUndefined();
    expect(early.html).toContain("2026-12-18");
    now += 19 * 86_400_000;
    const next = await claimAs(store, "supporter");
    expect(codeIn(next.html)).toBeTruthy();
    expect(store.all.codes.size).toBe(2);
  });

  it("gives nothing without a sponsorship, or with a forged sign-in", async () => {
    const store = memoryStore();
    const none = await claimAs(store, "other");
    expect(none.html).toContain("no sponsorship of Dragon");
    expect(store.all.codes.size).toBe(0);
    const forged = await handle(
      new Request(`${BASE}/codes/callback?code=founder&state=c.abc`, {
        headers: { cookie: "__Host-hearth-claim=c.xyz" },
      }),
      env,
      store,
      clock,
      github,
    );
    expect(forged.status).toBe(400);
    expect(store.all.codes.size).toBe(0);
  });

  it("stops when the owner switches the campaign off", async () => {
    const store = memoryStore();
    await claimAs(store, "founder");
    const c = await store.campaign("sponsor-founder");
    await store.putCampaign({ ...c!, active: false });
    const res = await claimAs(store, "supporter");
    expect(codeIn(res.html)).toBeTruthy();
    const sc = await store.campaign("sponsor-supporter");
    await store.putCampaign({ ...sc!, active: false });
    now += 40 * 86_400_000;
    const paused = await claimAs(store, "supporter");
    expect(paused.status).toBe(503);
  });
});
