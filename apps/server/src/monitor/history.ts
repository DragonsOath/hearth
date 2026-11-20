import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { ContainerCounters, ContainerTools } from "../actions/tools";
import { getSetting, setSetting } from "../store/settings";
import type { HostCounters } from "./host-counters";

/**
 * Resource history (off until the owner switches it on in Settings, after
 * seeing what it will cost): every SAMPLE_MINUTES Hearth reads each
 * watched container's counters and the host's, and adds them to that hour's
 * row as running totals (one row per subject per hour however often it
 * samples). Rows older than the retention are deleted once a day. Uptime
 * history (availability_hourly) is pruned here too, at 90 days.
 */

export const SAMPLE_MINUTES = 5;
export const RETENTION_CHOICES = [7, 14, 30] as const;
export const HISTORY_DEFAULTS = { enabled: false, retentionDays: 14 } as const;
/** Uptime history kept for the 30-day availability figure, with room to spare. */
export const AVAILABILITY_KEEP_DAYS = 90;
/** Bytes one hourly row takes on disk with its indexes (measured, see history.test.ts). */
export const ROW_BYTES = 160;

export interface HistorySettings {
  enabled: boolean;
  retentionDays: number;
}

export interface HistoryEstimate {
  subjects: number;
  containers: number;
  rowsPerDay: number;
  rows: number;
  bytes: number;
  samplesPerHour: number;
}

export interface HistoryPoint {
  hour: string;
  samples: number;
  cpuAvgPct?: number;
  cpuMaxPct?: number;
  memoryAvgMb?: number;
  memoryMaxMb?: number;
  memoryLimitMb?: number;
  readMb?: number;
  writtenMb?: number;
  loadMax?: number;
}

const hourOf = (d: Date) => `${d.toISOString().slice(0, 13)}:00:00Z`;
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

interface Subject {
  subject: string;
  serviceId: string | null;
  container?: string;
}

type Previous = { kind: "container"; c: ContainerCounters } | { kind: "host"; h: HostCounters };

export class ResourceHistory {
  private previous = new Map<string, Previous>();
  private lastSample = 0;

  constructor(
    private readonly handle: DbHandle,
    private readonly deps: {
      containers: ContainerTools;
      host: () => Promise<HostCounters | undefined>;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async settings(): Promise<HistorySettings> {
    return { ...HISTORY_DEFAULTS, ...(await getSetting(this.handle.db, "resource_history")) };
  }

  async update(patch: Partial<HistorySettings>): Promise<HistorySettings> {
    const next = { ...(await this.settings()), ...patch };
    if (!RETENTION_CHOICES.includes(next.retentionDays as (typeof RETENTION_CHOICES)[number])) {
      throw new Error(`Retention must be one of ${RETENTION_CHOICES.join(", ")} days.`);
    }
    await setSetting(this.handle.db, "resource_history", next);
    // Switching off forgets the counters, so switching on again starts clean.
    if (!next.enabled) this.previous.clear();
    if (patch.retentionDays !== undefined) await this.prune(true);
    return next;
  }

  /** Watched containers on this machine, and the machine itself where it can be read. */
  private async subjects(): Promise<Subject[]> {
    const rows = await this.handle.db
      .select({ id: t.services.id, target: t.services.checkTarget })
      .from(t.services)
      .where(and(eq(t.services.kind, "container"), eq(t.services.lifecycle, "active")));
    const containers = rows
      .filter((r) => r.target?.startsWith("container:"))
      .map((r) => {
        const container = r.target!.slice("container:".length);
        return { subject: container, serviceId: r.id, container };
      });
    return [{ subject: "host", serviceId: null }, ...containers];
  }

  async estimate(retentionDays?: number): Promise<HistoryEstimate> {
    const subjects = await this.subjects();
    const days = retentionDays ?? (await this.settings()).retentionDays;
    const rowsPerDay = subjects.length * 24;
    return {
      subjects: subjects.length,
      containers: subjects.length - 1,
      rowsPerDay,
      rows: rowsPerDay * days,
      bytes: rowsPerDay * days * ROW_BYTES,
      samplesPerHour: 60 / SAMPLE_MINUTES,
    };
  }

  async stored(): Promise<{ rows: number; oldest?: string; bytes: number }> {
    const r = await this.handle.db
      .select({
        n: sql<number>`count(*)`,
        oldest: sql<string | null>`min(${t.resourceHourly.hour})`,
      })
      .from(t.resourceHourly)
      .get();
    const rows = Number(r?.n ?? 0);
    return { rows, ...(r?.oldest ? { oldest: r.oldest } : {}), bytes: rows * ROW_BYTES };
  }

  /** Called on every monitoring pass; samples only when on and SAMPLE_MINUTES have passed. */
  async tick(): Promise<void> {
    const now = this.now().getTime();
    if (now - this.lastSample < SAMPLE_MINUTES * 60_000 - 5_000) return;
    if (!(await this.settings()).enabled) return;
    this.lastSample = now;
    await this.sample();
  }

  async sample(): Promise<number> {
    const hour = hourOf(this.now());
    const subjects = await this.subjects();
    let written = 0;
    // A few at a time: each is one quick Docker read.
    for (let i = 0; i < subjects.length; i += 6) {
      const batch = subjects.slice(i, i + 6);
      const read = await Promise.all(
        batch.map(async (s) =>
          s.container
            ? { s, c: await this.deps.containers.counters(s.container).catch(() => undefined) }
            : { s, h: await this.deps.host().catch(() => undefined) },
        ),
      );
      for (const r of read) {
        const point = "c" in r ? this.fromContainer(r.s.subject, r.c) : this.fromHost(r.h);
        if (!point) continue;
        await this.add(r.s, hour, point);
        written++;
      }
    }
    return written;
  }

  private fromContainer(subject: string, c?: ContainerCounters) {
    if (!c) {
      // Stopped or gone: the next start begins fresh counters.
      this.previous.delete(subject);
      return undefined;
    }
    const prev = this.previous.get(subject);
    this.previous.set(subject, { kind: "container", c });
    if (prev?.kind !== "container") return undefined; // the first read only sets the baseline
    const p = prev.c;
    const sys = c.systemTotal - p.systemTotal;
    const used = c.cpuTotal - p.cpuTotal;
    // Counters went backwards: the container restarted between samples.
    const restarted = used < 0;
    const delta = (a?: number, b?: number) =>
      a === undefined || b === undefined ? undefined : a >= b && !restarted ? a - b : a;
    return {
      cpu: sys > 0 && !restarted ? (used / sys) * c.onlineCpus * 100 : undefined,
      memoryMb: c.memoryMb,
      memoryLimitMb: c.memoryLimitMb,
      readBytes: delta(c.readBytes, p.readBytes),
      writeBytes: delta(c.writeBytes, p.writeBytes),
    };
  }

  private fromHost(h?: HostCounters) {
    if (!h) return undefined;
    const prev = this.previous.get("host");
    this.previous.set("host", { kind: "host", h });
    if (prev?.kind !== "host") return undefined;
    const p = prev.h;
    const total = h.cpuTotal - p.cpuTotal;
    const delta = (a: number, b: number) => (a >= b ? a - b : a);
    return {
      cpu: total > 0 ? ((h.cpuBusy - p.cpuBusy) / total) * 100 : undefined,
      memoryMb: h.memoryMb,
      memoryLimitMb: h.memoryTotalMb,
      readBytes: delta(h.readBytes, p.readBytes),
      writeBytes: delta(h.writeBytes, p.writeBytes),
      load: h.load1,
    };
  }

  private async add(
    s: Subject,
    hour: string,
    p: {
      cpu?: number;
      memoryMb?: number;
      memoryLimitMb?: number;
      readBytes?: number;
      writeBytes?: number;
      load?: number;
    },
  ) {
    const r = t.resourceHourly;
    const cpu = p.cpu ?? 0;
    const mem = p.memoryMb ?? 0;
    await this.handle.db
      .insert(r)
      .values({
        subject: s.subject,
        hour,
        samples: 1,
        cpuSum: cpu,
        cpuMax: cpu,
        memSumMb: mem,
        memMaxMb: mem,
        memLimitMb: p.memoryLimitMb ?? null,
        readBytes: p.readBytes ?? null,
        writeBytes: p.writeBytes ?? null,
        loadMax: p.load ?? null,
      })
      .onConflictDoUpdate({
        target: [r.subject, r.hour],
        set: {
          samples: sql`${r.samples} + 1`,
          cpuSum: sql`${r.cpuSum} + ${cpu}`,
          cpuMax: sql`max(${r.cpuMax}, ${cpu})`,
          memSumMb: sql`${r.memSumMb} + ${mem}`,
          memMaxMb: sql`max(${r.memMaxMb}, ${mem})`,
          memLimitMb: p.memoryLimitMb ?? sql`${r.memLimitMb}`,
          readBytes:
            p.readBytes === undefined
              ? sql`${r.readBytes}`
              : sql`coalesce(${r.readBytes}, 0) + ${p.readBytes}`,
          writeBytes:
            p.writeBytes === undefined
              ? sql`${r.writeBytes}`
              : sql`coalesce(${r.writeBytes}, 0) + ${p.writeBytes}`,
          loadMax:
            p.load === undefined
              ? sql`${r.loadMax}`
              : sql`max(coalesce(${r.loadMax}, 0), ${p.load})`,
        },
      });
  }

  /**
   * Deletes resource rows older than the retention and uptime rows older than
   * 90 days. Once a day, unless forced. Never touches incidents, timelines,
   * actions, or the audit trail (separate tables, nothing depends on these rows).
   */
  async prune(force = false): Promise<{ resource: number; availability: number }> {
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    if (!force && (await getSetting(this.handle.db, "history_pruned_on")) === today) {
      return { resource: 0, availability: 0 };
    }
    const { retentionDays } = await this.settings();
    const resourceCut = hourOf(new Date(now.getTime() - retentionDays * 86_400_000));
    const uptimeCut = hourOf(new Date(now.getTime() - AVAILABILITY_KEEP_DAYS * 86_400_000));
    const resource = await this.handle.db
      .delete(t.resourceHourly)
      .where(lt(t.resourceHourly.hour, resourceCut))
      .returning({ s: t.resourceHourly.subject });
    const availability = await this.handle.db
      .delete(t.availabilityHourly)
      .where(lt(t.availabilityHourly.hour, uptimeCut))
      .returning({ s: t.availabilityHourly.serviceId });
    await setSetting(this.handle.db, "history_pruned_on", today);
    return { resource: resource.length, availability: availability.length };
  }

  /** Hourly points for a subject ("host" or a container's service), oldest first. */
  async series(
    which: { serviceId: string } | { host: true },
    hours: number,
  ): Promise<HistoryPoint[]> {
    const since = hourOf(new Date(this.now().getTime() - hours * 3_600_000));
    const r = t.resourceHourly;
    let subject = "host";
    if (!("host" in which)) {
      const svc = await this.handle.db
        .select({ target: t.services.checkTarget })
        .from(t.services)
        .where(eq(t.services.id, which.serviceId))
        .get();
      if (!svc?.target?.startsWith("container:")) return [];
      subject = svc.target.slice("container:".length);
    }
    const rows = await this.handle.db
      .select()
      .from(r)
      .where(and(eq(r.subject, subject), gte(r.hour, since)))
      .orderBy(asc(r.hour));
    return rows.map((x) => ({
      hour: x.hour,
      samples: x.samples,
      cpuAvgPct: round(x.cpuSum / x.samples),
      cpuMaxPct: round(x.cpuMax),
      memoryAvgMb: Math.round(x.memSumMb / x.samples),
      memoryMaxMb: Math.round(x.memMaxMb),
      ...(x.memLimitMb ? { memoryLimitMb: Math.round(x.memLimitMb) } : {}),
      ...(x.readBytes !== null ? { readMb: round(x.readBytes / 1048576) } : {}),
      ...(x.writeBytes !== null ? { writtenMb: round(x.writeBytes / 1048576) } : {}),
      ...(x.loadMax !== null ? { loadMax: round(x.loadMax, 2) } : {}),
    }));
  }
}
