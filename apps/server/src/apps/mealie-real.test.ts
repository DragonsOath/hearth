import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { mealieDashboard, readMealie } from "./mealie";
import { MealieOperations } from "./mealie-control";

/**
 * The same reads and changes as mealie.test.ts against a real Mealie: only a throwaway one made for
 * this, still with its first-run administrator, a few recipes and a second account locked by failed
 * sign-ins. It runs only with HEARTH_MEALIE_TEST_URL, HEARTH_MEALIE_TEST_KEY_FILE and
 * HEARTH_MEALIE_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_MEALIE_TEST_URL ?? "";
const file = process.env.HEARTH_MEALIE_TEST_KEY_FILE;
const run = Boolean(url && file && process.env.HEARTH_MEALIE_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(`a real, throwaway Mealie at ${url || "(none)"}`, { timeout: 60_000 }, () => {
  const token = run ? readFileSync(file!, "utf8").trim() : "";
  const service = { id: "real", name: "Mealie", localUrl: url };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: token }),
  } as unknown as CredentialBroker;
  const ops = new MealieOperations(handle, broker, realFetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-mealie-control" as const,
    serviceId: "real",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (op: string) => {
    const planned = await ops.plan(service, { op }, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };

  it("reads version, checks, counts, storage, backups and the first-run administrator, and no secret", async () => {
    const d = await mealieDashboard(realFetch, url, token);
    expect(d.version).toMatch(/^\d+\.\d+/);
    expect(d.database).toBe("SQLite");
    expect(d.recipes).toBeGreaterThan(0);
    expect(d.users).toBeGreaterThanOrEqual(2);
    expect(d.checks.baseUrlSet).toBe(true);
    expect(d.storage.data).toMatch(/B$/);
    expect(d.defaultAdmin).toBe(true);
    const text = JSON.stringify(d);
    expect(text).not.toContain(token);
    expect(text).not.toContain("sqlite:");
    const r = await readMealie(url, token, realFetch);
    expect(r.issues.map((i) => i.key)).toContain("default-admin");
    await expect(mealieDashboard(realFetch, url, "wrong-token")).rejects.toThrow(
      /refused the API token/,
    );
  });

  it("makes a backup, read back from the backup list, and cleans up", async () => {
    // Backups are named to the second.
    await new Promise((r) => setTimeout(r, 1100));
    const b = await go("backup");
    expect(b.outcome).toMatchObject({ ok: true, verified: true });
    for (const op of ["clean-temp", "clean-images", "clean-folders"])
      expect((await go(op)).outcome.ok).toBe(true);
  });

  it("unlocks the locked account", async () => {
    const r = await go("unlock");
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect(r.outcome.result).toMatch(/unlocked 1 account|No account was locked/);
  });
});
