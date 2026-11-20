import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import {
  needsAttention,
  type AppActivity,
  type ChangeItem,
  type DashboardBriefing,
  type EmberActivityItem,
  type TrendItem,
  type WorkingItem,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { FindingsEngine } from "./engine";
import { DAY, plural } from "./analyzers/types";
import { clock } from "./analyzers/types";

/**
 * The dashboard's answers, built from what Hearth holds: what needs you and why, what changed
 * since you last looked, what is working (only real evidence: imports that happened, problems
 * solved, backups made), what Ember is on, trends from the history Hearth keeps, and what it
 * can and cannot see. Nothing here is invented: a section with no evidence is left empty.
 */

const IMPORTING_APPS = new Set(["sonarr", "radarr", "lidarr", "chaptarr"]);
const WHAT: Record<string, [string, string]> = {
  sonarr: ["episode", "episodes"],
  radarr: ["movie", "movies"],
  lidarr: ["album", "albums"],
  chaptarr: ["book", "books"],
};

const gb = (tb: number) =>
  Math.abs(tb) >= 1 ? `${tb.toFixed(2)} TB` : `${Math.round(tb * 1000).toLocaleString()} GB`;

export async function buildBriefing(
  handle: DbHandle,
  engine: FindingsEngine,
  opts: { since?: string; now?: Date } = {},
): Promise<DashboardBriefing> {
  const db = handle.db;
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - DAY).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const dayAgo = new Date(now.getTime() - DAY).toISOString();

  const active = await engine.findings.list({ status: "active", hideSnoozed: true, now });
  const attention = active.filter(needsAttention);
  const worthKnowing = active.filter((f) => !needsAttention(f));

  /* What changed since you last looked. */
  const changes: ChangeItem[] = [];
  const { opened, resolved } = await engine.findings.changedSince(since);
  // New findings are listed above (attention, worth knowing): here they are one line, not a copy.
  if (opened.length) {
    // Counted the way Home shows them: findings under one incident are one thing.
    const things = (list: typeof opened) => new Set(list.map((f) => f.incidentId ?? f.id)).size;
    const total = things(opened);
    const urgent = things(opened.filter(needsAttention));
    changes.push({
      at: opened[0]!.firstSeenAt,
      tone: urgent ? "attention" : "neutral",
      text:
        total === 1
          ? `Found 1 new thing: ${opened[0]!.title}`
          : `Found ${total} new things${urgent ? `, ${urgent} needing you` : ""}`,
      ref: total === 1 ? `finding:${opened[0]!.id}` : "page:findings",
    });
  }
  for (const f of resolved)
    changes.push({
      at: f.resolvedAt!,
      tone: "good",
      text: `Resolved: ${f.title}${f.resolution ? `. ${f.resolution}` : ""}`,
      ref: `finding:${f.id}`,
    });
  // Events (updates, new containers, backups, imports) are Recent activity's: not repeated here.
  const finishedJobs = await db
    .select()
    .from(t.jobs)
    .where(
      and(
        gte(t.jobs.createdAt, weekAgo),
        inArray(t.jobs.status, ["succeeded", "partial", "failed", "rolled-back"]),
      ),
    )
    .orderBy(desc(t.jobs.createdAt))
    .limit(20);
  for (const j of finishedJobs) {
    const at = j.finishedAt ?? j.createdAt;
    if (at <= since) continue;
    changes.push({
      at,
      tone: j.status === "succeeded" ? "good" : "attention",
      text:
        j.status === "succeeded"
          ? `Plan done and verified: ${j.title}`
          : `Plan ${j.status === "rolled-back" ? "rolled back" : j.status}: ${j.title}`,
      ref: `job:${j.id}`,
    });
  }
  changes.sort((a, b) => b.at.localeCompare(a.at));

  /* What is working. Real evidence only. */
  const working: WorkingItem[] = [];
  const services = await db.select().from(t.services).where(eq(t.services.lifecycle, "active"));
  const byId = new Map(services.map((s) => [s.id, s]));
  for (const row of await db.select().from(t.appHealth)) {
    const s = byId.get(row.serviceId);
    if (!s || !IMPORTING_APPS.has(row.app)) continue;
    const activity = ((row.details as { activity?: AppActivity[] } | null)?.activity ?? []).filter(
      (a) => a.tone === "good" && a.at && a.at >= dayAgo,
    );
    if (activity.length) {
      const [one, many] = WHAT[row.app] ?? ["item", "items"];
      working.push({
        text: `${s.name} imported ${plural(activity.length, one, many)} in the last day`,
        ref: `service:${s.id}`,
      });
    }
  }
  const quietFixes = (
    await db
      .select({ handledBy: t.incidents.handledBy })
      .from(t.incidents)
      .where(and(eq(t.incidents.status, "resolved"), gte(t.incidents.resolvedAt, weekAgo)))
  ).filter((i) => i.handledBy !== "you").length;
  if (quietFixes)
    working.push({
      text: `${plural(quietFixes, "problem was", "problems were")} resolved this week without you`,
    });
  const watched = services.filter((s) => s.checkTarget && !s.stoppedAt);
  if (watched.length && watched.every((s) => s.health === "healthy")) {
    const lastIncident = await db
      .select({ at: t.incidents.openedAt })
      .from(t.incidents)
      .orderBy(desc(t.incidents.openedAt))
      .get();
    const days = lastIncident
      ? Math.floor((now.getTime() - Date.parse(lastIncident.at)) / DAY)
      : undefined;
    working.push({
      text: `All ${watched.length} watched services are healthy${days && days >= 2 ? `, with no incidents for ${days} days` : ""}`,
    });
  }
  const lastBackup = await db
    .select()
    .from(t.backupLog)
    .where(eq(t.backupLog.ok, true))
    .orderBy(desc(t.backupLog.at))
    .get();
  if (lastBackup && lastBackup.at >= dayAgo)
    working.push({ text: `Hearth backed itself up at ${clock(lastBackup.at, now)}` });

  /* What Ember is on. */
  const ember: EmberActivityItem[] = active
    .filter((f) => f.status === "investigating")
    .map((f) => ({
      text: `Investigating F-${f.number}: ${f.title}`,
      status: "investigating" as const,
      ref: `finding:${f.id}`,
    }));
  const jobs = await db
    .select()
    .from(t.jobs)
    .where(inArray(t.jobs.status, ["awaiting-approval", "running"]))
    .orderBy(desc(t.jobs.createdAt))
    .limit(10);
  for (const j of jobs)
    ember.push({
      text:
        j.status === "running"
          ? `Running: ${j.title}`
          : `${j.requestedBy === "agent" ? "Proposed" : "Planned"}, waiting for your approval: ${j.title}`,
      status: j.status === "running" ? "running" : "awaiting-approval",
      ref: `job:${j.id}`,
    });

  /* Trends from the history Hearth keeps. */
  const trends: TrendItem[] = [];
  const availability = await db
    .select()
    .from(t.availabilityHourly)
    .where(gte(t.availabilityHourly.hour, weekAgo));
  const total = availability.reduce((n, r) => n + r.total, 0);
  if (total >= 50) {
    const ok = availability.reduce((n, r) => n + r.ok, 0);
    const pct = (ok / total) * 100;
    trends.push({
      label: "Uptime this week",
      text: `${pct >= 99.95 ? "100" : pct.toFixed(pct >= 99 ? 2 : 1)}% of checks passed`,
      tone: pct >= 99.5 ? "good" : pct >= 97 ? "neutral" : "attention",
    });
  }
  const volumes = await db.select().from(t.volumes);
  for (const v of volumes) {
    const samples = await db
      .select()
      .from(t.volumeUsageDaily)
      .where(
        and(
          eq(t.volumeUsageDaily.volumeId, v.id),
          gte(t.volumeUsageDaily.day, weekAgo.slice(0, 10)),
        ),
      )
      .orderBy(t.volumeUsageDaily.day);
    if (samples.length < 2) continue;
    const delta = samples.at(-1)!.usedTb - samples[0]!.usedTb;
    if (Math.abs(delta) < 0.001) continue;
    trends.push({
      label: `${v.label} this week`,
      text: `${delta > 0 ? "Grew" : "Shrank"} by ${gb(Math.abs(delta))} (${samples.length} days)`,
      tone: "neutral",
    });
  }
  const weekFindings = await engine.findings.changedSince(weekAgo);
  if (weekFindings.opened.length || weekFindings.resolved.length)
    trends.push({
      label: "Findings this week",
      text: `${weekFindings.opened.length} new, ${weekFindings.resolved.length} resolved`,
      tone: weekFindings.resolved.length >= weekFindings.opened.length ? "good" : "neutral",
    });
  const restarts = await db
    .select({ cause: t.containerEvents.cause })
    .from(t.containerEvents)
    .where(
      and(
        gte(t.containerEvents.at, weekAgo),
        eq(t.containerEvents.kind, "start"),
        ne(t.containerEvents.cause, "first-seen"),
      ),
    );
  if (restarts.length)
    trends.push({
      label: "Restarts this week",
      text: `${restarts.length} (${restarts.filter((r) => r.cause === "docker").length} by Docker after a crash)`,
      tone: restarts.some((r) => r.cause === "docker") ? "attention" : "neutral",
    });

  return {
    generatedAt: now.toISOString(),
    attention: attention.slice(0, 8),
    attentionTotal: attention.length,
    worthKnowing: worthKnowing.slice(0, 6),
    worthKnowingTotal: worthKnowing.length,
    changes: changes.slice(0, 10),
    working,
    ember,
    trends,
    coverage: await engine.coverage(),
  };
}
