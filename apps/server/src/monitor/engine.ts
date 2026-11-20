import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { saveDisks } from "../store/disks";
import { getSetting, setSetting } from "../store/settings";
import type { ContainerState, MonitorProbes } from "./probes";
import { cascadeActive, simulatedCondition } from "./simulation";

/* ---------- Debouncing (pure) ---------- */

export type CheckStatus = "ok" | "slow" | "failing";

export interface CheckOutcome {
  status: CheckStatus;
  responseMs?: number;
  /** Plain words: "is not running", "stopped responding (connection refused)". */
  detail: string;
  /** Short title fragment used when an incident opens. */
  problem?: string;
  /** What kind of failure; decides which repair fits. */
  code?: ProblemCode;
}

/** Failure kinds. Only some can be fixed by a restart. */
export type ProblemCode =
  | "not-responding"
  | "not-running"
  | "stopped-on-purpose"
  | "unhealthy"
  | "crash-loop"
  | "missing"
  | "docker-unreachable";

/**
 * Exit codes of a container that was asked to stop: 0 (it shut down cleanly)
 * or 143 (128 + SIGTERM, what `docker stop` sends). A crash ends otherwise,
 * and a container with a restart policy would have been started again.
 */
export const CLEAN_STOP_CODES = new Set([0, 143]);

export interface PriorState {
  status: CheckStatus;
  consecutiveFailures: number;
}

export type Transition =
  | "steady"
  | "first-failure"
  | "still-unconfirmed"
  | "confirmed"
  | "still-failing"
  | "recovered"
  | "blip-cleared";

/**
 * A single failed check is not an incident: it must repeat `threshold`
 * times in a row. One good check ends the run. Exhaustively tested.
 */
export function evaluate(
  prior: PriorState | undefined,
  outcome: CheckOutcome,
  threshold: number,
): { next: PriorState; transition: Transition } {
  const wasFailing = prior?.status === "failing";
  if (outcome.status === "failing") {
    const failures = (wasFailing ? prior!.consecutiveFailures : 0) + 1;
    const transition: Transition =
      failures === threshold
        ? "confirmed"
        : failures > threshold
          ? "still-failing"
          : failures === 1
            ? "first-failure"
            : "still-unconfirmed";
    return { next: { status: "failing", consecutiveFailures: failures }, transition };
  }
  const transition: Transition = !wasFailing
    ? "steady"
    : prior!.consecutiveFailures >= threshold
      ? "recovered"
      : "blip-cleared";
  return { next: { status: outcome.status, consecutiveFailures: 0 }, transition };
}

/* ---------- Checking one service ---------- */

const SLOW_MS = 3000;

type ServiceRow = typeof t.services.$inferSelect;

export async function checkService(
  service: ServiceRow,
  probes: MonitorProbes,
  containers: Map<string, ContainerState> | { error: string } | undefined,
  priorRestarts?: number | null,
): Promise<CheckOutcome & { restartCount?: number }> {
  const target = service.checkTarget ?? "";

  if (target.startsWith("demo:")) {
    const condition = simulatedCondition(service.id);
    const base = service.responseMs ?? 40;
    if (condition === "down" || condition === "stuck") {
      return {
        status: "failing",
        detail: "stopped responding (simulated)",
        problem: "stopped responding",
        code: "not-responding",
      };
    }
    if (condition === "cascade" && cascadeActive(service.id)) {
      return {
        status: "failing",
        detail: "is running, but its requests are failing (simulated)",
        problem: "is failing",
        code: "not-responding",
      };
    }
    if (condition === "slow")
      return { status: "slow", responseMs: 4200, detail: "is answering slowly (simulated)" };
    return {
      status: "ok",
      responseMs: Math.max(5, base + ((Date.now() / 1000) % 11) - 5),
      detail: "is responding",
    };
  }

  if (target.startsWith("container:")) {
    if (containers && "error" in containers) {
      // Docker itself is unreachable; say so instead of blaming every service.
      return {
        status: "failing",
        detail: `could not be checked: ${containers.error}`,
        problem: "could not be checked",
        code: "docker-unreachable",
      };
    }
    const name = target.slice("container:".length);
    const state = containers?.get(name);
    if (!state)
      return {
        status: "failing",
        detail: "has no container any more",
        problem: "is missing",
        code: "missing",
      };
    if (
      state.state === "stopped" &&
      state.exitCode !== undefined &&
      CLEAN_STOP_CODES.has(state.exitCode)
    ) {
      return {
        status: "failing",
        restartCount: state.restartCount,
        detail: `was stopped, not a crash: it shut down cleanly (exit code ${state.exitCode}) and Docker left it off`,
        problem: "was stopped (not a crash)",
        code: "stopped-on-purpose",
      };
    }
    if (state.state !== "running") {
      return {
        status: "failing",
        restartCount: state.restartCount,
        detail: `is ${state.state === "stopped" ? "not running" : state.state}`,
        problem: "is not running",
        code: "not-running",
      };
    }
    // A count that keeps climbing is a crash loop, even if it looks "running" right now.
    const restarts = state.restartCount;
    if (restarts !== undefined && priorRestarts != null && restarts > priorRestarts) {
      const n = restarts - priorRestarts;
      return {
        status: "failing",
        restartCount: restarts,
        detail: `keeps restarting (${n} ${n === 1 ? "restart" : "restarts"} since the last check, ${restarts.toLocaleString()} in total)`,
        problem: "keeps restarting",
        code: "crash-loop",
      };
    }
    if (state.health === "unhealthy") {
      return {
        status: "failing",
        restartCount: restarts,
        detail: "is running but Docker reports it unhealthy",
        problem: "is unhealthy",
        code: "unhealthy",
      };
    }
    const http = await httpOutcome(service, probes);
    return { ...http, restartCount: restarts };
  }

  return httpOutcome(service, probes);
}

async function httpOutcome(service: ServiceRow, probes: MonitorProbes): Promise<CheckOutcome> {
  const target = service.checkTarget ?? "";

  if (service.localUrl) {
    const res = await probes.http(service.localUrl);
    if (!res.ok) {
      const why =
        res.error ?? (res.status ? `answered with error ${res.status}` : "did not answer");
      return {
        status: "failing",
        responseMs: undefined,
        detail: `stopped responding (${why})`,
        problem: "stopped responding",
        code: "not-responding",
      };
    }
    if (res.ms > SLOW_MS)
      return { status: "slow", responseMs: res.ms, detail: `is answering slowly (${res.ms} ms)` };
    return { status: "ok", responseMs: res.ms, detail: `is responding (${res.ms} ms)` };
  }

  // Container-only services (databases, VPNs): running and not unhealthy is all we can know.
  return target.startsWith("container:")
    ? { status: "ok", detail: "is running" }
    : { status: "ok", detail: "has nothing to check yet" };
}

/* ---------- Incidents ---------- */

const incidentId = () => `inc-${randomBytes(3).toString("hex")}`;
export const minutesBetween = (a: string, b: string) =>
  Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 60_000));

type Db = DbHandle["db"];

export async function openIncidentFor(db: Db, monitorKey: string) {
  return db
    .select()
    .from(t.incidents)
    .where(and(eq(t.incidents.monitorKey, monitorKey), ne(t.incidents.status, "resolved")))
    .get();
}

export async function addTimeline(
  db: Db,
  incidentId: string,
  at: string,
  kind: string,
  text: string,
) {
  await db.insert(t.incidentTimeline).values({ incidentId, at, kind, text });
}

export async function addEvent(
  db: Db,
  at: string,
  tone: "good" | "neutral" | "attention",
  message: string,
  refs: { incidentId?: string; serviceId?: string; hostId?: string },
) {
  await db.insert(t.events).values({ id: randomUUID(), at, tone, message, ...refs });
}

/**
 * A repeat check on an open incident: when the latest line is the same check, it is updated in
 * place, so an incident open for days keeps one line for its checks instead of one per check.
 */
export async function noteCheck(db: Db, incidentId: string, at: string, text: string) {
  const last = await db
    .select({
      id: t.incidentTimeline.id,
      kind: t.incidentTimeline.kind,
      text: t.incidentTimeline.text,
    })
    .from(t.incidentTimeline)
    .where(eq(t.incidentTimeline.incidentId, incidentId))
    .orderBy(desc(t.incidentTimeline.id))
    .limit(1)
    .get();
  // Only the same reading again (numbers aside): a diagnosis or a repair's result is kept.
  const shape = (x: string) => x.replace(/[\d.,]+/g, "#");
  if (last?.kind === "check" && shape(last.text) === shape(text))
    await db.update(t.incidentTimeline).set({ at, text }).where(eq(t.incidentTimeline.id, last.id));
  else await addTimeline(db, incidentId, at, "check", text);
}

async function unmute(db: Db, key: string) {
  const mutes = await getSetting(db, "incident_mutes");
  if (!mutes?.[key]) return;
  const { [key]: _gone, ...rest } = mutes;
  await setSetting(db, "incident_mutes", rest);
}

/**
 * The owner dismisses an open incident: it is closed, and not opened again while the problem
 * reads the same. If it recovers, or comes back different, Hearth raises it as usual.
 */
export async function dismissIncident(db: Db, id: string, at: string) {
  const row = await db.select().from(t.incidents).where(eq(t.incidents.id, id)).get();
  if (!row) return undefined;
  if (row.status === "resolved") return row;
  await addTimeline(db, id, at, "resolved", "Dismissed by you.");
  await db
    .update(t.incidents)
    .set({
      status: "resolved",
      resolvedAt: at,
      resolution:
        "Dismissed by you. Hearth raises it again if it changes or comes back after recovering.",
      handledBy: "you",
      proposedAction: null,
    })
    .where(eq(t.incidents.id, id));
  await db
    .update(t.actions)
    .set({ status: "refused", result: "Not needed: you dismissed the incident.", completedAt: at })
    .where(and(eq(t.actions.incidentId, id), eq(t.actions.status, "requested")));
  if (row.monitorKey) {
    const mutes = (await getSetting(db, "incident_mutes")) ?? {};
    await setSetting(db, "incident_mutes", {
      ...mutes,
      [row.monitorKey]: { title: row.title, at },
    });
  }
  return row;
}

/** Opens an incident for a confirmed problem, or notes it on the one already open. */
export async function raise(
  db: Db,
  p: {
    key: string;
    at: string;
    since: string;
    title: string;
    summary: string;
    severity: "info" | "warning" | "critical";
    serviceId?: string;
    hostId?: string;
    detectedText: string;
    confirmText: string;
    /** Why nothing automatic will happen; service incidents get theirs from the responder. */
    escalateText?: string;
    problem?: ProblemCode;
  },
) {
  const existing = await openIncidentFor(db, p.key);
  if (existing) {
    await noteCheck(db, existing.id, p.at, p.confirmText);
    return existing.id;
  }
  // Dismissed by the owner while it reads the same: not opened again.
  const mute = (await getSetting(db, "incident_mutes"))?.[p.key];
  if (mute && mute.title === p.title) return undefined;
  const id = incidentId();
  await db.insert(t.incidents).values({
    id,
    title: p.title,
    severity: p.severity,
    status: "open",
    openedAt: p.since,
    summary: p.summary,
    handledBy: "pending",
    serviceId: p.serviceId ?? null,
    hostId: p.hostId ?? null,
    monitorKey: p.key,
    problem: p.problem ?? null,
  });
  await addTimeline(db, id, p.since, "detected", p.detectedText);
  await addTimeline(db, id, p.at, "check", p.confirmText);
  if (p.escalateText) await addTimeline(db, id, p.at, "escalated", p.escalateText);
  await addEvent(db, p.at, "attention", p.title, {
    incidentId: id,
    serviceId: p.serviceId,
    hostId: p.hostId,
  });
  return id;
}

/** Closes an open incident because the problem went away. */
export async function settle(
  db: Db,
  key: string,
  at: string,
  checkText: string,
  resolution: string,
  event: string,
) {
  await unmute(db, key);
  const open = await openIncidentFor(db, key);
  if (!open) return;
  await addTimeline(db, open.id, at, "check", checkText);
  await addTimeline(
    db,
    open.id,
    at,
    "resolved",
    `Recovered on its own after ${minutesBetween(open.openedAt, at)} min.`,
  );
  await db
    .update(t.incidents)
    .set({
      status: "resolved",
      resolvedAt: at,
      resolution,
      handledBy:
        open.handledBy === "pending" || open.status === "awaiting-approval"
          ? "recovered"
          : open.handledBy,
      proposedAction: null,
    })
    .where(eq(t.incidents.id, open.id));
  // A repair still waiting for approval is no longer needed.
  await db
    .update(t.actions)
    .set({
      status: "refused",
      result: "No longer needed: it recovered on its own.",
      completedAt: at,
    })
    .where(and(eq(t.actions.incidentId, open.id), eq(t.actions.status, "requested")));
  await addEvent(db, at, "good", event, {
    incidentId: open.id,
    serviceId: open.serviceId ?? undefined,
  });
}

/* ---------- One monitoring pass ---------- */

export interface RunSummary {
  at: string;
  checked: number;
  failing: number;
  opened: number;
  resolved: number;
  /** Incidents this pass opened, for the responder to act on. */
  openedIncidents: string[];
}

const hourOf = (iso: string) => `${iso.slice(0, 13)}:00:00Z`;

export async function runChecks(
  handle: DbHandle,
  probes: MonitorProbes,
  opts: { serviceIds?: string[]; now?: () => Date } = {},
): Promise<RunSummary> {
  const { db } = handle;
  const at = (opts.now?.() ?? new Date()).toISOString();
  const threshold = (await getSetting(db, "failure_threshold")) ?? 2;
  const environment = await getSetting(db, "environment");

  // Paused and retired services are off on purpose: never checked, never an incident.
  let services = await db
    .select()
    .from(t.services)
    .where(and(isNotNull(t.services.checkTarget), eq(t.services.lifecycle, "active")));
  if (opts.serviceIds) services = services.filter((s) => opts.serviceIds!.includes(s.id));
  // A service being repaired right now is judged by the repair's own verification, not here.
  const busy = new Set(
    (
      await db
        .select({ id: t.actions.targetId })
        .from(t.actions)
        .where(eq(t.actions.status, "running"))
    ).map((r) => r.id),
  );
  services = services.filter((s) => !busy.has(s.id));

  // Gather observations outside the transaction (they can take seconds).
  const needsDocker = services.some((s) => s.checkTarget?.startsWith("container:"));
  const containers = needsDocker
    ? await probes
        .containers()
        .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
    : undefined;
  // Stopped on request: not checked while it stays stopped. Started some other way, it is
  // watched again (the hold is lifted); if Docker cannot be read, it is left alone.
  const held = services.filter((s) => s.stoppedAt);
  if (held.length) {
    const nowRunning = held.filter(
      (s) =>
        containers &&
        !("error" in containers) &&
        containers.get(s.checkTarget?.slice("container:".length) ?? "")?.state === "running",
    );
    for (const s of nowRunning) {
      await db
        .update(t.services)
        .set({ stoppedAt: null, stoppedBy: null })
        .where(eq(t.services.id, s.id));
    }
    const stillHeld = new Set(held.filter((s) => !nowRunning.includes(s)).map((s) => s.id));
    services = services.filter((s) => !stillHeld.has(s.id));
  }
  const priorStates = new Map((await db.select().from(t.checkState)).map((s) => [s.serviceId, s]));
  const outcomes = await Promise.all(
    services.map((s) => checkService(s, probes, containers, priorStates.get(s.id)?.restartCount)),
  );
  const realHost =
    environment === "real" && !opts.serviceIds
      ? (await db.select().from(t.hosts)).find((h) => h.connection === "this-machine")
      : undefined;
  const metrics = realHost ? await probes.host().catch(() => undefined) : undefined;

  const summary: RunSummary = {
    at,
    checked: services.length,
    failing: 0,
    opened: 0,
    resolved: 0,
    openedIncidents: [],
  };

  await withTransaction(handle, async () => {
    const states = new Map((await db.select().from(t.checkState)).map((s) => [s.serviceId, s]));

    for (const [i, service] of services.entries()) {
      const outcome = outcomes[i]!;
      const prior = states.get(service.id);
      const { next, transition } = evaluate(prior, outcome, threshold);
      const since = transition === "first-failure" ? at : (prior?.failingSince ?? at);
      if (outcome.status === "failing") summary.failing++;

      await db
        .insert(t.checkState)
        .values({
          serviceId: service.id,
          status: next.status,
          consecutiveFailures: next.consecutiveFailures,
          failingSince: outcome.status === "failing" ? since : null,
          detail: outcome.detail,
          problem: outcome.code ?? null,
          restartCount: outcome.restartCount ?? null,
          checkedAt: at,
          lastOkAt: outcome.status === "failing" ? (prior?.lastOkAt ?? null) : at,
        })
        .onConflictDoUpdate({
          target: t.checkState.serviceId,
          set: {
            status: next.status,
            consecutiveFailures: next.consecutiveFailures,
            failingSince: outcome.status === "failing" ? since : null,
            detail: outcome.detail,
            problem: outcome.code ?? null,
            restartCount: outcome.restartCount ?? null,
            checkedAt: at,
            lastOkAt: outcome.status === "failing" ? (prior?.lastOkAt ?? null) : at,
          },
        });

      await db
        .update(t.services)
        .set({
          health:
            outcome.status === "ok"
              ? "healthy"
              : outcome.status === "slow"
                ? "attention"
                : next.consecutiveFailures >= threshold
                  ? "offline"
                  : service.health,
          responseMs:
            outcome.responseMs !== undefined
              ? Math.round(outcome.responseMs)
              : outcome.status === "failing"
                ? null
                : service.responseMs,
        })
        .where(eq(t.services.id, service.id));

      await db
        .insert(t.availabilityHourly)
        .values({
          serviceId: service.id,
          hour: hourOf(at),
          ok: outcome.status === "failing" ? 0 : 1,
          total: 1,
        })
        .onConflictDoUpdate({
          target: [t.availabilityHourly.serviceId, t.availabilityHourly.hour],
          set: {
            ok: sql`${t.availabilityHourly.ok} + ${outcome.status === "failing" ? 0 : 1}`,
            total: sql`${t.availabilityHourly.total} + 1`,
          },
        });

      const key = `service:${service.id}`;
      if (transition === "confirmed" || transition === "still-failing") {
        // "still-failing" only reaches an incident if none is open (e.g. it was closed by hand).
        const open = await openIncidentFor(db, key);
        if (transition === "confirmed" || !open) {
          const existed = Boolean(open);
          const id = await raise(db, {
            key,
            at,
            since,
            title: `${service.name} ${outcome.problem ?? "has a problem"}`,
            summary: `${service.name} ${outcome.detail}. Hearth confirmed it on ${threshold} checks in a row before opening this incident.`,
            // A deliberate-looking stop is a question for you, not an alarm.
            severity: outcome.code === "stopped-on-purpose" ? "info" : "warning",
            serviceId: service.id,
            hostId: service.hostId,
            detectedText: `${service.name} ${outcome.detail}.`,
            confirmText: `Still failing after ${threshold} checks in a row.`,
            problem: outcome.code,
          });
          if (!existed && id) {
            summary.opened++;
            summary.openedIncidents.push(id);
          }
        }
      } else if (transition === "recovered") {
        const before = await openIncidentFor(db, key);
        await settle(
          db,
          key,
          at,
          `${service.name} ${outcome.detail}.`,
          `${service.name} recovered on its own. No action was needed.`,
          `${service.name} recovered on its own`,
        );
        if (before) summary.resolved++;
      }
    }

    // This machine: live metrics, and volume capacity.
    if (realHost && metrics) {
      await db
        .update(t.hosts)
        .set({
          cpuUsagePct: metrics.cpuPct,
          memUsedGb: metrics.memUsedGb,
          uptimeHours: metrics.uptimeHours,
          lastSeenAt: at,
          health: "healthy",
        })
        .where(eq(t.hosts.id, realHost.id));
      const vols = await db.select().from(t.volumes).where(eq(t.volumes.hostId, realHost.id));
      for (const v of vols) {
        const m = metrics.volumes.find((x) => x.mount.toLowerCase() === v.mount.toLowerCase());
        if (m)
          await db
            .update(t.volumes)
            .set({ usedTb: m.usedTb, totalTb: m.totalTb })
            .where(eq(t.volumes.id, v.id));
      }
    }

    // Machines seen only over the network report through their apps.
    if (environment === "real" && !opts.serviceIds) {
      const remote = (await db.select().from(t.hosts)).filter((h) => h.connection === "network");
      for (const host of remote) {
        const results = services.flatMap((s, i) => (s.hostId === host.id ? [outcomes[i]!] : []));
        if (!results.length) continue;
        const answering = results.filter((o) => o.status !== "failing").length;
        await db
          .update(t.hosts)
          .set({
            health: answering === results.length ? "healthy" : answering ? "attention" : "offline",
            ...(answering ? { lastSeenAt: at } : {}),
          })
          .where(eq(t.hosts.id, host.id));
      }
    }

    const volumes = await checkVolumes(db, at);
    summary.opened += volumes.opened.length;
    summary.openedIncidents.push(...volumes.opened);
    summary.resolved += volumes.resolved;
    await setSetting(db, "monitor_last_run", at);
  });

  return summary;
}

/** Capacity incidents: open at 90% (critical at 97%), close below 88% so they do not flap. */
async function checkVolumes(db: Db, at: string) {
  const opened: string[] = [];
  let resolved = 0;
  const hosts = new Map((await db.select().from(t.hosts)).map((h) => [h.id, h]));
  for (const v of await db.select().from(t.volumes)) {
    const pct = v.totalTb ? (v.usedTb / v.totalTb) * 100 : 0;
    const key = `volume:${v.id}`;
    const open = await openIncidentFor(db, key);
    const host = hosts.get(v.hostId);
    if (pct >= 90) {
      if (!open) {
        const id = await raise(db, {
          key,
          at,
          since: at,
          title: `${v.label} volume is ${Math.round(pct)}% full`,
          summary: `The ${v.label} volume on ${host?.name ?? "this machine"} has ${(v.totalTb - v.usedTb).toFixed(1)} TB left.`,
          severity: pct >= 97 ? "critical" : "warning",
          hostId: v.hostId,
          detectedText: `${v.label} crossed 90% capacity.`,
          confirmText: `${Math.round(pct)}% used, ${(v.totalTb - v.usedTb).toFixed(1)} TB free.`,
          escalateText:
            "A full volume needs you to decide what to remove. Hearth never deletes files.",
        });
        if (id) opened.push(id);
      }
    } else if (open && pct < 88) {
      await settle(
        db,
        key,
        at,
        `${v.label} is down to ${Math.round(pct)}% used.`,
        `Space was freed on ${v.label}. No action is needed.`,
        `${v.label} has room again`,
      );
      resolved++;
    }
  }
  return { opened, resolved };
}

/** Drive health is slower to read, so it runs on its own, less frequent schedule. */
export async function refreshDiskHealth(handle: DbHandle, probes: MonitorProbes): Promise<void> {
  const { db } = handle;
  if ((await getSetting(db, "environment")) !== "real") return;
  const host = (await db.select().from(t.hosts)).find((h) => h.connection === "this-machine");
  if (!host) return;
  const disks = await probes.disks(host.id);
  const at = new Date().toISOString();
  await withTransaction(handle, async () => {
    await saveDisks(db, host.id, disks);
    for (const d of disks) {
      const key = `disk:${d.id}`;
      if (d.health === "warning" || d.health === "failing") {
        await raise(db, {
          key,
          at,
          since: at,
          title: `Drive ${d.model} reports ${d.health === "failing" ? "a failure" : "a problem"}`,
          summary: `Windows reports the drive holding ${d.volumes.join(", ") || "no drive letter"} as ${d.health}. Back up what matters on it.`,
          severity: d.health === "failing" ? "critical" : "warning",
          hostId: host.id,
          detectedText: `Drive health changed to ${d.health}.`,
          confirmText: "Confirmed on the next health reading.",
          escalateText: "Drive problems need you. Hearth does not change anything on the drive.",
        });
      } else if (d.health === "healthy") {
        await settle(
          db,
          key,
          at,
          "Drive reports healthy again.",
          "The drive reports healthy again.",
          `Drive ${d.model} reports healthy again`,
        );
      }
    }
  });
}
