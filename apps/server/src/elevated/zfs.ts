import fs from "node:fs/promises";
import path from "node:path";
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
 * The elevated executor's ZFS operations. Like the mdadm ones: typed, only pool and drive names
 * from the request, the machine checked here before acting (never trusting what Hearth saw), fixed
 * zpool commands, and the pool read back afterwards. Existing members are named to zpool by their
 * GUID, so a renamed device path can never point a command at the wrong drive.
 *
 * Never, whatever the request says: a drive holding the system, mounted, in another array or pool,
 * or holding data unless erasing it was approved with its serial; detaching or taking offline a
 * drive zpool says the pool cannot spare.
 */

const POOL = /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/;
const RESERVED = /^(mirror|raidz|draid|spare|log|cache|special|dedup|c[0-9])/;
const GUID = /^\d{5,20}$/;
const LEVELS = ["mirror", "raidz1", "raidz2", "raidz3", "stripe"] as const;
const MIN: Record<string, number> = { mirror: 2, raidz1: 3, raidz2: 4, raidz3: 5, stripe: 1 };

async function zpool(deps: RaidDeps, args: string[], timeoutMs = 120_000) {
  const r = await deps.run("zpool", args, { timeoutMs });
  if (r.code !== 0)
    throw new RaidFailed(`zpool ${args[0]} did not succeed: ${r.out.trim().slice(-400)}`);
  return r.out;
}

function poolParam(v: unknown) {
  if (typeof v !== "string" || !POOL.test(v) || RESERVED.test(v))
    throw new RaidRefused("The pool's name is not valid.");
  return v;
}

/**
 * Runs a command through systemd-run --wait (outside the executor's sandbox and mount namespace),
 * passing its output back; directly where there is no systemd (tests).
 */
async function outside(deps: RaidDeps, cmd: string, args: string[], timeoutMs = 300_000) {
  let r = await deps.run(
    "systemd-run",
    [
      "--wait",
      "--pipe",
      "--collect",
      "--quiet",
      `--description=Hearth: ${cmd} ${args[0]}`,
      cmd,
      ...args,
    ],
    { timeoutMs },
  );
  if (r.code === 127) r = await deps.run(cmd, args, { timeoutMs });
  if (r.code !== 0)
    throw new RaidFailed(`${cmd} ${args[0]} did not succeed: ${r.out.trim().slice(-400)}`);
  return r.out;
}

async function poolExists(deps: RaidDeps, pool: string) {
  const r = await deps.run("zpool", ["list", "-H", "-o", "name", pool], { timeoutMs: 15_000 });
  return r.code === 0 && r.out.trim() === pool;
}

/** The pool's drives: device path (resolved) and GUID, in tree order, with their state. */
async function members(deps: RaidDeps, pool: string) {
  const rows = (args: string[]) =>
    deps.run("zpool", ["status", ...args, pool], { timeoutMs: 15_000 }).then((r) => {
      if (r.code !== 0) throw new RaidRefused(`${pool} is not an imported pool.`, "stale");
      const cfg = r.out.split(/^\s*config:\s*$/m)[1]?.split(/^\s*errors:/m)[0] ?? "";
      return cfg
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter((c) => c[0] && c[0] !== "NAME");
    });
  const named = await rows(["-P", "-L"]);
  const guids = await rows(["-g"]);
  const out: { device: string; guid?: string; state: string; section: string }[] = [];
  let section = "data";
  named.forEach((c, i) => {
    if (["logs", "cache", "spares", "special", "dedup"].includes(c[0]!)) section = c[0]!;
    const g = guids[i]?.[0];
    if (c[0]!.startsWith("/dev/") || GUID.test(c[0]!))
      out.push({
        device: c[0]!,
        ...(g && GUID.test(g) ? { guid: g } : {}),
        state: c[1] ?? "",
        section,
      });
  });
  return out;
}

/** The member named (its path or GUID), as zpool knows it: by GUID. */
async function memberParam(deps: RaidDeps, pool: string, v: unknown, what = "The drive") {
  if (typeof v !== "string" || !(GUID.test(v) || /^\/dev\/[\w/.:+-]{1,200}$/.test(v)))
    throw new RaidRefused(`${what} must be a device path or a ZFS GUID.`);
  const all = await members(deps, pool);
  const m = all.find((x) => x.device === v || x.guid === v);
  if (!m) throw new RaidRefused(`${v} is not a drive in ${pool}.`, "stale");
  return m;
}

/** A stable name for a whole drive (/dev/disk/by-id/...), so the pool finds it after a reboot. */
async function stableName(deps: RaidDeps, device: string) {
  if (/^\/dev\/loop/.test(device)) return device;
  const dir = "/dev/disk/by-id";
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const want = await fs.realpath(device).catch(() => device);
  const hits: string[] = [];
  for (const n of names) {
    if (/-part\d+$/.test(n)) continue;
    const to = await fs.realpath(path.join(dir, n)).catch(() => "");
    if (to === want) hits.push(n);
  }
  // Readable names first (ata-, nvme-, scsi-), then the WWN.
  hits.sort((a, b) => Number(/^wwn-|^nvme-eui/.test(a)) - Number(/^wwn-|^nvme-eui/.test(b)));
  return hits[0] ? path.join(dir, hits[0]) : device;
}

/** A drive joining a pool: every check of an mdadm member, and given to ZFS whole. */
async function newDrive(deps: RaidDeps, v: unknown, params: { serial?: unknown; erase?: unknown }) {
  const device = driveParam(deps, v);
  if (/\d$/.test(device) && !/^\/dev\/(nvme\d+n\d+|loop\d+)$/.test(device))
    throw new RaidRefused("ZFS is given whole drives (like /dev/sdb), not partitions.");
  const d = await checkNewDrive(deps, device, params);
  return { device, by: await stableName(deps, device), ...d };
}

async function scanLine(deps: RaidDeps, pool: string) {
  const r = await deps.run("zpool", ["status", pool], { timeoutMs: 15_000 });
  return /^\s*scan:\s*(.*)$/m.exec(r.out)?.[1]?.trim() ?? "";
}

/** zfs.scrub: start (or resume a paused one), pause, or cancel a scrub. */
export async function zfsScrub(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const pool = poolParam(params.pool);
  if (!(await poolExists(deps, pool)))
    throw new RaidRefused(`${pool} is not an imported pool.`, "stale");
  const before = await scanLine(deps, pool);
  if (params.action === "start") {
    if (/resilver in progress/.test(before))
      throw new RaidRefused(`${pool} is rebuilding; scrub after it finishes.`, "stale");
    if (/scrub in progress/.test(before))
      throw new RaidRefused(`${pool} is already being scrubbed.`, "stale");
    await zpool(deps, ["scrub", pool]);
    await deps.wait(1000);
    const now = await scanLine(deps, pool);
    return {
      target: pool,
      result: `${/paused/.test(before) ? "The scrub continues" : "A scrub started"} on ${pool}.`,
      evidence: [{ label: "scan", value: now }],
    };
  }
  if (params.action === "pause" || params.action === "cancel") {
    if (
      !/scrub in progress/.test(before) &&
      !(params.action === "cancel" && /scrub paused/.test(before))
    )
      throw new RaidRefused(`${pool} is not being scrubbed; a rebuild is never stopped.`, "stale");
    await zpool(deps, ["scrub", params.action === "pause" ? "-p" : "-s", pool]);
    const now = await scanLine(deps, pool);
    if (/scrub in progress/.test(now))
      throw new RaidFailed(`The scrub on ${pool} is still running.`);
    return {
      target: pool,
      result:
        params.action === "pause"
          ? `The scrub on ${pool} is paused.`
          : `The scrub on ${pool} was stopped.`,
      evidence: [{ label: "scan", value: now }],
    };
  }
  throw new RaidRefused("The scrub action is not valid.");
}

/** zfs.member: replace, add or remove a spare, take offline or bring online, detach, attach. */
export async function zfsMember(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const pool = poolParam(params.pool);
  const action = params.action;
  const force = params.erase === true ? ["-f"] : [];
  const after = async (device: string) => {
    const all = await members(deps, pool);
    const real = await fs.realpath(device).catch(() => device);
    return all.find((m) => m.device === real || m.device === device || m.device.startsWith(real));
  };
  if (action === "replace") {
    const old = await memberParam(deps, pool, params.replaces, "The drive being replaced");
    if (old.section === "spares") throw new RaidRefused("A spare is removed, not replaced.");
    const d = await newDrive(deps, params.device, params);
    await zpool(deps, ["replace", ...force, pool, old.guid ?? old.device, d.by], 300_000);
    const now = await after(d.device);
    if (!now) throw new RaidFailed(`${d.device} does not show in ${pool} afterwards.`);
    return {
      target: `${pool} ${d.device}`,
      result: `${d.device}${d.serial ? ` (serial ${d.serial})` : ""} is replacing ${old.device} in ${pool}${d.erased.length ? `, after erasing ${d.erased.join(", ")}` : ""}; ZFS is rebuilding onto it.`,
      evidence: [{ label: "new drive", value: `${now.device} ${now.state}` }],
    };
  }
  if (action === "add-spare") {
    const d = await newDrive(deps, params.device, params);
    await zpool(deps, ["add", ...force, pool, "spare", d.by]);
    const now = await after(d.device);
    if (!now || now.section !== "spares")
      throw new RaidFailed(`${d.device} is not a spare of ${pool} afterwards.`);
    return {
      target: `${pool} ${d.device}`,
      result: `${d.device}${d.serial ? ` (serial ${d.serial})` : ""} is a hot spare of ${pool}.`,
    };
  }
  if (action === "attach") {
    const target = params.target;
    let to: string;
    if (typeof target === "string" && /^raidz[123]?-\d+$/.test(target)) to = target;
    else
      to = (await memberParam(deps, pool, target, "The drive to attach to")).guid ?? String(target);
    const d = await newDrive(deps, params.device, params);
    await zpool(deps, ["attach", ...force, pool, to, d.by], 300_000);
    const now = await after(d.device);
    if (!now) throw new RaidFailed(`${d.device} does not show in ${pool} afterwards.`);
    return {
      target: `${pool} ${d.device}`,
      result: `${d.device}${d.serial ? ` (serial ${d.serial})` : ""} was added to ${to} in ${pool}; ZFS is copying onto it.`,
    };
  }
  const m = await memberParam(deps, pool, params.device);
  const id = m.guid ?? m.device;
  if (action === "remove-spare") {
    if (m.section !== "spares") throw new RaidRefused(`${m.device} is not a spare.`, "stale");
    await zpool(deps, ["remove", pool, id]);
    if (await after(m.device)) throw new RaidFailed(`${m.device} is still in ${pool}.`);
    return {
      target: `${pool} ${m.device}`,
      result: `The spare ${m.device} was removed from ${pool}. It was not erased.`,
    };
  }
  if (action === "offline") {
    if (m.state !== "ONLINE")
      throw new RaidRefused(`${m.device} is ${m.state}, not online.`, "stale");
    // zpool refuses on its own when the pool has no other copy; that answer is passed on.
    await zpool(deps, ["offline", pool, id]);
    const now = (await members(deps, pool)).find((x) => x.guid === m.guid || x.device === m.device);
    if (now?.state !== "OFFLINE")
      throw new RaidFailed(`${m.device} is ${now?.state ?? "gone"} afterwards, not offline.`);
    return {
      target: `${pool} ${m.device}`,
      result: `${m.device} is offline in ${pool}. Bring it back online or replace it.`,
    };
  }
  if (action === "online") {
    await zpool(deps, ["online", pool, id]);
    const now = (await members(deps, pool)).find((x) => x.guid === m.guid || x.device === m.device);
    return {
      target: `${pool} ${m.device}`,
      result: `${m.device} is ${now?.state ?? "back"} in ${pool}; ZFS copies what changed while it was away.`,
    };
  }
  if (action === "detach") {
    await zpool(deps, ["detach", pool, id]);
    if ((await members(deps, pool)).some((x) => x.guid === m.guid))
      throw new RaidFailed(`${m.device} is still in ${pool}.`);
    return {
      target: `${pool} ${m.device}`,
      result: `${m.device} was detached from its mirror in ${pool}. It was not erased.`,
    };
  }
  throw new RaidRefused("The drive action is not valid.");
}

/** zfs.clear: forget the pool's error counts (and retry a faulted drive). */
export async function zfsClear(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const pool = poolParam(params.pool);
  if (!(await poolExists(deps, pool)))
    throw new RaidRefused(`${pool} is not an imported pool.`, "stale");
  await zpool(deps, ["clear", pool]);
  const health = (
    await deps.run("zpool", ["list", "-H", "-o", "health", pool], { timeoutMs: 15_000 })
  ).out.trim();
  return { target: pool, result: `${pool}'s error counts were cleared; it reports ${health}.` };
}

/** zfs.grow: use the drives' full size (autoexpand, then each drive expanded). */
export async function zfsGrow(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const pool = poolParam(params.pool);
  if (params.mode !== "expand") throw new RaidRefused("The grow mode is not valid.");
  const sizeOf = async () =>
    Number(
      (
        await deps.run("zpool", ["list", "-H", "-p", "-o", "size", pool], { timeoutMs: 15_000 })
      ).out.trim(),
    );
  const before = await sizeOf();
  if (!Number.isFinite(before)) throw new RaidRefused(`${pool} is not an imported pool.`, "stale");
  await zpool(deps, ["set", "autoexpand=on", pool]);
  for (const m of await members(deps, pool))
    if (m.section === "data" && m.state === "ONLINE")
      await zpool(deps, ["online", "-e", pool, m.guid ?? m.device]);
  const now = await sizeOf();
  return {
    target: pool,
    result:
      now > before
        ? `${pool} grew from ${Math.round(before / 1e9)} GB to ${Math.round(now / 1e9)} GB (raw).`
        : `${pool} is ${Math.round(now / 1e9)} GB; there was no unused space to take.`,
  };
}

/** zfs.create: a new pool from approved, checked, whole drives, mounted at /mnt/<name>. */
export async function zfsCreate(params: Params, deps: RaidDeps): Promise<RaidResult> {
  const name = poolParam(params.name);
  const level = params.level;
  if (typeof level !== "string" || !(LEVELS as readonly string[]).includes(level))
    throw new RaidRefused("The layout must be mirror, raidz1, raidz2, raidz3, or stripe.");
  const list = Array.isArray(params.devices)
    ? (params.devices as { device?: unknown; serial?: unknown; erase?: unknown }[])
    : [];
  if (list.length < MIN[level]!)
    throw new RaidRefused(`${level} needs at least ${MIN[level]} drives.`);
  if (list.length > 32) throw new RaidRefused("Too many drives.");
  if (await poolExists(deps, name))
    throw new RaidRefused(`A pool named ${name} already exists.`, "stale");
  const mount = `/mnt/${name}`;
  const inside = await fs.readdir(mount).catch(() => [] as string[]);
  if (inside.length) throw new RaidRefused(`${mount} already holds files; choose another name.`);
  const seen = new Set<string>();
  const drives: Awaited<ReturnType<typeof newDrive>>[] = [];
  for (const d of list) {
    const dev = driveParam(deps, d.device);
    if (seen.has(dev)) throw new RaidRefused(`${dev} is listed twice.`);
    seen.add(dev);
    drives.push(await newDrive(deps, dev, d));
  }
  const force = list.some((d) => d.erase === true) ? ["-f"] : [];
  // Outside the executor's sandbox (its own mount namespace), so the new pool's mount is the
  // machine's, not only the sandbox's.
  await outside(
    deps,
    "zpool",
    [
      "create",
      ...force,
      "-o",
      "ashift=12",
      "-O",
      "compression=lz4",
      "-O",
      "atime=off",
      "-m",
      mount,
      name,
      ...(level === "stripe" ? [] : [level]),
      ...drives.map((d) => d.by),
    ],
    300_000,
  );
  if (!(await poolExists(deps, name))) throw new RaidFailed(`${name} does not show afterwards.`);
  const erased = drives.filter((d) => d.erased.length).map((d) => d.device);
  return {
    target: name,
    result: `Created the ZFS pool ${name} (${level}) from ${drives.map((d) => d.device).join(", ")}${erased.length ? `, after erasing ${erased.join(", ")}` : ""}, mounted at ${mount}.`,
    data: { pool: name, mount },
  };
}
