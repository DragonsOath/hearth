import { and, eq, gte, lt, ne } from "drizzle-orm";
import * as t from "../../db/schema";
import type { MonitorProbes } from "../../monitor/probes";
import type { FindingDraft } from "../store";
import { DAY, MIN, type Analyzer } from "./types";

/**
 * Storage: how full each volume is, where it is heading, and whether it is there at all.
 * Monitoring opens an incident at 90%; this analyzer covers the room before that (80 to 90%),
 * forecasts when a volume will fill from the daily history it keeps (only once there are a few
 * days of real samples), and notices a volume Hearth knows that this machine no longer shows.
 */

export const HISTORY_KEEP_DAYS = 120;
/** Fewer days than this of samples: no forecast (a guess from one day is noise). */
const MIN_FORECAST_SPAN_DAYS = 2;
const FORECAST_HORIZON_DAYS = 30;

/** Least-squares growth in TB per day, from (day index, used) points. */
export function growthPerDay(points: { day: string; usedTb: number }[]): number | undefined {
  if (points.length < 3) return undefined;
  const x0 = Date.parse(points[0]!.day);
  const xs = points.map((p) => (Date.parse(p.day) - x0) / DAY);
  if (xs.at(-1)! < MIN_FORECAST_SPAN_DAYS) return undefined;
  const ys = points.map((p) => p.usedTb);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den ? num / den : undefined;
}

const gb = (tb: number) =>
  tb >= 1 ? `${tb.toFixed(2)} TB` : `${Math.round(tb * 1000).toLocaleString()} GB`;

export function storageAnalyzer(probes: MonitorProbes): Analyzer {
  return {
    id: "storage.volumes",
    source: "storage",
    label: "Storage",
    intervalMs: 15 * MIN,
    async run({ handle, now, environment }) {
      const db = handle.db;
      const day = now.toISOString().slice(0, 10);
      const volumes = await db.select().from(t.volumes);
      const hosts = new Map((await db.select().from(t.hosts)).map((h) => [h.id, h]));

      // Today's sample (the day's highest reading), then forget what is too old to matter.
      for (const v of volumes) {
        if (!v.totalTb) continue;
        const prev = await db
          .select()
          .from(t.volumeUsageDaily)
          .where(and(eq(t.volumeUsageDaily.volumeId, v.id), eq(t.volumeUsageDaily.day, day)))
          .get();
        if (!prev)
          await db
            .insert(t.volumeUsageDaily)
            .values({ volumeId: v.id, day, usedTb: v.usedTb, totalTb: v.totalTb });
        else if (v.usedTb > prev.usedTb)
          await db
            .update(t.volumeUsageDaily)
            .set({ usedTb: v.usedTb, totalTb: v.totalTb })
            .where(and(eq(t.volumeUsageDaily.volumeId, v.id), eq(t.volumeUsageDaily.day, day)));
      }
      await db
        .delete(t.volumeUsageDaily)
        .where(
          lt(
            t.volumeUsageDaily.day,
            new Date(now.getTime() - HISTORY_KEEP_DAYS * DAY).toISOString().slice(0, 10),
          ),
        );

      const capacityIncidents = new Set(
        (
          await db
            .select({ key: t.incidents.monitorKey })
            .from(t.incidents)
            .where(ne(t.incidents.status, "resolved"))
        )
          .map((i) => i.key)
          .filter((k): k is string => Boolean(k?.startsWith("volume:"))),
      );

      // Mounted right now, on this machine (real installs only; sample data has no machine).
      const thisHost = [...hosts.values()].find((h) => h.connection === "this-machine");
      let mounted: Set<string> | undefined;
      let note: string | undefined;
      if (environment === "real" && thisHost) {
        const metrics = await probes.host().catch(() => undefined);
        if (metrics) mounted = new Set(metrics.volumes.map((m) => m.mount.toLowerCase()));
        else note = "Could not read this machine's mounted volumes.";
      }

      const drafts: FindingDraft[] = [];
      const since = new Date(now.getTime() - FORECAST_HORIZON_DAYS * DAY)
        .toISOString()
        .slice(0, 10);
      // Your names for drives (Storage & Files), by the mount they were last seen at.
      const names = new Map(
        (await handle.db.select().from(t.volumeNames)).map((n) => [n.mount, n.name] as const),
      );
      for (const raw of volumes) {
        const name = names.get(raw.mount.length > 1 ? raw.mount.replace(/\/+$/, "") : raw.mount);
        const v = name ? { ...raw, label: `${name} (${raw.mount})` } : raw;
        const host = hosts.get(v.hostId);
        const where = `${v.label} on ${host?.name ?? "this machine"}`;
        const resources = [
          { kind: "volume" as const, id: v.id, name: v.label },
          ...(host ? [{ kind: "host" as const, id: host.id, name: host.name }] : []),
        ];
        if (mounted && v.hostId === thisHost?.id && !mounted.has(v.mount.toLowerCase())) {
          drafts.push({
            key: `storage:missing:${v.id}`,
            kind: "suspected",
            nature: "failure",
            severity: "high",
            title: `${v.label} (${v.mount}) is not mounted`,
            summary: `Hearth knows ${v.mount} on ${host?.name ?? "this machine"}, but the machine does not show it as mounted right now.`,
            why: "Anything that stores data there is either failing or, worse, writing to the system drive instead.",
            nextSteps: [
              "Check the drive is connected and mounted.",
              "Ask Ember which services use it.",
            ],
            evidence: [
              { label: "Mounted volumes checked", value: now.toISOString(), at: now.toISOString() },
            ],
            resources,
            hostId: v.hostId,
            confirmAfter: 2,
          });
          continue;
        }
        if (!v.totalTb || v.totalTb < 0.005) continue;
        const pct = (v.usedTb / v.totalTb) * 100;
        const free = v.totalTb - v.usedTb;
        if (!capacityIncidents.has(`volume:${v.id}`) && pct >= 80 && pct < 90) {
          drafts.push({
            key: `storage:filling:${v.id}`,
            kind: "recommendation",
            nature: "risk",
            // The band (80s), so accepting "84% full" is not accepting "89% full" silently.
            signature: pct >= 85 ? "85-90" : "80-85",
            severity: pct >= 85 ? "medium" : "low",
            title: `${where} is ${Math.round(pct)}% full`,
            summary: `${gb(free)} free of ${gb(v.totalTb)}.`,
            why: "Above 90% downloads, databases, and backups start failing. There is room now, so this is the easy time to plan.",
            nextSteps: [
              "See what is taking the space (Storage, or ask Ember).",
              "Clear what you do not need, or plan more space.",
            ],
            evidence: [
              {
                label: "Used",
                value: `${gb(v.usedTb)} (${Math.round(pct)}%)`,
                at: now.toISOString(),
              },
            ],
            resources,
            hostId: v.hostId,
          });
        }
        const history = await db
          .select()
          .from(t.volumeUsageDaily)
          .where(and(eq(t.volumeUsageDaily.volumeId, v.id), gte(t.volumeUsageDaily.day, since)))
          .orderBy(t.volumeUsageDaily.day);
        const rate = growthPerDay(history);
        const limit = v.totalTb * 0.95;
        if (rate && rate > 0 && v.usedTb < limit) {
          const days = (limit - v.usedTb) / rate;
          if (days <= FORECAST_HORIZON_DAYS) {
            drafts.push({
              key: `storage:forecast:${v.id}`,
              kind: "suspected",
              nature: "risk",
              signature: days <= 7 ? "within a week" : "within a month",
              severity: days <= 7 ? "high" : "medium",
              title: `${where} will be nearly full in about ${Math.max(1, Math.round(days))} days`,
              summary: `It has been growing by about ${gb(rate)} a day over the last ${history.length} days; at that rate it reaches 95% in about ${Math.max(1, Math.round(days))} days.`,
              why: "A forecast, not a certainty: the rate can change. But when it fills, everything writing to it fails at once.",
              nextSteps: [
                "Ask Ember what has been growing.",
                "Clear space or plan more before it fills.",
              ],
              evidence: [
                {
                  label: `${history[0]!.day}`,
                  value: `${gb(history[0]!.usedTb)} used`,
                },
                {
                  label: `${history.at(-1)!.day}`,
                  value: `${gb(history.at(-1)!.usedTb)} used`,
                },
                { label: "Growth", value: `${gb(rate)} per day` },
              ],
              resources,
              hostId: v.hostId,
            });
          }
        }
      }
      return {
        status: note ? "partial" : "ok",
        note:
          note ??
          `Watches ${volumes.length} ${volumes.length === 1 ? "volume" : "volumes"}; forecasts after a few days of history.`,
        drafts,
        covered: (key) =>
          key.startsWith("storage:") && (!key.startsWith("storage:missing:") || Boolean(mounted)),
      };
    },
  };
}
