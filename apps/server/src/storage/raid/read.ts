import path from "node:path";
import {
  raidTolerance,
  type RaidArray,
  type RaidCandidate,
  type RaidHealth,
  type RaidMember,
  type RaidMemberRole,
  type RaidSchedule,
  type RaidSync,
  type RaidTechSupport,
} from "@dragon-control/core";
import type { RaidIO } from "./io";

/**
 * Linux software RAID (mdadm), read from the kernel's own files: /proc/mdstat for which arrays
 * exist, /sys/block/mdN/md/ for their level, state, members, and running check or rebuild, and
 * lsblk for each member's drive (model, serial, size). None of it needs root.
 */

export interface Block {
  name: string;
  kname: string;
  pkname?: string;
  type: string;
  sizeBytes: number;
  rotational?: boolean;
  transport?: string;
  fstype?: string;
  mount?: string;
  model?: string;
  serial?: string;
  partType?: string;
  /** The filesystem's UUID (all devices of one Btrfs filesystem share it). */
  uuid?: string;
  children: Block[];
}

interface RawBlock {
  name?: string;
  kname?: string;
  pkname?: string | null;
  type?: string;
  size?: number | string;
  rota?: boolean | string | number;
  tran?: string | null;
  fstype?: string | null;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  model?: string | null;
  serial?: string | null;
  parttypename?: string | null;
  uuid?: string | null;
  children?: RawBlock[];
}

const truthy = (v: unknown) => v === true || v === "1" || v === 1 || v === "true";

export function parseBlocks(json: string, allowLoop = false): Block[] {
  const raw = JSON.parse(json) as { blockdevices?: RawBlock[] };
  const walk = (b: RawBlock): Block => {
    const mount = b.mountpoint ?? b.mountpoints?.find((m) => m) ?? undefined;
    return {
      name: b.name ?? "?",
      kname: b.kname ?? b.name ?? "?",
      ...(b.pkname ? { pkname: b.pkname } : {}),
      type: b.type ?? "unknown",
      sizeBytes: Number(b.size ?? 0),
      ...(b.rota !== undefined && b.rota !== null ? { rotational: truthy(b.rota) } : {}),
      ...(b.tran ? { transport: b.tran } : {}),
      ...(b.fstype ? { fstype: b.fstype } : {}),
      ...(mount ? { mount } : {}),
      ...(b.model ? { model: b.model.trim() } : {}),
      ...(b.serial ? { serial: b.serial.trim() } : {}),
      ...(b.parttypename ? { partType: b.parttypename } : {}),
      ...(b.uuid ? { uuid: b.uuid } : {}),
      children: (b.children ?? []).map(walk),
    };
  };
  return (raw.blockdevices ?? [])
    .filter((b) => !/^(ram|zram)/.test(b.name ?? "") && (allowLoop || !/^loop/.test(b.name ?? "")))
    .map(walk);
}

/** Every block device, flat, each with the whole drive it belongs to. */
export function flatten(blocks: Block[]): { b: Block; disk: Block }[] {
  const out: { b: Block; disk: Block }[] = [];
  const walk = (b: Block, disk: Block) => {
    out.push({ b, disk });
    for (const c of b.children) walk(c, b.type === "disk" || b.type === "loop" ? b : disk);
  };
  for (const b of blocks) walk(b, b);
  return out;
}

const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/efi", "/usr", "/var", "[SWAP]"]);

const num = (s?: string) => {
  const n = Number(
    String(s ?? "")
      .trim()
      .split(/\s/)[0],
  );
  return Number.isFinite(n) ? n : undefined;
};
const text = (s?: string) => s?.trim() || undefined;

function roleOf(states: string[], slot: number | undefined, action: string): RaidMemberRole {
  if (states.includes("faulty")) return "faulty";
  if (states.includes("replacement")) return "replacing";
  if (states.includes("spare") || slot === undefined)
    return action === "recover" && slot !== undefined ? "rebuilding" : "spare";
  if (!states.includes("in_sync")) return "rebuilding";
  if (states.includes("write_mostly")) return "write-mostly";
  return "active";
}

/** The md devices /proc/mdstat lists ("md0", "md127"). */
export function mdNames(mdstat: string): string[] {
  return [...mdstat.matchAll(/^(md\w+)\s*:/gm)].map((m) => m[1]!);
}

/** "123 / 456" (sectors done / total) to a percentage. */
function progress(completed?: string): { done: number; total: number } | undefined {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(completed?.trim() ?? "");
  if (!m) return undefined;
  const total = Number(m[2]);
  return total > 0 ? { done: Number(m[1]), total } : undefined;
}

const HEALTH_TEXT: Record<RaidHealth, string> = {
  healthy: "Every member is in place and in step. One drive failing would not lose data.",
  degraded:
    "A member is missing or failed. The data is still there, but the array has less (or no) protection left until it is rebuilt.",
  rebuilding:
    "A member is being rebuilt from the others. Until it finishes, the array has less protection.",
  resyncing: "The members are being brought into step (after creation or an unclean shutdown).",
  checking: "A consistency check is reading every block. The array is fully usable meanwhile.",
  reshaping: "The array is being reshaped (more members or another layout). Leave it running.",
  failed:
    "Too many members are missing for the array to hold its data. Do not write to it; get help before changing anything.",
  inactive:
    "The array is not running. Its members are known, but it is not assembled, so its data cannot be read.",
  unknown: "Hearth could not tell the array's state.",
};

export interface ReadOptions {
  /** Loop devices count as drives (throwaway test arrays only). */
  allowLoop?: boolean;
  now?: number;
}

export async function readMdArrays(
  io: RaidIO,
  blocks: Block[],
  _opts: ReadOptions = {},
): Promise<RaidArray[]> {
  const mdstat = (await io.read("/proc/mdstat")) ?? "";
  const names = mdNames(mdstat);
  const flat = flatten(blocks);
  const byKname = new Map(flat.map((x) => [x.b.kname, x]));
  // mdadm's names for arrays ("/dev/md/media" -> md127).
  const named = new Map<string, string>();
  for (const n of await io.list("/dev/md")) {
    const to = await io.readlink(`/dev/md/${n}`);
    if (to) named.set(path.basename(to), n);
  }
  const conf = (await io.read("/etc/mdadm/mdadm.conf")) ?? (await io.read("/etc/mdadm.conf")) ?? "";
  const confUuids = [...conf.matchAll(/UUID=([0-9a-f:.-]+)/gi)].map((m) =>
    m[1]!.replace(/[^0-9a-f]/gi, "").toLowerCase(),
  );
  const sysMin = num(await io.read("/proc/sys/dev/raid/speed_limit_min"));
  const sysMax = num(await io.read("/proc/sys/dev/raid/speed_limit_max"));

  const out: RaidArray[] = [];
  for (const md of names) {
    const base = `/sys/block/${md}/md`;
    const r = (f: string) => io.read(`${base}/${f}`);
    const level = text(await r("level"));
    const arrayState = text(await r("array_state")) ?? "unknown";
    const raidDisks = num(await r("raid_disks"));
    const degraded = num(await r("degraded")) ?? 0;
    const completed = progress(await r("sync_completed"));
    // Newer kernels report "recover" for a degraded array that has nothing to rebuild onto (no
    // spare); nothing is copying then, so it is idle. A real rebuild has progress.
    const rawAction = text(await r("sync_action")) ?? "idle";
    const action = rawAction === "recover" && !completed ? "idle" : rawAction;
    const speed = num(await r("sync_speed"));
    const mismatches = num(await r("mismatch_cnt"));
    const chunk = num(await r("chunk_size"));
    const layoutRaw = text(await r("layout"));
    const metadata = text(await r("metadata_version"));
    const componentKiB = num(await r("component_size"));
    const uuid = text(await r("uuid"));
    const bitmap = text(await r("bitmap/location"));
    const syncMin = num(await r("sync_min"));
    const minRaw = text(await r("sync_speed_min"));
    const maxRaw = text(await r("sync_speed_max"));
    const sizeSectors = num(await io.read(`/sys/block/${md}/size`));

    const members: RaidMember[] = [];
    for (const entry of (await io.list(base)).filter((e) => e.startsWith("dev-"))) {
      const dev = entry.slice(4);
      const states = (text(await r(`${entry}/state`)) ?? "").split(",").filter(Boolean);
      const slotText = text(await r(`${entry}/slot`));
      const slot = slotText && slotText !== "none" ? Number(slotText) : undefined;
      const errors = num(await r(`${entry}/errors`));
      const found = byKname.get(dev);
      const disk = found?.disk;
      members.push({
        device: `/dev/${dev}`,
        ...(slot !== undefined && Number.isFinite(slot) ? { slot } : {}),
        role: roleOf(states, slot, action),
        states,
        ...(errors ? { errors } : {}),
        ...(disk
          ? {
              disk: `/dev/${disk.kname}`,
              ...(disk.model ? { model: disk.model } : {}),
              ...(disk.serial ? { serial: disk.serial } : {}),
              sizeBytes: (found?.b ?? disk).sizeBytes,
              ...(disk.transport ? { transport: disk.transport } : {}),
              ...(disk.rotational !== undefined ? { rotational: disk.rotational } : {}),
            }
          : {}),
      });
    }
    // Slots with no member are missing members. A failed member the kernel already took out of
    // its slot stands for one of them, so it is not counted twice.
    if (raidDisks !== undefined) {
      const taken = new Set(members.filter((m) => m.slot !== undefined).map((m) => m.slot!));
      let unslottedFaulty = members.filter(
        (m) => m.role === "faulty" && m.slot === undefined,
      ).length;
      for (let s = 0; s < raidDisks; s++)
        if (!taken.has(s)) {
          if (unslottedFaulty > 0) unslottedFaulty--;
          else members.push({ slot: s, role: "missing", states: [] });
        }
    }
    members.sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));

    const counts = {
      active: members.filter((m) => m.role === "active" || m.role === "write-mostly").length,
      failed: members.filter((m) => m.role === "faulty").length,
      missing: members.filter((m) => m.role === "missing").length,
      spare: members.filter((m) => m.role === "spare").length,
    };
    const tolerance = raidTolerance(level, raidDisks ?? 0);
    const lost = Math.max(degraded, counts.missing);
    const canLose = tolerance === undefined ? undefined : Math.max(0, tolerance - lost);

    let health: RaidHealth;
    if (arrayState === "inactive" || arrayState === "clear") health = "inactive";
    else if (arrayState === "broken" || (tolerance !== undefined && lost > tolerance))
      health = "failed";
    // "recover" is a rebuild only when a member is actually being rebuilt onto. Right after a
    // member fails with no spare, the kernel can show "recover" (with a progress line) for a
    // moment while it finds nothing to rebuild onto: that array is degraded, not rebuilding.
    else if (
      action === "recover" &&
      members.some((m) => m.role === "rebuilding" || m.role === "replacing")
    )
      health = "rebuilding";
    else if (action === "reshape") health = "reshaping";
    else if (lost > 0) health = "degraded";
    else if (action === "resync") health = "resyncing";
    else if (action === "check" || action === "repair") health = "checking";
    else if (level) health = "healthy";
    else health = "unknown";

    let sync: RaidSync | undefined;
    if (["resync", "recover", "check", "repair", "reshape"].includes(action)) {
      const left = completed ? completed.total - completed.done : undefined;
      sync = {
        action: action as RaidSync["action"],
        ...(completed
          ? { progressPct: Math.round((completed.done / completed.total) * 1000) / 10 }
          : {}),
        ...(speed ? { speedKiBs: speed } : {}),
        // Sectors are 512 bytes: left/2 KiB at speed KiB/s.
        ...(left !== undefined && speed ? { etaMinutes: Math.round(left / 2 / speed / 60) } : {}),
      };
    } else if (action === "idle" && syncMin && syncMin > 0) {
      // A check stopped part way: sync_min keeps where it got to.
      sync = {
        action: "check",
        paused: true,
        // sync_min counts sectors within one member.
        ...(componentKiB
          ? { progressPct: Math.round((syncMin / (componentKiB * 2)) * 1000) / 10 }
          : {}),
      };
    }

    // Where the array is mounted, and its filesystem, from lsblk.
    const node = byKname.get(md)?.b;
    const mount = node?.mount ?? node?.children.find((c) => c.mount)?.mount;
    const fstype = node?.fstype ?? node?.children.find((c) => c.fstype)?.fstype;
    const used = mount ? await io.statfs(mount) : undefined;

    const memberDisks = members.filter((m) => m.sizeBytes);
    const warnings: string[] = [];
    if (health === "degraded" || health === "rebuilding")
      warnings.push(
        canLose === 0
          ? "No redundancy left: one more drive failure would lose the array's data."
          : `It can lose ${canLose} more drive${canLose === 1 ? "" : "s"} before data is lost.`,
      );
    if (counts.failed)
      warnings.push(
        `${counts.failed} member${counts.failed > 1 ? "s are" : " is"} marked failed: replace ${counts.failed > 1 ? "them" : "it"}.`,
      );
    if (mismatches && mismatches > 0 && action === "idle")
      warnings.push(
        `The last check found ${mismatches.toLocaleString("en-US")} mismatched blocks. On RAID 1 and 10 some are normal after swap; otherwise look closer before repairing.`,
      );
    for (const m of members)
      if (m.errors && m.errors > 0)
        warnings.push(`${m.device} has had ${m.errors} read errors the array corrected.`);
    if (members.some((m) => m.states.includes("want_replacement")))
      warnings.push(
        "A member asked to be replaced (it is failing): replace it while the array is whole.",
      );
    if (bitmap === "none" && (raidDisks ?? 0) > 1 && level !== "raid0")
      warnings.push(
        "No write-intent bitmap: after a crash or a member drops out briefly, the whole array is resynced instead of only what changed.",
      );
    if (!counts.spare && tolerance !== undefined && tolerance > 0 && health === "healthy")
      warnings.push("No hot spare: a failed drive is only rebuilt once you add one.");

    const uuidHex = uuid?.replace(/[^0-9a-f]/gi, "").toLowerCase();
    const speedFrom = (s?: string) =>
      (/\(system\)/.test(s ?? "") ? "system" : "array") as "system" | "array";
    out.push({
      id: `mdadm:${md}`,
      tech: "mdadm",
      name: named.get(md) ?? md,
      device: `/dev/${md}`,
      ...(uuid ? { uuid } : {}),
      ...(level ? { level } : {}),
      ...(layoutRaw && level === "raid10"
        ? { layout: layoutRaw }
        : layoutRaw && /raid[456]/.test(level ?? "")
          ? { layout: layoutRaw }
          : {}),
      ...(chunk ? { chunkKiB: chunk / 1024 } : {}),
      ...(metadata ? { metadata } : {}),
      health,
      healthText: HEALTH_TEXT[health],
      ...(sizeSectors ? { sizeBytes: sizeSectors * 512 } : {}),
      ...(componentKiB ? { memberSizeBytes: componentKiB * 1024 } : {}),
      ...(memberDisks.length
        ? { rawBytes: memberDisks.reduce((n, m) => n + (m.sizeBytes ?? 0), 0) }
        : {}),
      ...(used ? { usedBytes: used.total - used.free } : {}),
      ...(raidDisks !== undefined ? { raidDevices: raidDisks } : {}),
      counts,
      ...(canLose !== undefined ? { canLose } : {}),
      members,
      ...(mount ? { mount } : {}),
      ...(fstype ? { fstype } : {}),
      ...(sync ? { sync } : {}),
      ...(minRaw || maxRaw
        ? {
            speedLimit: {
              minKiBs: num(minRaw) ?? sysMin ?? 1000,
              maxKiBs: num(maxRaw) ?? sysMax ?? 200000,
              minFrom: speedFrom(minRaw),
              maxFrom: speedFrom(maxRaw),
            },
          }
        : {}),
      ...(mismatches !== undefined ? { mismatches } : {}),
      ...(bitmap ? { bitmap } : {}),
      ...(uuidHex ? { inConfig: confUuids.includes(uuidHex) } : {}),
      warnings,
      actions: [],
    });
  }
  return out;
}

/**
 * Drives and partitions that could join an array. A drive holding the system, mounted anywhere,
 * in use by LVM or encryption, or already in an array is excluded with the reason; one with a
 * filesystem or old RAID signature is offered only as "has data" (joining erases it).
 */
export function readCandidates(blocks: Block[], arrays: RaidArray[]): RaidCandidate[] {
  const members = new Set(
    arrays.flatMap((a) => a.members.map((m) => m.device).filter(Boolean) as string[]),
  );
  const out: RaidCandidate[] = [];
  const mountsBelow = (b: Block): string[] => [
    ...(b.mount ? [b.mount] : []),
    ...b.children.flatMap(mountsBelow),
  ];
  for (const disk of blocks) {
    if (disk.type !== "disk" && disk.type !== "loop") continue;
    const info = {
      ...(disk.model ? { model: disk.model } : {}),
      ...(disk.serial ? { serial: disk.serial } : {}),
      ...(disk.transport ? { transport: disk.transport } : {}),
      ...(disk.rotational !== undefined ? { rotational: disk.rotational } : {}),
    };
    const all = mountsBelow(disk);
    const system = all.find((m) => SYSTEM_MOUNTS.has(m));
    const inUse = (b: Block): string | undefined => {
      // The device itself, or a partition on it (ZFS gives a whole drive a partition), is a
      // member of an array or pool of any kind.
      const member = [b, ...b.children].find((x) => members.has(`/dev/${x.kname}`));
      if (member) {
        const a = arrays.find((x) => x.members.some((m) => m.device === `/dev/${member.kname}`));
        return `Already in ${a?.name ?? "an array"}${a && a.tech !== "mdadm" ? ` (${a.tech === "zfs" ? "ZFS pool" : a.tech})` : ""}.`;
      }
      if (b.children.some((c) => c.type === "raid1" || /^raid|^md/.test(c.type)))
        return "Already in a running array.";
      if (b.children.some((c) => c.type === "lvm")) return "In use by LVM.";
      if (b.children.some((c) => c.type === "crypt")) return "In use by disk encryption.";
      const m = mountsBelow(b);
      if (m.length) return `Mounted at ${m.join(", ")}: in use.`;
      if (b.fstype === "swap") return "Used as swap.";
      return undefined;
    };
    const dev = `/dev/${disk.kname}`;
    if (system) {
      out.push({
        device: dev,
        kind: "disk",
        state: "excluded",
        reason: `Holds the system (${system}). Never offered.`,
        sizeBytes: disk.sizeBytes,
        ...info,
      });
      continue;
    }
    const diskUse = inUse(disk);
    const parts = disk.children.filter((c) => c.type === "part");
    out.push({
      device: dev,
      kind: "disk",
      sizeBytes: disk.sizeBytes,
      ...info,
      ...(diskUse
        ? { state: "excluded" as const, reason: diskUse }
        : parts.length
          ? {
              state: "has-data" as const,
              reason: `Has ${parts.length} partition${parts.length > 1 ? "s" : ""}${parts.some((p) => p.fstype) ? ` (${[...new Set(parts.map((p) => p.fstype).filter(Boolean))].join(", ")})` : ""}: using the whole drive erases them.`,
            }
          : disk.fstype
            ? {
                state: "has-data" as const,
                fstype: disk.fstype,
                reason:
                  disk.fstype === "linux_raid_member"
                    ? "Was a RAID member before: joining erases what it held (or re-adds it, if it was this array's)."
                    : `Holds a ${disk.fstype} filesystem: joining erases it.`,
              }
            : { state: "usable" as const }),
    });
    for (const p of parts) {
      // A partition of a drive that is in use, or a scrap (a Windows reserved or boot
      // partition), is never offered: Hearth does not split a drive that holds your data.
      const use =
        inUse(p) ??
        (diskUse || all.length
          ? `Another part of this drive is in use (${all.join(", ") || diskUse}).`
          : p.sizeBytes < 1024 ** 3
            ? "Too small for an array."
            : undefined);
      out.push({
        device: `/dev/${p.kname}`,
        kind: "part",
        sizeBytes: p.sizeBytes,
        disk: dev,
        ...info,
        ...(use
          ? { state: "excluded" as const, reason: use }
          : p.fstype
            ? {
                state: "has-data" as const,
                fstype: p.fstype,
                reason:
                  p.fstype === "linux_raid_member"
                    ? "Was a RAID member before: joining erases what it held (or re-adds it, if it was this array's)."
                    : `Holds a ${p.fstype} filesystem: joining erases it.`,
              }
            : { state: "usable" as const }),
      });
    }
  }
  return out;
}

/** Consistency checks the operating system already runs (Debian/Ubuntu cron, systemd timers). */
export async function readSystemSchedules(io: RaidIO): Promise<RaidSchedule[]> {
  const out: RaidSchedule[] = [];
  const cron = await io.read("/etc/cron.d/mdadm");
  const defaults = (await io.read("/etc/default/mdadm")) ?? "";
  const autocheckOff = /^\s*AUTOCHECK\s*=\s*"?false/im.test(defaults);
  if (cron && /checkarray/.test(cron) && !autocheckOff) {
    const line = cron.split("\n").find((l) => /checkarray/.test(l) && !/^\s*#/.test(l));
    out.push({
      by: "system",
      every: "monthly",
      text: `The system checks every array monthly${line ? ` (cron: ${line.trim().split(/\s+/).slice(0, 5).join(" ")}, the first Sunday)` : ""} (Debian checkarray).`,
    });
  }
  for (const dir of [
    "/etc/systemd/system/timers.target.wants",
    "/etc/systemd/system/mdmonitor.service.wants",
  ])
    for (const t of await io.list(dir))
      if (/^mdcheck_start\.timer$/.test(t))
        out.push({
          by: "system",
          every: "monthly",
          text: "The system's mdcheck timer checks arrays monthly (a few hours each night until done).",
        });
  if (autocheckOff && cron)
    out.push({
      by: "system",
      text: "The system's monthly check is switched off (AUTOCHECK=false).",
    });
  return out;
}

export async function mdTechSupport(
  io: RaidIO,
  blocks: Block[],
  arrays: RaidArray[],
  verified: RaidTechSupport["verified"],
): Promise<RaidTechSupport[]> {
  const flat = flatten(blocks);
  const fstypes = flat.map((x) => x.b.fstype).filter(Boolean) as string[];
  const bin = async (n: string) =>
    (
      await Promise.all(
        ["/usr/sbin", "/sbin", "/usr/bin", "/bin"].map((d) => io.exists(`${d}/${n}`)),
      )
    ).some(Boolean);
  const mdadm = await bin("mdadm");
  return [
    {
      tech: "mdadm",
      seen: arrays.length
        ? `${arrays.length} array${arrays.length > 1 ? "s" : ""} in /proc/mdstat`
        : fstypes.includes("linux_raid_member")
          ? "RAID member partitions present, but no running array"
          : "No arrays in /proc/mdstat",
      support: "manage",
      verified,
      tools: [{ name: "mdadm", present: mdadm }],
    },
    {
      tech: "zfs",
      seen: fstypes.includes("zfs_member")
        ? "ZFS pool members present; Hearth does not read pools yet"
        : "No ZFS pool members",
      support: fstypes.includes("zfs_member") ? "detect" : "none",
      verified: "none",
      tools: [{ name: "zpool", present: await bin("zpool") }],
    },
    {
      tech: "btrfs",
      seen: fstypes.includes("btrfs")
        ? "Btrfs filesystems present; their multi-device health is not read yet"
        : "No Btrfs filesystems",
      support: fstypes.includes("btrfs") ? "detect" : "none",
      verified: "none",
      tools: [{ name: "btrfs", present: await bin("btrfs") }],
    },
    {
      tech: "lvm",
      seen: fstypes.includes("LVM2_member")
        ? "LVM volumes present; LVM RAID is not read yet"
        : "No LVM volumes",
      support: fstypes.includes("LVM2_member") ? "detect" : "none",
      verified: "none",
    },
    {
      tech: "unraid",
      seen: (await io.exists("/etc/unraid-version"))
        ? "This is Unraid; its array and parity are not read yet"
        : "Not Unraid",
      support: (await io.exists("/etc/unraid-version")) ? "detect" : "none",
      verified: "none",
    },
    {
      tech: "hardware",
      seen: "Hardware RAID controllers are not read (each vendor needs its own tool).",
      support: "none",
      verified: "none",
    },
  ];
}
