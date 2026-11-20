import { describe, expect, it } from "vitest";
import type {
  ArrDashboard,
  ArrHistoryEvent,
  QbittorrentDashboard,
  SabnzbdDashboard,
  Torrent,
} from "@dragon-control/core";
import { buildJourneys, markMedia } from "./journeys";

/** File journeys, from captured shapes of Radarr's history and queue, qBittorrent, and SABnzbd. */

const NOW = Date.parse("2026-10-21T12:00:00Z");

const torrent = (over: Partial<Torrent>): Torrent =>
  ({
    hash: "abc",
    name: "Masterplan.2026.1080p.WEBDL",
    status: "seeding",
    state: "uploading",
    progressPct: 100,
    sizeBytes: 7_815_850_055,
    downloadedBytes: 7_815_850_055,
    leftBytes: 0,
    downSpeed: 0,
    upSpeed: 0,
    seedsConnected: 0,
    leechersConnected: 0,
    seedsInSwarm: 0,
    leechersInSwarm: 0,
    ratio: 1.3,
    ...over,
  }) as Torrent;

const radarr = (
  history: ArrHistoryEvent[],
  queue: ArrDashboard["queue"] = [],
): { serviceId: string; name: string; data: ArrDashboard } => ({
  serviceId: "radarr",
  name: "Radarr",
  data: {
    app: "radarr",
    totals: { titles: 1, monitored: 1, missing: 0, queue: queue.length, stuckImports: 0 },
    queue,
    missing: [],
    upcoming: [],
    recent: [],
    health: [],
    history,
  },
});
const qbit = (torrents: Torrent[]) => ({
  serviceId: "qb",
  name: "qBittorrent",
  data: {
    app: "qbittorrent",
    connection: "connected",
    downSpeed: 0,
    upSpeed: 0,
    torrents,
  } as QbittorrentDashboard,
});
const sab = (history: SabnzbdDashboard["history"]) => ({
  serviceId: "sab",
  name: "SABnzbd",
  data: {
    app: "sabnzbd",
    paused: false,
    status: "Idle",
    speedKbps: 0,
    queue: [],
    history,
  } as unknown as SabnzbdDashboard,
});

describe("buildJourneys", () => {
  it("follows a movie from the grab through the download and import to the library, still seeding", () => {
    const [j] = buildJourneys({
      managers: [
        radarr([
          {
            at: "2026-10-21T09:00:00Z",
            event: "grabbed",
            title: "Masterplan (2026)",
            release: "Masterplan.2026.1080p.WEBDL",
            downloadId: "ABC",
            indexer: "Torznab",
          },
          {
            at: "2026-10-21T10:30:00Z",
            event: "imported",
            title: "Masterplan (2026)",
            downloadId: "ABC",
            droppedPath: "/downloads/Masterplan.2026.1080p.WEBDL/Masterplan.mkv",
            importedPath: "/new releases/2026/Masterplan/Masterplan (2026).WEBDL-1080p.mkv",
          },
        ]),
      ],
      qbittorrent: [qbit([torrent({ completedAt: "2026-10-21T10:20:00Z" })])],
      sabnzbd: [],
      now: NOW,
    });
    expect(j).toMatchObject({
      title: "Masterplan (2026)",
      outcome: "imported",
      attention: false,
      seeding: true,
      source: { path: "/downloads/Masterplan.2026.1080p.WEBDL/Masterplan.mkv", source: "Radarr" },
      destination: { path: "/new releases/2026/Masterplan/Masterplan (2026).WEBDL-1080p.mkv" },
      stoppedAt: "In Plex",
    });
    expect(j!.steps.map((s) => [s.key, s.state, s.evidence])).toEqual([
      ["grabbed", "done", "confirmed"],
      ["download", "done", "confirmed"],
      ["import", "done", "confirmed"],
      ["library", "done", "confirmed"],
      ["media", "unknown", "none"],
    ]);
    expect(j!.steps[1]!.detail).toMatch(/still seeding/);
  });

  it("a finished download Radarr has not imported waits in /downloads with Radarr's reason", () => {
    const [j] = buildJourneys({
      managers: [
        radarr(
          [
            {
              at: "2026-10-21T11:00:00Z",
              event: "grabbed",
              title: "Dune (2024)",
              downloadId: "D1",
            },
          ],
          [
            {
              queueId: 9,
              downloadId: "D1",
              title: "Dune (2024)",
              status: "completed",
              state: "importPending",
              problem: "No files found are eligible for import",
              outputPath: "/downloads/Dune.2024",
              stuckImport: true,
            },
          ],
        ),
      ],
      qbittorrent: [qbit([torrent({ hash: "d1", completedAt: "2026-10-21T11:30:00Z" })])],
      sabnzbd: [],
      now: NOW,
    });
    expect(j).toMatchObject({
      outcome: "waiting",
      attention: true,
      stoppedAt: "Awaiting import",
      queueId: 9,
      problem: "No files found are eligible for import",
      source: { path: "/downloads/Dune.2024" },
    });
    expect(j!.destination).toBeUndefined();
  });

  it("an import that failed says why, in the app's words", () => {
    const [j] = buildJourneys({
      managers: [
        radarr([
          { at: "2026-10-21T08:00:00Z", event: "grabbed", title: "Heat (1995)", downloadId: "H" },
          {
            at: "2026-10-21T08:40:00Z",
            event: "failed",
            title: "Heat (1995)",
            downloadId: "H",
            message: "Import failed: path not accessible",
          },
        ]),
      ],
      qbittorrent: [],
      sabnzbd: [],
      now: NOW,
    });
    expect(j).toMatchObject({ outcome: "failed", attention: true, stoppedAt: "Import failed" });
    expect(j!.problem).toMatch(/path not accessible/);
  });

  it("a failure a later download got past no longer needs a look", () => {
    const js = buildJourneys({
      managers: [
        radarr([
          { at: "2026-10-20T08:00:00Z", event: "grabbed", title: "Heat (1995)", downloadId: "H1" },
          {
            at: "2026-10-20T08:40:00Z",
            event: "failed",
            title: "Heat (1995)",
            downloadId: "H1",
            message: "Import failed: sample only",
          },
          { at: "2026-10-20T09:00:00Z", event: "grabbed", title: "Heat (1995)", downloadId: "H2" },
          {
            at: "2026-10-20T10:00:00Z",
            event: "imported",
            title: "Heat (1995)",
            downloadId: "H2",
            importedPath: "/movies/Heat (1995)/Heat.mkv",
          },
        ]),
      ],
      qbittorrent: [],
      sabnzbd: [],
      now: NOW,
    });
    const old = js.find((j) => j.key === "radarr:h1")!;
    expect(old).toMatchObject({ outcome: "failed", attention: false });
    expect(old.stoppedAt).toMatch(/later download was imported/);
    expect(old.replacedBy?.key).toBe("radarr:h2");
  });

  it("a finished torrent no manager tracks is never called failed; a SABnzbd failure is", () => {
    const js = buildJourneys({
      managers: [radarr([])],
      qbittorrent: [qbit([torrent({ hash: "zz", completedAt: "2026-10-21T07:00:00Z" })])],
      sabnzbd: [
        sab([
          {
            id: "nzo1",
            name: "Some.Show.S01E01",
            failed: true,
            status: "Failed",
            why: "CRC error",
          },
        ]),
      ],
      now: NOW,
    });
    const tor = js.find((x) => x.key === "qb:zz")!;
    expect(tor).toMatchObject({ outcome: "downloaded", attention: false, seeding: true });
    expect(tor.steps.find((s) => s.key === "import")).toMatchObject({
      state: "unknown",
      evidence: "inferred",
    });
    expect(js.find((x) => x.key === "sab:nzo1")).toMatchObject({
      outcome: "failed",
      problem: "CRC error",
    });
    // What needs you comes first.
    expect(js[0]!.key).toBe("sab:nzo1");
  });
});

describe("markMedia", () => {
  const imported = () =>
    buildJourneys({
      managers: [
        radarr([
          {
            at: new Date(NOW - 2 * 3_600_000).toISOString(),
            event: "imported",
            title: "Masterplan (2026)",
            downloadId: "ABC",
            importedPath: "/new releases/Masterplan.mkv",
          },
        ]),
      ],
      qbittorrent: [],
      sabnzbd: [],
      now: NOW,
    });

  it("confirms Plex when it lists the exact file", () => {
    const js = imported();
    js[0]!.destination!.hostPath = "/mnt/f/New Releases/Masterplan.mkv";
    markMedia(
      js,
      {
        name: "Plex",
        connected: true,
        files: new Map([["/mnt/f/New Releases/Masterplan.mkv", "2026-10-21T10:40:00Z"]]),
      },
      NOW,
    );
    expect(js[0]).toMatchObject({ outcome: "in plex" });
    expect(js[0]!.steps.at(-1)).toMatchObject({
      state: "done",
      evidence: "confirmed",
      source: "Plex",
    });
  });

  it("says plainly when Plex does not list it, or is not connected", () => {
    const js = imported();
    js[0]!.destination!.hostPath = "/mnt/f/New Releases/Masterplan.mkv";
    markMedia(js, { name: "Plex", connected: true, files: new Map() }, NOW);
    expect(js[0]!.steps.at(-1)).toMatchObject({ state: "unknown" });
    expect(js[0]!.steps.at(-1)!.detail).toMatch(/50 most recently added/);
    const none = imported();
    markMedia(none, undefined, NOW);
    expect(none[0]!.steps.at(-1)).toMatchObject({ state: "skipped" });
  });
});
