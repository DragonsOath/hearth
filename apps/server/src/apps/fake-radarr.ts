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
 * A stand-in Radarr 6 for the native Radarr panel (checklist 46.9). It keeps state, answers the
 * v3 API paths the panel and its operations use with the same shapes Radarr 6.4 returns, and
 * accepts changes, so plans made from the panel run through the real planning, approval,
 * re-reading and read-back code. Used for browser tests (DC_FAKE_APPS=1) and for the sample-data
 * panel (demo), never against a real install. Titles are invented.
 *
 * The real disposable Radarr (private/docs/RADARR_TEST_INSTANCE_PROPOSAL.md) checks the same
 * code against the real app.
 */

export const FAKE_RADARR_VERSION = VERSION.radarr;

interface Seed {
  title: string;
  year: number;
  /** Quality key of the file on disk; absent when missing. */
  file?: keyof typeof QUALITIES;
  gb?: number;
  monitored?: boolean;
  profile?: number;
  status?: "released" | "inCinemas" | "announced";
  tags?: number[];
  genres?: string[];
  rating?: number;
  addedDaysAgo?: number;
  codec?: string;
  collection?: string;
}

const SEEDS: Seed[] = [
  {
    title: "Harbor Lights",
    year: 2019,
    file: "bluray1080",
    gb: 9.4,
    genres: ["Drama"],
    rating: 7.4,
    addedDaysAgo: 300,
    codec: "x264",
  },
  {
    title: "The Quiet Engine",
    year: 2021,
    file: "web2160",
    gb: 18.2,
    profile: 2,
    genres: ["Science Fiction", "Thriller"],
    rating: 7.9,
    addedDaysAgo: 210,
    codec: "x265",
  },
  {
    title: "Paper Lanterns",
    year: 2016,
    file: "web720",
    gb: 2.1,
    genres: ["Romance"],
    rating: 6.8,
    addedDaysAgo: 500,
    codec: "x264",
  },
  {
    title: "Iron Orchard",
    year: 2023,
    file: "web1080",
    gb: 5.6,
    genres: ["Action"],
    rating: 6.5,
    addedDaysAgo: 90,
    codec: "x265",
    tags: [1],
  },
  {
    title: "North of Nowhere",
    year: 2012,
    file: "dvd",
    gb: 1.4,
    genres: ["Adventure"],
    rating: 7.1,
    addedDaysAgo: 800,
    codec: "xvid",
  },
  {
    title: "Glass Meridian",
    year: 2024,
    genres: ["Mystery"],
    rating: 7.2,
    addedDaysAgo: 30,
    collection: "Meridian",
  },
  {
    title: "Glass Meridian II",
    year: 2026,
    status: "announced",
    genres: ["Mystery"],
    addedDaysAgo: 3,
    collection: "Meridian",
  },
  {
    title: "Summer of Small Things",
    year: 2018,
    file: "bluray1080",
    gb: 11.8,
    genres: ["Comedy", "Family"],
    rating: 7.6,
    addedDaysAgo: 420,
    codec: "x264",
    tags: [2],
  },
  {
    title: "The Last Lighthouse",
    year: 2020,
    file: "hdtv720",
    gb: 1.9,
    genres: ["Horror"],
    rating: 6.1,
    addedDaysAgo: 360,
    codec: "x264",
  },
  { title: "Copper Sky", year: 2025, status: "inCinemas", genres: ["Western"], addedDaysAgo: 12 },
  {
    title: "Velvet Static",
    year: 2022,
    file: "bluray2160",
    gb: 41.3,
    profile: 2,
    genres: ["Music", "Drama"],
    rating: 8.1,
    addedDaysAgo: 150,
    codec: "x265",
  },
  {
    title: "A House Called Winter",
    year: 2017,
    monitored: false,
    genres: ["Drama"],
    rating: 6.9,
    addedDaysAgo: 700,
  },
];

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function initialMovies(): Json[] {
  return SEEDS.map((s, i) => {
    const id = i + 1;
    const folder = `${s.title} (${s.year})`;
    const q = s.file ? QUALITIES[s.file]! : undefined;
    const size = s.gb ? Math.round(s.gb * GB) : 0;
    const status = s.status ?? "released";
    return {
      id,
      title: s.title,
      sortTitle: s.title.toLowerCase().replace(/^the /, ""),
      year: s.year,
      status,
      overview: `${s.title} is a stand-in film used by Hearth's tests.`,
      inCinemas: status === "announced" ? iso(120) : iso(-(2026 - s.year) * 365 - 40),
      ...(status === "released" ? { digitalRelease: iso(-(2026 - s.year) * 365) } : {}),
      images: [],
      website: "",
      monitored: s.monitored ?? true,
      minimumAvailability: "released",
      isAvailable: status === "released",
      qualityProfileId: s.profile ?? 1,
      rootFolderPath: "/movies",
      folderName: folder,
      path: `/movies/${folder}`,
      tags: s.tags ?? [],
      added: iso(-(s.addedDaysAgo ?? 100)),
      hasFile: Boolean(q),
      sizeOnDisk: size,
      runtime: 95 + ((i * 7) % 40),
      genres: s.genres ?? [],
      // TMDB popularity: the newest movies are the popular ones here.
      popularity: s.year >= 2025 ? 85 : 6 + (i % 5),
      studio: "Stand-in Pictures",
      certification: "PG-13",
      ratings: s.rating
        ? { imdb: { value: s.rating, votes: 1000 + i * 37 }, tmdb: { value: s.rating } }
        : {},
      tmdbId: 7000 + id,
      imdbId: `tt90000${String(id).padStart(2, "0")}`,
      titleSlug: `${slug(s.title)}-${7000 + id}`,
      ...(s.collection ? { collection: { title: s.collection, tmdbId: 8800 } } : {}),
      statistics: { movieFileCount: q ? 1 : 0, sizeOnDisk: size },
      ...(q
        ? {
            movieFile: {
              id: 500 + id,
              movieId: id,
              relativePath: `${folder} ${q.name}.mkv`,
              path: `/movies/${folder}/${folder} ${q.name}.mkv`,
              size,
              dateAdded: iso(-(s.addedDaysAgo ?? 100)),
              quality: { quality: q, revision: { version: 1, real: 0, isRepack: false } },
              customFormats: s.codec === "x265" ? [{ id: 2, name: "x265 (HD)" }] : [],
              customFormatScore: s.codec === "x265" ? -10 : 0,
              mediaInfo: {
                videoCodec: s.codec ?? "x264",
                audioCodec: "AAC",
                audioChannels: 2,
                resolution: `${q.resolution === 2160 ? 3840 : q.resolution === 1080 ? 1920 : 1280}x${q.resolution}`,
                videoDynamicRangeType: q.resolution === 2160 ? "HDR10" : "",
              },
            },
          }
        : {}),
    };
  });
}

function initialHistory(movies: Json[]): Json[] {
  const rows: Json[] = [];
  let id = 1;
  for (const m of movies) {
    const file = m.movieFile as Json | undefined;
    if (!file) continue;
    const q = (file.quality as Json).quality as Json;
    const when = new Date(String(file.dateAdded)).getTime();
    const release = `${String(m.title).replace(/\s+/g, ".")}.${m.year}.${q.name}-GROUP`;
    rows.push({
      id: id++,
      movieId: m.id,
      sourceTitle: release,
      quality: file.quality,
      customFormats: file.customFormats,
      customFormatScore: file.customFormatScore,
      date: new Date(when - 3_600_000).toISOString(),
      eventType: "grabbed",
      downloadId: `dl${m.id}`,
      data: {
        indexer: "Stand-in Indexer",
        downloadClient: "Stand-in Client",
        releaseGroup: "GROUP",
      },
    });
    rows.push({
      id: id++,
      movieId: m.id,
      sourceTitle: release,
      quality: file.quality,
      customFormats: file.customFormats,
      customFormatScore: file.customFormatScore,
      date: new Date(when).toISOString(),
      eventType: "downloadFolderImported",
      downloadId: `dl${m.id}`,
      data: { droppedPath: `/downloads/${release}`, importedPath: file.path },
    });
  }
  rows.push({
    id,
    movieId: 6,
    sourceTitle: "Glass.Meridian.2024.1080p.WEB-DL-FAKEGRP",
    quality: { quality: QUALITIES.web1080 },
    customFormats: [{ id: 3, name: "Bad release group" }],
    customFormatScore: -1000,
    date: iso(-2),
    eventType: "downloadFailed",
    data: { message: "Download failed: the files were incomplete." },
  });
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/** Movies Radarr's search would find on TMDB that are not in the library yet. */
const LOOKUP: Json[] = [
  ["Lantern Season", 2023, "released"],
  ["Lantern Season 2", 2027, "announced"],
  ["The Orchard Keeper", 2021, "released"],
].map(([title, year, status], i) => ({
  title,
  year,
  status,
  tmdbId: 9900 + i,
  overview: `${String(title)} is a stand-in film used by Hearth's tests.`,
  images: [],
  folder: `${String(title)} (${String(year)})`,
  genres: ["Drama"],
  ratings: {},
}));

function initialState() {
  const movies = initialMovies();
  return {
    movies,
    ...sharedState("radarr"),
    naming: {
      id: 1,
      renameMovies: true,
      replaceIllegalCharacters: true,
      colonReplacementFormat: "dash",
      standardMovieFormat: "{Movie Title} ({Release Year}) {Quality Full}",
      movieFolderFormat: "{Movie Title} ({Release Year})",
    } as Json,
    media: {
      id: 1,
      autoUnmonitorPreviouslyDownloadedMovies: false,
      recycleBin: "",
      recycleBinCleanupDays: 7,
      downloadPropersAndRepacks: "preferAndUpgrade",
      createEmptyMovieFolders: false,
      deleteEmptyFolders: false,
      fileDate: "none",
      rescanAfterRefresh: "always",
      autoRenameFolders: false,
      pathsDefaultStatic: false,
      setPermissionsLinux: false,
      chmodFolder: "755",
      chownGroup: "",
      skipFreeSpaceCheckWhenImporting: false,
      minimumFreeSpaceWhenImporting: 100,
      copyUsingHardlinks: true,
      useScriptImport: false,
      scriptImportPath: "",
      importExtraFiles: false,
      extraFileExtensions: "srt",
      enableMediaInfo: true,
    } as Json,
    history: initialHistory(movies),
    exclusions: [
      { id: 1, tmdbId: 9902, movieTitle: "The Orchard Keeper", movieYear: 2021 },
    ] as Json[],
    // Finished downloads Radarr has not imported: one it knows, one it cannot match.
    downloads: [
      {
        path: "/downloads/Glass.Meridian.2018.1080p.BluRay.x264-GRP/Glass.Meridian.2018.1080p.BluRay.x264-GRP.mkv",
        size: Math.round(8.2 * GB),
        movieId: 6,
        quality: "bluray1080",
      },
      {
        path: "/downloads/Holiday.Video.2024.mkv",
        size: Math.round(1.1 * GB),
        quality: "web720",
      },
    ] as { path: string; size: number; movieId?: number; quality: string }[],
    blocklist: [
      {
        id: 1,
        movieId: 6,
        sourceTitle: "Glass.Meridian.2024.1080p.WEB-DL-FAKEGRP",
        quality: { quality: QUALITIES.web1080 },
        customFormats: [{ id: 3, name: "Bad release group" }],
        date: iso(-2),
        protocol: "torrent",
        indexer: "Stand-in Indexer",
        message: "Download failed: the files were incomplete.",
      },
    ] as Json[],
    health: [
      {
        source: "IndexerSearchCheck",
        type: "warning",
        message: "Stand-in: no indexers available with Interactive Search enabled for 4K.",
        wikiUrl: "https://wiki.servarr.com/radarr/system#indexers",
      },
    ] as Json[],
    queue: [
      {
        id: 9001,
        movieId: 10,
        title: "Copper.Sky.2025.1080p.WEB-DL-GROUP",
        status: "downloading",
        trackedDownloadStatus: "ok",
        trackedDownloadState: "downloading",
        size: 6 * GB,
        sizeleft: 2.5 * GB,
        timeleft: "00:12:00",
        downloadClient: "Stand-in Client",
        protocol: "torrent",
        downloadId: "dlcopper",
        quality: { quality: QUALITIES.web1080 },
      },
      {
        id: 9002,
        movieId: 6,
        title: "Glass.Meridian.2024.1080p.WEB-DL-GROUP",
        status: "failed",
        trackedDownloadStatus: "error",
        trackedDownloadState: "failedPending",
        errorMessage: "The download failed in the download client.",
        size: 5 * GB,
        sizeleft: 5 * GB,
        downloadClient: "Stand-in Client",
        protocol: "torrent",
        downloadId: "dlglass",
        quality: { quality: QUALITIES.web1080 },
      },
    ] as Json[],
  };
}

export interface FakeRadarr {
  fetch: Fetch;
  reset(): void;
  /** Movies as the stand-in has them (tests). */
  movies(): Json[];
  /** Every search Radarr started, with the movie's profile at that moment (the Crucible's race). */
  searches(): { movieId: number; profileId: number; on: "add" | "command" }[];
  /** Releases grabbed (by a search or RSS sync), with the profile that allowed it. */
  grabs(): { movieId: number; profileId: number; by: "search" | "rss" }[];
}

export function fakeRadarr(): FakeRadarr {
  let s = initialState();
  let searches: { movieId: number; profileId: number; on: "add" | "command" }[] = [];
  let grabs: { movieId: number; profileId: number; by: "search" | "rss" }[] = [];
  /**
   * Radarr's decision on one new release for a wanted movie, as real Radarr makes it for a search
   * and for RSS sync alike: the profile's format score must reach its minimum. A grab is recorded.
   */
  const tryGrab = (m: Json, by: "search" | "rss") => {
    if (m.monitored === false || m.hasFile) return;
    const profile = s.profiles.find((p) => p.id === Number(m.qualityProfileId));
    if (!profile) return;
    const title = `${String(m.title).replace(/\W+/g, ".")}.${String(m.year)}.1080p.WEB-DL.x264-GRP`;
    const score = formatsMatching(s.formats, title).reduce(
      (sum, f) =>
        sum +
        (Number(
          ((profile.formatItems as Json[]) ?? []).find((i) => Number(i.format) === f.id)?.score,
        ) || 0),
      0,
    );
    if (score >= Number(profile.minFormatScore ?? 0))
      grabs.push({ movieId: Number(m.id), profileId: Number(profile.id), by });
  };
  const core = servarrCore({
    app: "radarr",
    state: () => s,
    items: () => s.movies,
    root: "/movies",
    onCommand: (body) => {
      if (body.name === "MoviesSearch")
        for (const id of (body.movieIds as number[]) ?? []) {
          const m = s.movies.find((x) => x.id === id);
          if (m) {
            searches.push({ movieId: id, profileId: Number(m.qualityProfileId), on: "command" });
            tryGrab(m, "search");
          }
        }
      // RSS sync: every monitored movie still missing, searched or not.
      if (body.name === "RssSync") for (const m of s.movies) tryGrab(m, "rss");
      if (body.name !== "ManualImport") return;
      for (const f of (body.files as Json[]) ?? []) {
        const src = s.downloads.find((d) => d.path === f.path);
        const m = s.movies.find((x) => x.id === f.movieId);
        if (!src || !m) continue;
        const name = src.path.split("/").pop()!;
        const q =
          ((f.quality as Json | undefined)?.quality as Json | undefined) ?? QUALITIES[src.quality];
        m.hasFile = true;
        m.sizeOnDisk = src.size;
        m.movieFile = {
          id: nextId(),
          movieId: m.id,
          relativePath: name,
          path: `${String(m.path)}/${name}`,
          originalFilePath: src.path,
          size: src.size,
          dateAdded: iso(0),
          quality: { quality: q, revision: { version: 1, real: 0, isRepack: false } },
          customFormats: [],
          customFormatScore: 0,
          mediaInfo: {
            videoCodec: "x264",
            audioCodec: "AAC",
            audioChannels: 2,
            resolution: "1920x1080",
          },
        };
        if (body.importMode !== "copy") s.downloads = s.downloads.filter((d) => d !== src);
      }
    },
  });
  const nextId = () => ++s.nextId;
  const withMovie = (r: Json) => ({ ...r, movie: s.movies.find((m) => m.id === r.movieId) });
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
        { id: 1, path: "/movies", accessible: true, freeSpace: 1.2e12, unmappedFolders: [] },
      ]);
    // Radarr's own search for a movie to add (it asks TMDB), and adding one.
    if (p === "/api/v3/movie/lookup") {
      // As Radarr: "Title 2021" finds the title of that year.
      const term = (u.searchParams.get("term") ?? "").toLowerCase().replace(/\s+(19|20)\d\d$/, "");
      const hits = [...LOOKUP, ...s.movies.map((m) => ({ ...m }))].filter((m) =>
        String(m.title).toLowerCase().includes(term),
      );
      return reply(
        200,
        hits.map((m) => s.movies.find((x) => x.tmdbId === m.tmdbId) ?? { ...m, id: 0 }),
      );
    }
    if (p === "/api/v3/movie/lookup/tmdb") {
      const id = Number(u.searchParams.get("tmdbId"));
      const m = [...LOOKUP, ...s.movies].find((x) => x.tmdbId === id);
      return m ? reply(200, { ...m, id: 0 }) : reply(404, { message: "NotFound" });
    }
    if (p === "/api/v3/movie" && method === "POST") {
      if (s.movies.some((m) => m.tmdbId === body.tmdbId))
        return reply(400, [{ errorMessage: "This movie has already been added" }]);
      const id = nextId();
      const folder = `${String(body.title)} (${String(body.year)})`;
      const made: Json = {
        ...body,
        id,
        folderName: folder,
        path: `${String(body.rootFolderPath)}/${folder}`,
        hasFile: false,
        sizeOnDisk: 0,
        isAvailable: body.status === "released",
        added: iso(0),
        statistics: { movieFileCount: 0, sizeOnDisk: 0 },
      };
      // "Start search for missing movie": Radarr searches right away, with the profile it was added with.
      if ((body.addOptions as Json | undefined)?.searchForMovie)
        searches.push({ movieId: id, profileId: Number(body.qualityProfileId), on: "add" });
      delete made.addOptions;
      s.movies = [...s.movies, made];
      return reply(201, made);
    }

    // Movies.
    // The movie editor: several movies' profile (or monitoring) in one call (the Crucible, 11-17).
    if (p === "/api/v3/movie/editor" && method === "PUT") {
      const b = body as Json;
      const ids = new Set(((b.movieIds as number[]) ?? []).map(Number));
      for (const m of s.movies)
        if (ids.has(Number(m.id))) {
          if (b.qualityProfileId !== undefined) m.qualityProfileId = b.qualityProfileId;
          if (b.monitored !== undefined) m.monitored = b.monitored;
          // Tags, as the editor applies them: add, remove or replace.
          if (Array.isArray(b.tags)) {
            const have = new Set(((m.tags as number[]) ?? []).map(Number));
            const given = (b.tags as number[]).map(Number);
            m.tags =
              b.applyTags === "remove"
                ? [...have].filter((t) => !given.includes(t))
                : b.applyTags === "replace"
                  ? given
                  : [...new Set([...have, ...given])];
          }
        }
      return reply(
        202,
        s.movies.filter((m) => ids.has(Number(m.id))),
      );
    }
    if (p === "/api/v3/movie" && method === "GET") {
      const tmdb = u.searchParams.get("tmdbId");
      return reply(200, tmdb ? s.movies.filter((m) => String(m.tmdbId) === tmdb) : s.movies);
    }
    const movieOne = /^\/api\/v3\/movie\/(\d+)$/.exec(p);
    if (movieOne) {
      const id = Number(movieOne[1]);
      const m = s.movies.find((x) => x.id === id);
      if (!m) return reply(404, { message: "NotFound" });
      if (method === "GET") return reply(200, m);
      if (method === "PUT") {
        const next = { ...m, ...body, id, movieFile: m.movieFile, hasFile: m.hasFile };
        s.movies = s.movies.map((x) => (x.id === id ? next : x));
        return reply(202, next);
      }
      if (method === "DELETE") {
        s.movies = s.movies.filter((x) => x.id !== id);
        return reply(200, {});
      }
    }
    const fileOne = /^\/api\/v3\/moviefile\/(\d+)$/.exec(p);
    if (fileOne && method === "DELETE") {
      const id = Number(fileOne[1]);
      const m = s.movies.find((x) => (x.movieFile as Json | undefined)?.id === id);
      if (!m) return reply(404, { message: "NotFound" });
      const { movieFile: _gone, ...rest } = m;
      void _gone;
      s.movies = s.movies.map((x) =>
        x === m
          ? {
              ...rest,
              hasFile: false,
              sizeOnDisk: 0,
              statistics: { movieFileCount: 0, sizeOnDisk: 0 },
            }
          : x,
      );
      return reply(200, {});
    }
    if (p === "/api/v3/moviefile" && method === "GET") {
      const id = Number(u.searchParams.get("movieId"));
      const m = s.movies.find((x) => x.id === id);
      return reply(200, m?.movieFile ? [m.movieFile] : []);
    }

    // Activity and wanted.
    if (p === "/api/v3/history" && method === "GET") {
      const type = u.searchParams.get("eventType");
      const names: Record<string, string> = {
        "1": "grabbed",
        "3": "downloadFolderImported",
        "4": "downloadFailed",
        "6": "movieFileDeleted",
      };
      const list = type
        ? s.history.filter((h) => h.eventType === (names[type] ?? type))
        : s.history;
      const page = paged(list, u);
      return reply(200, { ...page, records: page.records.map(withMovie) });
    }
    if (p === "/api/v3/history/movie" && method === "GET") {
      const id = Number(u.searchParams.get("movieId"));
      return reply(
        200,
        s.history.filter((h) => h.movieId === id),
      );
    }
    if (p === "/api/v3/blocklist" && method === "GET") {
      const page = paged(s.blocklist, u);
      return reply(200, { ...page, records: page.records.map(withMovie) });
    }
    const blockOne = /^\/api\/v3\/blocklist\/(\d+)$/.exec(p);
    if (blockOne && method === "DELETE") {
      const id = Number(blockOne[1]);
      if (!s.blocklist.some((b) => b.id === id)) return reply(404, { message: "NotFound" });
      s.blocklist = s.blocklist.filter((b) => b.id !== id);
      return reply(200, {});
    }
    if (p === "/api/v3/wanted/missing")
      return reply(
        200,
        paged(
          s.movies.filter((m) => !m.hasFile && m.monitored && m.isAvailable),
          u,
        ),
      );
    if (p === "/api/v3/wanted/cutoff") {
      const below = s.movies.filter((m) => {
        const f = m.movieFile as Json | undefined;
        const prof = s.profiles.find((x) => x.id === m.qualityProfileId);
        if (!f || !prof || !m.monitored) return false;
        const qid = ((f.quality as Json).quality as Json).id as number;
        const order = (prof.items as Json[]).map((i) => (i.quality as Json).id);
        return order.indexOf(qid) < order.indexOf(prof.cutoff);
      });
      return reply(200, paged(below, u));
    }

    // The download queue: one downloading, one failed in the download client.
    if (p === "/api/v3/queue" && method === "GET") {
      const movie = (id: number) => s.movies.find((m) => m.id === id);
      const records = s.queue
        .filter((q) => movie(q.movieId as number))
        .map((q) => ({ ...q, movie: movie(q.movieId as number) }));
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
        s.movies.filter((m) => m.status !== "released"),
      );
    if (p === "/api/v3/collection")
      return reply(200, [
        {
          id: 1,
          title: "Meridian",
          tmdbId: 8800,
          monitored: true,
          movies: s.movies
            .filter((m) => (m.collection as Json | undefined)?.title === "Meridian")
            .map((m) => ({ tmdbId: m.tmdbId, title: m.title, year: m.year, isExisting: true })),
        },
      ]);
    // Manual import: files in a folder, with Radarr's guess of the movie and quality.
    if (p === "/api/v3/manualimport" && method === "GET") {
      const folder = u.searchParams.get("folder") ?? "";
      if (!folder) return reply(200, []);
      return reply(
        200,
        s.downloads
          .filter((f) => f.path.startsWith(folder.replace(/\/$/, "") + "/"))
          .map((f, i) => {
            const m = s.movies.find((x) => x.id === f.movieId);
            const name = f.path.split("/").pop()!;
            return {
              id: i + 1,
              path: f.path,
              relativePath: name,
              folderName: f.path.split("/").slice(-2, -1)[0],
              name: name.replace(/\.mkv$/, ""),
              size: f.size,
              ...(m ? { movie: m } : {}),
              quality: {
                quality: QUALITIES[f.quality],
                revision: { version: 1, real: 0, isRepack: false },
              },
              languages: [{ id: 1, name: "English" }],
              releaseGroup: "GRP",
              rejections: m ? [] : [{ reason: "Unknown Movie", type: "permanent" }],
            };
          }),
      );
    }
    if (p === "/api/v3/release" && method === "GET") {
      const id = Number(u.searchParams.get("movieId"));
      const m = s.movies.find((x) => x.id === id);
      if (!m) return reply(200, []);
      const base = `${String(m.title).replace(/\s+/g, ".")}.${String(m.year)}`;
      // Smart Quality's near miss (11-17): the missing movie's releases are all only over the
      // size limit.
      if (m.title === "Glass Meridian")
        return reply(
          200,
          [
            ["1080p.BluRay.x264-OLDIE", "Bluray-1080p", 8.9],
            ["1080p.BluRay.DTS.x264-CLASSIC", "Bluray-1080p", 11.2],
            ["1080p.WEB-DL.H264-RETRO", "WEBDL-1080p", 9.4],
          ].map(([rel, q, gbs], i) => ({
            guid: `stand-in-${id}-old-${i}`,
            indexerId: 1,
            indexer: "Stand-in Indexer",
            title: `${base}.${String(rel)}`,
            size: Math.round(Number(gbs) * GB),
            seeders: 4 + i,
            leechers: 1,
            protocol: "torrent",
            ageHours: 900 + i * 40,
            quality: { quality: { name: q } },
            customFormatScore: 0,
            approved: false,
            rejected: true,
            rejections: [
              {
                reason: `${String(gbs)} GiB is larger than maximum allowed 8 GiB`,
                type: "permanent",
              },
            ],
          })),
        );
      return reply(
        200,
        [
          ["1080p.BluRay.x264-GROUP", "Bluray-1080p", 9.1, 120, true, []],
          ["2160p.WEB-DL.x265-GROUP", "WEBDL-2160p", 16.4, 44, false, ["Not wanted in profile"]],
          [
            "720p.WEB-DL-FAKEGRP",
            "WEBDL-720p",
            2.2,
            3,
            false,
            ["Custom format score -1000 is below the minimum 0"],
          ],
        ].map(([rel, q, gbs, seeders, approved, rejections], i) => ({
          guid: `stand-in-${id}-${i}`,
          indexerId: 1,
          indexer: "Stand-in Indexer",
          title: `${base}.${String(rel)}`,
          size: Math.round(Number(gbs) * GB),
          seeders,
          leechers: 2,
          protocol: "torrent",
          ageHours: 30 + i * 12,
          quality: { quality: { name: q } },
          customFormatScore: i === 2 ? -1000 : 0,
          approved,
          rejected: !approved,
          rejections,
        })),
      );
    }

    // Radarr's own matcher for a release name (the custom format preview, D13).
    if (p === "/api/v3/parse") {
      const title = u.searchParams.get("title") ?? "";
      const formats = formatsMatching(s.formats, title);
      const score = scoreOf(s.profiles, formats);
      return reply(200, {
        title,
        parsedMovieInfo: {
          // As Radarr: the words before the year are the title.
          movieTitles: [
            (/^(.+?)[ .(]+(19|20)\d\d\b/.exec(title)?.[1] ?? title.split(".")[0]!).replace(
              /\./g,
              " ",
            ),
          ],
          year: Number(/\b(19|20)\d\d\b/.exec(title)?.[0] ?? 0),
        },
        ...(() => {
          const m = s.movies.find((x) =>
            title.toLowerCase().replace(/\./g, " ").startsWith(String(x.title).toLowerCase()),
          );
          return m ? { movie: m } : {};
        })(),
        customFormats: formats,
        customFormatScore: score,
      });
    }

    return reply(404, { message: "NotFound" });
  };

  return {
    fetch: fetchImpl,
    reset() {
      s = initialState();
      searches = [];
      grabs = [];
    },
    movies: () => s.movies,
    searches: () => searches,
    grabs: () => grabs,
  };
}
