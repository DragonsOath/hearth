import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  ImportDraft,
  ImportDraftInput,
  ImportPayload,
  ImportSummary,
  ImportTriage,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { ConflictError, NotFoundError } from "../store/errors";
import { redactTranscript } from "./redact";
import type { Memory } from "./service";
import { triageDrafts, type SystemFacts } from "./triage";

/**
 * Importing existing notes and past sessions into the memory, with the
 * owner in the loop: an importer proposes drafts, the owner accepts, edits,
 * or rejects each one, and only accepted drafts become memories. Source
 * files are only ever read, by the importer, on the machine that has them.
 *
 * Re-running an import is safe: drafts are keyed by their source piece, so
 * pending ones are refreshed, decided ones keep their decision, and an
 * accepted session receives any messages added since.
 */

type Row = typeof t.memoryImportDrafts.$inferSelect;

function scrub(payload: ImportPayload): ImportPayload {
  if (payload.kind === "entry") {
    const e = payload.entry;
    return {
      kind: "entry",
      entry: { ...e, title: redactTranscript(e.title), body: e.body && redactTranscript(e.body) },
    };
  }
  if (payload.kind === "project") {
    const p = payload.project;
    return {
      kind: "project",
      project: { ...p, summary: p.summary && redactTranscript(p.summary) },
    };
  }
  return {
    kind: "session",
    session: {
      ...payload.session,
      messages: payload.session.messages.map((m) => ({ ...m, text: redactTranscript(m.text) })),
    },
  };
}

function toDraft(row: Row, full: boolean, triage?: ImportTriage): ImportDraft {
  let payload = row.payload as ImportPayload;
  let messageCount: number | undefined;
  if (payload.kind === "session") {
    messageCount = payload.session.messages.length;
    if (!full) {
      payload = {
        kind: "session",
        session: { ...payload.session, messages: payload.session.messages.slice(0, 3) },
      };
    }
  }
  return {
    id: row.id,
    sourceRef: row.sourceRef,
    batch: row.batch,
    origin: row.origin,
    anchor: row.anchor,
    payload,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decidedAt: row.decidedAt ?? undefined,
    resultId: row.resultId ?? undefined,
    messageCount,
    triage: row.status === "pending" ? triage : undefined,
  };
}

export class Imports {
  constructor(
    private readonly handle: DbHandle,
    private readonly memory: Memory,
    /** What Hearth sees now, to check old notes against. */
    private readonly system: () => Promise<SystemFacts> = async () => ({
      real: false,
      hosts: [],
      services: [],
    }),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** How many drafts wait, and how many look ready to keep in one go. */
  async readiness(): Promise<{ pending: number; ready: number }> {
    const triage = await this.triage();
    let ready = 0;
    for (const t of triage.values()) if (t.tier === "confident") ready++;
    return { pending: triage.size, ready };
  }

  /** Suggestions for every waiting draft, worked out together so duplicates can be found. */
  async triage(): Promise<Map<string, ImportTriage>> {
    const rows = await this.handle.db
      .select()
      .from(t.memoryImportDrafts)
      .where(eq(t.memoryImportDrafts.status, "pending"))
      .orderBy(t.memoryImportDrafts.createdAt);
    const entries = await this.memory.list({ limit: 5000 });
    const sessions = (await this.memory.transcripts(100_000)).flatMap((tr) =>
      tr.sessionRef ? [{ id: tr.id, sessionRef: tr.sessionRef, title: tr.title }] : [],
    );
    return triageDrafts(
      rows.map((r) => ({ id: r.id, note: r.note, payload: r.payload as ImportPayload })),
      {
        system: await this.system(),
        entries,
        sessions,
        projectNames: (await this.memory.projects()).map((p) => p.name),
      },
    );
  }

  private now() {
    return this.clock().toISOString();
  }

  /** Adds or refreshes drafts. Secret-looking text is hidden before anything is stored. */
  async propose(
    batch: string,
    drafts: ImportDraftInput[],
  ): Promise<{ added: number; refreshed: number; kept: number; appended: number }> {
    const { db } = this.handle;
    let added = 0;
    let refreshed = 0;
    let kept = 0;
    let appended = 0;
    for (const d of drafts) {
      const payload = scrub(d.payload);
      const at = this.now();
      const [existing] = await db
        .select()
        .from(t.memoryImportDrafts)
        .where(eq(t.memoryImportDrafts.sourceRef, d.sourceRef));
      if (!existing) {
        await db.insert(t.memoryImportDrafts).values({
          id: randomUUID(),
          sourceRef: d.sourceRef,
          batch,
          origin: d.origin,
          anchor: d.anchor,
          kind: payload.kind,
          payload,
          note: d.note ?? "",
          status: "pending",
          createdAt: at,
          updatedAt: at,
        });
        added++;
      } else if (existing.status === "pending") {
        await db
          .update(t.memoryImportDrafts)
          .set({
            batch,
            origin: d.origin,
            anchor: d.anchor,
            kind: payload.kind,
            payload,
            note: d.note ?? "",
            updatedAt: at,
          })
          .where(eq(t.memoryImportDrafts.id, existing.id));
        refreshed++;
      } else if (
        existing.status === "accepted" &&
        payload.kind === "session" &&
        existing.resultId
      ) {
        // The same session, continued since it was accepted: add the new messages.
        const result = await this.memory.appendMessages(
          existing.resultId,
          payload.session.messages,
        );
        if (result.added) {
          await db
            .update(t.memoryImportDrafts)
            .set({ payload, updatedAt: at })
            .where(eq(t.memoryImportDrafts.id, existing.id));
          appended += result.added;
        } else kept++;
      } else {
        kept++;
      }
    }
    return { added, refreshed, kept, appended };
  }

  async summary(): Promise<ImportSummary> {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT batch, status, count(*) AS n FROM memory_import_drafts GROUP BY batch, status`,
      )
      .all() as { batch: string; status: string; n: number }[];
    const batches = new Map<string, { batch: string; pending: number; total: number }>();
    const totals = { pending: 0, accepted: 0, rejected: 0 };
    for (const r of rows) {
      const b = batches.get(r.batch) ?? { batch: r.batch, pending: 0, total: 0 };
      b.total += Number(r.n);
      if (r.status === "pending") b.pending += Number(r.n);
      batches.set(r.batch, b);
      totals[r.status as keyof typeof totals] += Number(r.n);
    }
    return { ...totals, batches: [...batches.values()] };
  }

  async list(
    filter: { status?: ImportDraft["status"]; batch?: string } = {},
  ): Promise<ImportDraft[]> {
    const d = t.memoryImportDrafts;
    const rows = await this.handle.db
      .select()
      .from(d)
      .where(
        and(
          filter.status ? eq(d.status, filter.status) : undefined,
          filter.batch ? eq(d.batch, filter.batch) : undefined,
        ),
      )
      .orderBy(d.origin, d.createdAt);
    const triage = filter.status === "pending" || !filter.status ? await this.triage() : undefined;
    return rows.map((r) => toDraft(r, false, triage?.get(r.id)));
  }

  async get(id: string, withTriage = true): Promise<ImportDraft> {
    const [row] = await this.handle.db
      .select()
      .from(t.memoryImportDrafts)
      .where(eq(t.memoryImportDrafts.id, id));
    if (!row) throw new NotFoundError("No such import draft.");
    const triage =
      withTriage && row.status === "pending" ? (await this.triage()).get(id) : undefined;
    return toDraft(row, true, triage);
  }

  private async projectId(name: string | undefined): Promise<string | undefined> {
    if (!name?.trim()) return undefined;
    const projects = await this.memory.projects();
    const match = projects.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
    return match?.id ?? (await this.memory.createProject({ name: name.trim() })).id;
  }

  /**
   * Turns a draft into memory. `edits` lets the owner correct an entry
   * before it is saved. Accepting twice changes nothing.
   */
  async accept(
    id: string,
    edits?: Partial<Extract<ImportPayload, { kind: "entry" }>["entry"]>,
    opts: { asCurrent?: boolean; triage?: Map<string, ImportTriage> } = {},
  ): Promise<ImportDraft> {
    const draft = await this.get(id, false);
    if (draft.status === "accepted") return draft;
    // Older notes that conflict with what Hearth sees are history:
    // saved superseded (and an open thread closed) unless you say otherwise.
    const supersede = opts.asCurrent
      ? undefined
      : (opts.triage ?? (await this.triage())).get(id)?.supersede;
    let resultId: string;
    const payload = draft.payload;
    if (payload.kind === "project") {
      const existing = (await this.memory.projects()).find(
        (p) => p.name.toLowerCase() === payload.project.name.toLowerCase(),
      );
      resultId = existing
        ? (
            await this.memory.updateProject(existing.id, {
              summary: payload.project.summary ?? existing.summary,
              status: payload.project.status,
            })
          ).id
        : (await this.memory.createProject(payload.project)).id;
    } else if (payload.kind === "session") {
      const s = payload.session;
      const tr = await this.memory.startTranscript({
        client: s.client,
        title: s.title,
        machine: s.machine,
        sessionRef: s.sessionRef,
        startedAt: s.startedAt,
      });
      await this.memory.appendMessages(tr.id, s.messages);
      resultId = tr.id;
    } else {
      const e = { ...payload.entry, ...edits };
      const entry = await this.memory.create(
        {
          kind: e.kind,
          title: redactTranscript(e.title),
          body: e.body && redactTranscript(e.body),
          projectId: await this.projectId(e.projectName),
          status: e.kind === "thread" ? (supersede ? "done" : (e.status ?? "open")) : undefined,
          superseded: supersede ? { at: this.now(), reason: supersede } : undefined,
          happenedAt: e.happenedAt,
          basis: e.basis ?? "documented",
          machine: e.machine,
          links: [
            {
              label: "Imported from",
              ref: `file:${draft.origin}${draft.anchor ? `#${draft.anchor}` : ""}`,
            },
            ...(e.links ?? []),
          ],
          clientRef: `import:${draft.sourceRef}`,
        },
        { source: "import", author: e.author ? `${e.author}, imported` : "Imported" },
      );
      resultId = entry.id;
    }
    await this.handle.db
      .update(t.memoryImportDrafts)
      .set({ status: "accepted", decidedAt: this.now(), resultId, updatedAt: this.now() })
      .where(eq(t.memoryImportDrafts.id, id));
    return this.get(id, false);
  }

  async reject(id: string): Promise<ImportDraft> {
    const draft = await this.get(id, false);
    if (draft.status === "accepted") {
      throw new ConflictError("Already accepted. Delete the memory it created instead.");
    }
    await this.handle.db
      .update(t.memoryImportDrafts)
      .set({ status: "rejected", decidedAt: this.now(), updatedAt: this.now() })
      .where(eq(t.memoryImportDrafts.id, id));
    return this.get(id);
  }

  /** Accept or reject many at once (one file, one batch, or a selection). */
  async decide(
    ids: string[],
    decision: "accept" | "reject",
  ): Promise<{ done: number; skipped: number }> {
    let done = 0;
    let skipped = 0;
    const triage = decision === "accept" ? await this.triage() : undefined;
    // Projects first, so entries that name them attach to them.
    const rows = await this.handle.db
      .select({
        id: t.memoryImportDrafts.id,
        kind: t.memoryImportDrafts.kind,
        status: t.memoryImportDrafts.status,
      })
      .from(t.memoryImportDrafts)
      .where(inArray(t.memoryImportDrafts.id, ids))
      .orderBy(
        sql`case ${t.memoryImportDrafts.kind} when 'project' then 0 else 1 end`,
        desc(t.memoryImportDrafts.createdAt),
      );
    for (const r of rows) {
      if (r.status !== "pending") {
        skipped++;
        continue;
      }
      await (decision === "accept" ? this.accept(r.id, undefined, { triage }) : this.reject(r.id));
      done++;
    }
    return { done, skipped };
  }

  /** Puts a rejected draft back up for review. */
  async reopen(id: string): Promise<ImportDraft> {
    const draft = await this.get(id);
    if (draft.status !== "rejected")
      throw new ConflictError("Only rejected drafts can be reconsidered.");
    await withTransaction(this.handle, async () => {
      await this.handle.db
        .update(t.memoryImportDrafts)
        .set({ status: "pending", decidedAt: null, updatedAt: this.now() })
        .where(eq(t.memoryImportDrafts.id, id));
    });
    return this.get(id);
  }
}
