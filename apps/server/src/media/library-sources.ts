import { get as absGet } from "../apps/audiobookshelf";
import type { Fetch } from "../apps/http";
import { session as kavitaSession } from "../apps/kavita";
import { type NdLogin, subsonic } from "../apps/navidrome";
import { type RommCredential, rommGames } from "../apps/romm";
import { jfGet, type LibraryItem, plexGet, RECENT_WINDOW } from "./sources";

/**
 * What the library apps just added, in the same shape as Plex's and Jellyfin's movies and
 * episodes (sources.ts), for "New in your library": albums from Plex, Jellyfin, Emby and
 * Navidrome; audiobooks, ebooks and podcast episodes from Audiobookshelf; books and comics from
 * Kavita; games from RomM. Only the newest items are read, and only from libraries: downloaders
 * (Lidarr, Readarr) announce nothing, and personal media (photo libraries, home videos, Kavita's
 * image libraries, Immich) is never read at all.
 */

const iso = (t?: number | string | null) => {
  if (t === undefined || t === null || t === "") return undefined;
  const d = typeof t === "number" ? new Date(t < 1e11 ? t * 1000 : t) : new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const list = (...xs: (string | undefined | null)[]) =>
  xs.flatMap((x) => (x ?? "").split(/\s*,\s*/)).filter(Boolean);
const num = (x: unknown) => {
  const n = typeof x === "string" ? Number.parseFloat(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const yearOf = (x: unknown) => {
  const n = num(x);
  return n && n > 1000 && n < 3000 ? Math.floor(n) : undefined;
};

/**
 * Reads each library on its own: one that fails (an older app without that route, a library
 * being rebuilt) never hides the others. Only when every one fails does the read fail, so a
 * server that is down is never taken as an empty one.
 */
async function eachLibrary<L>(
  libs: L[],
  read: (lib: L) => Promise<LibraryItem[]>,
): Promise<LibraryItem[]> {
  const out: LibraryItem[] = [];
  let failed: unknown;
  let ok = 0;
  for (const lib of libs) {
    try {
      out.push(...(await read(lib)));
      ok++;
    } catch (e) {
      failed = e;
    }
  }
  if (libs.length && !ok) throw failed;
  return out;
}

/* ---------------- Plex music ---------------- */

export interface PlexAlbumRaw {
  ratingKey?: string;
  title?: string;
  parentTitle?: string;
  year?: number;
  addedAt?: number;
  leafCount?: number;
  thumb?: string;
  summary?: string;
  Genre?: { tag?: string }[];
  Guid?: { id?: string }[];
}

export function plexAlbum(m: PlexAlbumRaw, lib: { id: string; name: string }): LibraryItem {
  const mbid = (m.Guid ?? []).map((g) => /^mbid:\/\/(.+)$/.exec(g.id ?? "")?.[1]).find(Boolean);
  return {
    itemId: m.ratingKey ?? "",
    kind: "album",
    title: m.title ?? "Untitled",
    ...(m.year ? { year: m.year } : {}),
    ids: mbid ? { mbid } : {},
    libraryId: lib.id,
    library: lib.name,
    ...(iso(m.addedAt) ? { addedAt: iso(m.addedAt)! } : {}),
    ...(m.parentTitle ? { creators: [m.parentTitle] } : {}),
    ...(m.leafCount ? { tracks: m.leafCount } : {}),
    ...(m.summary ? { overview: m.summary } : {}),
    ...(m.Genre?.length ? { genres: m.Genre.map((g) => g.tag ?? "").filter(Boolean) } : {}),
    ...(m.thumb ? { poster: m.thumb } : {}),
  };
}

/** The newest albums in Plex's music libraries. */
export async function plexAlbums(
  f: Fetch,
  base: string,
  token: string,
  limit = RECENT_WINDOW,
): Promise<LibraryItem[]> {
  const sections = await plexGet<{
    MediaContainer?: { Directory?: { key?: string; type?: string; title?: string }[] };
  }>(f, base, "/library/sections", token);
  const music = (sections.MediaContainer?.Directory ?? []).filter(
    (d) => d.key && d.type === "artist",
  );
  return eachLibrary(music, async (d) => {
    const page = await plexGet<{ MediaContainer?: { Metadata?: PlexAlbumRaw[] } }>(
      f,
      base,
      // type 9: albums.
      `/library/sections/${d.key}/all?type=9&sort=addedAt:desc&includeGuids=1&X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`,
      token,
    );
    return (page.MediaContainer?.Metadata ?? []).map((m) =>
      plexAlbum(m, { id: String(d.key), name: d.title ?? "Music" }),
    );
  });
}

/* ---------------- Jellyfin and Emby music ---------------- */

export interface JfAlbumRaw {
  Id?: string;
  Name?: string;
  AlbumArtist?: string;
  AlbumArtists?: { Name?: string }[];
  ProductionYear?: number;
  DateCreated?: string;
  ChildCount?: number;
  RunTimeTicks?: number;
  Genres?: string[];
  Overview?: string;
  ProviderIds?: Record<string, string>;
  ImageTags?: Record<string, string>;
}

export function jellyfinAlbum(a: JfAlbumRaw, lib: { id: string; name: string }): LibraryItem {
  const artists = a.AlbumArtists?.map((x) => x.Name ?? "").filter(Boolean);
  const mbid = a.ProviderIds?.MusicBrainzAlbum;
  return {
    itemId: a.Id ?? "",
    kind: "album",
    title: a.Name ?? "Untitled",
    ...(a.ProductionYear ? { year: a.ProductionYear } : {}),
    ids: mbid ? { mbid } : {},
    libraryId: lib.id,
    library: lib.name,
    ...(a.DateCreated ? { addedAt: a.DateCreated } : {}),
    ...(artists?.length
      ? { creators: artists }
      : a.AlbumArtist
        ? { creators: [a.AlbumArtist] }
        : {}),
    ...(a.ChildCount ? { tracks: a.ChildCount } : {}),
    ...(a.RunTimeTicks ? { runtimeMin: Math.round(a.RunTimeTicks / 600_000_000) } : {}),
    ...(a.Overview ? { overview: a.Overview } : {}),
    ...(a.Genres?.length ? { genres: a.Genres } : {}),
    ...(a.ImageTags?.Primary ? { poster: `/Items/${a.Id}/Images/Primary` } : {}),
  };
}

/** The newest albums in Jellyfin's (or Emby's) music libraries. */
export async function jellyfinAlbums(
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
  const music = folders.filter((l) => l.ItemId && l.CollectionType === "music");
  return eachLibrary(music, async (lib) => {
    const page = await jfGet<{ Items?: JfAlbumRaw[] }>(
      f,
      base,
      `/Items?ParentId=${lib.ItemId}&Recursive=true&IncludeItemTypes=MusicAlbum&SortBy=DateCreated&SortOrder=Descending&Limit=${limit}&Fields=ProviderIds,Genres,DateCreated,ChildCount,Overview`,
      key,
    );
    return (page.Items ?? []).map((a) =>
      jellyfinAlbum(a, { id: lib.ItemId!, name: lib.Name ?? "Music" }),
    );
  });
}

/* ---------------- Navidrome ---------------- */

export interface NdAlbumRaw {
  id?: string;
  name?: string;
  artist?: string;
  year?: number;
  genre?: string;
  genres?: { name?: string }[];
  songCount?: number;
  duration?: number;
  created?: string;
  coverArt?: string;
}

export function navidromeAlbum(a: NdAlbumRaw): LibraryItem {
  const genres = a.genres?.map((g) => g.name ?? "").filter(Boolean) ?? list(a.genre);
  return {
    itemId: a.id ?? "",
    kind: "album",
    title: a.name ?? "Untitled",
    ...(a.year ? { year: a.year } : {}),
    ids: {},
    libraryId: "music",
    library: "Music",
    ...(a.created ? { addedAt: a.created } : {}),
    ...(a.artist ? { creators: [a.artist] } : {}),
    ...(a.songCount ? { tracks: a.songCount } : {}),
    ...(a.duration ? { runtimeMin: Math.round(a.duration / 60) } : {}),
    ...(genres.length ? { genres } : {}),
    ...(a.coverArt ? { poster: a.coverArt } : {}),
  };
}

/** Navidrome's newest albums (Subsonic getAlbumList2, newest first). */
export async function navidromeAlbums(
  f: Fetch,
  base: string,
  login: NdLogin,
  limit = RECENT_WINDOW,
): Promise<LibraryItem[]> {
  const { body } = await subsonic<{ albumList2?: { album?: NdAlbumRaw[] } }>(
    f,
    base,
    login,
    "getAlbumList2",
    { type: "newest", size: String(Math.min(500, limit)) },
  );
  return (body.albumList2?.album ?? []).map(navidromeAlbum);
}

/* ---------------- Audiobookshelf ---------------- */

export interface AbsItemRaw {
  id?: string;
  libraryId?: string;
  addedAt?: number;
  mediaType?: string;
  media?: {
    coverPath?: string | null;
    duration?: number;
    numTracks?: number;
    ebookFormat?: string;
    metadata?: {
      title?: string;
      authorName?: string;
      narratorName?: string;
      seriesName?: string;
      publishedYear?: string;
      genres?: string[];
      description?: string;
    };
  };
}

/** "The Expanse #3" (Audiobookshelf's series text) as its name and number. */
function seriesOf(text?: string): { seriesName?: string; seriesIndex?: number } {
  const first = text?.split(",")[0]?.trim();
  if (!first) return {};
  const m = /^(.*?)\s*#\s*([\d.]+)$/.exec(first);
  return m ? { seriesName: m[1]!, seriesIndex: Number(m[2]) } : { seriesName: first };
}

/** An audiobook (it has audio) or an ebook (only a book file); anything else is skipped. */
export function absItem(r: AbsItemRaw, lib: { id: string; name: string }): LibraryItem | undefined {
  const tracks = r.media?.numTracks ?? 0;
  const kind = tracks > 0 ? "audiobook" : r.media?.ebookFormat ? "book" : undefined;
  if (!kind || !r.id) return undefined;
  const m = r.media?.metadata ?? {};
  return {
    itemId: r.id,
    kind,
    title: m.title ?? "Untitled",
    ...(yearOf(m.publishedYear) ? { year: yearOf(m.publishedYear)! } : {}),
    ids: {},
    libraryId: lib.id,
    library: lib.name,
    ...(iso(r.addedAt) ? { addedAt: iso(r.addedAt)! } : {}),
    ...(list(m.authorName).length ? { creators: list(m.authorName) } : {}),
    ...(kind === "audiobook" && list(m.narratorName).length
      ? { narrators: list(m.narratorName) }
      : {}),
    ...seriesOf(m.seriesName),
    ...(kind === "audiobook" && r.media?.duration
      ? { runtimeMin: Math.round(r.media.duration / 60) }
      : {}),
    ...(m.genres?.length ? { genres: m.genres } : {}),
    ...(m.description ? { overview: m.description.replace(/<[^>]*>/g, " ").trim() } : {}),
    ...(r.media?.coverPath ? { poster: `/api/items/${r.id}/cover` } : {}),
  };
}

export interface AbsEpisodeRaw {
  id?: string;
  libraryItemId?: string;
  title?: string;
  publishedAt?: number;
  addedAt?: number;
  description?: string;
  podcast?: { metadata?: { title?: string; author?: string; genres?: string[] } };
}

export function absEpisode(
  e: AbsEpisodeRaw,
  lib: { id: string; name: string },
): LibraryItem | undefined {
  if (!e.id || !e.libraryItemId) return undefined;
  const p = e.podcast?.metadata ?? {};
  return {
    itemId: `${e.libraryItemId}/${e.id}`,
    kind: "podcast",
    title: e.title ?? "A new episode",
    ids: {},
    libraryId: lib.id,
    library: lib.name,
    ...(iso(e.addedAt ?? e.publishedAt) ? { addedAt: iso(e.addedAt ?? e.publishedAt)! } : {}),
    ...(p.title ? { podcastShow: p.title } : {}),
    ...(p.author ? { creators: [p.author] } : {}),
    ...(p.genres?.length ? { genres: p.genres } : {}),
    ...(e.description ? { overview: e.description.replace(/<[^>]*>/g, " ").trim() } : {}),
    poster: `/api/items/${e.libraryItemId}/cover`,
  };
}

/** Audiobookshelf's newest audiobooks, ebooks and podcast episodes. */
export async function audiobookshelfRecent(
  f: Fetch,
  base: string,
  key: string,
  limit = RECENT_WINDOW,
): Promise<LibraryItem[]> {
  const g = <T>(path: string) => absGet<T>(f, base, key, path);
  const libs = await g<{ libraries?: { id: string; name?: string; mediaType?: string }[] }>(
    "/api/libraries",
  );
  return eachLibrary(libs.libraries ?? [], async (l) => {
    const lib = { id: l.id, name: l.name ?? "Library" };
    const id = encodeURIComponent(l.id);
    if (l.mediaType === "podcast") {
      const r = await g<{ episodes?: AbsEpisodeRaw[] }>(
        `/api/libraries/${id}/recent-episodes?limit=${limit}&page=0`,
      );
      return (r.episodes ?? []).flatMap((e) => absEpisode(e, lib) ?? []);
    }
    const r = await g<{ results?: AbsItemRaw[] }>(
      `/api/libraries/${id}/items?sort=addedAt&desc=1&limit=${limit}`,
    );
    return (r.results ?? []).flatMap((x) => absItem(x, lib) ?? []);
  });
}

/* ---------------- Kavita ---------------- */

/** Kavita's library types: 0 manga, 1 comic, 2 book, 3 images, 4 light novel, 5 comic (ComicVine). */
const KAVITA_KIND: Record<number, "comic" | "book" | undefined> = {
  0: "comic",
  1: "comic",
  2: "book",
  3: undefined, // Image libraries can be personal pictures: never announced.
  4: "book",
  5: "comic",
};

export interface KavitaRecentRaw {
  seriesId?: number;
  seriesName?: string;
  libraryId?: number;
  libraryName?: string;
  libraryType?: number;
  title?: string;
  created?: string;
  chapterId?: number;
  volumeId?: number;
  id?: number;
}

/** One new chapter or volume of a series (Kavita's "recently updated"). */
export function kavitaItem(r: KavitaRecentRaw): LibraryItem | undefined {
  const kind = KAVITA_KIND[r.libraryType ?? -1];
  if (!kind || r.seriesId === undefined) return undefined;
  const series = r.seriesName ?? "A series";
  const number = /(\d+(?:\.\d+)?)\s*$/.exec(r.title ?? "")?.[1];
  const title = r.title && r.title !== series ? `${series}: ${r.title}` : series;
  return {
    itemId: `${r.seriesId}/${r.chapterId ?? r.volumeId ?? r.id ?? 0}`,
    kind,
    title,
    ids: {},
    libraryId: String(r.libraryId ?? ""),
    library: r.libraryName ?? "Library",
    ...(r.created ? { addedAt: r.created.replace(/Z?$/, "Z") } : {}),
    ...(kind === "comic" ? { seriesName: series } : {}),
    ...(kind === "comic" && number ? { seriesIndex: Number(number) } : {}),
    poster: `/api/Image/series-cover?seriesId=${r.seriesId}`,
  };
}

/**
 * Kavita's newest chapters and volumes (GET /api/Series/recently-updated-series). Not yet checked
 * against a real Kavita (its source could not be read): verify on a real install before relying on it.
 */
export async function kavitaRecent(f: Fetch, base: string, key: string): Promise<LibraryItem[]> {
  const { get } = await kavitaSession(f, base, key);
  const rows = await get<KavitaRecentRaw[]>("/api/Series/recently-updated-series");
  return (rows ?? []).flatMap((r) => kavitaItem(r) ?? []);
}

/* ---------------- RomM ---------------- */

/** RomM's newest games (its own "added" order), one per game. */
export async function rommRecent(
  f: Fetch,
  base: string,
  cred: RommCredential,
): Promise<LibraryItem[]> {
  const page = await rommGames(f, base, cred, { order: "added" });
  return page.items.map((g) => ({
    itemId: String(g.id),
    kind: "game" as const,
    title: g.name,
    ...(g.year ? { year: g.year } : {}),
    ids: {},
    libraryId: g.platformSlug || "games",
    library: g.platform || "Games",
    ...(g.addedAt ? { addedAt: g.addedAt } : {}),
    ...(g.platform ? { platform: g.platform } : {}),
    ...(g.cover ? { poster: `/api/roms/${g.id}/cover` } : {}),
  }));
}
