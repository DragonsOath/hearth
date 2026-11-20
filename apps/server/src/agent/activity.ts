import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { CaveActivity } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";

/**
 * Live progress for Ember. Each row is written when the work starts
 * and finished when it ends, so the app only ever shows what really
 * happened (or is happening now), never a planned checklist.
 */

const JOB_STATUS: Record<(typeof t.jobs.$inferSelect)["status"], CaveActivity["status"]> = {
  "awaiting-approval": "waiting",
  running: "running",
  succeeded: "done",
  // Finished with some items not done: shown as done, the summary says which were not.
  partial: "done",
  failed: "failed",
  refused: "failed",
  "rolled-back": "failed",
  cancelled: "stopped",
  expired: "stopped",
  interrupted: "stopped",
};

export interface Turn {
  conversationId: string;
  /** The owner's message being answered. */
  messageId: number;
}

type Status = CaveActivity["status"];

export class Activity {
  constructor(private readonly handle: DbHandle) {}

  async start(
    turn: Turn,
    kind: CaveActivity["kind"],
    label: string,
    opts: { ref?: string; status?: Status; detail?: string; show?: CaveActivity["show"] } = {},
  ): Promise<number> {
    const status = opts.status ?? "running";
    const at = new Date().toISOString();
    // Insert and read back the id together, so parallel tool calls never swap ids.
    return withTransaction(this.handle, async () => {
      await this.handle.db.insert(t.conversationActivity).values({
        conversationId: turn.conversationId,
        messageId: turn.messageId,
        kind,
        label: label.slice(0, 200),
        status,
        detail: opts.detail?.slice(0, 400) ?? null,
        ref: opts.ref ?? null,
        show: opts.show ?? null,
        at,
        finishedAt: status === "running" ? null : at,
      });
      const row = await this.handle.db
        .select({ id: t.conversationActivity.id })
        .from(t.conversationActivity)
        .orderBy(desc(t.conversationActivity.id))
        .limit(1)
        .get();
      return row!.id;
    });
  }

  /** Ends a step; `label` replaces the running wording ("Checking..." becomes "Checked..."). */
  async finish(
    id: number,
    status: Exclude<Status, "running">,
    opts: {
      detail?: string;
      label?: string;
      show?: CaveActivity["show"];
      evidence?: CaveActivity["evidence"];
    } = {},
  ) {
    await this.handle.db
      .update(t.conversationActivity)
      .set({
        status,
        finishedAt: new Date().toISOString(),
        ...(opts.detail !== undefined ? { detail: opts.detail.slice(0, 400) } : {}),
        ...(opts.label !== undefined ? { label: opts.label.slice(0, 200) } : {}),
        ...(opts.show !== undefined ? { show: opts.show } : {}),
        ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
      })
      .where(eq(t.conversationActivity.id, id));
  }

  /** Anything still running for this turn when the answer is given (or the work is abandoned). */
  async settle(turn: Turn, detail: string) {
    await this.handle.db
      .update(t.conversationActivity)
      .set({ status: "stopped", detail, finishedAt: new Date().toISOString() })
      .where(
        and(
          eq(t.conversationActivity.conversationId, turn.conversationId),
          eq(t.conversationActivity.messageId, turn.messageId),
          eq(t.conversationActivity.status, "running"),
          ne(t.conversationActivity.kind, "job"),
        ),
      );
  }

  /** After a restart nothing is still running: say so instead of spinning forever. */
  async recoverInterrupted() {
    await this.handle.db
      .update(t.conversationActivity)
      .set({
        status: "stopped",
        detail: "Hearth restarted before this finished.",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(t.conversationActivity.status, "running"));
  }

  async forConversation(conversationId: string): Promise<Map<number, CaveActivity[]>> {
    const rows = await this.handle.db
      .select()
      .from(t.conversationActivity)
      .where(eq(t.conversationActivity.conversationId, conversationId))
      .orderBy(asc(t.conversationActivity.id));
    // A plan's row always shows the job as it is now: jobs keep going after the answer.
    const jobIds = rows.filter((r) => r.ref?.startsWith("job:")).map((r) => r.ref!.slice(4));
    const jobs = new Map(
      (jobIds.length
        ? await this.handle.db.select().from(t.jobs).where(inArray(t.jobs.id, jobIds))
        : []
      ).map((j) => [j.id, j]),
    );
    const out = new Map<number, CaveActivity[]>();
    for (const row of rows) {
      const job = row.ref?.startsWith("job:") ? jobs.get(row.ref.slice(4)) : undefined;
      const r = job
        ? { ...row, status: JOB_STATUS[job.status], detail: job.summary ?? row.detail }
        : row;
      const list = out.get(r.messageId) ?? [];
      list.push({
        id: r.id,
        kind: r.kind,
        label: r.label,
        status: r.status,
        at: r.at,
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.ref ? { ref: r.ref } : {}),
        ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
        ...(r.show ? { show: r.show } : {}),
        ...(r.evidence ? { evidence: r.evidence as CaveActivity["evidence"] } : {}),
      });
      out.set(r.messageId, list);
    }
    return out;
  }
}
