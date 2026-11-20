import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The elevated executor's wire format, shared by Hearth's server (which asks) and the executor
 * (which checks and acts). Node built-ins only: the executor is shipped as one small file and must
 * not pull in Hearth's dependencies.
 *
 * Every operation that changes something carries an authorization: issued by Hearth's backend for
 * exactly one approved plan step, for exactly these parameters (by fingerprint), usable once, for
 * at most 15 minutes, and signed with a key only Hearth's service and root can read. The model
 * never sees the key, the socket, or a request.
 */

export const PROTOCOL_VERSION = 1;
/** The longest an authorization may live. */
export const MAX_AUTH_MS = 15 * 60_000;
/** Largest file content one request may carry. */
export const MAX_CONTENT_BYTES = 1024 * 1024;

export type OperationName =
  | "file.write"
  | "file.restore"
  | "file.permissions"
  | "dir.create"
  | "file.remove"
  | "dir.remove"
  | "compose.apply"
  | "compose.down"
  | "unit.control"
  | "revert"
  | "smart.read"
  | "file.rename"
  | "file.copy"
  | "raid.member"
  | "raid.sync"
  | "raid.speed"
  | "raid.grow"
  | "raid.create"
  | "zfs.member"
  | "zfs.scrub"
  | "zfs.clear"
  | "zfs.grow"
  | "zfs.create"
  | "btrfs.member"
  | "btrfs.scrub"
  | "btrfs.balance"
  | "btrfs.clear"
  | "btrfs.create"
  | "snapraid.run"
  | "spaces.member"
  | "spaces.repair"
  | "spaces.grow"
  | "spaces.create"
  | "storage.read";

export const OPERATION_NAMES: readonly OperationName[] = [
  "file.write",
  "file.restore",
  "file.permissions",
  "dir.create",
  "file.remove",
  "dir.remove",
  "compose.apply",
  "compose.down",
  "unit.control",
  "revert",
  "smart.read",
  "file.rename",
  "file.copy",
  "raid.member",
  "raid.sync",
  "raid.speed",
  "raid.grow",
  "raid.create",
  "zfs.member",
  "zfs.scrub",
  "zfs.clear",
  "zfs.grow",
  "zfs.create",
  "btrfs.member",
  "btrfs.scrub",
  "btrfs.balance",
  "btrfs.clear",
  "btrfs.create",
  "snapraid.run",
  "spaces.member",
  "spaces.repair",
  "spaces.grow",
  "spaces.create",
  "storage.read",
];

/** Linux software RAID (mdadm). */
export const MDADM_OPERATIONS: readonly OperationName[] = [
  "raid.member",
  "raid.sync",
  "raid.speed",
  "raid.grow",
  "raid.create",
];

/**
 * Everything the RAID / Arrays tab changes on Linux (mdadm, ZFS, Btrfs, SnapRAID) and the reads
 * that need root: switched on together ("--add-operation raid"), or one by one.
 */
export const RAID_OPERATIONS: readonly OperationName[] = [
  ...MDADM_OPERATIONS,
  "zfs.member",
  "zfs.scrub",
  "zfs.clear",
  "zfs.grow",
  "zfs.create",
  "btrfs.member",
  "btrfs.scrub",
  "btrfs.balance",
  "btrfs.clear",
  "btrfs.create",
  "snapraid.run",
  "storage.read",
];

/** Windows Storage Spaces (the Windows executor's storage catalog; SnapRAID runs as Hearth there). */
export const WINDOWS_RAID_OPERATIONS: readonly OperationName[] = [
  "spaces.member",
  "spaces.repair",
  "spaces.grow",
  "spaces.create",
];

/**
 * Operations that only read, so they need no per-request authorization: switching one on in the
 * root-owned scope file is the owner's approval. Each read is still recorded in the log.
 */
export const READ_OPERATIONS: readonly OperationName[] = ["smart.read", "storage.read"];

export type Params = Record<string, unknown>;

export interface Authorization {
  /** 32 hex characters, never reused. */
  id: string;
  op: OperationName;
  /** fingerprint(op, params) of the exact request it allows. */
  fingerprint: string;
  /** The plan and step it was issued for (for the record). */
  jobId: string;
  step: number;
  /** Who approved the plan, and when (for the record). */
  approvedBy: string;
  approvedAt?: string;
  issuedAt: string;
  expiresAt: string;
  mac: string;
}

export interface ElevatedRequest {
  v: number;
  op: OperationName | "status";
  params?: Params;
  auth?: Authorization;
}

export interface Evidence {
  label: string;
  value: string;
}

export interface ElevatedResponse {
  ok: boolean;
  /** Plain words: what was done and how it was checked, or why nothing was done. */
  result: string;
  /**
   * refused: nothing was done (scope, authorization, a precondition). stale: the target is no
   * longer as approved. failed: it was tried and did not verify (and was put back when possible).
   */
  outcome: "done" | "refused" | "stale" | "failed";
  evidence?: Evidence[];
  /** For undo: an id the executor accepts in a later `revert` (and the backup it made). */
  receipt?: string;
  backup?: string;
  /** Present for `status`. */
  status?: ExecutorStatus;
  /** Present for a read operation: what was read (smartctl's JSON for smart.read). */
  data?: unknown;
}

export interface ExecutorStatus {
  version: number;
  operations: OperationName[];
  roots: string[];
  units: string[];
  backupRoot: string;
  auditLog: string;
  /** Problems with the executor's own setup (ownership, modes), which make it refuse everything. */
  problems: string[];
}

/** JSON with keys sorted at every level, so the same values always give the same text. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const sha256hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/**
 * What an authorization is bound to. File content is covered through its hash (afterHash), so the
 * fingerprint leaves the bulky content out.
 */
export function fingerprint(op: string, params: Params = {}): string {
  const { content: _content, ...rest } = params;
  return sha256hex(canonical({ op, params: rest }));
}

function macOf(key: Buffer, a: Omit<Authorization, "mac">): string {
  return createHmac("sha256", key)
    .update(
      canonical({
        id: a.id,
        op: a.op,
        fingerprint: a.fingerprint,
        jobId: a.jobId,
        step: a.step,
        approvedBy: a.approvedBy,
        approvedAt: a.approvedAt,
        issuedAt: a.issuedAt,
        expiresAt: a.expiresAt,
      }),
    )
    .digest("hex");
}

export function signAuthorization(key: Buffer, a: Omit<Authorization, "mac">): Authorization {
  return { ...a, mac: macOf(key, a) };
}

/** Why an authorization does not allow this request, or undefined when it does. */
export function checkAuthorization(
  key: Buffer,
  auth: Authorization | undefined,
  op: string,
  params: Params,
  now = Date.now(),
): string | undefined {
  if (!auth || typeof auth !== "object") return "No authorization came with the request.";
  if (typeof auth.id !== "string" || !/^[0-9a-f]{32}$/.test(auth.id))
    return "The authorization has no valid id.";
  if (typeof auth.mac !== "string" || !/^[0-9a-f]{64}$/.test(auth.mac))
    return "The authorization is not signed.";
  const want = Buffer.from(macOf(key, auth), "hex");
  if (!timingSafeEqual(want, Buffer.from(auth.mac, "hex")))
    return "The authorization's signature does not match: it was not issued by this Hearth.";
  if (auth.op !== op) return `The authorization is for ${auth.op}, not ${op}.`;
  if (auth.fingerprint !== fingerprint(op, params))
    return "The request is not exactly what was authorized (its fingerprint differs).";
  const issued = Date.parse(auth.issuedAt);
  const expires = Date.parse(auth.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires))
    return "The authorization has no valid times.";
  if (expires - issued > MAX_AUTH_MS) return "The authorization is valid for too long.";
  if (now < issued - 60_000) return "The authorization was issued in the future.";
  if (now > expires) return "The authorization has expired; the step must be authorized again.";
  return undefined;
}
