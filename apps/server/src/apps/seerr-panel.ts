import type { ServarrGet } from "./servarr-panel";

/**
 * The native Seerr panel's tabs beyond Requests (Overseerr, Jellyseerr, Seerr 3): Discover (search
 * TMDB through Seerr, and a show's seasons for a request), Issues (list and one issue with its
 * comments) and People (users and their request limits). Reads only; requesting and handling
 * issues are plan steps (seerr-ops.ts). Nothing secret is read or returned.
 */

export const SEERR_VIEWS = [
  "search",
  "discover",
  "title",
  "servers",
  "issues",
  "issue",
  "users",
  "similar",
  "ratings",
] as const;
export type SeerrView = (typeof SEERR_VIEWS)[number];

export class SeerrReadError extends Error {}

/** Seerr's media status in words. */
const MEDIA: Record<number, string> = {
  1: "not requested",
  2: "requested",
  3: "processing",
  4: "partly available",
  5: "available",
  6: "blocklisted",
  7: "deleted",
};
const ISSUE_TYPES: Record<number, string> = { 1: "Video", 2: "Audio", 3: "Subtitles", 4: "Other" };

const num = (v: string | undefined, fallback: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};
const year = (d?: string) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : undefined);

async function get<T>(read: ServarrGet, path: string): Promise<T> {
  const r = await read(path);
  if (!r.ok) throw new SeerrReadError(`Seerr answered ${r.status} for ${path.split("?")[0]}.`);
  return r.data as T;
}

interface RawResult {
  id: number;
  mediaType?: string;
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  genreIds?: number[];
  mediaInfo?: { status?: number };
}

/** TMDB's genre ids (fixed by TMDB), as Plex names them, for "More like this" on a missing title. */
export const TMDB_GENRES: Record<number, string> = {
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction",
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
  10759: "Action/Adventure",
  10762: "Children",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk Show",
  10768: "War & Politics",
};
interface RawIssue {
  id: number;
  status?: number;
  issueType?: number;
  problemSeason?: number;
  problemEpisode?: number;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: { displayName?: string };
  comments?: {
    id: number;
    message?: string;
    createdAt?: string;
    user?: { displayName?: string };
  }[];
  media?: { tmdbId?: number; mediaType?: string };
}

/** A title's name and year, looked up once per view. */
async function titles(read: ServarrGet, items: { tmdbId?: number; mediaType?: string }[]) {
  const names = new Map<string, string>();
  await Promise.all(
    [
      ...new Set(
        items
          .filter((m) => m.tmdbId)
          .map((m) => `${m.mediaType === "tv" ? "tv" : "movie"}/${m.tmdbId}`),
      ),
    ].map(async (key) => {
      const t = await get<RawResult>(read, `/api/v1/${key}`).catch(() => undefined);
      if (t) {
        const y = year(t.releaseDate ?? t.firstAirDate);
        names.set(key, `${t.title ?? t.name ?? key}${y ? ` (${y})` : ""}`);
      }
    }),
  );
  return (m: { tmdbId?: number; mediaType?: string }) =>
    names.get(`${m.mediaType === "tv" ? "tv" : "movie"}/${m.tmdbId}`) ?? `TMDB ${m.tmdbId ?? "?"}`;
}

/** A search or discover result, as the panel shows it (posters go through Hearth's route). */
const result = (x: RawResult) => ({
  tmdbId: x.id,
  mediaType: x.mediaType,
  title: x.title ?? x.name ?? "",
  year: year(x.releaseDate ?? x.firstAirDate),
  overview: (x.overview ?? "").slice(0, 280),
  poster: x.posterPath,
  ...(x.backdropPath ? { backdrop: x.backdropPath } : {}),
  status: MEDIA[x.mediaInfo?.status ?? 1] ?? "not requested",
  genres: (x.genreIds ?? []).map((g) => TMDB_GENRES[g]).filter((g): g is string => Boolean(g)),
});

/**
 * Discover's rows (checklist 46.20), each one of Seerr's own discover lists (checked against
 * Seerr 3's API, 2026-11-02): trending movies and shows this week, and movies released in the last
 * 60 days by popularity (with a few votes, so it is real releases, not far-off or unknown ones).
 */
export const DISCOVER_ROWS = {
  "trending-movies": {
    title: "Trending movies",
    path: () => "/api/v1/discover/trending?mediaType=movie&timeWindow=week",
    type: "movie",
  },
  "recent-movies": {
    title: "Recently released movies",
    path: (now = new Date()) => {
      const day = (d: Date) => d.toISOString().slice(0, 10);
      const from = new Date(now.getTime() - 60 * 86_400_000);
      return `/api/v1/discover/movies?sortBy=popularity.desc&primaryReleaseDateGte=${day(from)}&primaryReleaseDateLte=${day(now)}&voteCountGte=5`;
    },
    type: "movie",
  },
  // Coming to cinemas soon (the owner, 2026-11-02); Overseerr 1.x and Seerr both have it.
  "upcoming-movies": {
    title: "Upcoming movies",
    path: () => "/api/v1/discover/movies/upcoming",
    type: "movie",
  },
  "trending-tv": {
    title: "Trending shows",
    path: () => "/api/v1/discover/trending?mediaType=tv&timeWindow=week",
    type: "tv",
  },
} as const;
export type DiscoverRow = keyof typeof DISCOVER_ROWS;

type Page = { page?: number; totalPages?: number; results?: RawResult[] };

/**
 * Overseerr 1.x's trending list takes no mediaType or timeWindow (it answers 400; Seerr 3 takes
 * both): there the plain trending list is read, two of its pages per page shown, and split.
 */
async function trendingPlain(read: ServarrGet, page: number): Promise<Page> {
  const [a, b] = await Promise.all([
    get<Page>(read, `/api/v1/discover/trending?page=${page * 2 - 1}`),
    get<Page>(read, `/api/v1/discover/trending?page=${page * 2}`).catch(() => ({}) as Page),
  ]);
  return {
    page,
    totalPages: Math.ceil((a.totalPages ?? 1) / 2),
    results: [...(a.results ?? []), ...(b.results ?? [])],
  };
}

async function discoverRow(read: ServarrGet, row: DiscoverRow, page: number) {
  const def = DISCOVER_ROWS[row];
  const path: string = def.path();
  const r = await get<Page>(read, `${path}${path.includes("?") ? "&" : "?"}page=${page}`).catch(
    (e: unknown) => {
      if (row.startsWith("trending-") && e instanceof SeerrReadError && / 400 /.test(e.message))
        return trendingPlain(read, page);
      throw e;
    },
  );
  return {
    id: row,
    title: def.title,
    page: r.page ?? page,
    pages: Math.min(r.totalPages ?? 1, 20),
    results: (r.results ?? [])
      // Trending lists can carry people; the movie list has no mediaType, so it is set here.
      .map((x) => ({ ...x, mediaType: x.mediaType ?? def.type }))
      .filter((x) => x.mediaType === def.type)
      .map(result),
  };
}

export async function readSeerrView(
  read: ServarrGet,
  view: SeerrView,
  q: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (view === "servers") {
    // Where a request can go: Seerr's Radarr (movies) or Sonarr (shows), their root folders, and
    // the folder Seerr uses when none is chosen. 4K servers are left out (requests are not 4K).
    const kind = q.type === "tv" ? "sonarr" : "radarr";
    const list = await get<
      {
        id: number;
        name?: string;
        is4k?: boolean;
        isDefault?: boolean;
        activeDirectory?: string;
        activeProfileId?: number;
      }[]
    >(read, `/api/v1/service/${kind}`);
    const servers = await Promise.all(
      list
        .filter((s) => !s.is4k)
        .map(async (s) => {
          const detail = await get<{
            rootFolders?: { path?: string; freeSpace?: number }[];
            profiles?: { id: number; name?: string }[];
          }>(read, `/api/v1/service/${kind}/${s.id}`).catch(() => undefined);
          const folders = (detail?.rootFolders ?? [])
            .filter((f) => f.path)
            .map((f) => ({ path: f.path!, ...(f.freeSpace ? { freeBytes: f.freeSpace } : {}) }));
          // When Seerr cannot list them (it cannot reach the app), its default folder still shows.
          if (s.activeDirectory && !folders.some((f) => f.path === s.activeDirectory))
            folders.unshift({ path: s.activeDirectory });
          return {
            id: s.id,
            name: s.name ?? `${kind} ${s.id}`,
            isDefault: Boolean(s.isDefault),
            defaultFolder: s.activeDirectory,
            folders,
            ...(s.activeProfileId !== undefined ? { defaultProfile: s.activeProfileId } : {}),
            profiles: (detail?.profiles ?? []).map((p) => ({
              id: p.id,
              name: p.name ?? `Profile ${p.id}`,
            })),
            ...(detail
              ? {}
              : {
                  note: `${kind === "radarr" ? "Radarr" : "Sonarr"}'s folders could not be read through Seerr; its default is shown.`,
                }),
          };
        }),
    );
    return { app: kind, servers };
  }
  if (view === "discover") {
    // One row, a page at a time (See all), or the first page of every row (the tab opening).
    const row = q.row as DiscoverRow | undefined;
    if (row) {
      if (!(row in DISCOVER_ROWS)) throw new SeerrReadError("No such Discover row.");
      return discoverRow(read, row, num(q.page, 1, 20));
    }
    // A row that fails says so on its own; the others still show.
    const rows = await Promise.all(
      (Object.keys(DISCOVER_ROWS) as DiscoverRow[]).map((id) =>
        discoverRow(read, id, 1).catch((e: unknown) => ({
          id,
          title: DISCOVER_ROWS[id].title,
          page: 1,
          pages: 0,
          results: [],
          error: e instanceof Error ? e.message : String(e),
        })),
      ),
    );
    return { rows };
  }
  if (view === "search") {
    const query = (q.query ?? "").trim();
    if (!query) return { results: [], page: 1, pages: 0 };
    const page = num(q.page, 1, 50);
    const r = await get<{ page?: number; totalPages?: number; results?: RawResult[] }>(
      read,
      `/api/v1/search?query=${encodeURIComponent(query)}&page=${page}`,
    );
    return {
      page: r.page ?? page,
      pages: r.totalPages ?? 1,
      // Posters load through Hearth's poster route, never straight from TMDB by the browser.
      results: (r.results ?? [])
        .filter((x) => x.mediaType === "movie" || x.mediaType === "tv")
        .map(result),
    };
  }
  // Seerr's own "recommended" and "similar" lists for one title (TMDB's, through Seerr), for
  // Curator For You's "Not in your library": no AI, nothing leaves the network but Seerr's usual.
  if (view === "similar") {
    const type = q.type === "tv" ? "tv" : "movie";
    const id = num(q.id, 0, 10_000_000);
    if (!id) throw new SeerrReadError("Say which title (id).");
    const lists = await Promise.all(
      ["recommendations", "similar"].map((which) =>
        get<{ results?: RawResult[] }>(read, `/api/v1/${type}/${id}/${which}?page=1`).catch(
          () => ({ results: [] }) as { results?: RawResult[] },
        ),
      ),
    );
    const seen = new Set<number>();
    const results = [];
    // Recommended first (TMDB's better list), then similar, each title once.
    for (const x of lists.flatMap((l) => l.results ?? [])) {
      if (!x.id || seen.has(x.id)) continue;
      seen.add(x.id);
      results.push(result({ ...x, mediaType: type }));
    }
    return { results };
  }
  // IMDb and Rotten Tomatoes, as Seerr gathers them (it asks Rotten Tomatoes and IMDb itself):
  // read when a title opens, apart from its details, since they are slower and often missing.
  if (view === "ratings") {
    const type = q.type === "tv" ? "tv" : "movie";
    const id = num(q.id, 0, 10_000_000);
    if (!id) throw new SeerrReadError("Say which title (id).");
    const r = await read(
      type === "movie" ? `/api/v1/movie/${id}/ratingscombined` : `/api/v1/tv/${id}/ratings`,
    );
    if (!r.ok) return {};
    type Rt = { criticsScore?: number; audienceScore?: number; url?: string };
    const d = r.data as { rt?: Rt; imdb?: { criticsScore?: number; url?: string } } & Rt;
    const rt = type === "movie" ? d.rt : d;
    const safe = (u?: string, host = "") =>
      typeof u === "string" && u.startsWith(`https://www.${host}/`) ? u : undefined;
    return {
      ...(rt && (rt.criticsScore !== undefined || rt.audienceScore !== undefined)
        ? {
            rottenTomatoes: {
              ...(typeof rt.criticsScore === "number" ? { critics: rt.criticsScore } : {}),
              ...(typeof rt.audienceScore === "number" ? { audience: rt.audienceScore } : {}),
              ...(safe(rt.url, "rottentomatoes.com") ? { url: rt.url } : {}),
            },
          }
        : {}),
      ...(type === "movie" && typeof d.imdb?.criticsScore === "number"
        ? {
            imdb: {
              score: d.imdb.criticsScore,
              ...(safe(d.imdb.url, "imdb.com") ? { url: d.imdb.url } : {}),
            },
          }
        : {}),
    };
  }
  if (view === "title") {
    const type = q.type === "tv" ? "tv" : "movie";
    const id = num(q.id, 0, 10_000_000);
    if (!id) throw new SeerrReadError("Say which title (id).");
    const t = await get<
      RawResult & {
        voteAverage?: number;
        runtime?: number;
        genres?: { name?: string }[];
        numberOfSeasons?: number;
        seasons?: { seasonNumber: number; name?: string; episodeCount?: number }[];
        relatedVideos?: { site?: string; type?: string; key?: string; name?: string }[];
        tagline?: string;
        imdbId?: string;
        externalIds?: { imdbId?: string };
        credits?: {
          cast?: { name?: string; character?: string; profilePath?: string; order?: number }[];
          crew?: { name?: string; job?: string }[];
        };
        createdBy?: { name?: string }[];
        releases?: {
          results?: { iso_3166_1?: string; release_dates?: { certification?: string }[] }[];
        };
        contentRatings?: { results?: { iso_3166_1?: string; rating?: string }[] };
        mediaInfo?: {
          id?: number;
          status?: number;
          seasons?: { seasonNumber: number; status?: number }[];
          requests?: { status?: number; seasons?: { seasonNumber: number }[] }[];
        };
      }
    >(read, `/api/v1/${type}/${id}`);
    const has = new Map((t.mediaInfo?.seasons ?? []).map((s) => [s.seasonNumber, s.status ?? 1]));
    const asked = new Set(
      (t.mediaInfo?.requests ?? [])
        .filter((r) => r.status !== 3)
        .flatMap((r) => (r.seasons ?? []).map((s) => s.seasonNumber)),
    );
    return {
      tmdbId: id,
      mediaType: type,
      title: t.title ?? t.name ?? "",
      year: year(t.releaseDate ?? t.firstAirDate),
      status: MEDIA[t.mediaInfo?.status ?? 1] ?? "not requested",
      // Seerr's own record of the title (Tell Seerr you have it marks this one available).
      ...(t.mediaInfo?.id ? { mediaId: t.mediaInfo.id } : {}),
      overview: (t.overview ?? "").slice(0, 1200),
      ...(t.releaseDate || t.firstAirDate ? { released: t.releaseDate ?? t.firstAirDate } : {}),
      ...(t.voteAverage ? { rating: Math.round(t.voteAverage * 10) / 10 } : {}),
      ...(t.runtime ? { runtime: t.runtime } : {}),
      genres: (t.genres ?? [])
        .map((g) => g.name ?? "")
        .filter(Boolean)
        .slice(0, 4),
      ...(t.posterPath ? { poster: t.posterPath } : {}),
      ...(t.backdropPath ? { backdrop: t.backdropPath } : {}),
      ...(t.tagline ? { tagline: t.tagline.slice(0, 200) } : {}),
      ...certificationOf(t),
      ...peopleOf(t, type),
      ...((t.externalIds?.imdbId ?? t.imdbId) ? { imdbId: t.externalIds?.imdbId ?? t.imdbId } : {}),
      ...trailerOf(t.relatedVideos),
      seasons: (t.seasons ?? [])
        .filter((s) => s.seasonNumber > 0)
        .map((s) => ({
          number: s.seasonNumber,
          name: s.name ?? `Season ${s.seasonNumber}`,
          episodes: s.episodeCount ?? 0,
          status:
            (has.get(s.seasonNumber) ?? 1) >= 2
              ? MEDIA[has.get(s.seasonNumber)!]
              : asked.has(s.seasonNumber)
                ? "requested"
                : "not requested",
        })),
    };
  }
  if (view === "issues") {
    const filter = q.status === "resolved" ? "resolved" : q.status === "all" ? "all" : "open";
    const page = num(q.page, 1, 100);
    const r = await get<{ pageInfo?: { pages?: number; results?: number }; results?: RawIssue[] }>(
      read,
      `/api/v1/issue?take=25&skip=${(page - 1) * 25}&sort=modified&filter=${filter}`,
    );
    const raw = r.results ?? [];
    const name = await titles(
      read,
      raw.map((i) => i.media ?? {}),
    );
    return {
      page,
      pages: r.pageInfo?.pages ?? 1,
      total: r.pageInfo?.results ?? raw.length,
      issues: raw.map((i) => ({
        id: i.id,
        open: i.status !== 2,
        type: ISSUE_TYPES[i.issueType ?? 4] ?? "Other",
        title: name(i.media ?? {}),
        where: i.problemSeason
          ? `Season ${i.problemSeason}${i.problemEpisode ? `, episode ${i.problemEpisode}` : ""}`
          : undefined,
        by: i.createdBy?.displayName ?? "someone",
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        comments: i.comments?.length ?? 0,
      })),
    };
  }
  if (view === "issue") {
    const id = num(q.id, 0, 10_000_000);
    if (!id) throw new SeerrReadError("Say which issue (id).");
    const i = await get<RawIssue>(read, `/api/v1/issue/${id}`);
    const name = await titles(read, [i.media ?? {}]);
    return {
      id: i.id,
      open: i.status !== 2,
      type: ISSUE_TYPES[i.issueType ?? 4] ?? "Other",
      title: name(i.media ?? {}),
      by: i.createdBy?.displayName ?? "someone",
      createdAt: i.createdAt,
      comments: (i.comments ?? []).map((c) => ({
        id: c.id,
        by: c.user?.displayName ?? "someone",
        at: c.createdAt,
        message: (c.message ?? "").slice(0, 4000),
      })),
    };
  }
  // users: who can request, how much they asked for, their limits. No emails or tokens.
  const r = await get<{
    results?: {
      id: number;
      displayName?: string;
      userType?: number;
      permissions?: number;
      requestCount?: number;
      movieQuotaLimit?: number | null;
      movieQuotaDays?: number | null;
      tvQuotaLimit?: number | null;
      tvQuotaDays?: number | null;
      createdAt?: string;
    }[];
  }>(read, "/api/v1/user?take=100&sort=displayname");
  const kinds: Record<number, string> = { 1: "Plex", 2: "Local", 3: "Jellyfin", 4: "Emby" };
  return {
    users: (r.results ?? []).map((u) => ({
      id: u.id,
      name: u.displayName ?? `User ${u.id}`,
      account: kinds[u.userType ?? 0] ?? "Account",
      // Seerr's permission bit 2 is Admin.
      admin: Boolean((u.permissions ?? 0) & 2),
      requests: u.requestCount ?? 0,
      movieLimit: u.movieQuotaLimit
        ? `${u.movieQuotaLimit} every ${u.movieQuotaDays ?? 7} days`
        : "No limit",
      tvLimit: u.tvQuotaLimit
        ? `${u.tvQuotaLimit} seasons every ${u.tvQuotaDays ?? 7} days`
        : "No limit",
      joined: u.createdAt,
    })),
  };
}

/** The age rating where Seerr's discover region is the US (PG-13, TV-MA), when TMDB has one. */
function certificationOf(t: {
  releases?: { results?: { iso_3166_1?: string; release_dates?: { certification?: string }[] }[] };
  contentRatings?: { results?: { iso_3166_1?: string; rating?: string }[] };
}): { certification?: string } {
  const movie = t.releases?.results
    ?.find((r) => r.iso_3166_1 === "US")
    ?.release_dates?.find((d) => d.certification?.trim())?.certification;
  const tv = t.contentRatings?.results?.find((r) => r.iso_3166_1 === "US")?.rating;
  const c = (movie ?? tv ?? "").trim();
  return c && c.length <= 10 ? { certification: c } : {};
}

/** Who made it and who is in it: the director (or a show's creators) and the first billed cast. */
function peopleOf(
  t: {
    credits?: {
      cast?: { name?: string; character?: string; profilePath?: string; order?: number }[];
      crew?: { name?: string; job?: string }[];
    };
    createdBy?: { name?: string }[];
  },
  type: "movie" | "tv",
) {
  const made =
    type === "tv"
      ? (t.createdBy ?? []).map((p) => p.name ?? "")
      : (t.credits?.crew ?? []).filter((c) => c.job === "Director").map((c) => c.name ?? "");
  const cast = [...(t.credits?.cast ?? [])]
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .slice(0, 15)
    .filter((c) => c.name)
    .map((c) => ({
      name: c.name!,
      ...(c.character ? { character: c.character.slice(0, 60) } : {}),
      ...(c.profilePath ? { photo: c.profilePath } : {}),
    }));
  const names = [...new Set(made.filter(Boolean))].slice(0, 3);
  return {
    ...(names.length ? { [type === "tv" ? "createdBy" : "director"]: names.join(", ") } : {}),
    ...(cast.length ? { cast } : {}),
  };
}

/**
 * A title's YouTube trailer (the owner, 11-10: "a watch trailer that launches the YouTube trailer
 * if it's available"), from TMDB's videos for that exact title, as Seerr returns them. A trailer
 * before a teaser; only a well-formed YouTube id becomes a link. None: no link, never a search.
 */
export function trailerOf(videos: { site?: string; type?: string; key?: string }[] | undefined): {
  trailer?: string;
} {
  const yt = (videos ?? []).filter(
    (v) => v.site === "YouTube" && typeof v.key === "string" && /^[\w-]{11}$/.test(v.key),
  );
  const v = yt.find((x) => x.type === "Trailer") ?? yt.find((x) => x.type === "Teaser");
  return v ? { trailer: `https://www.youtube.com/watch?v=${v.key}` } : {};
}
