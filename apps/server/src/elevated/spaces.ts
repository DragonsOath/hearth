import type { Params } from "./protocol";
import { RaidFailed, RaidRefused, type RaidDeps, type RaidResult } from "./raid";

/**
 * The Windows elevated executor's Storage Spaces operations. Typed like the Linux ones: only a
 * pool's id, drive numbers with their serials, and fixed choices come from the request; every
 * value is checked against a strict pattern before it reaches PowerShell; the script checks the
 * drives in Windows itself before acting (never the drive holding Windows, never a volume with a
 * drive letter, never a drive whose serial is not the approved one, never erasing unless approved
 * with its serial), and the pool is read back afterwards.
 */

const POOL_ID = /^[\w{}:.-]{1,120}$/;
const DRIVE = /^\\\\\.\\PHYSICALDRIVE(\d{1,3})$/;
const SERIAL = /^[\w .:/-]{0,80}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/;
const LEVELS: Record<string, { args: string; min: number }> = {
  "spaces-mirror": { args: "-ResiliencySettingName Mirror -NumberOfDataCopies 2", min: 2 },
  "spaces-mirror3": { args: "-ResiliencySettingName Mirror -NumberOfDataCopies 3", min: 5 },
  "spaces-parity": { args: "-ResiliencySettingName Parity -PhysicalDiskRedundancy 1", min: 3 },
  "spaces-parity2": { args: "-ResiliencySettingName Parity -PhysicalDiskRedundancy 2", min: 7 },
  "spaces-simple": { args: "-ResiliencySettingName Simple", min: 1 },
};

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const POWERSHELL_EXE = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** Runs one script; it answers with one JSON line: { ok, outcome, result, evidence? }. */
async function ps(deps: RaidDeps, script: string, timeoutMs = 300_000) {
  const r = await deps.run(
    POWERSHELL_EXE,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `${PRELUDE}\n${script}`,
    ],
    { timeoutMs },
  );
  const line = r.out
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .at(-1);
  let ans: { ok?: boolean; outcome?: string; result?: string } | undefined;
  try {
    ans = line ? (JSON.parse(line) as typeof ans) : undefined;
  } catch {
    ans = undefined;
  }
  if (!ans) throw new RaidFailed(`PowerShell did not answer: ${r.out.trim().slice(-400)}`);
  if (ans.outcome === "refused" || ans.outcome === "stale")
    throw new RaidRefused(ans.result ?? "Refused.", ans.outcome);
  if (!ans.ok) throw new RaidFailed(ans.result ?? "It did not succeed.");
  return ans.result ?? "Done.";
}

/**
 * Shared checks, in PowerShell. Say ends the script with one JSON answer. NewDrive returns the
 * physical disk only if it may join a pool now (erasing it first when that was approved).
 */
const PRELUDE = `$ErrorActionPreference = 'Stop'
function Say($ok, $outcome, $result) { [pscustomobject]@{ ok = $ok; outcome = $outcome; result = $result } | ConvertTo-Json -Compress; exit 0 }
trap { Say $false 'failed' ("" + $_.Exception.Message) }
function PoolOf($id) {
  $p = Get-StoragePool -IsPrimordial $false -ErrorAction SilentlyContinue | Where-Object { $_.UniqueId -eq $id }
  if (-not $p) { Say $false 'stale' 'That pool is not on this machine.' }
  $p
}
# " (serial X)", or nothing when the drive reports none (virtual drives often do not).
function Ser($x) { $s = "$($x.SerialNumber)".Trim(); if ($s) { " (serial $s)" } else { "" } }
function NewDrive($n, $serial, $erase) {
  $d = Get-PhysicalDisk | Where-Object { "$($_.DeviceId)" -eq "$n" }
  if (-not $d) { Say $false 'refused' "Drive $n is not on this machine." }
  $have = "$($d.SerialNumber)".Trim()
  if ($serial -and $have -ne $serial) { $h = if ($have) { "serial $have" } else { 'no serial' }; Say $false 'stale' "Drive $n is not the one approved ($h, approved $serial). Nothing was done." }
  $disk = Get-Disk -Number $n -ErrorAction SilentlyContinue
  if ($disk -and ($disk.IsSystem -or $disk.IsBoot)) { Say $false 'refused' "Drive $n holds Windows. Never used." }
  if (@($d.CannotPoolReason) -match 'In a Pool') { Say $false 'refused' "Drive $n is already in a storage pool." }
  $parts = @($disk | Get-Partition -ErrorAction SilentlyContinue)
  $letters = @($parts | Where-Object { $_.DriveLetter -and $_.DriveLetter -ne [char]0 } | ForEach-Object { "$($_.DriveLetter):" })
  if ($letters.Count) { Say $false 'refused' "Drive $n is in use as $($letters -join ', '). Hearth never erases a drive in use." }
  if (-not $d.CanPool) {
    if (-not $parts.Count) { Say $false 'refused' "Windows will not pool drive $n ($(@($d.CannotPoolReason) -join ', '))." }
    if (-not $erase) { Say $false 'refused' "Drive $n holds partitions. Joining a pool erases them; that was not approved." }
    if (-not $have -or $have -ne $serial) { Say $false 'refused' "Erasing drive $n needs its serial number in the approval, and it did not match." }
    Clear-Disk -Number $n -RemoveData -RemoveOEM -Confirm:$false
    $d = Get-PhysicalDisk | Where-Object { "$($_.DeviceId)" -eq "$n" }
    if (-not $d.CanPool) { Say $false 'failed' "Drive $n was erased, but Windows still will not pool it ($(@($d.CannotPoolReason) -join ', '))." }
  }
  $d
}
function Tolerance($pool) {
  $v = @($pool | Get-VirtualDisk)
  if (-not $v.Count) { return 0 }
  ($v | Measure-Object -Property PhysicalDiskRedundancy -Minimum).Minimum
}
function Lost($pool) {
  @($pool | Get-PhysicalDisk | Where-Object { $_.HealthStatus -ne 'Healthy' -or "$($_.OperationalStatus)" -match 'Lost' -or "$($_.Usage)" -eq 'Retired' }).Count
}`;

function poolParam(v: unknown) {
  if (typeof v !== "string" || !POOL_ID.test(v))
    throw new RaidRefused("The pool's id is not valid.");
  return v;
}
function driveParam(v: unknown) {
  const m = typeof v === "string" ? DRIVE.exec(v) : null;
  if (!m) throw new RaidRefused("The drive must be named like \\\\.\\PHYSICALDRIVE2.");
  return Number(m[1]);
}
function serialParam(v: unknown) {
  if (v === undefined || v === "") return "";
  if (typeof v !== "string" || !SERIAL.test(v))
    throw new RaidRefused("The serial number is not valid.");
  return v;
}
function memberParam(v: unknown) {
  if (typeof v !== "string" || !POOL_ID.test(v))
    throw new RaidRefused("The drive's id is not valid.");
  return v;
}

/** spaces.member: add, add as a spare, replace, retire, put back, or remove a drive. */
export async function spacesMember(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const pool = poolParam(params.pool);
  const action = params.action;
  if (action === "add" || action === "add-spare" || action === "replace") {
    const n = driveParam(params.disk);
    const serial = serialParam(params.serial);
    const erase = params.erase === true ? "$true" : "$false";
    const old = action === "replace" ? memberParam(params.replaces) : "";
    const result = await ps(
      deps,
      `$pool = PoolOf ${q(pool)}
$d = NewDrive ${n} ${q(serial)} ${erase}
${
  action === "replace"
    ? `$old = $pool | Get-PhysicalDisk | Where-Object { $_.UniqueId -eq ${q(old)} }
if (-not $old) { Say $false 'stale' 'The drive being replaced is no longer in the pool.' }`
    : ""
}
Add-PhysicalDisk -StoragePoolUniqueId $pool.UniqueId -PhysicalDisks $d${action === "add-spare" ? " -Usage HotSpare" : ""}
$in = @($pool | Get-PhysicalDisk | Where-Object { $_.UniqueId -eq $d.UniqueId })
if (-not $in.Count) { Say $false 'failed' "Drive ${n} does not show in the pool afterwards." }
${
  action === "replace"
    ? `if ("$($old.OperationalStatus)" -notmatch 'Lost') { Set-PhysicalDisk -UniqueId $old.UniqueId -Usage Retired }
$pool | Get-VirtualDisk | Repair-VirtualDisk -AsJob | Out-Null
Say $true 'done' "Drive ${n}$(Ser $d) joined $($pool.FriendlyName); the old drive is retired and Windows is repairing the space onto the new one. Remove the old drive once the repair finishes."`
    : `Say $true 'done' "Drive ${n}$(Ser $d) joined $($pool.FriendlyName)${action === "add-spare" ? " as a hot spare" : ""}."`
}`,
    );
    return { target: `${pool} disk ${n}`, result };
  }
  const member = memberParam(params.member);
  const serial = serialParam(params.serial);
  const find = `$pool = PoolOf ${q(pool)}
$m = $pool | Get-PhysicalDisk | Where-Object { $_.UniqueId -eq ${q(member)} }
if (-not $m) { Say $false 'stale' 'That drive is not in the pool.' }
if (${q(serial)} -and "$($m.SerialNumber)".Trim() -ne ${q(serial)}) { Say $false 'stale' 'That drive is not the one approved. Nothing was done.' }`;
  if (action === "retire") {
    const result = await ps(
      deps,
      `${find}
if ((Lost $pool) -ge (Tolerance $pool)) { Say $false 'refused' 'No redundancy left: retiring another drive would lose data.' }
Set-PhysicalDisk -UniqueId $m.UniqueId -Usage Retired
$pool | Get-VirtualDisk | Repair-VirtualDisk -AsJob | Out-Null
Say $true 'done' "The drive$(Ser $m) is retired; Windows is moving its data onto the others."`,
    );
    return { target: `${pool} ${member}`, result };
  }
  if (action === "restore") {
    const result = await ps(
      deps,
      `${find}
Set-PhysicalDisk -UniqueId $m.UniqueId -Usage AutoSelect
Say $true 'done' "The drive$(Ser $m) is back in use."`,
    );
    return { target: `${pool} ${member}`, result };
  }
  if (action === "remove") {
    const result = await ps(
      deps,
      `${find}
if ("$($m.Usage)" -notin @('Retired', 'HotSpare', 'Hot Spare') -and "$($m.OperationalStatus)" -notmatch 'Lost') { Say $false 'refused' 'Only a retired, missing, or spare drive leaves the pool. Retire it first.' }
Remove-PhysicalDisk -StoragePoolUniqueId $pool.UniqueId -PhysicalDisks $m -Confirm:$false
if ($pool | Get-PhysicalDisk | Where-Object { $_.UniqueId -eq $m.UniqueId }) { Say $false 'failed' 'The drive is still in the pool.' }
Say $true 'done' 'The drive left the pool. It was not erased.'`,
    );
    return { target: `${pool} ${member}`, result };
  }
  throw new RaidRefused("The drive action is not valid.");
}

/** spaces.repair: repair the pool's spaces, or optimize (rebalance) the pool. */
export async function spacesRepair(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const pool = poolParam(params.pool);
  if (params.action !== "repair" && params.action !== "optimize")
    throw new RaidRefused("Repair or optimize.");
  const result = await ps(
    deps,
    `$pool = PoolOf ${q(pool)}
${params.action === "repair" ? "$pool | Get-VirtualDisk | Repair-VirtualDisk -AsJob | Out-Null" : "Optimize-StoragePool -UniqueId $pool.UniqueId -AsJob | Out-Null"}
Say $true 'done' "${params.action === "repair" ? "Windows is repairing the spaces in" : "Windows is spreading data over every drive in"} $($pool.FriendlyName); it runs in the background."`,
  );
  return { target: pool, result };
}

/** spaces.grow: extend each space, and its volume, over the pool's free space. */
export async function spacesGrow(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const pool = poolParam(params.pool);
  const result = await ps(
    deps,
    `$pool = PoolOf ${q(pool)}
$said = @()
foreach ($v in @($pool | Get-VirtualDisk)) {
  $more = (Get-VirtualDiskSupportedSize -StoragePoolUniqueId $pool.UniqueId -ResiliencySettingName $v.ResiliencySettingName).VirtualDiskSizeMax
  if ($more -gt 1GB) { Resize-VirtualDisk -UniqueId $v.UniqueId -Size ($v.Size + $more) }
  $part = $v | Get-Disk | Get-Partition | Where-Object { $_.Type -eq 'Basic' } | Select-Object -Last 1
  if ($part) {
    $max = ($part | Get-PartitionSupportedSize).SizeMax
    if ($max -gt $part.Size + 1GB) { $part | Resize-Partition -Size $max }
  }
  $said += "$($v.FriendlyName): $([math]::Round((Get-VirtualDisk -UniqueId $v.UniqueId).Size / 1GB)) GB"
}
Say $true 'done' ("Extended: " + ($said -join '; ') + ".")`,
  );
  return { target: pool, result };
}

/** spaces.create: a pool from approved, checked drives, one space over all of it, and a volume. */
export async function spacesCreate(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const name = typeof params.name === "string" && NAME.test(params.name) ? params.name : undefined;
  if (!name)
    throw new RaidRefused(
      "The pool's name must be letters, digits, spaces, dashes, or underscores.",
    );
  const level = typeof params.level === "string" ? LEVELS[params.level] : undefined;
  if (!level) throw new RaidRefused("The layout is not valid.");
  const fs = params.fs === "refs" ? "ReFS" : "NTFS";
  const list = Array.isArray(params.disks)
    ? (params.disks as { disk?: unknown; serial?: unknown; erase?: unknown }[])
    : [];
  if (list.length < level.min)
    throw new RaidRefused(`That layout needs at least ${level.min} drives.`);
  if (list.length > 32) throw new RaidRefused("Too many drives.");
  const seen = new Set<number>();
  const checks = list.map((d) => {
    const n = driveParam(d.disk);
    if (seen.has(n)) throw new RaidRefused(`Drive ${n} is listed twice.`);
    seen.add(n);
    return `$disks += NewDrive ${n} ${q(serialParam(d.serial))} ${d.erase === true ? "$true" : "$false"}`;
  });
  const result = await ps(
    deps,
    `if (Get-StoragePool -IsPrimordial $false -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -eq ${q(name)} }) { Say $false 'refused' 'A pool with that name already exists.' }
$disks = @()
${checks.join("\n")}
$sub = Get-StorageSubSystem | Where-Object { $_.FriendlyName -like 'Windows Storage*' } | Select-Object -First 1
$pool = New-StoragePool -FriendlyName ${q(name)} -StorageSubSystemUniqueId $sub.UniqueId -PhysicalDisks $disks
$v = New-VirtualDisk -StoragePoolUniqueId $pool.UniqueId -FriendlyName ${q(name)} ${level.args} -ProvisioningType Fixed -UseMaximumSize
$disk = $v | Get-Disk
if ($disk.PartitionStyle -eq 'RAW') { Initialize-Disk -Number $disk.Number -PartitionStyle GPT }
$part = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
Format-Volume -Partition $part -FileSystem ${fs} -NewFileSystemLabel ${q(name)} -Confirm:$false | Out-Null
$letter = (Get-Partition -DiskNumber $disk.Number | Where-Object { $_.DriveLetter } | Select-Object -First 1).DriveLetter
Say $true 'done' "Created the pool ${name.replace(/"/g, "")} with a $([math]::Round($v.Size / 1GB)) GB space, formatted ${fs} as $($letter):."`,
    900_000,
  );
  return { target: name, result };
}
