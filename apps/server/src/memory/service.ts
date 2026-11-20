import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type {
  MemoryBasis,
  MemoryEntry,
  MemoryKind,
  MemoryLink,
  MemoryProject,
  MemoryRevision,
  MemorySearchHit,
  MemorySource,
  MemorySuperseded,
  MemoryVerification,
  Transcript,
  TranscriptMessage,
  TranscriptRole,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { slug } from "../discovery/scan";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting } from "../store/settings";
import { redactTranscript } from "./redact";

/**
 * The homelab memory (decision D10). Lives in Hearth's own
 * database on the server, so no terminal, PC, or session owns it: every
 * client reads and writes the same memory, and saves land the moment they
 * are made. Every change keeps the previous version (memory_revisions);
 * deleting only marks an entry until you delete it for good.
 */

type Db = DbHandle["db"];

export interface Writer {
  source: MemorySource;
  /** e.g. "Claude Code on ai-box". */
  author?: string;
}

export interface EntryInput {
  kind: MemoryKind;
  title: string;
  body?: string;
  projectId?: string | null;
  status?: "open" | "done" | null;
  happenedAt?: string;
  basis?: MemoryBasis;
  machine?: string | null;
  verification?: MemoryVerification | null;
  /** Set when it is no longer how things are; null makes it current again. */
  superseded?: MemorySuperseded | null;
  links?: MemoryLink[];
  /** The writer's own id for this save: saving it again returns the first copy. */
  clientRef?: string;
}

export type EntryPatch = Partial<Omit<EntryInput, "clientRef">>;

type EntryRow = typeof t.memoryEntries.$inferSelect;

export function toEntry(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId ?? undefined,
    title: row.title,
    body: row.body,
    status: row.status ?? undefined,
    happenedAt: row.happenedAt,
    basis: row.basis,
    machine: row.machine ?? undefined,
    verification: row.verification ?? undefined,
    superseded: row.superseded ?? undefined,
    source: row.source,
    author: row.author ?? undefined,
    links: row.links,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? undefined,
  };
}

function snapshotOf(row: EntryRow): Omit<MemoryEntry, "id"> {
  // toEntry leaves out clientRef, so snapshots never carry it.
  const { id: _id, ...rest } = toEntry(row);
  return rest;
}

/**
 * Turns what someone typed into a safe full-text query: every word is
 * matched literally (no operators sneak through), and the last word also
 * matches as a prefix so results appear while typing.
 */
export function toFtsQuery(text: string): string | undefined {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/["*^:()]/g, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!words.length) return undefined;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

export class Memory {
  constructor(
    private readonly handle: DbHandle,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now() {
    return this.clock().toISOString();
  }

  /* ---------- Projects ---------- */

  async projects(): Promise<MemoryProject[]> {
    const { db } = this.handle;
    const rows = await db.select().from(t.memoryProjects).orderBy(asc(t.memoryProjects.name));
    const counts = await db
      .select({
        projectId: t.memoryEntries.projectId,
        entries: sql<number>`count(*)`,
        openThreads: sql<number>`sum(case when ${t.memoryEntries.kind} = 'thread' and ${t.memoryEntries.status} = 'open' and ${t.memoryEntries.superseded} is null then 1 else 0 end)`,
      })
      .from(t.memoryEntries)
      .where(and(isNull(t.memoryEntries.deletedAt), isNotNull(t.memoryEntries.projectId)))
      .groupBy(t.memoryEntries.projectId);
    const byId = new Map(counts.map((c) => [c.projectId, c]));
    return rows.map((p) => ({
      ...p,
      entries: Number(byId.get(p.id)?.entries ?? 0),
      openThreads: Number(byId.get(p.id)?.openThreads ?? 0),
    }));
  }

  async createProject(input: {
    name: string;
    summary?: string;
    status?: MemoryProject["status"];
  }): Promise<MemoryProject> {
    const { db } = this.handle;
    const base = slug(input.name);
    const taken = new Set(
      (await db.select({ id: t.memoryProjects.id }).from(t.memoryProjects)).map((r) => r.id),
    );
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const at = this.now();
    await db.insert(t.memoryProjects).values({
      id,
      name: input.name.trim(),
      summary: input.summary?.trim() ?? "",
      status: input.status ?? "active",
      createdAt: at,
      updatedAt: at,
    });
    return (await this.projects()).find((p) => p.id === id)!;
  }

  async updateProject(
    id: string,
    patch: { name?: string; summary?: string; status?: MemoryProject["status"] },
  ): Promise<MemoryProject> {
    const { db } = this.handle;
    const [row] = await db.select().from(t.memoryProjects).where(eq(t.memoryProjects.id, id));
    if (!row) throw new NotFoundError("No such project.");
    await db
      .update(t.memoryProjects)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary.trim() } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: this.now(),
      })
      .where(eq(t.memoryProjects.id, id));
    return (await this.projects()).find((p) => p.id === id)!;
  }

  private async checkProject(db: Db, projectId: string | null | undefined) {
    if (!projectId) return;
    const [row] = await db
      .select({ id: t.memoryProjects.id })
      .from(t.memoryProjects)
      .where(eq(t.memoryProjects.id, projectId));
    if (!row) throw new InvalidRequestError("That project does not exist.");
  }

  /* ---------- Entries ---------- */

  async list(
    filter: {
      kind?: MemoryKind;
      projectId?: string;
      status?: "open" | "done";
      deleted?: boolean;
      limit?: number;
    } = {},
  ): Promise<MemoryEntry[]> {
    const e = t.memoryEntries;
    const rows = await this.handle.db
      .select()
      .from(e)
      .where(
        and(
          filter.deleted ? isNotNull(e.deletedAt) : isNull(e.deletedAt),
          filter.kind ? eq(e.kind, filter.kind) : undefined,
          filter.projectId ? eq(e.projectId, filter.projectId) : undefined,
          filter.status ? eq(e.status, filter.status) : undefined,
        ),
      )
      .orderBy(filter.deleted ? desc(e.deletedAt) : desc(e.happenedAt), desc(e.createdAt))
      .limit(filter.limit ?? 500);
    return rows.map(toEntry);
  }

  async get(id: string): Promise<MemoryEntry> {
    const [row] = await this.handle.db
      .select()
      .from(t.memoryEntries)
      .where(eq(t.memoryEntries.id, id));
    if (!row) throw new NotFoundError("Nothing is remembered under that id.");
    return toEntry(row);
  }

  async history(id: string): Promise<MemoryRevision[]> {
    await this.get(id);
    const rows = await this.handle.db
      .select()
      .from(t.memoryRevisions)
      .where(eq(t.memoryRevisions.entryId, id))
      .orderBy(desc(t.memoryRevisions.id));
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      by: r.by,
      author: r.author ?? undefined,
      snapshot: r.snapshot as MemoryRevision["snapshot"],
    }));
  }

  /** Saves a memory immediately. Use inside an open transaction with createIn. */
  async create(input: EntryInput, by: Writer): Promise<MemoryEntry> {
    return withTransaction(this.handle, () => this.createIn(this.handle.db, input, by));
  }

  async createIn(db: Db, input: EntryInput, by: Writer): Promise<MemoryEntry> {
    if (input.clientRef) {
      const [existing] = await db
        .select()
        .from(t.memoryEntries)
        .where(eq(t.memoryEntries.clientRef, input.clientRef));
      // Already saved (a resend after being offline): the first copy stands.
      if (existing) return toEntry(existing);
    }
    await this.checkProject(db, input.projectId);
    const at = this.now();
    const row: EntryRow = {
      id: randomUUID(),
      kind: input.kind,
      projectId: input.projectId ?? null,
      title: input.title.trim(),
      body: input.body?.trim() ?? "",
      status: input.kind === "thread" ? (input.status ?? "open") : null,
      happenedAt: input.happenedAt ?? at,
      basis: input.basis ?? (by.source === "you" ? "stated" : "unknown"),
      machine: input.machine ?? null,
      verification: input.verification ?? null,
      superseded: input.superseded ?? null,
      source: by.source,
      author: by.author ?? null,
      links: input.links ?? [],
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      clientRef: input.clientRef ?? null,
    };
    await db.insert(t.memoryEntries).values(row);
    await db.insert(t.memoryRevisions).values({
      entryId: row.id,
      at,
      action: "created",
      by: by.source,
      author: by.author ?? null,
      snapshot: snapshotOf(row),
    });
    return toEntry(row);
  }

  async update(id: string, patch: EntryPatch, by: Writer): Promise<MemoryEntry> {
    return withTransaction(this.handle, async () => {
      const { db } = this.handle;
      const [before] = await db.select().from(t.memoryEntries).where(eq(t.memoryEntries.id, id));
      if (!before) throw new NotFoundError("Nothing is remembered under that id.");
      if (before.deletedAt) throw new ConflictError("Restore it before changing it.");
      if (patch.projectId !== undefined) await this.checkProject(db, patch.projectId);
      const kind = patch.kind ?? before.kind;
      const at = this.now();
      await db
        .update(t.memoryEntries)
        .set({
          kind,
          ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
          ...(patch.body !== undefined ? { body: patch.body.trim() } : {}),
          ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
          status:
            kind === "thread"
              ? ((patch.status === undefined ? before.status : patch.status) ?? "open")
              : null,
          ...(patch.happenedAt !== undefined ? { happenedAt: patch.happenedAt } : {}),
          ...(patch.basis !== undefined ? { basis: patch.basis } : {}),
          ...(patch.machine !== undefined ? { machine: patch.machine } : {}),
          ...(patch.verification !== undefined ? { verification: patch.verification } : {}),
          ...(patch.superseded !== undefined ? { superseded: patch.superseded } : {}),
          ...(patch.links !== undefined ? { links: patch.links } : {}),
          updatedAt: at,
        })
        .where(eq(t.memoryEntries.id, id));
      await db.insert(t.memoryRevisions).values({
        entryId: id,
        at,
        action: "edited",
        by: by.source,
        author: by.author ?? null,
        snapshot: snapshotOf(before),
      });
      return this.get(id);
    });
  }

  /** Moves it to Recently deleted. It can be restored until deleted for good. */
  async remove(id: string, by: Writer): Promise<void> {
    await this.mark(id, by, "deleted");
  }

  async restore(id: string, by: Writer): Promise<MemoryEntry> {
    await this.mark(id, by, "restored");
    return this.get(id);
  }

  private async mark(id: string, by: Writer, action: "deleted" | "restored") {
    await withTransaction(this.handle, async () => {
      const { db } = this.handle;
      const [before] = await db.select().from(t.memoryEntries).where(eq(t.memoryEntries.id, id));
      if (!before) throw new NotFoundError("Nothing is remembered under that id.");
      if ((action === "deleted") === Boolean(before.deletedAt)) {
        throw new ConflictError(action === "deleted" ? "Already deleted." : "It is not deleted.");
      }
      const at = this.now();
      await db
        .update(t.memoryEntries)
        .set({ deletedAt: action === "deleted" ? at : null, updatedAt: at })
        .where(eq(t.memoryEntries.id, id));
      await db.insert(t.memoryRevisions).values({
        entryId: id,
        at,
        action,
        by: by.source,
        author: by.author ?? null,
        snapshot: snapshotOf(before),
      });
    });
  }

  /** Gone for good, history included. Only from Recently deleted. */
  async purge(id: string): Promise<void> {
    const entry = await this.get(id);
    if (!entry.deletedAt)
      throw new ConflictError("Delete it first; then it can be removed for good.");
    await this.handle.db.delete(t.memoryEntries).where(eq(t.memoryEntries.id, id));
  }

  /**
   * Hearth's own journal: repairs, discoveries, installs. Only for
   * your real systems; sample data is never remembered.
   */
  async recordSystem(
    db: Db,
    input: Omit<EntryInput, "kind" | "basis"> & { kind?: MemoryKind },
  ): Promise<MemoryEntry | undefined> {
    if ((await getSetting(db, "environment")) !== "real") return undefined;
    return this.createIn(
      db,
      { ...input, kind: input.kind ?? "journal", basis: "observed" },
      { source: "dragon-control", author: "Hearth" },
    );
  }

  /* ---------- Search ---------- */

  async search(text: string, limit = 30): Promise<MemorySearchHit[]> {
    const query = toFtsQuery(text);
    if (!query) return [];
    const rows = this.handle.sqlite
      .prepare(
        `SELECT source, ref, snippet(memory_search, -1, '[[', ']]', '…', 14) AS snippet
         FROM memory_search WHERE memory_search MATCH ? ORDER BY bm25(memory_search, 0, 0, 3, 1) LIMIT ?`,
      )
      .all(query, limit) as { source: string; ref: string; snippet: string }[];

    const hits: MemorySearchHit[] = [];
    for (const r of rows) {
      if (r.source === "entry") {
        const e = this.handle.sqlite
          .prepare("SELECT title, kind, happened_at FROM memory_entries WHERE id = ?")
          .get(r.ref) as { title: string; kind: MemoryKind; happened_at: string } | undefined;
        if (e) {
          hits.push({
            type: "entry",
            id: r.ref,
            title: e.title,
            snippet: r.snippet,
            at: e.happened_at,
            kind: e.kind,
          });
        }
        continue;
      }
      const cut = r.ref.lastIndexOf(":");
      const parent = r.ref.slice(0, cut);
      const seq = Number(r.ref.slice(cut + 1));
      if (r.source === "transcript") {
        const m = this.handle.sqlite
          .prepare(
            `SELECT tr.title AS title, m.at AS at FROM memory_transcript_messages m
             JOIN memory_transcripts tr ON tr.id = m.transcript_id WHERE m.transcript_id = ? AND m.seq = ?`,
          )
          .get(parent, seq) as { title: string; at: string } | undefined;
        if (m)
          hits.push({
            type: "transcript",
            id: parent,
            seq,
            title: m.title,
            snippet: r.snippet,
            at: m.at,
          });
      } else if (r.source === "conversation") {
        const m = this.handle.sqlite
          .prepare(
            `SELECT c.title AS title, m.at AS at FROM conversation_messages m
             JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`,
          )
          .get(seq) as { title: string; at: string } | undefined;
        if (m)
          hits.push({
            type: "conversation",
            id: parent,
            seq,
            title: m.title,
            snippet: r.snippet,
            at: m.at,
          });
      }
    }
    return hits;
  }

  /* ---------- Transcripts ---------- */

  async startTranscript(input: {
    client: string;
    title: string;
    machine?: string;
    sessionRef?: string;
    projectId?: string;
    startedAt?: string;
  }): Promise<Transcript> {
    const { db } = this.handle;
    if (input.sessionRef) {
      const [existing] = await db
        .select()
        .from(t.memoryTranscripts)
        .where(
          and(
            eq(t.memoryTranscripts.client, input.client),
            eq(t.memoryTranscripts.sessionRef, input.sessionRef),
          ),
        );
      // Saving the same session again continues it instead of making a copy.
      if (existing) return this.transcript(existing.id).then((x) => x.transcript);
    }
    await this.checkProject(db, input.projectId);
    const id = randomUUID();
    const at = this.now();
    await db.insert(t.memoryTranscripts).values({
      id,
      client: input.client,
      title: input.title.trim(),
      machine: input.machine ?? null,
      sessionRef: input.sessionRef ?? null,
      projectId: input.projectId ?? null,
      startedAt: input.startedAt ?? at,
      endedAt: null,
      createdAt: at,
    });
    return (await this.transcript(id)).transcript;
  }

  /**
   * Adds messages as they happen. Messages that carry a number already
   * saved are skipped, so a client can safely resend after a dropped
   * connection or a crash.
   */
  async appendMessages(
    id: string,
    messages: { seq?: number; role: TranscriptRole; text: string; at?: string }[],
  ): Promise<{ added: number; skipped: number; lastSeq: number }> {
    return withTransaction(this.handle, async () => {
      const { db } = this.handle;
      const [tr] = await db
        .select()
        .from(t.memoryTranscripts)
        .where(eq(t.memoryTranscripts.id, id));
      if (!tr) throw new NotFoundError("No such transcript.");
      const [top] = await db
        .select({ max: sql<number | null>`max(${t.memoryTranscriptMessages.seq})` })
        .from(t.memoryTranscriptMessages)
        .where(eq(t.memoryTranscriptMessages.transcriptId, id));
      let next = Number(top?.max ?? 0) + 1;
      const existing = new Set(
        (
          await db
            .select({ seq: t.memoryTranscriptMessages.seq })
            .from(t.memoryTranscriptMessages)
            .where(eq(t.memoryTranscriptMessages.transcriptId, id))
        ).map((r) => r.seq),
      );
      let added = 0;
      let skipped = 0;
      for (const m of messages) {
        const seq = m.seq ?? next;
        if (existing.has(seq)) {
          skipped++;
          continue;
        }
        await db.insert(t.memoryTranscriptMessages).values({
          transcriptId: id,
          seq,
          role: m.role,
          text: redactTranscript(m.text),
          at: m.at ?? this.now(),
        });
        existing.add(seq);
        next = Math.max(next, seq + 1);
        added++;
      }
      return { added, skipped, lastSeq: next - 1 };
    });
  }

  async endTranscript(id: string): Promise<Transcript> {
    await this.transcript(id);
    await this.handle.db
      .update(t.memoryTranscripts)
      .set({ endedAt: this.now() })
      .where(eq(t.memoryTranscripts.id, id));
    return (await this.transcript(id)).transcript;
  }

  async transcripts(limit = 100): Promise<Transcript[]> {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT tr.*, (SELECT count(*) FROM memory_transcript_messages m WHERE m.transcript_id = tr.id) AS message_count
         FROM memory_transcripts tr ORDER BY tr.started_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, string | number | null>[];
    return rows.map(rowToTranscript);
  }

  async transcript(id: string): Promise<{ transcript: Transcript; messages: TranscriptMessage[] }> {
    const row = this.handle.sqlite
      .prepare(
        `SELECT tr.*, (SELECT count(*) FROM memory_transcript_messages m WHERE m.transcript_id = tr.id) AS message_count
         FROM memory_transcripts tr WHERE tr.id = ?`,
      )
      .get(id) as Record<string, string | number | null> | undefined;
    if (!row) throw new NotFoundError("No such transcript.");
    const messages = await this.handle.db
      .select({
        seq: t.memoryTranscriptMessages.seq,
        role: t.memoryTranscriptMessages.role,
        text: t.memoryTranscriptMessages.text,
        at: t.memoryTranscriptMessages.at,
      })
      .from(t.memoryTranscriptMessages)
      .where(eq(t.memoryTranscriptMessages.transcriptId, id))
      .orderBy(asc(t.memoryTranscriptMessages.seq));
    return { transcript: rowToTranscript(row), messages };
  }
}

function rowToTranscript(r: Record<string, string | number | null>): Transcript {
  return {
    id: String(r.id),
    client: String(r.client),
    title: String(r.title),
    machine: (r.machine as string | null) ?? undefined,
    sessionRef: (r.session_ref as string | null) ?? undefined,
    projectId: (r.project_id as string | null) ?? undefined,
    startedAt: String(r.started_at),
    endedAt: (r.ended_at as string | null) ?? undefined,
    messageCount: Number(r.message_count ?? 0),
  };
}
