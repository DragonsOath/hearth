import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  ACTIONS,
  ACTION_KINDS,
  MAX_JOB_STEPS,
  MAX_WORKSPACE_PLAN_STEPS,
  type Job,
  type JobStatus,
  type JobStep,
  type JobStepInput,
  type Requester,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { approvalExpiry } from "../actions/approval";
import { addTimeline } from "../monitor/engine";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import {
  ROLLBACK_TEXT,
  VERIFY_TEXT,
  type JobOperations,
  type PlannedStep,
  type StepRun,
} from "./operations";

type JobRow = typeof t.jobs.$inferSelect;
type StepRow = typeof t.jobSteps.$inferSelect;

/**
 * The approval covers the job's identity, its exact steps in order, who asked,
 * and the expiry. Change any of it and the fingerprint changes.
 */
export function jobFingerprint(job: JobRow, steps: StepRow[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        job.id,
        job.title,
        job.requestedBy,
        job.incidentId,
        job.expiresAt,
        // The exact values approved: parameters and the before/after of every change.
        steps.map((s) => [s.seq, s.kind, s.serviceId, s.params ?? null, s.change ?? null]),
        // A plan from a workspace: approval also covers the frozen snapshot and each step's item.
        ...(job.snapshotId
          ? [job.workspaceId, job.snapshotId, job.mode, steps.map((s) => s.itemId)]
          : []),
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

function toJob(row: JobRow, steps: StepRow[]): Job {
  const kindOf = (k: string) => k as JobStep["kind"];
  return {
    id: row.id,
    title: row.title,
    reason: row.reason ?? undefined,
    ...(row.impact ? { impact: row.impact } : {}),
    requestedBy: row.requestedBy,
    incidentId: row.incidentId ?? undefined,
    projectId: row.projectId ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    summary: row.summary ?? undefined,
    approvedAt: row.approvedAt ?? undefined,
    ...(row.workspaceId && row.snapshotId
      ? { workspace: { id: row.workspaceId, snapshotId: row.snapshotId } }
      : {}),
    approval:
      row.status === "awaiting-approval" && row.expiresAt
        ? { fingerprint: jobFingerprint(row, steps), expiresAt: row.expiresAt }
        : undefined,
    steps: steps.map((s) => ({
      seq: s.seq,
      kind: kindOf(s.kind),
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      label: s.label,
      changes: ACTIONS[kindOf(s.kind)]?.changes ?? true,
      policy: s.policy,
      policyReason: s.policyReason,
      verify: VERIFY_TEXT[kindOf(s.kind)] ?? "",
      rollback: ROLLBACK_TEXT[kindOf(s.kind)] ?? "",
      ...(s.params ? { params: s.params } : {}),
      ...(s.change ? { change: s.change } : {}),
      status: s.status,
      startedAt: s.startedAt ?? undefined,
      finishedAt: s.finishedAt ?? undefined,
      result: s.result ?? undefined,
      actionId: s.actionId ?? undefined,
      ...(s.itemId ? { itemId: s.itemId } : {}),
      ...(s.freedBytes ? { freedBytes: s.freedBytes } : {}),
      ...(s.verified !== null && s.verified !== undefined ? { verified: s.verified } : {}),
    })),
  };
}

export interface NewJob {
  title: string;
  reason?: string;
  /** What changes for the owner if approved (shown on the card). */
  impact?: string;
  steps: JobStepInput[];
  requestedBy: Requester;
  incidentId?: string;
  projectId?: string;
  /** The conversation it was proposed in (its result is posted there when it ends). */
  conversationId?: string;
  /**
   * Made from a workspace submission: the frozen snapshot, one item per step (in order), and a
   * check that each planned step really acts on its item. Steps then run independently.
   */
  workspace?: {
    workspaceId: string;
    snapshotId: string;
    itemIds: string[];
    bind: (planned: PlannedStep, index: number) => string | undefined;
  };
}

/** Before a per-item step runs: a reason to skip it safely, or nothing to go ahead. */
export type ItemCheck = (
  job: { id: string; workspaceId: string; snapshotId: string },
  step: { seq: number; itemId: string; kind: string },
) => Promise<string | undefined>;

/** Per-item plans stop trying after this many failures in a row (the app is likely down). */
const MAX_FAILURES_IN_A_ROW = 3;

/**
 * Plans, approvals, and execution of jobs. One step at a time, in order;
 * each step goes through the same runner and policy as any action, with the
 * policy checked again at the moment it runs.
 */
export class Jobs {
  private inflight = new Map<string, Promise<void>>();
  private stopRequested = new Set<string>();
  /** Called after each change, so notifications and listeners catch up. */
  onChange: (() => void) | undefined;
  /** A job that ran has ended (succeeded, partly, failed, stopped, or interrupted). */
  onFinished: ((jobId: string) => void) | undefined;
  /** Revalidates a workspace item against its snapshot and current state before its step runs. */
  itemCheck: ItemCheck | undefined;

  constructor(
    private readonly handle: DbHandle,
    private readonly ops: JobOperations,
  ) {}

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  private closing = false;

  /**
   * Hearth is stopping: running jobs finish their current step and
   * stop there, recorded as interrupted (never resumed by themselves).
   */
  async close(): Promise<void> {
    this.closing = true;
    await this.idle();
  }

  private async rows(id: string): Promise<{ job: JobRow; steps: StepRow[] }> {
    const { db } = this.handle;
    const job = await db.select().from(t.jobs).where(eq(t.jobs.id, id)).get();
    if (!job) throw new NotFoundError(`No job "${id}"`);
    const steps = await db
      .select()
      .from(t.jobSteps)
      .where(eq(t.jobSteps.jobId, id))
      .orderBy(asc(t.jobSteps.seq));
    return { job, steps };
  }

  async get(id: string): Promise<Job> {
    const { job, steps } = await this.rows(id);
    return toJob(job, steps);
  }

  async list(limit = 30, status?: JobStatus[]): Promise<Job[]> {
    const { db } = this.handle;
    const jobRows = await db
      .select()
      .from(t.jobs)
      .where(status ? inArray(t.jobs.status, status) : undefined)
      .orderBy(desc(t.jobs.createdAt))
      .limit(limit);
    if (!jobRows.length) return [];
    const stepRows = await db
      .select()
      .from(t.jobSteps)
      .where(
        inArray(
          t.jobSteps.jobId,
          jobRows.map((j) => j.id),
        ),
      )
      .orderBy(asc(t.jobSteps.seq));
    return jobRows.map((j) =>
      toJob(
        j,
        stepRows.filter((s) => s.jobId === j.id),
      ),
    );
  }

  /**
   * Makes a plan. Refused outright if any step is refused. Otherwise it waits
   * for approval when you asked for it (you review your own plans before they
   * run) or any step needs approval; only a plan whose every step the policy
   * allows, asked for by Hearth or the AI, starts at once.
   */
  async create(input: NewJob): Promise<Job> {
    const title = input.title.trim();
    if (!title) throw new InvalidRequestError("A job needs a title.");
    if (!input.steps.length) throw new InvalidRequestError("A job needs at least one step.");
    const max = input.workspace ? MAX_WORKSPACE_PLAN_STEPS : MAX_JOB_STEPS;
    if (input.steps.length > max) {
      throw new InvalidRequestError(`A job can have at most ${max} steps.`);
    }
    if (input.workspace && input.workspace.itemIds.length !== input.steps.length) {
      throw new InvalidRequestError("Every step of a workspace plan needs its item.");
    }
    for (const step of input.steps) {
      if (!ACTION_KINDS.includes(step.kind)) {
        throw new InvalidRequestError(`"${step.kind}" is not something Hearth can do.`);
      }
    }
    const planned: PlannedStep[] = [];
    for (const step of input.steps) planned.push(await this.ops.plan(step, input.requestedBy));
    if (input.workspace) {
      for (const [i, p] of planned.entries()) {
        if (p.policy === "refuse") continue;
        const wrong = input.workspace.bind(p, i);
        if (wrong) throw new InvalidRequestError(`Step ${i + 1}: ${wrong}`);
      }
    }

    const refused = planned.find((p) => p.policy === "refuse");
    const needsApproval =
      input.requestedBy === "you" || planned.some((p) => p.policy === "approve-first");
    const status: JobStatus = refused ? "refused" : needsApproval ? "awaiting-approval" : "running";
    const id = randomUUID();
    const at = new Date().toISOString();
    const { db } = this.handle;

    await withTransaction(this.handle, async () => {
      if (input.projectId) {
        const project = await db
          .select({ id: t.memoryProjects.id })
          .from(t.memoryProjects)
          .where(eq(t.memoryProjects.id, input.projectId))
          .get();
        if (!project) throw new NotFoundError(`No project "${input.projectId}"`);
      }
      if (input.incidentId) {
        const incident = await db
          .select({ id: t.incidents.id })
          .from(t.incidents)
          .where(eq(t.incidents.id, input.incidentId))
          .get();
        if (!incident) throw new NotFoundError(`No incident "${input.incidentId}"`);
      }
      const keysOnly = input.steps.every((st) => st.kind === "credential-import");
      await db.insert(t.jobs).values({
        id,
        title,
        reason: input.reason?.trim() || null,
        impact: input.impact?.trim().slice(0, 400) || null,
        requestedBy: input.requestedBy,
        incidentId: input.incidentId ?? null,
        projectId: input.projectId ?? null,
        conversationId: input.conversationId ?? null,
        status,
        createdAt: at,
        expiresAt: status === "awaiting-approval" ? approvalExpiry() : null,
        startedAt: status === "running" ? at : null,
        finishedAt: refused ? at : null,
        summary: refused ? `Not allowed: ${refused.policyReason}` : null,
        workspaceId: input.workspace?.workspaceId ?? null,
        snapshotId: input.workspace?.snapshotId ?? null,
        // Storing several apps' keys: each app stands alone, so one app that is down or rejects
        // its key never stops the others (one approval for all of them).
        mode: input.workspace || keysOnly ? "per-item" : null,
      });
      await db.insert(t.jobSteps).values(
        input.steps.map((s, i) => ({
          jobId: id,
          seq: i + 1,
          kind: s.kind,
          serviceId: s.serviceId,
          serviceName: planned[i]!.serviceName,
          label: planned[i]!.label,
          policy: planned[i]!.policy,
          policyReason: planned[i]!.policyReason,
          params: planned[i]!.params ?? s.params ?? null,
          change: planned[i]!.change ?? null,
          itemId: input.workspace?.itemIds[i] ?? (keysOnly ? s.serviceId : null),
          status: refused ? ("skipped" as const) : ("pending" as const),
        })),
      );
      await recordAudit(db, {
        actor: input.requestedBy,
        action: refused ? `Planned a job that is not allowed: ${title}` : `Planned a job: ${title}`,
        target: `job:${id}`,
        detail: {
          steps: planned.map((p) => p.label),
          ...(planned.some((p) => p.change)
            ? { changes: planned.flatMap((p) => p.change?.settings ?? []) }
            : {}),
          status,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
      if (input.incidentId) {
        await addTimeline(
          db,
          input.incidentId,
          at,
          refused ? "escalated" : needsApproval ? "approval" : "action",
          refused
            ? `A job was planned but is not allowed: ${refused.policyReason}`
            : needsApproval
              ? `Job planned, waiting for your approval: ${title}.`
              : `Job started: ${title}.`,
        );
      }
    });
    if (status === "running") this.start(id);
    this.onChange?.();
    return this.get(id);
  }

  /**
   * Your decision on a plan. Approving must name the exact plan you saw (its
   * fingerprint), before it expires; the first approval starts it and no
   * second one can. Declining is always possible while it waits.
   */
  async decide(id: string, decision: "approve" | "decline", fingerprint?: string): Promise<Job> {
    const { db } = this.handle;
    const at = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      const { job, steps } = await this.rows(id);
      if (job.status !== "awaiting-approval") {
        throw new ConflictError("This job is not waiting for a decision.");
      }
      if (decision === "approve") {
        if (!fingerprint) {
          throw new InvalidRequestError("Approving needs the fingerprint of the plan you saw.");
        }
        if (job.expiresAt && job.expiresAt <= at) {
          throw new ConflictError(
            "This plan has expired, so it can no longer be approved. Nothing was changed.",
          );
        }
        if (fingerprint !== jobFingerprint(job, steps)) {
          throw new ConflictError(
            "This plan changed after you saw it. Review the current one before approving.",
          );
        }
        // Single use: only one transition out of awaiting-approval can win.
        await db
          .update(t.jobs)
          .set({ status: "running", approvedAt: at, startedAt: at, expiresAt: null })
          .where(and(eq(t.jobs.id, id), eq(t.jobs.status, "awaiting-approval")));
      } else {
        await db
          .update(t.jobs)
          .set({
            status: "cancelled",
            expiresAt: null,
            finishedAt: at,
            summary: "You declined it. Nothing was changed.",
          })
          .where(eq(t.jobs.id, id));
        await db
          .update(t.jobSteps)
          .set({ status: "skipped" })
          .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.status, "pending")));
      }
      await recordAudit(db, {
        actor: "you",
        action:
          decision === "approve" ? `Approved a job: ${job.title}` : `Declined a job: ${job.title}`,
        target: `job:${id}`,
        detail: decision === "approve" ? { fingerprint } : {},
      });
      if (job.incidentId) {
        await addTimeline(
          db,
          job.incidentId,
          at,
          "approval",
          decision === "approve"
            ? `You approved the job: ${job.title}.`
            : `You declined the job: ${job.title}.`,
        );
      }
    });
    if (decision === "approve") this.start(id);
    this.onChange?.();
    return this.get(id);
  }

  /**
   * A plan still waiting for approval is replaced by a newer one made from your revised
   * workspace decisions. Nothing had been done; it can no longer be approved.
   */
  async supersede(id: string, byJobId: string): Promise<void> {
    const { db } = this.handle;
    const at = new Date().toISOString();
    await withTransaction(this.handle, async () => {
      const { job } = await this.rows(id);
      if (job.status !== "awaiting-approval") return;
      await db
        .update(t.jobs)
        .set({
          status: "cancelled",
          expiresAt: null,
          finishedAt: at,
          summary: `Replaced by a plan for your revised decisions (job ${byJobId.slice(0, 8)}). Nothing was changed.`,
        })
        .where(and(eq(t.jobs.id, id), eq(t.jobs.status, "awaiting-approval")));
      await db
        .update(t.jobSteps)
        .set({ status: "skipped" })
        .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.status, "pending")));
      await recordAudit(db, {
        actor: "dragon-control",
        action: `Replaced a plan waiting for approval with one for your revised decisions: ${job.title}`,
        target: `job:${id}`,
        detail: { replacedBy: byJobId },
      });
    });
    this.onChange?.();
  }

  /** Stops a running job after its current step. Nothing already done is undone. */
  async stop(id: string): Promise<Job> {
    const { job } = await this.rows(id);
    if (job.status === "awaiting-approval") return this.decide(id, "decline");
    if (job.status !== "running") throw new ConflictError("This job is not running.");
    this.stopRequested.add(id);
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Asked to stop a job: ${job.title}`,
      target: `job:${id}`,
    });
    return this.get(id);
  }

  private start(id: string) {
    if (this.inflight.has(id)) return;
    const work = this.execute(id)
      .catch((error: unknown) => console.error("Hearth: job failed", error))
      .finally(() => {
        this.inflight.delete(id);
        this.stopRequested.delete(id);
        this.onChange?.();
      });
    this.inflight.set(id, work);
  }

  /** Steps done but not confirmed by reading the result back (never called verified). */
  private async unverified(jobId: string) {
    const rows = await this.handle.db
      .select({ status: t.jobSteps.status, verified: t.jobSteps.verified })
      .from(t.jobSteps)
      .where(eq(t.jobSteps.jobId, jobId));
    return rows.filter((r) => r.status === "succeeded" && r.verified === false).length;
  }

  private async execute(id: string) {
    const { db } = this.handle;
    const { job, steps } = await this.rows(id);
    if (job.status !== "running") return;
    if (job.mode === "per-item") return this.executePerItem(job, steps);
    const run = (s: StepRow): StepRun => ({
      kind: s.kind as StepRun["kind"],
      serviceId: s.serviceId,
      requestedBy: job.requestedBy,
      incidentId: job.incidentId ?? undefined,
      job: { id: job.id, seq: s.seq, approvedAt: job.approvedAt ?? undefined },
      ...(s.params ? { params: s.params } : {}),
      ...(s.change ? { change: s.change } : {}),
    });

    const done: StepRow[] = [];
    const results = new Map<number, string>();
    let failed: { step: StepRow; result: string } | undefined;
    let stoppedAfter: number | undefined;
    let shutDownAfter: number | undefined;
    for (const step of steps) {
      if (step.status !== "pending") continue;
      if (this.closing) {
        shutDownAfter = done.length;
        break;
      }
      if (this.stopRequested.has(id)) {
        stoppedAfter = done.length;
        break;
      }
      await db
        .update(t.jobSteps)
        .set({ status: "running", startedAt: new Date().toISOString() })
        .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.seq, step.seq)));
      this.onChange?.();
      const outcome = await this.ops.run(run(step));
      await db
        .update(t.jobSteps)
        .set({
          status: outcome.ok ? "succeeded" : "failed",
          finishedAt: new Date().toISOString(),
          result: outcome.result,
          actionId: outcome.actionId ?? null,
          verified: outcome.verified ?? null,
        })
        .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.seq, step.seq)));
      if (!outcome.ok) {
        failed = { step, result: outcome.result };
        break;
      }
      results.set(step.seq, outcome.result);
      done.push(step);
    }

    // Undo what can be undone, newest first.
    let undone = 0;
    if (failed && this.ops.undo) {
      for (const step of [...done].reverse()) {
        const outcome = await this.ops.undo(run(step));
        if (!outcome) continue;
        undone++;
        await db
          .update(t.jobSteps)
          .set({
            status: outcome.ok ? "rolled-back" : "failed",
            result: `${results.get(step.seq) ?? ""} Rollback: ${outcome.result}`.trim(),
          })
          .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.seq, step.seq)));
      }
    }

    const at = new Date().toISOString();
    const total = steps.length;
    const status: JobStatus = failed
      ? undone
        ? "rolled-back"
        : "failed"
      : shutDownAfter !== undefined
        ? "interrupted"
        : stoppedAfter !== undefined
          ? "cancelled"
          : "succeeded";
    const summary = failed
      ? `Stopped at step ${failed.step.seq} of ${total} (${failed.step.label}): ${failed.result}${
          undone ? ` ${undone} earlier ${undone === 1 ? "step was" : "steps were"} undone.` : ""
        }`
      : shutDownAfter !== undefined
        ? `Hearth was stopping, so the job stopped after ${shutDownAfter} of ${total} steps. It was not resumed; plan it again to continue.`
        : stoppedAfter !== undefined
          ? `Stopped by you after ${stoppedAfter} of ${total} steps. Nothing done was undone.`
          : (await this.unverified(id))
            ? `All ${total} ${total === 1 ? "step" : "steps"} done; ${await this.unverified(id)} not verified by a read-back yet.`
            : `All ${total} ${total === 1 ? "step" : "steps"} done and verified.`;

    await withTransaction(this.handle, async () => {
      await db
        .update(t.jobSteps)
        .set({ status: "skipped" })
        .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.status, "pending")));
      await db.update(t.jobs).set({ status, finishedAt: at, summary }).where(eq(t.jobs.id, id));
      await recordAudit(db, {
        actor: "dragon-control",
        action:
          status === "succeeded"
            ? `Finished a job: ${job.title}`
            : status === "cancelled"
              ? `Stopped a job: ${job.title}`
              : status === "interrupted"
                ? `A job was interrupted by a restart: ${job.title}`
                : `A job did not finish: ${job.title}`,
        target: `job:${id}`,
        detail: { status, summary },
      });
      if (job.incidentId) {
        await addTimeline(
          db,
          job.incidentId,
          at,
          status === "succeeded" ? "action" : "escalated",
          `Job ${status === "succeeded" ? "finished" : status === "cancelled" ? "stopped" : "did not finish"}: ${summary}`,
        );
      }
    });
    this.onFinished?.(id);
  }

  /**
   * A plan made from a workspace: each step acts on one item and stands alone. Before each step
   * the item is checked against the frozen snapshot and your current choice; then the operation
   * re-reads its target as always. A target that changed is skipped (nothing done), a failure is
   * recorded, and neither stops or undoes the other items. Space is only counted from deletes
   * that were verified.
   */
  private async executePerItem(job: JobRow, steps: StepRow[]) {
    const { db } = this.handle;
    const id = job.id;
    const setStep = (seq: number, set: Partial<StepRow>) =>
      db
        .update(t.jobSteps)
        .set(set)
        .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.seq, seq)));
    const unfinished = new Set<string>(); // items with a step that did not succeed
    let inARow = 0;
    let halted: "stop" | "closing" | "failures" | undefined;
    for (const step of steps) {
      if (step.status !== "pending") continue;
      if (this.closing) halted = "closing";
      else if (this.stopRequested.has(id)) halted = "stop";
      if (halted) break;
      const now = () => new Date().toISOString();
      const itemId = step.itemId ?? "";
      let skip: string | undefined;
      if (unfinished.has(itemId)) skip = "An earlier step for this item did not complete.";
      else if (job.workspaceId && job.snapshotId && this.itemCheck)
        skip = await this.itemCheck(
          { id, workspaceId: job.workspaceId, snapshotId: job.snapshotId },
          { seq: step.seq, itemId, kind: step.kind },
        );
      if (skip) {
        unfinished.add(itemId);
        await setStep(step.seq, {
          status: "skipped",
          finishedAt: now(),
          result: `Skipped: ${skip} Nothing was done to it.`,
        });
        this.onChange?.();
        continue;
      }
      await setStep(step.seq, { status: "running", startedAt: now() });
      this.onChange?.();
      const outcome = await this.ops.run({
        kind: step.kind as StepRun["kind"],
        serviceId: step.serviceId,
        requestedBy: job.requestedBy,
        incidentId: job.incidentId ?? undefined,
        job: { id: job.id, seq: step.seq, approvedAt: job.approvedAt ?? undefined },
        ...(step.params ? { params: step.params } : {}),
        ...(step.change ? { change: step.change } : {}),
      });
      const status = outcome.ok ? "succeeded" : outcome.stale ? "skipped" : "failed";
      await setStep(step.seq, {
        status,
        finishedAt: now(),
        result: outcome.stale ? `Skipped: ${outcome.result}` : outcome.result,
        actionId: outcome.actionId ?? null,
        freedBytes: outcome.ok && outcome.freedBytes ? Math.round(outcome.freedBytes) : null,
        verified: outcome.verified ?? null,
      });
      this.onChange?.();
      if (status !== "succeeded") unfinished.add(itemId);
      inARow = status === "failed" ? inARow + 1 : 0;
      if (inARow >= MAX_FAILURES_IN_A_ROW) {
        halted = "failures";
        break;
      }
    }

    const at = new Date().toISOString();
    const final = await db
      .select()
      .from(t.jobSteps)
      .where(eq(t.jobSteps.jobId, id))
      .orderBy(asc(t.jobSteps.seq));
    const notRun = final.filter((s) => s.status === "pending").length;
    const count = (st: string) => final.filter((s) => s.status === st).length;
    const done = count("succeeded");
    const skipped = count("skipped");
    const failed = count("failed");
    const freed = final.reduce(
      (n, s) => n + (s.status === "succeeded" ? (s.freedBytes ?? 0) : 0),
      0,
    );
    const status: JobStatus =
      halted === "closing"
        ? "interrupted"
        : halted === "stop"
          ? "cancelled"
          : done === final.length
            ? "succeeded"
            : done === 0
              ? "failed"
              : "partial";
    const parts = [
      `${done} of ${final.length} done and verified`,
      ...(skipped ? [`${skipped} skipped (nothing done to them)`] : []),
      ...(failed ? [`${failed} failed`] : []),
      ...(notRun ? [`${notRun} not attempted`] : []),
    ];
    const why =
      halted === "failures"
        ? ` Stopped after ${MAX_FAILURES_IN_A_ROW} failures in a row; the rest were not attempted.`
        : halted === "stop"
          ? " Stopped by you; nothing done was undone."
          : halted === "closing"
            ? " Hearth was stopping; it was not resumed."
            : "";
    const summary = `${parts.join(", ")}.${freed ? ` Verified space freed: ${(freed / 1024 ** 3).toFixed(1)} GB.` : ""}${why}`;
    await withTransaction(this.handle, async () => {
      await db
        .update(t.jobSteps)
        .set({ status: "skipped", result: "Not attempted." })
        .where(and(eq(t.jobSteps.jobId, id), eq(t.jobSteps.status, "pending")));
      await db.update(t.jobs).set({ status, finishedAt: at, summary }).where(eq(t.jobs.id, id));
      await recordAudit(db, {
        actor: "dragon-control",
        action:
          status === "succeeded"
            ? `Finished a job: ${job.title}`
            : status === "partial"
              ? `Finished part of a job: ${job.title}`
              : status === "cancelled"
                ? `Stopped a job: ${job.title}`
                : status === "interrupted"
                  ? `A job was interrupted by a restart: ${job.title}`
                  : `A job did not finish: ${job.title}`,
        target: `job:${id}`,
        detail: { status, summary, done, skipped, failed, freedBytes: freed },
      });
      if (job.incidentId) {
        await addTimeline(
          db,
          job.incidentId,
          at,
          status === "succeeded" ? "action" : "escalated",
          `Job ${status === "succeeded" ? "finished" : "finished with items not done"}: ${summary}`,
        );
      }
    });
    this.onFinished?.(id);
  }

  /**
   * After a restart: a job that was running is marked interrupted, never
   * resumed on its own. What it already did stays recorded; plan it again to
   * continue (which needs a fresh approval).
   */
  async recoverInterrupted(): Promise<number> {
    const { db } = this.handle;
    const running = await db.select().from(t.jobs).where(eq(t.jobs.status, "running"));
    const at = new Date().toISOString();
    for (const job of running) {
      await withTransaction(this.handle, async () => {
        await db
          .update(t.jobSteps)
          .set({
            status: "interrupted",
            finishedAt: at,
            result: "Hearth restarted during this step; check the service before running it again.",
          })
          .where(and(eq(t.jobSteps.jobId, job.id), eq(t.jobSteps.status, "running")));
        await db
          .update(t.jobSteps)
          .set({ status: "skipped" })
          .where(and(eq(t.jobSteps.jobId, job.id), eq(t.jobSteps.status, "pending")));
        await db
          .update(t.jobs)
          .set({
            status: "interrupted",
            finishedAt: at,
            summary:
              "Hearth restarted while this job was running. It was not resumed; plan it again to continue.",
          })
          .where(eq(t.jobs.id, job.id));
        await recordAudit(db, {
          actor: "dragon-control",
          action: `A job was interrupted by a restart: ${job.title}`,
          target: `job:${job.id}`,
        });
      });
    }
    return running.length;
  }
}
