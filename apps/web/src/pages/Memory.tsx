import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import {
  MEMORY_BASES,
  MEMORY_BASIS_LABELS,
  MEMORY_KINDS,
  MEMORY_KIND_LABELS,
  freshnessText,
  memoryFreshness,
  type MemoryEntry,
  type MemoryKind,
  type MemoryLink,
  type MemoryProject,
  type MemorySearchHit,
  type MemorySource,
} from "@dragon-control/core";
import {
  Button,
  EmptyState,
  LinkButton,
  PageHeader,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Tag,
  cx,
} from "../components/ui";
import { useConversation } from "../data/agent";
import {
  useBackups,
  useEntryAction,
  useImportSummary,
  useMemoryEntries,
  useMemoryEntry,
  useMemoryProjects,
  useMemorySearch,
  useSaveEntry,
  useSaveProject,
  useTranscript,
  useTranscripts,
  type EntryInput,
} from "../data/memory";
import { ago, fullDateTime } from "../lib/format";
import { FormError, TextField } from "./auth/AuthFrame";

const sourceLabel = (source: MemorySource, author?: string) =>
  author ?? { you: "You", ai: "Claude", "dragon-control": "Hearth", import: "Imported" }[source];

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

const selectClass =
  "min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

/** Turns "[[match]]" markers from search into highlighted text, without any HTML injection. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[[") && p.endsWith("]]") ? (
          <mark key={i} className="rounded-sm bg-gold/20 px-0.5 text-gold">
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="mb-5">
      <label htmlFor={id} className="mb-2 block text-[0.85rem] text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClass}
      >
        {children}
      </select>
    </div>
  );
}

/* ---------- Writing ---------- */

function EntryForm({
  entry,
  projects,
  onClose,
}: {
  entry?: MemoryEntry;
  projects: MemoryProject[];
  onClose: () => void;
}) {
  const save = useSaveEntry();
  const [kind, setKind] = useState<MemoryKind>(entry?.kind ?? "note");
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState(entry?.body ?? "");
  const [projectId, setProjectId] = useState(entry?.projectId ?? "");
  const [happened, setHappened] = useState(
    (entry?.happenedAt ?? new Date().toISOString()).slice(0, 10),
  );
  const [basis, setBasis] = useState(entry?.basis ?? "stated");
  const [machine, setMachine] = useState(entry?.machine ?? "");
  const submit = () => {
    const input: Partial<EntryInput> = {
      kind,
      title,
      body,
      projectId: projectId || null,
      basis,
      machine: machine.trim() || null,
    };
    // Keep the original time of day unless the date itself changed.
    if (!entry || entry.happenedAt.slice(0, 10) !== happened) {
      input.happenedAt = new Date(`${happened}T12:00:00`).toISOString();
    }
    save.mutate({ id: entry?.id, input }, { onSuccess: onClose });
  };
  return (
    <Sheet
      label={entry ? "Edit memory" : "Remember something"}
      eyebrow="Memory"
      title={entry ? "Edit" : "Remember something"}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SelectField
          id="memory-kind"
          label="Kind"
          value={kind}
          onChange={(v) => setKind(v as MemoryKind)}
        >
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {MEMORY_KIND_LABELS[k]}
            </option>
          ))}
        </SelectField>
        <TextField
          id="memory-title"
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="Title"
          required
        />
        <div className="mb-5">
          <label htmlFor="memory-body" className="mb-2 block text-[0.85rem] text-muted">
            Details
          </label>
          <textarea
            id="memory-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            maxLength={20000}
            className="w-full rounded-lg border border-line-strong bg-bg px-4 py-3 text-[0.95rem] leading-relaxed text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
            placeholder="Details"
          />
          <p className="mt-2 text-[0.78rem] leading-relaxed text-faint">
            Never put passwords or keys here. They belong in the vault.
          </p>
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <SelectField
            id="memory-project"
            label="Project"
            value={projectId}
            onChange={setProjectId}
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          <TextField
            id="memory-date"
            label="When"
            type="date"
            value={happened}
            onChange={(e) => setHappened(e.target.value)}
            required
          />
          <SelectField
            id="memory-basis"
            label="How it is known"
            value={basis}
            onChange={(v) => setBasis(v as typeof basis)}
          >
            {MEMORY_BASES.map((b) => (
              <option key={b} value={b}>
                {MEMORY_BASIS_LABELS[b]}
              </option>
            ))}
          </SelectField>
          <TextField
            id="memory-machine"
            label="Machine"
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
            maxLength={80}
            placeholder="Machine name"
          />
        </div>
        <Button tone="primary" type="submit" className="w-full" disabled={save.isPending}>
          {save.isPending ? "Saving" : entry ? "Save changes" : "Remember it"}
        </Button>
        <FormError error={save.error} />
      </form>
    </Sheet>
  );
}

function ProjectForm({ project, onClose }: { project?: MemoryProject; onClose: () => void }) {
  const save = useSaveProject();
  const [name, setName] = useState(project?.name ?? "");
  const [summary, setSummary] = useState(project?.summary ?? "");
  const [status, setStatus] = useState<MemoryProject["status"]>(project?.status ?? "active");
  return (
    <Sheet
      label={project ? "Edit project" : "New project"}
      eyebrow="Projects"
      title={project ? project.name : "New project"}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            { id: project?.id, input: { name, summary, status } },
            { onSuccess: onClose },
          );
        }}
      >
        <TextField
          id="project-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Project name"
          required
        />
        <div className="mb-5">
          <label htmlFor="project-summary" className="mb-2 block text-[0.85rem] text-muted">
            What it is
          </label>
          <textarea
            id="project-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={4}
            maxLength={4000}
            className="w-full rounded-lg border border-line-strong bg-bg px-4 py-3 text-[0.95rem] leading-relaxed text-ink focus:border-gold/60 focus:outline-none"
          />
        </div>
        <SelectField
          id="project-status"
          label="Status"
          value={status}
          onChange={(v) => setStatus(v as MemoryProject["status"])}
        >
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="done">Done</option>
        </SelectField>
        <Button tone="primary" type="submit" className="w-full" disabled={save.isPending}>
          {save.isPending ? "Saving" : project ? "Save" : "Create project"}
        </Button>
        <FormError error={save.error} />
      </form>
    </Sheet>
  );
}

/* ---------- Reading ---------- */

type Snapshot = Omit<MemoryEntry, "id">;

/** What one change did, in words: "Status: open → done". */
function describeChange(before: Snapshot, after: Snapshot, projects: MemoryProject[]): string[] {
  const name = (id?: string) => (id ? (projects.find((p) => p.id === id)?.name ?? id) : "none");
  const out: string[] = [];
  if (before.title !== after.title) out.push(`Title: ${before.title} → ${after.title}`);
  if (before.kind !== after.kind)
    out.push(`Kind: ${MEMORY_KIND_LABELS[before.kind]} → ${MEMORY_KIND_LABELS[after.kind]}`);
  if (before.status !== after.status)
    out.push(`Status: ${before.status ?? "none"} → ${after.status ?? "none"}`);
  if (before.body !== after.body) out.push("Details changed");
  if (before.basis !== after.basis)
    out.push(
      `How it is known: ${MEMORY_BASIS_LABELS[before.basis]} → ${MEMORY_BASIS_LABELS[after.basis]}`,
    );
  if (before.projectId !== after.projectId)
    out.push(`Project: ${name(before.projectId)} → ${name(after.projectId)}`);
  if (before.machine !== after.machine)
    out.push(`Machine: ${before.machine ?? "none"} → ${after.machine ?? "none"}`);
  if (before.happenedAt.slice(0, 10) !== after.happenedAt.slice(0, 10))
    out.push(`When: ${day(before.happenedAt)} → ${day(after.happenedAt)}`);
  if (JSON.stringify(before.verification) !== JSON.stringify(after.verification))
    out.push("Verification updated");
  if (JSON.stringify(before.links) !== JSON.stringify(after.links)) out.push("Evidence updated");
  if (Boolean(before.superseded) !== Boolean(after.superseded))
    out.push(
      after.superseded ? "Marked as history (no longer current)" : "Marked as current again",
    );
  return out;
}

function LinkRef({ link }: { link: MemoryLink }) {
  const [kind, id] = [
    link.ref.slice(0, link.ref.indexOf(":")),
    link.ref.slice(link.ref.indexOf(":") + 1),
  ];
  const to =
    kind === "incident"
      ? `/incidents/${id}`
      : kind === "service"
        ? `/services/${id}`
        : kind === "host"
          ? `/systems#${id}`
          : undefined;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-[0.85rem]">
      {to ? (
        <Link to={to} className="text-gold underline-offset-4 hover:underline">
          {link.label}
        </Link>
      ) : kind === "url" ? (
        <a
          href={id}
          target="_blank"
          rel="noreferrer"
          className="text-gold underline-offset-4 hover:underline"
        >
          {link.label}
        </a>
      ) : (
        <span className="text-ink">{link.label}</span>
      )}
      <span className="font-mono text-[0.75rem] break-all text-faint">{link.ref}</span>
    </li>
  );
}

function EntrySheet({
  id,
  projects,
  onClose,
}: {
  id: string;
  projects: MemoryProject[];
  onClose: () => void;
}) {
  const { data, error } = useMemoryEntry(id);
  const save = useSaveEntry();
  const act = useEntryAction();
  const [editing, setEditing] = useState(false);
  const [confirmForever, setConfirmForever] = useState(false);
  const entry = data?.entry;
  if (editing && entry) {
    return <EntryForm entry={entry} projects={projects} onClose={() => setEditing(false)} />;
  }
  const project = projects.find((p) => p.id === entry?.projectId);
  return (
    <Sheet
      label="Memory"
      eyebrow={entry ? MEMORY_KIND_LABELS[entry.kind] : "Memory"}
      title={entry?.title ?? "…"}
      onClose={onClose}
      wide
    >
      {error && <FormError error={error} />}
      {entry && (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Tag
              tone={
                entry.basis === "observed" ? "gold" : entry.basis === "unknown" ? "warn" : "neutral"
              }
            >
              {MEMORY_BASIS_LABELS[entry.basis]}
            </Tag>
            {entry.kind === "thread" && (
              <Tag tone={entry.status === "open" ? "gold" : "neutral"}>
                {entry.status === "open" ? "Open" : "Done"}
              </Tag>
            )}
            {entry.deletedAt && <Tag tone="warn">Deleted {ago(entry.deletedAt).toLowerCase()}</Tag>}
            {entry.superseded && <Tag>History, no longer current</Tag>}
            <FreshnessTag entry={entry} long />
          </div>
          {entry.superseded && (
            <p
              className="rounded-lg border border-line px-4 py-3 text-[0.85rem] leading-relaxed text-muted"
              data-testid="superseded-note"
            >
              Kept as history since {day(entry.superseded.at)}, so it is never shown as how things
              are now. {entry.superseded.reason}
            </p>
          )}
          {entry.body && (
            <p className="text-[0.95rem] leading-relaxed whitespace-pre-wrap text-ink">
              {entry.body}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-5 text-[0.85rem]">
            <div>
              <dt className="text-faint">When</dt>
              <dd className="mt-1 text-ink">{day(entry.happenedAt)}</dd>
            </div>
            <div>
              <dt className="text-faint">Written by</dt>
              <dd className="mt-1 text-ink">{sourceLabel(entry.source, entry.author)}</dd>
            </div>
            <div>
              <dt className="text-faint">Project</dt>
              <dd className="mt-1 text-ink">{project?.name ?? "None"}</dd>
            </div>
            <div>
              <dt className="text-faint">Machine</dt>
              <dd className="mt-1 text-ink">{entry.machine ?? "Not set"}</dd>
            </div>
          </dl>
          {entry.verification && (
            <div className="rounded-lg border border-line p-4 text-[0.85rem]">
              <p className="text-faint">Verified {fullDateTime(entry.verification.at)}</p>
              <p className="mt-2 font-mono text-[0.8rem] break-words text-ink">
                {entry.verification.check}
              </p>
              <p className="mt-1 text-muted">{entry.verification.result}</p>
            </div>
          )}
          {entry.links.length > 0 && (
            <div>
              <p className="eyebrow mb-3">Evidence</p>
              <ul className="space-y-2">
                {entry.links.map((l) => (
                  <LinkRef key={l.ref} link={l} />
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {entry.deletedAt ? (
              <>
                <Button tone="primary" onClick={() => act.mutate({ id, action: "restore" })}>
                  Restore
                </Button>
                {confirmForever ? (
                  <Button
                    tone="outline"
                    className="border-bad/50 text-bad hover:border-bad hover:text-bad"
                    onClick={() => act.mutate({ id, action: "forever" }, { onSuccess: onClose })}
                  >
                    Delete forever, with its history
                  </Button>
                ) : (
                  <Button tone="quiet" onClick={() => setConfirmForever(true)}>
                    Delete forever
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button tone="primary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                {entry.kind === "thread" && (
                  <Button
                    onClick={() =>
                      save.mutate({
                        id,
                        input: { status: entry.status === "open" ? "done" : "open" },
                      })
                    }
                  >
                    {entry.status === "open" ? "Mark done" : "Reopen"}
                  </Button>
                )}
                {entry.kind !== "journal" && entry.kind !== "win" && (
                  <Button
                    tone="quiet"
                    onClick={() =>
                      save.mutate({
                        id,
                        input: {
                          superseded: entry.superseded
                            ? null
                            : {
                                at: new Date().toISOString(),
                                reason: "You marked it as no longer how things are.",
                              },
                        },
                      })
                    }
                  >
                    {entry.superseded ? "Still current" : "No longer true"}
                  </Button>
                )}
                <Button
                  tone="quiet"
                  onClick={() => act.mutate({ id, action: "delete" }, { onSuccess: onClose })}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
          <FormError error={act.error ?? save.error} />

          <div>
            <p className="eyebrow mb-3">History</p>
            <ol className="space-y-3" data-testid="memory-history">
              {data.history.map((h, i) => {
                // Each revision holds the entry as it was before; the newer one (or now) is after.
                const after = i === 0 ? entry : data.history[i - 1]!.snapshot;
                const changes =
                  h.action === "edited" ? describeChange(h.snapshot, after, projects) : [];
                return (
                  <li key={h.id} className="text-[0.85rem]">
                    <span className="text-ink capitalize">{h.action}</span>
                    <span className="text-muted">
                      {" "}
                      by {sourceLabel(h.by, h.author)} · {ago(h.at).toLowerCase()}
                    </span>
                    {changes.map((c) => (
                      <p key={c} className="mt-1 text-[0.8rem] break-words text-faint">
                        {c}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function TranscriptSheet({ id, seq, onClose }: { id: string; seq?: number; onClose: () => void }) {
  const { data } = useTranscript(id);
  const target = useRef<HTMLLIElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [data]);
  return (
    <Sheet
      label="Saved session"
      eyebrow="Saved session"
      title={data?.transcript.title ?? "…"}
      onClose={onClose}
      wide
    >
      {data && (
        <>
          <p className="mb-5 text-[0.82rem] text-muted">
            {data.transcript.client}
            {data.transcript.machine ? ` on ${data.transcript.machine}` : ""} ·{" "}
            {fullDateTime(data.transcript.startedAt)} · {data.transcript.messageCount} messages
          </p>
          <ol className="space-y-4">
            {data.messages.map((m) => (
              <li
                key={m.seq}
                ref={m.seq === seq ? target : undefined}
                className={cx(
                  "rounded-lg border p-4",
                  m.seq === seq ? "border-gold/50 bg-gold/[0.05]" : "border-line",
                )}
              >
                <p className="mb-2 text-[0.75rem] tracking-wide text-faint uppercase">
                  {m.role === "you" ? "You" : m.role === "ai" ? "Claude" : m.role} ·{" "}
                  {fullDateTime(m.at)}
                </p>
                <p className="text-[0.9rem] leading-relaxed whitespace-pre-wrap text-ink">
                  {m.text}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
    </Sheet>
  );
}

function ConversationSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useConversation(id);
  return (
    <Sheet
      label="Conversation"
      eyebrow="Conversation"
      title={data?.title ?? "…"}
      onClose={onClose}
      wide
    >
      <ol className="space-y-4">
        {data?.messages.map((m, i) => (
          <li key={i} className="rounded-lg border border-line p-4">
            <p className="mb-2 text-[0.75rem] tracking-wide text-faint uppercase">
              {m.role === "you" ? "You" : m.role === "agent" ? "Claude" : "Note"} ·{" "}
              {fullDateTime(m.at)}
            </p>
            <p className="text-[0.9rem] leading-relaxed whitespace-pre-wrap text-ink">{m.text}</p>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

/* ---------- Lists ---------- */

function EntryRow({
  entry,
  projects,
  onOpen,
}: {
  entry: MemoryEntry;
  projects: MemoryProject[];
  onOpen: () => void;
}) {
  const project = projects.find((p) => p.id === entry.projectId);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full flex-col gap-1.5 py-4 text-left focus-visible:outline-gold"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Tag tone={entry.kind === "thread" && entry.status === "open" ? "gold" : "neutral"}>
            {entry.kind === "thread"
              ? entry.status === "open"
                ? "Open thread"
                : "Thread done"
              : MEMORY_KIND_LABELS[entry.kind]}
          </Tag>
          {entry.basis === "unknown" && <Tag tone="warn">Unverified</Tag>}
          {entry.superseded && <Tag>History</Tag>}
          <FreshnessTag entry={entry} />
        </span>
        <span className="text-[0.98rem] text-ink group-hover:text-gold">{entry.title}</span>
        <span className="text-[0.78rem] text-faint">
          {day(entry.happenedAt)}
          {project ? ` · ${project.name}` : ""}
          {entry.machine ? ` · ${entry.machine}` : ""} · {sourceLabel(entry.source, entry.author)}
        </span>
        {entry.body && (
          <span className="line-clamp-2 text-[0.85rem] leading-relaxed text-muted">
            {entry.body}
          </span>
        )}
      </button>
    </li>
  );
}

type Open =
  | { type: "entry"; id: string }
  | { type: "transcript"; id: string; seq?: number }
  | { type: "conversation"; id: string };

const hitLabel: Record<MemorySearchHit["type"], string> = {
  entry: "Memory",
  transcript: "Saved session",
  conversation: "Conversation",
};

function SearchResults({ q, onOpen }: { q: string; onOpen: (o: Open) => void }) {
  const { data, isFetching } = useMemorySearch(q);
  if (!data) return <Skeleton className="h-24" />;
  if (!data.length) {
    return (
      <p role="status" className="py-6 text-[0.9rem] text-muted">
        {isFetching ? "Searching" : `Nothing remembered matches "${q.trim()}".`}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line" aria-label="Search results">
      {data.map((h) => (
        <li key={`${h.type}-${h.id}-${h.seq ?? ""}`}>
          <button
            type="button"
            onClick={() =>
              onOpen(
                h.type === "entry"
                  ? { type: "entry", id: h.id }
                  : h.type === "transcript"
                    ? { type: "transcript", id: h.id, seq: h.seq }
                    : { type: "conversation", id: h.id },
              )
            }
            className="group flex w-full flex-col gap-1 py-4 text-left"
          >
            <span className="text-[0.75rem] tracking-wide text-faint uppercase">
              {h.kind ? MEMORY_KIND_LABELS[h.kind] : hitLabel[h.type]} · {day(h.at)}
            </span>
            <span className="text-[0.95rem] text-ink group-hover:text-gold">{h.title}</span>
            <span className="text-[0.85rem] leading-relaxed text-muted">
              <Snippet text={h.snippet} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Drafts from an import wait for you here before any of them become memories. */
function ImportBanner() {
  const { data } = useImportSummary();
  if (!data?.pending) return null;
  return (
    <div
      role="status"
      className="mb-8 flex flex-col gap-3 rounded-lg border border-gold/40 bg-gold/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-[0.9rem] leading-relaxed text-ink">
        {data.pending} {data.pending === 1 ? "piece" : "pieces"} of your existing notes{" "}
        {data.pending === 1 ? "is" : "are"} waiting for you. Nothing is remembered until you accept
        it.
      </p>
      <LinkButton to="/memory/import" tone="primary">
        Review
      </LinkButton>
    </div>
  );
}

function BackupLine() {
  const { data } = useBackups();
  if (!data) return null;
  const last = data.recent[0];
  const failed = last && !last.ok;
  return (
    <p role="status" className={cx("mb-8 text-[0.82rem]", failed ? "text-warn" : "text-faint")}>
      {failed
        ? `The last backup failed ${ago(last.at).toLowerCase()}: ${last.detail}. `
        : data.lastOk
          ? `Saved on this server and backed up ${ago(data.lastOk.at).toLowerCase()}. `
          : "Saved on this server. The first backup runs within a few minutes. "}
      <Link to="/settings#backups" className="text-gold underline underline-offset-4">
        Backups
      </Link>
    </p>
  );
}

type Filter = "all" | MemoryKind | "deleted";

export function MemoryPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [adding, setAdding] = useState(false);
  const [projectSheet, setProjectSheet] = useState<MemoryProject | "new" | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const projects = useMemoryProjects().data ?? [];
  const entries = useMemoryEntries({
    kind: filter === "all" || filter === "deleted" ? undefined : filter,
    view: filter === "deleted" ? "deleted" : "active",
    projectId: projectId || undefined,
  });
  const transcripts = useTranscripts().data ?? [];
  const searching = debounced.trim().length > 0;

  return (
    <>
      <PageHeader
        eyebrow="Memory"
        title="What it remembers"
        subtitle="Your projects, what was built and why, open threads, and how you like to work. Kept in Hearth on this server, never in a terminal, and saved the moment it is written."
        actions={
          <Button tone="primary" onClick={() => setAdding(true)}>
            Remember something
          </Button>
        }
      />
      <ImportBanner />
      <BackupLine />

      <div className="relative mb-8">
        <label htmlFor="memory-search" className="sr-only">
          Search memories and conversations
        </label>
        <Search
          strokeWidth={1.25}
          className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-faint"
        />
        <input
          id="memory-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search memories and conversations"
          className="min-h-12 w-full rounded-lg border border-line-strong bg-bg pr-4 pl-11 text-[0.95rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
        />
      </div>

      {searching ? (
        <Section title="Search">
          <SearchResults q={debounced} onOpen={setOpen} />
        </Section>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <Segmented<Filter>
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "Everything" },
                { value: "thread", label: "Threads" },
                { value: "journal", label: "Journal" },
                { value: "win", label: "Wins" },
                { value: "preference", label: "How you work" },
                { value: "hardware", label: "Hardware" },
                { value: "note", label: "Notes" },
                { value: "deleted", label: "Recently deleted" },
              ]}
            />
            {projects.length > 0 && (
              <div className="lg:w-56">
                <label htmlFor="memory-project-filter" className="sr-only">
                  Project
                </label>
                <select
                  id="memory-project-filter"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className={selectClass}
                >
                  <option value="">All projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {entries.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : entries.data && entries.data.length > 0 ? (
            <ul
              className="mb-14 divide-y divide-line border-y border-line"
              data-testid="memory-list"
            >
              {entries.data.map((e) => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  projects={projects}
                  onOpen={() => setOpen({ type: "entry", id: e.id })}
                />
              ))}
            </ul>
          ) : (
            <div className="mb-14">
              <EmptyState
                title={
                  filter === "deleted"
                    ? "Nothing deleted"
                    : filter === "all" && !projectId
                      ? "Nothing remembered yet"
                      : "Nothing here yet"
                }
                action={
                  filter === "deleted" ? undefined : (
                    <Button tone="primary" onClick={() => setAdding(true)}>
                      Remember something
                    </Button>
                  )
                }
              >
                {filter === "deleted"
                  ? "Deleted memories wait here until you restore them or delete them for good."
                  : "Fixes Hearth makes on your systems are written here on their own. Add anything else worth keeping: a decision and why, an unfinished job, how you like things done."}
              </EmptyState>
            </div>
          )}

          <Section
            title="Projects"
            action={<Button onClick={() => setProjectSheet("new")}>New project</Button>}
          >
            {projects.length === 0 ? (
              <p className="py-2 text-[0.9rem] text-muted">Group memories by project.</p>
            ) : (
              <ul className="divide-y divide-line">
                {projects.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 py-4">
                    <button
                      type="button"
                      onClick={() => {
                        setProjectId(p.id);
                        setFilter("all");
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block text-[0.95rem] text-ink hover:text-gold">
                        {p.name}
                      </span>
                      <span className="block text-[0.78rem] text-faint">
                        {p.entries} {p.entries === 1 ? "memory" : "memories"}
                        {p.openThreads ? ` · ${p.openThreads} open` : ""}
                      </span>
                    </button>
                    <Tag tone={p.status === "active" ? "gold" : "neutral"}>
                      {p.status === "active" ? "Active" : p.status === "paused" ? "Paused" : "Done"}
                    </Tag>
                    <Button tone="quiet" onClick={() => setProjectSheet(p)}>
                      Edit
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Saved sessions">
            {transcripts.length === 0 ? (
              <p className="py-2 text-[0.9rem] text-muted">
                Whole conversations, kept word for word so the reasoning behind decisions is never
                lost. Claude Code sessions will be saved here once it is connected.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {transcripts.map((tr) => (
                  <li key={tr.id}>
                    <button
                      type="button"
                      onClick={() => setOpen({ type: "transcript", id: tr.id })}
                      className="group flex w-full flex-col gap-1 py-4 text-left"
                    >
                      <span className="text-[0.95rem] text-ink group-hover:text-gold">
                        {tr.title}
                      </span>
                      <span className="text-[0.78rem] text-faint">
                        {tr.client}
                        {tr.machine ? ` on ${tr.machine}` : ""} · {day(tr.startedAt)} ·{" "}
                        {tr.messageCount} messages
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {adding && <EntryForm projects={projects} onClose={() => setAdding(false)} />}
      {projectSheet && (
        <ProjectForm
          project={projectSheet === "new" ? undefined : projectSheet}
          onClose={() => setProjectSheet(null)}
        />
      )}
      {open?.type === "entry" && (
        <EntrySheet key={open.id} id={open.id} projects={projects} onClose={() => setOpen(null)} />
      )}
      {open?.type === "transcript" && (
        <TranscriptSheet key={open.id} id={open.id} seq={open.seq} onClose={() => setOpen(null)} />
      )}
      {open?.type === "conversation" && (
        <ConversationSheet key={open.id} id={open.id} onClose={() => setOpen(null)} />
      )}
    </>
  );
}

/**
 * How recently a setup fact was known to be true. Only setup facts age (notes, hardware, how you
 * work); history and open threads never do. A stale one is amber: check it before trusting it.
 */
function FreshnessTag({ entry, long = false }: { entry: MemoryEntry; long?: boolean }) {
  const f = memoryFreshness(entry, new Date());
  if (!f.ages || entry.superseded || entry.deletedAt) return null;
  if (!f.stale && !long) return null;
  const text = freshnessText(f);
  return (
    <Tag tone={f.stale ? "warn" : "neutral"}>
      {f.stale && !long ? "May be out of date" : text[0]!.toUpperCase() + text.slice(1)}
    </Tag>
  );
}
