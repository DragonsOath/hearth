import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { ContainerCounters, ContainerTools } from "../actions/tools";
import { countersFromStats } from "../actions/tools";
import { ResourceHistory, ROW_BYTES } from "./history";
import { parseDiskstats, parseMeminfo, parseProcStat, type HostCounters } from "./host-counters";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup(file = ":memory:") {
  const handle = openDatabase(file);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Homeserver",
    role: "server",
    os: "Linux",
    address: "127.0.0.1",
    cpuModel: "x",
    cpuCores: 8,
    cpuUsagePct: 0,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 1,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeenAt: "2026-10-09T00:00:00Z",
  });
  const svc = (id: string, lifecycle: "active" | "retired" = "active") => ({
    id,
    name: id,
    category: "media",
    hostId: "h1",
    kind: "container" as const,
    health: "healthy" as const,
    autonomyArea: "media",
    checkTarget: `container:${id}`,
    lifecycle,
  });
  await handle.db.insert(t.services).values([svc("audiobooks"), svc("old", "retired")]);
  return handle;
}

function harness(handle: DbHandle) {
  let clock = new Date("2026-10-09T10:01:00Z");
  const counters = new Map<string, ContainerCounters | undefined>();
  let host: HostCounters | undefined;
  const containers = {
    counters: async (name: string) => counters.get(name),
  } as unknown as ContainerTools;
  const history = new ResourceHistory(handle, {
    containers,
    host: async () => host,
    now: () => clock,
  });
  return {
    history,
    set: (name: string, c: ContainerCounters | undefined) => counters.set(name, c),
    setHost: (h: HostCounters) => (host = h),
    advance: (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000)),
  };
}

const c = (n: number, extra: Partial<ContainerCounters> = {}): ContainerCounters => ({
  cpuTotal: n * 5e9,
  systemTotal: n * 40e9,
  onlineCpus: 4,
  memoryMb: 200 + n,
  memoryLimitMb: 1024,
  readBytes: n * 1048576,
  writeBytes: n * 2097152,
  ...extra,
});

describe("resource history", () => {
  it("is off until switched on, and estimates its cost first", async () => {
    const handle = await setup();
    const h = harness(handle);
    h.set("audiobooks", c(1));
    await h.history.tick();
    expect((await h.history.stored()).rows).toBe(0);
    const e = await h.history.estimate();
    // The host and the one active container; the retired one is not sampled.
    expect(e).toMatchObject({ subjects: 2, containers: 1, rowsPerDay: 48, rows: 48 * 14 });
    expect(e.bytes).toBe(48 * 14 * ROW_BYTES);
    expect((await h.history.estimate(30)).rows).toBe(48 * 30);
  });

  it("keeps hourly averages and peaks, baselines first, and survives a restart", async () => {
    const handle = await setup();
    const h = harness(handle);
    await h.history.update({ enabled: true });
    h.set("audiobooks", c(1));
    expect(await h.history.sample()).toBe(0); // the first read only sets the baseline
    h.advance(5);
    h.set("audiobooks", c(2));
    await h.history.sample();
    h.advance(5);
    // Busier: 2 cores' worth over the interval.
    h.set("audiobooks", { ...c(3), cpuTotal: 2 * 5e9 + 20e9, memoryMb: 900 });
    await h.history.sample();
    h.advance(5);
    // Restarted: counters start again from zero, no negative CPU or disk.
    h.set("audiobooks", c(0.5));
    await h.history.sample();
    const points = await h.history.series({ serviceId: "audiobooks" }, 24);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      hour: "2026-10-09T10:00:00Z",
      samples: 3,
      cpuMaxPct: 200,
      memoryMaxMb: 900,
      memoryLimitMb: 1024,
    });
    // (50 + 200 + 0) / 3
    expect(points[0]!.cpuAvgPct).toBeCloseTo(83.3, 1);
    expect(points[0]!.readMb).toBeGreaterThan(0);
  });

  it("records the host from /proc", async () => {
    const handle = await setup();
    const h = harness(handle);
    await h.history.update({ enabled: true });
    const host = (busy: number, total: number, load: number): HostCounters => ({
      cpuBusy: busy,
      cpuTotal: total,
      memoryMb: 8000,
      memoryTotalMb: 32000,
      load1: load,
      readBytes: total * 1000,
      writeBytes: total * 2000,
    });
    h.setHost(host(100, 1000, 0.5));
    await h.history.sample();
    h.advance(5);
    h.setHost(host(400, 2000, 3.2));
    await h.history.sample();
    const [p] = await h.history.series({ host: true }, 24);
    expect(p).toMatchObject({ cpuAvgPct: 30, loadMax: 3.2, memoryLimitMb: 32000 });
  });

  it("prunes past the retention, and uptime past 90 days, never incidents", async () => {
    const handle = await setup();
    const h = harness(handle);
    await h.history.update({ enabled: true, retentionDays: 7 });
    const row = (hour: string) => ({
      subject: "audiobooks",
      hour,
      samples: 1,
    });
    await handle.db
      .insert(t.resourceHourly)
      .values([row("2026-09-30T10:00:00Z"), row("2026-10-08T10:00:00Z")]);
    await handle.db.insert(t.availabilityHourly).values([
      { serviceId: "audiobooks", hour: "2026-07-01T10:00:00Z", ok: 1, total: 1 },
      { serviceId: "audiobooks", hour: "2026-08-01T10:00:00Z", ok: 1, total: 1 },
    ]);
    await handle.db.insert(t.incidents).values({
      id: "inc-old",
      title: "Old incident",
      severity: "info",
      status: "resolved",
      openedAt: "2026-06-01T00:00:00Z",
      summary: "Long ago.",
      handledBy: "you",
      serviceId: "audiobooks",
    });
    expect(await h.history.prune(true)).toEqual({ resource: 1, availability: 1 });
    // Once a day unless forced.
    expect(await h.history.prune()).toEqual({ resource: 0, availability: 0 });
    expect(await handle.db.select().from(t.incidents)).toHaveLength(1);
    await expect(h.history.update({ retentionDays: 9 })).rejects.toThrow(/one of 7, 14, 30/);
  });

  it("measures what a row costs on disk", async () => {
    const handle = await setup();
    const rows = Array.from({ length: 49 * 24 * 14 }, (_, i) => ({
      subject: `container-${String(i % 49).padStart(2, "0")}`,
      hour:
        new Date(Date.UTC(2026, 9, 1) + Math.floor(i / 49) * 3_600_000).toISOString().slice(0, 13) +
        ":00:00Z",
      samples: 12,
      cpuSum: 123.4,
      cpuMax: 45.6,
      memSumMb: 3000.5,
      memMaxMb: 260.2,
      memLimitMb: 1024,
      readBytes: 123456789,
      writeBytes: 987654321,
    }));
    const before = handle.sqlite
      .prepare("select page_count * page_size as b from pragma_page_count(), pragma_page_size()")
      .get() as { b: number };
    for (let i = 0; i < rows.length; i += 500)
      await handle.db.insert(t.resourceHourly).values(rows.slice(i, i + 500));
    const after = handle.sqlite
      .prepare("select page_count * page_size as b from pragma_page_count(), pragma_page_size()")
      .get() as { b: number };
    const perRow = (after.b - before.b) / rows.length;
    // ROW_BYTES must not understate the real cost.
    expect(perRow).toBeLessThanOrEqual(ROW_BYTES);
    expect(perRow).toBeGreaterThan(ROW_BYTES * 0.6);
  });
});

describe("counters", () => {
  it("reads Docker's one-shot stats, cgroup v1 and v2 disk counters alike", () => {
    expect(
      countersFromStats({
        cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100, online_cpus: 2 },
        memory_stats: {
          usage: 300 * 1048576,
          limit: 1024 * 1048576,
          stats: { inactive_file: 100 * 1048576 },
        },
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: "read", value: 5 },
            { op: "Read", value: 5 },
            { op: "write", value: 7 },
          ],
        },
      }),
    ).toEqual({
      cpuTotal: 10,
      systemTotal: 100,
      onlineCpus: 2,
      memoryMb: 200,
      memoryLimitMb: 1024,
      readBytes: 10,
      writeBytes: 7,
    });
  });

  it("parses /proc", () => {
    expect(parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3")).toEqual({
      busy: 150,
      total: 1000,
    });
    expect(
      parseMeminfo("MemTotal:       32768000 kB\nMemFree: 1 kB\nMemAvailable:   24576000 kB\n"),
    ).toEqual({
      usedMb: 8000,
      totalMb: 32000,
    });
    const disks = [
      "   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0",
      "   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0",
      " 259       0 nvme0n1 1 0 10 0 1 0 20 0 0 0 0",
      "   7       0 loop0 1 0 999 0 1 0 999 0 0 0 0",
    ].join("\n");
    expect(parseDiskstats(disks)).toEqual({ readBytes: 2010 * 512, writeBytes: 4020 * 512 });
  });
});
