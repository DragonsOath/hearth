import type {
  ReleaseOption,
  ReleaseScope,
  ReleaseSearchResult,
  SearchApp,
  SearchEpisode,
  SearchTitle,
} from "@dragon-control/core";
import { releaseDetails } from "@dragon-control/core";
import { gb } from "./media-library";

/**
 * Interactive search in Sonarr, Radarr, Lidarr and Chaptarr (10-26): find a title in the
 * library, list what the indexers offer for it (the app's own "interactive search", which
 * downloads nothing), and send one chosen release to the download client. Sonarr and Radarr speak
 * API v3, Lidarr and Chaptarr v1; the calls are otherwise the same.
 */

export type Call = <T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<{ ok: boolean; status: number; data: T }>;

const v = (app: SearchApp) => (app === "sonarr" || app === "radarr" ? "v3" : "v1");
const MAX_TITLES = 25;
const MAX_RELEASES = 100;

/** Lower case, accents and punctuation folded, so "Mist & Fury" and "mist and fury," compare. */
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const matches = (q: string, ...texts: (string | undefined)[]) => {
  const words = fold(q).split(" ").filter(Boolean);
  const hay = ` ${fold(texts.filter(Boolean).join(" "))} `;
  return words.length > 0 && words.every((w) => hay.includes(w));
};

type Person = { authorName?: string; artistName?: string };
interface RawTitle {
  id: number;
  title?: string;
  year?: number;
  monitored?: boolean;
  hasFile?: boolean;
  statistics?: { episodeFileCount?: number; bookFileCount?: number; trackFileCount?: number };
  seasons?: { seasonNumber: number }[];
  author?: Person;
  artist?: Person;
  authorId?: number;
  authorTitle?: string;
  seriesTitle?: string;
  foreignBookId?: string;
  releaseDate?: string;
  mediaType?: string;
  bookType?: string;
  format?: string;
}

/** Titles in the library whose name (or author, or artist) has every word typed. */
export async function searchTitles(app: SearchApp, call: Call, q: string): Promise<SearchTitle[]> {
  const words = q.trim();
  if (!words) return [];
  if (app === "chaptarr") return chaptarrTitles(call, words);
  const path =
    app === "radarr"
      ? "/api/v3/movie"
      : app === "sonarr"
        ? "/api/v3/series"
        : app === "lidarr"
          ? "/api/v1/album?includeAllArtistAlbums=true"
          : "/api/v1/book";
  const r = await call<RawTitle[]>("GET", path);
  if (!r.ok) throw new Error(`The app did not list its library (${r.status}).`);
  const list = Array.isArray(r.data) ? r.data : [];
  const kind: SearchTitle["kind"] =
    app === "radarr" ? "movie" : app === "sonarr" ? "series" : app === "lidarr" ? "album" : "book";
  return list
    .filter((x) =>
      matches(words, x.title, x.author?.authorName, x.artist?.artistName, x.authorTitle),
    )
    .slice(0, MAX_TITLES)
    .map((x) => {
      const by = x.author?.authorName ?? x.artist?.artistName;
      const year = x.year ?? (x.releaseDate ? Number(x.releaseDate.slice(0, 4)) : undefined);
      const has =
        x.hasFile ??
        (x.statistics
          ? (x.statistics.episodeFileCount ??
              x.statistics.bookFileCount ??
              x.statistics.trackFileCount ??
              0) > 0
          : undefined);
      return {
        id: x.id,
        title: x.title ?? "Untitled",
        kind,
        ...(year && Number.isFinite(year) ? { year } : {}),
        ...(by ? { by } : {}),
        ...(has !== undefined ? { hasFile: has } : {}),
        ...(x.monitored !== undefined ? { monitored: x.monitored } : {}),
        ...(app === "sonarr" && x.seasons
          ? {
              seasons: x.seasons
                .map((s) => s.seasonNumber)
                .filter((n) => n > 0)
                .sort((a, b) => a - b),
            }
          : {}),
      };
    });
}

/** "A Court of Mist and Fury (A Court of Thorns and Roses, #2)" -> "a court of mist and fury". */
const bareTitle = (t: string) => fold(t.replace(/\s*\([^)]*#\s*[\d.]+\)\s*$/, ""));

/**
 * Chaptarr: the library's books whose title, series or author has every word typed, then what
 * Chaptarr's own search finds that isn't in the library yet (as its site shows). A library that
 * can't be read is said plainly, never shown as "nothing matches".
 */
async function chaptarrTitles(call: Call, words: string): Promise<SearchTitle[]> {
  const [lib, authors, look] = await Promise.all([
    call<RawTitle[]>("GET", "/api/v1/book"),
    call<{ id: number; authorName?: string }[]>("GET", "/api/v1/author").catch(() => undefined),
    call<RawTitle[]>("GET", `/api/v1/book/lookup?term=${encodeURIComponent(words)}`).catch(
      () => undefined,
    ),
  ]);
  if (!lib.ok) throw new Error(`Chaptarr did not list its library (${lib.status}).`);
  if (!Array.isArray(lib.data))
    throw new Error(
      "Chaptarr's library came back in a form Hearth couldn't read, so nothing could be matched. Try again; if it keeps happening, check Chaptarr's logs.",
    );
  const names = new Map<number, string>();
  if (authors?.ok && Array.isArray(authors.data))
    for (const a of authors.data) if (a.authorName) names.set(a.id, a.authorName);
  const by = (x: RawTitle) =>
    x.author?.authorName ?? (x.authorId ? names.get(x.authorId) : undefined);
  const typed = fold(words);
  const rank = (x: RawTitle) => {
    const t = bareTitle(x.title ?? "");
    return t === typed ? 0 : t.startsWith(typed) ? 1 : 2;
  };
  const inLibrary = lib.data
    .filter((x) => matches(words, x.title, x.seriesTitle, by(x), x.authorTitle))
    // The closest titles first: exactly what was typed, then titles starting with it.
    .sort((a, b) => rank(a) - rank(b) || (a.title ?? "").length - (b.title ?? "").length)
    .slice(0, MAX_TITLES);
  const known = new Set(lib.data.map((x) => x.foreignBookId).filter(Boolean));
  const shown = new Set(inLibrary.map((x) => `${bareTitle(x.title ?? "")}|${x.mediaType ?? ""}`));
  const outside =
    look?.ok && Array.isArray(look.data)
      ? look.data
          .filter(
            (x) =>
              x.foreignBookId &&
              !known.has(x.foreignBookId) &&
              !shown.has(`${bareTitle(x.title ?? "")}|${x.mediaType ?? ""}`),
          )
          .slice(0, 10)
      : [];
  const one = (x: RawTitle, id: number): SearchTitle => {
    const author = by(x);
    const year = x.releaseDate ? Number(x.releaseDate.slice(0, 4)) : undefined;
    const format = x.mediaType ?? x.bookType ?? x.format;
    const has =
      x.statistics?.bookFileCount !== undefined ? x.statistics.bookFileCount > 0 : undefined;
    return {
      id,
      title: x.title ?? "Untitled",
      kind: "book",
      ...(year && Number.isFinite(year) ? { year } : {}),
      ...(author ? { by: author } : {}),
      ...(format ? { format: String(format) } : {}),
      ...(has !== undefined ? { hasFile: has } : {}),
      ...(x.monitored !== undefined ? { monitored: x.monitored } : {}),
    };
  };
  return [
    ...inLibrary.map((x) => one(x, x.id)),
    ...outside.map((x) => ({
      ...one(x, 0),
      notInLibrary: {
        foreignBookId: x.foreignBookId!,
        addUrl: `/add/search?term=${encodeURIComponent(words)}`,
      },
    })),
  ];
}

/** Sonarr: a series' episodes, to search for one on its own. */
export async function seriesEpisodes(call: Call, seriesId: number): Promise<SearchEpisode[]> {
  const r = await call<
    {
      id: number;
      seasonNumber: number;
      episodeNumber: number;
      title?: string;
      hasFile?: boolean;
      airDate?: string;
    }[]
  >("GET", `/api/v3/episode?seriesId=${seriesId}`);
  if (!r.ok) throw new Error(`Sonarr did not list the episodes (${r.status}).`);
  return (Array.isArray(r.data) ? r.data : [])
    .filter((e) => e.seasonNumber > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
    .map((e) => ({
      id: e.id,
      season: e.seasonNumber,
      episode: e.episodeNumber,
      ...(e.title ? { title: e.title } : {}),
      ...(e.hasFile !== undefined ? { hasFile: e.hasFile } : {}),
      ...(e.airDate ? { airDate: e.airDate } : {}),
    }));
}

/** The query that asks the app for one item's releases. */
export function scopeQuery(app: SearchApp, scope: ReleaseScope): string {
  const s = scope as Record<string, number>;
  const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
  if (app === "radarr" && ok(s.movieId)) return `movieId=${s.movieId}`;
  if (app === "sonarr" && ok(s.episodeId)) return `episodeId=${s.episodeId}`;
  if (app === "sonarr" && ok(s.seriesId) && Number.isInteger(s.seasonNumber))
    return `seriesId=${s.seriesId}&seasonNumber=${s.seasonNumber}`;
  if (app === "lidarr" && ok(s.albumId)) return `albumId=${s.albumId}`;
  if (app === "chaptarr" && ok(s.bookId)) return `bookId=${s.bookId}`;
  throw new Error("Say what to search for.");
}

interface RawRelease {
  guid?: string;
  indexerId?: number;
  title?: string;
  indexer?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  protocol?: string;
  ageHours?: number;
  age?: number;
  quality?: { quality?: { name?: string; source?: string; resolution?: number } };
  customFormatScore?: number;
  approved?: boolean;
  rejected?: boolean;
  fullSeason?: boolean;
  rejections?: (string | { reason?: string })[];
}

const reasonOf = (r: string | { reason?: string }) =>
  typeof r === "string" ? r : (r.reason ?? "");

/** One raw release as Hearth shows it. */
export function toOption(x: RawRelease): ReleaseOption | undefined {
  if (!x.guid || typeof x.indexerId !== "number") return undefined;
  return {
    guid: x.guid,
    indexerId: x.indexerId,
    title: x.title ?? "Untitled release",
    ...(x.indexer ? { indexer: x.indexer } : {}),
    ...(x.size !== undefined ? { sizeGB: gb(x.size)! } : {}),
    ...(x.quality?.quality?.name ? { quality: x.quality.quality.name } : {}),
    ...(x.protocol ? { protocol: x.protocol } : {}),
    ...(x.protocol === "torrent" ? { seeders: x.seeders ?? 0, leechers: x.leechers ?? 0 } : {}),
    ...(x.ageHours !== undefined
      ? { ageHours: Math.round(x.ageHours) }
      : x.age !== undefined
        ? { ageHours: x.age * 24 }
        : {}),
    ...(x.customFormatScore !== undefined ? { score: x.customFormatScore } : {}),
    approved: Boolean(x.approved),
    ...(x.fullSeason ? { fullSeason: true } : {}),
    rejections: (x.rejections ?? []).map(reasonOf).filter(Boolean),
    ...(x.quality?.quality?.resolution ? { resolution: `${x.quality.quality.resolution}p` } : {}),
    ...(SOURCE[x.quality?.quality?.source ?? ""]
      ? { source: SOURCE[x.quality!.quality!.source!] }
      : {}),
    ...releaseDetails(x.title ?? ""),
  };
}

/** Sonarr's and Radarr's source names, as people say them. */
const SOURCE: Record<string, string> = {
  web: "WEB-DL",
  webdl: "WEB-DL",
  webRip: "WEBRip",
  webrip: "WEBRip",
  bluray: "Blu-ray",
  blurayRaw: "Blu-ray disc",
  remux: "Remux",
  television: "HDTV",
  televisionRaw: "TV",
  tv: "HDTV",
  dvd: "DVD",
};

/** What the indexers offer for one item right now: the ones the app would take first. */
export async function findReleases(
  app: SearchApp,
  call: Call,
  scope: ReleaseScope,
): Promise<ReleaseSearchResult> {
  const r = await call<unknown>("GET", `/api/${v(app)}/release?${scopeQuery(app, scope)}`);
  if (!r.ok) throw new Error(`The search did not finish (${r.status}). Try again in a moment.`);
  // Newer Chaptarr answers { releases, hiddenReleases }: the hidden ones are on its page under
  // "Hidden results" (collections, packs), and the owner can still want one (10-28).
  const data = r.data as RawRelease[] | { releases?: RawRelease[]; hiddenReleases?: RawRelease[] };
  const shownRaw = Array.isArray(data) ? data : (data?.releases ?? []);
  const hiddenRaw = Array.isArray(data) ? [] : (data?.hiddenReleases ?? []);
  const all = [
    ...shownRaw.map(toOption),
    ...hiddenRaw.map((x) => {
      const o = toOption(x);
      return o ? { ...o, hidden: true } : undefined;
    }),
  ].filter((x): x is ReleaseOption => Boolean(x));
  all.sort(
    (a, b) =>
      Number(b.approved) - Number(a.approved) ||
      (b.score ?? 0) - (a.score ?? 0) ||
      (b.seeders ?? 0) - (a.seeders ?? 0),
  );
  return { releases: all.slice(0, MAX_RELEASES), found: all.length };
}

/**
 * Sends one release to the download client, then checks the app's queue for it. The app keeps a
 * search's results for a while (about 30 minutes): an older one has to be searched again.
 */
export async function grabRelease(
  app: SearchApp,
  call: Call,
  release: { guid: string; indexerId: number; release: string },
  wait: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; result: string; stale?: boolean }> {
  const r = await call<{ title?: string }>("POST", `/api/${v(app)}/release`, {
    guid: release.guid,
    indexerId: release.indexerId,
  });
  if (r.status === 404)
    return {
      ok: false,
      stale: true,
      result: "That search result has expired. Search again and pick it from the new list.",
    };
  if (!r.ok)
    return { ok: false, result: `The app did not send it to the download client (${r.status}).` };
  for (let i = 0; i < 8; i++) {
    const q = await call<{ records?: { title?: string }[] } | { title?: string }[]>(
      "GET",
      `/api/${v(app)}/queue?page=1&pageSize=200`,
    );
    const list = Array.isArray(q.data) ? q.data : (q.data?.records ?? []);
    if (list.some((x) => x.title === release.release))
      return {
        ok: true,
        result: `Sent ${release.release} to the download client. It is in the queue and downloading.`,
      };
    await wait(1500);
  }
  return {
    ok: true,
    result: `Sent ${release.release} to the download client. It has not shown in the queue yet; check the Queue tab in a minute.`,
  };
}

/* ---------- sample data (demo installs and browser tests) ---------- */

export function sampleTitles(app: SearchApp, q: string): SearchTitle[] {
  const all: SearchTitle[] =
    app === "radarr"
      ? [
          { id: 693, title: "Dune: Part Two", kind: "movie", year: 2024, hasFile: false },
          { id: 11, title: "Heat", kind: "movie", year: 1995, hasFile: true },
        ]
      : app === "sonarr"
        ? [
            { id: 7, title: "Ghosts (US)", kind: "series", year: 2021, seasons: [1, 2] },
            { id: 3, title: "Foundation", kind: "series", year: 2021, seasons: [1, 2, 3] },
          ]
        : app === "lidarr"
          ? [
              {
                id: 41,
                title: "Random Access Memories",
                kind: "album",
                year: 2013,
                by: "Daft Punk",
              },
            ]
          : [
              {
                id: 9295,
                title: "The Primal Hunter, Vol. 1",
                kind: "book",
                by: "Zogarth",
                format: "audiobook",
              },
            ];
  return all.filter((t) => matches(q, t.title, t.by));
}

export function sampleEpisodes(seriesId: number): SearchEpisode[] {
  return seriesId === 7
    ? [
        { id: 701, season: 2, episode: 1, title: "The Thanksgiving Special", hasFile: true },
        { id: 710, season: 2, episode: 10, title: "The Liquor License", hasFile: false },
      ]
    : [{ id: 303, season: 3, episode: 3, title: "The Missing Chapter", hasFile: true }];
}

export function sampleReleases(app: SearchApp): ReleaseSearchResult {
  const tv = app === "sonarr";
  const releases: ReleaseOption[] = [
    {
      guid: "sample-1",
      indexerId: 1,
      title: tv
        ? "Ghosts.US.2021.S02E10.1080p.WEB-DL.DDP5.1.H.264-FLUX"
        : "Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.H.264-FLUX",
      indexer: "UsenetOne (Prowlarr)",
      sizeGB: tv ? 1.2 : 7.8,
      quality: "WEBDL-1080p",
      protocol: "usenet",
      ageHours: 30,
      score: 1750,
      approved: true,
      rejections: [],
    },
    {
      guid: "sample-2",
      indexerId: 2,
      title: tv
        ? "Ghosts.US.S02E10.2160p.WEB.H265-GGEZ"
        : "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX-FGT",
      indexer: "TrackerTwo (Prowlarr)",
      sizeGB: tv ? 4.1 : 62.4,
      quality: tv ? "WEBDL-2160p" : "Remux-2160p",
      protocol: "torrent",
      seeders: 48,
      leechers: 3,
      ageHours: 50,
      approved: false,
      rejections: ["Not wanted in profile: the quality is above what the profile allows"],
    },
  ];
  return { releases, found: releases.length, sample: true };
}

/* ---------- the plan step: download one picked release ---------- */

export interface GrabParams {
  guid: string;
  indexerId: number;
  /** The release's name, as the list showed it. */
  release: string;
  /** What it is for: the movie, episode, season, album, or book. */
  title: string;
  quality?: string;
  sizeGB?: number;
  indexer?: string;
  /**
   * Why the owner's quality rules turned this release down, when they chose it anyway: the plan
   * says it is a one-time exception for this release, and no rule changes.
   */
  exception?: string;
}

/** The plan's parameters for downloading one release, or why they will not do. */
export function grabParams(p: Record<string, unknown> | undefined): GrabParams | string {
  const guid = typeof p?.guid === "string" ? p.guid : "";
  const indexerId = typeof p?.indexerId === "number" ? p.indexerId : Number(p?.indexerId);
  const release = typeof p?.release === "string" ? p.release.trim() : "";
  const title = typeof p?.title === "string" ? p.title.trim() : "";
  if (!guid || !Number.isInteger(indexerId) || !release || !title)
    return "Say which release to download (pick one from a search).";
  return {
    guid,
    indexerId,
    release: release.slice(0, 300),
    title: title.slice(0, 200),
    ...(typeof p?.quality === "string" ? { quality: p.quality.slice(0, 60) } : {}),
    ...(typeof p?.sizeGB === "number" ? { sizeGB: p.sizeGB } : {}),
    ...(typeof p?.indexer === "string" ? { indexer: p.indexer.slice(0, 80) } : {}),
    ...(typeof p?.exception === "string" && p.exception.trim()
      ? { exception: p.exception.trim().slice(0, 300) }
      : {}),
  };
}

/** What the plan says it will do. */
export function grabChange(serviceName: string, g: GrabParams) {
  const facts = [
    g.quality,
    g.sizeGB !== undefined ? `${g.sizeGB} GB` : "",
    g.indexer ? `from ${g.indexer}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const summary = `Download ${g.release} for ${g.title} in ${serviceName}${g.exception ? `, as a one-time exception to your quality rules (${g.exception}). Your rules stay as they are` : ""}`;
  return {
    summary,
    settings: [
      {
        name: g.title,
        before: "Not downloading this release",
        after: `${serviceName} sends ${g.release}${facts ? ` (${facts})` : ""} to the download client`,
      },
      // Chosen against the owner's own rules: said plainly, and the rules themselves stay.
      ...(g.exception
        ? [
            {
              name: "Your quality rules",
              before: `Turned this release down: ${g.exception}`,
              after: "Unchanged. A one-time exception for this release only",
            },
          ]
        : []),
    ],
  };
}
