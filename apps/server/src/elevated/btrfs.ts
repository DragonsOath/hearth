import type { Params } from "./protocol";
import {
  RaidFailed,
  RaidRefused,
  checkNewDrive,
  driveParam,
  type RaidDeps,
  type RaidResult,
} from "./raid";

/**
 * The elevated executor's Btrfs operations, on a mounted multi-device Btrfs filesystem named by
 * its mount point (checked to be Btrfs, now). Fixed btrfs commands; new drives get every check an
 * mdadm member gets. Long work (a balance or conversion, a replace, removing a drive) runs in its
 * own systemd unit, hearth-btrfs: btrfs's own background mode keeps the job tied to the process
 * that started it, and the kernel cancels the job when the executor's request ends.
 */

const PROFILES = [
  "single",
  "raid0",
  "raid1",
  "raid1c3",
  "raid1c4",
  "raid10",
  "raid5",
  "raid6",
] as const;
const MIN: Record<string, number> = {
  single: 1,
  raid0: 2,
  raid1: 2,
  raid1c3: 3,
  raid1c4: 4,
  raid10: 4,
  raid5: 2,
  raid6: 3,
};
/** Metadata is kept at least as safe as data, and never on RAID 5/6 (the write hole). */
const META: Record<string, string> = {
  single: "dup",
  raid0: "raid1",
  raid1: "raid1",
  raid1c3: "raid1c3",
  raid1c4: "raid1c4",
  raid10: "raid1",
  raid5: "raid1",
  raid6: "raid1c3",
};
export const BTRFS_UNIT = "hearth-btrfs";

async function btrfs(deps: RaidDeps, args: string[], timeoutMs = 120_000) {
  const r = await deps.run("btrfs", args, { timeoutMs });
  if (r.code !== 0)
    throw new RaidFailed(
      `btrfs ${args.slice(0, 2).join(" ")} did not succeed: ${r.out.trim().slice(-400)}`,
    );
  return r.out;
}

/** The mount point named, if it is a mounted Btrfs filesystem now. */
async function mountParam(deps: RaidDeps, v: unknown) {
  if (typeof v !== "string" || !/^\/[\w./ -]{0,200}$/.test(v) || v.includes(".."))
    throw new RaidRefused("The mount point is not valid.");
  const r = await deps.run("findmnt", ["-n", "-o", "FSTYPE,TARGET", "--mountpoint", v], {
    timeoutMs: 15_000,
  });
  if (r.code !== 0 || !/^btrfs\s/.test(r.out.trim()))
    throw new RaidRefused(`${v} is not a mounted Btrfs filesystem.`, "stale");
  return v;
}

/** The filesystem's devices now: devid, path, and whether missing. */
async function devices(deps: RaidDeps, mount: string) {
  const out = await btrfs(deps, ["filesystem", "show", "--raw", mount], 30_000);
  const list = [
    ...out.matchAll(/devid\s+(\d+)\s+size\s+(\d+)\s+used\s+(\d+)\s+path\s+(\S+)(.*)$/gm),
  ].map((m) => ({
    devid: m[1]!,
    size: Number(m[2]),
    path: m[4]!,
    missing: /MISSING/i.test(m[5] ?? "") || m[4] === "<missing",
  }));
  const missing = /Some devices missing|\*\*\* Some devices missing/i.test(out);
  return { list, missing };
}

/** A member named by its path or its devid ("devid:3" for a missing one). */
async function memberParam(deps: RaidDeps, mount: string, v: unknown) {
  if (typeof v !== "string" || !(/^devid:\d{1,4}$/.test(v) || /^\/dev\/[\w/.:+-]{1,200}$/.test(v)))
    throw new RaidRefused("The drive must be a device path or devid:N.");
  const d = await devices(deps, mount);
  const m = v.startsWith("devid:")
    ? d.list.find((x) => x.devid === v.slice(6))
    : d.list.find((x) => x.path === v);
  if (!m && !(v.startsWith("devid:") && d.missing))
    throw new RaidRefused(`${v} is not in the filesystem at ${mount}.`, "stale");
  return { id: v.startsWith("devid:") ? v.slice(6) : m!.path, path: m?.path ?? v };
}

/** Long Btrfs work in its own unit, so it outlives the request that started it. */
async function inUnit(deps: RaidDeps, description: string, args: string[]) {
  const active =
    (await deps.run("systemctl", ["is-active", "--quiet", BTRFS_UNIT], { timeoutMs: 15_000 }))
      .code === 0;
  if (active)
    throw new RaidRefused("Other Btrfs work is still running; wait until it finishes.", "stale");
  await deps.run("systemctl", ["reset-failed", BTRFS_UNIT], { timeoutMs: 15_000 });
  const r = await deps.run(
    "systemd-run",
    [
      `--unit=${BTRFS_UNIT}`,
      "--collect",
      "--quiet",
      `--description=Hearth: ${description}`,
      "btrfs",
      ...args,
    ],
    { timeoutMs: 30_000 },
  );
  if (r.code !== 0)
    throw new RaidFailed(
      `The ${description.toLowerCase()} could not be started: ${r.out.trim().slice(-300)}`,
    );
}

async function exclusive(deps: RaidDeps, mount: string) {
  const r = await deps.run("btrfs", ["balance", "status", mount], { timeoutMs: 15_000 });
  if (/is running|is paused/i.test(r.out)) return "balance";
  const s = await deps.run("btrfs", ["replace", "status", "-1", mount], { timeoutMs: 15_000 });
  if (/Started on|% done/i.test(s.out) && !/Never started|finished|canceled/i.test(s.out))
    return "replace";
  return undefined;
}

/** btrfs.member: add, replace, or remove a drive. */
export async function btrfsMember(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const mount = await mountParam(deps, params.mount);
  const busy = await exclusive(deps, mount);
  if (busy)
    throw new RaidRefused(`A ${busy} is running on ${mount}; wait until it finishes.`, "stale");
  const force = params.erase === true ? ["-f"] : [];
  if (params.action === "add") {
    const device = driveParam(deps, params.device);
    const d = await checkNewDrive(deps, device, params);
    await btrfs(deps, ["device", "add", ...force, device, mount]);
    const now = await devices(deps, mount);
    if (!now.list.some((x) => x.path === device))
      throw new RaidFailed(`${device} does not show in ${mount} afterwards.`);
    return {
      target: `${mount} ${device}`,
      result: `${device}${d.serial ? ` (serial ${d.serial})` : ""} joined the filesystem at ${mount}. Balance it to spread data onto the new drive.`,
    };
  }
  if (params.action === "replace") {
    const old = await memberParam(deps, mount, params.replaces);
    const device = driveParam(deps, params.device);
    const d = await checkNewDrive(deps, device, params);
    // The old drive stays in use until the copy is done.
    await inUnit(deps, "Btrfs drive replacement", [
      "replace",
      "start",
      "-B",
      ...force,
      old.id,
      device,
      mount,
    ]);
    return {
      target: `${mount} ${device}`,
      result: `${device}${d.serial ? ` (serial ${d.serial})` : ""} is replacing ${old.path} in ${mount}; btrfs copies onto it in the background.`,
    };
  }
  if (params.action === "remove") {
    const m = await memberParam(deps, mount, params.device);
    // btrfs refuses by itself when the rest cannot hold the data in its profile.
    await inUnit(deps, "Btrfs drive removal", ["device", "remove", m.id, mount]);
    return {
      target: `${mount} ${m.path}`,
      result: `Removing ${m.path} from ${mount} in the background (unit ${BTRFS_UNIT}): btrfs moves its data onto the others first. Its drive is not erased.`,
    };
  }
  throw new RaidRefused("The drive action is not valid.");
}

/** btrfs.scrub: start, cancel (it keeps its place), or resume a scrub. */
export async function btrfsScrub(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const mount = await mountParam(deps, params.mount);
  const verb = { start: "start", cancel: "cancel", resume: "resume" }[String(params.action)];
  if (!verb) throw new RaidRefused("Start, cancel, or resume.");
  const r = await deps.run("btrfs", ["scrub", verb, mount], { timeoutMs: 60_000 });
  // "resume" with nothing to resume, or "cancel" with nothing running, is stale, not a failure.
  if (r.code !== 0)
    throw new RaidRefused(
      `btrfs scrub ${verb}: ${r.out.trim().slice(-300)}`,
      verb === "start" ? "refused" : "stale",
    );
  return {
    target: mount,
    result:
      verb === "start"
        ? `A scrub started on ${mount}.`
        : verb === "cancel"
          ? `The scrub on ${mount} was stopped; it can resume from there.`
          : `The scrub on ${mount} continues.`,
  };
}

/** btrfs.balance: spread data over every drive, or convert to another profile; or stop one. */
export async function btrfsBalance(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const mount = await mountParam(deps, params.mount);
  const action = params.action;
  if (action === "cancel" || action === "pause" || action === "resume") {
    const r = await deps.run("btrfs", ["balance", action, mount], { timeoutMs: 600_000 });
    if (r.code !== 0)
      throw new RaidRefused(`btrfs balance ${action}: ${r.out.trim().slice(-300)}`, "stale");
    return {
      target: mount,
      result: `The balance on ${mount}: ${action === "cancel" ? "stopped" : action === "pause" ? "paused" : "resumed"}.`,
    };
  }
  if (action !== "start") throw new RaidRefused("The balance action is not valid.");
  if (await exclusive(deps, mount))
    throw new RaidRefused(`${mount} is busy (a balance or replace).`, "stale");
  const convert = params.convert;
  const args = ["balance", "start"];
  if (convert !== undefined) {
    if (typeof convert !== "string" || !(PROFILES as readonly string[]).includes(convert))
      throw new RaidRefused("The profile is not valid.");
    const have = (await devices(deps, mount)).list.filter((d) => !d.missing).length;
    if (have < MIN[convert]!)
      throw new RaidRefused(
        `${convert} needs at least ${MIN[convert]} drives; ${mount} has ${have}.`,
      );
    args.push(`-dconvert=${convert}`, `-mconvert=${META[convert]}`);
  } else args.push("--full-balance");
  await inUnit(deps, convert ? "Btrfs conversion" : "Btrfs balance", [...args, mount]);
  return {
    target: mount,
    result: convert
      ? `${mount} is converting to ${convert} (metadata ${META[convert]}) in the background.`
      : `${mount} is balancing in the background.`,
  };
}

/** btrfs.clear: reset the error counters, or grow each drive's share to its full size. */
export async function btrfsClear(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const mount = await mountParam(deps, params.mount);
  if (params.action === "grow") {
    const d = await devices(deps, mount);
    for (const x of d.list.filter((y) => !y.missing))
      await btrfs(deps, ["filesystem", "resize", `${x.devid}:max`, mount]);
    return { target: mount, result: `Every drive in ${mount} now gives its full size.` };
  }
  await btrfs(deps, ["device", "stats", "-z", mount]);
  return { target: mount, result: `The error counters of ${mount} were reset.` };
}

/** btrfs.create: a new filesystem over approved, checked drives (not mounted). */
export async function btrfsCreate(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const profile = params.profile;
  if (typeof profile !== "string" || !(PROFILES as readonly string[]).includes(profile))
    throw new RaidRefused("The profile is not valid.");
  const label =
    typeof params.name === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(params.name)
      ? params.name
      : undefined;
  if (!label) throw new RaidRefused("The name must be letters, digits, dashes, or underscores.");
  const list = Array.isArray(params.devices)
    ? (params.devices as { device?: unknown; serial?: unknown; erase?: unknown }[])
    : [];
  if (list.length < MIN[profile]!)
    throw new RaidRefused(`${profile} needs at least ${MIN[profile]} drives.`);
  if (list.length > 32) throw new RaidRefused("Too many drives.");
  const seen = new Set<string>();
  for (const d of list) {
    const dev = driveParam(deps, d.device);
    if (seen.has(dev)) throw new RaidRefused(`${dev} is listed twice.`);
    seen.add(dev);
    await checkNewDrive(deps, dev, d);
  }
  const force = list.some((d) => d.erase === true) ? ["-f"] : [];
  const m = await deps.run(
    "mkfs.btrfs",
    [
      ...force,
      "-L",
      label,
      "-d",
      profile,
      "-m",
      list.length === 1 ? "dup" : META[profile]!,
      ...seen,
    ],
    { timeoutMs: 600_000 },
  );
  if (m.code !== 0) throw new RaidFailed(`mkfs.btrfs did not succeed: ${m.out.trim().slice(-300)}`);
  return {
    target: label,
    result: `Created the Btrfs filesystem ${label} (${profile}) on ${[...seen].join(", ")}. It is not mounted: mounting it is a separate step.`,
  };
}
