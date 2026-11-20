import { useAiName } from "../data/api";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Lightbulb } from "lucide-react";
import {
  TODO_CATEGORIES,
  TODO_CATEGORY_LABEL,
  TODO_PRIORITIES,
  TODO_PRIORITY_LABEL,
  TODO_STATUS_LABEL,
  type Service,
  type TodoCategory,
  type TodoCheck,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "@dragon-control/core";
import {
  Button,
  EmptyState,
  LinkButton,
  PageHeader,
  Rows,
  Section,
  Segmented,
  Sheet,
  Tag,
  cx,
} from "../components/ui";
import { useWorkspace } from "../data/api";
import { useProjects } from "../data/projects";
import {
  useAddTodo,
  useSaveSuggestion,
  useTodo,
  useTodos,
  useUpdateTodo,
  workOnHref,
  type TodoDraft,
} from "../data/todos";
import { ago } from "../lib/format";
import { FormError } from "./auth/AuthFrame";

/**
 * Issues & ideas: what we need to fix, what there is to do, and what would be
 * worth building. Ember notices things as it works; they are only
 * suggestions until you add them. Filters live in the address, so a filtered
 * list can be bookmarked or opened beside something else.
 */

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

const VIEWS: Record<string, { label: string; statuses: TodoStatus[] }> = {
  active: { label: "To deal with", statuses: ["open", "investigating", "waiting-approval"] },
  deferred: { label: "Deferred", statuses: ["deferred"] },
  resolved: { label: "Resolved", statuses: ["resolved"] },
  dismissed: { label: "Dismissed", statuses: ["dismissed"] },
  all: {
    label: "Everything",
    statuses: ["open", "investigating", "waiting-approval", "deferred", "resolved", "dismissed"],
  },
};

const CHECK_TEXT: Record<TodoCheck["state"], { label: string; cls: string }> = {
  active: { label: "Still happening", cls: "text-warn" },
  "looks-resolved": { label: "Looks resolved", cls: "text-live" },
  unverified: { label: "Not verified", cls: "text-faint" },
};

const PRIORITY_DOT: Record<TodoPriority, string> = {
  high: "bg-amber",
  medium: "bg-gold/70",
  low: "bg-line-strong",
};

function statusTag(status: TodoStatus) {
  const tone =
    status === "waiting-approval" || status === "investigating"
      ? "gold"
      : status === "open"
        ? "warn"
        : "neutral";
  return <Tag tone={tone}>{TODO_STATUS_LABEL[status]}</Tag>;
}

function CheckLine({ check }: { check?: TodoCheck }) {
  if (!check) return null;
  const c = CHECK_TEXT[check.state];
  return <span className={cx("text-[0.78rem]", c.cls)}>{c.label}</span>;
}

function systemNames(ids: string[], services: Service[]) {
  return ids.map((id) => services.find((s) => s.id === id)?.name ?? id);
}

function Suggestions({ items }: { items: TodoItem[] }) {
  const aiName = useAiName();
  const save = useSaveSuggestion();
  const update = useUpdateTodo();
  if (!items.length) return null;
  const busy = save.isPending || update.isPending;
  return (
    <Section title={`Noticed by ${aiName}, not saved`}>
      <ul
        className="divide-y divide-line rounded-xl border border-line"
        data-testid="todo-suggestions"
      >
        {items.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <Lightbulb strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[0.92rem] text-ink">
                <span className="text-faint">#{t.number} </span>
                {t.title}
              </p>
              <p className="text-[0.76rem] text-faint">
                {TODO_CATEGORY_LABEL[t.category]} · noticed {ago(t.createdAt).toLowerCase()}
                {t.conversationId ? (
                  <>
                    {" · "}
                    <Link to={`/ask/${t.conversationId}`} className="underline underline-offset-4">
                      where
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-10 px-3.5"
                tone="primary"
                disabled={busy}
                onClick={() => save.mutate({ id: t.id })}
                aria-label={`Add #${t.number} to the list`}
              >
                Add
              </Button>
              <Button
                className="min-h-10 px-3.5"
                disabled={busy}
                onClick={() => save.mutate({ id: t.id, deferred: true })}
                aria-label={`Save #${t.number} for later`}
              >
                Later
              </Button>
              <Button
                className="min-h-10 px-3.5"
                tone="quiet"
                disabled={busy}
                onClick={() => update.mutate({ id: t.id, status: "dismissed" })}
                aria-label={`Ignore #${t.number}`}
              >
                Ignore
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function AddItem({ services, onClose }: { services: Service[]; onClose: () => void }) {
  const add = useAddTodo();
  const projects = useProjects();
  const [draft, setDraft] = useState<TodoDraft>({
    category: "issue",
    title: "",
    priority: "medium",
  });
  const [system, setSystem] = useState("");
  const set = (patch: Partial<TodoDraft>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <Sheet label="Add to the to-do list" eyebrow="To-do" title="Add an item" onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(
            {
              ...draft,
              title: draft.title.trim(),
              description: draft.description?.trim() || undefined,
              services: system ? [system] : undefined,
              projectId: draft.projectId || undefined,
            },
            { onSuccess: onClose },
          );
        }}
      >
        <div>
          <p className="mb-2 text-[0.82rem] text-muted">Kind</p>
          <Segmented
            label="Kind"
            value={draft.category}
            options={TODO_CATEGORIES.map((c) => ({ value: c, label: TODO_CATEGORY_LABEL[c] }))}
            onChange={(category) =>
              set({ category, priority: category === "issue" ? "medium" : "low" })
            }
          />
        </div>
        <div>
          <label htmlFor="todo-title" className="mb-1 block text-[0.82rem] text-muted">
            Title
          </label>
          <input
            id="todo-title"
            required
            minLength={3}
            maxLength={160}
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Title"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="todo-description" className="mb-1 block text-[0.82rem] text-muted">
            Details (optional)
          </label>
          <textarea
            id="todo-description"
            rows={3}
            maxLength={2000}
            value={draft.description ?? ""}
            onChange={(e) => set({ description: e.target.value })}
            className={cx(field, "py-2")}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="todo-system" className="mb-1 block text-[0.82rem] text-muted">
              System (optional)
            </label>
            <select
              id="todo-system"
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              className={field}
            >
              <option value="">None</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="todo-project" className="mb-1 block text-[0.82rem] text-muted">
              Project (optional)
            </label>
            <select
              id="todo-project"
              value={draft.projectId ?? ""}
              onChange={(e) => set({ projectId: e.target.value })}
              className={field}
            >
              <option value="">None</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <p className="mb-2 text-[0.82rem] text-muted">Priority</p>
          <Segmented
            label="Priority"
            value={draft.priority ?? "medium"}
            options={TODO_PRIORITIES.map((p) => ({ value: p, label: TODO_PRIORITY_LABEL[p] }))}
            onChange={(priority) => set({ priority })}
          />
        </div>
        <label className="flex min-h-10 items-center gap-2.5 text-[0.88rem] text-ink">
          <input
            type="checkbox"
            checked={draft.status === "deferred"}
            onChange={(e) => set({ status: e.target.checked ? "deferred" : "open" })}
            className="accent-[var(--color-gold)]"
          />
          For later (deferred)
        </label>
        <FormError error={add.error} />
        <div className="flex flex-wrap gap-3">
          <Button
            tone="primary"
            type="submit"
            disabled={add.isPending || draft.title.trim().length < 3}
          >
            Add to the list
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  );
}

function ItemSheet({
  id,
  services,
  onClose,
}: {
  id: string;
  services: Service[];
  onClose: () => void;
}) {
  const aiName = useAiName();
  const item = useTodo(id);
  const update = useUpdateTodo();
  const projects = useProjects();
  const [note, setNote] = useState("");
  const d = item.data;
  const project = d?.projectId ? projects.data?.find((p) => p.id === d.projectId) : undefined;
  const closed = d && (d.status === "resolved" || d.status === "dismissed");
  const act = (status: Exclude<TodoStatus, "suggested">) =>
    d && update.mutate({ id: d.id, status });
  return (
    <Sheet
      label={d ? `To-do #${d.number}` : "To-do item"}
      eyebrow={d ? `#${d.number} · ${TODO_CATEGORY_LABEL[d.category]}` : "To-do"}
      title={d?.title ?? "Loading"}
      onClose={onClose}
      wide
    >
      {d && (
        <div className="grid gap-6" data-testid="todo-detail">
          <div className="flex flex-wrap items-center gap-2">
            {d.savedAt ? statusTag(d.status) : <Tag>Suggestion, not saved</Tag>}
            <Tag>{TODO_PRIORITY_LABEL[d.priority]} priority</Tag>
            {d.source === "agent" && <Tag>Noticed by {aiName}</Tag>}
          </div>
          {d.check && (
            <div className="rounded-lg border border-line px-4 py-3">
              <p className="text-[0.86rem]">
                <CheckLine check={d.check} />
              </p>
              <p className="mt-1 text-[0.8rem] leading-relaxed text-muted">{d.check.detail}</p>
            </div>
          )}
          {d.description && (
            <p className="text-[0.9rem] leading-relaxed whitespace-pre-wrap text-ink">
              {d.description}
            </p>
          )}
          {d.nextAction && (
            <p className="text-[0.86rem] text-muted">
              <span className="text-faint">Next: </span>
              {d.nextAction}
            </p>
          )}
          <dl className="grid gap-2 text-[0.84rem]">
            {d.services.length > 0 && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">Systems</dt>
                <dd className="flex flex-wrap gap-x-3">
                  {d.services.map((s) => (
                    <Link
                      key={s}
                      to={`/services/${s}`}
                      className="text-ink underline underline-offset-4"
                    >
                      {systemNames([s], services)[0]}
                    </Link>
                  ))}
                </dd>
              </div>
            )}
            {project && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">Project</dt>
                <dd>
                  <Link
                    to={`/projects/${project.id}`}
                    className="text-ink underline underline-offset-4"
                  >
                    {project.name}
                  </Link>
                </dd>
              </div>
            )}
            {d.jobs.length > 0 && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">Plans</dt>
                <dd className="grid gap-1">
                  {d.jobs.map((j) => (
                    <Link
                      key={j.id}
                      to={`/jobs/${j.id}`}
                      className="text-ink underline underline-offset-4"
                    >
                      {j.title} ({j.status.replace("-", " ")})
                    </Link>
                  ))}
                </dd>
              </div>
            )}
            {d.conversationId && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-faint">Came up in</dt>
                <dd>
                  <Link
                    to={`/ask/${d.conversationId}`}
                    className="text-ink underline underline-offset-4"
                  >
                    the conversation
                  </Link>
                </dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-faint">Added</dt>
              <dd className="text-muted">{ago(d.savedAt ?? d.createdAt)}</dd>
            </div>
          </dl>
          {d.evidence.length > 0 && (
            <div>
              <p className="mb-1.5 text-[0.8rem] text-faint">Evidence when it was noted</p>
              <ul className="grid gap-1 text-[0.82rem] text-muted">
                {d.evidence.map((e, i) => (
                  <li key={i}>
                    {e.label}
                    <span className="text-faint">
                      {" "}
                      · {e.kind === "live" ? "checked live" : e.kind}
                      {e.at ? `, ${ago(e.at).toLowerCase()}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {!closed && (
                <LinkButton to={workOnHref(d)} tone="primary">
                  Work on it with {aiName}
                </LinkButton>
              )}
              {!d.savedAt && d.status === "suggested" && (
                <Button onClick={() => act("open")} disabled={update.isPending}>
                  Add to the list
                </Button>
              )}
              {!closed && d.savedAt && (
                <Button onClick={() => act("resolved")} disabled={update.isPending}>
                  Mark resolved
                </Button>
              )}
              {d.status !== "deferred" && !closed && d.savedAt && (
                <Button onClick={() => act("deferred")} disabled={update.isPending}>
                  Defer
                </Button>
              )}
              {(closed || d.status === "deferred") && (
                <Button onClick={() => act("open")} disabled={update.isPending}>
                  Reopen
                </Button>
              )}
              {!closed && (
                <Button tone="quiet" onClick={() => act("dismissed")} disabled={update.isPending}>
                  Dismiss
                </Button>
              )}
            </div>
            <p className="text-[0.76rem] text-faint">
              Working on it in Ember picks up from its history. Any change still needs your approval
              of the exact plan.
            </p>
            <div>
              <p className="mb-2 text-[0.82rem] text-muted">Priority</p>
              <Segmented
                label="Priority"
                value={d.priority}
                options={TODO_PRIORITIES.map((p) => ({ value: p, label: TODO_PRIORITY_LABEL[p] }))}
                onChange={(priority) => update.mutate({ id: d.id, priority })}
              />
            </div>
            <FormError error={update.error} />
          </div>

          <div>
            <p className="mb-2 text-[0.82rem] text-muted">History</p>
            <ol className="grid gap-2 border-l border-line pl-4" data-testid="todo-history">
              {d.history.map((h, i) => (
                <li key={i} className="text-[0.82rem] leading-relaxed">
                  <span className="text-faint">
                    {ago(h.at)} ·{" "}
                    {h.actor === "you" ? "You" : h.actor === "agent" ? aiName : "Hearth"}:{" "}
                  </span>
                  <span className="text-ink">{h.text}</span>
                </li>
              ))}
            </ol>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!note.trim()) return;
                update.mutate({ id: d.id, note: note.trim() }, { onSuccess: () => setNote("") });
              }}
            >
              <label htmlFor="todo-note" className="sr-only">
                Add a note
              </label>
              <input
                id="todo-note"
                value={note}
                maxLength={1000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note"
                className={field}
              />
              <Button type="submit" disabled={!note.trim() || update.isPending}>
                Add
              </Button>
            </form>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function TodoPage() {
  const aiName = useAiName();
  const [params, setParams] = useSearchParams();
  const todos = useTodos({ suggestions: true });
  const ws = useWorkspace();
  const projects = useProjects();
  const [adding, setAdding] = useState(false);
  const services = [...(ws.data?.services ?? []), ...(ws.data?.inactiveServices ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  const category = (params.get("category") ?? "all") as TodoCategory | "all";
  const view = params.get("view") && VIEWS[params.get("view")!] ? params.get("view")! : "active";
  const priority = (params.get("priority") ?? "") as TodoPriority | "";
  const project = params.get("project") ?? "";
  const system = params.get("system") ?? "";
  const open = params.get("item") ?? undefined;
  // From the address as it is now, not as this render saw it: the sheet's close event
  // arrives asynchronously and can land after a filter change.
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: key !== "item" });
  };

  const all = todos.data ?? [];
  const suggestions = all.filter((t) => t.status === "suggested");
  const saved = all.filter((t) => t.savedAt);
  const inView = saved.filter(
    (t) =>
      VIEWS[view]!.statuses.includes(t.status) &&
      (!priority || t.priority === priority) &&
      (!project || t.projectId === project) &&
      (!system || t.services.includes(system)),
  );
  const shown = inView.filter((t) => category === "all" || t.category === category);
  const rank: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };
  shown.sort(
    (a, b) => rank[a.priority] - rank[b.priority] || b.updatedAt.localeCompare(a.updatedAt),
  );
  const active = saved.filter((t) => VIEWS.active!.statuses.includes(t.status));
  const usedSystems = services.filter((s) => saved.some((t) => t.services.includes(s.id)));
  const usedProjects = (projects.data ?? []).filter((p) => saved.some((t) => t.projectId === p.id));

  return (
    <>
      <PageHeader
        eyebrow="Plan"
        title="To-do"
        subtitle={
          active.length
            ? `${active.length} to deal with. Problems to fix, things to do, and ideas worth building, kept with Ember so you do not have to remember them.`
            : "Problems to fix, things to do, and ideas worth building, kept with Ember so you do not have to remember them."
        }
        actions={
          <Button tone="primary" onClick={() => setAdding(true)}>
            Add an item
          </Button>
        }
      />

      <Suggestions items={suggestions} />

      <div className="mb-6 grid gap-4">
        <Segmented
          label="Kind"
          value={category}
          options={[
            { value: "all", label: "All", count: inView.length },
            ...TODO_CATEGORIES.map((c) => ({
              value: c,
              label: `${TODO_CATEGORY_LABEL[c]}s`,
              count: inView.filter((t) => t.category === c).length,
            })),
          ]}
          onChange={(v) => setParam("category", v === "all" ? "" : v)}
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div>
            <label htmlFor="todo-filter-view" className="mb-1 block text-[0.78rem] text-faint">
              Status
            </label>
            <select
              id="todo-filter-view"
              value={view}
              onChange={(e) => setParam("view", e.target.value === "active" ? "" : e.target.value)}
              className={field}
            >
              {Object.entries(VIEWS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="todo-filter-priority" className="mb-1 block text-[0.78rem] text-faint">
              Priority
            </label>
            <select
              id="todo-filter-priority"
              value={priority}
              onChange={(e) => setParam("priority", e.target.value)}
              className={field}
            >
              <option value="">Any</option>
              {TODO_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TODO_PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="todo-filter-project" className="mb-1 block text-[0.78rem] text-faint">
              Project
            </label>
            <select
              id="todo-filter-project"
              value={project}
              onChange={(e) => setParam("project", e.target.value)}
              className={field}
            >
              <option value="">Any</option>
              {usedProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="todo-filter-system" className="mb-1 block text-[0.78rem] text-faint">
              System
            </label>
            <select
              id="todo-filter-system"
              value={system}
              onChange={(e) => setParam("system", e.target.value)}
              className={field}
            >
              <option value="">Any</option>
              {usedSystems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {shown.length === 0 && !todos.isLoading ? (
        <EmptyState title={saved.length ? "Nothing matches" : "Nothing on the list yet"}>
          {saved.length
            ? "Try another status or filter."
            : `Add something here, or tell ${aiName} "add it to the list" when it spots something worth keeping.`}
        </EmptyState>
      ) : (
        <Rows>
          {shown.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setParam("item", t.id)}
                className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors duration-200 hover:bg-panel-2/60 focus-visible:bg-panel-2/60"
                data-testid="todo-row"
              >
                <span
                  aria-hidden
                  className={cx("h-2 w-2 shrink-0 rounded-full", PRIORITY_DOT[t.priority])}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[0.95rem] text-ink">
                    <span className="text-faint">#{t.number} </span>
                    {t.title}
                    <span className="sr-only">, {TODO_PRIORITY_LABEL[t.priority]} priority</span>
                  </p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-[0.78rem] text-faint">
                    <span>{TODO_CATEGORY_LABEL[t.category]}</span>
                    {t.services.length > 0 && (
                      <span>· {systemNames(t.services, services).join(", ")}</span>
                    )}
                    <span>· {ago(t.updatedAt)}</span>
                    {t.check && (
                      <span>
                        · <CheckLine check={t.check} />
                      </span>
                    )}
                  </p>
                </div>
                <div className="hidden sm:block">{statusTag(t.status)}</div>
              </button>
            </li>
          ))}
        </Rows>
      )}

      {adding && <AddItem services={services} onClose={() => setAdding(false)} />}
      {open && <ItemSheet id={open} services={services} onClose={() => setParam("item", "")} />}
    </>
  );
}
