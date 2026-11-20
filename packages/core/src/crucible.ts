/**
 * The Crucible (11-17): quality and size for movies and shows, in plain words, for anyone. People
 * pick a starting point (No limits, Balanced, Storage-smart) or answer a few questions, then
 * change any row. Each row is a group of titles ("Older movies") and a ladder: the qualities it
 * accepts from best down, each with the most it may cost in GB. Not finding the best never means
 * not getting the title: Radarr takes the next step down, and upgrades later if the best one
 * that fits turns up (a switch).
 *
 * Hearth turns the rows into Radarr's own settings, so Radarr enforces them even when Hearth is
 * off: one profile per row ("Hearth · Older movies"), and custom formats that turn down a quality
 * over its cap ("Hearth · 2160p over 25 GB"). Hearth only ever changes what it named itself.
 * No one's personal taste is built in: the presets are starting points, every number changes.
 */

/** "sd": DVD and SD copies (480p and 576p), for titles that never came out in HD. */
export type CrucibleQuality = "2160p" | "1080p" | "720p" | "sd";
export const CRUCIBLE_QUALITIES: readonly CrucibleQuality[] = ["2160p", "1080p", "720p", "sd"];
export const QUALITY_WORDS: Record<CrucibleQuality, string> = {
  "2160p": "4K",
  "1080p": "1080p",
  "720p": "720p",
  sd: "SD (DVD)",
};
/** The resolutions a step takes (SD: both DVD sizes). */
const RESOLUTIONS: Record<CrucibleQuality, number[]> = {
  "2160p": [2160],
  "1080p": [1080],
  "720p": [720],
  sd: [480, 576],
};
/** The quality a resolution belongs to. */
export function qualityOfResolution(res: number | undefined): CrucibleQuality | undefined {
  return (Object.keys(RESOLUTIONS) as CrucibleQuality[]).find((q) =>
    RESOLUTIONS[q].includes(res ?? -1),
  );
}
/** Releases from before a film is out (cinema recordings): never taken, SD or not. */
const PRE_RELEASE = /\b(cam|telesync|telecine|workprint|dvdscr|regional)\b/i;

/** One step of a row's ladder: a quality, and the most it may cost (a movie, or one episode). */
export interface CrucibleStep {
  quality: CrucibleQuality;
  /** In GB; null: no limit. */
  maxGB: number | null;
}

/** Which titles a row is for. Empty: every title the rows above didn't take. */
export interface CrucibleGroup {
  /** Released more than this many years ago. */
  olderThanYears?: number;
  /** Released in the last this many years. */
  newerThanYears?: number;
  /** Popular right now (TMDB popularity at least POPULAR). */
  popular?: boolean;
  /** Any of these genres. */
  genres?: string[];
  /** Any of these Radarr or Sonarr tags (by label). */
  tags?: string[];
  /**
   * Out (on digital) at most this many months ago, or not out yet. The date is the digital
   * release, else the disc release, else the cinema release plus 3 months (a show: first aired).
   */
  digitalWithinMonths?: number;
  /** Made in or after this year. */
  fromYear?: number;
  /** Made in or before this year. */
  toYear?: number;
  /** None of these genres. */
  notGenres?: string[];
  /** Rated at least / at most this (0 to 10, TMDB's rating, else IMDb's). */
  minRating?: number;
  maxRating?: number;
  /** At least / at most this many minutes long (a show: per episode). */
  minRuntime?: number;
  maxRuntime?: number;
  /** Originally in any of these languages ("English", "Japanese"). */
  languages?: string[];
  /** Any condition is enough (Expert); otherwise every condition must hold. */
  any?: boolean;
}

export interface CrucibleRow {
  id: string;
  /** What people call this group ("Older movies"). */
  name: string;
  group: CrucibleGroup;
  /** Best first. */
  ladder: CrucibleStep[];
  /** Replace a lower step's download when a better one that fits turns up. */
  upgrade: boolean;
  /** Wait this long for the top step before settling for a lower one (0: don't wait). */
  waitHours: number;
  /** Switched off: kept, but no title is placed by it (the last row is always on). */
  off?: boolean;
}

export type CruciblePreset = "no-limits" | "balanced" | "storage-smart";

export interface CrucibleSetup {
  preset: CruciblePreset | "custom";
  /** First matching row wins; the last row takes everything else. */
  movies: CrucibleRow[];
  /** Per episode; season packs are judged per episode. */
  shows: CrucibleRow[];
  /** New movies get their row's profile within a few minutes (default on; the keeper). */
  autoAssign?: boolean;
  /**
   * Seerr's own search on add is off for this Radarr, so Hearth starts the search itself right
   * after giving a new movie its row (the first search always uses the row's profile).
   */
  searchAfterSorting?: boolean;
  /**
   * Smaller wins (step 10; default on): of two releases the same quality, Radarr takes the
   * smaller (a small score per size band). Movies only: a size filter counts a season pack's total.
   */
  smallerWins?: boolean;
  /**
   * Titles follow the rules as they age (default on): once a day, a title whose rule changed
   * (a new release is no longer new) moves to its new rule's profile, but only when it has no
   * file yet, or its file already fits the new rule, so nothing is ever replaced by a move.
   */
  followAge?: boolean;
}

/** TMDB popularity Hearth calls "popular" (a starting point; most new wide releases pass it). */
export const POPULAR = 40;

const step = (quality: CrucibleQuality, maxGB: number | null): CrucibleStep => ({
  quality,
  maxGB,
});
const row = (
  id: string,
  name: string,
  group: CrucibleGroup,
  ladder: CrucibleStep[],
  more: Partial<CrucibleRow> = {},
): CrucibleRow => ({ id, name, group, ladder, upgrade: true, waitHours: 0, ...more });

export const CRUCIBLE_PRESETS: Record<
  CruciblePreset,
  { name: string; what: string; setup: () => CrucibleSetup }
> = {
  "no-limits": {
    name: "No limits",
    what: "The best quality there is, whatever the size.",
    setup: () => ({
      preset: "no-limits",
      movies: [
        row("all", "All movies", {}, [
          step("2160p", null),
          step("1080p", null),
          step("720p", null),
        ]),
      ],
      shows: [
        row("all", "All shows", {}, [step("2160p", null), step("1080p", null), step("720p", null)]),
      ],
    }),
  },
  balanced: {
    name: "Balanced",
    what: "Great quality with sensible sizes: 4K for big new releases, 1080p for the rest.",
    setup: () => ({
      preset: "balanced",
      movies: [
        row("blockbusters", "Big new releases", { newerThanYears: 2, popular: true }, [
          step("2160p", 40),
          step("1080p", 15),
        ]),
        row("all", "Everything else", {}, [step("1080p", 15), step("720p", 8)]),
      ],
      shows: [row("all", "All shows", {}, [step("1080p", 4), step("720p", 2)])],
    }),
  },
  "storage-smart": {
    name: "Storage-smart",
    what: "Good enough for what it is: smaller files where nobody would notice the difference.",
    setup: () => ({
      preset: "storage-smart",
      movies: [
        row("blockbusters", "Big new releases", { newerThanYears: 2, popular: true }, [
          step("2160p", 25),
          step("1080p", 10),
        ]),
        row("kids", "Kids' and animated movies", { genres: ["Animation", "Family"] }, [
          step("1080p", 4),
          step("720p", 3),
        ]),
        row("classics", "Classics (30+ years)", { olderThanYears: 30 }, [
          step("1080p", 4),
          step("720p", 4),
        ]),
        row("older", "Older movies (15+ years)", { olderThanYears: 15 }, [
          step("1080p", 6),
          step("720p", 4),
        ]),
        row("all", "Newer movies", {}, [step("1080p", 10), step("720p", 6)]),
      ],
      shows: [row("all", "All shows", {}, [step("1080p", 2.5), step("720p", 1.5)])],
    }),
  },
};

/** Guided setup: a few plain answers instead of rules. */
export interface CrucibleAnswers {
  /** "Do you care about storage space?" */
  careAboutSpace: boolean;
  /** "Which movies deserve the best picture?" */
  best: "new-releases" | "none" | "all";
  /** "Is 720p fine for older movies?" and how old counts as older. */
  olderIs720Fine: boolean;
  olderYears: number;
  /** "For shows, how much per episode?" (GB). */
  episodeGB: number;
}

export function setupFromAnswers(a: CrucibleAnswers): CrucibleSetup {
  if (!a.careAboutSpace) return CRUCIBLE_PRESETS["no-limits"].setup();
  const base = CRUCIBLE_PRESETS["storage-smart"].setup();
  const movies: CrucibleRow[] = [];
  if (a.best === "all")
    movies.push(row("all", "All movies", {}, [step("2160p", 25), step("1080p", 10)]));
  else {
    if (a.best === "new-releases") movies.push(base.movies[0]!);
    movies.push(base.movies[1]!);
    movies.push(
      row(
        "older",
        `Older movies (${a.olderYears}+ years)`,
        { olderThanYears: a.olderYears },
        a.olderIs720Fine ? [step("1080p", 5), step("720p", 4)] : [step("1080p", 6)],
      ),
    );
    movies.push(base.movies[4]!);
  }
  const ep = Math.max(0.3, a.episodeGB);
  return {
    preset: "custom",
    movies,
    shows: [
      row("all", "All shows", {}, [
        step("1080p", ep),
        step("720p", Math.round(ep * 0.6 * 10) / 10),
      ]),
    ],
  };
}

/** What Hearth reads of a title to place it in a row. */
export interface CrucibleTitle {
  year?: number;
  genres?: string[];
  /** TMDB popularity. */
  popularity?: number;
  /** Tag labels. */
  tags?: string[];
  /** The file it has now, in GB. */
  sizeGB?: number;
  /** Days since it came out (digital, else disc, else cinema + 90; negative: not out yet). */
  outDaysAgo?: number;
  /** 0 to 10. */
  rating?: number;
  /** Minutes (a show: per episode). */
  runtime?: number;
  /** Original language ("English"). */
  language?: string;
  /** Has a file (a show: every episode it wants). */
  hasFile?: boolean;
  /** The quality of the file it has (a movie). */
  fileQuality?: CrucibleQuality;
  /** Files it has (a show: episodes with a file; sizeGB is per episode). */
  files?: number;
}

const lower = (x: string) => x.toLowerCase();
const anyOf = (want: string[], have: string[] | undefined) =>
  want.some((x) => have?.some((y) => lower(y) === lower(x)));

/** The checks a group makes, each with its answer for this title (Explain uses them). */
export function groupChecks(
  t: CrucibleTitle,
  g: CrucibleGroup,
  thisYear: number,
): { key: keyof CrucibleGroup; ok: boolean }[] {
  const age = t.year ? thisYear - t.year : undefined;
  const out: { key: keyof CrucibleGroup; ok: boolean }[] = [];
  const add = (key: keyof CrucibleGroup, ok: boolean) => out.push({ key, ok });
  if (g.olderThanYears !== undefined)
    add("olderThanYears", age !== undefined && age >= g.olderThanYears);
  if (g.newerThanYears !== undefined)
    add("newerThanYears", age !== undefined && age <= g.newerThanYears);
  if (g.digitalWithinMonths !== undefined)
    add(
      "digitalWithinMonths",
      t.outDaysAgo !== undefined && t.outDaysAgo <= g.digitalWithinMonths * 30.44,
    );
  if (g.fromYear !== undefined) add("fromYear", t.year !== undefined && t.year >= g.fromYear);
  if (g.toYear !== undefined) add("toYear", t.year !== undefined && t.year <= g.toYear);
  if (g.popular) add("popular", (t.popularity ?? 0) >= POPULAR);
  if (g.genres?.length) add("genres", anyOf(g.genres, t.genres));
  if (g.notGenres?.length) add("notGenres", !anyOf(g.notGenres, t.genres));
  if (g.tags?.length) add("tags", anyOf(g.tags, t.tags));
  if (g.minRating !== undefined)
    add("minRating", t.rating !== undefined && t.rating >= g.minRating);
  if (g.maxRating !== undefined)
    add("maxRating", t.rating !== undefined && t.rating <= g.maxRating);
  if (g.minRuntime !== undefined)
    add("minRuntime", t.runtime !== undefined && t.runtime >= g.minRuntime);
  if (g.maxRuntime !== undefined)
    add("maxRuntime", t.runtime !== undefined && t.runtime > 0 && t.runtime <= g.maxRuntime);
  if (g.languages?.length) add("languages", anyOf(g.languages, t.language ? [t.language] : []));
  return out;
}

export function inGroup(t: CrucibleTitle, g: CrucibleGroup, thisYear: number): boolean {
  const checks = groupChecks(t, g, thisYear);
  if (!checks.length) return true;
  return g.any ? checks.some((c) => c.ok) : checks.every((c) => c.ok);
}

/** The row a title belongs to: the first that matches (the last row takes the rest). */
export function rowFor(
  t: CrucibleTitle,
  rows: CrucibleRow[],
  thisYear: number,
): CrucibleRow | undefined {
  const last = rows.at(-1);
  return rows.find((r) => (!r.off || r === last) && inGroup(t, r.group, thisYear)) ?? last;
}

/** "212 of your movies are in this group. 18 are bigger than this." */
export function rowCounts(titles: CrucibleTitle[], rows: CrucibleRow[], thisYear: number) {
  const out = new Map(rows.map((r) => [r.id, { titles: 0, bigger: 0 }]));
  for (const t of titles) {
    const r = rowFor(t, rows, thisYear);
    if (!r) continue;
    const c = out.get(r.id)!;
    c.titles += 1;
    const top = r.ladder[0]?.maxGB;
    if (top != null && t.sizeGB !== undefined && t.sizeGB > top) c.bigger += 1;
  }
  return out;
}

/** What a step usually costs, in words people can picture (a 2-hour movie, or one episode). */
export const TYPICAL_GB: Record<"movie" | "episode", Record<CrucibleQuality, [number, number]>> = {
  movie: { "2160p": [15, 60], "1080p": [4, 15], "720p": [2, 6], sd: [0.7, 2] },
  episode: { "2160p": [4, 12], "1080p": [1, 4], "720p": [0.5, 1.5], sd: [0.2, 0.6] },
};

/** "Most 2-hour movies at 1080p are 4 to 15 GB. At 10 GB you'll get most of them." */
export function explainStep(kind: "movie" | "episode", s: CrucibleStep): string {
  const [lo, hi] = TYPICAL_GB[kind][s.quality];
  const what = kind === "movie" ? "2-hour movies" : "hour-long episodes";
  const head = `Most ${what} in ${QUALITY_WORDS[s.quality]} are ${lo} to ${hi} GB.`;
  if (s.maxGB === null) return `${head} No limit: the best one found is taken.`;
  if (s.maxGB >= hi) return `${head} At ${s.maxGB} GB you'll get almost all of them.`;
  if (s.maxGB <= lo)
    return `${head} At ${s.maxGB} GB only the smallest fit, so many will step down a quality.`;
  const share = (s.maxGB - lo) / (hi - lo);
  return `${head} At ${s.maxGB} GB you'll get ${share > 0.6 ? "most" : share > 0.3 ? "about half" : "some"} of them; the rest step down a quality.`;
}

/* ---------- Radarr's own settings for the rows ---------- */

export const HEARTH_PREFIX = "Hearth · ";
export const capFormatName = (q: CrucibleQuality, gb: number) =>
  `${HEARTH_PREFIX}${q} over ${gb} GB`;
export const rowProfileName = (r: CrucibleRow) => `${HEARTH_PREFIX}${r.name}`;
/** Turns a release down outright (more than any score a release can earn). */
export const BLOCK_SCORE = -10000;

/** A quality as Radarr lists it in a profile. */
export interface ArrQuality {
  id: number;
  name: string;
  resolution?: number;
  source?: string;
}
/** One item of a Radarr profile: a quality, or a named group of them. */
export interface ArrProfileItem {
  id?: number;
  name?: string;
  quality?: ArrQuality;
  items?: ArrProfileItem[];
  allowed: boolean;
}

/** Qualities never worth taking, whatever the row says (whole discs, raw captures). */
const NEVER = /br-disk|raw-hd|dvd-r\b/i;

const resolutionOf = (i: ArrProfileItem): number | undefined =>
  i.quality?.resolution ?? i.items?.find((x) => x.quality?.resolution)?.quality?.resolution;

/**
 * A row's profile items, from a template profile's items (Radarr's own list and order, lowest
 * first): allowed when the quality's resolution is on the ladder.
 */
export function profileItems(template: ArrProfileItem[], r: CrucibleRow): ArrProfileItem[] {
  const want = new Set(r.ladder.flatMap((s) => RESOLUTIONS[s.quality]));
  const allow = (i: ArrProfileItem): ArrProfileItem => {
    if (i.items?.length) {
      const items = i.items.map(allow);
      return { ...i, items, allowed: items.some((x) => x.allowed) };
    }
    const res = i.quality?.resolution;
    return {
      ...i,
      allowed:
        res !== undefined &&
        want.has(res) &&
        !NEVER.test(i.quality?.name ?? "") &&
        !PRE_RELEASE.test(i.quality?.name ?? ""),
    };
  };
  return template.map(allow);
}

/** Where Radarr stops upgrading: the best allowed item at the ladder's top quality. */
export function cutoffOf(items: ArrProfileItem[], r: CrucibleRow): number | undefined {
  const top = RESOLUTIONS[r.ladder[0]!.quality];
  const best = [...items].reverse().find((i) => i.allowed && top.includes(resolutionOf(i) ?? -1));
  return best ? (best.items?.length ? best.id : best.quality?.id) : undefined;
}

/** The custom formats every row's caps need, one per quality and cap, shared between rows. */
export function capFormats(
  rows: CrucibleRow[],
): { quality: CrucibleQuality; gb: number; name: string }[] {
  const seen = new Map<string, { quality: CrucibleQuality; gb: number; name: string }>();
  for (const r of rows)
    for (const s of r.ladder)
      if (s.maxGB !== null) {
        const name = capFormatName(s.quality, s.maxGB);
        seen.set(name, { quality: s.quality, gb: s.maxGB, name });
      }
  return [...seen.values()];
}

/** A step's resolution conditions (SD: either DVD size, so neither is required on its own). */
const resolutionSpecs = (quality: CrucibleQuality) =>
  RESOLUTIONS[quality].map((value, _i, all) => ({
    name: all.length > 1 ? `Resolution ${value}` : "Resolution",
    implementation: "ResolutionSpecification",
    negate: false,
    required: all.length === 1,
    fields: [{ name: "value", value }],
  }));

/** A cap format's conditions, as Radarr's custom format API takes them. */
export function capSpecifications(quality: CrucibleQuality, gb: number) {
  return [
    ...resolutionSpecs(quality),
    {
      name: "Bigger than the cap",
      implementation: "SizeSpecification",
      negate: false,
      required: true,
      fields: [
        { name: "min", value: gb },
        { name: "max", value: Math.max(1000, gb * 20) },
      ],
    },
  ];
}

/** Which cap formats a row turns releases down with (by name). */
export const rowBlocks = (r: CrucibleRow) =>
  r.ladder.filter((s) => s.maxGB !== null).map((s) => capFormatName(s.quality, s.maxGB!));

/** A row's ladder in a line ("4K up to 25 GB, else 1080p up to 10 GB"). */
export function ladderWords(r: CrucibleRow, unit: "movie" | "episode" = "movie"): string {
  const per = unit === "episode" ? " an episode" : "";
  return r.ladder
    .map(
      (s, i) =>
        `${i ? "else " : ""}${QUALITY_WORDS[s.quality]} ${s.maxGB === null ? "at any size" : `up to ${s.maxGB} GB${per}`}`,
    )
    .join(", ");
}

/** What the Crucible reads of one Radarr (GET /api/services/:id/crucible). */
export interface CrucibleLibrary {
  titles: (CrucibleTitle & { id: number; title: string; profile: string })[];
  /** The profiles Hearth made: what each blocks, to spot a change made in Radarr itself. */
  hearthProfiles: { name: string; upgradeAllowed: boolean; blocks: string[] }[];
  /** Every profile's name. */
  profiles: string[];
  sample?: boolean;
}

/** Rows whose Radarr profile no longer matches what was saved (someone changed it in Radarr). */
export function driftedRows(
  rows: CrucibleRow[],
  lib: Pick<CrucibleLibrary, "hearthProfiles">,
  /** Show rows: their sizes are Sonarr's own limits, not filters in the profile. */
  caps = true,
): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const p = lib.hearthProfiles.find((x) => x.name === rowProfileName(r));
    if (!p) continue;
    const want = new Set(caps ? rowBlocks(r) : []);
    const same =
      p.upgradeAllowed === r.upgrade &&
      p.blocks.length === want.size &&
      p.blocks.every((b) => want.has(b));
    if (!same) out.push(r.name);
  }
  return out;
}

/**
 * The checkpoint (11-17, the owner): with Seerr's own search off, Seerr adds a requested movie
 * on this profile. Its one format turns every release down, so nothing (a search or Radarr's RSS
 * sync) can grab it until the Crucible moves it to its row's profile and starts the search. If
 * Hearth is down, requests wait here, visibly, and are caught up when it's back.
 */
export const HOLD_PROFILE = `${HEARTH_PREFIX}Waiting for the Crucible`;
export const HOLD_FORMAT = `${HEARTH_PREFIX}Hold every release (waiting for the Crucible)`;
/** The hold format's one condition: a release title matching anything. */
export const holdSpecifications = () => [
  {
    name: "Any release",
    implementation: "ReleaseTitleSpecification",
    negate: false,
    required: true,
    fields: [{ name: "value", value: ".*" }],
  },
];

/** The row's profile name for a title being requested, when it is in the app's profile list. */
export function requestProfile(
  t: CrucibleTitle,
  setups: CrucibleSetup[],
  profiles: { id: number; name?: string }[],
  thisYear: number,
  kind: "movie" | "tv" = "movie",
): { id: number; name: string; row: CrucibleRow } | undefined {
  for (const s of setups) {
    const r = rowFor(t, kind === "tv" ? (s.shows ?? []) : s.movies, thisYear);
    if (!r) continue;
    const p = profiles.find((x) => x.name === rowProfileName(r));
    if (p) return { id: p.id, name: rowProfileName(r), row: r };
  }
  return undefined;
}

/**
 * Near misses on their own (plan step 8): a small daily check of movies missing a while, oldest
 * first, so indexers aren't hammered. Each result says whether nothing exists, something fits
 * (Radarr should take it), or the owner's own rules turned every release down.
 */
export interface NearMissSettings {
  /** Titles searched a day, across every Radarr (default 10; 0 turns the check off). */
  perDay: number;
  /** Only titles missing at least this many days (default 7). */
  minDays: number;
  /** Also say so in Needs you and the bell (default off). */
  notify: boolean;
}
export const DEFAULT_NEAR_MISS_SETTINGS: NearMissSettings = {
  perDay: 10,
  minDays: 7,
  notify: false,
};

export interface NearMissItem {
  serviceId: string;
  service: string;
  movieId: number;
  title: string;
  checkedAt: string;
  kind: "none" | "available" | "blocked";
  sentence: string;
  /** Turned down only for size: the closest one, for "Grab it anyway". */
  closest?: {
    guid: string;
    indexerId: number;
    title: string;
    quality?: string;
    sizeGB?: number;
    indexer?: string;
  };
}

export interface NearMissReport {
  settings: NearMissSettings;
  checkedAt?: string;
  items: NearMissItem[];
}

/**
 * Smaller wins when quality is equal (plan step 10): size bands per quality, each a format that
 * adds SMALLER_SCORE, so a release under more bands (smaller) scores a little higher. Radarr ranks
 * by quality first, so this only decides between releases of the same quality.
 */
export const SMALLER_BANDS: Record<CrucibleQuality, number[]> = {
  "2160p": [15, 25, 40],
  "1080p": [4, 8, 12],
  "720p": [2, 4],
  sd: [1, 2],
};
export const SMALLER_SCORE = 1;
/** At least this much score improvement before an upgrade, so size bands alone never upgrade. */
export const SMALLER_NO_UPGRADE = 4;
export const smallerFormatName = (q: CrucibleQuality, gb: number) =>
  `${HEARTH_PREFIX}Smaller ${q === "2160p" ? "4K" : q === "sd" ? "SD" : q} (under ${gb} GB)`;
export function smallerFormats(): { quality: CrucibleQuality; gb: number; name: string }[] {
  return (Object.keys(SMALLER_BANDS) as CrucibleQuality[]).flatMap((q) =>
    SMALLER_BANDS[q].map((gb) => ({ quality: q, gb, name: smallerFormatName(q, gb) })),
  );
}
export function smallerSpecifications(quality: CrucibleQuality, gb: number) {
  return [
    ...resolutionSpecs(quality),
    {
      name: "Smaller than",
      implementation: "SizeSpecification",
      negate: false,
      required: true,
      fields: [
        { name: "min", value: 0 },
        { name: "max", value: gb },
      ],
    },
  ];
}

/**
 * "Wait for the best first" (a row's waitHours): Radarr's and Sonarr's delay profiles apply by
 * tag, so each waiting row gets its own tag (on the titles in that row) and a delay profile on it
 * that is skipped as soon as the row's best quality turns up.
 */
export const WAIT_TAG_PREFIX = "hearth-wait-";
export const waitTag = (r: Pick<CrucibleRow, "id">) =>
  `${WAIT_TAG_PREFIX}${
    r.id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "row"
  }`;
export function waitWords(hours: number): string {
  if (hours <= 0) return "No wait";
  if (hours % 168 === 0) return hours === 168 ? "1 week" : `${hours / 168} weeks`;
  if (hours % 24 === 0) return hours === 24 ? "1 day" : `${hours / 24} days`;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/* ---------- Your rules in plain words (11-18, the owner) ---------- */

/**
 * What Hearth reads of a Radarr movie or a Sonarr series to place it (the same everywhere: the
 * keeper, Save, the preview). Dates: digital, else disc, else cinema + 90 days; a show: first aired.
 */
export function arrTitle(
  m: Record<string, unknown>,
  tagLabel: Map<number, string>,
  now: Date = new Date(),
): CrucibleTitle {
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const day = (x: unknown) => {
    const t = typeof x === "string" ? Date.parse(x) : NaN;
    return Number.isNaN(t) ? undefined : t;
  };
  const cinema = day(m.inCinemas);
  const out =
    day(m.digitalRelease) ??
    day(m.physicalRelease) ??
    (cinema !== undefined ? cinema + 90 * 86_400_000 : undefined) ??
    day(m.firstAired);
  const ratings = (m.ratings ?? {}) as {
    tmdb?: { value?: number };
    imdb?: { value?: number };
    value?: number;
  };
  const rating = num(ratings.tmdb?.value) || num(ratings.imdb?.value) || num(ratings.value);
  const lang = m.originalLanguage as { name?: string } | string | undefined;
  const language = typeof lang === "string" ? lang : lang?.name;
  const file = m.movieFile as
    { quality?: { quality?: { resolution?: number } }; size?: number } | undefined;
  const st = (m.statistics ?? {}) as {
    sizeOnDisk?: number;
    episodeFileCount?: number;
    episodeCount?: number;
  };
  const isShow = "seasons" in m;
  const files = isShow ? Number(st.episodeFileCount ?? 0) : m.hasFile ? 1 : 0;
  const size = isShow
    ? files > 0 && Number(st.sizeOnDisk) > 0
      ? Number(st.sizeOnDisk) / files
      : undefined
    : Number(m.sizeOnDisk) > 0
      ? Number(m.sizeOnDisk)
      : undefined;
  const fileQuality = qualityOfResolution(file?.quality?.quality?.resolution);
  return {
    ...(num(m.year) ? { year: num(m.year)! } : {}),
    genres: (m.genres as string[]) ?? [],
    ...(num(m.popularity) !== undefined ? { popularity: num(m.popularity)! } : {}),
    tags: ((m.tags as number[]) ?? []).map((t) => tagLabel.get(t) ?? "").filter(Boolean),
    ...(size !== undefined ? { sizeGB: Math.round((size / 1024 ** 3) * 10) / 10 } : {}),
    ...(out !== undefined ? { outDaysAgo: Math.floor((now.getTime() - out) / 86_400_000) } : {}),
    ...(rating ? { rating: Math.round(rating * 10) / 10 } : {}),
    ...(num(m.runtime) ? { runtime: num(m.runtime)! } : {}),
    ...(language ? { language } : {}),
    hasFile: isShow ? files > 0 && files >= Number(st.episodeCount ?? files) : Boolean(m.hasFile),
    ...(fileQuality ? { fileQuality } : {}),
    files,
  };
}

const list = (xs: string[], joiner: "or" | "and") =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${joiner} ${xs.at(-1)}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Each condition of a group as a phrase people read ("out on digital less than 6 months ago").
 * The key says which part a tap changes, so every definition is in plain sight.
 */
export function groupPhrases(
  g: CrucibleGroup,
  kind: "movie" | "show" = "movie",
): { key: keyof CrucibleGroup; text: string }[] {
  const out: { key: keyof CrucibleGroup; text: string }[] = [];
  const add = (key: keyof CrucibleGroup, text: string) => out.push({ key, text });
  if (g.digitalWithinMonths !== undefined)
    add(
      "digitalWithinMonths",
      kind === "show"
        ? `that started less than ${plural(g.digitalWithinMonths, "month")} ago`
        : `out on digital less than ${plural(g.digitalWithinMonths, "month")} ago`,
    );
  if (g.newerThanYears !== undefined)
    add("newerThanYears", `released in the last ${plural(g.newerThanYears, "year")}`);
  if (g.olderThanYears !== undefined)
    add("olderThanYears", `released more than ${plural(g.olderThanYears, "year")} ago`);
  if (g.fromYear !== undefined && g.toYear !== undefined)
    add("fromYear", `made from ${g.fromYear} to ${g.toYear}`);
  else if (g.fromYear !== undefined) add("fromYear", `made in ${g.fromYear} or later`);
  else if (g.toYear !== undefined) add("toYear", `made in ${g.toYear} or earlier`);
  if (g.popular) add("popular", "popular right now");
  if (g.genres?.length) add("genres", `in ${list(g.genres, "or")}`);
  if (g.notGenres?.length) add("notGenres", `not ${list(g.notGenres, "or")}`);
  if (g.tags?.length) add("tags", `tagged ${list(g.tags, "or")}`);
  if (g.minRating !== undefined && g.maxRating !== undefined)
    add("minRating", `rated ${g.minRating} to ${g.maxRating}`);
  else if (g.minRating !== undefined) add("minRating", `rated ${g.minRating} or higher`);
  else if (g.maxRating !== undefined) add("maxRating", `rated ${g.maxRating} or lower`);
  const per = kind === "show" ? " an episode" : "";
  if (g.minRuntime !== undefined && g.maxRuntime !== undefined)
    add("minRuntime", `${g.minRuntime} to ${g.maxRuntime} minutes long${per}`);
  else if (g.minRuntime !== undefined)
    add("minRuntime", `at least ${g.minRuntime} minutes long${per}`);
  else if (g.maxRuntime !== undefined)
    add("maxRuntime", `at most ${g.maxRuntime} minutes long${per}`);
  if (g.languages?.length) add("languages", `in ${list(g.languages, "or")} originally`);
  return out;
}

/** A row as one sentence ("Movies out on digital less than 6 months ago get 4K up to 15 GB."). */
export function rowSentence(r: CrucibleRow, kind: "movie" | "show", last: boolean): string {
  const ph = groupPhrases(r.group, kind).map((p) => p.text);
  const who = kind === "show" ? "Shows" : "Movies";
  const head = last
    ? `Every other ${kind}`
    : ph.length
      ? `${who} ${list(ph, r.group.any ? "or" : "and")}`
      : `All ${kind === "show" ? "shows" : "movies"}`;
  const verb = last || !ph.length ? (last ? "gets" : "get") : "get";
  const body = ladderWords(r, kind === "show" ? "episode" : "movie");
  const more = [
    r.upgrade ? "" : "no upgrades later",
    r.waitHours > 0 ? `wait ${waitWords(r.waitHours)} for the best first` : "",
  ].filter(Boolean);
  return `${head} ${verb} ${body}${more.length ? ` (${more.join(", ")})` : ""}.`;
}

/** The phrase a check belongs to (a range's two ends share one phrase). */
const PHRASE_OF: Partial<Record<keyof CrucibleGroup, keyof CrucibleGroup>> = {
  toYear: "fromYear",
  maxRating: "minRating",
  maxRuntime: "minRuntime",
};
const phraseFor = (
  phrases: { key: keyof CrucibleGroup; text: string }[],
  key: keyof CrucibleGroup,
) => (phrases.find((p) => p.key === key) ?? phrases.find((p) => p.key === PHRASE_OF[key]))?.text;

/** Why a title gets what it gets: each rule from the top, until the one that took it. */
export function explainTitle(
  t: CrucibleTitle,
  rows: CrucibleRow[],
  thisYear: number,
  kind: "movie" | "show" = "movie",
): { row?: CrucibleRow; lines: string[] } {
  const unit = kind === "show" ? "episode" : "movie";
  const lines: string[] = [];
  const last = rows.at(-1);
  for (const r of rows) {
    const name = `"${r.name}"`;
    if (r.off && r !== last) {
      lines.push(`${name} is switched off.`);
      continue;
    }
    const phrases = groupPhrases(r.group, kind);
    const checks = groupChecks(t, r.group, thisYear);
    const ok =
      !checks.length || (r.group.any ? checks.some((c) => c.ok) : checks.every((c) => c.ok));
    const words = (cs: typeof checks) => [
      ...new Set(cs.map((c) => phraseFor(phrases, c.key)).filter((x): x is string => !!x)),
    ];
    if (ok) {
      const why = words(checks.filter((c) => c.ok));
      lines.push(
        `${name} fits${why.length ? ` (${list(why, "and")})` : ""}: ${ladderWords(r, unit)}.`,
      );
      return { row: r, lines };
    }
    if (r === last) {
      lines.push(`${name} takes everything the rules above didn't: ${ladderWords(r, unit)}.`);
      return { row: r, lines };
    }
    lines.push(
      `${name} doesn't fit: not ${list(words(checks.filter((c) => !c.ok)), r.group.any ? "and" : "or")}.`,
    );
  }
  return { lines };
}

/**
 * Where two switched-on rules both fit the same titles: the higher one wins. Shown so people
 * can see a conflict and choose (move one up, or narrow one).
 */
export function rowOverlaps(
  titles: CrucibleTitle[],
  rows: CrucibleRow[],
  thisYear: number,
): { higher: string; lower: string; titles: number }[] {
  const out: { higher: string; lower: string; titles: number }[] = [];
  const live = rows.slice(0, -1).filter((r) => !r.off && Object.keys(r.group).length);
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const n = titles.filter(
        (t) => inGroup(t, live[i]!.group, thisYear) && inGroup(t, live[j]!.group, thisYear),
      ).length;
      if (n) out.push({ higher: live[i]!.name, lower: live[j]!.name, titles: n });
    }
  return out;
}

/** What a step would usually take (an estimate for a title not downloaded yet). */
const likelyGB = (kind: "movie" | "episode", s: CrucibleStep) => {
  const [lo, hi] = TYPICAL_GB[kind][s.quality];
  const mid = (lo + hi) / 2;
  return s.maxGB === null ? mid : Math.min(mid, s.maxGB * 0.85);
};

/**
 * The space the library takes now, and what it would take if every title followed the rules
 * (a title bigger than its allowance counts at the allowance; nothing is ever deleted to get
 * there, it's the size the rules aim for). Missing titles are estimated.
 */
export function spaceEstimate(
  titles: CrucibleTitle[],
  rows: CrucibleRow[],
  thisYear: number,
  kind: "movie" | "show" = "movie",
): {
  nowGB: number;
  rulesGB: number;
  missing: number;
  missingGB: number;
  overAllowance: number;
} {
  const unit = kind === "show" ? "episode" : "movie";
  let nowGB = 0;
  let rulesGB = 0;
  let missing = 0;
  let missingGB = 0;
  let overAllowance = 0;
  for (const t of titles) {
    const r = rowFor(t, rows, thisYear);
    if (!r) continue;
    const n = kind === "show" ? Math.max(1, t.files ?? 1) : 1;
    if (t.sizeGB !== undefined && t.sizeGB > 0) {
      nowGB += t.sizeGB * n;
      const step = r.ladder.find((s) => s.quality === t.fileQuality) ?? r.ladder[0]!;
      const cap = r.ladder.some((s) => s.maxGB === null)
        ? null
        : Math.max(...r.ladder.map((s) => s.maxGB!));
      const allow = step.maxGB ?? cap;
      if (allow !== null && t.sizeGB > allow) {
        overAllowance += 1;
        rulesGB += allow * n;
      } else rulesGB += t.sizeGB * n;
    } else if (kind === "movie") {
      missing += 1;
      const gb = likelyGB(unit, r.ladder[0]!);
      missingGB += gb;
      rulesGB += gb;
    }
  }
  const r1 = (x: number) => Math.round(x);
  return {
    nowGB: r1(nowGB),
    rulesGB: r1(rulesGB),
    missing,
    missingGB: r1(missingGB),
    overAllowance,
  };
}

/**
 * Ready-made rules people switch on (Everyday): each one a row, its definitions shown in the
 * sentence and changed with a tap. Neutral starting values, never anyone's own taste.
 */
export const CRUCIBLE_STATEMENTS: {
  id: string;
  kind: "movie" | "show";
  name: string;
  make: () => CrucibleRow;
}[] = [
  {
    id: "new-digital",
    kind: "movie",
    name: "New releases get the best",
    make: () =>
      row("new-digital", "New releases", { digitalWithinMonths: 6 }, [
        step("2160p", 25),
        step("1080p", 10),
      ]),
  },
  {
    id: "older-smaller",
    kind: "movie",
    name: "Older movies can be smaller",
    make: () =>
      row("older-smaller", "Older movies", { olderThanYears: 20 }, [
        step("1080p", 4),
        step("720p", 2),
      ]),
  },
  {
    id: "classics-best",
    kind: "movie",
    name: "Classics get the best copy",
    make: () =>
      row("classics-best", "Classics", { toYear: 1969, minRating: 7.5 }, [
        step("1080p", 15),
        step("720p", 6),
        step("sd", 3),
      ]),
  },
  {
    id: "era",
    kind: "movie",
    name: "A decade I love",
    make: () =>
      row("era", "The 80s", { fromYear: 1980, toYear: 1989 }, [step("1080p", 12), step("720p", 5)]),
  },
  {
    id: "kids-small",
    kind: "movie",
    name: "Kids' movies don't need 4K",
    make: () =>
      row("kids-small", "Kids' movies", { genres: ["Animation", "Family"] }, [
        step("1080p", 4),
        step("720p", 2),
      ]),
  },
  {
    id: "genre-best",
    kind: "movie",
    name: "A genre that should look its best",
    make: () =>
      row("genre-best", "Sci-fi", { genres: ["Science Fiction"] }, [
        step("2160p", 30),
        step("1080p", 12),
      ]),
  },
  {
    id: "genre-small",
    kind: "movie",
    name: "A genre that can be smaller",
    make: () =>
      row("genre-small", "Comedies", { genres: ["Comedy"], notGenres: ["Animation"] }, [
        step("1080p", 4),
        step("720p", 2),
      ]),
  },
  {
    id: "long-room",
    kind: "movie",
    name: "Long movies get more room",
    make: () =>
      row("long-room", "Long movies", { minRuntime: 150 }, [step("1080p", 14), step("720p", 6)]),
  },
  {
    id: "old-shows-sd",
    kind: "show",
    name: "Old shows can be DVD quality",
    make: () =>
      row("old-shows-sd", "Older shows", { toYear: 1999 }, [
        step("1080p", 2),
        step("720p", 1),
        step("sd", 0.6),
      ]),
  },
  {
    id: "new-shows",
    kind: "show",
    name: "New shows get the best",
    make: () =>
      row("new-shows", "New shows", { newerThanYears: 2 }, [step("1080p", 4), step("720p", 2)]),
  },
];

/**
 * May an aging title move to this row without anything being replaced? Yes when it has no file
 * yet, or (a movie) its file's quality is on the new ladder and within that step's size.
 */
export function safeToMove(t: CrucibleTitle, to: CrucibleRow): boolean {
  if (!t.files) return true;
  if (!t.fileQuality) return false;
  const step = to.ladder.find((s) => s.quality === t.fileQuality);
  if (!step) return false;
  return step.maxGB === null || (t.sizeGB !== undefined && t.sizeGB <= step.maxGB);
}
