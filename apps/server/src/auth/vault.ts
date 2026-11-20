import { randomUUID } from "node:crypto";
import { DEFAULT_CREDENTIAL_SCOPE } from "@dragon-control/core";
import { asc, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { open, openWith, seal, sealTo } from "./crypto";
import { ForbiddenAuthError, type Auth, type Session } from "./service";

/**
 * Secrets you choose to keep here, encrypted on this machine only.
 *
 * - Automation: usable unattended (by Hearth on an agent's behalf,
 *   later), encrypted with a key the operating system protects.
 * - Protected: encrypted to a key only your password, passkey, or recovery
 *   key can open. Each use needs you.
 *
 * Plain values exist only in memory for the moment they are used or shown,
 * and never appear in the workspace, the audit log, or server logs.
 */

export type SecretKind = (typeof t.vaultSecrets.$inferSelect)["kind"];
export type SecretTier = (typeof t.vaultSecrets.$inferSelect)["tier"];

export interface SecretSummary {
  /** Hearth may sign Ember's Browser in to this credential's app with it (off unless you allow it). */
  browserSignIn: boolean;
  id: string;
  name: string;
  kind: SecretKind;
  tier: SecretTier;
  serviceId?: string;
  category?: string;
  username?: string;
  endpoint?: string;
  notes?: string;
  tags: string[];
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  /** What Hearth may do with it (never skips an approval). */
  scope: "read" | "approved-changes";
  lastOkAt?: string;
  lastFailureAt?: string;
  /** Why the last use failed; never contains the value. */
  lastFailure?: string;
  /** rejected (the credential is wrong) or something else (unreachable, blocked, incompatible, internal). */
  lastFailureKind?: import("@dragon-control/core").CredentialFailureKind;
  source?: string;
}

/** What describes a secret without being it: never encrypted, never the value. */
export interface SecretDetails {
  category?: string | null;
  username?: string | null;
  endpoint?: string | null;
  notes?: string | null;
  tags?: string[];
}

const clean = (v: string | null | undefined, max: number) =>
  v === undefined ? undefined : v === null || !v.trim() ? null : v.trim().slice(0, max);

function details(d: SecretDetails) {
  return {
    ...(d.category !== undefined ? { category: clean(d.category, 60) } : {}),
    ...(d.username !== undefined ? { username: clean(d.username, 200) } : {}),
    ...(d.endpoint !== undefined ? { endpoint: clean(d.endpoint, 300) } : {}),
    ...(d.notes !== undefined ? { notes: clean(d.notes, 2000) } : {}),
    ...(d.tags !== undefined
      ? {
          tags: [...new Set(d.tags.map((x) => x.trim().slice(0, 40)).filter(Boolean))].slice(0, 12),
        }
      : {}),
  };
}

const MAX_VALUE = 8192;
const aad = (id: string, tier: SecretTier) => `secret:${id}:${tier}`;

function summary(row: typeof t.vaultSecrets.$inferSelect): SecretSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    tier: row.tier,
    serviceId: row.serviceId ?? undefined,
    category: row.category ?? undefined,
    username: row.username ?? undefined,
    endpoint: row.endpoint ?? undefined,
    notes: row.notes ?? undefined,
    tags: row.tags ?? [],
    verifiedAt: row.verifiedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
    scope: row.scope,
    browserSignIn: row.browserSignIn,
    lastOkAt: row.lastOkAt ?? undefined,
    lastFailureAt: row.lastFailureAt ?? undefined,
    lastFailure: row.lastFailure ?? undefined,
    lastFailureKind: (row.lastFailureKind as SecretSummary["lastFailureKind"]) ?? undefined,
    source: row.source ?? undefined,
  };
}

export class Vault {
  constructor(
    private readonly handle: DbHandle,
    private readonly auth: Auth,
  ) {}

  private get db() {
    return this.handle.db;
  }

  async exists(id: string): Promise<boolean> {
    return Boolean(
      await this.db.select().from(t.vaultSecrets).where(eq(t.vaultSecrets.id, id)).get(),
    );
  }

  /** Removal on Hearth's side, e.g. when you stop a notification channel. */
  async removeInternal(id: string) {
    await this.db.delete(t.vaultSecrets).where(eq(t.vaultSecrets.id, id));
  }

  async list(): Promise<SecretSummary[]> {
    return (await this.db.select().from(t.vaultSecrets).orderBy(asc(t.vaultSecrets.name))).map(
      summary,
    );
  }

  private async encrypt(id: string, tier: SecretTier, value: string): Promise<string> {
    const plain = Buffer.from(value, "utf8");
    return tier === "automation"
      ? seal(await this.auth.automation(), plain, aad(id, tier))
      : sealTo(await this.auth.publicKey(), plain, aad(id, tier));
  }

  private async row(id: string) {
    const row = await this.db.select().from(t.vaultSecrets).where(eq(t.vaultSecrets.id, id)).get();
    if (!row) throw new NotFoundError("No such secret.");
    return row;
  }

  private decrypt(
    row: typeof t.vaultSecrets.$inferSelect,
    privateKey?: Buffer,
    automation?: Buffer,
  ) {
    try {
      return row.tier === "automation"
        ? open(automation!, row.ciphertext, aad(row.id, row.tier)).toString("utf8")
        : openWith(privateKey!, row.ciphertext, aad(row.id, row.tier)).toString("utf8");
    } catch {
      throw new ConflictError(
        "This secret could not be decrypted. It may have been tampered with.",
      );
    }
  }

  async add(
    input: {
      name: string;
      kind: SecretKind;
      tier: SecretTier;
      serviceId?: string;
      value: string;
      scope?: "read" | "approved-changes";
      /** "you" by default; "dragon-control" when it stores something it generated or imported. */
      actor?: "you" | "dragon-control";
      source?: string;
    } & SecretDetails,
  ): Promise<SecretSummary> {
    const name = input.name.trim();
    if (!name) throw new InvalidRequestError("Give the secret a name.");
    if (!input.value) throw new InvalidRequestError("The secret is empty.");
    if (input.value.length > MAX_VALUE) throw new InvalidRequestError("That secret is too long.");
    const id = randomUUID();
    const now = new Date().toISOString();
    const ciphertext = await this.encrypt(id, input.tier, input.value);
    await withTransaction(this.handle, async () => {
      await this.db.insert(t.vaultSecrets).values({
        id,
        name: name.slice(0, 80),
        kind: input.kind,
        tier: input.tier,
        serviceId: input.serviceId ?? null,
        ...details(input),
        ciphertext,
        // Diagnostics only unless you choose otherwise: changes are always a deliberate grant.
        scope: input.scope ?? DEFAULT_CREDENTIAL_SCOPE,
        source: input.source ?? "you",
        createdAt: now,
        updatedAt: now,
      });
      await recordAudit(this.db, {
        actor: input.actor ?? "you",
        action: `Added "${name.slice(0, 80)}" to the vault`,
        target: `secret:${id}`,
        detail: {
          tier: input.tier,
          ...(input.serviceId ? { service: input.serviceId } : {}),
          ...(input.source && input.source !== "you" ? { source: input.source } : {}),
        },
      });
    });
    return summary(await this.row(id));
  }

  /** Rename, relink, or replace the value. Replacing needs nothing unlocked. */
  async update(
    id: string,
    patch: {
      name?: string;
      serviceId?: string | null;
      value?: string;
      scope?: "read" | "approved-changes";
      browserSignIn?: boolean;
    } & SecretDetails,
  ) {
    const row = await this.row(id);
    if (patch.value !== undefined && (!patch.value || patch.value.length > MAX_VALUE)) {
      throw new InvalidRequestError("The new value must not be empty or too long.");
    }
    const ciphertext =
      patch.value !== undefined ? await this.encrypt(id, row.tier, patch.value) : undefined;
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.vaultSecrets)
        .set({
          ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 80) } : {}),
          ...(patch.serviceId !== undefined ? { serviceId: patch.serviceId } : {}),
          ...details(patch),
          ...(patch.scope ? { scope: patch.scope } : {}),
          ...(patch.browserSignIn !== undefined ? { browserSignIn: patch.browserSignIn } : {}),
          // A new value has no track record yet.
          ...(ciphertext
            ? {
                ciphertext,
                verifiedAt: null,
                lastOkAt: null,
                lastFailureAt: null,
                lastFailure: null,
                lastFailureKind: null,
              }
            : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(t.vaultSecrets.id, id));
      await recordAudit(this.db, {
        actor: "you",
        action: ciphertext
          ? `Replaced the value of "${row.name}"`
          : patch.browserSignIn !== undefined
            ? `${patch.browserSignIn ? "Allowed" : "Stopped"} Ember's Browser signing in with "${row.name}"`
            : `Edited "${row.name}"`,
        target: `secret:${id}`,
        ...(patch.scope && patch.scope !== row.scope ? { detail: { scope: patch.scope } } : {}),
      });
    });
  }

  /** You confirmed it still works (or an integration just used it successfully). */
  async markVerified(id: string, by: "you" | "dragon-control" = "you") {
    const row = await this.row(id);
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.vaultSecrets)
        .set({ verifiedAt: new Date().toISOString() })
        .where(eq(t.vaultSecrets.id, id));
      if (by === "you") {
        await recordAudit(this.db, {
          actor: "you",
          action: `Confirmed "${row.name}" still works`,
          target: `secret:${id}`,
        });
      }
    });
  }

  async remove(session: Session, id: string) {
    this.auth.requireRecent(session);
    const row = await this.row(id);
    await withTransaction(this.handle, async () => {
      await this.db.delete(t.vaultSecrets).where(eq(t.vaultSecrets.id, id));
      await recordAudit(this.db, {
        actor: "you",
        action: `Removed "${row.name}" from the vault`,
        target: `secret:${id}`,
      });
    });
  }

  /** Shows you a value. Automation secrets need a recent check; protected ones need the vault unlocked. */
  async reveal(session: Session, id: string): Promise<string> {
    const row = await this.row(id);
    let value: string;
    if (row.tier === "automation") {
      this.auth.requireRecent(session);
      value = this.decrypt(row, undefined, await this.auth.automation());
    } else {
      const key = this.auth.privateKeyFor(session);
      if (!key) throw new ForbiddenAuthError("Unlock the vault to see protected secrets.");
      value = this.decrypt(row, key);
    }
    await recordAudit(this.db, {
      actor: "you",
      action: `Viewed "${row.name}"`,
      target: `secret:${id}`,
    });
    return value;
  }

  /**
   * Hearth using a secret for a task (an agent's request, an
   * integration check). Automation secrets work unattended; protected ones
   * only through a session you have unlocked. Every use is recorded.
   */
  async use(
    id: string,
    purpose: string,
    opts: {
      actor: "dragon-control" | "agent";
      unlockedSession?: Session;
      /** false: the caller keeps its own record of each use (e.g. the notification log). */
      audit?: boolean;
    },
  ): Promise<string> {
    const row = await this.row(id);
    let value: string;
    if (row.tier === "automation") {
      value = this.decrypt(row, undefined, await this.auth.automation());
    } else {
      const key = opts.unlockedSession && this.auth.privateKeyFor(opts.unlockedSession);
      if (!key)
        throw new ForbiddenAuthError(`"${row.name}" is protected and needs you to unlock it.`);
      value = this.decrypt(row, key);
    }
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.vaultSecrets)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(t.vaultSecrets.id, id));
      if (opts.audit === false) return;
      await recordAudit(this.db, {
        actor: opts.actor,
        action: `Used "${row.name}"`,
        target: `secret:${id}`,
        detail: { purpose },
      });
    });
    return value;
  }
}
