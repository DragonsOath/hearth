import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeMealie } from "./fake-mealie";
import { mealieDashboard, readMealie } from "./mealie";
import { MealieOperations } from "./mealie-control";

/**
 * Mealie against the stand-in (answering as a throwaway v3.30.0 did; mealie-real.test.ts runs the
 * same calls against a real one): health and version, never the database address, and the light
 * maintenance controls as plans.
 */

const BASE = "http://10.0.0.9:9925";
const TOKEN = "e2e-mealie-token";
const service = { id: "ml", name: "Mealie", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeMealie();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
  } as unknown as CredentialBroker;
  const ops = new MealieOperations(handle, broker, fake.fetch);
  const go = async (op: string) => {
    const planned = await ops.plan(service, { op }, base);
    const outcome = await ops.run(
      { kind: "app-mealie-control", serviceId: "ml", requestedBy: "you", params: planned.params! },
      service,
    );
    return { planned, outcome };
  };
  return { fake, go };
}

describe("reading Mealie", () => {
  it("reads version, counts, checks, storage, backups and the first-run administrator, never the database address", async () => {
    const { fake } = setup();
    const d = await mealieDashboard(fake.fetch, BASE, TOKEN);
    expect(d).toMatchObject({
      version: "3.30.0",
      latest: "3.31.0",
      database: "PostgreSQL",
      recipes: 214,
      users: 3,
      defaultAdmin: true,
    });
    expect(d.storage).toMatchObject({ data: "412.5 MB", cleanableImages: 3 });
    expect(d.backups).toHaveLength(1);
    const text = JSON.stringify(d);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("postgresql://");
    expect(text).not.toContain("hearth");
    expect(text).not.toContain(TOKEN);
  });

  it("warns about the first-run administrator and an old backup, and refuses a wrong token plainly", async () => {
    const { fake } = setup();
    const r = await readMealie(BASE, TOKEN, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["default-admin", "backup-old"]);
    await expect(mealieDashboard(fake.fetch, BASE, "wrong")).rejects.toThrow(
      /refused the API token/,
    );
  });
});

describe("changing Mealie", () => {
  it("makes a backup read back from the list, and the old-backup warning goes", async () => {
    const { go, fake } = setup();
    const b = await go("backup");
    expect(b.planned.label).toBe("Make a backup of Mealie now");
    expect(b.outcome).toMatchObject({ ok: true, verified: true });
    expect((await readMealie(BASE, TOKEN, fake.fetch)).issues.map((i) => i.key)).toEqual([
      "default-admin",
    ]);
  });

  it("cleans up and unlocks", async () => {
    const { go } = setup();
    const img = await go("clean-images");
    expect(img.planned.label).toBe("Delete the 3 images no recipe uses in Mealie");
    expect(img.outcome.result).toBe("Mealie: 3 Images cleaned.");
    expect((await go("unlock")).outcome.result).toBe("Mealie unlocked 1 account.");
    expect((await go("unlock")).outcome.result).toBe("No account was locked.");
    await expect(go("drop-everything")).rejects.toThrow(/Say what to do/);
  });
});
