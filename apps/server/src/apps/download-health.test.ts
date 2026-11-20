import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AppDashboard,
  ArrDashboard,
  QbittorrentDashboard,
  SabnzbdDashboard,
  Torrent,
} from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import * as t from "../db/schema";
import { autoRecover, DownloadHealth, type HealthRecord } from "./download-health";
import { DEFAULT_HEALTH_SETTINGS, type DownloadHealthItem } from "@dragon-control/core";

// Download Health, monitoring: only downloads an app tracks are judged, strikes build over checks,
// Usenet failures and stuck imports need attention at once, an unreachable client is one cause.

const HASH = "a".repeat(40);
const MANUAL = "b".repeat(40);
const torrent = (hash: string, status: Torrent["status"], downloadedBytes: number): Torrent => ({
  hash,
  name: hash === HASH ? "Show.S01E01" : "Manual.Thing",
  status,
  state: status === "stalled" ? "stalledDL" : "downloading",
  progressPct: 40,
  sizeBytes: 1000,
  downloadedBytes,
  leftBytes: 600,
  downSpeed: 0,
  upSpeed: 0,
  seedsConnected: 0,
  leechersConnected: 0,
  seedsInSwarm: 0,
  leechersInSwarm: 0,
  ratio: 0,
});

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Home Server",
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
    lastSeenAt: "2026-11-07T00:00:00Z",
  });
  for (const [id, name, image, port] of [
    ["qbt", "qBittorrent", "lscr.io/linuxserver/qbittorrent", 8090],
    ["sab", "SABnzbd", "lscr.io/linuxserver/sabnzbd", 8080],
    ["sonarr", "Sonarr", "lscr.io/linuxserver/sonarr", 8989],
  ] as const)
    await handle.db.insert(t.services).values({
      id,
      name,
      category: "media",
      hostId: "h1",
      kind: "container",
      image,
      localUrl: `http://10.0.0.5:${port}`,
      health: "healthy",
      autonomyArea: "media",
    });
  let clock = Date.parse("2026-11-07T10:00:00Z");
  let bytes = 100;
  let qbtDown = false;
  const at = () => new Date(clock).toISOString();
  const dash = async (id: string): Promise<AppDashboard> => {
    if (id === "qbt") {
      if (qbtDown)
        return { serviceId: id, at: at(), error: { kind: "unreachable", message: "no answer" } };
      const data: QbittorrentDashboard = {
        app: "qbittorrent",
        connection: "connected",
        downSpeed: 0,
        upSpeed: 0,
        torrents: [torrent(HASH, "stalled", bytes), torrent(MANUAL, "stalled", 5)],
      };
      return { serviceId: id, at: at(), data };
    }
    if (id === "sab") {
      const data: SabnzbdDashboard = {
        app: "sabnzbd",
        paused: false,
        status: "Idle",
        speedKbps: 0,
        queue: [],
        history: [
          {
            id: "SABnzbd_nzo_1",
            name: "Show.S01E02",
            failed: true,
            status: "Failed",
            why: "Aborted, cannot be completed",
          },
        ],
        warnings: [],
      };
      return { serviceId: id, at: at(), data };
    }
    const data = {
      app: "sonarr",
      totals: { titles: 1, monitored: 1, missing: 0, queue: 3, stuckImports: 1 },
      queue: [
        {
          queueId: 1,
          downloadId: HASH.toUpperCase(),
          title: "Show S01E01",
          status: "warning",
          stuckImport: false,
        },
        {
          queueId: 2,
          downloadId: "SABnzbd_nzo_1",
          title: "Show S01E02",
          status: "failed",
          stuckImport: false,
          failed: true,
        },
        {
          queueId: 3,
          downloadId: "c".repeat(40),
          title: "Show S01E03",
          status: "completed",
          stuckImport: true,
          problem: "Episode 1x03 was not found in the grabbed release",
        },
      ],
      missing: [],
      upcoming: [],
      recent: [],
      health: [],
    } as ArrDashboard;
    return { serviceId: id, at: at(), data };
  };
  const health = new DownloadHealth(handle, dash, () => clock);
  return {
    health,
    advance: (min: number) => (clock += min * 60_000),
    progress: () => (bytes += 50),
    setDown: (v: boolean) => (qbtDown = v),
  };
}

describe("download health monitoring", () => {
  it("judges only tracked downloads, builds strikes, and explains failures at once", async () => {
    const s = await setup();
    let o = await s.health.check();
    const keys = o.items.map((i) => i.key);
    expect(keys).toContain(`qbt:${HASH}`);
    expect(keys.some((k) => k.includes(MANUAL))).toBe(false);
    const stalled = o.items.find((i) => i.key === `qbt:${HASH}`)!;
    expect(stalled).toMatchObject({
      state: "watching",
      strikes: 1,
      app: "Sonarr",
      title: "Show S01E01",
    });
    const usenet = o.items.find((i) => i.problem === "usenet-failed")!;
    expect(usenet).toMatchObject({ state: "attention", title: "Show S01E02" });
    expect(usenet.explain).toContain("Usenet provider");
    const stuck = o.items.find((i) => i.problem === "import-failed")!;
    expect(stuck.explain).toContain("manual import");
    // The failed Usenet job is one problem, not also a separate failed queue item.
    expect(o.items.filter((i) => i.title === "Show S01E02")).toHaveLength(1);

    s.advance(30);
    await s.health.check();
    s.advance(31);
    o = await s.health.check();
    expect(o.items.find((i) => i.key === `qbt:${HASH}`)).toMatchObject({
      state: "attention",
      strikes: 3,
    });
    const view = await s.health.overview();
    expect(view.history.some((h) => h.event === "attention" && h.title === "Show S01E01")).toBe(
      true,
    );

    // Progress clears it; the history says so.
    s.progress();
    s.advance(5);
    o = await s.health.check();
    expect(o.items.find((i) => i.key === `qbt:${HASH}`)).toBeUndefined();
    expect((await s.health.overview()).history[0]).toMatchObject({
      event: "cleared",
      title: "Show S01E01",
    });
  });

  it("an unreachable client is one cause, and its downloads get no strikes", async () => {
    const s = await setup();
    await s.health.check();
    s.setDown(true);
    s.advance(30);
    const o = await s.health.check();
    expect(o.clients.find((c) => c.serviceId === "qbt")).toMatchObject({ reachable: false });
    expect(o.causes[0]!.text).toContain("can't reach qBittorrent");
    expect(o.items.find((i) => i.key === `qbt:${HASH}`)).toBeUndefined();
  });
});

describe("Automatic Recovery (11-13): the owner's switch is the standing approval", () => {
  const item = (over: Partial<DownloadHealthItem> = {}): DownloadHealthItem => ({
    key: "qbt:x",
    title: "Glass Meridian",
    client: "qBittorrent",
    clientServiceId: "qbt",
    app: "Radarr",
    appServiceId: "radarr",
    problem: "stalled",
    state: "attention",
    strikes: 3,
    explain: "No one is sharing it.",
    since: "2026-11-13T00:00:00Z",
    fix: { serviceId: "radarr", queueId: 9002 },
    ...over,
  });
  const run = async (auto: boolean, items: DownloadHealthItem[], tried = new Set<string>()) => {
    const made: unknown[] = [];
    const approved: string[] = [];
    const log: HealthRecord[] = [];
    const n = await autoRecover(
      {
        downloading: 1,
        watching: 0,
        attention: items.length,
        clients: [],
        causes: [],
        items,
        settings: { ...DEFAULT_HEALTH_SETTINGS, auto },
      },
      {
        tried,
        create: async (job) => {
          made.push(job);
          return { id: "j1", status: "awaiting-approval", approval: { fingerprint: "fp" } };
        },
        approve: async (id, fp) => {
          approved.push(`${id}:${fp}`);
          return { status: "succeeded" };
        },
        log: async (r) => void log.push(r),
      },
    );
    return { n, made, approved, log };
  };

  it("does nothing while the switch is off", async () => {
    const r = await run(false, [item()]);
    expect(r.made).toEqual([]);
  });

  it("on: makes Fix it's plan, approves it, and says so once", async () => {
    const tried = new Set<string>();
    const r = await run(true, [item()], tried);
    expect(r.n).toBe(1);
    expect(r.made).toEqual([
      expect.objectContaining({
        steps: [
          {
            kind: "app-arr-queue-remove",
            serviceId: "radarr",
            params: { queueId: 9002, recover: true },
          },
        ],
        requestedBy: "dragon-control",
      }),
    ]);
    expect(r.approved).toEqual(["j1:fp"]);
    expect(r.log[0]).toMatchObject({ event: "fixed", title: "Glass Meridian" });
    // The next check: not again for the same download.
    expect((await run(true, [item()], tried)).made).toEqual([]);
  });

  it("leaves alone what Fix it doesn't cover: a failed import, a shared cause, no app queue item", async () => {
    const r = await run(true, [
      item({ key: "a", problem: "import-failed" }),
      item({ key: "b", sharedCause: "The VPN is down" }),
      item({ key: "c", fix: undefined }),
      item({ key: "d", state: "watching" }),
    ]);
    expect(r.made).toEqual([]);
  });
});
