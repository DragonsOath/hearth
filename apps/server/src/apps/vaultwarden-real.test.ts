import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import {
  admin,
  forgetVaultwardenSessions,
  readVaultwarden,
  vaultwardenDashboard,
} from "./vaultwarden";
import { VaultwardenOperations } from "./vaultwarden-control";

/**
 * The same reads and changes as vaultwarden.test.ts against a real Vaultwarden: only a throwaway
 * one made for this, with its admin page on, one account that signed up
 * (alex@example.com) with an authenticator app set up for its two-step sign-in. It runs only with HEARTH_VAULTWARDEN_TEST_URL,
 * HEARTH_VAULTWARDEN_TEST_TOKEN_FILE and HEARTH_VAULTWARDEN_TEST_THROWAWAY=yes, and leaves the
 * accounts as it found them.
 */

const url = process.env.HEARTH_VAULTWARDEN_TEST_URL ?? "";
const file = process.env.HEARTH_VAULTWARDEN_TEST_TOKEN_FILE;
const run = Boolean(url && file && process.env.HEARTH_VAULTWARDEN_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(
  `a real, throwaway Vaultwarden at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const token = run ? readFileSync(file!, "utf8").trim() : "";
    const service = { id: "real", name: "Vaultwarden", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: token }),
    } as unknown as CredentialBroker;
    const ops = new VaultwardenOperations(handle, broker, realFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-vaultwarden-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });
    const go = async (params: PlannedStep["params"]) => {
      const planned = await ops.plan(service, params, base);
      const outcome = await ops.run(step(planned.params), service);
      return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
    };
    const alex = async () =>
      (await vaultwardenDashboard(realFetch, url, token)).users.find(
        (u) => u.email === "alex@example.com",
      )!;

    it("reads version, accounts and settings, and no keys, token or secrets", async () => {
      const d = await vaultwardenDashboard(realFetch, url, token);
      expect(d.version).toMatch(/^\d+\.\d+/);
      expect(d.database).toMatch(/SQLite|MySQL|PostgreSQL/i);
      expect(d.address).toMatch(/^https?:\/\//);
      expect((await alex()).status).toBe("active");
      expect(typeof d.settings.signupsAllowed).toBe("boolean");
      const json = JSON.stringify(d);
      for (const word of ["privateKey", "securityStamp", '"key"', "admin_token", token])
        expect(json).not.toContain(word);
      // The raw account list does carry keys: that is why Hearth copies fields by name.
      expect(JSON.stringify(await admin(realFetch, url, token, "GET", "/admin/users"))).toContain(
        "securityStamp",
      );
      const r = await readVaultwarden(url, token, realFetch);
      expect(r.facts.map((f) => f.label)).toContain("Accounts");
    });

    it("keeps one admin session instead of signing in each time", async () => {
      // Vaultwarden allows 3 admin sign-ins in 5 minutes: five more reads use the same session.
      for (let i = 0; i < 5; i++) await vaultwardenDashboard(realFetch, url, token);
    });

    it("turns an account off and on, read back, and marks the plan protected", async () => {
      const r = await go({ op: "disable", userId: (await alex()).id });
      expect(r.planned.params?.protected).toBe("yes");
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      expect((await alex()).status).toBe("disabled");
      expect((await r.undo())?.ok).toBe(true);
      expect((await alex()).status).toBe("active");
    });

    it("signs an account out everywhere, and turns off its two-step sign-in", async () => {
      const id = (await alex()).id;
      expect((await go({ op: "deauth", userId: id })).outcome.ok).toBe(true);
      // Set up on the throwaway with an authenticator app code before the run.
      if ((await alex()).twoFactor) {
        const r = await go({ op: "remove-2fa", userId: id });
        expect(r.outcome).toMatchObject({ ok: true, verified: true });
      }
      await expect(go({ op: "remove-2fa", userId: id })).rejects.toThrow(/no two-step sign-in/);
    });

    it("invites, sends again, and withdraws the invitation on undo", async () => {
      const email = `hearth${Date.now() % 100000}@example.com`;
      const r = await go({ op: "invite", email });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
      const invited = (await vaultwardenDashboard(realFetch, url, token)).users.find(
        (u) => u.email === email,
      )!;
      expect(invited.status).toBe("invited");
      expect((await go({ op: "resend", userId: invited.id })).outcome.ok).toBe(true);
      expect((await r.undo())?.ok).toBe(true);
      expect(
        (await vaultwardenDashboard(realFetch, url, token)).users.some((u) => u.email === email),
      ).toBe(false);
      await expect(go({ op: "invite", email: "alex@example.com" })).rejects.toThrow(/already has/);
      expect((await go({ op: "backup" })).outcome.ok).toBe(true);
    });

    it("refuses a wrong token plainly", async () => {
      forgetVaultwardenSessions();
      await expect(vaultwardenDashboard(realFetch, url, "wrong")).rejects.toThrow(
        /refused the admin token/,
      );
    });
  },
);
