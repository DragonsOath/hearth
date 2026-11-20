import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { SabnzbdOperations, sabHistory, sabJobFiles, sabnzbdDashboard } from "./sabnzbd-live";

/**
 * SABnzbd's everyday controls against a real, disposable SABnzbd 5.1 on an internal network with no
 * internet and no Usenet servers (checklist 46.10m): its queue holds synthetic jobs that can never
 * download. Skipped unless HEARTH_SAB_TEST_URL and HEARTH_SAB_TEST_KEY_FILE point at such an
 * instance: never run this against one anyone uses. Everything it changes it puts back.
 */

const url = process.env.HEARTH_SAB_TEST_URL;
const keyFile = process.env.HEARTH_SAB_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const live = Boolean(url && key);

const fetchImpl = (u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init);
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const sab = { id: "sab-test", name: "SABnzbd", localUrl: url ?? "" };
const ops = new SabnzbdOperations(
  handle,
  broker,
  fetchImpl as unknown as ConstructorParameters<typeof SabnzbdOperations>[2],
);
const read = () =>
  sabnzbdDashboard(
    fetchImpl as unknown as Parameters<typeof sabnzbdDashboard>[0],
    sab.localUrl,
    key,
  );
const step = (planned: PlannedStep) => ({
  kind: "app-sabnzbd-control" as const,
  serviceId: "sab-test",
  requestedBy: "you" as const,
  params: planned.params,
  change: planned.change,
});
const act = async (params: StepParams) => {
  const planned = await ops.plan(sab, params, base);
  return { planned, done: await ops.run(step(planned), sab) };
};

describe.skipIf(!live)("SABnzbd against a real test instance", () => {
  let order: string[] = [];
  afterAll(async () => {
    const d = await read();
    if ((d.speedLimitPct ?? 100) !== 100) await act({ op: "speed-limit", value: "100" });
    if (d.paused) await act({ op: "resume-all" });
  });

  it("reads the queue with priorities, categories and the speed limit", async () => {
    const d = await read();
    expect(d.version).toMatch(/^5\./);
    expect(d.queue.length).toBeGreaterThanOrEqual(3);
    expect(d.queue[0]!.priority).toBeTruthy();
    expect(d.categories).toEqual(expect.arrayContaining(["movies", "tv"]));
    order = d.queue.map((j) => j.id);
  });

  it("limits the speed and lifts it again, each read back", async () => {
    const { done } = await act({ op: "speed-limit", value: "50" });
    expect(done.ok, done.result).toBe(true);
    expect((await read()).speedLimitPct).toBe(50);
    const off = await act({ op: "speed-limit", value: "100" });
    expect(off.done.ok, off.done.result).toBe(true);
    expect((await read()).speedLimitPct).toBeUndefined();
  });

  it("pauses for a while, then resumes", async () => {
    const { done } = await act({ op: "pause-for", value: "5" });
    expect(done.ok, done.result).toBe(true);
    const d = await read();
    expect(d.paused).toBe(true);
    expect(d.pausedMinutes).toBeGreaterThan(0);
    expect((await act({ op: "resume-all" })).done.ok).toBe(true);
  });

  it("changes a job's priority, place and category; a retried move does nothing", async () => {
    const last = order[order.length - 1]!;
    const pr = await act({ op: "priority", nzoId: last, value: "low" });
    expect(pr.done.ok, pr.done.result).toBe(true);
    const back = await act({ op: "priority", nzoId: last, value: "normal" });
    expect(back.done.ok).toBe(true);

    const moved = await act({ op: "move", nzoId: last, value: "0" });
    expect(moved.done.ok, moved.done.result).toBe(true);
    expect((await read()).queue[0]!.id).toBe(last);
    expect(await ops.run(step(moved.planned), sab)).toMatchObject({ ok: false, stale: true });
    // Put it back at the end.
    const restore = await act({ op: "move", nzoId: last, value: String(order.length - 1) });
    expect(restore.done.ok).toBe(true);

    const cat = await act({ op: "category", nzoId: last, category: "tv" });
    expect(cat.done.ok, cat.done.result).toBe(true);
    const none = await act({ op: "category", nzoId: last, category: "" });
    expect(none.done.ok, none.done.result).toBe(true);
    await expect(
      ops.plan(sab, { op: "category", nzoId: last, category: "nope" }, base),
    ).rejects.toThrow(/no category "nope"/);
  });
});

describe.skipIf(!live)("SABnzbd's Downloads tab against a real test instance", () => {
  const f = fetchImpl as unknown as Parameters<typeof sabHistory>[0];
  const name = `Hearth.Test.${Date.now()}`;
  // A synthetic NZB: one file of one segment no server has (this instance has no Usenet servers).
  const nzb = Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="hearth@test.invalid" date="1700000000" subject="&quot;${name}.mkv&quot; yEnc (1/1)">
    <groups><group>alt.binaries.test</group></groups>
    <segments><segment bytes="500000" number="1">${name}-1@test.invalid</segment></segments>
  </file>
</nzb>
`,
  ).toString("base64");
  const added: string[] = [];
  afterAll(async () => {
    const d = await read();
    for (const j of d.queue.filter((x) => x.name.startsWith("Hearth.Test.")))
      await act({ op: "remove", nzoId: j.id, deleteFiles: true }).catch(() => undefined);
    for (const h of d.history.filter((x) => x.name.startsWith("Hearth.Test.")))
      await act({ op: "remove-history", nzoId: h.id, deleteFiles: true }).catch(() => undefined);
  });

  it("adds an .nzb file paused in a category, reads its files, then removes it", async () => {
    const { planned, done } = await act({
      op: "add",
      files: JSON.stringify([{ name: `${name}.nzb`, data: nzb }]),
      category: "movies",
      paused: true,
    });
    expect(planned.label).toBe(`Add ${name} to SABnzbd`);
    expect(done.ok, done.result).toBe(true);
    const job = (await read()).queue.find((j) => j.name === name);
    expect(job).toMatchObject({ category: "movies" });
    expect(job!.status).toMatch(/paused/i);
    added.push(job!.id);
    const files = await sabJobFiles(f, sab.localUrl, key, job!.id);
    expect(files.length).toBeGreaterThanOrEqual(1);
    // A retried plan does not add it a second time.
    const again = await ops.run(step(planned), sab);
    expect(again.result).toContain("not added again");
    expect((await read()).queue.filter((j) => j.name === name)).toHaveLength(1);
    const gone = await act({ op: "remove", nzoId: job!.id, deleteFiles: true });
    expect(gone.done.ok, gone.done.result).toBe(true);
  });

  it("searches and filters the history", async () => {
    const all = await sabHistory(f, sab.localUrl, key);
    expect(all.total).toBeGreaterThanOrEqual(all.items.length);
    const failed = await sabHistory(f, sab.localUrl, key, { failedOnly: true });
    expect(failed.items.every((h) => h.failed)).toBe(true);
    const none = await sabHistory(f, sab.localUrl, key, { search: `zz-nothing-${Date.now()}` });
    expect(none.items).toHaveLength(0);
  });

  it("clears the warnings when there are some", async () => {
    const d = await read();
    if (!d.warnings.length) {
      await expect(ops.plan(sab, { op: "clear-warnings" }, base)).rejects.toThrow(/no warnings/);
      return;
    }
    const { done } = await act({ op: "clear-warnings" });
    expect(done.ok, done.result).toBe(true);
    expect((await read()).warnings).toHaveLength(0);
  });
});
