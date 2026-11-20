import type {
  RaidAction,
  RaidActionId,
  RaidArray,
  RaidCandidate,
  RaidCreateOption,
  RaidHealth,
  RaidMember,
  RaidMemberRole,
  RaidSync,
} from "@dragon-control/core";
import type { OperationName } from "../../elevated/protocol";
import { gb } from "./actions";
import {
  Refuse,
  driveWords,
  pickCandidate,
  pickMember,
  sameDrive,
  type PlanWords,
  type RaidDriver,
} from "./driver";
import type { RaidIO } from "./io";

/**
 * Windows Storage Spaces: pools of drives holding resilient virtual disks (mirrors, parity),
 * read with the Storage module's Get-StoragePool, Get-VirtualDisk, Get-PhysicalDisk, and
 * Get-StorageJob, which need no administrator rights. Changes go through the Windows elevated
 * executor's spaces.* operations.
 */

export const SPACES_OPERATIONS: readonly OperationName[] = [
  "spaces.member",
  "spaces.repair",
  "spaces.grow",
  "spaces.create",
];

export const POWERSHELL = "powershell.exe";
export const psArgs = (script: string) => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  script,
];

/** Pools, their drives and spaces (with volumes), and running storage jobs: $pools, $jobs. */
const POOLS_PART = `$s = { param($x) @($x | ForEach-Object { [string]$_ }) }
$pools = @(Get-StoragePool -IsPrimordial $false | ForEach-Object {
  $p = $_
  [pscustomobject]@{
    name = $p.FriendlyName; id = $p.UniqueId; health = [string]$p.HealthStatus
    op = & $s $p.OperationalStatus; size = $p.Size; alloc = $p.AllocatedSize; readOnly = $p.IsReadOnly
    disks = @($p | Get-PhysicalDisk | ForEach-Object { [pscustomobject]@{
      name = $_.FriendlyName; serial = "$($_.SerialNumber)".Trim(); id = $_.UniqueId; number = $_.DeviceId
      size = $_.Size; alloc = $_.AllocatedSize; media = [string]$_.MediaType; bus = [string]$_.BusType
      health = [string]$_.HealthStatus; op = & $s $_.OperationalStatus; usage = [string]$_.Usage } })
    vdisks = @($p | Get-VirtualDisk | ForEach-Object {
      $v = $_
      $vol = $v | Get-Disk | Get-Partition | Get-Volume | Where-Object { $_.DriveLetter -or $_.FileSystemLabel } | Select-Object -First 1
      [pscustomobject]@{
        name = $v.FriendlyName; id = $v.UniqueId; resiliency = $v.ResiliencySettingName
        copies = $v.NumberOfDataCopies; redundancy = $v.PhysicalDiskRedundancy; columns = $v.NumberOfColumns
        health = [string]$v.HealthStatus; op = & $s $v.OperationalStatus; size = $v.Size
        footprint = $v.FootprintOnPool; provisioning = [string]$v.ProvisioningType
        letter = if ($vol.DriveLetter) { [string]$vol.DriveLetter } else { $null }
        fs = $vol.FileSystemType; volSize = $vol.Size; free = $vol.SizeRemaining; label = $vol.FileSystemLabel } })
  }
})
$jobs = @(Get-StorageJob | ForEach-Object { [pscustomobject]@{
  name = $_.Name; state = [string]$_.JobState; pct = $_.PercentComplete; done = $_.BytesProcessed; total = $_.BytesTotal } })`;

/** Every drive: whether it could join a pool, why not, and what is on it: $disks. */
const DISKS_PART = `$sys = @(Get-Disk | Where-Object { $_.IsSystem -or $_.IsBoot } | ForEach-Object { [string]$_.Number })
$disks = @(Get-PhysicalDisk | ForEach-Object {
  $d = $_
  $disk = if ("$($d.DeviceId)" -ne '') { Get-Disk -Number $d.DeviceId } else { $null }
  $parts = @($disk | Get-Partition | ForEach-Object {
    $v = $_ | Get-Volume
    [pscustomobject]@{ letter = if ($_.DriveLetter -and $_.DriveLetter -ne [char]0) { [string]$_.DriveLetter } else { $null }; size = $_.Size; type = [string]$_.Type; fs = $v.FileSystemType; label = $v.FileSystemLabel } })
  [pscustomobject]@{
    name = $d.FriendlyName; serial = "$($d.SerialNumber)".Trim(); id = $d.UniqueId; number = [string]$d.DeviceId
    size = $d.Size; media = [string]$d.MediaType; bus = [string]$d.BusType; canPool = $d.CanPool
    why = @($d.CannotPoolReason | ForEach-Object { [string]$_ }); usage = [string]$d.Usage
    system = ($sys -contains [string]$d.DeviceId); parts = $parts }
})`;

const QUIET = "$ErrorActionPreference = 'SilentlyContinue'";

/** Every pool, its drives and virtual disks (with their volumes), and the running storage jobs. */
export const READ_SCRIPT = `${QUIET}
${POOLS_PART}
[pscustomobject]@{ pools = $pools; jobs = $jobs } | ConvertTo-Json -Depth 6 -Compress`;

/** Every drive: whether it could join a pool, why not, and what is on it. */
export const DISKS_SCRIPT = `${QUIET}
${DISKS_PART}
ConvertTo-Json -InputObject $disks -Depth 5 -Compress`;

/** Both at once: one PowerShell start (about a second) instead of two. */
export const ALL_SCRIPT = `${QUIET}
${POOLS_PART}
${DISKS_PART}
[pscustomobject]@{ pools = $pools; jobs = $jobs; disks = $disks } | ConvertTo-Json -Depth 6 -Compress`;

interface PsDisk {
  name?: string;
  serial?: string;
  id?: string;
  number?: string | number;
  size?: number;
  alloc?: number;
  media?: string;
  bus?: string;
  health?: string;
  op?: string | string[];
  usage?: string;
}
interface PsVdisk {
  name?: string;
  id?: string;
  resiliency?: string;
  copies?: number;
  redundancy?: number;
  columns?: number;
  health?: string;
  op?: string | string[];
  size?: number;
  footprint?: number;
  provisioning?: string;
  letter?: string | null;
  fs?: string;
  volSize?: number;
  free?: number;
  label?: string;
}
interface PsPool {
  name?: string;
  id?: string;
  health?: string;
  op?: string | string[];
  size?: number;
  alloc?: number;
  readOnly?: boolean;
  disks?: PsDisk[];
  vdisks?: PsVdisk[];
}
interface PsJob {
  name?: string;
  state?: string;
  pct?: number;
  done?: number;
  total?: number;
}
export interface SpacesRead {
  pools?: PsPool[];
  jobs?: PsJob[];
}
interface PsCandidate {
  name?: string;
  serial?: string;
  id?: string;
  number?: string;
  size?: number;
  media?: string;
  bus?: string;
  canPool?: boolean;
  why?: string[];
  usage?: string;
  system?: boolean;
  parts?: { letter?: string | null; size?: number; type?: string; fs?: string; label?: string }[];
}

const list = <T>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];
/** PowerShell sends a one-item list as a plain value: either way, a list of words. */
const ops = (v: unknown): string[] => list(v as string | string[] | undefined).map(String);

/** A drive's name everywhere in Hearth: \\.\PHYSICALDRIVE2 (the number Disk Management shows). */
export const driveName = (n: string | number | undefined) =>
  n === undefined || n === "" ? undefined : `\\\\.\\PHYSICALDRIVE${n}`;

export function levelOf(v: PsVdisk): { level: string; text: string; tolerance: number } {
  const r = (v.resiliency ?? "").toLowerCase();
  if (r === "mirror") {
    const n = v.copies ?? 2;
    return {
      level: n >= 3 ? "spaces-mirror3" : "spaces-mirror",
      text: n >= 3 ? "Three-way mirror" : "Two-way mirror",
      tolerance: v.redundancy ?? n - 1,
    };
  }
  if (r === "parity") {
    const n = v.redundancy ?? 1;
    return {
      level: n >= 2 ? "spaces-parity2" : "spaces-parity",
      text: n >= 2 ? "Dual parity" : "Parity",
      tolerance: n,
    };
  }
  return { level: "spaces-simple", text: "Simple (no resiliency)", tolerance: 0 };
}

const HEALTH_TEXT: Record<RaidHealth, string> = {
  healthy: "Every drive is working. The space keeps a copy of everything on another drive.",
  degraded:
    "A drive is missing, failing, or retired. The data is still there, but with less (or no) protection until it is repaired.",
  rebuilding: "Windows is repairing the space onto the remaining drives. Leave it running.",
  resyncing: "The space is being brought into step.",
  checking: "The pool is being checked.",
  reshaping: "Windows is spreading data over the drives (optimizing). The pool stays usable.",
  failed:
    "Too many drives are missing for the space to hold its data (detached or incomplete). Do not write to it; reconnect the missing drives before changing anything.",
  inactive: "The space is detached: its data cannot be read until it is attached again.",
  unknown: "Hearth could not tell the pool's state.",
};

function roleOf(d: PsDisk): RaidMemberRole {
  const op = ops(d.op).join(" ");
  if (/Lost Communication|Removing|Missing/i.test(op)) return "missing";
  if (/Retired/i.test(d.usage ?? "")) return "retired";
  if (/Hot Spare/i.test(d.usage ?? "")) return "spare";
  if (d.health && d.health !== "Healthy") return "faulty";
  if (/Journal/i.test(d.usage ?? "")) return "log";
  return "active";
}

export function poolsToArrays(read: SpacesRead): RaidArray[] {
  const jobs = list(read.jobs).filter((j) => j.state && !/Completed|Killed/i.test(j.state));
  return list(read.pools).map((p): RaidArray => {
    const vdisks = list(p.vdisks);
    const disks = list(p.disks);
    const members: RaidMember[] = disks.map((d) => ({
      // A drive that lost contact may have no number left: then it is named by its id.
      ...(driveName(d.number) || d.id ? { device: driveName(d.number) ?? `disk:${d.id}` } : {}),
      disk: driveName(d.number) ?? d.id ?? "",
      ...(d.name ? { model: d.name } : {}),
      ...(d.serial ? { serial: d.serial } : {}),
      ...(d.size ? { sizeBytes: d.size } : {}),
      ...(d.bus ? { transport: d.bus.toLowerCase() } : {}),
      ...(d.media ? { rotational: d.media === "HDD" } : {}),
      role: roleOf(d),
      states: [...ops(d.op), d.usage ?? ""].filter(Boolean).map((x) => x.toLowerCase()),
      stateText: `${d.health ?? "?"}, ${ops(d.op).join(", ") || "?"}${d.usage ? `, ${d.usage}` : ""}`,
      ...(d.id ? { path: d.id } : {}),
      ...(d.alloc !== undefined ? { usedBytes: d.alloc } : {}),
      ...(d.size !== undefined && d.alloc !== undefined ? { freeBytes: d.size - d.alloc } : {}),
    }));
    const levels = vdisks.map(levelOf);
    const lost = members.filter((m) => ["missing", "faulty"].includes(m.role)).length;
    const tolerance = levels.length ? Math.min(...levels.map((l) => l.tolerance)) : undefined;
    const canLose = tolerance === undefined ? undefined : Math.max(0, tolerance - lost);
    const vOps = vdisks.flatMap((v) => ops(v.op)).join(" ");
    const running = jobs.filter((j) =>
      /repair|regenerat|rebalanc|optimiz|virtual disk/i.test(j.name ?? ""),
    );
    const sync: RaidSync | undefined = running.length
      ? {
          action: running.some((j) => /rebalanc|optimiz/i.test(j.name ?? ""))
            ? "optimize"
            : "recover",
          ...(running[0]!.pct !== undefined ? { progressPct: running[0]!.pct! } : {}),
        }
      : undefined;
    let health: RaidHealth;
    if (/Detached/i.test(vOps)) health = "inactive";
    else if (/Incomplete/i.test(vOps) || p.health === "Unhealthy") health = "failed";
    else if (sync?.action === "recover" || /InService/i.test(vOps)) health = "rebuilding";
    else if (sync?.action === "optimize") health = "reshaping";
    else if (/Degraded/i.test(vOps) || p.health === "Warning" || lost) health = "degraded";
    else if (p.health === "Healthy") health = "healthy";
    else health = "unknown";
    const v0 = vdisks[0];
    const warnings: string[] = [];
    if (health === "degraded" || health === "rebuilding")
      warnings.push(
        canLose === 0
          ? "No redundancy left: one more drive failure would lose the data."
          : `It can lose ${canLose} more drive${canLose === 1 ? "" : "s"} before data is lost.`,
      );
    for (const m of members) {
      if (m.role === "missing")
        warnings.push(
          `${m.model ?? "A drive"}${m.serial ? ` (serial ${m.serial})` : ""} is not answering (lost communication). Reconnect it, or replace it.`,
        );
      if (m.role === "faulty")
        warnings.push(
          `${m.model ?? "A drive"}${m.serial ? ` (serial ${m.serial})` : ""} reports ${m.stateText}. Replace it.`,
        );
      if (m.role === "retired")
        warnings.push(
          `${m.model ?? "A drive"}${m.serial ? ` (serial ${m.serial})` : ""} is retired: Windows moves its data off; remove it once the repair finishes.`,
        );
    }
    if (levels.some((l) => l.tolerance === 0))
      warnings.push("A simple space keeps no second copy: one drive failing loses it.");
    const free = (p.size ?? 0) - (p.alloc ?? 0);
    const biggest = Math.max(0, ...members.map((m) => m.sizeBytes ?? 0));
    if (p.size && levels.some((l) => l.tolerance > 0) && free < biggest && health === "healthy")
      warnings.push(
        "The pool's free space is less than its largest drive: if a drive fails, Windows cannot repair onto the others until you add one.",
      );
    const used = vdisks.reduce(
      (n, v) => n + (v.volSize && v.free !== undefined ? v.volSize - v.free : 0),
      0,
    );
    return {
      id: `spaces:${p.id ?? p.name}`,
      tech: "storage-spaces",
      name: p.name ?? "Storage pool",
      ...(p.id ? { uuid: p.id } : {}),
      ...(levels[0] ? { level: levels[0].level } : {}),
      ...(levels.length
        ? {
            levelText:
              levels.length === 1
                ? `${levels[0]!.text}, ${members.length} drives`
                : levels.map((l, i) => `${vdisks[i]!.name}: ${l.text}`).join("; "),
          }
        : {}),
      health,
      healthText: HEALTH_TEXT[health],
      ...(vdisks.length ? { sizeBytes: vdisks.reduce((n, v) => n + (v.size ?? 0), 0) } : {}),
      ...(p.size ? { rawBytes: p.size } : {}),
      ...(used ? { usedBytes: used } : {}),
      raidDevices: members.length,
      counts: {
        active: members.filter((m) => m.role === "active").length,
        failed: members.filter((m) => m.role === "faulty").length,
        missing: members.filter((m) => m.role === "missing").length,
        spare: members.filter((m) => m.role === "spare").length,
      },
      ...(canLose !== undefined ? { canLose } : {}),
      members,
      ...(v0?.letter ? { mount: `${v0.letter}:` } : {}),
      ...(v0?.fs ? { fstype: v0.fs.toLowerCase() } : {}),
      ...(sync ? { sync } : {}),
      groups: vdisks.map((v, i) => ({
        name: `${v.name ?? "Space"}${v.letter ? ` (${v.letter}:)` : ""}`,
        level: levels[i]!.level,
        health: (/OK/i.test(ops(v.op).join(" ")) && v.health === "Healthy"
          ? "healthy"
          : /Detached|Incomplete/i.test(ops(v.op).join(" "))
            ? "failed"
            : "degraded") as RaidHealth,
        stateText: `${v.health ?? "?"}, ${ops(v.op).join(", ")}${v.provisioning ? `, ${v.provisioning.toLowerCase()} provisioning` : ""}`,
      })),
      ...(p.size ? { layout: `${gb(free)} of ${gb(p.size)} free in the pool` } : {}),
      warnings,
      actions: [],
    };
  });
}

export function candidatesFrom(disks: PsCandidate[]): RaidCandidate[] {
  return disks.map((d): RaidCandidate => {
    const device = driveName(d.number) ?? `disk:${d.id ?? "?"}`;
    const info = {
      ...(d.name ? { model: d.name } : {}),
      ...(d.serial ? { serial: d.serial } : {}),
      ...(d.size ? { sizeBytes: d.size } : {}),
      ...(d.bus ? { transport: d.bus.toLowerCase() } : {}),
      ...(d.media ? { rotational: d.media === "HDD" } : {}),
    };
    const parts = list(d.parts);
    const letters = parts
      .map((p) => p.letter)
      .filter(Boolean)
      .map((l) => `${l}:`);
    const why = list(d.why).join(", ");
    if (d.system)
      return {
        device,
        kind: "disk",
        state: "excluded",
        reason: "Holds Windows. Never offered.",
        ...info,
      };
    if (/In a Pool/i.test(why) || d.usage === "Journal")
      return {
        device,
        kind: "disk",
        state: "excluded",
        reason: "Already in a storage pool.",
        ...info,
      };
    if (/Not Healthy|Offline|Removable/i.test(why))
      return {
        device,
        kind: "disk",
        state: "excluded",
        reason: `Windows will not pool it: ${why}.`,
        ...info,
      };
    if (d.canPool) return { device, kind: "disk", state: "usable", ...info };
    // A volume with a drive letter is in use (like a mounted drive on Linux): never offered.
    const inUse = parts.filter((p) => p.letter);
    if (inUse.length)
      return {
        device,
        kind: "disk",
        state: "excluded",
        reason: `In use as ${inUse.map((p) => `${p.letter}:${p.label ? ` (${p.label}${p.fs ? `, ${p.fs}` : ""})` : ""}`).join(", ")}. Hearth never erases a drive in use: copy its files off and delete its volume in Disk Management first.`,
        ...info,
      };
    if (parts.length)
      return {
        device,
        kind: "disk",
        state: "has-data",
        reason: `Has ${parts.length} partition${parts.length === 1 ? "" : "s"}${letters.length ? ` (${letters.join(", ")})` : ""}${parts.some((p) => p.fs) ? `, ${[...new Set(parts.map((p) => p.fs).filter(Boolean))].join(", ")}` : ""}: pooling it erases them.`,
        ...(parts.find((p) => p.fs)?.fs
          ? { fstype: parts.find((p) => p.fs)!.fs!.toLowerCase() }
          : {}),
        ...info,
      };
    return {
      device,
      kind: "disk",
      state: "excluded",
      reason: `Windows will not pool it${why ? `: ${why}` : ""}.`,
      ...info,
    };
  });
}

/* ---------- what can be done ---------- */

const LABELS: Partial<Record<RaidActionId, string>> = {
  replace: "Replace a drive",
  "grow-devices": "Add a drive (more space)",
  "add-spare": "Add a hot spare",
  "mark-failed": "Retire a drive",
  "re-add": "Put a retired drive back in use",
  remove: "Remove a drive from the pool",
  repair: "Repair the space",
  rebalance: "Optimize (spread data over all drives)",
  "grow-size": "Use the pool's free space",
  check: "Check every block",
  "schedule-check": "Schedule regular checks",
  speed: "Repair speed",
  "change-level": "Change the resiliency",
  identify: "Identify the physical drives",
};

export function spacesActions(
  a: RaidArray,
  ctx: { candidates: RaidCandidate[]; ready: { ready: boolean; why?: string } },
): RaidAction[] {
  const out: RaidAction[] = [];
  const add = (
    id: RaidActionId,
    status: RaidAction["status"],
    reason?: string,
    extra: Partial<RaidAction> = {},
  ) => out.push({ id, label: LABELS[id] ?? id, status, ...(reason ? { reason } : {}), ...extra });
  const busy = a.sync?.action;
  const usable = ctx.candidates.filter((c) => c.state !== "excluded");
  const redundant = (a.groups ?? []).some((g) => g.level && g.level !== "spaces-simple");
  const off = a.health === "failed" || a.health === "inactive";
  const noDisk =
    "No drive Windows can pool is connected. Connect one (not the Windows drive), then read again.";
  if (off)
    add("replace", "blocked", "The space is detached or incomplete: reconnect its drives first.");
  else if (!redundant)
    add(
      "replace",
      "unsupported",
      "A simple space has no second copy to rebuild a drive from; copy the data off first.",
    );
  else if (!usable.length) add("replace", "blocked", noDisk);
  else
    add(
      "replace",
      "available",
      a.members.some((m) => ["missing", "faulty"].includes(m.role))
        ? `Suggested for ${a.members
            .filter((m) => ["missing", "faulty"].includes(m.role))
            .map((m) => m.serial ?? m.device)
            .join(", ")}.`
        : undefined,
      {
        risk: "The new drive joins the pool, the old one is retired, and Windows repairs the space onto the others: less protection until it finishes.",
      },
    );
  if (off) add("grow-devices", "blocked", "The space is not attached.");
  else if (!usable.length) add("grow-devices", "blocked", noDisk);
  else
    add("grow-devices", "available", undefined, {
      risk: "The drive joins the pool; then Windows spreads data onto it (optimize). Its space is used once the space is extended.",
    });
  if (!redundant) add("add-spare", "unsupported", "A simple space cannot use a spare.");
  else if (!usable.length) add("add-spare", "blocked", noDisk);
  else
    add(
      "add-spare",
      "available",
      "Microsoft recommends spare capacity (an extra drive in the pool) over hot spares; a spare only waits.",
      { risk: "The drive waits unused until a drive fails." },
    );
  if (!redundant)
    add("mark-failed", "unsupported", "Retiring a drive in a simple space would lose its data.");
  else if ((a.canLose ?? 0) < 1)
    add("mark-failed", "blocked", "No redundancy left: retiring another drive would lose data.");
  else
    add("mark-failed", "available", undefined, {
      risk: "Windows moves the drive's data onto the others, then it can be removed. Nothing is lost if the pool has room.",
    });
  if (a.members.some((m) => m.role === "retired"))
    add("re-add", "available", "Puts a retired drive back in use.");
  else add("re-add", "blocked", "No drive is retired.");
  const removable = a.members.filter(
    (m) => m.role === "retired" || m.role === "missing" || m.role === "spare",
  );
  if (busy === "recover") add("remove", "blocked", "Wait until the repair finishes.");
  else if (removable.length)
    add(
      "remove",
      "available",
      `Retired, missing, or spare drives can leave: ${removable.map((m) => m.serial ?? m.device).join(", ")}.`,
      { risk: "Windows refuses if any data still lives only on it." },
    );
  else
    add("remove", "blocked", "Retire a drive first; Windows moves its data off before it leaves.");
  if (busy === "recover")
    add(
      "repair",
      "running",
      a.sync?.progressPct !== undefined ? `${a.sync.progressPct}%` : undefined,
    );
  else if (a.health === "degraded")
    add("repair", "available", "Rebuilds missing copies onto the remaining drives.", {
      risk: "The drives are busy while it runs.",
    });
  else add("repair", "blocked", "Nothing needs repairing.");
  if (busy === "optimize") add("rebalance", "running");
  else if (a.health !== "healthy") add("rebalance", "blocked", "Optimize a healthy pool.");
  else
    add("rebalance", "available", "After adding a drive: spreads the data over all drives.", {
      risk: "Runs in the background; the pool stays usable.",
    });
  add(
    "grow-size",
    a.health === "healthy" ? "available" : "blocked",
    a.health === "healthy"
      ? "Extends the space and its volume over the pool's free space."
      : "Grow a healthy space.",
    a.health === "healthy"
      ? { risk: "The volume grows while in use. Shrinking is not offered." }
      : {},
  );
  add(
    "check",
    "unsupported",
    "Storage Spaces checks itself as it reads. ReFS volumes are also scrubbed by Windows' own Data Integrity Scan task.",
  );
  add(
    "schedule-check",
    "unsupported",
    "Windows schedules its own checks (the Data Integrity Scan task, for ReFS).",
  );
  add("speed", "unsupported", "Windows paces repairs itself.");
  add(
    "change-level",
    "unsupported",
    "A space's resiliency cannot be changed in place: create a new space in the same pool and copy the data across. Ember can plan it with you.",
  );
  add(
    "identify",
    "available",
    "Each drive's model and serial number are shown; match the serial on the drive's label.",
  );
  if (!ctx.ready.ready)
    for (const x of out)
      if (x.status === "available" && x.id !== "identify") {
        x.status = "blocked";
        x.reason = `${ctx.ready.why ?? "Approved changes are not set up on this machine."}${x.reason ? ` (${x.reason})` : ""}`;
      }
  return out;
}

/* ---------- the driver ---------- */

const SPACES_LEVELS: RaidCreateOption["levels"] = [
  {
    id: "spaces-mirror",
    label: "Two-way mirror",
    min: 2,
    tolerance: 1,
    words: "Two copies of everything: the usual choice.",
  },
  {
    id: "spaces-mirror3",
    label: "Three-way mirror",
    min: 5,
    tolerance: 2,
    words: "Three copies: survives two failures.",
  },
  {
    id: "spaces-parity",
    label: "Parity",
    min: 3,
    tolerance: 1,
    words: "More usable space, slower writes. Good for media that is written once.",
  },
  {
    id: "spaces-parity2",
    label: "Dual parity",
    min: 7,
    tolerance: 2,
    words: "Survives two failures with more space than a three-way mirror.",
  },
  {
    id: "spaces-simple",
    label: "Simple",
    min: 1,
    tolerance: 0,
    words: "No protection: one failure loses everything.",
  },
];

export interface WindowsRead extends SpacesRead {
  disks?: PsCandidate | PsCandidate[];
}

/**
 * Windows' storage, read in one PowerShell call (starting PowerShell takes about a second) and
 * kept for 15 seconds, shared by Storage Spaces and SnapRAID. Forgotten after every change.
 */
const windowsCache = new WeakMap<RaidIO, { at: number; read: Promise<WindowsRead | undefined> }>();
export function readWindows(io: RaidIO): Promise<WindowsRead | undefined> {
  const c = windowsCache.get(io);
  if (c && Date.now() - c.at < 15_000) return c.read;
  const read = readJson<WindowsRead>(io, ALL_SCRIPT);
  windowsCache.set(io, { at: Date.now(), read });
  return read;
}
export function forgetWindows(io: RaidIO) {
  windowsCache.delete(io);
}

async function readJson<T>(io: RaidIO, script: string): Promise<T | undefined> {
  const r = await io.run(POWERSHELL, psArgs(script), { timeoutMs: 60_000 });
  if (r.code !== 0 || !r.out.trim()) return undefined;
  try {
    return JSON.parse(r.out.trim()) as T;
  } catch {
    return undefined;
  }
}

export const spacesDriver: RaidDriver = {
  tech: "storage-spaces",
  platforms: ["win32"],
  operations: SPACES_OPERATIONS,
  async present({ io }) {
    return io.platform === "win32";
  },
  async support(env) {
    const arrays = await spacesDriver.arrays(env).catch(() => []);
    return {
      tech: "storage-spaces",
      seen: arrays.length
        ? `${arrays.length} storage pool${arrays.length > 1 ? "s" : ""}: ${arrays.map((a) => a.name).join(", ")}`
        : "No storage pools",
      support: "manage",
      verified: env.sample ? "fixtures" : "loopback",
      tools: [{ name: "Windows Storage module", present: true }],
    };
  },
  async arrays({ io }) {
    const read = await readWindows(io);
    return read ? poolsToArrays(read) : [];
  },
  async candidates({ io }) {
    return candidatesFrom(list((await readWindows(io))?.disks));
  },
  actions(a, env) {
    return spacesActions(a, env);
  },
  async create() {
    return {
      tech: "storage-spaces",
      label: "Storage Spaces",
      levels: SPACES_LEVELS,
      filesystems: [
        { id: "ntfs", label: "NTFS" },
        { id: "refs", label: "ReFS (checks its own data)" },
      ],
      note: "Makes the pool, one space using all of it, and a formatted volume with the next free drive letter.",
    };
  },
  async plan({ action, array: a, params: p, report, host }): Promise<PlanWords> {
    const where = a ? `pool ${a.name} (${a.levelText ?? a.level}) on ${host}` : host;
    const act = a?.actions.find((x) => x.id === action);
    const risk = act?.risk ?? "";
    const out: Record<string, string | number | boolean> = {};
    const erase = (c: RaidCandidate) =>
      c.state === "has-data" ? ` ERASES ${c.device}: ${c.reason ?? "it holds data"}.` : "";
    switch (action) {
      case "replace":
      case "grow-devices":
      case "add-spare": {
        const c = pickCandidate(report, p.device, { erase: p.erase });
        out.serial = c.serial ?? "";
        if (action === "replace") {
          const old = pickMember(a!, p.replaces);
          out.replacesSerial = old.serial ?? "";
          return {
            label: `Replace ${driveWords(old)} with ${driveWords(c)} in ${where}`,
            reason: `${erase(c).trim()} ${risk}`.trim(),
            params: out,
          };
        }
        return {
          label: `${action === "add-spare" ? "Add" : "Add"} ${driveWords(c)} ${action === "add-spare" ? "as a hot spare to" : "to"} ${where}`,
          reason: `${erase(c).trim()} ${risk}`.trim(),
          params: out,
        };
      }
      case "mark-failed":
      case "re-add":
      case "remove": {
        const m = pickMember(a!, p.device);
        out.serial = m.serial ?? "";
        const verb = { "mark-failed": "Retire", "re-add": "Put back in use", remove: "Remove" }[
          action
        ];
        return {
          label: `${verb} ${driveWords(m)} in ${where}`,
          reason: risk || (act?.reason ?? ""),
          params: out,
        };
      }
      case "repair":
      case "rebalance":
      case "grow-size":
        return {
          label: `${{ repair: "Repair", rebalance: "Optimize", "grow-size": "Extend over the free space:" }[action]} ${where}`,
          reason: risk || (act?.reason ?? ""),
        };
      case "create": {
        const lv = SPACES_LEVELS.find((l) => l.id === p.level);
        if (!lv)
          throw new Refuse(
            "Choose a two-way mirror, three-way mirror, parity, dual parity, or simple.",
          );
        const devices = String(p.devices ?? "")
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        if (devices.length < lv.min)
          throw new Refuse(`${lv.label} needs at least ${lv.min} drives.`);
        const eraseSet = new Set(
          String(p.eraseDevices ?? "")
            .split(",")
            .map((d) => d.trim()),
        );
        const cs = devices.map((d) => pickCandidate(report, d, { erase: eraseSet.has(d) }));
        const name = String(p.name ?? "");
        if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/.test(name))
          throw new Refuse(
            "Name the pool with letters, digits, spaces, dashes, or underscores (like Media).",
          );
        const fs = p.fs === "refs" ? "ReFS" : "NTFS";
        out.serials = cs.map((c) => c.serial ?? "").join(",");
        const sizes = cs.map((c) => c.sizeBytes ?? 0);
        const total = sizes.reduce((x, y) => x + y, 0);
        const usable =
          lv.id === "spaces-simple"
            ? total
            : lv.id === "spaces-mirror"
              ? total / 2
              : lv.id === "spaces-mirror3"
                ? total / 3
                : (total * (cs.length - lv.tolerance)) / cs.length;
        return {
          label: `Create a Storage Spaces pool "${name}" with a ${lv.label.toLowerCase()} space and an ${fs} volume on ${host} from ${cs.map(driveWords).join("; ")}`,
          reason: `ERASES EVERYTHING on ${cs.map((c) => `${c.model ?? c.device}${c.serial ? ` (${c.serial})` : ""}`).join(", ")}. About ${gb(usable)} usable; it survives ${lv.tolerance} drive failure${lv.tolerance === 1 ? "" : "s"}. RAID is not a backup: deleted or damaged files are gone on every drive at once. This cannot be undone.`,
          params: out,
        };
      }
      default:
        throw new Refuse(`"${action}" is shown in the tab only; there is nothing to run.`);
    }
  },
  async run({ action, array: a, params: p, report }, perform) {
    const pool = a?.uuid ?? "";
    const disk = (device: unknown) =>
      report.candidates.find((c) => c.device === device) ??
      a?.members.find((m) => m.device === device);
    const idOf = (device: unknown) => {
      const m = a?.members.find((x) => x.device === device);
      return m?.path ?? undefined;
    };
    switch (action) {
      case "replace":
      case "grow-devices":
      case "add-spare": {
        sameDrive(report, a, p.device, p.serial);
        const c = disk(p.device);
        return perform("spaces.member", {
          pool,
          action: action === "replace" ? "replace" : action === "add-spare" ? "add-spare" : "add",
          disk: String(p.device),
          serial: String(c?.serial ?? p.serial ?? ""),
          ...(p.erase === true ? { erase: true } : {}),
          ...(action === "replace"
            ? {
                replaces: idOf(p.replaces) ?? String(p.replaces),
                replacesSerial: String(p.replacesSerial ?? ""),
              }
            : {}),
        });
      }
      case "mark-failed":
      case "re-add":
      case "remove":
        return perform("spaces.member", {
          pool,
          action: { "mark-failed": "retire", "re-add": "restore", remove: "remove" }[action],
          member: idOf(p.device) ?? String(p.device),
          serial: String(p.serial ?? ""),
        });
      case "repair":
      case "rebalance":
        return perform("spaces.repair", {
          pool,
          action: action === "repair" ? "repair" : "optimize",
        });
      case "grow-size":
        return perform("spaces.grow", { pool });
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
        return perform("spaces.create", {
          name: String(p.name),
          level: String(p.level),
          fs: p.fs === "refs" ? "refs" : "ntfs",
          disks: devices.map((d, i) => ({
            disk: d,
            serial: serials[i] ?? "",
            ...(erase.has(d) ? { erase: true } : {}),
          })),
        });
      }
      default:
        throw new Refuse("Nothing to run.");
    }
  },
};
