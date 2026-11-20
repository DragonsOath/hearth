import { asc, desc, eq, gte, ne } from "drizzle-orm";
import type { FindingSeverity } from "@dragon-control/core";
import * as t from "../../db/schema";
import type { FindingDraft } from "../store";
import { DAY, type Analyzer } from "./types";

/**
 * Monitoring incidents (a service down, a volume nearly full, a drive reporting trouble) as
 * findings, so the dashboard has one list. The incident keeps its own workflow (repairs,
 * approvals); the finding links to it and resolves with it, carrying its resolution. App
 * incidents are left to the apps analyzer, which already knows them as findings before they
 * are confirmed.
 */

const WHY: Record<string, (name: string) => string> = {
  "not-responding": (n) =>
    `Anyone or anything using ${n} cannot reach it, and services that depend on it stop working too.`,
  "not-running": (n) =>
    `${n} is not running, so whatever it does for your homelab is not happening.`,
  "crash-loop": (n) =>
    `${n} keeps crashing and restarting, so it is unreliable and may be damaging its own data.`,
  unhealthy: (n) =>
    `Docker's own health check for ${n} fails, which usually means it is running but not working properly.`,
  missing: (n) =>
    `Its container is gone, so ${n} is not running. It may have been removed or renamed.`,
  "stopped-on-purpose": (n) =>
    `${n} shut down cleanly, which usually means someone stopped it. If that was not intended, whatever it does is not happening.`,
  "docker-unreachable": () =>
    "Hearth cannot read Docker, so it cannot tell whether any container is running.",
};

const SEVERITY: Record<string, FindingSeverity> = {
  critical: "critical",
  warning: "high",
  info: "medium",
};

/** One subject, one key: the service or volume monitoring watches, else the incident itself. */
const keyOf = (i: { id: string; monitorKey: string | null }) => `incident:${i.monitorKey ?? i.id}`;

export function incidentsAnalyzer(): Analyzer {
  return {
    id: "monitor.incidents",
    source: "monitor",
    label: "Service monitoring",
    intervalMs: 0,
    async run({ handle, now }) {
      const db = handle.db;
      const open = (await db.select().from(t.incidents).where(ne(t.incidents.status, "resolved")))
        // App incidents are findings of the apps analyzer already.
        .filter((i) => !i.monitorKey?.startsWith("app:"));
      const services = new Map((await db.select().from(t.services)).map((s) => [s.id, s]));
      const hosts = new Map((await db.select().from(t.hosts)).map((h) => [h.id, h]));
      const drafts: FindingDraft[] = [];
      for (const i of open) {
        const service = i.serviceId ? services.get(i.serviceId) : undefined;
        const host = i.hostId ? hosts.get(i.hostId) : undefined;
        const name = service?.name ?? host?.name ?? "it";
        const timeline = await db
          .select()
          .from(t.incidentTimeline)
          .where(eq(t.incidentTimeline.incidentId, i.id))
          .orderBy(desc(t.incidentTimeline.id))
          .limit(4);
        const why = i.problem
          ? (WHY[i.problem]?.(name) ?? i.summary)
          : i.monitorKey?.startsWith("volume:")
            ? "When a volume fills up, downloads, databases, and backups on it start failing."
            : i.monitorKey?.startsWith("disk:")
              ? "A drive reporting trouble can fail completely and take everything on it."
              : i.summary;
        const nextSteps =
          i.status === "awaiting-approval"
            ? [
                `Review the repair Hearth proposed${i.proposedAction ? `: ${i.proposedAction}` : ""}.`,
              ]
            : i.handledBy === "runbook" || i.handledBy === "agent"
              ? ["Hearth is working on it. Open it to follow along."]
              : i.problem === "stopped-on-purpose"
                ? [
                    `If ${name} should be running, start it.`,
                    `If you stopped it on purpose, pause its monitoring so Hearth stops asking.`,
                  ]
                : ["Open it to see what Hearth knows.", "Ask Ember to investigate the cause."];
        drafts.push({
          // By what it is about (the service, the volume), so the same trouble coming back is
          // one finding with its history, and a repair that did not hold shows as such.
          key: keyOf(i),
          kind: i.problem === "stopped-on-purpose" ? "observation" : "problem",
          nature:
            i.problem === "stopped-on-purpose"
              ? "state"
              : i.monitorKey?.startsWith("volume:") || i.monitorKey?.startsWith("disk:")
                ? "risk"
                : "failure",
          signature: i.problem ?? i.monitorKey ?? i.title,
          severity: SEVERITY[i.severity] ?? "high",
          title: i.title,
          summary: i.summary,
          why,
          nextSteps,
          evidence: timeline.reverse().map((e) => ({ label: e.kind, value: e.text, at: e.at })),
          resources: [
            ...(service ? [{ kind: "service" as const, id: service.id, name: service.name }] : []),
            ...(host ? [{ kind: "host" as const, id: host.id, name: host.name }] : []),
          ],
          ...(i.serviceId ? { serviceId: i.serviceId } : {}),
          ...(i.hostId ? { hostId: i.hostId } : {}),
          incidentId: i.id,
        });
      }
      // How each recently closed incident ended (the latest per subject), for the findings it
      // resolves: in its own words, and whether a repair did it or it recovered on its own.
      const closed = new Map(
        (
          await db
            .select()
            .from(t.incidents)
            .where(gte(t.incidents.resolvedAt, new Date(now.getTime() - 7 * DAY).toISOString()))
            .orderBy(asc(t.incidents.resolvedAt))
        ).map((r) => [keyOf(r), r]),
      );
      return {
        status: "ok",
        drafts,
        covered: (key) => key.startsWith("incident:"),
        resolution: ({ key }) => closed.get(key)?.resolution ?? undefined,
        repaired: ({ key }) => {
          const i = closed.get(key);
          return Boolean(i && i.handledBy !== "recovered" && i.handledBy !== "pending");
        },
      };
    },
  };
}
