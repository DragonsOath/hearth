import {
  raidTolerance,
  type RaidAction,
  type RaidActionId,
  type RaidArray,
  type RaidCandidate,
  type RaidCreateOption,
  type RaidHealth,
  type RaidMember,
  type RaidMemberRole,
  type RaidSchedule,
  type RaidSync,
  type RaidTechSupport,
} from "@dragon-control/core";
import type { OperationName } from "../../elevated/protocol";
import { eta, gb } from "./actions";
import {
  Refuse,
  driveWords,
  pickCandidate,
  pickMember,
  sameDrive,
  type DriverEnv,
  type PlanWords,
  type RaidDriver,
} from "./driver";
import { flatten, type Block } from "./read";

/**
 * ZFS pools (TrueNAS SCALE, Proxmox, Ubuntu), read with `zpool status -P -L -p`, `zpool list`, and
 * `zfs get`, which any account may run. Changes go through the elevated executor's zfs.*
 * operations: fixed zpool commands on checked drives, read back afterwards.
 */

export const ZFS_OPERATIONS: readonly OperationName[] = [
  "zfs.member",
  "zfs.scrub",
  "zfs.clear",
  "zfs.grow",
  "zfs.create",
];

/* ---------- reading zpool status ---------- */

export interface ZLeaf {
  name: string;
  state: string;
  read: number;
  write: number;
  cksum: number;
  /** The rest of the line: "was /dev/sdd1", "(resilvering)". */
  note?: string;
  /** Inside a replacing-N or spare-N group: the old drive (first) or the new one. */
  replacing?: "old" | "new";
}

export interface ZVdev {
  name: string;
  /** mirror, raidz1, raidz2, raidz3, draid, or disk (a single drive on its own). */
  type: string;
  state: string;
  leaves: ZLeaf[];
}

export interface ZPool {
  name: string;
  state: string;
  status?: string;
  action?: string;
  scan?: string;
  errors?: string;
  vdevs: ZVdev[];
  logs: ZVdev[];
  special: ZVdev[];
  spares: ZLeaf[];
  cache: ZLeaf[];
}

const SECTIONS = new Set(["logs", "cache", "spares", "special", "dedup"]);
const GROUP = /^(mirror|raidz[123]?|draid[123]?(:[\w:]+)?|replacing|spare)-\d+$/;

/** "1.2K" (or an exact count) as a number. */
function count(s?: string): number {
  if (!s) return 0;
  const m = /^([\d.]+)([KMGT]?)$/.exec(s.trim());
  if (!m) return 0;
  const mult = { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2] as "" | "K" | "M" | "G" | "T"];
  return Math.round(Number(m[1]) * mult);
}

/** Each "key: text" field of a pool's block, with its continuation lines joined. */
function fields(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | undefined;
  for (const line of block.split("\n")) {
    const m =
      /^\s{0,3}(pool|state|status|action|see|scan|scrub|remove|config|errors|id):\s?(.*)$/.exec(
        line,
      );
    if (m) {
      key = m[1] === "scrub" ? "scan" : m[1]!;
      out[key] = m[2]!.trim();
    } else if (key && key !== "config" && line.trim())
      out[key] = `${out[key]} ${line.trim()}`.trim();
    else if (key === "config") out.config = `${out.config ?? ""}\n${line}`;
  }
  return out;
}

const indent = (line: string) => line.replace(/\t/g, "        ").search(/\S/);

export function parseZpoolStatus(text: string): ZPool[] {
  const pools: ZPool[] = [];
  for (const block of text.split(/^(?=\s{0,3}pool: )/m)) {
    const f = fields(block);
    if (!f.pool) continue;
    const pool: ZPool = {
      name: f.pool,
      state: (f.state ?? "UNKNOWN").split(/\s/)[0]!,
      ...(f.status ? { status: f.status } : {}),
      ...(f.action ? { action: f.action } : {}),
      ...(f.scan ? { scan: f.scan } : {}),
      ...(f.errors ? { errors: f.errors } : {}),
      vdevs: [],
      logs: [],
      special: [],
      spares: [],
      cache: [],
    };
    const rows = (f.config ?? "")
      .split("\n")
      .filter((l) => l.trim() && !/^\s*NAME\s+STATE/.test(l));
    if (!rows.length) {
      pools.push(pool);
      continue;
    }
    const base = indent(rows[0]!);
    let section = "data";
    let vdev: { v: ZVdev; at: number } | undefined;
    let replacing: { leaves: ZLeaf[]; at: number } | undefined;
    const put = (v: ZVdev) => {
      if (section === "logs") pool.logs.push(v);
      else if (section === "special" || section === "dedup") pool.special.push(v);
      else pool.vdevs.push(v);
    };
    for (const row of rows) {
      const at = indent(row);
      const parts = row.trim().split(/\s+/);
      const name = parts[0]!;
      if (at <= base) {
        // The pool's own row, or a section heading (logs, cache, spares, special).
        section = SECTIONS.has(name) ? name : "data";
        vdev = undefined;
        replacing = undefined;
        continue;
      }
      const [state = "", read, write, cksum, ...rest] = parts.slice(1);
      const note = rest.join(" ") || undefined;
      if (replacing && at <= replacing.at) replacing = undefined;
      if (vdev && at <= vdev.at) vdev = undefined;
      if (GROUP.test(name)) {
        if (/^(replacing|spare)-\d+$/.test(name)) {
          // A drive being replaced (or covered by a spare): the old and the new drive under it.
          replacing = { leaves: [], at };
          if (!vdev) {
            vdev = { v: { name, type: "disk", state, leaves: [] }, at };
            put(vdev.v);
          }
          continue;
        }
        vdev = {
          v: {
            name,
            type: name
              .replace(/-\d+$/, "")
              .replace(/^raidz$/, "raidz1")
              .replace(/:.*$/, ""),
            state,
            leaves: [],
          },
          at,
        };
        put(vdev.v);
        continue;
      }
      const leaf: ZLeaf = {
        name,
        state,
        read: count(read),
        write: count(write),
        cksum: count(cksum),
        ...(note ? { note } : {}),
      };
      if (replacing) {
        leaf.replacing = replacing.leaves.length ? "new" : "old";
        replacing.leaves.push(leaf);
      }
      if (section === "spares") pool.spares.push(leaf);
      else if (section === "cache") pool.cache.push(leaf);
      else if (vdev) vdev.v.leaves.push(leaf);
      // A drive on its own directly under the pool (or a section): its own one-drive group.
      else put({ name, type: "disk", state, leaves: [leaf] });
    }
    pools.push(pool);
  }
  return pools;
}

/* ---------- the scan line ---------- */

const UNIT: Record<string, number> = {
  "": 1,
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5,
};

function scanState(scan?: string): { sync?: RaidSync; last?: RaidArray["lastCheck"] } {
  if (!scan) return {};
  const pct = /([\d.]+)% done/.exec(scan);
  const left = /(?:(\d+) days? )?(\d+):(\d\d):(\d\d) to go/.exec(scan);
  const speed = /issued at ([\d.]+)([KMGTP]?)\/s/.exec(scan);
  const etaMinutes = left
    ? Number(left[1] ?? 0) * 1440 + Number(left[2]) * 60 + Number(left[3])
    : undefined;
  const progress = {
    ...(pct ? { progressPct: Math.round(Number(pct[1]) * 10) / 10 } : {}),
    ...(etaMinutes !== undefined ? { etaMinutes } : {}),
    ...(speed ? { speedKiBs: Math.round((Number(speed[1]) * UNIT[speed[2]!]!) / 1024) } : {}),
  };
  const when = (re: RegExp) => {
    const m = re.exec(scan);
    if (!m) return undefined;
    const d = new Date(m[1]!.trim());
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  if (/resilver in progress/.test(scan)) return { sync: { action: "resilver", ...progress } };
  if (/scrub paused/.test(scan)) return { sync: { action: "scrub", paused: true, ...progress } };
  if (/scrub in progress/.test(scan)) return { sync: { action: "scrub", ...progress } };
  const errors = /with (\d+) errors/.exec(scan);
  if (/scrub repaired/.test(scan)) {
    const at = when(/ on (.+)$/);
    const repaired = /repaired (\S+)/.exec(scan)?.[1];
    return {
      last: {
        ...(at ? { at } : {}),
        errors: Number(errors?.[1] ?? 0),
        text: `Last scrub${at ? ` ${at.slice(0, 10)}` : ""}: ${Number(errors?.[1] ?? 0) ? `${errors![1]} errors` : "no errors"}${repaired && repaired !== "0B" && repaired !== "0" ? `, repaired ${repaired}` : ""}.`,
      },
    };
  }
  if (/resilvered/.test(scan)) {
    const at = when(/ on (.+)$/);
    return {
      last: {
        ...(at ? { at } : {}),
        errors: Number(errors?.[1] ?? 0),
        text: `Last rebuild (resilver)${at ? ` finished ${at.slice(0, 10)}` : ""} with ${Number(errors?.[1] ?? 0)} errors. No scrub since.`,
      },
    };
  }
  if (/scrub canceled/.test(scan)) {
    const at = when(/canceled on (.+)$/);
    return {
      last: { ...(at ? { at } : {}), text: "The last scrub was cancelled before it finished." },
    };
  }
  if (/none requested/.test(scan)) return { last: { text: "Never scrubbed." } };
  return {};
}

/* ---------- pools as arrays ---------- */

const LEVEL_TEXT: Record<string, string> = {
  mirror: "Mirror",
  raidz1: "RAID-Z1",
  raidz2: "RAID-Z2",
  raidz3: "RAID-Z3",
  draid: "dRAID",
  disk: "Single drives (no redundancy)",
};

export function vdevTolerance(v: ZVdev): number {
  // A drive being rebuilt onto protects nothing yet.
  if (v.type === "mirror") return v.leaves.filter((l) => l.replacing !== "new").length - 1;
  if (v.type === "draid") return Number(/draid(\d)/.exec(v.name)?.[1] ?? 1);
  return raidTolerance(v.type, v.leaves.length) ?? 0;
}

const HEALTH_TEXT: Record<RaidHealth, string> = {
  healthy: "Every drive is online. The pool can lose a drive in each group without losing data.",
  degraded:
    "A drive is missing, failed, or offline. The data is still there, but with less (or no) protection until it is replaced.",
  rebuilding:
    "ZFS is rebuilding (resilvering) onto a drive. Until it finishes, the pool has less protection.",
  resyncing: "The pool is being brought into step.",
  checking: "A scrub is reading and verifying every block. The pool is fully usable meanwhile.",
  reshaping: "The pool is being reshaped. Leave it running.",
  failed:
    "Too many drives are missing for the pool to hold its data, or ZFS suspended it. Do not write to it; get help before changing anything.",
  inactive: "The pool is offline.",
  unknown: "Hearth could not tell the pool's state.",
};

interface PoolInfo {
  size?: number;
  alloc?: number;
  free?: number;
  guid?: string;
  autoexpand?: boolean;
  expandBytes?: number;
  frag?: number;
  cap?: number;
}

export function parseZpoolList(text: string): Map<string, PoolInfo> {
  const out = new Map<string, PoolInfo>();
  for (const line of text.split("\n")) {
    const c = line.split("\t");
    if (c.length < 10) continue;
    const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
    out.set(c[0]!, {
      ...(n(c[1]) !== undefined ? { size: n(c[1]) } : {}),
      ...(n(c[2]) !== undefined ? { alloc: n(c[2]) } : {}),
      ...(n(c[3]) !== undefined ? { free: n(c[3]) } : {}),
      ...(c[5] ? { guid: c[5] } : {}),
      autoexpand: c[6] === "on",
      ...(n(c[7]) ? { expandBytes: n(c[7]) } : {}),
      ...(n(c[8]?.replace("%", "")) !== undefined ? { frag: n(c[8]?.replace("%", "")) } : {}),
      ...(n(c[9]?.replace("%", "")) !== undefined ? { cap: n(c[9]?.replace("%", "")) } : {}),
    });
  }
  return out;
}

export const ZPOOL_LIST_ARGS = [
  "list",
  "-H",
  "-p",
  "-o",
  "name,size,allocated,free,health,guid,autoexpand,expandsize,fragmentation,capacity",
];

function roleOf(leaf: ZLeaf, section: "data" | "spares" | "cache" | "logs"): RaidMemberRole {
  if (section === "cache") return "cache";
  if (section === "logs") return "log";
  if (section === "spares")
    return leaf.state === "INUSE" ? "active" : leaf.state === "AVAIL" ? "spare" : "faulty";
  if (/resilvering/.test(leaf.note ?? "") || leaf.replacing === "new")
    return leaf.state === "ONLINE" || /resilvering/.test(leaf.note ?? "") ? "rebuilding" : "faulty";
  switch (leaf.state) {
    case "ONLINE":
    case "DEGRADED":
      return leaf.replacing === "old" ? "replacing" : "active";
    case "OFFLINE":
      return "offline";
    case "REMOVED":
      return "missing";
    default:
      return "faulty";
  }
}

export interface ZfsReadContext {
  blocks: Block[];
  info: Map<string, PoolInfo>;
  datasets: Map<string, { used?: number; available?: number; mountpoint?: string }>;
  now?: number;
}

/** One pool as the tab's array: members with their drives, groups, scan, warnings. */
export function poolToArray(p: ZPool, ctx: ZfsReadContext): RaidArray {
  const flat = flatten(ctx.blocks);
  const byPath = new Map(flat.map((x) => [`/dev/${x.b.kname}`, x]));
  const info = ctx.info.get(p.name) ?? {};
  const ds = ctx.datasets.get(p.name) ?? {};
  const scan = scanState(p.scan);
  const member = (leaf: ZLeaf, group: string, role: RaidMemberRole): RaidMember => {
    const was = /was (\S+)/.exec(leaf.note ?? "")?.[1];
    const found = byPath.get(leaf.name) ?? (was ? byPath.get(was) : undefined);
    const disk = found?.disk;
    const errors = leaf.read + leaf.write + leaf.cksum;
    return {
      device: leaf.name,
      group,
      role,
      states: [leaf.state.toLowerCase()],
      stateText: `${leaf.state}${leaf.note ? ` ${leaf.note}` : ""}`,
      ...(errors
        ? { errors, errorCounts: { read: leaf.read, write: leaf.write, checksum: leaf.cksum } }
        : {}),
      ...(disk
        ? {
            disk: `/dev/${disk.kname}`,
            ...(disk.model ? { model: disk.model } : {}),
            ...(disk.serial ? { serial: disk.serial } : {}),
            sizeBytes: disk.sizeBytes,
            ...(disk.transport ? { transport: disk.transport } : {}),
            ...(disk.rotational !== undefined ? { rotational: disk.rotational } : {}),
          }
        : {}),
    };
  };
  const members: RaidMember[] = [];
  for (const v of p.vdevs)
    for (const l of v.leaves) members.push(member(l, v.name, roleOf(l, "data")));
  for (const v of [...p.special, ...p.logs])
    for (const l of v.leaves)
      members.push(member(l, v.name, p.logs.includes(v) ? "log" : roleOf(l, "data")));
  for (const l of p.spares) members.push(member(l, "spares", roleOf(l, "spares")));
  for (const l of p.cache) members.push(member(l, "cache", "cache"));

  // A drive being rebuilt onto does not protect yet; the one it replaces counts until it is gone.
  const lostIn = (v: ZVdev) =>
    v.leaves.filter((l) => l.replacing !== "new" && !["ONLINE", "DEGRADED"].includes(l.state))
      .length;
  const dataVdevs = [...p.vdevs, ...p.special];
  const canLose = dataVdevs.length
    ? Math.max(0, Math.min(...dataVdevs.map((v) => vdevTolerance(v) - lostIn(v))))
    : undefined;
  const types = [...new Set(p.vdevs.map((v) => v.type))];
  const level = types.length === 1 ? types[0]! : types.length ? "mixed" : undefined;
  const levelText =
    types.length === 1
      ? `${LEVEL_TEXT[types[0]!] ?? types[0]}${p.vdevs.length > 1 ? `, ${p.vdevs.length} groups of ${p.vdevs[0]!.leaves.length}` : `, ${p.vdevs[0]!.leaves.length} drive${p.vdevs[0]!.leaves.length === 1 ? "" : "s"}`}`
      : types.length
        ? `Mixed: ${p.vdevs.map((v) => `${LEVEL_TEXT[v.type] ?? v.type} (${v.leaves.length})`).join(" + ")}`
        : undefined;

  const counts = {
    active: members.filter((m) => m.role === "active" && m.group !== "spares").length,
    failed: members.filter((m) => m.role === "faulty").length,
    missing: members.filter((m) => m.role === "missing" || m.role === "offline").length,
    spare: members.filter((m) => m.role === "spare").length,
  };

  let health: RaidHealth;
  if (["FAULTED", "UNAVAIL", "SUSPENDED"].includes(p.state)) health = "failed";
  else if (p.state === "OFFLINE") health = "inactive";
  else if (scan.sync?.action === "resilver") health = "rebuilding";
  else if (p.state === "DEGRADED") health = "degraded";
  else if (scan.sync?.action === "scrub" && !scan.sync.paused) health = "checking";
  else if (p.state === "ONLINE") health = "healthy";
  else health = "unknown";

  const dataErr = /(\d+) data errors/.exec(p.errors ?? "");
  const permanent = /Permanent errors/.test(p.errors ?? "");
  const dataErrors =
    dataErr || permanent
      ? {
          count: Number(dataErr?.[1] ?? 1),
          text: `ZFS found ${dataErr ? `${dataErr[1]} damaged blocks` : "damaged files"} it could not repair. Those files need restoring from a backup (zpool status -v lists them).`,
        }
      : undefined;

  const warnings: string[] = [];
  if (health === "degraded" || health === "rebuilding")
    warnings.push(
      canLose === 0
        ? "No redundancy left in at least one group: one more drive failure there would lose the pool."
        : `It can lose ${canLose} more drive${canLose === 1 ? "" : "s"} (in the weakest group) before data is lost.`,
    );
  if (counts.failed)
    warnings.push(
      `${counts.failed} drive${counts.failed > 1 ? "s have" : " has"} failed: replace ${counts.failed > 1 ? "them" : "it"}.`,
    );
  const offline = members.filter((m) => m.role === "offline");
  if (offline.length)
    warnings.push(
      `${offline.map((m) => m.device).join(", ")} ${offline.length > 1 ? "are" : "is"} offline (taken out on purpose). Bring ${offline.length > 1 ? "them" : "it"} back online or replace ${offline.length > 1 ? "them" : "it"}.`,
    );
  for (const m of members)
    if (m.errorCounts && m.errors)
      warnings.push(
        `${m.device} has had ${Object.entries(m.errorCounts)
          .filter(([, n]) => n)
          .map(([k, n]) => `${n} ${k}`)
          .join(
            ", ",
          )} errors. Check its cable and SMART health; clear the count once it is dealt with.`,
      );
  if (dataErrors) warnings.push(dataErrors.text);
  const now = ctx.now ?? Date.now();
  if (!scan.sync && scan.last?.at) {
    const days = Math.floor((now - Date.parse(scan.last.at)) / 86_400_000);
    if (days > 35)
      warnings.push(
        `Not scrubbed for ${days} days. A monthly scrub finds silent damage while it can still be repaired.`,
      );
  } else if (!scan.sync && /Never scrubbed/.test(scan.last?.text ?? ""))
    warnings.push(
      "Never scrubbed. A scrub reads every block and repairs silent damage from the good copy.",
    );
  if (info.cap !== undefined && info.cap >= 80)
    warnings.push(`${info.cap}% full. ZFS slows down past about 80%; free space or add capacity.`);
  if (info.expandBytes)
    warnings.push(
      `${gb(info.expandBytes)} of drive space is not used yet: the drives were replaced with larger ones. Expand the pool to use it.`,
    );

  const notes = [p.status, p.action].filter(Boolean) as string[];
  const usable =
    ds.used !== undefined && ds.available !== undefined ? ds.used + ds.available : undefined;
  return {
    id: `zfs:${p.name}`,
    tech: "zfs",
    name: p.name,
    device: p.name,
    ...(info.guid ? { uuid: info.guid } : {}),
    ...(level ? { level } : {}),
    ...(levelText ? { levelText } : {}),
    health,
    healthText: HEALTH_TEXT[health],
    ...(usable ? { sizeBytes: usable } : {}),
    ...(info.size ? { rawBytes: info.size } : {}),
    ...(ds.used !== undefined ? { usedBytes: ds.used } : {}),
    raidDevices: p.vdevs.reduce((n, v) => n + v.leaves.length, 0),
    counts,
    ...(canLose !== undefined ? { canLose } : {}),
    members,
    ...(ds.mountpoint && ds.mountpoint !== "none" && ds.mountpoint !== "-"
      ? { mount: ds.mountpoint }
      : {}),
    fstype: "zfs",
    ...(scan.sync ? { sync: scan.sync } : {}),
    ...(scan.last ? { lastCheck: scan.last } : {}),
    ...(dataErrors ? { dataErrors } : {}),
    groups: [...p.vdevs, ...p.special, ...p.logs].map((v) => ({
      name: v.name,
      level: v.type,
      health: (v.state === "ONLINE"
        ? "healthy"
        : v.state === "DEGRADED"
          ? "degraded"
          : "failed") as RaidHealth,
      stateText: v.state,
    })),
    ...(notes.length ? { notes } : {}),
    ...(info.autoexpand !== undefined
      ? { layout: info.autoexpand ? "autoexpand on" : "autoexpand off" }
      : {}),
    warnings,
    actions: [],
  };
}

/* ---------- what can be done ---------- */

const LABELS: Partial<Record<RaidActionId, string>> = {
  check: "Scrub (check and repair every block)",
  "pause-check": "Pause the scrub",
  "resume-check": "Resume the scrub",
  "cancel-check": "Stop the scrub",
  replace: "Replace a drive",
  "add-disk": "Add a disk to rebuild",
  "add-spare": "Add a hot spare",
  "remove-spare": "Remove a spare",
  "mark-failed": "Take a drive offline",
  "re-add": "Bring a drive back online",
  remove: "Detach a drive from its mirror",
  "clear-errors": "Clear error counts",
  "grow-devices": "Add a drive to a group (another mirror copy, or widen RAID-Z)",
  "grow-size": "Use the larger drives' full size",
  "schedule-check": "Schedule regular scrubs",
  speed: "Scrub and rebuild speed",
  "change-level": "Change the layout",
  identify: "Identify the physical drives",
};

export interface ZfsActionContext {
  candidates: RaidCandidate[];
  ready: { ready: boolean; why?: string };
  /** OpenZFS version ("2.2.2"): widening RAID-Z needs 2.3. */
  version?: string;
}

const atLeast = (v: string | undefined, want: [number, number]) => {
  const m = /(\d+)\.(\d+)/.exec(v ?? "");
  if (!m) return false;
  return Number(m[1]) > want[0] || (Number(m[1]) === want[0] && Number(m[2]) >= want[1]);
};

export function zfsActions(a: RaidArray, ctx: ZfsActionContext): RaidAction[] {
  const out: RaidAction[] = [];
  const add = (
    id: RaidActionId,
    status: RaidAction["status"],
    reason?: string,
    extra: Partial<RaidAction> = {},
  ) => out.push({ id, label: LABELS[id] ?? id, status, ...(reason ? { reason } : {}), ...extra });
  const busy = a.sync && !a.sync.paused ? a.sync.action : undefined;
  const failed = a.health === "failed" || a.health === "inactive";
  const groups = a.groups ?? [];
  const dataGroups = groups.filter(
    (g) => g.level !== "disk" || a.members.some((m) => m.group === g.name && m.role !== "log"),
  );
  const redundant = dataGroups.some((g) => g.level && g.level !== "disk");
  const smallest = Math.min(
    ...a.members
      .filter((m) => m.sizeBytes && m.group !== "cache" && m.group !== "spares")
      .map((m) => m.sizeBytes!),
  );
  const min = Number.isFinite(smallest) ? smallest : undefined;
  const usable = ctx.candidates.filter(
    (c) => c.state !== "excluded" && (!min || (c.sizeBytes ?? 0) >= min),
  );
  const noDisk = min
    ? `No free drive of at least ${gb(min)} is connected. Connect one (it must not be the system drive or mounted), then read again.`
    : "No free drive is connected.";
  const pct = a.sync?.progressPct !== undefined ? `${a.sync.progressPct}%` : "";
  const left = a.sync?.etaMinutes !== undefined ? `, about ${eta(a.sync.etaMinutes)} left` : "";

  // Scrubs.
  if (busy === "scrub") add("check", "running", `${pct}${left}`);
  else if (busy === "resilver")
    add("check", "blocked", "A rebuild (resilver) is running; scrub after it finishes.");
  else if (failed) add("check", "blocked", "The pool is not online.");
  else if (a.sync?.paused)
    add("check", "blocked", "A scrub is paused: resume it, or stop it to start over.");
  else
    add("check", "available", undefined, {
      risk: "Reads every block and repairs damage from the good copy. Drives are busier while it runs (hours on large pools). Safe on a degraded pool, though it then cannot repair what lacks a copy.",
    });
  if (busy === "scrub") {
    add("pause-check", "available", "Keeps its place; resume continues from there.");
    add("cancel-check", "available", "Stops it; the next scrub starts from the beginning.");
  } else if (busy === "resilver")
    add(
      "cancel-check",
      "unsupported",
      "A rebuild (resilver) cannot be stopped: it restores the pool's protection.",
    );
  if (a.sync?.paused)
    add("resume-check", "available", `Continues from ${a.sync.progressPct ?? 0}%.`);
  add("speed", "unsupported", "ZFS paces scrubs and rebuilds itself, giving way to normal use.");

  // Drives.
  add(
    "add-disk",
    "unsupported",
    "In ZFS a failed or missing drive is swapped with Replace, which rebuilds onto the new one.",
  );
  const failing = a.members.filter(
    (m) => ["faulty", "missing", "offline"].includes(m.role) || (m.errors ?? 0) > 0,
  );
  if (!redundant && !failing.length)
    add(
      "replace",
      "blocked",
      "Every group is a single drive: a working drive can still be replaced (ZFS copies it first), but connect a new drive to do it.",
    );
  if (failed) add("replace", "blocked", "The pool is not online.");
  else if (!usable.length) add("replace", "blocked", noDisk);
  else if (!out.some((x) => x.id === "replace"))
    add(
      "replace",
      "available",
      failing.length ? `Suggested for ${failing.map((m) => m.device).join(", ")}.` : undefined,
      {
        risk: failing.length
          ? "ZFS rebuilds (resilvers) the new drive from the others: less protection until it finishes."
          : "A working drive is copied to the new one while it stays in the pool, so protection is kept throughout.",
      },
    );
  if (failed) add("add-spare", "blocked", "The pool is not online.");
  else if (!redundant)
    add("add-spare", "unsupported", "A spare needs a group with redundancy to rebuild into.");
  else if (!usable.length) add("add-spare", "blocked", noDisk);
  else
    add("add-spare", "available", undefined, {
      risk: "The drive waits unused; ZFS's event daemon (zed) swaps it in when a drive fails.",
    });
  if (a.counts.spare) add("remove-spare", "available");
  const canOffline = a.canLose !== undefined && a.canLose > 0;
  if (!redundant)
    add(
      "mark-failed",
      "unsupported",
      "Taking a drive offline would take the pool down: no group has a second copy.",
    );
  else if (!canOffline)
    add(
      "mark-failed",
      "blocked",
      "No redundancy left: taking another drive offline would take the pool down.",
    );
  else
    add("mark-failed", "available", undefined, {
      risk: "The pool loses that drive's protection until it is back online. Nothing on it is erased.",
    });
  if (a.members.some((m) => m.role === "offline"))
    add("re-add", "available", "ZFS copies only what changed while it was offline.");
  else add("re-add", "blocked", "No drive is offline.");
  if (
    groups.some(
      (g) => g.level === "mirror" && a.members.filter((m) => m.group === g.name).length > 1,
    )
  )
    add(
      "remove",
      "available",
      "Only a mirror member is detached; the mirror keeps its other copies.",
      {
        risk: "The mirror has one copy fewer afterwards. The detached drive is not erased, but it can no longer be imported on its own.",
      },
    );
  else
    add(
      "remove",
      "blocked",
      "Only a drive in a mirror with another copy can be detached. Spares are removed with Remove a spare.",
    );
  if (a.members.some((m) => (m.errors ?? 0) > 0) || a.health === "degraded")
    add(
      "clear-errors",
      "available",
      "Once the cause (cable, drive) is dealt with: ZFS forgets the counts and tries a faulted drive again.",
    );
  else add("clear-errors", "blocked", "No errors are counted.");

  // Capacity.
  const mirror = groups.find((g) => g.level === "mirror");
  const raidz = groups.find((g) => /^raidz/.test(g.level ?? ""));
  if (a.health !== "healthy" || busy)
    add("grow-devices", "blocked", "Grow only a whole, idle pool.");
  else if (!usable.length) add("grow-devices", "blocked", noDisk);
  else if (mirror)
    add(
      "grow-devices",
      "available",
      "Adds another copy to a mirror (more protection, not more space).",
      {
        risk: "ZFS copies the mirror onto the new drive.",
      },
    );
  else if (raidz && atLeast(ctx.version, [2, 3]))
    add(
      "grow-devices",
      "available",
      `Widens ${raidz.name} by one drive (RAID-Z expansion, OpenZFS ${ctx.version}).`,
      {
        irreversible: true,
        risk: "Runs for many hours; the pool stays usable. A group cannot be narrowed again. Old data keeps its old parity ratio until it is rewritten.",
      },
    );
  else if (raidz)
    add(
      "grow-devices",
      "unsupported",
      `Widening a RAID-Z group needs OpenZFS 2.3 or newer (this machine has ${ctx.version ?? "an older one"}). To grow now, replace each drive with a larger one, then use their full size.`,
    );
  else add("grow-devices", "unsupported", "Single-drive groups are not widened.");
  const expand = a.warnings.find((w) => /not used yet/.test(w));
  if (expand)
    add("grow-size", "available", expand, {
      risk: "Expanding is safe and quick; the pool stays online.",
    });
  else
    add(
      "grow-size",
      "blocked",
      "Every drive's space is already used. Replace the drives one at a time with larger ones first.",
    );
  add(
    "change-level",
    "unsupported",
    "ZFS cannot change a group's layout (a mirror into RAID-Z, RAID-Z1 into Z2). That means a new pool and copying the data across; Ember can plan it with you.",
  );
  if (!redundant)
    add(
      "schedule-check",
      "available",
      "A scrub still finds damage on single drives, though it cannot repair it.",
    );
  else add("schedule-check", "available");
  add(
    "identify",
    "available",
    "Each drive's model and serial number are shown; match the serial on the drive's label.",
  );

  if (!ctx.ready.ready)
    for (const x of out)
      if (x.status === "available" && !["identify", "schedule-check"].includes(x.id)) {
        x.status = "blocked";
        x.reason = `${ctx.ready.why ?? "Approved ZFS changes are not set up on this machine."}${x.reason ? ` (${x.reason})` : ""}`;
      }
  return out;
}

/* ---------- the driver ---------- */

const ZFS_LEVELS: RaidCreateOption["levels"] = [
  {
    id: "mirror",
    label: "Mirror",
    min: 2,
    tolerance: 1,
    words: "Every drive holds the same data. Simple, fast, easy to grow.",
  },
  {
    id: "raidz1",
    label: "RAID-Z1",
    min: 3,
    tolerance: 1,
    words: "One drive's worth of parity. Fine for smaller drives; risky with very large ones.",
  },
  {
    id: "raidz2",
    label: "RAID-Z2",
    min: 4,
    tolerance: 2,
    words: "Two drives' worth of parity: the usual choice for big media pools.",
  },
  {
    id: "raidz3",
    label: "RAID-Z3",
    min: 5,
    tolerance: 3,
    words: "Three drives of parity, for many large drives.",
  },
  {
    id: "stripe",
    label: "Stripe",
    min: 1,
    tolerance: 0,
    words: "No protection: one failure loses everything.",
  },
];

async function bin(io: DriverEnv["io"], n: string) {
  return (
    await Promise.all(
      ["/usr/sbin", "/sbin", "/usr/bin", "/bin", "/usr/local/sbin"].map((d) =>
        io.exists(`${d}/${n}`),
      ),
    )
  ).some(Boolean);
}

export const zfsDriver: RaidDriver = {
  tech: "zfs",
  platforms: ["linux"],
  operations: ZFS_OPERATIONS,
  async present({ io, blocks }) {
    if (io.platform !== "linux") return false;
    return (await bin(io, "zpool")) || flatten(blocks).some((x) => x.b.fstype === "zfs_member");
  },
  async support(env) {
    const tool = await bin(env.io, "zpool");
    const pools = tool ? await zfsDriver.arrays(env).catch(() => []) : [];
    const members = flatten(env.blocks).some((x) => x.b.fstype === "zfs_member");
    return {
      tech: "zfs",
      seen: !tool
        ? members
          ? "ZFS pool members are present, but the zpool tool is not installed"
          : "ZFS is not installed"
        : pools.length
          ? `${pools.length} pool${pools.length > 1 ? "s" : ""}: ${pools.map((p) => p.name).join(", ")}`
          : "ZFS is installed; no pools are imported",
      support: tool ? "manage" : members ? "detect" : "none",
      verified: env.sample ? "fixtures" : "loopback",
      tools: [{ name: "zpool", present: tool }],
    };
  },
  async arrays(env) {
    const { io } = env;
    const list = await io.run("zpool", ZPOOL_LIST_ARGS);
    if (list.code !== 0) return [];
    const info = parseZpoolList(list.out);
    if (!info.size) return [];
    const status = await io.run("zpool", ["status", "-P", "-L", "-p"]);
    const pools = parseZpoolStatus(status.out);
    const datasets = new Map<string, { used?: number; available?: number; mountpoint?: string }>();
    for (const name of info.keys()) {
      const g = await io.run("zfs", [
        "get",
        "-H",
        "-p",
        "-o",
        "property,value",
        "used,available,mountpoint",
        name,
      ]);
      const d: { used?: number; available?: number; mountpoint?: string } = {};
      for (const line of g.out.split("\n")) {
        const [k, v] = line.split("\t");
        if (k === "used" || k === "available") d[k] = Number(v);
        if (k === "mountpoint" && v) d.mountpoint = v;
      }
      datasets.set(name, d);
    }
    const version = /zfs-(\d+\.\d+\.\d+)/.exec((await io.run("zfs", ["version"])).out)?.[1];
    return pools.map((p) => {
      const a = poolToArray(p, { blocks: env.blocks, info, datasets });
      if (version) a.toolVersion = version;
      return a;
    });
  },
  actions(a, env) {
    return zfsActions(a, {
      candidates: env.candidates,
      ready: env.ready,
      ...(a.toolVersion ? { version: a.toolVersion } : {}),
    });
  },
  async create(env) {
    if (!(await bin(env.io, "zpool"))) return undefined;
    return {
      tech: "zfs",
      label: "ZFS pool",
      levels: ZFS_LEVELS,
      note: "Mounted at /mnt/<name>, with compression on. Drives are given to ZFS whole (it partitions them).",
    };
  },
  async schedules(env) {
    const out: RaidSchedule[] = [];
    const cron = await env.io.read("/etc/cron.d/zfsutils-linux");
    if (
      cron &&
      /scrub/.test(cron) &&
      cron.split("\n").some((l) => /scrub/.test(l) && !/^\s*#/.test(l))
    )
      out.push({
        by: "system",
        every: "monthly",
        text: "The system scrubs every pool on the second Sunday of each month (Ubuntu/Debian zfsutils cron).",
      });
    for (const t of await env.io.list("/etc/systemd/system/timers.target.wants"))
      if (/^zfs-scrub-(weekly|monthly)@(.+)\.timer$/.test(t)) {
        const m = /^zfs-scrub-(weekly|monthly)@(.+)\.timer$/.exec(t)!;
        out.push({
          arrayId: `zfs:${m[2]}`,
          by: "system",
          every: m[1] as "weekly" | "monthly",
          text: `The system scrubs ${m[2]} ${m[1]} (systemd timer).`,
        });
      }
    return out;
  },
  async plan({ action, array: a, params: p, report, host }): Promise<PlanWords> {
    const where = a ? `pool ${a.name} (${a.levelText ?? a.level}) on ${host}` : host;
    const act = a?.actions.find((x) => x.id === action);
    const risk = act?.risk ? ` ${act.risk}` : "";
    const out: Record<string, string | number | boolean> = {};
    switch (action) {
      case "check":
      case "resume-check":
        return {
          label: `${action === "check" ? "Scrub" : "Resume the scrub of"} ${where}`,
          reason: act?.risk ?? "Reads every block; repairs damage from the good copy.",
        };
      case "pause-check":
      case "cancel-check":
        return {
          label: `${action === "pause-check" ? "Pause" : "Stop"} the scrub of ${where}`,
          reason: "Only the scrub is affected; the data is not.",
        };
      case "replace": {
        const old = pickMember(a!, p.replaces);
        const min = old.sizeBytes;
        const c = pickCandidate(report, p.device, {
          ...(min ? { minBytes: min } : {}),
          erase: p.erase,
        });
        out.serial = c.serial ?? "";
        return {
          label: `Replace ${driveWords({ ...old, device: old.device })} with ${driveWords(c)} in ${where}`,
          reason: `ZFS takes the whole new drive.${c.state === "has-data" ? ` ERASES ${c.device}: ${c.reason ?? "it holds data"}.` : ""}${risk}`,
          params: out,
        };
      }
      case "add-spare":
      case "grow-devices": {
        const c = pickCandidate(report, p.device, { erase: p.erase });
        out.serial = c.serial ?? "";
        if (action === "grow-devices") {
          const g =
            (a!.groups ?? []).find((x) => x.level === "mirror") ??
            (a!.groups ?? []).find((x) => /^raidz/.test(x.level ?? ""));
          if (!g) throw new Refuse("There is no mirror or RAID-Z group to add a drive to.");
          const target =
            g.level === "mirror"
              ? a!.members.find((m) => m.group === g.name && m.role === "active")?.device
              : g.name;
          if (!target) throw new Refuse(`${g.name} has no working drive to attach to.`);
          out.target = target;
          return {
            label: `Add ${driveWords(c)} to ${g.name} in ${where}${g.level === "mirror" ? " as another mirror copy" : " (RAID-Z expansion)"}`,
            reason: `${c.state === "has-data" ? `ERASES ${c.device}: ${c.reason ?? "it holds data"}. ` : ""}${risk}${act?.irreversible ? " This cannot be undone." : ""}`,
            params: out,
          };
        }
        return {
          label: `Add ${driveWords(c)} as a hot spare in ${where}`,
          reason: `${c.state === "has-data" ? `ERASES ${c.device}: ${c.reason ?? "it holds data"}. ` : ""}${risk}`,
          params: out,
        };
      }
      case "remove-spare":
      case "mark-failed":
      case "re-add":
      case "remove": {
        const m = pickMember(a!, p.device);
        if (action === "remove-spare" && m.role !== "spare")
          throw new Refuse(`${m.device} is not a spare.`);
        if (action === "re-add" && m.role !== "offline")
          throw new Refuse(`${m.device} is not offline.`);
        if (action === "mark-failed" && m.role !== "active")
          throw new Refuse(`${m.device} is not an online drive.`);
        out.serial = m.serial ?? "";
        const verb = {
          "remove-spare": "Remove the spare",
          "mark-failed": "Take offline",
          "re-add": "Bring back online",
          remove: "Detach from its mirror",
        }[action];
        return {
          label: `${verb} ${driveWords({ ...m })} in ${where}`,
          reason:
            action === "remove-spare"
              ? "The spare leaves the pool. It is not erased."
              : `${risk}`.trim() || (act?.reason ?? ""),
          params: out,
        };
      }
      case "clear-errors":
        return {
          label: `Clear the error counts of ${where}`,
          reason:
            "ZFS forgets the counted errors and tries a faulted drive again. Do it once the cause is fixed; errors that return mean the drive or cable is failing.",
        };
      case "grow-size":
        return { label: `Expand ${where} to its drives' full size`, reason: act?.risk ?? "" };
      case "create": {
        const level = String(p.level ?? "");
        const lv = ZFS_LEVELS.find((l) => l.id === level);
        if (!lv) throw new Refuse("Choose a mirror, RAID-Z1, Z2, Z3, or a stripe.");
        const devices = String(p.devices ?? "")
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        if (devices.length < lv.min)
          throw new Refuse(`${lv.label} needs at least ${lv.min} drives.`);
        const erase = new Set(
          String(p.eraseDevices ?? "")
            .split(",")
            .map((d) => d.trim()),
        );
        const cs = devices.map((d) => pickCandidate(report, d, { erase: erase.has(d) }));
        if (cs.some((c) => c.kind === "part"))
          throw new Refuse("Give ZFS whole drives, not partitions.");
        const name = String(p.name ?? "");
        if (
          !/^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(name) ||
          /^(mirror|raidz|draid|spare|log|cache|special|dedup|c[0-9])/.test(name)
        )
          throw new Refuse(
            "Name the pool with a letter first, then letters, digits, dashes, dots, or underscores (like tank or media).",
          );
        out.serials = cs.map((c) => c.serial ?? "").join(",");
        const sizes = cs.map((c) => c.sizeBytes ?? 0);
        const usable =
          level === "mirror"
            ? Math.min(...sizes)
            : level === "stripe"
              ? sizes.reduce((x, y) => x + y, 0)
              : Math.min(...sizes) * (cs.length - lv.tolerance);
        return {
          label: `Create a ZFS ${lv.label} pool "${name}" on ${host} from ${cs.map(driveWords).join("; ")}, mounted at /mnt/${name}`,
          reason: `ERASES EVERYTHING on ${cs.map((c) => c.device).join(", ")}${
            cs.some((c) => c.state === "has-data")
              ? ` (${cs
                  .filter((c) => c.state === "has-data")
                  .map((c) => `${c.device}: ${c.reason ?? "holds data"}`)
                  .join("; ")})`
              : ""
          }. About ${gb(usable)} usable; it survives ${lv.tolerance} drive failure${lv.tolerance === 1 ? "" : "s"}. RAID is not a backup: deleted or damaged files are gone on every drive at once. This cannot be undone.`,
          params: out,
        };
      }
      default:
        throw new Refuse(`"${action}" is shown in the tab only; there is nothing to run.`);
    }
  },
  async run({ action, array: a, params: p, report }, perform) {
    const pool = a?.name ?? "";
    switch (action) {
      case "check":
      case "resume-check":
        return perform("zfs.scrub", { pool, action: "start" });
      case "pause-check":
        return perform("zfs.scrub", { pool, action: "pause" });
      case "cancel-check":
        return perform("zfs.scrub", { pool, action: "cancel" });
      case "replace":
        sameDrive(report, a, p.device, p.serial);
        return perform("zfs.member", {
          pool,
          action: "replace",
          replaces: String(p.replaces),
          device: String(p.device),
          ...(p.serial ? { serial: String(p.serial) } : {}),
          ...(p.erase === true ? { erase: true } : {}),
        });
      case "add-spare":
        sameDrive(report, a, p.device, p.serial);
        return perform("zfs.member", {
          pool,
          action: "add-spare",
          device: String(p.device),
          ...(p.serial ? { serial: String(p.serial) } : {}),
          ...(p.erase === true ? { erase: true } : {}),
        });
      case "grow-devices":
        sameDrive(report, a, p.device, p.serial);
        return perform("zfs.member", {
          pool,
          action: "attach",
          target: String(p.target),
          device: String(p.device),
          ...(p.serial ? { serial: String(p.serial) } : {}),
          ...(p.erase === true ? { erase: true } : {}),
        });
      case "remove-spare":
      case "mark-failed":
      case "re-add":
      case "remove":
        return perform("zfs.member", {
          pool,
          action: {
            "remove-spare": "remove-spare",
            "mark-failed": "offline",
            "re-add": "online",
            remove: "detach",
          }[action],
          device: String(p.device),
        });
      case "clear-errors":
        return perform("zfs.clear", { pool });
      case "grow-size":
        return perform("zfs.grow", { pool, mode: "expand" });
      case "create": {
        const devices = String(p.devices ?? "")
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        const serials = String(p.serials ?? "").split(",");
        const erase = new Set(
          String(p.eraseDevices ?? "")
            .split(",")
            .map((d) => d.trim()),
        );
        devices.forEach((d, i) => sameDrive(report, undefined, d, serials[i]));
        return perform("zfs.create", {
          name: String(p.name),
          level: String(p.level),
          devices: devices.map((d, i) => ({
            device: d,
            ...(serials[i] ? { serial: serials[i] } : {}),
            ...(erase.has(d) ? { erase: true } : {}),
          })),
        });
      }
      default:
        throw new Refuse("Nothing to run.");
    }
  },
};

export type { RaidTechSupport };
