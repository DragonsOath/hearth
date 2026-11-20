import { describe, expect, it } from "vitest";
import { buildTemplate } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { FAKE_PHOTOS, fakeImmich } from "./fake-immich";
import { ImmichOperations } from "./immich";
import { filesStatus, readStorage } from "./immich-files";

/**
 * Files and folders against the stand-in Immich: the storage template changes only through a
 * plan (before and after shown), Immich's job moves the files, and the panel checks a few photos
 * landed where the pattern says. The same steps ran against a throwaway Immich 3.2.4
 * (immich-files-real.test.ts).
 */

const BASE = "http://10.0.0.9:2283";
const service = { id: "im", name: "Immich", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const brokerFor = (key: string) =>
  ({
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
  }) as unknown as CredentialBroker;

function setup(key = "e2e-im-key") {
  const im = fakeImmich();
  const ops = new ImmichOperations(handle, brokerFor(key), im.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-immich-control" as const,
    serviceId: "im",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  const c = { fetchImpl: im.fetch, base: BASE, key, service };
  return { ops, go, step, c };
}
const body = (enabled: boolean, template: string) => JSON.stringify({ enabled, template });

describe("Files and folders", () => {
  it("reads the pattern and previews where a few photos would go", async () => {
    const { c } = setup();
    const s = await filesStatus(c);
    expect(s.storage).toMatchObject({ known: true, enabled: false, canChange: true });
    expect(s.samples).toHaveLength(4);
    expect(s.samples[0]).toMatchObject({
      name: FAKE_PHOTOS[0]!.originalFileName,
      owner: "admin",
      path: expect.stringMatching(/^upload\//),
      expected: "library/admin/2026/2026-10-30/IMG_4100.jpg",
    });
    // Off: nothing to check yet.
    expect(s.samples[0]!.inPlace).toBeUndefined();
  });

  it("changes the pattern through a plan, runs Immich's job, and checks the files", async () => {
    const { go, c } = setup();
    const template = buildTemplate("year-month", "date");
    const { planned, outcome } = await go({ op: "storage-template", body: body(true, template) });
    expect(planned.label).toMatch(/whole library; external libraries stay where they are/);
    expect(planned.change?.settings[0]).toMatchObject({
      name: "In words",
      before: "off",
      after: "By year, then month; date, then the original name",
    });
    expect(planned.change?.settings[1]).toMatchObject({
      before: expect.stringMatching(/^off/),
      after: template,
    });
    expect(outcome).toMatchObject({ ok: true, verified: true });
    expect(await readStorage(c)).toMatchObject({ enabled: true, template });
    expect((await go({ op: "storage-migrate" })).outcome).toMatchObject({ ok: true });
    // Busy while Immich moves the files, then every sample is where the pattern says.
    expect((await filesStatus(c)).migration.active).toBe(1);
    await filesStatus(c);
    const done = await filesStatus(c);
    expect(done.migration.active).toBe(0);
    expect(done.samples.map((x) => x.inPlace)).toEqual([true, true, true, true]);
    expect(done.samples[0]!.path).toBe("library/admin/2026/10/2026-10-30 IMG_4100.jpg");
  });

  it("refuses no change, a bad pattern, and a key that cannot change settings", async () => {
    const { ops } = setup();
    const plan = (b: string) => ops.plan(service, { op: "storage-template", body: b }, base);
    await expect(plan(body(false, "{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}"))).rejects.toThrow(
      /Nothing would change/,
    );
    await expect(plan(body(true, "{{y}}/{{MM}}"))).rejects.toThrow(/needs the file name/);
    const ro = setup("e2e-im-readonly");
    await expect(
      ro.ops.plan(
        service,
        { op: "storage-template", body: body(true, buildTemplate("year", "original")) },
        base,
      ),
    ).rejects.toThrow(/systemConfig.update/);
    expect((await readStorage(ro.c)).canChange).toBe(false);
  });

  it("changes nothing when the pattern was changed in Immich after planning, and undoes itself", async () => {
    const { ops, go, step, c } = setup();
    const planned = await ops.plan(
      service,
      { op: "storage-template", body: body(true, buildTemplate("year", "original")) },
      base,
    );
    await go({ op: "storage-template", body: body(true, buildTemplate("album", "original")) });
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: false, stale: true });
    // A later step failed: the pattern goes back to what it was before this step.
    const again = await ops.plan(
      service,
      { op: "storage-template", body: body(true, buildTemplate("year", "date")) },
      base,
    );
    await ops.run(step(again.params), service);
    expect(await ops.undo(step(again.params), service)).toMatchObject({ ok: true });
    expect(await readStorage(c)).toMatchObject({ template: buildTemplate("album", "original") });
  });
});
