import fs from "node:fs/promises";
import path from "node:path";
import type { Evidence, Params } from "./protocol";

/**
 * The elevated executor's RAID operations (Linux software RAID, mdadm). Each one is typed, takes
 * only array and drive names from the request, checks the machine itself before acting (it does
 * not trust what Hearth's backend saw), and reads the kernel's state back afterwards. There is no
 * free-form mdadm: only these commands, with these arguments.
 *
 * Never, whatever the request says:
 * - a drive holding the system, or mounted anywhere, or in another array, or in use by LVM or
 *   encryption;
 * - erasing a drive that holds data unless the request says erase and names its serial number;
 * - failing a member when the array has no redundancy left;
 * - creating a filesystem anywhere but on an array it has just created, when asked.
 */

export class RaidRefused extends Error {
  constructor(
    message: string,
    readonly outcome: "refused" | "stale" = "refused",
  ) {
    super(message);
  }
}
export class RaidFailed extends Error {}

export interface RaidDeps {
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ code: number; out: string }>;
  wait(ms: number): Promise<void>;
  /** The kernel's md files; tests stand in for them. */
  sys?: {
    read(p: string): Promise<string | undefined>;
    write(p: string, v: string): Promise<void>;
    isBlock(p: string): Promise<boolean>;
  };
  /** Loop devices may be members (throwaway test arrays only; set in the scope file). */
  allowLoop?: boolean;
  /** Where background jobs (SnapRAID) keep their state, and how to start this program again. */
  jobs?: import("./snapraid").JobPlaces;
}

export interface RaidResult {
  result: string;
  target: string;
  evidence?: Evidence[];
  data?: unknown;
}

const ARRAY = /^\/dev\/md\d{1,3}$/;
const DRIVE =
  /^\/dev\/(sd[a-z]{1,3}\d{0,3}|nvme\d{1,2}n\d{1,2}(p\d{1,3})?|vd[a-z]{1,2}\d{0,3}|xvd[a-z]{1,2}\d{0,3}|loop\d{1,3})$/;
const SYSTEM = new Set(["/", "/boot", "/boot/efi", "/efi", "/usr", "/var", "[SWAP]"]);
const LEVELS = ["raid0", "raid1", "raid5", "raid6", "raid10"] as const;
const MIN_DEVICES: Record<string, number> = { raid0: 2, raid1: 2, raid5: 3, raid6: 4, raid10: 4 };
const TOLERANCE: Record<string, (n: number) => number> = {
  raid1: (n) => n - 1,
  raid4: () => 1,
  raid5: () => 1,
  raid6: () => 2,
  raid10: () => 1,
};

const sysOf = (deps: RaidDeps) =>
  deps.sys ?? {
    read: (p: string) => fs.readFile(p, "utf8").catch(() => undefined),
    write: (p: string, v: string) => fs.writeFile(p, v),
    isBlock: async (p: string) =>
      (await fs.stat(p).catch(() => undefined))?.isBlockDevice() === true,
  };

const mdName = (array: string) => path.basename(array);
const md = (array: string, f: string) => `/sys/block/${mdName(array)}/md/${f}`;

async function mdadm(deps: RaidDeps, args: string[], timeoutMs = 120_000) {
  const r = await deps.run("mdadm", args, { timeoutMs });
  if (r.code !== 0)
    throw new RaidFailed(
      `mdadm ${args[0]} ${args[1] ?? ""} did not succeed: ${r.out.trim().slice(-400)}`,
    );
  return r.out;
}

function arrayParam(deps: RaidDeps, v: unknown) {
  if (typeof v !== "string" || !ARRAY.test(v))
    throw new RaidRefused("The array must be named like /dev/md0.");
  return v;
}

export function driveParam(deps: RaidDeps, v: unknown, what = "The drive") {
  if (typeof v !== "string" || !DRIVE.test(v))
    throw new RaidRefused(`${what} must be a drive or partition like /dev/sdb or /dev/sdb1.`);
  if (/^\/dev\/loop/.test(v) && !deps.allowLoop)
    throw new RaidRefused(
      "Loop devices are only used for test arrays, and that is not switched on here.",
    );
  return v;
}

interface LsNode {
  name?: string;
  kname?: string;
  type?: string;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  fstype?: string | null;
  serial?: string | null;
  children?: LsNode[];
}

const mountsIn = (n: LsNode): string[] => [
  ...[n.mountpoint, ...(n.mountpoints ?? [])].filter((m): m is string => Boolean(m)),
  ...(n.children ?? []).flatMap(mountsIn),
];

/** The drive tree a device belongs to, read now (not as Hearth saw it). */
export async function treeOf(deps: RaidDeps, device: string) {
  const r = await deps.run(
    "lsblk",
    ["-J", "-b", "-s", "-o", "NAME,KNAME,TYPE,MOUNTPOINT,FSTYPE,SERIAL", device],
    {
      timeoutMs: 15_000,
    },
  );
  // -s lists the device with its parents (the whole drive last), so the drive's serial is found.
  const self = (JSON.parse(r.out || "{}") as { blockdevices?: LsNode[] }).blockdevices?.[0];
  if (r.code !== 0 || !self) throw new RaidRefused(`${device} is not a drive on this machine.`);
  let disk = self;
  while (disk.children?.length) disk = disk.children[0]!;
  const whole = await deps.run(
    "lsblk",
    [
      "-J",
      "-b",
      "-o",
      "NAME,KNAME,TYPE,MOUNTPOINT,FSTYPE,SERIAL",
      `/dev/${disk.kname ?? disk.name}`,
    ],
    {
      timeoutMs: 15_000,
    },
  );
  const diskTree =
    (JSON.parse(whole.out || "{}") as { blockdevices?: LsNode[] }).blockdevices?.[0] ?? disk;
  const selfTree = ((): LsNode => {
    const find = (n: LsNode): LsNode | undefined =>
      `/dev/${n.kname ?? n.name}` === device ? n : (n.children ?? []).map(find).find(Boolean);
    return find(diskTree) ?? self;
  })();
  return { self: selfTree, disk: diskTree };
}

async function mdstat(deps: RaidDeps) {
  return (await sysOf(deps).read("/proc/mdstat")) ?? "";
}

/**
 * A drive that is to join an array: not the system, not mounted, not in another array or LVM,
 * the drive that was approved (serial), and empty unless erasing it was approved.
 */
export async function checkNewDrive(
  deps: RaidDeps,
  device: string,
  params: { serial?: unknown; erase?: unknown },
) {
  if (!(await sysOf(deps).isBlock(device)))
    throw new RaidRefused(`${device} is not a drive on this machine.`);
  const { self, disk } = await treeOf(deps, device);
  const system = mountsIn(disk).find((m) => SYSTEM.has(m));
  if (system)
    throw new RaidRefused(
      `${device} is on the drive that holds the system (${system}). Never used.`,
    );
  const elsewhere = mountsIn(disk).filter((m) => !mountsIn(self).includes(m));
  if (elsewhere.length)
    throw new RaidRefused(
      `Another part of the drive ${device} is on is mounted (${elsewhere.join(", ")}). Hearth does not split a drive in use.`,
    );
  const mounted = mountsIn(self);
  if (mounted.length)
    throw new RaidRefused(`${device} is mounted at ${mounted.join(", ")}. Unmount it first.`);
  const kname = self.kname ?? self.name ?? "";
  if (new RegExp(`\\b${kname}\\[\\d+\\]`).test(await mdstat(deps)))
    throw new RaidRefused(`${device} is already in a running array.`);
  // A drive in an imported ZFS pool is in use, whatever its signatures say.
  const pools = await deps.run("zpool", ["status", "-P", "-L"], { timeoutMs: 15_000 });
  if (pools.code === 0) {
    const names = [kname, ...(self.children ?? []).map((c) => c.kname ?? c.name ?? "")].filter(
      Boolean,
    );
    if (names.some((n) => new RegExp(`/dev/${n}(p?\\d+)?(\\s|$)`, "m").test(pools.out)))
      throw new RaidRefused(`${device} is in an imported ZFS pool.`);
  }
  const used = (n: LsNode): string | undefined =>
    n.type === "lvm"
      ? "LVM"
      : n.type === "crypt"
        ? "disk encryption"
        : /^raid|^md/.test(n.type ?? "")
          ? "an array"
          : (n.children ?? []).map(used).find(Boolean);
  const u = (self.children ?? []).map(used).find(Boolean);
  if (u) throw new RaidRefused(`${device} is in use by ${u}.`);
  const serial = disk.serial?.trim();
  if (typeof params.serial === "string" && params.serial && serial !== params.serial)
    throw new RaidRefused(
      `The drive at ${device} is not the one approved (serial ${serial ?? "unknown"}, approved ${params.serial}). Nothing was done.`,
      "stale",
    );
  const sig = await deps.run("wipefs", ["--no-act", "--json", device], { timeoutMs: 15_000 });
  const signatures =
    (JSON.parse(sig.out || "{}") as { signatures?: { type?: string }[] }).signatures ?? [];
  const parts = (self.children ?? []).filter((c) => c.type === "part");
  const holds = [
    ...new Set([
      ...signatures.map((s) => s.type ?? "data"),
      ...(parts.length ? ["partitions"] : []),
    ]),
  ];
  if (holds.length) {
    if (params.erase !== true)
      throw new RaidRefused(
        `${device} holds ${holds.join(", ")}. Joining an array erases it; that was not approved.`,
      );
    if (!serial || params.serial !== serial)
      throw new RaidRefused(
        `Erasing ${device} needs its serial number in the approval, and it did not match.`,
      );
    for (const p of parts) {
      const w = await deps.run("wipefs", ["--all", `/dev/${p.kname ?? p.name}`], {
        timeoutMs: 60_000,
      });
      if (w.code !== 0)
        throw new RaidFailed(`Could not erase ${p.kname}: ${w.out.trim().slice(-200)}`);
    }
    const w = await deps.run("wipefs", ["--all", device], { timeoutMs: 60_000 });
    if (w.code !== 0)
      throw new RaidFailed(`Could not erase ${device}: ${w.out.trim().slice(-200)}`);
    if (parts.length) await deps.run("blockdev", ["--rereadpt", device], { timeoutMs: 30_000 });
  }
  return { serial, erased: holds };
}

async function arrayState(deps: RaidDeps, array: string) {
  const s = sysOf(deps);
  const level = (await s.read(md(array, "level")))?.trim();
  if (!level) throw new RaidRefused(`${array} is not a running array.`);
  const raidDisks = Number((await s.read(md(array, "raid_disks")))?.trim());
  const degraded = Number((await s.read(md(array, "degraded")))?.trim() || 0);
  const raw = (await s.read(md(array, "sync_action")))?.trim() ?? "idle";
  // Newer kernels report "recover" on a degraded array with no spare: nothing is copying.
  const completed = (await s.read(md(array, "sync_completed")))?.trim() ?? "none";
  const action = raw === "recover" && !/^\d+\s*\/\s*\d+/.test(completed) ? "idle" : raw;
  return { level, raidDisks, degraded, action };
}

const memberDir = (array: string, device: string) => md(array, `dev-${path.basename(device)}`);
async function memberState(deps: RaidDeps, array: string, device: string) {
  return (await sysOf(deps).read(`${memberDir(array, device)}/state`))?.trim();
}

/** raid.member: add, add-spare, fail, remove, re-add, or replace one member. */
export async function raidMember(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const array = arrayParam(deps, params.array);
  const action = params.action;
  const device = driveParam(deps, params.device);
  const st = await arrayState(deps, array);
  const target = `${array} ${device}`;
  if (action === "add" || action === "add-spare") {
    const d = await checkNewDrive(deps, device, params);
    await mdadm(deps, ["--manage", array, action === "add" ? "--add" : "--add-spare", device]);
    const state = await memberState(deps, array, device);
    if (!state) throw new RaidFailed(`${device} does not show in ${array} afterwards.`);
    return {
      target,
      result: `${device}${d.serial ? ` (serial ${d.serial})` : ""} joined ${array}${d.erased.length ? ` after erasing ${d.erased.join(", ")}` : ""}; the kernel reports it as ${state}.`,
      evidence: [{ label: "member state", value: state }],
    };
  }
  if (action === "replace") {
    const old = driveParam(deps, params.replaces, "The member being replaced");
    const oldState = await memberState(deps, array, old);
    if (!oldState) throw new RaidRefused(`${old} is not a member of ${array}.`, "stale");
    if (oldState.includes("faulty"))
      throw new RaidRefused(
        `${old} has already failed: remove it and add the new drive instead (a rebuild).`,
        "stale",
      );
    const d = await checkNewDrive(deps, device, params);
    await mdadm(deps, ["--manage", array, "--add", device, "--replace", old, "--with", device]);
    const state = await memberState(deps, array, device);
    if (!state) throw new RaidFailed(`${device} does not show in ${array} afterwards.`);
    return {
      target,
      result: `${device}${d.serial ? ` (serial ${d.serial})` : ""} is taking over from ${old} in ${array}; ${old} stays in until the copy finishes, then is marked failed for removal.`,
      evidence: [{ label: "new member state", value: state }],
    };
  }
  const state = await memberState(deps, array, device);
  if (action === "re-add") {
    if (state) throw new RaidRefused(`${device} is already in ${array}.`, "stale");
    await checkNewDrive(deps, device, { ...params, erase: false, serial: params.serial });
    await mdadm(deps, ["--manage", array, "--re-add", device]).catch((e: unknown) => {
      throw new RaidFailed(
        `mdadm would not re-add ${device} (${e instanceof Error ? e.message : String(e)}). Add it as a new disk instead; that rebuilds it fully.`,
      );
    });
    const now = await memberState(deps, array, device);
    if (!now) throw new RaidFailed(`${device} does not show in ${array} afterwards.`);
    return { target, result: `${device} is back in ${array} (${now}).` };
  }
  if (!state) throw new RaidRefused(`${device} is not a member of ${array}.`, "stale");
  if (action === "fail") {
    const tol = TOLERANCE[st.level]?.(st.raidDisks);
    if (tol === undefined)
      throw new RaidRefused(
        `${st.level} keeps no redundancy; failing a member would take it down.`,
      );
    if (state.includes("faulty"))
      throw new RaidRefused(`${device} is already marked failed.`, "stale");
    if (!state.includes("spare") && st.degraded >= tol)
      throw new RaidRefused(
        `${array} has no redundancy left (${st.degraded} missing); failing ${device} would lose its data.`,
      );
    await mdadm(deps, ["--manage", array, "--fail", device]);
    const now = await memberState(deps, array, device);
    if (!now?.includes("faulty"))
      throw new RaidFailed(`${device} is "${now}" afterwards, not failed.`);
    return {
      target,
      result: `${device} is marked failed in ${array}. Remove it, then replace it.`,
    };
  }
  if (action === "remove") {
    if (!state.includes("faulty") && !state.includes("spare"))
      throw new RaidRefused(
        `${device} is working (${state}); only failed members and spares are removed. Mark it failed first.`,
      );
    await mdadm(deps, ["--manage", array, "--remove", device]);
    if (await memberState(deps, array, device))
      throw new RaidFailed(`${device} is still in ${array} afterwards.`);
    return { target, result: `${device} was removed from ${array}. Its drive was not erased.` };
  }
  throw new RaidRefused("The member action is not valid.");
}

/** raid.sync: start a check or repair, pause, resume, or cancel one. */
export async function raidSync(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const array = arrayParam(deps, params.array);
  const action = params.action;
  const st = await arrayState(deps, array);
  const s = sysOf(deps);
  if (!TOLERANCE[st.level]) throw new RaidRefused(`${st.level} has no redundancy to check.`);
  if (action === "check" || action === "repair") {
    if (st.action !== "idle") throw new RaidRefused(`${array} is busy (${st.action}).`, "stale");
    if (st.degraded > 0)
      throw new RaidRefused(`${array} is degraded; rebuild it before checking.`, "stale");
    await s.write(md(array, "sync_min"), "0");
    await s.write(md(array, "sync_max"), "max");
    await s.write(md(array, "sync_action"), action);
    await deps.wait(1500);
    const now = (await s.read(md(array, "sync_action")))?.trim();
    if (now !== action && now !== "idle")
      throw new RaidFailed(`${array} is doing "${now}", not ${action}.`);
    return {
      target: array,
      result: `${action === "check" ? "A consistency check" : "A repair"} started on ${array}.`,
      evidence: [{ label: "sync_action", value: now ?? "" }],
    };
  }
  if (action === "pause" || action === "cancel") {
    if (st.action !== "check" && st.action !== "repair")
      throw new RaidRefused(
        `${array} is not checking (${st.action}); a rebuild or reshape is never stopped.`,
        "stale",
      );
    const done = Number((await s.read(md(array, "sync_completed")))?.split("/")[0]?.trim());
    await s.write(md(array, "sync_action"), "idle");
    await deps.wait(1000);
    if (action === "cancel") await s.write(md(array, "sync_min"), "0");
    const now = (await s.read(md(array, "sync_action")))?.trim();
    if (now !== "idle") throw new RaidFailed(`${array} is still "${now}".`);
    return {
      target: array,
      result:
        action === "pause"
          ? `The check on ${array} is paused.`
          : `The check on ${array} was cancelled.`,
      ...(action === "pause" && Number.isFinite(done) ? { data: { position: done } } : {}),
    };
  }
  if (action === "resume") {
    if (st.action !== "idle") throw new RaidRefused(`${array} is busy (${st.action}).`, "stale");
    const pos = params.position;
    if (typeof pos !== "number" || !Number.isInteger(pos) || pos < 0)
      throw new RaidRefused("Where to resume from is not valid.");
    const chunkBytes = Number((await s.read(md(array, "chunk_size")))?.trim() || 0);
    const step = Math.max(8, chunkBytes / 512 || 8);
    await s.write(md(array, "sync_min"), String(Math.floor(pos / step) * step));
    await s.write(md(array, "sync_max"), "max");
    await s.write(md(array, "sync_action"), "check");
    await deps.wait(1500);
    return { target: array, result: `The check on ${array} continues from where it stopped.` };
  }
  throw new RaidRefused("The check action is not valid.");
}

/** raid.speed: the array's own rebuild and check speed limits (or back to the system's). */
export async function raidSpeed(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const array = arrayParam(deps, params.array);
  await arrayState(deps, array);
  const s = sysOf(deps);
  const val = (v: unknown, name: string) => {
    if (v === "system") return "system";
    if (typeof v !== "number" || !Number.isInteger(v) || v < 100 || v > 10_000_000)
      throw new RaidRefused(`${name} must be between 100 and 10,000,000 KiB/s, or "system".`);
    return String(v);
  };
  const min = val(params.minKiBs, "The minimum");
  const max = val(params.maxKiBs, "The maximum");
  if (min !== "system" && max !== "system" && Number(min) > Number(max))
    throw new RaidRefused("The minimum must not be above the maximum.");
  await s.write(md(array, "sync_speed_max"), max);
  await s.write(md(array, "sync_speed_min"), min);
  const readMin = (await s.read(md(array, "sync_speed_min")))?.trim() ?? "";
  const readMax = (await s.read(md(array, "sync_speed_max")))?.trim() ?? "";
  return {
    target: array,
    result: `${array} rebuild and check speed: at least ${readMin}, at most ${readMax} KiB/s.`,
  };
}

/** raid.grow: another member, the drives' full size, or the filesystem to the array's size. */
export async function raidGrow(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const array = arrayParam(deps, params.array);
  const st = await arrayState(deps, array);
  const s = sysOf(deps);
  const mode = params.mode;
  if (mode === "devices") {
    if (!TOLERANCE[st.level]) throw new RaidRefused(`Hearth does not grow ${st.level} by members.`);
    if (st.degraded > 0 || st.action !== "idle")
      throw new RaidRefused(`${array} must be whole and idle to grow.`, "stale");
    const want = params.raidDevices;
    if (typeof want !== "number" || want !== st.raidDisks + 1)
      throw new RaidRefused(
        `Growing adds one member at a time (from ${st.raidDisks} to ${st.raidDisks + 1}).`,
        "stale",
      );
    if (typeof params.device === "string") {
      const device = driveParam(deps, params.device);
      await checkNewDrive(deps, device, params);
      await mdadm(deps, ["--manage", array, "--add-spare", device]);
    }
    await mdadm(deps, ["--grow", array, `--raid-devices=${want}`], 300_000);
    const now = Number((await s.read(md(array, "raid_disks")))?.trim());
    if (now !== want) throw new RaidFailed(`${array} has ${now} members afterwards, not ${want}.`);
    return {
      target: array,
      result: `${array} now has ${want} members; the kernel is ${st.level === "raid1" ? "copying onto the new mirror" : "reshaping the data across them"}.`,
    };
  }
  if (mode === "size") {
    if (st.degraded > 0 || st.action !== "idle")
      throw new RaidRefused(`${array} must be whole and idle to grow.`, "stale");
    const before = Number((await s.read(md(array, "component_size")))?.trim());
    await mdadm(deps, ["--grow", array, "--size=max"], 300_000);
    const after = Number((await s.read(md(array, "component_size")))?.trim());
    if (!(after > before))
      throw new RaidFailed(`${array}'s member size did not grow (${before} KiB).`);
    return {
      target: array,
      result: `Each member of ${array} now gives ${Math.round(after / 1024 / 1024)} GiB (was ${Math.round(before / 1024 / 1024)}). Grow the filesystem next to use it.`,
    };
  }
  if (mode === "filesystem") {
    const r = await deps.run("lsblk", ["-J", "-b", "-o", "FSTYPE,MOUNTPOINT,FSSIZE", array], {
      timeoutMs: 15_000,
    });
    const node = (
      JSON.parse(r.out || "{}") as {
        blockdevices?: { fstype?: string; mountpoint?: string; fssize?: number | string }[];
      }
    ).blockdevices?.[0];
    const fstype = node?.fstype;
    if (fstype === "ext4" || fstype === "ext3") {
      const g = await deps.run("resize2fs", [array], { timeoutMs: 1_800_000 });
      if (g.code !== 0)
        throw new RaidFailed(`resize2fs did not succeed: ${g.out.trim().slice(-300)}`);
      return {
        target: array,
        result: `The ${fstype} filesystem on ${array} was grown to the array's size.`,
      };
    }
    if (fstype === "xfs") {
      if (!node?.mountpoint) throw new RaidRefused("XFS grows only while mounted.");
      const g = await deps.run("xfs_growfs", [node.mountpoint], { timeoutMs: 1_800_000 });
      if (g.code !== 0)
        throw new RaidFailed(`xfs_growfs did not succeed: ${g.out.trim().slice(-300)}`);
      return {
        target: array,
        result: `The XFS filesystem at ${node.mountpoint} was grown to the array's size.`,
      };
    }
    throw new RaidRefused(`Hearth grows ext4 and XFS; ${array} has ${fstype ?? "no filesystem"}.`);
  }
  throw new RaidRefused("The grow mode is not valid.");
}

/** raid.create: a new array from approved, checked drives (and a filesystem on it, if asked). */
export async function raidCreate(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const level = params.level;
  if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level))
    throw new RaidRefused("The level must be raid0, raid1, raid5, raid6, or raid10.");
  const list = Array.isArray(params.devices)
    ? (params.devices as { device?: unknown; serial?: unknown; erase?: unknown }[])
    : [];
  if (list.length < MIN_DEVICES[level]!)
    throw new RaidRefused(`${level} needs at least ${MIN_DEVICES[level]} drives.`);
  if (list.length > 32) throw new RaidRefused("Too many drives.");
  const name =
    typeof params.name === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(params.name)
      ? params.name
      : undefined;
  if (!name)
    throw new RaidRefused("The array's name must be letters, digits, dashes, or underscores.");
  const devices: string[] = [];
  for (const d of list) {
    const dev = driveParam(deps, d.device);
    if (devices.includes(dev)) throw new RaidRefused(`${dev} is listed twice.`);
    devices.push(dev);
  }
  // Two partitions of one drive in one array give no protection.
  const disks = new Set<string>();
  for (const d of list) {
    const { disk } = await treeOf(deps, String(d.device));
    const k = disk.kname ?? disk.name ?? "";
    if (disks.has(k) && level !== "raid0")
      throw new RaidRefused(`Two members are on the same drive (${k}); that protects nothing.`);
    disks.add(k);
  }
  const erased: string[] = [];
  for (const d of list) {
    const r = await checkNewDrive(deps, String(d.device), d);
    if (r.erased.length) erased.push(String(d.device));
  }
  const used = new Set(
    [...(await mdstat(deps)).matchAll(/^md(\d+)\s*:/gm)].map((m) => Number(m[1])),
  );
  let n = 0;
  while (used.has(n) || (await sysOf(deps).isBlock(`/dev/md${n}`))) n++;
  const array = `/dev/md${n}`;
  await mdadm(
    deps,
    [
      "--create",
      array,
      "--run",
      `--level=${level}`,
      `--raid-devices=${devices.length}`,
      "--metadata=1.2",
      `--name=${name}`,
      ...(level === "raid0" ? [] : ["--bitmap=internal"]),
      ...devices,
    ],
    300_000,
  );
  const got = (await sysOf(deps).read(md(array, "level")))?.trim();
  if (got !== level)
    throw new RaidFailed(`${array} reports level "${got}" afterwards, not ${level}.`);
  let fs = "";
  if (params.mkfs === "ext4") {
    const m = await deps.run("mkfs.ext4", ["-q", "-L", name.slice(0, 16), array], {
      timeoutMs: 1_800_000,
    });
    if (m.code !== 0)
      throw new RaidFailed(
        `The array was created, but mkfs.ext4 did not succeed: ${m.out.trim().slice(-300)}`,
      );
    fs = " with an empty ext4 filesystem (not mounted)";
  }
  return {
    target: array,
    result: `Created ${array} (${name}, ${level}) from ${devices.join(", ")}${erased.length ? `, after erasing ${erased.join(", ")}` : ""}${fs}. The kernel is bringing the members into step; it is usable meanwhile.`,
    data: { array },
  };
}
