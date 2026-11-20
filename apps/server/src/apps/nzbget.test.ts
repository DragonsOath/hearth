import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeNzbget } from "./fake-nzbget";
import { nzbgetDashboard, nzbgetHistory, nzbgetJobFiles, readNzbget, toJob } from "./nzbget";
import { NzbgetOperations } from "./nzbget-control";

/**
 * NZBGet against the stand-in (answering as a throwaway 26.3 did; nzbget-real.test.ts runs the
 * same calls against a real one): SABnzbd's shapes from NZBGet's answers, no password from its
 * settings, and every change as a plan read back.
 */

const BASE = "http://10.0.0.9:6789";
const LOGIN = { username: "nzbget", password: "e2e-nzbget" };
const service = { id: "nz", name: "NZBGet", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const nz = fakeNzbget();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: LOGIN.password, username: LOGIN.username }),
  } as unknown as CredentialBroker;
  const ops = new NzbgetOperations(handle, broker, nz.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-nzbget-control" as const,
    serviceId: "nz",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  return { nz, ops, go, step };
}

describe("reading NZBGet", () => {
  it("reads the queue, history, warnings and categories in SABnzbd's shapes, and no password", async () => {
    const { nz } = setup();
    const d = await nzbgetDashboard(nz.fetch, BASE, LOGIN);
    expect(d).toMatchObject({
      app: "nzbget",
      version: "26.3",
      status: "Downloading",
      speedKbps: 8192,
    });
    expect(d.categories).toEqual(["Movies", "Series", "Music"]);
    expect(d.queue.map((j) => [j.id, j.status, j.priority, j.category])).toEqual([
      ["1", "Downloading", "Normal", "Series"],
      ["2", "Queued", "High", "Movies"],
      ["3", "Paused", "Normal", "Music"],
    ]);
    expect(d.queue[0]).toMatchObject({ progressPct: 62.5, sizeMb: 2400 });
    expect(d.history.find((h) => h.id === "5")).toMatchObject({
      failed: true,
      status: "Failed",
      why: "too many missing articles",
    });
    expect(d.history.find((h) => h.id === "6")).toMatchObject({ failed: false, status: "Deleted" });
    expect(d.warnings).toEqual([
      "The control password is easy to guess",
      "Broken.Release.1080p: too many articles missing",
    ]);
    expect(d.diskFreeGb).toBe(500);
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });

  it("pages and filters the history, and lists a download's files", async () => {
    const { nz } = setup();
    expect((await nzbgetHistory(nz.fetch, BASE, LOGIN, { failedOnly: true })).items).toHaveLength(
      1,
    );
    expect(
      (await nzbgetHistory(nz.fetch, BASE, LOGIN, { search: "documentary" })).items[0]!.name,
    ).toBe("Old.Documentary.720p");
    const files = await nzbgetJobFiles(nz.fetch, BASE, LOGIN, "1");
    expect(files.map((f) => f.status)).toEqual(["finished", "active"]);
  });

  it("reports warnings and failures, and refuses a wrong password plainly", async () => {
    const { nz } = setup();
    const r = await readNzbget(BASE, LOGIN, nz.fetch);
    expect(r.issues.map((i) => i.key)).toContain("history:failed");
    await expect(
      nzbgetDashboard(nz.fetch, BASE, { username: "nzbget", password: "wrong" }),
    ).rejects.toThrow(/refused the username or password/);
  });

  it("reads a paused group as paused, whatever its status word", () => {
    const g = {
      NZBID: 9,
      NZBName: "x",
      Status: "DOWNLOADING",
      FileSizeLo: 10,
      RemainingSizeLo: 5,
      PausedSizeLo: 5,
    };
    expect(toJob(g, 0).status).toBe("Paused");
    expect(toJob({ ...g, PausedSizeLo: 0 }, 1000).status).toBe("Downloading");
  });
});

describe("changing NZBGet", () => {
  it("pauses and resumes everything, and one download, read back", async () => {
    const { go } = setup();
    expect((await go({ op: "pause-all" })).outcome).toMatchObject({ ok: true, verified: true });
    await expect(go({ op: "pause-all" })).rejects.toThrow(/already paused/);
    expect((await go({ op: "resume-all" })).outcome.ok).toBe(true);
    expect((await go({ op: "pause", nzoId: "1" })).outcome).toMatchObject({
      ok: true,
      result: "Lantern.S01E03.1080p is paused. NZBGet confirms it.",
    });
    expect((await go({ op: "resume", nzoId: "3" })).outcome.ok).toBe(true);
  });

  it("limits the speed in KB/s and pauses for a while", async () => {
    const { go } = setup();
    const r = await go({ op: "speed-limit", value: "5120" });
    expect(r.planned.label).toBe("Limit downloads to 5 MB/s in NZBGet");
    expect(r.outcome.ok).toBe(true);
    await expect(go({ op: "speed-limit", value: "50" + "%" })).rejects.toThrow(/KB\/s/);
    const p = await go({ op: "pause-for", value: "30" });
    expect(p.outcome.ok).toBe(true);
  });

  it("changes priority, place and category, and puts them back on undo", async () => {
    const { go, ops, step, nz } = setup();
    const pr = await go({ op: "priority", nzoId: "3", value: "force" });
    expect(pr.outcome.ok).toBe(true);
    await ops.undo(step(pr.planned.params), service);
    expect((await nzbgetDashboard(nz.fetch, BASE, LOGIN)).queue[2]!.priority).toBe("Normal");
    expect((await go({ op: "move", nzoId: "3", value: "0" })).outcome.ok).toBe(true);
    expect((await go({ op: "move", nzoId: "3", value: "1" })).outcome.ok).toBe(true);
    expect((await go({ op: "category", nzoId: "2", category: "Series" })).outcome.ok).toBe(true);
    await expect(go({ op: "category", nzoId: "2", category: "Nope" })).rejects.toThrow(
      /no category "Nope"/,
    );
  });

  it("retries a failed download, removes one, and cleans the history", async () => {
    const { go } = setup();
    const r = await go({ op: "retry", nzoId: "5" });
    expect(r.planned.label).toContain("it failed: too many missing articles");
    expect(r.outcome.ok).toBe(true);
    await expect(go({ op: "retry", nzoId: "4" })).rejects.toThrow(
      /no longer in the history|did not fail/,
    );
    expect((await go({ op: "remove", nzoId: "2" })).outcome.ok).toBe(true);
    expect((await go({ op: "remove-history", nzoId: "6" })).outcome.ok).toBe(true);
  });

  it("adds an NZB file paused in a category, and refuses it twice", async () => {
    const { go } = setup();
    const data = Buffer.from('<?xml version="1.0"?><nzb xmlns="x"></nzb>').toString("base64");
    const add = {
      op: "add",
      files: JSON.stringify([{ name: "New.Show.S01E01.nzb", data }]),
      category: "Series",
      paused: true,
    };
    const r = await go(add);
    expect(r.planned.label).toBe("Add New.Show.S01E01 to NZBGet");
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    await expect(go(add)).rejects.toThrow(/already in the queue/);
    await expect(go({ op: "add", urls: "ftp://x/y.nzb" })).rejects.toThrow(/http or https/);
  });
});
