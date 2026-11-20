import type { ElevatedResponse, Params } from "../../elevated/protocol";
import type { RaidIO } from "./io";
import { SampleBtrfs } from "./sample-btrfs";
import { SampleSnapraid } from "./sample-snapraid";
import { SampleSpaces } from "./sample-spaces";
import { SampleZfs, type SampleDisks } from "./sample-zfs";

/**
 * A simulated machine with Linux software RAID, for demo mode and tests (DC_FAKE_RAID=1, never a
 * real install): a degraded RAID 5 with a failed drive, a healthy RAID 1 being checked, a blank
 * drive and one holding data. It answers the RAID tab's reads like the kernel's files do and
 * applies approved operations the way mdadm would, including rebuilds that progress over time.
 */

interface SimMember {
  kname: string;
  state: string;
  slot?: number;
}
interface SimArray {
  md: string;
  name: string;
  level: string;
  raidDisks: number;
  members: SimMember[];
  componentKiB: number;
  uuid: string;
  mount?: string;
  fstype?: string;
  action: string;
  started?: number;
  durationMs?: number;
  mismatches: number;
  syncMin: number;
  inConf?: boolean;
  speedMin?: number;
  speedMax?: number;
  bitmap: string;
}
interface SimDisk {
  kname: string;
  model: string;
  serial: string;
  sizeBytes: number;
  rota: boolean;
  tran: string;
  fstype?: string;
  mount?: string;
  parts: { kname: string; sizeBytes: number; fstype?: string; mount?: string }[];
}

const TB = 1e12;
const GB = 1e9;

/** How ZFS lays out a whole drive it was given: its data partition, and a small reserve. */
function zfsParts(k: string, size: number): SimDisk["parts"] {
  return [
    { kname: `${k}1`, sizeBytes: size - 8 * 1024 ** 2, fstype: "zfs_member" },
    { kname: `${k}9`, sizeBytes: 8 * 1024 ** 2 },
  ];
}

export class SampleRaid {
  arrays: SimArray[];
  disks: SimDisk[];
  zfs: SampleZfs;
  /** The Windows machine instead (DC_FAKE_RAID=windows): Storage Spaces. */
  readonly windows: boolean;
  spaces: SampleSpaces;
  snap: SampleSnapraid;
  btrfs: SampleBtrfs;
  private readonly now: () => number;
  /** How long a simulated rebuild or check takes. */
  private readonly runMs: number;

  constructor(opts: { now?: () => number; runMs?: number; windows?: boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.runMs = opts.runMs ?? 45_000;
    this.zfs = new SampleZfs(this.now, this.runMs);
    this.windows = opts.windows === true;
    this.spaces = new SampleSpaces(this.now, this.runMs);
    this.snap = new SampleSnapraid(this.now, this.runMs, this.windows);
    this.btrfs = new SampleBtrfs(this.now, this.runMs);
    const whole = (k: string, serial: string): SimDisk => ({
      kname: k,
      model: "ST6000VN001-2BB186",
      serial,
      sizeBytes: 6 * TB,
      rota: true,
      tran: "sata",
      parts: [],
    });
    // SnapRAID's drives: three data drives and a parity drive, each its own ext4 filesystem.
    const own = (
      k: string,
      model: string,
      serial: string,
      size: number,
      mount: string,
    ): SimDisk => ({
      kname: k,
      model,
      serial,
      sizeBytes: size,
      rota: true,
      tran: "sata",
      parts: [{ kname: `${k}1`, sizeBytes: size, fstype: "ext4", mount }],
    });
    const pool = (k: string, serial: string): SimDisk => ({
      kname: k,
      model: "ST12000NT001-3LR101",
      serial,
      sizeBytes: 12 * TB,
      rota: true,
      tran: "sata",
      parts: zfsParts(k, 12 * TB),
    });
    this.disks = [
      {
        kname: "sda",
        model: "Samsung SSD 870 EVO",
        serial: "S6PNNS0T401234",
        sizeBytes: 500 * GB,
        rota: false,
        tran: "sata",
        parts: [
          { kname: "sda1", sizeBytes: 1 * GB, fstype: "vfat", mount: "/boot/efi" },
          { kname: "sda2", sizeBytes: 499 * GB, fstype: "ext4", mount: "/" },
        ],
      },
      {
        kname: "sdb",
        model: "WDC WD40EFRX-68N32N0",
        serial: "WD-WCC7K1AAAAAA",
        sizeBytes: 4 * TB,
        rota: true,
        tran: "sata",
        parts: [{ kname: "sdb1", sizeBytes: 4 * TB - GB, fstype: "linux_raid_member" }],
      },
      {
        kname: "sdc",
        model: "WDC WD40EFRX-68N32N0",
        serial: "WD-WCC7K1BBBBBB",
        sizeBytes: 4 * TB,
        rota: true,
        tran: "sata",
        parts: [{ kname: "sdc1", sizeBytes: 4 * TB - GB, fstype: "linux_raid_member" }],
      },
      {
        kname: "sdd",
        model: "WDC WD40EFRX-68N32N0",
        serial: "WD-WCC7K1CCCCCC",
        sizeBytes: 4 * TB,
        rota: true,
        tran: "sata",
        parts: [{ kname: "sdd1", sizeBytes: 4 * TB - GB, fstype: "linux_raid_member" }],
      },
      {
        kname: "sde",
        model: "ST4000VN008-2DR166",
        serial: "ZDH1NEWDISK",
        sizeBytes: 4 * TB,
        rota: true,
        tran: "sata",
        parts: [],
      },
      {
        kname: "sdf",
        model: "ST4000DM004-2U9104",
        serial: "ZFL2OLDDATA",
        sizeBytes: 4 * TB,
        rota: true,
        tran: "usb",
        parts: [{ kname: "sdf1", sizeBytes: 4 * TB, fstype: "ntfs" }],
      },
      {
        kname: "sdg",
        model: "Seagate IronWolf 8TB",
        serial: "ZA1MIRRORA",
        sizeBytes: 8 * TB,
        rota: true,
        tran: "sata",
        parts: [],
      },
      {
        kname: "sdh",
        model: "Seagate IronWolf 8TB",
        serial: "ZA1MIRRORB",
        sizeBytes: 8 * TB,
        rota: true,
        tran: "sata",
        parts: [],
      },
      own("sdp", "WDC WD80EFZZ-68BTXN0", "WD-CA0SNAP1", 8 * TB, "/mnt/disk1"),
      own("sdq", "WDC WD80EFZZ-68BTXN0", "WD-CA0SNAP2", 8 * TB, "/mnt/disk2"),
      own("sdr", "WDC WD80EFZZ-68BTXN0", "WD-CA0SNAP3", 8 * TB, "/mnt/disk3"),
      own("sds", "WDC WD101EFBX-68B0AN0", "VCJPARITY1", 10 * TB, "/mnt/parity1"),
      whole("sdt", "ZR1VAULTA"),
      whole("sdu", "ZR1VAULTB"),
      pool("sdi", "ZRT0A1PRO"),
      pool("sdj", "ZRT0A2PRO"),
      pool("sdk", "ZRT0A3PRO"),
      pool("sdl", "ZRT0A4PRO"),
      pool("sdm", "ZRT0A5PRO"),
      pool("sdn", "ZRT0A6PRO"),
      {
        kname: "sdo",
        model: "ST12000VN0008-2YS101",
        serial: "ZL2NEWTWELVE",
        sizeBytes: 12 * TB,
        rota: true,
        tran: "sata",
        parts: [],
      },
    ];
    this.arrays = [
      {
        md: "md0",
        name: "media",
        level: "raid5",
        raidDisks: 3,
        members: [
          { kname: "sdb1", state: "in_sync", slot: 0 },
          { kname: "sdc1", state: "in_sync", slot: 1 },
          { kname: "sdd1", state: "faulty", slot: 2 },
        ],
        componentKiB: (4 * TB - GB) / 1024,
        uuid: "3f9c2a1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f",
        mount: "/srv/media",
        fstype: "ext4",
        action: "idle",
        mismatches: 0,
        syncMin: 0,
        bitmap: "+8",
        inConf: true,
      },
      {
        md: "md1",
        name: "backup",
        level: "raid1",
        raidDisks: 2,
        members: [
          { kname: "sdg", state: "in_sync", slot: 0 },
          { kname: "sdh", state: "in_sync", slot: 1 },
        ],
        componentKiB: (8 * TB) / 1024,
        uuid: "a1b2c3d4-e5f6-4711-8899-aabbccddeeff",
        mount: "/srv/backup",
        fstype: "ext4",
        action: "check",
        started: this.now() - 20_000,
        durationMs: 10 * 60_000,
        mismatches: 0,
        syncMin: 0,
        bitmap: "+8",
      },
    ];
  }

  /** Finishes rebuilds and checks whose time is up. */
  private tick() {
    for (const a of this.arrays) {
      if (a.action === "idle" || a.started === undefined || a.durationMs === undefined) continue;
      if (this.now() - a.started < a.durationMs) continue;
      for (const m of a.members)
        if (m.state === "spare" && m.slot !== undefined) m.state = "in_sync";
      for (const m of a.members) if (m.state === "in_sync,replacement") m.state = "in_sync";
      a.members = a.members.filter((m) => !m.state.includes("want_replacement"));
      a.action = "idle";
      a.started = undefined;
      a.durationMs = undefined;
      a.syncMin = 0;
    }
  }

  private degraded(a: SimArray) {
    const inSlot = new Set(
      a.members
        .filter((m) => m.slot !== undefined && m.state.includes("in_sync"))
        .map((m) => m.slot),
    );
    let n = 0;
    for (let s = 0; s < a.raidDisks; s++) if (!inSlot.has(s)) n++;
    return n;
  }

  /** The simulated drives, as ZFS's simulation needs them. */
  private sampleDisks(): SampleDisks {
    return {
      claim: (device, serial, erase) => {
        const why = this.checkNew(device, serial, erase);
        if (why) return why;
        const d = this.disk(device)!;
        return { kname: d.kname, sizeBytes: d.sizeBytes };
      },
      setZfs: (kname, on) => {
        const d = this.disk(kname);
        if (d) d.parts = on ? zfsParts(d.kname, d.sizeBytes) : [];
      },
    };
  }

  /** Why a drive cannot join an array or pool now, or nothing when it can (erasing if approved). */
  private checkNew(device: unknown, serial: unknown, erase: unknown): string | undefined {
    const d = this.disk(device);
    if (!d) return `${String(device)} is not a drive on this machine.`;
    if (d.parts.some((p) => p.mount) || d.mount)
      return `${String(device)} is mounted or holds the system.`;
    if (serial && d.serial !== serial)
      return `The drive is not the one approved (serial ${d.serial}).`;
    const k = String(device).replace(/^\/dev\//, "");
    if (
      this.memberOf(k) ||
      this.btrfs.memberOf(d.kname) ||
      this.zfs.members().some((m) => m === k || m.startsWith(d.kname))
    )
      return `${String(device)} is already in an array or pool.`;
    const holds = d.fstype || d.parts.length;
    if (holds && erase !== true)
      return `${String(device)} holds data; erasing it was not approved.`;
    if (holds) {
      d.fstype = undefined;
      d.parts = [];
    }
    return undefined;
  }

  private memberOf(kname: string) {
    return this.arrays.find((a) => a.members.some((m) => m.kname === kname));
  }

  io(): RaidIO {
    if (this.windows) return this.snap.wrap(this.spaces.io());
    const files = (): Record<string, string> => {
      this.tick();
      const f: Record<string, string> = {
        ...this.btrfs.files(),
        "/proc/mdstat": `Personalities : [raid1] [raid6] [raid5] [raid4]\n${this.arrays
          .map(
            (a) =>
              `${a.md} : active ${a.level} ${a.members.map((m) => `${m.kname}[${m.slot ?? 9}]${m.state.includes("faulty") ? "(F)" : m.state === "spare" ? "(S)" : ""}`).join(" ")}\n      ${a.componentKiB * (a.level === "raid1" ? 1 : a.raidDisks - 1)} blocks\n`,
          )
          .join("\n")}\nunused devices: <none>\n`,
        "/proc/sys/dev/raid/speed_limit_min": "1000",
        "/proc/sys/dev/raid/speed_limit_max": "200000",
        "/etc/mdadm/mdadm.conf": this.arrays
          .filter((a) => a.inConf)
          .map(
            (a) =>
              `ARRAY /dev/md/${a.name} metadata=1.2 UUID=${a.uuid.replace(/-/g, "").match(/.{8}/g)!.join(":")}\n`,
          )
          .join(""),
        "/etc/cron.d/mdadm":
          "57 0 * * 0 root if [ -x /usr/share/mdadm/checkarray ] && [ $(date +\\%d) -le 7 ]; then /usr/share/mdadm/checkarray --cron --all --idle --quiet; fi\n",
        "/usr/sbin/mdadm": "",
        "/usr/sbin/zpool": "",
        "/etc/cron.d/zfsutils-linux":
          "# Scrub the second Sunday of every month.\n24 0 8-14 * * root if [ $(date +\\%w) -eq 0 ] && [ -x /usr/lib/zfs-linux/scrub ]; then /usr/lib/zfs-linux/scrub; fi\n",
      };
      for (const a of this.arrays) {
        const b = `/sys/block/${a.md}/md`;
        const total = a.componentKiB * 2;
        const done =
          a.started !== undefined && a.durationMs
            ? Math.min(total, Math.round(((this.now() - a.started) / a.durationMs) * total))
            : undefined;
        Object.assign(f, {
          [`${b}/level`]: a.level,
          [`${b}/raid_disks`]: String(a.raidDisks),
          [`${b}/array_state`]: a.action === "idle" ? "clean" : "active",
          [`${b}/degraded`]: String(this.degraded(a)),
          [`${b}/sync_action`]: a.action,
          [`${b}/sync_completed`]: done !== undefined ? `${done} / ${total}` : "none",
          [`${b}/sync_speed`]: a.action === "idle" ? "none" : "142000",
          [`${b}/sync_speed_min`]: a.speedMin ? `${a.speedMin} (local)` : "1000 (system)",
          [`${b}/sync_speed_max`]: a.speedMax ? `${a.speedMax} (local)` : "200000 (system)",
          [`${b}/sync_min`]: String(a.syncMin),
          [`${b}/mismatch_cnt`]: String(a.mismatches),
          [`${b}/chunk_size`]: String(512 * 1024),
          [`${b}/layout`]: a.level === "raid5" ? "2" : "0",
          [`${b}/metadata_version`]: "1.2",
          [`${b}/component_size`]: String(a.componentKiB),
          [`${b}/uuid`]: a.uuid,
          [`${b}/bitmap/location`]: a.bitmap,
          [`/sys/block/${a.md}/size`]: String(
            a.componentKiB * 2 * (a.level === "raid1" ? 1 : a.raidDisks - 1),
          ),
        });
        for (const m of a.members) {
          f[`${b}/dev-${m.kname}/state`] = m.state;
          f[`${b}/dev-${m.kname}/slot`] = m.slot === undefined ? "none" : String(m.slot);
          f[`${b}/dev-${m.kname}/errors`] = m.state.includes("faulty") ? "48" : "0";
        }
      }
      return f;
    };
    const links = () =>
      Object.fromEntries(this.arrays.map((a) => [`/dev/md/${a.name}`, `../${a.md}`]));
    const lsblk = () => ({
      blockdevices: [
        ...this.disks.map((d) => {
          const arr = (kname: string) => this.memberOf(kname);
          const mdChild = (kname: string) => {
            const a = arr(kname);
            return a
              ? [
                  {
                    name: a.md,
                    kname: a.md,
                    type: a.level,
                    size: a.componentKiB * 1024,
                    fstype: a.fstype,
                    mountpoint: a.mount,
                  },
                ]
              : [];
          };
          return {
            name: d.kname,
            kname: d.kname,
            type: "disk",
            size: d.sizeBytes,
            rota: d.rota,
            tran: d.tran,
            model: d.model,
            serial: d.serial,
            fstype: arr(d.kname)
              ? "linux_raid_member"
              : this.btrfs.memberOf(d.kname)
                ? "btrfs"
                : d.fstype,
            ...(this.btrfs.memberOf(d.kname) ? { uuid: this.btrfs.memberOf(d.kname)!.uuid } : {}),
            mountpoint:
              d.mount ??
              (this.btrfs.memberOf(d.kname)?.devices[0] === d.kname
                ? this.btrfs.memberOf(d.kname)!.mount || null
                : null),
            children: [
              ...mdChild(d.kname),
              ...d.parts.map((p) => ({
                name: p.kname,
                kname: p.kname,
                pkname: d.kname,
                type: "part",
                size: p.sizeBytes,
                fstype: arr(p.kname) ? "linux_raid_member" : p.fstype,
                mountpoint: p.mount ?? null,
                children: mdChild(p.kname),
              })),
            ],
          };
        }),
      ],
    });
    const statfs: Record<string, { total: number; free: number }> = {
      "/srv/media": { total: 7.8 * TB, free: 1.9 * TB },
      "/srv/backup": { total: 7.9 * TB, free: 5.2 * TB },
      "/srv/vault": { total: 6 * TB, free: 2.2 * TB },
    };
    return this.snap.wrap({
      read: async (p) => files()[p],
      async list(dir) {
        const pre = dir.endsWith("/") ? dir : `${dir}/`;
        const all = [...Object.keys(files()), ...Object.keys(links())];
        return [
          ...new Set(
            all.filter((p) => p.startsWith(pre)).map((p) => p.slice(pre.length).split("/")[0]!),
          ),
        ];
      },
      readlink: async (p) => links()[p],
      lsblk: async () => JSON.stringify(lsblk()),
      statfs: async (m) => statfs[m],
      exists: async (p) => Object.keys(files()).some((x) => x === p || x.startsWith(`${p}/`)),
      run: async (cmd, args) =>
        this.zfs.run(cmd, args) ??
        this.btrfs.run(cmd, args) ?? { code: 127, out: `${cmd}: not found` },
      platform: "linux",
    });
  }

  private disk(device: unknown) {
    const k = String(device ?? "").replace(/^\/dev\//, "");
    return this.disks.find((d) => d.kname === k || d.parts.some((p) => p.kname === k));
  }

  /** What the elevated executor would do, applied to the simulation. */
  perform(op: string, params: Params): ElevatedResponse {
    this.tick();
    const fail = (result: string, outcome: "refused" | "stale" = "refused"): ElevatedResponse => ({
      ok: false,
      outcome,
      result,
    });
    const done = (result: string, data?: unknown): ElevatedResponse => ({
      ok: true,
      outcome: "done",
      result,
      ...(data !== undefined ? { data } : {}),
    });
    const a = this.arrays.find((x) => `/dev/${x.md}` === params.array);
    if (op.startsWith("zfs.")) return this.zfs.perform(op, params, this.sampleDisks());
    if (op.startsWith("spaces.")) return this.spaces.perform(op, params);
    if (op === "snapraid.run") return this.snap.perform(params);
    if (op.startsWith("btrfs."))
      return this.btrfs.perform(
        op,
        params,
        (d, s, e) => this.checkNew(d, s, e) ?? { kname: this.disk(d)!.kname },
      );
    const checkNew = (device: unknown, serial: unknown, erase: unknown) => {
      const d = this.disk(device);
      if (!d) return `${String(device)} is not a drive on this machine.`;
      if (d.parts.some((p) => p.mount) || d.mount)
        return `${String(device)} is mounted or holds the system.`;
      if (serial && d.serial !== serial)
        return `The drive is not the one approved (serial ${d.serial}).`;
      const k = String(device).replace(/^\/dev\//, "");
      if (this.memberOf(k)) return `${String(device)} is already in an array.`;
      const holds = d.fstype || d.parts.length;
      if (holds && erase !== true)
        return `${String(device)} holds data; erasing it was not approved.`;
      if (holds) {
        d.fstype = undefined;
        d.parts = [];
      }
      return undefined;
    };
    if (op === "raid.create") {
      const devices =
        (params.devices as { device: string; serial?: string; erase?: boolean }[]) ?? [];
      for (const d of devices) {
        const why = checkNew(d.device, d.serial, d.erase);
        if (why) return fail(why);
      }
      const md = `md${this.arrays.length}`;
      const level = String(params.level);
      const size = Math.min(...devices.map((d) => this.disk(d.device)!.sizeBytes));
      this.arrays.push({
        md,
        name: String(params.name),
        level,
        raidDisks: devices.length,
        members: devices.map((d, i) => ({
          kname: d.device.replace(/^\/dev\//, ""),
          state: "in_sync",
          slot: i,
        })),
        componentKiB: size / 1024,
        uuid: `0000${this.arrays.length}c0d-0000-4000-8000-000000000000`,
        action: level === "raid0" ? "idle" : "resync",
        ...(level === "raid0" ? {} : { started: this.now(), durationMs: this.runMs }),
        mismatches: 0,
        syncMin: 0,
        bitmap: level === "raid0" ? "none" : "+8",
        ...(params.mkfs === "ext4" ? { fstype: "ext4" } : {}),
      });
      return done(`Created /dev/${md} (${String(params.name)}, ${level}).`, {
        array: `/dev/${md}`,
      });
    }
    if (!a) return fail(`${String(params.array)} is not a running array.`);
    const dev = String(params.device ?? "").replace(/^\/dev\//, "");
    const m = a.members.find((x) => x.kname === dev);
    if (op === "raid.member") {
      switch (params.action) {
        case "add":
        case "add-spare": {
          const why = checkNew(params.device, params.serial, params.erase);
          if (why) return fail(why, /approved \(serial/.test(why) ? "stale" : "refused");
          // A slot with no working member: the new drive is rebuilt into it at once.
          const free = [...Array(a.raidDisks).keys()].find(
            (s) => !a.members.some((x) => x.slot === s && !x.state.includes("faulty")),
          );
          if (free !== undefined && a.action === "idle") {
            for (const x of a.members) if (x.slot === free) delete x.slot;
            a.members.push({ kname: dev, state: "spare", slot: free });
            a.action = "recover";
            a.started = this.now();
            a.durationMs = this.runMs;
          } else a.members.push({ kname: dev, state: "spare" });
          return done(`${String(params.device)} joined /dev/${a.md}.`);
        }
        case "fail":
          if (!m) return fail("Not a member.", "stale");
          m.state = "faulty";
          return done(`${String(params.device)} is marked failed.`);
        case "remove":
          if (!m || !(m.state.includes("faulty") || m.state === "spare"))
            return fail("Only failed members and spares are removed.");
          a.members = a.members.filter((x) => x !== m);
          return done(`${String(params.device)} was removed.`);
        case "replace": {
          const why = checkNew(params.device, params.serial, params.erase);
          if (why) return fail(why);
          const old = a.members.find((x) => `/dev/${x.kname}` === params.replaces);
          if (!old) return fail("Not a member.", "stale");
          old.state = "in_sync,want_replacement";
          a.members.push({
            kname: dev,
            state: "in_sync,replacement",
            ...(old.slot !== undefined ? { slot: old.slot } : {}),
          });
          a.action = "recover";
          a.started = this.now();
          a.durationMs = this.runMs;
          return done(`${String(params.device)} is taking over.`);
        }
        default:
          return fail("Not available in the sample.");
      }
    }
    if (op === "raid.sync") {
      if (params.action === "check" || params.action === "repair") {
        if (a.action !== "idle") return fail("Busy.", "stale");
        a.action = String(params.action);
        a.started = this.now();
        a.durationMs = this.runMs;
        return done(`A ${String(params.action)} started on /dev/${a.md}.`);
      }
      if (params.action === "pause" || params.action === "cancel") {
        const total = a.componentKiB * 2;
        const pos =
          a.started && a.durationMs
            ? Math.round(((this.now() - a.started) / a.durationMs) * total)
            : 0;
        a.action = "idle";
        a.started = undefined;
        a.durationMs = undefined;
        a.syncMin = params.action === "pause" ? pos : 0;
        return done(
          params.action === "pause" ? "Paused." : "Cancelled.",
          params.action === "pause" ? { position: pos } : undefined,
        );
      }
      if (params.action === "resume") {
        a.action = "check";
        a.started = this.now();
        a.durationMs = this.runMs;
        return done("Resumed.");
      }
    }
    if (op === "raid.config") {
      a.inConf = true;
      return done(`Added /dev/${a.md} to mdadm.conf.`);
    }
    if (op === "raid.speed") {
      a.speedMin = params.minKiBs === "system" ? undefined : Number(params.minKiBs);
      a.speedMax = params.maxKiBs === "system" ? undefined : Number(params.maxKiBs);
      return done("Speed set.");
    }
    if (op === "raid.grow" && params.mode === "devices") {
      if (params.device) {
        const why = checkNew(params.device, params.serial, params.erase);
        if (why) return fail(why);
        a.members.push({ kname: dev, state: "in_sync", slot: a.raidDisks });
      }
      a.raidDisks += 1;
      a.action = a.level === "raid1" ? "recover" : "reshape";
      a.started = this.now();
      a.durationMs = this.runMs;
      return done(`Now ${a.raidDisks} members.`);
    }
    return fail(`${op} is not simulated.`);
  }
}
