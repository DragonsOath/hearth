import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeSabnzbd } from "./fake-sabnzbd";
import { sabHistory, sabJobFiles, sabnzbdDashboard, SabnzbdOperations } from "./sabnzbd-live";

/** SABnzbd's panel and controls, against a stand-in that answers like SABnzbd 4.4. */

const BASE = "http://10.0.0.9:8080";
const KEY = "e2e-sab-key";
const service = { id: "sab", name: "SABnzbd", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-sabnzbd-control" as const,
  serviceId: "sab",
  requestedBy: "you" as const,
  params,
});

describe("the SABnzbd panel", () => {
  it("shows the queue, speed, disk, and why a download failed", async () => {
    const d = await sabnzbdDashboard(fakeSabnzbd().fetch, BASE, KEY);
    expect(d).toMatchObject({ status: "Downloading", paused: false, diskFreeGb: 812.4 });
    expect(d.speedKbps).toBeGreaterThan(48000);
    expect(d.queue[0]).toMatchObject({
      name: "Arrival.2016.1080p.BluRay",
      progressPct: 63,
      sizeMb: 9800,
    });
    expect(d.history[0]).toMatchObject({
      failed: true,
      why: "Repair failed, not enough repair blocks (412 short)",
      sizeMb: 51200,
    });
    expect(d.history[1]?.failed).toBe(false);
  });

  it("says plainly when the key is refused", async () => {
    await expect(sabnzbdDashboard(fakeSabnzbd().fetch, BASE, "wrong")).rejects.toThrow(
      "SABnzbd refused the API key.",
    );
  });
});

describe("SABnzbd controls", () => {
  it("pauses and resumes everything, and checks it took", async () => {
    const ops = new SabnzbdOperations(handle, broker, fakeSabnzbd().fetch);
    const planned = await ops.plan(service, { op: "pause-all" }, base);
    expect(planned.label).toBe("Pause all downloads in SABnzbd");
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: true });
    await expect(ops.plan(service, { op: "pause-all" }, base)).rejects.toThrow(/already paused/);
    const resume = await ops.plan(service, { op: "resume-all" }, base);
    expect(await ops.run(step(resume.params), service)).toMatchObject({
      ok: true,
      result: "Downloads are running again. SABnzbd confirms it.",
    });
  });

  it("retries a failed job, and refuses one that did not fail", async () => {
    const ops = new SabnzbdOperations(handle, broker, fakeSabnzbd().fetch);
    const planned = await ops.plan(service, { op: "retry", nzoId: "SABnzbd_nzo_c3" }, base);
    expect(planned.label).toContain("Retry Dune.Part.Two.2024.2160p");
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: true });
    await expect(ops.plan(service, { op: "retry", nzoId: "SABnzbd_nzo_d4" }, base)).rejects.toThrow(
      /did not fail/,
    );
  });

  it("removes a job, keeping its files unless asked", async () => {
    const ops = new SabnzbdOperations(handle, broker, fakeSabnzbd().fetch);
    const keep = await ops.plan(service, { op: "remove", nzoId: "SABnzbd_nzo_b2" }, base);
    expect(keep.label).toContain("(what it downloaded stays)");
    expect(keep.params).not.toHaveProperty("deleteFiles");
    const del = await ops.plan(
      service,
      { op: "remove", nzoId: "SABnzbd_nzo_b2", deleteFiles: true },
      base,
    );
    expect(del.label).toContain("and delete what it downloaded");
    expect(await ops.run(step(keep.params), service)).toMatchObject({ ok: true });
    await expect(ops.plan(service, { op: "pause", nzoId: "SABnzbd_nzo_b2" }, base)).rejects.toThrow(
      /no longer in the queue/,
    );
  });
});

describe("SABnzbd's Downloads tab", () => {
  const nzb = (name: string) =>
    JSON.stringify([
      {
        name,
        data: Buffer.from(
          '<?xml version="1.0"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file/></nzb>',
        ).toString("base64"),
      },
    ]);

  it("adds an NZB link and an .nzb file, with a category and priority, read back by id", async () => {
    const sab = fakeSabnzbd();
    const ops = new SabnzbdOperations(handle, broker, sab.fetch);
    const planned = await ops.plan(
      service,
      {
        op: "add",
        urls: "https://indexer.example/getnzb/Big.Buck.Bunny.nzb?apikey=SECRET123",
        files: nzb("Sintel.2010.nzb"),
        category: "movies",
        value: "high",
      },
      base,
    );
    expect(planned.label).toBe("Add 2 NZBs to SABnzbd");
    // The link's query (an indexer's key) is never shown in the plan.
    expect(JSON.stringify(planned.change)).not.toContain("SECRET123");
    expect(planned.change?.settings.map((s) => s.name)).toEqual([
      "indexer.example/getnzb/Big.Buck.Bunny.nzb?…",
      "Sintel.2010",
    ]);
    expect(await ops.run(step(planned.params), service)).toMatchObject({
      ok: true,
      result: "2 NZBs are in SABnzbd. SABnzbd confirms it.",
    });
    const d = await sabnzbdDashboard(sab.fetch, BASE, KEY);
    expect(d.queue.slice(3)).toMatchObject([
      { name: "Big.Buck.Bunny", category: "movies", priority: "High" },
      { name: "Sintel.2010", category: "movies", priority: "High" },
    ]);
  });

  it("refuses a file already in the queue, a wrong category, a non-NZB, and a bad link", async () => {
    const sab = fakeSabnzbd();
    const ops = new SabnzbdOperations(handle, broker, sab.fetch);
    await expect(
      ops.plan(service, { op: "add", files: nzb("Arrival.2016.1080p.BluRay.nzb") }, base),
    ).rejects.toThrow(/already in the queue/);
    await expect(
      ops.plan(service, { op: "add", urls: "https://x.example/a.nzb", category: "games" }, base),
    ).rejects.toThrow(/no category "games"/);
    await expect(
      ops.plan(
        service,
        {
          op: "add",
          files: JSON.stringify([{ name: "a.nzb", data: Buffer.from("hello").toString("base64") }]),
        },
        base,
      ),
    ).rejects.toThrow(/does not look like an NZB/);
    await expect(ops.plan(service, { op: "add", urls: "ftp://x/a.nzb" }, base)).rejects.toThrow(
      /http or https/,
    );
  });

  it("adds one paused, under its own name", async () => {
    const sab = fakeSabnzbd();
    const ops = new SabnzbdOperations(handle, broker, sab.fetch);
    const planned = await ops.plan(
      service,
      { op: "add", files: nzb("x.nzb"), paused: true, nzbName: "My.Home.Video" },
      base,
    );
    expect(planned.change?.settings[0]).toMatchObject({ name: "My.Home.Video" });
    expect(planned.change?.settings[0]?.after).toContain("paused");
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: true });
    const d = await sabnzbdDashboard(sab.fetch, BASE, KEY);
    expect(d.queue.find((j) => j.name === "My.Home.Video")?.status).toBe("Paused");
    // Run again (a retried plan): the file is already there, so it is not added twice.
    expect(await ops.run(step(planned.params), service)).toMatchObject({
      ok: true,
      result: expect.stringContaining("not added again"),
    });
    expect((await sabnzbdDashboard(sab.fetch, BASE, KEY)).queue).toHaveLength(4);
  });

  it("clears the warnings, and says so when there are none", async () => {
    const sab = fakeSabnzbd();
    const ops = new SabnzbdOperations(handle, broker, sab.fetch);
    expect((await sabnzbdDashboard(sab.fetch, BASE, KEY)).warnings).toHaveLength(1);
    const planned = await ops.plan(service, { op: "clear-warnings" }, base);
    expect(planned.label).toBe("Clear the warning in SABnzbd");
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: true });
    await expect(ops.plan(service, { op: "clear-warnings" }, base)).rejects.toThrow(/no warnings/);
  });

  it("searches and filters the history, and lists a job's files", async () => {
    const sab = fakeSabnzbd();
    expect(await sabHistory(sab.fetch, BASE, KEY, { failedOnly: true })).toMatchObject({
      total: 1,
      items: [{ name: "Dune.Part.Two.2024.2160p", failed: true }],
    });
    expect((await sabHistory(sab.fetch, BASE, KEY, { search: "paper" })).items[0]?.name).toBe(
      "Paper.Moons.2026.1080p",
    );
    const files = await sabJobFiles(sab.fetch, BASE, KEY, "SABnzbd_nzo_a1");
    expect(files).toHaveLength(4);
    expect(files[0]).toMatchObject({ status: "finished", leftMb: 0 });
  });
});
