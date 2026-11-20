import path from "node:path";
import type {
  RaidAction,
  RaidActionId,
  RaidArray,
  RaidHealth,
  RaidMember,
  RaidSchedule,
} from "@dragon-control/core";
import type { OperationName } from "../../elevated/protocol";
import { SNAPRAID_CONFS } from "../../elevated/snapraid";
import type { SnapraidJobState } from "../../elevated/snapraid-job";
import { eta, gb } from "./actions";
import { Refuse, pickMember, type DriverEnv, type PlanWords, type RaidDriver } from "./driver";
import type { RaidIO } from "./io";
import { flatten } from "./read";
import { readWindows } from "./spaces";

/**
 * SnapRAID (Linux and Windows): parity over ordinary drives that each keep their own files, the
 * usual choice for media libraries (often with mergerfs or DrivePool pooling the drives). Hearth
 * reads snapraid.conf and SnapRAID's status report, and runs its jobs: a sync with a safety stop
 * (no sync after many deletions, which is what a missing drive looks like), a scrub, fixing the
 * errors a check found, and rebuilding a lost drive's files from parity. On Linux the jobs run
 * through the elevated executor (snapraid.run); on Windows as the owner's own account.
 */

export const SNAPRAID_OPERATIONS: readonly OperationName[] = ["snapraid.run"];

const LINUX_BINS = ["/usr/bin/snapraid", "/usr/local/bin/snapraid", "/usr/sbin/snapraid"];
const WINDOWS_DIRS = [
  "C:\\SnapRAID",
  "C:\\Program Files\\SnapRAID",
  "C:\\Tools\\SnapRAID",
  "C:\\snapraid",
  "C:\\ProgramData\\SnapRAID",
];

export interface SnapConf {
  file: string;
  parity: { level: number; name: string; paths: string[] }[];
  data: { name: string; path: string }[];
  content: string[];
}

export function parseConf(text: string, file: string): SnapConf {
  const conf: SnapConf = { file, parity: [], data: [], content: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m as unknown as [string, string, string];
    const lvl = /^(?:(\d)-)?parity$|^z-parity$/.exec(key!);
    if (lvl) {
      const level = key === "z-parity" ? 1 : Number(lvl[1] ?? 1);
      conf.parity.push({
        level,
        name: key === "parity" ? "parity" : key!,
        paths: rest!.split(",").map((p) => p.trim()),
      });
    } else if (key === "data" || key === "disk") {
      const d = /^(\S+)\s+(.+)$/.exec(rest!);
      if (d) conf.data.push({ name: d[1]!, path: d[2]!.trim() });
    } else if (key === "content") conf.content.push(rest!.trim());
  }
  conf.parity.sort((a, b) => a.level - b.level);
  return conf;
}

export interface SnapStatus {
  errors: number;
  syncing?: number;
  unsynced: boolean;
  notScrubbedPct?: number;
  oldestDays?: number;
  medianDays?: number;
  zeroSubSecond?: number;
  disks: Record<string, { files: number; usedGB?: number; freeGB?: number }>;
  /** SnapRAID's own warnings, word for word. */
  notes: string[];
}

export function parseStatus(out: string): SnapStatus {
  const disks: SnapStatus["disks"] = {};
  for (const m of out.matchAll(
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+|-)\s+(\d+|-)\s+(\d+%|-)\s+(\S+)\s*$/gm,
  ))
    disks[m[8]!] = {
      files: Number(m[1]),
      ...(m[5] !== "-" ? { usedGB: Number(m[5]) } : {}),
      ...(m[6] !== "-" ? { freeGB: Number(m[6]) } : {}),
    };
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const errors =
    num(/In the array there are (\d+) errors/i) ?? (/No error detected/i.test(out) ? 0 : 0);
  const syncing = num(/sync in progress at (\d+)%/i);
  const zero = num(/You have (\d+) files? with (?:a )?zero sub-second timestamp/i);
  return {
    errors,
    ...(syncing !== undefined ? { syncing } : {}),
    unsynced: /NOT fully synced|not synced|sync in progress/i.test(out),
    ...(num(/The (\d+)% of the array is not scrubbed/i) !== undefined
      ? { notScrubbedPct: num(/The (\d+)% of the array is not scrubbed/i)! }
      : {}),
    ...(num(/oldest block was scrubbed (\d+) days? ago/i) !== undefined
      ? { oldestDays: num(/oldest block was scrubbed (\d+) days? ago/i)! }
      : {}),
    ...(num(/the median (\d+)/i) !== undefined ? { medianDays: num(/the median (\d+)/i)! } : {}),
    ...(zero !== undefined ? { zeroSubSecond: zero } : {}),
    disks,
    notes: out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(WARNING|DANGER)!/.test(l)),
  };
}

/* ---------- finding it ---------- */

export interface SnapPlace {
  bin: string;
  conf: string;
}

export async function locate(io: RaidIO): Promise<SnapPlace | undefined> {
  if (io.platform === "win32") {
    const where = await io.run("where", ["snapraid"], { timeoutMs: 10_000 });
    const dirs = [
      ...(where.code === 0 ? [path.win32.dirname(where.out.trim().split(/\r?\n/)[0]!)] : []),
      ...WINDOWS_DIRS,
    ];
    for (const d of dirs) {
      const bin = path.win32.join(d, "snapraid.exe");
      const conf = path.win32.join(d, "snapraid.conf");
      if ((await io.exists(bin)) && (await io.exists(conf))) return { bin, conf };
    }
    return undefined;
  }
  let bin: string | undefined;
  for (const b of LINUX_BINS) if (await io.exists(b)) bin = bin ?? b;
  for (const c of SNAPRAID_CONFS) if (await io.read(c)) return bin ? { bin, conf: c } : undefined;
  return undefined;
}

/* ---------- as an array ---------- */

const HEALTH_TEXT: Record<RaidHealth, string> = {
  healthy:
    "Every drive is there and SnapRAID found no errors. Files are protected as of the last sync; anything added since is not, until the next one.",
  degraded:
    "A drive is missing, or SnapRAID found errors. The other drives' files are fine; the affected files can be rebuilt from parity.",
  rebuilding: "SnapRAID is rebuilding files from parity.",
  resyncing: "SnapRAID is syncing: bringing parity up to date with the files on the drives.",
  checking: "SnapRAID is scrubbing: reading files and parity to find silent damage.",
  reshaping: "",
  failed:
    "More drives are missing than there are parity drives: their files cannot all be rebuilt.",
  inactive: "",
  unknown: "Hearth could not read SnapRAID's status.",
};

interface DiskInfo {
  device: string;
  disk?: string;
  model?: string;
  serial?: string;
  sizeBytes?: number;
  transport?: string;
  rotational?: boolean;
}

/** Linux: the drive a folder lives on (its longest mount point). */
function linuxDrive(env: Pick<DriverEnv, "blocks">, folder: string): DiskInfo & { mount?: string } {
  const flat = flatten(env.blocks).filter((x) => x.b.mount && x.b.mount !== "[SWAP]");
  const norm = folder.endsWith("/") ? folder : `${folder}/`;
  const hit = flat
    .filter((x) => norm.startsWith(x.b.mount === "/" ? "/" : `${x.b.mount}/`))
    .sort((a, b) => b.b.mount!.length - a.b.mount!.length)[0];
  if (!hit) return { device: folder };
  return {
    device: `/dev/${hit.b.kname}`,
    disk: `/dev/${hit.disk.kname}`,
    ...(hit.disk.model ? { model: hit.disk.model } : {}),
    ...(hit.disk.serial ? { serial: hit.disk.serial } : {}),
    sizeBytes: hit.b.sizeBytes,
    ...(hit.disk.transport ? { transport: hit.disk.transport } : {}),
    ...(hit.disk.rotational !== undefined ? { rotational: hit.disk.rotational } : {}),
    mount: hit.b.mount!,
  };
}

interface WinDisk {
  number?: string;
  name?: string;
  serial?: string;
  size?: number;
  bus?: string;
  media?: string;
  parts?: { letter?: string | null }[];
}

async function windowsDrives(io: RaidIO): Promise<WinDisk[]> {
  const v = (await readWindows(io))?.disks as WinDisk | WinDisk[] | undefined;
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function windowsDrive(disks: WinDisk[], folder: string): DiskInfo {
  const letter = /^([A-Za-z]):/.exec(folder)?.[1]?.toUpperCase();
  const d = disks.find((x) => (x.parts ?? []).some((p) => p.letter?.toUpperCase() === letter));
  if (!d) return { device: letter ? `${letter}:` : folder };
  return {
    device: `${letter}:`,
    disk: `\\\\.\\PHYSICALDRIVE${d.number}`,
    ...(d.name ? { model: d.name } : {}),
    ...(d.serial ? { serial: d.serial } : {}),
    ...(d.size ? { sizeBytes: d.size } : {}),
    ...(d.bus ? { transport: d.bus.toLowerCase() } : {}),
    ...(d.media ? { rotational: d.media === "HDD" } : {}),
  };
}

export interface SnapReadContext {
  conf: SnapConf;
  status?: SnapStatus;
  /** Why the status could not be read. */
  statusWhy?: string;
  job?: SnapraidJobState;
  members: RaidMember[];
  /** Data drives whose folder is missing, or on the system drive (their drive is not mounted). */
  missing: string[];
  version?: string;
  now?: number;
}

export function snapToArray(x: SnapReadContext): RaidArray {
  const { conf, status, job } = x;
  const parityCount = conf.parity.length;
  const lost = x.missing.length;
  const parityNames = new Set(conf.parity.map((p) => p.name));
  const canLose = Math.max(0, parityCount - lost);
  const running = job?.running ? job : undefined;
  let health: RaidHealth;
  if (lost > parityCount) health = "failed";
  else if (
    running &&
    (running.step === "sync" || running.step === "diff" || running.step === "touch")
  )
    health = "resyncing";
  else if (running?.step === "scrub") health = "checking";
  else if (running?.step === "fix") health = "rebuilding";
  else if (lost || (status?.errors ?? 0) > 0) health = "degraded";
  else if (status) health = "healthy";
  else health = "unknown";
  const warnings: string[] = [];
  for (const name of x.missing.filter((n) => parityNames.has(n)))
    warnings.push(
      `The parity drive (${name}) is missing or not mounted: until it is back, nothing is protected by it. If it is gone, a new one is filled by the next sync.`,
    );
  for (const name of x.missing.filter((n) => !parityNames.has(n)))
    warnings.push(
      `${name}'s folder is missing or on the system drive: its drive is probably not mounted. Do not sync until it is back; its files can be rebuilt from parity if the drive is gone.`,
    );
  if (status?.errors)
    warnings.push(
      `SnapRAID found ${status.errors} error${status.errors === 1 ? "" : "s"}. Fix them from parity (Fix the errors found).`,
    );
  if (status?.unsynced && !running)
    warnings.push("Files changed since the last sync are not protected yet: sync to protect them.");
  if (status?.oldestDays !== undefined && status.oldestDays > 45)
    warnings.push(
      `Some blocks have not been scrubbed for ${status.oldestDays} days. A regular small scrub checks all of it about monthly.`,
    );
  const biggest = Math.max(
    0,
    ...x.members.filter((m) => m.role === "data").map((m) => m.sizeBytes ?? 0),
  );
  for (const p of x.members.filter((m) => m.role === "parity"))
    if (p.sizeBytes && biggest && p.sizeBytes < biggest)
      warnings.push(
        `The parity drive ${p.device} (${gb(p.sizeBytes)}) is smaller than the largest data drive (${gb(biggest)}): a sync fails once that drive fills past it.`,
      );
  if (job && !job.running && job.ok === false && job.finishedAt)
    warnings.push(
      `The last SnapRAID job (${job.action}, ${job.finishedAt.slice(0, 16).replace("T", " ")}) did not finish: ${job.result ?? ""}`,
    );
  if (x.statusWhy) warnings.push(x.statusWhy);
  const data = x.members.filter((m) => m.role === "data");
  const used = data.reduce((n, m) => n + (m.usedBytes ?? 0), 0);
  const size = data.reduce((n, m) => n + (m.sizeBytes ?? 0), 0);
  const lastJob =
    job && !job.running && job.finishedAt
      ? `Last ${job.action} ${job.finishedAt.slice(0, 16).replace("T", " ")}: ${job.result ?? (job.ok ? "done" : "did not finish")}`
      : undefined;
  const scrubText =
    status?.oldestDays !== undefined
      ? `The oldest block was scrubbed ${status.oldestDays} days ago${status.medianDays !== undefined ? ` (median ${status.medianDays})` : ""}${status.notScrubbedPct ? `; ${status.notScrubbedPct}% of the array is not scrubbed yet` : ""}.`
      : undefined;
  return {
    id: `snapraid:${conf.file}`,
    tech: "snapraid",
    name: "SnapRAID",
    device: conf.file,
    level: `snapraid-${parityCount}`,
    levelText: `${parityCount} parity drive${parityCount === 1 ? "" : "s"}, ${conf.data.length} data drive${conf.data.length === 1 ? "" : "s"}`,
    health,
    healthText: HEALTH_TEXT[health] || HEALTH_TEXT.unknown,
    ...(size ? { sizeBytes: size } : {}),
    rawBytes: x.members.reduce((n, m) => n + (m.sizeBytes ?? 0), 0),
    ...(used ? { usedBytes: used } : {}),
    raidDevices: x.members.length,
    counts: {
      active: x.members.filter((m) => m.role === "data" || m.role === "parity").length,
      failed: 0,
      missing: lost,
      spare: 0,
    },
    canLose,
    members: x.members,
    ...(running
      ? {
          sync: {
            action:
              running.step === "scrub" ? "scrub" : running.step === "fix" ? "recover" : "sync",
            ...(running.progressPct !== undefined ? { progressPct: running.progressPct } : {}),
            ...(running.etaMinutes !== undefined ? { etaMinutes: running.etaMinutes } : {}),
            ...(running.speedMBs !== undefined ? { speedKiBs: running.speedMBs * 1024 } : {}),
          },
        }
      : {}),
    ...(lastJob || scrubText
      ? { lastCheck: { text: [lastJob, scrubText].filter(Boolean).join(" ") } }
      : {}),
    ...(status?.errors
      ? { dataErrors: { count: status.errors, text: `SnapRAID found ${status.errors} errors.` } }
      : {}),
    ...(status?.notes.length ? { notes: status.notes } : {}),
    ...(x.version ? { toolVersion: x.version } : {}),
    warnings,
    actions: [],
  };
}

/* ---------- what can be done ---------- */

const LABELS: Partial<Record<RaidActionId, string>> = {
  sync: "Sync parity now",
  check: "Scrub part of the array",
  repair: "Fix the errors found",
  fix: "Rebuild a lost drive's files from parity",
  "cancel-check": "Stop the running job",
  "schedule-check": "Schedule nightly sync and scrub",
  diff: "What changed since the last sync",
  replace: "Replace a drive",
  "grow-devices": "Add a data drive",
  "add-spare": "Add a hot spare",
  speed: "Speed",
  "change-level": "More parity",
  identify: "Identify the physical drives",
};

export function snapActions(a: RaidArray, ready: { ready: boolean; why?: string }): RaidAction[] {
  const out: RaidAction[] = [];
  const add = (
    id: RaidActionId,
    status: RaidAction["status"],
    reason?: string,
    extra: Partial<RaidAction> = {},
  ) => out.push({ id, label: LABELS[id] ?? id, status, ...(reason ? { reason } : {}), ...extra });
  const busy = a.sync?.action;
  const missing = a.counts.missing > 0;
  if (busy)
    add(
      "sync",
      busy === "sync" ? "running" : "blocked",
      busy === "sync" ? progress(a) : "Another SnapRAID job is running.",
    );
  else if (missing)
    add(
      "sync",
      "blocked",
      "A data drive is missing: syncing now would throw away the parity needed to rebuild it. Bring the drive back, or rebuild it first.",
    );
  else
    add("sync", "available", undefined, {
      risk: "Reads the changed files and updates parity: hours after big changes, minutes otherwise. Stops by itself if more than 50 files were deleted since the last sync.",
    });
  if (busy)
    add(
      "check",
      busy === "scrub" ? "running" : "blocked",
      busy === "scrub" ? progress(a) : "Another SnapRAID job is running.",
    );
  else
    add(
      "check",
      "available",
      "Checks 8% of the array (blocks not checked for 10 days), oldest first.",
      { risk: "Reads files and parity; changes nothing." },
    );
  if (busy)
    add(
      "cancel-check",
      "available",
      "SnapRAID saves what it has done; the next run carries on from there.",
    );
  if ((a.dataErrors?.count ?? 0) > 0 && !busy)
    add("repair", "available", undefined, {
      risk: "Rewrites only the blocks a check found bad, from parity.",
    });
  else
    add("repair", "blocked", busy ? "Another SnapRAID job is running." : "No errors were found.");
  if (busy) add("fix", "blocked", "Another SnapRAID job is running.");
  else
    add(
      "fix",
      "available",
      "Mount an empty drive where the lost one was first; its files are rebuilt there.",
      {
        risk: "Writes the lost drive's files back from parity. Files changed after the last sync come back as they were then, or not at all.",
      },
    );
  add("diff", "available", "Read only: lists added, deleted, changed, and moved files.");
  add("schedule-check", "available", "The usual setup: a sync every night, then a small scrub.");
  add(
    "replace",
    "unsupported",
    "In SnapRAID a drive is replaced by copying its files to the new drive (or rebuilding them from parity), pointing snapraid.conf at it, and syncing. Ember can walk you through it.",
  );
  add(
    "grow-devices",
    "unsupported",
    "Add a data drive by adding a data line to snapraid.conf and syncing. Ember can do it with you.",
  );
  add(
    "add-spare",
    "unsupported",
    "SnapRAID has no hot spares: a lost drive is rebuilt onto a new one by Rebuild from parity.",
  );
  add("speed", "unsupported", "SnapRAID runs as fast as the drives allow.");
  add(
    "change-level",
    "unsupported",
    "More parity means another parity drive at least as large as the largest data drive, a 2-parity line in snapraid.conf, and a sync. Ember can plan it with you.",
  );
  add(
    "identify",
    "available",
    "Each drive's model and serial number are shown; match the serial on the drive's label.",
  );
  if (!ready.ready)
    for (const x of out)
      if (x.status === "available" && !["identify", "schedule-check", "diff"].includes(x.id)) {
        x.status = "blocked";
        x.reason = `${ready.why ?? "Approved SnapRAID jobs are not set up on this machine."}${x.reason ? ` (${x.reason})` : ""}`;
      }
  return out;
}

const progress = (a: RaidArray) =>
  [
    a.sync?.progressPct !== undefined ? `${a.sync.progressPct}%` : "running",
    a.sync?.etaMinutes !== undefined ? `about ${eta(a.sync.etaMinutes)} left` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

/* ---------- the driver ---------- */

export interface SnapEnv extends DriverEnv {
  /** Where the running job reports its state (beside the executor's log, or Hearth's data). */
  jobFile?: string;
  /** Root-only reads through the executor (Linux), when it is set up. */
  readElevated?: (
    params: Record<string, string>,
  ) => Promise<{ code: number; out: string } | undefined>;
}

export const snapraidDriver: RaidDriver = {
  tech: "snapraid",
  platforms: ["linux", "win32"],
  operations: SNAPRAID_OPERATIONS,
  async present({ io }) {
    return Boolean(await locate(io));
  },
  async readyWithout({ io, sample }) {
    // On Windows SnapRAID runs as the owner's account: nothing to set up beyond SnapRAID itself.
    if (io.platform === "win32" || sample) return { ready: Boolean(await locate(io)) || sample };
    return { ready: false };
  },
  async support(env) {
    const place = await locate(env.io);
    return {
      tech: "snapraid",
      seen: place
        ? `snapraid.conf at ${place.conf}`
        : "SnapRAID is not installed (or has no snapraid.conf)",
      support: place ? "manage" : "none",
      verified: env.sample ? "fixtures" : "loopback",
      tools: [{ name: "snapraid", present: Boolean(place) }],
    };
  },
  async arrays(env) {
    const e = env as SnapEnv;
    const place = await locate(env.io);
    if (!place) return [];
    const text = await env.io.read(place.conf);
    if (!text) return [];
    const conf = parseConf(text, place.conf);
    const win = env.io.platform === "win32";
    const winDisks = win ? await windowsDrives(env.io) : [];
    const members: RaidMember[] = [];
    const missing: string[] = [];
    const describe = async (name: string, folder: string, role: "data" | "parity") => {
      const where = win ? windowsDrive(winDisks, folder) : linuxDrive(env, folder);
      const mount = "mount" in where ? (where as { mount?: string }).mount : undefined;
      const here = win ? await env.io.exists(folder) : Boolean(mount && mount !== "/");
      const fs = await env.io.statfs(win ? folder.slice(0, 3) : (mount ?? folder));
      if (!here) missing.push(name);
      members.push({
        ...where,
        name,
        group: role === "data" ? "Data" : "Parity",
        role: here ? role : "missing",
        states: [here ? role : "missing"],
        path: folder,
        stateText: `${name}: ${folder}`,
        ...(fs ? { usedBytes: fs.total - fs.free, freeBytes: fs.free } : {}),
        ...(fs && !where.sizeBytes ? { sizeBytes: fs.total } : {}),
      });
    };
    for (const d of conf.data) await describe(d.name, d.path, "data");
    for (const p of conf.parity)
      await describe(
        p.name,
        win ? path.win32.dirname(p.paths[0]!) : path.posix.dirname(p.paths[0]!),
        "parity",
      );
    let job: SnapraidJobState | undefined;
    if (e.jobFile) {
      const raw = await env.io.read(e.jobFile);
      try {
        job = raw ? (JSON.parse(raw) as SnapraidJobState) : undefined;
      } catch {
        job = undefined;
      }
    }
    let status: SnapStatus | undefined;
    let statusWhy: string | undefined;
    if (!job?.running) {
      const r = await env.io.run(place.bin, ["-c", place.conf, "status"], { timeoutMs: 300_000 });
      if (r.code === 0) status = parseStatus(r.out);
      else {
        const viaRoot = e.readElevated
          ? await e.readElevated({ kind: "snapraid-status", conf: place.conf })
          : undefined;
        if (viaRoot?.code === 0) status = parseStatus(viaRoot.out);
        else
          statusWhy = `Hearth could not read SnapRAID's status${win ? "" : " as its own account (its content files may be root's; with the admin helper set up it reads them through that)"}: ${r.out.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`;
      }
    }
    const version = /snapraid v?(\d+\.\d+)/i.exec(
      (await env.io.run(place.bin, ["--version"], { timeoutMs: 10_000 })).out,
    )?.[1];
    return [
      snapToArray({
        conf,
        ...(status ? { status } : {}),
        ...(statusWhy ? { statusWhy } : {}),
        ...(job ? { job } : {}),
        members,
        missing,
        ...(version ? { version } : {}),
      }),
    ];
  },
  actions(a, env) {
    return snapActions(a, env.ready);
  },
  async schedules(env) {
    const out: RaidSchedule[] = [];
    if (env.io.platform === "win32") return out;
    for (const f of [
      "/etc/cron.d/snapraid",
      "/etc/cron.d/snapraid-runner",
      "/etc/cron.d/snapraid-aio",
    ]) {
      const t = await env.io.read(f);
      if (t && t.split("\n").some((l) => /snapraid/.test(l) && !/^\s*#/.test(l)))
        out.push({
          by: "system",
          text: `A cron job already runs SnapRAID (${f}). Hearth's schedule would run beside it: use one or the other.`,
        });
    }
    return out;
  },
  async plan({ action, array: a, params: p, host }): Promise<PlanWords> {
    const where = `the SnapRAID array (${a!.levelText}) on ${host}`;
    const act = a!.actions.find((x) => x.id === action);
    switch (action) {
      case "sync":
        return {
          label: `Sync SnapRAID parity on ${host}`,
          reason: `${act?.risk ?? ""} It first lists what changed; if more than ${typeof p.deleteThreshold === "number" ? p.deleteThreshold : 50} files were deleted it stops and says so.`,
        };
      case "check":
        return { label: `Scrub part of ${where}`, reason: act?.risk ?? "" };
      case "repair":
        return { label: `Fix the errors SnapRAID found in ${where}`, reason: act?.risk ?? "" };
      case "cancel-check":
        return {
          label: `Stop the running SnapRAID job on ${host}`,
          reason: "SnapRAID saves what it has done; the next run carries on.",
        };
      case "fix": {
        const m =
          a!.members.find((x) => x.name === p.disk && x.role === "data") ?? pickMember(a!, p.disk);
        return {
          label: `Rebuild ${m.name}'s files (${m.path}) from parity on ${host}`,
          reason: `${act?.risk ?? ""} Make sure an empty drive is mounted at ${m.path} first: files are written there.`,
          params: { disk: m.name ?? String(p.disk) },
        };
      }
      default:
        throw new Refuse(`"${action}" is shown in the tab only; there is nothing to run.`);
    }
  },
  async run({ action, array: a, params: p }, perform) {
    const conf = a!.device!;
    const base = {
      conf,
      by: p.scheduled === true ? "the nightly schedule" : "a plan you approved",
    };
    switch (action) {
      case "sync":
        return perform("snapraid.run", {
          ...base,
          action: "sync",
          deleteThreshold: typeof p.deleteThreshold === "number" ? p.deleteThreshold : 50,
          scrubPercent: p.scheduled === true ? 3 : 0,
          olderThanDays: 10,
        });
      case "check":
        return perform("snapraid.run", {
          ...base,
          action: "scrub",
          scrubPercent: 8,
          olderThanDays: 10,
        });
      case "repair":
        return perform("snapraid.run", { ...base, action: "fix-errors" });
      case "fix":
        return perform("snapraid.run", { ...base, action: "fix", disk: String(p.disk) });
      case "cancel-check":
        return perform("snapraid.run", { conf, action: "cancel" });
      default:
        throw new Refuse("Nothing to run.");
    }
  },
};
