import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { StepParams } from "@dragon-control/core";
import type { ContainerTools } from "../actions/tools";
import { backupFile, readTarget, writeAtomic } from "../admin/files";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { joinUrl, type Fetch } from "./http";

/**
 * Tinyauth's users from Hearth (checklist 46.15, approved by 11-02): the usernames in its users
 * file (whether each has a sign-in code), changing a password, adding, removing and renaming a
 * user. A password is typed in the browser after you confirm it is you, scrambled (bcrypt) on this
 * machine at once, and kept in memory only until its plan runs: it is never stored, logged, put in
 * a plan or shown to Ember. Each change is a protected plan (approving it needs a fresh "it's you"):
 * the users file is backed up, rewritten in one step, Tinyauth is restarted (it reads the file only
 * when it starts), and the change is proved by signing in with the new password. If Tinyauth does
 * not come back or the sign-in fails, the old file is put back and Tinyauth restarted again.
 */

export interface TinyauthUser {
  username: string;
  /** Has a sign-in code (TOTP) set: kept as it is by every change here. */
  twoStep: boolean;
}

export interface TinyauthUsersView {
  /** file: its users file (changes work); environment: users set in its environment (read only here). */
  source: "file" | "environment" | "none";
  users: TinyauthUser[];
  editable: boolean;
  /** Why changes cannot be made here, when they cannot. */
  why?: string;
}

interface Entry {
  username: string;
  hash: string;
  totp?: string;
}

const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;
/** Its users-file setting, in each Tinyauth version's name for it (newest first). */
const FILE_SETTINGS = ["TINYAUTH_AUTH_USERSFILE", "TINYAUTH_USERSFILE", "USERS_FILE"];
const ENV_SETTINGS = ["TINYAUTH_AUTH_USERS", "TINYAUTH_USERS", "USERS"];
const PENDING_MS = 15 * 60_000;

/** username:bcrypt[:totp] per line; blank lines and comments are left out. */
export function parseUsers(text: string): Entry[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [username = "", hash = "", totp] = l.split(":");
      return { username, hash, ...(totp ? { totp } : {}) };
    })
    .filter((e) => e.username && e.hash);
}

export const usersText = (entries: Entry[]) =>
  `${entries.map((e) => [e.username, e.hash, ...(e.totp ? [e.totp] : [])].join(":")).join("\n")}\n`;

const OPS = ["password", "add", "remove", "rename"] as const;
type Op = (typeof OPS)[number];

export class TinyauthUsers {
  /** Passwords typed for a plan: scrambled already, kept in memory only, gone after it runs. */
  private pending = new Map<
    string,
    { serviceId: string; username: string; password: string; hash: string; expires: number }
  >();

  constructor(
    private readonly handle: DbHandle,
    private readonly containers: () => ContainerTools,
    private readonly backupRoot: string,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Where its users are: the container, and its users file on this machine. */
  private async locate(serviceId: string) {
    const service = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.id, serviceId))
      .get();
    if (!service) throw new NotFoundError("No such service.");
    if (!/tinyauth/i.test(`${service.image ?? ""} ${service.name}`))
      throw new InvalidRequestError(`${service.name} is not Tinyauth.`);
    const target = service.checkTarget ?? "";
    if (target.startsWith("demo:"))
      return { service, problem: "Sample data has no real Tinyauth to read." } as const;
    const container = target.startsWith("container:")
      ? target.slice("container:".length)
      : undefined;
    if (!container)
      return {
        service,
        problem: `Hearth does not know which container ${service.name} is.`,
      } as const;
    const host = await this.handle.db
      .select()
      .from(t.hosts)
      .where(eq(t.hosts.id, service.hostId))
      .get();
    if (host?.connection !== "this-machine")
      return {
        service,
        container,
        problem: `${service.name} runs on another machine; its users can be changed from the Hearth on that machine.`,
      } as const;
    const cfg = await this.containers().config(container);
    if (!cfg)
      return { service, container, problem: "Docker has no container by that name." } as const;
    const setting = FILE_SETTINGS.find((k) => cfg.pathSettings?.[k]);
    if (!setting) {
      const env = ENV_SETTINGS.some((k) => cfg.environmentNames.includes(k));
      return {
        service,
        container,
        source: env ? ("environment" as const) : ("none" as const),
        problem: env
          ? `${service.name}'s users are set in its environment (its compose file), not a users file, so Hearth only shows them there. Moving them to a users file lets you change them here; Ember can explain how.`
          : `${service.name} has no users file set (TINYAUTH_AUTH_USERSFILE), so there are no users for Hearth to show.`,
      } as const;
    }
    const inside = cfg.pathSettings[setting]!;
    // The users file on this machine: through the bind mount that holds it.
    const mount = cfg.mounts
      .filter(
        (m) =>
          inside === m.destination || inside.startsWith(`${m.destination.replace(/\/$/, "")}/`),
      )
      .sort((a, b) => b.destination.length - a.destination.length)[0];
    if (!mount || !path.isAbsolute(mount.source) || mount.readOnly)
      return {
        service,
        container,
        source: "file" as const,
        problem: `${service.name}'s users file is not in a folder Hearth can reach on this machine.`,
      } as const;
    const file = path.join(mount.source, path.relative(mount.destination, inside));
    return { service, container, source: "file" as const, file } as const;
  }

  /** The usernames (never a password or its scramble), and whether changes work here. */
  async list(serviceId: string): Promise<TinyauthUsersView> {
    const where = await this.locate(serviceId);
    if (!("file" in where) || !where.file) {
      return {
        source: "source" in where && where.source ? where.source : "none",
        users: [],
        editable: false,
        why: where.problem,
      };
    }
    const cur = await readTarget(where.file).catch((error: unknown) => {
      throw new ConflictError(
        `${where.service.name}'s users file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return {
      source: "file",
      users: parseUsers(cur.content).map((e) => ({
        username: e.username,
        twoStep: Boolean(e.totp),
      })),
      editable: true,
    };
  }

  /**
   * Takes a password typed in the browser (the caller has checked it is you), scrambles it now,
   * and returns a reference for the plan. The password itself never goes into a plan.
   */
  async prepare(serviceId: string, username: string, password: string): Promise<{ ref: string }> {
    if (!USERNAME.test(username))
      throw new InvalidRequestError(
        "A username is 1 to 64 letters, digits, dots, dashes, underscores or @.",
      );
    if (password.length < 8) throw new InvalidRequestError("Use at least 8 characters.");
    if (Buffer.byteLength(password) > 72)
      throw new InvalidRequestError("Use at most 72 bytes (Tinyauth's scrambling stops there).");
    if (password.includes("\n")) throw new InvalidRequestError("A password is one line.");
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    const ref = `pw-${randomBytes(12).toString("hex")}`;
    this.pending.set(ref, {
      serviceId,
      username,
      password,
      hash: await bcrypt.hash(password, 10),
      expires: Date.now() + PENDING_MS,
    });
    return { ref };
  }

  async plan(
    service: { id: string; name: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!OPS.includes(op)) throw new Error(`Say what to do: ${OPS.join(", ")}.`);
    const where = await this.locate(service.id);
    if (!("file" in where) || !where.file) throw new Error(where.problem ?? "No users file.");
    const cur = await readTarget(where.file);
    const users = parseUsers(cur.content);
    const username = String(params?.username ?? "").trim();
    const user = users.find((u) => u.username === username);
    const ref = typeof params?.secretRef === "string" ? params.secretRef : "";
    const secret = ref ? this.pending.get(ref) : undefined;
    let label: string;
    let after: string;
    let newName = "";
    if (op === "password" || op === "add") {
      if (!secret || secret.serviceId !== service.id || secret.username !== username)
        throw new Error("Type the new password again in the panel.");
      if (op === "password" && !user) throw new Error(`${service.name} has no user "${username}".`);
      if (op === "add" && user)
        throw new Error(`${service.name} already has a user "${username}".`);
      label =
        op === "password"
          ? `Change ${username}'s password in ${service.name}`
          : `Add the user ${username} to ${service.name}`;
      after =
        op === "password" ? "a new password (never shown)" : "a user, with the password you typed";
    } else if (op === "remove") {
      if (!user) throw new Error(`${service.name} has no user "${username}".`);
      if (users.length === 1)
        throw new Error(`${username} is the only user: without one, nobody could sign in.`);
      label = `Remove the user ${username} from ${service.name}`;
      after = "removed (can no longer sign in)";
    } else {
      newName = String(params?.newName ?? "").trim();
      if (!user) throw new Error(`${service.name} has no user "${username}".`);
      if (!USERNAME.test(newName))
        throw new Error("A username is 1 to 64 letters, digits, dots, dashes, underscores or @.");
      if (users.some((u) => u.username === newName))
        throw new Error(`${service.name} already has a user "${newName}".`);
      label = `Rename ${username} to ${newName} in ${service.name}`;
      after = `signs in as ${newName}, with the same password`;
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: {
        op,
        username,
        ...(newName ? { newName } : {}),
        ...(ref ? { secretRef: ref } : {}),
        // The file as it was when planned: a changed file is never overwritten.
        fileHash: cur.hash,
        protected: "yes",
      },
      change: {
        summary: `${label}. Its users file is backed up, then ${service.name} restarts (sites behind it wait a few seconds) and the change is checked by signing in; if anything fails the old file is put back.`,
        settings: [
          {
            name: username,
            before: user ? (user.totp ? "a user with a sign-in code" : "a user") : "not a user",
            after: `${after}${user?.totp && op !== "remove" ? "; its sign-in code stays" : ""}. ${service.name} restarts`,
          },
        ],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl?: string | null },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const username = String(p.username ?? "");
    const newName = String(p.newName ?? "");
    const ref = String(p.secretRef ?? "");
    const secret = ref ? this.pending.get(ref) : undefined;
    // Used once: whatever happens, the typed password is let go after this run.
    if (ref) this.pending.delete(ref);
    const outcome = await this.change(
      service,
      op,
      username,
      newName,
      secret,
      String(p.fileHash ?? ""),
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${username}${newName ? ` to ${newName}` : ""}) in ${service.name}'s users`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }

  private async change(
    service: { id: string; name: string; localUrl?: string | null },
    op: Op,
    username: string,
    newName: string,
    secret: { password: string; hash: string; expires: number } | undefined,
    fileHash: string,
  ): Promise<StepOutcome> {
    if ((op === "password" || op === "add") && (!secret || secret.expires < Date.now()))
      return {
        ok: false,
        result:
          "The password typed for this is gone (15 minutes passed, or Hearth restarted). Nothing was changed: type it again in the panel.",
      };
    const where = await this.locate(service.id);
    if (!("file" in where) || !where.file || !("container" in where) || !where.container)
      return { ok: false, result: where.problem ?? "No users file." };
    const file = where.file;
    const container = where.container;
    const cur = await readTarget(file);
    const users = parseUsers(cur.content);
    if (cur.hash !== fileHash)
      return {
        ok: false,
        stale: true,
        result: `${service.name}'s users file changed since this was planned; nothing was changed. Plan it again.`,
      };
    let next: Entry[];
    if (op === "password")
      next = users.map((u) => (u.username === username ? { ...u, hash: secret!.hash } : u));
    else if (op === "add") next = [...users, { username, hash: secret!.hash }];
    else if (op === "remove") next = users.filter((u) => u.username !== username);
    else next = users.map((u) => (u.username === username ? { ...u, username: newName } : u));
    const backup = await backupFile(this.backupRoot, "tinyauth", file, cur.content, {
      reason: `users-${op}-${randomBytes(2).toString("hex")}`,
      beforeHash: cur.hash,
    });
    // The backup holds password scrambles too: only this account may read it.
    await fs.chmod(path.join(backup, path.basename(file)), 0o600).catch(() => undefined);
    await writeAtomic(file, usersText(next), { mode: cur.mode, uid: cur.uid, gid: cur.gid });
    const up = await this.restartAndWait(container, service.localUrl);
    const signedIn =
      up && (op === "password" || op === "add")
        ? await this.signIn(service.localUrl, username, secret!.password)
        : up;
    if (up && signedIn) {
      const done = {
        password: `${username}'s password is changed`,
        add: `${username} can sign in now`,
        remove: `${username} can no longer sign in`,
        rename: `${username} is now ${newName}`,
      }[op];
      return {
        ok: true,
        result: `${done}. ${service.name} restarted and ${op === "password" || op === "add" ? "a sign-in with the new password worked" : "is running again"}. The old users file is backed up.`,
      };
    }
    // Put it back as it was.
    await writeAtomic(file, cur.content, { mode: cur.mode, uid: cur.uid, gid: cur.gid });
    const back = await this.restartAndWait(container, service.localUrl);
    return {
      ok: false,
      result: `${!up ? `${service.name} did not come back after the restart` : "Signing in with the new password did not work"}, so the old users file was put back${back ? ` and ${service.name} is running again` : `; ${service.name} is still not answering: check it now`}.`,
    };
  }

  /** Restarts it and waits until Docker says it runs and it answers its health check. */
  private async restartAndWait(container: string, localUrl?: string | null): Promise<boolean> {
    await this.containers().restart(container);
    for (let i = 0; i < 30; i++) {
      await this.wait(1000);
      const r = await this.containers()
        .runtime(container)
        .catch(() => undefined);
      if (!r?.running) continue;
      if (!localUrl) return true;
      const ok = await this.fetchImpl(joinUrl(localUrl, "/api/healthz"), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      })
        .then((res) => res.ok)
        .catch(() => false);
      if (ok) return true;
    }
    return false;
  }

  /** Proves a password: Tinyauth's own sign-in, on its own address (a sign-in code still pending counts). */
  private async signIn(localUrl: string | null | undefined, username: string, password: string) {
    if (!localUrl) return true;
    const res = await this.fetchImpl(joinUrl(localUrl, "/api/user/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => undefined);
    return res?.status === 200;
  }
}
