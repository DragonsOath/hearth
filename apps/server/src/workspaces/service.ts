import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import {
  WORKSPACE_LIMITS as L,
  type WorkspaceSpec,
  type WorkspaceSubmission,
  type WorkspaceSummary,
  type WorkspaceView,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { redactTranscript } from "../memory/redact";
import { InvalidRequestError, NotFoundError } from "../store/errors";
import type { Memory } from "../memory/service";
import { changedSince, plansFor, snapshotById, writeSnapshot } from "./plans";

/**
 * Interactive workspaces (feature request 20). Ember fills a panel with structured data
 * (columns, items, choices); the owner's choices are kept here as they make them. Nothing here
 * touches files, services, or plans: a submission is only the owner's decisions, handed back to
 * the conversation. Dismissing removes only this row.
 */

export const WORKSPACE_KEEP_DAYS = 30;

type Row = typeof t.workspaces.$inferSelect;

const label = z.string().trim().min(1).max(80);
const cell = z.union([z.string().max(L.text), z.number().finite(), z.null()]);
const key = z
  .string()
  .regex(
    /^[\w-]{1,40}$/,
    "Column keys and choice values are short words (letters, digits, - or _).",
  );

const column = z
  .object({ key, label, kind: z.enum(["text", "number", "bytes", "badge", "path"]).optional() })
  .strict();
const choice = z
  .object({
    value: key,
    label: z.string().trim().min(1).max(30),
    tone: z.enum(["good", "warn", "neutral"]).optional(),
    acts: z.boolean().optional(),
  })
  .strict();
const item = z
  .object({
    id: z.string().min(1).max(400),
    group: z.string().max(200).optional(),
    values: z.record(key, cell),
    warning: z.string().max(L.text).optional(),
    image: z
      .string()
      .max(400)
      .regex(
        /^\/library\/[\w/.-]+$/,
        "image is a Plex picture path such as /library/metadata/123/thumb/456.",
      )
      .optional(),
  })
  .strict();

const layout = z
  .object({
    kind: z.literal("pick"),
    choice: key,
    other: key,
    target: z.number().int().min(1).max(L.items).optional(),
    details: z.array(key).max(6).optional(),
  })
  .strict()
  .describe(
    "pick: a set to choose (Selected beside Alternatives, with the count against target). choice = the choice value meaning selected (acts: true when the plan acts on selected items), other = the value for the rest; details = column keys shown under each title.",
  );

export const workspaceSpec = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional(),
    columns: z.array(column).min(1).max(L.columns),
    choices: z.array(choice).max(L.choices).optional(),
    items: z.array(item).max(L.items),
    suggested: z.record(z.string().max(400), key).optional(),
    submitLabel: z.string().trim().min(1).max(40).optional(),
    layout: layout.optional(),
    imageService: z
      .string()
      .max(80)
      .optional()
      .describe("The Plex service id the items' image paths come from: posters show on each item."),
  })
  .strict();

/** What Ember may change in an open workspace; the owner's choices are kept. */
export const workspacePatch = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    columns: z.array(column).min(1).max(L.columns).optional(),
    choices: z.array(choice).max(L.choices).optional(),
    /** Replaces the whole list. */
    items: z.array(item).max(L.items).optional(),
    /** Adds or replaces these (by id). */
    upsert: z.array(item).max(L.items).optional(),
    remove: z.array(z.string().max(400)).max(L.items).optional(),
    suggested: z.record(z.string().max(400), key).optional(),
    submitLabel: z.string().trim().min(1).max(40).optional(),
    layout: layout.optional(),
  })
  .strict();

/** Checks a spec as a whole: unique ids, known columns and choices. */
function check(spec: WorkspaceSpec): WorkspaceSpec {
  if (spec.items.length > L.items) throw new InvalidRequestError(`At most ${L.items} items.`);
  const ids = new Set<string>();
  for (const i of spec.items) {
    if (ids.has(i.id)) throw new InvalidRequestError(`Two items share the id "${i.id}".`);
    ids.add(i.id);
  }
  const cols = new Set(spec.columns.map((c) => c.key));
  if (cols.size !== spec.columns.length) throw new InvalidRequestError("Two columns share a key.");
  for (const i of spec.items)
    for (const k of Object.keys(i.values))
      if (!cols.has(k))
        throw new InvalidRequestError(`Item "${i.id}" has a value for unknown column "${k}".`);
  const values = new Set((spec.choices ?? []).map((c) => c.value));
  if (values.size !== (spec.choices ?? []).length)
    throw new InvalidRequestError("Two choices share a value.");
  if (spec.layout) {
    if (!values.has(spec.layout.choice) || !values.has(spec.layout.other))
      throw new InvalidRequestError(
        "A pick layout's choice and other must both be among the choices (for example include and skip).",
      );
    for (const k of spec.layout.details ?? [])
      if (!cols.has(k)) throw new InvalidRequestError(`Detail "${k}" is not a column.`);
  }
  if (spec.suggested) {
    for (const [id, v] of Object.entries(spec.suggested)) {
      if (!ids.has(id)) delete spec.suggested[id];
      else if (!values.has(v))
        throw new InvalidRequestError(`Suggested choice "${v}" is not one of the choices.`);
    }
  }
  // Text shown to the owner and read back by the AI: no secrets kept here.
  spec.title = redactTranscript(spec.title);
  if (spec.description) spec.description = redactTranscript(spec.description);
  return spec;
}

/** The owner's choices, with Ember's suggestions where they have not chosen. */
export function effective(spec: WorkspaceSpec, selections: Record<string, string>) {
  const out: Record<string, string> = {};
  const values = new Set((spec.choices ?? []).map((c) => c.value));
  for (const i of spec.items) {
    const v = selections[i.id] ?? spec.suggested?.[i.id];
    if (v && values.has(v)) out[i.id] = v;
  }
  return out;
}

function toView(r: Row): WorkspaceView {
  return {
    id: r.id,
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
    kind: r.kind,
    state: r.state,
    spec: r.spec as WorkspaceSpec,
    selections: (r.selections as Record<string, string> | null) ?? {},
    ...(r.submission ? { submission: r.submission as WorkspaceSubmission } : {}),
    ...(r.folder ? { folder: r.folder } : {}),
    ...(r.savedAt ? { savedAt: r.savedAt } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function summarize(v: WorkspaceView): WorkspaceSummary {
  return {
    id: v.id,
    title: v.spec.title,
    ...(v.conversationId ? { conversationId: v.conversationId } : {}),
    kind: v.kind,
    state: v.state,
    ...(v.folder ? { folder: v.folder } : {}),
    ...(v.savedAt ? { savedAt: v.savedAt } : {}),
    ...(v.spec.description ? { description: v.spec.description.slice(0, 200) } : {}),
    items: v.spec.items.length,
    decided: Object.keys(effective(v.spec, v.selections)).length,
    ...(v.submission ? { submittedAt: v.submission.at } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export class Workspaces {
  constructor(private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  async create(input: { conversationId?: string; spec: unknown }): Promise<WorkspaceView> {
    const spec = check(workspaceSpec.parse(input.spec) as WorkspaceSpec);
    if (input.conversationId) {
      const c = await this.db
        .select({ id: t.conversations.id })
        .from(t.conversations)
        .where(eq(t.conversations.id, input.conversationId))
        .get();
      if (!c) throw new NotFoundError("No such conversation.");
    }
    const now = new Date().toISOString();
    const row: Row = {
      id: randomUUID(),
      conversationId: input.conversationId ?? null,
      kind: "temporary",
      state: "open",
      spec,
      selections: {},
      submission: null,
      folder: null,
      savedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(t.workspaces).values(row);
    return toView(row);
  }

  async get(id: string): Promise<WorkspaceView> {
    const r = await this.db.select().from(t.workspaces).where(eq(t.workspaces.id, id)).get();
    if (!r) throw new NotFoundError("That workspace is gone (it was closed or never existed).");
    const v = toView(r);
    const plans = await plansFor(this.handle, id);
    if (!plans.length) return v;
    // The newest plan still waiting or running: does it still match your choices?
    const active = plans.find((p) => p.status === "awaiting-approval" || p.status === "running");
    const snap = active ? await snapshotById(this.handle, active.snapshotId) : undefined;
    const changed = snap ? changedSince(v, snap) : [];
    return {
      ...v,
      plans,
      ...(active && changed.length
        ? { revised: { jobId: active.jobId, snapshotAt: active.snapshotAt, changed } }
        : {}),
    };
  }

  async list(
    q: { conversationId?: string; kind?: "temporary" | "saved" } = {},
  ): Promise<WorkspaceSummary[]> {
    const where = [
      ...(q.conversationId ? [eq(t.workspaces.conversationId, q.conversationId)] : []),
      ...(q.kind ? [eq(t.workspaces.kind, q.kind)] : []),
    ];
    const rows = await this.db
      .select()
      .from(t.workspaces)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(t.workspaces.updatedAt));
    return rows.map((r) => summarize(toView(r)));
  }

  /** Ember changes the list or its layout; every choice the owner made stays. */
  async update(id: string, patch: unknown): Promise<WorkspaceView> {
    const p = workspacePatch.parse(patch);
    const cur = await this.get(id);
    const spec: WorkspaceSpec = structuredClone(cur.spec);
    if (p.title !== undefined) spec.title = p.title;
    if (p.description !== undefined) spec.description = p.description;
    if (p.columns) spec.columns = p.columns;
    if (p.choices) spec.choices = p.choices;
    if (p.submitLabel) spec.submitLabel = p.submitLabel;
    if (p.layout) spec.layout = p.layout;
    if (p.items) spec.items = p.items;
    if (p.upsert) {
      const at = new Map(spec.items.map((i, n) => [i.id, n]));
      for (const i of p.upsert) {
        const n = at.get(i.id);
        if (n === undefined) spec.items.push(i);
        else spec.items[n] = i;
      }
    }
    if (p.remove) {
      const gone = new Set(p.remove);
      spec.items = spec.items.filter((i) => !gone.has(i.id));
    }
    if (p.suggested) spec.suggested = { ...(spec.suggested ?? {}), ...p.suggested };
    check(spec);
    return this.write(id, { spec });
  }

  /**
   * The owner adds a title from the whole library to a pick sheet (11-07): it joins the list
   * and lands in Selected, like any item Ember loaded. Already there: it is selected, not added
   * twice. The sheet's own item limit still applies.
   */
  async addPicked(
    id: string,
    item: { id: string; values: Record<string, string | number | null>; image?: string },
  ): Promise<{ view: WorkspaceView; added: boolean }> {
    const cur = await this.get(id);
    const pick = cur.spec.layout?.kind === "pick" ? cur.spec.layout : undefined;
    if (!pick) throw new InvalidRequestError("Only a pick sheet takes titles from the library.");
    const known = new Set(cur.spec.columns.map((c) => c.key));
    const values = Object.fromEntries(
      Object.entries(item.values).filter(([k]) => known.has(k)),
    ) as Record<string, string | number | null>;
    const exists = cur.spec.items.some((i) => i.id === item.id);
    if (!exists) {
      const spec: WorkspaceSpec = structuredClone(cur.spec);
      spec.items.push({ id: item.id, values, ...(item.image ? { image: item.image } : {}) });
      check(spec);
      await this.write(id, { spec });
    }
    const view = await this.select(id, { [item.id]: pick.choice });
    return { view, added: !exists };
  }

  /** The owner's choices, merged in as they make them (null clears one). */
  async select(id: string, changes: Record<string, string | null>): Promise<WorkspaceView> {
    const cur = await this.get(id);
    const values = new Set((cur.spec.choices ?? []).map((c) => c.value));
    const ids = new Set(cur.spec.items.map((i) => i.id));
    const next = { ...cur.selections };
    for (const [itemId, v] of Object.entries(changes)) {
      if (!ids.has(itemId)) continue; // an item Ember just removed
      if (v === null) delete next[itemId];
      else if (values.has(v)) next[itemId] = v;
      else throw new InvalidRequestError(`"${v}" is not one of this workspace's choices.`);
    }
    return this.write(id, { selections: next });
  }

  async submit(id: string): Promise<WorkspaceView> {
    const cur = await this.get(id);
    if (!cur.spec.choices?.length)
      throw new InvalidRequestError("This workspace has nothing to decide.");
    const decisions = effective(cur.spec, cur.selections);
    const counts: Record<string, number> = {};
    for (const v of Object.values(decisions)) counts[v] = (counts[v] ?? 0) + 1;
    const at = new Date().toISOString();
    // Frozen: what a plan is built from. Later edits to the workspace never change it.
    const snapshotId = await writeSnapshot(this.handle, cur, decisions, at);
    const submission: WorkspaceSubmission = {
      snapshotId,
      at,
      decisions,
      counts,
      undecided: cur.spec.items.length - Object.keys(decisions).length,
    };
    return this.write(id, { submission });
  }

  async setState(id: string, state: "open" | "minimized" | "closed"): Promise<WorkspaceView> {
    const cur = await this.get(id);
    if (state === "closed" && cur.kind !== "saved")
      throw new InvalidRequestError(
        "Only a saved working file can be closed and kept; a temporary workspace is discarded.",
      );
    return this.write(id, { state });
  }

  /**
   * Saves it as a working file: moved (not copied) into Saved work with everything it holds
   * (items, your choices, submission, its conversation), still interactive, never cleared.
   */
  async save(id: string, opts: { title?: string; folder?: string } = {}): Promise<WorkspaceView> {
    const cur = await this.get(id);
    const spec = opts.title?.trim()
      ? { ...cur.spec, title: redactTranscript(opts.title.trim().slice(0, 120)) }
      : cur.spec;
    return this.write(id, {
      kind: "saved",
      spec,
      folder: cleanFolder(opts.folder) ?? cur.folder ?? null,
      savedAt: cur.savedAt ?? new Date().toISOString(),
    });
  }

  /** Your own edits to a workspace: its name, description, and folder. */
  async edit(
    id: string,
    patch: { title?: string; description?: string; folder?: string | null },
  ): Promise<WorkspaceView> {
    const cur = await this.get(id);
    const spec = { ...cur.spec };
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new InvalidRequestError("A working file needs a name.");
      spec.title = redactTranscript(patch.title.trim().slice(0, 120));
    }
    if (patch.description !== undefined) {
      const d = redactTranscript(patch.description.trim().slice(0, 1000));
      if (d) spec.description = d;
      else delete spec.description;
    }
    return this.write(id, {
      spec,
      ...(patch.folder !== undefined
        ? { folder: cleanFolder(patch.folder ?? undefined) ?? null }
        : {}),
    });
  }

  /**
   * Removes the workspace and its working data only. Never files, services, or plans. A saved
   * working file is only deleted when that is asked for on purpose (closing it keeps it).
   */
  async remove(id: string, opts: { saved?: boolean } = {}): Promise<void> {
    const cur = await this.get(id);
    if (cur.kind === "saved" && !opts.saved)
      throw new InvalidRequestError(
        "This is a saved working file: closing it keeps it. Delete it from Saved work if you mean to.",
      );
    await this.db.delete(t.workspaces).where(eq(t.workspaces.id, id));
  }

  /**
   * Saves what the workspace found as a note in Memory (reference for you and Ember).
   * A copy: the workspace itself is unchanged.
   */
  async saveNote(id: string, memory: Memory, opts: { title?: string } = {}) {
    const v = await this.get(id);
    const title = (opts.title?.trim() || v.spec.title).slice(0, 160);
    return memory.create(
      {
        kind: "note",
        title,
        body: noteBody(v),
        basis: "documented",
        links: [{ label: `Workspace: ${v.spec.title}`, ref: `workspace:${v.id}` }],
      },
      { source: "you" },
    );
  }

  /** Temporary workspaces nobody touched for WORKSPACE_KEEP_DAYS. Saved ones are kept. */
  async prune(now = Date.now()): Promise<number> {
    const before = new Date(now - WORKSPACE_KEEP_DAYS * 86_400_000).toISOString();
    const stale = await this.db
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(and(eq(t.workspaces.kind, "temporary"), lt(t.workspaces.updatedAt, before)));
    for (const s of stale) await this.db.delete(t.workspaces).where(eq(t.workspaces.id, s.id));
    return stale.length;
  }

  private async write(id: string, set: Partial<Row>): Promise<WorkspaceView> {
    await this.db
      .update(t.workspaces)
      .set({ ...set, updatedAt: new Date().toISOString() })
      .where(eq(t.workspaces.id, id));
    return this.get(id);
  }
}

/** What a submission says in the conversation: counts, and the exact decisions when they fit. */
export function submissionMessage(v: WorkspaceView): string {
  const s = v.submission;
  if (!s) throw new InvalidRequestError("Nothing submitted yet.");
  const names = new Map((v.spec.choices ?? []).map((c) => [c.value, c.label]));
  const counts = Object.entries(s.counts)
    .map(([k, n]) => `${names.get(k) ?? k} ${n}`)
    .join(", ");
  const head = `Submitted the workspace "${v.spec.title}" (workspace ${v.id}): ${counts || "nothing chosen"}${s.undecided ? `, ${s.undecided} undecided` : ""}.`;
  const body = Object.entries(s.decisions)
    .map(([id, c]) => `- ${id}: ${names.get(c) ?? c}`)
    .join("\n");
  // A plan made from an earlier submission does not include these decisions.
  const earlier = v.plans?.find(
    (p) =>
      (p.status === "awaiting-approval" || p.status === "running") && p.snapshotId !== s.snapshotId,
  );
  const note = earlier
    ? ` Note: plan "${earlier.title}" (job ${earlier.jobId.slice(0, 8)}, ${earlier.status === "running" ? "already running" : "waiting for my approval"}) was made from my earlier submission at ${earlier.snapshotAt.slice(11, 16)} UTC and does not reflect these decisions. ${earlier.status === "running" ? "It is not changed. Items it has not reached yet that I changed to Keep will be skipped; items already done or in progress are not affected (a Keep change cannot undo them)." : "Tell me that, and offer to prepare a replacement plan for these decisions (making it replaces the waiting one)."}`
    : "";
  const tail = `Continue the task from these decisions; to act on them, propose a plan with propose_workspace_plan.${note} Submitting is not approval: anything that deletes or changes something still goes into a plan for my approval.`;
  return head.length + body.length + tail.length < 3800
    ? `${head}\n${body}\n${tail}`
    : `${head} The full list is too long for a message: read it with workspace_read. ${tail}`;
}

function cleanFolder(folder: string | undefined): string | undefined {
  const f = folder?.trim().replace(/\s+/g, " ").slice(0, 60);
  return f ? redactTranscript(f) : undefined;
}

const NOTE_ROWS = 300;

/** Sizes the way the app shows them (1 GB = 1024^3 bytes). */
function size(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return u === 0 ? `${n} bytes` : `${n.toFixed(1)} ${units[u]}`;
}

/** A workspace as reference text: what it was for, the counts, and the items with choices. */
export function noteBody(v: WorkspaceView): string {
  const chosen = effective(v.spec, v.selections);
  const names = new Map((v.spec.choices ?? []).map((c) => [c.value, c.label]));
  const cols = v.spec.columns;
  const esc = (x: unknown) =>
    String(x ?? "")
      .replace(/\|/g, "/")
      .replace(/\n/g, " ");
  const lines: string[] = [];
  if (v.spec.description) lines.push(v.spec.description, "");
  const counts: Record<string, number> = {};
  for (const c of Object.values(chosen)) counts[c] = (counts[c] ?? 0) + 1;
  lines.push(
    `${v.spec.items.length} items` +
      (v.spec.choices?.length
        ? `: ${
            Object.entries(counts)
              .map(([k, n]) => `${names.get(k) ?? k} ${n}`)
              .join(", ") || "nothing chosen"
          }, ${v.spec.items.length - Object.keys(chosen).length} undecided`
        : "") +
      (v.submission ? `. Submitted ${v.submission.at.slice(0, 16).replace("T", " ")} UTC.` : "."),
    "",
  );
  const header = [...cols.map((c) => c.label), ...(v.spec.choices?.length ? ["Choice"] : [])];
  lines.push(`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`);
  for (const i of v.spec.items.slice(0, NOTE_ROWS)) {
    const cells = cols.map((c) => {
      const x = i.values[c.key];
      return c.kind === "bytes" && typeof x === "number" ? size(x) : esc(x);
    });
    if (v.spec.choices?.length) cells.push(esc(names.get(chosen[i.id] ?? "") ?? ""));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (v.spec.items.length > NOTE_ROWS)
    lines.push("", `(${v.spec.items.length - NOTE_ROWS} more items are in the workspace.)`);
  return redactTranscript(lines.join("\n")).slice(0, 60_000);
}
