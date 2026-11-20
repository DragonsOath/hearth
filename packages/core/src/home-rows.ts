/**
 * Home Rows (design doc "Home Rows: design for DC", 2026-11-06): the owner designs their media
 * server's home screen in Hearth. A row is one saved definition, read and written by the editor and
 * (later) Ember alike. Phase one publishes rows built from Plex's own filters to one Plex library
 * each, as a smart collection Hearth creates, promotes and places.
 */

export const HOME_ROW_SORTS = [
  "newest",
  "random",
  "rating",
  "most-watched",
  "year",
  "title",
] as const;
export type HomeRowSort = (typeof HOME_ROW_SORTS)[number];

export const HOME_ROW_SORT_NAMES: Record<HomeRowSort, string> = {
  newest: "Newest added",
  random: "Random",
  rating: "Highest rated",
  "most-watched": "Most watched",
  year: "Newest release",
  title: "Title A to Z",
};

export const HOME_ROW_RESOLUTIONS = ["4k", "1080", "720", "sd"] as const;
export type HomeRowResolution = (typeof HOME_ROW_RESOLUTIONS)[number];

/** Rules Plex's own filters can express (phase one). */
export interface HomeRowRules {
  /**
   * Hand-picked titles (Plex ratingKeys, in order) instead of filters: for themes Plex has no
   * filter for, like Thanksgiving films (11-06). The row is a collection of exactly these.
   */
  titles?: string[];
  /** Genre names as the library lists them; a title matches any of them. */
  genres?: string[];
  yearFrom?: number;
  yearTo?: number;
  /** Not yet watched by the account Hearth's Plex key belongs to (the owner's). */
  unwatched?: boolean;
  /** Audience rating, 0 to 10. */
  minRating?: number;
  resolution?: HomeRowResolution;
  addedWithinDays?: number;
}

/** Where the row shows: Plex's three places for a library's rows. */
export interface HomeRowPlacement {
  home: boolean;
  recommended: boolean;
  shared: boolean;
}

/** What Plex holds for a published row, tracked by Plex's stable id, never by title. */
export interface HomeRowPublished {
  /** The collection's ratingKey. */
  collectionKey: string;
  /** Its row in the library's row list (custom.collection.<library>.<key>). */
  hubId: string;
  at: string;
}

export interface HomeRow {
  id: string;
  /** The Plex service the row publishes to. */
  serviceId: string;
  libraryId: string;
  libraryName?: string;
  /** What the row is called on screen. */
  name: string;
  rules: HomeRowRules;
  sort: HomeRowSort;
  limit: number;
  placement: HomeRowPlacement;
  /** The row it goes after in its library's row list; empty puts it first. */
  after: string;
  published?: HomeRowPublished;
  /** When the last apply can be undone (its previous state is kept). */
  undoable?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the editor sends to save a row. */
export type HomeRowInput = Pick<
  HomeRow,
  "serviceId" | "libraryId" | "name" | "rules" | "sort" | "limit" | "placement" | "after"
> & { libraryName?: string };

const year = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1870 && n <= 2100 ? n : undefined;
};

/** Checks and cleans a row from the editor (or Ember); throws a plain-English reason. */
export function checkHomeRow(input: unknown): HomeRowInput {
  const o = (input ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const serviceId = text(o.serviceId, 80);
  const libraryId = text(o.libraryId, 20);
  const name = text(o.name, 80);
  if (!serviceId) throw new Error("Say which Plex the row is for.");
  if (!/^\d+$/.test(libraryId)) throw new Error("Pick the library the row comes from.");
  if (!name) throw new Error("Give the row a name.");
  const r = (o.rules ?? {}) as Record<string, unknown>;
  const rules: HomeRowRules = {};
  if (Array.isArray(r.titles) && r.titles.length) {
    const keys = [...new Set(r.titles.map((x) => String(x).trim()))];
    if (keys.some((k) => !/^\d{1,12}$/.test(k)))
      throw new Error("Titles are Plex ratingKeys (numbers).");
    if (keys.length > 100) throw new Error("A row holds 1 to 100 titles.");
    rules.titles = keys;
  }
  if (rules.titles) {
    // Hand-picked: exactly these titles, no filters.
  } else if (Array.isArray(r.genres)) {
    const g = [...new Set(r.genres.map((x) => text(x, 60)).filter(Boolean))].slice(0, 10);
    if (g.length) rules.genres = g;
  }
  const from = r.yearFrom === undefined || r.yearFrom === "" ? undefined : year(r.yearFrom);
  const to = r.yearTo === undefined || r.yearTo === "" ? undefined : year(r.yearTo);
  if (r.yearFrom !== undefined && r.yearFrom !== "" && from === undefined)
    throw new Error("The first year is four digits.");
  if (r.yearTo !== undefined && r.yearTo !== "" && to === undefined)
    throw new Error("The last year is four digits.");
  if (from !== undefined && to !== undefined && from > to)
    throw new Error("The first year comes before the last.");
  if (from !== undefined) rules.yearFrom = from;
  if (to !== undefined) rules.yearTo = to;
  if (r.unwatched === true) rules.unwatched = true;
  if (r.minRating !== undefined && r.minRating !== "" && r.minRating !== null) {
    const n = Number(r.minRating);
    if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error("A rating is 0 to 10.");
    if (n > 0) rules.minRating = Math.round(n * 10) / 10;
  }
  if (r.resolution) {
    if (!HOME_ROW_RESOLUTIONS.includes(r.resolution as HomeRowResolution))
      throw new Error("Resolution is 4K, 1080p, 720p or SD.");
    rules.resolution = r.resolution as HomeRowResolution;
  }
  if (r.addedWithinDays !== undefined && r.addedWithinDays !== "" && r.addedWithinDays !== null) {
    const n = Number(r.addedWithinDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error("Added within: 1 to 3650 days.");
    rules.addedWithinDays = n;
  }
  if (rules.titles)
    for (const k of Object.keys(rules)) if (k !== "titles") delete rules[k as keyof HomeRowRules];
  const sort = HOME_ROW_SORTS.includes(o.sort as HomeRowSort) ? (o.sort as HomeRowSort) : "newest";
  const limit = rules.titles ? rules.titles.length : Number(o.limit ?? 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("A row holds 1 to 100 titles.");
  const p = (o.placement ?? {}) as Record<string, unknown>;
  const placement: HomeRowPlacement = {
    home: p.home !== false,
    recommended: p.recommended === true,
    shared: p.shared === true,
  };
  // Nowhere at all: a collection only, not a row (11-07: "maybe you just want to build a
  // collection"). Only for hand-picked titles; a filter row exists to be shown.
  if (!placement.home && !placement.recommended && !placement.shared && !rules.titles)
    throw new Error("Choose at least one place for the row to show.");
  const after = text(o.after, 200);
  const libraryName = text(o.libraryName, 80);
  return {
    serviceId,
    libraryId,
    name,
    rules,
    sort,
    limit,
    placement,
    after,
    ...(libraryName ? { libraryName } : {}),
  };
}

const SORT_KEY: Record<HomeRowSort, string> = {
  newest: "addedAt:desc",
  random: "random",
  rating: "audienceRating:desc",
  "most-watched": "viewCount:desc",
  year: "year:desc",
  title: "titleSort",
};

/**
 * The rules as Plex's library filter (the part after "?" in /library/sections/<id>/all), with the
 * genres already turned into Plex's genre ids. The same text makes the poster preview and the
 * smart collection, so what the owner previews is what Plex keeps.
 */
export function plexRowQuery(
  row: Pick<HomeRow, "rules" | "sort" | "limit">,
  opts: { type: number; genreIds: string[] },
): string {
  const parts: string[] = [`type=${opts.type}`];
  const add = (k: string, v: string | number) =>
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  const r = row.rules;
  if (opts.genreIds.length) add("genre", opts.genreIds.join(","));
  // Plex's >>= and <<= are strictly after and before: the owner's years and rating are inclusive.
  if (r.yearFrom !== undefined) add("year>>", r.yearFrom - 1);
  if (r.yearTo !== undefined) add("year<<", r.yearTo + 1);
  if (r.unwatched) add("unwatched", 1);
  if (r.minRating !== undefined)
    add("audienceRating>>", Math.round((r.minRating - 0.05) * 100) / 100);
  if (r.resolution) add("resolution", r.resolution);
  if (r.addedWithinDays !== undefined) add("addedAt>>", `-${r.addedWithinDays}d`);
  add("sort", SORT_KEY[row.sort]);
  add("limit", row.limit);
  return parts.join("&");
}

/** The rules in plain words, for the row list and the apply preview. */
export function describeHomeRow(row: Pick<HomeRow, "rules" | "sort" | "limit">): string {
  const r = row.rules;
  if (r.titles?.length)
    return `${r.titles.length} hand-picked ${r.titles.length === 1 ? "title" : "titles"}`;
  const bits: string[] = [];
  if (r.genres?.length) bits.push(r.genres.join(" or "));
  if (r.yearFrom !== undefined && r.yearTo !== undefined)
    bits.push(r.yearFrom === r.yearTo ? String(r.yearFrom) : `${r.yearFrom} to ${r.yearTo}`);
  else if (r.yearFrom !== undefined) bits.push(`${r.yearFrom} or later`);
  else if (r.yearTo !== undefined) bits.push(`${r.yearTo} or earlier`);
  if (r.unwatched) bits.push("unwatched");
  if (r.minRating !== undefined) bits.push(`rated ${r.minRating}+`);
  if (r.resolution)
    bits.push(r.resolution === "sd" ? "SD" : r.resolution === "4k" ? "4K" : `${r.resolution}p`);
  if (r.addedWithinDays !== undefined) bits.push(`added in the last ${r.addedWithinDays} days`);
  return `${bits.length ? bits.join(", ") : "Everything in the library"}; ${HOME_ROW_SORT_NAMES[row.sort].toLowerCase()}, up to ${row.limit}`;
}
