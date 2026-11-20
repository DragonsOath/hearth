import { downloadTrails } from "./arr-trail";
import type {
  MovieItem,
  RadarrLibrary,
  ArrDashboard,
  ArrHistoryEvent,
  ArrMissing,
  ArrQueueItem,
  ArrUpcoming,
} from "@dragon-control/core";
import { getJson, type Fetch } from "./http";
import {
  LIBRARY_MS,
  findMovies,
  radarrLibrary,
  type RawCollection,
  type RawMovie,
  type RawRoot,
} from "./radarr-library";

/**
 * Sonarr's and Radarr's live dashboards (feature request 7), read only: totals, the download
 * queue with what is stuck and why, missing (wanted) items, the next week's releases, recent
 * imports, and the app's own health. The full series or movie list is large, so totals are read
 * at most every TOTALS_MS; everything else on each refresh.
 */

const TOTALS_MS = 5 * 60_000;

interface RawQueue {
  id: number;
  downloadId?: string;
  title?: string;
  seriesId?: number;
  episodeId?: number;
  movieId?: number;
  series?: { title?: string };
  episode?: { seasonNumber?: number; episodeNumber?: number; title?: string; hasFile?: boolean };
  movie?: { title?: string; year?: number; hasFile?: boolean };
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  errorMessage?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  downloadClient?: string;
  indexer?: string;
  protocol?: string;
  /** Where the download client put it (the app's own report, a path as the app sees it). */
  outputPath?: string;
}

const pad = (n?: number) => String(n ?? 0).padStart(2, "0");

export function episodeTitle(
  series?: { title?: string },
  e?: { seasonNumber?: number; episodeNumber?: number },
) {
  return `${series?.title ?? "A series"}${e ? ` S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}` : ""}`;
}

const movieTitle = (m?: { title?: string; year?: number }) =>
  `${m?.title ?? "A movie"}${m?.year ? ` (${m.year})` : ""}`;

const STUCK = new Set(["importPending", "importBlocked", "importFailed", "failedPending"]);
const FAILED_STATES = new Set(["failed", "failedPending"]);

/** Failed in the download client: a failed repair, an aborted job. */
export const isFailedDownload = (r: { status?: string; trackedDownloadState?: string }) =>
  r.status === "failed" || FAILED_STATES.has(r.trackedDownloadState ?? "");

/** The app says it did not grab this itself, so it never clears it or tries another release. */
const notGrabbedByApp = (r: RawQueue) =>
  (r.statusMessages ?? []).some((m) =>
    (m.messages ?? []).some((x) => /wasn't grabbed by/i.test(x)),
  );

export function toQueueItem(app: "sonarr" | "radarr", r: RawQueue): ArrQueueItem {
  const messages = [
    r.errorMessage,
    ...(r.statusMessages ?? []).flatMap((m) =>
      (m.messages ?? []).map((x) => (m.title && m.title !== r.title ? `${m.title}: ${x}` : x)),
    ),
  ].filter((x): x is string => Boolean(x));
  const troubled = r.trackedDownloadStatus === "warning" || r.trackedDownloadStatus === "error";
  const done = r.sizeleft === 0 || r.status === "completed";
  const failed = isFailedDownload(r);
  const name = app === "sonarr" ? "Sonarr" : "Radarr";
  const problem = failed
    ? [
        (r.errorMessage?.trim() || "The download client could not finish it").replace(
          /[^.!?]$/,
          "$&.",
        ),
        notGrabbedByApp(r)
          ? `${name} did not grab this download itself, so it will not clear it or try another release on its own.`
          : undefined,
      ]
        .filter(Boolean)
        .join(" ")
    : troubled || messages.length
      ? messages.join(" ") || "Needs attention."
      : undefined;
  const progressPct =
    !failed && r.size && r.sizeleft !== undefined
      ? Math.max(0, Math.min(100, Math.round(((r.size - r.sizeleft) / r.size) * 1000) / 10))
      : undefined;
  return {
    queueId: r.id,
    ...(r.downloadId ? { downloadId: r.downloadId } : {}),
    title: app === "sonarr" ? episodeTitle(r.series, r.episode) : movieTitle(r.movie),
    ...(r.title ? { release: r.title } : {}),
    ...(r.seriesId !== undefined ? { seriesId: r.seriesId } : {}),
    ...(r.episodeId !== undefined ? { episodeId: r.episodeId } : {}),
    ...(r.movieId !== undefined ? { movieId: r.movieId } : {}),
    status: r.status ?? "queued",
    ...(r.trackedDownloadState ? { state: r.trackedDownloadState } : {}),
    ...(progressPct !== undefined ? { progressPct } : {}),
    ...(r.size !== undefined ? { sizeBytes: r.size } : {}),
    ...(r.timeleft ? { timeLeft: r.timeleft } : {}),
    ...(r.downloadClient ? { client: r.downloadClient } : {}),
    ...(r.indexer ? { indexer: r.indexer } : {}),
    ...(r.protocol ? { protocol: r.protocol } : {}),
    ...(r.outputPath ? { outputPath: r.outputPath } : {}),
    ...(problem ? { problem } : {}),
    stuckImport: !failed && done && troubled && STUCK.has(r.trackedDownloadState ?? ""),
    ...(failed ? { failed: true } : {}),
    ...((app === "sonarr" ? r.episode?.hasFile : r.movie?.hasFile) ? { onDisk: true } : {}),
  };
}

export class ArrLive {
  private totals = new Map<string, { at: number; titles: number; monitored: number }>();
  private libraries = new Map<
    string,
    { at: number; library: RadarrLibrary; index: MovieItem[]; refreshing?: Promise<void> }
  >();

  constructor(private readonly fetchImpl: Fetch) {}

  /**
   * Radarr's library summary, read at most every LIBRARY_MS. A stale one is shown while a fresh
   * one is read in the background, so the panel never waits on Radarr's large movie list twice.
   */
  private async libraryOf(serviceId: string, get: <T>(path: string) => Promise<T>) {
    const read = async () => {
      const [movies, cutoff, collections, roots] = await Promise.all([
        get<RawMovie[]>("/api/v3/movie"),
        get<{ records?: { id: number }[] }>(
          "/api/v3/wanted/cutoff?page=1&pageSize=10000&monitored=true",
        ).catch(() => ({ records: [] })),
        get<RawCollection[]>("/api/v3/collection").catch(() => []),
        get<RawRoot[]>("/api/v3/rootfolder").catch(() => []),
      ]);
      const below = new Set((cutoff.records ?? []).map((r) => r.id));
      const { library, index } = radarrLibrary(movies, below, collections, roots, new Date());
      this.libraries.set(serviceId, { at: Date.now(), library, index });
    };
    const have = this.libraries.get(serviceId);
    if (!have) {
      await read();
    } else if (Date.now() - have.at > LIBRARY_MS && !have.refreshing) {
      have.refreshing = read()
        .catch(() => undefined)
        .finally(() => {
          have.refreshing = undefined;
        });
    }
    return this.libraries.get(serviceId)?.library;
  }

  /** Movies in Radarr by title, from the library last read (the panel reads it first). */
  async findMovies(
    serviceId: string,
    base: string,
    key: string,
    q: string,
  ): Promise<{ at?: string; movies: MovieItem[] }> {
    if (!this.libraries.has(serviceId)) {
      const get = <T>(path: string) => getJson<T>(this.fetchImpl, "Radarr", base, path, key);
      await this.libraryOf(serviceId, get);
    }
    const lib = this.libraries.get(serviceId);
    return { ...(lib ? { at: lib.library.at } : {}), movies: findMovies(lib?.index ?? [], q) };
  }

  async dashboard(
    serviceId: string,
    app: "sonarr" | "radarr",
    base: string,
    key: string,
  ): Promise<ArrDashboard> {
    const name = app === "sonarr" ? "Sonarr" : "Radarr";
    const get = <T>(path: string) => getJson<T>(this.fetchImpl, name, base, path, key);
    const include =
      app === "sonarr" ? "includeSeries=true&includeEpisode=true" : "includeMovie=true";
    const now = new Date();
    const week = new Date(now.getTime() + 7 * 86_400_000);
    const [status, health, queue, missing, calendar, history] = await Promise.all([
      get<{ version?: string }>("/api/v3/system/status"),
      get<{ type?: string; message?: string; source?: string }[]>("/api/v3/health"),
      get<{ totalRecords?: number; records?: RawQueue[] }>(
        `/api/v3/queue?page=1&pageSize=100&${include}`,
      ),
      get<{
        totalRecords?: number;
        records?: {
          id: number;
          title?: string;
          year?: number;
          seriesId?: number;
          seasonNumber?: number;
          episodeNumber?: number;
          airDateUtc?: string;
          monitored?: boolean;
          series?: { title?: string };
        }[];
      }>(
        app === "sonarr"
          ? "/api/v3/wanted/missing?page=1&pageSize=30&sortKey=episodes.airDateUtc&sortDirection=descending&includeSeries=true"
          : "/api/v3/wanted/missing?page=1&pageSize=30&sortDirection=descending",
      ).catch(() => ({ totalRecords: 0, records: [] })),
      get<
        {
          title?: string;
          year?: number;
          airDateUtc?: string;
          inCinemas?: string;
          digitalRelease?: string;
          physicalRelease?: string;
          hasFile?: boolean;
          seasonNumber?: number;
          episodeNumber?: number;
          series?: { title?: string };
        }[]
      >(
        `/api/v3/calendar?start=${encodeURIComponent(now.toISOString())}&end=${encodeURIComponent(week.toISOString())}${app === "sonarr" ? "&includeSeries=true" : ""}`,
      ).catch(() => []),
      get<{
        records?: {
          date?: string;
          eventType?: string;
          sourceTitle?: string;
          downloadId?: string;
          data?: Record<string, string | undefined>;
          quality?: { quality?: { name?: string } };
          series?: { title?: string };
          episode?: { seasonNumber?: number; episodeNumber?: number };
          movie?: { title?: string; year?: number };
        }[];
      }>(
        `/api/v3/history?page=1&pageSize=100&sortKey=date&sortDirection=descending&${include}`,
      ).catch(() => ({ records: [] })),
    ]);

    const library =
      app === "radarr" ? await this.libraryOf(serviceId, get).catch(() => undefined) : undefined;

    let totals = this.totals.get(serviceId);
    if (!totals || Date.now() - totals.at > TOTALS_MS) {
      const all = await get<{ monitored?: boolean }[]>(
        app === "sonarr" ? "/api/v3/series" : "/api/v3/movie",
      ).catch(() => undefined);
      if (all) {
        totals = {
          at: Date.now(),
          titles: all.length,
          monitored: all.filter((x) => x.monitored).length,
        };
        this.totals.set(serviceId, totals);
      }
    }

    const items = (queue.records ?? []).map((r) => toQueueItem(app, r));
    const missingItems: ArrMissing[] = (missing.records ?? []).map((m) =>
      app === "sonarr"
        ? {
            title: episodeTitle(m.series, m),
            ...(m.seriesId !== undefined ? { seriesId: m.seriesId } : {}),
            episodeId: m.id,
            ...(m.airDateUtc ? { airedAt: m.airDateUtc } : {}),
            monitored: m.monitored ?? true,
          }
        : { title: movieTitle(m), movieId: m.id, monitored: m.monitored ?? true },
    );
    const upcoming: ArrUpcoming[] = (Array.isArray(calendar) ? calendar : [])
      .map((c) => ({
        title: app === "sonarr" ? episodeTitle(c.series, c) : movieTitle(c),
        ...((c.airDateUtc ?? c.digitalRelease ?? c.physicalRelease ?? c.inCinemas)
          ? { at: c.airDateUtc ?? c.digitalRelease ?? c.physicalRelease ?? c.inCinemas }
          : {}),
        hasFile: Boolean(c.hasFile),
      }))
      .slice(0, 20);
    const recent = (history.records ?? [])
      .filter((h) => /Imported$/.test(h.eventType ?? ""))
      .slice(0, 10)
      .map((h) => ({
        title: app === "sonarr" ? episodeTitle(h.series, h.episode) : movieTitle(h.movie),
        ...(h.date ? { at: h.date } : {}),
        event: "Imported",
        ...(h.quality?.quality?.name ? { quality: h.quality.quality.name } : {}),
      }));

    // Journeys: each event with what ties it together (downloadId) and where files went.
    const EVENT: Record<string, ArrHistoryEvent["event"]> = {
      grabbed: "grabbed",
      downloadFolderImported: "imported",
      downloadFailed: "failed",
      importFailed: "failed",
      downloadIgnored: "ignored",
      movieFileDeleted: "deleted",
      episodeFileDeleted: "deleted",
      movieFileRenamed: "renamed",
      episodeFileRenamed: "renamed",
    };
    const historyEvents: ArrHistoryEvent[] = (history.records ?? []).map((h) => {
      const d = h.data ?? {};
      return {
        ...(h.date ? { at: h.date } : {}),
        event: EVENT[h.eventType ?? ""] ?? "other",
        title: app === "sonarr" ? episodeTitle(h.series, h.episode) : movieTitle(h.movie),
        ...(h.sourceTitle ? { release: h.sourceTitle } : {}),
        ...(h.downloadId ? { downloadId: h.downloadId } : {}),
        ...((d.downloadClientName ?? d.downloadClient)
          ? { client: d.downloadClientName ?? d.downloadClient }
          : {}),
        ...(d.indexer ? { indexer: d.indexer } : {}),
        ...(d.droppedPath ? { droppedPath: d.droppedPath } : {}),
        ...(d.importedPath ? { importedPath: d.importedPath } : {}),
        ...(d.message ? { message: d.message } : {}),
        ...(h.quality?.quality?.name ? { quality: h.quality.quality.name } : {}),
        ...(/Renamed$/.test(h.eventType ?? "") && d.sourcePath
          ? { renamedFrom: d.sourcePath }
          : {}),
        ...(/Renamed$/.test(h.eventType ?? "") && d.path ? { renamedTo: d.path } : {}),
      };
    });
    const trails = downloadTrails(
      app === "sonarr" ? "Sonarr" : "Radarr",
      historyEvents,
      items.map((i) => ({ ...i, stuck: i.stuckImport })),
    );

    return {
      app,
      history: historyEvents,
      trails,
      ...(status.version ? { version: status.version } : {}),
      totals: {
        titles: totals?.titles ?? 0,
        monitored: totals?.monitored ?? 0,
        missing: missing.totalRecords ?? missingItems.length,
        queue: queue.totalRecords ?? items.length,
        stuckImports: items.filter((i) => i.stuckImport).length,
        failed: items.filter((i) => i.failed).length,
      },
      queue: items,
      missing: missingItems,
      upcoming,
      recent,
      health: health
        .filter((h) => h.type === "warning" || h.type === "error")
        .map((h) => ({
          level: h.type === "error" ? ("error" as const) : ("warning" as const),
          text: h.message ?? "",
          ...(h.source ? { source: h.source } : {}),
        })),
      ...(library ? { library } : {}),
    };
  }
}
