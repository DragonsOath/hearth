import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import {
  DEFAULT_STALL_MINUTES,
  type ReportedWorkStatus,
  type TrackedWork,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { InvalidRequestError, NotFoundError } from "../store/errors";

type Row = typeof t.trackedWork.$inferSelect;

/** Something the owner should hear about, once. */
export interface WorkAlert {
  kind: "stalled" | "overdue" | "failed" | "done";
  work: TrackedWork;
}

const toWork = (r: Row, now: Date): TrackedWork => ({
  id: r.id,
  title: r.title,
  machine: r.machine,
  status: r.status,
  progress: r.progress ?? undefined,
  detail: r.detail ?? undefined,
  startedAt: r.startedAt,
  heartbeatAt: r.heartbeatAt,
  stopBy: r.stopBy ?? undefined,
  stallMinutes: r.stallMinutes,
  finishedAt: r.finishedAt ?? undefined,
  reportedBy: r.reportedBy,
  overdue:
    (r.status === "running" || r.status === "stalled") && r.stopBy
      ? now.toISOString() > r.stopBy
      : undefined,
});

const FINISHED = ["done", "failed", "stopped"] as const;

/**
 * Long work: created by whatever runs it (a script with an access key that has the "work"
 * scope), which then reports progress. Hearth decides "stalled" itself, from the
 * heartbeat, and says so once; a report after that brings it back to running.
 */
export class Work {
  constructor(
    private readonly handle: DbHandle,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(input: {
    title: string;
    machine: string;
    stopBy?: string;
    stallMinutes?: number;
    detail?: string;
    progress?: number;
    reportedBy: string;
  }): Promise<TrackedWork> {
    const title = input.title.trim();
    const machine = input.machine.trim();
    if (!title || !machine) throw new InvalidRequestError("Long work needs a title and a machine.");
    if (input.stopBy && Number.isNaN(Date.parse(input.stopBy))) {
      throw new InvalidRequestError("The stop time is not a date and time.");
    }
    const at = this.now().toISOString();
    const row: Row = {
      id: randomUUID(),
      title,
      machine,
      status: "running",
      progress: input.progress ?? null,
      detail: input.detail?.trim() || null,
      startedAt: at,
      heartbeatAt: at,
      stopBy: input.stopBy ? new Date(input.stopBy).toISOString() : null,
      stallMinutes: input.stallMinutes ?? DEFAULT_STALL_MINUTES,
      finishedAt: null,
      reportedBy: input.reportedBy,
      alerted: [],
    };
    await this.handle.db.insert(t.trackedWork).values(row);
    return toWork(row, this.now());
  }

  /** A progress report. Any report is a heartbeat; a finished status closes the work. */
  async report(
    id: string,
    input: { progress?: number; detail?: string; status?: ReportedWorkStatus },
  ): Promise<TrackedWork> {
    const { db } = this.handle;
    const row = await db.select().from(t.trackedWork).where(eq(t.trackedWork.id, id)).get();
    if (!row) throw new NotFoundError("No such long work.");
    if ((FINISHED as readonly string[]).includes(row.status)) {
      throw new InvalidRequestError(
        `That work already ${row.status === "done" ? "finished" : row.status}.`,
      );
    }
    const at = this.now().toISOString();
    const status = input.status ?? "running";
    const finished = (FINISHED as readonly string[]).includes(status);
    const patch: Partial<Row> = {
      status,
      heartbeatAt: at,
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.detail !== undefined ? { detail: input.detail.trim() || null } : {}),
      ...(finished ? { finishedAt: at } : {}),
      // Back to running after a stall: a later stall is news again.
      ...(row.status === "stalled" && status === "running"
        ? { alerted: row.alerted.filter((a) => a !== "stalled") }
        : {}),
    };
    await db.update(t.trackedWork).set(patch).where(eq(t.trackedWork.id, id));
    return toWork({ ...row, ...patch }, this.now());
  }

  async get(id: string): Promise<TrackedWork> {
    const row = await this.handle.db
      .select()
      .from(t.trackedWork)
      .where(eq(t.trackedWork.id, id))
      .get();
    if (!row) throw new NotFoundError("No such long work.");
    return toWork(row, this.now());
  }

  /** What is going on now, and what finished in the last two days. */
  async list(): Promise<TrackedWork[]> {
    const since = new Date(this.now().getTime() - 2 * 86_400_000).toISOString();
    const rows = await this.handle.db
      .select()
      .from(t.trackedWork)
      .where(
        or(
          inArray(t.trackedWork.status, ["running", "stalled"]),
          gte(t.trackedWork.finishedAt, since),
        ),
      )
      .orderBy(desc(t.trackedWork.startedAt))
      .limit(50);
    return rows.map((r) => toWork(r, this.now()));
  }

  /**
   * Marks work whose heartbeat stopped as stalled, and returns each alert not yet sent:
   * stalled, past its stop time, failed, or finished. Called on a timer.
   */
  async sweep(): Promise<WorkAlert[]> {
    const { db } = this.handle;
    const now = this.now();
    const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const rows = await db
      .select()
      .from(t.trackedWork)
      .where(
        or(
          inArray(t.trackedWork.status, ["running", "stalled"]),
          and(
            inArray(t.trackedWork.status, ["done", "failed"]),
            gte(t.trackedWork.finishedAt, since),
          ),
        ),
      );
    const alerts: WorkAlert[] = [];
    for (const row of rows) {
      let current = row;
      const quietFor = now.getTime() - Date.parse(row.heartbeatAt);
      if (row.status === "running" && quietFor > row.stallMinutes * 60_000) {
        current = { ...row, status: "stalled" };
        await db
          .update(t.trackedWork)
          .set({ status: "stalled" })
          .where(eq(t.trackedWork.id, row.id));
      }
      const due: WorkAlert["kind"][] = [];
      if (current.status === "stalled") due.push("stalled");
      if (current.status === "failed") due.push("failed");
      if (current.status === "done") due.push("done");
      if (
        (current.status === "running" || current.status === "stalled") &&
        current.stopBy &&
        now.toISOString() > current.stopBy
      ) {
        due.push("overdue");
      }
      const fresh = due.filter((k) => !current.alerted.includes(k));
      if (!fresh.length) continue;
      await db
        .update(t.trackedWork)
        .set({ alerted: [...current.alerted, ...fresh] })
        .where(eq(t.trackedWork.id, row.id));
      for (const kind of fresh) alerts.push({ kind, work: toWork(current, now) });
    }
    return alerts;
  }
}
