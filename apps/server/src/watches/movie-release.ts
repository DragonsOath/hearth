import { eq } from "drizzle-orm";
import { SEERR_MEDIA, SEERR_REQUEST, type AppKind, type MovieFacts } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { appOf } from "../apps/service";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "../apps/http";
import { CredentialError, type CredentialBroker } from "../credentials/broker";

/**
 * Movie releases: what Seerr and Radarr say about a requested movie, read through the credential
 * broker (keys stay in Secure Vault; only the answers come back). Reads only: nothing here
 * searches indexers, grabs, or changes Seerr or Radarr. See docs/design/RELEASE_WATCH.md for
 * where each field comes from.
 */

type ServiceRow = typeof t.services.$inferSelect;

/** A movie request found in Seerr, to be watched. */
export interface MovieRequest {
  key: string;
  seerrServiceId: string;
  requestId: number;
  tmdbId: number;
  requestedAt: string;
  status: number;
  mediaStatus: number;
}

type SeerrRequest = {
  id: number;
  status?: number;
  type?: string;
  createdAt?: string;
  requestedBy?: { displayName?: string };
  media?: { tmdbId?: number; status?: number };
};

type TmdbRelease = {
  iso_3166_1?: string;
  release_dates?: { type?: number; release_date?: string }[];
};

type RadarrMovie = {
  id: number;
  tmdbId?: number;
  titleSlug?: string;
  monitored?: boolean;
  hasFile?: boolean;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
};

/** Seerr's own fallback when no region is set (its movie page does the same). */
const DEFAULT_REGION = "US";
/** Requests read per page, and the most pages read in one pass (1,000 requests). */
const PAGE = 100;
const MAX_PAGES = 10;

export const requestKey = (seerrServiceId: string, requestId: number) =>
  `${seerrServiceId}:${requestId}`;

/** The earliest date of one TMDB release type for the region, as YYYY-MM-DD. */
export function tmdbDate(
  releases: { results?: TmdbRelease[] } | undefined,
  region: string,
  type: number,
): string | undefined {
  const dates = (releases?.results ?? [])
    .find((r) => r.iso_3166_1?.toUpperCase() === region.toUpperCase())
    ?.release_dates?.filter((d) => d.type === type && d.release_date)
    .map((d) => d.release_date!.slice(0, 10))
    .sort();
  return dates?.[0];
}

export class MovieReleases {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  /** Watched apps of one kind with an address, never sample data. */
  async services(app: AppKind): Promise<ServiceRow[]> {
    const rows = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.lifecycle, "active"));
    return rows.filter(
      (s) => appOf(s) === app && s.localUrl && !s.checkTarget?.startsWith("demo:"),
    );
  }

  /** One read from an app, with its key from the vault. 404 comes back as a status, not an error. */
  async read<T>(
    service: ServiceRow,
    path: string,
    purpose: string,
  ): Promise<{ status: number; data?: T }> {
    const url = joinUrl(service.localUrl!, path);
    return this.broker.use(
      { serviceId: service.id, purpose, access: "read", destination: url },
      async ({ value }) => {
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(url, {
            method: "GET",
            headers: { "X-Api-Key": value, Accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS * 2),
          });
        } catch (error) {
          throw new AppUnreachableError(
            `${service.name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (res.status === 401 || res.status === 403)
          throw new AppKeyError(`${service.name} refused the API key. Check it in Secure Vault.`);
        if (res.status === 404) return { status: 404 };
        if (!res.ok) throw new AppUnreachableError(`${service.name} answered ${res.status}.`);
        return { status: res.status, data: (await res.json().catch(() => undefined)) as T };
      },
    );
  }

  /**
   * Every movie request in every watched Seerr that is not in the library yet. All pages, so
   * requests made before watching started are found too.
   */
  async discover(): Promise<{ requests: MovieRequest[]; seerrs: string[]; errors: string[] }> {
    const requests: MovieRequest[] = [];
    const errors: string[] = [];
    const seerrs = await this.services("seerr");
    for (const seerr of seerrs) {
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const r = await this.read<{ results?: SeerrRequest[]; pageInfo?: { pages?: number } }>(
            seerr,
            // No mediaType: Overseerr rejects it as unknown (400). Shows are skipped below.
            `/api/v1/request?take=${PAGE}&skip=${page * PAGE}&filter=all&sort=added`,
            "find movie requests to watch",
          );
          const list = r.data?.results ?? [];
          for (const req of list) {
            const tmdbId = req.media?.tmdbId;
            if (req.type && req.type !== "movie") continue;
            if (!tmdbId) continue;
            const mediaStatus = req.media?.status ?? 1;
            // Already in the library, declined, or gone: nothing to wait for.
            if (
              mediaStatus === SEERR_MEDIA.available ||
              mediaStatus === SEERR_MEDIA.deleted ||
              mediaStatus === SEERR_MEDIA.blocklisted ||
              req.status === SEERR_REQUEST.declined ||
              req.status === SEERR_REQUEST.completed
            )
              continue;
            requests.push({
              key: requestKey(seerr.id, req.id),
              seerrServiceId: seerr.id,
              requestId: req.id,
              tmdbId,
              requestedAt: req.createdAt ?? new Date().toISOString(),
              status: req.status ?? SEERR_REQUEST.pending,
              mediaStatus,
            });
          }
          if (list.length < PAGE || page + 1 >= (r.data?.pageInfo?.pages ?? 1)) break;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { requests, seerrs: seerrs.map((s) => s.id), errors };
  }

  /** Seerr's region setting, for which country's release dates count. */
  async region(seerr: ServiceRow): Promise<string> {
    const r = await this.read<{ discoverRegion?: string; region?: string }>(
      seerr,
      "/api/v1/settings/public",
      "read which country's release dates to use",
    ).catch(() => undefined);
    return (r?.data?.discoverRegion || r?.data?.region || DEFAULT_REGION).toUpperCase();
  }

  /**
   * Everything about one requested movie now. Throws only when Seerr itself cannot be read (the
   * watch then keeps what it knew and tries again); a Radarr that does not answer is a fact.
   */
  async facts(
    req: { seerrServiceId: string; requestId: number; tmdbId: number },
    regionSetting: string,
  ): Promise<MovieFacts> {
    const seerr = (await this.services("seerr")).find((s) => s.id === req.seerrServiceId);
    if (!seerr) throw new AppUnreachableError("That Seerr is no longer watched.");
    const request = await this.read<SeerrRequest>(
      seerr,
      `/api/v1/request/${req.requestId}`,
      "check a movie request",
    );
    const movie = await this.read<{
      title?: string;
      releaseDate?: string;
      releases?: { results?: TmdbRelease[] };
      mediaInfo?: { status?: number };
    }>(seerr, `/api/v1/movie/${req.tmdbId}`, "read a requested movie's release dates");
    const region = regionSetting || (await this.region(seerr));
    const m = movie.data;
    const radarr = await this.radarr(req.tmdbId);
    const r = radarr.found ? radarr.movie : undefined;
    const digitalTmdb = tmdbDate(m?.releases, region, 4);
    const physicalTmdb = tmdbDate(m?.releases, region, 5);
    const digital = digitalTmdb ?? r?.digitalRelease?.slice(0, 10);
    const physical = physicalTmdb ?? r?.physicalRelease?.slice(0, 10);
    const theatrical =
      tmdbDate(m?.releases, region, 3) ??
      r?.inCinemas?.slice(0, 10) ??
      m?.releaseDate?.slice(0, 10);
    const s = request.data;
    return {
      tmdbId: req.tmdbId,
      title: m?.title ?? `A movie (TMDB ${req.tmdbId})`,
      ...(m?.releaseDate ? { year: Number(m.releaseDate.slice(0, 4)) } : {}),
      ...(request.status === 404 || !s
        ? {}
        : {
            request: {
              seerrServiceId: seerr.id,
              requestId: s.id,
              requestedAt: s.createdAt ?? new Date().toISOString(),
              ...(s.requestedBy?.displayName ? { requestedBy: s.requestedBy.displayName } : {}),
              status: s.status ?? SEERR_REQUEST.pending,
              mediaStatus: s.media?.status ?? m?.mediaInfo?.status ?? 1,
            },
          }),
      dates: {
        region,
        ...(digital ? { digital, digitalSource: digitalTmdb ? "tmdb" : "radarr" } : {}),
        ...(physical ? { physical, physicalSource: physicalTmdb ? "tmdb" : "radarr" } : {}),
        ...(theatrical ? { theatrical } : {}),
      },
      radarr: radarr.found
        ? {
            found: true,
            serviceId: radarr.service.id,
            movieId: radarr.movie.id,
            ...(radarr.movie.titleSlug ? { titleSlug: radarr.movie.titleSlug } : {}),
            monitored: Boolean(radarr.movie.monitored),
            hasFile: Boolean(radarr.movie.hasFile),
            ...(radarr.queue ? { queue: radarr.queue } : {}),
            ...(radarr.lastEvent ? { lastEvent: radarr.lastEvent } : {}),
          }
        : radarr,
    };
  }

  /** The movie in any watched Radarr, with its queue entry and latest history event. */
  private async radarr(tmdbId: number): Promise<
    | Extract<MovieFacts["radarr"], { found: false }>
    | {
        found: true;
        service: ServiceRow;
        movie: RadarrMovie;
        queue?: { state?: string; status?: string; message?: string; progress?: number };
        lastEvent?: { type: string; at: string };
      }
  > {
    const radarrs = await this.services("radarr");
    if (!radarrs.length) return { found: false, reason: "no-radarr" };
    let reason: "no-key" | "not-added" | "unreachable" = "not-added";
    let detail: string | undefined;
    for (const service of radarrs) {
      try {
        const list = await this.read<RadarrMovie[]>(
          service,
          `/api/v3/movie?tmdbId=${tmdbId}`,
          "check a requested movie in Radarr",
        );
        const movie = (list.data ?? []).find((x) => x.tmdbId === undefined || x.tmdbId === tmdbId);
        if (!movie) continue;
        const queue = await this.read<{
          records?: {
            movieId?: number;
            status?: string;
            trackedDownloadStatus?: string;
            trackedDownloadState?: string;
            errorMessage?: string;
            statusMessages?: { messages?: string[] }[];
            size?: number;
            sizeleft?: number;
          }[];
        }>(service, `/api/v3/queue?movieIds=${movie.id}`, "check a movie's download");
        const q = (queue.data?.records ?? []).find(
          (x) => x.movieId === undefined || x.movieId === movie.id,
        );
        const history = await this.read<{ eventType?: string; date?: string }[]>(
          service,
          `/api/v3/history/movie?movieId=${movie.id}`,
          "check what happened to a movie's downloads",
        );
        const last = (history.data ?? [])
          .filter((h) => h.eventType && h.date)
          .sort((a, b) => b.date!.localeCompare(a.date!))[0];
        const message =
          q?.errorMessage ?? q?.statusMessages?.flatMap((m) => m.messages ?? [])[0] ?? undefined;
        return {
          found: true,
          service,
          movie,
          ...(q
            ? {
                queue: {
                  ...(q.trackedDownloadState ? { state: q.trackedDownloadState } : {}),
                  ...(q.trackedDownloadStatus ? { status: q.trackedDownloadStatus } : {}),
                  ...(message ? { message: message.slice(0, 200) } : {}),
                  ...(q.size
                    ? {
                        progress: Math.max(
                          0,
                          Math.min(100, 100 * (1 - (q.sizeleft ?? 0) / q.size)),
                        ),
                      }
                    : {}),
                },
              }
            : {}),
          ...(last ? { lastEvent: { type: last.eventType!, at: last.date! } } : {}),
        };
      } catch (error) {
        if (error instanceof CredentialError) reason = "no-key";
        else {
          reason = "unreachable";
          detail = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return { found: false, reason, ...(detail ? { detail } : {}) };
  }

  /** Where the movie is in Seerr's and Radarr's own pages, for the links on the watch. */
  async links(
    f: MovieFacts,
    services?: ServiceRow[],
  ): Promise<{ seerr?: string; radarr?: string }> {
    const rows = services ?? (await this.handle.db.select().from(t.services));
    const byId = new Map(rows.map((s) => [s.id, s]));
    const seerr = f.request ? byId.get(f.request.seerrServiceId) : undefined;
    const radarr = f.radarr.found ? byId.get(f.radarr.serviceId) : undefined;
    const web = (s?: ServiceRow) => s?.publicUrl ?? s?.localUrl ?? undefined;
    return {
      ...(web(seerr) ? { seerr: joinUrl(web(seerr)!, `/movie/${f.tmdbId}`) } : {}),
      ...(web(radarr) && f.radarr.found
        ? { radarr: joinUrl(web(radarr)!, `/movie/${f.radarr.titleSlug ?? f.tmdbId}`) }
        : {}),
    };
  }
}
