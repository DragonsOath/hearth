import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeVaultwarden } from "./fake-vaultwarden";
import {
  diagnosticsOf,
  forgetVaultwardenSessions,
  newer,
  readVaultwarden,
  toUser,
  vaultwardenDashboard,
} from "./vaultwarden";
import { VaultwardenOperations } from "./vaultwarden-control";

/**
 * Vaultwarden against the stand-in (answering as a throwaway 1.37.5 did; vaultwarden-real.test.ts
 * runs the same calls against a real one): accounts and settings with no key material or secrets,
 * one sign-in for many reads, and every change as a protected plan read back.
 */

const BASE = "http://10.0.0.9:8222";
const TOKEN = "e2e-admin-token";
const service = { id: "vw", name: "Vaultwarden", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeVaultwarden();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
  } as unknown as CredentialBroker;
  const ops = new VaultwardenOperations(handle, broker, fake.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-vaultwarden-control" as const,
    serviceId: "vw",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    const outcome = await ops.run(step(planned.params), service);
    return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
  };
  const users = async () => (await vaultwardenDashboard(fake.fetch, BASE, TOKEN)).users;
  return { fake, go, users };
}

beforeEach(() => forgetVaultwardenSessions());

describe("reading Vaultwarden", () => {
  it("reads accounts, organizations, settings and version, and no keys or secrets", async () => {
    const { fake } = setup();
    const d = await vaultwardenDashboard(fake.fetch, BASE, TOKEN);
    expect(d).toMatchObject({
      version: "1.37.5",
      latest: "1.38.0",
      webVault: "2026.10.1",
      database: "SQLite 3.53.2",
      address: "https://vault.example.com",
      https: true,
      orgs: [{ name: "Family", members: 2 }],
      settings: { signupsAllowed: true, signupDomains: "", emailConfigured: false },
    });
    expect(d.users.map((u) => [u.email, u.status, u.twoFactor])).toEqual([
      ["alex@example.com", "active", true],
      ["gran@example.com", "invited", false],
      ["old@example.com", "disabled", false],
      ["sam@example.com", "active", false],
    ]);
    expect(d.users.find((u) => u.email === "gran@example.com")!.name).toBe("gran");
    const json = JSON.stringify(d);
    expect(json).not.toContain("SECRET");
    expect(json).not.toMatch(/privateKey|securityStamp|admin_token|\*\*\*/);
    expect(json).not.toContain(TOKEN);
  });

  it("signs in once for many reads, even when they start together", async () => {
    const { fake } = setup();
    await Promise.all([1, 2, 3].map(() => vaultwardenDashboard(fake.fetch, BASE, TOKEN)));
    for (let i = 0; i < 5; i++) await vaultwardenDashboard(fake.fetch, BASE, TOKEN);
    expect(fake.signIns()).toBe(1);
  });

  it("warns about open sign-ups and refuses a wrong token plainly", async () => {
    const { fake } = setup();
    const r = await readVaultwarden(BASE, TOKEN, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["signups-open"]);
    expect(r.facts).toEqual(
      expect.arrayContaining([
        { label: "Accounts", value: "2" },
        { label: "Without two-step sign-in", value: "1" },
        { label: "Update", value: "1.38.0" },
      ]),
    );
    forgetVaultwardenSessions();
    await expect(vaultwardenDashboard(fake.fetch, BASE, "wrong")).rejects.toThrow(
      /refused the admin token/,
    );
  });

  it("reads its diagnostics, times and versions", () => {
    expect(
      diagnosticsOf('<script type="application/json" id="diagnostics_json">{"a":1}</script>'),
    ).toEqual({ a: 1 });
    expect(diagnosticsOf("<html></html>")).toEqual({});
    expect(newer("1.38.0", "1.37.5")).toBe(true);
    expect(newer("1.37.5", "1.37.5")).toBe(false);
    expect(
      toUser({ id: "x", email: "a@b.c", lastActive: "2026-11-08 08:40:36 +00:00" }).lastActive,
    ).toBe("2026-11-08T08:40:36.000Z");
  });
});

describe("changing Vaultwarden", () => {
  it("turns an account off and on as a protected plan, read back", async () => {
    const { go, users } = setup();
    const r = await go({ op: "disable", userId: "u-sam" });
    expect(r.planned.params?.protected).toBe("yes");
    expect(r.planned.label).toBe(
      "Turn off sam@example.com in Vaultwarden (they cannot sign in or sync; their vault stays)",
    );
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await users()).find((u) => u.id === "u-sam")!.status).toBe("disabled");
    await r.undo();
    expect((await users()).find((u) => u.id === "u-sam")!.status).toBe("active");
    await expect(go({ op: "enable", userId: "u-sam" })).rejects.toThrow(/not turned off/);
  });

  it("turns off two-step sign-in for a lost phone, and signs out everywhere", async () => {
    const { go } = setup();
    const r = await go({ op: "remove-2fa", userId: "u-alex" });
    expect(r.planned.label).toContain("their master password alone opens the vault");
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    await expect(go({ op: "remove-2fa", userId: "u-alex" })).rejects.toThrow(/no two-step/);
    expect((await go({ op: "deauth", userId: "u-sam" })).outcome.ok).toBe(true);
    await expect(go({ op: "deauth", userId: "u-gran" })).rejects.toThrow(/not made an account/);
  });

  it("invites, resends, and withdraws on undo; deleting says it cannot be undone", async () => {
    const { go, users } = setup();
    const r = await go({ op: "invite", email: "Aunt@Example.com" });
    expect(r.planned.label).toContain("tell them to sign up at its address");
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    const aunt = (await users()).find((u) => u.email === "aunt@example.com")!;
    expect((await go({ op: "resend", userId: aunt.id })).outcome.ok).toBe(true);
    await r.undo();
    expect((await users()).some((u) => u.email === "aunt@example.com")).toBe(false);
    await expect(go({ op: "invite", email: "not an email" })).rejects.toThrow(/email address/);
    const del = await go({ op: "delete", userId: "u-old" });
    expect(del.planned.label).toContain("cannot be undone");
    expect(del.outcome).toMatchObject({ ok: true, verified: true });
    expect(await del.undo()).toBeUndefined();
    expect((await go({ op: "backup" })).outcome.ok).toBe(true);
  });
});
