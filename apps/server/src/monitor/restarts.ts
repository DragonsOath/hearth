import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { ContainerFacts, ContainerTools } from "../actions/tools";
import { getSetting, setSetting } from "../store/settings";

/**
 * Restart history (feature request 4.3 and 12.3): each start and stop of a
 * watched container, read from Docker's own inspect data (state, start and
 * finish times, exit code, out-of-memory, restart count) every RESTART_SWEEP
 * minutes. Nothing else from the inspect response is kept.
 *
 * A start is attributed from evidence only: an action Hearth ran on
 * that service within a couple of minutes ("dragon-control"), Docker's restart
 * count going up ("docker", its restart policy), otherwise "outside" (a deploy,
 * a manual restart, a host reboot). The first time a container is seen its
 * current run is recorded as "first-seen".
 *
 * Storage limits: rows older than the retention (30, 90, or 180 days; default
 * 90) are deleted daily, and at most RESTART_KEEP_PER_SERVICE rows are kept
 * per service. Switching it off stops recording; what is kept stays until
 * the retention removes it.
 */

export const RESTART_SWEEP_MINUTES = 5;
export const RESTART_RETENTION_CHOICES = [30, 90, 180] as const;
export const RESTART_DEFAULTS = { enabled: true, retentionDays: 90 } as const;
export const RESTART_KEEP_PER_SERVICE = 300;
/** Measured bytes per row with its index (see restarts.test.ts). */
export const RESTART_ROW_BYTES = 200;
const ACTION_WINDOW_MS = 3 * 60_000;
const START_ACTIONS = ["restart-container", "start-container"];

export type RestartCause = "first-seen" | "dragon-control" | "docker" | "outside";

export interface ContainerEvent {
  serviceId: string;
  at: string;
  kind: "start" | "stop";
  exitCode?: number;
  oomKilled?: boolean;
  restartCount?: number;
  cause: RestartCause | "exit";
  actionId?: string;
}

export class RestartLog {
  private lastSweep = 0;
  private lastPrune = 0;

  constructor(
    private readonly handle: DbHandle,
    private readonly containers: ContainerTools,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async settings(): Promise<{ enabled: boolean; retentionDays: number }> {
    return { ...RESTART_DEFAULTS, ...(await getSetting(this.handle.db, "restart_history")) };
  }

  async update(patch: { enabled?: boolean; retentionDays?: number }) {
    const next = { ...(await this.settings()), ...patch };
    if (
      !RESTART_RETENTION_CHOICES.includes(
        next.retentionDays as (typeof RESTART_RETENTION_CHOICES)[number],
      )
    ) {
      throw new Error(`Retention must be one of ${RESTART_RETENTION_CHOICES.join(", ")} days.`);
    }
    await setSetting(this.handle.db, "restart_history", next);
    if (patch.retentionDays !== undefined) await this.prune(true);
    return next;
  }

  async stored(): Promise<{ rows: number; bytes: number; oldest?: string }> {
    const r = await this.handle.db
      .select({
        n: sql<number>`count(*)`,
        oldest: sql<string | null>`min(${t.containerEvents.at})`,
      })
      .from(t.containerEvents)
      .get();
    const rows = Number(r?.n ?? 0);
    return { rows, bytes: rows * RESTART_ROW_BYTES, ...(r?.oldest ? { oldest: r.oldest } : {}) };
  }

  /** Called on every monitoring pass; reads Docker every RESTART_SWEEP_MINUTES when on. */
  async tick(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastSweep < RESTART_SWEEP_MINUTES * 60_000 - 5_000) return;
    if (!(await this.settings()).enabled) return;
    this.lastSweep = now;
    await this.sweep();
    if (now - this.lastPrune > 86_400_000) await this.prune();
  }

  /** One look at every watched container. Returns the events recorded. */
  async sweep(): Promise<number> {
    const rows = await this.handle.db
      .select({ id: t.services.id, target: t.services.checkTarget })
      .from(t.services)
      .where(and(eq(t.services.kind, "container"), eq(t.services.lifecycle, "active")));
    const watched = rows.filter((r) => r.target?.startsWith("container:"));
    let written = 0;
    for (let i = 0; i < watched.length; i += 6) {
      const batch = watched.slice(i, i + 6);
      const read = await Promise.all(
        batch.map(async (r) => ({
          serviceId: r.id,
          facts: await this.containers
            .facts(r.target!.slice("container:".length))
            .catch(() => undefined),
        })),
      );
      for (const { serviceId, facts } of read) {
        if (facts) written += await this.observe(serviceId, facts);
      }
    }
    return written;
  }

  /** Records what changed since the last look at this service. */
  async observe(serviceId: string, f: ContainerFacts): Promise<number> {
    const { db } = this.handle;
    const last = await db
      .select()
      .from(t.containerEvents)
      .where(eq(t.containerEvents.serviceId, serviceId))
      .orderBy(desc(t.containerEvents.at))
      .limit(1)
      .get();
    const lastStart = await db
      .select()
      .from(t.containerEvents)
      .where(and(eq(t.containerEvents.serviceId, serviceId), eq(t.containerEvents.kind, "start")))
      .orderBy(desc(t.containerEvents.at))
      .limit(1)
      .get();
    const events: ContainerEvent[] = [];

    if (f.running && f.startedAt) {
      if (!lastStart || lastStart.at < f.startedAt) {
        // The previous run's end, when Docker still has it and it is not recorded yet.
        if (
          lastStart &&
          f.finishedAt &&
          f.finishedAt > lastStart.at &&
          f.finishedAt < f.startedAt
        ) {
          events.push({
            serviceId,
            at: f.finishedAt,
            kind: "stop",
            exitCode: f.exitCode,
            oomKilled: f.oomKilled,
            cause: "exit",
          });
        }
        const by = lastStart ? await this.actionNear(serviceId, f.startedAt) : undefined;
        const cause: RestartCause = !lastStart
          ? "first-seen"
          : by
            ? "dragon-control"
            : f.restartCount !== undefined &&
                lastStart.restartCount !== null &&
                f.restartCount > lastStart.restartCount
              ? "docker"
              : "outside";
        events.push({
          serviceId,
          at: f.startedAt,
          kind: "start",
          restartCount: f.restartCount,
          cause,
          ...(by ? { actionId: by } : {}),
        });
      }
    } else if (!f.running && f.finishedAt && (!last || last.at < f.finishedAt)) {
      events.push({
        serviceId,
        at: f.finishedAt,
        kind: "stop",
        exitCode: f.exitCode,
        oomKilled: f.oomKilled,
        cause: "exit",
      });
    }

    const recordedAt = this.now().toISOString();
    for (const e of events) {
      await db
        .insert(t.containerEvents)
        .values({
          serviceId: e.serviceId,
          at: e.at,
          kind: e.kind,
          exitCode: e.exitCode ?? null,
          oomKilled: e.oomKilled ?? null,
          restartCount: e.restartCount ?? null,
          cause: e.cause,
          actionId: e.actionId ?? null,
          recordedAt,
        })
        .onConflictDoNothing();
    }
    return events.length;
  }

  /** An action Hearth ran that would explain a start at this time. */
  private async actionNear(serviceId: string, at: string): Promise<string | undefined> {
    const when = Date.parse(at);
    const rows = await this.handle.db
      .select({ id: t.actions.id, at: t.actions.requestedAt, done: t.actions.completedAt })
      .from(t.actions)
      .where(
        and(
          eq(t.actions.targetType, "service"),
          eq(t.actions.targetId, serviceId),
          inArray(t.actions.kind, START_ACTIONS),
          gte(t.actions.requestedAt, new Date(when - ACTION_WINDOW_MS).toISOString()),
        ),
      );
    return rows.find((r) => Date.parse(r.at) <= when + 60_000)?.id;
  }

  async list(serviceId: string, limit = 100): Promise<ContainerEvent[]> {
    const rows = await this.handle.db
      .select()
      .from(t.containerEvents)
      .where(eq(t.containerEvents.serviceId, serviceId))
      .orderBy(desc(t.containerEvents.at))
      .limit(limit);
    return rows.map((r) => ({
      serviceId: r.serviceId,
      at: r.at,
      kind: r.kind,
      ...(r.exitCode !== null ? { exitCode: r.exitCode } : {}),
      ...(r.oomKilled !== null ? { oomKilled: r.oomKilled } : {}),
      ...(r.restartCount !== null ? { restartCount: r.restartCount } : {}),
      cause: r.cause as ContainerEvent["cause"],
      ...(r.actionId ? { actionId: r.actionId } : {}),
    }));
  }

  /** Retention, then the per-service cap. */
  async prune(force = false): Promise<number> {
    const now = this.now();
    if (!force && now.getTime() - this.lastPrune < 86_400_000) return 0;
    this.lastPrune = now.getTime();
    const { retentionDays } = await this.settings();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const { sqlite } = this.handle;
    const old = sqlite.prepare("DELETE FROM container_events WHERE at < ?").run(cutoff);
    const capped = sqlite
      .prepare(
        `DELETE FROM container_events WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, row_number() OVER (PARTITION BY service_id ORDER BY at DESC) AS n
             FROM container_events
           ) WHERE n > ?
         )`,
      )
      .run(RESTART_KEEP_PER_SERVICE);
    return Number(old.changes ?? 0) + Number(capped.changes ?? 0);
  }
}

/** Plain words for one event, for the Health tab, History, and the AI. */
export function describeEvent(e: ContainerEvent): string {
  if (e.kind === "stop") {
    return e.oomKilled
      ? "Stopped: killed for running out of memory"
      : e.exitCode === undefined
        ? "Stopped"
        : e.exitCode === 0 || e.exitCode === 143
          ? `Stopped cleanly (exit code ${e.exitCode})`
          : `Stopped with exit code ${e.exitCode}${e.exitCode === 137 ? " (killed)" : ""}`;
  }
  switch (e.cause) {
    case "first-seen":
      return "Running when Hearth first recorded it";
    case "dragon-control":
      return "Started by Hearth (an action it ran)";
    case "docker":
      return "Restarted by Docker (its restart policy)";
    default:
      return "Started outside Hearth (a deploy, a manual restart, or a reboot)";
  }
}
