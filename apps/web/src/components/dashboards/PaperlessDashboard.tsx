import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ExternalLink, MessageCircle, RotateCcw, Trash2 } from "lucide-react";
import type {
  PaperlessDashboard as Data,
  PaperlessDoc,
  PaperlessLabel,
} from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * Paperless-ngx from Hearth. The Overview answers "is anything waiting on me or stuck?": the inbox,
 * imports running and failed with Paperless's reason, its own health, free space, tags and
 * maintenance. Inbox sorts new documents: mark them done, tag them, set the correspondent or type,
 * a few at a time. Documents searches everything by its text, filters by tag, and moves documents
 * to the trash or back. Each change is a plan you approve. Hearth shows titles, never the text.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const input =
  "min-h-8 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink placeholder:text-faint";
const KIND = "app-paperless-control" as const;

const HEALTH_TEXT = { ok: "text-ok", warning: "text-amber", error: "text-alert" } as const;
const MAINTENANCE = [
  ["sanity_check", "Run the sanity check"],
  ["train_classifier", "Train the classifier"],
  ["index_optimize", "Optimize the search index"],
  ["mail_fetch", "Fetch mail now"],
] as const;

function usePaperless(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "paperless" ? q.data.data : undefined;
  return { q, d };
}

function useWeb(serviceId: string) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  return (path: string) => keyPageHref(service, path);
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof usePaperless>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="pl-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add an API token to Secure Vault, for this service: in Paperless-ngx, your name (top
            right), My Profile, API Auth Token. An administrator's token sees every document.
          </p>
        )}
      </div>
    );
  return null;
}

function WebLink({ href, children }: { href: string | undefined; children: React.ReactNode }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
    >
      {children} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
    </a>
  );
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const web = useWeb(serviceId);
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Paperless-ngx ${d.version} · ` : ""}
      {d.updateTo ? <span className="text-amber">{d.updateTo} is out · </span> : null}
      live, every 30 s · Hearth shows titles, never a document's text.{" "}
      <WebLink href={web("/dashboard")}>Open Paperless-ngx</WebLink>
    </p>
  );
}

function TagChip({ tag }: { tag: PaperlessLabel }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[0.72rem] text-muted">
      <span
        className="h-2 w-2 rounded-full"
        style={{ background: tag.color ?? "currentColor" }}
        aria-hidden
      />
      {tag.name}
    </span>
  );
}

export function PaperlessDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = usePaperless(serviceId);
  const cave = useCave();
  const act = useApproveHere(serviceId, "Proposed from Paperless-ngx's panel.");
  const [tag, setTag] = useState("");
  const [inboxTag, setInboxTag] = useState(false);
  if (!d) return <Gate name={name} q={q} />;
  const problems = d.health.filter((h) => h.status !== "ok");
  const propose = (params: Record<string, string | number | boolean>, title: string) =>
    void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-4"
      data-testid="pl-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("inbox")}
          data-hearth-target="tab:inbox:open"
        >
          <p className={eyebrow}>Inbox</p>
          <p
            className={cx("stat-value tabular", d.inboxCount ? "text-amber" : "text-ink")}
            data-testid="pl-inbox"
          >
            {d.inboxCount}
          </p>
          <p className="text-[0.74rem] text-faint">new, still to sort</p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Importing</p>
          <p className="stat-value text-ink tabular" data-testid="pl-waiting">
            {d.waiting.length}
          </p>
          <p className="text-[0.74rem] text-faint">waiting or being read</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Failed</p>
          <p
            className={cx("stat-value tabular", d.failed.length ? "text-alert" : "text-ink")}
            data-testid="pl-failed"
          >
            {d.failed.length}
          </p>
          <p className="text-[0.74rem] text-faint">imports and tasks</p>
        </div>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("documents")}
        >
          <p className={eyebrow}>Documents</p>
          <p className="stat-value text-ink tabular" data-testid="pl-documents">
            {d.documents.toLocaleString()}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.freeGb !== undefined ? `${d.freeGb} GB free` : ""}
            {d.trashCount ? ` · ${d.trashCount} in the trash` : ""}
          </p>
        </button>
      </div>

      {d.failed.length > 0 && (
        <div
          className="space-y-2 rounded-xl border border-alert/40 bg-alert/[0.04] p-3"
          data-testid="pl-failures"
        >
          <p className={eyebrow}>Could not finish</p>
          <ul className="space-y-2 text-[0.84rem]">
            {d.failed.map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-2"
                data-testid="pl-failure"
                data-capture-item
                data-capture-label={t.file ?? t.name}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{t.file ?? t.name}</span>
                  <span className="text-faint">
                    {" "}
                    · {t.name.toLowerCase()}
                    {t.at ? `, ${ago(t.at).toLowerCase()}` : ""}
                  </span>
                  {t.result && (
                    <span className="block font-mono text-[0.74rem] break-all text-alert">
                      {t.result}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    cave.ask(
                      `Paperless-ngx (${name}) could not ${t.name === "Import" ? `import ${t.file ?? "a file"}` : t.name.toLowerCase()}: "${t.result ?? "no reason given"}". What causes this, and how do I get it in?`,
                    )
                  }
                >
                  <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember why
                  <EmberMark />
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    propose(
                      { op: "dismiss", taskIds: String(t.id) },
                      `Dismiss the failed ${t.name.toLowerCase()} in ${name}`,
                    )
                  }
                  data-testid="pl-dismiss"
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[0.74rem] text-faint">
            A file from the consume folder that failed stays there; fix it and Paperless tries it
            again.
          </p>
        </div>
      )}

      {d.waiting.length > 0 && (
        <div data-testid="pl-importing">
          <p className={eyebrow}>Importing now</p>
          <ul className="space-y-1 text-[0.82rem]">
            {d.waiting.map((t) => (
              <li key={t.id} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{t.file ?? t.name}</span>
                <span className="text-faint">
                  {t.status === "running" ? "being read" : "waiting"}
                  {t.at ? `, since ${ago(t.at).toLowerCase()}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div data-testid="pl-health">
        <p className={eyebrow}>Paperless itself</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem]">
          {d.health.map((h) => (
            <li key={h.part} className="flex items-center gap-1.5">
              <span className={cx("h-2 w-2 rounded-full bg-current", HEALTH_TEXT[h.status])} />
              <span className="text-muted">{h.part}</span>
            </li>
          ))}
        </ul>
        {problems.map((h) => (
          <p key={h.part} className={cx("mt-1 text-[0.8rem]", HEALTH_TEXT[h.status])}>
            {h.part}: {h.message ?? (h.status === "error" ? "a problem" : "needs a look")}
            {h.at ? <span className="text-faint"> (last {ago(h.at).toLowerCase()})</span> : null}
          </p>
        ))}
      </div>

      <div data-testid="pl-tags">
        <p className={eyebrow}>Tags</p>
        <div className="flex flex-wrap gap-1.5">
          {d.tags.slice(0, 24).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onGo?.("documents", `tag/${t.id}`)}
              className="inline-flex items-center gap-1"
              title={`${t.count} documents${t.inbox ? " · inbox tag" : ""}`}
            >
              <TagChip tag={t} />
              <span className="text-[0.72rem] text-faint">{t.count}</span>
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="New tag"
            aria-label="New tag name"
            className={cx(input, "w-40")}
            data-hearth-target="tags:add"
          />
          <label className="flex items-center gap-1 text-[0.78rem] text-muted">
            <input
              type="checkbox"
              checked={inboxTag}
              onChange={(e) => setInboxTag(e.target.checked)}
            />
            marks new documents
          </label>
          <button
            type="button"
            className={btn}
            disabled={!tag.trim()}
            onClick={() => {
              propose(
                { op: "tag-create", name: tag.trim(), inbox: inboxTag },
                `Make the tag ${tag.trim()} in ${name}`,
              );
              setTag("");
            }}
          >
            Make tag
          </button>
        </div>
        {(d.correspondents.length > 0 || d.types.length > 0) && (
          <p className="mt-2 text-[0.78rem] text-faint">
            {d.correspondents.length} correspondents
            {d.correspondents[0] ? ` (most: ${d.correspondents[0].name})` : ""} · {d.types.length}{" "}
            document types
            {d.fileTypes.length
              ? ` · ${d.fileTypes.map((f) => `${f.count} ${f.type.split("/")[1]?.toUpperCase() ?? f.type}`).join(", ")}`
              : ""}
          </p>
        )}
      </div>

      <div data-hearth-target="paperless:maintenance" data-testid="pl-maintenance">
        <p className={eyebrow}>Maintenance</p>
        <div className="flex flex-wrap gap-2">
          {MAINTENANCE.map(([task, label]) => (
            <button
              key={task}
              type="button"
              className={btn}
              onClick={() => propose({ op: "run", task }, `${label} in ${name}`)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

/** One document with its labels; ticks into the selection. */
function DocRow({
  doc,
  d,
  selected,
  onToggle,
  web,
  children,
}: {
  doc: PaperlessDoc;
  d: Data;
  selected: boolean;
  onToggle: () => void;
  web: (path: string) => string | undefined;
  children?: React.ReactNode;
}) {
  const tags = doc.tags
    .map((id) => d.tags.find((t) => t.id === id))
    .filter((t): t is PaperlessLabel => Boolean(t));
  return (
    <li
      className="flex flex-wrap items-start gap-2 py-2"
      data-testid="pl-doc"
      data-capture-item
      data-capture-label={doc.title}
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select ${doc.title}`}
      />
      <span className="min-w-0 flex-1">
        <span className="text-[0.88rem] text-ink">{doc.title}</span>
        <span className="block text-[0.74rem] text-faint">
          {[
            doc.correspondent ?? "no correspondent",
            doc.type ?? "no type",
            doc.created && `dated ${doc.created}`,
            doc.deletedAt
              ? `in the trash since ${ago(doc.deletedAt).toLowerCase()}`
              : doc.added && `added ${ago(doc.added).toLowerCase()}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {tags.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {tags.map((t) => (
              <TagChip key={t.id} tag={t} />
            ))}
          </span>
        )}
      </span>
      {children}
      {!doc.deletedAt && (
        <a
          href={web(`/documents/${doc.id}/details`)}
          target="_blank"
          rel="noreferrer"
          className={btn}
          aria-label={`Open ${doc.title} in Paperless-ngx`}
        >
          <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </li>
  );
}

/** Tag, correspondent and type for the selected documents. */
function SortBar({
  d,
  ids,
  propose,
  name,
  docs,
}: {
  d: Data;
  ids: number[];
  propose: (params: Record<string, string | number>, title: string) => void;
  name: string;
  docs: PaperlessDoc[];
}) {
  const what =
    ids.length === 1
      ? `"${docs.find((x) => x.id === ids[0])?.title ?? ids[0]}"`
      : `${ids.length} documents`;
  const documents = ids.join(",");
  const pick = (
    label: string,
    list: PaperlessLabel[],
    onPick: (id: string) => void,
    none?: string,
  ) => (
    <select
      className={input}
      value="-"
      disabled={!ids.length}
      aria-label={label}
      onChange={(e) => e.target.value !== "-" && onPick(e.target.value)}
    >
      <option value="-">{label}</option>
      {none && <option value="">{none}</option>}
      {list.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {pick(
        "Add a tag",
        d.tags.filter((t) => !t.inbox),
        (id) =>
          propose(
            { op: "tag-add", documents, tagId: Number(id) },
            `Tag ${what} ${d.tags.find((t) => t.id === Number(id))?.name ?? ""} in ${name}`,
          ),
      )}
      {pick(
        "Correspondent",
        d.correspondents,
        (id) =>
          propose(
            { op: "correspondent", documents, value: id },
            `Set the correspondent of ${what} in ${name}`,
          ),
        "None",
      )}
      {pick(
        "Document type",
        d.types,
        (id) => propose({ op: "type", documents, value: id }, `Set the type of ${what} in ${name}`),
        "None",
      )}
    </div>
  );
}

export function PaperlessInbox({ serviceId, name }: AppViewProps) {
  const { q, d } = usePaperless(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Paperless-ngx's panel.");
  const web = useWeb(serviceId);
  const [picked, setPicked] = useState<number[]>([]);
  if (!d) return <Gate name={name} q={q} />;
  const ids = picked.filter((id) => d.inbox.some((x) => x.id === id));
  const propose = (params: Record<string, string | number>, title: string) =>
    void act.propose(KIND, params, title);
  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <section
      className="@container space-y-3"
      data-testid="pl-inbox-tab"
      aria-label={`${name}: inbox`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      {d.inbox.length === 0 ? (
        <p className="text-[0.88rem] text-ok" data-testid="pl-inbox-empty">
          The inbox is empty: every new document is sorted.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={btn}
              onClick={() =>
                setPicked(ids.length === d.inbox.length ? [] : d.inbox.map((x) => x.id))
              }
            >
              {ids.length === d.inbox.length ? "Select none" : "Select all"}
            </button>
            <button
              type="button"
              className={cx(btn, "border-gold/50 text-gold")}
              disabled={!ids.length}
              onClick={() =>
                propose(
                  { op: "inbox-done", documents: ids.join(",") },
                  `Mark ${ids.length === 1 ? "a document" : `${ids.length} documents`} done in ${name}`,
                )
              }
              data-hearth-target="inbox:done"
              data-testid="pl-mark-done"
            >
              <Check strokeWidth={1.5} className="h-3.5 w-3.5" /> Mark done
              {ids.length ? ` (${ids.length})` : ""}
            </button>
            <SortBar d={d} ids={ids} propose={propose} name={name} docs={d.inbox} />
          </div>
          <ul className="divide-y divide-line">
            {d.inbox.map((doc) => (
              <DocRow
                key={doc.id}
                doc={doc}
                d={d}
                selected={ids.includes(doc.id)}
                onToggle={() => toggle(doc.id)}
                web={web}
              >
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    propose(
                      { op: "inbox-done", documents: String(doc.id) },
                      `Mark "${doc.title}" done in ${name}`,
                    )
                  }
                  data-testid="pl-doc-done"
                >
                  <Check strokeWidth={1.5} className="h-3.5 w-3.5" /> Done
                </button>
              </DocRow>
            ))}
          </ul>
          {d.inboxCount > d.inbox.length && (
            <p className="text-[0.74rem] text-faint">
              Showing the newest {d.inbox.length} of {d.inboxCount}.
            </p>
          )}
        </>
      )}
      <p className="text-[0.74rem] text-faint">
        Done takes a document's inbox tag off. New correspondents and document types are made in
        Paperless-ngx.
      </p>
    </section>
  );
}

type DocPage = { total: number; items: PaperlessDoc[] };

export function PaperlessDocuments({ serviceId, name, sub }: AppViewProps) {
  const { q: dq, d } = usePaperless(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Paperless-ngx's panel.");
  const web = useWeb(serviceId);
  const fromSub = /^tag\/(\d+)$/.exec(sub ?? "")?.[1];
  const [find, setFind] = useState("");
  const [query, setQuery] = useState("");
  const [tagId, setTagId] = useState(fromSub ?? "");
  const [trash, setTrash] = useState(false);
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<number[]>([]);
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "paperless-docs", query, tagId, trash, page],
    queryFn: () => {
      const p = new URLSearchParams({ page: String(page) });
      if (trash) p.set("trash", "1");
      else {
        if (query) p.set("query", query);
        if (tagId) p.set("tag", tagId);
      }
      return api<DocPage>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/paperless/documents?${p.toString()}`,
      );
    },
    staleTime: 15_000,
  });
  if (!d) return <Gate name={name} q={dq} />;
  const items = q.data?.items ?? [];
  const ids = picked.filter((id) => items.some((x) => x.id === id));
  const propose = (params: Record<string, string | number>, title: string) =>
    void act.propose(KIND, params, title);
  const what = ids.length === 1 ? "a document" : `${ids.length} documents`;
  return (
    <section
      className="@container space-y-3"
      data-testid="pl-documents-tab"
      aria-label={`${name}: documents`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTrash(false);
          setPage(1);
          setQuery(find.trim());
        }}
      >
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Search every document's text"
          aria-label="Search documents"
          className={cx(input, "min-h-9 min-w-48 flex-1")}
          data-hearth-target="documents:find"
        />
        <button type="submit" className={btn}>
          Search
        </button>
        <select
          className={input}
          value={tagId}
          aria-label="Only with the tag"
          onChange={(e) => {
            setTagId(e.target.value);
            setTrash(false);
            setPage(1);
          }}
        >
          <option value="">Any tag</option>
          {d.tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={trash}
          className={cx(btn, trash && "border-gold/60 text-gold")}
          onClick={() => {
            setTrash(!trash);
            setPage(1);
          }}
          data-testid="pl-trash-toggle"
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Trash ({d.trashCount})
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {trash ? (
          <button
            type="button"
            className={btn}
            disabled={!ids.length}
            onClick={() =>
              propose({ op: "restore", documents: ids.join(",") }, `Bring back ${what} in ${name}`)
            }
            data-testid="pl-restore"
          >
            <RotateCcw strokeWidth={1.5} className="h-3.5 w-3.5" /> Bring back
          </button>
        ) : (
          <>
            <button
              type="button"
              className={btn}
              disabled={!ids.length}
              onClick={() =>
                propose(
                  { op: "trash", documents: ids.join(",") },
                  `Move ${what} to the trash in ${name}`,
                )
              }
              data-testid="pl-trash"
            >
              <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Move to trash
            </button>
            <button
              type="button"
              className={btn}
              disabled={!ids.length}
              onClick={() =>
                propose(
                  { op: "reprocess", documents: ids.join(",") },
                  `Process ${what} again in ${name}`,
                )
              }
            >
              Process again
            </button>
            <SortBar d={d} ids={ids} propose={propose} name={name} docs={items} />
          </>
        )}
      </div>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <p className="text-[0.84rem] text-alert">
          Could not read the documents: {(q.error as Error).message}
        </p>
      ) : (
        <>
          <p className="text-[0.74rem] text-faint" data-testid="pl-doc-count">
            {trash
              ? `${q.data?.total ?? 0} in the trash`
              : `${q.data?.total ?? 0} ${query ? `found for "${query}"` : "documents, newest first"}`}
          </p>
          <ul className="divide-y divide-line">
            {items.map((doc) => (
              <DocRow
                key={doc.id}
                doc={doc}
                d={d}
                selected={ids.includes(doc.id)}
                onToggle={() =>
                  setPicked((p) =>
                    p.includes(doc.id) ? p.filter((x) => x !== doc.id) : [...p, doc.id],
                  )
                }
                web={web}
              />
            ))}
          </ul>
          {(q.data?.total ?? 0) > 25 && (
            <div className="flex items-center gap-2 text-[0.78rem] text-faint">
              <button
                type="button"
                className={btn}
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Newer
              </button>
              page {page} of {Math.ceil((q.data?.total ?? 0) / 25)}
              <button
                type="button"
                className={btn}
                disabled={page * 25 >= (q.data?.total ?? 0)}
                onClick={() => setPage(page + 1)}
              >
                Older
              </button>
            </div>
          )}
        </>
      )}
      <p className="text-[0.74rem] text-faint">
        The trash keeps documents until Paperless empties it (30 days unless changed). Deleting for
        good happens in Paperless-ngx.
      </p>
    </section>
  );
}
