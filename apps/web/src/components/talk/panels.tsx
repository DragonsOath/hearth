import { useState } from "react";
import { Link } from "react-router";
import { MessageCircle, Plus } from "lucide-react";
import { TODO_STATUS_LABEL, type TodoItem, type TodoPriority } from "@dragon-control/core";
import { useAddTodo, useTodos, useUpdateTodo } from "../../data/todos";
import { useJobs } from "../../data/jobs";
import { JobCard } from "../cave/Progress";
import { cx } from "../ui";

/**
 * Small tools that open as panels in conversation mode: the to-do list (tick off, add, change
 * priority) and plans (waiting, running, finished). The full pages stay where they are.
 */

const ACTIVE = new Set(["open", "investigating", "waiting-approval"]);
/** Still to deal with (not done). */
export const isActiveTodo = (t: Pick<TodoItem, "status">) => ACTIVE.has(t.status);
const RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_CLS: Record<TodoPriority, string> = {
  high: "border-alert/50 text-alert",
  medium: "border-amber/50 text-amber",
  low: "border-live/50 text-live",
};

export function TodoPanel({
  view: shown,
  onWork,
  aiName = "Ember",
}: {
  view?: "active" | "done";
  /** Work on this: hands an unfinished task to Ember (the Lair's panel). */
  onWork?: (t: TodoItem) => void;
  aiName?: string;
} = {}) {
  const todos = useTodos();
  const update = useUpdateTodo();
  const add = useAddTodo();
  const [own, setView] = useState<"active" | "done">("active");
  // In the Lair the panel's own tabs choose; in the War Room this list has its own switch.
  const view = shown ?? own;
  const [title, setTitle] = useState("");
  const all = (todos.data ?? []).filter((t) => t.savedAt);
  const list = all
    .filter((t) => (view === "active" ? ACTIVE.has(t.status) : t.status === "resolved"))
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
  const activeCount = all.filter((t) => ACTIVE.has(t.status)).length;
  const toggle = (t: TodoItem) =>
    update.mutate({ id: t.id, status: t.status === "resolved" ? "open" : "resolved" });
  return (
    <div className="space-y-3" data-testid="talk-todo">
      <div
        hidden={shown !== undefined}
        role="tablist"
        aria-label="Which items"
        className="flex gap-1 rounded-lg border border-line p-1"
      >
        {(["active", "done"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => setView(v)}
            className={cx(
              "min-h-9 flex-1 rounded-md text-[0.84rem]",
              view === v ? "bg-gold/15 text-gold" : "text-muted hover:text-ink",
            )}
          >
            {v === "active" ? `To deal with (${activeCount})` : "Done"}
          </button>
        ))}
      </div>
      {todos.isLoading ? (
        <p className="text-[0.84rem] text-muted">Loading…</p>
      ) : todos.error ? (
        <p role="alert" className="text-[0.84rem] text-bad">
          Could not load the list: {todos.error.message}
        </p>
      ) : list.length === 0 ? (
        <p className="text-[0.84rem] text-faint">
          {view === "active" ? "Nothing to deal with." : "Nothing done yet."}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {list.slice(0, 50).map((t) => (
            <li key={t.id} className="flex items-start gap-3 py-2.5">
              <input
                type="checkbox"
                checked={t.status === "resolved"}
                onChange={() => toggle(t)}
                aria-label={`${t.status === "resolved" ? "Reopen" : "Mark done"}: ${t.title}`}
                className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-[var(--color-gold)]"
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cx(
                    "text-[0.88rem] leading-snug text-ink",
                    t.status === "resolved" && "text-muted line-through",
                  )}
                >
                  <span className="text-faint">#{t.number} </span>
                  {t.title}
                </p>
                <p className="mt-0.5 text-[0.74rem] text-faint">{TODO_STATUS_LABEL[t.status]}</p>
              </div>
              {onWork && t.status !== "resolved" && (
                <button
                  type="button"
                  onClick={() => onWork(t)}
                  aria-label={`Work on this with ${aiName}: ${t.title}`}
                  title={`Work on this with ${aiName}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line text-muted hover:border-gold/60 hover:text-gold"
                  data-testid="todo-work-on"
                >
                  <MessageCircle strokeWidth={1.75} className="h-4 w-4" aria-hidden />
                </button>
              )}
              <label className="shrink-0">
                <span className="sr-only">Priority of {t.title}</span>
                <select
                  value={t.priority}
                  onChange={(e) =>
                    update.mutate({ id: t.id, priority: e.target.value as TodoPriority })
                  }
                  className={cx(
                    "min-h-8 rounded-md border bg-bg px-1.5 text-[0.74rem]",
                    PRIORITY_CLS[t.priority],
                  )}
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = title.trim();
          if (!text) return;
          add.mutate({ category: "task", title: text }, { onSuccess: () => setTitle("") });
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">New to-do item</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a task…"
            className="min-h-10 w-full rounded-lg border border-line bg-bg px-3 text-[0.86rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!title.trim() || add.isPending}
          aria-label="Add the task"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-gold/50 text-gold disabled:opacity-40"
        >
          <Plus strokeWidth={1.75} className="h-4 w-4" />
        </button>
      </form>
      {(add.error || update.error) && (
        <p role="alert" className="text-[0.8rem] text-bad">
          {(add.error ?? update.error)!.message}
        </p>
      )}
      <Link to="/todo" className="inline-block text-[0.78rem] text-gold hover:underline">
        The full to-do page
      </Link>
    </div>
  );
}

export function PlansPanel() {
  const jobs = useJobs();
  const list = [...(jobs.data ?? [])]
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 12);
  if (jobs.isLoading) return <p className="text-[0.84rem] text-muted">Loading…</p>;
  if (jobs.error)
    return (
      <p role="alert" className="text-[0.84rem] text-bad">
        Could not load plans: {jobs.error.message}
      </p>
    );
  if (!list.length) return <p className="text-[0.84rem] text-faint">No plans yet.</p>;
  return (
    <div className="space-y-2" data-testid="talk-plans-panel">
      {list.map((j) => (
        <JobCard key={j.id} id={j.id} />
      ))}
    </div>
  );
}
