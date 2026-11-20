import type {
  RaidAction,
  RaidArray,
  RaidCandidate,
  RaidCreateOption,
  RaidReport,
  RaidSchedule,
  RaidTech,
  RaidTechSupport,
} from "@dragon-control/core";
import type { ElevatedResponse, OperationName, Params } from "../../elevated/protocol";
import type { RaidIO } from "./io";
import type { Block } from "./read";

/**
 * One storage technology in the RAID / Arrays tab (ZFS, SnapRAID, Storage Spaces...). Each reads
 * its own arrays without privilege, decides which actions are possible now, words a plan step
 * with the exact host, array, and drives, and carries an approved step out through `perform`
 * (the elevated executor, or the simulated machine). Linux software RAID keeps its own code in
 * service.ts; every other technology is a driver.
 */

/** A plan step that must not run, with why (shown to the owner and Ember). */
export class Refuse extends Error {}

export interface DriverEnv {
  io: RaidIO;
  /** lsblk's drives (Linux; empty on Windows). */
  blocks: Block[];
  /** Drives that could join an array, and why others cannot. */
  candidates: RaidCandidate[];
  /** Whether this technology's approved changes can run here, and if not, why. */
  ready: { ready: boolean; why?: string };
  sample: boolean;
}

export interface PlanInput {
  action: string;
  array?: RaidArray;
  params: Record<string, unknown>;
  report: RaidReport;
  host: string;
}

export interface PlanWords {
  label: string;
  reason: string;
  /** Extra parameters to keep with the step (serials, resolved paths). */
  params?: Record<string, string | number | boolean>;
}

export type Perform = (op: OperationName, params: Params) => Promise<ElevatedResponse>;

export interface RaidDriver {
  tech: RaidTech;
  /** Where it exists: "linux", "win32", or both (SnapRAID). */
  platforms: readonly NodeJS.Platform[];
  /** Executor operations its changes need; empty when changes run as Hearth's own account. */
  operations: readonly OperationName[];
  /** Present here at all (its tools or its config are found)? Cheap. */
  present(env: Pick<DriverEnv, "io" | "blocks">): Promise<boolean>;
  support(env: DriverEnv): Promise<RaidTechSupport>;
  /** Its arrays, without actions (the free drives are known only once every array is read). */
  arrays(env: DriverEnv): Promise<RaidArray[]>;
  /** What can be done to one of its arrays now. */
  actions(a: RaidArray, env: DriverEnv): RaidAction[];
  /** Drives that could join (Windows reads its own; Linux shares lsblk's). */
  candidates?(env: Pick<DriverEnv, "io" | "blocks" | "sample">): Promise<RaidCandidate[]>;
  create?(env: DriverEnv): Promise<RaidCreateOption | undefined>;
  schedules?(env: DriverEnv): Promise<RaidSchedule[]>;
  /** Whether changes can run without the executor (SnapRAID on Windows runs as the owner). */
  readyWithout?(env: Pick<DriverEnv, "io" | "sample">): Promise<{ ready: boolean; why?: string }>;
  plan(x: PlanInput): Promise<PlanWords>;
  run(x: PlanInput, perform: Perform): Promise<ElevatedResponse>;
}

/** "a drive (serial X) at /dev/sdb, 4.0 TB", the way every plan names one. */
export function driveWords(c: {
  device?: string;
  model?: string;
  serial?: string;
  sizeBytes?: number;
}) {
  const size =
    c.sizeBytes === undefined
      ? ""
      : c.sizeBytes >= 1e12
        ? `, ${(c.sizeBytes / 1e12).toFixed(1)} TB`
        : `, ${Math.round(c.sizeBytes / 1e9)} GB`;
  return `${c.model ?? "drive"}${c.serial ? ` (serial ${c.serial})` : ""} at ${c.device ?? "?"}${size}`;
}

/** The candidate named, usable, and big enough, or why not. */
export function pickCandidate(
  report: RaidReport,
  device: unknown,
  opts: { minBytes?: number; erase?: unknown } = {},
): RaidCandidate {
  const c = report.candidates.find((x) => x.device === device);
  if (!c) throw new Refuse(`${String(device)} is not a drive Hearth sees on this machine.`);
  if (c.state === "excluded")
    throw new Refuse(`${c.device} cannot be used: ${c.reason ?? "excluded"}`);
  if (opts.minBytes && (c.sizeBytes ?? 0) < opts.minBytes)
    throw new Refuse(
      `${c.device} is too small: each member needs at least ${(opts.minBytes / 1e9).toFixed(0)} GB.`,
    );
  if (c.state === "has-data" && opts.erase !== true)
    throw new Refuse(
      `${c.device} holds data (${c.reason ?? ""}). Approve erasing it, or choose an empty drive.`,
    );
  return c;
}

/** The array's member named, or why not. */
export function pickMember(a: RaidArray, device: unknown) {
  const m = a.members.find((x) => x.device === device || x.group === device);
  if (!m) throw new Refuse(`${String(device)} is not a member of ${a.name}.`);
  return m;
}

/** At run time: the drive at that place is still the one approved (by serial). */
export function sameDrive(
  report: RaidReport,
  a: RaidArray | undefined,
  device: unknown,
  serial: unknown,
) {
  if (!serial) return;
  const c =
    report.candidates.find((x) => x.device === device) ??
    a?.members.find((m) => m.device === device);
  if (c?.serial !== serial)
    throw new Refuse(
      `The drive at ${String(device)} is not the one approved (serial ${c?.serial ?? "unknown"}). Nothing was done.`,
    );
}

export const refused = (result: string): ElevatedResponse => ({
  ok: false,
  outcome: "refused",
  result,
});
