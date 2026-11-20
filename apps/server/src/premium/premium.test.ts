import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { licenceCovers } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { Entitlements, PremiumRequiredError, stateOf } from "./entitlements";
import { newCode, normalizeCode } from "./issuer";
import {
  LicenseError,
  newSigningKey,
  readLicense,
  signLicense,
  type LicensePayload,
} from "./license";

// Hearth Premium (11-05): licences are signed and checked offline; only the two premium features
// exist; expiry, revocation and a clock set back behave predictably.

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
async function db() {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  return handle;
}

const key = newSigningKey();
const trusted = { [key.keyId]: key.publicKey };
const INSTALL = "11111111-2222-4333-8444-555555555555";
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();

const licence = (over: Partial<Omit<LicensePayload, "v" | "key">> = {}, pem = key.privatePem) =>
  signLicense(
    {
      id: "lic-1",
      install: INSTALL,
      features: ["ember_show_and_tell"],
      kind: "complimentary",
      start: at(Date.parse("2026-11-01T00:00:00Z")),
      issued: at(Date.parse("2026-11-01T00:00:00Z")),
      ...over,
    },
    pem,
  );

describe("Hearth licences", () => {
  it("still read when they name Hearth Transfer, which was removed (11-11): that entry is dropped", () => {
    const token = licence({
      features: ["hearth_interconnectivity", "ember_show_and_tell", "hearth_transfer" as never],
    });
    expect(readLicense(token, trusted).features).toEqual([
      "hearth_interconnectivity",
      "ember_show_and_tell",
    ]);
  });

  it("are checked by signature, against trusted keys only, and can't be edited", () => {
    const token = licence({ label: "Alex's Hearth" });
    expect(readLicense(token, trusted)).toMatchObject({ id: "lic-1", label: "Alex's Hearth" });
    // Someone else's key: not trusted.
    const other = newSigningKey();
    expect(() => readLicense(licence({}, other.privatePem), trusted)).toThrow(
      /key this Hearth trusts/,
    );
    // One field changed (more features), the old signature kept.
    const [p, body, sig] = token.split(".");
    const edited = JSON.parse(Buffer.from(body!, "base64url").toString());
    edited.features = ["ember_show_and_tell", "hearth_interconnectivity"];
    const forged = `${p}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${sig}`;
    expect(() => readLicense(forged, trusted)).toThrow(/signature/);
    expect(() => readLicense("not a licence", trusted)).toThrow(LicenseError);
    // A feature that doesn't exist is refused (no invented paid features).
    expect(() => readLicense(licence({ features: ["everything" as never] }), trusted)).toThrow(
      /understands/,
    );
  });

  it("are active, scheduled, expired, revoked, or waiting when the clock was set back", () => {
    const p = readLicense(licence({ end: at(Date.parse("2026-12-01T00:00:00Z")) }), trusted);
    const nov = Date.parse("2026-11-15T00:00:00Z");
    expect(stateOf(p, nov, new Set())).toBe("active");
    expect(stateOf(p, Date.parse("2026-10-15T00:00:00Z"), new Set())).toBe("scheduled");
    expect(stateOf(p, Date.parse("2026-12-02T00:00:00Z"), new Set())).toBe("expired");
    expect(stateOf(p, nov, new Set(["lic-1"]))).toBe("revoked");
    // Hearth saw December; the clock now says November: a dated licence can't be trusted.
    expect(stateOf(p, nov, new Set(), at(Date.parse("2026-12-20T00:00:00Z")))).toBe("pending");
    // A lifetime licence doesn't depend on the clock.
    const life = readLicense(licence(), trusted);
    expect(stateOf(life, nov, new Set(), at(Date.parse("2026-12-20T00:00:00Z")))).toBe("active");
  });

  it("promo codes are long, random and forgiving to type", () => {
    const c = newCode();
    expect(c).toMatch(/^HRTH-[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    expect(new Set(Array.from({ length: 200 }, newCode)).size).toBe(200);
    expect(normalizeCode(c.toLowerCase().replace(/-/g, " "))).toBe(normalizeCode(c));
    expect(normalizeCode("hrth-0o1il-xxxxx-xxxxx-xxxxx")).toBe(
      normalizeCode("HRTH-00111-XXXXX-XXXXX-XXXXX"),
    );
  });
});

describe("this installation's entitlements", () => {
  it("before launch, every premium feature is open and the page is told so", async () => {
    const e = new Entitlements(
      await db(),
      async () => INSTALL,
      async () => ({}),
      async () => [],
      Date.now,
      () => false,
    );
    expect(await e.has("ember_show_and_tell")).toBe(true);
    expect(await e.has("hearth_interconnectivity")).toBe(true);
    await expect(e.require("ember_show_and_tell", "Show & Tell")).resolves.toBeUndefined();
    const st = await e.status(false, false);
    expect(st.open).toBe(true);
    expect(st.features.every((f) => f.state === "active")).toBe(true);
  });

  const make = async (now: () => number, revoked: string[] = []) => {
    const h = await db();
    return new Entitlements(
      h,
      async () => INSTALL,
      async () => trusted,
      async () => revoked,
      now,
    );
  };

  it("hands a service the licence that gives a feature now, the longest-lasting one, never an ended one", async () => {
    let now = Date.parse("2026-11-10T00:00:00Z");
    const e = await make(() => now);
    expect(await e.tokenFor("panel_builder")).toBeUndefined();
    const other = licence({ id: "lic-show" });
    const short = licence({
      id: "lic-short",
      features: ["panel_builder"],
      end: at(Date.parse("2026-11-20T00:00:00Z")),
    });
    const forGood = licence({ id: "lic-good", features: ["panel_builder", "ember_show_and_tell"] });
    await e.install(other);
    expect(await e.tokenFor("panel_builder")).toBeUndefined();
    await e.install(short);
    expect(await e.tokenFor("panel_builder")).toBe(short);
    await e.install(forGood);
    expect(await e.tokenFor("panel_builder")).toBe(forGood);
    await e.markRevoked(["lic-good"]);
    expect(await e.tokenFor("panel_builder")).toBe(short);
    now = Date.parse("2026-11-21T00:00:00Z");
    expect(await e.tokenFor("panel_builder")).toBeUndefined();
  });

  it("unlock exactly the licensed feature, and refuse the other plainly", async () => {
    let now = Date.parse("2026-11-10T00:00:00Z");
    const e = await make(() => now);
    expect(await e.has("ember_show_and_tell")).toBe(false);
    await e.install(licence({ end: at(Date.parse("2026-11-20T00:00:00Z")) }));
    expect(await e.has("ember_show_and_tell")).toBe(true);
    expect(await e.has("hearth_interconnectivity")).toBe(false);
    await expect(e.require("hearth_interconnectivity", "Linking a PC")).rejects.toThrow(
      PremiumRequiredError,
    );
    await expect(e.require("hearth_interconnectivity", "Linking a PC")).rejects.toThrow(
      /Everything you already set up is kept/,
    );
    const st = await e.status(false, false);
    expect(st.features.find((f) => f.feature === "ember_show_and_tell")).toMatchObject({
      state: "active",
      kind: "complimentary",
    });
    // It ends: refused again, the licence still listed (nothing deleted).
    now = Date.parse("2026-11-21T00:00:00Z");
    expect(await e.has("ember_show_and_tell")).toBe(false);
    expect((await e.status(false, false)).licenses[0]).toMatchObject({ state: "expired" });
  });

  it("refuse a licence for another installation, and follow revocation and reinstatement", async () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    const e = await make(() => now);
    await expect(e.install(licence({ install: "someone-else" }))).rejects.toThrow(
      /different Hearth installation/,
    );
    await e.install(licence());
    await e.markRevoked(["lic-1"]);
    expect(await e.has("ember_show_and_tell")).toBe(false);
    await e.unrevoke("lic-1");
    expect(await e.has("ember_show_and_tell")).toBe(true);
    // The issuer on this Hearth took it back: counts at once.
    const issuerSaid = await make(() => now, ["lic-1"]);
    await issuerSaid.install(licence());
    expect(await issuerSaid.has("ember_show_and_tell")).toBe(false);
  });

  it("works offline, and doesn't let a clock set back stretch a dated licence", async () => {
    let now = Date.parse("2026-11-10T00:00:00Z");
    const e = await make(() => now);
    await e.install(licence({ end: at(Date.parse("2026-11-12T00:00:00Z")) }));
    // Hearth sees the 13th (expired), then the clock is put back to the 11th.
    now = Date.parse("2026-11-13T00:00:00Z");
    expect(await e.has("ember_show_and_tell")).toBe(false);
    now = Date.parse("2026-11-11T00:00:00Z");
    expect((await e.status(false, false)).features[1]).toMatchObject({ state: "pending" });
    expect(await e.has("ember_show_and_tell")).toBe(false);
    // Installing the same licence again replaces it, not a second copy.
    await e.install(licence({ end: at(Date.parse("2026-11-12T00:00:00Z")) }));
    expect((await e.state()).licenses).toHaveLength(1);
    void DAY;
  });
});

describe("the owner's grants and promo codes", () => {
  /** A vault stand-in holding the signing key (protected: needs the owner's unlocked session). */
  const fakeVault = () => {
    const secrets = new Map<string, string>();
    return {
      exists: async (id: string) => secrets.has(id),
      add: async (s: { value: string }) => {
        const id = `s${secrets.size + 1}`;
        secrets.set(id, s.value);
        return { id };
      },
      use: async (id: string, _purpose: string, o: { unlockedSession?: unknown }) => {
        if (!o.unlockedSession) throw new Error("protected: unlock the vault");
        return secrets.get(id)!;
      },
    };
  };
  const session = { id: "owner" } as never;
  const setup = async (now = () => Date.now()) => {
    const h = await db();
    const trust: Record<string, string> = {};
    const installed: string[] = [];
    const { Issuer } = await import("./issuer");
    const issuer = new Issuer(
      h,
      fakeVault() as never,
      async () => INSTALL,
      async () => trust,
      async (t) => installed.push(t),
      now,
    );
    return { h, issuer, trust, installed };
  };

  it("issue nothing until the signing key is one Hearth trusts", async () => {
    const { issuer, trust } = await setup();
    expect(await issuer.active()).toBe(false);
    const k = await issuer.setUp();
    // Made, but no release trusts it yet: still can't issue.
    expect(await issuer.active()).toBe(false);
    await expect(
      issuer.grant(session, {
        recipient: "Me",
        audience: "self",
        scope: ["premium_all"],
        installId: INSTALL,
      }),
    ).rejects.toThrow(/no trusted signing key/);
    trust[k.keyId] = k.publicKey;
    expect(await issuer.active()).toBe(true);
    await expect(issuer.setUp()).rejects.toThrow(/already has a signing key/);
  });

  it("grant directly ($0, no card), for this installation at once or as a key to send", async () => {
    const { issuer, trust, installed } = await setup();
    const k = await issuer.setUp();
    trust[k.keyId] = k.publicKey;
    const mine = await issuer.grant(session, {
      recipient: "Me",
      audience: "self",
      scope: ["premium_all"],
      installId: INSTALL,
    });
    expect(installed).toEqual([mine.licenseKey]);
    expect(readLicense(mine.licenseKey!, trust)).toMatchObject({
      install: INSTALL,
      features: ["hearth_interconnectivity", "ember_show_and_tell", "panel_builder"],
      kind: "complimentary",
    });
    const friend = await issuer.grant(session, {
      recipient: "Sam",
      audience: "friend",
      note: "private: met at the meetup",
      label: "Sam's Hearth",
      scope: ["ember_show_and_tell"],
      end: at(Date.now() + 30 * DAY),
      installId: "99999999-2222-4333-8444-555555555555",
    });
    // Not for this installation: handed back to send, not installed here.
    expect(installed).toHaveLength(1);
    const p = readLicense(friend.licenseKey!, trust);
    expect(p).toMatchObject({ label: "Sam's Hearth", features: ["ember_show_and_tell"] });
    // The owner's private note never goes into the licence the recipient gets.
    expect(JSON.stringify(p)).not.toContain("meetup");
    // Revoked: named in what the issuer says, and back again when reinstated.
    await issuer.revoke(friend.grantId);
    expect(await issuer.revokedLicenses()).toEqual([p.id]);
    await issuer.reinstate(friend.grantId);
    expect(await issuer.revokedLicenses()).toEqual([]);
  });

  it("redeem codes once per installation, never past their uses, even at the same moment", async () => {
    let now = Date.parse("2026-11-10T00:00:00Z");
    const { issuer, trust } = await setup(() => now);
    const k = await issuer.setUp();
    trust[k.keyId] = k.publicKey;
    const { code, id } = await issuer.createCode({
      scope: ["hearth_interconnectivity"],
      audience: "creator",
      campaign: "Launch week",
      maxUses: 3,
      durationDays: 30,
    });
    // Ten installations at once, three uses: exactly three get it.
    const installs = Array.from(
      { length: 10 },
      (_, i) => `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`,
    );
    const results = await Promise.allSettled(
      installs.map((ins) => issuer.redeem(session, code, ins)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const ov = await issuer.overview();
    expect(ov.codes[0]).toMatchObject({ uses: 3, remaining: 0, state: "used up" });
    expect(ov.codes[0]).not.toHaveProperty("hash");
    expect(ov.grants.filter((g) => g.codeId === id)).toHaveLength(3);
    // The grant from a code lasts its 30 days.
    const lic = readLicense(
      (
        results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
          licenseKey: string;
        }>
      ).value.licenseKey,
      trust,
    );
    expect(Date.parse(lic.end!) - Date.parse(lic.start)).toBe(30 * DAY);

    // Once per installation; a wrong code; a switched-off code; an expired code.
    const two = await issuer.createCode({
      scope: ["premium_all"],
      audience: "tester",
      maxUses: 5,
      expiresAt: at(now + DAY),
    });
    await issuer.redeem(session, two.code.toLowerCase(), INSTALL);
    await expect(issuer.redeem(session, two.code, INSTALL)).rejects.toThrow(/already redeemed/);
    await expect(issuer.redeem(session, "HRTH-AAAAA-AAAAA-AAAAA-AAAAA", "x2")).rejects.toThrow(
      /isn't right/,
    );
    await issuer.setCodeActive(two.id, false);
    await expect(issuer.redeem(session, two.code, "x3")).rejects.toThrow(/switched off/);
    await issuer.setCodeActive(two.id, true);
    now += 2 * DAY;
    await expect(issuer.redeem(session, two.code, "x4")).rejects.toThrow(/expired/);
  });

  it("slow down someone guessing codes", async () => {
    const { issuer, trust } = await setup();
    const k = await issuer.setUp();
    trust[k.keyId] = k.publicKey;
    for (let i = 0; i < 5; i++)
      await expect(issuer.redeem(session, newCode(), "guesser")).rejects.toThrow(/isn't right/);
    await expect(issuer.redeem(session, newCode(), "guesser")).rejects.toThrow(/Too many tries/);
  });
});

describe("Panel Builder joins Premium; For You leaves it (11-14)", () => {
  it("a licence issued as all of Premium before still covers Panel Builder; one feature alone does not", () => {
    expect(
      licenceCovers(["hearth_interconnectivity", "ember_show_and_tell"], "panel_builder"),
    ).toBe(true);
    expect(licenceCovers(["ember_show_and_tell"], "panel_builder")).toBe(false);
    expect(licenceCovers(["panel_builder"], "panel_builder")).toBe(true);
  });
});

describe("Hearth's licence service, from the owner's Hearth and another one", () => {
  it("a code made on the owner's Hearth redeems on another Hearth, and taking it back reaches it", async () => {
    const { handle, memoryStore } = await import("../../../../services/hearth-licence/src/licence");
    const { LicenceService } = await import("./service");
    const { Issuer } = await import("./issuer");
    const store = memoryStore();
    const serviceKey = newSigningKey();
    const trust: Record<string, string> = { [serviceKey.keyId]: serviceKey.publicKey };
    const env = { SIGNING_KEY: serviceKey.privatePem, OWNER_KEY: "" };
    // The Worker, reached through fetch.
    const service = new LicenceService("https://licence.test", (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => handle(new Request(String(input), init), env, store)) as typeof fetch);

    // The owner's Hearth: makes its key (its public half becomes the service's OWNER_KEY).
    const secrets = new Map<string, string>();
    const vault = {
      exists: async (id: string) => secrets.has(id),
      add: async (s: { value: string }) => {
        secrets.set("k1", s.value);
        return { id: "k1" };
      },
      use: async (id: string) => secrets.get(id)!,
    };
    const owner = new Issuer(
      await db(),
      vault as never,
      async () => "owner-install-0000",
      async () => trust,
      async () => undefined,
    );
    const k = await owner.setUp();
    trust[k.keyId] = k.publicKey;
    env.OWNER_KEY = k.publicKey;
    owner.connect(service);
    const session = { id: "owner" } as never;
    const { id, code } = await owner.createCode(
      { scope: ["ember_show_and_tell"], audience: "friend", maxUses: 2, durationDays: 30 },
      session,
    );

    // Another Hearth redeems it through the service and installs the licence.
    const other = new Entitlements(
      await db(),
      async () => INSTALL,
      async () => trust,
    );
    const { licence } = await service.redeem(code, INSTALL);
    await other.install(licence);
    expect(await other.has("ember_show_and_tell")).toBe(true);
    expect((await owner.overview()).codes.find((c) => c.id === id)).toMatchObject({ uses: 1 });

    // The owner takes back every licence from the code; the other Hearth learns of it.
    await owner.revokeCode(id, session);
    await other.syncRevoked(await service.revoked());
    expect(await other.has("ember_show_and_tell")).toBe(false);
    await expect(service.redeem(code, "another-install-0001")).rejects.toThrow(/switched off/);
  });
});
