import type { MovieItem, MovieTier, RadarrLibrary } from "@dragon-control/core";

/**
 * Radarr's whole library, summarised for its panel: what the collection is like (how sharp,
 * which codecs, how big), what is coming out, what is below the quality its profile asks for,
 * and which collections are partly there. Radarr's full movie list is large (tens of MB for a
 * few thousand movies), so it is read at most every LIBRARY_MS and only the summary goes to the
 * browser. Find searches a compact index kept here, without re-reading Radarr.
 */

export const LIBRARY_MS = 5 * 60_000;

export interface RawMovie {
  id: number;
  title?: string;
  year?: number;
  monitored?: boolean;
  hasFile?: boolean;
  sizeOnDisk?: number;
  path?: string;
  tmdbId?: number;
  status?: string;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  ratings?: { imdb?: { value?: number; votes?: number }; tmdb?: { value?: number } };
  collection?: { tmdbId?: number; title?: string };
  movieFile?: {
    size?: number;
    quality?: { quality?: { name?: string; resolution?: number } };
    mediaInfo?: { videoCodec?: string; videoDynamicRangeType?: string };
  };
}

export interface RawCollection {
  id: number;
  title?: string;
  tmdbId?: number;
  movies?: {
    tmdbId: number;
    title?: string;
    year?: number;
    status?: string;
    isExisting?: boolean;
    isExcluded?: boolean;
  }[];
}

export interface RawRoot {
  path: string;
  freeSpace?: number;
  totalSpace?: number;
}

const TIERS: MovieTier[] = ["4K", "1080p", "720p", "SD", "Unknown"];
const UPGRADE_SAMPLE = 60;
const MAX_COLLECTIONS = 150;
const COMING_DAYS = 180;

export function tierOf(resolution?: number): MovieTier {
  if (!resolution) return "Unknown";
  if (resolution >= 2160) return "4K";
  if (resolution >= 1080) return "1080p";
  if (resolution >= 720) return "720p";
  return "SD";
}

export function movieItem(m: RawMovie, belowCutoff?: boolean): MovieItem {
  const f = m.hasFile ? m.movieFile : undefined;
  const q = f?.quality?.quality;
  const hdr = f?.mediaInfo?.videoDynamicRangeType?.trim();
  const rating = m.ratings?.imdb?.value ?? m.ratings?.tmdb?.value;
  return {
    movieId: m.id,
    title: m.title ?? "A movie",
    ...(m.year ? { year: m.year } : {}),
    monitored: m.monitored ?? false,
    hasFile: Boolean(m.hasFile),
    ...(f ? { tier: tierOf(q?.resolution) } : {}),
    ...(q?.name ? { quality: q.name } : {}),
    ...(m.sizeOnDisk || f?.size ? { sizeBytes: m.sizeOnDisk || f?.size } : {}),
    ...(f?.mediaInfo?.videoCodec ? { codec: f.mediaInfo.videoCodec } : {}),
    ...(hdr ? { hdr } : {}),
    ...(rating ? { rating: Math.round(rating * 10) / 10 } : {}),
    ...(belowCutoff ? { belowCutoff: true } : {}),
  };
}

const byRating = (a: MovieItem, b: MovieItem) =>
  (b.rating ?? 0) - (a.rating ?? 0) || a.title.localeCompare(b.title);

export function radarrLibrary(
  movies: RawMovie[],
  belowCutoff: Set<number>,
  collections: RawCollection[],
  roots: RawRoot[],
  now: Date,
): { library: RadarrLibrary; index: MovieItem[] } {
  const index = movies.map((m) => ({
    ...movieItem(m, belowCutoff.has(m.id)),
    ...(m.path ? { path: m.path } : {}),
  }));
  const onDisk = index.filter((m) => m.hasFile);

  const tiers = TIERS.map((tier) => {
    const these = onDisk.filter((m) => m.tier === tier);
    return {
      tier,
      count: these.length,
      sizeBytes: these.reduce((n, m) => n + (m.sizeBytes ?? 0), 0),
    };
  }).filter((t) => t.count > 0);

  const codecCount = new Map<string, number>();
  for (const m of onDisk) if (m.codec) codecCount.set(m.codec, (codecCount.get(m.codec) ?? 0) + 1);
  const codecs = [...codecCount]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const biggest = [...onDisk]
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))
    .slice(0, 5)
    .map(({ path: _path, ...m }) => m);

  // The next date each wanted movie comes out: digital first (that is when downloads appear).
  const until = now.getTime() + COMING_DAYS * 86_400_000;
  const coming = movies
    .filter((m) => m.monitored && !m.hasFile)
    .flatMap((m) => {
      const next = (
        [
          ["digital", m.digitalRelease],
          ["physical", m.physicalRelease],
          ["cinema", m.inCinemas],
        ] as const
      )
        .map(([kind, on]) => ({ kind, at: on ? Date.parse(on) : NaN, on }))
        .filter((x) => x.at >= now.getTime() && x.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      return next
        ? [
            {
              movieId: m.id,
              title: m.title ?? "A movie",
              ...(m.year ? { year: m.year } : {}),
              on: next.on!,
              kind: next.kind,
            },
          ]
        : [];
    })
    .sort((a, b) => Date.parse(a.on) - Date.parse(b.on))
    .slice(0, 40);

  // Below cutoff: counted per tier; the best-rated of each tier are listed.
  const upgradable = onDisk.filter((m) => m.belowCutoff);
  const byTier = TIERS.map((tier) => ({
    tier,
    count: upgradable.filter((m) => m.tier === tier).length,
  })).filter((t) => t.count > 0);
  const upgradeItems = byTier.flatMap((t) =>
    upgradable
      .filter((m) => m.tier === t.tier)
      .sort(byRating)
      .slice(0, UPGRADE_SAMPLE)
      .map(({ path: _path, ...m }) => m),
  );

  const partial = collections
    .flatMap((c) => {
      const all = (c.movies ?? []).filter((m) => !m.isExcluded);
      const have = all.filter((m) => m.isExisting).length;
      const missing = all
        .filter((m) => !m.isExisting)
        .map((m) => ({
          tmdbId: m.tmdbId,
          title: m.title ?? "A movie",
          ...(m.year ? { year: m.year } : {}),
          released: m.status === "released",
        }));
      return have > 0 && missing.some((m) => m.released)
        ? [{ id: c.id, title: c.title ?? "A collection", have, total: all.length, missing }]
        : [];
    })
    .sort((a, b) => b.have / b.total - a.have / a.total || a.title.localeCompare(b.title));

  return {
    index,
    library: {
      at: now.toISOString(),
      onDisk: onDisk.length,
      sizeBytes: onDisk.reduce((n, m) => n + (m.sizeBytes ?? 0), 0),
      tiers,
      hdr: onDisk.filter((m) => m.hdr).length,
      codecs,
      biggest,
      folders: roots.map((r) => ({
        path: r.path,
        ...(r.freeSpace !== undefined ? { freeBytes: r.freeSpace } : {}),
        ...(r.totalSpace ? { totalBytes: r.totalSpace } : {}),
      })),
      coming,
      upgrades: { total: upgradable.length, byTier, items: upgradeItems },
      collectionsTotal: partial.length,
      collections: partial.slice(0, MAX_COLLECTIONS),
    },
  };
}

/** Find movies by title (and year): exact starts first, then contains; at most 40. */
export function findMovies(index: MovieItem[], q: string): MovieItem[] {
  const words = q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N} ]/gu, " ");
  const hits = index.filter((m) => {
    const hay = `${norm(m.title)} ${m.year ?? ""}`;
    return words.every((w) => hay.includes(w));
  });
  const first = norm(q).trim();
  return hits
    .sort(
      (a, b) =>
        Number(norm(b.title).startsWith(first)) - Number(norm(a.title).startsWith(first)) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 40);
}
