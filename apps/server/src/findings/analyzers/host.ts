import type { BackupStatus } from "@dragon-control/core";
import * as t from "../../db/schema";
import type { AnalyzerChange, FindingDraft } from "../store";
import { DAY, HOUR, MIN, duration, type Analyzer, clock } from "./types";

/**
 * The machines themselves (memory pressure, restarts) and Hearth's own backups (a failed run,
 * none for days, the off-machine copy going stale). All from readings Hearth already makes.
 */

interface HostMemo {
  uptime?: Record<string, number>;
}

export function hostAnalyzer(): Analyzer {
  return {
    id: "host.machines",
    source: "host",
    label: "Machines",
    intervalMs: 5 * MIN,
    async run({ handle, now, memo }) {
      const hosts = await handle.db.select().from(t.hosts);
      const drafts: FindingDraft[] = [];
      const changes: AnalyzerChange[] = [];
      const before = (memo as HostMemo | null)?.uptime ?? {};
      const uptime: Record<string, number> = {};
      for (const h of hosts) {
        const resources = [{ kind: "host" as const, id: h.id, name: h.name }];
        // A machine that has not reported recently says nothing about now.
        const fresh = now.getTime() - Date.parse(h.lastSeenAt) < 15 * MIN;
        if (!fresh) continue;
        uptime[h.id] = h.uptimeHours;
        const was = before[h.id];
        if (was !== undefined && h.uptimeHours + 0.05 < was) {
          changes.push({
            tone: "neutral",
            text: `${h.name} restarted ${duration(h.uptimeHours * HOUR)} ago`,
            hostId: h.id,
          });
        }
        const pct = h.memTotalGb ? (h.memUsedGb / h.memTotalGb) * 100 : 0;
        if (pct >= 90) {
          drafts.push({
            key: `host:memory:${h.id}`,
            kind: "suspected",
            nature: "degraded",
            severity: pct >= 95 ? "high" : "medium",
            title: `${h.name} is using ${Math.round(pct)}% of its memory`,
            summary: `${h.memUsedGb.toFixed(1)} GB of ${h.memTotalGb.toFixed(1)} GB in use.`,
            why: "When memory runs out, the system starts killing or slowing services, often the biggest ones (media servers, databases).",
            nextSteps: [
              "Ask Ember which containers use the most memory.",
              "Set memory limits on the hungry ones, or add memory.",
            ],
            evidence: [{ label: "Memory in use", value: `${Math.round(pct)}%`, at: h.lastSeenAt }],
            resources,
            hostId: h.id,
            // Several readings in a row: one busy minute is not a finding.
            confirmAfter: 3,
          });
        }
      }
      return {
        status: "ok",
        drafts,
        covered: (key) => key.startsWith("host:"),
        changes,
        memo: { uptime: { ...before, ...uptime } } satisfies HostMemo,
      };
    },
  };
}

export function backupAnalyzer(backups: { status(): Promise<BackupStatus> }): Analyzer {
  return {
    id: "backup.hearth",
    source: "backup",
    label: "Hearth's own backups",
    intervalMs: 15 * MIN,
    async run({ now }) {
      let status: BackupStatus;
      try {
        status = await backups.status();
      } catch (error) {
        return {
          status: "unavailable",
          note: `Backup status could not be read: ${error instanceof Error ? error.message : String(error)}`,
          drafts: [],
          covered: () => false,
        };
      }
      const drafts: FindingDraft[] = [];
      const last = status.recent[0];
      const resources = [{ kind: "path" as const, name: status.dir }];
      if (last && !last.ok) {
        drafts.push({
          key: "backup:failed",
          kind: "problem",
          nature: "failure",
          severity: "high",
          title: "Hearth's last backup failed",
          summary: `The backup at ${last.at.slice(0, 16).replace("T", " ")} UTC failed: ${last.detail}`,
          why: "Hearth's backup holds your settings, history, and vault. Without a recent one, a disk failure loses them.",
          nextSteps: ["Open Settings, Backups to see the error and run one again."],
          evidence: status.recent
            .slice(0, 4)
            .map((r) => ({ label: r.ok ? "Succeeded" : "Failed", value: r.detail, at: r.at })),
          resources,
        });
      } else if (status.lastOk && now.getTime() - Date.parse(status.lastOk.at) > 2 * DAY) {
        drafts.push({
          key: "backup:stale",
          kind: "problem",
          nature: "risk",
          severity: "medium",
          title: `No backup of Hearth for ${duration(now.getTime() - Date.parse(status.lastOk.at))}`,
          summary: `The last successful backup was at ${status.lastOk.at.slice(0, 16).replace("T", " ")} UTC; one is due every day.`,
          why: "Hearth's backup holds your settings, history, and vault. The older it is, the more is lost if the disk fails.",
          nextSteps: ["Open Settings, Backups and run one now."],
          evidence: [{ label: "Last success", value: status.lastOk.detail, at: status.lastOk.at }],
          resources,
        });
      }
      if (status.offsite?.stale) {
        drafts.push({
          key: "backup:offsite",
          kind: "problem",
          nature: "risk",
          severity: "medium",
          title: `No backup copy has reached ${status.offsite.name} recently`,
          summary: status.offsite.lastVerified
            ? `The last copy ${status.offsite.name} confirmed arrived at ${clock(status.offsite.lastVerified.receivedAt)}.`
            : `${status.offsite.name} has not confirmed any copy yet.`,
          why: "A copy on another machine is what survives if this one fails or is stolen.",
          nextSteps: [`Check that ${status.offsite.name} is on and its fetch task runs.`],
          evidence: [],
          resources,
        });
      }
      return { status: "ok", drafts, covered: (key) => key.startsWith("backup:") };
    },
  };
}
