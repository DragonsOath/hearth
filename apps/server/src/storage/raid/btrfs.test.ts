import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../../config";
import { openDatabase, runMigrations, type DbHandle } from "../../db/client";
import type { StepRun } from "../../jobs/operations";
import { btrfsBalance, btrfsMember } from "../../elevated/btrfs";
import type { RaidDeps } from "../../elevated/raid";
import { btrfsActions, btrfsToArray, parseScrub, parseStats, readBtrfs } from "./btrfs";
import { fixtureIO } from "./io";
import { parseBlocks } from "./read";
import { SampleRaid } from "./sample";
import { RaidService } from "./service";

const UUID = "11111111-2222-3333-4444-555555555555";
const lsblk = {
  blockdevices: ["sdb", "sdc", "sdd"].map((k, i) => ({
    name: k,
    kname: k,
    type: "disk",
    size: 4e12,
    model: "WDC WD40EFRX",
    serial: `S${i}`,
    fstype: "btrfs",
    uuid: UUID,
    mountpoint: i === 0 ? "/srv/pool" : null,
  })),
};
const sys = (extra: Record<string, string> = {}) =>
  fixtureIO({
    lsblk,
    files: {
      [`/sys/fs/btrfs/${UUID}/label`]: "pool",
      [`/sys/fs/btrfs/${UUID}/exclusive_operation`]: "none",
      [`/sys/fs/btrfs/${UUID}/allocation/data/raid1/total_bytes`]: "1",
      [`/sys/fs/btrfs/${UUID}/allocation/metadata/raid1c3/total_bytes`]: "1",
      [`/sys/fs/btrfs/${UUID}/devinfo/1/missing`]: "0",
      [`/sys/fs/btrfs/${UUID}/devinfo/2/missing`]: "0",
      [`/sys/fs/btrfs/${UUID}/devinfo/3/missing`]: "0",
      [`/sys/fs/btrfs/${UUID}/devinfo/4/missing`]: "1",
      ...extra,
    },
  });

describe("reading Btrfs", () => {
  it("reads a RAID 1 over several drives from the kernel's files, with a missing drive", async () => {
    const io = sys();
    const blocks = parseBlocks(await io.lsblk());
    const [fs] = await readBtrfs(io, blocks);
    expect(fs).toMatchObject({
      uuid: UUID,
      label: "pool",
      data: ["raid1"],
      metadata: ["raid1c3"],
      missing: ["4"],
      mount: "/srv/pool",
    });
    const a = btrfsToArray(
      fs!,
      {
        stats: parseStats("[/dev/sdc].write_io_errs   0\n[/dev/sdc].corruption_errs  7\n"),
        scrub: parseScrub(
          "Scrub started:    Sat Oct 24 01:00:00 2026\nStatus:           finished\nError summary:    no errors found\n",
        ),
      },
      blocks,
    );
    expect(a).toMatchObject({
      tech: "btrfs",
      name: "pool",
      level: "btrfs-raid1",
      health: "degraded",
      canLose: 0,
      mount: "/srv/pool",
    });
    expect(a.levelText).toBe("RAID 1 (two copies), metadata RAID 1C3, 4 drives");
    expect(a.members.map((m) => [m.device, m.role])).toEqual([
      ["/dev/sdb", "active"],
      ["/dev/sdc", "active"],
      ["/dev/sdd", "active"],
      ["devid:4", "missing"],
    ]);
    expect(a.members[1]!.errorCounts?.corruption).toBe(7);
    expect(a.lastCheck?.text).toMatch(/no errors found/);
    expect(a.warnings.join(" ")).toMatch(/No redundancy left/);
  });

  it("counts a just-added drive lsblk has not caught up with, and reads raw scrub counters", async () => {
    const io = fixtureIO({
      lsblk: {
        blockdevices: [
          ...lsblk.blockdevices,
          { name: "sde", kname: "sde", type: "disk", size: 4e12, serial: "S9" },
        ],
      },
      files: {
        [`/sys/fs/btrfs/${UUID}/allocation/data/raid1/total_bytes`]: "1",
        // Left over from before a conversion: holds nothing, so it is not the profile.
        [`/sys/fs/btrfs/${UUID}/allocation/data/raid0/total_bytes`]: "0",
        ...Object.fromEntries(
          ["sdb", "sdc", "sdd", "sde"].map((d) => [`/sys/fs/btrfs/${UUID}/devices/${d}`, ""]),
        ),
      },
    });
    const blocks = parseBlocks(await io.lsblk());
    const [fs] = await readBtrfs(io, blocks);
    expect(fs!.devices.map((d) => d.name)).toEqual(["sdb", "sdc", "sdd", "sde"]);
    expect(fs!.data).toEqual(["raid1"]);
    const raw = (csum: number, fixed: number) =>
      parseScrub(
        `Scrub started:    Sun Oct 25 06:14:58 2026\nStatus:           finished\nDuration:         0:00:01\n\tdata_extents_scrubbed: 2\n\tread_errors: 0\n\tcsum_errors: ${csum}\n\tverify_errors: 0\n\tsuper_errors: 0\n\tmalloc_errors: 0\n\tuncorrectable_errors: 0\n\tunverified_errors: 0\n\tcorrected_errors: ${fixed}\n\tlast_physical: 0\n`,
      );
    expect(raw(0, 0).errors).toBe("no errors found");
    expect(raw(3, 3).errors).toBe("3 errors found, 3 corrected, 0 uncorrectable");
  });

  it("leaves out a single-drive filesystem (a Fedora system drive is not RAID)", async () => {
    const io = fixtureIO({
      lsblk: {
        blockdevices: [
          {
            name: "nvme0n1",
            kname: "nvme0n1",
            type: "disk",
            size: 1e12,
            fstype: "btrfs",
            uuid: "x",
            mountpoint: "/",
          },
        ],
      },
      files: {
        "/sys/fs/btrfs/x/allocation/data/single/total_bytes": "1",
        "/sys/fs/btrfs/x/devinfo/1/missing": "0",
      },
    });
    expect(await readBtrfs(io, parseBlocks(await io.lsblk()))).toEqual([]);
  });

  it("warns about RAID 5/6 and weaker metadata, and offers conversion in place", async () => {
    const io = sys({
      [`/sys/fs/btrfs/${UUID}/devinfo/4/missing`]: "0",
      [`/sys/fs/btrfs/${UUID}/allocation/data/raid1/total_bytes`]: "",
    });
    const blocks = parseBlocks(await io.lsblk());
    const [fs] = await readBtrfs(io, blocks);
    const a = btrfsToArray({ ...fs!, data: ["raid5"], metadata: ["single"] }, {}, blocks);
    expect(a.warnings.join(" ")).toMatch(/write hole/);
    expect(a.warnings.join(" ")).toMatch(/Metadata \(single\) is less protected/);
    const by = Object.fromEntries(
      btrfsActions(a, { candidates: [], ready: { ready: true } }).map((x) => [x.id, x]),
    );
    expect(by["change-level"]!.status).toBe("available");
    expect(by["add-spare"]!.status).toBe("unsupported");
    expect(by.check!.status).toBe("available");
  });
});

/* ---------- through plans, on the simulated machine ---------- */

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const approved = (params: Record<string, string | number | boolean>): StepRun => ({
  kind: "storage-raid",
  serviceId: "this-host",
  requestedBy: "you",
  params,
  job: { id: "job-1", seq: 1, approvedAt: new Date().toISOString() },
});

describe("Btrfs through plans", () => {
  it("scrubs, adds a drive, and converts to RAID 1C3 in place", async () => {
    const handle = openDatabase(":memory:");
    await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
    handles.push(handle);
    let t = Date.now();
    const raid = new RaidService(handle, {
      sample: new SampleRaid({ runMs: 60_000, now: () => t }),
      hostName: () => "Box",
    });
    const vault = async () => (await raid.report(true)).arrays.find((a) => a.tech === "btrfs")!;
    expect(await vault()).toMatchObject({
      name: "vault",
      health: "healthy",
      level: "btrfs-raid1",
      mount: "/srv/vault",
    });
    const step = async (params: Record<string, string | number | boolean>) => {
      const p = await raid.plan({
        kind: "storage-raid",
        serviceId: "this-host",
        params: { arrayId: (await vault()).id, ...params },
      });
      expect(p.policy, p.policyReason).toBe("approve-first");
      const r = await raid.run(approved(p.params!));
      expect(r.ok, r.result).toBe(true);
      return p;
    };
    await step({ action: "check" });
    expect((await vault()).health).toBe("checking");
    t += 61_000;
    const add = await step({ action: "grow-devices", device: "/dev/sdo" });
    expect(add.label).toMatch(/Add .*ZL2NEWTWELVE.* to the Btrfs filesystem vault/);
    expect((await vault()).members).toHaveLength(3);
    const conv = await step({ action: "change-level", profile: "raid1c3" });
    expect(conv.label).toMatch(/Convert .* to RAID 1C3 \(three copies\)/);
    expect((await vault()).health).toBe("reshaping");
    t += 61_000;
    expect((await vault()).level).toBe("btrfs-raid1c3");
  });
});

/* ---------- the executor's checks ---------- */

describe("the executor's Btrfs checks", () => {
  const deps = (mounted = true): RaidDeps => ({
    run: async (cmd, args) =>
      cmd === "findmnt"
        ? mounted
          ? { code: 0, out: `btrfs ${args.at(-1)}\n` }
          : { code: 1, out: "" }
        : cmd === "btrfs" && args[0] === "filesystem"
          ? {
              code: 0,
              out: "devid    1 size 4000 used 10 path /dev/sdb\n\tdevid    2 size 4000 used 10 path /dev/sdc\n",
            }
          : { code: 0, out: "" },
    wait: async () => undefined,
  });
  it("acts only on a mounted Btrfs filesystem, a known drive, and a known profile", async () => {
    await expect(
      btrfsMember({ mount: "/srv/x", action: "remove", device: "/dev/sdb" }, deps(false)),
    ).rejects.toThrow(/not a mounted Btrfs/);
    await expect(
      btrfsMember({ mount: "/srv/../etc", action: "remove", device: "/dev/sdb" }, deps()),
    ).rejects.toThrow(/not valid/);
    await expect(
      btrfsMember({ mount: "/srv/pool", action: "remove", device: "/dev/sdz" }, deps()),
    ).rejects.toThrow(/not in the filesystem/);
    await expect(
      btrfsBalance({ mount: "/srv/pool", action: "start", convert: "raid7" }, deps()),
    ).rejects.toThrow(/profile is not valid/);
    await expect(
      btrfsBalance({ mount: "/srv/pool", action: "start", convert: "raid1c3" }, deps()),
    ).rejects.toThrow(/needs at least 3 drives/);
  });
});
