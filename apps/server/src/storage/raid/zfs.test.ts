import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../../config";
import { openDatabase, runMigrations, type DbHandle } from "../../db/client";
import type { StepRun } from "../../jobs/operations";
import { Jobs } from "../../jobs/engine";
import { zfsCreate, zfsMember, zfsScrub } from "../../elevated/zfs";
import type { RaidDeps } from "../../elevated/raid";
import { parseBlocks } from "./read";
import { SampleRaid } from "./sample";
import { RaidService } from "./service";
import { parseZpoolList, parseZpoolStatus, poolToArray, zfsActions } from "./zfs";

// zpool status -P -L as OpenZFS 2.1 to 2.2 print it (tabs and two-space steps).
const HEALTHY = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 05:12:44 with 0 errors on Sun Oct 12 05:36:45 2026
config:

\tNAME           STATE     READ WRITE CKSUM
\ttank           ONLINE       0     0     0
\t  raidz2-0     ONLINE       0     0     0
\t    /dev/sdb1  ONLINE       0     0     0
\t    /dev/sdc1  ONLINE       0     0     0
\t    /dev/sdd1  ONLINE       0     0     0
\t    /dev/sde1  ONLINE       0     0     0

errors: No known data errors
`;

const DEGRADED = `  pool: media
 state: DEGRADED
status: One or more devices could not be used because the label is missing or
\tinvalid.  Sufficient replicas exist for the pool to continue
\tfunctioning in a degraded state.
action: Replace the device using 'zpool replace'.
   see: https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-4J
  scan: scrub in progress since Fri Oct 23 22:00:01 2026
\t1.23T / 4.56T scanned at 456M/s, 1.00T / 4.56T issued at 400M/s
\t0B repaired, 21.93% done, 02:30:10 to go
config:

\tNAME                      STATE     READ WRITE CKSUM
\tmedia                     DEGRADED     0     0     0
\t  raidz1-0                DEGRADED     0     0     0
\t    /dev/sdb1             ONLINE       0     0     2
\t    /dev/sdc1             ONLINE       0     0     0
\t    9876543210123456789   UNAVAIL      0     0     0  was /dev/sdd1
\tlogs
\t  /dev/nvme0n1p4          ONLINE       0     0     0
\tcache
\t  /dev/nvme0n1p5          ONLINE       0     0     0
\tspares
\t  /dev/sdf1               AVAIL

errors: No known data errors
`;

const RESILVER = `  pool: vault
 state: DEGRADED
status: One or more devices is currently being resilvered.  The pool will
\tcontinue to function, possibly in a degraded state.
action: Wait for the resilver to complete.
  scan: resilver in progress since Sat Oct 24 09:00:00 2026
\t812G / 3.62T scanned at 1.10G/s, 400G / 3.62T issued at 540M/s
\t400G resilvered, 10.80% done, 1 days 02:03:04 to go
config:

\tNAME             STATE     READ WRITE CKSUM
\tvault            DEGRADED     0     0     0
\t  mirror-0       ONLINE       0     0     0
\t    /dev/sda1    ONLINE       0     0     0
\t    /dev/sdb1    ONLINE       0     0     0
\t  mirror-1       DEGRADED     0     0     0
\t    replacing-0  DEGRADED     0     0     0
\t      /dev/sdc1  FAULTED     12     0     0  too many errors
\t      /dev/sdg1  ONLINE       0     0     0  (resilvering)
\t    /dev/sdd1    ONLINE       0     0     0

errors: 2 data errors, use '-v' for a list
`;

const lsblk = {
  blockdevices: ["sdb", "sdc", "sdd", "sde", "sdf", "sdg"].map((k, i) => ({
    name: k,
    kname: k,
    type: "disk",
    size: 4e12,
    model: "WDC WD40EFRX",
    serial: `SER${i}`,
    children: [{ name: `${k}1`, kname: `${k}1`, type: "part", size: 4e12, fstype: "zfs_member" }],
  })),
};

describe("reading ZFS pools", () => {
  it("reads a healthy RAID-Z2 pool, its drives, and its last scrub", () => {
    const [p] = parseZpoolStatus(HEALTHY);
    expect(p).toMatchObject({ name: "tank", state: "ONLINE" });
    expect(p!.vdevs).toHaveLength(1);
    expect(p!.vdevs[0]).toMatchObject({ name: "raidz2-0", type: "raidz2" });
    expect(p!.vdevs[0]!.leaves.map((l) => l.name)).toEqual([
      "/dev/sdb1",
      "/dev/sdc1",
      "/dev/sdd1",
      "/dev/sde1",
    ]);
    const a = poolToArray(p!, {
      blocks: parseBlocks(JSON.stringify(lsblk)),
      info: parseZpoolList(
        "tank\t16000000000000\t4000000000000\t12000000000000\tONLINE\t123\toff\t-\t2%\t25%\n",
      ),
      datasets: new Map([["tank", { used: 2e12, available: 5e12, mountpoint: "/tank" }]]),
      now: Date.parse("2026-10-24T12:00:00Z"),
    });
    expect(a).toMatchObject({
      id: "zfs:tank",
      tech: "zfs",
      health: "healthy",
      level: "raidz2",
      levelText: "RAID-Z2, 4 drives",
      canLose: 2,
      sizeBytes: 7e12,
      rawBytes: 16e12,
      mount: "/tank",
      uuid: "123",
    });
    expect(a.members[0]).toMatchObject({
      device: "/dev/sdb1",
      disk: "/dev/sdb",
      serial: "SER0",
      role: "active",
      group: "raidz2-0",
    });
    expect(a.lastCheck?.text).toMatch(/Last scrub 2026-10-12: no errors/);
    expect(a.warnings).toEqual([]);
  });

  it("reads a degraded pool: the missing drive, a scrub in progress, logs, cache, and a spare", () => {
    const [p] = parseZpoolStatus(DEGRADED);
    expect(p!.vdevs).toHaveLength(1);
    expect(p!.logs).toHaveLength(1);
    expect(p!.cache.map((l) => l.name)).toEqual(["/dev/nvme0n1p5"]);
    expect(p!.spares.map((l) => [l.name, l.state])).toEqual([["/dev/sdf1", "AVAIL"]]);
    const missing = p!.vdevs[0]!.leaves[2]!;
    expect(missing).toMatchObject({
      name: "9876543210123456789",
      state: "UNAVAIL",
      note: "was /dev/sdd1",
    });
    const a = poolToArray(p!, {
      blocks: parseBlocks(JSON.stringify(lsblk)),
      info: new Map(),
      datasets: new Map(),
    });
    expect(a.health).toBe("degraded");
    expect(a.canLose).toBe(0);
    expect(a.sync).toMatchObject({ action: "scrub", progressPct: 21.9, etaMinutes: 150 });
    expect(a.sync?.speedKiBs).toBe(409600);
    const gone = a.members.find((m) => m.device === "9876543210123456789")!;
    // The missing drive is still named by its old place, so the right one is pulled.
    expect(gone).toMatchObject({ role: "faulty", disk: "/dev/sdd", serial: "SER2" });
    expect(a.members.find((m) => m.device === "/dev/sdf1")?.role).toBe("spare");
    expect(a.members.find((m) => m.device === "/dev/nvme0n1p4")?.role).toBe("log");
    expect(a.members.find((m) => m.device === "/dev/sdb1")?.errorCounts).toEqual({
      read: 0,
      write: 0,
      checksum: 2,
    });
    expect(a.warnings.join(" ")).toMatch(/No redundancy left/);
    expect(a.warnings.join(" ")).toMatch(/2 checksum errors/);
    expect(a.notes?.[0]).toMatch(/label is missing or invalid/);
  });

  it("reads a rebuild onto a new drive inside a mirror, and damaged data", () => {
    const [p] = parseZpoolStatus(RESILVER);
    expect(p!.vdevs.map((v) => [v.name, v.leaves.length])).toEqual([
      ["mirror-0", 2],
      ["mirror-1", 3],
    ]);
    const a = poolToArray(p!, {
      blocks: parseBlocks(JSON.stringify(lsblk)),
      info: new Map(),
      datasets: new Map(),
    });
    expect(a.health).toBe("rebuilding");
    expect(a.levelText).toBe("Mirror, 2 groups of 2");
    expect(a.sync).toMatchObject({ action: "resilver", progressPct: 10.8, etaMinutes: 1563 });
    expect(a.members.find((m) => m.device === "/dev/sdg1")?.role).toBe("rebuilding");
    expect(a.members.find((m) => m.device === "/dev/sdc1")?.role).toBe("faulty");
    // mirror-1 still has /dev/sdd1; the faulted drive is the one copy it lost.
    expect(a.canLose).toBe(0);
    expect(a.dataErrors?.count).toBe(2);
    expect(a.warnings.join(" ")).toMatch(/restoring from a backup/);
  });

  it("decides what can be done: scrubs, replacing, offline, and RAID-Z expansion by version", () => {
    const [p] = parseZpoolStatus(HEALTHY);
    const a = poolToArray(p!, { blocks: [], info: new Map(), datasets: new Map() });
    a.members.forEach((m) => (m.sizeBytes = 4e12));
    const free = [
      { device: "/dev/sdx", kind: "disk" as const, state: "usable" as const, sizeBytes: 4e12 },
    ];
    const by = (v: string | undefined, ready = true) =>
      Object.fromEntries(
        zfsActions(a, {
          candidates: free,
          ready: { ready, why: "Not set up." },
          ...(v ? { version: v } : {}),
        }).map((x) => [x.id, x]),
      );
    const old = by("2.2.2");
    expect(old.check!.status).toBe("available");
    expect(old.replace!.status).toBe("available");
    expect(old["mark-failed"]!.status).toBe("available");
    expect(old["grow-devices"]!.status).toBe("unsupported");
    expect(old["grow-devices"]!.reason).toMatch(/OpenZFS 2.3/);
    expect(old["change-level"]!.status).toBe("unsupported");
    expect(old["add-disk"]!.status).toBe("unsupported");
    expect(by("2.3.1")["grow-devices"]!.status).toBe("available");
    const off = by("2.3.1", false);
    expect(off.check!.status).toBe("blocked");
    expect(off.check!.reason).toMatch(/Not set up/);
    expect(off["schedule-check"]!.status).toBe("available");
  });
});

/* ---------- through plans, on the simulated machine ---------- */

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup(sample = new SampleRaid({ runMs: 60_000 })) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  return { sample, raid: new RaidService(handle, { sample, hostName: () => "Testbox" }), handle };
}

const approved = (params: Record<string, string | number | boolean>): StepRun => ({
  kind: "storage-raid",
  serviceId: "this-host",
  requestedBy: "you",
  params,
  job: { id: "job-1", seq: 1, approvedAt: new Date().toISOString() },
});

describe("ZFS through plans", () => {
  it("shows the pool beside the mdadm arrays, and never offers its drives", async () => {
    const { raid } = await setup();
    const r = await raid.report(true);
    const tank = r.arrays.find((a) => a.id === "zfs:tank")!;
    expect(tank).toMatchObject({
      tech: "zfs",
      health: "healthy",
      level: "raidz2",
      canLose: 2,
      mount: "/mnt/tank",
    });
    expect(tank.members).toHaveLength(6);
    expect(tank.members.find((m) => m.device === "/dev/sdl1")?.errorCounts?.checksum).toBe(3);
    expect(r.candidates.find((c) => c.device === "/dev/sdi")).toMatchObject({
      state: "excluded",
      reason: "Already in tank (ZFS pool).",
    });
    expect(r.candidates.find((c) => c.device === "/dev/sdo")?.state).toBe("usable");
    expect(r.tech.find((t) => t.tech === "zfs")).toMatchObject({
      support: "manage",
      seen: "1 pool: tank",
    });
    expect(r.create?.map((c) => c.tech)).toEqual(["mdadm", "zfs", "btrfs"]);
    expect(r.schedules.some((s) => /second Sunday/.test(s.text))).toBe(true);
  });

  it("replaces the drive with checksum errors, planned with both serials, and rebuilds", async () => {
    const { raid } = await setup();
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "replace", arrayId: "zfs:tank", replaces: "/dev/sdl1", device: "/dev/sdo" },
    });
    expect(p.policy).toBe("approve-first");
    expect(p.label).toMatch(/Replace .*ZRT0A4PRO.* with .*ZL2NEWTWELVE.* in pool tank/);
    // A drive too small for the pool is refused at planning.
    const small = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "replace", arrayId: "zfs:tank", replaces: "/dev/sdl1", device: "/dev/sde" },
    });
    expect(small.policy).toBe("refuse");
    expect(small.policyReason).toMatch(/too small/);
    const out = await raid.run(approved(p.params!));
    expect(out.ok).toBe(true);
    const tank = (await raid.report(true)).arrays.find((a) => a.id === "zfs:tank")!;
    expect(tank.health).toBe("rebuilding");
    expect(tank.sync?.action).toBe("resilver");
    expect(tank.members.find((m) => m.device === "/dev/sdo1")?.role).toBe("rebuilding");
  });

  it("scrubs, pauses, resumes, and stops", async () => {
    const { raid } = await setup();
    const step = async (action: string) => {
      const p = await raid.plan({
        kind: "storage-raid",
        serviceId: "this-host",
        params: { action, arrayId: "zfs:tank" },
      });
      expect(p.policy, p.policyReason).toBe("approve-first");
      const r = await raid.run(approved(p.params!));
      expect(r.ok, r.result).toBe(true);
      return (await raid.report(true)).arrays.find((a) => a.id === "zfs:tank")!;
    };
    expect((await step("check")).health).toBe("checking");
    expect((await step("pause-check")).sync).toMatchObject({ action: "scrub", paused: true });
    expect((await step("resume-check")).health).toBe("checking");
    const stopped = await step("cancel-check");
    expect(stopped.lastCheck?.text).toMatch(/cancelled/);
  });

  it("schedules a weekly scrub that runs as its own plan", async () => {
    const { raid, handle } = await setup();
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "schedule-check", arrayId: "zfs:tank", every: "weekly" },
    });
    expect(p.label).toMatch(
      /Let Hearth scrub tank \(RAID-Z2, 6 drives\) on Testbox every Sunday at 02:00/,
    );
    expect((await raid.run(approved(p.params!))).ok).toBe(true);
    const jobs = new Jobs(handle, { plan: (s) => raid.plan(s), run: (s) => raid.run(s) });
    raid.useJobs((j) => jobs.create(j));
    const said = await raid.tick(new Date(Date.now() + 8 * 86_400_000));
    expect(said[0]).toMatch(/Started the scheduled scrub of tank/);
    await jobs.idle();
    const [job] = await jobs.list(5);
    expect(job!.status).toBe("succeeded");
    expect((await raid.report(true)).arrays.find((a) => a.id === "zfs:tank")!.health).toBe(
      "checking",
    );
  });

  it("plans a new pool from whole drives, naming what it erases", async () => {
    const { raid } = await setup();
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: {
        action: "create",
        tech: "zfs",
        level: "mirror",
        devices: "/dev/sde,/dev/sdf",
        eraseDevices: "/dev/sdf",
        name: "photos",
      },
    });
    expect(p.policy, p.policyReason).toBe("approve-first");
    expect(p.label).toMatch(/Create a ZFS Mirror pool "photos" .* mounted at \/mnt\/photos/);
    expect(p.policyReason).toMatch(/ERASES EVERYTHING on \/dev\/sde, \/dev\/sdf/);
    expect(p.policyReason).toMatch(/not a backup/);
    expect((await raid.run(approved(p.params!))).ok).toBe(true);
    expect((await raid.report(true)).arrays.some((a) => a.id === "zfs:photos")).toBe(true);
  });
});

/* ---------- the elevated executor's ZFS checks ---------- */

function fakeZfs(
  opts: { inPool?: string; signatures?: string[]; serial?: string; mounted?: string } = {},
) {
  const ran: string[][] = [];
  const status = `  pool: tank\n state: ONLINE\nconfig:\n\n\tNAME        STATE     READ WRITE CKSUM\n\ttank        ONLINE       0     0     0\n\t  mirror-0  ONLINE       0     0     0\n\t    /dev/sdb1  ONLINE       0     0     0\n\t    /dev/sdc1  ONLINE       0     0     0\n${opts.inPool ? `\t    ${opts.inPool}  ONLINE       0     0     0\n` : ""}\nerrors: No known data errors\n`;
  const guids = status
    .replace("/dev/sdb1", "1111111111111111111")
    .replace("/dev/sdc1", "2222222222222222222")
    .replace("mirror-0", "3333333333333333333");
  let pools = ["tank"];
  const deps: RaidDeps = {
    async run(cmd, args) {
      ran.push([cmd, ...args]);
      if (cmd === "zpool" && args[0] === "status")
        return { code: 0, out: args.includes("-g") ? guids : status };
      if (cmd === "zpool" && args[0] === "list") {
        const name = args.at(-1)!;
        return pools.includes(name)
          ? { code: 0, out: `${name}\n` }
          : { code: 1, out: "no such pool" };
      }
      if (cmd === "systemd-run") return { code: 127, out: "not here" };
      if (cmd === "zpool" && args[0] === "create") {
        pools.push(args[args.indexOf("-m") + 2]!);
        return { code: 0, out: "" };
      }
      if (cmd === "lsblk") {
        const k = (args.at(-1) ?? "").replace(/^\/dev\//, "").replace(/\d+$/, "");
        return {
          code: 0,
          out: JSON.stringify({
            blockdevices: [
              {
                name: k,
                kname: k,
                type: "disk",
                serial: opts.serial ?? "NEWSERIAL",
                mountpoint: opts.mounted ?? null,
                children: [],
              },
            ],
          }),
        };
      }
      if (cmd === "wipefs" && args[0] === "--no-act")
        return {
          code: 0,
          out: JSON.stringify({ signatures: (opts.signatures ?? []).map((type) => ({ type })) }),
        };
      return { code: 0, out: "" };
    },
    wait: async () => undefined,
    sys: {
      read: async (p) => (p === "/proc/mdstat" ? "" : undefined),
      write: async () => undefined,
      isBlock: async (p) => /^\/dev\/sd/.test(p),
    },
  };
  return { deps, ran, setPools: (p: string[]) => (pools = p) };
}

describe("the elevated executor's ZFS checks", () => {
  it("replaces a member by its GUID with an empty, approved drive", async () => {
    const { deps, ran } = fakeZfs();
    const r = await zfsMember(
      {
        pool: "tank",
        action: "replace",
        replaces: "/dev/sdc1",
        device: "/dev/sdx",
        serial: "NEWSERIAL",
      },
      deps,
    ).catch((e: Error) => e);
    // The fake pool does not show the new drive afterwards, so the read-back fails: but the
    // command it ran named the old drive by GUID and the new one by its path.
    expect(ran).toContainEqual(["zpool", "replace", "tank", "2222222222222222222", "/dev/sdx"]);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/does not show/);
  });

  it("refuses a drive already in a pool, one holding data, a partition, and a wrong serial", async () => {
    await expect(
      zfsMember(
        { pool: "tank", action: "add-spare", device: "/dev/sdd" },
        fakeZfs({ inPool: "/dev/sdd1" }).deps,
      ),
    ).rejects.toThrow(/imported ZFS pool/);
    await expect(
      zfsMember(
        { pool: "tank", action: "add-spare", device: "/dev/sdd" },
        fakeZfs({ signatures: ["ntfs"] }).deps,
      ),
    ).rejects.toThrow(/holds ntfs/);
    await expect(
      zfsMember({ pool: "tank", action: "add-spare", device: "/dev/sdd1" }, fakeZfs().deps),
    ).rejects.toThrow(/whole drives/);
    await expect(
      zfsMember(
        { pool: "tank", action: "add-spare", device: "/dev/sdd", serial: "OTHER" },
        fakeZfs().deps,
      ),
    ).rejects.toThrow(/not the one approved/);
    await expect(
      zfsMember(
        { pool: "tank", action: "add-spare", device: "/dev/sdd" },
        fakeZfs({ mounted: "/" }).deps,
      ),
    ).rejects.toThrow(/holds the system/);
    await expect(
      zfsMember({ pool: "tank; rm", action: "offline", device: "/dev/sdb1" }, fakeZfs().deps),
    ).rejects.toThrow(/name is not valid/);
    await expect(
      zfsMember({ pool: "tank", action: "offline", device: "/dev/sdz1" }, fakeZfs().deps),
    ).rejects.toThrow(/not a drive in tank/);
  });

  it("creates a pool with fixed options, mounted under /mnt", async () => {
    const { deps, ran } = fakeZfs();
    const r = await zfsCreate(
      {
        name: "photos",
        level: "mirror",
        devices: [
          { device: "/dev/sdd", serial: "NEWSERIAL" },
          { device: "/dev/sde", serial: "NEWSERIAL" },
        ],
      },
      deps,
    );
    expect(r.result).toMatch(/Created the ZFS pool photos \(mirror\)/);
    expect(ran).toContainEqual([
      "zpool",
      "create",
      "-o",
      "ashift=12",
      "-O",
      "compression=lz4",
      "-O",
      "atime=off",
      "-m",
      "/mnt/photos",
      "photos",
      "mirror",
      "/dev/sdd",
      "/dev/sde",
    ]);
    await expect(
      zfsCreate(
        {
          name: "tank",
          level: "mirror",
          devices: [{ device: "/dev/sdd" }, { device: "/dev/sde" }],
        },
        deps,
      ),
    ).rejects.toThrow(/already exists/);
    await expect(
      zfsCreate({ name: "x", level: "raidz2", devices: [{ device: "/dev/sdd" }] }, deps),
    ).rejects.toThrow(/at least 4/);
  });

  it("never stops a rebuild", async () => {
    const { deps } = fakeZfs();
    const d: RaidDeps = {
      ...deps,
      run: async (cmd, args) =>
        cmd === "zpool" && args[0] === "status" && args.length === 2
          ? { code: 0, out: "  scan: resilver in progress since now\n" }
          : deps.run(cmd, args),
    };
    await expect(zfsScrub({ pool: "tank", action: "cancel" }, d)).rejects.toThrow(
      /rebuild is never stopped/,
    );
    await expect(zfsScrub({ pool: "tank", action: "start" }, d)).rejects.toThrow(/rebuilding/);
  });
});
