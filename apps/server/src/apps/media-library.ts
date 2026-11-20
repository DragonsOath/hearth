import type { CredentialBroker } from "../credentials/broker";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { episodeTitle, toQueueItem } from "./arr-live";
import { appOf } from "./service";

/**
 * Radarr movies and Plex library items, in depth, for investigating and
 * repairing one title (feature request 18: duplicates, re-grab loops,
 * upgrades). Every request goes through the credential broker to that
 * service's own address; nothing here returns a credential. Reads use
 * "read" access; changes are made only by media-operations.ts, as approved
 * plan steps, with "change" access.
 */

export interface RadarrQuality {
  quality?: { id?: number; name?: string; resolution?: number };
}
export interface RadarrFile {
  id: number;
  movieId?: number;
  /** Sonarr episode files. */
  seriesId?: number;
  relativePath?: string;
  path?: string;
  size?: number;
  quality?: RadarrQuality;
  customFormatScore?: number;
  dateAdded?: string;
}
export interface RadarrMovie {
  id: number;
  title: string;
  year?: number;
  monitored: boolean;
  qualityProfileId: number;
  hasFile?: boolean;
  path?: string;
  movieFile?: RadarrFile;
  [field: string]: unknown;
}
interface ProfileItem {
  id?: number;
  name?: string;
  quality?: { id?: number; name?: string };
  items?: ProfileItem[];
  allowed?: boolean;
}
export interface RadarrProfile {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items?: ProfileItem[];
  minFormatScore?: number;
  cutoffFormatScore?: number;
  [field: string]: unknown;
}
export interface SonarrSeries {
  id: number;
  title: string;
  year?: number;
  monitored: boolean;
  qualityProfileId: number;
  path?: string;
  [field: string]: unknown;
}
export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  monitored: boolean;
  hasFile?: boolean;
  episodeFileId?: number;
  series?: { title?: string };
  [field: string]: unknown;
}
interface HistoryRecord {
  date?: string;
  eventType?: string;
  sourceTitle?: string;
  quality?: RadarrQuality;
  customFormatScore?: number;
  data?: Record<string, string | undefined>;
}

export const gb = (bytes?: number) =>
  bytes === undefined ? undefined : Math.round((bytes / 1024 ** 3) * 100) / 100;

export const qualityName = (q?: RadarrQuality) => q?.quality?.name ?? "unknown quality";

/** The cutoff quality's name (the cutoff can be a single quality or a group). */
/** Sonarr's or Radarr's naming settings, as the API returns them. */
export type NamingConfig = { id?: number } & Record<string, unknown>;

/**
 * The naming settings an approved plan may change, one per step. Paths, root folders, and
 * anything outside naming are not here and cannot be changed this way.
 */
export const NAMING_SETTINGS: Record<
  string,
  { label: string; type: "boolean" | "format"; apps: ("sonarr" | "radarr")[] }
> = {
  renameEpisodes: { label: "Rename episodes", type: "boolean", apps: ["sonarr"] },
  standardEpisodeFormat: { label: "Episode file name", type: "format", apps: ["sonarr"] },
  dailyEpisodeFormat: { label: "Daily episode file name", type: "format", apps: ["sonarr"] },
  animeEpisodeFormat: { label: "Anime episode file name", type: "format", apps: ["sonarr"] },
  seriesFolderFormat: { label: "Series folder name", type: "format", apps: ["sonarr"] },
  seasonFolderFormat: { label: "Season folder name", type: "format", apps: ["sonarr"] },
  renameMovies: { label: "Rename movies", type: "boolean", apps: ["radarr"] },
  standardMovieFormat: { label: "Movie file name", type: "format", apps: ["radarr"] },
  movieFolderFormat: { label: "Movie folder name", type: "format", apps: ["radarr"] },
  replaceIllegalCharacters: {
    label: "Replace characters that are not allowed in file names",
    type: "boolean",
    apps: ["sonarr", "radarr"],
  },
};

export function cutoffName(p: RadarrProfile): string {
  const walk = (items: ProfileItem[] = []): string | undefined => {
    for (const i of items) {
      if ((i.quality?.id ?? i.id) === p.cutoff) return i.quality?.name ?? i.name;
      const inner = walk(i.items);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(p.items) ?? `quality #${p.cutoff}`;
}

const EVENT: Record<string, string> = {
  grabbed: "grabbed",
  downloadFolderImported: "imported",
  movieFileImported: "imported",
  movieFileDeleted: "file deleted",
  movieFileRenamed: "renamed",
  downloadFailed: "download failed",
  importFailed: "import failed",
  downloadIgnored: "ignored",
};

type Service = { id: string; name: string; localUrl: string; image?: string | null };

export class MediaLibrary {
  constructor(
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  /** One request to a Radarr or Sonarr with its API key. */
  async arr<T>(
    service: Service,
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    purpose: string,
    opts: { body?: unknown; by?: "agent" | "you" } = {},
  ): Promise<{ ok: boolean; status: number; data: T }> {
    return this.broker.use(
      {
        serviceId: service.id,
        purpose,
        access: method === "GET" ? "read" : "change",
        destination: joinUrl(service.localUrl, path),
        ...(opts.by ? { onBehalfOf: opts.by } : {}),
      },
      async ({ value }) => {
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(joinUrl(service.localUrl, path), {
            method,
            headers: {
              "X-Api-Key": value,
              Accept: "application/json",
              ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
            signal: AbortSignal.timeout(TIMEOUT_MS * 3),
          });
        } catch (error) {
          throw new AppUnreachableError(
            `${service.name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (res.status === 401 || res.status === 403)
          throw new AppKeyError(
            `${service.name} refused the API key. Check it in the Secure Vault.`,
          );
        const data = (await res.json().catch(() => undefined)) as T;
        return { ok: res.ok, status: res.status, data };
      },
    );
  }

  /** One request to Plex with its token (sent as a header, never in the URL). */
  async plex<T>(
    service: Service,
    method: "GET" | "DELETE",
    path: string,
    purpose: string,
    by?: "agent" | "you",
  ): Promise<{ ok: boolean; status: number; data: T }> {
    return this.broker.use(
      {
        serviceId: service.id,
        purpose,
        access: method === "GET" ? "read" : "change",
        destination: joinUrl(service.localUrl, path),
        ...(by ? { onBehalfOf: by } : {}),
      },
      async ({ value }) => {
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(joinUrl(service.localUrl, path), {
            method,
            headers: { Accept: "application/json", "X-Plex-Token": value },
            signal: AbortSignal.timeout(TIMEOUT_MS * 3),
          });
        } catch (error) {
          throw new AppUnreachableError(
            `${service.name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (res.status === 401)
          throw new AppKeyError(`${service.name} refused the token. Link Plex again.`);
        const data = (await res.json().catch(() => undefined)) as T;
        return { ok: res.ok, status: res.status, data };
      },
    );
  }

  /* ---------------- Radarr reads ---------------- */

  async movies(service: Service, by?: "agent" | "you"): Promise<RadarrMovie[]> {
    const r = await this.arr<RadarrMovie[]>(
      service,
      "GET",
      "/api/v3/movie",
      "read the movie list",
      { by },
    );
    if (!r.ok || !Array.isArray(r.data))
      throw new AppUnreachableError(`${service.name} answered ${r.status}.`);
    return r.data;
  }

  async movie(
    service: Service,
    movieId: number,
    by?: "agent" | "you",
  ): Promise<RadarrMovie | undefined> {
    const r = await this.arr<RadarrMovie>(
      service,
      "GET",
      `/api/v3/movie/${movieId}`,
      "read a movie",
      { by },
    );
    if (r.status === 404) return undefined;
    if (!r.ok) throw new AppUnreachableError(`${service.name} answered ${r.status}.`);
    return r.data;
  }

  async movieFiles(service: Service, movieId: number, by?: "agent" | "you"): Promise<RadarrFile[]> {
    const r = await this.arr<RadarrFile[]>(
      service,
      "GET",
      `/api/v3/moviefile?movieId=${movieId}`,
      "read a movie's files",
      { by },
    );
    return r.ok && Array.isArray(r.data) ? r.data : [];
  }

  /** Sonarr's or Radarr's naming settings (renaming on or off, file and folder formats). */
  async naming(service: Service, by?: "agent" | "you"): Promise<NamingConfig | undefined> {
    const r = await this.arr<NamingConfig>(
      service,
      "GET",
      "/api/v3/config/naming",
      "read naming settings",
      { by },
    );
    return r.ok && r.data && typeof r.data === "object" && !Array.isArray(r.data)
      ? r.data
      : undefined;
  }

  /** The naming settings Hearth can change, as the AI reads them. */
  async arrNaming(service: Service, app: "sonarr" | "radarr", by?: "agent" | "you") {
    const cfg = await this.naming(service, by);
    if (!cfg) throw new Error(`Could not read ${service.name}'s naming settings.`);
    return {
      settings: Object.entries(NAMING_SETTINGS)
        .filter(([key, spec]) => spec.apps.includes(app) && key in cfg)
        .map(([key, spec]) => ({ setting: key, label: spec.label, value: cfg[key] })),
      note: "Change one with the plan step app-arr-set-naming (params.setting, params.value: true or false for on/off settings, otherwise the format). Changes apply to files imported from now on; files already in the library keep their names.",
    };
  }

  async profile(
    service: Service,
    id: number,
    by?: "agent" | "you",
  ): Promise<RadarrProfile | undefined> {
    const r = await this.arr<RadarrProfile>(
      service,
      "GET",
      `/api/v3/qualityprofile/${id}`,
      "read a quality profile",
      { by },
    );
    return r.ok ? r.data : undefined;
  }

  /** Where Sonarr or Radarr puts deleted files, if anywhere. */
  async recycleBin(service: Service, by?: "agent" | "you"): Promise<string> {
    const r = await this.arr<{ recycleBin?: string; recycleBinCleanupDays?: number }>(
      service,
      "GET",
      "/api/v3/config/mediamanagement",
      "read where deleted files go",
      { by },
    ).catch(() => undefined);
    // Sonarr and Radarr share this: say which one (11-04, Sonarr's said "Radarr").
    const app =
      appOf({ name: service.name, image: service.image ?? null }) === "sonarr"
        ? "Sonarr"
        : "Radarr";
    if (!r?.ok) return `unknown (could not read ${app}'s media management settings)`;
    return r.data.recycleBin
      ? `${r.data.recycleBin} (emptied after ${r.data.recycleBinCleanupDays ?? "?"} days): a deleted file can be restored from there`
      : `none: ${app} deletes files permanently`;
  }

  /** Everything about one movie that explains grabs, upgrades, and copies on disk. */
  async movieReport(
    service: Service,
    q: { movieId?: number; title?: string },
    by?: "agent" | "you",
  ): Promise<Record<string, unknown>> {
    const all = await this.movies(service, by);
    let movie: RadarrMovie | undefined;
    if (q.movieId !== undefined) movie = all.find((m) => m.id === q.movieId);
    else if (q.title) {
      const t = q.title.trim().toLowerCase();
      const matches = all.filter((m) => m.title.toLowerCase().includes(t));
      const exact = matches.filter((m) => m.title.toLowerCase() === t);
      const pick = exact.length === 1 ? exact : matches;
      if (pick.length !== 1) {
        return pick.length
          ? {
              matches: pick
                .slice(0, 20)
                .map((m) => ({ movieId: m.id, title: m.title, year: m.year, hasFile: m.hasFile })),
              note: "Several movies match; ask again with movieId.",
            }
          : {
              matches: [],
              note: `${service.name} has no movie whose title contains "${q.title}".`,
            };
      }
      movie = pick[0];
    }
    if (!movie) return { note: `${service.name} has no such movie.` };
    const [files, history, profile, bin] = await Promise.all([
      this.movieFiles(service, movie.id, by),
      this.arr<HistoryRecord[]>(
        service,
        "GET",
        `/api/v3/history/movie?movieId=${movie.id}`,
        "read a movie's history",
        { by },
      ).catch(() => undefined),
      this.profile(service, movie.qualityProfileId, by),
      this.recycleBin(service, by),
    ]);
    // Files in the movie's folder that Radarr does not track (other copies, leftovers).
    const extra = movie.path
      ? await this.arr<
          {
            path?: string;
            size?: number;
            quality?: RadarrQuality;
            rejections?: { reason?: string }[];
          }[]
        >(
          service,
          "GET",
          `/api/v3/manualimport?folder=${encodeURIComponent(movie.path)}&filterExistingFiles=true&movieId=${movie.id}`,
          "list untracked files in a movie's folder",
          { by },
        ).catch(() => undefined)
      : undefined;
    return {
      movie: {
        movieId: movie.id,
        title: movie.title,
        year: movie.year,
        monitored: movie.monitored,
        folder: movie.path,
      },
      qualityProfile: profile
        ? {
            profileId: profile.id,
            name: profile.name,
            upgradesAllowed: profile.upgradeAllowed,
            upgradeUntil: cutoffName(profile),
            ...(profile.cutoffFormatScore !== undefined
              ? { upgradeUntilCustomFormatScore: profile.cutoffFormatScore }
              : {}),
            ...(profile.minFormatScore !== undefined
              ? { minimumCustomFormatScore: profile.minFormatScore }
              : {}),
            moviesUsingIt: all.filter((m) => m.qualityProfileId === profile.id).length,
          }
        : "could not be read",
      trackedFiles: files.map((f) => ({
        movieFileId: f.id,
        path: f.path ?? f.relativePath,
        sizeGB: gb(f.size),
        quality: qualityName(f.quality),
        ...(f.customFormatScore !== undefined ? { customFormatScore: f.customFormatScore } : {}),
        added: f.dateAdded,
      })),
      untrackedFilesInFolder:
        extra === undefined
          ? "could not be listed"
          : Array.isArray(extra.data)
            ? extra.data.map((x) => ({
                path: x.path,
                sizeGB: gb(x.size),
                quality: qualityName(x.quality),
                ...(x.rejections?.length
                  ? {
                      radarrSays: x.rejections
                        .map((r) => r.reason)
                        .filter(Boolean)
                        .join("; "),
                    }
                  : {}),
              }))
            : [],
      history: Array.isArray(history?.data)
        ? history.data
            .slice()
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .slice(0, 30)
            .map((h) => ({
              date: h.date,
              event: EVENT[h.eventType ?? ""] ?? h.eventType,
              release: h.sourceTitle,
              quality: qualityName(h.quality),
              ...(h.customFormatScore !== undefined
                ? { customFormatScore: h.customFormatScore }
                : {}),
              ...(h.data?.reason ? { reason: h.data.reason } : {}),
              ...(h.data?.indexer ? { indexer: h.data.indexer } : {}),
              ...(h.data?.downloadClient ? { downloadClient: h.data.downloadClient } : {}),
            }))
        : "could not be read",
      recycleBin: bin,
    };
  }

  /* ---------------- Sonarr reads ---------------- */

  async series(service: Service, by?: "agent" | "you"): Promise<SonarrSeries[]> {
    const r = await this.arr<SonarrSeries[]>(
      service,
      "GET",
      "/api/v3/series",
      "read the series list",
      { by },
    );
    if (!r.ok || !Array.isArray(r.data))
      throw new AppUnreachableError(`${service.name} answered ${r.status}.`);
    return r.data;
  }

  async oneSeries(
    service: Service,
    seriesId: number,
    by?: "agent" | "you",
  ): Promise<SonarrSeries | undefined> {
    const r = await this.arr<SonarrSeries>(
      service,
      "GET",
      `/api/v3/series/${seriesId}`,
      "read a series",
      { by },
    );
    return r.ok ? r.data : undefined;
  }

  async episode(
    service: Service,
    episodeId: number,
    by?: "agent" | "you",
  ): Promise<SonarrEpisode | undefined> {
    const r = await this.arr<SonarrEpisode>(
      service,
      "GET",
      `/api/v3/episode/${episodeId}`,
      "read an episode",
      { by },
    );
    return r.ok ? r.data : undefined;
  }

  async episodeFile(
    service: Service,
    fileId: number,
    by?: "agent" | "you",
  ): Promise<RadarrFile | undefined> {
    const r = await this.arr<RadarrFile>(
      service,
      "GET",
      `/api/v3/episodefile/${fileId}`,
      "read an episode file",
      { by },
    );
    return r.ok ? r.data : undefined;
  }

  /**
   * One series in Sonarr: its profile, and either one episode in depth (file, history), one
   * season's episodes, or a season summary with recent history.
   */
  async seriesReport(
    service: Service,
    q: { seriesId?: number; title?: string; season?: number; episode?: number },
    by?: "agent" | "you",
  ): Promise<Record<string, unknown>> {
    const all = await this.series(service, by);
    let s: SonarrSeries | undefined;
    if (q.seriesId !== undefined) s = all.find((x) => x.id === q.seriesId);
    else if (q.title) {
      const t = q.title.trim().toLowerCase();
      const matches = all.filter((x) => x.title.toLowerCase().includes(t));
      const exact = matches.filter((x) => x.title.toLowerCase() === t);
      const pick = exact.length === 1 ? exact : matches;
      if (pick.length !== 1)
        return pick.length
          ? {
              matches: pick
                .slice(0, 20)
                .map((x) => ({ seriesId: x.id, title: x.title, year: x.year })),
              note: "Several series match; ask again with seriesId.",
            }
          : {
              matches: [],
              note: `${service.name} has no series whose title contains "${q.title}".`,
            };
      s = pick[0];
    }
    if (!s) return { note: `${service.name} has no such series.` };
    const [episodes, files, profile] = await Promise.all([
      this.arr<SonarrEpisode[]>(
        service,
        "GET",
        `/api/v3/episode?seriesId=${s.id}`,
        "read a series' episodes",
        { by },
      ),
      this.arr<RadarrFile[]>(
        service,
        "GET",
        `/api/v3/episodefile?seriesId=${s.id}`,
        "read a series' files",
        { by },
      ),
      this.profile(service, s.qualityProfileId, by),
    ]);
    const eps = Array.isArray(episodes.data) ? episodes.data : [];
    const fileById = new Map((Array.isArray(files.data) ? files.data : []).map((f) => [f.id, f]));
    const fileOf = (e: SonarrEpisode) =>
      e.episodeFileId ? fileById.get(e.episodeFileId) : undefined;
    const epView = (e: SonarrEpisode) => {
      const f = fileOf(e);
      return {
        episodeId: e.id,
        number: `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`,
        title: e.title,
        monitored: e.monitored,
        ...(f
          ? {
              file: {
                episodeFileId: f.id,
                path: f.path ?? f.relativePath,
                sizeGB: gb(f.size),
                quality: qualityName(f.quality),
                ...(f.customFormatScore !== undefined
                  ? { customFormatScore: f.customFormatScore }
                  : {}),
              },
            }
          : { file: "none" }),
      };
    };
    const base = {
      series: {
        seriesId: s.id,
        title: s.title,
        year: s.year,
        monitored: s.monitored,
        folder: s.path,
      },
      qualityProfile: profile
        ? {
            profileId: profile.id,
            name: profile.name,
            upgradesAllowed: profile.upgradeAllowed,
            upgradeUntil: cutoffName(profile),
            ...(profile.cutoffFormatScore !== undefined
              ? { upgradeUntilCustomFormatScore: profile.cutoffFormatScore }
              : {}),
            seriesUsingIt: all.filter((x) => x.qualityProfileId === profile.id).length,
          }
        : "could not be read",
      recycleBin: await this.recycleBin(service, by),
    };
    const hist = async (path: string) => {
      const r = await this.arr<{ records?: HistoryRecord[] } | HistoryRecord[]>(
        service,
        "GET",
        path,
        "read history",
        { by },
      ).catch(() => undefined);
      const list = Array.isArray(r?.data) ? r.data : (r?.data?.records ?? []);
      return list
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 30)
        .map((h) => ({
          date: h.date,
          event: EVENT[h.eventType ?? ""] ?? h.eventType,
          release: h.sourceTitle,
          quality: qualityName(h.quality),
          ...(h.customFormatScore !== undefined ? { customFormatScore: h.customFormatScore } : {}),
          ...(h.data?.reason ? { reason: h.data.reason } : {}),
          ...(h.data?.indexer ? { indexer: h.data.indexer } : {}),
        }));
    };
    if (q.season !== undefined && q.episode !== undefined) {
      const e = eps.find((x) => x.seasonNumber === q.season && x.episodeNumber === q.episode);
      if (!e) return { ...base, note: `No episode S${q.season}E${q.episode}.` };
      return {
        ...base,
        episode: epView(e),
        history: await hist(`/api/v3/history?page=1&pageSize=50&episodeId=${e.id}`),
      };
    }
    if (q.season !== undefined) {
      return { ...base, episodes: eps.filter((e) => e.seasonNumber === q.season).map(epView) };
    }
    const seasons = [...new Set(eps.map((e) => e.seasonNumber))]
      .sort((a, b) => a - b)
      .map((n) => {
        const inSeason = eps.filter((e) => e.seasonNumber === n);
        return {
          season: n,
          episodes: inSeason.length,
          withFiles: inSeason.filter((e) => fileOf(e)).length,
          monitored: inSeason.filter((e) => e.monitored).length,
        };
      });
    return {
      ...base,
      seasons,
      history: await hist(`/api/v3/history/series?seriesId=${s.id}&includeEpisode=true`),
    };
  }

  /* ---------------- Sonarr/Radarr queue, missing, availability ---------------- */

  /**
   * The download queue with, for each stuck import, its files, where the app would put each,
   * and the app's own reasons it stopped. Read only.
   */
  async arrQueue(service: Service, app: "sonarr" | "radarr", by?: "agent" | "you") {
    const include =
      app === "sonarr" ? "includeSeries=true&includeEpisode=true" : "includeMovie=true";
    const q = await this.arr<{
      totalRecords?: number;
      records?: Parameters<typeof toQueueItem>[1][];
    }>(service, "GET", `/api/v3/queue?page=1&pageSize=100&${include}`, "read the download queue", {
      by,
    });
    const items = (q.data?.records ?? []).map((r) => toQueueItem(app, r));
    const out = [];
    for (const i of items) {
      if (!i.stuckImport || !i.downloadId) {
        out.push(i);
        continue;
      }
      const files = await this.arr<
        {
          path?: string;
          size?: number;
          series?: { title?: string };
          seasonNumber?: number;
          episodes?: { seasonNumber?: number; episodeNumber?: number }[];
          movie?: { title?: string; year?: number };
          quality?: RadarrQuality;
          rejections?: { reason?: string }[];
        }[]
      >(
        service,
        "GET",
        `/api/v3/manualimport?downloadId=${encodeURIComponent(i.downloadId)}&filterExistingFiles=false`,
        "read a stuck download's files",
        { by },
      ).catch(() => undefined);
      out.push({
        ...i,
        files: Array.isArray(files?.data)
          ? files.data.slice(0, 20).map((f) => ({
              path: f.path,
              sizeGB: gb(f.size),
              quality: qualityName(f.quality),
              wouldImportAs:
                app === "sonarr"
                  ? f.series && f.episodes?.length
                    ? f.episodes
                        .map((e) =>
                          episodeTitle(f.series, {
                            seasonNumber: e.seasonNumber ?? f.seasonNumber,
                            episodeNumber: e.episodeNumber,
                          }),
                        )
                        .join(", ")
                    : "unknown: the app cannot place it"
                  : f.movie
                    ? `${f.movie.title}${f.movie.year ? ` (${f.movie.year})` : ""}`
                    : "unknown: the app cannot place it",
              ...(f.rejections?.length
                ? { appSays: f.rejections.map((r) => r.reason).join("; ") }
                : {}),
            }))
          : "could not be read",
      });
    }
    return { total: q.data?.totalRecords ?? items.length, items: out };
  }

  async arrMissing(service: Service, app: "sonarr" | "radarr", by?: "agent" | "you") {
    const r = await this.arr<{
      totalRecords?: number;
      records?: {
        id: number;
        title?: string;
        year?: number;
        seasonNumber?: number;
        episodeNumber?: number;
        airDateUtc?: string;
        monitored?: boolean;
        series?: { title?: string };
      }[];
    }>(
      service,
      "GET",
      app === "sonarr"
        ? "/api/v3/wanted/missing?page=1&pageSize=50&sortKey=episodes.airDateUtc&sortDirection=descending&includeSeries=true"
        : "/api/v3/wanted/missing?page=1&pageSize=50&sortDirection=descending",
      "read missing items",
      { by },
    );
    return {
      total: r.data?.totalRecords ?? 0,
      items: (r.data?.records ?? []).map((m) =>
        app === "sonarr"
          ? {
              episodeId: m.id,
              title: episodeTitle(m.series, m),
              aired: m.airDateUtc,
              monitored: m.monitored,
            }
          : {
              movieId: m.id,
              title: `${m.title}${m.year ? ` (${m.year})` : ""}`,
              monitored: m.monitored,
            },
      ),
    };
  }

  /** Every quality profile with its upgrade settings and how many titles use it. */
  async arrProfiles(service: Service, app: "sonarr" | "radarr", by?: "agent" | "you") {
    const [profiles, titles] = await Promise.all([
      this.arr<RadarrProfile[]>(service, "GET", "/api/v3/qualityprofile", "read quality profiles", {
        by,
      }),
      this.arr<{ qualityProfileId: number; monitored: boolean; hasFile?: boolean }[]>(
        service,
        "GET",
        app === "sonarr" ? "/api/v3/series" : "/api/v3/movie",
        "read titles per profile",
        { by },
      ),
    ]);
    const list = Array.isArray(titles.data) ? titles.data : [];
    return {
      profiles: (Array.isArray(profiles.data) ? profiles.data : []).map((p) => ({
        profileId: p.id,
        name: p.name,
        upgradesAllowed: p.upgradeAllowed,
        upgradeUntil: cutoffName(p),
        ...(p.cutoffFormatScore !== undefined
          ? { upgradeUntilCustomFormatScore: p.cutoffFormatScore }
          : {}),
        titlesUsingIt: list.filter((t) => t.qualityProfileId === p.id).length,
      })),
      ...(app === "radarr"
        ? { monitoredMoviesYouAlreadyHave: list.filter((t) => t.monitored && t.hasFile).length }
        : {}),
    };
  }

  /** What the indexers offer for one episode or movie right now. Downloads nothing. */
  async arrReleases(
    service: Service,
    app: "sonarr" | "radarr",
    q: { episodeId?: number; movieId?: number },
    by?: "agent" | "you",
  ) {
    const path =
      app === "sonarr"
        ? `/api/v3/release?episodeId=${q.episodeId}`
        : `/api/v3/release?movieId=${q.movieId}`;
    const r = await this.arr<
      {
        title?: string;
        indexer?: string;
        size?: number;
        seeders?: number;
        leechers?: number;
        protocol?: string;
        ageHours?: number;
        quality?: RadarrQuality;
        customFormatScore?: number;
        approved?: boolean;
        rejected?: boolean;
        rejections?: string[];
      }[]
    >(service, "GET", path, "search indexers for one item (no download)", { by });
    const list = Array.isArray(r.data) ? r.data : [];
    return {
      found: list.length,
      accepted: list.filter((x) => x.approved).length,
      releases: list.slice(0, 25).map((x) => ({
        release: x.title,
        indexer: x.indexer,
        sizeGB: gb(x.size),
        quality: qualityName(x.quality),
        ...(x.protocol === "torrent" ? { seeders: x.seeders ?? 0 } : {}),
        ...(x.customFormatScore !== undefined ? { customFormatScore: x.customFormatScore } : {}),
        accepted: Boolean(x.approved),
        ...(x.rejections?.length ? { whyNot: x.rejections.join("; ") } : {}),
      })),
    };
  }

  /* ---------------- Plex reads ---------------- */

  /** Movies (or shows) in Plex whose title contains the text, with every version on disk. */
  async plexItems(service: Service, title: string, by?: "agent" | "you") {
    type Part = { file?: string; size?: number };
    type Media = {
      id: number;
      videoResolution?: string;
      bitrate?: number;
      videoCodec?: string;
      container?: string;
      Part?: Part[];
    };
    type Meta = { ratingKey: string; title: string; year?: number; type?: string; Media?: Media[] };
    const sections = await this.plex<{
      MediaContainer?: { Directory?: { key: string; type?: string; title?: string }[] };
    }>(service, "GET", "/library/sections", "list Plex libraries", by);
    const movieSections = (sections.data?.MediaContainer?.Directory ?? []).filter(
      (d) => d.type === "movie",
    );
    const found: Meta[] = [];
    for (const s of movieSections) {
      const r = await this.plex<{ MediaContainer?: { Metadata?: Meta[] } }>(
        service,
        "GET",
        `/library/sections/${encodeURIComponent(s.key)}/all?type=1&title=${encodeURIComponent(title)}`,
        "find a title in Plex",
        by,
      );
      found.push(...(r.data?.MediaContainer?.Metadata ?? []));
    }
    const prefs = await this.plex<{
      MediaContainer?: { Setting?: { id: string; value?: unknown }[] };
    }>(service, "GET", "/:/prefs", "read whether Plex allows deleting media", by).catch(
      () => undefined,
    );
    const allow = prefs?.data?.MediaContainer?.Setting?.find(
      (x) => x.id === "allowMediaDeletion",
    )?.value;
    return {
      items: found.slice(0, 20).map((m) => ({
        ratingKey: m.ratingKey,
        title: m.title,
        year: m.year,
        versions: (m.Media ?? []).map((v) => ({
          mediaId: v.id,
          resolution: v.videoResolution,
          videoCodec: v.videoCodec,
          bitrateKbps: v.bitrate,
          files: (v.Part ?? []).map((p) => ({ path: p.file, sizeGB: gb(p.size) })),
        })),
      })),
      plexAllowsDeletingMedia:
        allow === undefined ? "unknown" : allow === true || allow === "1" || allow === 1,
    };
  }

  async plexMeta(service: Service, ratingKey: string, by?: "agent" | "you") {
    const r = await this.plex<{
      MediaContainer?: {
        Metadata?: {
          ratingKey: string;
          title: string;
          year?: number;
          Media?: {
            id: number;
            videoResolution?: string;
            Part?: { file?: string; size?: number }[];
          }[];
        }[];
      };
    }>(
      service,
      "GET",
      `/library/metadata/${encodeURIComponent(ratingKey)}`,
      "read a Plex item",
      by,
    );
    return r.status === 404 ? undefined : r.data?.MediaContainer?.Metadata?.[0];
  }

  async plexAllowsDeletion(service: Service): Promise<boolean | undefined> {
    const prefs = await this.plex<{
      MediaContainer?: { Setting?: { id: string; value?: unknown }[] };
    }>(service, "GET", "/:/prefs", "read whether Plex allows deleting media").catch(
      () => undefined,
    );
    const v = prefs?.data?.MediaContainer?.Setting?.find(
      (x) => x.id === "allowMediaDeletion",
    )?.value;
    return v === undefined ? undefined : v === true || v === "1" || v === 1;
  }
}
