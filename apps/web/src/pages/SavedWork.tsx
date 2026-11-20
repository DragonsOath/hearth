import { useState } from "react";
import { ToolImage } from "../components/panels/ToolImage";
import { Link, useSearchParams } from "react-router";
import { ClipboardList, FolderOpen, NotebookPen, Pencil, Search, Trash2 } from "lucide-react";
import type { MemoryEntry, WorkspaceSummary } from "@dragon-control/core";
import { Button, EmptyState, PageHeader, Segmented, Sheet, Skeleton, Tag } from "../components/ui";
import { DeleteFileDialog, EditDialog } from "../components/workspace/dialogs";
import { useOpenWorkspace } from "../components/workspace/dock";
import { FORGE_EXAMPLES, useForgeWaiting } from "../components/workspace/forge";
import { useCave } from "../components/shell/cave-context";
import { useAiName } from "../data/api";
import { useMemoryEntries } from "../data/memory";
import {
  useDeleteWorkingFile,
  useEditWorkspace,
  useSavedWorkspaces,
  useTemporaryWorkspaces,
} from "../data/workspaces";
import { EmberMark } from "../components/ember/EmberMark";

/**
 * The Forge (checklist 46.19; was Saved work, feature request 20.9): what it is and what to ask
 * Ember for, the sheets waiting for your choices, then the Forge Library (saved sheets, still
 * interactive, in your folders), the sheets open now, and notes (reference in Memory). Opening a
 * sheet brings it back beside its conversation with its list and choices.
 */

type Tab = "files" | "notes" | "temporary";

const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
    : "";

function Progress({ w }: { w: WorkspaceSummary }) {
  return (
    <span className="flex items-center gap-2 text-[0.76rem] text-faint tabular-nums">
      <span className="h-1 w-16 overflow-hidden rounded-full bg-line" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-gold"
          style={{ width: `${w.items ? (w.decided / w.items) * 100 : 0}%` }}
        />
      </span>
      {w.decided} of {w.items} decided
    </span>
  );
}

function FileRow({
  w,
  onOpen,
  onEdit,
  onDelete,
}: {
  w: WorkspaceSummary;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className="flex flex-col gap-3 border-b border-line py-4 last:border-b-0 sm:flex-row sm:items-center"
      data-testid="working-file"
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 items-center gap-2 text-left font-display text-[1.2rem] leading-tight text-ink hover:text-gold"
        >
          <ClipboardList strokeWidth={1.4} className="h-4 w-4 shrink-0 text-gold" />
          <span className="truncate">{w.title}</span>
        </button>
        {w.description && (
          <p className="mt-1 line-clamp-2 text-[0.82rem] text-muted">{w.description}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Progress w={w} />
          <span className="text-[0.76rem] text-faint">Saved {when(w.savedAt)}</span>
          {w.submittedAt && (
            <span className="text-[0.76rem] text-faint">Submitted {when(w.submittedAt)}</span>
          )}
          {w.state !== "closed" && (
            <Tag tone="gold">{w.state === "open" ? "Open" : "Minimized"}</Tag>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button tone="primary" onClick={onOpen} className="min-h-10 px-4">
          Open
        </Button>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${w.title}`}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-gold"
        >
          <Pencil strokeWidth={1.5} className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${w.title}`}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:text-bad"
        >
          <Trash2 strokeWidth={1.5} className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

function WorkingFiles() {
  const files = useSavedWorkspaces();
  const open = useOpenWorkspace();
  const edit = useEditWorkspace();
  const remove = useDeleteWorkingFile();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<WorkspaceSummary | undefined>();
  const [deleting, setDeleting] = useState<WorkspaceSummary | undefined>();
  const list = files.data ?? [];
  const folders = [
    ...new Set(list.map((w) => w.folder).filter((f): f is string => Boolean(f))),
  ].sort();
  const s = q.trim().toLowerCase();
  const shown = s
    ? list.filter((w) =>
        `${w.title} ${w.folder ?? ""} ${w.description ?? ""}`.toLowerCase().includes(s),
      )
    : list;
  const groups = [
    ...folders.map((f) => ({ name: f, items: shown.filter((w) => w.folder === f) })),
    { name: "", items: shown.filter((w) => !w.folder) },
  ].filter((g) => g.items.length);

  if (files.isLoading) return <Skeleton className="h-40" />;
  if (!list.length)
    return (
      <EmptyState title="Nothing in the Forge Library yet">
        When Ember opens a Forge sheet you want to keep, use Save in its panel and choose Working
        file. It stays interactive here, with its list and your choices.
      </EmptyState>
    );
  return (
    <>
      <label className="mb-6 flex min-h-11 max-w-md items-center gap-2 rounded-lg border border-line-strong px-3 focus-within:border-gold">
        <Search strokeWidth={1.5} className="h-4 w-4 text-faint" />
        <span className="sr-only">Search the Forge Library</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the Forge Library"
          className="min-w-0 flex-1 bg-transparent text-[0.9rem] text-ink placeholder:text-faint focus:outline-none"
        />
      </label>
      {groups.map((g) => (
        <section key={g.name || "none"} className="mb-8" aria-label={g.name || "Not in a folder"}>
          <h2 className="eyebrow mb-1 flex items-center gap-2">
            <FolderOpen strokeWidth={1.4} className="h-3.5 w-3.5" />
            {g.name || "Not in a folder"}
            <span className="text-faint">{g.items.length}</span>
          </h2>
          <ul>
            {g.items.map((w) => (
              <FileRow
                key={w.id}
                w={w}
                onOpen={() => open(w)}
                onEdit={() => setEditing(w)}
                onDelete={() => setDeleting(w)}
              />
            ))}
          </ul>
        </section>
      ))}
      {!groups.length && <p className="text-[0.9rem] text-faint">No working files match.</p>}
      {editing && (
        <EditDialog
          title={editing.title}
          description={editing.description}
          folder={editing.folder}
          folders={folders}
          busy={edit.isPending}
          error={(edit.error as Error | null)?.message}
          onCancel={() => setEditing(undefined)}
          onSave={(patch) =>
            edit.mutate({ id: editing.id, ...patch }, { onSuccess: () => setEditing(undefined) })
          }
        />
      )}
      {deleting && (
        <DeleteFileDialog
          title={deleting.title}
          busy={remove.isPending}
          onCancel={() => setDeleting(undefined)}
          onDelete={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(undefined) })}
        />
      )}
    </>
  );
}

function Notes() {
  const notes = useMemoryEntries({ kind: "note" });
  const [reading, setReading] = useState<MemoryEntry | undefined>();
  const list = notes.data ?? [];
  if (notes.isLoading) return <Skeleton className="h-40" />;
  if (!list.length)
    return (
      <EmptyState title="No notes yet">
        Save a workspace as a note to keep what it found as reference. Notes live in Memory, where
        Ember can find them later.
      </EmptyState>
    );
  return (
    <>
      <ul>
        {list.map((n) => {
          const fromWorkspace = n.links.some((l) => l.ref.startsWith("workspace:"));
          return (
            <li
              key={n.id}
              className="border-b border-line py-4 last:border-b-0"
              data-testid="saved-note"
            >
              <button
                type="button"
                onClick={() => setReading(n)}
                className="flex items-center gap-2 text-left font-display text-[1.15rem] leading-tight text-ink hover:text-gold"
              >
                <NotebookPen strokeWidth={1.4} className="h-4 w-4 shrink-0 text-gold" />
                {n.title}
              </button>
              <p className="mt-1 line-clamp-2 text-[0.82rem] text-muted">
                {n.body.split("\n").find((l) => l.trim() && !l.startsWith("|")) ?? ""}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[0.76rem] text-faint">
                <span>{when(n.createdAt)}</span>
                {fromWorkspace && <Tag>From a workspace</Tag>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-6 text-[0.84rem] text-muted">
        Notes are part of Memory.{" "}
        <Link to="/memory" className="text-gold underline underline-offset-4">
          Edit or delete them there
        </Link>
        .
      </p>
      {reading && (
        <Sheet
          label="Note"
          eyebrow="Note"
          title={reading.title}
          wide
          onClose={() => setReading(undefined)}
        >
          <pre className="font-sans text-[0.84rem] leading-relaxed whitespace-pre-wrap text-ink/90">
            {reading.body}
          </pre>
        </Sheet>
      )}
    </>
  );
}

function Temporary() {
  const temp = useTemporaryWorkspaces();
  const open = useOpenWorkspace();
  const list = temp.data ?? [];
  if (temp.isLoading) return <Skeleton className="h-40" />;
  if (!list.length)
    return (
      <EmptyState title="No Forge sheets open">
        Ember opens one beside the conversation when a task has many items to go through, or
        whenever you ask for the Forge.
      </EmptyState>
    );
  return (
    <>
      <p className="mb-4 max-w-xl text-[0.86rem] text-muted">
        Open now or minimized, beside their conversations. Untouched ones are cleared after 30 days;
        save one as a working file to keep it.
      </p>
      <ul>
        {list.map((w) => (
          <li
            key={w.id}
            className="flex flex-col gap-3 border-b border-line py-4 last:border-b-0 sm:flex-row sm:items-center"
            data-testid="temporary-workspace"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-[1.15rem] text-ink">{w.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                <Progress w={w} />
                <span className="text-[0.76rem] text-faint">Updated {when(w.updatedAt)}</span>
                <Tag>{w.state === "minimized" ? "Minimized" : "Open"}</Tag>
              </div>
            </div>
            <Button onClick={() => open(w)} className="min-h-10 px-4">
              Open
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** What the Forge is for, and things to ask for that Ember can really build. */
function ForgeIntro({ aiName }: { aiName: string }) {
  const cave = useCave();
  return (
    <section
      className="mb-8 rounded-xl border border-gold/30 bg-gold/[0.04] p-4 sm:p-5"
      aria-label="What the Forge is"
      data-testid="forge-intro"
    >
      <div className="flex items-start gap-3">
        <ToolImage id="forge" className="h-12 w-12" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-[0.9rem] text-ink">
            Ask {aiName} for anything with a lot of items to go through: it opens a Forge sheet
            beside the chat with every item, what it found and what it would do. Search, filter,
            pick for each one, and send your choices back. Save a sheet to keep it here and carry on
            later.
          </p>
          <p className="text-[0.78rem] text-faint">Try asking:</p>
          <ul className="flex flex-wrap gap-2" aria-label="Things to ask for">
            {FORGE_EXAMPLES.map((e) => (
              <li key={e}>
                <button
                  type="button"
                  onClick={() => cave.ask(e)}
                  className="min-h-9 rounded-full border border-line-strong px-3 text-left text-[0.8rem] text-muted hover:border-gold/60 hover:text-gold"
                  data-testid="forge-example"
                >
                  {e}
                  <EmberMark />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Sheets waiting for your choices, first, so unfinished work is never lost. */
function Waiting() {
  const waiting = useForgeWaiting();
  const open = useOpenWorkspace();
  if (!waiting.length) return null;
  return (
    <section className="mb-8" aria-label="Waiting for you" data-testid="forge-waiting">
      <h2 className="eyebrow mb-1">Waiting for you · {waiting.length}</h2>
      <ul>
        {waiting.map((w) => (
          <li
            key={w.id}
            className="flex flex-col gap-3 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-[1.1rem] text-ink">{w.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                <Progress w={w} />
                <span className="text-[0.76rem] text-faint">
                  {w.kind === "saved" ? "In the Library" : "Not saved yet"} · updated{" "}
                  {when(w.updatedAt)}
                </span>
              </div>
            </div>
            <Button tone="primary" onClick={() => open(w)} className="min-h-10 px-4">
              Carry on
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SavedWorkPage() {
  const aiName = useAiName();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = raw === "notes" || raw === "temporary" ? raw : "files";
  const files = useSavedWorkspaces();
  const temp = useTemporaryWorkspaces();
  const notes = useMemoryEntries({ kind: "note" });
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        eyebrow="Ember"
        title="The Forge"
        subtitle={`Where you and ${aiName} work through things together: ${aiName} lays out what it found with what it would do, you make each call, and nothing changes until you approve a plan.`}
      />
      <ForgeIntro aiName={aiName} />
      <Waiting />
      <div className="mb-8">
        <Segmented<Tab>
          label="Show"
          value={tab}
          onChange={(t) => {
            const next = new URLSearchParams(params);
            if (t === "files") next.delete("tab");
            else next.set("tab", t);
            setParams(next, { replace: true });
          }}
          options={[
            { value: "files", label: "Library", count: files.data?.length },
            { value: "temporary", label: "Open now", count: temp.data?.length },
            { value: "notes", label: "Notes", count: notes.data?.length },
          ]}
        />
      </div>
      {tab === "files" && <WorkingFiles />}
      {tab === "notes" && <Notes />}
      {tab === "temporary" && <Temporary />}
    </div>
  );
}
