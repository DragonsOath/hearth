import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  DEFAULT_CREDENTIAL_SCOPE,
  APP_INTEGRATIONS,
  type CredentialFailureKind,
  type CredentialNeed,
  type CredentialScope,
  type CredentialStatus,
} from "@dragon-control/core";
import type { Vault } from "../auth/vault";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import { NotFoundError } from "../store/errors";
import { appOf } from "../apps/service";

/**
 * The credential broker: the only way Hearth turns a stored
 * credential into a usable value. Callers ask for an authorized use ("read
 * Prowlarr's health", "change an indexer in an approved plan"); the broker
 * picks the service's credential, checks what it may be used for, checks the
 * request goes to that service's own address, hands the value to the caller's
 * function for that one request, and records whether it worked.
 *
 * The value never leaves the backend: it is not returned to the AI, put in
 * tool results, progress, conversations, audit entries, or errors (any error
 * text is scrubbed of it). There is no "give me the secret" path and no
 * general authenticated request path for the AI.
 */

type SecretRow = typeof t.vaultSecrets.$inferSelect;
type ServiceRow = typeof t.services.$inferSelect;

export class CredentialError extends Error {
  constructor(
    message: string,
    /** missing, protected, scope, destination: why it could not be used. */
    readonly reason: "missing" | "protected" | "scope" | "destination",
  ) {
    super(message);
  }
}

/** What a service needs, if Hearth knows how to use one there. Reusable: from the app catalogue. */
export function needOf(service: Pick<ServiceRow, "image" | "name">): CredentialNeed | undefined {
  const app = appOf(service);
  if (!app) return undefined;
  const def = APP_INTEGRATIONS[app];
  if (def.credential === "none") return undefined;
  return {
    kind: def.credential,
    label: def.keyLabel ?? (def.credential === "login" ? "Web UI login" : "API key"),
    where: def.where,
    ...(def.keyPage ? { keyPage: def.keyPage } : {}),
    ...(def.tokenToo ? { tokenToo: true } : {}),
  };
}

/** Whether a saved credential is the kind a service needs (a login first, where it takes one). */
export function fitsNeed(
  need: Pick<CredentialNeed, "kind" | "tokenToo"> | undefined,
  s: Pick<SecretRow, "kind" | "username">,
): boolean {
  if (!need) return true;
  const login = (s.kind === "login" || s.kind === "password") && Boolean(s.username);
  const key = s.kind === "api-key" || s.kind === "token";
  return need.kind === "login" ? login || (Boolean(need.tokenToo) && key) : key;
}

/** Removes a value (and its URL-encoded form) from text before it is stored or shown. */
export function scrub(text: string, ...values: (string | undefined)[]): string {
  let out = text;
  for (const v of values) {
    if (!v || v.length < 4) continue;
    out = out.split(v).join("[hidden]").split(encodeURIComponent(v)).join("[hidden]");
  }
  return out;
}

const origin = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * Where a credential may be sent: the service's own address, or the address recorded on the
 * credential. The one exception: a Plex server's token to plex.tv, when asked for by name.
 */
export function mayGoTo(
  service: { name: string; image?: string | null; localUrl?: string | null },
  endpoint: string | null | undefined,
  destination: string,
  account?: "plex.tv",
): boolean {
  const what = `${service.image ?? ""} ${service.name}`;
  const plexAccount =
    account === "plex.tv" &&
    /plex/i.test(what) &&
    !/tautulli|seerr|ombi|kometa|meta-manager|wizarr|trakt/i.test(what);
  const allowed = [service.localUrl, endpoint, plexAccount ? "https://plex.tv" : undefined]
    .filter(Boolean)
    .map((u) => origin(u!));
  const to = origin(destination);
  return Boolean(to) && allowed.includes(to!);
}

export class CredentialBroker {
  constructor(
    private readonly handle: DbHandle,
    private readonly vault: Vault,
  ) {}

  private async service(serviceId: string): Promise<ServiceRow> {
    const s = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.id, serviceId))
      .get();
    if (!s) throw new NotFoundError("No such service.");
    return s;
  }

  /** The credential linked to a service that fits what it needs, automation tier first. */
  private async pick(
    service: ServiceRow,
    login = false,
  ): Promise<{ row?: SecretRow; all: SecretRow[] }> {
    const need: Pick<CredentialNeed, "kind" | "tokenToo"> | undefined = login
      ? { kind: "login" }
      : needOf(service);
    const all = (
      await this.handle.db
        .select()
        .from(t.vaultSecrets)
        .where(eq(t.vaultSecrets.serviceId, service.id))
    ).filter((s) => fitsNeed(need, s));
    // A login before a token, where a service takes both (a token there is read only).
    const auto = all.filter((s) => s.tier === "automation");
    return { row: auto.find((s) => Boolean(s.username)) ?? auto[0], all };
  }

  /**
   * Uses the service's credential for one request. `destination` must be the
   * service's own address (or the address recorded on the credential):
   * a credential is never sent anywhere else. `access: "change"` needs the
   * credential's scope to allow approved changes; the approval itself is
   * checked by the caller (the job engine), never implied by the credential.
   */
  async use<T>(
    input: {
      serviceId: string;
      purpose: string;
      access: "read" | "change";
      destination: string;
      /**
       * Who asked, when it was not Hearth's own background read:
       * the use is then audited (service, purpose, outcome; never the value).
       */
      onBehalfOf?: "agent" | "you";
      /**
       * The one exception to "only its own address": a Plex server's own token may also go to
       * plex.tv, the account it came from, to read who the server is shared with (the owner's
       * OK, 2026-11-02). Only for a Plex server, and only when asked for by name.
       */
      account?: "plex.tv";
      /**
       * The service's web login rather than the key it normally uses: an app whose API key cannot
       * reach some of its own pages (Wizarr's settings and invite steps sit behind its admin
       * sign-in). Only a login with a username is picked.
       */
      login?: true;
    },
    fn: (credential: { value: string; username?: string }) => Promise<T>,
  ): Promise<T> {
    const service = await this.service(input.serviceId);
    const { row, all } = await this.pick(service, Boolean(input.login));
    if (!row) {
      if (input.login && !all.length)
        throw new CredentialError(
          `Secure Vault has no admin sign-in for ${service.name} yet (its API key cannot open these pages). Add it from ${service.name}'s panel.`,
          "missing",
        );
      throw new CredentialError(
        all.length
          ? `${service.name}'s credential is protected (it needs you to unlock it each time), so Hearth cannot use it on its own. Make it an automation credential in the Secure Vault.`
          : `${service.name} has no credential in the Secure Vault yet. Add it from ${service.name}'s workspace or the Secure Vault.`,
        all.length ? "protected" : "missing",
      );
    }
    if (input.access === "change" && row.scope !== "approved-changes") {
      throw new CredentialError(
        `${service.name}'s credential is limited to diagnostics. To let approved plans change ${service.name}, allow approved changes on it in the Secure Vault.`,
        "scope",
      );
    }
    if (!mayGoTo(service, row.endpoint, input.destination, input.account)) {
      throw new CredentialError(
        `Refused: ${service.name}'s credential is only ever sent to ${service.name}'s own address.`,
        "destination",
      );
    }

    const value = await this.vault.use(row.id, input.purpose, {
      actor: "dragon-control",
      audit: false,
    });
    const at = new Date().toISOString();
    try {
      const result = await fn({ value, ...(row.username ? { username: row.username } : {}) });
      // A live dashboard uses the credential every few seconds: record "last worked" at most once a minute.
      if (!row.lastOkAt || Date.parse(at) - Date.parse(row.lastOkAt) > 60_000) {
        await this.handle.db
          .update(t.vaultSecrets)
          .set({ lastOkAt: at, verifiedAt: at })
          .where(eq(t.vaultSecrets.id, row.id));
      }
      if (input.onBehalfOf) await this.auditUse(input, service.name, row.id, "worked");
      return result;
    } catch (error) {
      const message = scrub(
        error instanceof Error ? error.message : String(error),
        value,
        row.username ?? undefined,
      );
      const kind = (error as { kind?: unknown } | null)?.kind;
      await this.handle.db
        .update(t.vaultSecrets)
        .set({
          lastFailureAt: at,
          lastFailure: message.slice(0, 300),
          lastFailureKind: typeof kind === "string" ? kind : "internal",
        })
        .where(eq(t.vaultSecrets.id, row.id));
      if (input.onBehalfOf) await this.auditUse(input, service.name, row.id, "failed", message);
      // Same error type (callers tell a refused key from an unreachable app), value scrubbed.
      // Some errors (a fetch timeout's DOMException) have a read-only message: those are
      // replaced by a plain error of the same name instead.
      if (error instanceof Error && Object.getOwnPropertyDescriptor(error, "message")?.writable) {
        error.message = message;
        if (error.stack) error.stack = scrub(error.stack, value, row.username ?? undefined);
        throw error;
      }
      if (error instanceof Error) {
        throw Object.assign(new Error(message), { name: error.name });
      }
      // The original thrown value is not attached: it could contain the credential.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    }
  }

  private async auditUse(
    input: { purpose: string; access: "read" | "change"; onBehalfOf?: "agent" | "you" },
    serviceName: string,
    secretId: string,
    outcome: "worked" | "failed",
    message?: string,
  ) {
    const who = input.onBehalfOf === "agent" ? "Ember" : "You";
    await recordAudit(this.handle.db, {
      actor: input.onBehalfOf ?? "dragon-control",
      action: `${who} used ${serviceName}'s Secure Vault credential to ${input.purpose} (${input.access === "read" ? "read only" : "approved change"}): ${outcome}`,
      target: `secret:${secretId}`,
      detail: {
        purpose: input.purpose,
        access: input.access,
        outcome,
        ...(message ? { why: message.slice(0, 200) } : {}),
      },
    });
  }

  /**
   * Signs Ember's Browser in to a service (checklist 45.14): the service's web login, only when
   * the owner switched "Sign in Ember's Browser" on for it, only to the service's own address,
   * handed to Hearth's sign-in for that one request. The value never leaves the backend; what
   * comes back is the app's session, for the browser.
   */
  async browserSignIn<T>(
    serviceId: string,
    destination: string,
    fn: (login: { username: string; password: string }) => Promise<T>,
  ): Promise<T> {
    const service = await this.service(serviceId);
    const rows = await this.handle.db
      .select()
      .from(t.vaultSecrets)
      .where(eq(t.vaultSecrets.serviceId, service.id));
    const logins = rows.filter(
      (r) => (r.kind === "login" || r.kind === "password") && Boolean(r.username),
    );
    const row = logins.find((r) => r.browserSignIn && r.tier === "automation");
    if (!row)
      throw new CredentialError(
        logins.length
          ? `${service.name}'s web login is in Secure Vault, but "Sign in Ember's Browser" is off for it (or it needs unlocking each time). Switch it on in Secure Vault, then Ember's browser opens ${service.name} signed in.`
          : `Secure Vault has no web login for ${service.name} (its API key cannot sign in to its web page). Add ${service.name}'s web login in Secure Vault with "Sign in Ember's Browser" on.`,
        "missing",
      );
    if (!mayGoTo(service, row.endpoint, destination))
      throw new CredentialError(
        `Refused: ${service.name}'s login is only ever sent to ${service.name}'s own address.`,
        "destination",
      );
    const value = await this.vault.use(row.id, "sign Ember's Browser in", {
      actor: "dragon-control",
      audit: false,
    });
    try {
      const result = await fn({ username: row.username!, password: value });
      const at = new Date().toISOString();
      await this.handle.db
        .update(t.vaultSecrets)
        .set({ lastOkAt: at, verifiedAt: at })
        .where(eq(t.vaultSecrets.id, row.id));
      await recordAudit(this.handle.db, {
        actor: "agent",
        action: `Ember's browser signed in to ${service.name} (Secure Vault; only the session reached the browser)`,
        target: `secret:${row.id}`,
        detail: { serviceId: service.id },
      });
      return result;
    } catch (error) {
      const message = scrub(
        error instanceof Error ? error.message : String(error),
        value,
        row.username ?? undefined,
      );
      await this.handle.db
        .update(t.vaultSecrets)
        .set({
          lastFailureAt: new Date().toISOString(),
          lastFailure: message.slice(0, 300),
          lastFailureKind: "rejected",
        })
        .where(eq(t.vaultSecrets.id, row.id));
      throw new CredentialError(message, "missing");
    }
  }

  private secretCache = new Map<string, { at: number; values: string[] }>();

  /**
   * The service's own secret values, only so the browser can hide them in what Ember reads.
   * Never returned to a route, a tool or the AI; kept for a minute at a time.
   */
  async secretValues(serviceId: string): Promise<string[]> {
    const hit = this.secretCache.get(serviceId);
    if (hit && Date.now() - hit.at < 60_000) return hit.values;
    const rows = (
      await this.handle.db
        .select()
        .from(t.vaultSecrets)
        .where(eq(t.vaultSecrets.serviceId, serviceId))
    ).filter((r) => r.tier === "automation");
    const values: string[] = [];
    for (const r of rows)
      values.push(
        await this.vault.use(r.id, "hide it in what Ember's browser reads", {
          actor: "dragon-control",
          audit: false,
        }),
      );
    this.secretCache.set(serviceId, { at: Date.now(), values });
    return values;
  }

  /** Whether an approved change could use the credential (to refuse a plan early, with the reason). */
  async canChange(serviceId: string): Promise<string | undefined> {
    const service = await this.service(serviceId);
    const { row, all } = await this.pick(service);
    if (!row) {
      return all.length
        ? `${service.name}'s credential is protected; make it an automation credential in the Secure Vault.`
        : `Add ${service.name}'s ${needOf(service)?.label ?? "credential"} to the Secure Vault first (${needOf(service)?.where ?? "from the app's settings"}).`;
    }
    if (row.scope !== "approved-changes") {
      return `${service.name}'s credential is limited to diagnostics; allow approved changes on it in the Secure Vault.`;
    }
    return undefined;
  }

  /**
   * Stores a credential Hearth produced in an authorized workflow (an
   * app it set up, a key it created through an app's API): linked to the
   * service, automation tier, audited without the value, never shown.
   */
  async storeGenerated(input: {
    serviceId: string;
    kind: "api-key" | "login" | "token" | "password";
    value: string;
    username?: string;
    workflow: string;
    scope?: CredentialScope;
  }): Promise<{ id: string }> {
    const service = await this.service(input.serviceId);
    const { id } = await this.vault.add({
      name: `${service.name} ${input.kind === "login" ? "login" : input.kind === "token" ? "token" : "API key"}`,
      kind: input.kind,
      tier: "automation",
      serviceId: service.id,
      value: input.value,
      ...(input.username ? { username: input.username } : {}),
      scope: input.scope ?? DEFAULT_CREDENTIAL_SCOPE,
      actor: "dragon-control",
      source: `generated: ${input.workflow}`,
    });
    await recordAudit(this.handle.db, {
      actor: "dragon-control",
      action: `Stored a credential it generated for ${service.name}`,
      target: `secret:${id}`,
      detail: { workflow: input.workflow, service: service.id },
    });
    return { id };
  }

  /** Whether Hearth holds a usable credential for a service (never its value). */
  async has(serviceId: string): Promise<boolean> {
    return Boolean((await this.pick(await this.service(serviceId))).row);
  }

  /** Per service: what it needs and the state of its credential. Never values. */
  async status(
    importSources?: (s: ServiceRow) => Promise<{ id: string; description: string }[]>,
  ): Promise<CredentialStatus[]> {
    const services = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.lifecycle, "active"));
    const out: CredentialStatus[] = [];
    for (const s of services) {
      const need = needOf(s);
      if (!need) continue;
      const { row, all } = await this.pick(s);
      const shown = row ?? all[0];
      const state: CredentialStatus["state"] = !shown
        ? "missing"
        : !row
          ? "protected"
          : row.lastFailureAt && (!row.lastOkAt || row.lastFailureAt >= row.lastOkAt)
            ? "failing"
            : row.lastOkAt
              ? "working"
              : "unused";
      out.push({
        serviceId: s.id,
        serviceName: s.name,
        need,
        state,
        ...(shown
          ? {
              secret: {
                id: shown.id,
                name: shown.name,
                scope: shown.scope,
                ...(shown.source ? { source: shown.source } : {}),
                ...(shown.lastUsedAt ? { lastUsedAt: shown.lastUsedAt } : {}),
                ...(shown.lastOkAt ? { lastOkAt: shown.lastOkAt } : {}),
                ...(shown.lastFailureAt ? { lastFailureAt: shown.lastFailureAt } : {}),
                ...(shown.lastFailure ? { lastFailure: shown.lastFailure } : {}),
                ...(shown.lastFailureKind
                  ? { lastFailureKind: shown.lastFailureKind as CredentialFailureKind }
                  : {}),
              },
            }
          : {}),
        importSources:
          !shown && importSources && !s.checkTarget?.startsWith("demo:")
            ? await importSources(s)
            : [],
      });
    }
    return out.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
  }
}

export const newId = () => randomUUID();
