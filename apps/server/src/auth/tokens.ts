import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { recordAudit } from "../store/audit";
import { InvalidRequestError, NotFoundError } from "../store/errors";
import { randomToken, sha256 } from "./crypto";
import { KEY_SCOPES, type KeyScope, type KeySummary } from "@dragon-control/core";

export { KEY_SCOPES };

/**
 * Access keys let other software use Hearth without a browser
 * session: Home Assistant, scripts, and (as short-lived keys) AI agent
 * sessions. A key can only reach the routes its scopes name; everything
 * else (settings, security, the vault, keys themselves) needs you, signed in.
 */

export type Scope = KeyScope | "agent";

/** Which routes each scope opens, as Fastify route patterns. Anything not listed is closed to keys. */
export const ROUTE_SCOPES: Record<string, Scope> = {
  "GET /api/workspace": "read",
  "GET /api/status": "read",
  "GET /api/agent/conversations/:id": "converse",
  "POST /api/agent/conversations": "converse",
  "POST /api/incidents/:id/decision": "approve",
  "GET /api/jobs": "read",
  "GET /api/projects": "read",
  "GET /api/services/:id/runtime": "read",
  "GET /api/projects/:id": "read",
  "GET /api/jobs/:id": "read",
  "POST /api/jobs/:id/decision": "approve",
  "POST /api/monitor/run": "act",
  "POST /api/actions": "act",
  // The homelab companion (Claude Code on your machines): read and add to the memory, never delete.
  "GET /api/companion/briefing": "memory",
  "GET /api/memory/search": "memory",
  "GET /api/memory/entries": "memory",
  "GET /api/memory/entries/:id": "memory",
  "POST /api/memory/entries": "memory",
  "PATCH /api/memory/entries/:id": "memory",
  "GET /api/memory/projects": "memory",
  "POST /api/memory/projects": "memory",
  "GET /api/memory/transcripts": "memory",
  "POST /api/memory/transcripts": "memory",
  "GET /api/memory/transcripts/:id": "memory",
  "POST /api/memory/transcripts/:id/messages": "memory",
  "POST /api/memory/transcripts/:id/end": "memory",
  // Importers may propose; only you accept or reject.
  "POST /api/memory/imports": "memory",
  // Scripts running long work on your machines: start tracking it and report progress, nothing else.
  "POST /api/work": "work",
  "POST /api/work/:id": "work",
  "GET /api/work": "read",
  "POST /api/mcp": "agent",
  "GET /api/mcp": "agent",
  "DELETE /api/mcp": "agent",
};

export interface KeyPrincipal {
  id: string;
  name: string;
  kind: "key" | "agent";
  scopes: Scope[];
}

const AGENT_KEY_MINUTES = 20;

export class AccessKeys {
  constructor(private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  async list(): Promise<KeySummary[]> {
    const rows = await this.db
      .select()
      .from(t.apiTokens)
      .where(and(eq(t.apiTokens.kind, "key"), isNull(t.apiTokens.revokedAt)));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes as KeyScope[],
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? undefined,
    }));
  }

  /** Creates a key; the returned secret is shown once and never stored. */
  async create(name: string, scopes: KeyScope[]): Promise<{ key: string; summary: KeySummary }> {
    const clean = [...new Set(scopes)].filter((s) => KEY_SCOPES.includes(s));
    if (!clean.length) throw new InvalidRequestError("Choose at least one permission.");
    const key = `dc_${randomToken(24)}`;
    const id = randomUUID();
    const now = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      await this.db.insert(t.apiTokens).values({
        id,
        name: name.trim().slice(0, 60) || "Access key",
        prefix: key.slice(0, 7),
        tokenHash: sha256(key),
        scopes: clean,
        kind: "key",
        createdAt: now,
      });
      await recordAudit(this.db, {
        actor: "you",
        action: `Created an access key: ${name.trim() || "Access key"}`,
        target: "security",
        detail: { scopes: clean },
      });
    });
    return { key, summary: (await this.list()).find((k) => k.id === id)! };
  }

  async revoke(id: string) {
    const row = await this.db.select().from(t.apiTokens).where(eq(t.apiTokens.id, id)).get();
    if (!row || row.kind !== "key" || row.revokedAt) throw new NotFoundError("No such key.");
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.apiTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(t.apiTokens.id, id));
      await recordAudit(this.db, {
        actor: "you",
        action: `Revoked the access key: ${row.name}`,
        target: "security",
      });
    });
  }

  /** A short-lived key for one agent session, usable only on the MCP endpoint. */
  async issueAgentKey(label: string): Promise<{ key: string; id: string }> {
    const key = `dca_${randomToken(24)}`;
    const id = randomUUID();
    const now = Date.now();
    await this.db.insert(t.apiTokens).values({
      id,
      name: label.slice(0, 80),
      prefix: key.slice(0, 8),
      tokenHash: sha256(key),
      scopes: ["agent"],
      kind: "agent",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + AGENT_KEY_MINUTES * 60_000).toISOString(),
    });
    return { key, id };
  }

  /** Keeps an agent key alive another 20 minutes (a Remote Control session, while it runs). */
  async renew(id: string) {
    await this.db
      .update(t.apiTokens)
      .set({ expiresAt: new Date(Date.now() + AGENT_KEY_MINUTES * 60_000).toISOString() })
      .where(and(eq(t.apiTokens.id, id), isNull(t.apiTokens.revokedAt)));
  }

  async expire(id: string) {
    await this.db
      .update(t.apiTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(t.apiTokens.id, id));
  }

  /** The key behind a bearer token, or null if unknown, revoked, or expired. */
  async verify(token: string): Promise<KeyPrincipal | null> {
    if (!/^dca?_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
    const row = await this.db
      .select()
      .from(t.apiTokens)
      .where(eq(t.apiTokens.tokenHash, sha256(token)))
      .get();
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return null;
    const now = new Date();
    if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > 60_000) {
      await this.db
        .update(t.apiTokens)
        .set({ lastUsedAt: now.toISOString() })
        .where(eq(t.apiTokens.id, row.id));
    }
    return { id: row.id, name: row.name, kind: row.kind, scopes: row.scopes as Scope[] };
  }
}
