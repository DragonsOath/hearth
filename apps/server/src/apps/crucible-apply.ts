import {
  BLOCK_SCORE,
  HEARTH_PREFIX,
  HOLD_FORMAT,
  HOLD_PROFILE,
  holdSpecifications,
  WAIT_TAG_PREFIX,
  waitTag,
  waitWords,
  SMALLER_NO_UPGRADE,
  SMALLER_SCORE,
  smallerFormats,
  DEFAULT_SEASON_PACKS,
  SEASON_PACK_FORMAT,
  SEASON_PACK_SCORE,
  seasonPackCapName,
  seasonPackCapSpecifications,
  seasonPackSentence,
  seasonPackSpecifications,
  seasonPacksOf,
  smallerSpecifications,
  capFormats,
  capSpecifications,
  cutoffOf,
  ladderWords,
  profileItems,
  rowBlocks,
  rowFor,
  rowProfileName,
  type ArrProfileItem,
  type CrucibleRow,
  type CrucibleSetup,
  type SettingChange,
  type StepChange,
  type StepParams,
  CRUCIBLE_QUALITIES,
  QUALITY_WORDS,
  qualityOfResolution,
  arrTitle,
} from "@dragon-control/core";
import { releaseHeld } from "./crucible-keeper";

/**
 * The Crucible's Save (11-17): one approved step that turns the movie rows into Radarr's own
 * settings, the same contract as every Radarr change. The plan reads Radarr and states exactly
 * what will be created or changed (and, when asked, which movies move to their row's profile);
 * the run re-reads Hearth's own objects and stops if they changed since; then it writes, reads
 * back, and Undo puts everything back as it was.
 *
 * Hearth only ever creates or changes what it named "Hearth · ". Profiles and formats made by
 * people, Recyclarr or Profilarr are never changed; Radarr's app-wide size limits are never
 * touched. A format no row needs any more is left in place (harmless; removable in Radarr).
 */

type Json = Record<string, unknown>;
export type Arr = <T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  purpose: string,
  body?: unknown,
) => Promise<{ ok: boolean; status: number; data: T }>;

export class CruciblePlanError extends Error {}

/**
 * Radarr (movies) or Sonarr (shows, plan step 9): the same Save, keeper and exit, with each app's
 * own paths and words. Sonarr's size caps are its own per-minute size limits (they judge a season
 * pack per episode), so show rows get no size filter inside their profile.
 */
export interface ArrShape {
  app: "radarr" | "sonarr";
  App: "Radarr" | "Sonarr";
  items: string;
  editor: string;
  ids: "movieIds" | "seriesIds";
  one: string;
  many: string;
  Many: string;
  hookFlag: "onMovieAdded" | "onSeriesAdd";
  rows: (s: CrucibleSetup) => CrucibleRow[];
  /** The search commands for these titles (Sonarr searches one series per command). */
  search: (ids: number[]) => Json[];
  /** Monitored and still missing something (worth a search). */
  wanting: (item: Json) => boolean;
}
export const SHAPES: Record<"radarr" | "sonarr", ArrShape> = {
  radarr: {
    app: "radarr",
    App: "Radarr",
    items: "/api/v3/movie",
    editor: "/api/v3/movie/editor",
    ids: "movieIds",
    one: "movie",
    many: "movies",
    Many: "Movies",
    hookFlag: "onMovieAdded",
    rows: (s) => s.movies,
    search: (ids) => [{ name: "MoviesSearch", movieIds: ids }],
    wanting: (m) => m.monitored !== false && !m.hasFile,
  },
  sonarr: {
    app: "sonarr",
    App: "Sonarr",
    items: "/api/v3/series",
    editor: "/api/v3/series/editor",
    ids: "seriesIds",
    one: "show",
    many: "shows",
    Many: "Shows",
    hookFlag: "onSeriesAdd",
    rows: (s) => s.shows,
    search: (ids) => ids.map((seriesId) => ({ name: "SeriesSearch", seriesId })),
    wanting: (m) =>
      m.monitored !== false &&
      Number((m.statistics as Json | undefined)?.percentOfEpisodes ?? 0) < 100,
  },
};
export const shapeOf = (app: unknown): ArrShape =>
  app === "sonarr" ? SHAPES.sonarr : SHAPES.radarr;

/** An hour-long episode: what a show row's GB means in Sonarr's per-minute size limits. */
const EPISODE_MINUTES = 60;
/** The main TV row (the last, the one every show falls back to): its caps become Sonarr's sizes. */
export function sizeChanges(definitions: Json[], rows: CrucibleRow[]) {
  const main = rows.at(-1);
  const out: {
    id: number;
    title: string;
    quality: string;
    gb: number;
    from: number | null;
    to: number;
    preferred: number | null;
  }[] = [];
  for (const step of main?.ladder ?? []) {
    if (step.maxGB == null) continue;
    const to = Math.round(((step.maxGB * 1024) / EPISODE_MINUTES) * 10) / 10;
    for (const d of definitions) {
      const q = d.quality as Json | undefined;
      if (qualityOfResolution(Number(q?.resolution)) !== step.quality) continue;
      const from = d.maxSize == null ? null : Number(d.maxSize);
      if (from === to) continue;
      out.push({
        id: Number(d.id),
        title: String(d.title ?? q?.name ?? d.id),
        quality: step.quality,
        gb: step.maxGB,
        from,
        to,
        preferred: d.preferredSize == null ? null : Number(d.preferredSize),
      });
    }
  }
  return out;
}

const isHearth = (name: unknown) => typeof name === "string" && name.startsWith(HEARTH_PREFIX);

interface Snapshot {
  profiles: Json[];
  formats: Json[];
}

async function list(arr: Arr, path: string, what: string): Promise<Json[]> {
  const r = await arr<Json[]>("GET", path, `read ${what} (Crucible)`);
  if (!r.ok || !Array.isArray(r.data))
    throw new CruciblePlanError(`The app did not list its ${what} (${r.status}).`);
  return r.data;
}

/** Hearth's own profiles and formats as they are now (the plan's "before"; Undo restores it). */
async function snapshot(arr: Arr): Promise<Snapshot & { allProfiles: Json[]; allFormats: Json[] }> {
  const allProfiles = await list(arr, "/api/v3/qualityprofile", "quality profiles");
  const allFormats = await list(arr, "/api/v3/customformat", "custom formats");
  return {
    allProfiles,
    allFormats,
    profiles: allProfiles.filter((p) => isHearth(p.name)),
    formats: allFormats.filter((f) => isHearth(f.name)),
  };
}

/** Only what matters for "did someone change it since", in a stable form. */
const fingerprint = (s: Snapshot) =>
  JSON.stringify({
    profiles: s.profiles
      .map((p) => ({
        name: p.name,
        items: p.items,
        cutoff: p.cutoff,
        upgradeAllowed: p.upgradeAllowed,
        formatItems: ((p.formatItems as Json[]) ?? [])
          .filter((f) => isHearth(f.name))
          .map((f) => [f.name, f.score]),
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    formats: s.formats
      .map((f) => ({ name: f.name, specifications: f.specifications }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
  });

/** The profile most movies use: the template for Hearth's (its quality list, language, scores). */
function templateOf(profiles: Json[], movies: Json[]): Json {
  const own = profiles.filter((p) => !isHearth(p.name));
  if (!own.length) throw new CruciblePlanError("The app has no quality profile to start from.");
  const used = new Map<number, number>();
  for (const m of movies)
    used.set(Number(m.qualityProfileId), (used.get(Number(m.qualityProfileId)) ?? 0) + 1);
  return [...own].sort((a, b) => (used.get(Number(b.id)) ?? 0) - (used.get(Number(a.id)) ?? 0))[0]!;
}

/** Radarr's Connect webhook that tells Hearth the moment a movie is added (the keeper sorts it). */
export const HOOK_NAME = `${HEARTH_PREFIX}The Crucible`;
const hookBody = (url: string, shape: ArrShape = SHAPES.radarr) => ({
  name: HOOK_NAME,
  implementation: "Webhook",
  implementationName: "Webhook",
  configContract: "WebhookSettings",
  onGrab: false,
  onDownload: false,
  onUpgrade: false,
  onRename: false,
  [shape.hookFlag]: true,
  onHealthIssue: false,
  onApplicationUpdate: false,
  onManualInteractionRequired: false,
  includeHealthWarnings: false,
  tags: [],
  fields: [
    { name: "url", value: url },
    { name: "method", value: 1 },
    { name: "username", value: "" },
    { name: "password", value: "" },
  ],
});
const hookUrlOf = (n: Json | undefined) =>
  String(((n?.fields as Json[]) ?? []).find((f) => f.name === "url")?.value ?? "");
/** Where Hearth is, as Radarr should call it: an http(s) address, nothing else. */
export function hookBaseOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Gives titles their row: the row's profile, and its wait tag (other rows' wait tags removed),
 * so the right delay profile applies before the first search.
 */
export async function giveRow(
  arr: Arr,
  shape: ArrShape,
  ids: number[],
  profileId: number | undefined,
  row: CrucibleRow | undefined,
  purpose: string,
): Promise<boolean> {
  if (!ids.length) return true;
  const put = await arr("PUT", shape.editor, purpose, {
    [shape.ids]: ids,
    qualityProfileId: profileId,
  });
  if (!put.ok) return false;
  const tags = await arr<Json[]>("GET", "/api/v3/tag", "read the tags (the Crucible)");
  const waits = (tags.data ?? []).filter((t) => String(t.label).startsWith(WAIT_TAG_PREFIX));
  const mine = row && row.waitHours > 0 ? waits.find((t) => t.label === waitTag(row)) : undefined;
  const others = waits.filter((t) => t !== mine).map((t) => Number(t.id));
  if (others.length)
    await arr("PUT", shape.editor, "remove other rows' wait tags (the Crucible)", {
      [shape.ids]: ids,
      tags: others,
      applyTags: "remove",
    });
  if (mine)
    await arr("PUT", shape.editor, "add the row's wait tag (the Crucible)", {
      [shape.ids]: ids,
      tags: [Number(mine.id)],
      applyTags: "add",
    });
  return true;
}

/** Hearth's own delay profiles (on a hearth-wait- tag) and the tags themselves: Undo restores them. */
async function waitSnapshot(arr: Arr) {
  const tags = await list(arr, "/api/v3/tag", "tags");
  const waitTags = tags.filter((t) => String(t.label).startsWith(WAIT_TAG_PREFIX));
  const ids = new Set(waitTags.map((t) => Number(t.id)));
  const delays = (await list(arr, "/api/v3/delayprofile", "delay profiles")).filter((d) =>
    ((d.tags as number[]) ?? []).some((t) => ids.has(Number(t))),
  );
  return { tags: waitTags, delays };
}

export function parseSetup(text: unknown, shape: ArrShape = SHAPES.radarr): CrucibleSetup {
  let s: CrucibleSetup;
  try {
    s = JSON.parse(String(text)) as CrucibleSetup;
  } catch {
    throw new CruciblePlanError("The Crucible's setup isn't readable.");
  }
  if (!Array.isArray(s?.movies)) s.movies = [];
  if (!Array.isArray(s?.shows)) s.shows = [];
  const rows = shape.rows(s);
  if (!rows.length) throw new CruciblePlanError(`There are no ${shape.one} rows to save.`);
  for (const r of rows) {
    if (!r.name || !Array.isArray(r.ladder) || !r.ladder.length)
      throw new CruciblePlanError(`The row "${r.name ?? "?"}" needs at least one quality.`);
    for (const st of r.ladder)
      if (
        !CRUCIBLE_QUALITIES.includes(st.quality) ||
        (st.maxGB !== null && !(st.maxGB > 0 && st.maxGB <= 500))
      )
        throw new CruciblePlanError(`The row "${r.name}" has a step Hearth can't use.`);
    const g = (r.group ?? {}) as Record<string, unknown>;
    const nums = [
      "olderThanYears",
      "newerThanYears",
      "digitalWithinMonths",
      "fromYear",
      "toYear",
      "minRating",
      "maxRating",
      "minRuntime",
      "maxRuntime",
    ];
    for (const k of nums)
      if (
        g[k] !== undefined &&
        !(
          typeof g[k] === "number" &&
          Number.isFinite(g[k]) &&
          (g[k] as number) >= 0 &&
          (g[k] as number) <= 3000
        )
      )
        throw new CruciblePlanError(`The row "${r.name}" has a condition Hearth can't use (${k}).`);
    for (const k of ["genres", "notGenres", "tags", "languages"])
      if (
        g[k] !== undefined &&
        !(
          Array.isArray(g[k]) &&
          (g[k] as unknown[]).every((x) => typeof x === "string" && x.length <= 80)
        )
      )
        throw new CruciblePlanError(`The row "${r.name}" has a condition Hearth can't use (${k}).`);
  }
  const names = rows.map((r) => r.name.trim().toLowerCase());
  if (new Set(names).size !== names.length)
    throw new CruciblePlanError("Two rows have the same name; rename one.");
  return s;
}

const tagLabels = (tags: Json[]) => new Map(tags.map((t) => [Number(t.id), String(t.label)]));

/** Which profile each movie would move to (only movies whose profile changes). */
function moves(
  movies: Json[],
  rows: CrucibleRow[],
  tags: Map<number, string>,
  profileName: Map<number, string>,
  thisYear: number,
) {
  const out: { id: number; title: string; from: number; to: string }[] = [];
  for (const m of movies) {
    const r = rowFor(arrTitle(m, tags), rows, thisYear);
    if (!r) continue;
    const to = rowProfileName(r);
    if (profileName.get(Number(m.qualityProfileId)) !== to)
      out.push({
        id: Number(m.id),
        title: String(m.title ?? m.id),
        from: Number(m.qualityProfileId),
        to,
      });
  }
  return out;
}

/** The plan: what Save will create or change in Radarr, in words, and what the run needs. */
export async function planCrucible(
  arr: Arr,
  serviceName: string,
  params: StepParams | undefined,
  thisYear = new Date().getFullYear(),
): Promise<[StepChange, StepParams]> {
  const shape = shapeOf(params?.app);
  const setup = parseSetup(params?.setup, shape);
  const rows = shape.rows(setup);
  const resort = params?.resort === true || params?.resort === "true";
  const snap = await snapshot(arr);
  const movies = await list(arr, shape.items, shape.many);
  const settings: SettingChange[] = [];

  for (const f of shape.app === "radarr" ? capFormats(rows) : []) {
    const have = snap.formats.find((x) => x.name === f.name);
    if (!have)
      settings.push({
        name: `Turn down ${QUALITY_WORDS[f.quality]} over ${f.gb} GB`,
        before: "Not set",
        after: `New format "${f.name}"`,
      });
  }
  const smaller = shape.app === "radarr" && setup.smallerWins !== false;
  if (shape.app === "radarr") {
    const have = snap.formats.some((f) => String(f.name).startsWith(`${HEARTH_PREFIX}Smaller `));
    settings.push({
      name: "Same quality: take the smaller one",
      before: have ? "On" : "Off",
      after: smaller
        ? `On: ${smallerFormats().length} size bands (for example 1080p under 4, 8 and 12 GB) each add ${SMALLER_SCORE} to a release's score, so of two the same quality the smaller wins; never a reason to re-download on its own`
        : "Off",
    });
  }
  for (const r of rows) {
    const name = rowProfileName(r);
    const have = snap.profiles.find((p) => p.name === name);
    settings.push({
      name: `${r.name}`,
      before: have ? `Profile "${name}" (being updated)` : "No profile yet",
      after: `${shape.app === "sonarr" ? ladderWords({ ...r, ladder: r.ladder.map((st) => ({ ...st, maxGB: null })) }) : ladderWords(r)}${r.upgrade ? ", upgrades when a better one fits" : ", no upgrades"}`,
    });
  }
  // Shows: the main TV row's caps are Sonarr's own size limits (per minute, so a season pack is
  // judged per episode), unless Recyclarr or Profilarr manages them.
  let sizes: ReturnType<typeof sizeChanges> = [];
  if (shape.app === "sonarr") {
    const managed = params?.sizesManaged === true || params?.sizesManaged === "true";
    if (managed)
      settings.push({
        name: "Episode sizes",
        before: "Managed by Recyclarr or Profilarr",
        after: "Left alone (the Crucible only sets which qualities each row wants)",
      });
    else {
      sizes = sizeChanges(await list(arr, "/api/v3/qualitydefinition", "size limits"), rows);
      for (const c of sizes)
        settings.push({
          name: `Size limit, ${c.title}`,
          before: c.from == null ? "No limit" : `${c.from} MB a minute`,
          after: `${c.to} MB a minute: about ${c.gb} GB for an hour-long episode, less for shorter ones (season packs judged per episode)`,
        });
    }
  }
  // Shows: season packs preferred, not, or avoided, and a cap for a whole pack.
  if (shape.app === "sonarr") {
    const packs = seasonPacksOf(setup);
    const hadPack = snap.formats.some((f) => f.name === SEASON_PACK_FORMAT);
    const hadCap = snap.formats.some((f) =>
      String(f.name).startsWith(`${SEASON_PACK_FORMAT} over `),
    );
    settings.push({
      name: "Season packs",
      before: hadPack || hadCap ? "Set by the Crucible before (being updated)" : "No preference",
      after: `${seasonPackSentence(packs)}. Episodes already downloaded are never replaced just to swap them for a pack`,
    });
  }
  let moved: ReturnType<typeof moves> = [];
  if (resort) {
    const tags = tagLabels(await list(arr, "/api/v3/tag", "tags"));
    const names = new Map(snap.allProfiles.map((p) => [Number(p.id), String(p.name)]));
    moved = moves(movies, rows, tags, names, thisYear);
    settings.push({
      name: `${shape.Many} you already have`,
      before: `${moved.length} on another profile`,
      after: moved.length
        ? `Each moves to its row's profile (${moved.length} ${moved.length === 1 ? shape.one : shape.many}); files already downloaded stay as they are`
        : "Already in the right rows",
    });
  } else
    settings.push({
      name: `${shape.Many} you already have`,
      before: "Keep their profiles",
      after: `Unchanged (new ${shape.many} get their row's profile)`,
    });

  if (setup.searchAfterSorting)
    settings.push({
      name: "Requests wait for the Crucible",
      before: snap.profiles.some((x) => x.name === HOLD_PROFILE) ? "Set up" : "Not set",
      after: `Profile "${HOLD_PROFILE}": nothing can be grabbed on it (a search or RSS sync) until the Crucible gives the ${shape.one} its row and searches`,
    });
  const hookBase = hookBaseOf(params?.hookBase);
  let hookBefore = "";
  if (hookBase) {
    const have = (await list(arr, "/api/v3/notification", "connections")).find(
      (n) => n.name === HOOK_NAME,
    );
    hookBefore = have ? JSON.stringify(have) : "";
    settings.push({
      name: `Tell Hearth the moment a ${shape.one} is added`,
      before: have ? "Set up" : "Not set",
      after: `${shape.App} calls Hearth at ${hookBase} (a private link) on each new ${shape.one}, so its row is in place before the first search`,
    });
  }

  for (const r of rows.filter((x) => x.waitHours > 0 && x.ladder.length > 1))
    settings.push({
      name: `${r.name}: wait for the best first`,
      before: "No wait",
      after: `Wait up to ${waitWords(r.waitHours)} for ${QUALITY_WORDS[r.ladder[0]!.quality]} before settling for ${QUALITY_WORDS[r.ladder[1]!.quality]}; no wait once it turns up (a ${shape.App} delay profile on the tag "${waitTag(r)}")`,
    });
  const waitBefore = await waitSnapshot(arr);
  const template = templateOf(snap.allProfiles, movies);
  return [
    {
      summary: `Save the Crucible's ${shape.one} rows in ${serviceName}`,
      settings,
    },
    {
      app: shape.app,
      setup: JSON.stringify(setup),
      waitBefore: JSON.stringify(waitBefore),
      ...(sizes.length ? { sizes: JSON.stringify(sizes) } : {}),
      resort,
      template: Number(template.id),
      before: JSON.stringify({ profiles: snap.profiles, formats: snap.formats }),
      fingerprint: fingerprint(snap),
      moves: JSON.stringify(moved.map((m) => [m.id, m.from, m.to])),
      ...(hookBase ? { hookBase, hookBefore } : {}),
    },
  ];
}

export interface CrucibleRunResult {
  ok: boolean;
  verified: boolean;
  stale?: boolean;
  result: string;
  /** What Undo needs (the profiles and formats Hearth created). */
  created?: { profiles: string[]; formats: string[] };
}

/** The run: re-read, stop if Hearth's objects changed since the plan, write, read back. */
export async function runCrucible(
  arr: Arr,
  serviceName: string,
  p: StepParams,
  opts: { hookUrl?: string } = {},
): Promise<CrucibleRunResult> {
  const shape = shapeOf(p.app);
  const setup = parseSetup(p.setup, shape);
  const rows = shape.rows(setup);
  const snap = await snapshot(arr);
  if (fingerprint(snap) !== p.fingerprint)
    return {
      ok: false,
      verified: false,
      stale: true,
      result: `Hearth's profiles or formats in ${serviceName} changed since this plan was made. Nothing was changed; open the Crucible and save again.`,
    };
  const created = { profiles: [] as string[], formats: [] as string[] };

  // 1. The cap formats.
  const formatId = new Map<string, number>(
    snap.allFormats.map((f) => [String(f.name), Number(f.id)]),
  );
  for (const f of shape.app === "radarr" ? capFormats(rows) : []) {
    const body = {
      name: f.name,
      includeCustomFormatWhenRenaming: false,
      specifications: capSpecifications(f.quality, f.gb),
    };
    const have = snap.formats.find((x) => x.name === f.name);
    const r = have
      ? await arr<Json>(
          "PUT",
          `/api/v3/customformat/${Number(have.id)}`,
          `update ${f.name} (approved plan)`,
          { ...have, ...body },
        )
      : await arr<Json>("POST", "/api/v3/customformat", `add ${f.name} (approved plan)`, body);
    if (!r.ok)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} refused the format "${f.name}" (${r.status}). Stopped there; Undo puts back what was done.`,
      };
    if (!have) created.formats.push(f.name);
    formatId.set(f.name, Number((r.data as Json).id));
  }

  // 1a. Smaller wins: the size band formats (movies only).
  const smaller = shape.app === "radarr" && setup.smallerWins !== false;
  for (const f of smaller ? smallerFormats() : []) {
    const body = {
      name: f.name,
      includeCustomFormatWhenRenaming: false,
      specifications: smallerSpecifications(f.quality, f.gb),
    };
    const have = snap.formats.find((x) => x.name === f.name);
    const r = have
      ? await arr<Json>(
          "PUT",
          `/api/v3/customformat/${Number(have.id)}`,
          `update ${f.name} (approved plan)`,
          {
            ...have,
            ...body,
          },
        )
      : await arr<Json>("POST", "/api/v3/customformat", `add ${f.name} (approved plan)`, body);
    if (!r.ok)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} refused the format "${f.name}" (${r.status}). Stopped there; Undo puts back what was done.`,
      };
    if (!have) created.formats.push(f.name);
  }
  const smallerNames = new Set(smaller ? smallerFormats().map((f) => f.name) : []);

  // 1a'. Shows: the season pack format (scored up or down per the choice) and the pack cap.
  const packs = shape.app === "sonarr" ? seasonPacksOf(setup) : DEFAULT_SEASON_PACKS;
  const packFormats = [
    ...(packs.choice !== "neutral"
      ? [{ name: SEASON_PACK_FORMAT, specifications: seasonPackSpecifications() }]
      : []),
    ...(packs.maxGB
      ? [
          {
            name: seasonPackCapName(packs.maxGB),
            specifications: seasonPackCapSpecifications(packs.maxGB),
          },
        ]
      : []),
  ];
  for (const f of packFormats) {
    const body = {
      name: f.name,
      includeCustomFormatWhenRenaming: false,
      specifications: f.specifications,
    };
    const have = snap.formats.find((x) => x.name === f.name);
    const r = have
      ? await arr<Json>(
          "PUT",
          `/api/v3/customformat/${Number(have.id)}`,
          `update ${f.name} (approved plan)`,
          { ...have, ...body },
        )
      : await arr<Json>("POST", "/api/v3/customformat", `add ${f.name} (approved plan)`, body);
    if (!r.ok)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} refused the format "${f.name}" (${r.status}). Stopped there; Undo puts back what was done.`,
      };
    if (!have) created.formats.push(f.name);
  }
  const packScore =
    packs.choice === "prefer"
      ? SEASON_PACK_SCORE
      : packs.choice === "avoid"
        ? -SEASON_PACK_SCORE
        : 0;
  const packCap = packs.maxGB ? seasonPackCapName(packs.maxGB) : undefined;

  // 1b. The checkpoint's hold format (every release turned down), when Seerr's search is the
  // Crucible's.
  if (setup.searchAfterSorting) {
    const have = snap.formats.find((x) => x.name === HOLD_FORMAT);
    const body = {
      name: HOLD_FORMAT,
      includeCustomFormatWhenRenaming: false,
      specifications: holdSpecifications(),
    };
    const r = have
      ? await arr<Json>(
          "PUT",
          `/api/v3/customformat/${Number(have.id)}`,
          `update ${HOLD_FORMAT} (approved plan)`,
          { ...have, ...body },
        )
      : await arr<Json>("POST", "/api/v3/customformat", `add ${HOLD_FORMAT} (approved plan)`, body);
    if (!r.ok)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} refused the format "${HOLD_FORMAT}" (${r.status}). Stopped there; Undo puts back what was done.`,
      };
    if (!have) created.formats.push(HOLD_FORMAT);
  }

  // 2. A profile per row, from the template (its qualities in Radarr's order, language, scores).
  const allFormats = await list(arr, "/api/v3/customformat", "custom formats");
  const tmpl =
    snap.allProfiles.find((x) => Number(x.id) === Number(p.template)) ??
    templateOf(snap.allProfiles, []);
  const tmplScores = new Map(
    ((tmpl.formatItems as Json[]) ?? []).map((f) => [Number(f.format), Number(f.score ?? 0)]),
  );
  const profileId = new Map<string, number>(
    snap.allProfiles.map((x) => [String(x.name), Number(x.id)]),
  );
  for (const row of rows) {
    const name = rowProfileName(row);
    const items = profileItems(tmpl.items as ArrProfileItem[], row);
    const cutoff = cutoffOf(items, row);
    if (cutoff === undefined)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} has no ${row.ladder[0]!.quality} quality to stop at for "${row.name}". Stopped there; Undo puts back what was done.`,
      };
    const blocks = new Set(shape.app === "radarr" ? rowBlocks(row) : []);
    const formatItems = allFormats.map((f) => ({
      format: Number(f.id),
      name: f.name,
      score: isHearth(f.name)
        ? blocks.has(String(f.name)) || String(f.name) === packCap
          ? BLOCK_SCORE
          : smallerNames.has(String(f.name))
            ? SMALLER_SCORE
            : String(f.name) === SEASON_PACK_FORMAT
              ? packScore
              : 0
        : (tmplScores.get(Number(f.id)) ?? 0),
    }));
    const body: Json = {
      name,
      upgradeAllowed: row.upgrade,
      cutoff,
      items,
      minFormatScore: Math.max(0, Number(tmpl.minFormatScore ?? 0)),
      cutoffFormatScore: Number(tmpl.cutoffFormatScore ?? 0),
      // Size bands add at most a few points: never enough to upgrade on their own.
      // Size bands add at most a few points, and a preferred season pack SEASON_PACK_SCORE: never
      // enough to upgrade on their own (episodes on disk aren't swapped for a pack).
      minUpgradeFormatScore: Math.max(
        smaller ? SMALLER_NO_UPGRADE : 1,
        packScore > 0 ? packScore + 1 : 1,
        Number(tmpl.minUpgradeFormatScore ?? 1),
      ),
      formatItems,
      ...(tmpl.language ? { language: tmpl.language } : {}),
    };
    const have = snap.profiles.find((x) => x.name === name);
    const r = have
      ? await arr<Json>(
          "PUT",
          `/api/v3/qualityprofile/${Number(have.id)}`,
          `update ${name} (approved plan)`,
          { ...body, id: Number(have.id) },
        )
      : await arr<Json>("POST", "/api/v3/qualityprofile", `add ${name} (approved plan)`, body);
    if (!r.ok)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} refused the profile "${name}" (${r.status}). Stopped there; Undo puts back what was done.`,
      };
    if (!have) created.profiles.push(name);
    profileId.set(name, Number((r.data as Json).id));
  }

  // 2b. The checkpoint's holding profile: the template's qualities, every release turned down.
  if (setup.searchAfterSorting) {
    const have = snap.profiles.find((x) => x.name === HOLD_PROFILE);
    const body: Json = {
      name: HOLD_PROFILE,
      upgradeAllowed: false,
      cutoff: tmpl.cutoff,
      items: tmpl.items,
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: 1,
      formatItems: allFormats.map((f) => ({
        format: Number(f.id),
        name: f.name,
        score: f.name === HOLD_FORMAT ? BLOCK_SCORE : 0,
      })),
      ...(tmpl.language ? { language: tmpl.language } : {}),
    };
    const r = have
      ? await arr<Json>(
          "PUT",
          `/api/v3/qualityprofile/${Number(have.id)}`,
          `update ${HOLD_PROFILE} (approved plan)`,
          { ...body, id: Number(have.id) },
        )
      : await arr<Json>(
          "POST",
          "/api/v3/qualityprofile",
          `add ${HOLD_PROFILE} (approved plan)`,
          body,
        );
    if (!r.ok)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} refused the profile "${HOLD_PROFILE}" (${r.status}). Stopped there; Undo puts back what was done.`,
      };
    if (!have) created.profiles.push(HOLD_PROFILE);
  }

  // 2c. Shows: Sonarr's own size limits from the main TV row (per minute; packs per episode).
  const sizes = JSON.parse(String(p.sizes ?? "[]")) as ReturnType<typeof sizeChanges>;
  if (sizes.length) {
    const defs = await list(arr, "/api/v3/qualitydefinition", "size limits");
    for (const c of sizes) {
      const d = defs.find((x) => Number(x.id) === c.id);
      if (!d) continue;
      const preferred = d.preferredSize == null ? null : Math.min(Number(d.preferredSize), c.to);
      const r = await arr(
        "PUT",
        `/api/v3/qualitydefinition/${c.id}`,
        `size limit for ${c.title} (approved plan)`,
        { ...d, maxSize: c.to, preferredSize: preferred },
      );
      if (!r.ok)
        return {
          ok: false,
          verified: false,
          created,
          result: `${serviceName} refused the size limit for ${c.title} (${r.status}). Stopped there; Undo puts back what was done.`,
        };
    }
  }

  // 2d. Wait for the best first: a tag and a delay profile per waiting row; stale ones removed.
  const waitRows = rows.filter((x) => x.waitHours > 0 && x.ladder.length > 1);
  if (waitRows.length || JSON.parse(String(p.waitBefore ?? "{}")).delays?.length) {
    const allDelays = await list(arr, "/api/v3/delayprofile", "delay profiles");
    const base = allDelays.find((d) => !((d.tags as number[]) ?? []).length) ?? {};
    let tags = await list(arr, "/api/v3/tag", "tags");
    for (const r of waitRows) {
      const label = waitTag(r);
      let tag = tags.find((t) => t.label === label);
      if (!tag) {
        const made = await arr<Json>(
          "POST",
          "/api/v3/tag",
          `add the tag ${label} (approved plan)`,
          { label },
        );
        if (!made.ok)
          return {
            ok: false,
            verified: false,
            created,
            result: `${serviceName} refused the tag "${label}" (${made.status}). Stopped there; Undo puts back what was done.`,
          };
        tag = made.data;
        tags = [...tags, tag];
      }
      const minutes = Math.round(r.waitHours * 60);
      const body: Json = {
        enableUsenet: base.enableUsenet ?? true,
        enableTorrent: base.enableTorrent ?? true,
        preferredProtocol: base.preferredProtocol ?? "usenet",
        usenetDelay: minutes,
        torrentDelay: minutes,
        bypassIfHighestQuality: true,
        bypassIfAboveCustomFormatScore: false,
        minimumCustomFormatScore: 0,
        tags: [Number(tag.id)],
      };
      const have = allDelays.find((d) => ((d.tags as number[]) ?? []).includes(Number(tag!.id)));
      const w = have
        ? await arr(
            "PUT",
            `/api/v3/delayprofile/${Number(have.id)}`,
            `wait for ${r.name} (approved plan)`,
            { ...have, ...body },
          )
        : await arr("POST", "/api/v3/delayprofile", `wait for ${r.name} (approved plan)`, body);
      if (!w.ok)
        return {
          ok: false,
          verified: false,
          created,
          result: `${serviceName} refused the wait for "${r.name}" (${w.status}). Stopped there; Undo puts back what was done.`,
        };
    }
    // A row that no longer waits: its delay profile goes (its tag stays, harmless).
    const keep = new Set(waitRows.map(waitTag));
    const stale = tags.filter(
      (t) => String(t.label).startsWith(WAIT_TAG_PREFIX) && !keep.has(String(t.label)),
    );
    for (const t of stale)
      for (const d of allDelays.filter((x) => ((x.tags as number[]) ?? []).includes(Number(t.id))))
        await arr(
          "DELETE",
          `/api/v3/delayprofile/${Number(d.id)}`,
          `stop waiting (${String(t.label)}, approved plan)`,
        );
  }

  // 3. Titles moved to their row (only when asked).
  const mv = JSON.parse(String(p.moves ?? "[]")) as [number, number, string][];
  const byTarget = new Map<string, number[]>();
  for (const [id, , to] of mv) byTarget.set(to, [...(byTarget.get(to) ?? []), id]);
  for (const [to, ids] of byTarget) {
    const ok = await giveRow(
      arr,
      shape,
      ids,
      profileId.get(to),
      rows.find((x) => rowProfileName(x) === to),
      `move ${ids.length} ${shape.many} to ${to} (approved plan)`,
    );
    if (!ok)
      return {
        ok: false,
        verified: false,
        created,
        result: `${serviceName} refused moving ${shape.many} to "${to}". Stopped there; Undo puts back what was done.`,
      };
  }

  // 3b. The checkpoint turned off: every request still waiting gets its row now, and is searched.
  let releasedLine = "";
  if (!setup.searchAfterSorting) {
    const rel = await releaseHeld(arr, setup, new Date().getFullYear(), undefined, shape);
    if (rel.released.length)
      releasedLine = ` ${rel.released.length} waiting ${rel.released.length === 1 ? "request" : "requests"} got their row and ${rel.searched === 1 ? "was" : "were"} searched.`;
    if (rel.stuck.length)
      releasedLine += ` Still waiting (move them in ${shape.App}): ${rel.stuck.join(", ")}.`;
  }

  // 4. Radarr's webhook to Hearth (the address and its private key; Hearth's own connection).
  let hookOk = true;
  if (opts.hookUrl) {
    const have = (await list(arr, "/api/v3/notification", "connections")).find(
      (n) => n.name === HOOK_NAME,
    );
    const body = hookBody(opts.hookUrl, shape);
    const r = have
      ? await arr<Json>(
          "PUT",
          `/api/v3/notification/${Number(have.id)}`,
          `update ${HOOK_NAME} (approved plan)`,
          { ...body, id: Number(have.id) },
        )
      : await arr<Json>("POST", "/api/v3/notification", `add ${HOOK_NAME} (approved plan)`, body);
    const back = (await list(arr, "/api/v3/notification", "connections")).find(
      (n) => n.name === HOOK_NAME,
    );
    hookOk = r.ok && Boolean(back?.[shape.hookFlag]) && hookUrlOf(back) === opts.hookUrl;
  }

  // Read back: every row's profile with its qualities and caps, every moved movie on it.
  const after = await snapshot(arr);
  const missing = rows.filter((row) => {
    const prof = after.profiles.find((x) => x.name === rowProfileName(row));
    if (!prof) return true;
    const blocked = ((prof.formatItems as Json[]) ?? [])
      .filter((f) => Number(f.score) === BLOCK_SCORE)
      .map((f) => String(f.name));
    const bonus = ((prof.formatItems as Json[]) ?? [])
      .filter((f) => smallerNames.has(String(f.name)) && Number(f.score) === SMALLER_SCORE)
      .map((f) => String(f.name));
    return (
      (shape.app === "radarr" ? rowBlocks(row) : []).some((b) => !blocked.includes(b)) ||
      prof.upgradeAllowed !== row.upgrade ||
      bonus.length !== smallerNames.size
    );
  });
  let sizesOk = true;
  if (sizes.length) {
    const defs = await list(arr, "/api/v3/qualitydefinition", "size limits");
    sizesOk = sizes.every((c) => Number(defs.find((x) => Number(x.id) === c.id)?.maxSize) === c.to);
  }
  const waitNow = await waitSnapshot(arr);
  const waitOk = waitRows.every((r) => {
    const tag = waitNow.tags.find((t) => t.label === waitTag(r));
    const d =
      tag && waitNow.delays.find((x) => ((x.tags as number[]) ?? []).includes(Number(tag.id)));
    return (
      Boolean(d) &&
      Number(d!.usenetDelay) === Math.round(r.waitHours * 60) &&
      d!.bypassIfHighestQuality === true
    );
  });
  let movedOk = true;
  if (mv.length) {
    const movies = await list(arr, shape.items, shape.many);
    const at = new Map(movies.map((m) => [Number(m.id), Number(m.qualityProfileId)]));
    movedOk = mv.every(([id, , to]) => at.get(id) === profileId.get(to));
  }
  const holdOk =
    !setup.searchAfterSorting ||
    ((after.profiles.find((x) => x.name === HOLD_PROFILE)?.formatItems as Json[]) ?? []).some(
      (f) => f.name === HOLD_FORMAT && Number(f.score) === BLOCK_SCORE,
    );
  const verified = missing.length === 0 && movedOk && hookOk && holdOk && sizesOk && waitOk;
  return {
    ok: true,
    verified,
    created,
    result: verified
      ? `Saved ${rows.length} ${rows.length === 1 ? "row" : "rows"} in ${serviceName}${sizes.length ? `, set ${sizes.length} episode size ${sizes.length === 1 ? "limit" : "limits"}` : ""}${mv.length ? ` and moved ${mv.length} ${mv.length === 1 ? shape.one : shape.many} to their row` : ""}, verified by reading it back.${releasedLine}`
      : `${serviceName} accepted the changes, but ${missing.length ? `"${missing.map((r) => r.name).join('", "')}" ` : `some ${shape.many} or sizes `}don't read back as approved.`,
  };
}

/**
 * Undo: movies back to the profiles they had, Hearth's profiles and formats back as they were,
 * and the ones Save created removed.
 */
export async function undoCrucible(
  arr: Arr,
  serviceName: string,
  p: StepParams,
  /** Seerr's earlier default profile, for requests waiting on the holding profile. */
  opts: { fallback?: { id?: number; name?: string } } = {},
): Promise<CrucibleRunResult> {
  const shape = shapeOf(p.app);
  const before = JSON.parse(String(p.before)) as Snapshot;
  const mv = JSON.parse(String(p.moves ?? "[]")) as [number, number, string][];
  const byFrom = new Map<number, number[]>();
  for (const [id, from] of mv) byFrom.set(from, [...(byFrom.get(from) ?? []), id]);
  for (const [from, ids] of byFrom)
    await arr("PUT", shape.editor, `put ${shape.many} back on their profile (undo)`, {
      [shape.ids]: ids,
      qualityProfileId: from,
    });
  // Waits: Hearth's delay profiles back as they were before Save.
  if (p.waitBefore) {
    const was = JSON.parse(String(p.waitBefore)) as { tags: Json[]; delays: Json[] };
    const now = await waitSnapshot(arr);
    for (const d of now.delays) {
      const old = was.delays.find((x) => Number(x.id) === Number(d.id));
      if (old)
        await arr("PUT", `/api/v3/delayprofile/${Number(d.id)}`, "put back a wait (undo)", old);
      else await arr("DELETE", `/api/v3/delayprofile/${Number(d.id)}`, "remove a wait (undo)");
    }
    for (const old of was.delays)
      if (!now.delays.some((d) => Number(d.id) === Number(old.id))) {
        const { id: _id, ...rest } = old;
        await arr("POST", "/api/v3/delayprofile", "put back a wait (undo)", rest);
      }
  }
  // Shows: Sonarr's size limits back as they were.
  const sizes = JSON.parse(String(p.sizes ?? "[]")) as ReturnType<typeof sizeChanges>;
  let sizesOk = true;
  if (sizes.length) {
    const defs = await list(arr, "/api/v3/qualitydefinition", "size limits");
    for (const c of sizes) {
      const d = defs.find((x) => Number(x.id) === c.id);
      if (d)
        await arr(
          "PUT",
          `/api/v3/qualitydefinition/${c.id}`,
          `put back the size limit for ${c.title} (undo)`,
          {
            ...d,
            maxSize: c.from,
            preferredSize: c.preferred,
          },
        );
    }
    const back = await list(arr, "/api/v3/qualitydefinition", "size limits");
    sizesOk = sizes.every((c) => {
      const m = back.find((x) => Number(x.id) === c.id)?.maxSize;
      return (m == null ? null : Number(m)) === c.from;
    });
  }
  // Never strand a movie: requests waiting for the Crucible go to Seerr's earlier default (else
  // the profile Save copied) and are searched; any other movie on a Hearth profile that Undo
  // removes goes to the profile Save copied (Radarr refuses to remove a profile still in use).
  const template = Number(p.template);
  const rel = await releaseHeld(
    arr,
    undefined,
    new Date().getFullYear(),
    opts.fallback ?? (Number.isFinite(template) ? { id: template } : undefined),
    shape,
  );
  const goingAway = new Set(
    (await snapshot(arr)).profiles
      .filter((x) => !before.profiles.some((b) => b.name === x.name))
      .map((x) => Number(x.id)),
  );
  const onThem = (await list(arr, shape.items, shape.many))
    .filter((m) => goingAway.has(Number(m.qualityProfileId)))
    .map((m) => Number(m.id));
  if (onThem.length && Number.isFinite(template))
    await arr("PUT", shape.editor, `move ${shape.many} off Hearth's profiles (undo)`, {
      [shape.ids]: onThem,
      qualityProfileId: template,
    });
  const now = await snapshot(arr);
  for (const prof of now.profiles) {
    const old = before.profiles.find((x) => x.name === prof.name);
    if (old)
      await arr(
        "PUT",
        `/api/v3/qualityprofile/${Number(prof.id)}`,
        `put back ${String(prof.name)} (undo)`,
        old,
      );
    else
      await arr(
        "DELETE",
        `/api/v3/qualityprofile/${Number(prof.id)}`,
        `remove ${String(prof.name)} (undo)`,
      );
  }
  for (const f of now.formats) {
    const old = before.formats.find((x) => x.name === f.name);
    if (old)
      await arr(
        "PUT",
        `/api/v3/customformat/${Number(f.id)}`,
        `put back ${String(f.name)} (undo)`,
        old,
      );
    else
      await arr(
        "DELETE",
        `/api/v3/customformat/${Number(f.id)}`,
        `remove ${String(f.name)} (undo)`,
      );
  }
  // Radarr's webhook to Hearth: as it was before Save, or gone.
  if (p.hookBase) {
    const now = (await list(arr, "/api/v3/notification", "connections")).find(
      (n) => n.name === HOOK_NAME,
    );
    const old = p.hookBefore ? (JSON.parse(String(p.hookBefore)) as Json) : undefined;
    if (now && old)
      await arr(
        "PUT",
        `/api/v3/notification/${Number(now.id)}`,
        `put back ${HOOK_NAME} (undo)`,
        old,
      );
    else if (now)
      await arr("DELETE", `/api/v3/notification/${Number(now.id)}`, `remove ${HOOK_NAME} (undo)`);
  }
  const after = await snapshot(arr);
  const verified = fingerprint(after) === fingerprint(before) && sizesOk;
  return {
    ok: true,
    verified,
    result: verified
      ? `The Crucible's changes in ${serviceName} are undone: profiles, formats${sizes.length ? ", size limits" : ""} and ${shape.many} are back as they were.${rel.released.length ? ` ${rel.released.length} waiting ${rel.released.length === 1 ? "request was" : "requests were"} moved off the holding profile and searched.` : ""}`
      : `Put back what Hearth could in ${serviceName}, but its profiles or formats don't read back exactly as before.${rel.stuck.length ? ` Still on the holding profile: ${rel.stuck.join(", ")}.` : ""}`,
  };
}
