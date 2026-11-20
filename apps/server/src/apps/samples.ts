import { FAKE_PHOTOS } from "./fake-immich";
import { downloadTrails } from "./arr-trail";
import { chaptarrCollection } from "./arr-v1-live";
import { radarrLibrary, type RawMovie } from "./radarr-library";
import { createHash } from "node:crypto";
import type { PlexDashboard, QbittorrentDashboard, TorrentDetail } from "@dragon-control/core";
import { toTorrent } from "./qbittorrent-live";

/**
 * Sample data for the demo environment: a believable qBittorrent, labelled as
 * sample data wherever it is shown. The downloading torrent advances with the
 * clock (60% to 100% every ten minutes) so progress bars visibly move.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const hashOf = (name: string) => createHash("sha1").update(name).digest("hex");
const ago = (days: number) => Math.floor(Date.now() / 1000 - days * 86400);

export function sampleQbittorrent(now = Date.now()): Omit<QbittorrentDashboard, "vpn"> {
  const cycle = (now / 1000) % 600;
  const ghost = 0.6 + (cycle / 600) * 0.4;
  const ghostSize = 2.1 * GB;
  const raw: [string, Parameters<typeof toTorrent>[1]][] = [
    [
      "Ghost.S05E02.1080p.WEB.h264",
      {
        state: ghost >= 1 ? "uploading" : "downloading",
        ...(ghost >= 1 ? { seeding_time: 60 } : {}),
        progress: Math.min(1, ghost),
        size: ghostSize,
        amount_left: Math.max(0, ghostSize * (1 - ghost)),
        dlspeed: 4.2 * MB,
        upspeed: 180 * 1024,
        eta: Math.round((ghostSize * (1 - ghost)) / (4.2 * MB)),
        num_seeds: 14,
        num_leechs: 3,
        num_complete: 212,
        num_incomplete: 31,
        ratio: 0.08,
        tracker: "https://tracker.example.org:443/a1b2c3d4e5/announce",
        category: "tv-sonarr",
        added_on: ago(0.02),
        availability: 14.6,
      },
    ],
    [
      "The.Orville.S02E04.1080p.WEB.x264",
      {
        state: "stalledDL",
        progress: 0.34,
        size: 1.6 * GB,
        amount_left: 1.6 * GB * 0.66,
        dlspeed: 0,
        upspeed: 0,
        eta: 8640000,
        num_seeds: 0,
        num_leechs: 0,
        num_complete: 0,
        num_incomplete: 2,
        ratio: 0,
        tracker: "udp://open.tracker.example:1337/announce",
        category: "tv-sonarr",
        added_on: ago(3),
        seen_complete: ago(12),
        availability: 0.34,
      },
    ],
    [
      "Linux.Mint.22.Cinnamon.x64.iso",
      {
        state: "uploading",
        seeding_time: Math.round(1.3 * 86400),
        progress: 1,
        size: 2.9 * GB,
        amount_left: 0,
        dlspeed: 0,
        upspeed: 350 * 1024,
        num_seeds: 0,
        num_leechs: 4,
        num_complete: 980,
        num_incomplete: 12,
        ratio: 1.84,
        tracker: "https://torrents.linuxmint.example/announce",
        added_on: ago(9),
        completion_on: ago(9),
      },
    ],
    [
      "Foundation.S03E05.2160p.WEB",
      {
        state: "queuedDL",
        progress: 0,
        size: 7.4 * GB,
        amount_left: 7.4 * GB,
        num_complete: 88,
        num_incomplete: 40,
        priority: 1,
        category: "tv-sonarr",
        added_on: ago(0.1),
      },
    ],
    [
      "Dune.Part.Two.2160p.UHD.BluRay",
      {
        state: "stoppedDL",
        progress: 0.12,
        size: 61 * GB,
        amount_left: 61 * GB * 0.88,
        num_complete: 40,
        num_incomplete: 9,
        category: "movies-radarr",
        added_on: ago(5),
      },
    ],
    [
      "Andor.S02.COMPLETE.1080p",
      {
        state: "stoppedUP",
        seeding_time: Math.round(3.2 * 86400),
        progress: 1,
        size: 18.2 * GB,
        amount_left: 0,
        ratio: 1.02,
        category: "tv-sonarr",
        added_on: ago(20),
        completion_on: ago(19),
      },
    ],
    [
      "Old.Documentary.1998.DVDRip",
      {
        state: "missingFiles",
        progress: 0.91,
        size: 1.4 * GB,
        amount_left: 1.4 * GB * 0.09,
        category: "movies-radarr",
        added_on: ago(40),
      },
    ],
    [
      "magnet: Severance S02E10",
      { state: "metaDL", progress: 0, size: 0, num_seeds: 0, num_leechs: 0, added_on: ago(0.01) },
    ],
  ];
  // Where each came from (11-11), as the grabbing app's history would say.
  const sources: Record<string, { indexer: string; via: string }> = {
    "Ghost.S05E02.1080p.WEB.h264": { indexer: "TrackerOne", via: "Sonarr" },
    "The.Orville.S02E04.1080p.WEB.x264": { indexer: "TrackerTwo", via: "Sonarr" },
    "Foundation.S03E05.2160p.WEB": { indexer: "PublicTracker", via: "Sonarr" },
    "Dune.Part.Two.2160p.UHD.BluRay": { indexer: "PublicThree", via: "Radarr" },
    "Andor.S02.COMPLETE.1080p": { indexer: "The Pirate Bay", via: "Prowlarr" },
  };
  const torrents = raw.map(([name, r]) => {
    const t = toTorrent(hashOf(name), { ...r, name });
    return sources[name] ? { ...t, source: sources[name] } : t;
  });
  return {
    app: "qbittorrent",
    version: "5.2.4 (sample data)",
    connection: "connected",
    downSpeed: torrents.reduce((n, t) => n + t.downSpeed, 0),
    upSpeed: torrents.reduce((n, t) => n + t.upSpeed, 0),
    dhtNodes: 412,
    freeSpaceBytes: 1.8 * 1024 * GB,
    torrents,
  };
}

export function sampleTorrentDetail(
  hash: string,
  more: { files?: boolean; peers?: boolean } = {},
): TorrentDetail {
  const t = sampleQbittorrent().torrents.find((x) => x.hash === hash);
  const stalled = t?.status === "stalled";
  const size = t?.sizeBytes ?? 1_000_000_000;
  const pct = t?.progressPct ?? 0;
  return {
    ...(more.files
      ? {
          files: [
            {
              index: 0,
              name: `${t?.name ?? "Sample"}/${t?.name ?? "sample"}.mkv`,
              sizeBytes: Math.round(size * 0.97),
              progressPct: pct,
              priority: 1 as const,
            },
            {
              index: 1,
              name: `${t?.name ?? "Sample"}/Sample/sample.mkv`,
              sizeBytes: Math.round(size * 0.02),
              progressPct: 0,
              priority: 0 as const,
            },
            {
              index: 2,
              name: `${t?.name ?? "Sample"}/info.nfo`,
              sizeBytes: 4096,
              progressPct: 100,
              priority: 1 as const,
            },
          ],
        }
      : {}),
    ...(more.peers
      ? {
          peerList: stalled
            ? []
            : [
                {
                  address: "203.0.113.24:51413",
                  client: "qBittorrent 5.1.0",
                  country: "Netherlands",
                  progressPct: 100,
                  downSpeed: t?.downSpeed ?? 0,
                  upSpeed: 0,
                  flags: "D (interested and downloading)",
                },
                {
                  address: "198.51.100.7:6881",
                  client: "Transmission 4.0.6",
                  country: "Canada",
                  progressPct: 61.2,
                  downSpeed: 0,
                  upSpeed: t?.upSpeed ?? 0,
                  flags: "U (interested and uploading)",
                },
              ],
        }
      : {}),
    transfer: {
      downloadedBytes: t?.downloadedBytes ?? 0,
      uploadedBytes: Math.round((t?.downloadedBytes ?? 0) * (t?.ratio ?? 0)),
      ratio: t?.ratio ?? 0,
      downLimit: 0,
      upLimit: 0,
      ...(t?.addedAt ? { addedAt: t.addedAt } : {}),
      ...(t?.completedAt ? { completedAt: t.completedAt } : {}),
    },
    hash,
    trackers: [
      {
        host: t?.tracker ?? "tracker.example.org",
        status: stalled ? "not working" : "working",
        ...(stalled
          ? { message: "Connection timed out (sample data)" }
          : { seeds: t?.seedsInSwarm, leechers: t?.leechersInSwarm }),
      },
      { host: "DHT", status: "working", seeds: stalled ? 0 : 9, leechers: stalled ? 1 : 4 },
      { host: "PeX", status: "working", seeds: 0, leechers: 0 },
    ],
    savePath: "/downloads/complete",
    activeSec: 3600,
    seedingSec: t?.status === "seeding" ? 86400 : 0,
    piecesHave: Math.round((t?.progressPct ?? 0) * 10),
    piecesTotal: 1000,
    peers: {
      connected: (t?.seedsConnected ?? 0) + (t?.leechersConnected ?? 0),
      seeds: t?.seedsConnected ?? 0,
      leechers: t?.leechersConnected ?? 0,
    },
  };
}

/** Sample Plex: two libraries, two people watching (one transcoding too slowly), a scan running. */
export function samplePlex(now = Date.now()): PlexDashboard {
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
  const movieMs = 2 * 3600_000 + 46 * 60_000;
  const moved = ((now / 1000) % 600) * 1000;
  return {
    app: "plex",
    version: "1.43.4 (sample data)",
    serverName: "Media Server (sample data)",
    totals: { movies: 1284, shows: 212, seasons: 961, episodes: 18_406 },
    libraries: [
      { key: "1", title: "Movies", type: "movie", count: 1284 },
      { key: "2", title: "TV Shows", type: "show", count: 212, seasons: 961, episodes: 18_406 },
      { key: "3", title: "Music", type: "artist", count: 340 },
    ],
    recentlyAdded: [
      {
        id: "9001",
        title: "Ghost Stories",
        type: "episode",
        show: "Ghosts",
        season: 5,
        episode: 2,
        addedAt: iso(14),
      },
      { id: "9002", title: "Dune: Part Two", type: "movie", year: 2024, addedAt: iso(120) },
      {
        id: "9003",
        title: "A Tale of Two Ships",
        type: "episode",
        show: "The Orville",
        season: 2,
        episode: 3,
        addedAt: iso(300),
      },
    ],
    sessions: [
      {
        id: "9002",
        sessionId: "s-1",
        title: "Dune: Part Two",
        type: "movie",
        year: 2024,
        user: "Jeff",
        player: "Living Room TV",
        device: "Google TV Streamer",
        platform: "Android",
        state: "playing",
        local: true,
        durationMs: movieMs,
        offsetMs: 40 * 60_000 + moved,
        progressPct: Math.round(((40 * 60_000 + moved) / movieMs) * 1000) / 10,
        decision: "direct play",
        resolution: "4k",
        bitrateKbps: 38_000,
        bandwidthKbps: 41_000,
      },
      {
        id: "9003",
        sessionId: "s-2",
        title: "A Tale of Two Ships",
        type: "episode",
        show: "The Orville",
        season: 2,
        episode: 3,
        user: "Sam",
        player: "Chrome",
        device: "Windows",
        platform: "Chrome",
        state: "buffering",
        local: false,
        durationMs: 52 * 60_000,
        offsetMs: 12 * 60_000,
        progressPct: 23.1,
        decision: "transcode",
        videoDecision: "transcode",
        audioDecision: "copy",
        resolution: "1080",
        bitrateKbps: 12_000,
        bandwidthKbps: 4_000,
        transcodeSpeed: 0.7,
        hardwareTranscode: false,
        problem: "Buffering: the transcoder runs at 0.7x, slower than real time.",
      },
    ],
    activities: [{ title: "Scanning TV Shows", subtitle: "Ghosts", progressPct: 62 }],
  };
}

/** A small Radarr library: mixed quality, one coming, two partial collections. */
export function sampleRadarrLibrary(now = new Date()) {
  const day = 86_400_000;
  const file = (resolution: number, name: string, size: number, codec = "x264", hdr = "") => ({
    hasFile: true,
    sizeOnDisk: size,
    movieFile: {
      size,
      quality: { quality: { name, resolution } },
      mediaInfo: { videoCodec: codec, videoDynamicRangeType: hdr },
    },
  });
  const m = (
    id: number,
    title: string,
    year: number,
    rating: number,
    extra: Partial<RawMovie>,
  ): RawMovie => ({
    id,
    title,
    year,
    monitored: true,
    hasFile: false,
    path: `/movies/${title} (${year})`,
    ratings: { imdb: { value: rating } },
    ...extra,
  });
  const movies: RawMovie[] = [
    m(1, "Dune", 2021, 8.0, {
      ...file(2160, "Bluray-2160p", 21.8e9, "x265", "DV HDR10"),
      tmdbId: 438631,
    }),
    m(2, "John Wick", 2014, 7.4, { ...file(720, "HDTV-720p", 1.6e9), tmdbId: 245891 }),
    m(3, "John Wick: Chapter 4", 2023, 7.6, {
      ...file(1080, "Bluray-1080p", 19.9e9),
      tmdbId: 603692,
    }),
    m(4, "The Road", 2009, 7.2, { ...file(1080, "Remux-1080p", 30.8e9, "h264") }),
    m(5, "Arrival", 2016, 7.9, { ...file(720, "HDTV-720p", 1.4e9) }),
    m(6, "Heat", 1995, 8.3, { ...file(480, "SDTV", 0.7e9, "XviD") }),
    m(7, "The Thing", 1982, 8.2, { ...file(480, "SDTV", 0.7e9, "XviD") }),
    m(8, "Wicked: For Good", 2025, 7.0, { ...file(1080, "WEBDL-1080p", 6.1e9, "x265") }),
    m(9, "The Odyssey", 2026, 0, {
      inCinemas: new Date(now.getTime() - 60 * day).toISOString(),
      digitalRelease: new Date(now.getTime() + 23 * day).toISOString(),
    }),
    m(10, "Street Fighter", 2026, 0, {
      inCinemas: new Date(now.getTime() + 37 * day).toISOString(),
    }),
  ];
  return radarrLibrary(
    movies,
    new Set([2, 5, 6, 7]),
    [
      {
        id: 731,
        title: "John Wick Collection",
        movies: [
          { tmdbId: 245891, title: "John Wick", year: 2014, status: "released", isExisting: true },
          {
            tmdbId: 324552,
            title: "John Wick: Chapter 2",
            year: 2017,
            status: "released",
            isExisting: false,
          },
          {
            tmdbId: 458156,
            title: "John Wick: Chapter 3 - Parabellum",
            year: 2019,
            status: "released",
            isExisting: false,
          },
          {
            tmdbId: 603692,
            title: "John Wick: Chapter 4",
            year: 2023,
            status: "released",
            isExisting: true,
          },
        ],
      },
      {
        id: 11,
        title: "Wicked Collection",
        movies: [
          { tmdbId: 402431, title: "Wicked", year: 2024, status: "released", isExisting: false },
          {
            tmdbId: 967941,
            title: "Wicked: For Good",
            year: 2025,
            status: "released",
            isExisting: true,
          },
        ],
      },
      {
        id: 12,
        title: "Complete Collection",
        movies: [
          { tmdbId: 438631, title: "Dune", year: 2021, status: "released", isExisting: true },
        ],
      },
    ],
    [
      { path: "/movies", freeSpace: 11.81e12, totalSpace: 18e12 },
      { path: "/new releases", freeSpace: 11.81e12, totalSpace: 18e12 },
    ],
    now,
  );
}

/** Sonarr or Radarr as sample data: one stuck import, one downloading, missing items. */
export function sampleArr(app: "sonarr" | "radarr"): import("@dragon-control/core").ArrDashboard {
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const ahead = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const sonarr = app === "sonarr";
  const d = sampleArrBody(app, ago, ahead, sonarr);
  // One finished download, from the grab through the download folder into the library.
  const title = sonarr ? "Foundation S03E03" : "Heat (1995)";
  const history: import("@dragon-control/core").ArrHistoryEvent[] = [
    {
      at: ago(5),
      event: "imported",
      title,
      downloadId: "sample-done",
      client: "SABnzbd",
      droppedPath: sonarr
        ? "/usenet-tv/Foundation.S03E03.1080p.WEB.h264/Foundation.S03E03.1080p.WEB.h264.mkv"
        : "/usenet-movies/Heat.1995.1080p.BluRay.x264/Heat.1995.1080p.BluRay.x264.mkv",
      importedPath: sonarr
        ? "/tv/Foundation/Season 03/Foundation - S03E03 - The Missing Chapter WEBDL-1080p.mkv"
        : "/movies/Heat (1995)/Heat (1995) Bluray-1080p.mkv",
    },
    {
      at: ago(5.2),
      event: "grabbed",
      title,
      release: sonarr ? "Foundation.S03E03.1080p.WEB.h264" : "Heat.1995.1080p.BluRay.x264",
      downloadId: "sample-done",
      client: "SABnzbd",
      indexer: "UsenetOne (Prowlarr)",
    },
  ];
  return {
    ...d,
    history,
    trails: downloadTrails(sonarr ? "Sonarr" : "Radarr", history, [
      ...d.queue.map((q) => ({ ...q, stuck: q.stuckImport })),
    ]),
  };
}

function sampleArrBody(
  app: "sonarr" | "radarr",
  ago: (h: number) => string,
  ahead: (h: number) => string,
  sonarr: boolean,
): import("@dragon-control/core").ArrDashboard {
  return {
    app,
    version: sonarr ? "4.0.9" : "5.14.0",
    totals: {
      titles: sonarr ? 64 : 412,
      monitored: sonarr ? 58 : 388,
      missing: sonarr ? 12 : 7,
      queue: 3,
      stuckImports: 1,
      failed: 1,
    },
    queue: [
      {
        queueId: 101,
        downloadId: "a".repeat(40),
        title: sonarr ? "Ghosts (US) S02E01" : "Colony (2026)",
        release: sonarr ? "Ghosts.US.S02E01.1080p.WEB.h264-GROUP" : "Colony.2026.1080p.WEB-DL.x264",
        ...(sonarr ? { seriesId: 7, episodeId: 701 } : { movieId: 5264 }),
        status: "completed",
        state: "importPending",
        progressPct: 100,
        sizeBytes: 2.1 * 1024 ** 3,
        client: "qBittorrent",
        indexer: "PublicTwo",
        protocol: "torrent",
        problem: sonarr
          ? "Found matching series via grab history, but release was matched to series by ID. Automatic import is not possible."
          : "Not an upgrade for existing movie file. Existing quality: Bluray-1080p.",
        stuckImport: true,
      },
      {
        queueId: 102,
        title: sonarr ? "The Orville S03E05" : "Arrival (2016)",
        release: sonarr ? "The.Orville.S03E05.720p.WEB" : "Arrival.2016.2160p.BluRay",
        ...(sonarr ? { seriesId: 8, episodeId: 805 } : { movieId: 77 }),
        status: "downloading",
        state: "downloading",
        progressPct: 43.5,
        sizeBytes: 1.4 * 1024 ** 3,
        timeLeft: "00:12:40",
        client: "qBittorrent",
        protocol: "torrent",
        stuckImport: false,
      },
      {
        queueId: 103,
        title: sonarr ? "Ghosts (US) S02E10" : "Dune: Part Two (2024)",
        release: sonarr
          ? "Ghosts.US.2021.S02E10.1080p.WEB-DL.DDP5.1.HEVC-YELLO"
          : "Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.x265",
        ...(sonarr ? { seriesId: 7, episodeId: 710 } : { movieId: 693 }),
        status: "failed",
        state: "downloading",
        // So it has a download trail too, like a real failed download.
        downloadId: "sample-failed",
        sizeBytes: 690_920_473,
        client: "SABnzbd",
        protocol: "usenet",
        problem: `Repair failed, not enough repair blocks (4 short). ${sonarr ? "Sonarr" : "Radarr"} did not grab this download itself, so it will not clear it or try another release on its own.`,
        stuckImport: false,
        failed: true,
      },
    ],
    ...(sonarr ? {} : { library: sampleRadarrLibrary().library }),
    missing: sonarr
      ? [
          {
            title: "Ghosts (US) S02E02",
            seriesId: 7,
            episodeId: 702,
            airedAt: ago(30),
            monitored: true,
          },
          {
            title: "Foundation S03E04",
            seriesId: 9,
            episodeId: 904,
            airedAt: ago(80),
            monitored: true,
          },
        ]
      : [{ title: "Dune: Part Two (2024)", movieId: 88, monitored: true }],
    upcoming: [
      { title: sonarr ? "Ghosts (US) S02E03" : "Mickey 17 (2025)", at: ahead(40), hasFile: false },
    ],
    recent: [
      {
        title: sonarr ? "Foundation S03E03" : "Heat (1995)",
        at: ago(5),
        event: "Imported",
        quality: "WEBDL-1080p",
      },
    ],
    health: [],
  };
}

/** Sample movie requests for demo Seerr services: one in each stage, dates relative to today. */
export function sampleSeerr(now = Date.now()): import("@dragon-control/core").SeerrDashboard {
  const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  const radarr = (extra: object = {}) => ({
    serviceId: "demo-radarr",
    movieId: 1,
    instance: "Radarr",
    monitored: true,
    rootFolder: "/movies",
    quality: "HD-1080p",
    ...extra,
  });
  const movies: import("@dragon-control/core").RequestedMovie[] = [
    {
      requestId: 1,
      tmdbId: 1,
      title: "Night Signal",
      year: 2026,
      requestedAt: at(40),
      requestedBy: "You",
      mine: true,
      approval: "approved",
      digital: { date: day(-8), source: "tmdb" },
      theatrical: day(-60),
      overdueDays: 8,
      stage: "searching",
      doing: "Radarr is monitoring it and has not grabbed a release yet.",
      radarr: radarr({ path: "/movies/Night Signal (2026)" }),
    },
    {
      requestId: 2,
      tmdbId: 2,
      title: "Paper Moons",
      year: 2026,
      requestedAt: at(30),
      requestedBy: "You",
      mine: true,
      approval: "approved",
      digital: { date: day(-2), source: "tmdb" },
      stage: "downloading",
      doing: "Radarr is downloading it (40%).",
      radarr: radarr({ progressPct: 40 }),
    },
    {
      requestId: 3,
      tmdbId: 3,
      title: "The Long Road",
      year: 2026,
      requestedAt: at(20),
      requestedBy: "Alex",
      mine: false,
      approval: "approved",
      digital: { date: day(10), source: "tmdb" },
      stage: "waiting-release",
      doing: "Radarr is monitoring it and has not grabbed a release yet.",
      radarr: radarr({ rootFolder: "/movies-4k", quality: "Ultra-HD" }),
    },
    {
      requestId: 4,
      tmdbId: 4,
      title: "Quiet Harbor",
      year: 2026,
      requestedAt: at(2),
      requestedBy: "Alex",
      mine: false,
      approval: "pending",
      stage: "awaiting-approval",
      doing: "Not in Radarr yet.",
    },
    {
      requestId: 5,
      tmdbId: 5,
      title: "Ember Lake",
      year: 2025,
      requestedAt: at(90),
      requestedBy: "You",
      mine: true,
      approval: "completed",
      digital: { date: day(-20), source: "tmdb" },
      stage: "imported",
      doing: "Radarr has it.",
      radarr: radarr(),
    },
  ];
  return {
    app: "seerr",
    version: "1.33.2",
    region: "US",
    me: "You",
    overdueAfterDays: 2,
    totals: {
      movies: movies.length,
      mine: movies.filter((m) => m.mine).length,
      overdue: movies.filter((m) => m.overdueDays !== undefined).length,
      awaitingApproval: movies.filter((m) => m.approval === "pending").length,
    },
    movies,
    notes: [],
    radarrs: [{ serviceId: "demo-radarr", name: "Radarr", rootFolders: ["/movies", "/movies-4k"] }],
  };
}

/** Sample Wizarr data for demo services: three invitations, three users, one ending this week. */
export function sampleWizarr(now = Date.now()): import("@dragon-control/core").WizarrDashboard {
  const at = (days: number) => new Date(now + days * 86_400_000).toISOString();
  return {
    app: "wizarr",
    totals: { users: 3, invites: 3, pending: 1, expired: 1, expiringSoon: 1 },
    invites: [
      {
        id: 3,
        code: "FAMILY7",
        url: "https://wizarr.example/j/FAMILY7",
        status: "pending",
        created: at(-1),
        expires: at(6),
        duration: "unlimited",
        servers: ["Plex"],
        libraries: [],
      },
      {
        id: 2,
        code: "SAM2026",
        url: "https://wizarr.example/j/SAM2026",
        status: "used",
        created: at(-12),
        usedAt: at(-11),
        usedBy: "sam",
        duration: "30",
        servers: ["Plex"],
        libraries: [1],
      },
      {
        id: 1,
        code: "OLDLINK",
        url: "https://wizarr.example/j/OLDLINK",
        status: "expired",
        created: at(-40),
        expires: at(-10),
        duration: "unlimited",
        servers: ["Plex"],
        libraries: [],
      },
    ],
    users: [
      {
        id: 1,
        username: "sam",
        email: "sam@example.com",
        server: "Plex",
        serverType: "plex",
        expires: at(4),
        created: at(-11),
      },
      { id: 2, username: "alex", server: "Plex", serverType: "plex", created: at(-90) },
      { id: 3, username: "kim", server: "Plex", serverType: "plex", created: at(-200) },
    ],
    servers: [{ id: 1, name: "Plex", type: "plex", verified: true }],
    libraries: [
      { id: 1, name: "Movies", serverId: 1, enabled: true },
      { id: 2, name: "TV Shows", serverId: 1, enabled: true },
    ],
  };
}

/** Sample Tautulli activity for demo services: two streams, one converted, and a week's tops. */
export function sampleTautulli(now = Date.now()): import("@dragon-control/core").TautulliDashboard {
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  return {
    app: "tautulli",
    version: "2.15.2",
    totals: { streams: 2, transcoding: 1, bandwidthKbps: 28500, remoteKbps: 8200 },
    streams: [
      {
        sessionId: "s1",
        user: "Alex",
        title: "Severance - Hello, Ms. Cobel",
        mediaType: "episode",
        progressPct: 42,
        state: "playing",
        player: "Living Room · Plex for LG",
        quality: "4k",
        decision: "direct play",
        bandwidthKbps: 20300,
        location: "lan",
      },
      {
        sessionId: "s2",
        user: "sam",
        title: "Dune: Part Two",
        year: 2024,
        mediaType: "movie",
        progressPct: 71,
        state: "playing",
        player: "iPhone · Plex for iOS",
        quality: "720p",
        decision: "transcode",
        why: "Video converted from 4k to 720p (hevc to h264), on the graphics card.",
        bandwidthKbps: 8200,
        location: "wan",
      },
    ],
    top: {
      users: [
        { name: "Alex", plays: 14 },
        { name: "sam", plays: 9 },
      ],
      movies: [{ title: "Dune: Part Two", plays: 3 }],
      shows: [{ title: "Severance", plays: 8 }],
    },
    history: [
      {
        user: "Alex",
        title: "Severance - Woe's Hollow",
        at: at(20),
        watchedPct: 100,
        player: "Plex for LG",
      },
      { user: "sam", title: "Arrival", at: at(30), watchedPct: 64, player: "Plex for iOS" },
    ],
  };
}

/** Sample SABnzbd for demo services: one downloading, one paused, a failure in the history. */
export function sampleSabnzbd(now = Date.now()): import("@dragon-control/core").SabnzbdDashboard {
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  return {
    app: "sabnzbd",
    version: "4.4.1",
    paused: false,
    status: "Downloading",
    speedKbps: 48_200,
    sizeLeft: "6.2 GB",
    timeLeft: "0:02:11",
    diskFreeGb: 812,
    diskTotalGb: 3726,
    queue: [
      {
        id: "SABnzbd_nzo_a1",
        source: { indexer: "UsenetOne", via: "Radarr" },
        name: "Arrival.2016.1080p.BluRay",
        status: "Downloading",
        progressPct: 63,
        sizeMb: 9800,
        timeLeft: "0:01:20",
        category: "movies",
      },
      {
        id: "SABnzbd_nzo_b2",
        source: { indexer: "UsenetTwo", via: "Sonarr" },
        name: "Severance.S02E05.1080p.WEB",
        status: "Paused",
        progressPct: 0,
        sizeMb: 2100,
        category: "tv",
      },
    ],
    history: [
      {
        id: "SABnzbd_nzo_c3",
        source: { indexer: "UsenetOne", via: "Radarr" },
        name: "Dune.Part.Two.2024.2160p",
        failed: true,
        status: "Failed",
        why: "Repair failed, not enough repair blocks (412 short)",
        at: at(5),
        sizeMb: 51200,
        category: "movies",
      },
      {
        id: "SABnzbd_nzo_d4",
        source: { indexer: "NZBFinder", via: "Radarr" },
        name: "Paper.Moons.2026.1080p",
        failed: false,
        status: "Completed",
        at: at(9),
        sizeMb: 8100,
        category: "movies",
      },
    ],
    warnings: [],
  };
}

/** Sample Prowlarr for demo services: one indexer failing and paused, one switched off. */
export function sampleProwlarr(now = Date.now()): import("@dragon-control/core").ProwlarrDashboard {
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString();
  return {
    app: "prowlarr",
    version: "1.24.3",
    totals: { indexers: 3, enabled: 2, failing: 1, queries: 412, grabs: 37 },
    indexers: [
      {
        id: 2,
        name: "Torrent Alpha",
        enabled: true,
        failing: true,
        protocol: "torrent",
        privacy: "public",
        pausedUntil: at(2),
        lastFailure: at(-1),
        queries: 120,
        grabs: 4,
        failedQueries: 31,
        failedGrabs: 0,
        avgMs: 2400,
        proxies: ["FlareSolverr"],
      },
      {
        id: 1,
        name: "Usenet Prime",
        enabled: true,
        failing: false,
        protocol: "usenet",
        privacy: "private",
        queries: 292,
        grabs: 33,
        failedQueries: 0,
        failedGrabs: 0,
        avgMs: 310,
      },
      {
        id: 3,
        name: "Old Tracker",
        enabled: false,
        failing: false,
        protocol: "torrent",
        privacy: "semiPrivate",
        queries: 0,
        grabs: 0,
        failedQueries: 0,
        failedGrabs: 0,
      },
    ],
    apps: [
      { name: "Radarr", kind: "Radarr", sync: "full" },
      { name: "Sonarr", kind: "Sonarr", sync: "full" },
    ],
    health: [],
  };
}

/** Sample Bazarr for demo services: a few missing subtitles and one throttled provider. */
export function sampleBazarr(now = Date.now()): import("@dragon-control/core").BazarrDashboard {
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  return {
    app: "bazarr",
    version: "1.5.1",
    totals: { movies: 2, episodes: 1, providers: 3, throttled: 1 },
    movies: [
      { radarrId: 11, title: "Arrival", missing: ["English"] },
      { radarrId: 12, title: "Amelie", missing: ["English", "French (forced)"] },
    ],
    episodes: [
      { seriesId: 4, episodeId: 41, title: "Severance 2x05: Trojan's Horse", missing: ["English"] },
    ],
    providers: [
      { name: "opensubtitlescom", ok: false, why: "TooManyRequests", retry: "in 2 hours" },
      { name: "podnapisi", ok: true },
      { name: "subdl", ok: true },
    ],
    history: [
      { title: "Dune: Part Two", text: "English subtitles downloaded from subdl", at: at(3) },
    ],
  };
}

/** Sample Home Assistant for demo services. */
export function sampleHomeAssistant(
  now = Date.now(),
): import("@dragon-control/core").HomeAssistantDashboard {
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  return {
    app: "homeassistant",
    version: "2026.10.2",
    running: true,
    totals: {
      entities: 214,
      unavailable: 1,
      automations: 2,
      automationsOn: 1,
      integrationsFailing: 1,
    },
    automations: [
      {
        entityId: "automation.porch_lights_at_sunset",
        name: "Porch lights at sunset",
        on: true,
        lastRan: at(5),
      },
      { entityId: "automation.vacation_mode", name: "Vacation mode", on: false },
    ],
    scripts: [{ entityId: "script.movie_night", name: "Movie night", running: false }],
    scenes: [{ entityId: "scene.good_morning", name: "Good morning" }],
    switches: [
      { entityId: "light.living_room", name: "Living room", kind: "light", on: false },
      { entityId: "switch.server_fan", name: "Server fan", kind: "switch", on: true },
    ],
    unavailable: [{ entityId: "sensor.garage_temp", name: "Garage temperature", since: at(30) }],
    integrations: [
      {
        entryId: "abc123",
        name: "Zigbee",
        domain: "zha",
        problem: "keeps retrying setup: Could not reach the coordinator",
      },
    ],
  };
}

/** Sample Syncthing for demo services. */
export function sampleSyncthing(
  now = Date.now(),
): import("@dragon-control/core").SyncthingDashboard {
  return {
    app: "syncthing",
    version: "1.29.2",
    folders: [
      {
        id: "docs",
        name: "Documents",
        path: "/data/docs",
        kind: "send and receive",
        paused: false,
        state: "idle",
        syncedPct: 100,
        needFiles: 0,
        needMb: 0,
        sizeGb: 1,
        errors: 1,
        failed: [{ path: "taxes/2025.pdf", why: "permission denied" }],
        sharedWith: ["Laptop"],
      },
      {
        id: "photos",
        name: "Phone photos",
        path: "/data/photos",
        kind: "receive only",
        paused: false,
        state: "syncing",
        syncedPct: 80,
        needFiles: 140,
        needMb: 2048,
        sizeGb: 10,
        errors: 0,
        failed: [],
        sharedWith: ["Pixel"],
      },
    ],
    devices: [
      {
        id: "BBBBBBB-PHONEPH",
        name: "Pixel",
        paused: false,
        connected: true,
        address: "192.168.1.50:22000",
        lastSeen: new Date(now).toISOString(),
      },
      {
        id: "CCCCCCC-LAPTOPL",
        name: "Laptop",
        paused: false,
        connected: false,
        lastSeen: new Date(now - 3 * 86_400_000).toISOString(),
      },
    ],
  };
}

/** Sample Lidarr or Chaptarr for demo services. */
export function sampleLibrary(
  app: "lidarr" | "chaptarr",
  now = Date.now(),
): import("@dragon-control/core").LibraryDashboard {
  const L = app === "lidarr";
  return {
    app,
    version: L ? "2.9.6" : "0.9.1",
    words: L
      ? { who: "artist", what: "album", whats: "albums" }
      : { who: "author", what: "book", whats: "books" },
    totals: { people: 48, monitored: 44, missing: 12, queue: 2, stuck: 1 },
    queue: [
      {
        id: 501,
        title: L ? "Radiohead - OK Computer" : "Andy Weir - Project Hail Mary",
        release: L ? "Radiohead-OK_Computer-1997-FLAC" : "Andy.Weir.Project.Hail.Mary.2021.EPUB",
        status: "importPending",
        stuck: true,
        sizeBytes: L ? 412_000_000 : 3_100_000,
        problem: L ? "No files found are eligible for import" : "Book not found in folder",
        via: "SABnzbd",
        indexer: "UsenetOne",
      },
      {
        id: 502,
        title: L ? "Bjork - Homogenic" : "Ursula K. Le Guin - The Dispossessed",
        release: L ? "Bjork-Homogenic-1997-FLAC" : "Ursula.K.Le.Guin.The.Dispossessed.EPUB",
        status: "downloading",
        stuck: false,
        progressPct: 75,
        sizeBytes: L ? 380_000_000 : 2_400_000,
        timeLeft: "00:04:10",
        via: "qBittorrent",
        indexer: "Prowlarr",
      },
    ],
    missing: [
      {
        id: 31,
        title: L ? "Radiohead - Kid A" : "Andy Weir - Artemis",
        released: "2000-10-02T00:00:00Z",
      },
    ],
    upcoming: [
      {
        id: 40,
        title: L ? "Bjork - New Album" : "Andy Weir - New Book",
        on: new Date(now + 5 * 86_400_000).toISOString(),
      },
    ],
    recent: [
      {
        text: L ? "imported: Bjork - Post" : "imported: Andy Weir - The Martian",
        at: new Date(now - 3_600_000).toISOString(),
        failed: false,
        event: "imported",
        title: L ? "Bjork - Post" : "Andy Weir - The Martian",
        quality: L ? "FLAC" : "EPUB",
      },
      {
        text: L
          ? "grabbed: Bjork-Homogenic-1997-FLAC"
          : "grabbed: Ursula.K.Le.Guin.The.Dispossessed.EPUB",
        at: new Date(now - 2 * 3_600_000).toISOString(),
        failed: false,
        event: "grabbed",
        title: L ? "Bjork-Homogenic-1997-FLAC" : "Ursula.K.Le.Guin.The.Dispossessed.EPUB",
      },
    ],
    health: [],
    ...(L ? {} : sampleBookCollection(now)),
  };
}

/** A small Chaptarr collection: audiobooks and ebooks, wanted and not, one author with a book coming. */
function sampleBookCollection(now: number) {
  const day = 86_400_000;
  const book = (
    id: number,
    title: string,
    authorId: number,
    mediaType: "audiobook" | "ebook",
    monitored: boolean,
    size: number,
    releaseDate: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    title,
    authorId,
    mediaType,
    monitored,
    hasFiles: size > 0,
    releaseDate,
    statistics: { bookFileCount: size > 0 ? 1 : 0, sizeOnDisk: size },
    ...extra,
  });
  const soon = new Date(now + 40 * day).toISOString();
  const later = new Date(now + 150 * day).toISOString();
  return chaptarrCollection(
    [
      book(61, "The Martian", 1, "audiobook", true, 312_000_000, "2014-02-11T00:00:00Z", {
        narrator: "R. C. Bray",
        durationMinutes: 653,
      }),
      book(62, "The Martian", 1, "ebook", true, 4_100_000, "2014-02-11T00:00:00Z", {
        pageCount: 387,
      }),
      book(63, "Project Hail Mary", 1, "audiobook", true, 0, "2021-05-04T00:00:00Z", {
        narrator: "Ray Porter",
        durationMinutes: 970,
      }),
      book(64, "Artemis", 1, "ebook", false, 3_600_000, "2017-11-14T00:00:00Z"),
      book(65, "The Next One", 1, "audiobook", false, 0, soon, { seriesTitle: "Hail Mary #2" }),
      book(66, "The Next One", 1, "ebook", false, 0, soon, { seriesTitle: "Hail Mary #2" }),
      book(71, "The Dispossessed", 2, "ebook", true, 2_400_000, "1974-05-01T00:00:00Z", {
        pageCount: 387,
      }),
      book(72, "A Wizard of Earthsea", 2, "audiobook", true, 205_000_000, "1968-01-01T00:00:00Z", {
        narrator: "Rob Inglis",
        durationMinutes: 425,
        seriesTitle: "Earthsea #1",
      }),
      book(81, "The Way of Kings", 3, "audiobook", true, 1_900_000_000, "2010-08-31T00:00:00Z", {
        narrator: "Michael Kramer, Kate Reading",
        durationMinutes: 2729,
        seriesTitle: "The Stormlight Archive #1",
      }),
      book(82, "Isles of the Emberdark", 3, "ebook", false, 0, later),
    ],
    [
      {
        id: 1,
        authorName: "Andy Weir",
        monitored: true,
        nextBook: { title: "The Next One", releaseDate: soon },
      },
      { id: 2, authorName: "Ursula K. Le Guin", monitored: true },
      {
        id: 3,
        authorName: "Brandon Sanderson",
        monitored: true,
        nextBook: { title: "Isles of the Emberdark", releaseDate: later },
      },
    ],
    [
      { name: "Audio Books", path: "/audiobooks", freeSpace: 10.9e12, totalSpace: 14e12 },
      { name: "Books", path: "/ebooks", freeSpace: 10.9e12, totalSpace: 14e12 },
    ],
    new Date(now),
  );
}

/** Sample Jellyfin for demo services. */
export function sampleJellyfin(now = Date.now()): import("@dragon-control/core").JellyfinDashboard {
  return {
    app: "jellyfin",
    version: "10.10.7",
    server: "homeserver",
    needsRestart: false,
    updateAvailable: false,
    streams: [
      {
        sessionId: "s2",
        user: "sam",
        title: "Dune: Part Two (2024)",
        device: "iPhone · Jellyfin iOS",
        progressPct: 71,
        paused: false,
        converting: true,
        why: "Converting: the player cannot play the video format.",
        away: true,
      },
    ],
    libraries: [
      {
        id: "lib-movies",
        name: "Movies",
        kind: "movies",
        folders: 1,
        scanning: false,
        size: [{ n: 812, label: "movies" }],
      },
      {
        id: "lib-shows",
        name: "Shows",
        kind: "tvshows",
        folders: 2,
        scanning: false,
        size: [
          { n: 140, label: "shows" },
          { n: 6123, label: "episodes" },
        ],
      },
    ],
    counts: { movies: 812, shows: 140, episodes: 6123, albums: 0, books: 0 },
    users: [
      { name: "Alex", admin: true, disabled: false, lastActive: new Date(now).toISOString() },
    ],
    tasks: [
      {
        id: "t2",
        name: "Extract Chapter Images",
        running: false,
        failed: true,
        error: "ffmpeg exited with code 1",
      },
    ],
    recent: [
      {
        id: "anora",
        title: "Anora (2024)",
        kind: "Movie",
        at: new Date(now - 3_600_000).toISOString(),
        poster: "anora",
      },
      {
        id: "harbor-s2e4",
        title: "Harbor Lights: The Long Night",
        kind: "Episode",
        at: new Date(now - 7_200_000).toISOString(),
        poster: "series-harbor",
      },
    ],
  };
}

/** Sample Immich for demo services. */
export function sampleImmich(): import("@dragon-control/core").ImmichDashboard {
  return {
    app: "immich",
    version: "3.2.4",
    photos: 48210,
    videos: 1904,
    usageGb: 812,
    disk: { used: "1.9 TiB", size: "3.6 TiB", free: "1.7 TiB", pct: 52 },
    people: [
      { name: "Alex", photos: 40000, videos: 1500, usageGb: 700 },
      { name: "Sam", photos: 8210, videos: 404, usageGb: 112, quotaGb: 200 },
    ],
    queues: [
      {
        name: "faceDetection",
        label: "Finding faces",
        paused: false,
        active: 0,
        waiting: 0,
        failed: 7,
        runnable: true,
      },
      {
        name: "thumbnailGeneration",
        label: "Thumbnails",
        paused: false,
        active: 2,
        waiting: 120,
        failed: 0,
        runnable: true,
      },
    ],
    // The stand-in's photos, so a demo panel shows thumbnails (served by the stand-in Immich).
    recent: FAKE_PHOTOS.slice(0, 20).map((a) => ({
      id: a.id,
      name: a.originalFileName,
      takenAt: a.fileCreatedAt,
      ...(a.isFavorite ? { favorite: true } : {}),
    })),
  };
}

/** Sample Audiobookshelf for demo services. */
export function sampleAudiobookshelf(
  now = Date.now(),
): import("@dragon-control/core").AudiobookshelfDashboard {
  return {
    app: "audiobookshelf",
    version: "2.35.1",
    listening: [
      {
        user: "alex",
        title: "The Hobbit · J.R.R. Tolkien",
        device: "Abs Android · Pixel",
        progressPct: 30,
      },
    ],
    online: ["alex"],
    libraries: [
      {
        id: "lib-books",
        name: "Audiobooks",
        kind: "books",
        items: 312,
        authors: 140,
        hours: 4210,
        sizeGb: 180,
        recent: [
          { title: "Project Hail Mary · Andy Weir", at: new Date(now - 3_600_000).toISOString() },
        ],
      },
      {
        id: "lib-pods",
        name: "Podcasts",
        kind: "podcasts",
        items: 18,
        authors: 0,
        hours: 600,
        sizeGb: 30,
        recent: [],
      },
    ],
    backups: { count: 3, newest: new Date(now - 86_400_000).toISOString() },
  };
}

/** Sample Kavita for demo services. */
/** Sample RomM for demo services: a small library on four platforms. */
export function sampleRomm(now = Date.now()): import("@dragon-control/core").RommDashboard {
  const at = (d: number) => new Date(now - d * 86_400_000).toISOString();
  const game = (
    id: number,
    name: string,
    platform: string,
    platformSlug: string,
    days: number,
    extra: Partial<import("@dragon-control/core").RommGame> = {},
  ) => ({ id, name, platform, platformSlug, cover: false, addedAt: at(days), ...extra });
  return {
    app: "romm",
    version: "5.3.1",
    totals: { platforms: 4, games: 8, saves: 3, states: 1, screenshots: 0, sizeBytes: 9_437_184 },
    platforms: [
      { id: 2, name: "Nintendo Entertainment System", slug: "nes", games: 3, sizeBytes: 196_656 },
      { id: 1, name: "Game Boy Advance", slug: "gba", games: 2, sizeBytes: 3_145_728 },
      {
        id: 4,
        name: "Super Nintendo Entertainment System",
        slug: "snes",
        games: 2,
        sizeBytes: 1_572_864,
      },
      { id: 3, name: "PlayStation", slug: "psx", games: 1, sizeBytes: 3_145_809 },
    ],
    recent: [
      game(6, "Silent Ferry", "PlayStation", "psx", 1, { year: 1998 }),
      game(8, "Iron Orchard", "Super Nintendo Entertainment System", "snes", 3),
      game(4, "Lantern Quest", "Nintendo Entertainment System", "nes", 5, {
        year: 1989,
        favorite: true,
      }),
    ],
    favorites: [
      game(4, "Lantern Quest", "Nintendo Entertainment System", "nes", 5, {
        year: 1989,
        favorite: true,
      }),
    ],
    unidentified: 2,
    canScan: true,
  };
}

export function sampleKavita(now = Date.now()): import("@dragon-control/core").KavitaDashboard {
  return {
    app: "kavita",
    version: "0.8.8.3",
    series: 420,
    volumes: 1310,
    chapters: 9800,
    files: 11020,
    sizeGb: 210,
    readingHours: 312,
    libraries: [
      {
        id: 1,
        name: "Manga",
        kind: "manga",
        folders: 1,
        lastScanned: new Date(now - 3_600_000).toISOString(),
      },
      { id: 2, name: "Books", kind: "books", folders: 2 },
    ],
    jobs: [{ name: "Cleanup", lastRan: new Date(now - 86_400_000).toISOString() }],
    unreadable: {
      count: 1,
      files: [
        { file: "broken.epub", where: "Books · Broken", why: "The file is not a valid EPUB" },
      ],
    },
  };
}

/** Sample ErsatzTV for demo services. */
export function sampleErsatz(now = Date.now()): import("@dragon-control/core").ErsatzDashboard {
  const at = (m: number) => new Date(now + m * 60_000).toISOString();
  return {
    app: "ersatztv",
    version: "26.3.0",
    channels: [
      {
        number: "1",
        name: "Home Network TV",
        streaming: true,
        now: { title: "The Expanse: Dulcinea", until: at(25) },
        next: { title: "Arcane", at: at(25) },
      },
      {
        number: "101",
        name: "Fantasy",
        streaming: false,
        now: { title: "The Fellowship of the Ring", until: at(100) },
      },
    ],
    streams: 1,
    guideRead: true,
  };
}

/** Sample invite steps (Wizarr, Settings, Wizard), for demo installs: not anyone's real Wizarr. */
export function sampleWizarrWizard(): import("@dragon-control/core").WizarrWizard {
  const step = (
    id: number,
    server: string,
    category: "pre_invite" | "post_invite",
    position: number,
    title: string,
    markdown: string,
    requireInteraction = false,
  ) => ({ id, server, category, position, title, markdown, requireInteraction });
  return {
    servers: [
      {
        server: "plex",
        steps: [
          step(
            1,
            "plex",
            "pre_invite",
            0,
            "Welcome",
            "# Welcome\n\nYou are invited to the family Plex.",
          ),
          step(
            2,
            "plex",
            "post_invite",
            0,
            "Get the app",
            "# Get the app\n\nInstall Plex on your TV or phone, then sign in.",
            true,
          ),
          step(
            3,
            "plex",
            "post_invite",
            1,
            "You're in",
            "# You're in\n\nEnjoy, and ask if anything is missing.",
          ),
        ],
      },
    ],
  };
}

/** Sample General settings (Wizarr), for demo installs. */
export function sampleWizarrSettings(): import("@dragon-control/core").WizarrSettings {
  return {
    displayName: "Family Media",
    protectWizard: true,
    expiryAction: "delete",
    posters: {
      value: "",
      choices: [
        { value: "", label: "First server (default)" },
        { value: "invite", label: "The server the invite is for" },
        { value: "1", label: "Plex" },
      ],
    },
  };
}

/** Sample Pi-hole for demo services. */
export function samplePihole(now = Date.now()): import("@dragon-control/core").PiholeDashboard {
  const hour = 3_600_000;
  return {
    app: "pihole",
    version: "6.5 (FTL 6.8)",
    blocking: "enabled",
    queries: {
      total: 41230,
      blocked: 6112,
      percentBlocked: 14.8,
      uniqueDomains: 2210,
      forwarded: 20100,
      cached: 15018,
    },
    clients: { active: 14, total: 19 },
    gravity: { domains: 168420, updatedAt: new Date(now - 2 * 86_400_000).toISOString() },
    topBlocked: [
      { domain: "ads.example.com", count: 1420 },
      { domain: "telemetry.example.net", count: 980 },
      { domain: "tracker.example.org", count: 611 },
    ],
    topClients: [
      { name: "living-room-tv", ip: "192.168.1.40", count: 9120 },
      { name: "phone", ip: "192.168.1.52", count: 6010 },
    ],
    history: Array.from({ length: 24 }, (_, i) => {
      const total = 1200 + Math.round(900 * Math.sin((i / 24) * Math.PI));
      return {
        at: new Date(Math.floor(now / hour) * hour - (23 - i) * hour).toISOString(),
        total,
        blocked: Math.round(total * 0.15),
      };
    }),
    lists: [
      {
        id: 1,
        address: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
        type: "block",
        enabled: true,
        comment: "Default list",
        domains: 168420,
        status: "unchanged",
        updatedAt: new Date(now - 2 * 86_400_000).toISOString(),
      },
    ],
    allowed: [{ domain: "s.youtube.com", match: "exact", comment: "Watch history", enabled: true }],
    denied: [{ domain: "(\\.|^)doubleclick\\.net$", match: "regex", enabled: true }],
    localDns: {
      records: [{ name: "plex.home", ip: "192.168.1.10" }],
      aliases: [{ name: "movies.home", target: "plex.home" }],
    },
    messages: [],
  };
}

/** Sample AdGuard Home for demo services. */
export function sampleAdguard(now = Date.now()): import("@dragon-control/core").AdguardDashboard {
  const hour = 3_600_000;
  return {
    app: "adguard",
    version: "0.107.80",
    protection: { enabled: true },
    filteringEnabled: true,
    queries: {
      total: 38220,
      blocked: 5410,
      percentBlocked: 14.2,
      safeBrowsing: 3,
      parental: 0,
      safeSearch: 41,
      avgMs: 7.4,
    },
    topBlocked: [
      { domain: "ads.example.com", count: 1210 },
      { domain: "telemetry.example.net", count: 870 },
    ],
    topQueried: [{ domain: "www.example.org", count: 3020 }],
    topClients: [
      { client: "192.168.1.40", count: 8120 },
      { client: "192.168.1.52", count: 5210 },
    ],
    history: Array.from({ length: 24 }, (_, i) => {
      const total = 1100 + Math.round(800 * Math.sin((i / 24) * Math.PI));
      return {
        at: new Date(Math.floor(now / hour) * hour - (23 - i) * hour).toISOString(),
        total,
        blocked: Math.round(total * 0.14),
      };
    }),
    filters: [
      {
        id: 1,
        name: "AdGuard DNS filter",
        url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
        enabled: true,
        allowlist: false,
        rules: 61204,
        updatedAt: new Date(now - 5 * hour).toISOString(),
      },
    ],
    updateEveryHours: 24,
    userRules: [{ text: "@@||s.youtube.com^", kind: "allow", domain: "s.youtube.com" }],
    rewrites: [{ domain: "plex.home", answer: "192.168.1.10", enabled: true }],
    blockedServices: {
      ids: ["tiktok"],
      all: [
        { id: "tiktok", name: "TikTok", group: "social_network" },
        { id: "youtube", name: "YouTube", group: "streaming" },
      ],
    },
    safety: { safeBrowsing: true, parental: false, safeSearch: false },
  };
}

/** Sample Proxmox VE for demo services. */
export function sampleProxmox(now = Date.now()): import("@dragon-control/core").ProxmoxDashboard {
  const gb = 1024 ** 3;
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  return {
    app: "proxmox",
    version: "9.1.1",
    nodes: [
      {
        name: "pve",
        online: true,
        cpuPct: 18.4,
        cpus: 16,
        memUsed: 41 * gb,
        memTotal: 64 * gb,
        diskUsed: 22 * gb,
        diskTotal: 94 * gb,
        uptimeSec: 1_814_400,
        updates: 7,
      },
    ],
    guests: [
      {
        id: "qemu/100",
        kind: "vm",
        vmid: 100,
        name: "home-assistant",
        node: "pve",
        status: "running",
        cpuPct: 4.1,
        cpus: 2,
        memUsed: 2.6 * gb,
        memTotal: 4 * gb,
        diskTotal: 32 * gb,
        uptimeSec: 1_200_000,
        template: false,
        tags: ["home"],
        lastBackup: ago(20),
      },
      {
        id: "lxc/200",
        kind: "container",
        vmid: 200,
        name: "media",
        node: "pve",
        status: "running",
        cpuPct: 22.5,
        cpus: 4,
        memUsed: 6.1 * gb,
        memTotal: 8 * gb,
        diskTotal: 16 * gb,
        uptimeSec: 900_000,
        template: false,
        tags: ["media"],
        lastBackup: ago(20),
      },
      {
        id: "qemu/101",
        kind: "vm",
        vmid: 101,
        name: "windows",
        node: "pve",
        status: "stopped",
        cpuPct: 0,
        cpus: 4,
        memUsed: 0,
        memTotal: 8 * gb,
        diskTotal: 128 * gb,
        uptimeSec: 0,
        template: false,
        tags: [],
      },
    ],
    storage: [
      {
        id: "local",
        node: "pve",
        type: "dir",
        shared: false,
        active: true,
        usedBytes: 22 * gb,
        totalBytes: 94 * gb,
        content: ["iso", "vztmpl", "backup"],
      },
      {
        id: "local-lvm",
        node: "pve",
        type: "lvmthin",
        shared: false,
        active: true,
        usedBytes: 310 * gb,
        totalBytes: 800 * gb,
        content: ["images", "rootdir"],
      },
    ],
    backupJobs: [
      {
        id: "backup-nightly",
        schedule: "02:00",
        enabled: true,
        storage: "local",
        guests: "all",
        mode: "snapshot",
      },
    ],
    backups: [
      {
        volid: "local:backup/vzdump-qemu-100-nightly.vma.zst",
        vmid: 100,
        node: "pve",
        storage: "local",
        at: ago(20),
        sizeBytes: 3.1 * gb,
        protected: false,
      },
    ],
    tasks: [
      {
        upid: "UPID:pve:1",
        node: "pve",
        what: "Backup",
        user: "root@pam",
        started: ago(20),
        ended: ago(19.5),
        ok: true,
      },
    ],
  };
}

/** Sample Nginx Proxy Manager for demo services. */
export function sampleNpm(now = Date.now()): import("@dragon-control/core").NpmDashboard {
  const day = 86_400_000;
  const exp = new Date(now + 62 * day).toISOString();
  return {
    app: "npm",
    version: "2.16.0",
    hosts: [
      {
        id: 1,
        domains: ["radarr.example.com"],
        forward: "http://192.168.1.10:7878",
        forwardScheme: "http",
        forwardHost: "192.168.1.10",
        forwardPort: 7878,
        enabled: true,
        online: true,
        certificate: { id: 1, name: "example.com", expires: exp },
        sslForced: true,
        websockets: true,
        blockExploits: true,
      },
    ],
    certificates: [
      {
        id: 1,
        name: "example.com",
        domains: ["*.example.com"],
        provider: "letsencrypt",
        expires: exp,
        usedBy: ["radarr.example.com"],
      },
    ],
    redirections: [],
    streams: [],
    deadHosts: [],
    accessLists: [],
    activity: [
      {
        at: new Date(now - day).toISOString(),
        who: "Admin",
        action: "updated",
        what: "proxy host radarr.example.com",
      },
    ],
  };
}

/** Sample Traefik for demo services. */
export function sampleTraefik(now = Date.now()): import("@dragon-control/core").TraefikDashboard {
  return {
    app: "traefik",
    version: "3.7.17",
    providers: ["Docker", "File"],
    entryPoints: [
      { name: "web", address: ":80" },
      { name: "websecure", address: ":443" },
    ],
    routers: [
      {
        name: "radarr@docker",
        provider: "docker",
        rule: "Host(`radarr.example.com`)",
        hosts: ["radarr.example.com"],
        entryPoints: ["websecure"],
        tls: true,
        middlewares: ["auth@file"],
        service: "radarr@docker",
        status: "enabled",
        errors: [],
        servers: [{ url: "http://172.18.0.5:7878", up: true }],
      },
    ],
    certificates: [
      {
        names: ["*.example.com"],
        issuer: "R11",
        expires: new Date(now + 58 * 86_400_000).toISOString(),
        status: "enabled",
      },
    ],
    counts: { routers: 1, errors: 0, warnings: 0, servicesDown: 0 },
  };
}

/** Sample Portainer for demo services. */
export function samplePortainer(): import("@dragon-control/core").PortainerDashboard {
  return {
    app: "portainer",
    version: "2.45.3",
    environments: [
      {
        id: 1,
        name: "local",
        kind: "docker",
        online: true,
        running: 3,
        stopped: 1,
        unhealthy: 0,
        stacks: 1,
        images: 24,
        cpus: 8,
        memoryBytes: 32 * 1024 ** 3,
      },
    ],
    stacks: [
      {
        id: 1,
        name: "media",
        environmentId: 1,
        running: true,
        fromGit: false,
        containers: 3,
        containersRunning: 3,
      },
    ],
    containers: [
      {
        id: "a1b2c3d4e5f6",
        name: "media-radarr-1",
        image: "linuxserver/radarr",
        state: "running",
        status: "Up 3 days",
        stack: "media",
        environmentId: 1,
      },
      {
        id: "b1b2c3d4e5f6",
        name: "media-sonarr-1",
        image: "linuxserver/sonarr",
        state: "running",
        status: "Up 3 days (healthy)",
        health: "healthy",
        stack: "media",
        environmentId: 1,
      },
      {
        id: "c1b2c3d4e5f6",
        name: "old-test",
        image: "busybox",
        state: "exited",
        status: "Exited (0) 2 weeks ago",
        environmentId: 1,
      },
    ],
    updatesKnown: false,
  };
}

/** Sample Uptime Kuma for demo services. */
export function sampleUptimeKuma(): import("@dragon-control/core").KumaDashboard {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const beats = (down = 0) =>
    Array.from({ length: 40 }, (_, i) => ({
      status: (i >= 40 - down ? "down" : "up") as "up" | "down",
      at: at((40 - i) * 1),
      ...(i >= 40 - down ? {} : { pingMs: 30 + ((i * 13) % 40) }),
    }));
  const m = (
    id: number,
    name: string,
    target: string,
    extra: Partial<import("@dragon-control/core").KumaMonitor> = {},
  ): import("@dragon-control/core").KumaMonitor => ({
    id,
    name,
    type: "http",
    target,
    status: "up",
    message: "200 - OK",
    since: at(60 * 24 * 6),
    pingMs: 42,
    avgPingMs: 48.2,
    uptime24h: 1,
    uptime30d: 0.9993,
    intervalSeconds: 60,
    alerts: 1,
    tags: [],
    beats: beats(),
    ...extra,
  });
  return {
    app: "uptimekuma",
    version: "2.5.9",
    monitors: [
      m(1, "Media", "", { type: "group", target: undefined, beats: beats(), message: "All up" }),
      m(2, "Jellyfin", "http://jellyfin:8096", { group: "Media", parentId: 1 }),
      m(3, "Radarr", "http://radarr:7878", { group: "Media", parentId: 1 }),
      m(4, "Sonarr", "http://sonarr:8989", {
        group: "Media",
        parentId: 1,
        status: "down",
        message: "connect ECONNREFUSED 172.18.0.7:8989",
        since: at(4),
        uptime24h: 0.972,
        uptime30d: 0.995,
        beats: beats(4),
      }),
      m(5, "Home Assistant", "https://home.example.com", { certDaysLeft: 9, certValid: true }),
      m(6, "Nextcloud", "https://cloud.example.com", { certDaysLeft: 61, certValid: true }),
      m(7, "NAS", "192.168.1.20", { type: "ping", message: "", pingMs: 1, avgPingMs: 1.2 }),
      m(8, "Old printer", "192.168.1.40", {
        type: "ping",
        status: "paused",
        alerts: 0,
        beats: [],
      }),
    ],
    events: [
      {
        monitorId: 4,
        monitor: "Sonarr",
        status: "down",
        at: at(4),
        message: "connect ECONNREFUSED",
      },
      { monitorId: 2, monitor: "Jellyfin", status: "up", at: at(300), message: "200 - OK" },
      { monitorId: 2, monitor: "Jellyfin", status: "down", at: at(312), message: "timeout" },
    ],
    maintenance: [{ id: 1, title: "NAS disk swap", status: "scheduled", active: true }],
    statusPages: [{ slug: "home", title: "Home services", published: true }],
    notifications: ["Discord"],
  };
}

/** Sample Nextcloud for demo services. */
export function sampleNextcloud(): import("@dragon-control/core").NextcloudDashboard {
  const GB = 1024 ** 3;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const user = (
    id: string,
    name: string,
    groups: string[],
    usedGb: number,
    quotaGb: number | undefined,
    lastMin: number | undefined,
    enabled = true,
  ) => ({
    id,
    name,
    email: `${id}@example.com`,
    enabled,
    admin: groups.includes("admin"),
    groups,
    ...(quotaGb ? { quotaBytes: quotaGb * GB } : {}),
    quota: quotaGb ? `${quotaGb} GB` : "none",
    usedBytes: usedGb * GB,
    ...(lastMin !== undefined ? { lastLogin: ago(lastMin) } : {}),
    backend: "Database",
  });
  return {
    app: "nextcloud",
    version: "35.0.2",
    maintenance: false,
    signedInAs: "hearth",
    freeGb: 412,
    files: 48210,
    accounts: 4,
    disabledAccounts: 1,
    active: { last5min: 1, lastHour: 2, lastDay: 3, lastWeek: 3, lastMonth: 3 },
    shares: { total: 14, links: 5, linksNoPassword: 3, federated: 0 },
    system: {
      php: "8.5.12",
      database: "mysql 11.4.5",
      databaseMb: 700,
      webserver: "Apache/2.4.69 (Debian)",
      memoryGb: 15.7,
      memoryFreeGb: 9,
      load: 0.42,
      cpus: 4,
      memcache: "APCu",
    },
    jobs: { mode: "cron", lastRun: ago(3), health: "ok" },
    apps: { installed: 52, updates: [{ id: "calendar", version: "6.1.0" }] },
    checks: [
      {
        id: "MaintenanceWindowStart",
        name: "Maintenance window start",
        level: "warning",
        text: "Server has no maintenance window start time configured.",
      },
      {
        id: "TwoFactorConfiguration",
        name: "Second factor configuration",
        level: "info",
        text: "Second factor providers are available but two-factor authentication is not enforced.",
      },
    ],
    users: [
      user("hearth", "Hearth", ["admin"], 0, undefined, 1),
      user("alex", "Alex", ["admin", "family"], 182, undefined, 20),
      user("sam", "Sam", ["family"], 46, 50, 900),
      user("guest", "Old guest", [], 0, 1, undefined, false),
    ],
    groups: ["admin", "family"],
    settings: { linksNeedPassword: false, linksAllowed: true },
  };
}

/** Sample Nextcloud apps for demo services. */
export function sampleNextcloudApps(): import("@dragon-control/core").NextcloudApp[] {
  return [
    { id: "calendar", name: "Calendar", version: "6.0.1", enabled: true, update: "6.1.0" },
    { id: "files", name: "Files", version: "2.5.0", enabled: true },
    { id: "photos", name: "Photos", version: "5.0.0", enabled: true },
    { id: "admin_audit", name: "Auditing / Logging", version: "1.22.0", enabled: false },
  ];
}

/** Sample Paperless-ngx for demo services. */
export function samplePaperless(): import("@dragon-control/core").PaperlessDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const doc = (
    id: number,
    title: string,
    tags: number[],
    addedMin: number,
    correspondent?: [number, string],
    type?: [number, string],
  ) => ({
    id,
    title,
    tags,
    added: ago(addedMin),
    created: ago(addedMin + 4320).slice(0, 10),
    ...(correspondent
      ? { correspondentId: correspondent[0], correspondent: correspondent[1] }
      : {}),
    ...(type ? { typeId: type[0], type: type[1] } : {}),
  });
  return {
    app: "paperless",
    version: "3.4.2",
    documents: 1284,
    inboxCount: 3,
    inbox: [
      doc(1281, "Electricity bill November", [1], 40, [1, "Acme Power"]),
      doc(1282, "Water bill October", [1, 2], 180, [2, "City Water"], [1, "Invoice"]),
      doc(1283, "Letter from the school", [1], 600),
    ],
    inboxTags: [1],
    waiting: [],
    failed: [
      {
        id: 51,
        name: "Import",
        file: "scan-0042.pdf",
        status: "failed",
        at: ago(25),
        result:
          "scan-0042.pdf: Error occurred while consuming document scan-0042.pdf: InputFileError:",
      },
    ],
    freeGb: 120,
    totalGb: 500,
    health: [
      { part: "Database", status: "ok" },
      { part: "Redis", status: "ok" },
      { part: "Workers", status: "ok" },
      { part: "Search index", status: "ok", at: ago(30) },
      { part: "Classifier", status: "ok", at: ago(50) },
      { part: "Sanity check", status: "ok", at: ago(60 * 20) },
    ],
    tags: [
      { id: 2, name: "Bills", count: 412, color: "#e76f51" },
      { id: 3, name: "Tax 2026", count: 88, color: "#264653" },
      { id: 1, name: "Inbox", count: 3, color: "#2a9d8f", inbox: true },
    ],
    correspondents: [
      { id: 1, name: "Acme Power", count: 64 },
      { id: 2, name: "City Water", count: 31 },
    ],
    types: [
      { id: 1, name: "Invoice", count: 530 },
      { id: 2, name: "Letter", count: 205 },
    ],
    fileTypes: [
      { type: "application/pdf", count: 1201 },
      { type: "image/jpeg", count: 83 },
    ],
    trashCount: 2,
  };
}

/** Sample Vaultwarden for demo services. */
export function sampleVaultwarden(): import("@dragon-control/core").VaultwardenDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const user = (
    id: string,
    email: string,
    name: string,
    status: "active" | "invited" | "disabled",
    twoFactor: boolean,
    lastMin: number | undefined,
    orgs: string[],
  ) => ({
    id,
    email,
    name,
    status,
    twoFactor,
    ...(lastMin !== undefined ? { lastActive: ago(lastMin) } : {}),
    orgs,
  });
  return {
    app: "vaultwarden",
    version: "1.37.5",
    webVault: "2026.10.1",
    database: "SQLite 3.53.2",
    address: "https://vault.example.com",
    https: true,
    users: [
      user("u-alex", "alex@example.com", "Alex", "active", true, 12, ["Family"]),
      user("u-sam", "sam@example.com", "Sam", "active", false, 1500, ["Family"]),
      user("u-kid", "kid@example.com", "Kid", "active", true, 3000, ["Family"]),
      user("u-gran", "gran@example.com", "gran", "invited", false, undefined, []),
    ],
    orgs: [{ name: "Family", members: 3 }],
    settings: {
      signupsAllowed: false,
      signupDomains: "",
      signupsVerify: false,
      invitationsAllowed: true,
      emergencyAccess: true,
      sends: true,
      passwordHints: true,
      showPasswordHint: false,
      emailConfigured: true,
      webVault: true,
    },
    checks: [],
  };
}

/** Sample Tailscale tailnet for demo services. */
export function sampleTailscale(): import("@dragon-control/core").TailscaleDashboard {
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const dev = (
    name: string,
    os: string,
    over: Partial<import("@dragon-control/core").TailscaleDevice> = {},
  ): import("@dragon-control/core").TailscaleDevice => ({
    id: `n${name}`,
    name,
    fqdn: `${name}.tail1234.ts.net`,
    hostname: name,
    os,
    user: "alex@example.com",
    tags: [],
    addresses: ["100.64.0.10", "fd7a:115c:a1e0::a"],
    online: true,
    authorized: true,
    keyExpires: at(120),
    keyExpiryDisabled: false,
    clientVersion: "1.90.4",
    updateAvailable: false,
    exitNode: { offered: false, approved: false },
    routes: { offered: [], approved: [] },
    external: false,
    ephemeral: false,
    ssh: false,
    ...over,
  });
  return {
    app: "tailscale",
    domain: "tail1234.ts.net",
    devices: [
      dev("nas", "linux", {
        tags: ["tag:server"],
        keyExpiryDisabled: true,
        exitNode: { offered: true, approved: true },
        routes: { offered: ["192.168.1.0/24"], approved: ["192.168.1.0/24"] },
        ssh: true,
      }),
      dev("laptop", "macOS"),
      dev("phone", "iOS", { online: false, lastSeen: at(-1), updateAvailable: true }),
      dev("tablet", "android"),
      dev("pi", "linux", { exitNode: { offered: true, approved: false } }),
      dev("work-pc", "windows", { keyExpires: at(9) }),
    ],
    dns: { magicDns: true, nameservers: ["1.1.1.1"] },
  };
}

/** Sample wg-easy for demo services. */
export function sampleWgEasy(): import("@dragon-control/core").WgEasyDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const peer = (
    id: number,
    name: string,
    enabled: boolean,
    handshakeMin: number | undefined,
    gbDown: number,
  ) => ({
    id,
    name,
    enabled,
    address: `10.8.0.${id + 1}`,
    ...(handshakeMin !== undefined
      ? { lastHandshake: ago(handshakeMin), from: `203.0.113.${id}:5${id}413` }
      : {}),
    connected: handshakeMin !== undefined && handshakeMin < 3,
    receivedBytes: Math.round(gbDown * 0.15 * 1e9),
    sentBytes: Math.round(gbDown * 1e9),
  });
  return {
    app: "wgeasy",
    version: "15.2.2",
    host: "vpn.example.com",
    port: 51820,
    subnet: "10.8.0.0/24",
    dns: ["1.1.1.1"],
    allowedIps: ["0.0.0.0/0", "::/0"],
    peers: [
      peer(1, "Alex's phone", true, 1, 3.1),
      peer(2, "laptop", true, 2, 12.4),
      peer(3, "Sam's phone", true, 60 * 30, 0.8),
      peer(4, "guest tablet", false, undefined, 0),
    ],
  };
}

/** Sample Navidrome for demo services. */
export function sampleNavidrome(): import("@dragon-control/core").NavidromeDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return {
    app: "navidrome",
    version: "0.64.2",
    scan: { scanning: false, lastScan: ago(180), type: "quick", files: 1284, folders: 96 },
    libraries: [
      {
        id: 1,
        name: "Music Library",
        path: "/music",
        songs: 1284,
        albums: 112,
        artists: 64,
        missing: 0,
        lastScan: ago(180),
      },
    ],
    nowPlaying: [
      {
        user: "sam",
        title: "Tide",
        artist: "Quiet Harbor",
        album: "Open Water",
        player: "Sam's phone",
        minutesAgo: 1,
      },
    ],
    users: [
      { id: "u1", userName: "alex", name: "Alex", admin: true, lastSeen: ago(5) },
      { id: "u2", userName: "sam", name: "Sam", admin: false, lastSeen: ago(1) },
      { id: "u3", userName: "kid", name: "Kid", admin: false, lastSeen: ago(60 * 30) },
    ],
    players: [
      {
        id: "p1",
        name: "Sam's phone [Symfonium]",
        user: "sam",
        client: "Symfonium",
        lastSeen: ago(1),
      },
      {
        id: "p2",
        name: "NavidromeUI [Firefox]",
        user: "alex",
        client: "NavidromeUI",
        lastSeen: ago(5),
      },
    ],
    missing: [],
    missingCount: 0,
    playlists: 7,
    shares: 2,
  };
}

/** Sample Komga for demo services. */
export function sampleKomga(): import("@dragon-control/core").KomgaDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return {
    app: "komga",
    version: "1.30.0",
    libraries: [
      {
        id: "lib-comics",
        name: "Comics",
        root: "/data/comics",
        series: 38,
        books: 412,
        scanEvery: "every 6 hours",
      },
      {
        id: "lib-manga",
        name: "Manga",
        root: "/data/manga",
        series: 21,
        books: 230,
        scanEvery: "off",
      },
    ],
    series: 59,
    books: 642,
    unreadable: [
      { id: "b-bad", name: "Harbor Lights v03", series: "Harbor Lights", why: "ERR_1002" },
    ],
    unreadableCount: 1,
    latest: [
      { id: "b1", name: "Lantern Tales v04", series: "Lantern Tales", added: ago(30) },
      { id: "b2", name: "Lantern Tales v03", series: "Lantern Tales", added: ago(60 * 48) },
    ],
    users: [
      { id: "u1", email: "alex@example.com", admin: true, lastSeen: ago(3) },
      { id: "u2", email: "kid@example.com", admin: false, lastSeen: ago(180) },
    ],
    failedSignIns: [],
    history: [{ type: "BookImported", at: ago(30), text: "Book imported: Lantern Tales v04" }],
    readLists: 3,
    collections: 5,
  };
}

/** Sample Gitea for demo services. */
export function sampleGitea(): import("@dragon-control/core").GiteaDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return {
    app: "gitea",
    version: "1.27.3",
    flavor: "Gitea",
    repos: 4,
    privateRepos: 1,
    archivedRepos: 1,
    sizeKb: 6784,
    recent: [
      { id: 1, fullName: "alex/homelab", private: true, mirror: false, updated: ago(20) },
      { id: 2, fullName: "alex/notes", private: false, mirror: false, updated: ago(300) },
      { id: 3, fullName: "alex/upstream-mirror", private: false, mirror: true, updated: ago(90) },
    ],
    mirrors: [
      {
        id: 3,
        owner: "alex",
        name: "upstream-mirror",
        fullName: "alex/upstream-mirror",
        interval: "every 8 hours",
        lastSync: ago(90),
        late: false,
      },
    ],
    runners: [
      {
        id: 2,
        name: "garage-runner",
        online: true,
        busy: false,
        disabled: false,
        labels: ["ubuntu-latest"],
      },
      {
        id: 1,
        name: "shed-runner",
        online: false,
        busy: false,
        disabled: false,
        labels: ["ubuntu-latest"],
      },
    ],
    runs: [
      {
        id: 7,
        owner: "alex",
        repo: "homelab",
        title: "Update compose files",
        workflow: "ci.yml",
        branch: "main",
        status: "completed",
        conclusion: "success",
        attempt: 1,
        started: ago(45),
      },
    ],
    canRerun: true,
    failedRunsToday: 0,
    users: 3,
    admins: 1,
    orgs: 1,
    tasks: [
      { name: "update_mirrors", schedule: "@every 10m", next: ago(-5), prev: ago(5) },
      { name: "repo_health_check", schedule: "@midnight", next: ago(-600) },
    ],
  };
}

/** Sample Mealie for demo services. */
export function sampleMealie(): import("@dragon-control/core").MealieDashboard {
  return {
    app: "mealie",
    version: "3.30.0",
    latest: "3.30.0",
    database: "SQLite",
    recipes: 214,
    users: 3,
    households: 1,
    groups: 1,
    uncategorized: 40,
    untagged: 12,
    checks: { emailReady: true, baseUrlSet: true },
    storage: {
      data: "412.5 MB",
      temp: "0 bytes",
      backups: "18.2 MB",
      cleanableImages: 0,
      cleanableDirs: 0,
    },
    backups: [
      {
        name: "mealie_v3.30.0_2026.11.08.03.00.00.zip",
        at: new Date(Date.now() - 3_600_000).toISOString(),
        size: "18.2 MB",
      },
    ],
    defaultAdmin: false,
  };
}

/** Sample Actual Budget server for demo services. */
export function sampleActual(): import("@dragon-control/core").ActualDashboard {
  return {
    app: "actual",
    version: "26.11.0",
    healthy: true,
    uptime: 86_400 * 3,
    memoryMb: 180,
    loginMethods: ["Password"],
    multiuser: false,
    budgets: [
      { id: "f-household", name: "Household 2026", encrypted: true, people: 2 },
      { id: "f-trip", name: "Summer trip", encrypted: false, people: 1 },
    ],
    deleted: 1,
  };
}

/** Sample Authentik for demo services. */
export function sampleAuthentik(): import("@dragon-control/core").AuthentikDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return {
    app: "authentik",
    version: "2026.8.5",
    latest: "2026.8.5",
    outdated: false,
    signIns: 14,
    failedSignIns: [{ username: "sam", at: ago(40), ip: "10.0.0.8" }],
    failedCount: 1,
    users: [
      { id: 6, username: "akadmin", name: "Alex", active: true, admin: true, lastLogin: ago(30) },
      { id: 7, username: "sam", name: "Sam", active: true, admin: false, lastLogin: ago(300) },
    ],
    activeUsers: 2,
    applications: [
      {
        slug: "paperless",
        name: "Paperless",
        protects: "paperless.example.com",
        provider: "Proxy Provider",
      },
      { slug: "grafana", name: "Grafana", provider: "OAuth2/OpenID Provider" },
    ],
    outposts: [
      {
        id: "op-embedded",
        name: "authentik Embedded Outpost",
        type: "proxy",
        healthy: true,
        lastSeen: ago(1),
        outdated: false,
      },
    ],
    workers: 1,
    tasks: { failed: 0, warning: 0, running: 0, queued: 0 },
    failedTasks: [],
    certificates: [],
  };
}

/** Sample Frigate for demo services. */
export function sampleFrigate(): import("@dragon-control/core").FrigateDashboard {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  return {
    app: "frigate",
    version: "0.18.2-cfa08c5",
    latest: "0.18.2",
    uptime: 3 * 86_400,
    cameras: [
      {
        name: "front_door",
        fps: 5,
        expectedFps: 5,
        detecting: true,
        online: true,
        connection: "good",
        reconnects: 0,
        storageMb: 812000,
      },
      {
        name: "garage",
        fps: 5,
        expectedFps: 5,
        detecting: true,
        online: true,
        connection: "good",
        reconnects: 0,
        storageMb: 168000,
      },
    ],
    detectors: [{ name: "coral", inferenceMs: 8.4 }],
    events: [
      {
        id: "s-1",
        camera: "front_door",
        label: "person",
        at: ago(10),
        snapshot: true,
        kept: false,
      },
      { id: "s-2", camera: "garage", label: "car", at: ago(60), snapshot: true, kept: true },
    ],
    alertsToday: 3,
    detectionsToday: 7,
    unreviewed: 2,
    storage: { usedGb: 640, totalGb: 1000, freeGb: 360 },
  };
}

/** Sample Authelia for demo services. */
export function sampleAuthelia(): import("@dragon-control/core").AutheliaDashboard {
  return {
    app: "authelia",
    healthy: true,
    metrics: true,
    metricsAddress: "http://authelia:9959/metrics",
    since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    memoryMb: 40,
    signIns: 142,
    failed: 4,
    banned: 0,
    signInMs: 215,
    serverErrors: 0,
  };
}
