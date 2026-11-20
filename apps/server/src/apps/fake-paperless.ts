import type { Fetch } from "./http";

/**
 * A stand-in Paperless-ngx (port 8000) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering API version 9 as a throwaway paperlessngx/paperless-ngx 3.4.2 did: a token
 * starting "e2e-", an inbox tag with three new documents, two older ones, a failed import and one
 * waiting, the system status with a classifier warning, and the bulk edits, trash, tags and tasks
 * the panel uses. Its status reports a Redis address with a password (e2e-SECRET) and every
 * document has text: neither may reach the panel.
 */

export interface FakePaperless {
  fetch: Fetch;
  reset(): void;
}

interface Doc {
  id: number;
  title: string;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
  created: string;
  added: string;
  original_file_name: string;
  content: string;
  deleted_at: string | null;
}

interface Task {
  id: number;
  task_name: string;
  task_file_name: string | null;
  status: string;
  date_created: string;
  date_done: string | null;
  result: string | null;
  acknowledged: boolean;
  related_document: number | null;
}

interface Label {
  id: number;
  name: string;
  color?: string;
  is_inbox_tag?: boolean;
}

export function fakePaperless(): FakePaperless {
  let docs: Doc[] = [];
  let tasks: Task[] = [];
  let tags: Label[] = [];
  let correspondents: Label[] = [];
  let types: Label[] = [];
  let next = 100;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const reset = () => {
    const doc = (
      id: number,
      title: string,
      tagIds: number[],
      corr: number | null,
      type: number | null,
      addedMin: number,
    ): Doc => ({
      id,
      title,
      correspondent: corr,
      document_type: type,
      tags: tagIds,
      created: ago(addedMin + 60 * 24 * 3).slice(0, 10),
      added: ago(addedMin),
      original_file_name: `${title.toLowerCase().replace(/\W+/g, "-")}.pdf`,
      content: `e2e-SECRET text of ${title}`,
      deleted_at: null,
    });
    tags = [
      { id: 1, name: "Inbox", color: "#2a9d8f", is_inbox_tag: true },
      { id: 2, name: "Bills", color: "#e76f51" },
      { id: 3, name: "Tax 2026", color: "#264653" },
    ];
    correspondents = [
      { id: 1, name: "Acme Power" },
      { id: 2, name: "City Water" },
    ];
    types = [
      { id: 1, name: "Invoice" },
      { id: 2, name: "Letter" },
    ];
    docs = [
      doc(1, "Electricity bill November", [1], 1, null, 30),
      doc(2, "Water bill October", [1, 2], 2, 1, 90),
      doc(3, "Letter from the school", [1], null, null, 200),
      doc(4, "Car insurance renewal", [2], null, 2, 60 * 24 * 10),
      doc(5, "Tax return 2025", [3], null, null, 60 * 24 * 40),
    ];
    tasks = [
      {
        id: 11,
        task_name: "consume_file",
        task_file_name: "scan-0042.pdf",
        status: "FAILURE",
        date_created: ago(20),
        date_done: ago(19),
        result:
          "scan-0042.pdf: Error occurred while consuming document scan-0042.pdf: InputFileError: ",
        acknowledged: false,
        related_document: null,
      },
      {
        id: 12,
        task_name: "consume_file",
        task_file_name: "receipt-hardware-store.jpg",
        status: "STARTED",
        date_created: ago(1),
        date_done: null,
        result: null,
        acknowledged: false,
        related_document: null,
      },
      {
        id: 10,
        task_name: "consume_file",
        task_file_name: "electricity-bill-november.pdf",
        status: "SUCCESS",
        date_created: ago(31),
        date_done: ago(30),
        result: "Success. New document id 1 created",
        acknowledged: false,
        related_document: 1,
      },
    ];
    next = 100;
  };
  reset();

  const reply = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  const page = <T>(items: T[]) => ({
    count: items.length,
    next: null,
    previous: null,
    results: items,
  });
  const count = (field: "tags" | "correspondent" | "document_type", id: number) =>
    docs.filter((d) => !d.deleted_at && (field === "tags" ? d.tags.includes(id) : d[field] === id))
      .length;
  const live = () => docs.filter((d) => !d.deleted_at);
  const pick = (d: Doc, fields: string | null) => {
    if (!fields) return d;
    return Object.fromEntries(fields.split(",").map((f) => [f, d[f as keyof Doc]]));
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    const token = (init.headers.Authorization ?? "").replace(/^Token /, "");
    if (!token.startsWith("e2e-")) return reply(401, { detail: "Invalid token." });
    const body = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    const q = u.searchParams;

    if (path === "/api/status/")
      return reply(200, {
        pngx_version: "3.4.2",
        storage: { total: 500 * 1024 ** 3, available: 120 * 1024 ** 3 },
        database: {
          type: "postgresql",
          url: "postgres://paperless:e2e-SECRET@db/paperless",
          status: "OK",
          error: null,
        },
        tasks: {
          redis_url: "redis://:e2e-SECRET@broker:6379",
          redis_status: "OK",
          redis_error: null,
          celery_status: "OK",
          celery_error: null,
          index_status: "OK",
          index_error: null,
          index_last_modified: ago(30),
          classifier_status: "WARNING",
          classifier_error: "Classifier file does not exist (yet). Re-training may be pending.",
          classifier_last_trained: null,
          sanity_check_status: "OK",
          sanity_check_error: null,
          sanity_check_last_run: ago(60 * 20),
        },
      });
    if (path === "/api/statistics/")
      return reply(200, {
        documents_total: live().length,
        documents_inbox: live().filter((d) => d.tags.includes(1)).length,
        inbox_tag: 1,
        inbox_tags: tags.filter((t) => t.is_inbox_tag).map((t) => t.id),
        document_file_type_counts: [
          { mime_type: "application/pdf", mime_type_count: live().length - 1 },
          { mime_type: "image/jpeg", mime_type_count: 1 },
        ],
      });
    if (path === "/api/remote_version/")
      return reply(200, { version: "3.5.0", update_available: true });
    if (path === "/api/tags/" && method === "POST") {
      const t = {
        id: next++,
        name: String(body.name),
        color: "#a6cee3",
        is_inbox_tag: body.is_inbox_tag === true,
      };
      tags.push(t);
      return reply(201, t);
    }
    const tagDel = /^\/api\/tags\/(\d+)\/$/.exec(path);
    if (tagDel && method === "DELETE") {
      tags = tags.filter((t) => t.id !== Number(tagDel[1]));
      return reply(204, undefined);
    }
    if (path === "/api/tags/")
      return reply(200, page(tags.map((t) => ({ ...t, document_count: count("tags", t.id) }))));
    if (path === "/api/correspondents/")
      return reply(
        200,
        page(correspondents.map((c) => ({ ...c, document_count: count("correspondent", c.id) }))),
      );
    if (path === "/api/document_types/")
      return reply(
        200,
        page(types.map((c) => ({ ...c, document_count: count("document_type", c.id) }))),
      );
    if (path === "/api/tasks/")
      return reply(
        200,
        tasks.filter((t) => q.get("acknowledged") !== "false" || !t.acknowledged),
      );
    if (path === "/api/tasks/acknowledge/") {
      const ids = (body.tasks as number[]) ?? [];
      for (const t of tasks) if (ids.includes(t.id)) t.acknowledged = true;
      return reply(200, { result: ids.length });
    }
    if (path === "/api/tasks/run/") {
      if (!body.task_type) return reply(400, { task_type: ["This field is required."] });
      return reply(200, { task_id: "e2e-task" });
    }
    if (path === "/api/trash/" && method === "POST") {
      const ids = (body.documents as number[]) ?? [];
      for (const d of docs) if (ids.includes(d.id)) d.deleted_at = null;
      return reply(200, { result: "OK", doc_ids: ids });
    }
    if (path === "/api/trash/") return reply(200, page(docs.filter((d) => d.deleted_at)));
    if (path === "/api/documents/bulk_edit/") {
      const ids = (body.documents as number[]) ?? [];
      const p = (body.parameters ?? {}) as Record<string, unknown>;
      for (const d of docs.filter((x) => ids.includes(x.id))) {
        if (body.method === "add_tag" && !d.tags.includes(Number(p.tag)))
          d.tags.push(Number(p.tag));
        if (body.method === "remove_tag") d.tags = d.tags.filter((t) => t !== Number(p.tag));
        if (body.method === "set_correspondent")
          d.correspondent = (p.correspondent as number) ?? null;
        if (body.method === "set_document_type")
          d.document_type = (p.document_type as number) ?? null;
        if (body.method === "delete") d.deleted_at = new Date().toISOString();
      }
      return reply(200, { result: "OK" });
    }
    if (path === "/api/documents/") {
      let list = live();
      const inTags = q.get("tags__id__in");
      if (inTags)
        list = list.filter((d) => inTags.split(",").some((t) => d.tags.includes(Number(t))));
      const allTag = q.get("tags__id__all");
      if (allTag) list = list.filter((d) => d.tags.includes(Number(allTag)));
      const ids = q.get("id__in");
      if (ids) list = list.filter((d) => ids.split(",").includes(String(d.id)));
      const query = q.get("query")?.toLowerCase();
      if (query) list = list.filter((d) => d.title.toLowerCase().includes(query));
      list = [...list].sort((a, b) => b.added.localeCompare(a.added));
      return reply(200, page(list.map((d) => pick(d, q.get("fields")))));
    }
    return reply(404, { detail: "Not found." });
  };

  return { fetch: fetchImpl, reset };
}
