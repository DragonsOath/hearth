import { randomBytes } from "node:crypto";
import { constants as fsc } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_CONTENT_BYTES,
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  READ_OPERATIONS,
  WINDOWS_RAID_OPERATIONS,
  canonical,
  checkAuthorization,
  sha256hex,
  type Authorization,
  type ElevatedRequest,
  type ElevatedResponse,
  type Evidence,
  type ExecutorStatus,
  type OperationName,
  type Params,
} from "./protocol";
import {
  RaidFailed,
  RaidRefused,
  raidCreate,
  raidGrow,
  raidMember,
  raidSpeed,
  raidSync,
} from "./raid";
import { zfsClear, zfsCreate, zfsGrow, zfsMember, zfsScrub } from "./zfs";
import { btrfsBalance, btrfsClear, btrfsCreate, btrfsMember, btrfsScrub } from "./btrfs";
import { snapraidRun } from "./snapraid";
import { spacesCreate, spacesGrow, spacesMember, spacesRepair } from "./spaces";
import { storageRead } from "./storage-read";
import { ancestors, windowsProblems } from "./windows";

/**
 * Hearth's elevated executor (private/docs/HEARTH_COMPOSE_ACCESS_PROPOSAL.md). It runs as root,
 * one process per request, started by systemd on a socket only Hearth's service account can
 * reach. It performs a fixed catalog of typed operations, each one:
 *
 * - inside the root-owned scope file (folders, operations, units) and never on the executor's own
 *   files or anything that would hand out raw privileged access (sudo, accounts, logins);
 * - only with a single-use authorization for exactly that request, signed by Hearth's backend;
 * - only when the target is still as approved (fingerprints, metadata), so stale approvals and
 *   changed targets do nothing;
 * - with a backup first, verification after (reading the result back, never trusting an exit
 *   code), and a put-back when verification fails;
 * - recorded in a hash-chained, append-only log Hearth can read but not change.
 *
 * Node built-ins only, so it ships as one file. Everything that touches the system beyond plain
 * files (docker, systemctl, getfacl) goes through `deps.run`, so tests can stand in for it.
 */

export interface ExecutorConfig {
  version: 1;
  /** Folders operations may act inside (never on a root itself). */
  roots: string[];
  /** Operations switched on. */
  operations: OperationName[];
  /** systemd units unit.control may act on. */
  units: string[];
  /** Where backups go: <backupRoot>/<key>/<time>-hearth-elevated-<reason>/. */
  backupRoot: string;
  /** Group that may read backups (Hearth's service group), so Hearth can show and restore them. */
  backupGid?: number;
  stateDir: string;
  auditLog: string;
  keyFile: string;
  /** RAID operations may use loop devices: only for throwaway test arrays. */
  raidAllowLoop?: boolean;
  /** Windows: the accounts (SIDs) that may read the key and the log: Hearth's own account. */
  readerSids?: string[];
}

export interface RunResult {
  code: number;
  out: string;
}

export interface ExecutorDeps {
  run(
    cmd: string,
    args: string[],
    opts?: { input?: string; timeoutMs?: number },
  ): Promise<RunResult>;
  now(): number;
  wait(ms: number): Promise<void>;
  /** Running as root: ownership is checked and set, the setup must be root-owned. */
  isRoot: boolean;
  /**
   * Running as Windows' SYSTEM account (the Windows executor): its files' permissions are checked
   * by SID instead, and only the storage operations are offered.
   */
  windowsSystem?: boolean;
  /** The executor's own program and config file: never a target. */
  selfPaths: string[];
  /** Whether a path is a block device (a drive). Tests stand in for it. */
  isBlockDevice?(p: string): Promise<boolean>;
  /** The kernel's md files (/sys, /proc), for RAID operations. Tests stand in for them. */
  raidSys?: {
    read(p: string): Promise<string | undefined>;
    write(p: string, v: string): Promise<void>;
    isBlock(p: string): Promise<boolean>;
  };
}

class Refused extends Error {
  constructor(
    message: string,
    readonly outcome: "refused" | "stale" = "refused",
  ) {
    super(message);
  }
}

const under = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

/* ---------- configuration ---------- */

export async function loadConfig(file: string): Promise<ExecutorConfig> {
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ExecutorConfig>;
  const list = (x: unknown) =>
    Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
  const str = (x: unknown, name: string) => {
    if (typeof x !== "string" || !path.isAbsolute(x))
      throw new Error(`${name} must be an absolute path.`);
    return path.normalize(x);
  };
  return {
    version: 1,
    roots: list(raw.roots).map((r) => str(r, "Each root")),
    operations: list(raw.operations).filter((o): o is OperationName =>
      (OPERATION_NAMES as readonly string[]).includes(o),
    ),
    units: list(raw.units),
    backupRoot: str(raw.backupRoot, "backupRoot"),
    ...(typeof raw.backupGid === "number" ? { backupGid: raw.backupGid } : {}),
    stateDir: str(raw.stateDir, "stateDir"),
    auditLog: str(raw.auditLog, "auditLog"),
    keyFile: str(raw.keyFile, "keyFile"),
    ...(raw.raidAllowLoop === true ? { raidAllowLoop: true } : {}),
    ...(Array.isArray(raw.readerSids)
      ? { readerSids: list(raw.readerSids).filter((s) => /^S-1-[\d-]{1,100}$/.test(s)) }
      : {}),
  };
}

/** Problems with the executor's own setup. Any problem makes it refuse every change. */
export async function setupProblems(
  cfg: ExecutorConfig,
  cfgFile: string,
  deps: ExecutorDeps,
): Promise<string[]> {
  const problems: string[] = [];
  for (const r of cfg.roots) {
    if (path.parse(r).root === r) problems.push(`A root may not be the whole filesystem (${r}).`);
    const posix = r.replaceAll("\\", "/");
    if (PRIVILEGE_PATHS.some((d) => posix === d || posix.startsWith(`${d}/`)))
      problems.push(`A root may not be inside a system area the executor never changes (${r}).`);
  }
  if (deps.windowsSystem) {
    // On Windows only the storage operations exist; the file operations assume Linux owners.
    const other = cfg.operations.filter(
      (o) => !(WINDOWS_RAID_OPERATIONS as readonly string[]).includes(o),
    );
    if (other.length)
      problems.push(
        `On Windows the executor offers only the storage operations (not ${other.join(", ")}).`,
      );
    const program = deps.selfPaths[0] ?? "";
    const readers = [...(cfg.readerSids ?? [])];
    return [
      ...problems,
      ...(await windowsProblems(
        [
          { path: process.execPath, label: "Node.js" },
          { path: program, label: "The executor's program" },
          ...[...new Set([...ancestors(process.execPath), ...ancestors(program)])].map((p) => ({
            path: p,
            label: "A folder above the executor's program",
          })),
          { path: cfgFile, label: "The scope file" },
          { path: cfg.keyFile, label: "The key file", readers },
          { path: cfg.stateDir, label: "The state folder", readers: [] },
          { path: path.dirname(cfg.auditLog), label: "The log folder", readers },
          { path: cfg.backupRoot, label: "The backup folder", readers },
        ],
        deps.run,
      )),
    ];
  }
  if (!deps.isRoot) return problems;
  // The program that runs every request, and every folder above it, must be root's alone:
  // otherwise whoever can change it runs code as root.
  for (const p of [process.execPath, ...deps.selfPaths.slice(0, 1)]) {
    let cur = await fs.realpath(p).catch(() => p);
    for (;;) {
      const st = await fs.stat(cur).catch(() => undefined);
      if (!st) {
        problems.push(`${cur} is missing.`);
        break;
      }
      if (st.uid !== 0 || st.mode & 0o022)
        problems.push(`${cur} can be changed by an account other than root, and it runs as root.`);
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  const rootOwned = async (p: string, label: string) => {
    const st = await fs.lstat(p).catch(() => undefined);
    if (!st) return problems.push(`${label} (${p}) is missing.`);
    if (st.isSymbolicLink()) return problems.push(`${label} (${p}) is a symbolic link.`);
    if (st.uid !== 0) problems.push(`${label} (${p}) is not owned by root.`);
    if (st.mode & 0o022) problems.push(`${label} (${p}) is writable by others.`);
  };
  await rootOwned(cfgFile, "The scope file");
  await rootOwned(cfg.keyFile, "The key file");
  const key = await fs.lstat(cfg.keyFile).catch(() => undefined);
  if (key && key.mode & 0o004)
    problems.push(`The key file (${cfg.keyFile}) is readable by everyone.`);
  await rootOwned(cfg.stateDir, "The state folder");
  const state = await fs.lstat(cfg.stateDir).catch(() => undefined);
  if (state && state.mode & 0o077)
    problems.push(`The state folder (${cfg.stateDir}) is open to others.`);
  await rootOwned(path.dirname(cfg.auditLog), "The log folder");
  // The ledger may belong to the owner; the executor's own backups inside it are root-owned and
  // checked one by one before any restore (readOwnBackup).
  const b = await fs.lstat(cfg.backupRoot).catch(() => undefined);
  if (!b?.isDirectory() || b.isSymbolicLink())
    problems.push(`The backup folder (${cfg.backupRoot}) is missing or a link.`);
  return problems;
}

/* ---------- paths ---------- */

/**
 * Paths that would hand out raw privileged access (accounts, sudo, logins, code that root or the
 * system runs on its own: services, timers, cron, shell start-up, the loader, kernel modules,
 * devices, system software): never targets, whatever the scope says.
 */
const PRIVILEGE_PATHS = [
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/sudo.conf",
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/passwd",
  "/etc/group",
  "/etc/pam.d",
  "/etc/security",
  "/etc/polkit-1",
  "/etc/ld.so.preload",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/environment",
  "/etc/profile",
  "/etc/profile.d",
  "/etc/bash.bashrc",
  "/etc/cron.d",
  "/etc/cron.hourly",
  "/etc/cron.daily",
  "/etc/cron.weekly",
  "/etc/cron.monthly",
  "/etc/crontab",
  "/var/spool/cron",
  "/etc/systemd",
  "/etc/init.d",
  "/etc/rc.local",
  "/etc/udev",
  "/etc/modprobe.d",
  "/etc/modules-load.d",
  "/etc/docker",
  "/etc/ssh",
  "/etc/hearth",
  "/root",
  "/boot",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/run/systemd",
  "/var/lib/systemd",
];

/** Whether a mode would make a program run with its owner's or group's privileges. */
const PRIVILEGED_BITS = 0o6000;

function deniedWhy(p: string, cfg: ExecutorConfig, deps: ExecutorDeps): string | undefined {
  const self = [
    ...deps.selfPaths,
    cfg.keyFile,
    cfg.stateDir,
    cfg.auditLog,
    path.dirname(cfg.auditLog),
  ].map((x) => path.normalize(x));
  if (self.some((s) => under(p, s) || under(s, p)))
    return "it is part of the executor itself (its program, scope, key, state, or log)";
  const posix = p.replaceAll("\\", "/");
  if (PRIVILEGE_PATHS.some((d) => posix === d || posix.startsWith(`${d}/`)))
    return "it controls accounts, logins, services, or software the system runs as root: changing it would hand out raw privileged access, which Hearth never does";
  if (/\/hearth-elevated[^/]*$/.test(posix))
    return "it defines Hearth's own services: changing it could widen Hearth's own privileges";
  const base = path.basename(p);
  if (/^authorized_keys2?$/.test(base)) return "it decides who may log in over SSH";
  if (p.split(path.sep).some((c) => c.includes("-hearth-elevated-")))
    return "it is one of the executor's own backups, which only the executor writes";
  return undefined;
}

/**
 * A target path the executor may act on: absolute and already normalized (no "..", no doubled
 * separators), strictly inside a scope root, not denied, and with no symbolic link anywhere from
 * the filesystem root down to it. Returns the path's current state (undefined when absent).
 */
async function targetOf(
  raw: unknown,
  cfg: ExecutorConfig,
  deps: ExecutorDeps,
  opts: { mustExist?: boolean; mustNotExist?: boolean } = {},
) {
  if (typeof raw !== "string" || !raw || raw.length > 4096 || raw.includes("\0"))
    throw new Refused("The path is missing or not valid.");
  if (!path.isAbsolute(raw)) throw new Refused(`${raw} is not an absolute path.`);
  const p = path.normalize(raw);
  if (p !== raw || raw.split(/[\\/]/).some((c) => c === ".." || c === "."))
    throw new Refused(`${raw} is not in plain form (no "..", ".", or doubled separators).`);
  if (p.endsWith(path.sep)) throw new Refused(`${raw} ends with a separator.`);
  const root = cfg.roots.find((r) => under(p, r) && p !== r);
  if (!root)
    throw new Refused(
      `${p} is outside the executor's scope (${cfg.roots.join(", ") || "no folders"}). Widening the scope is an owner step on the machine itself.`,
    );
  const denied = deniedWhy(p, cfg, deps);
  if (denied) throw new Refused(`${p} is never changed through the executor: ${denied}.`);
  // No symbolic link anywhere on the way: a link could point the change outside the scope.
  const parts = p.slice(path.parse(p).root.length).split(path.sep);
  let cur = path.parse(p).root;
  for (const c of parts.slice(0, -1)) {
    cur = path.join(cur, c);
    const st = await fs.lstat(cur).catch(() => undefined);
    if (!st) throw new Refused(`${cur} does not exist.`);
    if (st.isSymbolicLink())
      throw new Refused(`${cur} is a symbolic link; the executor does not follow links.`);
    if (!st.isDirectory()) throw new Refused(`${cur} is not a folder.`);
  }
  const parent = path.dirname(p);
  if ((await fs.realpath(parent)) !== parent)
    throw new Refused(`${parent} does not resolve to itself; the executor does not follow links.`);
  const st = await fs.lstat(p).catch(() => undefined);
  if (st?.isSymbolicLink())
    throw new Refused(`${p} is a symbolic link; the executor does not follow links.`);
  if (opts.mustExist && !st) throw new Refused(`${p} does not exist.`, "stale");
  if (opts.mustNotExist && st) throw new Refused(`${p} already exists.`, "stale");
  return { path: p, stat: st };
}

/* ---------- files ---------- */

export interface FileMeta {
  mode: number;
  uid: number;
  gid: number;
}

const metaOf = (st: { mode: number; uid: number; gid: number }): FileMeta => ({
  mode: st.mode & 0o7777,
  uid: st.uid,
  gid: st.gid,
});

const metaText = (m: FileMeta) =>
  `mode ${m.mode.toString(8).padStart(4, "0")}, owner ${m.uid}:${m.gid}`;

async function readRegular(p: string) {
  const st = await fs.lstat(p);
  if (!st.isFile()) throw new Refused(`${p} is not a regular file.`);
  if (st.size > MAX_CONTENT_BYTES) throw new Refused(`${p} is larger than 1 MB.`);
  const buf = await fs.readFile(p);
  return { buf, hash: sha256hex(buf), meta: metaOf(st), nlink: st.nlink };
}

/** The file's extended access list (beyond owner, group, other), to carry over to a new version. */
async function aclOf(p: string, deps: ExecutorDeps): Promise<string | undefined> {
  if (!deps.isRoot) return undefined;
  const r = await deps
    .run("getfacl", ["--absolute-names", "--omit-header", "--", p])
    .catch(() => undefined);
  if (!r || r.code !== 0) return undefined;
  const extended = r.out
    .split("\n")
    .some((l) => /^(user|group):[^:]+:/.test(l) || l.startsWith("mask::"));
  return extended ? r.out : undefined;
}

/**
 * Replaces a file in one step (temporary file beside it, then rename), with the given metadata
 * and access list, then verifies by reading it back: content fingerprint, type, and metadata.
 */
async function writeVerified(
  p: string,
  content: Buffer,
  meta: FileMeta,
  acl: string | undefined,
  deps: ExecutorDeps,
): Promise<string | undefined> {
  const tmp = path.join(
    path.dirname(p),
    `.${path.basename(p)}.hearth-tmp-${randomBytes(4).toString("hex")}`,
  );
  if (meta.mode & PRIVILEGED_BITS)
    throw new Refused("The executor never writes a file that runs with its owner's privileges.");
  const parent = await fs.lstat(path.dirname(p));
  await fs.writeFile(tmp, content, { flag: "wx", mode: meta.mode & 0o777 });
  try {
    // Owner first: changing the owner afterwards would clear mode bits again.
    if (deps.isRoot) await fs.chown(tmp, meta.uid, meta.gid);
    await fs.chmod(tmp, meta.mode);
    if (acl && deps.isRoot) {
      const r = await deps.run("setfacl", ["--set-file=-", "--", tmp], { input: acl });
      if (r.code !== 0)
        throw new Error(`The access list could not be carried over: ${r.out.trim()}`);
    }
    // The folder must still be the one that was checked (not swapped for a link meanwhile).
    const again = await fs.lstat(path.dirname(p));
    if (again.ino !== parent.ino || again.dev !== parent.dev || again.isSymbolicLink())
      throw new Error(`${path.dirname(p)} changed while writing; nothing was replaced.`);
    await fs.rename(tmp, p);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  const after = await fs.lstat(path.dirname(p));
  if (after.ino !== parent.ino || after.dev !== parent.dev)
    return `${path.dirname(p)} changed while writing.`;
  return verifyFile(p, sha256hex(content), meta, deps);
}

/** Why the file is not as intended, or undefined when it is. */
async function verifyFile(
  p: string,
  hash: string,
  meta: FileMeta,
  deps: ExecutorDeps,
): Promise<string | undefined> {
  const st = await fs.lstat(p).catch(() => undefined);
  if (!st) return `${p} is missing after writing.`;
  if (!st.isFile()) return `${p} is not a regular file after writing.`;
  if ((await fs.realpath(p)) !== p) return `${p} does not resolve to itself after writing.`;
  if (sha256hex(await fs.readFile(p)) !== hash) return `${p} does not read back as intended.`;
  const now = metaOf(st);
  if (process.platform !== "win32" && now.mode !== meta.mode)
    return `${p} has ${metaText(now)}, not ${metaText(meta)}.`;
  if (deps.isRoot && (now.uid !== meta.uid || now.gid !== meta.gid))
    return `${p} has ${metaText(now)}, not ${metaText(meta)}.`;
  return undefined;
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const stamp = (ms: number) => {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
};

export interface BackupManifest {
  file: string;
  service: string;
  reason: string;
  beforeHash: string;
  afterHash?: string;
  at: string;
  mode: number;
  uid: number;
  gid: number;
  acl?: string;
  authId: string;
  jobId: string;
  step: number;
}

/** A backup of the file as it is now, in the ledger convention, readable by Hearth but not writable. */
async function backup(
  ctx: Ctx,
  key: string,
  file: string,
  current: { buf: Buffer; hash: string; meta: FileMeta },
  reason: string,
  afterHash?: string,
): Promise<string> {
  const { cfg, deps, auth } = ctx;
  const parent = path.join(cfg.backupRoot, key);
  const pst = await fs.lstat(parent).catch(() => undefined);
  if (pst?.isSymbolicLink())
    throw new Refused(`${parent} is a symbolic link; no backup is written there.`);
  if (!pst) await fs.mkdir(parent, { mode: 0o750 });
  const name = `${stamp(deps.now())}-hearth-elevated-${reason}-${auth.id.slice(0, 6)}`;
  const dir = path.join(parent, name);
  await fs.mkdir(dir, { mode: 0o750 });
  const manifest: BackupManifest = {
    file,
    service: key,
    reason,
    beforeHash: current.hash,
    ...(afterHash ? { afterHash } : {}),
    at: new Date(deps.now()).toISOString(),
    ...current.meta,
    ...(ctx.acl ? { acl: ctx.acl } : {}),
    authId: auth.id,
    jobId: auth.jobId,
    step: auth.step,
  };
  // The copy is never more readable than the original: a file only its owner could read stays
  // root's alone (Hearth then restores it through the executor, from the manifest it can read).
  const contentMode = current.meta.mode & 0o040 ? 0o640 : 0o600;
  const copy = path.join(dir, path.basename(file));
  const record = path.join(dir, "manifest.json");
  await fs.writeFile(copy, current.buf, { flag: "wx", mode: contentMode });
  await fs.writeFile(record, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o640 });
  if (deps.isRoot && cfg.backupGid !== undefined)
    for (const f of [dir, copy, record]) await fs.chown(f, 0, cfg.backupGid);
  // Explicit modes: the service's umask would otherwise narrow them.
  if (!pst) await fs.chmod(parent, 0o750);
  await fs.chmod(dir, 0o750);
  await fs.chmod(copy, contentMode);
  await fs.chmod(record, 0o640);
  return `${key}/${name}`;
}

/**
 * Reads one of the executor's own backups, only if it is safe to restore from: a plain id, inside
 * the backup folder, made by the executor (root-owned when running as root, so Hearth could not
 * have planted or changed it), for exactly this file, with content matching its manifest.
 */
async function readOwnBackup(ctx: Ctx, id: unknown, file: string) {
  if (
    typeof id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}\/\d{8}-\d{6}-hearth-elevated-[a-z-]+-[0-9a-f]{6}$/.test(id)
  )
    throw new Refused("That is not one of the executor's backups.");
  const dir = path.join(ctx.cfg.backupRoot, ...id.split("/"));
  for (const p of [path.dirname(dir), dir]) {
    const st = await fs.lstat(p).catch(() => undefined);
    if (!st || st.isSymbolicLink() || !st.isDirectory())
      throw new Refused(`The backup ${id} is not there.`, "stale");
  }
  const own = await fs.lstat(dir);
  if (ctx.deps.isRoot && (own.uid !== 0 || own.mode & 0o022))
    throw new Refused(
      `The backup ${id} is not the executor's own (owner or mode changed); it is not restored.`,
    );
  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as BackupManifest;
  if (manifest.file !== file)
    throw new Refused(`The backup ${id} is of ${manifest.file}, not ${file}.`);
  const content = path.join(dir, path.basename(file));
  const cst = await fs.lstat(content);
  if (!cst.isFile() || (ctx.deps.isRoot && (cst.uid !== 0 || cst.mode & 0o022)))
    throw new Refused(`The backup ${id} is not intact; it is not restored.`);
  const buf = await fs.readFile(content);
  if (sha256hex(buf) !== manifest.beforeHash)
    throw new Refused(`The backup ${id} does not match its own record; it is not restored.`);
  return { buf, hash: manifest.beforeHash, manifest };
}

/* ---------- receipts (what revert may undo) ---------- */

interface Receipt {
  op: OperationName;
  at: string;
  reverted?: string;
  undo: Record<string, unknown>;
}

const receiptFile = (cfg: ExecutorConfig, id: string) =>
  path.join(cfg.stateDir, "receipts", `${id}.json`);

async function saveReceipt(ctx: Ctx, undo: Record<string, unknown>) {
  await fs.mkdir(path.join(ctx.cfg.stateDir, "receipts"), { recursive: true, mode: 0o700 });
  const r: Receipt = { op: ctx.op, at: new Date(ctx.deps.now()).toISOString(), undo };
  await fs.writeFile(receiptFile(ctx.cfg, ctx.auth.id), JSON.stringify(r), {
    flag: "wx",
    mode: 0o600,
  });
  return ctx.auth.id;
}

/* ---------- operations ---------- */

interface Ctx {
  cfg: ExecutorConfig;
  deps: ExecutorDeps;
  auth: Authorization;
  op: OperationName;
  params: Params;
  acl?: string;
}

interface OpResult {
  result: string;
  /** What the operation read and passes back (a paused check's position). */
  data?: unknown;
  evidence?: Evidence[];
  receipt?: string;
  backup?: string;
  /** The target, for the log. */
  target?: string;
}

/** Thrown after something was tried: the outcome is "failed", with what was put back. */
class Failed extends Error {
  constructor(
    message: string,
    readonly extra: Partial<OpResult> = {},
  ) {
    super(message);
  }
}

const hex64 = (v: unknown, name: string) => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))
    throw new Refused(`${name} must be a fingerprint.`);
  return v;
};
const int = (v: unknown, name: string, max: number) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max)
    throw new Refused(`${name} is not valid.`);
  return v;
};
const keyOf = (v: unknown) => {
  if (typeof v !== "string" || !KEY.test(v)) throw new Refused("The backup key is not valid.");
  return v;
};

/**
 * The catalog. Adding an operation means adding an entry here (with its checks, verification,
 * and what revert does), plus its name in protocol.ts and tests: the authorization, scope, log,
 * and transport stay as they are.
 */
const OPERATIONS: Record<
  Exclude<OperationName, "revert" | "smart.read" | "storage.read">,
  (ctx: Ctx) => Promise<OpResult>
> = {
  /** Writes a file (new or replacing one) exactly as approved. */
  async "file.write"(ctx) {
    const p = ctx.params;
    const key = keyOf(p.key);
    const afterHash = hex64(p.afterHash, "afterHash");
    if (typeof p.content !== "string") throw new Refused("No content was given.");
    const content = Buffer.from(p.content, "base64");
    if (content.length > MAX_CONTENT_BYTES) throw new Refused("The content is larger than 1 MB.");
    if (sha256hex(content) !== afterHash)
      throw new Refused("The content is not what was approved.");
    if (p.beforeHash === null) {
      const t = await targetOf(p.path, ctx.cfg, ctx.deps, { mustNotExist: true });
      const c = (p.create ?? {}) as Record<string, unknown>;
      const meta: FileMeta = {
        mode: int(c.mode ?? 0o644, "The new file's mode", 0o1777),
        uid: int(c.uid ?? 0, "The new file's owner", 2 ** 31),
        gid: int(c.gid ?? 0, "The new file's group", 2 ** 31),
      };
      const bad = await writeVerified(t.path, content, meta, undefined, ctx.deps);
      if (bad) {
        await fs.rm(t.path, { force: true });
        throw new Failed(`${bad} It was removed again.`, { target: t.path });
      }
      const receipt = await saveReceipt(ctx, { kind: "created", path: t.path, hash: afterHash });
      return {
        target: t.path,
        receipt,
        result: `Created ${t.path} (${metaText(meta)}), verified by reading it back.`,
        evidence: [{ label: "Fingerprint", value: afterHash.slice(0, 16) }],
      };
    }
    const beforeHash = hex64(p.beforeHash, "beforeHash");
    const t = await targetOf(p.path, ctx.cfg, ctx.deps, { mustExist: true });
    const cur = await readRegular(t.path);
    if (cur.hash !== beforeHash)
      throw new Refused(
        `${t.path} changed since the plan was approved. Nothing was changed.`,
        "stale",
      );
    ctx.acl = await aclOf(t.path, ctx.deps);
    const b = await backup(ctx, key, t.path, cur, "edit", afterHash);
    const bad = await writeVerified(t.path, content, cur.meta, ctx.acl, ctx.deps);
    if (bad) {
      const back = await writeVerified(t.path, cur.buf, cur.meta, ctx.acl, ctx.deps);
      throw new Failed(
        `${bad} ${back ? `Putting it back also failed: ${back}` : "It was put back as it was."} Backup: ${b}.`,
        { target: t.path, backup: b },
      );
    }
    const receipt = await saveReceipt(ctx, {
      kind: "replaced",
      path: t.path,
      hash: afterHash,
      backup: b,
    });
    return {
      target: t.path,
      receipt,
      backup: b,
      result: `Changed ${t.path}, verified by reading it back (fingerprint, ${metaText(cur.meta)}${ctx.acl ? ", access list kept" : ""}). Backup: ${b}.`,
      evidence: [
        { label: "Before", value: beforeHash.slice(0, 16) },
        { label: "After", value: afterHash.slice(0, 16) },
      ],
    };
  },

  /** Puts a file back from one of the executor's own backups (content, mode, owner, access list). */
  async "file.restore"(ctx) {
    const p = ctx.params;
    const key = keyOf(p.key);
    const beforeHash = hex64(p.beforeHash, "beforeHash");
    const backupHash = hex64(p.backupHash, "backupHash");
    const t = await targetOf(p.path, ctx.cfg, ctx.deps, { mustExist: true });
    const from = await readOwnBackup(ctx, p.backup, t.path);
    if (from.hash !== backupHash) throw new Refused("The backup is not the one approved.", "stale");
    const cur = await readRegular(t.path);
    if (cur.hash !== beforeHash)
      throw new Refused(
        `${t.path} changed since the plan was approved. Nothing was changed.`,
        "stale",
      );
    ctx.acl = await aclOf(t.path, ctx.deps);
    const b = await backup(ctx, key, t.path, cur, "restore", backupHash);
    const meta = { mode: from.manifest.mode, uid: from.manifest.uid, gid: from.manifest.gid };
    const bad = await writeVerified(t.path, from.buf, meta, from.manifest.acl, ctx.deps);
    if (bad) {
      const back = await writeVerified(t.path, cur.buf, cur.meta, ctx.acl, ctx.deps);
      throw new Failed(
        `${bad} ${back ? `Putting it back also failed: ${back}` : "It was put back as it was."}`,
        {
          target: t.path,
          backup: b,
        },
      );
    }
    const receipt = await saveReceipt(ctx, {
      kind: "replaced",
      path: t.path,
      hash: backupHash,
      backup: b,
    });
    return {
      target: t.path,
      receipt,
      backup: b,
      result: `Restored ${t.path} from ${String(p.backup)}, verified by reading it back. The version it replaced is in ${b}.`,
    };
  },

  /** Sets mode and ownership of one file or folder, from exactly the approved current state. */
  async "file.permissions"(ctx) {
    const p = ctx.params;
    const t = await targetOf(p.path, ctx.cfg, ctx.deps, { mustExist: true });
    const st = t.stat!;
    if (!st.isFile() && !st.isDirectory()) throw new Refused(`${t.path} is not a file or folder.`);
    if (st.isFile() && st.nlink > 1)
      throw new Refused(
        `${t.path} has other hard links: changing it would change another file too.`,
      );
    const b = (p.before ?? {}) as Record<string, unknown>;
    const a = (p.after ?? {}) as Record<string, unknown>;
    const before: FileMeta = {
      mode: int(b.mode, "before.mode", 0o7777),
      uid: int(b.uid, "before.uid", 2 ** 31),
      gid: int(b.gid, "before.gid", 2 ** 31),
    };
    const after: FileMeta = {
      mode: int(a.mode ?? before.mode, "after.mode", 0o1777),
      uid: int(a.uid ?? before.uid, "after.uid", 2 ** 31),
      gid: int(a.gid ?? before.gid, "after.gid", 2 ** 31),
    };
    const now = metaOf(st);
    if (
      now.mode !== before.mode ||
      (ctx.deps.isRoot && (now.uid !== before.uid || now.gid !== before.gid))
    )
      throw new Refused(
        `${t.path} has ${metaText(now)}, not ${metaText(before)} as approved. Nothing was changed.`,
        "stale",
      );
    // Through a handle opened without following links, on the very file that was checked: a link
    // swapped in meanwhile is refused, never followed.
    const apply = async (m: FileMeta) => {
      const h = await fs.open(t.path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
      try {
        const hs = await h.stat();
        if (hs.ino !== st.ino || hs.dev !== st.dev)
          throw new Failed(`${t.path} changed while it was being set; nothing more was done.`);
        if (ctx.deps.isRoot) await h.chown(m.uid, m.gid);
        await h.chmod(m.mode);
      } finally {
        await h.close();
      }
    };
    const check = async (m: FileMeta) => {
      const s = await fs.lstat(t.path);
      const x = metaOf(s);
      return s.isSymbolicLink() ||
        x.mode !== m.mode ||
        (ctx.deps.isRoot && (x.uid !== m.uid || x.gid !== m.gid))
        ? `${t.path} reads back as ${metaText(x)}, not ${metaText(m)}.`
        : undefined;
    };
    await apply(after);
    const bad = await check(after);
    if (bad) {
      await apply(before);
      throw new Failed(`${bad} It was set back to ${metaText(before)}.`, { target: t.path });
    }
    const receipt = await saveReceipt(ctx, { kind: "permissions", path: t.path, before, after });
    return {
      target: t.path,
      receipt,
      result: `Set ${t.path} to ${metaText(after)} (was ${metaText(before)}), verified by reading it back.`,
    };
  },

  /** Creates one folder (its parent must exist) with the approved mode and owner. */
  async "dir.create"(ctx) {
    const p = ctx.params;
    const t = await targetOf(p.path, ctx.cfg, ctx.deps, { mustNotExist: true });
    const meta: FileMeta = {
      mode: int(p.mode ?? 0o755, "mode", 0o1777),
      uid: int(p.uid ?? 0, "uid", 2 ** 31),
      gid: int(p.gid ?? 0, "gid", 2 ** 31),
    };
    await fs.mkdir(t.path, { mode: meta.mode & 0o777 });
    await fs.chmod(t.path, meta.mode);
    if (ctx.deps.isRoot) await fs.chown(t.path, meta.uid, meta.gid);
    const st = await fs.lstat(t.path);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Failed(`${t.path} is not a folder after creating it.`);
    const receipt = await saveReceipt(ctx, { kind: "dir", path: t.path });
    return { target: t.path, receipt, result: `Created the folder ${t.path} (${metaText(meta)}).` };
  },

  /**
   * Renames or moves a file or folder within one filesystem, exactly as approved: the item must
   * still be the size and time seen when planning, nothing may be at the destination, and the
   * move must not cross filesystems (that would be a copy and a delete). Revert moves it back.
   */
  async "file.rename"(ctx) {
    const p = ctx.params;
    const from = await targetOf(p.from, ctx.cfg, ctx.deps, { mustExist: true });
    const to = await targetOf(p.to, ctx.cfg, ctx.deps, { mustNotExist: true });
    const st = from.stat!;
    if (typeof p.size === "number" && !st.isDirectory() && st.size !== p.size)
      throw new Refused(`${from.path} changed since the plan was approved.`, "stale");
    if (typeof p.mtimeMs === "number" && Math.round(st.mtimeMs) !== p.mtimeMs)
      throw new Refused(`${from.path} changed since the plan was approved.`, "stale");
    if (under(to.path, from.path)) throw new Refused("A folder cannot go inside itself.");
    if ((await fs.stat(path.dirname(to.path))).dev !== st.dev)
      throw new Refused(
        "The destination is on another filesystem: a move there would copy and delete. Copy instead.",
      );
    await fs.rename(from.path, to.path);
    const after = await fs.lstat(to.path).catch(() => undefined);
    const left = await fs.lstat(from.path).then(
      () => true,
      () => false,
    );
    if (!after || left || (!st.isDirectory() && after.size !== st.size))
      throw new Failed(`${to.path} did not read back as the moved item.`, { target: to.path });
    const receipt = await saveReceipt(ctx, { kind: "renamed", from: from.path, path: to.path });
    return {
      target: to.path,
      receipt,
      result: `Moved ${from.path} to ${to.path}, checked at its new place.`,
    };
  },

  /**
   * Copies a file or folder, never over anything, with no links followed or copied, and checks
   * the copy's size against the original. The original is not touched. Not undone by deleting:
   * the copy stays until the owner decides.
   */
  async "file.copy"(ctx) {
    const p = ctx.params;
    const from = await targetOf(p.from, ctx.cfg, ctx.deps, { mustExist: true });
    const to = await targetOf(p.to, ctx.cfg, ctx.deps, { mustNotExist: true });
    if (under(to.path, from.path)) throw new Refused("A folder cannot be copied into itself.");
    const size = await treeSize(from.path);
    if (typeof p.size === "number" && !from.stat!.isDirectory() && size !== p.size)
      throw new Refused(`${from.path} changed since the plan was approved.`, "stale");
    await fs.cp(from.path, to.path, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const copied = await treeSize(to.path).catch(() => -1);
    if (copied !== size)
      throw new Failed(
        `The copy at ${to.path} is ${copied} bytes, the original ${size}; it was left for the owner to check.`,
        { target: to.path },
      );
    return {
      target: to.path,
      result: `Copied ${from.path} to ${to.path} (${size} bytes, checked). The original is unchanged.`,
    };
  },

  /** Removes one file exactly as approved, keeping a backup (revert puts it back). */
  async "file.remove"(ctx) {
    const p = ctx.params;
    const key = keyOf(p.key);
    const beforeHash = hex64(p.beforeHash, "beforeHash");
    const t = await targetOf(p.path, ctx.cfg, ctx.deps, { mustExist: true });
    const cur = await readRegular(t.path);
    if (cur.hash !== beforeHash)
      throw new Refused(
        `${t.path} changed since the plan was approved. Nothing was removed.`,
        "stale",
      );
    ctx.acl = await aclOf(t.path, ctx.deps);
    const b = await backup(ctx, key, t.path, cur, "remove");
    await fs.rm(t.path);
    if (
      await fs.lstat(t.path).then(
        () => true,
        () => false,
      )
    )
      throw new Failed(`${t.path} is still there.`, { target: t.path, backup: b });
    const receipt = await saveReceipt(ctx, { kind: "removed", path: t.path, backup: b });
    return { target: t.path, receipt, backup: b, result: `Removed ${t.path}. Backup: ${b}.` };
  },

  /** Removes one empty folder. */
  async "dir.remove"(ctx) {
    const t = await targetOf(ctx.params.path, ctx.cfg, ctx.deps, { mustExist: true });
    if (!t.stat!.isDirectory()) throw new Refused(`${t.path} is not a folder.`);
    if ((await fs.readdir(t.path)).length)
      throw new Refused(`${t.path} is not empty; only empty folders are removed.`, "stale");
    const meta = metaOf(t.stat!);
    await fs.rmdir(t.path);
    if (
      await fs.lstat(t.path).then(
        () => true,
        () => false,
      )
    )
      throw new Failed(`${t.path} is still there.`, { target: t.path });
    const receipt = await saveReceipt(ctx, { kind: "dir-removed", path: t.path, meta });
    return { target: t.path, receipt, result: `Removed the empty folder ${t.path}.` };
  },

  /** Brings a Compose project up from its file and checks every service runs (and is healthy). */
  async "compose.apply"(ctx) {
    const t = await composeTarget(ctx);
    // Bound to the approved content: the file (and its .env, which Compose reads too) must be
    // exactly as approved, or root would start whatever is there now.
    await sameContent(t, ctx.params.fileHash, "fileHash");
    const env = path.join(path.dirname(t), ".env");
    if (await exists(env)) await sameContent(env, ctx.params.envHash, "envHash");
    const v = await ctx.deps.run("docker", ["compose", "-f", t, "config", "-q"], {
      timeoutMs: 60_000,
    });
    if (v.code !== 0) throw new Refused(`Compose rejects ${t}: ${v.out.trim().slice(0, 300)}`);
    const up = await ctx.deps.run("docker", ["compose", "-f", t, "up", "-d", "--force-recreate"], {
      timeoutMs: 300_000,
    });
    if (up.code !== 0)
      throw new Failed(`Compose could not start it: ${up.out.trim().slice(-300)}`, { target: t });
    const state = await waitRunning(ctx, t);
    if (state.bad)
      throw new Failed(`Not all services came back within two minutes: ${state.bad}.`, {
        target: t,
      });
    return {
      target: t,
      result: `${state.services.join(", ")} recreated, running, and not unhealthy.`,
    };
  },

  /** Stops and removes a Compose project's containers (never its volumes or files). */
  async "compose.down"(ctx) {
    const t = await composeTarget(ctx);
    const r = await ctx.deps.run("docker", ["compose", "-f", t, "down"], { timeoutMs: 300_000 });
    if (r.code !== 0)
      throw new Failed(`Compose could not stop it: ${r.out.trim().slice(-300)}`, { target: t });
    const left = await ctx.deps.run("docker", ["compose", "-f", t, "ps", "-a", "-q"], {
      timeoutMs: 30_000,
    });
    if (left.out.trim()) throw new Failed("Some of its containers are still there.", { target: t });
    const env = path.join(path.dirname(t), ".env");
    const receipt = await saveReceipt(ctx, {
      kind: "compose-down",
      path: t,
      fileHash: (await readRegular(t)).hash,
      ...((await exists(env)) ? { envHash: (await readRegular(env)).hash } : {}),
    });
    return {
      target: t,
      receipt,
      result: `Stopped and removed the containers of ${t}. Its file, volumes, and data are untouched.`,
    };
  },

  "raid.member": (ctx) => raid(ctx, raidMember),
  "raid.sync": (ctx) => raid(ctx, raidSync),
  "raid.speed": (ctx) => raid(ctx, raidSpeed),
  "raid.grow": (ctx) => raid(ctx, raidGrow),
  "raid.create": (ctx) => raid(ctx, raidCreate),
  "zfs.member": (ctx) => raid(ctx, zfsMember),
  "zfs.scrub": (ctx) => raid(ctx, zfsScrub),
  "zfs.clear": (ctx) => raid(ctx, zfsClear),
  "zfs.grow": (ctx) => raid(ctx, zfsGrow),
  "zfs.create": (ctx) => raid(ctx, zfsCreate),
  "btrfs.member": (ctx) => raid(ctx, btrfsMember),
  "btrfs.scrub": (ctx) => raid(ctx, btrfsScrub),
  "btrfs.balance": (ctx) => raid(ctx, btrfsBalance),
  "btrfs.clear": (ctx) => raid(ctx, btrfsClear),
  "btrfs.create": (ctx) => raid(ctx, btrfsCreate),
  "snapraid.run": (ctx) => raid(ctx, snapraidRun),
  "spaces.member": (ctx) => raid(ctx, spacesMember),
  "spaces.repair": (ctx) => raid(ctx, spacesRepair),
  "spaces.grow": (ctx) => raid(ctx, spacesGrow),
  "spaces.create": (ctx) => raid(ctx, spacesCreate),

  /** Starts, stops, restarts, reloads, enables, or disables one listed systemd unit. */
  async "unit.control"(ctx) {
    const unit = ctx.params.unit;
    const action = ctx.params.action;
    if (
      typeof unit !== "string" ||
      !/^[A-Za-z0-9@._-]+\.(service|socket|timer|target|path|mount)$/.test(unit)
    )
      throw new Refused("The unit name is not valid.");
    if (/^hearth/i.test(unit))
      throw new Refused("Hearth's own units are never controlled through the executor.");
    if (!ctx.cfg.units.includes(unit))
      throw new Refused(
        `${unit} is outside the executor's scope (units: ${ctx.cfg.units.join(", ") || "none"}).`,
      );
    const actions = ["start", "stop", "restart", "reload", "enable", "disable"];
    if (typeof action !== "string" || !actions.includes(action))
      throw new Refused("The action is not valid.");
    const r = await ctx.deps.run("systemctl", [action, "--", unit], { timeoutMs: 120_000 });
    if (r.code !== 0)
      throw new Failed(`systemctl ${action} failed: ${r.out.trim().slice(-300)}`, { target: unit });
    const bad = await unitState(ctx, unit, action);
    if (bad) throw new Failed(bad, { target: unit });
    const opposite: Record<string, string> = {
      start: "stop",
      stop: "start",
      enable: "disable",
      disable: "enable",
    };
    const receipt = opposite[action]
      ? await saveReceipt(ctx, { kind: "unit", unit, action: opposite[action] })
      : undefined;
    return {
      target: unit,
      ...(receipt ? { receipt } : {}),
      result: `${unit}: ${action} done and verified.`,
    };
  },
};

/** A RAID operation (src/elevated/raid.ts), with its refusals and failures in the catalog's terms. */
async function raid(
  ctx: Ctx,
  fn: (
    params: Params,
    deps: import("./raid").RaidDeps,
  ) => Promise<{
    result: string;
    target: string;
    evidence?: Evidence[];
    data?: unknown;
  }>,
): Promise<OpResult> {
  try {
    return await fn(ctx.params, {
      run: (cmd, args, opts) => ctx.deps.run(cmd, args, opts),
      wait: (ms) => ctx.deps.wait(ms),
      ...(ctx.deps.raidSys ? { sys: ctx.deps.raidSys } : {}),
      allowLoop: ctx.cfg.raidAllowLoop === true,
      jobs: {
        stateDir: ctx.cfg.stateDir,
        logDir: path.dirname(ctx.cfg.auditLog),
        program: ctx.deps.selfPaths[0] ?? "",
        config: ctx.deps.selfPaths[1] ?? "",
        node: process.execPath,
      },
    });
  } catch (error) {
    if (error instanceof RaidRefused) throw new Refused(error.message, error.outcome);
    if (error instanceof RaidFailed) throw new Failed(error.message);
    throw error;
  }
}

const exists = (p: string) =>
  fs.lstat(p).then(
    () => true,
    () => false,
  );

async function sameContent(file: string, want: unknown, name: string) {
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want))
    throw new Refused(`${name} must be the approved fingerprint of ${file}.`);
  if ((await readRegular(file)).hash !== want)
    throw new Refused(`${file} is not as approved. Nothing was started.`, "stale");
}

async function composeTarget(ctx: Ctx) {
  const t = await targetOf(ctx.params.file, ctx.cfg, ctx.deps, { mustExist: true });
  if (!t.stat!.isFile() || !/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(path.basename(t.path)))
    throw new Refused(`${t.path} is not a Compose file.`);
  return t.path;
}

async function waitRunning(ctx: Ctx, file: string) {
  const want = (
    await ctx.deps.run("docker", ["compose", "-f", file, "config", "--services"], {
      timeoutMs: 60_000,
    })
  ).out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let bad = "";
  for (let i = 0; i < 24; i++) {
    await ctx.deps.wait(5_000);
    const ps = await ctx.deps.run(
      "docker",
      ["compose", "-f", file, "ps", "-a", "--format", "json"],
      {
        timeoutMs: 30_000,
      },
    );
    const rows = ps.out
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as { Service?: string; State?: string; Health?: string };
        } catch {
          return {};
        }
      });
    const notUp = want.filter((s) => {
      const r = rows.find((x) => x.Service === s);
      return !r || r.State !== "running" || r.Health === "starting" || r.Health === "unhealthy";
    });
    bad = notUp.join(", ");
    if (!notUp.length) return { services: want, bad: "" };
  }
  return { services: want, bad };
}

async function unitState(ctx: Ctx, unit: string, action: string) {
  const enabled = action === "enable" || action === "disable";
  const r = await ctx.deps.run("systemctl", [enabled ? "is-enabled" : "is-active", "--", unit], {
    timeoutMs: 30_000,
  });
  const state = r.out.trim();
  const want =
    action === "enable"
      ? "enabled"
      : action === "disable"
        ? "disabled"
        : action === "stop"
          ? "inactive"
          : "active";
  return state === want ? undefined : `${unit} is ${state || "unknown"} afterwards, not ${want}.`;
}

/** Undoes what an earlier operation did, only if the target is still exactly as it left it. */
async function revert(ctx: Ctx): Promise<OpResult> {
  const id = ctx.params.receipt;
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))
    throw new Refused("No valid receipt was given.");
  const file = receiptFile(ctx.cfg, id);
  const r = JSON.parse(await fs.readFile(file, "utf8").catch(() => "null")) as Receipt | null;
  if (!r) throw new Refused("There is no such receipt.", "stale");
  if (r.reverted) throw new Refused(`It was already undone (${r.reverted}).`, "stale");
  const u = r.undo;
  let out: OpResult;
  if (u.kind === "created" || u.kind === "replaced") {
    const t = await targetOf(u.path, ctx.cfg, ctx.deps, { mustExist: true });
    const cur = await readRegular(t.path);
    if (cur.hash !== u.hash)
      throw new Refused(`${t.path} changed after that step; it was not put back.`, "stale");
    if (u.kind === "created") {
      await fs.rm(t.path);
      out = { target: t.path, result: `Removed ${t.path}, which that step had created.` };
    } else {
      const from = await readOwnBackup(ctx, u.backup, t.path);
      const meta = { mode: from.manifest.mode, uid: from.manifest.uid, gid: from.manifest.gid };
      const bad = await writeVerified(t.path, from.buf, meta, from.manifest.acl, ctx.deps);
      if (bad) throw new Failed(bad, { target: t.path });
      out = {
        target: t.path,
        result: `Put ${t.path} back from ${String(u.backup)}, verified by reading it back.`,
      };
    }
  } else if (u.kind === "permissions") {
    const t = await targetOf(u.path, ctx.cfg, ctx.deps, { mustExist: true });
    const after = u.after as FileMeta;
    const before = u.before as FileMeta;
    const now = metaOf(t.stat!);
    if (
      now.mode !== after.mode ||
      (ctx.deps.isRoot && (now.uid !== after.uid || now.gid !== after.gid))
    )
      throw new Refused(`${t.path} changed after that step; it was not set back.`, "stale");
    if (ctx.deps.isRoot) await fs.chown(t.path, before.uid, before.gid);
    await fs.chmod(t.path, before.mode);
    const x = metaOf(await fs.lstat(t.path));
    if (x.mode !== before.mode)
      throw new Failed(`${t.path} did not go back to ${metaText(before)}.`);
    out = { target: t.path, result: `Set ${t.path} back to ${metaText(before)}.` };
  } else if (u.kind === "removed") {
    const t = await targetOf(u.path, ctx.cfg, ctx.deps, { mustNotExist: true });
    const from = await readOwnBackup(ctx, u.backup, t.path);
    const meta = { mode: from.manifest.mode, uid: from.manifest.uid, gid: from.manifest.gid };
    const bad = await writeVerified(t.path, from.buf, meta, from.manifest.acl, ctx.deps);
    if (bad) throw new Failed(bad, { target: t.path });
    out = { target: t.path, result: `Put ${t.path} back from ${String(u.backup)}.` };
  } else if (u.kind === "dir-removed") {
    const t = await targetOf(u.path, ctx.cfg, ctx.deps, { mustNotExist: true });
    const meta = u.meta as FileMeta;
    await fs.mkdir(t.path, { mode: meta.mode & 0o777 });
    await fs.chmod(t.path, meta.mode);
    if (ctx.deps.isRoot) await fs.chown(t.path, meta.uid, meta.gid);
    out = { target: t.path, result: `Created ${t.path} again.` };
  } else if (u.kind === "renamed") {
    const back = await targetOf(u.from, ctx.cfg, ctx.deps, { mustNotExist: true });
    const now = await targetOf(u.path, ctx.cfg, ctx.deps, { mustExist: true });
    await fs.rename(now.path, back.path);
    out = { target: back.path, result: `Moved ${now.path} back to ${back.path}.` };
  } else if (u.kind === "dir") {
    const t = await targetOf(u.path, ctx.cfg, ctx.deps, { mustExist: true });
    if ((await fs.readdir(t.path)).length)
      throw new Refused(`${t.path} is no longer empty; it was left in place.`, "stale");
    await fs.rmdir(t.path);
    out = { target: t.path, result: `Removed the empty folder ${t.path}.` };
  } else if (u.kind === "compose-down") {
    if (!ctx.cfg.operations.includes("compose.apply"))
      throw new Refused("compose.apply is switched off, so this cannot be undone here.");
    out = await OPERATIONS["compose.apply"]({
      ...ctx,
      params: { file: u.path, fileHash: u.fileHash, envHash: u.envHash },
    });
  } else if (u.kind === "unit") {
    if (!ctx.cfg.operations.includes("unit.control"))
      throw new Refused("unit.control is switched off, so this cannot be undone here.");
    out = await OPERATIONS["unit.control"]({
      ...ctx,
      params: { unit: u.unit, action: u.action },
    });
  } else throw new Refused("That receipt cannot be undone.");
  await fs.writeFile(
    file,
    JSON.stringify({ ...r, reverted: new Date(ctx.deps.now()).toISOString() }),
    {
      mode: 0o600,
    },
  );
  return out;
}

/* ---------- the log ---------- */

/** Appends one record, chained to the previous one by its fingerprint, so gaps and edits show. */
/** For the SnapRAID job mode (main.ts): its start and end go in the same chained log. */
export const recordJob = (cfg: ExecutorConfig, record: Record<string, unknown>) =>
  audit(cfg, record);

async function audit(cfg: ExecutorConfig, record: Record<string, unknown>) {
  // Every append holds the log's own short lock, so parallel requests never fork the chain.
  const lock = path.join(cfg.stateDir, "log.lock");
  for (let i = 0; ; i++) {
    try {
      await (await fs.open(lock, "wx", 0o600)).close();
      break;
    } catch {
      const st = await fs.stat(lock).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > 30_000) await fs.rm(lock, { force: true });
      if (i > 500) throw new Error("The log is busy.");
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  let prev = "";
  let h: fs.FileHandle;
  try {
    h = await fs.open(cfg.auditLog, "a+", 0o640);
  } catch (error) {
    await fs.rm(lock, { force: true });
    throw error;
  }
  try {
    const { size } = await h.stat();
    if (size > 0) {
      const len = Math.min(size, 65_536);
      const buf = Buffer.alloc(len);
      await h.read(buf, 0, len, size - len);
      const last = buf.toString("utf8").trimEnd().split("\n").at(-1) ?? "";
      prev = sha256hex(last);
    }
    await h.appendFile(`${canonical({ ...record, prev })}\n`);
  } finally {
    await h.close();
    await fs.rm(lock, { force: true });
  }
}

/** Checks the chain of the whole log: the first broken record, if any. */
export async function verifyAudit(file: string): Promise<{ records: number; broken?: number }> {
  const lines = (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
  let prev = "";
  for (const [i, l] of lines.entries()) {
    const rec = JSON.parse(l) as { prev?: string };
    if ((rec.prev ?? "") !== prev) return { records: lines.length, broken: i + 1 };
    prev = sha256hex(l);
  }
  return { records: lines.length };
}

/* ---------- one request ---------- */

async function withLock<T>(
  cfg: ExecutorConfig,
  deps: ExecutorDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = path.join(cfg.stateDir, "lock");
  const start = deps.now();
  for (;;) {
    try {
      const h = await fs.open(lock, "wx", 0o600);
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch {
      // A lock whose holder has died (systemd ends a request after 15 minutes) is released at
      // once; one older than any request may run is released too.
      const holder = Number(await fs.readFile(lock, "utf8").catch(() => ""));
      const st = await fs.stat(lock).catch(() => undefined);
      let alive = true;
      if (holder > 0)
        try {
          process.kill(holder, 0);
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      if (st && (!alive || deps.now() - st.mtimeMs > 16 * 60_000)) {
        const again = Number(await fs.readFile(lock, "utf8").catch(() => ""));
        if (again === holder) await fs.rm(lock, { force: true });
      }
      if (deps.now() - start > 6 * 60_000) throw new Refused("Another operation is still running.");
      await deps.wait(200);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

export async function status(
  cfg: ExecutorConfig,
  cfgFile: string,
  deps: ExecutorDeps,
): Promise<ExecutorStatus> {
  return {
    version: PROTOCOL_VERSION,
    operations: cfg.operations,
    roots: cfg.roots,
    units: cfg.units,
    backupRoot: cfg.backupRoot,
    auditLog: cfg.auditLog,
    problems: await setupProblems(cfg, cfgFile, deps),
  };
}

/** A file's size, or a folder's total, refusing links (a copy never follows or carries one). */
async function treeSize(p: string): Promise<number> {
  const st = await fs.lstat(p);
  if (st.isSymbolicLink()) throw new Refused(`${p} is a symbolic link; links are not copied.`);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const d of await fs.readdir(p)) total += await treeSize(path.join(p, d));
  return total;
}

/* ---------- reads ---------- */

/** A whole drive by its kernel name, nothing else: no partitions, no paths, no options. */
const DRIVE = /^\/dev\/(sd[a-z]{1,3}|nvme\d{1,2}n\d{1,2}|vd[a-z]{1,2}|hd[a-z])$/;
/** smartctl's largest answer we pass on (a full ATA report is about 30 KB). */
const MAX_READ_BYTES = 512 * 1024;

async function smartctlPath(): Promise<string> {
  for (const p of ["/usr/sbin/smartctl", "/usr/bin/smartctl", "/usr/local/sbin/smartctl"])
    if (
      await fs.access(p, fsc.X_OK).then(
        () => true,
        () => false,
      )
    )
      return p;
  return "smartctl";
}

/**
 * smart.read: smartctl's read-only report for one drive. The command is fixed (`-a`, JSON out);
 * only the drive name comes from the request, and only as a whole block device. A USB enclosure
 * that hides the drive is asked once more through SAT passthrough, which is how most USB bridges
 * carry SMART; if that fails too, smartctl's own words say why.
 */
async function smartRead(
  params: Params,
  deps: ExecutorDeps,
): Promise<{ target: string; result: string; data: unknown }> {
  const dev = params.device;
  if (typeof dev !== "string" || !DRIVE.test(dev))
    throw new Refused("smart.read takes a whole drive by its name, like /dev/sda or /dev/nvme0n1.");
  const isBlock =
    deps.isBlockDevice ??
    (async (p: string) => (await fs.stat(p).catch(() => undefined))?.isBlockDevice() === true);
  if (!(await isBlock(dev))) throw new Refused(`${dev} is not a drive on this machine.`);
  const bin = await smartctlPath();
  const ask = async (extra: string[]) => {
    // -n standby,0: a sleeping drive is left asleep (smartctl says so and stops), never spun up.
    const r = await deps.run(bin, ["--json=c", "-a", "-n", "standby,0", ...extra, dev], {
      timeoutMs: 60_000,
    });
    if (r.out.length > MAX_READ_BYTES) throw new Refused("smartctl's answer was too large.");
    try {
      return { code: r.code, json: JSON.parse(r.out) as Record<string, unknown> };
    } catch {
      return { code: r.code, json: undefined };
    }
  };
  // smartctl's exit status is a bit mask: bit 1 means the device could not be opened or
  // identified (a USB bridge it does not recognise); higher bits are the drive's own findings.
  let r = await ask([]);
  let via = "direct";
  if (r.code & 2 || !r.json) {
    const sat = await ask(["-d", "sat"]);
    if (sat.json && !(sat.code & 2)) {
      r = sat;
      via = "sat";
    } else if (!r.json) r = sat;
  }
  if (!r.json) throw new Refused(`smartctl gave no readable answer for ${dev}.`);
  return {
    target: dev,
    result: `Read SMART for ${dev}${via === "sat" ? " through SAT passthrough" : ""}.`,
    data: { ...r.json, hearth: { via, exitStatus: r.code } },
  };
}

/* ---------- the request ---------- */

/** Handles one request (the text the client sent) and answers it. Never throws. */
export async function handleRequest(
  raw: string,
  cfgFile: string,
  deps: ExecutorDeps,
): Promise<ElevatedResponse> {
  let cfg: ExecutorConfig;
  try {
    cfg = await loadConfig(cfgFile);
  } catch (error) {
    return {
      ok: false,
      outcome: "refused",
      result: `The executor's scope file cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let req: ElevatedRequest;
  try {
    req = JSON.parse(raw) as ElevatedRequest;
    if (!req || typeof req !== "object") throw new Error();
  } catch {
    return { ok: false, outcome: "refused", result: "The request is not valid JSON." };
  }
  if (req.v !== PROTOCOL_VERSION)
    return {
      ok: false,
      outcome: "refused",
      result: `The executor speaks version ${PROTOCOL_VERSION}.`,
    };
  if (req.op === "status") {
    return {
      ok: true,
      outcome: "done",
      result: "Status.",
      status: await status(cfg, cfgFile, deps),
    };
  }
  const op = req.op;
  const params = req.params && typeof req.params === "object" ? req.params : {};
  if (op === "smart.read" || (READ_OPERATIONS as readonly string[]).includes(op))
    return read(op as OperationName, params, cfg, cfgFile, deps);
  const auth = req.auth;
  const fields = {
    authId: typeof auth?.id === "string" ? auth.id.slice(0, 64) : undefined,
    jobId: typeof auth?.jobId === "string" ? auth.jobId.slice(0, 100) : undefined,
    step: typeof auth?.step === "number" ? auth.step : undefined,
    approvedBy: typeof auth?.approvedBy === "string" ? auth.approvedBy.slice(0, 40) : undefined,
    fingerprint: typeof auth?.fingerprint === "string" ? auth.fingerprint.slice(0, 64) : undefined,
  };
  // Until the authorization is verified, what a request says about itself is only a claim.
  let base: Record<string, unknown> = {
    at: new Date(deps.now()).toISOString(),
    op: String(op).slice(0, 40),
    claimed: fields,
  };
  const refuse = async (result: string, outcome: "refused" | "stale" = "refused") => {
    await audit(cfg, { ...base, outcome, result: result.slice(0, 500) }).catch(() => undefined);
    return { ok: false, outcome, result } satisfies ElevatedResponse;
  };
  if (!(OPERATION_NAMES as readonly string[]).includes(op))
    return refuse(`"${String(op)}" is not an operation the executor knows.`);
  if (!cfg.operations.includes(op))
    return refuse(
      `${op} is not switched on in the executor's scope (on: ${cfg.operations.join(", ") || "none"}).`,
    );
  const problems = await setupProblems(cfg, cfgFile, deps);
  if (problems.length)
    return refuse(
      `The executor's own setup is not safe, so it does nothing: ${problems.join(" ")}`,
    );
  const key = await fs.readFile(cfg.keyFile).catch(() => undefined);
  if (!key || key.length < 32) return refuse("The executor has no signing key.");
  const why = checkAuthorization(key, auth, op, params, deps.now());
  if (why) return refuse(why);
  base = { at: base.at, op, ...fields };
  try {
    return await withLock(cfg, deps, async () => {
      // Single use: the id is spent before anything is checked or done, so a replay never runs.
      await fs.mkdir(path.join(cfg.stateDir, "used"), { recursive: true, mode: 0o700 });
      try {
        await (await fs.open(path.join(cfg.stateDir, "used", auth!.id), "wx", 0o600)).close();
      } catch {
        return refuse("This authorization was already used.");
      }
      const ctx: Ctx = { cfg, deps, auth: auth!, op, params };
      // Nothing is done unless it was recorded first: the log fails closed.
      try {
        await audit(cfg, { ...base, outcome: "begin" });
      } catch (error) {
        return {
          ok: false,
          outcome: "refused",
          result: `The executor's log cannot be written, so it does nothing (${error instanceof Error ? error.message : String(error)}).`,
        } satisfies ElevatedResponse;
      }
      try {
        const r =
          op === "revert"
            ? await revert(ctx)
            : await OPERATIONS[op as keyof typeof OPERATIONS](ctx);
        await audit(cfg, {
          ...base,
          outcome: "done",
          target: r.target,
          result: r.result.slice(0, 500),
          backup: r.backup,
          receipt: r.receipt,
        });
        return {
          ok: true,
          outcome: "done",
          result: r.result,
          ...(r.data !== undefined ? { data: r.data } : {}),
          ...(r.evidence ? { evidence: r.evidence } : {}),
          ...(r.receipt ? { receipt: r.receipt } : {}),
          ...(r.backup ? { backup: r.backup } : {}),
        } satisfies ElevatedResponse;
      } catch (error) {
        if (error instanceof Refused) return refuse(error.message, error.outcome);
        const msg = error instanceof Error ? error.message : String(error);
        const extra = error instanceof Failed ? error.extra : {};
        await audit(cfg, {
          ...base,
          outcome: "failed",
          target: extra.target,
          result: msg.slice(0, 500),
          backup: extra.backup,
        }).catch(() => undefined);
        return {
          ok: false,
          outcome: "failed",
          result: msg,
          ...(extra.backup ? { backup: extra.backup } : {}),
        } satisfies ElevatedResponse;
      }
    });
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

/** A read: switched on in the scope file, the setup safe, recorded, and nothing changed. */
async function read(
  op: OperationName,
  params: Params,
  cfg: ExecutorConfig,
  cfgFile: string,
  deps: ExecutorDeps,
): Promise<ElevatedResponse> {
  const at = new Date(deps.now()).toISOString();
  const refuse = async (result: string) => {
    await audit(cfg, { at, op, outcome: "refused", result: result.slice(0, 500) }).catch(
      () => undefined,
    );
    return { ok: false, outcome: "refused", result } satisfies ElevatedResponse;
  };
  if (!cfg.operations.includes(op))
    return refuse(
      `${op} is not switched on in the executor's scope (on: ${cfg.operations.join(", ") || "none"}).`,
    );
  const problems = await setupProblems(cfg, cfgFile, deps);
  if (problems.length)
    return refuse(
      `The executor's own setup is not safe, so it does nothing: ${problems.join(" ")}`,
    );
  try {
    const r =
      op === "storage.read"
        ? await storageRead(params, {
            run: (cmd, args, opts) => deps.run(cmd, args, opts),
            wait: (ms) => deps.wait(ms),
          }).catch((error: unknown) => {
            if (error instanceof RaidRefused) throw new Refused(error.message);
            throw error;
          })
        : await smartRead(params, deps);
    await audit(cfg, { at, op, outcome: "read", target: r.target, result: r.result });
    return { ok: true, outcome: "done", result: r.result, data: r.data };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}
