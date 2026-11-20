import fs from "node:fs/promises";
import path from "node:path";
import type { Params } from "./protocol";
import { RaidRefused, type RaidDeps, type RaidResult } from "./raid";
import type { SnapraidJobSpec } from "./snapraid-job";

/**
 * snapraid.run on Linux: starts one SnapRAID job (sync with its safety stop, scrub, fix) as root
 * in its own systemd unit, hearth-snapraid, because a sync can take hours and the executor answers
 * one request at a time. The unit runs this same program in job mode (main.ts --snapraid-job),
 * which reads the job written here and reports progress where Hearth can read it. Only
 * snapraid.conf in its usual places, only these actions, one job at a time.
 */

export const SNAPRAID_CONFS = [
  "/etc/snapraid.conf",
  "/etc/snapraid/snapraid.conf",
  "/usr/local/etc/snapraid.conf",
];
const BINS = ["/usr/bin/snapraid", "/usr/local/bin/snapraid", "/usr/sbin/snapraid"];
export const SNAPRAID_UNIT = "hearth-snapraid";
export const JOB_SPEC = "snapraid-job.json";
/** Beside the executor's log, readable by Hearth: the job's state and SnapRAID's output. */
export const JOB_STATE = "snapraid-job.json";
export const JOB_LOG = "snapraid-job.log";

export interface JobPlaces {
  stateDir: string;
  logDir: string;
  /** This program and its scope file, to start the job unit with. */
  program: string;
  config: string;
  node: string;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

export async function snapraidBin() {
  for (const b of BINS) if (await exists(b)) return b;
  return undefined;
}

/** The data drives' names in snapraid.conf ("data d1 /mnt/disk1", or the older "disk d1 ..."). */
export function dataNames(conf: string) {
  return [...conf.matchAll(/^\s*(?:data|disk)\s+(\S+)\s+\S/gm)].map((m) => m[1]!);
}

export async function snapraidRun(
  params: Params,
  deps: RaidDeps & { jobs?: JobPlaces },
): Promise<RaidResult> {
  if (process.platform === "win32")
    throw new RaidRefused(
      "On Windows, SnapRAID runs as Hearth's own account, not through the executor.",
    );
  const jobs = deps.jobs;
  if (!jobs) throw new RaidRefused("The executor cannot start background jobs here.");
  const conf = params.conf;
  if (typeof conf !== "string" || !SNAPRAID_CONFS.includes(conf) || !(await exists(conf)))
    throw new RaidRefused(`SnapRAID's configuration must be one of ${SNAPRAID_CONFS.join(", ")}.`);
  const action = params.action;
  const active = async () =>
    (await deps.run("systemctl", ["is-active", "--quiet", SNAPRAID_UNIT], { timeoutMs: 15_000 }))
      .code === 0;
  if (action === "cancel") {
    if (!(await active())) throw new RaidRefused("No SnapRAID job is running.", "stale");
    // SnapRAID saves its progress when stopped; the next sync carries on from it.
    await deps.run("systemctl", ["kill", "--signal=SIGINT", SNAPRAID_UNIT], { timeoutMs: 15_000 });
    for (let i = 0; i < 60 && (await active()); i++) await deps.wait(1000);
    if (await active())
      await deps.run("systemctl", ["stop", SNAPRAID_UNIT], { timeoutMs: 120_000 });
    return {
      target: conf,
      result: "The SnapRAID job was stopped; SnapRAID saved what it had done.",
    };
  }
  if (!["sync", "scrub", "fix", "fix-errors"].includes(String(action)))
    throw new RaidRefused("The SnapRAID action is not valid.");
  const bin = await snapraidBin();
  if (!bin)
    throw new RaidRefused("SnapRAID is not installed (looked in /usr/bin, /usr/local/bin).");
  if (await active()) throw new RaidRefused("A SnapRAID job is already running.", "stale");
  const int = (v: unknown, lo: number, hi: number, name: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
      throw new RaidRefused(`${name} must be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  const spec: SnapraidJobSpec = {
    bin,
    conf,
    action: action as SnapraidJobSpec["action"],
    by: typeof params.by === "string" ? params.by.slice(0, 80) : "a plan",
  };
  const threshold = int(params.deleteThreshold, 0, 1_000_000, "The deletion limit");
  const pct = int(params.scrubPercent, 0, 100, "The scrub share");
  const older = int(params.olderThanDays, 0, 3650, "The scrub age");
  if (threshold !== undefined) spec.deleteThreshold = threshold;
  if (pct !== undefined) spec.scrubPercent = pct;
  if (older !== undefined) spec.olderThanDays = older;
  if (action === "fix") {
    const names = dataNames(await fs.readFile(conf, "utf8"));
    if (typeof params.disk !== "string" || !names.includes(params.disk))
      throw new RaidRefused(`Name one of the data drives in ${conf} (${names.join(", ")}).`);
    spec.disk = params.disk;
  }
  await fs.mkdir(jobs.stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(jobs.stateDir, JOB_SPEC), JSON.stringify(spec), { mode: 0o600 });
  await deps.run("systemctl", ["reset-failed", SNAPRAID_UNIT], { timeoutMs: 15_000 });
  const r = await deps.run(
    "systemd-run",
    [
      `--unit=${SNAPRAID_UNIT}`,
      "--collect",
      "--quiet",
      `--description=Hearth: SnapRAID ${spec.action}`,
      jobs.node,
      jobs.program,
      "--config",
      jobs.config,
      "--snapraid-job",
    ],
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0)
    throw new RaidRefused(`The job could not be started: ${r.out.trim().slice(-300)}`);
  return {
    target: conf,
    result: `SnapRAID ${spec.action === "fix-errors" ? "fix" : spec.action}${spec.disk ? ` of ${spec.disk}` : ""} started in the background (unit ${SNAPRAID_UNIT}); the RAID tab shows its progress.`,
  };
}
