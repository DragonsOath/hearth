import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  TODO_ACTIVE,
  TODO_STATUS_LABEL,
  type JobStatus,
  type TodoCategory,
  type TodoCheck,
  type TodoDetail,
  type TodoEvent,
  type TodoEvidence,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
  type Workspace,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { redactTranscript } from "../memory/redact";
import { recordAudit } from "../store/audit";
import { InvalidRequestError, NotFoundError } from "../store/errors";

/**
 * Issues & ideas. One table for the owner's list and for what Ember
 * noticed but was not asked to keep ("suggested", never saved). Every change
 * is a history event; nothing is rewritten or resolved behind the owner's
 * back. Hearth's own evidence (monitoring, incidents, linked plans)
 * says whether an issue still seems to be happening, but never closes it.
 */

type Row = typeof t.todoItems.$inferSelect;
type Actor = TodoEvent["actor"];

export interface TodoInput {
  category: TodoCategory;
  title: string;
  description?: string;
  priority?: TodoPriority;
  services?: string[];
  projectId?: string;
  evidence?: TodoEvidence[];
  nextAction?: string;
  conversationId?: string;
}

const STOP = new Set(
  "the a an and or of to in on for with is are was be been it its this that has have had keeps keep again not no from at by as up out into about when while after before".split(
    " ",
  ),
);

/** Significant words of a title, for recognising the same thing said differently. */
export function words(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
        .filter((w) => w.length > 2 && !STOP.has(w)),
    ),
  ].sort();
}

function similar(a: { title: string; services: string[] }, b: Row): boolean {
  const wa = words(a.title);
  const wb = b.fingerprint.split(" ").filter(Boolean);
  if (!wa.length || !wb.length) return false;
  const shared = wa.filter((w) => wb.includes(w)).length;
  const jaccard = shared / new Set([...wa, ...wb]).size;
  const sameSystem = a.services.some((s) => b.services.includes(s));
  return jaccard >= 0.6 || (sameSystem && jaccard >= 0.3);
}

const clean = (s: string | undefined, max: number) =>
  s === undefined ? undefined : redactTranscript(s.trim()).slice(0, max);

export class Todos {
  /** Called after any change (live updates). */
  onChange: (() => void) | undefined;

  constructor(
    private readonly handle: DbHandle,
    private readonly workspace: () => Promise<Workspace>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get db() {
    return this.handle.db;
  }

  private at() {
    return this.now().toISOString();
  }

  private async event(itemId: string, e: Omit<TodoEvent, "at"> & { at?: string }): Promise<void> {
    await this.db.insert(t.todoEvents).values({
      itemId,
      at: e.at ?? this.at(),
      actor: e.actor,
      kind: e.kind,
      text: e.text,
      fromStatus: e.from ?? null,
      toStatus: e.to ?? null,
      conversationId: e.conversationId ?? null,
    });
  }

  private async validate(input: { services?: string[]; projectId?: string }) {
    if (input.services?.length) {
      const known = await this.db
        .select({ id: t.services.id })
        .from(t.services)
        .where(inArray(t.services.id, input.services));
      const missing = input.services.filter((s) => !known.some((k) => k.id === s));
      if (missing.length) throw new InvalidRequestError(`Unknown system: ${missing.join(", ")}.`);
    }
    if (input.projectId) {
      const p = await this.db
        .select({ id: t.memoryProjects.id })
        .from(t.memoryProjects)
        .where(eq(t.memoryProjects.id, input.projectId))
        .get();
      if (!p) throw new InvalidRequestError("That project does not exist.");
    }
  }

  private async insert(
    input: TodoInput,
    status: TodoStatus,
    source: "you" | "agent",
  ): Promise<Row> {
    await this.validate(input);
    const at = this.at();
    const title = clean(input.title, 160)!;
    if (title.length < 3) throw new InvalidRequestError("Give it a title.");
    return withTransaction(this.handle, async () => {
      const last = await this.db
        .select({ n: sql<number>`coalesce(max(${t.todoItems.number}), 0)` })
        .from(t.todoItems)
        .get();
      const row: Row = {
        id: randomUUID(),
        number: (last?.n ?? 0) + 1,
        category: input.category,
        title,
        description: clean(input.description, 2000) ?? "",
        priority: input.priority ?? (input.category === "issue" ? "medium" : "low"),
        status,
        services: [...new Set(input.services ?? [])],
        projectId: input.projectId ?? null,
        evidence: (input.evidence ?? []).slice(0, 12).map((e) => ({
          ...e,
          label: clean(e.label, 200)!,
        })),
        nextAction: clean(input.nextAction, 500) ?? null,
        conversationId: input.conversationId ?? null,
        jobIds: [],
        source,
        fingerprint: words(title).join(" "),
        createdAt: at,
        updatedAt: at,
        savedAt: status === "suggested" ? null : at,
        resolvedAt: null,
      };
      await this.db.insert(t.todoItems).values(row);
      await this.event(row.id, {
        actor: source,
        kind: "created",
        text:
          status === "suggested"
            ? "Noticed by Ember and suggested for the list."
            : source === "agent"
              ? "Added to the list by Ember, as you asked."
              : "Added to the list.",
        to: status,
        conversationId: input.conversationId,
      });
      return row;
    });
  }

  /** Something Ember noticed: a suggestion, unless the same thing is already known. */
  async suggest(
    input: TodoInput,
  ): Promise<
    | { item: TodoItem; duplicate?: undefined }
    | { duplicate: TodoItem; reason: "listed" | "suggested" | "dismissed" }
  > {
    const dup = await this.findSimilar(input);
    if (dup) return dup;
    const row = await this.insert(input, "suggested", "agent");
    this.onChange?.();
    return { item: await this.toItem(row) };
  }

  /** Recently dismissed, still on the list, or already suggested: do not raise it again. */
  async findSimilar(input: {
    title: string;
    services?: string[];
  }): Promise<{ duplicate: TodoItem; reason: "listed" | "suggested" | "dismissed" } | undefined> {
    const monthAgo = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    const rows = await this.db
      .select()
      .from(t.todoItems)
      .where(sql`${t.todoItems.status} != 'resolved'`);
    const probe = { title: input.title, services: input.services ?? [] };
    for (const r of rows) {
      if (!similar(probe, r)) continue;
      if (r.status === "dismissed" && r.updatedAt < monthAgo) continue;
      return {
        duplicate: await this.toItem(r),
        reason:
          r.status === "dismissed"
            ? "dismissed"
            : r.status === "suggested"
              ? "suggested"
              : "listed",
      };
    }
    return undefined;
  }

  /** Straight onto the list (the owner, or Ember because the owner asked). */
  async create(
    input: TodoInput,
    actor: "you" | "agent",
    status: "open" | "deferred" = "open",
  ): Promise<TodoItem> {
    const row = await this.insert(input, status, actor);
    if (actor === "you") {
      await recordAudit(this.db, {
        actor: "you",
        action: `Added #${row.number} to the to-do list`,
        target: `todo:${row.id}`,
      });
    }
    this.onChange?.();
    return this.toItem(row);
  }

  private async row(idOrNumber: string | number): Promise<Row> {
    const n = typeof idOrNumber === "number" ? idOrNumber : Number(idOrNumber.replace(/^#/, ""));
    const row = await this.db
      .select()
      .from(t.todoItems)
      .where(
        Number.isInteger(n) && n > 0
          ? eq(t.todoItems.number, n)
          : eq(t.todoItems.id, String(idOrNumber)),
      )
      .get();
    if (!row) throw new NotFoundError("No such item on the list.");
    return row;
  }

  /** Puts a suggestion on the list (open or deferred). */
  async save(
    idOrNumber: string | number,
    actor: Actor,
    opts: { deferred?: boolean; conversationId?: string } = {},
  ): Promise<TodoItem> {
    const row = await this.row(idOrNumber);
    const to: TodoStatus = opts.deferred ? "deferred" : "open";
    if (row.savedAt && row.status !== "dismissed") {
      if (opts.deferred && row.status !== "deferred") {
        return this.setStatus(row.id, "deferred", actor, { conversationId: opts.conversationId });
      }
      return this.toItem(row);
    }
    const at = this.at();
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.todoItems)
        .set({ status: to, savedAt: at, updatedAt: at })
        .where(eq(t.todoItems.id, row.id));
      await this.event(row.id, {
        actor,
        kind: "saved",
        text: opts.deferred ? "Saved for later (deferred)." : "Saved to the list.",
        from: row.status,
        to,
        conversationId: opts.conversationId,
      });
    });
    this.onChange?.();
    return this.toItem(await this.row(row.id));
  }

  async setStatus(
    idOrNumber: string | number,
    status: Exclude<TodoStatus, "suggested">,
    actor: Actor,
    opts: { note?: string; conversationId?: string } = {},
  ): Promise<TodoItem> {
    const row = await this.row(idOrNumber);
    if (row.status === status) return this.toItem(row);
    const at = this.at();
    const note = clean(opts.note, 500);
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.todoItems)
        .set({
          status,
          updatedAt: at,
          // A suggestion the owner acts on is on the list from then on, except a dismissal.
          savedAt: row.savedAt ?? (status === "dismissed" ? null : at),
          resolvedAt: status === "resolved" ? at : null,
        })
        .where(eq(t.todoItems.id, row.id));
      await this.event(row.id, {
        actor,
        kind: "status",
        text: `${TODO_STATUS_LABEL[row.status]} to ${TODO_STATUS_LABEL[status]}${note ? `: ${note}` : "."}`,
        from: row.status,
        to: status,
        conversationId: opts.conversationId,
      });
    });
    if (actor === "you") {
      await recordAudit(this.db, {
        actor: "you",
        action: `Marked #${row.number} ${TODO_STATUS_LABEL[status].toLowerCase()}`,
        target: `todo:${row.id}`,
      });
    }
    this.onChange?.();
    return this.toItem(await this.row(row.id));
  }

  /**
   * The Ember conversation a task is being worked on in (11-11: Work on this), so the next
   * Work on this goes back to it instead of starting another. Not an edit: no history line.
   */
  async linkConversation(idOrNumber: string | number, conversationId: string): Promise<TodoItem> {
    const row = await this.row(idOrNumber);
    await this.handle.db
      .update(t.todoItems)
      .set({ conversationId })
      .where(eq(t.todoItems.id, row.id));
    return this.toItem(await this.row(row.id));
  }

  async edit(
    idOrNumber: string | number,
    patch: Partial<
      Pick<TodoInput, "title" | "description" | "category" | "priority" | "services" | "nextAction">
    > & { projectId?: string | null },
    actor: Actor,
    conversationId?: string,
  ): Promise<TodoItem> {
    const row = await this.row(idOrNumber);
    await this.validate({
      services: patch.services,
      projectId: patch.projectId ?? undefined,
    });
    const set: Partial<Row> = { updatedAt: this.at() };
    const changed: string[] = [];
    if (patch.title !== undefined) {
      set.title = clean(patch.title, 160)!;
      set.fingerprint = words(set.title).join(" ");
      changed.push("title");
    }
    if (patch.description !== undefined) {
      set.description = clean(patch.description, 2000)!;
      changed.push("description");
    }
    if (patch.category && patch.category !== row.category) {
      set.category = patch.category;
      changed.push(`category to ${patch.category}`);
    }
    if (patch.priority && patch.priority !== row.priority) {
      set.priority = patch.priority;
      changed.push(`priority to ${patch.priority}`);
    }
    if (patch.services) {
      set.services = [...new Set(patch.services)];
      changed.push("affected systems");
    }
    if (patch.projectId !== undefined) {
      set.projectId = patch.projectId;
      changed.push("project");
    }
    if (patch.nextAction !== undefined) {
      set.nextAction = clean(patch.nextAction, 500) || null;
      changed.push("next step");
    }
    if (!changed.length) return this.toItem(row);
    await withTransaction(this.handle, async () => {
      await this.db.update(t.todoItems).set(set).where(eq(t.todoItems.id, row.id));
      await this.event(row.id, {
        actor,
        kind: "edited",
        text: `Changed ${changed.join(", ")}.`,
        conversationId,
      });
    });
    this.onChange?.();
    return this.toItem(await this.row(row.id));
  }

  async note(
    idOrNumber: string | number,
    text: string,
    actor: Actor,
    opts: { conversationId?: string; evidence?: TodoEvidence[] } = {},
  ): Promise<TodoItem> {
    const row = await this.row(idOrNumber);
    const body = clean(text, 1000);
    if (!body) throw new InvalidRequestError("Say something first.");
    await withTransaction(this.handle, async () => {
      const evidence = [...row.evidence, ...(opts.evidence ?? [])].slice(-20);
      await this.db
        .update(t.todoItems)
        .set({ updatedAt: this.at(), evidence })
        .where(eq(t.todoItems.id, row.id));
      await this.event(row.id, {
        actor,
        kind: "note",
        text: body,
        conversationId: opts.conversationId,
      });
    });
    this.onChange?.();
    return this.toItem(await this.row(row.id));
  }

  /** A plan made for this item: remembered, and the item follows the plan's progress. */
  async linkJob(
    idOrNumber: string | number,
    job: { id: string; title: string; status: JobStatus },
    actor: Actor,
    conversationId?: string,
  ): Promise<TodoItem> {
    const row = await this.row(idOrNumber);
    if (row.jobIds.includes(job.id)) return this.toItem(row);
    await withTransaction(this.handle, async () => {
      await this.db
        .update(t.todoItems)
        .set({ jobIds: [...row.jobIds, job.id], updatedAt: this.at() })
        .where(eq(t.todoItems.id, row.id));
      await this.event(row.id, {
        actor,
        kind: "linked",
        text: `Plan "${job.title}" made for it.`,
        conversationId,
      });
    });
    await this.reconcile([row.id]);
    return this.toItem(await this.row(row.id));
  }

  /**
   * Follows linked plans: waiting for approval while one waits, investigating
   * while one runs, back to open if one fails. A plan that succeeded is
   * recorded, but the item stays until the owner (or clear evidence they
   * confirm) closes it.
   */
  async reconcile(ids?: string[]): Promise<void> {
    const rows = (
      await this.db
        .select()
        .from(t.todoItems)
        .where(
          and(
            inArray(t.todoItems.status, ["open", "investigating", "waiting-approval"]),
            ids ? inArray(t.todoItems.id, ids) : undefined,
          ),
        )
    ).filter((r) => r.jobIds.length);
    let changed = false;
    for (const r of rows) {
      const jobs = await this.db.select().from(t.jobs).where(inArray(t.jobs.id, r.jobIds));
      const seen = new Set(
        (
          await this.db
            .select({ text: t.todoEvents.text })
            .from(t.todoEvents)
            .where(and(eq(t.todoEvents.itemId, r.id), eq(t.todoEvents.actor, "dragon-control")))
        ).map((e) => e.text),
      );
      for (const j of jobs) {
        const outcome =
          j.status === "succeeded"
            ? `Plan "${j.title}" finished and its steps were verified. Check whether the problem is gone before closing it.`
            : j.status === "partial"
              ? `Plan "${j.title}" finished with some items not done: ${j.summary ?? ""}`.trim()
              : j.status === "failed" || j.status === "rolled-back" || j.status === "interrupted"
                ? `Plan "${j.title}" did not finish (${j.status}).`
                : j.status === "refused" || j.status === "expired" || j.status === "cancelled"
                  ? `Plan "${j.title}" was not carried out (${j.status}).`
                  : undefined;
        if (outcome && !seen.has(outcome)) {
          await this.event(r.id, { actor: "dragon-control", kind: "note", text: outcome });
          changed = true;
        }
      }
      const want: TodoStatus = jobs.some((j) => j.status === "awaiting-approval")
        ? "waiting-approval"
        : jobs.some((j) => j.status === "running")
          ? "investigating"
          : r.status === "waiting-approval"
            ? jobs.some((j) => j.status === "succeeded")
              ? "investigating"
              : "open"
            : r.status;
      if (want !== r.status) {
        await this.setStatus(r.id, want as Exclude<TodoStatus, "suggested">, "dragon-control", {
          note: "follows its plan",
        });
        changed = true;
      }
    }
    if (changed) this.onChange?.();
  }

  /** Issues only: is it still happening, as far as Hearth can see? */
  async checks(rows: Row[]): Promise<Map<string, TodoCheck>> {
    const out = new Map<string, TodoCheck>();
    const issues = rows.filter((r) => r.category === "issue" && r.status !== "dismissed");
    if (!issues.length) return out;
    const ws = await this.workspace();
    const all = [...ws.services, ...ws.inactiveServices];
    const ids = [...new Set(issues.flatMap((r) => r.services))];
    const incidents = ids.length
      ? await this.db
          .select({
            serviceId: t.incidents.serviceId,
            status: t.incidents.status,
            openedAt: t.incidents.openedAt,
            title: t.incidents.title,
          })
          .from(t.incidents)
          .where(inArray(t.incidents.serviceId, ids))
      : [];
    const apps = ids.length
      ? await this.db.select().from(t.appHealth).where(inArray(t.appHealth.serviceId, ids))
      : [];
    for (const r of issues) {
      if (!r.services.length) {
        out.set(r.id, {
          state: "unverified",
          detail: "Not tied to a system Hearth watches, so it cannot check it.",
        });
        continue;
      }
      const since = r.savedAt ?? r.createdAt;
      const problems: string[] = [];
      const fine: string[] = [];
      let newest: string | undefined;
      let unchecked = false;
      for (const id of r.services) {
        const s = all.find((x) => x.id === id);
        if (!s) continue;
        const name = s.name;
        if (s.lifecycle || s.stopped) {
          unchecked = true;
          continue;
        }
        const open = incidents.filter((i) => i.serviceId === id && i.status !== "resolved");
        const recent = incidents.filter((i) => i.serviceId === id && i.openedAt >= since);
        const app = apps.find((a) => a.serviceId === id);
        if (open.length) problems.push(`${name} has an open incident: ${open[0]!.title}`);
        else if (s.health === "offline" || s.lastCheck?.status === "failing")
          problems.push(`${name} is failing its checks now`);
        else if (app && (app.status === "failing" || app.status === "unreachable"))
          problems.push(`${name} reports problems inside the app`);
        else if (recent.length)
          problems.push(
            `${name} had ${recent.length} ${recent.length === 1 ? "incident" : "incidents"} since this was saved, though it is up now`,
          );
        else if (!s.lastCheck || s.lastCheck.at < since) unchecked = true;
        else {
          fine.push(name);
          if (!newest || s.lastCheck.at > newest) newest = s.lastCheck.at;
        }
      }
      if (problems.length) {
        out.set(r.id, { state: "active", detail: `${problems.join("; ")}.`, at: this.at() });
      } else if (fine.length && !unchecked) {
        out.set(r.id, {
          state: "looks-resolved",
          detail: `${fine.join(", ")} ${fine.length === 1 ? "has" : "have"} passed every check since it was saved, with no incidents. An intermittent problem may still be there.`,
          at: newest,
        });
      } else {
        out.set(r.id, {
          state: "unverified",
          detail: "Not checked since it was saved, or the system is paused or stopped.",
        });
      }
    }
    return out;
  }

  private async toItems(rows: Row[]): Promise<TodoItem[]> {
    const jobIds = [...new Set(rows.flatMap((r) => r.jobIds))];
    const jobs = jobIds.length
      ? await this.db
          .select({ id: t.jobs.id, title: t.jobs.title, status: t.jobs.status })
          .from(t.jobs)
          .where(inArray(t.jobs.id, jobIds))
      : [];
    const checks = await this.checks(rows);
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      category: r.category,
      title: r.title,
      description: r.description,
      priority: r.priority,
      status: r.status,
      services: r.services,
      projectId: r.projectId ?? undefined,
      evidence: r.evidence as TodoEvidence[],
      nextAction: r.nextAction ?? undefined,
      conversationId: r.conversationId ?? undefined,
      jobs: r.jobIds.flatMap((id) => jobs.filter((j) => j.id === id)),
      source: r.source,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      savedAt: r.savedAt ?? undefined,
      resolvedAt: r.resolvedAt ?? undefined,
      check: checks.get(r.id),
    }));
  }

  private async toItem(row: Row): Promise<TodoItem> {
    return (await this.toItems([row]))[0]!;
  }

  /** The list (saved items), plus suggestions when asked for. */
  async list(
    opts: { suggestions?: boolean; conversationId?: string; projectId?: string } = {},
  ): Promise<TodoItem[]> {
    const rows = await this.db
      .select()
      .from(t.todoItems)
      .where(
        and(
          opts.suggestions ? undefined : isNotNull(t.todoItems.savedAt),
          opts.conversationId ? eq(t.todoItems.conversationId, opts.conversationId) : undefined,
          opts.projectId ? eq(t.todoItems.projectId, opts.projectId) : undefined,
        ),
      )
      .orderBy(desc(t.todoItems.updatedAt));
    return this.toItems(rows);
  }

  /** Items Ember raised or worked on in this conversation, in order. */
  async inConversation(conversationId: string): Promise<TodoItem[]> {
    const fromEvents = await this.db
      .selectDistinct({ itemId: t.todoEvents.itemId })
      .from(t.todoEvents)
      .where(eq(t.todoEvents.conversationId, conversationId));
    const ids = fromEvents.map((e) => e.itemId);
    const rows = await this.db
      .select()
      .from(t.todoItems)
      .where(
        ids.length
          ? sql`${t.todoItems.conversationId} = ${conversationId} or ${inArray(t.todoItems.id, ids)}`
          : eq(t.todoItems.conversationId, conversationId),
      )
      .orderBy(asc(t.todoItems.createdAt), asc(t.todoItems.number));
    return this.toItems(rows);
  }

  async get(idOrNumber: string | number): Promise<TodoDetail> {
    const row = await this.row(idOrNumber);
    const events = await this.db
      .select()
      .from(t.todoEvents)
      .where(eq(t.todoEvents.itemId, row.id))
      .orderBy(asc(t.todoEvents.id));
    return {
      ...(await this.toItem(row)),
      history: events.map((e) => ({
        at: e.at,
        actor: e.actor,
        kind: e.kind,
        text: e.text,
        ...(e.fromStatus ? { from: e.fromStatus as TodoStatus } : {}),
        ...(e.toStatus ? { to: e.toStatus as TodoStatus } : {}),
        ...(e.conversationId ? { conversationId: e.conversationId } : {}),
      })),
    };
  }

  /** Open, investigating, or waiting: what is still to deal with. */
  async active(limit = 12): Promise<TodoItem[]> {
    const rows = await this.db
      .select()
      .from(t.todoItems)
      .where(inArray(t.todoItems.status, [...TODO_ACTIVE]))
      .orderBy(
        sql`case ${t.todoItems.priority} when 'high' then 0 when 'medium' then 1 else 2 end`,
        desc(t.todoItems.updatedAt),
      )
      .limit(limit);
    return this.toItems(rows);
  }

  async counts(): Promise<Record<TodoStatus, number>> {
    const rows = await this.db
      .select({ status: t.todoItems.status, n: sql<number>`count(*)` })
      .from(t.todoItems)
      .where(isNotNull(t.todoItems.savedAt))
      .groupBy(t.todoItems.status);
    const out = Object.fromEntries(
      (
        [
          "suggested",
          "open",
          "investigating",
          "waiting-approval",
          "deferred",
          "resolved",
          "dismissed",
        ] as TodoStatus[]
      ).map((s) => [s, 0]),
    ) as Record<TodoStatus, number>;
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  /** Recent items, for "what did we put off" style questions. */
  async since(days: number): Promise<TodoItem[]> {
    const from = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const rows = await this.db
      .select()
      .from(t.todoItems)
      .where(and(isNotNull(t.todoItems.savedAt), gte(t.todoItems.updatedAt, from)));
    return this.toItems(rows);
  }
}
