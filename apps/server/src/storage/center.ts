import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { Blocker, PhysicalDisk } from "@dragon-control/core";

/**
 * Storage & Files (docs/design/STORAGE_CENTER.md, from the owner's HEARTH_STORAGE_RAID_MANAGEMENT_SPEC):
 * one read-only picture of drives, layout, arrays, recent files, and file journeys, built from
 * what this machine shows an unprivileged process and what the apps report. Every part says where
 * it came from and what it could not see; nothing is guessed (no health percentage for hard
 * drives, no "failed" for a download that is simply still seeding). Nothing here changes anything.
 */

// ---------------------------------------------------------------------------------------------
// Layout: disks, partitions, filesystems, mounts (Linux lsblk, no root needed).

export interface LayoutNode {
  name: string;
  type: string;
  sizeBytes: number;
  rotational?: boolean;
  transport?: string;
  fstype?: string;
  mount?: string;
  model?: string;
  children: LayoutNode[];
}

interface RawLsblk {
  blockdevices?: RawBlock[];
}
interface RawBlock {
  name?: string;
  type?: string;
  size?: number | string;
  rota?: boolean | string | number;
  tran?: string | null;
  fstype?: string | null;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  model?: string | null;
  children?: RawBlock[];
}

const truthy = (v: unknown) => v === true || v === "1" || v === 1 || v === "true";

/** lsblk -J -b output to a tree; loop and ram devices are left out (snaps, zram). */
export function parseLsblk(json: string): LayoutNode[] {
  const raw = JSON.parse(json) as RawLsblk;
  const walk = (b: RawBlock): LayoutNode => {
    const mount = b.mountpoint ?? b.mountpoints?.find((m) => m) ?? undefined;
    return {
      name: b.name ?? "?",
      type: b.type ?? "unknown",
      sizeBytes: Number(b.size ?? 0),
      ...(b.rota !== undefined ? { rotational: truthy(b.rota) } : {}),
      ...(b.tran ? { transport: b.tran } : {}),
      ...(b.fstype ? { fstype: b.fstype } : {}),
      ...(mount ? { mount } : {}),
      ...(b.model ? { model: b.model.trim() } : {}),
      children: (b.children ?? []).map(walk),
    };
  };
  return (raw.blockdevices ?? []).filter((b) => !/^(loop|ram|zram)/.test(b.name ?? "")).map(walk);
}

const run = (cmd: string, args: string[], timeout = 10_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

export async function readLayout(): Promise<
  { available: true; disks: LayoutNode[] } | { available: false; why: string }
> {
  if (process.platform !== "linux")
    return {
      available: false,
      why: "Partitions and filesystems are read on Linux today; on this machine the drives below show their drive letters.",
    };
  try {
    const out = await run("lsblk", [
      "-J",
      "-b",
      "-o",
      "NAME,TYPE,SIZE,ROTA,TRAN,FSTYPE,MOUNTPOINT,MODEL",
    ]);
    return { available: true, disks: parseLsblk(out) };
  } catch (error) {
    return {
      available: false,
      why: `lsblk did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Arrays and pools: what is actually here, by platform. None found is a real answer.

export interface ArrayInfo {
  kind:
    | "mdadm"
    | "zfs"
    | "btrfs"
    | "unraid"
    | "hardware"
    | "snapraid"
    | "storage-spaces"
    | "lvm"
    | "drivepool";
  name: string;
  state: string;
  detail: string;
}

export interface ArraysReport {
  found: ArrayInfo[];
  /** Each platform looked for, and what was seen (evidence for "none"). */
  checked: {
    kind: ArrayInfo["kind"];
    seen: string;
    /** read: its arrays are read and shown. detect: Hearth only tells whether one is present. */
    support: "read" | "detect";
    /** How the adapter was verified: on a real array, against captured output, or not at all. */
    verified: "live" | "fixtures" | "none";
  }[];
}

/**
 * One storage platform. Every adapter only reads; none repairs, rebuilds, scrubs, or changes an
 * array. Management is not offered for any platform until it has been tested on an isolated
 * array of that kind.
 */
interface ArrayAdapter {
  kind: ArrayInfo["kind"];
  support: "read" | "detect";
  verified: "live" | "fixtures" | "none";
  look(fstypes: string[]): Promise<{ found: ArrayInfo[]; seen: string }>;
}

const ADAPTERS: ArrayAdapter[] = [
  {
    kind: "mdadm",
    support: "read",
    // parseMdstat is tested against captured /proc/mdstat output; the home server has no array to test on.
    verified: "fixtures",
    async look(fstypes) {
      const md = parseMdstat(await fs.readFile("/proc/mdstat", "utf8").catch(() => ""));
      return {
        found: md,
        seen: md.length
          ? `${md.length} array(s) in /proc/mdstat`
          : fstypes.includes("linux_raid_member")
            ? "RAID member partitions present, but no running array in /proc/mdstat"
            : "No arrays in /proc/mdstat, no RAID member partitions",
      };
    },
  },
  {
    kind: "zfs",
    support: "detect",
    verified: "none",
    async look(fstypes) {
      const zpool = await anyBin("zpool");
      return {
        found: [],
        seen: fstypes.includes("zfs_member")
          ? `ZFS member partitions present${zpool ? "; pool health is not read yet" : "; the zpool tool is not installed, so pools cannot be read"}`
          : "No ZFS member partitions",
      };
    },
  },
  {
    kind: "btrfs",
    support: "detect",
    verified: "none",
    async look(fstypes) {
      const btrfs = await anyBin("btrfs");
      return {
        found: [],
        seen: fstypes.includes("btrfs")
          ? `Btrfs filesystems present${btrfs ? "; their device health is not read yet" : "; the btrfs tool is not installed"}`
          : "No Btrfs filesystems",
      };
    },
  },
  {
    kind: "unraid",
    support: "detect",
    verified: "none",
    async look() {
      return {
        found: [],
        seen: (await exists("/etc/unraid-version"))
          ? "This is Unraid; its array and parity are not read yet"
          : "Not Unraid",
      };
    },
  },
  {
    kind: "hardware",
    support: "detect",
    verified: "none",
    async look() {
      return {
        found: [],
        seen: "Hardware RAID controllers are not read yet (each vendor needs its own tool).",
      };
    },
  },
];

/** /proc/mdstat to arrays: "md0 : active raid1 sdb1[1] sda1[0]" and its status line. */
export function parseMdstat(text: string): ArrayInfo[] {
  const out: ArrayInfo[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(md\w+)\s*:\s*(\w+)\s+(?:\((\w+)\)\s+)?(raid\d+|linear|multipath)?\s*(.*)$/.exec(
      lines[i]!,
    );
    if (!m) continue;
    const status = lines[i + 1]?.trim() ?? "";
    const degraded = /\[[U_]*_[U_]*\]/.test(status);
    const recovery = lines
      .slice(i + 2, i + 4)
      .find((l) => /recovery|resync|check/.test(l))
      ?.trim();
    out.push({
      kind: "mdadm",
      name: m[1]!,
      state: degraded ? "degraded" : (m[3] ?? m[2]!),
      detail: [m[4], m[5]?.trim(), status, recovery].filter(Boolean).join(" · "),
    });
  }
  return out;
}

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}
const anyBin = async (name: string) =>
  (
    await Promise.all(["/usr/sbin", "/sbin", "/usr/bin", "/bin"].map((d) => exists(`${d}/${name}`)))
  ).some(Boolean);

export function fstypesOf(nodes: LayoutNode[]): string[] {
  const out: string[] = [];
  const walk = (n: LayoutNode) => {
    if (n.fstype) out.push(n.fstype);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

export async function readArrays(layout: LayoutNode[]): Promise<ArraysReport> {
  if (process.platform !== "linux")
    return {
      found: [],
      checked: [
        {
          kind: "hardware",
          seen: "Windows Storage Spaces and SnapRAID are read in the RAID / Arrays tab.",
          support: "detect",
          verified: "none",
        },
      ],
    };
  const fstypes = fstypesOf(layout);
  const results = await Promise.all(ADAPTERS.map((a) => a.look(fstypes)));
  return {
    found: results.flatMap((r) => r.found),
    checked: ADAPTERS.map((a, i) => ({
      kind: a.kind,
      seen: results[i]!.seen,
      support: a.support,
      verified: a.verified,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// SMART: whether Hearth's own account can read drive health, and if not, exactly why.

export async function smartAccess(
  disks: PhysicalDisk[],
  layout: LayoutNode[],
): Promise<Blocker | undefined> {
  if (!disks.length) return undefined;
  if (process.platform === "win32") {
    if (disks.every((d) => d.powerOnHours === undefined && d.temperatureC === undefined))
      return {
        kind: "capability",
        title: "Drive health detail needs administrator access on this machine.",
        detail:
          "Windows shares temperature, power-on hours, wear, and error counts only with an elevated process. The drives' own health verdict and sizes are shown; the rest stays empty rather than guessed.",
      };
    return undefined;
  }
  const first = layout.find((n) => n.type === "disk");
  if (!first) return undefined;
  const dev = `/dev/${first.name}`;
  const readable = await fs.access(dev, fsConstants.R_OK).then(
    () => true,
    () => false,
  );
  if (readable) return undefined;
  const smartctl = await anyBin("smartctl");
  return {
    kind: "capability",
    path: dev,
    access: "read",
    title: "SMART detail (reallocated and pending sectors, power-on hours, self-tests) needs root.",
    detail: `${smartctl ? "smartctl is installed, but" : "smartctl is not installed, and"} reading a drive's SMART data opens the raw device (${dev}), which only root may do. Temperatures that Linux shares freely are shown. The narrow way is a read-only SMART operation in Hearth's elevated executor (not installed yet); adding Hearth to the disk group would give it raw read access to every drive, which is far more than SMART needs. Nothing is changed until you approve one.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Recent files: what changed lately in the folders you chose to watch, by file timestamps.
// Bounded on purpose: a few levels deep, a capped number of entries, a time limit, and only when
// asked, so it never crawls a 20 TB library or keeps sleeping drives awake.

export interface RecentFile {
  /** The file on this machine. */
  abs: string;
  /** Where it is in the file manager, once located. */
  open?: { rootId: string; folder: string; name: string };
  locationId: string;
  location: string;
  /** Relative to the watched folder, "/" separated (for Open in folder). */
  path: string;
  folder: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Partial downloads by their usual endings (qBittorrent .!qB, .part, SABnzbd's __ADMIN__). */
  incomplete: boolean;
}

const INCOMPLETE = /\.(!qb|part|partial|crdownload|tmp)$/i;

export async function recentFiles(
  locations: { id: string; label: string; path: string }[],
  opts: { sinceMs: number; maxDepth?: number; maxEntries?: number; timeMs?: number; now?: number },
): Promise<{ files: RecentFile[]; scanned: number; complete: boolean; tookMs: number }> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 4000;
  const started = Date.now();
  const deadline = started + (opts.timeMs ?? 4000);
  const cutoff = (opts.now ?? Date.now()) - opts.sinceMs;
  const files: RecentFile[] = [];
  let scanned = 0;
  let complete = true;
  for (const loc of locations) {
    const queue: { abs: string; rel: string; depth: number }[] = [
      { abs: loc.path, rel: "", depth: 0 },
    ];
    while (queue.length) {
      if (scanned >= maxEntries || Date.now() > deadline) {
        complete = false;
        break;
      }
      const { abs, rel, depth } = queue.shift()!;
      const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        scanned += 1;
        if (e.isSymbolicLink()) continue; // never followed out of the watched folder
        const childAbs = path.join(abs, e.name);
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (depth + 1 <= maxDepth && !e.name.startsWith("."))
            queue.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
          continue;
        }
        if (!e.isFile()) continue;
        const st = await fs.stat(childAbs).catch(() => undefined);
        if (!st || st.mtimeMs < cutoff) continue;
        files.push({
          abs: childAbs,
          locationId: loc.id,
          location: loc.label,
          path: childRel,
          folder: rel,
          name: e.name,
          sizeBytes: st.size,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
          incomplete: INCOMPLETE.test(e.name),
        });
      }
    }
  }
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { files: files.slice(0, 200), scanned, complete, tookMs: Date.now() - started };
}
