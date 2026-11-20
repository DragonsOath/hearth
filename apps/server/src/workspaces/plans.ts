import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  ActionKind,
  JobStepInput,
  StepParams,
  WorkspaceChoice,
  WorkspaceItem,
  WorkspaceItemPlanStatus,
  WorkspacePlanView,
  WorkspaceSnapshot,
  WorkspaceView,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { Jobs } from "../jobs/engine";
import type { PlannedStep } from "../jobs/operations";
import { InvalidRequestError, NotFoundError } from "../store/errors";
import { effective, type Workspaces } from "./service";

/**
 * Stage 2 of interactive workspaces (feature request 20.6): your submitted decisions become an
 * approval plan made of operations Hearth already has.
 *
 * - Submitting freezes a snapshot (ids, choices, items as shown). A plan points at it, and the
 *   approval fingerprint covers it, so editing the workspace afterwards never changes the plan.
 * - Only items whose submitted choice acts (Discard) can be steps, and each step must really act
 *   on its item (its file, title, or release matches the item).
 * - Before each step runs: the snapshot still says act, and your current choice still acts (if
 *   you changed it to Keep, the item is skipped). Then the operation re-reads its target as it
 *   always does; a changed target is skipped, never guessed at.
 * - Items run independently; each one's result is shown in the workspace.
 */

type SnapshotRow = typeof t.workspaceSnapshots.$inferSelect;

const toSnapshot = (r: SnapshotRow): WorkspaceSnapshot => ({
  id: r.id,
  workspaceId: r.workspaceId,
  at: r.at,
  title: r.title,
  choices: r.choices as WorkspaceChoice[],
  decisions: r.decisions as Record<string, string>,
  items: r.items as WorkspaceItem[],
});

const ACTIVE = ["awaiting-approval", "running"];

export async function writeSnapshot(
  handle: DbHandle,
  v: WorkspaceView,
  decisions: Record<string, string>,
  at: string,
): Promise<string> {
  const id = randomUUID();
  await handle.db.insert(t.workspaceSnapshots).values({
    id,
    workspaceId: v.id,
    conversationId: v.conversationId ?? null,
    at,
    title: v.spec.title,
    choices: v.spec.choices ?? [],
    decisions,
    items: v.spec.items.filter((i) => decisions[i.id] !== undefined),
  });
  return id;
}

export async function latestSnapshot(
  handle: DbHandle,
  workspaceId: string,
): Promise<WorkspaceSnapshot | undefined> {
  const r = await handle.db
    .select()
    .from(t.workspaceSnapshots)
    .where(eq(t.workspaceSnapshots.workspaceId, workspaceId))
    .orderBy(desc(t.workspaceSnapshots.at))
    .get();
  return r ? toSnapshot(r) : undefined;
}

export async function snapshotById(
  handle: DbHandle,
  id: string,
): Promise<WorkspaceSnapshot | undefined> {
  const r = await handle.db
    .select()
    .from(t.workspaceSnapshots)
    .where(eq(t.workspaceSnapshots.id, id))
    .get();
  return r ? toSnapshot(r) : undefined;
}

/** Items whose current choice differs from what the snapshot froze. */
export function changedSince(v: WorkspaceView, snap: WorkspaceSnapshot): string[] {
  const now = effective(v.spec, v.selections);
  const ids = new Set([...Object.keys(now), ...Object.keys(snap.decisions)]);
  return [...ids].filter((id) => now[id] !== snap.decisions[id]);
}

/** Plans made from this workspace, newest first, with each item's result. */
export async function plansFor(
  handle: DbHandle,
  workspaceId: string,
): Promise<WorkspacePlanView[]> {
  const { db } = handle;
  const jobs = await db
    .select()
    .from(t.jobs)
    .where(eq(t.jobs.workspaceId, workspaceId))
    .orderBy(desc(t.jobs.createdAt))
    .limit(10);
  if (!jobs.length) return [];
  const steps = await db
    .select()
    .from(t.jobSteps)
    .where(
      inArray(
        t.jobSteps.jobId,
        jobs.map((j) => j.id),
      ),
    )
    .orderBy(asc(t.jobSteps.seq));
  const snaps = await db
    .select({ id: t.workspaceSnapshots.id, at: t.workspaceSnapshots.at })
    .from(t.workspaceSnapshots)
    .where(
      inArray(
        t.workspaceSnapshots.id,
        jobs.map((j) => j.snapshotId ?? ""),
      ),
    );
  return jobs.map((j) => {
    const finished = !ACTIVE.includes(j.status);
    const items: WorkspacePlanView["items"] = {};
    for (const s of steps.filter((x) => x.jobId === j.id && x.itemId)) {
      const st: WorkspaceItemPlanStatus =
        s.status === "succeeded"
          ? "done"
          : s.status === "running"
            ? "running"
            : s.status === "skipped"
              ? // Declined, replaced, or never reached: not run. Otherwise skipped for a reason.
                !s.result || s.result === "Not attempted."
                ? "not-run"
                : "skipped"
              : s.status === "pending"
                ? finished
                  ? "not-run"
                  : "planned"
                : "failed";
      const prev = items[s.itemId!];
      const rank: WorkspaceItemPlanStatus[] = [
        "failed",
        "skipped",
        "running",
        "planned",
        "not-run",
        "done",
      ];
      // One item with several steps shows its worst result.
      const status = prev && rank.indexOf(prev.status) < rank.indexOf(st) ? prev.status : st;
      items[s.itemId!] = {
        status,
        label: prev ? `${prev.label}; ${s.label}` : s.label,
        result: [prev?.result, s.result].filter(Boolean).join(" ") || undefined,
      };
    }
    const counts = {
      planned: 0,
      running: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      "not-run": 0,
    } as WorkspacePlanView["counts"];
    for (const i of Object.values(items)) counts[i.status]++;
    const freed = steps
      .filter((s) => s.jobId === j.id && s.status === "succeeded")
      .reduce((n, s) => n + (s.freedBytes ?? 0), 0);
    return {
      jobId: j.id,
      title: j.title,
      status: j.status,
      ...(j.summary ? { summary: j.summary } : {}),
      snapshotId: j.snapshotId ?? "",
      snapshotAt: snaps.find((x) => x.id === j.snapshotId)?.at ?? j.createdAt,
      createdAt: j.createdAt,
      ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
      items,
      counts,
      ...(freed ? { freedBytes: freed } : {}),
    };
  });
}

/** What identifies a planned step's target, to tie it to exactly one workspace item. */
function targetsOf(p: PlannedStep): string[] {
  const params: StepParams = p.params ?? {};
  return ["path", "file", "release", "title", "hash", "ratingKey"]
    .map((k) => params[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export interface WorkspacePlanInput {
  workspaceId: string;
  title: string;
  reason: string;
  steps: (JobStepInput & { item: string })[];
}

export class WorkspacePlans {
  constructor(
    private readonly handle: DbHandle,
    private readonly workspaces: Workspaces,
    private readonly jobs: Jobs,
  ) {}

  /**
   * Makes the approval plan for a workspace's latest submission. Refused when you changed choices
   * after submitting (submit again first), when an item's submitted choice does not act, or when a
   * step does not act on its item. A plan still waiting from an earlier submission is replaced.
   */
  async propose(conversationId: string, input: WorkspacePlanInput) {
    const v = await this.workspaces.get(input.workspaceId);
    if (v.conversationId !== conversationId)
      throw new InvalidRequestError("That workspace belongs to another conversation.");
    const snap = await latestSnapshot(this.handle, v.id);
    if (!snap)
      throw new InvalidRequestError(
        "The owner has not submitted this workspace yet: a plan is only made from submitted decisions.",
      );
    const changed = changedSince(v, snap);
    if (changed.length)
      throw new InvalidRequestError(
        `The owner changed ${changed.length} choice${changed.length === 1 ? "" : "s"} after submitting at ${snap.at.slice(11, 16)} UTC. Ask them to submit again (the panel offers it); a plan is never made from decisions they have since changed.`,
      );
    const acting = new Set(snap.choices.filter((c) => c.acts).map((c) => c.value));
    if (!acting.size)
      throw new InvalidRequestError(
        "None of this workspace's choices is marked as one that acts (acts: true, for example Discard), so no item can become a plan step. Update the choices, and the owner submits again.",
      );
    const byId = new Map(snap.items.map((i) => [i.id, i]));
    for (const s of input.steps) {
      const decision = snap.decisions[s.item];
      if (!byId.has(s.item) || decision === undefined)
        throw new InvalidRequestError(`"${s.item}" is not among the submitted decisions.`);
      if (!acting.has(decision)) {
        const label = snap.choices.find((c) => c.value === decision)?.label ?? decision;
        throw new InvalidRequestError(
          `The owner chose "${label}" for "${s.item}": a plan can only act on items they chose to act on.`,
        );
      }
    }
    const job = await this.jobs.create({
      title: input.title,
      reason: input.reason,
      steps: input.steps.map(({ kind, serviceId, params }) => ({
        kind: kind as ActionKind,
        serviceId,
        ...(params ? { params } : {}),
      })),
      requestedBy: "agent",
      ...(v.conversationId ? { conversationId: v.conversationId } : {}),
      workspace: {
        workspaceId: v.id,
        snapshotId: snap.id,
        itemIds: input.steps.map((s) => s.item),
        bind: (planned, i) => {
          const item = byId.get(input.steps[i]!.item)!;
          const mine = new Set(
            [item.id, ...Object.values(item.values)].filter(
              (x): x is string => typeof x === "string",
            ),
          );
          const targets = targetsOf(planned);
          if (!targets.length)
            return `"${planned.label}" cannot be tied to one item, so it cannot be part of a workspace plan.`;
          return targets.some((x) => mine.has(x))
            ? undefined
            : `"${planned.label}" acts on ${targets.join(" / ")}, which is not the item "${item.id}".`;
        },
      },
    });
    // An earlier plan for this workspace still waiting for approval is replaced.
    const older = await this.handle.db
      .select({ id: t.jobs.id })
      .from(t.jobs)
      .where(and(eq(t.jobs.workspaceId, v.id), eq(t.jobs.status, "awaiting-approval")));
    for (const o of older) if (o.id !== job.id) await this.jobs.supersede(o.id, job.id);
    return { job, snapshot: snap };
  }

  /**
   * Just before a step runs: is the item still one you chose to act on? Reasons to skip come
   * back in plain words; nothing means go ahead (the operation then re-reads its target).
   */
  async check(
    job: { workspaceId: string; snapshotId: string },
    step: { itemId: string },
  ): Promise<string | undefined> {
    const snap = await snapshotById(this.handle, job.snapshotId);
    if (!snap) return "The submitted decisions behind this plan could not be found.";
    const decision = snap.decisions[step.itemId];
    const acting = new Set(snap.choices.filter((c) => c.acts).map((c) => c.value));
    if (decision === undefined || !acting.has(decision))
      return "The approved decisions do not say to act on this item.";
    // Your current choice: a change of mind after approving always wins, in the safe direction.
    const v = await this.workspaces.get(job.workspaceId).catch((e: unknown) => {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    });
    if (!v || !v.spec.items.some((i) => i.id === step.itemId)) return undefined;
    const now = effective(v.spec, v.selections)[step.itemId];
    if (now === undefined) return "You cleared your choice for it after this plan was made.";
    if (!acting.has(now)) {
      const label = v.spec.choices?.find((c) => c.value === now)?.label ?? now;
      return `You changed it to "${label}" after this plan was made.`;
    }
    return undefined;
  }
}
