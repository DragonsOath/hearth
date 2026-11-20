import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../../config";
import { openDatabase, runMigrations, type DbHandle } from "../../db/client";
import type { StepRun } from "../../jobs/operations";
import { Jobs } from "../../jobs/engine";
import {
  runSnapraidJob,
  parseDiff,
  parseProgress,
  type SnapraidJobState,
} from "../../elevated/snapraid-job";
import { snapraidRun } from "../../elevated/snapraid";
import type { RaidDeps } from "../../elevated/raid";
import { SampleRaid } from "./sample";
import { RaidService } from "./service";
import { parseConf, parseStatus, snapActions, snapToArray } from "./snapraid";

const CONF = `# example
parity /mnt/parity1/snapraid.parity
2-parity /mnt/parity2/snapraid.2-parity
content /var/snapraid/snapraid.content
content /mnt/disk1/snapraid.content
data d1 /mnt/disk1/
disk d2 /mnt/disk2/
exclude /lost+found/
`;

const STATUS = `SnapRAID status report:

   Files Fragmented Excess  Wasted  Used    Free  Use Name
            Files  Fragments  GB      GB      GB
   29546     394    1785       -    5243    1240  80% d1
   31226     392    1621       -    5259    1225  81% d2
 --------------------------------------------------------------------------
   60772     786    3406     0.0   10502    2465  80%

The oldest block was scrubbed 61 days ago, the median 12, the newest 0.

WARNING! The array is NOT fully synced.
The 59% of the array is not scrubbed.
You have 3 files with zero sub-second timestamp.
No rehash is in progress or needed.
DANGER! In the array there are 2 errors!
`;

describe("reading SnapRAID", () => {
  it("reads snapraid.conf: parity levels, data drives (new and old keywords), content files", () => {
    const c = parseConf(CONF, "/etc/snapraid.conf");
    expect(c.parity.map((p) => [p.level, p.name, p.paths[0]])).toEqual([
      [1, "parity", "/mnt/parity1/snapraid.parity"],
      [2, "2-parity", "/mnt/parity2/snapraid.2-parity"],
    ]);
    expect(c.data).toEqual([
      { name: "d1", path: "/mnt/disk1/" },
      { name: "d2", path: "/mnt/disk2/" },
    ]);
    expect(c.content).toHaveLength(2);
  });

  it("reads SnapRAID's status: errors, unsynced, scrub age, each drive", () => {
    const s = parseStatus(STATUS);
    expect(s).toMatchObject({
      errors: 2,
      unsynced: true,
      notScrubbedPct: 59,
      oldestDays: 61,
      medianDays: 12,
      zeroSubSecond: 3,
    });
    expect(s.disks.d1).toEqual({ files: 29546, usedGB: 5243, freeGB: 1240 });
    expect(s.notes).toEqual([
      "WARNING! The array is NOT fully synced.",
      "DANGER! In the array there are 2 errors!",
    ]);
  });

  it("is degraded with errors or a missing drive, and never offers a sync over a missing one", () => {
    const conf = parseConf(CONF, "/etc/snapraid.conf");
    const members = [
      { device: "/dev/sdb1", name: "d1", role: "data" as const, states: [], sizeBytes: 8e12 },
      { device: "/mnt/disk2/", name: "d2", role: "missing" as const, states: [] },
      { device: "/dev/sdd1", name: "parity", role: "parity" as const, states: [], sizeBytes: 6e12 },
    ];
    const a = snapToArray({ conf, status: parseStatus(STATUS), members, missing: ["d2"] });
    expect(a).toMatchObject({
      tech: "snapraid",
      health: "degraded",
      canLose: 1,
      levelText: "2 parity drives, 2 data drives",
    });
    expect(a.warnings.join(" ")).toMatch(/d2's folder is missing/);
    expect(a.warnings.join(" ")).toMatch(/smaller than the largest data drive/);
    const by = Object.fromEntries(snapActions(a, { ready: true }).map((x) => [x.id, x]));
    expect(by.sync!.status).toBe("blocked");
    expect(by.sync!.reason).toMatch(/throw away the parity/);
    expect(by.repair!.status).toBe("available");
    expect(by.fix!.status).toBe("available");
    expect(by.replace!.status).toBe("unsupported");
  });
});

/* ---------- the job: its safety stop, and what it reports ---------- */

function fakeJob(diffOut: string, codes: Record<string, number> = {}) {
  const ran: string[][] = [];
  const saved: SnapraidJobState[] = [];
  let t = 0;
  return {
    ran,
    saved,
    deps: {
      now: () => (t += 1000),
      log: async () => undefined,
      save: async (s: SnapraidJobState) => void saved.push(s),
      run: async (_cmd: string, args: string[], onOutput: (s: string) => void) => {
        ran.push(args);
        const verb = args.at(-1)!;
        if (verb === "diff") onOutput(diffOut);
        if (verb === "sync") onOutput("45%, 1200 MB, 140 MB/s, CPU 9%, 1:05 ETA\r");
        return codes[verb] ?? (verb === "diff" ? 2 : 0);
      },
    },
  };
}

describe("a SnapRAID job", () => {
  it("syncs, then scrubs, reporting what it did", async () => {
    const f = fakeJob(
      "  1000 equal\n    12 added\n     2 removed\n     1 updated\n     0 moved\n     0 copied\n     0 restored\n",
    );
    const end = await runSnapraidJob(
      { bin: "snapraid", conf: "/etc/snapraid.conf", action: "sync", scrubPercent: 3, by: "test" },
      f.deps,
    );
    expect(f.ran.map((a) => a.slice(2))).toEqual([
      ["touch"],
      ["diff"],
      ["sync"],
      ["scrub", "-p", "3", "-o", "10"],
    ]);
    expect(end).toMatchObject({ ok: true, running: false, diff: { added: 12, removed: 2 } });
    expect(end.result).toMatch(/Synced 12 added, 1 changed, 2 deleted/);
    expect(
      f.saved.some((s) => s.step === "sync" && s.progressPct === 45 && s.etaMinutes === 65),
    ).toBe(true);
  });

  it("stops before syncing when many files were deleted (a missing drive looks like that)", async () => {
    const f = fakeJob("  1000 equal\n     0 added\n  4012 removed\n     0 updated\n");
    const end = await runSnapraidJob(
      { bin: "snapraid", conf: "/etc/snapraid.conf", action: "sync", by: "test" },
      f.deps,
    );
    expect(f.ran.some((a) => a.includes("sync"))).toBe(false);
    expect(end.ok).toBe(false);
    expect(end.result).toMatch(
      /Stopped before syncing: 4012 files were deleted since the last sync \(more than the 50 allowed\)/,
    );
  });

  it("skips the sync when nothing changed, and says a failed step", async () => {
    const quiet = fakeJob("  1000 equal\n     0 added\n     0 removed\n", { diff: 0 });
    const end = await runSnapraidJob(
      { bin: "snapraid", conf: "/c", action: "sync", by: "t" },
      quiet.deps,
    );
    expect(end.result).toBe("Nothing changed since the last sync.");
    const bad = fakeJob("     5 added\n", { sync: 1 });
    expect(
      (await runSnapraidJob({ bin: "snapraid", conf: "/c", action: "sync", by: "t" }, bad.deps)).ok,
    ).toBe(false);
  });

  it("reads diff counts and progress lines", () => {
    expect(parseDiff("   7 equal\n   2 added\n   1 removed\n   0 updated\n").added).toBe(2);
    expect(
      parseProgress(
        "12%, 300 MB, 98 MB/s, CPU 5%, 0:41 ETA\r55%, 900 MB, 101 MB/s, CPU 5%, 0:19 ETA\r",
      ),
    ).toEqual({
      progressPct: 55,
      speedMBs: 101,
      etaMinutes: 19,
    });
  });
});

// The executor's SnapRAID jobs are Linux's (on Windows SnapRAID runs as Hearth's own account).
describe.skipIf(process.platform === "win32")("the executor's snapraid.run checks", () => {
  const deps: RaidDeps = { run: async () => ({ code: 3, out: "" }), wait: async () => undefined };
  it("only snapraid.conf in its usual places, only its actions, and stopping only a running job", async () => {
    await expect(
      snapraidRun(
        { conf: "/tmp/evil.conf", action: "sync" },
        {
          ...deps,
          jobs: { stateDir: "/x", logDir: "/y", program: "/p", config: "/c", node: "/n" },
        },
      ),
    ).rejects.toThrow(/must be one of/);
    await expect(snapraidRun({ conf: "/etc/snapraid.conf", action: "sync" }, deps)).rejects.toThrow(
      /background jobs|must be one of/,
    );
  });
});

/* ---------- through plans, on the simulated machines ---------- */

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup(windows = false) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  let t = Date.now();
  const sample = new SampleRaid({ runMs: 60_000, windows, now: () => t });
  return {
    raid: new RaidService(handle, { sample, hostName: () => "Box" }),
    handle,
    later: (ms: number) => (t += ms),
  };
}
const approved = (params: Record<string, string | number | boolean>): StepRun => ({
  kind: "storage-raid",
  serviceId: "this-host",
  requestedBy: "you",
  params,
  job: { id: "job-1", seq: 1, approvedAt: new Date().toISOString() },
});

describe("SnapRAID through plans", () => {
  for (const windows of [false, true])
    it(`${windows ? "Windows" : "Linux"}: shows the array with its drives, syncs, and reports progress`, async () => {
      const { raid, later } = await setup(windows);
      const r = await raid.report(true);
      const a = r.arrays.find((x) => x.tech === "snapraid")!;
      expect(a).toMatchObject({
        health: "healthy",
        levelText: "1 parity drive, 3 data drives",
        canLose: 1,
      });
      expect(a.members.map((m) => [m.name, m.role, m.serial])).toEqual([
        ["d1", "data", "WD-CA0SNAP1"],
        ["d2", "data", "WD-CA0SNAP2"],
        ["d3", "data", "WD-CA0SNAP3"],
        ["parity", "parity", "VCJPARITY1"],
      ]);
      expect(a.warnings.join(" ")).toMatch(/not protected yet/);
      const p = await raid.plan({
        kind: "storage-raid",
        serviceId: "this-host",
        params: { action: "sync", arrayId: a.id },
      });
      expect(p.policy, p.policyReason).toBe("approve-first");
      expect(p.policyReason).toMatch(/more than 50 files were deleted/);
      expect((await raid.run(approved(p.params!))).ok).toBe(true);
      later(20_000);
      const busy = (await raid.report(true)).arrays.find((x) => x.tech === "snapraid")!;
      expect(busy.health).toBe("resyncing");
      expect(busy.sync?.progressPct).toBeGreaterThan(0);
      expect(busy.actions.find((x) => x.id === "sync")?.status).toBe("running");
      later(60_000);
      const done = (await raid.report(true)).arrays.find((x) => x.tech === "snapraid")!;
      expect(done.lastCheck?.text).toMatch(/Last sync .*Synced 1204 added/);
      expect(done.warnings.join(" ")).not.toMatch(/not protected yet/);
    });

  it("schedules a nightly sync and scrub, which runs as its own plan", async () => {
    const { raid, handle } = await setup();
    const id = (await raid.report(true)).arrays.find((x) => x.tech === "snapraid")!.id;
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "schedule-check", arrayId: id, every: "daily" },
    });
    expect(p.label).toMatch(
      /Let Hearth sync parity and scrub a little of SnapRAID .* every night at 02:00/,
    );
    expect(p.policyReason).toMatch(/stops before syncing if more than 50 files were deleted/);
    expect((await raid.run(approved(p.params!))).ok).toBe(true);
    const jobs = new Jobs(handle, { plan: (s) => raid.plan(s), run: (s) => raid.run(s) });
    raid.useJobs((j) => jobs.create(j));
    const said = await raid.tick(new Date(Date.now() + 2 * 86_400_000));
    expect(said[0]).toMatch(/Started the scheduled sync and scrub of SnapRAID/);
    await jobs.idle();
    const [job] = await jobs.list(5);
    expect(job!.status).toBe("succeeded");
  });

  it("rebuilds a named data drive, and stops a running job", async () => {
    const { raid } = await setup();
    const a = (await raid.report(true)).arrays.find((x) => x.tech === "snapraid")!;
    const fix = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "fix", arrayId: a.id, disk: "d2" },
    });
    expect(fix.label).toMatch(/Rebuild d2's files \(\/mnt\/disk2\/\) from parity/);
    expect((await raid.run(approved(fix.params!))).ok).toBe(true);
    const stop = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "cancel-check", arrayId: a.id },
    });
    expect((await raid.run(approved(stop.params!))).ok).toBe(true);
  });
});
