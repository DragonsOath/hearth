import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  PROJECT_ICONS,
  type ProjectIcon,
  type ProjectLinkInput,
  type Workspace,
} from "@dragon-control/core";
import { WithWorkspace } from "../components/WithWorkspace";
import { Button, EmptyState, PageHeader, Panel, Section, Segmented, cx } from "../components/ui";
import { PROJECT_ICON, ProjectCard } from "../components/command/ProjectCard";
import { useCreateProject, useProjects } from "../data/projects";
import { FormError } from "./auth/AuthFrame";

const field =
  "min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none";

function NewProject({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const create = useCreateProject();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [icon, setIcon] = useState<ProjectIcon>("folder");
  const [related, setRelated] = useState<ProjectLinkInput[]>([]);
  const has = (l: ProjectLinkInput) => related.some((r) => r.kind === l.kind && r.id === l.id);
  const toggle = (l: ProjectLinkInput) =>
    setRelated((all) =>
      has(l) ? all.filter((r) => !(r.kind === l.kind && r.id === l.id)) : [...all, l],
    );
  const services = [...ws.services, ...ws.inactiveServices].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return (
    <Panel className="mb-10 p-6 sm:p-8">
      <form
        aria-label="Start a project"
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            { name, summary: summary || undefined, icon, related, phase: "planned" },
            {
              onSuccess: (p) => {
                onDone();
                void navigate(`/?project=${encodeURIComponent(p.id)}`);
              },
            },
          );
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-[0.82rem] text-muted">
            Name
            <input
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className={cx(field, "mt-1")}
            />
          </label>
          <label className="text-[0.82rem] text-muted">
            What it is for
            <input
              maxLength={1000}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Project description"
              className={cx(field, "mt-1")}
            />
          </label>
        </div>
        <fieldset>
          <legend className="mb-2 text-[0.82rem] text-muted">Icon</legend>
          <div className="flex flex-wrap gap-2">
            {PROJECT_ICONS.map((i) => {
              const Icon = PROJECT_ICON[i];
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={i}
                  aria-pressed={icon === i}
                  onClick={() => setIcon(i)}
                  className={cx(
                    "flex h-11 w-11 items-center justify-center rounded-lg border",
                    icon === i ? "border-gold text-gold" : "border-line text-muted hover:text-ink",
                  )}
                >
                  <Icon strokeWidth={1.5} className="h-5 w-5" />
                </button>
              );
            })}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-[0.82rem] text-muted">Systems it concerns (optional)</legend>
          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
            {ws.hosts.map((h) => (
              <button
                key={`h${h.id}`}
                type="button"
                aria-pressed={has({ kind: "host", id: h.id })}
                onClick={() => toggle({ kind: "host", id: h.id })}
                className={cx(
                  "min-h-9 rounded-full border px-3 text-[0.82rem]",
                  has({ kind: "host", id: h.id })
                    ? "border-gold text-gold"
                    : "border-line text-muted hover:text-ink",
                )}
              >
                {h.name}
              </button>
            ))}
            {services.map((s) => (
              <button
                key={`s${s.id}`}
                type="button"
                aria-pressed={has({ kind: "service", id: s.id })}
                onClick={() => toggle({ kind: "service", id: s.id })}
                className={cx(
                  "min-h-9 rounded-full border px-3 text-[0.82rem]",
                  has({ kind: "service", id: s.id })
                    ? "border-gold text-gold"
                    : "border-line text-muted hover:text-ink",
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="flex gap-3">
          <Button type="submit" tone="primary" disabled={!name.trim() || create.isPending}>
            Start the project
          </Button>
          <Button onClick={onDone}>Cancel</Button>
        </div>
        <FormError error={create.error} />
      </form>
    </Panel>
  );
}

function ProjectsContent({ ws }: { ws: Workspace }) {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<"active" | "done">("active");
  const projects = useProjects({ all: true });
  const creating = params.get("new") === "1";
  const all = projects.data ?? [];
  const list = all.filter((p) => (view === "active" ? p.status !== "done" : p.status === "done"));
  return (
    <>
      <PageHeader
        eyebrow="Operate"
        title="Projects"
        subtitle="Longer work: investigations, improvements, and fixes that take more than one step. Each keeps its tasks, jobs, notes, conversations, and history together."
        actions={
          !creating && (
            <Button tone="primary" onClick={() => setParams({ new: "1" })}>
              Start a project
            </Button>
          )
        }
      />
      {creating && <NewProject ws={ws} onDone={() => setParams({})} />}
      <div className="mb-6">
        <Segmented
          label="Project view"
          value={view}
          onChange={setView}
          options={[
            {
              value: "active",
              label: "Active",
              count: all.filter((p) => p.status !== "done").length,
            },
            {
              value: "done",
              label: "Completed",
              count: all.filter((p) => p.status === "done").length,
            },
          ]}
        />
      </div>
      <Section title={view === "active" ? "Active and paused" : "Completed"}>
        {list.length ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {list.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        ) : (
          <EmptyState title={view === "active" ? "No active projects" : "Nothing completed yet"}>
            {view === "active"
              ? "Start one, or let the AI companion record the projects you talk about."
              : "Completed projects stay here with everything they gathered."}
          </EmptyState>
        )}
      </Section>
    </>
  );
}

export function ProjectsPage() {
  return <WithWorkspace>{(ws) => <ProjectsContent ws={ws} />}</WithWorkspace>;
}
