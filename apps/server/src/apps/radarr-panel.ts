import {
  SHARED_VIEWS,
  ServarrReadError,
  historyRow,
  list,
  lookupsOf,
  needer,
  nums,
  num,
  obj,
  page,
  PAGE_SIZE,
  posterOf,
  qualityOf,
  readSharedView,
  str,
  strs,
  versionInfo,
  type Json,
  type ServarrGet,
  type SharedView,
} from "./servarr-panel";

/**
 * What the native Radarr panel's tabs read (checklist 46.9): Library, a movie's details, Wanted
 * (missing, below cutoff), Add a movie, Import files and the release-name check. Everything Radarr
 * shares with Sonarr (history, blocklist, profiles, formats, sizes, tags, naming, connections,
 * system, logs, exclusions) is read by servarr-panel.ts. Reading changes nothing; every change is
 * a plan step (arr-resource-operations.ts), the same one Ember plans.
 */

export type RadarrGet = ServarrGet;
export { posterOf, versionInfo };
export const RadarrReadError = ServarrReadError;

export const RADARR_VIEWS = [
  "library",
  "movie",
  "missing",
  "cutoff",
  "parse",
  "lookup",
  "imports",
  ...SHARED_VIEWS,
] as const;
export type RadarrView = (typeof RADARR_VIEWS)[number];

/** One movie as the Library tab lists it. */
export function movieRow(m: Json) {
  const file = m.movieFile ? obj(m.movieFile) : undefined;
  const q = qualityOf(file);
  const media = obj(file?.mediaInfo);
  const imdb = obj(obj(m.ratings).imdb);
  const tmdb = obj(obj(m.ratings).tmdb);
  return {
    id: num(m.id)!,
    title: str(m.title) ?? `Movie #${String(m.id)}`,
    sortTitle: str(m.sortTitle) ?? str(m.title)?.toLowerCase() ?? "",
    year: num(m.year),
    status: str(m.status) ?? "released",
    monitored: m.monitored === true,
    hasFile: m.hasFile === true,
    isAvailable: m.isAvailable === true,
    profileId: num(m.qualityProfileId),
    minimumAvailability: str(m.minimumAvailability),
    tags: nums(m.tags),
    sizeOnDisk: num(m.sizeOnDisk) ?? num(obj(m.statistics).sizeOnDisk) ?? 0,
    quality: q.name,
    resolution: q.resolution,
    codec: str(media.videoCodec),
    hdr: str(media.videoDynamicRangeType) || undefined,
    added: str(m.added),
    genres: strs(m.genres),
    rating: num(imdb.value) ?? num(tmdb.value),
    collection: str(obj(m.collection).title),
    poster: posterOf(m),
    path: str(m.path),
    tmdbId: num(m.tmdbId),
  };
}
export type RadarrMovieRow = ReturnType<typeof movieRow>;

export async function readRadarrView(
  get: RadarrGet,
  view: RadarrView,
  q: Record<string, string | undefined>,
): Promise<Json> {
  const need = needer("radarr", get);
  const status = obj(await need("/api/v3/system/status", "its version"));
  if ((SHARED_VIEWS as readonly string[]).includes(view))
    return readSharedView("radarr", get, view as SharedView, q, status);
  const meta = versionInfo(status, "radarr");
  const lookups = () => lookupsOf("radarr", get);

  switch (view as Exclude<RadarrView, SharedView>) {
    case "library": {
      const [movies, look, roots] = await Promise.all([
        need("/api/v3/movie", "its movies"),
        lookups(),
        need("/api/v3/rootfolder", "its root folders"),
      ]);
      return {
        meta,
        movies: list(movies).map(movieRow),
        ...look,
        rootFolders: list(roots).map((r) => ({
          path: str(r.path) ?? "",
          freeSpace: num(r.freeSpace),
        })),
      };
    }
    case "movie": {
      const id = Number(q.id);
      if (!Number.isInteger(id) || id <= 0) throw new RadarrReadError("Say which movie.");
      const [m, history, look] = await Promise.all([
        need(`/api/v3/movie/${id}`, "that movie"),
        get(`/api/v3/history/movie?movieId=${id}`),
        lookups(),
      ]);
      const movie = obj(m);
      const file = movie.movieFile ? obj(movie.movieFile) : undefined;
      const media = obj(file?.mediaInfo);
      return {
        meta,
        movie: {
          ...movieRow(movie),
          overview: str(movie.overview),
          runtime: num(movie.runtime),
          studio: str(movie.studio),
          certification: str(movie.certification),
          inCinemas: str(movie.inCinemas),
          digitalRelease: str(movie.digitalRelease),
          physicalRelease: str(movie.physicalRelease),
          imdbId: str(movie.imdbId),
          rootFolderPath: str(movie.rootFolderPath),
        },
        file: file
          ? {
              id: num(file.id)!,
              path: str(file.relativePath) ?? str(file.path),
              size: num(file.size) ?? 0,
              added: str(file.dateAdded),
              quality: qualityOf(file).name,
              formats: list(file.customFormats).map((f) => str(f.name) ?? ""),
              score: num(file.customFormatScore) ?? 0,
              video: [
                str(media.videoCodec),
                str(media.resolution),
                str(media.videoDynamicRangeType),
              ]
                .filter(Boolean)
                .join(" "),
              audio: [str(media.audioCodec), num(media.audioChannels)].filter(Boolean).join(" "),
            }
          : null,
        history: history.ok ? list(history.data).slice(0, 40).map(historyRow) : [],
        ...look,
      };
    }
    case "missing":
    case "cutoff": {
      const data = obj(
        await need(
          `/api/v3/wanted/${view}?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=movieMetadata.sortTitle&sortDirection=ascending&monitored=true`,
          view === "missing" ? "its missing movies" : "its movies below cutoff",
        ),
      );
      const look = await lookups();
      return {
        meta,
        page: num(data.page) ?? 1,
        pageSize: PAGE_SIZE,
        total: num(data.totalRecords) ?? 0,
        records: list(data.records).map(movieRow),
        profiles: look.profiles,
      };
    }
    case "imports": {
      // Files in a folder Radarr has not imported, with Radarr's own guess of movie and quality.
      const folder = String(q.folder ?? "")
        .trim()
        .slice(0, 500);
      if (!folder) throw new RadarrReadError("Say which folder to look in.");
      const [files, movies] = await Promise.all([
        need(
          `/api/v3/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`,
          "the files in that folder",
        ),
        need("/api/v3/movie", "its library"),
      ]);
      return {
        meta,
        folder,
        files: list(files)
          .slice(0, 200)
          .map((f) => {
            const m = obj(f.movie);
            return {
              path: str(f.path) ?? "",
              name: str(f.relativePath) ?? str(f.name) ?? "?",
              size: num(f.size) ?? 0,
              movieId: num(m.id) || undefined,
              movie: str(m.title)
                ? `${str(m.title)}${num(m.year) ? ` (${num(m.year)})` : ""}`
                : undefined,
              quality: str(obj(obj(f.quality).quality).name),
              rejections: list(f.rejections)
                .map((r) => str(r.reason))
                .filter((r): r is string => Boolean(r)),
            };
          }),
        movies: list(movies)
          .map((m) => ({
            id: num(m.id)!,
            title: `${str(m.title) ?? "?"}${num(m.year) ? ` (${num(m.year)})` : ""}`,
          }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      };
    }
    case "lookup": {
      const term = String(q.title ?? "")
        .trim()
        .slice(0, 100);
      if (!term) throw new RadarrReadError("Type a movie to look for.");
      const [found, look, roots] = await Promise.all([
        need(`/api/v3/movie/lookup?term=${encodeURIComponent(term)}`, "its search"),
        lookups(),
        need("/api/v3/rootfolder", "its root folders"),
      ]);
      return {
        meta,
        results: list(found)
          .slice(0, 20)
          .map((m) => ({
            key: num(m.tmdbId)!,
            tmdbId: num(m.tmdbId)!,
            title: str(m.title) ?? "?",
            year: num(m.year) || undefined,
            // For the Crucible's row (which profile a new movie gets): genres and popularity.
            genres: Array.isArray(m.genres) ? (m.genres as string[]) : [],
            popularity: num(m.popularity),
            overview: str(m.overview),
            poster: posterOf(m),
            inLibrary: (num(m.id) ?? 0) > 0,
            libraryId: (num(m.id) ?? 0) > 0 ? num(m.id) : undefined,
          })),
        ...look,
        rootFolders: list(roots).map((r) => ({
          path: str(r.path) ?? "",
          freeSpace: num(r.freeSpace),
        })),
      };
    }
    case "parse": {
      const title = String(q.title ?? "")
        .trim()
        .slice(0, 300);
      if (!title) throw new RadarrReadError("Type a release name to check.");
      const data = obj(await need(`/api/v3/parse?title=${encodeURIComponent(title)}`, "its match"));
      const parsed = obj(data.parsedMovieInfo);
      const name = str(obj(data.movie).title) ?? list(parsed.movieTitles).map(String)[0];
      return {
        meta,
        title,
        matched: name,
        year: num(parsed.year) || undefined,
        quality: str(obj(obj(parsed.quality).quality).name),
        formats: list(data.customFormats).map((f) => str(f.name) ?? ""),
        score: num(data.customFormatScore) ?? 0,
      };
    }
  }
}
