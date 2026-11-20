import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import {
  MEMORY_KINDS,
  MEMORY_KIND_LABELS,
  type ImportDraft,
  type ImportReason,
  type MemoryKind,
} from "@dragon-control/core";
import {
  Button,
  EmptyState,
  PageHeader,
  Section,
  Segmented,
  Sheet,
  Skeleton,
  Tag,
  cx,
} from "../components/ui";
import {
  useImportDecision,
  useImportDraft,
  useImportDrafts,
  useImportSummary,
  useMemoryProjects,
  type ImportEdits,
} from "../data/memory";
import { FormError, TextField } from "./auth/AuthFrame";

/**
 * Reviewing an import: the importer read your existing notes and past
 * sessions into drafts, and nothing becomes a memory until you accept it
 * here. Hearth sorts the drafts (ready, worth a look, probably
 * not) and says why, so straightforward ones can be kept in bulk and only
 * the questions need opening.
 */

type Status = ImportDraft["status"];

const segments = (p: string) => p.split(/[\\/]/).filter(Boolean);
const dirOf = (p: string) => segments(p).slice(0, -1).join("/");

/** Reference folders and session folders are reviewed as one group, other files one each. */
function groupOf(d: ImportDraft): string {
  if (d.note === "reference document" || d.payload.kind === "session") return dirOf(d.origin);
  if (d.note === "session log") return segments(d.origin).slice(0, -2).join("/");
  return segments(d.origin).join("/");
}

const groupLabel = (key: string) => segments(key).slice(-2).join(" / ");

const day = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";

function kindLabel(d: ImportDraft): string {
  if (d.payload.kind === "project") return "Project";
  if (d.payload.kind === "session") return "Session";
  const e = d.payload.entry;
  if (e.kind === "thread") return e.status === "done" ? "Thread, closed" : "Open thread";
  return MEMORY_KIND_LABELS[e.kind];
}

function titleOf(d: ImportDraft): string {
  if (d.payload.kind === "project") return d.payload.project.name;
  if (d.payload.kind === "session") return d.payload.session.title;
  return d.payload.entry.title;
}

function metaOf(d: ImportDraft): string {
  const p = d.payload;
  if (p.kind === "project") {
    const summary = p.project.summary?.replace(/\s+/g, " ").trim();
    return summary ? (summary.length > 90 ? `${summary.slice(0, 89)}…` : summary) : "No summary";
  }
  if (p.kind === "session") {
    return [
      `${d.messageCount ?? p.session.messages.length} messages`,
      p.session.machine,
      day(p.session.startedAt),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const e = p.entry;
  return [day(e.happenedAt), e.projectName, e.author].filter(Boolean).join(" · ");
}

const fieldClass =
  "min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

function DraftSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: draft, isPending } = useImportDraft(id);
  const projects = useMemoryProjects().data ?? [];
  const decide = useImportDecision();
  const [edits, setEdits] = useState<ImportEdits>({});
  const [asCurrent, setAsCurrent] = useState(false);
  const set = (patch: ImportEdits) => setEdits((e) => ({ ...e, ...patch }));
  const done = { onSuccess: onClose };

  if (isPending || !draft) {
    return (
      <Sheet label="Imported draft" eyebrow="Review import" title="Loading" onClose={onClose} wide>
        <Skeleton className="h-40" />
      </Sheet>
    );
  }
  const p = draft.payload;
  const entry = p.kind === "entry" ? { ...p.entry, ...edits } : undefined;
  const pending = draft.status === "pending";

  return (
    <Sheet
      label="Imported draft"
      eyebrow={`Review import · ${kindLabel(draft)}`}
      title={titleOf(draft)}
      onClose={onClose}
      wide
    >
      <p className="mb-6 text-[0.8rem] leading-relaxed break-words text-faint">
        From {segments(draft.origin).slice(-3).join(" / ")}
        {draft.anchor && draft.anchor !== "whole file" && draft.anchor !== "session"
          ? `, “${draft.anchor}”`
          : ""}
        . Read as: {draft.note}.
      </p>

      {draft.triage && (
        <div className="mb-6 rounded-lg border border-line px-4 py-3" data-testid="draft-reasons">
          <ul className="space-y-1.5">
            {draft.triage.reasons.map((r, i) => (
              <li key={i} className={cx("text-[0.85rem] leading-relaxed", reasonTone[r.kind])}>
                {r.text}
              </li>
            ))}
          </ul>
          {draft.triage.supersede && pending && (
            <fieldset className="mt-4">
              <legend className="mb-2 text-[0.85rem] text-muted">Keep it as</legend>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
                {[
                  { v: false, label: "History: no longer how things are" },
                  { v: true, label: "Current: this is still how it is set up" },
                ].map((o) => (
                  <label
                    key={o.label}
                    className="flex min-h-11 cursor-pointer items-center gap-2 text-[0.9rem] text-ink"
                  >
                    <input
                      type="radio"
                      name="keep-as"
                      checked={asCurrent === o.v}
                      onChange={() => setAsCurrent(o.v)}
                      className="h-4 w-4 accent-[var(--color-gold)]"
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}

      {entry && pending && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate({ action: "accept", id: draft.id, edits, asCurrent }, done);
          }}
        >
          <TextField
            id="import-title"
            label="Title"
            value={entry.title}
            onChange={(e) => set({ title: e.target.value })}
            maxLength={200}
            required
          />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <div className="mb-5">
              <label htmlFor="import-kind" className="mb-2 block text-[0.85rem] text-muted">
                Kind
              </label>
              <select
                id="import-kind"
                value={entry.kind}
                onChange={(e) => set({ kind: e.target.value as MemoryKind })}
                className={fieldClass}
              >
                {MEMORY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {MEMORY_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="mb-5">
              <label htmlFor="import-project" className="mb-2 block text-[0.85rem] text-muted">
                Project
              </label>
              <input
                id="import-project"
                list="import-project-names"
                value={entry.projectName ?? ""}
                onChange={(e) => set({ projectName: e.target.value })}
                maxLength={80}
                placeholder="No project"
                className={fieldClass}
              />
              <datalist id="import-project-names">
                {projects.map((pr) => (
                  <option key={pr.id} value={pr.name} />
                ))}
              </datalist>
            </div>
            {entry.kind === "thread" && (
              <div className="mb-5">
                <label htmlFor="import-status" className="mb-2 block text-[0.85rem] text-muted">
                  Status
                </label>
                <select
                  id="import-status"
                  value={entry.status ?? "open"}
                  onChange={(e) => set({ status: e.target.value as "open" | "done" })}
                  className={fieldClass}
                >
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                </select>
              </div>
            )}
            <div className="mb-5">
              <label htmlFor="import-date" className="mb-2 block text-[0.85rem] text-muted">
                When
              </label>
              <input
                id="import-date"
                type="date"
                value={(entry.happenedAt ?? "").slice(0, 10)}
                onChange={(e) =>
                  e.target.value &&
                  set({ happenedAt: new Date(`${e.target.value}T12:00:00Z`).toISOString() })
                }
                className={fieldClass}
              />
            </div>
          </div>
          <div className="mb-5">
            <label htmlFor="import-body" className="mb-2 block text-[0.85rem] text-muted">
              Details
            </label>
            <textarea
              id="import-body"
              value={entry.body ?? ""}
              onChange={(e) => set({ body: e.target.value })}
              rows={12}
              maxLength={20000}
              className="w-full rounded-lg border border-line-strong bg-bg px-4 py-3 font-mono text-[0.82rem] leading-relaxed text-ink focus:border-gold/60 focus:outline-none"
            />
            <p className="mt-2 text-[0.78rem] leading-relaxed text-faint">
              Anything that looked like a password or key was replaced with [hidden] before it
              reached this server.
            </p>
          </div>
          <FormError error={decide.error} />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" tone="primary" disabled={decide.isPending}>
              {Object.keys(edits).length ? "Save with my changes" : "Remember this"}
            </Button>
            <Button
              disabled={decide.isPending}
              onClick={() => decide.mutate({ action: "reject", id: draft.id }, done)}
            >
              Leave it out
            </Button>
          </div>
        </form>
      )}

      {entry && !pending && (
        <pre className="mb-6 font-mono text-[0.82rem] leading-relaxed break-words whitespace-pre-wrap text-ink">
          {entry.body}
        </pre>
      )}

      {p.kind === "project" && (
        <p className="mb-6 text-[0.95rem] leading-relaxed whitespace-pre-wrap text-ink">
          {p.project.summary || "No summary in the file."}
        </p>
      )}

      {p.kind === "session" && (
        <>
          <p className="mb-4 text-[0.85rem] text-muted">{metaOf(draft)}. Kept word for word.</p>
          <ol className="mb-6 space-y-4">
            {p.session.messages.slice(0, 80).map((m) => (
              <li key={m.seq}>
                <span className="eyebrow mb-1 block">
                  {m.role === "you" ? "You" : m.role === "ai" ? "Claude" : m.role}
                </span>
                <p className="text-[0.9rem] leading-relaxed break-words whitespace-pre-wrap text-ink">
                  {m.text.length > 1500 ? `${m.text.slice(0, 1500)}…` : m.text}
                </p>
              </li>
            ))}
          </ol>
          {p.session.messages.length > 80 && (
            <p className="mb-6 text-[0.85rem] text-faint">
              And {p.session.messages.length - 80} more messages, all kept once you accept.
            </p>
          )}
        </>
      )}

      {!entry && pending && (
        <div className="flex flex-wrap gap-3">
          <FormError error={decide.error} />
          <Button
            tone="primary"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ action: "accept", id: draft.id }, done)}
          >
            {p.kind === "session" ? "Keep this session" : "Add this project"}
          </Button>
          <Button
            disabled={decide.isPending}
            onClick={() => decide.mutate({ action: "reject", id: draft.id }, done)}
          >
            Leave it out
          </Button>
        </div>
      )}

      {draft.status === "rejected" && (
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate({ action: "reopen", id: draft.id }, done)}
        >
          Reconsider
        </Button>
      )}
      {draft.status === "accepted" && (
        <p className="text-[0.85rem] text-muted">
          Remembered {day(draft.decidedAt)}. To undo, delete it in{" "}
          <Link to="/memory" className="text-gold underline underline-offset-4">
            Memory
          </Link>
          .
        </p>
      )}
    </Sheet>
  );
}

/* ---------- Sorting for review ---------- */

/** The headline reason, shown on the row; conflicts first, since they matter most. */
function leadReason(d: ImportDraft): ImportReason | undefined {
  const r = d.triage?.reasons ?? [];
  return r.find((x) => x.kind === "conflict") ?? r[0];
}

const reasonTone: Record<ImportReason["kind"], string> = {
  conflict: "text-warn",
  duplicate: "text-muted",
  unrelated: "text-muted",
  unverified: "text-muted",
  check: "text-muted",
  history: "text-faint",
  verified: "text-faint",
};

/** Drafts that are worth a look, by why, so each kind of question is answered once. */
const LOOK_GROUPS: {
  key: string;
  title: string;
  help: string;
  test: (d: ImportDraft) => boolean;
  keepLabel: string;
}[] = [
  {
    key: "earlier-setup",
    title: "Describes an earlier setup",
    help: "These say something different from what Hearth sees now (another machine, Windows paths, another port). Keeping them saves them as history: searchable, never shown as how things are now. Open one to keep it as current instead.",
    test: (d) => Boolean(d.triage?.supersede),
    keepLabel: "Keep as history",
  },
  {
    key: "old-mentions",
    title: "Open items that mention the earlier setup",
    help: "The setup they refer to has changed, but the problem itself may still be real. Keep the ones still open; leave out the ones the move already settled.",
    test: (d) =>
      !d.triage?.supersede && Boolean(d.triage?.reasons.some((r) => r.kind === "conflict")),
    keepLabel: "Keep",
  },
  {
    key: "unverified",
    title: "Can't be checked",
    help: "About things Hearth doesn't watch, so it can't confirm they are still set up this way.",
    test: (d) => Boolean(d.triage?.reasons.some((r) => r.kind === "unverified")),
    keepLabel: "Keep",
  },
  {
    key: "confirm",
    title: "Confirm they still apply",
    help: "Open items, how you work, and setup notes: true when written, worth a glance to make sure they still are.",
    test: () => true,
    keepLabel: "Keep",
  },
];

function Row({
  d,
  selected,
  onSelect,
  onOpen,
}: {
  d: ImportDraft;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onOpen: () => void;
}) {
  const reason = leadReason(d);
  const file = segments(d.origin).slice(-1)[0];
  return (
    <li className="flex items-start gap-3">
      {onSelect && (
        <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
          <span className="sr-only">Select “{titleOf(d)}”</span>
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-gold)]"
          />
        </label>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="group flex min-w-0 flex-1 flex-col gap-1 py-3 text-left"
      >
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Tag
            tone={
              d.payload.kind === "entry" &&
              d.payload.entry.kind === "thread" &&
              d.payload.entry.status !== "done"
                ? "gold"
                : "neutral"
            }
          >
            {kindLabel(d)}
          </Tag>
          <span className="min-w-0 text-[0.95rem] break-words text-ink group-hover:text-gold">
            {titleOf(d)}
          </span>
        </span>
        <span className="block text-[0.78rem] text-faint">
          {[metaOf(d), file].filter(Boolean).join(" · ")}
        </span>
        {reason && (
          <span
            className={cx(
              "block text-[0.8rem] leading-relaxed break-words",
              reasonTone[reason.kind],
            )}
          >
            {reason.text}
          </span>
        )}
      </button>
    </li>
  );
}

/** "Keep all" / "Leave out all" for a set of drafts, with a confirmation step. */
function BulkActions({
  ids,
  keepLabel = "Keep",
  only,
}: {
  ids: string[];
  keepLabel?: string;
  only?: "accept" | "reject";
}) {
  const decide = useImportDecision();
  const [confirm, setConfirm] = useState<"accept" | "reject" | null>(null);
  const n = ids.length;
  if (!n) return null;
  const words = {
    accept: n === 1 ? keepLabel : `${keepLabel} all ${n}`,
    reject: n === 1 ? "Leave out" : `Leave out all ${n}`,
  };
  return (
    <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
      {confirm ? (
        <>
          <span className="text-[0.85rem] text-muted">{words[confirm]}?</span>
          <Button
            tone="primary"
            disabled={decide.isPending}
            onClick={() =>
              decide.mutate(
                { action: "decide", ids, decision: confirm },
                { onSettled: () => setConfirm(null) },
              )
            }
          >
            Yes
          </Button>
          <Button tone="quiet" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          {only !== "accept" && (
            <Button
              tone={only === "reject" ? "outline" : "quiet"}
              onClick={() => setConfirm("reject")}
            >
              {words.reject}
            </Button>
          )}
          {only !== "reject" && (
            <Button onClick={() => setConfirm("accept")}>{words.accept}</Button>
          )}
        </>
      )}
      <FormError error={decide.error} />
    </div>
  );
}

function Tier({
  id,
  title,
  help,
  drafts,
  selected,
  onSelect,
  onOpen,
  children,
  actions,
}: {
  id: string;
  title: string;
  help: string;
  drafts: ImportDraft[];
  selected: Set<string>;
  onSelect: (ids: string[], on: boolean) => void;
  onOpen: (id: string) => void;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const all = drafts.length > 0 && drafts.every((d) => selected.has(d.id));
  return (
    <section id={id} aria-label={title} className="mb-14 scroll-mt-24">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
        <h2 className="eyebrow">
          {title} · {drafts.length}
        </h2>
        {drafts.length > 0 && (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[0.82rem] text-muted">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) =>
                onSelect(
                  drafts.map((d) => d.id),
                  e.target.checked,
                )
              }
              className="h-4 w-4 accent-[var(--color-gold)]"
            />
            Select all
          </label>
        )}
      </div>
      <p className="mb-4 max-w-2xl text-[0.85rem] leading-relaxed text-muted">{help}</p>
      {actions}
      {children ?? (
        <ul className="divide-y divide-line">
          {drafts.map((d) => (
            <Row
              key={d.id}
              d={d}
              selected={selected.has(d.id)}
              onSelect={(on) => onSelect([d.id], on)}
              onOpen={() => onOpen(d.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Waiting({ drafts, onOpen }: { drafts: ImportDraft[]; onOpen: (id: string) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const decide = useImportDecision();
  const select = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  // Drafts decided elsewhere drop out of the selection.
  const live = new Set(drafts.map((d) => d.id));
  const chosen = [...selected].filter((id) => live.has(id));

  const tiers = useMemo(() => {
    const confident = drafts.filter((d) => d.triage?.tier === "confident");
    const skip = drafts.filter((d) => d.triage?.tier === "skip");
    const look = drafts.filter((d) => !d.triage || d.triage.tier === "review");
    const groups: { key: string; drafts: ImportDraft[] }[] = [];
    const left = new Set(look.map((d) => d.id));
    for (const g of LOOK_GROUPS) {
      const these = look.filter((d) => left.has(d.id) && g.test(d));
      for (const d of these) left.delete(d.id);
      groups.push({ key: g.key, drafts: these });
    }
    return { confident, look, groups, skip };
  }, [drafts]);

  return (
    <>
      <nav aria-label="Sorted for review" className="mb-10 grid gap-3 sm:grid-cols-3">
        {[
          {
            href: "#ready",
            n: tiers.confident.length,
            label: "Ready to keep",
            note: "Dated history and records that check out",
          },
          {
            href: "#look",
            n: tiers.look.length,
            label: "Worth a look",
            note: "Conflicts, open items, things to confirm",
          },
          {
            href: "#skip",
            n: tiers.skip.length,
            label: "Probably leave out",
            note: "Duplicates and unrelated material",
          },
        ].map((t) => (
          <a
            key={t.href}
            href={t.href}
            className="rounded-lg border border-line px-4 py-3 transition-colors duration-200 hover:border-gold/50"
          >
            <span className="block font-display text-[1.6rem] leading-none text-ink">{t.n}</span>
            <span className="mt-1 block text-[0.9rem] text-gold">{t.label}</span>
            <span className="block text-[0.78rem] text-faint">{t.note}</span>
          </a>
        ))}
      </nav>

      <Tier
        id="ready"
        title="Ready to keep"
        help="Dated history (it was true when written, whatever has changed since), closed items, past sessions mostly about the homelab, and notes that agree with what Hearth sees. Older setup among them is saved as history automatically."
        drafts={tiers.confident}
        selected={selected}
        onSelect={select}
        onOpen={onOpen}
        actions={<BulkActions ids={tiers.confident.map((d) => d.id)} only="accept" />}
      />

      <Tier
        id="look"
        title="Worth a look"
        help="Grouped by the question each one raises, so you can answer it once for the group or open any to decide one by one."
        drafts={tiers.look}
        selected={selected}
        onSelect={select}
        onOpen={onOpen}
      >
        {tiers.groups.map((g) => {
          const meta = LOOK_GROUPS.find((x) => x.key === g.key)!;
          if (!g.drafts.length) return null;
          return (
            <div key={g.key} className="mb-10" role="group" aria-label={meta.title}>
              <h3 className="mb-1 text-[0.95rem] text-ink">
                {meta.title} <span className="text-faint">· {g.drafts.length}</span>
              </h3>
              <p className="mb-3 max-w-2xl text-[0.82rem] leading-relaxed text-muted">
                {meta.help}
              </p>
              <BulkActions ids={g.drafts.map((d) => d.id)} keepLabel={meta.keepLabel} />
              <ul className="divide-y divide-line border-y border-line">
                {g.drafts.map((d) => (
                  <Row
                    key={d.id}
                    d={d}
                    selected={selected.has(d.id)}
                    onSelect={(on) => select([d.id], on)}
                    onOpen={() => onOpen(d.id)}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </Tier>

      <Tier
        id="skip"
        title="Probably leave out"
        help="Copies of something with more detail (another draft, a memory you already have, a session already saved) and material that is mostly not about the homelab."
        drafts={tiers.skip}
        selected={selected}
        onSelect={select}
        onOpen={onOpen}
        actions={<BulkActions ids={tiers.skip.map((d) => d.id)} only="reject" />}
      />

      {chosen.length > 0 && (
        <div
          role="region"
          aria-label="Selected drafts"
          className="sticky bottom-20 z-10 mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-gold/40 bg-panel px-4 py-3 shadow-lg lg:bottom-6"
        >
          <span className="text-[0.9rem] text-ink">{chosen.length} selected</span>
          <span className="flex-1" />
          <Button tone="quiet" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button
            disabled={decide.isPending}
            onClick={() =>
              decide.mutate(
                { action: "decide", ids: chosen, decision: "reject" },
                { onSuccess: () => setSelected(new Set()) },
              )
            }
          >
            Leave out
          </Button>
          <Button
            tone="primary"
            disabled={decide.isPending}
            onClick={() =>
              decide.mutate(
                { action: "decide", ids: chosen, decision: "accept" },
                { onSuccess: () => setSelected(new Set()) },
              )
            }
          >
            Keep
          </Button>
          <FormError error={decide.error} />
        </div>
      )}
    </>
  );
}

/** Remembered and left-out drafts, by the file they came from. */
function Decided({ drafts, onOpen }: { drafts: ImportDraft[]; onOpen: (id: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, ImportDraft[]>();
    for (const d of drafts) {
      const key = groupOf(d);
      map.set(key, [...(map.get(key) ?? []), d]);
    }
    return [...map.entries()];
  }, [drafts]);
  return (
    <>
      {groups.map(([key, list]) => (
        <Section key={key} title={groupLabel(key)}>
          <ul className="divide-y divide-line">
            {list.map((d) => (
              <Row key={d.id} d={d} onOpen={() => onOpen(d.id)} />
            ))}
          </ul>
        </Section>
      ))}
    </>
  );
}

export function ImportReviewPage() {
  const [status, setStatus] = useState<Status>("pending");
  const [open, setOpen] = useState<string | null>(null);
  const [file, setFile] = useState("");
  const summary = useImportSummary().data;
  const drafts = useImportDrafts(status);

  const files = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of drafts.data ?? []) seen.set(groupOf(d), groupLabel(groupOf(d)));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [drafts.data]);
  const shown = (drafts.data ?? []).filter((d) => !file || groupOf(d) === file);

  return (
    <>
      <Link
        to="/memory"
        className="mb-6 inline-flex min-h-11 items-center gap-1 text-[0.85rem] text-muted hover:text-gold"
      >
        <ChevronLeft strokeWidth={1.25} className="h-4 w-4" /> Memory
      </Link>
      <PageHeader
        eyebrow="Memory"
        title="Review your notes"
        subtitle="Your existing notes and past sessions, read into drafts and sorted by how sure Hearth is about each. Nothing is remembered until you keep it, and the original files are never changed."
      />
      <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <Segmented<Status>
          label="Show"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setFile("");
          }}
          options={[
            { value: "pending", label: `Waiting${summary ? ` (${summary.pending})` : ""}` },
            { value: "accepted", label: `Remembered${summary ? ` (${summary.accepted})` : ""}` },
            { value: "rejected", label: `Left out${summary ? ` (${summary.rejected})` : ""}` },
          ]}
        />
        {files.length > 1 && (
          <div className="lg:w-72">
            <label htmlFor="import-file" className="sr-only">
              Source
            </label>
            <select
              id="import-file"
              value={file}
              onChange={(e) => setFile(e.target.value)}
              className={fieldClass}
            >
              <option value="">Every source</option>
              {files.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {drafts.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          title={
            status === "pending"
              ? "Nothing waiting"
              : status === "accepted"
                ? "Nothing remembered from an import yet"
                : "Nothing left out"
          }
        >
          {status === "pending"
            ? "When an importer reads your notes, its drafts wait here for you."
            : "Decisions you make on imported drafts show up here."}
        </EmptyState>
      ) : status === "pending" ? (
        <Waiting drafts={shown} onOpen={setOpen} />
      ) : (
        <Decided drafts={shown} onOpen={setOpen} />
      )}

      {open && <DraftSheet key={open} id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
