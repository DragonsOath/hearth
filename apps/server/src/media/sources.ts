import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "../apps/http";

/**
 * What a media server has just added, in one shape for Plex and Jellyfin: the raw material for
 * media announcements (media/arrivals.ts). Only the newest items are read (a bounded window), never
 * the whole library. Nothing here is sent anywhere: pictures stay as the server's own paths, read
 * later through Hearth and attached to a message, so no internal address or key ever leaves.
 */

/** Movies and episodes from Plex, Jellyfin and Emby; the rest from library apps (library-sources.ts). */
export type MediaKind = "movie" | "episode" | import("@dragon-control/core").LibraryKind;

export interface LibraryItem {
  /** The server's own id for the item. */
  itemId: string;
  kind: MediaKind;
  /** Movie title, or the episode's own title. */
  title: string;
  year?: number;
  /** For episodes: the series, its ids and its year. */
  show?: string;
  showYear?: number;
  showIds?: ProviderIds;
  showItemId?: string;
  season?: number;
  episode?: number;
  ids: ProviderIds;
  /** The library (section) it is in. */
  libraryId: string;
  library: string;
  addedAt?: string;
  overview?: string;
  showOverview?: string;
  genres?: string[];
  runtimeMin?: number;
  /** Community rating, out of 10. */
  rating?: number;
  /** Age rating (PG-13, TV-MA). */
  contentRating?: string;
  /** Server-side picture paths (poster, backdrop), read through Hearth only. */
  poster?: string;
  backdrop?: string;
  /** Trailers the server itself lists for this exact item (YouTube and similar). */
  trailers?: string[];
  /**
   * The video file's own name (no folders), lowercased. Plex and Jellyfin playing the same file
   * are the same movie, even when one of them never recognized it.
   */
  file?: string;
  /** Library kinds (library-sources.ts): artist or author, narrator, series, tracks, pages, system. */
  creators?: string[];
  narrators?: string[];
  seriesName?: string;
  seriesIndex?: number;
  tracks?: number;
  pages?: number;
  platform?: string;
  /** Podcast episodes: the show (`title` is the episode's). */
  podcastShow?: string;
}

/** A file's own name from a full path (either slash), lowercased; never the folders. */
export function fileName(path?: string): string | undefined {
  const name = path?.split(/[/\\]/).pop()?.trim().toLowerCase();
  return name || undefined;
}

export interface ProviderIds {
  tmdb?: string;
  imdb?: string;
  tvdb?: string;
  /** Music: MusicBrainz release (album) id. */
  mbid?: string;
}

/**
 * How many of the newest items are read per library on each check: plenty between two checks.
 * The very first read of a server (the baseline) reads everything once, so an older title that
 * reappears later (a replaced file) is never mistaken for a new one.
 */
export const RECENT_WINDOW = 100;

/* ---------------- Plex ---------------- */

interface PlexRaw {
  ratingKey?: string;
  type?: string;
  title?: string;
  year?: number;
  summary?: string;
  addedAt?: number;
  duration?: number;
  audienceRating?: number;
  rating?: number;
  contentRating?: string;
  thumb?: string;
  art?: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  grandparentThumb?: string;
  grandparentArt?: string;
  parentIndex?: number;
  index?: number;
  librarySectionID?: number | string;
  librarySectionTitle?: string;
  Guid?: { id?: string }[];
  Genre?: { tag?: string }[];
  Media?: { Part?: { file?: string }[] }[];
}

function plexIds(guids?: { id?: string }[]): ProviderIds {
  const ids: ProviderIds = {};
  for (const g of guids ?? []) {
    const m = /^(tmdb|imdb|tvdb):\/\/(.+)$/.exec(g.id ?? "");
    if (m) ids[m[1] as keyof ProviderIds] = m[2];
  }
  return ids;
}

export async function plexGet<T>(f: Fetch, base: string, path: string, token: string): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await f(joinUrl(base, path), {
      headers: { Accept: "application/json", "X-Plex-Token": token },
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch {
    throw new AppUnreachableError("Plex did not answer.");
  }
  if (res.status === 401) throw new AppKeyError("Plex refused the token.");
  if (!res.ok) throw new AppUnreachableError(`Plex answered ${res.status}.`);
  return (await res.json()) as T;
}

export async function plexRecent(
  f: Fetch,
  base: string,
  token: string,
  limit = RECENT_WINDOW,
): Promise<LibraryItem[]> {
  type MC<T> = { MediaContainer?: T };
  const sections = await plexGet<
    MC<{ Directory?: { key?: string; title?: string; type?: string }[] }>
  >(f, base, "/library/sections", token);
  const video = (sections.MediaContainer?.Directory ?? []).filter(
    (d) => d.key && (d.type === "movie" || d.type === "show"),
  );
  const out: LibraryItem[] = [];
  const shows = new Map<string, PlexRaw | null>();
  for (const d of video) {
    // Movies, or each new episode (type 4), newest first, with their outside ids.
    const type = d.type === "movie" ? 1 : 4;
    const r = await plexGet<MC<{ Metadata?: PlexRaw[] }>>(
      f,
      base,
      `/library/sections/${d.key}/all?type=${type}&sort=addedAt:desc&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`,
      token,
    );
    for (const m of r.MediaContainer?.Metadata ?? []) {
      if (!m.ratingKey) continue;
      const base_ = {
        itemId: m.ratingKey,
        libraryId: String(d.key),
        library: d.title ?? "Library",
        ...(m.addedAt ? { addedAt: new Date(m.addedAt * 1000).toISOString() } : {}),
        ...(m.summary ? { overview: m.summary } : {}),
        ...(m.duration ? { runtimeMin: Math.round(m.duration / 60000) } : {}),
        ...((m.audienceRating ?? m.rating) ? { rating: m.audienceRating ?? m.rating } : {}),
        ...(m.contentRating ? { contentRating: m.contentRating } : {}),
        ...(m.Genre?.length ? { genres: m.Genre.map((g) => g.tag ?? "").filter(Boolean) } : {}),
      };
      if (m.type === "movie") {
        out.push({
          ...base_,
          kind: "movie",
          title: m.title ?? "Untitled",
          ...(m.year ? { year: m.year } : {}),
          ids: plexIds(m.Guid),
          ...(m.thumb ? { poster: m.thumb } : {}),
          ...(m.art ? { backdrop: m.art } : {}),
          ...(fileName(m.Media?.[0]?.Part?.[0]?.file)
            ? { file: fileName(m.Media?.[0]?.Part?.[0]?.file) }
            : {}),
        });
      } else if (m.type === "episode") {
        // The series' own ids, read once per series (an episode's guids are its own).
        const sk = m.grandparentRatingKey ?? "";
        if (sk && !shows.has(sk)) {
          const s = await plexGet<MC<{ Metadata?: PlexRaw[] }>>(
            f,
            base,
            `/library/metadata/${sk}?includeGuids=1`,
            token,
          ).catch(() => ({}) as MC<{ Metadata?: PlexRaw[] }>);
          shows.set(sk, s.MediaContainer?.Metadata?.[0] ?? null);
        }
        const show = shows.get(sk) ?? undefined;
        out.push({
          ...base_,
          kind: "episode",
          title: m.title ?? "Episode",
          show: m.grandparentTitle ?? show?.title ?? "A series",
          ...(show?.year ? { showYear: show.year } : {}),
          showIds: plexIds(show?.Guid),
          ...(sk ? { showItemId: sk } : {}),
          ...(show?.summary ? { showOverview: show.summary } : {}),
          ...(m.parentIndex !== undefined ? { season: m.parentIndex } : {}),
          ...(m.index !== undefined ? { episode: m.index } : {}),
          ids: plexIds(m.Guid),
          ...(!base_.genres && show?.Genre?.length
            ? { genres: show.Genre.map((g) => g.tag ?? "").filter(Boolean) }
            : {}),
          ...((m.grandparentThumb ?? show?.thumb)
            ? { poster: m.grandparentThumb ?? show?.thumb }
            : {}),
          ...((m.grandparentArt ?? show?.art) ? { backdrop: m.grandparentArt ?? show?.art } : {}),
        });
      }
    }
  }
  return out;
}

/* ---------------- Jellyfin ---------------- */

interface JfRaw {
  Id?: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  Overview?: string;
  DateCreated?: string;
  RunTimeTicks?: number;
  CommunityRating?: number;
  OfficialRating?: string;
  Genres?: string[];
  ProviderIds?: Record<string, string>;
  RemoteTrailers?: { Url?: string }[];
  SeriesName?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  Path?: string;
}

function jfIds(p?: Record<string, string>): ProviderIds {
  const ids: ProviderIds = {};
  if (p?.Tmdb) ids.tmdb = p.Tmdb;
  if (p?.Imdb) ids.imdb = p.Imdb;
  if (p?.Tvdb) ids.tvdb = p.Tvdb;
  return ids;
}

export async function jfGet<T>(f: Fetch, base: string, path: string, key: string): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await f(joinUrl(base, path), {
      headers: { Accept: "application/json", Authorization: `MediaBrowser Token="${key}"` },
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch {
    throw new AppUnreachableError("Jellyfin did not answer.");
  }
  if (res.status === 401 || res.status === 403) throw new AppKeyError("Jellyfin refused the key.");
  if (!res.ok) throw new AppUnreachableError(`Jellyfin answered ${res.status}.`);
  return (await res.json()) as T;
}

const FIELDS =
  "ProviderIds,Overview,Genres,DateCreated,RemoteTrailers,OfficialRating,CommunityRating,ParentId,Path";

const trailersOf = (r?: { Url?: string }[]) =>
  (r ?? []).map((t) => t.Url ?? "").filter((u) => /^https:\/\//.test(u));

export async function jellyfinRecent(
  f: Fetch,
  base: string,
  key: string,
  limit = RECENT_WINDOW,
): Promise<LibraryItem[]> {
  const folders = await jfGet<{ Name?: string; ItemId?: string; CollectionType?: string }[]>(
    f,
    base,
    "/Library/VirtualFolders",
    key,
  );
  const out: LibraryItem[] = [];
  const series = new Map<string, JfRaw | null>();
  for (const lib of folders.filter(
    (x) => x.ItemId && (x.CollectionType === "movies" || x.CollectionType === "tvshows"),
  )) {
    const types = lib.CollectionType === "movies" ? "Movie" : "Episode";
    const r = await jfGet<{ Items?: JfRaw[] }>(
      f,
      base,
      `/Items?ParentId=${lib.ItemId}&Recursive=true&IncludeItemTypes=${types}&SortBy=DateCreated&SortOrder=Descending&Limit=${limit}&Fields=${FIELDS}`,
      key,
    );
    for (const i of r.Items ?? []) {
      if (!i.Id) continue;
      const common = {
        itemId: i.Id,
        libraryId: lib.ItemId!,
        library: lib.Name ?? "Library",
        ...(i.DateCreated ? { addedAt: i.DateCreated } : {}),
        ...(i.Overview ? { overview: i.Overview } : {}),
        ...(i.RunTimeTicks ? { runtimeMin: Math.round(i.RunTimeTicks / 600_000_000) } : {}),
        ...(i.CommunityRating ? { rating: i.CommunityRating } : {}),
        ...(i.OfficialRating ? { contentRating: i.OfficialRating } : {}),
        ...(i.Genres?.length ? { genres: i.Genres } : {}),
      };
      if (i.Type === "Movie") {
        out.push({
          ...common,
          kind: "movie",
          title: i.Name ?? "Untitled",
          ...(i.ProductionYear ? { year: i.ProductionYear } : {}),
          ids: jfIds(i.ProviderIds),
          ...(i.ImageTags?.Primary ? { poster: `/Items/${i.Id}/Images/Primary` } : {}),
          ...(i.BackdropImageTags?.length ? { backdrop: `/Items/${i.Id}/Images/Backdrop` } : {}),
          ...(trailersOf(i.RemoteTrailers).length
            ? { trailers: trailersOf(i.RemoteTrailers) }
            : {}),
          ...(fileName(i.Path) ? { file: fileName(i.Path) } : {}),
        });
      } else if (i.Type === "Episode") {
        const sid = i.SeriesId ?? "";
        if (sid && !series.has(sid)) {
          const s = await jfGet<{ Items?: JfRaw[] }>(
            f,
            base,
            `/Items?Ids=${sid}&Fields=${FIELDS}`,
            key,
          ).catch(() => ({}) as { Items?: JfRaw[] });
          series.set(sid, s.Items?.[0] ?? null);
        }
        const s = series.get(sid) ?? undefined;
        out.push({
          ...common,
          kind: "episode",
          title: i.Name ?? "Episode",
          show: i.SeriesName ?? s?.Name ?? "A series",
          ...(s?.ProductionYear ? { showYear: s.ProductionYear } : {}),
          showIds: jfIds(s?.ProviderIds),
          ...(sid ? { showItemId: sid } : {}),
          ...(s?.Overview ? { showOverview: s.Overview } : {}),
          ...(i.ParentIndexNumber !== undefined ? { season: i.ParentIndexNumber } : {}),
          ...(i.IndexNumber !== undefined ? { episode: i.IndexNumber } : {}),
          ids: jfIds(i.ProviderIds),
          ...(!common.genres && s?.Genres?.length ? { genres: s.Genres } : {}),
          ...(sid
            ? { poster: `/Items/${sid}/Images/Primary`, backdrop: `/Items/${sid}/Images/Backdrop` }
            : {}),
          ...(trailersOf(s?.RemoteTrailers).length
            ? { trailers: trailersOf(s?.RemoteTrailers) }
            : {}),
        });
      }
    }
  }
  return out;
}

/** Enough to cover a whole library on the one-time baseline read. */
export const BASELINE_LIMIT = 100_000;
