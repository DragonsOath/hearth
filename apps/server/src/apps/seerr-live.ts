import {
  assessMovie,
  SEERR_MEDIA,
  SEERR_REQUEST,
  type MovieFacts,
  type RequestedMovie,
  type RequestedShow,
  type RequestStage,
  type SeerrDashboard,
} from "@dragon-control/core";
import type * as t from "../db/schema";
import { CredentialError } from "../credentials/broker";
import { tmdbDate, type MovieReleases } from "../watches/movie-release";

/**
 * The Seerr (Overseerr, Jellyseerr) dashboard: every movie request with its poster, digital
 * release date, approval, and where it stands in Radarr (which instance, root folder, quality
 * profile, download). Read through the credential broker, in bulk: one list of requests, each
 * movie's details from Seerr (cached, they rarely change), and each Radarr's movies, quality
 * profiles, and queue once. Where a movie stands uses the same assessment as release watches, so
 * the panel and the alerts never disagree. Reads only.
 */

type ServiceRow = typeof t.services.$inferSelect;

type SeerrRequest = {
  id: number;
  status?: number;
  type?: string;
  createdAt?: string;
  requestedBy?: { id?: number; displayName?: string };
  media?: { tmdbId?: number; tvdbId?: number; status?: number };
  seasons?: { seasonNumber?: number }[];
};

type ShowDetail = {
  name?: string;
  posterPath?: string;
  backdropPath?: string;
  genres?: { name?: string }[];
  networks?: { name?: string }[];
  status?: string;
  numberOfSeasons?: number;
  firstAirDate?: string;
  externalIds?: { tvdbId?: number };
};

type SonarrSeries = {
  id: number;
  title?: string;
  tvdbId?: number;
  tmdbId?: number;
  monitored?: boolean;
  status?: string;
  nextAiring?: string;
  statistics?: { episodeFileCount?: number; episodeCount?: number };
  seasons?: {
    seasonNumber?: number;
    monitored?: boolean;
    statistics?: { episodeFileCount?: number; episodeCount?: number };
  }[];
};

/** A show's seasons from Sonarr's series (specials left out), and what aired but isn't on disk. */
export function seasonsOf(s: SonarrSeries) {
  const seasons = (s.seasons ?? [])
    .filter((x) => (x.seasonNumber ?? 0) > 0)
    .map((x) => ({
      number: x.seasonNumber!,
      files: x.statistics?.episodeFileCount ?? 0,
      episodes: x.statistics?.episodeCount ?? 0,
      monitored: x.monitored === true,
    }))
    .sort((a, b) => a.number - b.number);
  // No season list (an older Sonarr): the show's own totals, specials and all.
  const missing = seasons.length
    ? seasons.reduce((n, x) => n + Math.max(0, x.episodes - x.files), 0)
    : Math.max(0, (s.statistics?.episodeCount ?? 0) - (s.statistics?.episodeFileCount ?? 0));
  return { seasons, missing };
}

type MovieDetail = {
  title?: string;
  posterPath?: string;
  releaseDate?: string;
  releases?: {
    results?: { iso_3166_1?: string; release_dates?: { type?: number; release_date?: string }[] }[];
  };
  mediaInfo?: { status?: number };
};

type RadarrMovie = {
  id: number;
  tmdbId?: number;
  titleSlug?: string;
  monitored?: boolean;
  hasFile?: boolean;
  isAvailable?: boolean;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  path?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;
};

type QueueRecord = {
  movieId?: number;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
  statusMessages?: { messages?: string[] }[];
  size?: number;
  sizeleft?: number;
};

interface RadarrView {
  service: ServiceRow;
  roots: string[];
  byTmdb: Map<number, RadarrMovie>;
  profiles: Map<number, string>;
  queue: Map<number, QueueRecord>;
}

/** Requests read per page, and the most read (newest first). */
const PAGE = 100;
const MAX_REQUESTS = 500;
/** Movie details change rarely (release dates do, so not for long). */
const DETAIL_TTL_MS = 6 * 60 * 60_000;
/** Seerr reads at once, so a long first load does not flood it. */
const PARALLEL = 6;
/** History is read only for movies whose date has passed with nothing in the queue. */
const MAX_HISTORY_READS = 40;

const APPROVAL: Record<number, RequestedMovie["approval"]> = {
  1: "pending",
  2: "approved",
  3: "declined",
  4: "failed",
  5: "completed",
};

const daysBetween = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );

/** The folder a movie's own folder sits in, when Radarr does not report its root folder. */
const parentOf = (p: string) => p.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]*$/, "") || undefined;

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export class SeerrLive {
  private details = new Map<string, { at: number; value?: MovieDetail }>();
  private showDetails = new Map<string, { at: number; value?: ShowDetail }>();

  constructor(private readonly movies: MovieReleases) {}

  async dashboard(
    seerr: ServiceRow,
    opts: { region: string; overdueAfterDays: number; now: Date; today: string },
  ): Promise<SeerrDashboard> {
    const read = <T>(service: ServiceRow, path: string, purpose: string) =>
      this.movies.read<T>(service, path, purpose);

    const [status, me, region] = await Promise.all([
      read<{ version?: string }>(seerr, "/api/v1/status", "read Seerr's version"),
      read<{ id?: number; displayName?: string }>(
        seerr,
        "/api/v1/auth/me",
        "read which Seerr user Hearth's key belongs to",
      ).catch(() => undefined),
      opts.region ? Promise.resolve(opts.region) : this.movies.region(seerr),
    ]);

    const requests: SeerrRequest[] = [];
    const showRequests: SeerrRequest[] = [];
    for (let skip = 0; skip < MAX_REQUESTS; skip += PAGE) {
      const r = await read<{ results?: SeerrRequest[]; pageInfo?: { pages?: number } }>(
        seerr,
        // No mediaType filter: Overseerr 1.35 rejects it (400, unknown parameter); Jellyseerr
        // accepts it. Shows are skipped below instead.
        `/api/v1/request?take=${PAGE}&skip=${skip}&filter=all&sort=added`,
        "list movie requests",
      );
      const list = (r.data?.results ?? []).filter(
        (x) => (!x.type || x.type === "movie") && x.media?.tmdbId,
      );
      requests.push(...list);
      showRequests.push(
        ...(r.data?.results ?? []).filter((x) => x.type === "tv" && x.media?.tmdbId),
      );
      if ((r.data?.results ?? []).length < PAGE) break;
    }

    const now = Date.now();
    await inBatches([...new Set(requests.map((r) => r.media!.tmdbId!))], PARALLEL, async (id) => {
      const k = `${seerr.id}:${id}`;
      const hit = this.details.get(k);
      if (hit && now - hit.at < DETAIL_TTL_MS) return;
      const d = await read<MovieDetail>(
        seerr,
        `/api/v1/movie/${id}`,
        "read a requested movie",
      ).catch(() => undefined);
      this.details.set(k, { at: now, value: d?.data });
    });

    const notes: string[] = [];
    const radarrs: RadarrView[] = [];
    let radarrMissing: Extract<MovieFacts["radarr"], { found: false }>["reason"] = "no-radarr";
    for (const service of await this.movies.services("radarr")) {
      try {
        const [list, profiles, queue, roots] = await Promise.all([
          read<RadarrMovie[]>(service, "/api/v3/movie", "match requests to Radarr's movies"),
          read<{ id: number; name?: string }[]>(
            service,
            "/api/v3/qualityprofile",
            "read Radarr's quality profile names",
          ),
          read<{ records?: QueueRecord[] }>(
            service,
            "/api/v3/queue?page=1&pageSize=1000&includeUnknownMovieItems=false",
            "read Radarr's download queue",
          ),
          read<{ path: string }[]>(
            service,
            "/api/v3/rootfolder",
            "read Radarr's root folders",
          ).catch(() => ({ status: 0, data: [] as { path: string }[] })),
        ]);
        radarrs.push({
          service,
          roots: (roots.data ?? []).map((r) => r.path.replace(/[/\\]+$/, "")),
          byTmdb: new Map((list.data ?? []).filter((m) => m.tmdbId).map((m) => [m.tmdbId!, m])),
          profiles: new Map((profiles.data ?? []).map((p) => [p.id, p.name ?? `Profile ${p.id}`])),
          queue: new Map(
            (queue.data?.records ?? []).filter((q) => q.movieId).map((q) => [q.movieId!, q]),
          ),
        });
      } catch (error) {
        const keyless = error instanceof CredentialError;
        if (radarrMissing !== "unreachable") radarrMissing = keyless ? "no-key" : "unreachable";
        notes.push(
          `${service.name}: ${keyless ? "its key is not in Secure Vault" : error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // With a Radarr unreadable, a movie missing from the others may be in that one: not "not added".
    if (radarrs.length) radarrMissing = notes.length ? "unreachable" : "not-added";

    // History only where it changes the answer: out, nothing queued, no file.
    let historyReads = 0;
    const lastEvent = async (v: RadarrView, m: RadarrMovie, digital?: string) => {
      if (m.hasFile || v.queue.has(m.id) || !digital || digital > opts.today) return undefined;
      if (historyReads++ >= MAX_HISTORY_READS) return undefined;
      const h = await read<{ eventType?: string; date?: string }[]>(
        v.service,
        `/api/v3/history/movie?movieId=${m.id}`,
        "check what happened to a requested movie's downloads",
      ).catch(() => undefined);
      const last = (h?.data ?? [])
        .filter((x) => x.eventType && x.date)
        .sort((a, b) => b.date!.localeCompare(a.date!))[0];
      return last ? { type: last.eventType!, at: last.date! } : undefined;
    };

    const movies: RequestedMovie[] = [];
    for (const req of requests) {
      const tmdbId = req.media!.tmdbId!;
      const d = this.details.get(`${seerr.id}:${tmdbId}`)?.value;
      const hit = radarrs.find((v) => v.byTmdb.has(tmdbId));
      const rm = hit?.byTmdb.get(tmdbId);
      const digitalTmdb = tmdbDate(d?.releases, region, 4);
      const digital = digitalTmdb ?? rm?.digitalRelease?.slice(0, 10);
      const physicalTmdb = tmdbDate(d?.releases, region, 5);
      const physical = physicalTmdb ?? rm?.physicalRelease?.slice(0, 10);
      const theatrical =
        tmdbDate(d?.releases, region, 3) ??
        rm?.inCinemas?.slice(0, 10) ??
        d?.releaseDate?.slice(0, 10);
      const q = hit && rm ? hit.queue.get(rm.id) : undefined;
      const message =
        q?.errorMessage ?? q?.statusMessages?.flatMap((m) => m.messages ?? [])[0] ?? undefined;
      const progress = q?.size
        ? Math.max(0, Math.min(100, 100 * (1 - (q.sizeleft ?? 0) / q.size)))
        : undefined;
      const event = hit && rm ? await lastEvent(hit, rm, digital) : undefined;
      const mediaStatus = req.media?.status ?? d?.mediaInfo?.status ?? 1;
      const facts: MovieFacts = {
        tmdbId,
        title: d?.title ?? `A movie (TMDB ${tmdbId})`,
        request: {
          seerrServiceId: seerr.id,
          requestId: req.id,
          requestedAt: req.createdAt ?? new Date(0).toISOString(),
          status: req.status ?? SEERR_REQUEST.pending,
          mediaStatus,
        },
        dates: {
          region,
          ...(digital ? { digital, digitalSource: digitalTmdb ? "tmdb" : "radarr" } : {}),
          ...(physical ? { physical, physicalSource: physicalTmdb ? "tmdb" : "radarr" } : {}),
          ...(theatrical ? { theatrical } : {}),
        },
        radarr:
          hit && rm
            ? {
                found: true,
                serviceId: hit.service.id,
                movieId: rm.id,
                monitored: Boolean(rm.monitored),
                hasFile: Boolean(rm.hasFile),
                ...(q
                  ? {
                      queue: {
                        ...(q.trackedDownloadState ? { state: q.trackedDownloadState } : {}),
                        ...(q.trackedDownloadStatus ? { status: q.trackedDownloadStatus } : {}),
                        ...(message ? { message: message.slice(0, 200) } : {}),
                        ...(progress !== undefined ? { progress } : {}),
                      },
                    }
                  : {}),
                ...(event ? { lastEvent: event } : {}),
              }
            : { found: false, reason: radarrMissing },
      };
      const a = assessMovie(facts, opts.now, opts.today, undefined, opts.overdueAfterDays * 24);
      const stage = stageOf(facts, rm, event, digital);
      const grabbedOrDone: RequestStage[] = [
        "grabbed",
        "downloading",
        "awaiting-import",
        "download-problem",
        "imported",
        "declined",
      ];
      const late = digital ? daysBetween(digital, opts.today) : undefined;
      movies.push({
        requestId: req.id,
        tmdbId,
        title: facts.title,
        ...(d?.releaseDate ? { year: Number(d.releaseDate.slice(0, 4)) } : {}),
        ...(d?.posterPath && /^\/[\w-]+\.(jpg|jpeg|png|webp)$/i.test(d.posterPath)
          ? { poster: d.posterPath }
          : {}),
        requestedAt: facts.request!.requestedAt,
        requestedBy: req.requestedBy?.displayName ?? "Someone",
        mine: me?.data?.id !== undefined && req.requestedBy?.id === me.data.id,
        approval: APPROVAL[req.status ?? 1] ?? "pending",
        ...(digital ? { digital: { date: digital, source: digitalTmdb ? "tmdb" : "radarr" } } : {}),
        ...(theatrical ? { theatrical } : {}),
        ...(late !== undefined && late >= opts.overdueAfterDays && !grabbedOrDone.includes(stage)
          ? { overdueDays: late }
          : {}),
        stage,
        doing: a.doing,
        ...(hit && rm
          ? {
              radarr: {
                serviceId: hit.service.id,
                movieId: rm.id,
                instance: hit.service.name,
                monitored: Boolean(rm.monitored),
                hasFile: Boolean(rm.hasFile),
                ...((rm.rootFolderPath ?? (rm.path ? parentOf(rm.path) : undefined))
                  ? { rootFolder: rm.rootFolderPath ?? parentOf(rm.path!) }
                  : {}),
                ...(rm.path ? { path: rm.path } : {}),
                ...(rm.qualityProfileId !== undefined && hit.profiles.has(rm.qualityProfileId)
                  ? { quality: hit.profiles.get(rm.qualityProfileId) }
                  : {}),
                ...(progress !== undefined ? { progressPct: Math.round(progress) } : {}),
                ...(stage === "download-problem" && message
                  ? { problem: message.slice(0, 200) }
                  : {}),
              },
            }
          : {}),
      });
    }
    movies.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    const shows = await this.shows(seerr, showRequests, me?.data?.id, notes);
    return {
      app: "seerr",
      ...(status.data?.version ? { version: status.data.version } : {}),
      region,
      ...(me?.data?.displayName ? { me: me.data.displayName } : {}),
      overdueAfterDays: opts.overdueAfterDays,
      totals: {
        movies: movies.length,
        mine: movies.filter((m) => m.mine).length,
        overdue: movies.filter((m) => m.overdueDays !== undefined).length,
        awaitingApproval: movies.filter((m) => m.approval === "pending").length,
      },
      movies,
      shows,
      notes,
      radarrs: radarrs.map((v) => ({
        serviceId: v.service.id,
        name: v.service.name,
        rootFolders: v.roots,
      })),
    };
  }

  /** Show requests: who asked, which seasons, and whether Sonarr is still looking (reads only). */
  private async shows(
    seerr: ServiceRow,
    requests: SeerrRequest[],
    meId: number | undefined,
    notes: string[],
  ): Promise<RequestedShow[]> {
    if (!requests.length) return [];
    const read = <T>(service: ServiceRow, path: string, purpose: string) =>
      this.movies.read<T>(service, path, purpose);
    const now = Date.now();
    await inBatches([...new Set(requests.map((r) => r.media!.tmdbId!))], PARALLEL, async (id) => {
      const k = `${seerr.id}:tv:${id}`;
      const hit = this.showDetails.get(k);
      if (hit && now - hit.at < DETAIL_TTL_MS) return;
      const d = await read<ShowDetail>(seerr, `/api/v1/tv/${id}`, "read a requested show").catch(
        () => undefined,
      );
      this.showDetails.set(k, { at: now, value: d?.data });
    });
    const sonarrs: { service: ServiceRow; series: SonarrSeries[] }[] = [];
    for (const service of await this.movies.services("sonarr")) {
      try {
        const r = await read<SonarrSeries[]>(
          service,
          "/api/v3/series",
          "match show requests to Sonarr's series",
        );
        sonarrs.push({ service, series: r.data ?? [] });
      } catch (error) {
        notes.push(
          `${service.name}: ${error instanceof CredentialError ? "its key is not in Secure Vault" : error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const out: RequestedShow[] = [];
    for (const req of requests) {
      const tmdbId = req.media!.tmdbId!;
      const d = this.showDetails.get(`${seerr.id}:tv:${tmdbId}`)?.value;
      const tvdbId = req.media?.tvdbId ?? d?.externalIds?.tvdbId;
      let match: { service: ServiceRow; s: SonarrSeries } | undefined;
      for (const v of sonarrs) {
        const s = v.series.find(
          (x) => (tvdbId && x.tvdbId === tvdbId) || (x.tmdbId && x.tmdbId === tmdbId),
        );
        if (s) {
          match = { service: v.service, s };
          break;
        }
      }
      const year = d?.firstAirDate ? Number(d.firstAirDate.slice(0, 4)) : undefined;
      out.push({
        requestId: req.id,
        tmdbId,
        title: d?.name ?? match?.s.title ?? `A show (TMDB ${tmdbId})`,
        ...(year ? { year } : {}),
        ...(d?.posterPath && /^\/[\w-]+\.(jpg|jpeg|png|webp)$/i.test(d.posterPath)
          ? { poster: d.posterPath }
          : {}),
        ...(d?.backdropPath && /^\/[\w-]+\.(jpg|jpeg|png|webp)$/i.test(d.backdropPath)
          ? { backdrop: d.backdropPath }
          : {}),
        ...(d?.genres?.length
          ? {
              genres: d.genres
                .map((g) => g.name ?? "")
                .filter(Boolean)
                .slice(0, 4),
            }
          : {}),
        ...(d?.networks?.[0]?.name ? { network: d.networks[0].name } : {}),
        ...(d?.status ? { showStatus: d.status } : {}),
        requestedAt: req.createdAt ?? new Date(0).toISOString(),
        requestedBy: req.requestedBy?.displayName ?? "Someone",
        mine: meId !== undefined && req.requestedBy?.id === meId,
        approval: APPROVAL[req.status ?? 1] ?? "pending",
        seasons: (req.seasons ?? [])
          .map((x) => x.seasonNumber)
          .filter((n): n is number => typeof n === "number")
          .sort((a, b) => a - b),
        ...(match
          ? {
              sonarr: {
                serviceId: match.service.id,
                seriesId: match.s.id,
                instance: match.service.name,
                monitored: Boolean(match.s.monitored),
                episodesOnDisk: match.s.statistics?.episodeFileCount ?? 0,
                episodes: match.s.statistics?.episodeCount ?? 0,
                ...(match.s.nextAiring ? { nextAiring: match.s.nextAiring } : {}),
                ...(match.s.status === "ended" ? { ended: true } : {}),
                ...seasonsOf(match.s),
              },
            }
          : {}),
      });
    }
    return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }
}

/** Where a request stands, from what Seerr and Radarr said (never inferred from a date alone). */
export function stageOf(
  f: MovieFacts,
  rm: RadarrMovie | undefined,
  event: { type: string; at: string } | undefined,
  digital: string | undefined,
): RequestStage {
  const req = f.request!;
  const r = f.radarr;
  if (r.found && r.hasFile) return "imported";
  if (req.mediaStatus === SEERR_MEDIA.available) return "imported";
  if (req.status === SEERR_REQUEST.declined) return "declined";
  if (req.status === SEERR_REQUEST.failed) return "request-failed";
  if (req.status === SEERR_REQUEST.pending) return "awaiting-approval";
  if (!r.found) return r.reason === "not-added" ? "not-in-radarr" : "radarr-unknown";
  if (r.queue) {
    const st = r.queue.state ?? "";
    if (
      r.queue.status === "error" ||
      r.queue.status === "warning" ||
      st === "failed" ||
      st === "failedPending" ||
      st === "importBlocked"
    )
      return "download-problem";
    if (/import/i.test(st)) return "awaiting-import";
    return "downloading";
  }
  if (event?.type === "grabbed" && (!digital || event.at.slice(0, 10) >= digital)) return "grabbed";
  if (!r.monitored) return "not-monitored";
  if (rm?.isAvailable === false) return "waiting-release";
  return "searching";
}
