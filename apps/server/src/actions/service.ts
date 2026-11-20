import {
  planLogQuery,
  shapeLogLines,
  SCAN_LINES,
  type LogQuery,
  type PlannedLogQuery,
} from "./log-query";
import { randomUUID } from "node:crypto";
import { and, eq, gte, ne } from "drizzle-orm";
import {
  ACTIONS,
  AUTONOMY_TITLES,
  decideAction,
  effectiveAutonomy,
  isCoreNetworking,
  POWER_ACTIONS,
  APP_ACTIONS,
  type ActionKind,
  type ActionRecord,
  type Autonomy,
  type PolicyDecision,
  type ServiceRuntime,
  type Requester,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import {
  addEvent,
  addTimeline,
  checkService,
  minutesBetween,
  openIncidentFor,
  runChecks,
  type ProblemCode,
} from "../monitor/engine";
import type { MonitorProbes } from "../monitor/probes";
import { simulatedCondition, simulateRestart } from "../monitor/simulation";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting, SETTING_DEFAULTS } from "../store/settings";
import { toActionRecord } from "./records";
import { approvalExpiry, pendingAction } from "./approval";
import type { ContainerTools } from "./tools";
import type { Memory } from "../memory/service";
import { parseFlareLog, type FlarePanel } from "../apps/flaresolverr";
import { parseTinyauthLog, type TinyauthPanel } from "../apps/tinyauth";

/**
 * Carries out actions, and responds to new incidents with the repair your
 * autonomy settings allow. Every request goes through decideAction (the
 * single policy, re-evaluated at the moment of execution), is stored in the
 * actions table, and every change is audited. A repair only counts once
 * Hearth's own health check passes again.
 */

export interface ActionDeps {
  probes: MonitorProbes;
  containers: ContainerTools;
  /** How long to watch for recovery after a restart. */
  verify: { intervalMs: number; attempts: number };
  /** How long a simulated restart of a sample service takes. */
  demoRestartMs: number;
}

export const REAL_VERIFY = { intervalMs: 5000, attempts: 18 }; // up to 90s for slow starters
export const DEMO_VERIFY = { intervalMs: 1500, attempts: 4 };
const FLAP_LIMIT = 3; // automatic restarts of one service per hour before giving up
const LOG_LINES = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "21 seconds" or "4 min": repairs are often quicker than a minute. */
function took(from: string, to: string): string {
  const seconds = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (seconds === 1) return "1 second";
  return seconds < 60 ? `${seconds} seconds` : `${minutesBetween(from, to)} min`;
}

type Db = DbHandle["db"];
type ServiceRow = typeof t.services.$inferSelect;
type IncidentRow = typeof t.incidents.$inferSelect;
type CheckResult = Awaited<ReturnType<typeof checkService>>;
/** The service an incident is about, when a repair targeted something it depends on. */
interface Dependent {
  service: ServiceRow;
  outcome?: CheckResult;
}

interface Target {
  service: ServiceRow;
  demo: boolean;
  container?: string;
  /** Why a restart is impossible, when it is. */
  cannotRestart?: string;
  level: Autonomy;
  area: string;
  live: boolean;
  liveRepairs: boolean;
  /** On the owner's do-not-touch list: the reason they gave (possibly empty). */
  doNotTouch?: string;
}

async function loadTarget(db: Db, serviceId: string): Promise<Target> {
  const service = await db.select().from(t.services).where(eq(t.services.id, serviceId)).get();
  if (!service) throw new NotFoundError("No such service.");
  const host = await db.select().from(t.hosts).where(eq(t.hosts.id, service.hostId)).get();
  const rules = await db.select().from(t.autonomyRules);
  const fallback = (await getSetting(db, "autonomy_default")) ?? SETTING_DEFAULTS.autonomy_default;
  const level = effectiveAutonomy(service.autonomyArea, rules, fallback);
  const area = rules.find((r) => r.id === service.autonomyArea)?.label ?? "This area";
  const target = service.checkTarget ?? "";
  const demo = target.startsWith("demo:");
  const container = target.startsWith("container:") ? target.slice("container:".length) : undefined;
  const cannotRestart =
    service.kind !== "container"
      ? `${service.name} is not a container, so there is nothing to restart.`
      : !demo && !container
        ? `Hearth does not know which container ${service.name} is.`
        : !demo && host?.connection !== "this-machine"
          ? `Hearth can only restart containers on the machine it runs on.`
          : undefined;
  return {
    service,
    demo,
    container,
    cannotRestart,
    level,
    area,
    live: !demo,
    liveRepairs: (await getSetting(db, "live_repairs")) ?? false,
    doNotTouch: ((await getSetting(db, "do_not_touch")) ?? []).find(
      (d) => d.serviceId === serviceId,
    )?.reason,
  };
}

/** Sample lines with times, a minute apart, ending at the window's end. */
function stampDemo(lines: string[], until?: number): string[] {
  const end = (until ?? Date.now() / 1000) - 30;
  return lines.map(
    (l, i) =>
      `${new Date((end - (lines.length - 1 - i) * 60) * 1000).toISOString().slice(0, 19)}Z ${l}`,
  );
}

function demoLogs(service: ServiceRow): string[] {
  const down = simulatedCondition(service.id);
  const lines = [
    `[INFO] Starting ${service.name} ${service.version ?? ""}`.trim(),
    "[INFO] Loading configuration",
    "[INFO] Database connection established",
    `[INFO] Web interface listening on ${service.localUrl ?? "its internal port"}`,
    "[INFO] Scheduled tasks registered",
  ];
  if (down) {
    lines.push(
      "[WARN] Request handler did not respond within 30s",
      "[ERROR] Health endpoint timed out (sample data)",
    );
  }
  return lines;
}

/** Plain-language diagnosis from facts Docker reports. */
function diagnosis(
  code: ProblemCode | null,
  facts: Awaited<ReturnType<ContainerTools["facts"]>>,
): string | undefined {
  const exit = facts?.oomKilled
    ? "it was stopped because the system ran out of memory"
    : facts?.exitCode !== undefined && facts.exitCode !== 0
      ? `its last run ended with exit code ${facts.exitCode}${facts.error ? ` (${facts.error})` : ""}`
      : undefined;
  switch (code) {
    case "not-responding":
      return "The container is running, but its web interface stopped answering.";
    case "unhealthy":
      return "The container is running, but Docker's own health check reports it unhealthy.";
    case "not-running":
      return exit ? `The container is not running: ${exit}.` : "The container is not running.";
    case "stopped-on-purpose":
      return "The container was stopped and shut down cleanly; nothing suggests a crash.";
    case "crash-loop":
      return `Docker keeps restarting it and it fails during startup each time${exit ? `; ${exit}` : ""}.`;
    default:
      return undefined;
  }
}

/** Why a problem is not something a restart can fix, or undefined if it might be. */
function noRestartReason(code: ProblemCode | null, name: string): string | undefined {
  switch (code) {
    case "crash-loop":
      return `Docker is already restarting ${name} over and over, so another restart will not help. Its recent logs are on the service page.`;
    case "missing":
      return `The ${name} container no longer exists, so there is nothing to restart.`;
    case "stopped-on-purpose":
      return `${name} was stopped on purpose (it shut down cleanly when asked to), not a crash, so Hearth will not start it again by itself. If it should stay off, pause or retire it on its page; if not, start it from there.`;
    case "docker-unreachable":
      return "Docker itself is not answering, so Hearth cannot act on containers until it is back.";
    default:
      return undefined;
  }
}

export class ActionRunner {
  private inflight = new Set<Promise<unknown>>();
  /** Restarts in progress, by service, so a runbook can wait for one to finish. */
  private restarting = new Map<string, Promise<unknown>>();
  /** Called after each piece of background work, so notifications go out promptly. */
  onChange: (() => void) | undefined;
  /** Where fixes are remembered (the homelab memory). Optional so tests can leave it out. */
  memory: Memory | undefined;

  /** Resolves when any restart of this service has finished and been verified. */
  async settled(serviceId: string): Promise<void> {
    await this.restarting.get(serviceId);
  }

  constructor(
    private readonly handle: DbHandle,
    private readonly deps: ActionDeps,
  ) {}

  /** Resolves once no background repair is running (tests and shutdown). */
  /** The container access this runner was given (real, or a stand-in in tests). */
  get containerTools(): ContainerTools {
    return this.deps.containers;
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private background(work: () => Promise<unknown>) {
    const p = work()
      .catch((error: unknown) => console.error("Hearth: background repair failed", error))
      .finally(() => {
        this.inflight.delete(p);
        this.onChange?.();
      });
    this.inflight.add(p);
  }

  private async record(id: string): Promise<ActionRecord> {
    const { db } = this.handle;
    const row = await db.select().from(t.actions).where(eq(t.actions.id, id)).get();
    const svc = await db.select().from(t.services).where(eq(t.services.id, row!.targetId)).get();
    return toActionRecord(row!, svc?.name ?? row!.targetId);
  }

  /**
   * An action asked for by you, Hearth, or (later) an agent.
   * Read-only actions return their result; a restart returns while it runs.
   */
  /**
   * Dependencies, checked when a start or stop is about to happen (not when
   * planning, so a plan can put things in order): starting needs what it
   * depends on running; a stop in a plan needs what depends on it stopped
   * first. Your own stop button lists what will be affected instead.
   */
  private async dependencyProblem(
    kind: ActionKind,
    target: Target,
    direct: boolean,
  ): Promise<string | undefined> {
    if (target.demo || (kind === "stop-container" && direct)) return undefined;
    const { db } = this.handle;
    const { service } = target;
    const links = await db.select().from(t.serviceDependencies);
    const ids =
      kind === "start-container"
        ? links.filter((l) => l.serviceId === service.id).map((l) => l.dependsOnId)
        : links.filter((l) => l.dependsOnId === service.id).map((l) => l.serviceId);
    if (!ids.length) return undefined;
    const related = (await db.select().from(t.services)).filter(
      (s) => ids.includes(s.id) && s.checkTarget?.startsWith("container:"),
    );
    if (!related.length) return undefined;
    const containers = await this.deps.probes.containers().catch(() => undefined);
    if (!containers || "error" in containers) {
      return "Docker did not answer, so Hearth cannot check what this depends on. Nothing was changed.";
    }
    const running = (s: ServiceRow) =>
      containers.get(s.checkTarget!.slice("container:".length))?.state === "running";
    const names = (rows: ServiceRow[]) => rows.map((s) => s.name).join(", ");
    if (kind === "start-container") {
      const down = related.filter((s) => !running(s));
      return down.length
        ? `${service.name} depends on ${names(down)}, which ${down.length === 1 ? "is" : "are"} not running. Start ${down.length === 1 ? "it" : "them"} first (an earlier step of the same plan works).`
        : undefined;
    }
    const up = related.filter((s) => s.lifecycle === "active" && running(s));
    return up.length
      ? `${names(up)} ${up.length === 1 ? "depends" : "depend"} on ${service.name} and ${up.length === 1 ? "is" : "are"} still running. Stop ${up.length === 1 ? "it" : "them"} first (an earlier step of the same plan works).`
      : undefined;
  }

  /** Audits an allowed start or stop as it begins; a stop is held from here on. Inside a transaction. */
  private async startPowerRecord(
    db: Db,
    kind: ActionKind,
    target: Target,
    requestedBy: Requester,
    reason: string,
    at: string,
  ) {
    const { service } = target;
    if (kind === "stop-container") {
      // Held before Docker is asked, so nothing mistakes the stop for an outage.
      await db
        .update(t.services)
        .set({ stoppedAt: at, stoppedBy: requestedBy })
        .where(eq(t.services.id, service.id));
    }
    await recordAudit(db, {
      actor: requestedBy,
      action: `${kind === "start-container" ? "Started" : "Stopped"} the ${service.name} container`,
      target: `service:${service.id}`,
      detail: { reason, ...(target.demo ? { sampleData: true } : {}) },
    });
  }

  /**
   * Start or stop, then verify: a start counts once Hearth's own
   * health check passes; a stop once Docker reports the container stopped.
   */
  private async carryOutPower(
    actionId: string,
    target: Target,
    kind: "start-container" | "stop-container",
  ) {
    const { db } = this.handle;
    const { service } = target;
    const starting = kind === "start-container";
    let failure: string | undefined;
    try {
      if (target.demo) await sleep(this.deps.demoRestartMs);
      else if (starting) await this.deps.containers.start(target.container!);
      else await this.deps.containers.stop(target.container!);
    } catch (error) {
      failure = `Docker did not ${starting ? "start" : "stop"} it: ${error instanceof Error ? error.message : String(error)}`;
    }

    let verified = false;
    let detail = "";
    if (!failure && starting) {
      // From here monitoring watches it normally again, whatever the check finds.
      await db
        .update(t.services)
        .set({ stoppedAt: null, stoppedBy: null })
        .where(eq(t.services.id, service.id));
      const outcome = target.demo
        ? { status: "ok" as const, detail: "is responding" }
        : await this.verifyService(service, false);
      verified = outcome.status !== "failing";
      detail = `${service.name} ${outcome.detail}.`;
    } else if (!failure) {
      const verify = this.deps.verify;
      for (let i = 0; i < verify.attempts && !verified; i++) {
        const now = target.demo
          ? { running: false }
          : await this.deps.containers.runtime(target.container!).catch(() => undefined);
        verified = now !== undefined && !now.running;
        if (!verified) await sleep(verify.intervalMs);
      }
      detail = verified
        ? "Docker reports the container stopped."
        : "Docker still reports the container running.";
    }

    const at = new Date().toISOString();
    const ok = !failure && verified;
    const result = failure
      ? failure
      : ok
        ? starting
          ? `Started and verified: ${detail}`
          : `Stopped and verified: ${detail} Hearth will not check or restart it until it is started again.`
        : starting
          ? `Started, but it did not pass Hearth's health check: ${detail} Monitoring is watching it again.`
          : `Asked Docker to stop it, but it still reports the container running.`;
    await withTransaction(this.handle, async () => {
      if (!starting && !ok) {
        // Not stopped after all: monitoring takes it back.
        await db
          .update(t.services)
          .set({ stoppedAt: null, stoppedBy: null })
          .where(eq(t.services.id, service.id));
      }
      if (!starting && ok) {
        await db.update(t.services).set({ health: "offline" }).where(eq(t.services.id, service.id));
        // A problem that was open about it is settled by the stop: it is off on request now.
        const open = await openIncidentFor(db, `service:${service.id}`);
        if (open) {
          await addTimeline(db, open.id, at, "resolved", `${service.name} was stopped on request.`);
          await db
            .update(t.incidents)
            .set({
              status: "resolved",
              resolvedAt: at,
              handledBy: "you",
              proposedAction: null,
              resolution: `${service.name} was stopped on request, so this is closed. Hearth checks it again once it is started.`,
            })
            .where(eq(t.incidents.id, open.id));
          await db
            .update(t.actions)
            .set({ status: "refused", result: "No longer needed.", completedAt: at })
            .where(and(eq(t.actions.incidentId, open.id), eq(t.actions.status, "requested")));
        }
      }
      if (starting && ok) {
        await db.update(t.services).set({ health: "healthy" }).where(eq(t.services.id, service.id));
      }
      await db
        .update(t.actions)
        .set({ status: ok ? "succeeded" : "failed", result, completedAt: at })
        .where(eq(t.actions.id, actionId));
      await addEvent(
        db,
        at,
        ok ? (starting ? "good" : "neutral") : "attention",
        ok
          ? `${service.name} ${starting ? "started" : "stopped"} and verified`
          : `${starting ? "Starting" : "Stopping"} ${service.name} did not go as planned`,
        { serviceId: service.id },
      );
    });
  }

  /**
   * The container's live state for the workspace (uptime, ports, CPU, memory),
   * read only. Anything that cannot be read says why instead of guessing.
   */
  async runtime(serviceId: string): Promise<ServiceRuntime> {
    const target = await loadTarget(this.handle.db, serviceId);
    const at = new Date().toISOString();
    if (target.demo) {
      return { available: false, reason: "Sample data has no live containers to read.", at };
    }
    if (!target.container || target.cannotRestart) {
      return {
        available: false,
        reason:
          target.cannotRestart?.replace("restart", "read") ??
          `Hearth does not know which container ${target.service.name} is.`,
        at,
      };
    }
    try {
      const r = await this.deps.containers.runtime(target.container);
      if (!r) return { available: false, reason: "Docker has no container by that name.", at };
      return { available: true, at, ...r };
    } catch (error) {
      return {
        available: false,
        reason: `Docker did not answer: ${error instanceof Error ? error.message : String(error)}`,
        at,
      };
    }
  }

  /**
   * FlareSolverr's panel: what its own log says it solved, for which sites, and how long it
   * took, with the container's state. Read only; the log lines are redacted by the container tools.
   */
  async flaresolverr(serviceId: string): Promise<
    | ({
        available: true;
        at: string;
        running: boolean;
        startedAt?: string;
        restarts: number;
      } & FlarePanel)
    | { available: false; reason: string; at: string }
  > {
    const target = await loadTarget(this.handle.db, serviceId);
    const at = new Date().toISOString();
    if (target.demo)
      return { available: false, reason: "Sample data has no live containers to read.", at };
    if (!target.container)
      return {
        available: false,
        reason: `Hearth does not know which container ${target.service.name} is.`,
        at,
      };
    try {
      const [r, lines] = await Promise.all([
        this.deps.containers.runtime(target.container),
        this.deps.containers.logs(target.container, 1500),
      ]);
      if (!r) return { available: false, reason: "Docker has no container by that name.", at };
      return {
        available: true,
        at,
        running: r.running,
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        restarts: r.restartCount ?? 0,
        ...parseFlareLog(lines),
      };
    } catch (error) {
      return {
        available: false,
        reason: `Docker did not answer: ${error instanceof Error ? error.message : String(error)}`,
        at,
      };
    }
  }

  /**
   * Tinyauth's panel, from its own log over the last day (it has no statistics API). A busy
   * day can be tens of thousands of lines, so the read is capped and the panel says what it covers.
   */
  async tinyauth(serviceId: string): Promise<
    | ({
        available: true;
        at: string;
        running: boolean;
        startedAt?: string;
        restarts: number;
      } & TinyauthPanel)
    | { available: false; reason: string; at: string }
  > {
    const target = await loadTarget(this.handle.db, serviceId);
    const at = new Date().toISOString();
    if (target.demo)
      return { available: false, reason: "Sample data has no live containers to read.", at };
    if (!target.container)
      return {
        available: false,
        reason: `Hearth does not know which container ${target.service.name} is.`,
        at,
      };
    try {
      const [r, lines] = await Promise.all([
        this.deps.containers.runtime(target.container),
        this.deps.containers.logs(target.container, 40_000, { since: Date.now() / 1000 - 86_400 }),
      ]);
      if (!r) return { available: false, reason: "Docker has no container by that name.", at };
      return {
        available: true,
        at,
        running: r.running,
        ...(r.startedAt ? { startedAt: r.startedAt } : {}),
        restarts: r.restartCount ?? 0,
        ...parseTinyauthLog(lines),
      };
    } catch (error) {
      return {
        available: false,
        reason: `Docker did not answer: ${error instanceof Error ? error.message : String(error)}`,
        at,
      };
    }
  }

  /** Why this action cannot be done on this service at all, whatever the policy says. */
  private async impossible(
    kind: ActionKind,
    requestedBy: Requester,
    target: Target,
  ): Promise<string | undefined> {
    const { service } = target;
    // Removed means not Hearth's any more: nothing is run on it, by anyone.
    if (service.lifecycle === "removed") {
      return `${service.name} was removed from Hearth, so Hearth does not touch it. To change that, bring it back from Settings first.`;
    }
    if (kind === "restart-container" && target.cannotRestart) return target.cannotRestart;
    if (POWER_ACTIONS.includes(kind)) {
      const verb = kind === "start-container" ? "start" : "stop";
      if (target.cannotRestart) return target.cannotRestart.replace(/restart/g, verb);
      // Paused or retired means off on purpose: not even you start it by accident.
      if (kind === "start-container" && service.lifecycle !== "active") {
        return `${service.name} is ${service.lifecycle}, so Hearth will not start it. If it should run again, set it back to active on its page first.`;
      }
      if (kind === "stop-container" && isCoreNetworking(service.name, service.image)) {
        return `${service.name} carries other things (remote access, a VPN, DNS, or Docker access), so Hearth never stops it. Stopping it would take other services down with it.`;
      }
      if (kind === "stop-container" && service.stoppedAt) {
        return `${service.name} is already stopped.`;
      }
    }
    if (kind === "restart-container" && service.stoppedAt && requestedBy !== "you") {
      return `${service.name} was stopped on request, so Hearth will not restart it. Start it instead if it should run.`;
    }
    // Off on purpose: only you may start it again (the AI and runbooks may not).
    if (ACTIONS[kind].changes && requestedBy !== "you") {
      if (service.lifecycle !== "active") {
        return `${service.name} is ${service.lifecycle} by its owner, so Hearth leaves it alone.`;
      }
      const check = await this.handle.db
        .select({ problem: t.checkState.problem })
        .from(t.checkState)
        .where(eq(t.checkState.serviceId, service.id))
        .get();
      // Starting it is exactly the question a clean stop asks; a plan you approve may.
      if (check?.problem === "stopped-on-purpose" && kind !== "start-container") {
        return noRestartReason("stopped-on-purpose", service.name)!;
      }
    }
    if (kind === "test-endpoint" && !service.localUrl) {
      return `${service.name} has no web address to test.`;
    }
    if (kind === "inspect-logs" && service.kind !== "container") {
      return `Logs are only available for containers.`;
    }
    return undefined;
  }

  /**
   * What would happen if this action were requested now, without doing it:
   * used to plan jobs. The same checks and policy as request().
   */
  async preview(
    kind: ActionKind,
    serviceId: string,
    requestedBy: Requester,
  ): Promise<{ serviceName: string; label: string; decision: PolicyDecision }> {
    const target = await loadTarget(this.handle.db, serviceId);
    const def = ACTIONS[kind];
    const label = def.describe(target.service.name);
    const blocked = await this.impossible(kind, requestedBy, target);
    if (blocked) {
      return {
        serviceName: target.service.name,
        label,
        decision: { outcome: "refuse", reason: blocked },
      };
    }
    const sandbox =
      def.changes && target.container
        ? ((await this.deps.containers.facts(target.container).catch(() => undefined))?.sandbox ??
          false)
        : false;
    return {
      serviceName: target.service.name,
      label,
      decision: decideAction({
        action: def,
        requestedBy,
        level: target.level,
        area: target.area,
        live: target.live,
        liveRepairs: target.liveRepairs,
        doNotTouch: target.doNotTouch,
        sandbox,
      }),
    };
  }

  /**
   * The policy alone for an operation on a service (the same autonomy rules as
   * any action), without container checks: used by operations inside apps.
   */
  async policyFor(
    kind: ActionKind,
    serviceId: string,
    requestedBy: Requester,
    approved = false,
  ): Promise<{ service: ServiceRow; decision: PolicyDecision }> {
    const target = await loadTarget(this.handle.db, serviceId);
    return {
      service: target.service,
      decision: decideAction({
        action: ACTIONS[kind],
        requestedBy,
        level: target.level,
        area: target.area,
        live: target.live,
        liveRepairs: target.liveRepairs,
        doNotTouch: target.doNotTouch,
        sandbox: false,
        approved,
      }),
    };
  }

  /**
   * Requests an action. `approved` is only ever passed by server code that
   * holds a verified, single-use approval (a job step); the HTTP route and
   * the AI cannot set it.
   */
  async request(input: {
    kind: ActionKind;
    serviceId: string;
    requestedBy: Requester;
    incidentId?: string;
    approved?: boolean;
    /** inspect-logs only: a time window and text filter instead of the latest lines. */
    logs?: LogQuery;
  }): Promise<{ action: ActionRecord; lines?: string[] }> {
    const { db } = this.handle;
    // Checked before anything is recorded: a malformed window is a plain answer, not an action.
    let logPlan: ReturnType<typeof planLogQuery> | undefined;
    try {
      logPlan = input.kind === "inspect-logs" && input.logs ? planLogQuery(input.logs) : undefined;
    } catch (error) {
      throw new InvalidRequestError(error instanceof Error ? error.message : String(error));
    }
    const target = await loadTarget(db, input.serviceId);
    const def = ACTIONS[input.kind];

    if (APP_ACTIONS.includes(input.kind)) {
      throw new ConflictError(
        `${def.describe(target.service.name)} needs details (which one, what to change), so it only runs as a step of a plan.`,
      );
    }
    const blocked = await this.impossible(input.kind, input.requestedBy, target);
    if (blocked) throw new ConflictError(blocked);
    const power = POWER_ACTIONS.includes(input.kind);
    if (power && input.requestedBy !== "you" && !input.approved) {
      throw new ConflictError(
        `${def.describe(target.service.name)} only happens when you do it, or as a step of a plan you approve. Propose it as a plan.`,
      );
    }
    if (power) {
      const direct = input.requestedBy === "you" && !input.approved;
      const order = await this.dependencyProblem(input.kind, target, direct);
      if (order) throw new ConflictError(order);
    }

    const sandbox =
      def.changes && target.container
        ? ((await this.deps.containers.facts(target.container).catch(() => undefined))?.sandbox ??
          false)
        : false;
    const decision = decideAction({
      action: def,
      requestedBy: input.requestedBy,
      level: target.level,
      area: target.area,
      live: target.live,
      liveRepairs: target.liveRepairs,
      doNotTouch: target.doNotTouch,
      sandbox,
      approved: input.approved,
    });

    const id = randomUUID();
    const at = new Date().toISOString();
    const status =
      decision.outcome === "refuse"
        ? "refused"
        : decision.outcome === "approve-first"
          ? "requested"
          : def.changes
            ? "running"
            : "succeeded";

    await withTransaction(this.handle, async () => {
      await db.insert(t.actions).values({
        id,
        kind: input.kind,
        targetType: "service",
        targetId: target.service.id,
        requestedBy: input.requestedBy,
        incidentId: input.incidentId ?? null,
        status,
        requestedAt: at,
        completedAt: status === "refused" ? at : null,
        result: decision.outcome === "allow" ? null : decision.reason,
      });
      if (status === "running" && power) {
        await this.startPowerRecord(db, input.kind, target, input.requestedBy, decision.reason, at);
      } else if (status === "running") {
        await this.startRestartRecord(
          db,
          id,
          target,
          input.requestedBy,
          decision.reason,
          at,
          input.approved ?? false,
        );
      }
    });

    if (decision.outcome !== "allow") return { action: await this.record(id) };

    if (def.changes) {
      this.startCarryOut(id, target, input.kind);
      return { action: await this.record(id) };
    }
    return this.runReadOnly(id, input.kind, target, logPlan);
  }

  private async runReadOnly(
    id: string,
    kind: ActionKind,
    target: Target,
    logPlan?: PlannedLogQuery,
  ) {
    const { db } = this.handle;
    const { service } = target;
    let ok = true;
    let result: string;
    let lines: string[] | undefined;
    try {
      if (kind === "run-check") {
        await runChecks(this.handle, this.deps.probes, { serviceIds: [service.id] });
        const state = await db
          .select()
          .from(t.checkState)
          .where(eq(t.checkState.serviceId, service.id))
          .get();
        ok = state?.status !== "failing";
        result = `${service.name} ${state?.detail ?? "was checked"}.`;
      } else if (kind === "test-endpoint") {
        const res = await this.deps.probes.http(service.localUrl!);
        ok = res.ok;
        result = res.ok
          ? `Answered in ${res.ms} ms${res.status ? ` (HTTP ${res.status})` : ""}.`
          : `Did not answer: ${res.error ?? `error ${res.status}`}.`;
      } else {
        if (logPlan) {
          const raw = target.demo
            ? stampDemo(demoLogs(service), logPlan.range.until)
            : await this.deps.containers.logs(target.container!, SCAN_LINES, logPlan.range);
          lines = shapeLogLines(raw, logPlan);
          result = `Read logs for ${logPlan.window}${logPlan.filter ? ` containing "${logPlan.filter}"` : ""}: ${raw.length} ${raw.length === 1 ? "line" : "lines"}.`;
        } else {
          lines = target.demo
            ? demoLogs(service)
            : await this.deps.containers.logs(target.container!, LOG_LINES);
          result = `Read ${lines.length} recent log ${lines.length === 1 ? "line" : "lines"}.`;
        }
      }
    } catch (error) {
      ok = false;
      result = error instanceof Error ? error.message : String(error);
    }
    await db
      .update(t.actions)
      .set({ status: ok ? "succeeded" : "failed", result, completedAt: new Date().toISOString() })
      .where(eq(t.actions.id, id));
    return { action: await this.record(id), lines };
  }

  /** Marks an approved or allowed restart as started: timeline, audit. Inside a transaction. */
  private async startRestartRecord(
    db: Db,
    actionId: string,
    target: Target,
    requestedBy: Requester,
    reason: string,
    at: string,
    approved: boolean,
  ) {
    const { service } = target;
    const label = ACTIONS["restart-container"].describe(service.name);
    const own = await db.select().from(t.actions).where(eq(t.actions.id, actionId)).get();
    const linked = own?.incidentId
      ? await db.select().from(t.incidents).where(eq(t.incidents.id, own.incidentId)).get()
      : undefined;
    const incident =
      linked && linked.status !== "resolved"
        ? linked
        : await openIncidentFor(db, `service:${service.id}`);
    // Restarting something another service depends on, as part of that service's incident.
    const forOther =
      incident?.serviceId && incident.serviceId !== service.id
        ? await db.select().from(t.services).where(eq(t.services.id, incident.serviceId)).get()
        : undefined;
    if (incident) {
      await db.update(t.actions).set({ incidentId: incident.id }).where(eq(t.actions.id, actionId));
      // Any other proposal for this incident is overtaken by this restart.
      await db
        .update(t.actions)
        .set({ status: "refused", result: "Overtaken by another restart.", completedAt: at })
        .where(
          and(
            eq(t.actions.incidentId, incident.id),
            eq(t.actions.status, "requested"),
            ne(t.actions.id, actionId),
          ),
        );
      await addTimeline(
        db,
        incident.id,
        at,
        "action",
        requestedBy === "you" && !approved
          ? `You restarted the ${service.name} container.`
          : forOther
            ? `${label}, which ${forOther.name} depends on. ${reason}`
            : `${label}. ${reason}`,
      );
    }
    await recordAudit(db, {
      actor: requestedBy,
      action: `Restarted the ${service.name} container`,
      target: `service:${service.id}`,
      detail: {
        reason,
        ...(incident ? { incident: incident.id } : {}),
        ...(target.demo ? { sampleData: true } : {}),
      },
    });
  }

  /** Restart, then verify with Hearth's own health check. */
  private async carryOut(actionId: string, target: Target) {
    const { service } = target;
    const started = Date.now();
    let failure: string | undefined;
    try {
      if (target.demo) {
        await sleep(this.deps.demoRestartMs);
        simulateRestart(service.id);
      } else {
        await this.deps.containers.restart(target.container!);
      }
    } catch (error) {
      failure = `The restart did not go through: ${error instanceof Error ? error.message : String(error)}`;
    }

    let outcome: Awaited<ReturnType<typeof checkService>> | undefined;
    if (!failure) {
      // Sample restarts are quick, so their verification is short (tests use their own timing).
      const verify =
        target.demo && this.deps.verify.intervalMs >= DEMO_VERIFY.intervalMs
          ? DEMO_VERIFY
          : this.deps.verify;
      for (let i = 0; i < verify.attempts; i++) {
        await sleep(verify.intervalMs);
        const containers = target.container
          ? await this.deps.probes
              .containers()
              .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
          : undefined;
        // Restart counts are not compared here: the restart itself is expected.
        outcome = await checkService(service, this.deps.probes, containers, null);
        if (outcome.status !== "failing") break;
      }
    }

    // A dependency was repaired for another service's incident: check that service too.
    const { db } = this.handle;
    let dependent: Dependent | undefined;
    const action = await db.select().from(t.actions).where(eq(t.actions.id, actionId)).get();
    const incident = action?.incidentId
      ? await db.select().from(t.incidents).where(eq(t.incidents.id, action.incidentId)).get()
      : undefined;
    if (incident?.serviceId && incident.serviceId !== service.id) {
      const other = await db
        .select()
        .from(t.services)
        .where(eq(t.services.id, incident.serviceId))
        .get();
      if (other) {
        const fixed = !failure && outcome !== undefined && outcome.status !== "failing";
        dependent = {
          service: other,
          outcome: fixed ? await this.verifyService(other, target.demo) : undefined,
        };
      }
    }
    await this.finish(actionId, target, started, failure, outcome, dependent);
  }

  /**
   * Hearth's own check of a service after a change made elsewhere (a Compose recreate): the
   * same check monitoring uses, repeated briefly. Undefined when the service is unknown.
   */
  async checkService(serviceId: string): Promise<CheckResult | undefined> {
    const service = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.id, serviceId))
      .get();
    return service ? this.verifyService(service, false) : undefined;
  }

  /** Hearth's own check, repeated briefly: services take a moment to come back. */
  private async verifyService(service: ServiceRow, demo: boolean): Promise<CheckResult> {
    const verify =
      demo && this.deps.verify.intervalMs >= DEMO_VERIFY.intervalMs
        ? DEMO_VERIFY
        : this.deps.verify;
    let outcome = await this.checkNow(service);
    for (let i = 1; i < verify.attempts && outcome.status === "failing"; i++) {
      await sleep(verify.intervalMs);
      outcome = await this.checkNow(service);
    }
    return outcome;
  }

  private async checkNow(service: ServiceRow): Promise<CheckResult> {
    const containers = service.checkTarget?.startsWith("container:")
      ? await this.deps.probes
          .containers()
          .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
      : undefined;
    return checkService(service, this.deps.probes, containers, null);
  }

  private async finish(
    actionId: string,
    target: Target,
    started: number,
    failure: string | undefined,
    outcome: CheckResult | undefined,
    dependent?: Dependent,
  ) {
    const { db } = this.handle;
    const { service } = target;
    const at = new Date().toISOString();
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    const recovered = !failure && outcome !== undefined && outcome.status !== "failing";
    const action = await db.select().from(t.actions).where(eq(t.actions.id, actionId)).get();
    const byYou = action?.requestedBy === "you";

    await withTransaction(this.handle, async () => {
      const result = recovered
        ? `${service.name} is back: ${outcome!.detail}. Verified ${seconds}s after the restart.`
        : (failure ??
          `Still failing after the restart: ${service.name} ${outcome?.detail ?? "did not recover"}.`);
      await db
        .update(t.actions)
        .set({ status: recovered ? "succeeded" : "failed", result, completedAt: at })
        .where(eq(t.actions.id, actionId));

      if (recovered) {
        await db
          .update(t.checkState)
          .set({
            status: outcome!.status,
            consecutiveFailures: 0,
            failingSince: null,
            problem: null,
            detail: outcome!.detail,
            checkedAt: at,
            lastOkAt: at,
          })
          .where(eq(t.checkState.serviceId, service.id));
        await db
          .update(t.services)
          .set({
            health: outcome!.status === "ok" ? "healthy" : "attention",
            responseMs:
              outcome!.responseMs !== undefined
                ? Math.round(outcome!.responseMs)
                : service.responseMs,
          })
          .where(eq(t.services.id, service.id));
      }

      await recordAudit(db, {
        actor: "dragon-control",
        action: recovered
          ? `Verified ${service.name} is working after the restart`
          : `Restarting ${service.name} did not fix it`,
        target: `service:${service.id}`,
        detail: { result },
      });

      const incident = action?.incidentId
        ? await db.select().from(t.incidents).where(eq(t.incidents.id, action.incidentId)).get()
        : undefined;
      // A repair the AI operator asked for is concluded by the operator's session, after
      // Hearth's own check; unless you approved it, which this path finishes.
      if (action?.requestedBy === "agent" && incident && incident.status !== "approved") {
        return;
      }
      if (!incident || incident.status === "resolved") {
        await addEvent(
          db,
          at,
          recovered ? "good" : "attention",
          recovered
            ? `${service.name} restarted and verified`
            : `Restarting ${service.name} did not fix it`,
          { serviceId: service.id },
        );
        return;
      }

      const approved = incident.status === "approved";
      if (dependent && incident.serviceId === dependent.service.id) {
        await this.finishForDependent(db, incident, service, dependent, {
          at,
          recovered,
          result,
          outcome,
          byYou,
          approved,
        });
        return;
      }
      if (recovered) {
        await addTimeline(
          db,
          incident.id,
          at,
          "check",
          `Health check passed: ${service.name} ${outcome!.detail}.`,
        );
        await addTimeline(
          db,
          incident.id,
          at,
          "resolved",
          `Fixed in ${took(incident.openedAt, at)} and verified by Hearth's own check.`,
        );
        const resolution = byYou
          ? `You restarted the ${service.name} container. Hearth confirmed it is working again.`
          : approved
            ? `Restarted the ${service.name} container with your approval. Hearth confirmed it is working again.`
            : `Restarted the ${service.name} container automatically. Hearth confirmed it is working again. Nothing is needed from you.`;
        const event =
          byYou || approved
            ? `${service.name} is back after a restart`
            : `${service.name} fixed automatically`;
        await db
          .update(t.incidents)
          .set({
            status: "resolved",
            resolvedAt: at,
            handledBy: byYou || approved ? "you" : "runbook",
            proposedAction: null,
            resolution,
          })
          .where(eq(t.incidents.id, incident.id));
        await addEvent(db, at, "good", event, { incidentId: incident.id, serviceId: service.id });
        await this.rememberFix(db, incident, service, at, {
          title: event,
          resolution,
          how: byYou ? "by you" : approved ? "after you approved it" : "on its own",
        });
      } else {
        await addTimeline(db, incident.id, at, "check", result);
        await addTimeline(
          db,
          incident.id,
          at,
          "escalated",
          "The restart did not fix it. Waiting for you.",
        );
        await db
          .update(t.incidents)
          .set({ status: "open", handledBy: "pending", proposedAction: null })
          .where(eq(t.incidents.id, incident.id));
        await addEvent(db, at, "attention", `Restarting ${service.name} did not fix it`, {
          incidentId: incident.id,
          serviceId: service.id,
        });
      }
    });
  }

  /** The incident's own service, checked after something it depends on was repaired. */
  private async finishForDependent(
    db: Db,
    incident: IncidentRow,
    repaired: ServiceRow,
    dependent: Dependent,
    r: {
      at: string;
      recovered: boolean;
      result: string;
      outcome: CheckResult | undefined;
      byYou: boolean;
      approved: boolean;
    },
  ) {
    const s = dependent.service;
    if (!r.recovered) {
      await addTimeline(db, incident.id, r.at, "check", r.result);
      await addTimeline(
        db,
        incident.id,
        r.at,
        "escalated",
        `Restarting ${repaired.name} did not fix it, so ${s.name} cannot recover yet. Waiting for you.`,
      );
      await db
        .update(t.incidents)
        .set({ status: "open", handledBy: "pending", proposedAction: null })
        .where(eq(t.incidents.id, incident.id));
      await addEvent(db, r.at, "attention", `${s.name} is still failing`, {
        incidentId: incident.id,
        serviceId: s.id,
      });
      return;
    }
    await addTimeline(
      db,
      incident.id,
      r.at,
      "check",
      `Health check passed: ${repaired.name} ${r.outcome!.detail}.`,
    );
    const after = dependent.outcome;
    if (after && after.status !== "failing") {
      await this.markHealthy(db, s, after, r.at);
      await addTimeline(
        db,
        incident.id,
        r.at,
        "check",
        `Retested ${s.name}: ${s.name} ${after.detail}.`,
      );
      await this.resolveIncident(db, incident, s, r.at, {
        handledBy: r.byYou || r.approved ? "you" : "runbook",
        resolution: `${s.name} was failing because ${repaired.name}, which it depends on, had stopped working. Restarted ${repaired.name}${r.approved ? " with your approval" : ""}, and Hearth confirmed both are working again. ${s.name} itself was not touched.`,
        event: `${s.name} fixed by restarting ${repaired.name}`,
      });
      return;
    }
    await addTimeline(
      db,
      incident.id,
      r.at,
      "check",
      `${repaired.name} is back, but ${s.name} still ${after?.detail ?? "fails"}.`,
    );
    await db
      .update(t.incidents)
      .set({ status: "open", handledBy: "pending", proposedAction: null })
      .where(eq(t.incidents.id, incident.id));
    // Upstream is fine now; carry on with the service itself.
    this.background(() => this.repairSelf(incident.id));
  }

  private async markHealthy(db: Db, service: ServiceRow, outcome: CheckResult, at: string) {
    await db
      .update(t.checkState)
      .set({
        status: outcome.status,
        consecutiveFailures: 0,
        failingSince: null,
        problem: null,
        detail: outcome.detail,
        checkedAt: at,
        lastOkAt: at,
      })
      .where(eq(t.checkState.serviceId, service.id));
    await db
      .update(t.services)
      .set({
        health: outcome.status === "ok" ? "healthy" : "attention",
        responseMs:
          outcome.responseMs !== undefined ? Math.round(outcome.responseMs) : service.responseMs,
      })
      .where(eq(t.services.id, service.id));
  }

  private async resolveIncident(
    db: Db,
    incident: IncidentRow,
    service: ServiceRow,
    at: string,
    r: { handledBy: "runbook" | "you"; resolution: string; event: string },
  ) {
    await addTimeline(
      db,
      incident.id,
      at,
      "resolved",
      `Fixed in ${took(incident.openedAt, at)} and verified by Hearth's own check.`,
    );
    await db
      .update(t.incidents)
      .set({
        status: "resolved",
        resolvedAt: at,
        handledBy: r.handledBy,
        proposedAction: null,
        resolution: r.resolution,
      })
      .where(eq(t.incidents.id, incident.id));
    await db
      .update(t.actions)
      .set({ status: "refused", result: "No longer needed.", completedAt: at })
      .where(and(eq(t.actions.incidentId, incident.id), eq(t.actions.status, "requested")));
    await addEvent(db, at, "good", r.event, { incidentId: incident.id, serviceId: service.id });
    await this.rememberFix(db, incident, service, at, {
      title: r.event,
      resolution: r.resolution,
      how: r.handledBy === "you" ? "after you approved it" : "on its own",
    });
  }

  /**
   * Every fix of your real systems becomes a journal entry in the homelab
   * memory, whichever path resolved it (a restart, a dependency, the AI).
   */
  async rememberFix(
    db: Db,
    incident: { id: string; title: string; openedAt: string },
    service: { id: string; name: string; hostId: string },
    at: string,
    text: { title: string; resolution: string; how: string },
  ) {
    if (!this.memory) return;
    const [host] = await db.select().from(t.hosts).where(eq(t.hosts.id, service.hostId));
    await this.memory.recordSystem(db, {
      title: text.title,
      body: `${incident.title}. ${text.resolution} Fixed in ${took(incident.openedAt, at)}, ${text.how}, and verified by Hearth's own check.`,
      happenedAt: at,
      machine: host?.name,
      links: [
        { label: "Incident", ref: `incident:${incident.id}` },
        { label: service.name, ref: `service:${service.id}` },
      ],
    });
  }

  /**
   * Responds to incidents monitoring just opened, one at a time and
   * dependencies first, so a service whose dependency is being repaired
   * waits for that repair instead of being restarted for nothing.
   */
  respond(incidentIds: string[]) {
    if (!incidentIds.length) return;
    this.background(async () => {
      for (const id of await this.dependencyOrder(incidentIds)) await this.respondTo(id);
    });
  }

  private async dependencyOrder(incidentIds: string[]): Promise<string[]> {
    const { db } = this.handle;
    const rows = (await db.select().from(t.incidents)).filter((i) => incidentIds.includes(i.id));
    const deps = await db.select().from(t.serviceDependencies);
    // How deep a service sits in the dependency graph: things others rely on go first.
    const depth = (serviceId: string | null, seen = new Set<string>()): number => {
      if (!serviceId || seen.has(serviceId)) return 0;
      seen.add(serviceId);
      const own = deps.filter((d) => d.serviceId === serviceId).map((d) => d.dependsOnId);
      return own.length ? 1 + Math.max(...own.map((d) => depth(d, seen))) : 0;
    };
    return rows.sort((a, b) => depth(a.serviceId) - depth(b.serviceId)).map((r) => r.id);
  }

  private async respondTo(incidentId: string) {
    const { db } = this.handle;
    const incident = await db
      .select()
      .from(t.incidents)
      .where(eq(t.incidents.id, incidentId))
      .get();
    if (!incident || incident.status === "resolved" || !incident.serviceId) return;
    const target = await loadTarget(db, incident.serviceId);
    const { service } = target;
    const state = await db
      .select()
      .from(t.checkState)
      .where(eq(t.checkState.serviceId, service.id))
      .get();
    const code = (state?.problem ?? null) as ProblemCode | null;

    // Diagnose: look before touching anything (read only).
    let found: string | undefined;
    if (target.level !== "monitor") {
      const facts = target.container
        ? await this.deps.containers.facts(target.container).catch(() => undefined)
        : undefined;
      found = diagnosis(code, facts);
    }

    const escalate = async (text: string) =>
      withTransaction(this.handle, async () => {
        const at = new Date().toISOString();
        if (found) await addTimeline(db, incidentId, at, "check", `Diagnosis: ${found}`);
        await addTimeline(db, incidentId, at, "escalated", text);
      });

    await this.noteSeenBefore(incident, service);

    if (target.level === "monitor") {
      return escalate(`${target.area} is set to Monitor, so Hearth only watches. Waiting for you.`);
    }

    if (await this.upstreamFirst(incident, service)) return;
    return this.repairSelf(incidentId, found);
  }

  /** "Seen before": the same service with the same kind of failure in the last 30 days. */
  private async noteSeenBefore(incident: IncidentRow, service: ServiceRow) {
    if (!incident.problem) return;
    const { db } = this.handle;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const earlier = (
      await db
        .select()
        .from(t.incidents)
        .where(
          and(
            eq(t.incidents.serviceId, service.id),
            eq(t.incidents.problem, incident.problem),
            gte(t.incidents.openedAt, since),
            ne(t.incidents.id, incident.id),
          ),
        )
    ).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    if (!earlier.length) return;
    const last = earlier[0]!;
    const n = earlier.length;
    await withTransaction(this.handle, () =>
      addTimeline(
        db,
        incident.id,
        new Date().toISOString(),
        "check",
        `Seen before: ${n} ${n === 1 ? "time" : "times"} in the last 30 days.${last.resolution ? ` Last time: ${last.resolution}` : ""}`,
      ),
    );
  }

  /**
   * If something this service depends on is failing, deal with that first.
   * Returns true when the incident was handled here (fixed, proposed, or
   * escalated); false when every dependency is fine.
   */
  private async upstreamFirst(incident: IncidentRow, service: ServiceRow): Promise<boolean> {
    const { db } = this.handle;
    const depIds = (
      await db
        .select()
        .from(t.serviceDependencies)
        .where(eq(t.serviceDependencies.serviceId, service.id))
    ).map((d) => d.dependsOnId);
    if (!depIds.length) return false;
    const deps = (await db.select().from(t.services)).filter(
      (s) => depIds.includes(s.id) && s.checkTarget && s.lifecycle !== "removed",
    );
    const now = () => new Date().toISOString();

    // A dependency already being restarted: let it finish first.
    let waited: ServiceRow | undefined;
    for (const d of deps) {
      const busy = this.restarting.get(d.id);
      if (busy) {
        await busy;
        waited = d;
      }
    }

    const checks = await Promise.all(deps.map(async (d) => ({ d, out: await this.checkNow(d) })));
    const broken = checks.find((c) => c.out.status === "failing");

    if (!broken) {
      if (!waited) return false;
      const fixedBy = waited;
      // What it depends on was just repaired; it may well be fine now.
      const self = await this.verifyService(
        service,
        service.checkTarget?.startsWith("demo:") ?? false,
      );
      if (self.status === "failing") return false;
      await withTransaction(this.handle, async () => {
        const current = await db
          .select()
          .from(t.incidents)
          .where(eq(t.incidents.id, incident.id))
          .get();
        if (!current || current.status === "resolved") return;
        await this.markHealthy(db, service, self, now());
        await addTimeline(
          db,
          incident.id,
          now(),
          "check",
          `${service.name} depends on ${fixedBy.name}, which was just repaired. Retested ${service.name}: ${service.name} ${self.detail}.`,
        );
        await this.resolveIncident(db, current, service, now(), {
          handledBy: "runbook",
          resolution: `${service.name} recovered once ${fixedBy.name}, which it depends on, was fixed. Nothing was restarted for ${service.name}.`,
          event: `${service.name} recovered once ${fixedBy.name} was fixed`,
        });
      });
      return true;
    }

    const d = broken.d;
    await withTransaction(this.handle, () =>
      addTimeline(
        db,
        incident.id,
        now(),
        "check",
        `Known fix: check what ${service.name} depends on first. ${d.name} ${broken.out.detail}.`,
      ),
    );
    const escalate = (text: string) =>
      withTransaction(this.handle, () => addTimeline(db, incident.id, now(), "escalated", text));

    // The dependency has its own incident waiting on you: point there instead of duplicating it.
    const theirs = await openIncidentFor(db, `service:${d.id}`);
    if (theirs) {
      await escalate(
        `${service.name} cannot recover until ${d.name} does, and ${d.name} needs you first (see "${theirs.title}"). Waiting for you.`,
      );
      return true;
    }

    const dTarget = await loadTarget(db, d.id);
    if (dTarget.cannotRestart) {
      await escalate(
        `${service.name} cannot recover until ${d.name} does. ${dTarget.cannotRestart} Waiting for you.`,
      );
      return true;
    }
    const { action } = await this.request({
      kind: "restart-container",
      serviceId: d.id,
      requestedBy: "dragon-control",
      incidentId: incident.id,
    });
    if (action.status === "requested") {
      await this.propose(
        incident.id,
        service,
        action,
        `${action.label} (${service.name} depends on it), then check ${service.name} again.`,
        d.name,
      );
    } else if (action.status === "refused") {
      await escalate(
        `${service.name} cannot recover until ${d.name} does. ${action.result ?? "Restarting it is not allowed."} Waiting for you.`,
      );
    }
    return true;
  }

  private async propose(
    incidentId: string,
    service: ServiceRow,
    action: ActionRecord,
    proposedAction: string,
    restartName: string,
  ) {
    const { db } = this.handle;
    await withTransaction(this.handle, async () => {
      const at = new Date().toISOString();
      await db
        .update(t.incidents)
        .set({
          status: "awaiting-approval",
          handledBy: "runbook",
          proposedAction,
          proposalExpiresAt: approvalExpiry(),
        })
        .where(eq(t.incidents.id, incidentId));
      await addTimeline(
        db,
        incidentId,
        at,
        "approval",
        `Proposed: ${action.label}. ${action.result ?? ""}`.trim(),
      );
      await addEvent(db, at, "attention", `Approval requested to restart ${restartName}`, {
        incidentId,
        serviceId: service.id,
      });
    });
  }

  /** The service's own repair: a restart, if a restart can fix it and policy allows. */
  private async repairSelf(incidentId: string, found?: string) {
    const { db } = this.handle;
    const incident = await db
      .select()
      .from(t.incidents)
      .where(eq(t.incidents.id, incidentId))
      .get();
    if (!incident || incident.status === "resolved" || !incident.serviceId) return;
    const target = await loadTarget(db, incident.serviceId);
    const { service } = target;
    const state = await db
      .select()
      .from(t.checkState)
      .where(eq(t.checkState.serviceId, service.id))
      .get();
    const code = (state?.problem ?? incident.problem ?? null) as ProblemCode | null;
    const levelName = AUTONOMY_TITLES[target.level];
    const escalate = async (text: string) =>
      withTransaction(this.handle, async () => {
        const at = new Date().toISOString();
        if (found) await addTimeline(db, incidentId, at, "check", `Diagnosis: ${found}`);
        await addTimeline(db, incidentId, at, "escalated", text);
      });
    const blocked = noRestartReason(code, service.name) ?? target.cannotRestart;
    if (blocked) return escalate(`${blocked} Waiting for you.`);
    if (target.level === "diagnose") {
      return escalate(
        `${target.area} is set to ${levelName}, so Hearth does not change anything there. A restart would be the usual fix. Waiting for you.`,
      );
    }

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const recent = (
      await db
        .select()
        .from(t.actions)
        .where(
          and(
            eq(t.actions.targetId, service.id),
            eq(t.actions.kind, "restart-container"),
            eq(t.actions.requestedBy, "dragon-control"),
            gte(t.actions.requestedAt, hourAgo),
          ),
        )
    ).filter((a) => a.status === "succeeded" || a.status === "failed");
    if (recent.length >= FLAP_LIMIT) {
      return escalate(
        `${service.name} has already been restarted ${recent.length} times in the last hour, so something deeper is wrong. Waiting for you.`,
      );
    }

    if (found) {
      await withTransaction(this.handle, () =>
        addTimeline(db, incidentId, new Date().toISOString(), "check", `Diagnosis: ${found}`),
      );
    }
    const { action } = await this.request({
      kind: "restart-container",
      serviceId: service.id,
      requestedBy: "dragon-control",
      incidentId,
    });
    if (action.status === "requested") {
      await this.propose(
        incidentId,
        service,
        action,
        `${action.label}, then check it is working again.`,
        service.name,
      );
    } else if (action.status === "refused") {
      await escalate(`${action.result ?? "Not allowed."} Waiting for you.`);
    }
  }

  /**
   * Carries out the repair you approved: exactly the action the approval was
   * bound to, once. The policy is evaluated again now, so tightening
   * autonomy after a proposal is respected.
   */
  async runApproved(incidentId: string, actionId: string | undefined) {
    const { db } = this.handle;
    if (!actionId) return;
    const pending = await pendingAction(db, incidentId);
    if (!pending || pending.id !== actionId) return;
    const target = await loadTarget(db, pending.targetId);
    const def = ACTIONS[pending.kind as ActionKind];
    const decision = decideAction({
      action: def,
      requestedBy: pending.requestedBy,
      level: target.level,
      area: target.area,
      approved: true,
      live: target.live,
      liveRepairs: target.liveRepairs,
      doNotTouch: target.doNotTouch,
      sandbox: false,
    });
    const at = new Date().toISOString();
    if (decision.outcome !== "allow" || target.cannotRestart) {
      const reason = target.cannotRestart ?? decision.reason;
      await withTransaction(this.handle, async () => {
        await db
          .update(t.actions)
          .set({ status: "refused", result: reason, completedAt: at })
          .where(eq(t.actions.id, pending.id));
        await addTimeline(
          db,
          incidentId,
          at,
          "escalated",
          `Your approval could not be carried out: ${reason}`,
        );
        await db
          .update(t.incidents)
          .set({ status: "open", handledBy: "pending", proposedAction: null })
          .where(eq(t.incidents.id, incidentId));
      });
      return;
    }
    await withTransaction(this.handle, async () => {
      await db
        .update(t.actions)
        .set({ status: "running", result: null })
        .where(eq(t.actions.id, pending.id));
      await this.startRestartRecord(
        db,
        pending.id,
        target,
        pending.requestedBy,
        decision.reason,
        at,
        true,
      );
    });
    this.startCarryOut(pending.id, target);
  }

  private startCarryOut(actionId: string, target: Target, kind: ActionKind = "restart-container") {
    const run =
      kind === "start-container" || kind === "stop-container"
        ? this.carryOutPower(actionId, target, kind)
        : this.carryOut(actionId, target);
    const work = run.finally(() => {
      if (this.restarting.get(target.service.id) === work) {
        this.restarting.delete(target.service.id);
      }
    });
    this.restarting.set(target.service.id, work);
    this.background(() => work);
  }

  /** You declined: the proposal is closed and nothing runs. */
  async decline(incidentId: string) {
    await this.handle.db
      .update(t.actions)
      .set({ status: "refused", result: "You declined it.", completedAt: new Date().toISOString() })
      .where(and(eq(t.actions.incidentId, incidentId), eq(t.actions.status, "requested")));
  }
}
