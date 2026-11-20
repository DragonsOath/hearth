import type {
  AppIssue,
  AppReport,
  PaperlessDashboard,
  PaperlessDoc,
  PaperlessLabel,
  PaperlessTask,
} from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Paperless-ngx, through its REST API with an API token from the vault (Authorization: Token).
 * Checked against a throwaway paperlessngx/paperless-ngx 3.4.2.
 *
 * Hearth asks for API version 9, which Paperless-ngx 2.x and 3.x both answer, so one set of field
 * names works on both (3.x renamed its task fields in version 10). Hearth reads titles, never a
 * document's text, and never passes on the Redis or database addresses Paperless reports: those can
 * hold passwords. The token goes only in the Authorization header and never leaves this file.
 */

export class PaperlessError extends Error {}

const API_VERSION = 9;

export async function pl<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        Authorization: `Token ${key}`,
        Accept: `application/json; version=${API_VERSION}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Paperless-ngx did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401)
    throw new AppKeyError("Paperless-ngx refused the API token. Check the token in the vault.");
  if (res.status === 403)
    throw new AppKeyError(
      "Paperless-ngx says this token's user may not do that. Use an administrator's token.",
    );
  if (!res.ok) {
    const text = (await res.text?.().catch(() => "")) ?? "";
    throw new PaperlessError(
      `Paperless-ngx refused ${method} ${path.split("?")[0]}: ${cleanMessage(text) || `answer ${res.status}`}.`,
    );
  }
  // A delete answers 204 with no body.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A message without addresses (a Redis or database address can hold a password). */
export const cleanMessage = (raw?: string | null) =>
  redactLine(String(raw ?? ""))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "(address)")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

interface RawStatus {
  pngx_version?: string;
  storage?: { total?: number; available?: number };
  database?: { status?: string; error?: string | null };
  tasks?: {
    redis_status?: string;
    redis_error?: string | null;
    celery_status?: string;
    celery_error?: string | null;
    index_status?: string;
    index_error?: string | null;
    index_last_modified?: string | null;
    classifier_status?: string;
    classifier_error?: string | null;
    classifier_last_trained?: string | null;
    sanity_check_status?: string;
    sanity_check_error?: string | null;
    sanity_check_last_run?: string | null;
  };
}

interface RawStats {
  documents_total?: number;
  documents_inbox?: number | null;
  inbox_tags?: number[] | null;
  inbox_tag?: number | null;
  document_file_type_counts?: { mime_type: string; mime_type_count: number }[];
}

interface RawLabel {
  id: number;
  name: string;
  document_count?: number;
  color?: string;
  is_inbox_tag?: boolean;
}

export interface RawDoc {
  id: number;
  title: string;
  correspondent?: number | null;
  document_type?: number | null;
  tags?: number[];
  created?: string;
  added?: string;
  original_file_name?: string;
  deleted_at?: string | null;
}

export interface RawTask {
  id: number;
  task_name?: string | null;
  task_file_name?: string | null;
  status?: string;
  date_created?: string;
  date_done?: string | null;
  result?: string | null;
  acknowledged?: boolean;
  related_document?: number | string | null;
}

type Page<T> = { count?: number; results?: T[] };

const GB = 1024 ** 3;
const gb = (n?: number) => (typeof n === "number" ? Math.round((n / GB) * 10) / 10 : undefined);

const TASK_STATUS: Record<string, PaperlessTask["status"]> = {
  PENDING: "waiting",
  RECEIVED: "waiting",
  STARTED: "running",
  SUCCESS: "done",
  FAILURE: "failed",
  REVOKED: "failed",
};

const TASK_NAMES: Record<string, string> = {
  consume_file: "Import",
  train_classifier: "Train the classifier",
  sanity_check: "Sanity check",
  index_optimize: "Optimize the search index",
  mail_fetch: "Fetch mail",
  empty_trash: "Empty the trash",
  check_workflows: "Check workflows",
  bulk_update: "Bulk edit",
  reprocess_document: "Process again",
};

export function toTask(t: RawTask): PaperlessTask {
  const name = t.task_name ?? "task";
  const doc = Number(t.related_document);
  return {
    id: t.id,
    name: TASK_NAMES[name] ?? name.replace(/_/g, " "),
    ...(t.task_file_name ? { file: t.task_file_name } : {}),
    status: TASK_STATUS[(t.status ?? "").toUpperCase()] ?? "waiting",
    ...(t.date_done || t.date_created ? { at: (t.date_done ?? t.date_created)! } : {}),
    ...(t.result ? { result: cleanMessage(t.result) } : {}),
    ...(Number.isFinite(doc) && doc > 0 ? { documentId: doc } : {}),
  };
}

const toLabel = (l: RawLabel): PaperlessLabel => ({
  id: l.id,
  name: l.name,
  count: l.document_count ?? 0,
  ...(l.color ? { color: l.color } : {}),
  ...(l.is_inbox_tag ? { inbox: true } : {}),
});

export function toDoc(
  d: RawDoc,
  correspondents: PaperlessLabel[],
  types: PaperlessLabel[],
): PaperlessDoc {
  const c = correspondents.find((x) => x.id === d.correspondent);
  const t = types.find((x) => x.id === d.document_type);
  return {
    id: d.id,
    title: d.title,
    ...(c ? { correspondent: c.name, correspondentId: c.id } : {}),
    ...(t ? { type: t.name, typeId: t.id } : {}),
    tags: d.tags ?? [],
    ...(d.created ? { created: d.created.slice(0, 10) } : {}),
    ...(d.added ? { added: d.added } : {}),
    ...(d.original_file_name ? { fileName: d.original_file_name } : {}),
    ...(d.deleted_at ? { deletedAt: d.deleted_at } : {}),
  };
}

const DOC_FIELDS = "id,title,correspondent,document_type,tags,created,added,original_file_name";
const labels = (fetchImpl: Fetch, base: string, key: string, kind: string) =>
  pl<Page<RawLabel>>(fetchImpl, base, key, "GET", `/api/${kind}/?page_size=1000`).then((p) =>
    (p.results ?? [])
      .map(toLabel)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  );

/** The tags, correspondents and document types, for names and the panel's choices. */
export async function paperlessLabels(fetchImpl: Fetch, base: string, key: string) {
  const [tags, correspondents, types] = await Promise.all([
    labels(fetchImpl, base, key, "tags"),
    labels(fetchImpl, base, key, "correspondents"),
    labels(fetchImpl, base, key, "document_types"),
  ]);
  return { tags, correspondents, types };
}

/** The tasks Paperless has not had dismissed, newest first. */
export const openTasks = (fetchImpl: Fetch, base: string, key: string) =>
  pl<RawTask[] | Page<RawTask>>(fetchImpl, base, key, "GET", "/api/tasks/?acknowledged=false").then(
    (r) => (Array.isArray(r) ? r : (r.results ?? [])),
  );

function health(st: RawStatus): PaperlessDashboard["health"] {
  const t = st.tasks ?? {};
  const parts: [
    string,
    string | undefined,
    string | null | undefined,
    string | null | undefined,
  ][] = [
    ["Database", st.database?.status, st.database?.error, undefined],
    ["Redis", t.redis_status, t.redis_error, undefined],
    ["Workers", t.celery_status, t.celery_error, undefined],
    ["Search index", t.index_status, t.index_error, t.index_last_modified],
    ["Classifier", t.classifier_status, t.classifier_error, t.classifier_last_trained],
    ["Sanity check", t.sanity_check_status, t.sanity_check_error, t.sanity_check_last_run],
  ];
  const out: PaperlessDashboard["health"] = [];
  for (const [part, status, error, at] of parts) {
    const s = (status ?? "").toUpperCase();
    if (!s || s === "DISABLED") continue;
    const level = s === "OK" ? "ok" : s === "WARNING" ? "warning" : "error";
    out.push({
      part,
      status: level,
      ...(level !== "ok" && error ? { message: cleanMessage(error) } : {}),
      ...(at ? { at } : {}),
    });
  }
  return out;
}

/** Everything the panel's Overview and Inbox show. */
export async function paperlessDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<PaperlessDashboard> {
  const [st, stats, names, tasks, trash, remote] = await Promise.all([
    pl<RawStatus>(fetchImpl, base, key, "GET", "/api/status/").catch((e: unknown) => {
      // The status view needs an administrator; the rest still reads without it.
      if (e instanceof AppKeyError && /may not/.test(e.message)) return {} as RawStatus;
      throw e;
    }),
    pl<RawStats>(fetchImpl, base, key, "GET", "/api/statistics/"),
    paperlessLabels(fetchImpl, base, key),
    openTasks(fetchImpl, base, key),
    pl<Page<RawDoc>>(fetchImpl, base, key, "GET", "/api/trash/?page_size=1").catch(() => ({
      count: 0,
    })),
    pl<{ version?: string; update_available?: boolean }>(
      fetchImpl,
      base,
      key,
      "GET",
      "/api/remote_version/",
    ).catch(() => ({}) as { version?: string; update_available?: boolean }),
  ]);
  const inboxTags =
    stats.inbox_tags ??
    (stats.inbox_tag ? [stats.inbox_tag] : names.tags.filter((t) => t.inbox).map((t) => t.id));
  const inbox = inboxTags.length
    ? await pl<Page<RawDoc>>(
        fetchImpl,
        base,
        key,
        "GET",
        `/api/documents/?tags__id__in=${inboxTags.join(",")}&ordering=-added&page_size=50&fields=${DOC_FIELDS}`,
      )
    : { count: 0, results: [] };
  const all = tasks.map(toTask);
  return {
    app: "paperless",
    ...(st.pngx_version ? { version: st.pngx_version } : {}),
    ...(remote.update_available && remote.version ? { updateTo: remote.version } : {}),
    documents: stats.documents_total ?? 0,
    inboxCount: stats.documents_inbox ?? inbox.count ?? 0,
    inbox: (inbox.results ?? []).map((d) => toDoc(d, names.correspondents, names.types)),
    inboxTags,
    waiting: all.filter((t) => t.status === "waiting" || t.status === "running"),
    failed: all.filter((t) => t.status === "failed"),
    ...(gb(st.storage?.available) !== undefined ? { freeGb: gb(st.storage?.available)! } : {}),
    ...(gb(st.storage?.total) !== undefined ? { totalGb: gb(st.storage?.total)! } : {}),
    health: health(st),
    tags: names.tags,
    correspondents: names.correspondents,
    types: names.types,
    fileTypes: (stats.document_file_type_counts ?? []).map((f) => ({
      type: f.mime_type,
      count: f.mime_type_count,
    })),
    trashCount: trash.count ?? 0,
  };
}

/** Documents for the Documents tab: a full-text search, or the newest; or the trash. */
export async function paperlessDocuments(
  fetchImpl: Fetch,
  base: string,
  key: string,
  want: { query?: string; tagId?: number; page?: number; trash?: boolean },
): Promise<{ total: number; items: PaperlessDoc[] }> {
  const page = Math.max(1, Math.floor(want.page ?? 1));
  const q = new URLSearchParams({ page: String(page), page_size: "25" });
  if (!want.trash) {
    q.set("fields", DOC_FIELDS);
    if (want.query?.trim()) q.set("query", want.query.trim().slice(0, 200));
    else q.set("ordering", "-added");
    if (want.tagId) q.set("tags__id__all", String(want.tagId));
  }
  const [r, names] = await Promise.all([
    pl<Page<RawDoc>>(
      fetchImpl,
      base,
      key,
      "GET",
      `/api/${want.trash ? "trash" : "documents"}/?${q.toString()}`,
    ),
    paperlessLabels(fetchImpl, base, key),
  ]);
  return {
    total: r.count ?? 0,
    // Only these fields: the trash answers with each document's whole text.
    items: (r.results ?? []).map((d) =>
      toDoc(
        {
          id: d.id,
          title: d.title,
          correspondent: d.correspondent ?? null,
          document_type: d.document_type ?? null,
          tags: d.tags ?? [],
          ...(d.created ? { created: d.created } : {}),
          ...(d.added ? { added: d.added } : {}),
          ...(d.original_file_name ? { original_file_name: d.original_file_name } : {}),
          ...(d.deleted_at ? { deleted_at: d.deleted_at } : {}),
        },
        names.correspondents,
        names.types,
      ),
    ),
  };
}

const FREE_WARN_GB = 5;

/** The health check: failed imports, Paperless's own errors, space. */
export async function readPaperless(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await paperlessDashboard(fetchImpl, base, key);
  const issues: AppIssue[] = [];
  for (const h of d.health.filter((x) => x.status === "error"))
    issues.push({
      level: "error",
      key: `health:${h.part}`,
      text: `Paperless-ngx's ${h.part.toLowerCase()} reports a problem${h.message ? `: ${h.message}` : "."}`,
    });
  const imports = d.failed.filter((t) => t.name === "Import");
  if (imports.length)
    issues.push({
      level: "warning",
      key: "imports-failed",
      text: `Paperless-ngx could not import ${imports.length === 1 ? (imports[0]!.file ?? "a file") : `${imports.length} files`}${imports.length === 1 && imports[0]!.result ? `: ${imports[0]!.result}` : "."}`,
    });
  if (d.freeGb !== undefined && d.freeGb < FREE_WARN_GB)
    issues.push({ level: "warning", key: "space", text: `Paperless-ngx has ${d.freeGb} GB free.` });
  return {
    app: "paperless",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Documents", value: String(d.documents) },
      { label: "In the inbox", value: String(d.inboxCount) },
      ...(d.waiting.length ? [{ label: "Importing", value: String(d.waiting.length) }] : []),
      ...(d.failed.length ? [{ label: "Failed", value: String(d.failed.length) }] : []),
      ...(d.freeGb !== undefined ? [{ label: "Free space", value: `${d.freeGb} GB` }] : []),
    ],
  };
}
