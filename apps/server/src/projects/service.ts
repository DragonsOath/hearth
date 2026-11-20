import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import {
  PROJECT_COLORS,
  PROJECT_ICONS,
  PROJECT_PHASES,
  type ProjectColor,
  type ProjectActivity,
  type ProjectDetail,
  type ProjectIcon,
  type ProjectLink,
  type ProjectLinkInput,
  type ProjectPhase,
  type ProjectSummary,
  type ProjectTask,
  type ProjectTaskStatus,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import type { Memory } from "../memory/service";
import { recordAudit } from "../store/audit";
import { InvalidRequestError, NotFoundError } from "../store/errors";

type ProjectRow = typeof t.memoryProjects.$inferSelect;
type JobRow = typeof t.jobs.$inferSelect;

const isPhase = (p: unknown): p is ProjectPhase =>
  typeof p === "string" && (PROJECT_PHASES as readonly string[]).includes(p);
const isIcon = (i: unknown): i is ProjectIcon =>
  typeof i === "string" && (PROJECT_ICONS as readonly string[]).includes(i);
const isColor = (c: unknown): c is ProjectColor =>
  typeof c === "string" && (PROJECT_COLORS as readonly string[]).includes(c);

/**
 * What a project shows. Facts win over the phase you set: paused or done
 * projects say so, a job waiting for you shows as awaiting approval, and a
 * running job as in progress.
 */
export function effectivePhase(row: ProjectRow, jobs: Pick<JobRow, "status">[]): ProjectPhase {
  if (row.status === "paused") return "paused";
  if (row.status === "done") return "completed";
  if (jobs.some((j) => j.status === "awaiting-approval")) return "awaiting-approval";
  if (jobs.some((j) => j.status === "running")) return "in-progress";
  return isPhase(row.phase) ? row.phase : "in-progress";
}

/**
 * Projects for the command center, on top of the memory projects: one store
 * for projects whether the companion, an import, or you made them.
 */
export class Projects {
  constructor(
    private readonly handle: DbHandle,
    private readonly memory: Memory,
  ) {}

  private async links(related: ProjectLinkInput[]): Promise<ProjectLink[]> {
    const { db } = this.handle;
    const serviceIds = related.filter((r) => r.kind === "service").map((r) => r.id);
    const hostIds = related.filter((r) => r.kind === "host").map((r) => r.id);
    const services = serviceIds.length
      ? await db.select().from(t.services).where(inArray(t.services.id, serviceIds))
      : [];
    const hosts = hostIds.length
      ? await db.select().from(t.hosts).where(inArray(t.hosts.id, hostIds))
      : [];
    return related.map((r) => {
      if (r.kind === "service") {
        // A system you removed from Hearth reads as gone, like one that no longer exists.
        const s = services.find((x) => x.id === r.id && x.lifecycle !== "removed");
        return s
          ? {
              ...r,
              name: s.name,
              health: s.health,
              lifecycle:
                s.lifecycle === "active" || s.lifecycle === "removed" ? undefined : s.lifecycle,
              ...(s.stoppedAt ? { stopped: true } : {}),
            }
          : { ...r, name: r.id, missing: true };
      }
      const h = hosts.find((x) => x.id === r.id);
      return h ? { ...r, name: h.name, health: h.health } : { ...r, name: r.id, missing: true };
    });
  }

  private async summaries(rows: ProjectRow[]): Promise<ProjectSummary[]> {
    const { db } = this.handle;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [jobs, tasks, memory] = await Promise.all([
      db
        .select({ projectId: t.jobs.projectId, status: t.jobs.status, createdAt: t.jobs.createdAt })
        .from(t.jobs)
        .where(inArray(t.jobs.projectId, ids)),
      db.select().from(t.projectTasks).where(inArray(t.projectTasks.projectId, ids)),
      this.memory.projects(),
    ]);
    const out: ProjectSummary[] = [];
    for (const row of rows) {
      const mine = jobs.filter((j) => j.projectId === row.id);
      const myTasks = tasks.filter((x) => x.projectId === row.id);
      const latestJob = mine
        .map((j) => j.createdAt)
        .sort()
        .at(-1);
      out.push({
        id: row.id,
        name: row.name,
        summary: row.summary,
        status: row.status,
        phase: effectivePhase(row, mine),
        icon: isIcon(row.icon) ? row.icon : "folder",
        ...(isColor(row.color) ? { color: row.color } : {}),
        systems: await this.links(row.related ?? []),
        progress: myTasks.length
          ? { done: myTasks.filter((x) => x.status === "done").length, total: myTasks.length }
          : undefined,
        awaitingApproval: mine.filter((j) => j.status === "awaiting-approval").length,
        runningJobs: mine.filter((j) => j.status === "running").length,
        openThreads: memory.find((m) => m.id === row.id)?.openThreads ?? 0,
        updatedAt: latestJob && latestJob > row.updatedAt ? latestJob : row.updatedAt,
      });
    }
    return out;
  }

  /** Active work first (waiting for you, then running, then the rest), newest change first. */
  async list(opts: { includeDone?: boolean } = {}): Promise<ProjectSummary[]> {
    const rows = await this.handle.db.select().from(t.memoryProjects);
    const all = await this.summaries(rows);
    const rank = (p: ProjectSummary) =>
      p.phase === "awaiting-approval"
        ? 0
        : p.phase === "blocked" || p.phase === "failed"
          ? 1
          : p.runningJobs
            ? 2
            : 3;
    return all
      .filter((p) => opts.includeDone || p.status !== "done")
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }

  private async row(id: string): Promise<ProjectRow> {
    const row = await this.handle.db
      .select()
      .from(t.memoryProjects)
      .where(eq(t.memoryProjects.id, id))
      .get();
    if (!row) throw new NotFoundError(`No project "${id}"`);
    return row;
  }

  async get(id: string): Promise<ProjectDetail> {
    const { db } = this.handle;
    const row = await this.row(id);
    const [summary] = await this.summaries([row]);
    const serviceIds = (row.related ?? []).filter((r) => r.kind === "service").map((r) => r.id);

    const [tasks, jobs, notes, conversations, events, audit] = await Promise.all([
      db
        .select()
        .from(t.projectTasks)
        .where(eq(t.projectTasks.projectId, id))
        .orderBy(asc(t.projectTasks.seq)),
      db.select().from(t.jobs).where(eq(t.jobs.projectId, id)).orderBy(desc(t.jobs.createdAt)),
      db
        .select()
        .from(t.memoryEntries)
        .where(
          and(
            eq(t.memoryEntries.projectId, id),
            isNull(t.memoryEntries.deletedAt),
            isNull(t.memoryEntries.superseded),
          ),
        )
        .orderBy(desc(t.memoryEntries.happenedAt))
        .limit(40),
      db
        .select()
        .from(t.conversations)
        .where(eq(t.conversations.projectId, id))
        .orderBy(desc(t.conversations.updatedAt)),
      serviceIds.length
        ? db
            .select()
            .from(t.events)
            .where(inArray(t.events.serviceId, serviceIds))
            .orderBy(desc(t.events.at))
            .limit(40)
        : Promise.resolve([] as (typeof t.events.$inferSelect)[]),
      db
        .select()
        .from(t.auditLog)
        .where(or(eq(t.auditLog.target, `project:${id}`), like(t.auditLog.target, "job:%")))
        .orderBy(desc(t.auditLog.id))
        .limit(200),
    ]);
    const jobIds = new Set(jobs.map((j) => `job:${j.id}`));
    const steps = jobs.length
      ? await db
          .select()
          .from(t.jobSteps)
          .where(
            inArray(
              t.jobSteps.jobId,
              jobs.map((j) => j.id),
            ),
          )
          .orderBy(asc(t.jobSteps.seq))
      : [];

    const history: ProjectActivity[] = audit
      .filter((a) => a.target === `project:${id}` || jobIds.has(a.target))
      .slice(0, 60)
      .map((a) => ({ at: a.at, actor: a.actor, text: a.action, ref: a.target }));
    for (const n of notes) {
      history.push({
        at: n.createdAt,
        actor:
          n.source === "you"
            ? "you"
            : n.source === "ai"
              ? "ai"
              : n.source === "import"
                ? "import"
                : "dragon-control",
        text: `Noted: ${n.title}`,
        ref: `memory:${n.id}`,
      });
    }
    history.sort((a, b) => b.at.localeCompare(a.at));

    const logs: ProjectDetail["logs"] = [
      ...events.map((e) => ({
        at: e.at,
        tone: e.tone,
        text: e.message,
        ref: e.incidentId ? `incident:${e.incidentId}` : undefined,
      })),
      ...jobs.flatMap((j) => [
        {
          at: j.createdAt,
          tone: "neutral" as const,
          text: `Job planned: ${j.title}`,
          ref: `job:${j.id}`,
        },
        ...(j.finishedAt
          ? [
              {
                at: j.finishedAt,
                tone: j.status === "succeeded" ? ("good" as const) : ("attention" as const),
                text: `Job ${j.status}: ${j.summary ?? j.title}`,
                ref: `job:${j.id}`,
              },
            ]
          : []),
      ]),
    ].sort((a, b) => b.at.localeCompare(a.at));

    const terminal = jobs
      .flatMap((j) =>
        steps
          .filter((s) => s.jobId === j.id && s.result)
          .map((s) => ({
            at: s.finishedAt ?? s.startedAt ?? j.createdAt,
            source: `${j.title} · step ${s.seq}`,
            lines: [`$ ${s.label}`, ...(s.result ?? "").split("\n")],
          })),
      )
      .sort((a, b) => b.at.localeCompare(a.at));

    return {
      ...summary!,
      createdAt: row.createdAt,
      tasks: tasks.map((x) => ({
        id: x.id,
        title: x.title,
        status: x.status,
        seq: x.seq,
        createdAt: x.createdAt,
        doneAt: x.doneAt ?? undefined,
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        title: j.title,
        status: j.status,
        createdAt: j.createdAt,
        summary: j.summary ?? undefined,
        steps: steps
          .filter((s) => s.jobId === j.id)
          .map((s) => ({
            seq: s.seq,
            kind: s.kind as ProjectDetail["jobs"][number]["steps"][number]["kind"],
            serviceId: s.serviceId,
            serviceName: s.serviceName,
            label: s.label,
            changes: s.kind === "restart-container",
            policy: s.policy,
            policyReason: s.policyReason,
            verify: "",
            rollback: "",
            status: s.status,
            result: s.result ?? undefined,
          })),
      })),
      notes: notes.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        at: n.happenedAt ?? n.createdAt,
        status: n.status ?? undefined,
      })),
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
      })),
      logs: logs.slice(0, 60),
      terminal: terminal.slice(0, 30),
      history,
    };
  }

  private async checkRelated(related: ProjectLinkInput[]) {
    if (related.length > 20)
      throw new InvalidRequestError("A project can link at most 20 systems.");
    const links = await this.links(related);
    const missing = links.find((l) => l.missing);
    if (missing) throw new InvalidRequestError(`No ${missing.kind} "${missing.id}".`);
  }

  async create(input: {
    name: string;
    summary?: string;
    phase?: ProjectPhase;
    icon?: ProjectIcon;
    color?: ProjectColor;
    related?: ProjectLinkInput[];
  }): Promise<ProjectDetail> {
    if (!input.name.trim()) throw new InvalidRequestError("A project needs a name.");
    await this.checkRelated(input.related ?? []);
    const created = await this.memory.createProject({ name: input.name, summary: input.summary });
    await this.handle.db
      .update(t.memoryProjects)
      .set({
        phase: input.phase ?? "planned",
        icon: input.icon ?? "folder",
        color: input.color ?? null,
        related: input.related ?? [],
      })
      .where(eq(t.memoryProjects.id, created.id));
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Started a project: ${created.name}`,
      target: `project:${created.id}`,
    });
    return this.get(created.id);
  }

  async update(
    id: string,
    patch: {
      name?: string;
      summary?: string;
      status?: ProjectRow["status"];
      phase?: ProjectPhase;
      icon?: ProjectIcon;
      /** A color, or null to go back to the plain card. */
      color?: ProjectColor | null;
      related?: ProjectLinkInput[];
    },
  ): Promise<ProjectDetail> {
    const before = await this.row(id);
    if (patch.related) await this.checkRelated(patch.related);
    await this.memory.updateProject(id, {
      name: patch.name,
      summary: patch.summary,
      status: patch.status,
    });
    await this.handle.db
      .update(t.memoryProjects)
      .set({
        ...(patch.phase ? { phase: patch.phase } : {}),
        ...(patch.icon ? { icon: patch.icon } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.related ? { related: patch.related } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(t.memoryProjects.id, id));
    const changed = Object.keys(patch).filter(
      (k) =>
        JSON.stringify(patch[k as keyof typeof patch]) !==
        JSON.stringify(before[k as keyof ProjectRow]),
    );
    if (changed.length) {
      await recordAudit(this.handle.db, {
        actor: "you",
        action: `Updated the project ${patch.name ?? before.name} (${changed.join(", ")})`,
        target: `project:${id}`,
      });
    }
    return this.get(id);
  }

  async addTask(projectId: string, title: string): Promise<ProjectTask> {
    await this.row(projectId);
    if (!title.trim()) throw new InvalidRequestError("A task needs a title.");
    const { db } = this.handle;
    const id = randomUUID();
    const at = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      const last = await db
        .select({ seq: t.projectTasks.seq })
        .from(t.projectTasks)
        .where(eq(t.projectTasks.projectId, projectId))
        .orderBy(desc(t.projectTasks.seq))
        .get();
      await db.insert(t.projectTasks).values({
        id,
        projectId,
        title: title.trim().slice(0, 200),
        status: "todo",
        seq: (last?.seq ?? 0) + 1,
        createdAt: at,
      });
      await db
        .update(t.memoryProjects)
        .set({ updatedAt: at })
        .where(eq(t.memoryProjects.id, projectId));
      await recordAudit(db, {
        actor: "you",
        action: `Added a task: ${title.trim().slice(0, 200)}`,
        target: `project:${projectId}`,
      });
    });
    return (await this.get(projectId)).tasks.find((x) => x.id === id)!;
  }

  async updateTask(
    projectId: string,
    taskId: string,
    patch: { title?: string; status?: ProjectTaskStatus },
  ): Promise<ProjectTask> {
    const { db } = this.handle;
    const task = await db
      .select()
      .from(t.projectTasks)
      .where(and(eq(t.projectTasks.id, taskId), eq(t.projectTasks.projectId, projectId)))
      .get();
    if (!task) throw new NotFoundError("No such task.");
    const at = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      await db
        .update(t.projectTasks)
        .set({
          ...(patch.title ? { title: patch.title.trim().slice(0, 200) } : {}),
          ...(patch.status
            ? { status: patch.status, doneAt: patch.status === "done" ? at : null }
            : {}),
        })
        .where(eq(t.projectTasks.id, taskId));
      await db
        .update(t.memoryProjects)
        .set({ updatedAt: at })
        .where(eq(t.memoryProjects.id, projectId));
      if (patch.status && patch.status !== task.status) {
        await recordAudit(db, {
          actor: "you",
          action: `Task ${patch.status === "done" ? "done" : `marked ${patch.status}`}: ${task.title}`,
          target: `project:${projectId}`,
        });
      }
    });
    return (await this.get(projectId)).tasks.find((x) => x.id === taskId)!;
  }

  async removeTask(projectId: string, taskId: string): Promise<void> {
    const { db } = this.handle;
    const task = await db
      .select()
      .from(t.projectTasks)
      .where(and(eq(t.projectTasks.id, taskId), eq(t.projectTasks.projectId, projectId)))
      .get();
    if (!task) throw new NotFoundError("No such task.");
    await withTransaction(this.handle, async () => {
      await db.delete(t.projectTasks).where(eq(t.projectTasks.id, taskId));
      await recordAudit(db, {
        actor: "you",
        action: `Removed a task: ${task.title}`,
        target: `project:${projectId}`,
      });
    });
  }
}
