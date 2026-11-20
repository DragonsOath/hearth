import { createHash } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import {
  ACTIONS,
  RAID_MIN_DEVICES,
  type RaidCreateOption,
  type RaidTech,
  type RaidTechSupport,
  THIS_HOST,
  raidTolerance,
  raidUsableBytes,
  type JobStepInput,
  type RaidArray,
  type RaidCandidate,
  type RaidReport,
  type RaidSchedule,
} from "@dragon-control/core";
import type { DbHandle } from "../../db/client";
import type { NewJob } from "../../jobs/engine";
import type { PlannedStep, StepOutcome, StepRun } from "../../jobs/operations";
import { getSetting, setSetting, type SettingValues } from "../../store/settings";
import type { Elevation } from "../../admin/elevation";
import {
  MDADM_OPERATIONS,
  RAID_OPERATIONS,
  WINDOWS_RAID_OPERATIONS,
  type ElevatedResponse,
  type OperationName,
  type Params,
} from "../../elevated/protocol";
import { Refuse, type DriverEnv, type RaidDriver } from "./driver";
import { DRIVERS } from "./drivers";
import { LocalSnapraid } from "./snapraid-local";
import { locate, type SnapEnv } from "./snapraid";
import { forgetWindows } from "./spaces";
import { parseDiff, type SnapraidDiff } from "../../elevated/snapraid-job";
import { eta, gb, mdActions } from "./actions";
import { machineIO, type RaidIO } from "./io";
import {
  mdTechSupport,
  parseBlocks,
  readCandidates,
  readMdArrays,
  readSystemSchedules,
} from "./read";
import { SampleRaid } from "./sample";

/**
 * Storage > RAID / Arrays: what the machine's arrays are, and approved changes to them. Reading
 * needs no privilege. Every change is a storage-raid plan step: planned from the machine's state
 * now, approved by the owner, carried out by the elevated executor (which checks the drives
 * itself), and read back afterwards. Scheduled consistency checks run as their own recorded
 * plans under the schedule the owner approved.
 */

type RaidState = SettingValues["raid_state"];
const EMPTY: RaidState = { schedules: {}, paused: {} };

export interface RaidOptions {
  io?: RaidIO;
  /** A simulated machine (demo and tests): reads and changes go to it, not the executor. */
  sample?: SampleRaid;
  allowLoop?: boolean;
  /** This machine's name in plans ("Homeserver"). */
  hostName?: () => string;
  platform?: NodeJS.Platform;
  /** The technologies besides mdadm (ZFS, SnapRAID, Storage Spaces...); tests narrow them. */
  drivers?: RaidDriver[];
  /** Hearth's data folder: where SnapRAID jobs run as Hearth (Windows) report their state. */
  dataDir?: string;
}

export class RaidService {
  private elevation?: Elevation;
  private createJob?: (job: NewJob) => Promise<unknown>;
  private cache?: { at: number; report: RaidReport };
  private io: RaidIO;

  constructor(
    private readonly handle: DbHandle,
    private readonly opts: RaidOptions = {},
  ) {
    this.io = opts.sample?.io() ?? opts.io ?? machineIO;
  }

  static fromEnv(
    handle: DbHandle,
    env: NodeJS.ProcessEnv,
    hostName?: () => string,
    dataDir?: string,
  ) {
    const sample =
      env.DC_FAKE_RAID === "1" || env.DC_FAKE_RAID === "windows"
        ? new SampleRaid({ windows: env.DC_FAKE_RAID === "windows" })
        : undefined;
    return new RaidService(handle, {
      ...(sample ? { sample } : {}),
      allowLoop: env.DC_RAID_ALLOW_LOOP === "1",
      ...(hostName ? { hostName } : {}),
      ...(dataDir ? { dataDir } : {}),
    });
  }

  useElevation(elevation: Elevation) {
    this.elevation = elevation;
  }

  /** Whether this is a simulated machine (demo and browser tests). */
  get simulated() {
    return Boolean(this.opts.sample);
  }

  /** Browser tests only: the simulated machine as it started (the Windows one when asked). */
  async resetSample(opts: { windows?: boolean } = {}) {
    if (!this.opts.sample) return;
    this.opts.sample = new SampleRaid({ windows: opts.windows ?? this.opts.sample.windows });
    this.io = this.opts.sample.io();
    this.cache = undefined;
    await this.saveState(EMPTY);
  }

  /** How scheduled checks become plans (the jobs engine). */
  useJobs(create: (job: NewJob) => Promise<unknown>) {
    this.createJob = create;
  }

  /**
   * Starts the scheduled checks that are due, each as its own plan that runs under the schedule
   * the owner approved. A run that is not possible now (array busy or not whole) is skipped and
   * reported, never forced.
   */
  async tick(now = new Date()): Promise<string[]> {
    if (!this.createJob) return [];
    const said: string[] = [];
    for (const d of await this.due(now)) {
      if (d.skip) {
        said.push(`Skipped the scheduled ${d.noun} of ${d.name}: ${d.skip}`);
        continue;
      }
      await this.createJob({
        title: `Scheduled ${d.noun}: ${d.name}`,
        reason: "Under the schedule you approved in Storage > RAID / Arrays.",
        requestedBy: "dragon-control",
        steps: [
          {
            kind: "storage-raid",
            serviceId: THIS_HOST,
            params: { action: d.action, arrayId: d.arrayId, scheduled: true },
          },
        ],
      });
      said.push(`Started the scheduled ${d.noun} of ${d.name}.`);
    }
    return said;
  }

  private host() {
    return this.opts.hostName?.() ?? hostname();
  }

  private async state(): Promise<RaidState> {
    return (await getSetting(this.handle.db, "raid_state")) ?? EMPTY;
  }

  private async saveState(s: RaidState) {
    await setSetting(this.handle.db, "raid_state", s);
  }

  private platform(): NodeJS.Platform {
    return this.opts.platform ?? this.io.platform;
  }

  /** The other technologies this machine's platform can have. */
  private drivers(): RaidDriver[] {
    const p = this.platform();
    return (this.opts.drivers ?? DRIVERS).filter((d) => d.platforms.includes(p));
  }

  driver(tech: string): RaidDriver | undefined {
    return this.drivers().find((d) => d.tech === tech);
  }

  /**
   * Whether approved changes can run here, for each technology, and if not, exactly what is
   * missing: the executor, or its operations for that technology.
   */
  private async changes(
    techs: RaidTech[],
    env: Pick<DriverEnv, "io" | "sample">,
  ): Promise<RaidReport["changes"]> {
    const win = this.platform() === "win32";
    const byTech: NonNullable<RaidReport["changes"]["byTech"]> = {};
    if (this.opts.sample) {
      for (const t of techs) byTech[t] = { ready: true };
      return {
        ready: true,
        operations: [...(win ? WINDOWS_RAID_OPERATIONS : RAID_OPERATIONS)],
        byTech,
      };
    }
    const setup = win ? WINDOWS_SETUP : LINUX_SETUP;
    let ops: string[] = [];
    let why: string | undefined;
    if (!this.elevation)
      why = `Hearth's admin helper (the elevated executor) is not set up here, so changes cannot run yet. ${setup}`;
    else {
      const s = await this.elevation.state();
      if (!s.available)
        why = `Hearth's admin helper (the elevated executor) is not set up on this machine, so changes cannot run yet. ${setup}`;
      else ops = s.status?.operations ?? [];
    }
    for (const t of techs) {
      const d = this.driver(t);
      const own = d?.readyWithout ? await d.readyWithout(env) : undefined;
      if (own?.ready) {
        byTech[t] = own;
        continue;
      }
      const need: readonly string[] = t === "mdadm" ? MDADM_OPERATIONS : (d?.operations ?? []);
      if (!need.length)
        byTech[t] = {
          ready: false,
          why: own?.why ?? "Hearth only reads this technology; it is managed in its own app.",
        };
      else if (why !== undefined) byTech[t] = { ready: false, why: own?.why ?? why };
      else if (need.every((o) => ops.includes(o))) byTech[t] = { ready: true };
      else
        byTech[t] = {
          ready: false,
          why: `The admin helper is set up, but its storage operations are off. Switch them on: ${win ? WINDOWS_SWITCH : LINUX_SWITCH}`,
        };
    }
    const notReady = techs.map((t) => byTech[t]!).find((x) => !x.ready);
    return {
      ready: techs.length > 0 && !notReady,
      ...(notReady?.why
        ? { why: notReady.why }
        : techs.length
          ? {}
          : { why: "There is nothing here to change." }),
      operations: ops.filter((o) => /^(raid|zfs|btrfs|snapraid|spaces|storage)\./.test(o)),
      byTech,
    };
  }

  async report(force = false): Promise<RaidReport> {
    if (!force && this.cache && Date.now() - this.cache.at < 3_000) return this.cache.report;
    const host = this.host();
    const at = new Date().toISOString();
    const st = await this.state();
    const win = this.platform() === "win32";
    const sample = Boolean(this.opts.sample);
    const hearthSchedules: RaidSchedule[] = Object.entries(st.schedules).map(([key, s]) => ({
      arrayId: key,
      by: "hearth",
      ...(s.every !== "daily" ? { every: s.every } : {}),
      text: scheduleText(s),
      ...(s.lastRun ? { last: s.lastRun } : {}),
      next: nextRun(s.every, new Date()).toISOString(),
    }));
    const blocks = win ? [] : parseBlocks(await this.io.lsblk(), this.opts.allowLoop);
    const md = win ? [] : await readMdArrays(this.io, blocks, { allowLoop: this.opts.allowLoop });
    const drivers = this.drivers();
    const present: RaidDriver[] = [];
    for (const d of drivers)
      if (await d.present({ io: this.io, blocks }).catch(() => false)) present.push(d);
    const techs: RaidTech[] = [
      ...(win ? [] : (["mdadm"] as RaidTech[])),
      ...present.map((d) => d.tech),
    ];
    const changes = await this.changes(techs, { io: this.io, sample });
    const ready = (t: RaidTech) =>
      changes.byTech?.[t] ?? { ready: changes.ready, ...(changes.why ? { why: changes.why } : {}) };
    const jobFile = await this.snapraidJobFile();
    const env = (t: RaidTech, candidates: RaidCandidate[]): SnapEnv => ({
      io: this.io,
      blocks,
      candidates,
      ready: ready(t),
      sample,
      ...(jobFile ? { jobFile } : {}),
      readElevated: (params) => this.readElevated(params),
    });
    const found = new Map<RaidDriver, RaidArray[]>();
    for (const d of present) found.set(d, await d.arrays(env(d.tech, [])).catch(() => []));
    const all = [...md, ...[...found.values()].flat()];
    let candidates: RaidCandidate[] = [];
    if (win) {
      const from = present.find((d) => d.candidates) ?? drivers.find((d) => d.candidates);
      candidates = from?.candidates
        ? await from.candidates({ io: this.io, blocks, sample }).catch(() => [])
        : [];
    } else candidates = readCandidates(blocks, all);
    const scheduled = (a: RaidArray) => {
      const s = st.schedules[a.uuid ?? a.id];
      const sc = a.actions.find((x) => x.id === "schedule-check");
      if (s && sc && sc.status !== "unsupported") sc.reason = `Scheduled: ${scheduleText(s)}`;
    };
    const mdReady = ready("mdadm");
    for (const a of md) {
      a.actions = mdActions(a, {
        candidates,
        changesReady: mdReady.ready,
        ...(mdReady.why ? { changesWhy: mdReady.why } : {}),
      });
      scheduled(a);
    }
    for (const [d, arrays] of found)
      for (const a of arrays) {
        a.actions = d.actions(a, env(d.tech, candidates));
        scheduled(a);
      }
    const mdSupport = win
      ? []
      : (await mdTechSupport(this.io, blocks, md, sample ? "fixtures" : "loopback")).filter(
          (t) => !drivers.some((d) => d.tech === t.tech),
        );
    const support: RaidTechSupport[] = [
      ...mdSupport,
      ...(await Promise.all(
        drivers.map((d) =>
          d.support(env(d.tech, candidates)).catch((): RaidTechSupport => ({
            tech: d.tech,
            seen: "Could not be read.",
            support: "none",
            verified: "none",
          })),
        ),
      )),
      ...(win
        ? [
            {
              tech: "hardware" as const,
              seen: "Hardware RAID controllers are not read (each vendor needs its own tool).",
              support: "none" as const,
              verified: "none" as const,
            },
          ]
        : []),
    ];
    const create: RaidCreateOption[] = [];
    if (!win && mdSupport.find((t) => t.tech === "mdadm")?.tools?.some((x) => x.present))
      create.push(MDADM_CREATE);
    for (const d of present) {
      const c = d.create
        ? await d.create(env(d.tech, candidates)).catch(() => undefined)
        : undefined;
      if (c) create.push(c);
    }
    const systemSchedules = [
      ...(win ? [] : await readSystemSchedules(this.io)),
      ...(
        await Promise.all(
          present.map((d) =>
            d.schedules ? d.schedules(env(d.tech, candidates)).catch(() => []) : [],
          ),
        )
      ).flat(),
    ];
    const report: RaidReport = {
      host,
      at,
      arrays: all,
      candidates,
      tech: support,
      schedules: [...hearthSchedules, ...systemSchedules],
      changes,
      backups: backupWords(all),
      create,
      platform: win ? "windows" : "linux",
      ...(sample ? { sample: true } : {}),
    };
    this.cache = { at: Date.now(), report };
    return report;
  }

  /* ---------- plan steps ---------- */

  private async resolve(params: Record<string, unknown>) {
    const report = await this.report(true);
    const action = String(params.action ?? "");
    if (action === "create") return { report, action, array: undefined };
    const array = report.arrays.find(
      (a) => a.id === params.arrayId || a.device === params.arrayId || a.name === params.arrayId,
    );
    if (!array) throw new Refuse("That array is not on this machine (read the RAID tab again).");
    const act = array.actions.find((x) => x.id === action);
    if (!act) throw new Refuse(`"${action}" is not something Hearth does to an array.`);
    if (act.status === "unsupported") throw new Refuse(`Not supported: ${act.reason ?? ""}`);
    if (act.status === "blocked") throw new Refuse(`Not possible now: ${act.reason ?? ""}`);
    if (act.status === "running" && !["pause-check", "cancel-check"].includes(action))
      throw new Refuse(`Already running: ${act.reason ?? ""}`);
    return { report, action, array, act };
  }

  private candidate(report: RaidReport, device: unknown, minBytes?: number): RaidCandidate {
    const c = report.candidates.find((x) => x.device === device);
    if (!c) throw new Refuse(`${String(device)} is not a drive Hearth sees on this machine.`);
    if (c.state === "excluded")
      throw new Refuse(`${c.device} cannot be used: ${c.reason ?? "excluded"}`);
    if (minBytes && (c.sizeBytes ?? 0) < minBytes)
      throw new Refuse(
        `${c.device} is ${gb(c.sizeBytes ?? 0)}; each member needs at least ${gb(minBytes)}.`,
      );
    return c;
  }

  private member(array: RaidArray, device: unknown) {
    const m = array.members.find((x) => x.device === device);
    if (!m) throw new Refuse(`${String(device)} is not a member of ${array.name}.`);
    return m;
  }

  /** Builds the step: what runs, in words with the exact host, array and drives. */
  async plan(step: JobStepInput): Promise<PlannedStep> {
    const base: PlannedStep = {
      label: ACTIONS["storage-raid"].describe("this machine"),
      serviceName: "This machine",
      changes: true,
      policy: "refuse",
      policyReason: "",
    };
    try {
      if (step.serviceId !== THIS_HOST)
        throw new Refuse(`Arrays are changed on the machine: use serviceId "${THIS_HOST}".`);
      const p = step.params ?? {};
      const r = await this.resolve(p);
      const host = r.report.host;
      if (p.scheduled === true) {
        // Only the scheduled work (a check, or SnapRAID's sync), only under a schedule the owner
        // approved for this array.
        const sch = r.array
          ? (await this.state()).schedules[r.array.uuid ?? r.array.id]
          : undefined;
        if (!sch || r.action !== (sch.action ?? "check"))
          throw new Refuse(
            "Only the work the owner scheduled runs on a schedule, and only under that approval.",
          );
        const work = scheduleWork(r.array!.tech);
        return {
          ...base,
          label: `Scheduled ${work.noun} of ${r.array!.name} on ${host}`,
          params: { ...p, host },
          policy: "allow",
          policyReason: `Runs under the schedule you approved on ${sch.approvedAt.slice(0, 10)} (${scheduleText(sch)}). ${work.safe}`,
        };
      }
      const tech = (r.array?.tech ?? (typeof p.tech === "string" ? p.tech : "mdadm")) as RaidTech;
      const rd = r.report.changes.byTech?.[tech] ?? {
        ready: r.report.changes.ready,
        ...(r.report.changes.why ? { why: r.report.changes.why } : {}),
      };
      if (!rd.ready && r.action !== "schedule-check")
        throw new Refuse(rd.why ?? "Changes cannot run here yet.");
      if (tech !== "mdadm" && r.action !== "schedule-check") {
        const d = this.driver(tech);
        if (!d) throw new Refuse(`Hearth does not manage ${tech} on this machine.`);
        const w = await d.plan({
          action: r.action,
          ...(r.array ? { array: r.array } : {}),
          params: p,
          report: r.report,
          host,
        });
        const careful =
          ["create", "repair", "fix", "change-level"].includes(r.action) ||
          r.action.startsWith("grow");
        return {
          ...base,
          label: w.label.slice(0, 300),
          params: { ...p, ...(w.params ?? {}), host },
          policy: "approve-first",
          policyReason: `${w.reason}${careful ? ` ${r.report.backups.text}` : ""}`.trim(),
        };
      }
      const drive = (c: { device: string; model?: string; serial?: string; sizeBytes?: number }) =>
        `${c.model ?? "drive"}${c.serial ? ` (serial ${c.serial})` : ""} at ${c.device}${c.sizeBytes ? `, ${gb(c.sizeBytes)}` : ""}`;
      let label = "";
      let reason = "";
      const out: Record<string, string | number | boolean> = { ...p };
      const a = r.array;
      const where = a
        ? `${a.name} (${a.tech === "mdadm" ? `${a.device}, ${a.level}` : (a.levelText ?? a.level ?? a.tech)}) on ${host}`
        : host;
      const risk = r.act?.risk ? ` ${r.act.risk}` : "";
      const irreversible = r.act?.irreversible ? " This cannot be undone." : "";
      const eraseWords = (c: RaidCandidate) =>
        c.state === "has-data" ? ` ERASES ${c.device}: ${c.reason ?? "it holds data"}` : "";

      switch (r.action) {
        case "add-disk":
        case "add-spare":
        case "replace": {
          const c = this.candidate(r.report, p.device, a!.memberSizeBytes);
          if (c.state === "has-data" && p.erase !== true)
            throw new Refuse(
              `${c.device} holds data (${c.reason ?? ""}). Approve erasing it, or choose an empty drive.`,
            );
          out.serial = c.serial ?? "";
          if (r.action === "replace") {
            const old = this.member(a!, p.replaces);
            if (old.role === "faulty" || old.role === "missing")
              throw new Refuse(
                `${old.device} has failed: remove it, then add the new drive (Hearth plans both together from the replace guide).`,
              );
            label = `Replace ${drive({ device: old.device!, ...old })} with ${drive(c)} in ${where}`;
          } else
            label = `${r.action === "add-spare" ? "Add" : "Add and rebuild onto"} ${drive(c)} ${r.action === "add-spare" ? "as a hot spare in" : "in"} ${where}`;
          reason = `Writes a RAID superblock to ${c.device}.${eraseWords(c)}${risk}`;
          break;
        }
        case "re-add": {
          const c = this.candidate(r.report, p.device);
          out.serial = c.serial ?? "";
          label = `Re-add ${drive(c)} to ${where}`;
          reason = `Only works if it was this array's member; otherwise mdadm refuses and nothing changes.${risk}`;
          break;
        }
        case "mark-failed":
        case "remove": {
          const m = this.member(a!, p.device);
          if (r.action === "remove" && !["faulty", "spare"].includes(m.role))
            throw new Refuse(
              `${m.device} is ${m.role}; only failed members and spares are removed.`,
            );
          if (r.action === "mark-failed" && m.role === "faulty")
            throw new Refuse(`${m.device} is already marked failed.`);
          out.serial = m.serial ?? "";
          label = `${r.action === "remove" ? "Remove" : "Mark failed"} ${drive({ device: m.device!, ...m })} ${r.action === "remove" ? "from" : "in"} ${where}`;
          reason =
            r.action === "remove"
              ? "The member leaves the array. Its drive is not erased."
              : `The array stops using it at once and has ${a!.canLose ? a!.canLose - 1 : 0} drive${(a!.canLose ?? 1) - 1 === 1 ? "" : "s"} of protection left until it is replaced.`;
          break;
        }
        case "check":
        case "repair":
          label = `${r.action === "check" ? "Run a consistency check on" : "Repair the mismatches on"} ${where}`;
          reason = `${r.act?.risk ?? ""}`;
          break;
        case "pause-check":
        case "cancel-check":
        case "resume-check":
          label = `${r.action === "pause-check" ? "Pause" : r.action === "cancel-check" ? "Cancel" : "Resume"} the check on ${where}`;
          reason = "Only the check is affected; the data is not.";
          break;
        case "speed": {
          const v = (x: unknown) => (x === "system" ? "system" : Number(x));
          const min = v(p.minKiBs);
          const max = v(p.maxKiBs);
          for (const x of [min, max])
            if (typeof x === "number" && (!Number.isInteger(x) || x < 100 || x > 10_000_000))
              throw new Refuse("Speeds are between 100 and 10,000,000 KiB/s (or the system's).");
          label = `Set ${where}'s rebuild and check speed: at least ${min === "system" ? "the system's" : `${Math.round(Number(min) / 1024)} MB/s`}, at most ${max === "system" ? "the system's" : `${Math.round(Number(max) / 1024)} MB/s`}`;
          reason = "Takes effect at once; lasts until the next restart.";
          break;
        }
        case "grow-devices": {
          let words = "using the spare already in it";
          if (p.device) {
            const c = this.candidate(r.report, p.device, a!.memberSizeBytes);
            if (c.state === "has-data" && p.erase !== true)
              throw new Refuse(
                `${c.device} holds data (${c.reason ?? ""}). Approve erasing it, or choose an empty drive.`,
              );
            out.serial = c.serial ?? "";
            words = `with ${drive(c)}${eraseWords(c)}`;
          } else if (!a!.counts.spare) throw new Refuse("Choose the drive to add.");
          out.raidDevices = (a!.raidDevices ?? 0) + 1;
          const after = raidUsableBytes(
            a!.level ?? "",
            Array(Number(out.raidDevices)).fill(a!.memberSizeBytes ?? 0),
          );
          label = `Grow ${where} from ${a!.raidDevices} to ${out.raidDevices} members ${words}`;
          reason = `${after && a!.level !== "raid1" ? `Usable space becomes about ${gb(after)}. ` : ""}${r.act?.risk ?? ""}${irreversible}`;
          break;
        }
        case "grow-size":
          label = `Grow ${where} to use its drives' full size`;
          reason = r.act?.risk ?? "";
          break;
        case "grow-filesystem":
          label = `Grow the ${a!.fstype} filesystem on ${where}${a!.mount ? ` (mounted at ${a!.mount})` : ""} to the array's size`;
          reason = r.act?.risk ?? "";
          break;
        case "save-config": {
          const conf = await this.confFile();
          if (!this.opts.sample) {
            const cover = this.elevation
              ? await this.elevation.covers("file.write", conf.path)
              : { ok: false as const, why: "The elevated executor is not set up here." };
            if (!cover.ok)
              throw new Refuse(
                `${conf.path} belongs to root, and the elevated executor may not write there: ${cover.why} Allow it once with: sudo bash deploy/linux/install-elevation.sh --service hearth --add-root ${conf.dir}`,
              );
          }
          const line = arrayLine(a!, host);
          if (!line)
            throw new Refuse("The array's UUID is not known, so its line cannot be written.");
          label = `Add ${where} to ${conf.path}`;
          reason = `Adds this line (the file is backed up first): ${line}. ${r.act?.risk ?? ""}`;
          break;
        }
        case "schedule-check": {
          const every = p.every;
          const work = scheduleWork(a!.tech);
          if (every !== "off" && !work.every.includes(every as ScheduleEvery))
            throw new Refuse(`Choose ${work.every.join(", ")}, or off.`);
          label =
            every === "off"
              ? `Stop Hearth's scheduled ${work.noun} of ${where}`
              : `Let Hearth ${work.verb} ${where} ${whenWords(every as ScheduleEvery)}`;
          reason =
            every === "off"
              ? "Hearth stops starting it on its own."
              : `${work.safe} Each run is recorded as its own plan. Undo it here any time.`;
          if (!rd.ready && every !== "off")
            reason += ` Until changes are set up here, the scheduled runs will be skipped: ${rd.why ?? ""}`;
          break;
        }
        case "create": {
          const level = String(p.level ?? "");
          if (!RAID_MIN_DEVICES[level]) throw new Refuse("Choose RAID 0, 1, 5, 6, or 10.");
          const devices = String(p.devices ?? "")
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean);
          if (devices.length < RAID_MIN_DEVICES[level]!)
            throw new Refuse(
              `RAID ${level.slice(4)} needs at least ${RAID_MIN_DEVICES[level]} drives.`,
            );
          const erase = new Set(
            String(p.eraseDevices ?? "")
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean),
          );
          const cs = devices.map((d) => this.candidate(r.report, d));
          for (const c of cs)
            if (c.state === "has-data" && !erase.has(c.device))
              throw new Refuse(
                `${c.device} holds data (${c.reason ?? ""}). Approve erasing it, or leave it out.`,
              );
          const disks = new Set(cs.map((c) => c.disk ?? c.device));
          if (disks.size < cs.length && level !== "raid0")
            throw new Refuse(
              "Two of the chosen partitions are on the same drive: that protects nothing. Choose separate drives.",
            );
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(p.name ?? "")))
            throw new Refuse(
              "Name the array with letters, digits, dashes, or underscores (like media).",
            );
          out.serials = cs.map((c) => c.serial ?? "").join(",");
          const usable = raidUsableBytes(
            level,
            cs.map((c) => c.sizeBytes ?? 0),
          );
          const tol = raidTolerance(level, cs.length);
          label = `Create a RAID ${level.slice(4)} array "${String(p.name)}" on ${host} from ${cs.map(drive).join("; ")}${p.mkfs === "ext4" ? ", with an empty ext4 filesystem" : ""}`;
          reason = `ERASES EVERYTHING on ${cs.map((c) => c.device).join(", ")}${
            cs.some((c) => c.state === "has-data")
              ? ` (${cs
                  .filter((c) => c.state === "has-data")
                  .map((c) => `${c.device}: ${c.reason ?? "holds data"}`)
                  .join("; ")})`
              : ""
          }. About ${usable ? gb(usable) : "unknown"} usable; it survives ${tol ?? 0} drive failure${tol === 1 ? "" : "s"}. RAID is not a backup: deleted or damaged files are gone on every drive at once. It is not mounted; that is a separate step. This cannot be undone.`;
          break;
        }
        default:
          throw new Refuse(`"${r.action}" is shown in the tab only; there is nothing to run.`);
      }
      return {
        ...base,
        label: label.slice(0, 300),
        params: { ...out, host },
        policy: "approve-first",
        policyReason:
          `${reason}${r.action === "create" || r.action.startsWith("grow") || r.action === "repair" ? ` ${r.report.backups.text}` : ""}`.trim(),
      };
    } catch (error) {
      return { ...base, policyReason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * SnapRAID's differences since the last sync, read now (it scans the data drives, so it can take
   * a minute): the counts, and the first files of each kind.
   */
  async snapraidDiff(): Promise<{
    ok: boolean;
    text: string;
    diff?: SnapraidDiff;
    files?: string[];
  }> {
    const place = await locate(this.io);
    if (!place) return { ok: false, text: "SnapRAID is not set up on this machine." };
    let r = await this.io.run(place.bin, ["-c", place.conf, "diff"], { timeoutMs: 600_000 });
    if (r.code !== 0 && r.code !== 2) {
      const viaRoot = await this.readElevated({ kind: "snapraid-diff", conf: place.conf });
      if (viaRoot && (viaRoot.code === 0 || viaRoot.code === 2)) r = viaRoot;
      else
        return {
          ok: false,
          text: `SnapRAID could not compare the drives: ${r.out.trim().split(/\r?\n/).slice(-1)[0] ?? ""}`,
        };
    }
    const diff = parseDiff(r.out);
    const files = r.out
      .split(/\r?\n/)
      .filter((l) => /^(add|remove|update|move|copy|restore) /.test(l))
      .slice(0, 60);
    const changed =
      diff.added + diff.removed + diff.updated + diff.moved + diff.copied + diff.restored;
    return {
      ok: true,
      diff,
      files,
      text: changed
        ? `${diff.added} added, ${diff.removed} deleted, ${diff.updated} changed, ${diff.moved} moved since the last sync.${diff.removed > 50 ? " That is many deletions: check that every drive is there before syncing." : ""}`
        : "Nothing changed since the last sync.",
    };
  }

  /** Where a running SnapRAID job reports its state. */
  private async snapraidJobFile(): Promise<string | undefined> {
    if (this.opts.sample) return this.opts.sample.snap.jobFile;
    if (this.platform() === "win32") return this.local()?.jobFile;
    const log = this.elevation ? (await this.elevation.state()).status?.auditLog : undefined;
    return path.posix.join(log ? path.posix.dirname(log) : "/var/log/hearth", "snapraid-job.json");
  }

  /** SnapRAID on Windows runs as Hearth's own account, from Hearth's data folder. */
  private localRunner?: LocalSnapraid;
  private local() {
    if (!this.opts.dataDir) return undefined;
    this.localRunner ??= new LocalSnapraid(path.join(this.opts.dataDir, "raid"), this.io);
    return this.localRunner;
  }

  /** A root-only read through the executor (SnapRAID's status when its files are root's). */
  private async readElevated(params: Record<string, string>) {
    if (this.opts.sample || !this.elevation) return undefined;
    const s = await this.elevation.state();
    if (!s.available || !s.status?.operations.includes("storage.read")) return undefined;
    const r = await this.elevation.read("storage.read", params);
    return r.ok ? (r.data as { code: number; out: string }) : undefined;
  }

  private async perform(
    op: OperationName,
    params: Params,
    step: StepRun,
  ): Promise<ElevatedResponse> {
    if (step.params?.scheduled === true && step.job && !step.job.approvedAt) {
      // A scheduled check carries the schedule's approval (when and by whom it was given).
      const a = (await this.report()).arrays.find((x) => x.id === step.params?.arrayId);
      const sch = a ? (await this.state()).schedules[a.uuid ?? a.id] : undefined;
      const scheduledWork =
        (op === "raid.sync" && params.action === "check") ||
        ((op === "zfs.scrub" || op === "btrfs.scrub") && params.action === "start") ||
        (op === "snapraid.run" && ["sync", "scrub"].includes(String(params.action)));
      if (!sch || !scheduledWork || step.params?.action !== (sch.action ?? "check"))
        return { ok: false, outcome: "refused", result: "No approved schedule covers this." };
      step = { ...step, job: { ...step.job, approvedAt: sch.approvedAt } };
    }
    if (this.opts.sample) {
      this.cache = undefined;
      forgetWindows(this.io);
      return this.opts.sample.perform(op, params);
    }
    if (op === "snapraid.run" && this.platform() === "win32") {
      const local = this.local();
      this.cache = undefined;
      return local
        ? local.perform(params)
        : { ok: false, outcome: "refused", result: "Hearth's data folder is not known here." };
    }
    if (!this.elevation)
      return {
        ok: false,
        outcome: "refused",
        result: "The elevated executor is not set up here; nothing was done.",
      };
    const res = await this.elevation.perform(op, params, step);
    this.cache = undefined;
    forgetWindows(this.io);
    return res;
  }

  async run(step: StepRun): Promise<StepOutcome> {
    try {
      const p = step.params ?? {};
      const action = String(p.action ?? "");
      // Checked again now, not as it was planned.
      const r = await this.resolve(p);
      if (r.report.host !== p.host && p.host !== undefined && !this.opts.sample)
        throw new Refuse(`This plan was made for ${String(p.host)}, not ${r.report.host}.`);
      const a = r.array;
      const st = await this.state();
      const sameDrive = (device: unknown) => {
        const c =
          r.report.candidates.find((x) => x.device === device) ??
          a?.members.find((m) => m.device === device);
        if (p.serial && c?.serial !== p.serial)
          throw new Refuse(
            `The drive at ${String(device)} is not the one approved (serial ${c?.serial ?? "unknown"}). Nothing was done.`,
          );
      };
      let res: ElevatedResponse;
      const tech = (a?.tech ?? (typeof p.tech === "string" ? p.tech : "mdadm")) as RaidTech;
      if (tech !== "mdadm" && action !== "schedule-check") {
        const d = this.driver(tech);
        if (!d) throw new Refuse(`Hearth does not manage ${tech} on this machine.`);
        res = await d.run(
          {
            action,
            ...(a ? { array: a } : {}),
            params: p,
            report: r.report,
            host: r.report.host,
          },
          (op, prm) => this.perform(op, prm, step),
        );
      } else
        switch (action) {
          case "add-disk":
          case "add-spare":
          case "replace":
          case "re-add":
            sameDrive(p.device);
            res = await this.perform(
              "raid.member",
              {
                array: a!.device!,
                action:
                  action === "add-disk" ? "add" : action === "add-spare" ? "add-spare" : action,
                device: String(p.device),
                ...(p.serial ? { serial: String(p.serial) } : {}),
                ...(p.erase === true ? { erase: true } : {}),
                ...(action === "replace" ? { replaces: String(p.replaces) } : {}),
              },
              step,
            );
            break;
          case "mark-failed":
          case "remove":
            sameDrive(p.device);
            res = await this.perform(
              "raid.member",
              {
                array: a!.device!,
                action: action === "mark-failed" ? "fail" : "remove",
                device: String(p.device),
              },
              step,
            );
            break;
          case "check":
          case "repair":
          case "pause-check":
          case "cancel-check":
          case "resume-check": {
            const key = a!.uuid ?? a!.id;
            const sync =
              action === "pause-check"
                ? "pause"
                : action === "cancel-check"
                  ? "cancel"
                  : action === "resume-check"
                    ? "resume"
                    : action;
            res = await this.perform(
              "raid.sync",
              {
                array: a!.device!,
                action: sync,
                ...(sync === "resume" ? { position: st.paused[key] ?? 0 } : {}),
              },
              step,
            );
            if (res.ok) {
              const pos = (res.data as { position?: number } | undefined)?.position;
              if (sync === "pause" && typeof pos === "number") st.paused[key] = pos;
              else delete st.paused[key];
              await this.saveState(st);
            }
            break;
          }
          case "speed":
            res = await this.perform(
              "raid.speed",
              {
                array: a!.device!,
                minKiBs: p.minKiBs === "system" ? "system" : Number(p.minKiBs),
                maxKiBs: p.maxKiBs === "system" ? "system" : Number(p.maxKiBs),
              },
              step,
            );
            break;
          case "grow-devices":
            if (p.device) sameDrive(p.device);
            res = await this.perform(
              "raid.grow",
              {
                array: a!.device!,
                mode: "devices",
                raidDevices: Number(p.raidDevices),
                ...(p.device ? { device: String(p.device) } : {}),
                ...(p.serial ? { serial: String(p.serial) } : {}),
                ...(p.erase === true ? { erase: true } : {}),
              },
              step,
            );
            break;
          case "grow-size":
          case "grow-filesystem":
            res = await this.perform(
              "raid.grow",
              { array: a!.device!, mode: action === "grow-size" ? "size" : "filesystem" },
              step,
            );
            break;
          case "save-config": {
            const conf = await this.confFile();
            const line = arrayLine(a!, r.report.host);
            if (!line) throw new Refuse("The array's UUID is not known.");
            if (this.opts.sample) {
              res = this.opts.sample.perform("raid.config", { array: a!.device! });
              this.cache = undefined;
              break;
            }
            const next = `${conf.content.replace(/\n*$/, "\n")}${line}\n`;
            res = await this.perform(
              "file.write",
              {
                path: conf.path,
                key: "mdadm",
                beforeHash: conf.content === "" && !conf.exists ? null : sha256(conf.content),
                afterHash: sha256(next),
                content: Buffer.from(next, "utf8").toString("base64"),
                ...(conf.exists ? {} : { create: { mode: 0o644, uid: 0, gid: 0 } }),
              },
              step,
            );
            break;
          }
          case "schedule-check": {
            const key = a!.uuid ?? a!.id;
            const work = scheduleWork(a!.tech);
            if (p.every === "off") delete st.schedules[key];
            else
              st.schedules[key] = {
                every: p.every as ScheduleEvery,
                name: a!.name,
                approvedBy: "you",
                approvedAt: step.job?.approvedAt ?? new Date().toISOString(),
                jobId: step.job?.id ?? "",
                action: work.action,
                tech: a!.tech,
              };
            await this.saveState(st);
            this.cache = undefined;
            return {
              ok: true,
              result:
                p.every === "off"
                  ? `Hearth no longer schedules the ${work.noun} of ${a!.name}.`
                  : `${scheduleText(st.schedules[key]!)} The next is ${nextRun(p.every as ScheduleEvery, new Date()).toLocaleString("en-US")}.`,
            };
          }
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
            devices.forEach((d, i) => {
              const c = r.report.candidates.find((x) => x.device === d);
              if (serials[i] && c?.serial !== serials[i])
                throw new Refuse(`The drive at ${d} is not the one approved. Nothing was created.`);
            });
            res = await this.perform(
              "raid.create",
              {
                level: String(p.level),
                name: String(p.name),
                devices: devices.map((d, i) => ({
                  device: d,
                  ...(serials[i] ? { serial: serials[i] } : {}),
                  ...(erase.has(d) ? { erase: true } : {}),
                })),
                ...(p.mkfs === "ext4" ? { mkfs: "ext4" } : {}),
              },
              step,
            );
            break;
          }
          default:
            throw new Refuse("Nothing to run.");
        }
      if (!res.ok) return { ok: false, result: `Nothing was changed: ${res.result}` };
      // Read back what the kernel says now.
      const after = await this.report(true);
      const now = a ? after.arrays.find((x) => x.id === a.id) : undefined;
      const state = now
        ? ` ${now.name} is now ${now.health}${now.sync ? ` (${now.sync.action}${now.sync.progressPct !== undefined ? ` ${now.sync.progressPct}%` : ""}${now.sync.etaMinutes !== undefined ? `, about ${eta(now.sync.etaMinutes)} left` : ""})` : ""}.`
        : "";
      return {
        ok: true,
        result: `${res.result}${this.opts.sample ? "" : " (through the elevated executor)"}${state}`,
      };
    } catch (error) {
      return { ok: false, result: error instanceof Error ? error.message : String(error) };
    }
  }

  private async confFile() {
    for (const p of ["/etc/mdadm/mdadm.conf", "/etc/mdadm.conf"]) {
      const c = await this.io.read(p);
      if (c !== undefined)
        return { path: p, dir: p.replace(/\/[^/]+$/, ""), content: c, exists: true };
    }
    return { path: "/etc/mdadm/mdadm.conf", dir: "/etc/mdadm", content: "", exists: false };
  }

  /**
   * Scheduled checks that are due: each runs as its own plan under the schedule the owner
   * approved (makePlan creates and runs it). Skipped, and said why, when the array is not whole
   * or is busy, or changes cannot run here.
   */
  async due(
    now = new Date(),
  ): Promise<{ arrayId: string; name: string; action: string; noun: string; skip?: string }[]> {
    const st = await this.state();
    const out: { arrayId: string; name: string; action: string; noun: string; skip?: string }[] =
      [];
    const report = Object.keys(st.schedules).length ? await this.report(true) : undefined;
    for (const [uuid, s] of Object.entries(st.schedules)) {
      const last = s.lastRun ? new Date(s.lastRun) : new Date(s.approvedAt);
      const next = nextRun(s.every, last);
      if (next > now) continue;
      const a = report?.arrays.find((x) => (x.uuid ?? x.id) === uuid);
      const action = s.action ?? "check";
      const check = a?.actions.find((x) => x.id === action);
      out.push({
        arrayId: a?.id ?? uuid,
        name: s.name,
        action,
        noun: scheduleWork(a?.tech ?? (s.tech as RaidTech | undefined) ?? "mdadm").noun,
        ...(!a
          ? { skip: `${s.name} is not on this machine now.` }
          : check?.status === "running"
            ? { skip: `It is already running (${check.reason ?? "in progress"}).` }
            : check?.status !== "available"
              ? { skip: check?.reason ?? "The check is not possible now." }
              : {}),
      });
      s.lastRun = now.toISOString();
    }
    if (out.length) await this.saveState(st);
    return out;
  }

  /** The schedule's approval, for the scheduled plan's record. */
  async scheduleApproval(arrayId: string) {
    const st = await this.state();
    const report = await this.report();
    const a = report.arrays.find((x) => x.id === arrayId);
    return a ? st.schedules[a.uuid ?? a.id] : undefined;
  }
}

/** mdadm.conf's line for an array: its name, metadata, and UUID in mdadm's 8:8:8:8 form. */
export function arrayLine(a: RaidArray, host: string): string | undefined {
  const hex = a.uuid?.replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (!hex || hex.length !== 32) return undefined;
  const uuid = hex.match(/.{8}/g)!.join(":");
  const name = /^md\d+$/.test(a.name) ? undefined : a.name;
  return `ARRAY ${name ? `/dev/md/${name}` : a.device} metadata=${a.metadata ?? "1.2"} UUID=${uuid}${name ? ` name=${host}:${name}` : ""}`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type ScheduleEvery = "daily" | "weekly" | "monthly";

/** 02:00 every night, every Sunday, or the first Sunday of the month, after `from`. */
export function nextRun(every: ScheduleEvery, from: Date): Date {
  const d = new Date(from);
  d.setHours(2, 0, 0, 0);
  for (let i = 0; i < 400; i++) {
    if (
      d > from &&
      (every === "daily" || d.getDay() === 0) &&
      (every !== "monthly" || d.getDate() <= 7)
    )
      return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

export function whenWords(every: ScheduleEvery) {
  return every === "daily"
    ? "every night at 02:00"
    : every === "weekly"
      ? "every Sunday at 02:00"
      : "on the first Sunday of each month at 02:00";
}

/** What a technology's schedule runs, in words, and which intervals it offers. */
export function scheduleWork(tech: RaidTech): {
  action: "check" | "sync";
  every: ScheduleEvery[];
  noun: string;
  verb: string;
  safe: string;
} {
  if (tech === "snapraid")
    return {
      action: "sync",
      every: ["daily", "weekly"],
      noun: "sync and scrub",
      verb: "sync parity and scrub a little of",
      safe: "Each run updates parity to match the files, then scrubs about 3% of the array (the oldest first, so all of it is checked about monthly). It stops before syncing if more than 50 files were deleted since the last sync: a missing or empty drive looks like that, and syncing then would throw away the parity needed to rebuild it.",
    };
  if (tech === "zfs" || tech === "btrfs")
    return {
      action: "check",
      every: ["weekly", "monthly"],
      noun: "scrub",
      verb: "scrub",
      safe: "Each run is a scrub: it reads every block and repairs damage from the good copy; files are not changed. It is skipped while the pool is rebuilding.",
    };
  return {
    action: "check",
    every: ["weekly", "monthly"],
    noun: "consistency check",
    verb: "run a consistency check on",
    safe: "Each run is a check only (never a repair), and is skipped when the array is not whole or is busy.",
  };
}

/** A Hearth schedule in words: "Hearth scrubs tank every Sunday at 02:00 (approved 2026-10-24)." */
export function scheduleText(s: RaidState["schedules"][string]) {
  const work = scheduleWork((s.tech as RaidTech | undefined) ?? "mdadm");
  return `Hearth ${work.action === "sync" ? "syncs and scrubs" : work.noun === "scrub" ? "scrubs" : "checks"} ${s.name} ${whenWords(s.every)} (approved ${s.approvedAt.slice(0, 10)}).`;
}

const LINUX_SETUP =
  "Set it up once with its storage operations switched on: sudo bash deploy/linux/install-elevation.sh --service hearth --add-operation raid";
const LINUX_SWITCH =
  "sudo bash deploy/linux/install-elevation.sh --service hearth --add-operation raid";
const WINDOWS_SETUP =
  "Set it up once, in PowerShell as administrator: powershell -ExecutionPolicy Bypass -File deploy\\windows\\install-elevation.ps1 -Operations storage";
const WINDOWS_SWITCH =
  "powershell -ExecutionPolicy Bypass -File deploy\\windows\\install-elevation.ps1 -Operations storage (as administrator)";

/** Linux software RAID's layouts, for Create an array. */
const MDADM_CREATE: RaidCreateOption = {
  tech: "mdadm",
  label: "Linux software RAID (mdadm)",
  levels: [
    {
      id: "raid1",
      label: "RAID 1",
      min: 2,
      tolerance: 1,
      words: "Mirrors: every drive holds the same data.",
    },
    {
      id: "raid5",
      label: "RAID 5",
      min: 3,
      tolerance: 1,
      words: "Striped with parity: one drive's worth of space protects the rest.",
    },
    {
      id: "raid6",
      label: "RAID 6",
      min: 4,
      tolerance: 2,
      words: "Striped with double parity: two drives may fail.",
    },
    {
      id: "raid10",
      label: "RAID 10",
      min: 4,
      tolerance: 1,
      words: "Mirrored pairs, striped: fast, half the space.",
    },
    {
      id: "raid0",
      label: "RAID 0",
      min: 2,
      tolerance: 0,
      words: "Striped, no protection: one failure loses everything.",
    },
  ],
  filesystems: [
    { id: "ext4", label: "An empty ext4 filesystem" },
    { id: "none", label: "No filesystem" },
  ],
  note: "Not mounted: mounting it is a separate step.",
};

function backupWords(arrays: RaidArray[]): RaidReport["backups"] {
  return {
    known: false,
    text: arrays.length
      ? "Hearth does not see a backup of what is on these arrays. RAID keeps data available through a drive failure; it does not protect against deletion, corruption, or the whole machine failing. Keep a copy elsewhere."
      : "RAID keeps data available through a drive failure. It is not a backup.",
  };
}
