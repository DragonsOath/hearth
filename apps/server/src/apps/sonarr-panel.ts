import {
  SHARED_VIEWS,
  ServarrReadError,
  episodeCode,
  historyRow,
  list,
  lookupsOf,
  needer,
  num,
  nums,
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
 * What the native Sonarr panel's own tabs read (native panels Phase 3): the series library, one
 * series with its seasons and episodes, Wanted (missing and below-cutoff episodes), Add a show,
 * Import files and the release-name check. Everything Sonarr shares with Radarr (history,
 * blocklist, profiles, formats, sizes, tags, naming, connections, system, logs, exclusions) is read
 * by servarr-panel.ts. Reading changes nothing; every change is a plan step, the same one Ember
 * plans.
 */

export const SONARR_VIEWS = [
  "library",
  "series",
  "missing",
  "cutoff",
  "parse",
  "lookup",
  "imports",
  ...SHARED_VIEWS,
] as const;
export type SonarrView = (typeof SONARR_VIEWS)[number];

const stats = (v: unknown) => {
  const s = obj(v);
  return {
    files: num(s.episodeFileCount) ?? 0,
    episodes: num(s.episodeCount) ?? 0,
    total: num(s.totalEpisodeCount) ?? 0,
    size: num(s.sizeOnDisk) ?? 0,
  };
};

/** One series as the Library tab lists it. */
export function seriesRow(m: Json) {
  const st = stats(m.statistics);
  return {
    id: num(m.id)!,
    title: str(m.title) ?? `Series #${String(m.id)}`,
    sortTitle: str(m.sortTitle) ?? str(m.title)?.toLowerCase() ?? "",
    year: num(m.year),
    status: str(m.status) ?? "continuing",
    network: str(m.network),
    monitored: m.monitored === true,
    profileId: num(m.qualityProfileId),
    seriesType: str(m.seriesType) ?? "standard",
    seasonFolder: m.seasonFolder !== false,
    tags: nums(m.tags),
    seasons: list(m.seasons).filter((s) => num(s.seasonNumber)! > 0).length,
    episodeFiles: st.files,
    episodes: st.episodes,
    totalEpisodes: st.total,
    sizeOnDisk: st.size,
    nextAiring: str(m.nextAiring),
    previousAiring: str(m.previousAiring),
    added: str(m.added),
    genres: strs(m.genres),
    rating: num(obj(m.ratings).value),
    poster: posterOf(m),
    path: str(m.path),
    tvdbId: num(m.tvdbId),
  };
}

/** One episode, as the series page and Wanted list it. */
function episodeRow(e: Json, file?: Json) {
  return {
    id: num(e.id)!,
    seriesId: num(e.seriesId),
    season: num(e.seasonNumber) ?? 0,
    number: num(e.episodeNumber) ?? 0,
    code: episodeCode(e) ?? "",
    title: str(e.title) ?? "",
    airDate: str(e.airDateUtc) ?? str(e.airDate),
    monitored: e.monitored === true,
    hasFile: e.hasFile === true,
    fileId: num(e.episodeFileId) || undefined,
    quality: file ? qualityOf(file).name : undefined,
    size: file ? (num(file.size) ?? 0) : undefined,
  };
}

export async function readSonarrView(
  get: ServarrGet,
  view: SonarrView,
  q: Record<string, string | undefined>,
): Promise<Json> {
  const need = needer("sonarr", get);
  const status = obj(await need("/api/v3/system/status", "its version"));
  if ((SHARED_VIEWS as readonly string[]).includes(view))
    return readSharedView("sonarr", get, view as SharedView, q, status);
  const meta = versionInfo(status, "sonarr");
  const lookups = () => lookupsOf("sonarr", get);

  switch (view as Exclude<SonarrView, SharedView>) {
    case "library": {
      const [series, look, roots] = await Promise.all([
        need("/api/v3/series", "its series"),
        lookups(),
        need("/api/v3/rootfolder", "its root folders"),
      ]);
      return {
        meta,
        series: list(series).map(seriesRow),
        ...look,
        rootFolders: list(roots).map((r) => ({
          path: str(r.path) ?? "",
          freeSpace: num(r.freeSpace),
        })),
      };
    }
    case "series": {
      const id = Number(q.id);
      if (!Number.isInteger(id) || id <= 0) throw new ServarrReadError("Say which series.");
      const [m, episodes, files, history, look] = await Promise.all([
        need(`/api/v3/series/${id}`, "that series"),
        need(`/api/v3/episode?seriesId=${id}`, "its episodes"),
        need(`/api/v3/episodefile?seriesId=${id}`, "its episode files"),
        get(`/api/v3/history/series?seriesId=${id}&includeEpisode=true`),
        lookups(),
      ]);
      const show = obj(m);
      const fileById = new Map(list(files).map((f) => [num(f.id), f]));
      const eps = list(episodes).map((e) => episodeRow(e, fileById.get(num(e.episodeFileId))));
      return {
        meta,
        series: {
          ...seriesRow(show),
          overview: str(show.overview),
          rootFolderPath: str(show.rootFolderPath),
          monitorNewItems: str(show.monitorNewItems),
        },
        seasons: list(show.seasons)
          .map((s) => {
            const n = num(s.seasonNumber) ?? 0;
            const st = stats(s.statistics);
            return {
              number: n,
              monitored: s.monitored === true,
              files: st.files,
              episodes: st.episodes,
              total: st.total,
              size: st.size,
            };
          })
          .sort((a, b) => b.number - a.number),
        episodes: eps.sort((a, b) => b.season - a.season || a.number - b.number),
        history: history.ok ? list(history.data).slice(0, 40).map(historyRow) : [],
        ...look,
      };
    }
    case "missing":
    case "cutoff": {
      const data = obj(
        await need(
          `/api/v3/wanted/${view}?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=airDateUtc&sortDirection=descending&includeSeries=true&monitored=true`,
          view === "missing" ? "its missing episodes" : "its episodes below cutoff",
        ),
      );
      return {
        meta,
        page: num(data.page) ?? 1,
        pageSize: PAGE_SIZE,
        total: num(data.totalRecords) ?? 0,
        records: list(data.records).map((e) => ({
          ...episodeRow(e),
          series: str(obj(e.series).title) ?? "?",
        })),
      };
    }
    case "imports": {
      const folder = String(q.folder ?? "")
        .trim()
        .slice(0, 500);
      if (!folder) throw new ServarrReadError("Say which folder to look in.");
      const [files, series] = await Promise.all([
        need(
          `/api/v3/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`,
          "the files in that folder",
        ),
        need("/api/v3/series", "its library"),
      ]);
      return {
        meta,
        folder,
        files: list(files)
          .slice(0, 200)
          .map((f) => {
            const m = obj(f.series);
            const eps = list(f.episodes);
            return {
              path: str(f.path) ?? "",
              name: str(f.relativePath) ?? str(f.name) ?? "?",
              size: num(f.size) ?? 0,
              seriesId: num(m.id) || undefined,
              series: str(m.title),
              season: num(f.seasonNumber),
              episodeIds: eps.map((e) => num(e.id)!).filter(Boolean),
              episodes: eps.map((e) => episodeCode(e) ?? "").filter(Boolean),
              quality: str(obj(obj(f.quality).quality).name),
              rejections: list(f.rejections)
                .map((r) => str(r.reason))
                .filter((r): r is string => Boolean(r)),
            };
          }),
        series: list(series)
          .map((m) => ({ id: num(m.id)!, title: str(m.title) ?? "?" }))
          .sort((a, b) => a.title.localeCompare(b.title)),
      };
    }
    case "lookup": {
      const term = String(q.title ?? "")
        .trim()
        .slice(0, 100);
      if (!term) throw new ServarrReadError("Type a show to look for.");
      const [found, look, roots] = await Promise.all([
        need(`/api/v3/series/lookup?term=${encodeURIComponent(term)}`, "its search"),
        lookups(),
        need("/api/v3/rootfolder", "its root folders"),
      ]);
      return {
        meta,
        results: list(found)
          .slice(0, 20)
          .map((m) => ({
            key: num(m.tvdbId)!,
            tvdbId: num(m.tvdbId)!,
            title: str(m.title) ?? "?",
            year: num(m.year) || undefined,
            overview: str(m.overview),
            network: str(m.network),
            seasons: list(m.seasons).filter((s) => num(s.seasonNumber)! > 0).length,
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
      if (!title) throw new ServarrReadError("Type a release name to check.");
      const data = obj(await need(`/api/v3/parse?title=${encodeURIComponent(title)}`, "its match"));
      const parsed = obj(data.parsedEpisodeInfo);
      const season = num(parsed.seasonNumber);
      const eps = list(parsed.episodeNumbers).map(Number);
      return {
        meta,
        title,
        matched: str(obj(data.series).title) ?? str(parsed.seriesTitle),
        episode:
          season !== undefined && eps.length
            ? `S${String(season).padStart(2, "0")}${eps.map((n) => `E${String(n).padStart(2, "0")}`).join("")}`
            : undefined,
        quality: str(obj(obj(parsed.quality).quality).name),
        formats: list(data.customFormats).map((f) => str(f.name) ?? ""),
        score: num(data.customFormatScore) ?? 0,
      };
    }
  }
}
