import { describe, expect, it } from "vitest";
import type { Fetch } from "./http";
import { readArrV1, readBazarr, readSeerr, readSyncthing, readTautulli } from "./more-apps";

/** A stand-in app: answers by path (query string ignored unless the key includes it). */
function fakeApp(routes: Record<string, unknown>, seen: string[] = []): Fetch {
  return async (url, init) => {
    const u = new URL(url);
    seen.push(`${u.pathname}${u.search}|${JSON.stringify(init.headers)}`);
    const cmd = u.searchParams.get("cmd");
    const key = cmd ? `${u.pathname}?cmd=${cmd.split("&")[0]}` : u.pathname;
    const data = routes[key];
    return {
      ok: data !== undefined,
      status: data === undefined ? 404 : 200,
      json: async () => data,
    };
  };
}

describe("more app readers (batch 1)", () => {
  it("Lidarr: missing, queue with the stuck reason, history, clients", async () => {
    const r = await readArrV1(
      "lidarr",
      "http://lidarr",
      "KEY",
      fakeApp({
        "/api/v1/system/status": { version: "2.9.6" },
        "/api/v1/health": [
          { type: "warning", message: "Indexer unavailable", source: "IndexerCheck" },
        ],
        "/api/v1/queue": {
          totalRecords: 1,
          records: [
            {
              title: "Album.FLAC",
              size: 100,
              sizeleft: 25,
              trackedDownloadState: "importPending",
              trackedDownloadStatus: "warning",
              statusMessages: [{ messages: ["No files found are eligible for import"] }],
              artist: { artistName: "Daft Punk" },
              album: { title: "Discovery" },
              downloadClient: "qBittorrent",
            },
          ],
        },
        "/api/v1/wanted/missing": { totalRecords: 42 },
        "/api/v1/history": {
          records: [
            { date: "2026-10-12T10:00:00Z", eventType: "downloadFailed", sourceTitle: "X" },
          ],
        },
        "/api/v1/downloadclient": [{ name: "qBittorrent", enable: true }],
      }),
    );
    expect(r.status).toBe("attention");
    expect(r.facts).toContainEqual({ label: "Missing (monitored)", value: "42" });
    expect(r.queue![0]).toMatchObject({
      title: "Daft Punk - Discovery",
      progressPct: 75,
      problem: "No files found are eligible for import",
    });
    expect(r.activity![0]).toMatchObject({ text: "download failed: X", tone: "error" });
  });

  it("Bazarr: missing subtitles, paused providers, running tasks", async () => {
    const r = await readBazarr(
      "http://bazarr",
      "KEY",
      fakeApp({
        "/api/system/status": { data: { bazarr_version: "1.5.2" } },
        "/api/system/health": { data: [] },
        "/api/badges": {
          episodes: 12,
          movies: 3,
          providers: 1,
          sonarr_signalr: "LIVE",
          radarr_signalr: "Disconnected",
        },
        "/api/providers": {
          data: [{ name: "opensubtitlescom", status: "Throttled", retry: "in 2 hours" }],
        },
        "/api/system/tasks": {
          data: [{ name: "Search for missing subtitles", job_running: true }],
        },
        "/api/episodes/history": { data: [] },
        "/api/movies/history": { data: [] },
      }),
    );
    expect(r.facts).toContainEqual({ label: "Episodes missing subtitles", value: "12" });
    expect(r.issues[0]!.text).toMatch(/opensubtitlescom \(Throttled, retry in 2 hours\)/);
    expect(r.connections).toContainEqual(expect.objectContaining({ name: "Radarr", ok: false }));
    expect(r.queue![0]).toMatchObject({ title: "Search for missing subtitles", status: "Running" });
  });

  it("Tautulli: streams, transcoding, top this week; its key never appears in an error", async () => {
    const T = (data: unknown) => ({ response: { result: "success", data } });
    const r = await readTautulli(
      "http://tautulli",
      "SECRETKEY",
      fakeApp({
        "/api/v2?cmd=get_tautulli_info": T({ tautulli_version: "v2.15.0" }),
        "/api/v2?cmd=get_activity": T({
          stream_count: "2",
          stream_count_transcode: 1,
          total_bandwidth: 18400,
          sessions: [
            {
              friendly_name: "the owner",
              full_title: "Silo - S02E01",
              transcode_decision: "transcode",
              progress_percent: "40",
              state: "playing",
              player: "Living Room TV",
            },
          ],
        }),
        "/api/v2?cmd=server_status": T({ connected: true }),
        "/api/v2?cmd=get_history": T({
          data: [
            { date: 1791800000, friendly_name: "the owner", full_title: "Dune", watched_status: 1 },
          ],
        }),
        "/api/v2?cmd=get_home_stats": T([
          { stat_id: "top_users", rows: [{ friendly_name: "the owner", total_plays: 12 }] },
        ]),
      }),
    );
    expect(r.version).toBe("2.15.0");
    expect(r.facts).toContainEqual({ label: "Streams now", value: "2 (1 transcoding)" });
    expect(r.queue![0]).toMatchObject({
      title: "the owner: Silo - S02E01",
      progressPct: 40,
      via: "Living Room TV",
    });
    const failing: Fetch = async () => {
      throw new Error("connect ECONNREFUSED http://tautulli/api/v2?apikey=SECRETKEY");
    };
    await expect(readTautulli("http://tautulli", "SECRETKEY", failing)).rejects.toThrow(
      /\[hidden\]/,
    );
  });

  it("Seerr: pending requests with titles and who asked", async () => {
    const r = await readSeerr(
      "http://seerr",
      "KEY",
      fakeApp({
        "/api/v1/status": { version: "2.7.3" },
        "/api/v1/request/count": { pending: 1, processing: 2, available: 40 },
        "/api/v1/issue/count": { open: 1 },
        "/api/v1/request": {
          results: [
            {
              id: 1,
              status: 1,
              type: "movie",
              media: { tmdbId: 693134 },
              requestedBy: { displayName: "Mom" },
            },
          ],
        },
        "/api/v1/movie/693134": { title: "Dune: Part Two", releaseDate: "2024-02-27" },
      }),
    );
    expect(r.facts).toContainEqual({ label: "Waiting for approval", value: "1" });
    expect(r.queue![0]).toMatchObject({ title: "Dune: Part Two (2024)", via: "requested by Mom" });
  });

  it("Syncthing: folders, devices online, errors", async () => {
    const r = await readSyncthing(
      "http://syncthing",
      "KEY",
      fakeApp({
        "/rest/system/version": { version: "v1.29.2" },
        "/rest/config/folders": [{ id: "photos", label: "Photos" }],
        "/rest/config/devices": [
          { deviceID: "SELF" },
          { deviceID: "PHONE", name: "the owner's phone" },
        ],
        "/rest/system/connections": { connections: { PHONE: { connected: false } } },
        "/rest/system/error": { errors: null },
        "/rest/db/status": {
          state: "syncing",
          needBytes: 1073741824,
          globalBytes: 4294967296,
          errors: 2,
        },
      }),
    );
    expect(r.facts).toContainEqual({ label: "Devices online", value: "0 of 1" });
    expect(r.issues[0]!.text).toMatch(/Photos.*2 file errors/);
    expect(r.queue![0]).toMatchObject({ title: "Photos", progressPct: 75 });
  });
});
