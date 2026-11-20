import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  fingerprint,
  signAuthorization,
  type ElevatedRequest,
  type ElevatedResponse,
  type ExecutorStatus,
  type OperationName,
  type Params,
} from "../elevated/protocol";
import type { StepRun } from "../jobs/operations";

/**
 * Hearth's side of the elevated executor (src/elevated). The backend, never the model, asks it
 * to act: only while carrying out an approved plan step, with a single-use authorization for the
 * exact request, signed with the key the installer shares between root and Hearth's service.
 * Nothing here is reachable from an AI tool except `status`, which only describes the scope.
 */

export interface ElevationTransport {
  send(req: ElevatedRequest): Promise<ElevatedResponse>;
}

const DEFAULT_SOCKET = "/run/hearth/elevated.sock";
/** Where the Windows executor listens (deploy/windows/install-elevation.ps1). */
export const WINDOWS_PIPE = "\\\\.\\pipe\\hearth-elevated";
const DEFAULT_KEY = "/etc/hearth/elevation.key";
/** How long an authorization lives: enough for one operation (Compose may take minutes). */
const AUTH_MS = 10 * 60_000;

/** One request per connection: write it, then read the whole answer. */
export function socketTransport(socketPath: string, timeoutMs = 7 * 60_000): ElevationTransport {
  return {
    send(req) {
      return new Promise((resolve, reject) => {
        const sock = net.createConnection(socketPath);
        let out = "";
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error("The elevated executor did not answer in time."));
        }, timeoutMs);
        sock.setEncoding("utf8");
        sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
        sock.on("data", (d: string) => {
          out += d;
        });
        sock.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        sock.on("close", () => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(out.trim()) as ElevatedResponse);
          } catch {
            reject(new Error("The elevated executor's answer could not be read."));
          }
        });
      });
    },
  };
}

export interface ElevationState {
  /** Installed and answering, with no problems in its own setup. */
  available: boolean;
  /** In plain words, for the owner and Ember. */
  summary: string;
  status?: ExecutorStatus;
}

const under = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

export class Elevation {
  private cache?: { at: number; state: ElevationState };
  private readonly transport?: ElevationTransport;
  private readonly keyFile: string;
  private readonly key?: Buffer;
  /** Installed only once its key file exists (Windows: noticed without restarting Hearth). */
  private readonly detect: boolean;

  constructor(
    opts: {
      transport?: ElevationTransport;
      socketPath?: string;
      keyFile?: string;
      key?: Buffer;
      /** Off unless configured (DC_ELEVATION=1 or a socket path): no executor is assumed. */
      enabled?: boolean;
      detect?: boolean;
    } = {},
  ) {
    this.keyFile = opts.keyFile ?? DEFAULT_KEY;
    this.key = opts.key;
    this.detect = opts.detect === true;
    if (opts.transport) this.transport = opts.transport;
    else if (opts.enabled) this.transport = socketTransport(opts.socketPath ?? DEFAULT_SOCKET);
  }

  static fromEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Elevation {
    // Windows: the executor's installer leaves its key where Hearth's account may read it, and the
    // executor listens on a named pipe; finding the key is the sign it is installed.
    if (platform === "win32" && !env.DC_ELEVATION_SOCKET) {
      const dir = path.join(env.ProgramData ?? "C:\\ProgramData", "Hearth", "elevation");
      const key = env.DC_ELEVATION_KEY ?? path.join(dir, "elevation.key");
      return new Elevation({ enabled: true, socketPath: WINDOWS_PIPE, keyFile: key, detect: true });
    }
    return new Elevation({
      enabled: env.DC_ELEVATION === "1" || Boolean(env.DC_ELEVATION_SOCKET),
      ...(env.DC_ELEVATION_SOCKET ? { socketPath: env.DC_ELEVATION_SOCKET } : {}),
      ...(env.DC_ELEVATION_KEY ? { keyFile: env.DC_ELEVATION_KEY } : {}),
    });
  }

  async state(force = false): Promise<ElevationState> {
    if (!force && this.cache && Date.now() - this.cache.at < 30_000) return this.cache.state;
    let state: ElevationState;
    if (this.detect && !existsSync(this.keyFile)) {
      state = {
        available: false,
        summary:
          "The elevated executor is not set up on this machine. Administrator-level changes need it; the owner installs it once (deploy/windows/install-elevation.ps1, in PowerShell as administrator).",
      };
    } else if (!this.transport) {
      state = {
        available: false,
        summary:
          "The elevated executor is not set up on this machine. Protected and system-owned changes need it; the owner installs it once (deploy/linux/install-elevation.sh), with a scope they choose.",
      };
    } else {
      try {
        const r = await this.transport.send({ v: PROTOCOL_VERSION, op: "status" });
        const s = r.status;
        if (!r.ok || !s)
          state = { available: false, summary: `The elevated executor answered: ${r.result}` };
        else if (s.problems.length)
          state = {
            available: false,
            status: s,
            summary: `The elevated executor refuses everything until its setup is fixed: ${s.problems.join(" ")}`,
          };
        else
          state = {
            available: true,
            status: s,
            summary: `The elevated executor is ready: ${s.operations.join(", ")} inside ${s.roots.join(", ") || "no folders"}${s.units.length ? `; units ${s.units.join(", ")}` : ""}.`,
          };
      } catch (error) {
        state = {
          available: false,
          summary: `The elevated executor is configured but not answering (${error instanceof Error ? error.message : String(error)}).`,
        };
      }
    }
    this.cache = { at: Date.now(), state };
    return state;
  }

  /**
   * Whether the executor may do `op` on `target` (a path, or a unit name), and if not, what would
   * make it possible, in words Ember can pass on: never "impossible", always what the owner can do.
   */
  async covers(
    op: OperationName,
    target?: string,
  ): Promise<{ ok: true } | { ok: false; why: string; scope: boolean }> {
    const st = await this.state();
    if (!st.available || !st.status) return { ok: false, why: st.summary, scope: false };
    const s = st.status;
    if (!s.operations.includes(op))
      return {
        ok: false,
        scope: true,
        why: `The elevated executor has ${op} switched off. The owner can switch it on in its scope file (deploy/linux/install-elevation.sh --operations).`,
      };
    if (target && op === "unit.control" && !s.units.includes(target))
      return {
        ok: false,
        scope: true,
        why: `${target} is not among the units the executor may control (${s.units.join(", ") || "none yet"}). The owner can add it (install-elevation.sh --add-unit ${target}).`,
      };
    if (target && op !== "unit.control") {
      // The executor's own notion of paths: the machine's (it runs there).
      const p = path.normalize(target);
      if (!s.roots.some((r) => under(p, r) && p !== r))
        return {
          ok: false,
          scope: true,
          why: `${target} is outside the executor's scope (${s.roots.join(", ") || "no folders"}). The owner can widen it (install-elevation.sh --add-root <folder>).`,
        };
    }
    return { ok: true };
  }

  /**
   * A read-only operation (smart.read). No authorization: the owner approved it by switching it on
   * in the executor's scope, and the executor refuses it otherwise.
   */
  async read(op: "smart.read" | "storage.read", params: Params): Promise<ElevatedResponse> {
    if (!this.transport)
      return { ok: false, outcome: "refused", result: (await this.state()).summary };
    try {
      return await this.transport.send({ v: PROTOCOL_VERSION, op, params });
    } catch (error) {
      return {
        ok: false,
        outcome: "failed",
        result: `The elevated executor could not be reached: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }
  }

  private signingKey(): Buffer {
    if (this.key) return this.key;
    return readFileSync(this.keyFile);
  }

  /**
   * Carries out one operation as part of an approved plan step. The authorization is made here,
   * for exactly these parameters, and used once.
   */
  async perform(
    op: OperationName,
    params: Params,
    step: Pick<StepRun, "job">,
  ): Promise<ElevatedResponse> {
    if (!this.transport)
      return { ok: false, outcome: "refused", result: (await this.state()).summary };
    if (!step.job?.approvedAt)
      return {
        ok: false,
        outcome: "refused",
        result: "Elevated operations run only as a step of a plan the owner approved.",
      };
    let key: Buffer;
    try {
      key = this.signingKey();
    } catch {
      return {
        ok: false,
        outcome: "refused",
        result: `Hearth cannot read the executor's key (${this.keyFile}); the installer sets it up.`,
      };
    }
    const now = Date.now();
    const auth = signAuthorization(key, {
      id: randomBytes(16).toString("hex"),
      op,
      fingerprint: fingerprint(op, params),
      jobId: step.job.id,
      step: step.job.seq,
      approvedBy: "you",
      approvedAt: step.job.approvedAt,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + AUTH_MS).toISOString(),
    });
    try {
      return await this.transport.send({ v: PROTOCOL_VERSION, op, params, auth });
    } catch (error) {
      return {
        ok: false,
        outcome: "failed",
        result: `The elevated executor could not be reached: ${error instanceof Error ? error.message : String(error)}. Whether it acted is not known; check its log before trying again.`,
      };
    }
  }
}
