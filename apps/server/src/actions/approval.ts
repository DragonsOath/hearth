import { createHash } from "node:crypto";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { APPROVAL_WINDOW_HOURS, type ApprovalTicket } from "@dragon-control/core";
import type { Database, DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { addTimeline } from "../monitor/engine";
import { recordAudit } from "../store/audit";

/**
 * Approvals are bound to one exact proposal. The fingerprint covers the
 * incident, the words you were shown, the action that would run (its id,
 * kind, and target), and the expiry, so any change to any of them needs a
 * fresh approval. Everything it covers is stored, so the fingerprint is the
 * same after a restart and an expired proposal stays expired.
 */

export const APPROVAL_WINDOW_MS = APPROVAL_WINDOW_HOURS * 60 * 60 * 1000;

export function approvalExpiry(now = new Date()): string {
  return new Date(now.getTime() + APPROVAL_WINDOW_MS).toISOString();
}

type IncidentRow = typeof t.incidents.$inferSelect;
type ActionRow = typeof t.actions.$inferSelect;

export function fingerprint(incident: IncidentRow, action: ActionRow | undefined): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        incident.id,
        incident.proposedAction,
        incident.proposalExpiresAt,
        action ? [action.id, action.kind, action.targetType, action.targetId] : null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/** The action waiting on this incident's approval, if a runnable one exists. */
export async function pendingAction(db: Database, incidentId: string) {
  return db
    .select()
    .from(t.actions)
    .where(and(eq(t.actions.incidentId, incidentId), eq(t.actions.status, "requested")))
    .get();
}

/** What the person approving must send back, for an incident awaiting approval. */
export async function ticketFor(
  db: Database,
  incident: IncidentRow,
): Promise<ApprovalTicket | undefined> {
  if (incident.status !== "awaiting-approval" || !incident.proposedAction) return undefined;
  if (!incident.proposalExpiresAt) return undefined;
  const action = await pendingAction(db, incident.id);
  return {
    fingerprint: fingerprint(incident, action),
    expiresAt: incident.proposalExpiresAt,
  };
}

/**
 * Closes proposals nobody approved in time: nothing runs, the incident goes
 * back to you, and the waiting action is refused. Safe to call at any time.
 */
export async function expireApprovals(handle: DbHandle, now = new Date()): Promise<number> {
  const { db } = handle;
  const stale = await db
    .select()
    .from(t.incidents)
    .where(
      and(
        eq(t.incidents.status, "awaiting-approval"),
        isNotNull(t.incidents.proposalExpiresAt),
        lt(t.incidents.proposalExpiresAt, now.toISOString()),
      ),
    );
  const at = now.toISOString();
  for (const incident of stale) {
    await withTransaction(handle, async () => {
      await db
        .update(t.incidents)
        .set({
          status: "open",
          handledBy: "pending",
          proposedAction: null,
          proposalExpiresAt: null,
        })
        .where(and(eq(t.incidents.id, incident.id), eq(t.incidents.status, "awaiting-approval")));
      await db
        .update(t.actions)
        .set({
          status: "refused",
          result: "Not approved in time, so it was not carried out.",
          completedAt: at,
        })
        .where(and(eq(t.actions.incidentId, incident.id), eq(t.actions.status, "requested")));
      await addTimeline(
        db,
        incident.id,
        at,
        "approval",
        "The proposed repair was not approved in time, so nothing was changed. It stays open for you.",
      );
      await recordAudit(db, {
        actor: "dragon-control",
        action: "A proposed repair expired unapproved",
        target: `incident:${incident.id}`,
        detail: { proposedAction: incident.proposedAction, expiredAt: incident.proposalExpiresAt },
      });
    });
  }
  return stale.length + (await expireJobs(handle, now));
}

/** Plans nobody approved in time: nothing runs, and they can never be approved. */
async function expireJobs(handle: DbHandle, now: Date): Promise<number> {
  const { db } = handle;
  const at = now.toISOString();
  const stale = await db
    .select()
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.status, "awaiting-approval"),
        isNotNull(t.jobs.expiresAt),
        lt(t.jobs.expiresAt, at),
      ),
    );
  for (const job of stale) {
    await withTransaction(handle, async () => {
      await db
        .update(t.jobs)
        .set({
          status: "expired",
          finishedAt: at,
          summary: "Not approved in time, so nothing was changed.",
        })
        .where(and(eq(t.jobs.id, job.id), eq(t.jobs.status, "awaiting-approval")));
      await db
        .update(t.jobSteps)
        .set({ status: "skipped" })
        .where(and(eq(t.jobSteps.jobId, job.id), eq(t.jobSteps.status, "pending")));
      await recordAudit(db, {
        actor: "dragon-control",
        action: `A planned job expired unapproved: ${job.title}`,
        target: `job:${job.id}`,
        detail: { expiredAt: job.expiresAt },
      });
      if (job.incidentId) {
        await addTimeline(
          db,
          job.incidentId,
          at,
          "approval",
          `The planned job was not approved in time, so nothing was changed: ${job.title}.`,
        );
      }
    });
  }
  return stale.length;
}
