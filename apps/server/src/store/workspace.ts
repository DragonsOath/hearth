import { asc, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import {
  GUARDRAILS,
  brokenReason,
  effectiveAutonomy,
  isChannelKind,
  isCoreNetworking,
  needsYou,
  type Host,
  type Incident,
  type Integration,
  type PendingJob,
  type RemovedService,
  type Service,
  type TimelineEntry,
  type Workspace,
} from "@dragon-control/core";
import type { Database } from "../db/client";
import * as t from "../db/schema";
import { getSetting, SETTING_DEFAULTS } from "./settings";
import { onboardingNeeded } from "./onboarding";
import { toLocation } from "../storage/service";
import { toDisk } from "./disks";
import { simulatedServices } from "../monitor/simulation";
import { DEFAULT_INTERVAL } from "../monitor/scheduler";
import { toActionRecord } from "../actions/records";
import { ticketFor } from "../actions/approval";
import { toAppReport } from "../apps/service";
import { SUPPORTED_CHANNELS } from "../notify/catalog";

const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

/** Everything the UI needs in one read. Small enough for a homelab; split later if needed. */
export async function loadWorkspace(db: Database, opts: { demo: boolean }): Promise<Workspace> {
  const [
    hostRows,
    volumeRows,
    serviceRows,
    depRows,
    incidentRows,
    timelineRows,
    eventRows,
    ruleRows,
    agentRows,
    sessionRows,
    channelRows,
    routeRows,
    integrationRows,
    locationRows,
    diskRows,
    actionRows,
  ] = await Promise.all([
    db.select().from(t.hosts).orderBy(asc(t.hosts.sort)),
    db.select().from(t.volumes).orderBy(asc(t.volumes.sort)),
    db.select().from(t.services).orderBy(asc(t.services.sort)),
    db.select().from(t.serviceDependencies),
    db.select().from(t.incidents).orderBy(desc(t.incidents.openedAt)),
    db
      .select()
      .from(t.incidentTimeline)
      .orderBy(asc(t.incidentTimeline.at), asc(t.incidentTimeline.id)),
    db.select().from(t.events).orderBy(desc(t.events.at)).limit(20),
    db.select().from(t.autonomyRules).orderBy(asc(t.autonomyRules.sort)),
    db.select().from(t.agents).orderBy(asc(t.agents.sort)),
    db.select().from(t.agentSessions).orderBy(desc(t.agentSessions.at)),
    db.select().from(t.notificationChannels).orderBy(asc(t.notificationChannels.sort)),
    db.select().from(t.notificationRoutes).orderBy(asc(t.notificationRoutes.sort)),
    db.select().from(t.integrations).orderBy(asc(t.integrations.sort)),
    db.select().from(t.storageLocations).orderBy(asc(t.storageLocations.sort)),
    db.select().from(t.disks),
    db.select().from(t.actions).orderBy(desc(t.actions.requestedAt)).limit(50),
  ]);

  const autonomyDefault =
    (await getSetting(db, "autonomy_default")) ?? SETTING_DEFAULTS.autonomy_default;

  const hosts: Host[] = hostRows.map((h) => ({
    id: h.id,
    name: h.name,
    role: h.role,
    os: h.os,
    address: h.address,
    cpu: { model: h.cpuModel, cores: h.cpuCores, usagePct: h.cpuUsagePct },
    memory: { totalGb: h.memTotalGb, usedGb: h.memUsedGb },
    uptimeHours: h.uptimeHours,
    connection: h.connection,
    docker: h.docker,
    health: h.health,
    lastSeenAt: h.lastSeenAt,
    volumes: volumeRows.filter((v) => v.hostId === h.id).map(({ sort: _sort, ...v }) => v),
  }));

  // 30-day availability from hourly check totals.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const availability = new Map(
    (
      await db
        .select({
          serviceId: t.availabilityHourly.serviceId,
          ok: sql<number>`sum(${t.availabilityHourly.ok})`,
          total: sql<number>`sum(${t.availabilityHourly.total})`,
        })
        .from(t.availabilityHourly)
        .where(gte(t.availabilityHourly.hour, since))
        .groupBy(t.availabilityHourly.serviceId)
    ).map((r) => [r.serviceId, r.total ? (Number(r.ok) / Number(r.total)) * 100 : undefined]),
  );
  const checks = new Map((await db.select().from(t.checkState)).map((c) => [c.serviceId, c]));
  // A service with a problem waiting on you needs attention even if its page still answers.
  const troubled = new Set(
    incidentRows.filter((i) => i.serviceId && needsYou(i)).map((i) => i.serviceId!),
  );

  // Systems you removed are hidden everywhere: only Settings lists them, to bring one back.
  const removedRows = serviceRows.filter((s) => s.lifecycle === "removed");
  const removedIds = new Set(removedRows.map((s) => s.id));
  const removedServices: RemovedService[] = removedRows.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category as Service["category"],
    hostId: s.hostId,
    kind: s.kind,
    address: s.checkTarget?.startsWith("container:")
      ? s.checkTarget.slice("container:".length)
      : orUndefined(s.localUrl),
    removedAt: orUndefined(s.lifecycleAt),
  }));

  const allServices: Service[] = serviceRows.flatMap((s) =>
    s.lifecycle === "removed" ? [] : [toService(s)],
  );
  function toService(s: (typeof serviceRows)[number]): Service {
    return {
      id: s.id,
      name: s.name,
      lifecycle: s.lifecycle === "active" || s.lifecycle === "removed" ? undefined : s.lifecycle,
      lifecycleNote: orUndefined(s.lifecycleNote),
      lifecycleAt: orUndefined(s.lifecycleAt),
      category: s.category as Service["category"],
      hostId: s.hostId,
      kind: s.kind,
      image: orUndefined(s.image),
      container: s.checkTarget?.startsWith("container:")
        ? s.checkTarget.slice("container:".length)
        : undefined,
      stopped: s.stoppedAt ? { at: s.stoppedAt, by: s.stoppedBy ?? "you" } : undefined,
      coreNetworking:
        s.kind === "container" && isCoreNetworking(s.name, s.image) ? true : undefined,
      version: orUndefined(s.version),
      localUrl: orUndefined(s.localUrl),
      publicUrl: orUndefined(s.publicUrl),
      proxyServiceId: orUndefined(s.proxyServiceId),
      health: s.health === "healthy" && troubled.has(s.id) ? "attention" : s.health,
      responseMs: orUndefined(s.responseMs),
      uptimePct: availability.get(s.id) ?? orUndefined(s.uptimePct),
      dependsOn: depRows
        .filter((d) => d.serviceId === s.id && !removedIds.has(d.dependsOnId))
        .map((d) => d.dependsOnId),
      autonomyArea: s.autonomyArea,
      autonomy: effectiveAutonomy(s.autonomyArea, ruleRows, autonomyDefault),
      lastCheck: checks.has(s.id)
        ? {
            status: checks.get(s.id)!.status,
            detail: checks.get(s.id)!.detail ?? "",
            at: checks.get(s.id)!.checkedAt,
            consecutiveFailures: checks.get(s.id)!.consecutiveFailures,
          }
        : undefined,
      note: orUndefined(s.note),
    };
  }

  // Paused and retired services are not watched, so they never count towards health.
  const services = allServices.filter((s) => !s.lifecycle);
  const inactiveServices = allServices.filter((s) => s.lifecycle);

  const names = new Map(serviceRows.map((s) => [s.id, s.name]));

  const tickets = new Map(
    await Promise.all(
      incidentRows
        .filter((i) => i.status === "awaiting-approval")
        .map(async (i) => [i.id, await ticketFor(db, i)] as const),
    ),
  );
  const incidents: Incident[] = incidentRows.map((i) => ({
    id: i.id,
    title: i.title,
    serviceId: orUndefined(i.serviceId),
    hostId: orUndefined(i.hostId),
    severity: i.severity,
    status: i.status,
    openedAt: i.openedAt,
    resolvedAt: orUndefined(i.resolvedAt),
    summary: i.summary,
    resolution: orUndefined(i.resolution),
    handledBy: i.handledBy,
    proposedAction: orUndefined(i.proposedAction),
    approval: tickets.get(i.id),
    timeline: timelineRows
      .filter((e) => e.incidentId === i.id)
      .map((e) => ({ at: e.at, kind: e.kind as TimelineEntry["kind"], text: e.text })),
  }));

  const env = await getSetting(db, "environment");
  // Databases from before M3 have a demo scenario but no "environment" setting.
  const legacyDemo = env === undefined && (await getSetting(db, "demo_scenario")) !== undefined;
  const isDemo = env === "demo" || legacyDemo;
  const environment: Workspace["environment"] =
    env === "real"
      ? "real"
      : isDemo
        ? opts.demo
          ? "demo"
          : "empty"
        : hostRows.length
          ? "real"
          : "empty";
  const demoScenario =
    environment === "demo" ? ((await getSetting(db, "demo_scenario")) ?? null) : null;
  const discoveredAt = environment === "real" ? await getSetting(db, "discovered_at") : undefined;

  // Each destination's latest real delivery: a failure for good marks it broken (11-13).
  const lastDelivery = new Map<string, { status: string; error: string | null; at: string }>();
  for (const n of await db
    .select({
      channelId: t.notificationLog.channelId,
      status: t.notificationLog.status,
      error: t.notificationLog.error,
      at: t.notificationLog.at,
    })
    .from(t.notificationLog)
    .where(ne(t.notificationLog.status, "held"))
    .orderBy(desc(t.notificationLog.id))
    .limit(500))
    if (!lastDelivery.has(n.channelId)) lastDelivery.set(n.channelId, n);
  return {
    instanceName: (await getSetting(db, "instance_name")) ?? SETTING_DEFAULTS.instance_name,
    ownerName: (await getSetting(db, "owner_name")) || undefined,
    ownerAvatarAt: (await getSetting(db, "owner_avatar_at")) || undefined,
    aiName: (await getSetting(db, "ai_name")) || undefined,
    aiLookStyle: (await getSetting(db, "ai_look_style")) ?? "ember",
    aiAvatarAt: (await getSetting(db, "ai_avatar_at")) || undefined,
    theme: (await getSetting(db, "ui_theme")) ?? undefined,
    phoneTheme: (await getSetting(db, "ui_theme_phone")) ?? undefined,
    lairOrder: (await getSetting(db, "lair_order")) ?? undefined,
    lairUsage: (await getSetting(db, "lair_usage")) ?? undefined,
    webUiVia: (await getSetting(db, "web_ui_via")) ?? "proxy",
    onboardingDoneAt: (await getSetting(db, "onboarding_done_at")) || undefined,
    journey: (await getSetting(db, "journey")) || undefined,
    onboardingStep: (await getSetting(db, "onboarding_step")) || undefined,
    onboardingNeeded: await onboardingNeeded(db),
    rules: {
      doNotTouch: (await getSetting(db, "do_not_touch")) ?? [],
      reservations: (await getSetting(db, "reservations")) ?? [],
      notes: (await getSetting(db, "lair_rules")) ?? "",
    },
    quietHours: (await getSetting(db, "quiet_hours")) ?? SETTING_DEFAULTS.quiet_hours,
    environment,
    demoScenario,
    discoveredAt,
    hosts,
    services,
    inactiveServices,
    removedServices,
    incidents,
    activity: eventRows.map((e) => ({
      id: e.id,
      at: e.at,
      tone: e.tone,
      text: e.message,
      incidentId: orUndefined(e.incidentId),
    })),
    agents: agentRows.map(({ sort: _sort, detail, ...a }) => ({
      ...a,
      detail: orUndefined(detail),
    })),
    agentSessions: sessionRows.map((r) => ({
      id: r.id,
      at: r.at,
      incidentId: orUndefined(r.incidentId),
      conversationId: orUndefined(r.conversationId),
      provider: orUndefined(r.provider),
      summary: r.summary,
      outcome: r.outcome,
    })),
    operator: {
      agentId: await getSetting(db, "operator_agent"),
      escalate: (await getSetting(db, "agent_escalate")) ?? true,
    },
    channels: channelRows.map((c) => {
      const last = lastDelivery.get(c.id);
      const reason =
        c.status === "configured" && last?.status === "failed"
          ? brokenReason(last.error, c.kind ?? c.id)
          : undefined;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        detail: orUndefined(c.detail),
        supported: SUPPORTED_CHANNELS.has(c.kind ?? c.id),
        kind: c.kind ?? c.id,
        enabled: c.enabled !== false,
        audience: c.audience ?? "private",
        // Added destinations have their own ids; a built-in channel's id is its kind.
        added: !isChannelKind(c.id),
        config: orUndefined(c.config),
        ...(reason && last ? { broken: { reason, at: last.at } } : {}),
      };
    }),
    routes: routeRows.map(({ sort: _sort, ...r }) => r),
    integrations: integrationRows.map(({ sort: _sort, instances, ...x }) => ({
      ...x,
      category: x.category as Integration["category"],
      instances: orUndefined(instances),
    })),
    autonomyDefault,
    autonomyRules: ruleRows.map(({ sort: _sort, ...r }) => r),
    guardrails: GUARDRAILS,
    storageLocations: locationRows.map(toLocation),
    monitoring: {
      intervalSec:
        (await getSetting(db, "monitor_interval_sec")) ??
        (environment === "real" ? DEFAULT_INTERVAL.real : DEFAULT_INTERVAL.demo),
      failureThreshold: (await getSetting(db, "failure_threshold")) ?? 2,
      lastRunAt: await getSetting(db, "monitor_last_run"),
      simulated: environment === "demo" ? simulatedServices() : [],
    },
    pendingJobs: await pendingJobs(db),
    apps: (await db.select().from(t.appHealth)).map(toAppReport),
    actions: actionRows.map((a) => toActionRecord(a, names.get(a.targetId) ?? a.targetId)),
    liveRepairs: (await getSetting(db, "live_repairs")) ?? false,
    chatPictures: (await getSetting(db, "chat_pictures")) ?? true,
    notifications: (
      await db.select().from(t.notificationLog).orderBy(desc(t.notificationLog.id)).limit(30)
    ).map((n) => ({
      id: n.id,
      at: n.at,
      event: n.event,
      incidentId: orUndefined(n.incidentId),
      channelId: n.channelId,
      title: n.title,
      status: n.status,
      error: orUndefined(n.error),
    })),
    disks: diskRows
      .map(toDisk)
      .sort((a, b) => (a.volumes[0] ?? "~").localeCompare(b.volumes[0] ?? "~")),
  };
}

async function pendingJobs(db: Database): Promise<PendingJob[]> {
  const rows = await db
    .select()
    .from(t.jobs)
    .where(eq(t.jobs.status, "awaiting-approval"))
    .orderBy(asc(t.jobs.createdAt));
  const counts = rows.length
    ? await db
        .select({ jobId: t.jobSteps.jobId, n: count() })
        .from(t.jobSteps)
        .where(
          inArray(
            t.jobSteps.jobId,
            rows.map((r) => r.id),
          ),
        )
        .groupBy(t.jobSteps.jobId)
    : [];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt ?? undefined,
    steps: counts.find((c) => c.jobId === r.id)?.n ?? 0,
  }));
}
