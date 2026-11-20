import type { ElevatedResponse, Params } from "../../elevated/protocol";
import type { RaidIO } from "./io";
import { ALL_SCRIPT, DISKS_SCRIPT, POWERSHELL, READ_SCRIPT, psArgs } from "./spaces";

/**
 * A simulated Windows machine (DC_FAKE_RAID=windows), for demo mode and tests: a Storage Spaces
 * pool holding a two-way mirror (D:), one of its four drives no longer answering; a blank drive
 * Windows can pool, one holding an old partition, one in use as E:, and the Windows drive. It
 * answers Hearth's PowerShell reads the way Windows does and applies approved spaces.* operations,
 * including repairs that progress over time.
 */

const TB = 1e12;

interface Disk {
  number: string;
  id: string;
  name: string;
  serial: string;
  size: number;
  media: "HDD" | "SSD";
  bus: "SATA" | "NVMe" | "USB";
  health: "Healthy" | "Warning" | "Unhealthy";
  op: string[];
  usage: "Auto-Select" | "Hot Spare" | "Retired";
  pool?: string;
  system?: boolean;
  parts: { letter?: string; size: number; type: string; fs?: string; label?: string }[];
}
interface Pool {
  id: string;
  name: string;
  vdisk: { id: string; name: string; copies: number; size: number; letter: string; used: number };
  job?: { kind: "repair" | "optimize"; started: number };
}

export class SampleSpaces {
  disks: Disk[];
  pools: Pool[];
  constructor(
    private readonly now: () => number,
    private readonly runMs: number,
  ) {
    const wd = (n: string, serial: string, op = ["OK"]): Disk => ({
      number: n,
      id: `60014055${serial}`,
      name: "WDC WD40EFZX-68AWUN0",
      serial,
      size: 4 * TB,
      media: "HDD",
      bus: "SATA",
      health: op[0] === "OK" ? "Healthy" : "Warning",
      op,
      usage: "Auto-Select",
      pool: "{pool-media}",
      parts: [],
    });
    this.disks = [
      {
        number: "0",
        id: "eui.0025385A11B2C3D4",
        name: "Samsung SSD 980 PRO 1TB",
        serial: "S69ENF0R123456A",
        size: 1 * TB,
        media: "SSD",
        bus: "NVMe",
        health: "Healthy",
        op: ["OK"],
        usage: "Auto-Select",
        system: true,
        parts: [
          { size: 100e6, type: "System" },
          { letter: "C", size: 999e9, type: "Basic", fs: "NTFS", label: "Windows" },
        ],
      },
      wd("1", "WD-WX12D80AAAAA"),
      wd("2", "WD-WX12D80BBBBB"),
      wd("3", "WD-WX12D80CCCCC", ["Lost Communication"]),
      wd("4", "WD-WX12D80DDDDD"),
      {
        number: "5",
        id: "60014055ZDHNEWSPACE",
        name: "ST4000VN008-2DR166",
        serial: "ZDHNEWSPACE",
        size: 4 * TB,
        media: "HDD",
        bus: "SATA",
        health: "Healthy",
        op: ["OK"],
        usage: "Auto-Select",
        parts: [],
      },
      {
        number: "6",
        id: "60014055ZFLOLDPART",
        name: "ST2000DM008-2FR102",
        serial: "ZFLOLDPART",
        size: 2 * TB,
        media: "HDD",
        bus: "SATA",
        health: "Healthy",
        op: ["OK"],
        usage: "Auto-Select",
        parts: [{ size: 2 * TB, type: "Basic", fs: "NTFS", label: "Old backup" }],
      },
      {
        number: "7",
        id: "60014055EXTERNALE",
        name: "WD Elements 25A3",
        serial: "WXK2A1EXTERNAL",
        size: 5 * TB,
        media: "HDD",
        bus: "USB",
        health: "Healthy",
        op: ["OK"],
        usage: "Auto-Select",
        parts: [{ letter: "E", size: 5 * TB, type: "Basic", fs: "NTFS", label: "Photos" }],
      },
      // SnapRAID's drives (with DrivePool or on their own): three data drives and a parity drive.
      ...(
        [
          ["8", "F", "WD-CA0SNAP1", 8, "Movies"],
          ["9", "G", "WD-CA0SNAP2", 8, "TV"],
          ["10", "H", "WD-CA0SNAP3", 8, "Music"],
          ["11", "P", "VCJPARITY1", 10, "Parity"],
        ] as const
      ).map(([n, letter, serial, tb, label]): Disk => ({
        number: n,
        id: `60014055${serial}`,
        name: tb === 10 ? "WDC WD101EFBX-68B0AN0" : "WDC WD80EFZZ-68BTXN0",
        serial,
        size: tb * TB,
        media: "HDD",
        bus: "SATA",
        health: "Healthy",
        op: ["OK"],
        usage: "Auto-Select",
        parts: [{ letter, size: tb * TB, type: "Basic", fs: "NTFS", label }],
      })),
    ];
    this.pools = [
      {
        id: "{pool-media}",
        name: "MediaPool",
        vdisk: {
          id: "{space-media}",
          name: "Media",
          copies: 2,
          size: 7.2 * TB,
          letter: "D",
          used: 5.1 * TB,
        },
      },
    ];
  }

  private members(p: Pool) {
    return this.disks.filter((d) => d.pool === p.id);
  }

  /** A repair or optimize finishes when its time is up. */
  tick() {
    for (const p of this.pools)
      if (p.job && this.now() - p.job.started >= this.runMs) {
        p.job = undefined;
        // Repaired: retired and lost drives hold nothing more.
        for (const d of this.members(p)) if (d.usage === "Retired") d.op = ["OK"];
      }
  }

  private vState(p: Pool) {
    const m = this.members(p).filter((d) => d.usage !== "Hot Spare");
    const bad = m.filter((d) => d.op.some((o) => /Lost/.test(o)) || d.usage === "Retired");
    if (p.job?.kind === "repair") return { health: "Warning", op: ["InService"] };
    if (bad.length) return { health: "Warning", op: ["Degraded"] };
    return { health: "Healthy", op: ["OK"] };
  }

  private read() {
    this.tick();
    return {
      pools: this.pools.map((p) => {
        const members = this.members(p);
        const size = members.reduce((n, d) => n + d.size, 0);
        const v = this.vState(p);
        return {
          name: p.name,
          id: p.id,
          health: v.health,
          op: v.op[0] === "OK" ? ["OK"] : ["Degraded"],
          size,
          alloc: Math.min(size, p.vdisk.size * p.vdisk.copies),
          readOnly: false,
          disks: members.map((d) => ({
            name: d.name,
            serial: d.serial,
            id: d.id,
            number: d.op.some((o) => /Lost/.test(o)) ? "" : d.number,
            size: d.size,
            alloc:
              d.usage === "Retired" && !p.job ? 0 : Math.round((p.vdisk.size * 2) / members.length),
            media: d.media,
            bus: d.bus,
            health: d.health,
            op: d.op,
            usage: d.usage,
          })),
          vdisks: [
            {
              name: p.vdisk.name,
              id: p.vdisk.id,
              resiliency: "Mirror",
              copies: p.vdisk.copies,
              redundancy: p.vdisk.copies - 1,
              columns: 1,
              health: v.health,
              op: v.op,
              size: p.vdisk.size,
              footprint: p.vdisk.size * 2,
              provisioning: "Fixed",
              letter: p.vdisk.letter,
              fs: "NTFS",
              volSize: p.vdisk.size,
              free: p.vdisk.size - p.vdisk.used,
              label: p.vdisk.name,
            },
          ],
        };
      }),
      jobs: this.pools
        .filter((p) => p.job)
        .map((p) => ({
          name: p.job!.kind === "repair" ? `${p.vdisk.name}-Repair` : `${p.name}-Rebalance`,
          state: "Running",
          pct: Math.min(99, Math.round(((this.now() - p.job!.started) / this.runMs) * 100)),
        })),
    };
  }

  private candidates() {
    this.tick();
    return this.disks.map((d) => ({
      name: d.name,
      serial: d.serial,
      id: d.id,
      number: d.number,
      size: d.size,
      media: d.media,
      bus: d.bus,
      canPool: !d.pool && !d.system && !d.parts.length,
      why: d.pool ? ["In a Pool"] : d.parts.length ? ["Insufficient Capacity"] : [],
      usage: d.usage,
      system: Boolean(d.system),
      parts: d.parts.map((x) => ({
        letter: x.letter ?? null,
        size: x.size,
        type: x.type,
        fs: x.fs ?? null,
        label: x.label ?? null,
      })),
    }));
  }

  io(): RaidIO {
    const read = [POWERSHELL, ...psArgs(READ_SCRIPT)].join(" ");
    const disks = [POWERSHELL, ...psArgs(DISKS_SCRIPT)].join(" ");
    const all = [POWERSHELL, ...psArgs(ALL_SCRIPT)].join(" ");
    return {
      read: async () => undefined,
      list: async () => [],
      readlink: async () => undefined,
      lsblk: async () => JSON.stringify({ blockdevices: [] }),
      statfs: async () => undefined,
      // StableBit DrivePool pools the SnapRAID drives on this simulated machine.
      exists: async (p) => p.endsWith("\\StableBit\\DrivePool\\DrivePool.Service.exe"),
      run: async (cmd, args) => {
        const key = [cmd, ...args].join(" ");
        if (key === read) return { code: 0, out: JSON.stringify(this.read()) };
        if (key === disks) return { code: 0, out: JSON.stringify(this.candidates()) };
        if (key === all)
          return { code: 0, out: JSON.stringify({ ...this.read(), disks: this.candidates() }) };
        return { code: 127, out: `${cmd}: not simulated` };
      },
      platform: "win32",
    };
  }

  perform(op: string, params: Params): ElevatedResponse {
    this.tick();
    const fail = (result: string, outcome: "refused" | "stale" = "refused"): ElevatedResponse => ({
      ok: false,
      outcome,
      result,
    });
    const done = (result: string): ElevatedResponse => ({ ok: true, outcome: "done", result });
    const byNumber = (v: unknown) =>
      this.disks.find((d) => `\\\\.\\PHYSICALDRIVE${d.number}` === v);
    const claim = (disk: unknown, serial: unknown, erase: unknown): Disk | string => {
      const d = byNumber(disk);
      if (!d) return `${String(disk)} is not on this machine.`;
      if (serial && d.serial !== serial) return `Not the one approved (serial ${d.serial}).`;
      if (d.system) return "It holds Windows. Never used.";
      if (d.pool) return "It is already in a storage pool.";
      if (d.parts.some((x) => x.letter))
        return `It is in use as ${d.parts.find((x) => x.letter)!.letter}:.`;
      if (d.parts.length && erase !== true) return "It holds partitions; erasing was not approved.";
      d.parts = [];
      return d;
    };
    if (op === "spaces.create") {
      const list = (params.disks as { disk: string; serial?: string; erase?: boolean }[]) ?? [];
      const got: Disk[] = [];
      for (const x of list) {
        const d = claim(x.disk, x.serial, x.erase);
        if (typeof d === "string") return fail(d);
        got.push(d);
      }
      const id = `{pool-${this.pools.length}}`;
      for (const d of got) d.pool = id;
      const total = got.reduce((n, d) => n + d.size, 0);
      this.pools.push({
        id,
        name: String(params.name),
        vdisk: {
          id: `{space-${this.pools.length}}`,
          name: String(params.name),
          copies: 2,
          size: total / 2,
          letter: "F",
          used: 0,
        },
      });
      return done(
        `Created the pool ${String(params.name)}, formatted ${params.fs === "refs" ? "ReFS" : "NTFS"} as F:.`,
      );
    }
    const p = this.pools.find((x) => x.id === params.pool);
    if (!p) return fail("That pool is not on this machine.", "stale");
    if (op === "spaces.repair") {
      p.job = { kind: params.action === "optimize" ? "optimize" : "repair", started: this.now() };
      return done(
        `Windows is ${params.action === "optimize" ? "optimizing" : "repairing"} ${p.name}.`,
      );
    }
    if (op === "spaces.grow")
      return done(`Extended: ${p.vdisk.name}: ${Math.round(p.vdisk.size / 1e9)} GB.`);
    if (op !== "spaces.member") return fail(`${op} is not simulated.`);
    const member = this.disks.find((d) => d.pool === p.id && d.id === params.member);
    switch (params.action) {
      case "add":
      case "add-spare":
      case "replace": {
        const d = claim(params.disk, params.serial, params.erase);
        if (typeof d === "string") return fail(d, /approved/.test(d) ? "stale" : "refused");
        d.pool = p.id;
        if (params.action === "add-spare") d.usage = "Hot Spare";
        if (params.action === "replace") {
          const old = this.disks.find((x) => x.pool === p.id && x.id === params.replaces);
          if (old && !old.op.some((o) => /Lost/.test(o))) old.usage = "Retired";
          if (old) old.usage = "Retired";
          p.job = { kind: "repair", started: this.now() };
        }
        return done(`${String(params.disk)} joined ${p.name}.`);
      }
      case "retire":
        if (!member) return fail("That drive is not in the pool.", "stale");
        member.usage = "Retired";
        p.job = { kind: "repair", started: this.now() };
        return done("The drive is retired.");
      case "restore":
        if (!member) return fail("That drive is not in the pool.", "stale");
        member.usage = "Auto-Select";
        return done("The drive is back in use.");
      case "remove":
        if (!member) return fail("That drive is not in the pool.", "stale");
        if (p.job) return fail("Windows is still moving data off it.");
        member.pool = undefined;
        member.usage = "Auto-Select";
        if (member.op.some((o) => /Lost/.test(o)))
          this.disks = this.disks.filter((d) => d !== member);
        return done("The drive left the pool. It was not erased.");
      default:
        return fail("Not available in the sample.");
    }
  }
}
