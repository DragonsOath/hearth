import type { Fetch } from "./http";
import {
  GB,
  QUALITIES,
  VERSION,
  formatsMatching,
  iso,
  paged,
  reply,
  scoreOf,
  servarrCore,
  sharedState,
  type Json,
} from "./fake-servarr";

/**
 * A stand-in Sonarr 4 for the native Sonarr panel (native panels Phase 3). Like the stand-in
 * Radarr it keeps state and answers the v3 paths the panel and its plan steps use, in Sonarr
 * 4.0's shapes: series with seasons, episodes, episode files, wanted lists, history, queue,
 * search to add, season and episode monitoring, manual import and the release-name check. The
 * settings, system and connections come from the shared Servarr core (fake-servarr.ts). Used for
 * tests and the sample-data panel; never against a real install. Titles are invented.
 */

export const FAKE_SONARR_VERSION = VERSION.sonarr;

interface ShowSeed {
  title: string;
  year: number;
  status: "continuing" | "ended" | "upcoming";
  network: string;
  /** Episodes per season. */
  seasons: number[];
  /** Episodes with a file, per season (the rest are missing). */
  have: number[];
  quality: keyof typeof QUALITIES;
  monitored?: boolean;
  /** Seasons not monitored (season numbers). */
  unmonitoredSeasons?: number[];
  profile?: number;
  type?: "standard" | "daily" | "anime";
  tags?: number[];
  genres?: string[];
  rating?: number;
}

const SHOWS: ShowSeed[] = [
  {
    title: "Night Harbor",
    year: 2019,
    status: "ended",
    network: "Stand-in One",
    seasons: [6, 6],
    have: [6, 6],
    quality: "bluray1080",
    genres: ["Drama"],
    rating: 8.1,
  },
  {
    title: "The Copper Line",
    year: 2023,
    status: "continuing",
    network: "Stand-in Two",
    seasons: [8, 8],
    have: [8, 5],
    quality: "web1080",
    genres: ["Crime"],
    rating: 7.6,
  },
  {
    title: "Small Hours",
    year: 2021,
    status: "continuing",
    network: "Stand-in One",
    seasons: [10, 10, 4],
    have: [10, 9, 0],
    quality: "hdtv720",
    unmonitoredSeasons: [1],
    genres: ["Comedy"],
    rating: 7.0,
    tags: [1],
  },
  {
    title: "Northwind",
    year: 2016,
    status: "ended",
    network: "Stand-in Three",
    seasons: [4],
    have: [4],
    quality: "web720",
    monitored: false,
    genres: ["Documentary"],
    rating: 8.4,
  },
];

/** Shows Sonarr's search would find that are not in the library yet. */
const LOOKUP: Json[] = [
  ["Lantern Bay", 2024, "continuing", 2],
  ["Lantern Bay Stories", 2026, "upcoming", 1],
  ["The Orchard Road", 2020, "ended", 3],
].map(([title, year, status, seasons], i) => ({
  title,
  year,
  status,
  tvdbId: 99000 + i,
  overview: `${String(title)} is a stand-in show used by Hearth's tests.`,
  network: "Stand-in Four",
  images: [],
  folder: `${String(title)} (${String(year)})`,
  genres: ["Drama"],
  ratings: { value: 7.2 },
  seasons: Array.from({ length: Number(seasons) }, (_, k) => ({
    seasonNumber: k + 1,
    monitored: true,
  })),
}));

const SIZE: Record<string, number> = {
  bluray1080: 4.2,
  web1080: 2.4,
  hdtv720: 1.1,
  web720: 1.3,
};

function build() {
  const series: Json[] = [];
  const episodes: Json[] = [];
  const files: Json[] = [];
  let epId = 1;
  let fileId = 1;
  SHOWS.forEach((show, i) => {
    const id = i + 1;
    const folder = `${show.title} (${show.year})`;
    const q = QUALITIES[show.quality]!;
    show.seasons.forEach((count, k) => {
      const season = k + 1;
      for (let n = 1; n <= count; n++) {
        const has = n <= (show.have[k] ?? 0);
        const aired = iso(-(show.seasons.length - k) * 120 + n * 7);
        const ep: Json = {
          id: epId,
          seriesId: id,
          tvdbId: 50000 + epId,
          seasonNumber: season,
          episodeNumber: n,
          title: `Chapter ${n}`,
          airDate: aired.slice(0, 10),
          airDateUtc: aired,
          monitored: show.monitored !== false && !(show.unmonitoredSeasons ?? []).includes(season),
          hasFile: has,
          episodeFileId: 0,
        };
        if (has) {
          const name = `${show.title} - S${String(season).padStart(2, "0")}E${String(n).padStart(2, "0")} - Chapter ${n} [${q.name}].mkv`;
          const f: Json = {
            id: fileId,
            seriesId: id,
            seasonNumber: season,
            relativePath: `Season ${season}/${name}`,
            path: `/tv/${folder}/Season ${season}/${name}`,
            size: Math.round((SIZE[show.quality] ?? 1) * GB),
            dateAdded: iso(-(show.seasons.length - k) * 100 + n),
            quality: { quality: q, revision: { version: 1, real: 0, isRepack: false } },
            customFormats: [],
            customFormatScore: 0,
            mediaInfo: { videoCodec: "x264", audioCodec: "AAC", audioChannels: 2 },
          };
          files.push(f);
          ep.episodeFileId = fileId;
          fileId++;
        }
        episodes.push(ep);
        epId++;
      }
    });
    series.push({
      id,
      title: show.title,
      sortTitle: show.title.toLowerCase().replace(/^the /, ""),
      year: show.year,
      tvdbId: 70000 + id,
      status: show.status,
      network: show.network,
      overview: `${show.title} is a stand-in show used by Hearth's tests.`,
      monitored: show.monitored !== false,
      monitorNewItems: "all",
      qualityProfileId: show.profile ?? 1,
      seriesType: show.type ?? "standard",
      seasonFolder: true,
      path: `/tv/${folder}`,
      rootFolderPath: "/tv",
      folder,
      tags: show.tags ?? [],
      genres: show.genres ?? [],
      ratings: { value: show.rating ?? 7 },
      images: [],
      added: iso(-400 + i * 30),
      seasons: show.seasons.map((_, k) => ({
        seasonNumber: k + 1,
        monitored: show.monitored !== false && !(show.unmonitoredSeasons ?? []).includes(k + 1),
      })),
    });
  });
  return { series, episodes, files, nextEpisode: epId, nextFile: fileId };
}

/** Grabbed and imported events for the newest files, and one failed download. */
function initialHistory(lib: ReturnType<typeof build>): Json[] {
  const rows: Json[] = [];
  let id = 1;
  const newest = [...lib.files]
    .sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)))
    .slice(0, 6);
  for (const f of newest) {
    const ep = lib.episodes.find((e) => e.episodeFileId === f.id)!;
    const show = lib.series.find((x) => x.id === f.seriesId)!;
    const release = `${String(show.title).replace(/\s+/g, ".")}.S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}.${String(((f.quality as Json).quality as Json).name)}-GROUP`;
    const when = new Date(String(f.dateAdded)).getTime();
    for (const [eventType, offset] of [
      ["grabbed", 3_600_000],
      ["downloadFolderImported", 0],
    ] as const)
      rows.push({
        id: id++,
        seriesId: show.id,
        episodeId: ep.id,
        sourceTitle: release,
        quality: f.quality,
        customFormats: [],
        customFormatScore: 0,
        date: new Date(when - offset).toISOString(),
        eventType,
        data: { indexer: "Stand-in Indexer", downloadClient: "Stand-in Client" },
      });
  }
  rows.push({
    id,
    seriesId: 2,
    episodeId: 26,
    sourceTitle: "The.Copper.Line.S02E06.1080p.WEB-DL-FAKEGRP",
    quality: { quality: QUALITIES.web1080 },
    customFormats: [{ id: 3, name: "Bad release group" }],
    customFormatScore: -1000,
    date: iso(-1),
    eventType: "downloadFailed",
    data: { message: "Download failed: the files were incomplete." },
  });
  // The grabs behind the stand-in qBittorrent's and SABnzbd's episodes (11-11).
  for (const [downloadId, sourceTitle, indexer] of [
    [
      "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
      "Night.Signal.S01E01.1080p.WEB",
      "TrackerOne (Prowlarr)",
    ],
    ["SABnzbd_nzo_b2", "Severance.S02E05.1080p.WEB", "UsenetOne (Prowlarr)"],
    ["SABnzbd_nzo_d4", "Paper.Moons.2026.1080p", "UsenetTwo (Prowlarr)"],
  ])
    rows.push({
      id: ++id,
      seriesId: 2,
      episodeId: 26,
      sourceTitle,
      quality: { quality: QUALITIES.web1080 },
      customFormats: [],
      customFormatScore: 0,
      date: iso(-0.5),
      eventType: "grabbed",
      downloadId,
      data: { indexer, downloadClient: "Stand-in Client" },
    });
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function initialState() {
  const lib = build();
  return {
    ...sharedState("sonarr"),
    ...lib,
    naming: {
      id: 1,
      renameEpisodes: true,
      replaceIllegalCharacters: true,
      colonReplacementFormat: 4,
      standardEpisodeFormat:
        "{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality Full}]",
      dailyEpisodeFormat: "{Series Title} - {Air-Date} - {Episode Title} [{Quality Full}]",
      animeEpisodeFormat:
        "{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality Full}]",
      seriesFolderFormat: "{Series Title} ({Series Year})",
      seasonFolderFormat: "Season {season}",
    } as Json,
    media: {
      id: 1,
      autoUnmonitorPreviouslyDownloadedEpisodes: false,
      recycleBin: "",
      recycleBinCleanupDays: 7,
      downloadPropersAndRepacks: "preferAndUpgrade",
      createEmptySeriesFolders: false,
      deleteEmptyFolders: false,
      fileDate: "none",
      rescanAfterRefresh: "always",
      copyUsingHardlinks: true,
      importExtraFiles: false,
      extraFileExtensions: "srt",
      minimumFreeSpaceWhenImporting: 100,
      skipFreeSpaceCheckWhenImporting: false,
    } as Json,
    health: [] as Json[],
    exclusions: [{ id: 1, tvdbId: 99002, title: "The Orchard Road" }] as Json[],
    history: initialHistory(lib),
    blocklist: [
      {
        id: 1,
        seriesId: 2,
        episodeIds: [26],
        sourceTitle: "The.Copper.Line.S02E06.1080p.WEB-DL-FAKEGRP",
        quality: { quality: QUALITIES.web1080 },
        customFormats: [{ id: 3, name: "Bad release group" }],
        date: iso(-1),
        protocol: "torrent",
        indexer: "Stand-in Indexer",
        message: "Download failed: the files were incomplete.",
      },
    ] as Json[],
    queue: [
      {
        id: 8001,
        seriesId: 2,
        episodeId: 26,
        title: "The.Copper.Line.S02E06.1080p.WEB-DL-GROUP",
        status: "downloading",
        trackedDownloadStatus: "ok",
        trackedDownloadState: "downloading",
        size: 2.4 * GB,
        sizeleft: 1 * GB,
        timeleft: "00:06:00",
        downloadClient: "Stand-in Client",
        protocol: "torrent",
        downloadId: "dlcopper6",
        quality: { quality: QUALITIES.web1080 },
      },
    ] as Json[],
    downloads: [
      {
        path: "/downloads/The.Copper.Line.S02E07.1080p.WEB-DL-GRP/The.Copper.Line.S02E07.1080p.WEB-DL-GRP.mkv",
        size: Math.round(2.3 * GB),
        seriesId: 2,
        seasonNumber: 2,
        episodeNumber: 7,
        quality: "web1080",
      },
      { path: "/downloads/Home.Movie.2024.mkv", size: Math.round(0.8 * GB), quality: "web720" },
    ] as {
      path: string;
      size: number;
      seriesId?: number;
      seasonNumber?: number;
      episodeNumber?: number;
      quality: string;
    }[],
  };
}

export interface FakeSonarr {
  fetch: Fetch;
  reset(): void;
  series(): Json[];
  episodes(): Json[];
}

export function fakeSonarr(): FakeSonarr {
  let s = initialState();
  const nextId = () => ++s.nextId;

  /** A series with its statistics worked out from its episodes and files, as Sonarr adds them. */
  const full = (show: Json): Json => {
    const eps = s.episodes.filter((e) => e.seriesId === show.id);
    const fileOf = (e: Json) => s.files.find((f) => f.id === e.episodeFileId);
    const stats = (list: Json[]) => {
      const withFile = list.filter((e) => e.hasFile);
      const counted = list.filter((e) => e.monitored || e.hasFile);
      const size = withFile.reduce((n, e) => n + Number(fileOf(e)?.size ?? 0), 0);
      return {
        episodeFileCount: withFile.length,
        episodeCount: counted.length,
        totalEpisodeCount: list.length,
        sizeOnDisk: size,
        percentOfEpisodes: counted.length ? (withFile.length / counted.length) * 100 : 0,
      };
    };
    const seasons = (show.seasons as Json[]).map((season) => ({
      ...season,
      statistics: stats(eps.filter((e) => e.seasonNumber === season.seasonNumber)),
    }));
    const aired = eps
      .map((e) => String(e.airDateUtc))
      .filter((d) => d < iso(0))
      .sort();
    const coming = eps
      .map((e) => String(e.airDateUtc))
      .filter((d) => d >= iso(0))
      .sort();
    return {
      ...show,
      seasons,
      statistics: { seasonCount: seasons.length, ...stats(eps) },
      previousAiring: aired.at(-1),
      nextAiring: coming[0],
    };
  };
  const withSeries = (r: Json) => {
    const show = s.series.find((x) => x.id === r.seriesId);
    const ep = s.episodes.find((e) => e.id === r.episodeId);
    return { ...r, series: show ? full(show) : undefined, episode: ep };
  };
  const qualityIndex = (profileId: unknown, qid: number) => {
    const prof = s.profiles.find((x) => x.id === profileId);
    const order = ((prof?.items as Json[]) ?? []).map((i) => (i.quality as Json).id);
    return { at: order.indexOf(qid), cutoff: order.indexOf(prof?.cutoff) };
  };

  const core = servarrCore({
    app: "sonarr",
    state: () => s,
    items: () => s.series,
    root: "/tv",
    onCommand: (body) => {
      if (body.name !== "ManualImport") return;
      for (const f of (body.files as Json[]) ?? []) {
        const src = s.downloads.find((d) => d.path === f.path);
        const show = s.series.find((x) => x.id === f.seriesId);
        const ids = ((f.episodeIds as number[]) ?? []).map(Number);
        if (!src || !show || ids.length === 0) continue;
        const name = src.path.split("/").pop()!;
        const q =
          ((f.quality as Json | undefined)?.quality as Json | undefined) ?? QUALITIES[src.quality];
        const ep = s.episodes.find((e) => e.id === ids[0]);
        const file: Json = {
          id: s.nextFile++,
          seriesId: show.id,
          seasonNumber: ep?.seasonNumber ?? 1,
          relativePath: `Season ${String(ep?.seasonNumber ?? 1)}/${name}`,
          path: `${String(show.path)}/Season ${String(ep?.seasonNumber ?? 1)}/${name}`,
          originalFilePath: src.path,
          size: src.size,
          dateAdded: iso(0),
          quality: { quality: q, revision: { version: 1, real: 0, isRepack: false } },
          customFormats: [],
          customFormatScore: 0,
          mediaInfo: { videoCodec: "x264", audioCodec: "AAC", audioChannels: 2 },
        };
        s.files.push(file);
        for (const e of s.episodes)
          if (ids.includes(e.id as number)) {
            e.hasFile = true;
            e.episodeFileId = file.id;
          }
        if (body.importMode !== "copy") s.downloads = s.downloads.filter((d) => d !== src);
      }
    },
  });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    let body: Json = {};
    try {
      body = init.body ? (JSON.parse(init.body) as Json) : {};
    } catch {
      return reply(400, { message: "Body is not JSON" });
    }
    const shared = core(u, p, method, body);
    if (shared) return shared;

    if (p === "/api/v3/rootfolder")
      return reply(200, [
        { id: 1, path: "/tv", accessible: true, freeSpace: 1.2e12, unmappedFolders: [] },
      ]);

    // Sonarr's own search for a show to add (it asks TVDB through Sonarr's metadata service).
    if (p === "/api/v3/series/lookup") {
      const term = (u.searchParams.get("term") ?? "").toLowerCase();
      const tvdb = /^tvdb:(\d+)$/.exec(term)?.[1];
      const hits = [...LOOKUP, ...s.series].filter((m) =>
        tvdb ? String(m.tvdbId) === tvdb : String(m.title).toLowerCase().includes(term),
      );
      return reply(
        200,
        hits.map((m) => {
          const have = s.series.find((x) => x.tvdbId === m.tvdbId);
          if (have) return full(have);
          const { id: _id, ...rest } = m as Json & { id?: unknown };
          void _id;
          return rest;
        }),
      );
    }
    if (p === "/api/v3/series" && method === "POST") {
      if (s.series.some((x) => x.tvdbId === body.tvdbId))
        return reply(400, [{ errorMessage: "This series has already been added" }]);
      const id = nextId();
      const folder = `${String(body.title)} (${String(body.year)})`;
      const seasons = ((body.seasons as Json[]) ?? []).map((x) => ({
        seasonNumber: x.seasonNumber,
        monitored: x.monitored !== false,
      }));
      const show: Json = {
        ...body,
        id,
        folder,
        path: `${String(body.rootFolderPath)}/${folder}`,
        added: iso(0),
        seasons,
      };
      delete show.addOptions;
      s.series = [...s.series, show];
      // Episodes appear once Sonarr has refreshed the show: three per season, none on disk.
      for (const season of seasons)
        for (let n = 1; n <= 3; n++)
          s.episodes.push({
            id: s.nextEpisode++,
            seriesId: id,
            seasonNumber: season.seasonNumber,
            episodeNumber: n,
            title: `Chapter ${n}`,
            airDateUtc: iso(-30 + n),
            monitored: Boolean(body.monitored) && season.monitored,
            hasFile: false,
            episodeFileId: 0,
          });
      return reply(201, full(show));
    }
    // The series editor (the Crucible moves shows to their row's profile).
    if (p === "/api/v3/series/editor" && method === "PUT") {
      const ids = new Set((body.seriesIds as number[]) ?? []);
      const b = body;
      for (const x of s.series)
        if (ids.has(Number(x.id))) {
          if (b.qualityProfileId !== undefined) x.qualityProfileId = b.qualityProfileId;
          // Tags, as the editor applies them: add, remove or replace.
          if (Array.isArray(b.tags)) {
            const have = new Set(((x.tags as number[]) ?? []).map(Number));
            const given = (b.tags as number[]).map(Number);
            x.tags =
              b.applyTags === "remove"
                ? [...have].filter((t) => !given.includes(t))
                : b.applyTags === "replace"
                  ? given
                  : [...new Set([...have, ...given])];
          }
        }
      return reply(202, s.series.filter((x) => ids.has(Number(x.id))).map(full));
    }
    if (p === "/api/v3/series" && method === "GET") {
      const tvdb = u.searchParams.get("tvdbId");
      const list = tvdb ? s.series.filter((x) => String(x.tvdbId) === tvdb) : s.series;
      return reply(200, list.map(full));
    }
    const seriesOne = /^\/api\/v3\/series\/(\d+)$/.exec(p);
    if (seriesOne) {
      const id = Number(seriesOne[1]);
      const show = s.series.find((x) => x.id === id);
      if (!show) return reply(404, { message: "NotFound" });
      if (method === "GET") return reply(200, full(show));
      if (method === "PUT") {
        const seasons = ((body.seasons as Json[]) ?? (show.seasons as Json[])).map((x) => ({
          seasonNumber: x.seasonNumber,
          monitored: x.monitored === true,
        }));
        const next: Json = { ...show, ...body, id, seasons };
        delete next.statistics;
        // A season switched on or off switches its episodes too, as Sonarr does.
        for (const season of seasons) {
          const before = (show.seasons as Json[]).find(
            (x) => x.seasonNumber === season.seasonNumber,
          );
          if (before && before.monitored !== season.monitored)
            for (const e of s.episodes)
              if (e.seriesId === id && e.seasonNumber === season.seasonNumber)
                e.monitored = season.monitored;
        }
        s.series = s.series.map((x) => (x.id === id ? next : x));
        return reply(202, full(next));
      }
      if (method === "DELETE") {
        s.series = s.series.filter((x) => x.id !== id);
        s.episodes = s.episodes.filter((e) => e.seriesId !== id);
        if (u.searchParams.get("deleteFiles") === "true")
          s.files = s.files.filter((f) => f.seriesId !== id);
        if (u.searchParams.get("addImportListExclusion") === "true")
          s.exclusions.push({ id: nextId(), tvdbId: show.tvdbId, title: show.title });
        return reply(200, {});
      }
    }
    if (p === "/api/v3/seasonpass" && method === "POST") {
      for (const item of (body.series as Json[]) ?? []) {
        const show = s.series.find((x) => x.id === item.id);
        if (!show) continue;
        if (typeof item.monitored === "boolean") show.monitored = item.monitored;
        for (const season of (item.seasons as Json[]) ?? []) {
          const have = (show.seasons as Json[]).find((x) => x.seasonNumber === season.seasonNumber);
          if (have) have.monitored = season.monitored;
          for (const e of s.episodes)
            if (e.seriesId === show.id && e.seasonNumber === season.seasonNumber)
              e.monitored = season.monitored;
        }
      }
      return reply(202, {});
    }

    // Episodes and their files.
    if (p === "/api/v3/episode" && method === "GET") {
      const seriesId = Number(u.searchParams.get("seriesId"));
      const ids = u.searchParams.getAll("episodeIds").map(Number);
      const list = ids.length
        ? s.episodes.filter((e) => ids.includes(e.id as number))
        : s.episodes.filter((e) => e.seriesId === seriesId);
      return reply(
        200,
        list.map((e) => ({
          ...e,
          ...(u.searchParams.get("includeEpisodeFile") === "true" && e.episodeFileId
            ? { episodeFile: s.files.find((f) => f.id === e.episodeFileId) }
            : {}),
        })),
      );
    }
    if (p === "/api/v3/episode/monitor" && method === "PUT") {
      const ids = ((body.episodeIds as number[]) ?? []).map(Number);
      for (const e of s.episodes) if (ids.includes(e.id as number)) e.monitored = body.monitored;
      return reply(
        202,
        s.episodes.filter((e) => ids.includes(e.id as number)),
      );
    }
    const episodeOne = /^\/api\/v3\/episode\/(\d+)$/.exec(p);
    if (episodeOne) {
      const e = s.episodes.find((x) => x.id === Number(episodeOne[1]));
      if (!e) return reply(404, { message: "NotFound" });
      if (method === "PUT") Object.assign(e, { monitored: body.monitored === true });
      return reply(method === "PUT" ? 202 : 200, e);
    }
    if (p === "/api/v3/episodefile" && method === "GET") {
      const seriesId = Number(u.searchParams.get("seriesId"));
      return reply(
        200,
        s.files.filter((f) => f.seriesId === seriesId),
      );
    }
    const fileOne = /^\/api\/v3\/episodefile\/(\d+)$/.exec(p);
    if (fileOne) {
      const id = Number(fileOne[1]);
      const f = s.files.find((x) => x.id === id);
      if (!f) return reply(404, { message: "NotFound" });
      if (method === "GET") return reply(200, f);
      if (method === "DELETE") {
        s.files = s.files.filter((x) => x.id !== id);
        for (const e of s.episodes)
          if (e.episodeFileId === id) {
            e.hasFile = false;
            e.episodeFileId = 0;
          }
        return reply(200, {});
      }
    }

    // Activity and wanted.
    if (p === "/api/v3/history" && method === "GET") {
      const page = paged(s.history, u);
      return reply(200, { ...page, records: page.records.map(withSeries) });
    }
    if (p === "/api/v3/history/series" && method === "GET") {
      const id = Number(u.searchParams.get("seriesId"));
      return reply(200, s.history.filter((h) => h.seriesId === id).map(withSeries));
    }
    if (p === "/api/v3/blocklist" && method === "GET") {
      const page = paged(s.blocklist, u);
      return reply(200, { ...page, records: page.records.map(withSeries) });
    }
    const blockOne = /^\/api\/v3\/blocklist\/(\d+)$/.exec(p);
    if (blockOne && method === "DELETE") {
      const id = Number(blockOne[1]);
      if (!s.blocklist.some((b) => b.id === id)) return reply(404, { message: "NotFound" });
      s.blocklist = s.blocklist.filter((b) => b.id !== id);
      return reply(200, {});
    }
    if (p === "/api/v3/wanted/missing") {
      const missing = s.episodes.filter((e) => {
        const show = s.series.find((x) => x.id === e.seriesId);
        return !e.hasFile && e.monitored && show?.monitored && String(e.airDateUtc) < iso(0);
      });
      const page = paged(missing, u);
      return reply(200, {
        ...page,
        records: page.records.map((e) =>
          withSeries({ ...e, seriesId: e.seriesId, episodeId: e.id }),
        ),
      });
    }
    if (p === "/api/v3/wanted/cutoff") {
      const below = s.episodes.filter((e) => {
        const show = s.series.find((x) => x.id === e.seriesId);
        const f = s.files.find((x) => x.id === e.episodeFileId);
        if (!f || !show || !e.monitored) return false;
        const qid = ((f.quality as Json).quality as Json).id as number;
        const { at, cutoff } = qualityIndex(show.qualityProfileId, qid);
        return at < cutoff;
      });
      const page = paged(below, u);
      return reply(200, {
        ...page,
        records: page.records.map((e) => withSeries({ ...e, episodeId: e.id })),
      });
    }
    if (p === "/api/v3/queue" && method === "GET") {
      const records = s.queue
        .filter((q) => s.series.some((x) => x.id === q.seriesId))
        .map(withSeries);
      return reply(200, { page: 1, pageSize: 100, totalRecords: records.length, records });
    }
    const queueOne = /^\/api\/v3\/queue\/(\d+)$/.exec(p);
    if (queueOne && method === "DELETE") {
      const id = Number(queueOne[1]);
      if (!s.queue.some((q) => q.id === id)) return reply(404, { message: "NotFound" });
      s.queue = s.queue.filter((q) => q.id !== id);
      return reply(200, {});
    }
    if (p === "/api/v3/calendar")
      return reply(
        200,
        s.episodes
          .filter((e) => String(e.airDateUtc) >= iso(0))
          .map((e) => withSeries({ ...e, episodeId: e.id })),
      );

    // Manual import: files in a folder, with Sonarr's guess of the series and episodes.
    if (p === "/api/v3/manualimport" && method === "GET") {
      const folder = u.searchParams.get("folder") ?? "";
      if (!folder) return reply(200, []);
      return reply(
        200,
        s.downloads
          .filter((f) => f.path.startsWith(folder.replace(/\/$/, "") + "/"))
          .map((f, i) => {
            const show = s.series.find((x) => x.id === f.seriesId);
            const eps = s.episodes.filter(
              (e) =>
                e.seriesId === f.seriesId &&
                e.seasonNumber === f.seasonNumber &&
                e.episodeNumber === f.episodeNumber,
            );
            const name = f.path.split("/").pop()!;
            return {
              id: i + 1,
              path: f.path,
              relativePath: name,
              folderName: f.path.split("/").slice(-2, -1)[0],
              name: name.replace(/\.mkv$/, ""),
              size: f.size,
              ...(show ? { series: full(show), seasonNumber: f.seasonNumber, episodes: eps } : {}),
              quality: {
                quality: QUALITIES[f.quality],
                revision: { version: 1, real: 0, isRepack: false },
              },
              languages: [{ id: 1, name: "English" }],
              releaseGroup: "GRP",
              rejections: show ? [] : [{ reason: "Unknown Series", type: "permanent" }],
            };
          }),
      );
    }

    // Sonarr's own matcher for a release name (the custom format preview, D13).
    if (p === "/api/v3/parse") {
      const title = u.searchParams.get("title") ?? "";
      const formats = formatsMatching(s.formats, title);
      const m = /^(.*?)[. ]S(\d{1,2})E(\d{1,3})/i.exec(title);
      const name = m ? m[1]!.replace(/\./g, " ") : title.split(".")[0];
      const show = s.series.find(
        (x) => String(x.title).toLowerCase() === String(name).toLowerCase(),
      );
      return reply(200, {
        title,
        parsedEpisodeInfo: {
          seriesTitle: name,
          seasonNumber: m ? Number(m[2]) : undefined,
          episodeNumbers: m ? [Number(m[3])] : [],
        },
        ...(show ? { series: full(show) } : {}),
        customFormats: formats,
        customFormatScore: scoreOf(s.profiles, formats),
      });
    }

    return reply(404, { message: "NotFound" });
  };

  return {
    fetch: fetchImpl,
    reset() {
      s = initialState();
    },
    series: () => s.series.map(full),
    episodes: () => s.episodes,
  };
}
