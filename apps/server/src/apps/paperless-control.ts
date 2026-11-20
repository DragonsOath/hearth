import type { PaperlessDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import {
  paperlessDashboard,
  paperlessLabels,
  PaperlessError,
  openTasks,
  pl,
  type RawDoc,
} from "./paperless";

/**
 * Changes in Paperless-ngx, each a plan the owner approves (app-paperless-control, params.op):
 * mark inbox documents done (take off their inbox tags), add or take off a tag, set the
 * correspondent or document type, make a tag, move documents to the trash or bring them back,
 * process documents again, dismiss failed imports, and run Paperless's own maintenance (sanity
 * check, train the classifier, optimize the search index, fetch mail). Each document change is
 * read back from Paperless, which applies bulk edits a moment later, and undone by putting the old
 * values back. Deleting for good (emptying the trash) stays in Paperless.
 */

export const PAPERLESS_OPS = [
  "inbox-done",
  "tag-add",
  "tag-remove",
  "correspondent",
  "type",
  "tag-create",
  "trash",
  "restore",
  "reprocess",
  "dismiss",
  "run",
] as const;
export type PaperlessOp = (typeof PAPERLESS_OPS)[number];

export const PAPERLESS_TASKS = {
  sanity_check: "Run the sanity check (finds missing or damaged files)",
  train_classifier: "Train the classifier (learns tags, correspondents and types from your edits)",
  index_optimize: "Optimize the search index",
  mail_fetch: "Fetch mail now",
} as const;
type TaskName = keyof typeof PAPERLESS_TASKS;

const MAX_DOCS = 100;
type Service = { id: string; name: string; localUrl: string };

/** Document ids from "1,2,3" (at most 100). */
export function docIds(raw: unknown): number[] {
  const ids = [
    ...new Set(
      String(raw ?? "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number),
    ),
  ];
  if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0))
    throw new Error("Say which documents, by their ids.");
  if (ids.length > MAX_DOCS) throw new Error(`At most ${MAX_DOCS} documents in one step.`);
  return ids;
}

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

export class PaperlessOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as PaperlessOp;
    if (!PAPERLESS_OPS.includes(op))
      throw new Error(`Say what to do: ${PAPERLESS_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Paperless-ngx", "read", async (key) => {
      const d = await paperlessDashboard(this.fetchImpl, service.localUrl, key);
      const p = params ?? {};
      const docs =
        op === "tag-create" || op === "run" || op === "dismiss"
          ? []
          : await readDocs(
              this.fetchImpl,
              service.localUrl,
              key,
              docIds(p.documents),
              op === "restore",
            );
      return planPaperless(d, docs, service.name, op, p, base);
    });
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Paperless-ngx", "change", (key) =>
        runPaperless(this.fetchImpl, service.localUrl, key, p),
      );
    } catch (error) {
      if (!(error instanceof PaperlessError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, documents: p.documents ?? null, taskIds: p.taskIds ?? null },
    });
    return out;
  }

  /** Puts the old values back. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op) as PaperlessOp;
    const back: Partial<Record<PaperlessOp, PaperlessOp>> = {
      "tag-add": "tag-remove",
      "tag-remove": "tag-add",
      trash: "restore",
      restore: "trash",
    };
    return this.use(service, "undo a change in Paperless-ngx", "change", async (key) => {
      if (back[op])
        return runPaperless(this.fetchImpl, service.localUrl, key, { ...p, op: back[op]! });
      if (op === "inbox-done" || op === "correspondent" || op === "type")
        return putBack(this.fetchImpl, service.localUrl, key, p);
      if (op === "tag-create") {
        const tag = (await paperlessLabels(this.fetchImpl, service.localUrl, key)).tags.find(
          (t) => t.name === p.name,
        );
        if (!tag || tag.count > 0) return undefined;
        await pl(this.fetchImpl, service.localUrl, key, "DELETE", `/api/tags/${tag.id}/`);
        return { ok: true, result: `The tag ${tag.name} is removed again.` };
      }
      return undefined;
    });
  }
}

/** The documents a step names, as Paperless has them now (from the trash for a restore). */
export async function readDocs(
  fetchImpl: Fetch,
  base: string,
  key: string,
  ids: number[],
  trash = false,
): Promise<RawDoc[]> {
  if (trash) {
    const r = await pl<{ results?: RawDoc[] }>(
      fetchImpl,
      base,
      key,
      "GET",
      "/api/trash/?page_size=1000",
    );
    return (r.results ?? [])
      .filter((d) => ids.includes(d.id))
      .map((d) => ({ id: d.id, title: d.title, tags: d.tags ?? [] }));
  }
  const r = await pl<{ results?: RawDoc[] }>(
    fetchImpl,
    base,
    key,
    "GET",
    `/api/documents/?id__in=${ids.join(",")}&page_size=${MAX_DOCS}&fields=id,title,correspondent,document_type,tags`,
  );
  return r.results ?? [];
}

const what = (docs: RawDoc[]) =>
  docs.length === 1 ? `"${docs[0]!.title}"` : plural(docs.length, "document");

export function planPaperless(
  d: PaperlessDashboard,
  docs: RawDoc[],
  name: string,
  op: PaperlessOp,
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams,
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: label, settings: [setting] },
  });

  if (op === "run") {
    const task = String(p.task ?? "") as TaskName;
    if (!PAPERLESS_TASKS[task])
      throw new Error(`Choose a task: ${Object.keys(PAPERLESS_TASKS).join(", ")}.`);
    return step(
      `${PAPERLESS_TASKS[task]} in ${name}`,
      { name: "Maintenance", before: "idle", after: task.replace(/_/g, " ") },
      { task },
    );
  }

  if (op === "dismiss") {
    const ids = String(p.taskIds ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const tasks = d.failed.filter((t) => ids.includes(t.id));
    if (!tasks.length) throw new Error(`${name} has no such failed task: read the panel again.`);
    return step(
      `Dismiss ${tasks.length === 1 ? `the failed ${tasks[0]!.name.toLowerCase()}${tasks[0]!.file ? ` of ${tasks[0]!.file}` : ""}` : plural(tasks.length, "failed task")} in ${name} (it only leaves the list)`,
      {
        name: "Failed tasks",
        before: `${d.failed.length} listed`,
        after: `${d.failed.length - tasks.length} listed`,
      },
      { taskIds: tasks.map((t) => t.id).join(",") },
    );
  }

  if (op === "tag-create") {
    const tag = String(p.name ?? "").trim();
    if (!tag || tag.length > 128) throw new Error("Give the tag a name.");
    if (d.tags.some((t) => t.name.toLowerCase() === tag.toLowerCase()))
      throw new Error(`${name} already has a tag "${tag}".`);
    const inbox = p.inbox === true || p.inbox === "true";
    return step(
      `Make a tag "${tag}" in ${name}${inbox ? " that marks new documents as inbox" : ""}`,
      { name: "Tags", before: `${d.tags.length}`, after: `${d.tags.length + 1}` },
      { name: tag, inbox },
    );
  }

  const ids = docIds(p.documents);
  const missing = ids.filter((id) => !docs.some((x) => x.id === id));
  if (missing.length)
    throw new Error(
      `${name} has no document ${missing.join(", ")}${op === "restore" ? " in its trash" : ""}: read the panel again.`,
    );
  const documents = ids.join(",");

  if (op === "inbox-done") {
    const had = docs.filter((x) => (x.tags ?? []).some((t) => d.inboxTags.includes(t)));
    if (!had.length)
      throw new Error(`${what(docs)} ${docs.length === 1 ? "is" : "are"} not in the inbox.`);
    const before = Object.fromEntries(
      had.map((x) => [x.id, (x.tags ?? []).filter((t) => d.inboxTags.includes(t))]),
    );
    return step(
      `Mark ${what(had)} done in ${name} (out of the inbox)`,
      {
        name: "Inbox",
        before: `${d.inboxCount}`,
        after: `${Math.max(0, d.inboxCount - had.length)}`,
      },
      { documents: had.map((x) => x.id).join(","), before: JSON.stringify(before) },
    );
  }

  if (op === "tag-add" || op === "tag-remove") {
    const tag = d.tags.find((t) => t.id === Number(p.tagId));
    if (!tag) throw new Error(`${name} has no such tag: read the panel again.`);
    const add = op === "tag-add";
    const affected = docs.filter((x) => (x.tags ?? []).includes(tag.id) !== add);
    if (!affected.length)
      throw new Error(`${what(docs)} ${add ? "already" : "do not"} have the tag ${tag.name}.`);
    return step(
      `${add ? "Tag" : "Take the tag"} ${tag.name} ${add ? "on" : "off"} ${what(affected)} in ${name}`,
      {
        name: tag.name,
        before: add ? "not tagged" : "tagged",
        after: add ? "tagged" : "not tagged",
      },
      { documents: affected.map((x) => x.id).join(","), tagId: tag.id },
    );
  }

  if (op === "correspondent" || op === "type") {
    const list = op === "correspondent" ? d.correspondents : d.types;
    const field = op === "correspondent" ? "correspondent" : "document_type";
    const word = op === "correspondent" ? "correspondent" : "document type";
    const raw = String(p.value ?? "");
    const to = raw === "" || raw === "0" ? undefined : list.find((x) => x.id === Number(raw));
    if (raw !== "" && raw !== "0" && !to)
      throw new Error(`${name} has no such ${word}. Make new ones in Paperless-ngx.`);
    const affected = docs.filter((x) => (x[field] ?? null) !== (to?.id ?? null));
    if (!affected.length)
      throw new Error(`${what(docs)} already ${to ? `has ${to.name}` : `has no ${word}`}.`);
    const nameOf = (id?: number | null) => list.find((x) => x.id === id)?.name ?? "none";
    return step(
      to
        ? `Set the ${word} of ${what(affected)} to ${to.name} in ${name}`
        : `Clear the ${word} of ${what(affected)} in ${name}`,
      {
        name: word,
        before: [...new Set(affected.map((x) => nameOf(x[field])))].join(", "),
        after: to?.name ?? "none",
      },
      {
        documents: affected.map((x) => x.id).join(","),
        value: to ? String(to.id) : "",
        before: JSON.stringify(Object.fromEntries(affected.map((x) => [x.id, x[field] ?? null]))),
      },
    );
  }

  if (op === "trash")
    return step(
      `Move ${what(docs)} to ${name}'s trash (Paperless keeps it there until the trash is emptied; undo brings it back)`,
      { name: "Documents", before: "in the archive", after: "in the trash" },
      { documents },
    );
  if (op === "restore")
    return step(
      `Bring ${what(docs)} back from ${name}'s trash`,
      { name: "Documents", before: "in the trash", after: "in the archive" },
      { documents },
    );
  // reprocess
  return step(
    `Process ${what(docs)} again in ${name} (reads the text again and makes a new archive copy; tags and dates stay)`,
    { name: "Documents", before: "processed", after: "processed again" },
    { documents },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads until the check passes, or about 10 seconds: Paperless applies bulk edits in its worker. */
async function readBack<T>(read: () => Promise<T>, ok: (v: T) => boolean, waitMs = 10_000) {
  const until = Date.now() + waitMs;
  let v = await read();
  while (!ok(v) && Date.now() < until) {
    await sleep(500);
    v = await read();
  }
  return v;
}

const bulk = (
  fetchImpl: Fetch,
  base: string,
  key: string,
  documents: number[],
  method: string,
  parameters: Record<string, unknown> = {},
) =>
  pl<{ result?: string }>(fetchImpl, base, key, "POST", "/api/documents/bulk_edit/", {
    documents,
    method,
    parameters,
  });

export async function runPaperless(
  fetchImpl: Fetch,
  base: string,
  key: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as PaperlessOp;
  const done = (ok: boolean, yes: string, no: string): StepOutcome => ({
    ok,
    verified: ok,
    result: ok ? yes : no,
  });

  if (op === "run") {
    const task = String(p.task);
    if (!(task in PAPERLESS_TASKS)) return { ok: false, result: "Not a task Hearth runs." };
    // 3.x names it task_type, 2.x task_name: send both.
    const r = await pl<{ task_id?: string }>(fetchImpl, base, key, "POST", "/api/tasks/run/", {
      task_type: task,
      task_name: task,
    });
    return {
      ok: Boolean(r.task_id),
      result: r.task_id
        ? `Paperless-ngx started it. It shows under its tasks while it runs.`
        : "Paperless-ngx did not start it.",
    };
  }

  if (op === "dismiss") {
    const ids = String(p.taskIds ?? "")
      .split(",")
      .map(Number)
      .filter((n) => n > 0);
    await pl(fetchImpl, base, key, "POST", "/api/tasks/acknowledge/", { tasks: ids });
    const left = (await openTasks(fetchImpl, base, key)).filter((t) => ids.includes(t.id));
    return done(left.length === 0, "Dismissed.", "Paperless-ngx still lists it.");
  }

  if (op === "tag-create") {
    const tag = String(p.name);
    const tags = (await paperlessLabels(fetchImpl, base, key)).tags;
    if (tags.some((t) => t.name.toLowerCase() === tag.toLowerCase()))
      return { ok: false, stale: true, result: `A tag "${tag}" exists already.` };
    await pl(fetchImpl, base, key, "POST", "/api/tags/", {
      name: tag,
      is_inbox_tag: p.inbox === true || p.inbox === "true",
      // Hearth makes tags by hand only: Paperless's matching stays off until set in Paperless.
      matching_algorithm: 0,
    });
    const made = (await paperlessLabels(fetchImpl, base, key)).tags.find((t) => t.name === tag);
    return done(Boolean(made), `The tag ${tag} is made.`, "The new tag does not read back.");
  }

  const ids = docIds(p.documents);

  if (op === "restore") {
    const inTrash = await readDocs(fetchImpl, base, key, ids, true);
    if (!inTrash.length)
      return { ok: false, stale: true, result: "Those documents are no longer in the trash." };
    await pl(fetchImpl, base, key, "POST", "/api/trash/", {
      documents: inTrash.map((x) => x.id),
      action: "restore",
    });
    const back = await readBack(
      () => readDocs(fetchImpl, base, key, ids),
      (v) => v.length >= inTrash.length,
    );
    return done(
      back.length >= inTrash.length,
      `${what(inTrash)} ${inTrash.length === 1 ? "is" : "are"} back.`,
      "Not every document reads back out of the trash.",
    );
  }

  const now = await readDocs(fetchImpl, base, key, ids);
  if (!now.length)
    return { ok: false, stale: true, result: "Those documents are gone from Paperless-ngx." };
  const read = () => readDocs(fetchImpl, base, key, ids);

  if (op === "trash") {
    await bulk(fetchImpl, base, key, ids, "delete");
    const left = await readBack(read, (v) => v.length === 0);
    return done(
      left.length === 0,
      `${what(now)} ${now.length === 1 ? "is" : "are"} in the trash.`,
      `${plural(left.length, "document")} still read back.`,
    );
  }

  if (op === "reprocess") {
    await bulk(fetchImpl, base, key, ids, "reprocess");
    return { ok: true, result: `Paperless-ngx is processing ${what(now)} again.` };
  }

  if (op === "inbox-done") {
    const before = JSON.parse(String(p.before ?? "{}")) as Record<string, number[]>;
    const inboxTags = [...new Set(Object.values(before).flat())];
    for (const tag of inboxTags)
      await bulk(
        fetchImpl,
        base,
        key,
        ids.filter((id) => (before[id] ?? []).includes(tag)),
        "remove_tag",
        { tag },
      );
    const after = await readBack(read, (v) =>
      v.every((x) => !(x.tags ?? []).some((t) => inboxTags.includes(t))),
    );
    const ok = after.every((x) => !(x.tags ?? []).some((t) => inboxTags.includes(t)));
    return done(
      ok,
      `${what(now)} ${now.length === 1 ? "is" : "are"} out of the inbox.`,
      "The inbox tag still reads back.",
    );
  }

  if (op === "tag-add" || op === "tag-remove") {
    const tag = Number(p.tagId);
    const add = op === "tag-add";
    if (now.every((x) => (x.tags ?? []).includes(tag) === add))
      return {
        ok: false,
        stale: true,
        result: `They ${add ? "already have" : "no longer have"} that tag.`,
      };
    await bulk(fetchImpl, base, key, ids, add ? "add_tag" : "remove_tag", { tag });
    const after = await readBack(read, (v) => v.every((x) => (x.tags ?? []).includes(tag) === add));
    return done(
      after.every((x) => (x.tags ?? []).includes(tag) === add),
      add ? `Tagged ${what(now)}.` : `The tag is off ${what(now)}.`,
      "The tags do not read back as planned.",
    );
  }

  // correspondent or type
  const field = op === "correspondent" ? "correspondent" : "document_type";
  const value = String(p.value ?? "") === "" ? null : Number(p.value);
  await bulk(
    fetchImpl,
    base,
    key,
    ids,
    op === "correspondent" ? "set_correspondent" : "set_document_type",
    {
      [field]: value,
    },
  );
  const after = await readBack(read, (v) => v.every((x) => (x[field] ?? null) === value));
  return done(
    after.every((x) => (x[field] ?? null) === value),
    `${what(now)} ${now.length === 1 ? "has" : "have"} the new ${op === "correspondent" ? "correspondent" : "document type"}.`,
    "It does not read back as planned.",
  );
}

/** Undo for inbox-done, correspondent and type: each document gets its old value again. */
async function putBack(
  fetchImpl: Fetch,
  base: string,
  key: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as PaperlessOp;
  const before = JSON.parse(String(p.before ?? "{}")) as Record<string, unknown>;
  const ids = Object.keys(before).map(Number);
  if (op === "inbox-done") {
    const tags = [...new Set(Object.values(before as Record<string, number[]>).flat())];
    for (const tag of tags)
      await bulk(
        fetchImpl,
        base,
        key,
        ids.filter((id) => ((before[id] as number[]) ?? []).includes(tag)),
        "add_tag",
        { tag },
      );
    return { ok: true, result: "They are back in the inbox." };
  }
  const field = op === "correspondent" ? "correspondent" : "document_type";
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const v = JSON.stringify(before[id] ?? null);
    groups.set(v, [...(groups.get(v) ?? []), id]);
  }
  for (const [v, docs] of groups)
    await bulk(
      fetchImpl,
      base,
      key,
      docs,
      op === "correspondent" ? "set_correspondent" : "set_document_type",
      {
        [field]: JSON.parse(v) as number | null,
      },
    );
  return {
    ok: true,
    result: `The old ${op === "correspondent" ? "correspondents" : "document types"} are back.`,
  };
}
