import {
  raidTolerance,
  type RaidAction,
  type RaidActionId,
  type RaidArray,
  type RaidCandidate,
  type RaidCreateOption,
  type RaidHealth,
  type RaidMember,
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
import { flatten, type Block } from "./read";
import type { SnapEnv } from "./snapraid";

/**
 * Btrfs filesystems spread over several drives (OpenMediaVault, Rockstor, Fedora and openSUSE
 * setups), read from the kernel's own files under /sys/fs/btrfs (no root needed): its drives,
 * which are missing, its data and metadata profiles, and what it is busy with. Error counters and
 * the last scrub need root: read through the executor's storage.read when it is set up. Changes
 * go through btrfs.* operations. Unlike mdadm and ZFS, Btrfs converts between profiles in place.
 */

export const BTRFS_OPERATIONS: readonly OperationName[] = [
  "btrfs.member",
  "btrfs.scrub",
  "btrfs.balance",
  "btrfs.clear",
  "btrfs.create",
];

const PROFILE_TEXT: Record<string, string> = {
  single: "Single (no redundancy)",
  dup: "Dup (two copies on one drive)",
  raid0: "RAID 0 (striped, no redundancy)",
  raid1: "RAID 1 (two copies)",
  raid1c3: "RAID 1C3 (three copies)",
  raid1c4: "RAID 1C4 (four copies)",
  raid10: "RAID 10",
  raid5: "RAID 5",
  raid6: "RAID 6",
};
const KNOWN = Object.keys(PROFILE_TEXT);

const tol = (p: string, n: number) =>
  p === "dup" || p === "single" || p === "raid0" ? 0 : (raidTolerance(`btrfs-${p}`, n) ?? 0);

export interface BtrfsFs {
  uuid: string;
  label?: string;
  devices: Block[];
  missing: string[];
  data: string[];
  metadata: string[];
  busy?: string;
  mount?: string;
}

/** Every Btrfs filesystem with more than one drive (or a redundant profile, or a lost drive). */
export async function readBtrfs(io: RaidIO, blocks: Block[]): Promise<BtrfsFs[]> {
  const all = flatten(blocks).map((x) => x.b);
  const flat = all.filter((b) => b.fstype === "btrfs" && b.uuid);
  const uuids = [...new Set(flat.map((b) => b.uuid!))];
  const out: BtrfsFs[] = [];
  for (const uuid of uuids) {
    const base = `/sys/fs/btrfs/${uuid}`;
    // The kernel's own list of member devices is current the moment a drive is added; lsblk
    // waits for udev, so a just-added drive can be missing from it for a while.
    const named = (await io.list(`${base}/devices`))
      .map((n) => all.find((b) => b.kname === n || b.name === n))
      .filter((b): b is Block => !!b);
    const devices = named.length ? named : flat.filter((b) => b.uuid === uuid);
    const ids = await io.list(`${base}/devinfo`);
    const missing: string[] = [];
    for (const id of ids)
      if ((await io.read(`${base}/devinfo/${id}/missing`))?.trim() === "1") missing.push(id);
    const profiles = async (kind: string) => {
      // A profile's folder can outlive its last chunk after a conversion: only count profiles
      // that still hold space (when the size can be read).
      const out: string[] = [];
      for (const p of await io.list(`${base}/allocation/${kind}`)) {
        if (!KNOWN.includes(p)) continue;
        const total = (await io.read(`${base}/allocation/${kind}/${p}/total_bytes`))?.trim();
        if (total === undefined || total === "" || Number(total) > 0) out.push(p);
      }
      return out;
    };
    const data = await profiles("data");
    const metadata = await profiles("metadata");
    const busy = (await io.read(`${base}/exclusive_operation`))?.trim();
    const label = (await io.read(`${base}/label`))?.trim();
    const mount = devices.find((d) => d.mount)?.mount;
    const redundant = data.some((p) => !["single", "dup", "raid0"].includes(p));
    if (devices.length < 2 && !redundant && !missing.length) continue;
    out.push({
      uuid,
      ...(label ? { label } : {}),
      devices,
      missing,
      data,
      metadata,
      ...(busy && busy !== "none" ? { busy } : {}),
      ...(mount ? { mount } : {}),
    });
  }
  return out;
}

/** "[/dev/sdb].write_io_errs   0" lines, by device. */
export function parseStats(out: string) {
  const by: Record<string, Record<string, number>> = {};
  for (const m of out.matchAll(/^\[(\S+)\]\.(\w+)_errs\s+(\d+)/gm)) {
    by[m[1]!] ??= {};
    by[m[1]!]![m[2]!] = Number(m[3]);
  }
  return by;
}

export function parseScrub(out: string) {
  const status = /^Status:\s+(\w+)/m.exec(out)?.[1];
  const started = /^Scrub started:\s+(.+)$/m.exec(out)?.[1]?.trim();
  const pct = /\((\d+(?:\.\d+)?)%\)/.exec(out)?.[1];
  // The plain status ends with an "Error summary" line; the raw one (-R, which Hearth reads)
  // lists counters instead, so total those.
  let errors = /Error summary:\s+(.+)$/m.exec(out)?.[1]?.trim();
  if (!errors) {
    const n = (k: string) => Number(new RegExp(`^\\s*${k}:\\s+(\\d+)`, "m").exec(out)?.[1] ?? 0);
    const counters = [...out.matchAll(/^\s*(\w+_errors):\s+(\d+)/gm)];
    if (counters.length) {
      const found = counters
        .filter(
          (m) => !["corrected_errors", "uncorrectable_errors", "unverified_errors"].includes(m[1]!),
        )
        .reduce((s, m) => s + Number(m[2]), 0);
      const bad = n("uncorrectable_errors");
      const fixed = n("corrected_errors");
      errors =
        found + bad === 0
          ? "no errors found"
          : `${found} error${found === 1 ? "" : "s"} found, ${fixed} corrected, ${bad} uncorrectable`;
    }
  }
  return {
    ...(status ? { status } : {}),
    ...(started ? { started } : {}),
    ...(pct ? { pct: Number(pct) } : {}),
    ...(errors ? { errors } : {}),
  };
}

const HEALTH_TEXT: Record<RaidHealth, string> = {
  healthy:
    "Every drive is there. Btrfs keeps the copies its profile asks for, and checks every block it reads.",
  degraded:
    "A drive is missing. The data is still there, but with less (or no) protection until the drive is replaced.",
  rebuilding: "Btrfs is copying a drive onto its replacement. Leave it running.",
  resyncing: "",
  checking:
    "A scrub is reading every block and repairing damage from the good copy. The filesystem is fully usable meanwhile.",
  reshaping:
    "Btrfs is moving data between drives (a balance, or a drive being removed). The filesystem stays usable, but slower.",
  failed:
    "More drives are missing than the profile can lose. Do not write to it; get help before changing anything.",
  inactive: "",
  unknown: "Hearth could not tell the filesystem's state.",
};

export function btrfsToArray(
  fs: BtrfsFs,
  extra: {
    used?: { total: number; free: number };
    stats?: Record<string, Record<string, number>>;
    scrub?: ReturnType<typeof parseScrub>;
  },
  blocks: Block[],
): RaidArray {
  const flat = flatten(blocks);
  const data = fs.data.find((p) => p !== "single") ?? fs.data[0] ?? "single";
  const meta = fs.metadata.find((p) => p !== "single" && p !== "dup") ?? fs.metadata[0];
  const n = fs.devices.length + fs.missing.length;
  const tolerance = Math.min(tol(data, n), meta ? tol(meta, n) : 9);
  const canLose = Math.max(0, tolerance - fs.missing.length);
  const members: RaidMember[] = fs.devices.map((d) => {
    const disk = flat.find((x) => x.b.kname === d.kname)?.disk ?? d;
    const errs = extra.stats?.[`/dev/${d.kname}`];
    const errors = errs ? Object.values(errs).reduce((a, b) => a + b, 0) : 0;
    return {
      device: `/dev/${d.kname}`,
      disk: `/dev/${disk.kname}`,
      ...(disk.model ? { model: disk.model } : {}),
      ...(disk.serial ? { serial: disk.serial } : {}),
      sizeBytes: d.sizeBytes,
      ...(disk.transport ? { transport: disk.transport } : {}),
      ...(disk.rotational !== undefined ? { rotational: disk.rotational } : {}),
      role: "active",
      states: ["present"],
      ...(errors ? { errors, errorCounts: errs } : {}),
    };
  });
  for (const id of fs.missing)
    members.push({
      device: `devid:${id}`,
      role: "missing",
      states: ["missing"],
      stateText: `Drive ${id} is missing`,
    });
  const scrubbing = extra.scrub?.status === "running";
  let health: RaidHealth;
  if (fs.missing.length > tolerance) health = "failed";
  else if (fs.busy === "device replace" || fs.busy === "replace") health = "rebuilding";
  else if (fs.busy) health = "reshaping";
  else if (fs.missing.length) health = "degraded";
  else if (scrubbing) health = "checking";
  else health = "healthy";
  const warnings: string[] = [];
  if (fs.missing.length)
    warnings.push(
      canLose === 0
        ? "No redundancy left: one more drive failure would lose data. Replace the missing drive (it is named by its number)."
        : `It can lose ${canLose} more drive${canLose === 1 ? "" : "s"} before data is lost.`,
    );
  if (fs.data.includes("raid5") || fs.data.includes("raid6"))
    warnings.push(
      "Btrfs RAID 5 and 6 can lose recent writes after a power cut (the write hole); the Btrfs developers do not recommend them. RAID 1 or 1C3 is safer.",
    );
  if (fs.data.length > 1)
    warnings.push(
      `Data is in more than one profile (${fs.data.join(", ")}): a conversion did not finish. Run it again to finish.`,
    );
  if (meta && tol(meta, n) < tol(data, n))
    warnings.push(
      `Metadata (${meta}) is less protected than data (${data}): losing it loses everything. Convert metadata to at least ${data}.`,
    );
  for (const m of members)
    if (m.errorCounts && m.errors)
      warnings.push(
        `${m.device} has had ${Object.entries(m.errorCounts)
          .filter(([, v]) => v)
          .map(([k, v]) => `${v} ${k}`)
          .join(
            ", ",
          )} errors. Check its cable and SMART health; reset the counters once it is dealt with.`,
      );
  if (extra.scrub?.errors && !/no errors/i.test(extra.scrub.errors))
    warnings.push(`The last scrub found errors: ${extra.scrub.errors}.`);
  return {
    id: `btrfs:${fs.uuid}`,
    tech: "btrfs",
    name: fs.label || fs.uuid.slice(0, 8),
    device: fs.mount ?? fs.uuid,
    uuid: fs.uuid,
    level: `btrfs-${data}`,
    levelText: `${PROFILE_TEXT[data] ?? data}${meta && meta !== data ? `, metadata ${PROFILE_TEXT[meta]?.split(" (")[0] ?? meta}` : ""}, ${n} drives`,
    health,
    healthText: HEALTH_TEXT[health] || HEALTH_TEXT.unknown,
    ...(extra.used
      ? { sizeBytes: extra.used.total, usedBytes: extra.used.total - extra.used.free }
      : {}),
    rawBytes: fs.devices.reduce((s, d) => s + d.sizeBytes, 0),
    raidDevices: n,
    counts: { active: fs.devices.length, failed: 0, missing: fs.missing.length, spare: 0 },
    canLose,
    members,
    ...(fs.mount ? { mount: fs.mount } : {}),
    fstype: "btrfs",
    ...(scrubbing
      ? {
          sync: {
            action: "scrub",
            ...(extra.scrub?.pct !== undefined ? { progressPct: extra.scrub.pct } : {}),
          },
        }
      : {}),
    ...(fs.busy && !scrubbing
      ? { sync: { action: fs.busy.includes("replace") ? "recover" : "balance" } }
      : {}),
    ...(extra.scrub?.status === "aborted" || extra.scrub?.status === "interrupted"
      ? { sync: { action: "scrub", paused: true } }
      : {}),
    ...(extra.scrub?.started && !scrubbing
      ? {
          lastCheck: {
            text: `Last scrub ${extra.scrub.started}: ${extra.scrub.errors ?? extra.scrub.status ?? "?"}.`,
          },
        }
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
  "grow-devices": "Add a drive",
  remove: "Remove a drive",
  rebalance: "Balance (spread data over every drive)",
  "change-level": "Convert to another profile",
  "clear-errors": "Reset error counters",
  "grow-size": "Use the drives' full size",
  "schedule-check": "Schedule regular scrubs",
  "add-spare": "Add a hot spare",
  "mark-failed": "Mark a drive failed",
  "re-add": "Re-add a returning drive",
  speed: "Scrub speed",
  identify: "Identify the physical drives",
};

export function btrfsActions(
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
  const busy = a.sync && !a.sync.paused ? a.sync.action : undefined;
  const mounted = Boolean(a.mount);
  const usable = ctx.candidates.filter((c) => c.state !== "excluded");
  const noDisk =
    "No free drive is connected. Connect one (it must not be the system drive or mounted), then read again.";
  const notMounted = "Btrfs is changed while mounted. Mount it first.";
  if (!mounted) add("check", "blocked", notMounted);
  else if (busy === "scrub")
    add(
      "check",
      "running",
      a.sync?.progressPct !== undefined ? `${a.sync.progressPct}%` : undefined,
    );
  else if (busy) add("check", "blocked", `Busy (${busy}); scrub after it finishes.`);
  else if (a.sync?.paused) add("check", "blocked", "A scrub is paused: resume it.");
  else
    add("check", "available", undefined, {
      risk: "Reads every block and repairs damage from the good copy. Drives are busier while it runs.",
    });
  if (busy === "scrub") {
    add("pause-check", "available", "Keeps its place; resume continues from there.");
    add("cancel-check", "available", "Stops it (it can still be resumed).");
  } else if (busy)
    add(
      "cancel-check",
      "unsupported",
      "A replace or drive removal is not stopped here: it restores or moves data.",
    );
  if (a.sync?.paused) add("resume-check", "available");
  const missing = a.members.some((m) => m.role === "missing");
  if (!mounted) add("replace", "blocked", notMounted);
  else if (busy && busy !== "scrub") add("replace", "blocked", `Wait until the ${busy} finishes.`);
  else if (!usable.length) add("replace", "blocked", noDisk);
  else
    add("replace", "available", missing ? "Suggested for the missing drive." : undefined, {
      risk: "Btrfs copies the old drive (or rebuilds a missing one from the copies) onto the new one; the old one stays in use until it is done.",
    });
  if (!mounted) add("grow-devices", "blocked", notMounted);
  else if (busy && busy !== "scrub")
    add("grow-devices", "blocked", `Wait until the ${busy} finishes.`);
  else if (!usable.length) add("grow-devices", "blocked", noDisk);
  else
    add("grow-devices", "available", "Then balance, so data spreads onto it.", {
      risk: "The drive joins at once; its space is used as data is written or balanced.",
    });
  if (!mounted) add("remove", "blocked", notMounted);
  else if (busy && busy !== "scrub") add("remove", "blocked", `Wait until the ${busy} finishes.`);
  else
    add(
      "remove",
      "available",
      "Btrfs moves its data onto the others first (hours); it refuses if they cannot hold it in this profile.",
      { risk: "Less space, and less protection if it was needed for the profile." },
    );
  if (!mounted || busy)
    add("rebalance", "blocked", mounted ? `Wait until the ${busy} finishes.` : notMounted);
  else
    add("rebalance", "available", undefined, {
      risk: "Rewrites every block across the drives: hours on large filesystems; it stays usable.",
    });
  if (!mounted || busy || missing)
    add(
      "change-level",
      "blocked",
      missing
        ? "Replace the missing drive first."
        : mounted
          ? `Wait until the ${busy} finishes.`
          : notMounted,
    );
  else
    add(
      "change-level",
      "available",
      "Btrfs converts in place: RAID 1 to 1C3 for more protection, single to RAID 1 after adding a drive.",
      {
        risk: "Rewrites all data (hours); it stays usable. It can be converted back the same way. Back up first.",
      },
    );
  if (a.members.some((m) => (m.errors ?? 0) > 0))
    add("clear-errors", "available", "Once the cause (cable, drive) is dealt with.");
  else
    add(
      "clear-errors",
      "blocked",
      "No errors are counted (or they cannot be read without the admin helper).",
    );
  if (!mounted) add("grow-size", "blocked", notMounted);
  else
    add(
      "grow-size",
      "available",
      "After replacing drives with larger ones: each gives its full size.",
      { risk: "Safe and quick." },
    );
  add("schedule-check", "available");
  add("add-spare", "unsupported", "Btrfs has no hot spares: replace a failed drive with Replace.");
  add("mark-failed", "unsupported", "Btrfs cannot mark a drive failed: replace it, or remove it.");
  add(
    "re-add",
    "unsupported",
    "A drive that comes back rejoins when the filesystem is mounted again; then scrub, so it catches up.",
  );
  add("speed", "unsupported", "Btrfs paces its scrub itself.");
  add(
    "identify",
    "available",
    "Each drive's model and serial number are shown; match the serial on the drive's label.",
  );
  if (!ctx.ready.ready)
    for (const x of out)
      if (x.status === "available" && !["identify", "schedule-check"].includes(x.id)) {
        x.status = "blocked";
        x.reason = `${ctx.ready.why ?? "Approved Btrfs changes are not set up on this machine."}${x.reason ? ` (${x.reason})` : ""}`;
      }
  return out;
}

/* ---------- the driver ---------- */

const BTRFS_LEVELS: RaidCreateOption["levels"] = [
  {
    id: "btrfs-raid1",
    label: "RAID 1",
    min: 2,
    tolerance: 1,
    words: "Two copies of everything, on any mix of drive sizes.",
  },
  {
    id: "btrfs-raid1c3",
    label: "RAID 1C3",
    min: 3,
    tolerance: 2,
    words: "Three copies: survives two failures.",
  },
  {
    id: "btrfs-raid10",
    label: "RAID 10",
    min: 4,
    tolerance: 1,
    words: "Two copies, striped: faster.",
  },
  {
    id: "btrfs-single",
    label: "Single",
    min: 1,
    tolerance: 0,
    words: "No protection: one failure loses what was on it.",
  },
];

const bin = async (io: RaidIO, n: string) =>
  (
    await Promise.all(["/usr/sbin", "/sbin", "/usr/bin", "/bin"].map((d) => io.exists(`${d}/${n}`)))
  ).some(Boolean);

export const btrfsDriver: RaidDriver = {
  tech: "btrfs",
  platforms: ["linux"],
  operations: BTRFS_OPERATIONS,
  async present({ io, blocks }) {
    return (
      io.platform === "linux" &&
      ((await readBtrfs(io, blocks)).length > 0 || (await bin(io, "mkfs.btrfs")))
    );
  },
  async support(env) {
    const found = await readBtrfs(env.io, env.blocks);
    const tool = await bin(env.io, "btrfs");
    return {
      tech: "btrfs",
      seen: found.length
        ? `${found.length} multi-drive filesystem${found.length > 1 ? "s" : ""}: ${found.map((f) => f.label ?? f.uuid.slice(0, 8)).join(", ")}`
        : "No Btrfs filesystem over several drives",
      support: tool ? "manage" : found.length ? "detect" : "none",
      verified: env.sample ? "fixtures" : "loopback",
      tools: [{ name: "btrfs", present: tool }],
    };
  },
  async arrays(env) {
    const e = env as SnapEnv;
    const found = await readBtrfs(env.io, env.blocks);
    const out: RaidArray[] = [];
    for (const f of found) {
      const extra: Parameters<typeof btrfsToArray>[1] = {};
      if (f.mount) {
        const used = await env.io.statfs(f.mount);
        if (used) extra.used = used;
        // Error counters and the scrub need root: as Hearth's account first, then the executor.
        const read = async (args: string[], kind: string) => {
          const r = await env.io.run("btrfs", args, { timeoutMs: 30_000 });
          if (r.code === 0) return r.out;
          const v = e.readElevated ? await e.readElevated({ kind, mount: f.mount! }) : undefined;
          return v?.code === 0 ? v.out : undefined;
        };
        const stats = await read(["device", "stats", f.mount], "btrfs-stats");
        if (stats) extra.stats = parseStats(stats);
        const scrub = await read(["scrub", "status", "-R", f.mount], "btrfs-scrub");
        if (scrub) extra.scrub = parseScrub(scrub);
      }
      out.push(btrfsToArray(f, extra, env.blocks));
    }
    return out;
  },
  actions(a, env) {
    return btrfsActions(a, env);
  },
  async create(env) {
    if (!(await bin(env.io, "mkfs.btrfs"))) return undefined;
    return {
      tech: "btrfs",
      label: "Btrfs",
      levels: BTRFS_LEVELS,
      note: "Not mounted: mounting it is a separate step. Btrfs mixes drive sizes well and can be converted later.",
    };
  },
  async plan({ action, array: a, params: p, report, host }): Promise<PlanWords> {
    const where = a
      ? `the Btrfs filesystem ${a.name} (${a.levelText}) at ${a.mount ?? "?"} on ${host}`
      : host;
    const act = a?.actions.find((x) => x.id === action);
    const risk = act?.risk ?? "";
    const out: Record<string, string | number | boolean> = {};
    switch (action) {
      case "check":
      case "resume-check":
        return {
          label: `${action === "check" ? "Scrub" : "Resume the scrub of"} ${where}`,
          reason: risk || "Reads and checks every block.",
        };
      case "pause-check":
      case "cancel-check":
        return {
          label: `Stop the scrub of ${where}`,
          reason: "Only the scrub stops; it can resume from where it was.",
        };
      case "replace":
      case "grow-devices": {
        const c = pickCandidate(report, p.device, { erase: p.erase });
        out.serial = c.serial ?? "";
        if (action === "replace") {
          const old = pickMember(a!, p.replaces);
          if (old.role !== "missing" && old.sizeBytes && (c.sizeBytes ?? 0) < old.sizeBytes)
            throw new Refuse(
              `${c.device} is smaller than ${old.device}; the new drive must be at least as large.`,
            );
          return {
            label: `Replace ${old.role === "missing" ? `missing drive ${old.device}` : driveWords(old)} with ${driveWords(c)} in ${where}`,
            reason: `${c.state === "has-data" ? `ERASES ${c.device}: ${c.reason ?? "it holds data"}. ` : ""}${risk}`,
            params: out,
          };
        }
        return {
          label: `Add ${driveWords(c)} to ${where}`,
          reason: `${c.state === "has-data" ? `ERASES ${c.device}: ${c.reason ?? "it holds data"}. ` : ""}${risk}`,
          params: out,
        };
      }
      case "remove": {
        const m = pickMember(a!, p.device);
        out.serial = m.serial ?? "";
        return {
          label: `Remove ${m.role === "missing" ? `missing drive ${m.device}` : driveWords(m)} from ${where}`,
          reason: `${act?.reason ?? ""} ${risk}`.trim(),
          params: out,
        };
      }
      case "rebalance":
        return { label: `Balance ${where}`, reason: risk };
      case "change-level": {
        const to = String(p.profile ?? "");
        const need: Record<string, number> = {
          raid1: 2,
          raid1c3: 3,
          raid1c4: 4,
          raid10: 4,
          raid0: 2,
          single: 1,
          raid5: 2,
          raid6: 3,
        };
        if (!need[to]) throw new Refuse("Choose a profile.");
        const have = a!.members.filter((m) => m.role !== "missing").length;
        if (have < need[to]!)
          throw new Refuse(
            `${PROFILE_TEXT[to]} needs at least ${need[to]} drives; ${a!.name} has ${have}. Add a drive first.`,
          );
        return {
          label: `Convert ${where} to ${PROFILE_TEXT[to]}`,
          reason: `${risk}${to === "raid5" || to === "raid6" ? " Btrfs RAID 5 and 6 are not recommended by its developers (the write hole)." : ""}${to === "single" || to === "raid0" ? " This removes all redundancy." : ""}`,
        };
      }
      case "clear-errors":
        return {
          label: `Reset the error counters of ${where}`,
          reason:
            "Do it once the cause is fixed; errors that return mean the drive or cable is failing.",
        };
      case "grow-size":
        return { label: `Let every drive in ${where} give its full size`, reason: risk };
      case "create": {
        const lv = BTRFS_LEVELS.find((l) => l.id === p.level);
        if (!lv) throw new Refuse("Choose RAID 1, 1C3, 10, or single.");
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
        const name = String(p.name ?? "");
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name))
          throw new Refuse("Name it with letters, digits, dashes, or underscores (like vault).");
        out.serials = cs.map((c) => c.serial ?? "").join(",");
        const sizes = cs.map((c) => c.sizeBytes ?? 0);
        const total = sizes.reduce((x, y) => x + y, 0);
        const largest = Math.max(...sizes);
        const usable =
          lv.id === "btrfs-single"
            ? total
            : lv.id === "btrfs-raid1c3"
              ? Math.min(total / 3, (total - largest) / 2)
              : Math.min(total / 2, total - largest);
        return {
          label: `Create a Btrfs ${lv.label} filesystem "${name}" on ${host} from ${cs.map(driveWords).join("; ")}`,
          reason: `ERASES EVERYTHING on ${cs.map((c) => c.device).join(", ")}. About ${gb(usable)} usable; it survives ${lv.tolerance} drive failure${lv.tolerance === 1 ? "" : "s"}. RAID is not a backup: deleted or damaged files are gone on every drive at once. It is not mounted; that is a separate step. This cannot be undone.`,
          params: out,
        };
      }
      default:
        throw new Refuse(`"${action}" is shown in the tab only; there is nothing to run.`);
    }
  },
  async run({ action, array: a, params: p, report }, perform) {
    const mount = a?.mount ?? "";
    switch (action) {
      case "check":
        return perform("btrfs.scrub", { mount, action: "start" });
      case "resume-check":
        return perform("btrfs.scrub", { mount, action: "resume" });
      case "pause-check":
      case "cancel-check":
        return perform("btrfs.scrub", { mount, action: "cancel" });
      case "replace":
      case "grow-devices":
        sameDrive(report, a, p.device, p.serial);
        return perform("btrfs.member", {
          mount,
          action: action === "replace" ? "replace" : "add",
          device: String(p.device),
          ...(p.serial ? { serial: String(p.serial) } : {}),
          ...(p.erase === true ? { erase: true } : {}),
          ...(action === "replace" ? { replaces: String(p.replaces) } : {}),
        });
      case "remove":
        return perform("btrfs.member", { mount, action: "remove", device: String(p.device) });
      case "rebalance":
        return perform("btrfs.balance", { mount, action: "start" });
      case "change-level":
        return perform("btrfs.balance", { mount, action: "start", convert: String(p.profile) });
      case "clear-errors":
        return perform("btrfs.clear", { mount });
      case "grow-size":
        return perform("btrfs.clear", { mount, action: "grow" });
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
        return perform("btrfs.create", {
          profile: String(p.level).replace(/^btrfs-/, ""),
          name: String(p.name),
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
