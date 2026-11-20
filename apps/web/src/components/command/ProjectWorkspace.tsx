import { useState } from "react";
import { ProjectColorPicker } from "./ProjectColorPicker";
import { Link } from "react-router";
import { usePanelHref } from "../desk/links";
import { Ban, CheckCircle2, Circle, CircleDot, ListChecks, ListTodo, Plus } from "lucide-react";
import {
  TODO_CATEGORY_LABEL,
  TODO_STATUS_LABEL,
  PROJECT_PHASES,
  PROJECT_PHASE_LABEL,
  type ProjectDetail,
  type ProjectPhase,
  type ProjectTask,
  type ProjectTaskStatus,
} from "@dragon-control/core";
import { Button, Skeleton, cx } from "../ui";
import { useAddTask, useProject, useUpdateProject, useUpdateTask } from "../../data/projects";
import { useSaveEntry } from "../../data/memory";
import { useTodos } from "../../data/todos";
import { ago } from "../../lib/format";
import { serviceDot } from "../shell/Sidebar";
import { PROJECT_ICON, PhasePill, tintOf } from "./ProjectCard";
import { TerminalView, Unavailable, WorkspaceFrame, type TabDef } from "./WorkspaceFrame";

type Tab = "overview" | "tasks" | "logs" | "terminal" | "files" | "notes" | "history";
const TABS: TabDef<Tab>[] = [
  { id: "overview", label: "Overview" },
  { id: "tasks", label: "Tasks" },
  { id: "logs", label: "Logs" },
  { id: "terminal", label: "Terminal" },
  { id: "files", label: "Files" },
  { id: "notes", label: "Notes" },
  { id: "history", label: "History" },
];

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

function TaskIcon({ status }: { status: ProjectTaskStatus }) {
  if (status === "done")
    return <CheckCircle2 strokeWidth={1.75} className="h-5 w-5 text-live" aria-label="Done" />;
  if (status === "doing")
    return <CircleDot strokeWidth={1.75} className="h-5 w-5 text-gold" aria-label="In progress" />;
  if (status === "blocked")
    return <Ban strokeWidth={1.75} className="h-5 w-5 text-alert" aria-label="Blocked" />;
  return <Circle strokeWidth={1.5} className="h-5 w-5 text-faint" aria-label="To do" />;
}

function Progress({ p }: { p: ProjectDetail }) {
  if (!p.progress) return null;
  const pct = Math.round((p.progress.done / p.progress.total) * 100);
  return (
    <div className="mt-4">
      <div
        role="progressbar"
        aria-label="Tasks done"
        aria-valuemin={0}
        aria-valuemax={p.progress.total}
        aria-valuenow={p.progress.done}
        className="h-1.5 overflow-hidden rounded-full bg-line"
      >
        <div className="h-full rounded-full bg-tint-blue" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 flex justify-between text-[0.78rem] text-faint">
        <span>
          {p.progress.done} of {p.progress.total} completed
        </span>
        <span className="tabular">{pct}%</span>
      </p>
    </div>
  );
}

function TaskList({ p, compact }: { p: ProjectDetail; compact?: boolean }) {
  const update = useUpdateTask();
  const list = compact ? p.tasks.slice(0, 8) : p.tasks;
  if (!p.tasks.length) {
    return (
      <p className="text-[0.86rem] text-muted">No tasks yet. Add what is left to do in Tasks.</p>
    );
  }
  return (
    <ul className="space-y-1" aria-label="Tasks">
      {list.map((t: ProjectTask) => (
        <li
          key={t.id}
          className={cx(
            "flex min-h-11 items-center gap-3 rounded-lg px-2",
            t.status === "doing" && "bg-gold/5",
          )}
        >
          <button
            type="button"
            aria-label={
              t.status === "done" ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`
            }
            onClick={() =>
              update.mutate({
                projectId: p.id,
                taskId: t.id,
                status: t.status === "done" ? "todo" : "done",
              })
            }
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-raised"
          >
            <TaskIcon status={t.status} />
          </button>
          <span
            className={cx(
              "flex-1 text-[0.9rem]",
              t.status === "done" ? "text-muted line-through decoration-line-strong" : "text-ink",
            )}
          >
            {t.title}
          </span>
          {!compact && (
            <select
              aria-label={`Status of "${t.title}"`}
              value={t.status}
              onChange={(e) =>
                update.mutate({
                  projectId: p.id,
                  taskId: t.id,
                  status: e.target.value as ProjectTaskStatus,
                })
              }
              className="min-h-9 rounded-md border border-line bg-bg px-2 text-[0.8rem] text-muted"
            >
              <option value="todo">To do</option>
              <option value="doing">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="done">Done</option>
            </select>
          )}
        </li>
      ))}
    </ul>
  );
}

function Overview({ p }: { p: ProjectDetail }) {
  const panelHref = usePanelHref();
  const update = useUpdateProject();
  const waiting = p.jobs.filter((j) => j.status === "awaiting-approval");
  const running = p.jobs.filter((j) => j.status === "running");
  const left = p.tasks.filter((t) => t.status !== "done");
  const blocked = p.tasks.filter((t) => t.status === "blocked");
  const findings = p.notes.filter((n) => n.kind === "thread" && n.status !== "done");
  return (
    <div className="space-y-7">
      <div>
        <p className="text-[0.92rem] leading-relaxed text-ink">{p.summary || "No summary yet."}</p>
        <Progress p={p} />
      </div>
      {(waiting.length > 0 || running.length > 0) && (
        <div className="space-y-2">
          {waiting.map((j) => (
            <Link
              key={j.id}
              to={`/jobs/${j.id}`}
              className="flex min-h-11 items-center justify-between rounded-lg border border-amber/40 px-3 text-[0.88rem] text-amber hover:bg-amber/5"
            >
              Job waiting for your approval: {j.title} <span aria-hidden="true">→</span>
            </Link>
          ))}
          {running.map((j) => (
            <Link
              key={j.id}
              to={`/jobs/${j.id}`}
              className="flex min-h-11 items-center justify-between rounded-lg border border-gold/40 px-3 text-[0.88rem] text-gold hover:bg-gold/5"
            >
              Running now: {j.title} <span aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      )}
      <div>
        <h3 className="eyebrow mb-2">Checklist</h3>
        <TaskList p={p} compact />
      </div>
      {blocked.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Blocked</h3>
          <ul className="list-disc pl-5 text-[0.88rem] text-alert">
            {blocked.map((t) => (
              <li key={t.id}>{t.title}</li>
            ))}
          </ul>
        </div>
      )}
      {left.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Next</h3>
          <p className="text-[0.88rem] text-ink">
            {left.find((t) => t.status === "doing")?.title ?? left[0]!.title}
          </p>
        </div>
      )}
      {findings.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Open threads</h3>
          <ul className="space-y-1.5">
            {findings.slice(0, 5).map((n) => (
              <li key={n.id} className="text-[0.88rem] text-ink">
                {n.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="eyebrow mb-2">Systems</h3>
        {p.systems.length ? (
          <ul className="flex flex-wrap gap-2">
            {p.systems.map((s) => {
              const dot =
                s.kind === "service" && s.health
                  ? serviceDot({
                      health: s.health,
                      lifecycle: s.lifecycle,
                      stopped: s.stopped ? { at: "", by: "" } : undefined,
                    })
                  : undefined;
              return (
                <li key={`${s.kind}:${s.id}`}>
                  <Link
                    to={s.kind === "service" ? panelHref(`service:${s.id}`)! : "/systems"}
                    className="inline-flex min-h-9 items-center gap-2 rounded-full border border-line px-3 text-[0.84rem] text-ink hover:border-gold/50"
                  >
                    {dot && (
                      <span
                        className={cx("h-2 w-2 rounded-full", dot.className)}
                        aria-label={dot.label}
                      />
                    )}
                    {s.name}
                    {s.missing && <span className="text-faint">(no longer found)</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">No systems linked.</p>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3 border-t border-line pt-5">
        <label className="text-[0.8rem] text-muted">
          Phase
          <select
            value={p.phase}
            disabled={p.status !== "active"}
            onChange={(e) => update.mutate({ id: p.id, phase: e.target.value as ProjectPhase })}
            className="mt-1 block min-h-10 rounded-lg border border-line-strong bg-bg px-2 text-[0.86rem] text-ink"
          >
            {PROJECT_PHASES.filter(
              (x) => x !== "completed" && x !== "paused" && x !== "awaiting-approval",
            ).map((x) => (
              <option key={x} value={x}>
                {PROJECT_PHASE_LABEL[x]}
              </option>
            ))}
            {!["planned", "queued", "investigating", "in-progress", "blocked", "failed"].includes(
              p.phase,
            ) && <option value={p.phase}>{PROJECT_PHASE_LABEL[p.phase]}</option>}
          </select>
        </label>
        {p.status === "active" ? (
          <>
            <Button onClick={() => update.mutate({ id: p.id, status: "paused" })}>Pause</Button>
            <Button onClick={() => update.mutate({ id: p.id, status: "done" })}>
              Mark complete
            </Button>
          </>
        ) : (
          <Button onClick={() => update.mutate({ id: p.id, status: "active" })}>
            {p.status === "done" ? "Reopen" : "Resume"}
          </Button>
        )}
      </div>
      <div>
        <h3 className="eyebrow mb-2">Color on Home</h3>
        <ProjectColorPicker
          value={p.color}
          onChange={(color) => update.mutate({ id: p.id, color: color ?? null })}
        />
      </div>
    </div>
  );
}

/** Issues and ideas on the to-do list that belong to this project. */
function ProjectTodos({ projectId }: { projectId: string }) {
  const todos = useTodos();
  const items = (todos.data ?? []).filter(
    (t) => t.projectId === projectId && t.status !== "dismissed" && t.status !== "resolved",
  );
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="eyebrow">On the to-do list</h3>
        <Link
          to={`/todo?project=${encodeURIComponent(projectId)}`}
          className="text-[0.82rem] text-gold hover:text-gold-bright"
        >
          Open the list →
        </Link>
      </div>
      {items.length ? (
        <ul className="space-y-2" data-testid="project-todos">
          {items.map((t) => (
            <li key={t.id}>
              <Link
                to={`/todo?item=${encodeURIComponent(t.id)}`}
                className="flex min-h-12 items-center gap-3 rounded-lg border border-line px-3 hover:border-gold/40"
              >
                <ListTodo strokeWidth={1.5} className="h-4 w-4 text-gold" />
                <span className="flex-1 text-[0.88rem] text-ink">
                  #{t.number} {t.title}
                </span>
                <span className="text-[0.76rem] text-faint">
                  {TODO_CATEGORY_LABEL[t.category]} · {TODO_STATUS_LABEL[t.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">
          Nothing for this project. Issues and ideas you save in Ember while working on it show up
          here.
        </p>
      )}
    </div>
  );
}

function Tasks({ p }: { p: ProjectDetail }) {
  const add = useAddTask();
  const [title, setTitle] = useState("");
  return (
    <div className="space-y-7">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          add.mutate({ projectId: p.id, title }, { onSuccess: () => setTitle("") });
        }}
      >
        <label htmlFor="new-task" className="sr-only">
          New task
        </label>
        <input
          id="new-task"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task"
          className={field}
        />
        <Button type="submit" disabled={!title.trim() || add.isPending}>
          <Plus strokeWidth={1.5} className="h-4 w-4" /> Add
        </Button>
      </form>
      <TaskList p={p} />
      <ProjectTodos projectId={p.id} />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="eyebrow">Jobs</h3>
          <Link
            to={`/jobs?project=${encodeURIComponent(p.id)}`}
            className="text-[0.82rem] text-gold hover:text-gold-bright"
          >
            Plan a job for this project →
          </Link>
        </div>
        {p.jobs.length ? (
          <ul className="space-y-2">
            {p.jobs.map((j) => {
              const done = j.steps.filter((s) => s.status === "succeeded").length;
              return (
                <li key={j.id}>
                  <Link
                    to={`/jobs/${j.id}`}
                    className="flex min-h-12 items-center gap-3 rounded-lg border border-line px-3 hover:border-gold/40"
                  >
                    <ListChecks strokeWidth={1.5} className="h-4 w-4 text-gold" />
                    <span className="flex-1 text-[0.88rem] text-ink">{j.title}</span>
                    <span className="text-[0.76rem] text-faint">
                      {done} of {j.steps.length} · {j.status.replace("-", " ")}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">
            No jobs yet. A job is a plan of steps Hearth already knows, approved once.
          </p>
        )}
      </div>
    </div>
  );
}

function Logs({ p }: { p: ProjectDetail }) {
  if (!p.logs.length)
    return (
      <p className="text-[0.86rem] text-muted">
        Nothing recorded yet for this project or its systems.
      </p>
    );
  const tone = { good: "text-live", neutral: "text-faint", attention: "text-amber" };
  return (
    <ul className="divide-y divide-line">
      {p.logs.map((l, i) => (
        <li key={i} className="flex gap-3 py-2.5 text-[0.86rem]">
          <span className={cx("mt-1 text-[0.6rem]", tone[l.tone])} aria-hidden="true">
            ◆
          </span>
          <span className="flex-1 text-ink">{l.text}</span>
          <span className="shrink-0 text-[0.76rem] text-faint tabular">{ago(l.at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Notes({ p }: { p: ProjectDetail }) {
  const save = useSaveEntry();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <div className="space-y-6">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          save.mutate(
            { input: { kind: "note", title, body, projectId: p.id, basis: "stated" } },
            {
              onSuccess: () => {
                setTitle("");
                setBody("");
              },
            },
          );
        }}
      >
        <label htmlFor="note-title" className="sr-only">
          Note title
        </label>
        <input
          id="note-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="A note for this project"
          className={field}
        />
        <label htmlFor="note-body" className="sr-only">
          Note
        </label>
        <textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="Details (optional)"
          className={cx(field, "py-2")}
        />
        <Button type="submit" disabled={!title.trim() || save.isPending}>
          Save note
        </Button>
      </form>
      {p.notes.length ? (
        <ul className="space-y-4">
          {p.notes.map((n) => (
            <li key={n.id} className="border-l-2 border-gold/30 pl-3">
              <p className="text-[0.9rem] text-ink">{n.title}</p>
              {n.body && (
                <p className="mt-1 line-clamp-4 text-[0.84rem] leading-relaxed whitespace-pre-wrap text-muted">
                  {n.body}
                </p>
              )}
              <p className="mt-1 text-[0.74rem] text-faint">
                {n.kind} · {ago(n.at)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">
          No notes yet. Notes are kept in the homelab memory with this project.
        </p>
      )}
    </div>
  );
}

function History({ p }: { p: ProjectDetail }) {
  if (!p.history.length) return <p className="text-[0.86rem] text-muted">No history yet.</p>;
  const who = {
    you: "You",
    "dragon-control": "Hearth",
    agent: "The AI",
    ai: "The AI",
    import: "Import",
  };
  return (
    <ul className="divide-y divide-line">
      {p.history.map((h, i) => (
        <li key={i} className="flex gap-3 py-2.5 text-[0.86rem]">
          <span className="w-28 shrink-0 text-[0.76rem] text-faint">{who[h.actor]}</span>
          <span className="flex-1 text-ink">{h.text}</span>
          <span className="shrink-0 text-[0.76rem] text-faint tabular">{ago(h.at)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProjectWorkspace({
  id,
  tab,
  onTab,
  onClose,
}: {
  id: string;
  tab: string | null;
  onTab: (t: string) => void;
  onClose: () => void;
}) {
  const project = useProject(id);
  const current = (TABS.some((t) => t.id === tab) ? tab : "overview") as Tab;
  if (project.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (!project.data) {
    return (
      <div className="rounded-2xl border border-line p-6">
        <p className="text-ink">This project could not be found.</p>
        <Button className="mt-4" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }
  const p = project.data;
  const Icon = PROJECT_ICON[p.icon];
  const tint = tintOf(p);
  return (
    <WorkspaceFrame
      label={`Project: ${p.name}`}
      testId="project-workspace"
      icon={
        <span
          className="flex h-11 w-11 items-center justify-center rounded-lg"
          style={{ background: `color-mix(in oklab, ${tint} 18%, transparent)`, color: tint }}
        >
          <Icon strokeWidth={1.5} className="h-6 w-6" />
        </span>
      }
      title={p.name}
      subtitle={
        <>
          {p.systems.length ? p.systems.map((s) => s.name).join(" · ") : "No systems linked"} ·
          updated {ago(p.updatedAt).toLowerCase()}
        </>
      }
      status={<PhasePill phase={p.phase} />}
      tabs={TABS}
      tab={current}
      onTab={onTab}
      onClose={onClose}
    >
      {current === "overview" && <Overview p={p} />}
      {current === "tasks" && <Tasks p={p} />}
      {current === "logs" && <Logs p={p} />}
      {current === "terminal" && (
        <TerminalView
          entries={p.terminal}
          empty="Nothing has run for this project yet. Job steps and their results appear here."
        />
      )}
      {current === "files" && (
        <Unavailable
          what="Project files"
          why="Hearth does not store project files yet. Notes and history are kept; files will come with a reviewed, permitted storage area."
        />
      )}
      {current === "notes" && <Notes p={p} />}
      {current === "history" && <History p={p} />}
    </WorkspaceFrame>
  );
}
