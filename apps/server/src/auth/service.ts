import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq, lt } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { recordAudit } from "../store/audit";
import { getSetting } from "../store/settings";
import { fingerprint } from "../pcs/hearth-key";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import {
  DEFAULT_KDF_COST,
  hashSecret,
  kdf,
  newKeyPair,
  newRecoveryKey,
  newSalt,
  newSetupCode,
  normaliseRecoveryKey,
  open,
  prfKey,
  randomToken,
  saltBytes,
  seal,
  sha256,
  verifySecret,
} from "./crypto";
import type { KeyGuard } from "./keyguard";

/**
 * One owner per installation. Claiming needs a one-time setup code that
 * only someone with access to the machine (or its installer) can see, so
 * nobody else on the network can claim it first.
 */

/** Codes as typed: device codes in any case, with or without the dash; join tokens as they are. */
export function pairKey(code: string): string {
  const c = code.trim();
  return /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/.test(c) ? normaliseRecoveryKey(c) : c;
}

export class UnauthorizedError extends Error {
  override name = "Unauthorized";
  statusCode = 401;
}
export class ForbiddenAuthError extends Error {
  override name = "Forbidden";
  statusCode = 403;
}
export class TooManyAttemptsError extends Error {
  override name = "Too many attempts";
  statusCode = 429;
}

export const SESSION_DAYS = 30;
/** "Remember this device": signed in this long, extended while it is used. */
export const REMEMBER_DAYS = 90;
/** Not remembered: the sign-in ends after this long (and when the browser closes). */
export const SHORT_HOURS = 12;
/** Failed sign-ins from the internet, across every address, before public sign-in pauses. */
export const PUBLIC_FAILURE_CAP = 30;

/** Where a sign-in comes from and what it asks for. */
export interface SignInContext {
  userAgent?: string;
  /** Remember this device (default yes). */
  remember?: boolean;
  /** Set when it came through the public address: the client's IP, for its own throttle. */
  publicIp?: string;
}

const lifetimeMs = (persistent: boolean) =>
  persistent ? REMEMBER_DAYS * 86_400_000 : SHORT_HOURS * 3_600_000;
/** How long a password or passkey check counts as "just now" for sensitive steps. */
export const RECENT_MS = 5 * 60_000;
/** How long protected secrets stay unlocked after you unlock them. */
export const UNLOCK_MS = 5 * 60_000;
export const MIN_PASSWORD = 12;

export interface AuthDeps {
  dataDir?: string;
  keyGuard: KeyGuard;
  kdfCost?: number;
  rpName?: string;
}

export interface Session {
  id: string;
  method: (typeof t.sessions.$inferSelect)["method"];
  verifiedAt: string;
  createdAt: string;
}

export interface RequestOrigin {
  /** e.g. "https://desktop-pc.tail1a2b3c.ts.net" */
  origin: string;
  /** e.g. "desktop-pc.tail1a2b3c.ts.net" */
  rpId: string;
}

type Db = DbHandle["db"];

/** Failed attempts slow everything down: 5 free, then 30s doubling to 15 min. */
class Throttle {
  private failures = 0;
  private until = 0;
  check() {
    const wait = this.until - Date.now();
    if (wait > 0) {
      throw new TooManyAttemptsError(
        `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`,
      );
    }
  }
  fail() {
    this.failures++;
    if (this.failures >= 5) {
      this.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (this.failures - 5));
    }
  }
  succeed() {
    this.failures = 0;
    this.until = 0;
  }
}

export class Auth {
  /** Set on a PC that can join another Hearth: which one it belongs to, if any. */
  joinedTo?: () => Promise<{
    name: string;
    url: string;
    online: boolean;
    pcId?: string;
  } | null>;
  private readonly cost: number;
  private readonly throttle = new Throttle();
  /**
   * Sign-ins through the public address are throttled per client address, and all of them
   * together are capped, so strangers on the internet can never lock you out at home or on
   * Tailscale (those keep their own throttle).
   */
  private readonly publicThrottles = new Map<string, Throttle>();
  private readonly publicFailures: number[] = [];

  private throttleFor(ctx: SignInContext = {}) {
    if (ctx.publicIp === undefined) return this.throttle;
    let t = this.publicThrottles.get(ctx.publicIp);
    if (!t) {
      if (this.publicThrottles.size > 5000) this.publicThrottles.clear();
      t = new Throttle();
      this.publicThrottles.set(ctx.publicIp, t);
    }
    const failures = this.publicFailures;
    const one = t;
    return {
      check() {
        const hourAgo = Date.now() - 3_600_000;
        while (failures.length && failures[0]! < hourAgo) failures.shift();
        if (failures.length >= PUBLIC_FAILURE_CAP) {
          throw new TooManyAttemptsError(
            "Too many failed sign-ins from the internet in the last hour. Sign-in from the internet is paused for a while; at home or on Tailscale it still works.",
          );
        }
        one.check();
      },
      fail() {
        failures.push(Date.now());
        one.fail();
      },
      succeed() {
        one.succeed();
      },
    };
  }
  /** Protected private keys held in memory, per session, while unlocked. */
  private readonly unlocked = new Map<string, { key: Buffer; until: number }>();
  private readonly challenges = new Map<string, number>();
  private automationKey: Buffer | undefined;

  constructor(
    private readonly handle: DbHandle,
    private readonly deps: AuthDeps,
  ) {
    this.cost = deps.kdfCost ?? DEFAULT_KDF_COST;
  }

  private get db(): Db {
    return this.handle.db;
  }

  /* ---------- Claiming ---------- */

  async claimed(): Promise<boolean> {
    return Boolean(await this.db.select().from(t.owner).get());
  }

  private codeFile() {
    return this.deps.dataDir ? path.join(this.deps.dataDir, "setup-code.txt") : undefined;
  }
  private memoryCode: string | undefined;

  /** The current setup code, created if needed, or null once claimed. */
  async setupCode(): Promise<string | null> {
    if (await this.claimed()) return null;
    const file = this.codeFile();
    if (file && existsSync(file)) return readFileSync(file, "utf8").trim();
    const code = this.memoryCode ?? newSetupCode();
    this.memoryCode = code;
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${code}\n`, { mode: 0o600 });
    }
    return code;
  }

  async setup(input: {
    code: string;
    password: string;
  }): Promise<{ token: string; recoveryKey: string }> {
    this.throttle.check();
    const expected = await this.setupCode();
    if (!expected) throw new ConflictError("Hearth is already set up. Sign in instead.");
    if (input.code.trim().toUpperCase() !== expected) {
      this.throttle.fail();
      throw new ForbiddenAuthError(
        "That setup code is not right. It is shown where Hearth was installed.",
      );
    }
    this.throttle.succeed();
    checkPassword(input.password);

    const recoveryKey = newRecoveryKey();
    const now = new Date().toISOString();
    const pair = newKeyPair();
    const passwordSalt = newSalt();
    const recoverySalt = newSalt();
    const automationKey = randomBytes(32);
    const [passwordHash, recoveryHash, passwordKek, recoveryKek, sealed] = await Promise.all([
      hashSecret(input.password, this.cost),
      hashSecret(recoveryKey, this.cost),
      kdf(input.password, saltBytes(passwordSalt), this.cost),
      kdf(recoveryKey, saltBytes(recoverySalt), this.cost),
      this.deps.keyGuard.seal(automationKey),
    ]);

    let token = "";
    await withTransaction(this.handle, async () => {
      if (await this.db.select().from(t.owner).get()) {
        throw new ConflictError("Hearth is already set up. Sign in instead.");
      }
      await this.db.insert(t.owner).values({
        id: 1,
        passwordHash,
        recoveryHash,
        createdAt: now,
        passwordChangedAt: now,
      });
      await this.db.insert(t.vaultKeys).values({
        id: 1,
        automationKeySealed: sealed,
        keyGuard: this.deps.keyGuard.kind,
        protectedPublicKey: pair.publicKey,
        privateByPassword: seal(passwordKek, pair.privateKey, "private-key"),
        passwordKdfSalt: passwordSalt,
        privateByRecovery: seal(recoveryKek, pair.privateKey, "private-key"),
        recoveryKdfSalt: recoverySalt,
        prfSalt: newSalt(),
      });
      token = await this.createSession("setup");
      await recordAudit(this.db, {
        actor: "you",
        action: "Secured this installation",
        target: "security",
      });
    });
    this.automationKey = automationKey;
    this.unlock(sha256(token), pair.privateKey);
    const file = this.codeFile();
    if (file && existsSync(file)) rmSync(file, { force: true });
    this.memoryCode = undefined;
    return { token, recoveryKey };
  }

  /* ---------- One-time codes: a device's sign-in, a PC's join link ---------- */

  /**
   * A code that signs in one device (10 minutes) or joins one PC (30 minutes), once. Only its
   * hash is kept. Making one is a sensitive step: the caller checks you confirmed it is you.
   */
  async newPairCode(
    purpose: "device" | "pc" | "home",
  ): Promise<{ code: string; expiresAt: string }> {
    const code = purpose === "pc" ? randomToken(18) : newSetupCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (purpose === "pc" ? 30 : 10) * 60_000).toISOString();
    await this.db.delete(t.pairCodes).where(lt(t.pairCodes.expiresAt, now.toISOString()));
    await this.db.insert(t.pairCodes).values({
      id: sha256(pairKey(code)),
      purpose,
      createdAt: now.toISOString(),
      expiresAt,
    });
    await recordAudit(this.db, {
      actor: "you",
      action:
        purpose === "device"
          ? "Made a code to sign in a device"
          : purpose === "home"
            ? "Made a code to pair a home tablet"
            : "Made a link to add a PC",
      target: "security",
    });
    return { code, expiresAt };
  }

  /** Uses a code once; wrong guesses are throttled like passwords. */
  async usePairCode(
    code: string,
    purpose: "device" | "pc" | ("device" | "pc" | "home")[],
    ctx: SignInContext = {},
  ): Promise<"device" | "pc" | "home"> {
    const allowed = Array.isArray(purpose) ? purpose : [purpose];
    const throttle = this.throttleFor(ctx);
    throttle.check();
    const id = sha256(pairKey(code));
    const now = new Date().toISOString();
    const row = await this.db.select().from(t.pairCodes).where(eq(t.pairCodes.id, id)).get();
    if (!row || !allowed.includes(row.purpose) || row.usedAt || row.expiresAt < now) {
      throttle.fail();
      throw new UnauthorizedError(
        row && (row.usedAt || row.expiresAt < now)
          ? "That code was already used or has run out. Make a new one."
          : "That code is not right. Check it, or make a new one.",
      );
    }
    await this.db.update(t.pairCodes).set({ usedAt: now }).where(eq(t.pairCodes.id, id));
    throttle.succeed();
    return row.purpose;
  }

  /**
   * A new PC's setup, with the Hearth API key (pcs/hearth-key.ts): a one-time join code. Wrong
   * keys are throttled like passwords.
   */
  async linkWithKey(secret: string, ctx: SignInContext = {}): Promise<{ code: string }> {
    if (!(await this.claimed())) throw new UnauthorizedError("Hearth is not set up yet.");
    const throttle = this.throttleFor(ctx);
    throttle.check();
    const kept = await getSetting(this.db, "link_key_hash");
    if (!kept || fingerprint(secret) !== kept) {
      throttle.fail();
      throw new UnauthorizedError(
        "That key is not right, or it was refreshed. Copy the Hearth API key again from the Secure Vault.",
      );
    }
    throttle.succeed();
    const { code } = await this.newPairCode("pc");
    await recordAudit(this.db, {
      actor: "you",
      action: `A new PC linked with the Hearth API key (${describeDevice(ctx.userAgent ?? null)})`,
      target: "security",
    });
    return { code };
  }

  /** Checks the Hearth API key without linking anything (another Hearth reading the layout). */
  async checkLinkKey(secret: string, ctx: SignInContext = {}): Promise<void> {
    if (!(await this.claimed())) throw new UnauthorizedError("Hearth is not set up yet.");
    const throttle = this.throttleFor(ctx);
    throttle.check();
    const kept = await getSetting(this.db, "link_key_hash");
    if (!kept || fingerprint(secret) !== kept) {
      throttle.fail();
      throw new UnauthorizedError(
        "That key is not right, or it was refreshed. Copy the Hearth API key again from the Secure Vault.",
      );
    }
    throttle.succeed();
  }

  /** Signs a device in with a code from Add a device. Sensitive steps still ask it is you. */
  async pairDevice(code: string, ctx: SignInContext = {}): Promise<string> {
    if (!(await this.claimed())) throw new UnauthorizedError("Hearth is not set up yet.");
    const purpose = await this.usePairCode(code, ["device", "home"], ctx);
    // A home tablet stays signed in (it lives on the wall) and reaches the home dashboard only.
    const home = purpose === "home";
    const token = await this.createSession(
      home ? "home" : "paired",
      home ? { ...ctx, remember: true } : ctx,
      {
        verified: false,
      },
    );
    await recordAudit(this.db, {
      actor: "you",
      action: home
        ? `Paired a home tablet with a code (${describeDevice(ctx.userAgent ?? null)})`
        : `Signed in a device with a code (${describeDevice(ctx.userAgent ?? null)})`,
      target: "security",
    });
    return token;
  }

  /* ---------- Sessions ---------- */

  private async createSession(
    method: Session["method"],
    ctx: SignInContext = {},
    opts: { verified?: boolean } = {},
  ): Promise<string> {
    const token = randomToken();
    const now = new Date();
    const persistent = ctx.remember !== false;
    await this.db.insert(t.sessions).values({
      id: sha256(token),
      method,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + lifetimeMs(persistent)).toISOString(),
      // A device signed in with a code has not proved it is you yet.
      verifiedAt: (opts.verified === false ? new Date(0) : now).toISOString(),
      userAgent: ctx.userAgent?.slice(0, 200) ?? null,
      persistent,
      viaPublic: ctx.publicIp !== undefined,
    });
    return token;
  }

  /** Whether a session lasts (remembered device) or ends with the browser. */
  async persistent(sessionId: string): Promise<boolean> {
    const row = await this.db.select().from(t.sessions).where(eq(t.sessions.id, sessionId)).get();
    return row?.persistent ?? true;
  }

  /** Every signed-in device, newest use first. Never the session tokens. */
  async devices(current: Session) {
    const rows = await this.db.select().from(t.sessions);
    return rows
      .filter((r) => Date.parse(r.expiresAt) > Date.now())
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((r) => ({
        id: r.id.slice(0, 16),
        method: r.method,
        device: describeDevice(r.userAgent),
        signedInAt: r.createdAt,
        lastSeenAt: r.lastSeenAt,
        expiresAt: r.expiresAt,
        remembered: r.persistent,
        viaInternet: r.viaPublic,
        current: r.id === current.id,
      }));
  }

  /** Signs one device out (by the short id the list shows). */
  async signOutDevice(shortId: string) {
    if (!/^[\w-]{16}$/.test(shortId)) throw new NotFoundError("No such device.");
    const rows = (await this.db.select().from(t.sessions)).filter((r) => r.id.startsWith(shortId));
    if (rows.length !== 1) throw new NotFoundError("No such device.");
    this.unlocked.delete(rows[0]!.id);
    await withTransaction(this.handle, async () => {
      await this.db.delete(t.sessions).where(eq(t.sessions.id, rows[0]!.id));
      await recordAudit(this.db, {
        actor: "you",
        action: `Signed out a device (${describeDevice(rows[0]!.userAgent)})`,
        target: "security",
      });
    });
  }

  /** Whether the password sign-in also asks for a name. */
  async usernameRequired(): Promise<boolean> {
    return Boolean((await this.db.select().from(t.owner).get())?.username);
  }

  /**
   * Sets the sign-in name and a new password without the old one: allowed only while this
   * session has the vault unlocked (you just confirmed it is you with a passkey or the
   * password), because the new password must re-wrap the vault's key.
   */
  async setCredentials(session: Session, input: { username?: string; password: string }) {
    checkPassword(input.password);
    const privateKey = this.privateKeyFor(session);
    if (!privateKey || !this.recentlyVerified(session)) {
      throw new ForbiddenAuthError(
        "Confirm it is you with your passkey first (it unlocks the vault key the new password protects).",
      );
    }
    const username = input.username?.trim() || null;
    if (username && !/^[\w .@-]{1,40}$/.test(username))
      throw new InvalidRequestError(
        "Use up to 40 letters, numbers, spaces, or . @ - _ for the name.",
      );
    await this.db.update(t.owner).set({ username }).where(eq(t.owner.id, 1));
    await this.setPassword(
      input.password,
      privateKey,
      username ? "Set the sign-in name and a new password" : "Set a new password",
    );
    await this.markVerified(session.id);
  }

  /** The session behind a cookie token, extended while in use; null if none or expired. */
  async session(token: string | undefined): Promise<Session | null> {
    if (!token) return null;
    const id = sha256(token);
    const row = await this.db.select().from(t.sessions).where(eq(t.sessions.id, id)).get();
    if (!row) return null;
    const now = Date.now();
    if (Date.parse(row.expiresAt) <= now) {
      await this.db.delete(t.sessions).where(eq(t.sessions.id, id));
      this.unlocked.delete(id);
      return null;
    }
    // Sliding expiry, written at most once an hour; a device not remembered keeps its short end.
    if (now - Date.parse(row.lastSeenAt) > 3_600_000) {
      await this.db
        .update(t.sessions)
        .set({
          lastSeenAt: new Date(now).toISOString(),
          ...(row.persistent ? { expiresAt: new Date(now + lifetimeMs(true)).toISOString() } : {}),
        })
        .where(eq(t.sessions.id, id));
    }
    return { id, method: row.method, verifiedAt: row.verifiedAt, createdAt: row.createdAt };
  }

  async signOut(session: Session) {
    this.unlocked.delete(session.id);
    await this.db.delete(t.sessions).where(eq(t.sessions.id, session.id));
  }

  async signOutEverywhere(session: Session) {
    this.unlocked.clear();
    await withTransaction(this.handle, async () => {
      await this.db.delete(t.sessions);
      await recordAudit(this.db, {
        actor: "you",
        action: "Signed out everywhere",
        target: "security",
      });
    });
    void session;
  }

  async pruneSessions() {
    await this.db.delete(t.sessions).where(lt(t.sessions.expiresAt, new Date().toISOString()));
  }

  recentlyVerified(session: Session): boolean {
    return Date.now() - Date.parse(session.verifiedAt) < RECENT_MS;
  }

  requireRecent(session: Session) {
    if (!this.recentlyVerified(session)) {
      throw new ForbiddenAuthError("Confirm it is you first (password or passkey).");
    }
  }

  private async markVerified(sessionId: string) {
    await this.db
      .update(t.sessions)
      .set({ verifiedAt: new Date().toISOString() })
      .where(eq(t.sessions.id, sessionId));
  }

  /* ---------- Password and recovery ---------- */

  private async ownerRow() {
    const row = await this.db.select().from(t.owner).get();
    if (!row) throw new ConflictError("Hearth is not set up yet.");
    return row;
  }

  private async keys() {
    const row = await this.db.select().from(t.vaultKeys).get();
    if (!row) throw new ConflictError("Hearth is not set up yet.");
    return row;
  }

  private async privateFromPassword(password: string): Promise<Buffer> {
    const keys = await this.keys();
    const kek = await kdf(password, saltBytes(keys.passwordKdfSalt), this.cost);
    return open(kek, keys.privateByPassword, "private-key");
  }

  /** Signs in with the password, or (with a session) confirms it is you and unlocks the vault. */
  async withPassword(
    password: string,
    current: Session | null,
    ctx: SignInContext = {},
    username?: string,
  ): Promise<{ token?: string; session: string; persistent: boolean }> {
    const throttle = this.throttleFor(ctx);
    throttle.check();
    const owner = await this.ownerRow();
    // With a sign-in name set, a new sign-in needs it too (confirming inside a session does not).
    const nameOk =
      current || !owner.username
        ? true
        : (username ?? "").trim().toLowerCase() === owner.username.toLowerCase();
    const passwordOk = await verifySecret(password, owner.passwordHash);
    if (!nameOk || !passwordOk) {
      throttle.fail();
      throw new UnauthorizedError(
        owner.username && !current
          ? "That name or password is not right."
          : "That password is not right.",
      );
    }
    throttle.succeed();
    const privateKey = await this.privateFromPassword(password);
    if (current) {
      await this.markVerified(current.id);
      this.unlock(current.id, privateKey);
      return { session: current.id, persistent: true };
    }
    const token = await this.createSession("password", ctx);
    this.unlock(sha256(token), privateKey);
    return { token, session: sha256(token), persistent: ctx.remember !== false };
  }

  /** Recovery: proves ownership with the recovery key and sets a new password at the same time. */
  async recover(input: { recoveryKey: string; newPassword: string }, ctx: SignInContext = {}) {
    const throttle = this.throttleFor(ctx);
    throttle.check();
    const owner = await this.ownerRow();
    const key = normaliseRecoveryKey(input.recoveryKey);
    if (!(await verifySecret(key, owner.recoveryHash))) {
      throttle.fail();
      throw new UnauthorizedError("That recovery key is not right.");
    }
    throttle.succeed();
    checkPassword(input.newPassword);
    const keys = await this.keys();
    const recoveryKek = await kdf(key, saltBytes(keys.recoveryKdfSalt), this.cost);
    const privateKey = open(recoveryKek, keys.privateByRecovery, "private-key");
    await this.setPassword(
      input.newPassword,
      privateKey,
      "Reset the password with the recovery key",
    );
    const token = await this.createSession("recovery", ctx);
    this.unlock(sha256(token), privateKey);
    return token;
  }

  async changePassword(session: Session, current: string, next: string) {
    checkPassword(next);
    this.throttle.check();
    const owner = await this.ownerRow();
    if (!(await verifySecret(current, owner.passwordHash))) {
      this.throttle.fail();
      throw new UnauthorizedError("Your current password is not right.");
    }
    this.throttle.succeed();
    const privateKey = await this.privateFromPassword(current);
    await this.setPassword(next, privateKey, "Changed the password");
    await this.markVerified(session.id);
  }

  private async setPassword(password: string, privateKey: Buffer, audit: string) {
    const salt = newSalt();
    const [hash, kek] = await Promise.all([
      hashSecret(password, this.cost),
      kdf(password, saltBytes(salt), this.cost),
    ]);
    await withTransaction(this.handle, async () => {
      const now = new Date().toISOString();
      await this.db
        .update(t.owner)
        .set({ passwordHash: hash, passwordChangedAt: now })
        .where(eq(t.owner.id, 1));
      await this.db
        .update(t.vaultKeys)
        .set({ privateByPassword: seal(kek, privateKey, "private-key"), passwordKdfSalt: salt })
        .where(eq(t.vaultKeys.id, 1));
      await recordAudit(this.db, { actor: "you", action: audit, target: "security" });
    });
  }

  /** A new recovery key replaces the old one, which stops working. */
  async regenerateRecoveryKey(session: Session, password: string): Promise<string> {
    await this.withPassword(password, session);
    const privateKey = await this.privateFromPassword(password);
    const recoveryKey = newRecoveryKey();
    const salt = newSalt();
    const [hash, kek] = await Promise.all([
      hashSecret(recoveryKey, this.cost),
      kdf(recoveryKey, saltBytes(salt), this.cost),
    ]);
    await withTransaction(this.handle, async () => {
      await this.db.update(t.owner).set({ recoveryHash: hash }).where(eq(t.owner.id, 1));
      await this.db
        .update(t.vaultKeys)
        .set({ privateByRecovery: seal(kek, privateKey, "private-key"), recoveryKdfSalt: salt })
        .where(eq(t.vaultKeys.id, 1));
      await recordAudit(this.db, {
        actor: "you",
        action: "Replaced the recovery key",
        target: "security",
      });
    });
    return recoveryKey;
  }

  /* ---------- Vault keys ---------- */

  private unlock(sessionId: string, privateKey: Buffer) {
    this.unlocked.set(sessionId, { key: privateKey, until: Date.now() + UNLOCK_MS });
  }

  lock(session: Session) {
    this.unlocked.delete(session.id);
  }

  /** The protected private key for this session, if unlocked and not expired. */
  privateKeyFor(session: Session): Buffer | undefined {
    const entry = this.unlocked.get(session.id);
    if (!entry) return undefined;
    if (entry.until <= Date.now()) {
      this.unlocked.delete(session.id);
      return undefined;
    }
    return entry.key;
  }

  unlockedUntil(session: Session): string | undefined {
    return this.privateKeyFor(session)
      ? new Date(this.unlocked.get(session.id)!.until).toISOString()
      : undefined;
  }

  /** How hard the password and recovery key derivations are (saved with sealed copies). */
  get kdfCost(): number {
    return this.cost;
  }

  async publicKey(): Promise<string> {
    return (await this.keys()).protectedPublicKey;
  }

  /** The automation key, unsealed by the OS on first use and then kept in memory. */
  async automation(): Promise<Buffer> {
    if (this.automationKey) return this.automationKey;
    const keys = await this.keys();
    if (keys.keyGuard !== this.deps.keyGuard.kind) {
      throw new ConflictError(
        "Automation secrets were sealed on a different system and cannot be opened here.",
      );
    }
    try {
      this.automationKey = await this.deps.keyGuard.unseal(keys.automationKeySealed);
    } catch {
      throw new ConflictError(
        "Automation secrets cannot be opened by this Windows account. Run Hearth as the account that set it up.",
      );
    }
    return this.automationKey;
  }

  /* ---------- Passkeys ---------- */

  private remember(challenge: string) {
    const now = Date.now();
    for (const [c, exp] of this.challenges) if (exp < now) this.challenges.delete(c);
    this.challenges.set(challenge, now + 5 * 60_000);
  }
  private consume = (challenge: string) => {
    const exp = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    return exp !== undefined && exp > Date.now();
  };

  async passkeyList() {
    const rows = await this.db.select().from(t.passkeys);
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt ?? undefined,
      unlocksVault: Boolean(p.wrappedPrivateKey),
    }));
  }

  async registrationOptions(session: Session, where: RequestOrigin) {
    this.requireRecent(session);
    if (!this.privateKeyFor(session)) {
      throw new ForbiddenAuthError("Confirm your password first, then add the passkey.");
    }
    const existing = await this.db.select().from(t.passkeys);
    const keys = await this.keys();
    const options = await generateRegistrationOptions({
      rpName: this.deps.rpName ?? "Hearth",
      rpID: where.rpId,
      userName: "owner",
      userDisplayName: "Owner",
      userID: new TextEncoder().encode("dragon-control-owner"),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      // The salt travels as base64url text; the browser turns it into bytes for the authenticator.
      extensions: { prf: { eval: { first: keys.prfSalt } } } as never,
    });
    this.remember(options.challenge);
    return options;
  }

  async register(
    session: Session,
    where: RequestOrigin,
    input: { response: RegistrationResponseJSON; name: string; prf?: string },
  ) {
    this.requireRecent(session);
    const privateKey = this.privateKeyFor(session);
    if (!privateKey)
      throw new ForbiddenAuthError("Confirm your password first, then add the passkey.");
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: this.consume,
      expectedOrigin: where.origin,
      expectedRPID: where.rpId,
      requireUserVerification: true,
    }).catch((e: unknown) => {
      throw new InvalidRequestError(`The passkey could not be verified: ${String(e)}`);
    });
    if (!result.verified || !result.registrationInfo) {
      throw new InvalidRequestError("The passkey could not be verified.");
    }
    const cred = result.registrationInfo.credential;
    const now = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      await this.db.insert(t.passkeys).values({
        id: cred.id,
        name: input.name.trim().slice(0, 60) || "Passkey",
        publicKey: Buffer.from(cred.publicKey).toString("base64url"),
        counter: cred.counter,
        transports: (cred.transports ?? []) as string[],
        rpId: where.rpId,
        wrappedPrivateKey: input.prf
          ? seal(prfKey(Buffer.from(input.prf, "base64url")), privateKey, "private-key")
          : null,
        createdAt: now,
      });
      await recordAudit(this.db, {
        actor: "you",
        action: `Added a passkey: ${input.name.trim() || "Passkey"}`,
        target: "security",
      });
    });
    return { id: cred.id, unlocksVault: Boolean(input.prf) };
  }

  /** Options for signing in, confirming it is you, or teaching a passkey to unlock the vault. */
  async authenticationOptions(where: RequestOrigin, credentialId?: string) {
    const keys = await this.db.select().from(t.vaultKeys).get();
    if (!keys) throw new ConflictError("Hearth is not set up yet.");
    const options = await generateAuthenticationOptions({
      rpID: where.rpId,
      userVerification: "required",
      allowCredentials: credentialId ? [{ id: credentialId }] : [],
      // The salt travels as base64url text; the browser turns it into bytes for the authenticator.
      extensions: { prf: { eval: { first: keys.prfSalt } } } as never,
    });
    this.remember(options.challenge);
    return options;
  }

  /**
   * Verifies a passkey. Without a session it signs you in; with one it
   * confirms it is you. If the passkey supplies its PRF secret, the vault
   * unlocks too, and a passkey that could not unlock before learns how
   * (only while the vault is already unlocked in this session).
   */
  async withPasskey(
    where: RequestOrigin,
    input: { response: AuthenticationResponseJSON; prf?: string },
    current: Session | null,
    ctx: SignInContext = {},
  ): Promise<{ token?: string; session: string; unlocked: boolean }> {
    const throttle = this.throttleFor(ctx);
    throttle.check();
    const row = await this.db
      .select()
      .from(t.passkeys)
      .where(eq(t.passkeys.id, input.response.id))
      .get();
    if (!row) {
      throttle.fail();
      throw new UnauthorizedError("That passkey is not registered here.");
    }
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: this.consume,
      expectedOrigin: where.origin,
      expectedRPID: row.rpId,
      requireUserVerification: true,
      credential: {
        id: row.id,
        publicKey: Buffer.from(row.publicKey, "base64url"),
        counter: row.counter,
        transports: row.transports as never,
      },
    }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
    if (!result.verified) {
      throttle.fail();
      throw new UnauthorizedError("The passkey could not be verified.");
    }
    throttle.succeed();

    let sessionId = current?.id;
    let token: string | undefined;
    if (!current) {
      token = await this.createSession("passkey", ctx);
      sessionId = sha256(token);
    } else {
      await this.markVerified(current.id);
    }

    let privateKey: Buffer | undefined;
    if (input.prf) {
      const kek = prfKey(Buffer.from(input.prf, "base64url"));
      if (row.wrappedPrivateKey) {
        try {
          privateKey = open(kek, row.wrappedPrivateKey, "private-key");
        } catch {
          privateKey = undefined;
        }
      } else if (current && this.privateKeyFor(current)) {
        privateKey = this.privateKeyFor(current)!;
        await this.db
          .update(t.passkeys)
          .set({ wrappedPrivateKey: seal(kek, privateKey, "private-key") })
          .where(eq(t.passkeys.id, row.id));
      }
    }
    if (privateKey) this.unlock(sessionId!, privateKey);
    await this.db
      .update(t.passkeys)
      .set({
        counter: result.authenticationInfo?.newCounter ?? row.counter,
        lastUsedAt: new Date().toISOString(),
      })
      .where(eq(t.passkeys.id, row.id));
    return { token, session: sessionId!, unlocked: Boolean(privateKey) };
  }

  async renamePasskey(id: string, name: string) {
    const row = await this.db.select().from(t.passkeys).where(eq(t.passkeys.id, id)).get();
    if (!row) throw new NotFoundError("No such passkey.");
    await this.db
      .update(t.passkeys)
      .set({ name: name.trim().slice(0, 60) || row.name })
      .where(eq(t.passkeys.id, id));
  }

  async removePasskey(session: Session, id: string) {
    this.requireRecent(session);
    const row = await this.db.select().from(t.passkeys).where(eq(t.passkeys.id, id)).get();
    if (!row) throw new NotFoundError("No such passkey.");
    await withTransaction(this.handle, async () => {
      await this.db.delete(t.passkeys).where(eq(t.passkeys.id, id));
      await recordAudit(this.db, {
        actor: "you",
        action: `Removed a passkey: ${row.name}`,
        target: "security",
      });
    });
  }
}

function checkPassword(password: string) {
  if (password.length < MIN_PASSWORD) {
    throw new InvalidRequestError(`Use at least ${MIN_PASSWORD} characters for the password.`);
  }
  if (password.length > 200) throw new InvalidRequestError("That password is too long.");
}

/** "Chrome on Android", "Safari on iPhone": enough to recognise a device, from its user agent. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X/.test(ua)
            ? "Mac"
            : /Linux/.test(ua)
              ? "Linux"
              : "an unknown system";
  return `${browser} on ${os}`;
}
