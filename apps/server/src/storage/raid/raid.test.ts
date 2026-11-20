import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../../config";
import { openDatabase, runMigrations, type DbHandle } from "../../db/client";
import type { StepRun } from "../../jobs/operations";
import { raidCreate, raidMember, raidSync, type RaidDeps } from "../../elevated/raid";
import { fixtureIO } from "./io";
import { mdNames, parseBlocks, readCandidates, readMdArrays } from "./read";
import { SampleRaid } from "./sample";
import { RaidService, arrayLine, nextRun } from "./service";
import { Jobs } from "../../jobs/engine";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup(sample = new SampleRaid({ runMs: 60_000 })) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  return { sample, raid: new RaidService(handle, { sample, hostName: () => "Testbox" }) };
}

const approved = (params: Record<string, string | number | boolean>): StepRun => ({
  kind: "storage-raid",
  serviceId: "this-host",
  requestedBy: "you",
  params,
  job: { id: "job-1", seq: 1, approvedAt: new Date().toISOString() },
});

describe("reading Linux software RAID", () => {
  it("reads a degraded RAID 5 and a RAID 1 being checked, from the kernel's files", async () => {
    const { raid } = await setup();
    const r = await raid.report(true);
    const media = r.arrays.find((a) => a.name === "media")!;
    expect(media).toMatchObject({
      level: "raid5",
      health: "degraded",
      device: "/dev/md0",
      mount: "/srv/media",
      fstype: "ext4",
      inConfig: true,
    });
    expect(media.counts).toEqual({ active: 2, failed: 1, missing: 0, spare: 0 });
    expect(media.canLose).toBe(0);
    const failed = media.members.find((m) => m.role === "faulty")!;
    expect(failed).toMatchObject({
      device: "/dev/sdd1",
      disk: "/dev/sdd",
      serial: "WD-WCC7K1CCCCCC",
      errors: 48,
    });
    expect(media.warnings.join(" ")).toMatch(/No redundancy left/);
    const backup = r.arrays.find((a) => a.name === "backup")!;
    expect(backup.health).toBe("checking");
    expect(backup.sync?.action).toBe("check");
    expect(backup.sync?.progressPct).toBeGreaterThan(0);
    expect(backup.inConfig).toBe(false);
    expect(r.schedules.some((s) => s.by === "system" && /checkarray/.test(s.text))).toBe(true);
  });

  it("offers only drives that are free: never the system, members, or mounted drives", async () => {
    const { raid } = await setup();
    const c = (await raid.report(true)).candidates;
    const by = (d: string) => c.find((x) => x.device === d)!;
    expect(by("/dev/sda")).toMatchObject({ state: "excluded" });
    expect(by("/dev/sda").reason).toMatch(/system/);
    expect(by("/dev/sde")).toMatchObject({ state: "usable", serial: "ZDH1NEWDISK" });
    expect(by("/dev/sdf")).toMatchObject({ state: "has-data" });
    expect(by("/dev/sdb1").state).toBe("excluded");
  });

  it("says what each action needs: blocked, unsupported, running, or available", async () => {
    const { raid } = await setup();
    const r = await raid.report(true);
    const act = (name: string, id: string) =>
      r.arrays.find((a) => a.name === name)!.actions.find((x) => x.id === id)!;
    expect(act("media", "add-disk").status).toBe("available");
    expect(act("media", "mark-failed").status).toBe("blocked");
    expect(act("media", "check").status).toBe("blocked");
    expect(act("media", "change-level").status).toBe("unsupported");
    expect(act("backup", "check").status).toBe("running");
    expect(act("backup", "pause-check").status).toBe("available");
    expect(act("backup", "save-config").status).toBe("available");
  });

  it("parses a hand-written machine too, and leaves loop devices out unless asked", async () => {
    const io = fixtureIO({
      files: {
        "/proc/mdstat": "md5 : active raid1 loop1[1] loop0[0]\n",
        "/sys/block/md5/md/level": "raid1",
        "/sys/block/md5/md/raid_disks": "2",
        "/sys/block/md5/md/array_state": "clean",
        "/sys/block/md5/md/degraded": "0",
        "/sys/block/md5/md/sync_action": "idle",
        "/sys/block/md5/md/component_size": "102400",
        "/sys/block/md5/md/dev-loop0/state": "in_sync",
        "/sys/block/md5/md/dev-loop0/slot": "0",
        "/sys/block/md5/md/dev-loop1/state": "in_sync",
        "/sys/block/md5/md/dev-loop1/slot": "1",
      },
      lsblk: {
        blockdevices: [
          {
            name: "loop0",
            kname: "loop0",
            type: "loop",
            size: 104857600,
            children: [{ name: "md5", kname: "md5", type: "raid1", size: 104792064 }],
          },
          {
            name: "loop1",
            kname: "loop1",
            type: "loop",
            size: 104857600,
            children: [{ name: "md5", kname: "md5", type: "raid1", size: 104792064 }],
          },
        ],
      },
    });
    expect(mdNames("md5 : active raid1 loop1[1] loop0[0]\n")).toEqual(["md5"]);
    const blocks = parseBlocks(await io.lsblk(), true);
    const arrays = await readMdArrays(io, blocks);
    expect(arrays[0]).toMatchObject({
      health: "healthy",
      raidDevices: 2,
      counts: { active: 2, failed: 0, missing: 0, spare: 0 },
    });
    expect(arrays[0]!.members.map((m) => m.disk)).toEqual(["/dev/loop0", "/dev/loop1"]);
    expect(parseBlocks(await io.lsblk(), false)).toEqual([]);
    expect(readCandidates(blocks, arrays).every((c) => c.state === "excluded")).toBe(true);
  });

  it("reads a degraded mirror with no spare as degraded, though newer kernels say recover", async () => {
    const files = (completed: string) => ({
      "/proc/mdstat": "md5 : active raid1 loop0[0]\n",
      "/sys/block/md5/md/level": "raid1",
      "/sys/block/md5/md/raid_disks": "2",
      "/sys/block/md5/md/array_state": "clean",
      "/sys/block/md5/md/degraded": "1",
      "/sys/block/md5/md/sync_action": "recover",
      "/sys/block/md5/md/sync_completed": completed,
      "/sys/block/md5/md/dev-loop0/state": "in_sync",
      "/sys/block/md5/md/dev-loop0/slot": "0",
    });
    const read = async (completed: string) =>
      (
        await readMdArrays(fixtureIO({ files: files(completed), lsblk: { blockdevices: [] } }), [])
      )[0]!;
    expect((await read("none")).health).toBe("degraded");
    expect((await read("none")).sync).toBeUndefined();
    // A progress line with no member to rebuild onto (the moment after a failure, CI 10-29) is
    // still degraded: nothing is being copied.
    expect((await read("2048 / 204800")).health).toBe("degraded");
    // With a new member taking the empty slot, the same progress is a real rebuild.
    const rebuilding = (
      await readMdArrays(
        fixtureIO({
          files: {
            ...files("2048 / 204800"),
            "/proc/mdstat": "md5 : active raid1 loop1[2] loop0[0]\n",
            "/sys/block/md5/md/dev-loop1/state": "spare",
            "/sys/block/md5/md/dev-loop1/slot": "1",
          },
          lsblk: { blockdevices: [] },
        }),
        [],
      )
    )[0]!;
    expect(rebuilding.health).toBe("rebuilding");
    expect(rebuilding.members.some((m) => m.role === "rebuilding")).toBe(true);
  });

  it("never offers a scrap partition next to one in use (a Windows reserved partition on a media drive)", () => {
    // The home server's real layout, 10-24: each USB media drive has a 16 MB reserved partition and its
    // NTFS partition mounted.
    const blocks = parseBlocks(
      JSON.stringify({
        blockdevices: [
          {
            name: "sda",
            kname: "sda",
            type: "disk",
            size: 22e12,
            serial: "ZX298C7Z",
            children: [
              { name: "sda1", kname: "sda1", pkname: "sda", type: "part", size: 16777216 },
              {
                name: "sda2",
                kname: "sda2",
                pkname: "sda",
                type: "part",
                size: 22e12,
                fstype: "ntfs",
                mountpoint: "/mnt/f",
              },
            ],
          },
        ],
      }),
    );
    const c = readCandidates(blocks, []);
    expect(c.every((x) => x.state === "excluded")).toBe(true);
    expect(c.find((x) => x.device === "/dev/sda1")?.reason).toMatch(
      /Another part of this drive is in use/,
    );
  });

  it("writes mdadm.conf lines in mdadm's own form", async () => {
    const { raid } = await setup();
    const backup = (await raid.report(true)).arrays.find((a) => a.name === "backup")!;
    expect(arrayLine(backup, "Testbox")).toBe(
      "ARRAY /dev/md/backup metadata=1.2 UUID=a1b2c3d4:e5f64711:8899aabb:ccddeeff name=Testbox:backup",
    );
  });
});

describe("approved RAID changes", () => {
  it("plans a rebuild onto a new drive with the exact drive, then runs it", async () => {
    const { raid } = await setup();
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "add-disk", arrayId: "mdadm:md0", device: "/dev/sde" },
    });
    expect(p.policy).toBe("approve-first");
    expect(p.label).toContain("ZDH1NEWDISK");
    expect(p.label).toContain("Testbox");
    const out = await raid.run(approved(p.params!));
    expect(out.ok).toBe(true);
    const media = (await raid.report(true)).arrays.find((a) => a.name === "media")!;
    expect(media.health).toBe("rebuilding");
    expect(media.members.some((m) => m.device === "/dev/sde" && m.role === "rebuilding")).toBe(
      true,
    );
  });

  it("never erases a drive with data unless that was approved, and stops when the drive changed", async () => {
    const { raid } = await setup();
    const refused = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "add-spare", arrayId: "mdadm:md0", device: "/dev/sdf" },
    });
    expect(refused.policy).toBe("refuse");
    expect(refused.policyReason).toMatch(/holds data/);
    const ok = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "add-spare", arrayId: "mdadm:md0", device: "/dev/sde" },
    });
    expect(ok.policy).toBe("approve-first");
    const swapped = await raid.run(approved({ ...ok.params!, serial: "SOMEOTHERDRIVE" }));
    expect(swapped.ok).toBe(false);
    expect(swapped.result).toMatch(/not the one approved/);
  });

  it("refuses to fail a member when nothing is left to lose, and never offers the system drive", async () => {
    const { raid } = await setup();
    const fail = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "mark-failed", arrayId: "mdadm:md0", device: "/dev/sdb1" },
    });
    expect(fail.policy).toBe("refuse");
    const sys = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "add-spare", arrayId: "mdadm:md1", device: "/dev/sda" },
    });
    expect(sys.policy).toBe("refuse");
    expect(sys.policyReason).toMatch(/system/);
  });

  it("creating an array names every drive it erases and says RAID is not a backup", async () => {
    const { raid } = await setup();
    const withData = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "create", level: "raid1", devices: "/dev/sde,/dev/sdf", name: "photos" },
    });
    expect(withData.policy).toBe("refuse");
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: {
        action: "create",
        level: "raid1",
        devices: "/dev/sde,/dev/sdf",
        eraseDevices: "/dev/sdf",
        name: "photos",
      },
    });
    expect(p.policy).toBe("approve-first");
    expect(p.policyReason).toMatch(/ERASES EVERYTHING on \/dev\/sde, \/dev\/sdf/);
    expect(p.policyReason).toMatch(/not a backup/);
    expect((await raid.run(approved(p.params!))).ok).toBe(true);
    expect((await raid.report(true)).arrays.some((a) => a.name === "photos")).toBe(true);
  });

  it("pauses a running check, remembers where, and resumes it", async () => {
    const { raid } = await setup();
    const pause = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "pause-check", arrayId: "mdadm:md1" },
    });
    expect((await raid.run(approved(pause.params!))).ok).toBe(true);
    let backup = (await raid.report(true)).arrays.find((a) => a.name === "backup")!;
    expect(backup.sync?.paused).toBe(true);
    expect(backup.actions.find((x) => x.id === "resume-check")?.status).toBe("available");
    const resume = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "resume-check", arrayId: "mdadm:md1" },
    });
    expect((await raid.run(approved(resume.params!))).ok).toBe(true);
    backup = (await raid.report(true)).arrays.find((a) => a.name === "backup")!;
    expect(backup.sync?.action).toBe("check");
  });

  it("runs scheduled checks only under the approved schedule, skipping a busy array", async () => {
    const { raid } = await setup();
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "schedule-check", arrayId: "mdadm:md1", every: "weekly" },
    });
    expect(p.policy).toBe("approve-first");
    expect((await raid.run(approved(p.params!))).ok).toBe(true);
    const later = new Date(Date.now() + 9 * 86_400_000);
    const due = await raid.due(later);
    expect(due).toHaveLength(1);
    expect(due[0]!.skip).toMatch(/busy|running|check/i);
    // A scheduled step without a schedule is refused.
    const rogue = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "check", arrayId: "mdadm:md0", scheduled: true },
    });
    expect(rogue.policy).toBe("refuse");
    expect(nextRun("monthly", new Date("2026-10-24T12:00:00")).getDate()).toBeLessThanOrEqual(7);
  });
});

describe("RAID through plans, as Ember proposes them", () => {
  it("an agent's plan waits for approval, then runs and is read back", async () => {
    const { raid } = await setup();
    const jobs = new Jobs(handles.at(-1)!, { plan: (s) => raid.plan(s), run: (s) => raid.run(s) });
    const job = await jobs.create({
      title: "Rebuild media onto the new drive",
      requestedBy: "agent",
      steps: [
        {
          kind: "storage-raid",
          serviceId: "this-host",
          params: { action: "add-disk", arrayId: "mdadm:md0", device: "/dev/sde" },
        },
      ],
    });
    expect(job.status).toBe("awaiting-approval");
    expect(job.steps[0]!.policyReason).toMatch(/superblock/);
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/rebuilding/);
  });

  it("a scheduled check becomes its own recorded plan under the approved schedule", async () => {
    let t = Date.now();
    const sample = new SampleRaid({ now: () => t, runMs: 60_000 });
    const { raid } = await setup(sample);
    const jobs = new Jobs(handles.at(-1)!, { plan: (s) => raid.plan(s), run: (s) => raid.run(s) });
    raid.useJobs((j) => jobs.create(j));
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: { action: "schedule-check", arrayId: "mdadm:md1", every: "weekly" },
    });
    await raid.run(approved(p.params!));
    t += 11 * 60_000; // the running check finishes
    const said = await raid.tick(new Date(Date.now() + 9 * 86_400_000));
    expect(said[0]).toMatch(/Started the scheduled consistency check of backup/);
    await jobs.idle();
    const [job] = await jobs.list(5);
    expect(job!.requestedBy).toBe("dragon-control");
    expect(job!.steps[0]!.policyReason).toMatch(/schedule you approved/);
    expect(job!.status).toBe("succeeded");
    const backup = (await raid.report(true)).arrays.find((a) => a.name === "backup")!;
    expect(backup.sync?.action).toBe("check");
  });
});

/** The elevated executor's own checks, against a stand-in machine. */
function fakeMachine(
  opts: { serial?: string; signatures?: string[]; mounted?: string; system?: boolean } = {},
) {
  const files: Record<string, string> = {
    "/proc/mdstat": "md0 : active raid1 sdb1[0]\n",
    "/sys/block/md0/md/level": "raid1",
    "/sys/block/md0/md/raid_disks": "2",
    "/sys/block/md0/md/degraded": "1",
    "/sys/block/md0/md/sync_action": "idle",
    "/sys/block/md0/md/dev-sdb1/state": "in_sync",
  };
  const ran: string[][] = [];
  const deps: RaidDeps = {
    async run(cmd, args) {
      ran.push([cmd, ...args]);
      if (cmd === "lsblk") {
        const k = (args.at(-1) ?? "").replace(/^\/dev\//, "").replace(/\d+$/, "");
        const disk = {
          name: k,
          kname: k,
          type: "disk",
          serial: opts.serial ?? "NEWSERIAL",
          mountpoint: opts.system ? "/" : null,
          children: opts.mounted
            ? [{ name: `${k}1`, kname: `${k}1`, type: "part", mountpoint: opts.mounted }]
            : [],
        };
        return { code: 0, out: JSON.stringify({ blockdevices: [disk] }) };
      }
      if (cmd === "wipefs" && args[0] === "--no-act")
        return {
          code: 0,
          out: JSON.stringify({ signatures: (opts.signatures ?? []).map((type) => ({ type })) }),
        };
      if (cmd === "mdadm" && args.includes("--add")) {
        files[`/sys/block/md0/md/dev-${(args.at(-1) ?? "").replace("/dev/", "")}/state`] = "spare";
        return { code: 0, out: "" };
      }
      if (cmd === "mdadm" && args[0] === "--create") {
        files["/sys/block/md1/md/level"] = "raid1";
        return { code: 0, out: "" };
      }
      return { code: 0, out: "" };
    },
    wait: async () => undefined,
    sys: {
      read: async (p) => files[p],
      write: async (p, v) => {
        files[p] = v;
      },
      isBlock: async (p) => /^\/dev\/sd/.test(p),
    },
  };
  return { deps, ran, files };
}

describe("the elevated executor's RAID checks", () => {
  it("adds an empty, approved drive and reads it back", async () => {
    const m = fakeMachine();
    const r = await raidMember(
      { array: "/dev/md0", action: "add", device: "/dev/sdc", serial: "NEWSERIAL" },
      m.deps,
    );
    expect(r.result).toMatch(/joined \/dev\/md0/);
    expect(m.ran).toContainEqual(["mdadm", "--manage", "/dev/md0", "--add", "/dev/sdc"]);
  });

  it("refuses the system drive, a mounted drive, another drive, and data it was not told to erase", async () => {
    await expect(
      raidMember(
        { array: "/dev/md0", action: "add", device: "/dev/sdc" },
        fakeMachine({ system: true }).deps,
      ),
    ).rejects.toThrow(/system/);
    await expect(
      raidMember(
        { array: "/dev/md0", action: "add", device: "/dev/sdc" },
        fakeMachine({ mounted: "/mnt/x" }).deps,
      ),
    ).rejects.toThrow(/mounted/);
    await expect(
      raidMember(
        { array: "/dev/md0", action: "add", device: "/dev/sdc", serial: "OTHER" },
        fakeMachine().deps,
      ),
    ).rejects.toThrow(/not the one approved/);
    const data = fakeMachine({ signatures: ["ntfs"] });
    await expect(
      raidMember(
        { array: "/dev/md0", action: "add", device: "/dev/sdc", serial: "NEWSERIAL" },
        data.deps,
      ),
    ).rejects.toThrow(/holds ntfs/);
    expect(data.ran.some((c) => c[0] === "mdadm")).toBe(false);
    const erase = fakeMachine({ signatures: ["ntfs"] });
    await raidMember(
      { array: "/dev/md0", action: "add", device: "/dev/sdc", serial: "NEWSERIAL", erase: true },
      erase.deps,
    );
    expect(erase.ran).toContainEqual(["wipefs", "--all", "/dev/sdc"]);
  });

  it("never fails a member of an array with no redundancy left, and takes no free-form names", async () => {
    const m = fakeMachine();
    await expect(
      raidMember({ array: "/dev/md0", action: "fail", device: "/dev/sdb1" }, m.deps),
    ).rejects.toThrow(/no redundancy/);
    await expect(
      raidMember({ array: "/dev/md0; rm -rf /", action: "add", device: "/dev/sdc" }, m.deps),
    ).rejects.toThrow(/named like/);
    await expect(
      raidMember({ array: "/dev/md0", action: "add", device: "/dev/loop0" }, m.deps),
    ).rejects.toThrow(/Loop devices/);
  });

  it("starts a check only on a whole, idle array", async () => {
    const m = fakeMachine();
    await expect(raidSync({ array: "/dev/md0", action: "check" }, m.deps)).rejects.toThrow(
      /degraded/,
    );
    m.files["/sys/block/md0/md/degraded"] = "0";
    m.files["/sys/block/md0/md/sync_action"] = "idle";
    const deps = {
      ...m.deps,
      wait: async () => void (m.files["/sys/block/md0/md/sync_action"] = "check"),
    };
    const r = await raidSync({ array: "/dev/md0", action: "check" }, deps);
    expect(r.result).toMatch(/consistency check started/);
    expect(m.files["/sys/block/md0/md/sync_min"]).toBe("0");
  });

  it("creates an array with a bitmap from checked drives", async () => {
    const m = fakeMachine();
    m.files["/proc/mdstat"] = "md0 : active raid1 sdb1[0]\n";
    const deps = {
      ...m.deps,
      sys: {
        ...m.deps.sys!,
        isBlock: async (p: string) => /^\/dev\/sd/.test(p) || p === "/dev/md0",
      },
    };
    const r = await raidCreate(
      {
        level: "raid1",
        name: "photos",
        devices: [
          { device: "/dev/sdc", serial: "NEWSERIAL" },
          { device: "/dev/sdd", serial: "NEWSERIAL" },
        ],
      },
      deps,
    );
    expect(r.target).toBe("/dev/md1");
    const create = m.ran.find((c) => c[1] === "--create")!;
    expect(create).toEqual(
      expect.arrayContaining([
        "--level=raid1",
        "--raid-devices=2",
        "--bitmap=internal",
        "--name=photos",
      ]),
    );
  });
});
