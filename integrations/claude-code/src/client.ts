import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type {
  CompanionBriefing,
  MemoryEntry,
  MemoryProject,
  MemorySearchHit,
  Transcript,
} from "./types";

/**
 * The companion's connection to Hearth, and what keeps it useful
 * when Hearth cannot be reached:
 *
 * - a cache of the last briefing and memories, always labelled with how
 *   old it is, never passed off as current;
 * - a queue of saves made while offline, each with its own id, sent in
 *   order once Hearth answers again (resending never duplicates).
 *
 * Everything lives in ~/.dragon-control (or DC_COMPANION_HOME).
 */

export interface CompanionConfig {
  url: string;
  key: string;
  name?: string;
}

export interface Live<T> {
  live: true;
  data: T;
  at: string;
}
export interface Cached<T> {
  live: false;
  data: T | undefined;
  /** When the cached copy was fetched. */
  at?: string;
  reason: string;
}
export type Result<T> = Live<T> | Cached<T>;

export type PendingOp =
  | { id: string; op: "create"; at: string; body: Record<string, unknown> }
  | { id: string; op: "update"; at: string; entryId: string; body: Record<string, unknown> }
  | { id: string; op: "project"; at: string; body: { name: string; summary?: string } }
  | { id: string; op: "transcript"; at: string; sessionId: string };

export class OfflineError extends Error {}
export class RejectedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const home = () => process.env.DC_COMPANION_HOME || path.join(homedir(), ".dragon-control");

/** "Claude Code on DESKTOP-PC" */
export const machineName = () => hostname();

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8").trimStart()) as T;
  } catch {
    return undefined;
  }
}

export function loadConfig(): CompanionConfig | undefined {
  if (process.env.DRAGON_CONTROL_URL && process.env.DRAGON_CONTROL_KEY) {
    return { url: process.env.DRAGON_CONTROL_URL, key: process.env.DRAGON_CONTROL_KEY };
  }
  const config = readJson<CompanionConfig>(path.join(home(), "companion.json"));
  return config?.url && config.key ? config : undefined;
}

export class Companion {
  readonly dir = home();
  constructor(
    private readonly config: CompanionConfig | undefined = loadConfig(),
    private readonly timeoutMs = Number(process.env.DC_COMPANION_TIMEOUT_MS) || 6000,
  ) {}

  get configured() {
    return Boolean(this.config);
  }

  get url() {
    return this.config?.url;
  }

  /* ---------- HTTP ---------- */

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    if (!this.config) {
      throw new OfflineError(
        "the companion is not set up on this machine (no ~/.dragon-control/companion.json)",
      );
    }
    let res: Response;
    try {
      res = await fetch(new URL(route, this.config.url), {
        method,
        headers: {
          authorization: `Bearer ${this.config.key}`,
          "x-dc-client": `Claude Code on ${machineName()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      throw new OfflineError(
        `${this.config.url} did not answer (${cause ?? (error as Error).name ?? "network error"})`,
      );
    }
    if (res.status >= 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      throw new OfflineError(`${this.config.url} answered ${res.status}`);
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new RejectedError(payload?.message ?? `Hearth answered ${res.status}`, res.status);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /* ---------- Cache ---------- */

  private cacheFile(name: string) {
    return path.join(this.dir, "cache", `${name}.json`);
  }

  private saveCache(name: string, data: unknown, at: string) {
    writeJson(this.cacheFile(name), { at, data });
  }

  readCache<T>(name: string): { at: string; data: T } | undefined {
    return readJson<{ at: string; data: T }>(this.cacheFile(name));
  }

  /** Live from Hearth, refreshing the cache; or the cached copy, clearly marked. */
  private async liveOrCached<T>(name: string, fetcher: () => Promise<T>): Promise<Result<T>> {
    try {
      await this.flush();
      const data = await fetcher();
      const at = new Date().toISOString();
      this.saveCache(name, data, at);
      return { live: true, data, at };
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
      const cached = this.readCache<T>(name);
      return { live: false, data: cached?.data, at: cached?.at, reason: error.message };
    }
  }

  async briefing(): Promise<Result<CompanionBriefing>> {
    const last = this.readCache<CompanionBriefing>("briefing");
    const since = last?.data.asOf;
    const result = await this.liveOrCached("briefing", () =>
      this.request<CompanionBriefing>(
        "GET",
        `/api/companion/briefing${since ? `?since=${encodeURIComponent(since)}` : ""}`,
      ),
    );
    if (result.live) {
      // Names worth recognising in later prompts: projects, services, machines.
      const names = [
        ...(result.data.vocabulary ?? []),
        ...result.data.projects.map((p) => p.name),
        ...result.data.system.hosts.map((h) => h.name),
      ];
      writeJson(path.join(this.dir, "cache", "names.json"), names);
      // A full copy of the memories, so recall still works offline.
      void this.liveOrCached("entries", () =>
        this.request<MemoryEntry[]>("GET", "/api/memory/entries"),
      ).catch(() => undefined);
    }
    return result;
  }

  async search(
    query: string,
  ): Promise<Result<{ hits: MemorySearchHit[]; entries: MemoryEntry[] }>> {
    try {
      await this.flush();
      const hits = await this.request<MemorySearchHit[]>(
        "GET",
        `/api/memory/search?q=${encodeURIComponent(query)}`,
      );
      const entries = await Promise.all(
        hits
          .filter((h) => h.type === "entry")
          .slice(0, 8)
          .map((h) =>
            this.request<{ entry: MemoryEntry }>("GET", `/api/memory/entries/${h.id}`).then(
              (r) => r.entry,
            ),
          ),
      );
      return { live: true, data: { hits, entries }, at: new Date().toISOString() };
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
      // Offline: plain word matching over the cached memories and unsent saves.
      const cached = this.readCache<MemoryEntry[]>("entries");
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const pool = [...(cached?.data ?? []), ...this.pendingEntries()];
      const entries = pool.filter((e) => {
        const text = `${e.title} ${e.body}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
      return { live: false, data: { hits: [], entries }, at: cached?.at, reason: error.message };
    }
  }

  async transcript(id: string, around?: number) {
    const t = await this.request<{
      transcript: Transcript;
      messages: { seq: number; role: string; text: string; at: string }[];
    }>("GET", `/api/memory/transcripts/${id}`);
    if (around === undefined) return t;
    return { ...t, messages: t.messages.filter((m) => Math.abs(m.seq - around) <= 3) };
  }

  async list(filter: {
    kind?: string;
    projectId?: string;
    status?: string;
  }): Promise<Result<MemoryEntry[]>> {
    const params = new URLSearchParams(
      Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])),
    );
    const key = `list-${params.toString() || "all"}`;
    const result = await this.liveOrCached(key, () =>
      this.request<MemoryEntry[]>("GET", `/api/memory/entries?${params}`),
    );
    if (!result.live && !result.data) {
      // Fall back to filtering the full cached copy.
      const all = this.readCache<MemoryEntry[]>("entries");
      if (all) {
        return {
          ...result,
          at: all.at,
          data: all.data.filter(
            (e) =>
              (!filter.kind || e.kind === filter.kind) &&
              (!filter.projectId || e.projectId === filter.projectId) &&
              (!filter.status || e.status === filter.status),
          ),
        };
      }
    }
    return result;
  }

  async projects(): Promise<Result<MemoryProject[]>> {
    return this.liveOrCached("projects", () =>
      this.request<MemoryProject[]>("GET", "/api/memory/projects"),
    );
  }

  /* ---------- Writes: sent now, or queued and sent later ---------- */

  private pendingDir() {
    return path.join(this.dir, "pending");
  }

  pending(): PendingOp[] {
    const dir = this.pendingDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => readJson<PendingOp>(path.join(dir, f)))
      .filter((op): op is PendingOp => Boolean(op));
  }

  /** Saves not yet sent, shaped like memories so offline recall can include them. */
  private pendingEntries(): MemoryEntry[] {
    return this.pending()
      .filter((op): op is Extract<PendingOp, { op: "create" }> => op.op === "create")
      .map((op) => ({
        id: `pending-${op.id}`,
        kind: op.body.kind as MemoryEntry["kind"],
        title: String(op.body.title),
        body: String(op.body.body ?? ""),
        happenedAt: String(op.body.happenedAt ?? op.at),
        basis: (op.body.basis as MemoryEntry["basis"]) ?? "unknown",
        source: "ai",
        links: [],
        createdAt: op.at,
        updatedAt: op.at,
      }));
  }

  private queue(op: PendingOp) {
    // Sorted by time then id, so they are sent in the order they were made.
    writeJson(path.join(this.pendingDir(), `${op.at.replace(/[:.]/g, "-")}-${op.id}.json`), op);
  }

  private dequeue(op: PendingOp) {
    const dir = this.pendingDir();
    for (const f of readdirSync(dir))
      if (f.endsWith(`-${op.id}.json`)) rmSync(path.join(dir, f), { force: true });
  }

  /** A save that Hearth refused (not an outage) is kept aside, not retried forever. */
  private reject(op: PendingOp, error: RejectedError) {
    this.dequeue(op);
    writeJson(path.join(this.dir, "rejected", `${op.id}.json`), {
      ...op,
      error: error.message,
      status: error.status,
    });
  }

  async remember(
    body: Record<string, unknown>,
  ): Promise<{ sent: true; entry: MemoryEntry } | { sent: false; queued: number; reason: string }> {
    const op: PendingOp = { id: randomUUID(), op: "create", at: new Date().toISOString(), body };
    try {
      await this.flush();
      const entry = await this.request<MemoryEntry>("POST", "/api/memory/entries", {
        ...body,
        clientRef: op.id,
      });
      return { sent: true, entry };
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
      this.queue(op);
      return { sent: false, queued: this.pending().length, reason: error.message };
    }
  }

  async update(entryId: string, body: Record<string, unknown>) {
    const op: PendingOp = {
      id: randomUUID(),
      op: "update",
      at: new Date().toISOString(),
      entryId,
      body,
    };
    try {
      await this.flush();
      return {
        sent: true as const,
        entry: await this.request<MemoryEntry>("PATCH", `/api/memory/entries/${entryId}`, body),
      };
    } catch (error) {
      if (!(error instanceof OfflineError)) throw error;
      this.queue(op);
      return { sent: false as const, queued: this.pending().length, reason: error.message };
    }
  }

  async ensureProject(name: string): Promise<string | undefined> {
    const projects = await this.projects();
    const match = projects.data?.find(
      (p) => p.name.toLowerCase() === name.toLowerCase() || p.id === name.toLowerCase(),
    );
    if (match) return match.id;
    if (!projects.live) return undefined;
    const created = await this.request<MemoryProject>("POST", "/api/memory/projects", { name });
    return created.id;
  }

  queueTranscript(sessionId: string) {
    if (this.pending().some((op) => op.op === "transcript" && op.sessionId === sessionId)) return;
    this.queue({ id: randomUUID(), op: "transcript", at: new Date().toISOString(), sessionId });
  }

  /**
   * Sends queued saves in order. Stops at the first sign of an outage (the
   * rest wait for next time); a save Hearth refuses is set aside.
   */
  async flush(
    syncTranscript?: (sessionId: string) => Promise<void>,
  ): Promise<{ sent: number; left: number }> {
    let sent = 0;
    for (const op of this.pending()) {
      try {
        if (op.op === "create") {
          await this.request("POST", "/api/memory/entries", { ...op.body, clientRef: op.id });
        } else if (op.op === "update") {
          await this.request("PATCH", `/api/memory/entries/${op.entryId}`, op.body);
        } else if (op.op === "project") {
          await this.request("POST", "/api/memory/projects", op.body);
        } else if (op.op === "transcript") {
          if (!syncTranscript) continue;
          await syncTranscript(op.sessionId);
        }
        this.dequeue(op);
        sent++;
      } catch (error) {
        if (error instanceof RejectedError) {
          this.reject(op, error);
          continue;
        }
        break;
      }
    }
    if (sent)
      writeJson(path.join(this.dir, "cache", "last-sync.json"), {
        at: new Date().toISOString(),
        sent,
      });
    return { sent, left: this.pending().length };
  }

  /* ---------- Transcripts ---------- */

  /** Proposes import drafts for the owner to review. Nothing is saved as memory yet. */
  async proposeImport(batch: string, drafts: unknown[]) {
    return this.request<{ added: number; refreshed: number; kept: number; appended: number }>(
      "POST",
      "/api/memory/imports",
      { batch, drafts },
    );
  }

  async startTranscript(body: {
    client: string;
    title: string;
    machine: string;
    sessionRef: string;
  }) {
    return this.request<Transcript>("POST", "/api/memory/transcripts", body);
  }

  async appendMessages(
    id: string,
    messages: { seq: number; role: string; text: string; at?: string }[],
  ) {
    return this.request<{ added: number; skipped: number; lastSeq: number }>(
      "POST",
      `/api/memory/transcripts/${id}/messages`,
      { messages },
    );
  }

  async endTranscript(id: string) {
    return this.request("POST", `/api/memory/transcripts/${id}/end`, {});
  }
}
