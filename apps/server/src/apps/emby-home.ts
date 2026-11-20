import type { PlannedStep, StepOutcome } from "../jobs/operations";
import type { JellyfinCallFn } from "./jellyfin-manage";

/**
 * Home rows for Emby (11-09). Emby 4.8 and later keep each person's home screen on the server as a
 * list of sections Hearth can add, change, move and remove: Emby's own (My Media, Continue
 * Watching, Latest Media...), a row of one collection or playlist, and a row of titles picked by
 * filters (type, genre, tag, unwatched, favorites). A row of hand-picked titles becomes a
 * collection Hearth makes first, then a row of it, as Plex's Home rows do. The library order and
 * My Media stay in the person's settings, as in Jellyfin.
 *
 * Checked against a real Emby 4.10.2.0 (11-09): sections are read in edit mode (Latest Media is
 * one block there, a row per library on the home screen); saving a section with its Id changes
 * it in place; Move takes Ids and a NewIndex; Delete takes Ids, Emby's own sections included;
 * re-adding one of Emby's gives it a new id. Older Emby (no HomeSections) uses Jellyfin's way.
 */

/** The sections Emby offers, in the words its own settings use (Emby web 4.10's list). */
export const EMBY_SECTIONS = {
  userviews: "My Media",
  resume: "Continue Watching",
  resumeaudio: "Continue Listening",
  latestmediablock: "Latest Media",
  collections: "All collections",
  playlists: "All playlists",
  boxset: "A collection",
  playlist: "A playlist",
  items: "Titles you choose by filters",
  latestmoviereleases: "Recently released movies",
  latestepisodereleases: "Recently released episodes",
  onnow: "On Now (Live TV)",
  activerecordings: "Recording now (Live TV)",
} as const;
export type EmbySectionType = keyof typeof EMBY_SECTIONS;
const isType = (s: string): s is EmbySectionType => s in EMBY_SECTIONS;

/** Kinds of titles a filtered row can hold (Emby's names). */
export const EMBY_ITEM_TYPES = ["Movie", "Series", "Episode", "MusicVideo", "Video"] as const;
/** How a filtered or collection row sorts (Emby's names). */
export const EMBY_SORTS = [
  "Random",
  "DateCreated",
  "PremiereDate",
  "SortName",
  "CommunityRating",
] as const;

/** One row of a person's home screen, as Hearth shows and sends it. */
export interface EmbyRow {
  /** Emby's id for a section the person has; absent for a new row. */
  id?: string;
  type: string;
  /** The row's own name (Emby's CustomName). */
  name?: string;
  /** The collection or playlist of a one-collection or one-playlist row. */
  parentId?: string;
  /** Hand-picked titles: Hearth makes a collection of them named after the row (new rows only). */
  titles?: string[];
  itemTypes?: string[];
  genreIds?: string[];
  tagIds?: string[];
  unwatched?: boolean;
  favorites?: boolean;
  sortBy?: string;
  sortOrder?: "Ascending" | "Descending";
  /** Libraries left out (Latest Media, filtered rows). */
  excluded?: string[];
}

/** One person's home screen. */
export interface EmbyHome {
  rows: EmbyRow[];
  /** Every library the person can see, in their order. */
  order: string[];
  /** Libraries shown in My Media. */
  media: string[];
}

interface RawSection {
  Id: string;
  Name?: string;
  CustomName?: string | null;
  SectionType: string;
  ParentId?: string | null;
  ItemTypes?: string[];
  ExcludedFolders?: string[];
  SortBy?: string | null;
  SortOrder?: string | null;
  Query?: {
    GenreIds?: string[];
    TagIds?: string[];
    IsPlayed?: boolean | null;
    IsFavorite?: boolean | null;
    [k: string]: unknown;
  };
  ParentItem?: { Name?: string };
  [k: string]: unknown;
}
interface RawConfig {
  OrderedViews?: string[];
  MyMediaExcludes?: string[];
  [k: string]: unknown;
}

const enc = encodeURIComponent;
const SECTIONS = (user: string) => `/Users/${enc(user)}/HomeSections`;
const PARENT_TYPES = new Set(["boxset", "playlist"]);
const EXCLUDE_TYPES = new Set(["latestmediablock", "items"]);
const MAX_ROWS = 30;

/**
 * A person's sections in edit mode, or undefined when this server keeps no home sections of
 * its own (Jellyfin, and Emby before 4.8): those use Jellyfin's way (jellyfin-home.ts).
 */
export async function readSections(
  call: JellyfinCallFn,
  userId: string,
): Promise<RawSection[] | undefined> {
  const r = await call<RawSection[]>("GET", `${SECTIONS(userId)}?IsEditMode=true`);
  if (!r.ok || !Array.isArray(r.data)) return undefined;
  return r.data;
}

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
const sorted = (v?: string[]) => [...(v ?? [])].sort();

/** What Hearth reads and writes of one section. */
export function rowOf(s: RawSection): EmbyRow {
  const row: EmbyRow = { id: s.Id, type: s.SectionType };
  if (s.CustomName) row.name = s.CustomName;
  if (PARENT_TYPES.has(s.SectionType) && s.ParentId) row.parentId = s.ParentId;
  if (EXCLUDE_TYPES.has(s.SectionType) && s.ExcludedFolders?.length)
    row.excluded = list(s.ExcludedFolders);
  if (s.SectionType === "items") {
    if (s.ItemTypes?.length) row.itemTypes = list(s.ItemTypes);
    if (s.Query?.GenreIds?.length) row.genreIds = list(s.Query.GenreIds);
    if (s.Query?.TagIds?.length) row.tagIds = list(s.Query.TagIds);
    if (s.Query?.IsPlayed === false) row.unwatched = true;
    if (s.Query?.IsFavorite === true) row.favorites = true;
  }
  if (s.SortBy) row.sortBy = s.SortBy;
  if (s.SortOrder === "Ascending" || s.SortOrder === "Descending") row.sortOrder = s.SortOrder;
  return row;
}

/** A row's content without its id, to tell whether two rows are the same. */
export function rowKey(r: EmbyRow): string {
  return JSON.stringify({
    t: r.type,
    n: r.name ?? "",
    p: PARENT_TYPES.has(r.type) ? (r.parentId ?? "") : "",
    x: EXCLUDE_TYPES.has(r.type) ? sorted(r.excluded) : [],
    i: r.type === "items" ? sorted(r.itemTypes) : [],
    g: r.type === "items" ? sorted(r.genreIds) : [],
    tg: r.type === "items" ? sorted(r.tagIds) : [],
    u: r.type === "items" && Boolean(r.unwatched),
    f: r.type === "items" && Boolean(r.favorites),
    s: r.sortBy ?? "",
    o: r.sortOrder ?? "",
  });
}

/** One section to send: Emby's own fields kept, Hearth's set. */
function rawOf(r: EmbyRow, was?: RawSection): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(was ?? {}), SectionType: r.type };
  if (was) out.Id = was.Id;
  else delete out.Id;
  delete out.Name;
  delete out.ParentItem;
  out.CustomName = r.name?.trim() || null;
  if (PARENT_TYPES.has(r.type)) out.ParentId = r.parentId ?? null;
  if (EXCLUDE_TYPES.has(r.type)) out.ExcludedFolders = r.excluded ?? [];
  if (r.type === "items") {
    out.ItemTypes = r.itemTypes ?? [];
    const q: Record<string, unknown> = { ...(was?.Query ?? {}) };
    q.GenreIds = r.genreIds ?? [];
    q.TagIds = r.tagIds ?? [];
    if (r.unwatched) q.IsPlayed = false;
    else delete q.IsPlayed;
    if (r.favorites) q.IsFavorite = true;
    else delete q.IsFavorite;
    out.Query = q;
  }
  out.SortBy = r.sortBy ?? null;
  out.SortOrder = r.sortOrder ?? null;
  return out;
}

async function readUsers(call: JellyfinCallFn) {
  const r = await call<
    { Id: string; Name?: string; Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean } }[]
  >("GET", "/Users");
  if (!r.ok) throw new Error(`Emby answered ${r.status} for its users.`);
  return (r.data ?? [])
    .filter((u) => !u.Policy?.IsDisabled)
    .map((u) => ({
      id: u.Id,
      name: u.Name ?? "A user",
      admin: Boolean(u.Policy?.IsAdministrator),
    }));
}

/** One person's home screen as Emby has it now, with what is needed to write it back. */
export async function readEmbyHome(call: JellyfinCallFn, userId: string) {
  const [sections, views, user] = await Promise.all([
    readSections(call, userId),
    call<{ Items?: { Id: string; Name?: string; CollectionType?: string }[] }>(
      "GET",
      `/Users/${enc(userId)}/Views`,
    ),
    call<{ Configuration?: RawConfig }>("GET", `/Users/${enc(userId)}`),
  ]);
  if (!sections) throw new Error("Emby didn't give that person's home sections.");
  if (!views.ok) throw new Error(`Emby answered ${views.status} for that person's libraries.`);
  if (!user.ok) throw new Error(`Emby answered ${user.status} for that person.`);
  const libraries = (views.data?.Items ?? []).map((v) => ({
    id: v.Id,
    name: v.Name ?? "A library",
    type: v.CollectionType ?? "mixed",
  }));
  const config = user.data?.Configuration ?? {};
  const mediaOff = new Set(config.MyMediaExcludes ?? []);
  const home: EmbyHome = {
    rows: sections.map(rowOf),
    order: libraries.map((l) => l.id),
    media: libraries.filter((l) => !mediaOff.has(l.id)).map((l) => l.id),
  };
  const names: Record<string, string> = {};
  for (const s of sections)
    names[s.Id] =
      s.CustomName || EMBY_SECTIONS[s.SectionType as EmbySectionType] || s.Name || s.SectionType;
  return { home, libraries, sections, names, config };
}

type RawItem = {
  Id: string;
  Name?: string;
  Type?: string;
  SeriesId?: string;
  SeriesName?: string;
  ProductionYear?: number;
};
const poster = (x: RawItem) => ({
  id: x.Type === "Episode" && x.SeriesId ? x.SeriesId : x.Id,
  title: x.Type === "Episode" && x.SeriesName ? x.SeriesName : (x.Name ?? ""),
});
const itemsOf = (r: { ok: boolean; data: unknown }) => {
  if (!r.ok) return [] as RawItem[];
  const d = r.data as RawItem[] | { Items?: RawItem[] };
  return Array.isArray(d) ? d : (d?.Items ?? []);
};

/** A few posters per row: what each row shows this person now (the home screen's own ids). */
async function readPreviews(call: JellyfinCallFn, userId: string) {
  const r = await call<RawSection[]>("GET", SECTIONS(userId));
  const shown = r.ok && Array.isArray(r.data) ? r.data : [];
  const out: Record<string, { id: string; title: string }[]> = {};
  await Promise.all(
    shown
      .filter((s) => s.SectionType !== "userviews")
      .map(async (s) => {
        const items = itemsOf(
          await call("GET", `/Users/${enc(userId)}/Sections/${enc(s.Id)}/Items?Limit=8`).catch(
            () => ({ ok: false, status: 0, data: undefined }),
          ),
        );
        // Latest Media is one block in edit mode and a row per library on the home screen.
        const key = s.SectionType === "latestmedia" && s.ParentId ? `latest:${s.ParentId}` : s.Id;
        out[key] = items.slice(0, 8).map(poster);
      }),
  );
  return out;
}

/** What rows can be built from: collections, playlists, genres and tags this person can see. */
async function readChoices(call: JellyfinCallFn, userId: string) {
  const u = enc(userId);
  const named = (r: { ok: boolean; data: unknown }) =>
    itemsOf(r)
      .map((x) => ({ id: x.Id, name: x.Name ?? x.Id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const [collections, playlists, genres, tags] = await Promise.all(
    [
      `/Users/${u}/Items?IncludeItemTypes=BoxSet&Recursive=true&Limit=500`,
      `/Users/${u}/Items?IncludeItemTypes=Playlist&Recursive=true&Limit=500`,
      `/Genres?UserId=${u}&Recursive=true&IncludeItemTypes=Movie,Series&Limit=500`,
      `/Tags?UserId=${u}&Recursive=true&Limit=500`,
    ].map((p) => call("GET", p).catch(() => ({ ok: false, status: 0, data: undefined }))),
  );
  return {
    collections: named(collections!),
    playlists: named(playlists!),
    genres: named(genres!),
    tags: named(tags!),
  };
}

/** Titles to hand-pick for a row, by name. */
export async function findTitles(call: JellyfinCallFn, userId: string, words: string) {
  const r = await call(
    "GET",
    `/Users/${enc(userId)}/Items?SearchTerm=${enc(words.slice(0, 100))}&IncludeItemTypes=Movie,Series&Recursive=true&Limit=20`,
  );
  return itemsOf(r).map((x) => ({
    id: x.Id,
    title: x.Name ?? "",
    ...(x.ProductionYear ? { year: x.ProductionYear } : {}),
    kind: x.Type === "Series" ? "show" : "movie",
  }));
}

/** The panel's Emby view: the people, one person's home screen, its rows' posters, the choices. */
export async function readEmbyHomeView(
  call: JellyfinCallFn,
  q: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const users = await readUsers(call);
  const who = users.find((u) => u.id === q.id) ?? users.find((u) => u.admin) ?? users[0];
  if (!who) throw new Error("Emby has no one signed up yet.");
  if (q.q) return { found: await findTitles(call, who.id, q.q) };
  const [{ home, libraries, names }, previews, choices] = await Promise.all([
    readEmbyHome(call, who.id),
    readPreviews(call, who.id),
    readChoices(call, who.id),
  ]);
  return {
    kind: "emby",
    users,
    userId: who.id,
    home,
    names,
    libraries,
    sections: Object.entries(EMBY_SECTIONS).map(([id, name]) => ({ id, name })),
    itemTypes: EMBY_ITEM_TYPES,
    sorts: EMBY_SORTS,
    previews,
    ...choices,
  };
}

/** Checks a home screen from the panel or Ember against what the person can see. */
export function checkEmbyHome(raw: unknown, libraryIds: string[], sectionIds: string[]): EmbyHome {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o.rows)) throw new Error("Say which rows the home screen shows.");
  if (o.rows.length > MAX_ROWS) throw new Error(`Up to ${MAX_ROWS} rows on one home screen.`);
  const seen = new Set<string>();
  const rows = o.rows.map((x): EmbyRow => {
    const r = (x ?? {}) as Record<string, unknown>;
    const type = String(r.type ?? "");
    const id = typeof r.id === "string" && sectionIds.includes(r.id) ? r.id : undefined;
    // A section the person has keeps its type, even one this Hearth doesn't know yet.
    if (!id && !isType(type)) throw new Error(`Emby has no home row called ${type || "that"}.`);
    if (id) {
      if (seen.has(id)) throw new Error("Each row goes on the home screen once.");
      seen.add(id);
    }
    const row: EmbyRow = { ...(id ? { id } : {}), type };
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 100) : "";
    if (name) row.name = name;
    if (PARENT_TYPES.has(type)) {
      const titles = list(r.titles).slice(0, 500);
      if (typeof r.parentId === "string" && r.parentId) row.parentId = r.parentId;
      else if (!id && type === "boxset" && titles.length) {
        if (!name) throw new Error("Give a row of hand-picked titles a name.");
        row.titles = titles;
      } else
        throw new Error(
          `Say which ${type === "playlist" ? "playlist" : "collection"} the row shows.`,
        );
    }
    if (EXCLUDE_TYPES.has(type)) {
      const ex = list(r.excluded);
      const bad = ex.find((e) => !libraryIds.includes(e));
      if (bad) throw new Error(`That person has no library ${bad}.`);
      if (ex.length) row.excluded = ex;
    }
    if (type === "items") {
      const it = list(r.itemTypes);
      const bad = it.find((t) => !(EMBY_ITEM_TYPES as readonly string[]).includes(t));
      if (bad) throw new Error(`A filtered row can't hold ${bad}.`);
      if (!it.length) throw new Error("Say what kind of titles the filtered row holds.");
      row.itemTypes = it;
      const g = list(r.genreIds);
      const t = list(r.tagIds);
      if (g.length) row.genreIds = g;
      if (t.length) row.tagIds = t;
      if (r.unwatched === true) row.unwatched = true;
      if (r.favorites === true) row.favorites = true;
    }
    if (typeof r.sortBy === "string" && r.sortBy) {
      if (!(EMBY_SORTS as readonly string[]).includes(r.sortBy) && !id)
        throw new Error(`Emby can't sort a row by ${r.sortBy}.`);
      row.sortBy = r.sortBy;
    }
    if (r.sortOrder === "Ascending" || r.sortOrder === "Descending") row.sortOrder = r.sortOrder;
    return row;
  });
  const ids = (v: unknown, what: string) => {
    if (!Array.isArray(v)) throw new Error(`Say which libraries ${what}.`);
    const out = [...new Set(v.map(String))];
    const bad = out.find((x) => !libraryIds.includes(x));
    if (bad) throw new Error(`That person has no library ${bad}.`);
    return out;
  };
  const order = ids(o.order ?? [], "go in what order");
  for (const id of libraryIds) if (!order.includes(id)) order.push(id);
  return { rows, order, media: ids(o.media ?? libraryIds, "show in My Media") };
}

const sameList = (a: string[], b: string[]) => a.join("\n") === b.join("\n");
const sameSet = (a: string[], b: string[]) => sameList(sorted(a), sorted(b));

/** The row names, top to bottom, for the approval. */
function rowWords(rows: EmbyRow[], names: Record<string, string>) {
  return (
    rows
      .map(
        (r) =>
          r.name || (r.id && names[r.id]) || EMBY_SECTIONS[r.type as EmbySectionType] || r.type,
      )
      .join(", ") || "nothing"
  );
}

/** Whether a person's home screen is the same as another, rows and their order included. */
export function sameEmbyHome(a: EmbyHome, b: EmbyHome) {
  return (
    sameList(a.rows.map(rowKey), b.rows.map(rowKey)) &&
    sameList(a.order, b.order) &&
    sameSet(a.media, b.media)
  );
}

function differences(
  who: string,
  before: EmbyHome,
  after: EmbyHome,
  libs: { id: string; name: string }[],
  names: Record<string, string>,
) {
  const out: { name: string; before: string; after: string }[] = [];
  const named = (ids: string[]) =>
    ids.map((id) => libs.find((l) => l.id === id)?.name ?? id).join(", ") || "none";
  if (!sameList(before.rows.map(rowKey), after.rows.map(rowKey)))
    out.push({
      name: `${who}: home rows`,
      before: rowWords(before.rows, names),
      after: rowWords(after.rows, names),
    });
  const changed = after.rows.filter((r) => {
    const was = r.id && before.rows.find((b) => b.id === r.id);
    return was && rowKey(was) !== rowKey(r);
  });
  for (const r of changed)
    out.push({ name: `${who}: ${names[r.id!] ?? r.type}`, before: "as it was", after: "changed" });
  const made = after.rows.filter((r) => r.titles?.length);
  for (const r of made)
    out.push({
      name: `${who}: new collection`,
      before: "none",
      after: `${r.name} (${r.titles!.length} ${r.titles!.length === 1 ? "title" : "titles"})`,
    });
  if (!sameList(before.order, after.order))
    out.push({
      name: `${who}: library order`,
      before: named(before.order),
      after: named(after.order),
    });
  if (!sameSet(before.media, after.media))
    out.push({
      name: `${who}: in My Media`,
      before: named(before.order.filter((x) => before.media.includes(x))),
      after: named(after.order.filter((x) => after.media.includes(x))),
    });
  return out;
}

/**
 * Plans the home-screen op for Emby: params.homes, JSON of person id to their new home screen.
 * Keeps each one's home screen now in params.before, so the panel can put it back.
 */
export async function planEmbyHome(
  call: JellyfinCallFn,
  service: { name: string },
  wanted: Record<string, unknown>,
  base: PlannedStep,
): Promise<PlannedStep> {
  const ids = Object.keys(wanted);
  const users = await readUsers(call);
  const homes: Record<string, EmbyHome> = {};
  const before: Record<string, EmbyHome> = {};
  const rows: { name: string; before: string; after: string }[] = [];
  for (const id of ids) {
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error(`${service.name} has no one with the id ${id}.`);
    const now = await readEmbyHome(call, id);
    const next = checkEmbyHome(
      wanted[id],
      now.libraries.map((l) => l.id),
      now.sections.map((s) => s.Id),
    );
    if (sameEmbyHome(now.home, next) && !next.rows.some((r) => r.titles)) continue;
    homes[id] = next;
    before[id] = now.home;
    rows.push(...differences(u.name, now.home, next, now.libraries, now.names));
  }
  if (!Object.keys(homes).length)
    throw new Error("Nothing to change: that is the home screen already.");
  const names = users.filter((u) => homes[u.id]).map((u) => u.name);
  const label =
    names.length === 1
      ? `Change ${names[0]}'s home screen in ${service.name}`
      : `Change the home screen for ${names.length} people in ${service.name} (${names.join(", ")})`;
  return {
    ...base,
    label,
    serviceName: service.name,
    params: {
      op: "home-screen",
      homes: JSON.stringify(homes),
      before: JSON.stringify(before),
      name: names.join(", "),
    },
    change: { summary: label, settings: rows },
  };
}

/** Writes one person's home screen into Emby: removes, changes, adds, then puts rows in order. */
async function writeEmbyHome(
  call: JellyfinCallFn,
  userId: string,
  next: EmbyHome,
  made: Map<string, string>,
): Promise<{ refused: string } | { rows: EmbyRow[] }> {
  const now = await readEmbyHome(call, userId);
  const have = new Map(now.sections.map((s) => [s.Id, s]));
  // A row sent without an id that the person already has, the same (Continue Watching, say, or
  // the same collection), keeps theirs: nothing removed and added again.
  const claimed = new Set<string>();
  const wanted = next.rows.map((r0) => {
    const r = { ...r0 };
    if (r.id && have.has(r.id) && !claimed.has(r.id)) claimed.add(r.id);
    else delete r.id;
    return r;
  });
  for (const r of wanted) {
    if (r.id || r.titles) continue;
    const match = now.sections.find((s) => !claimed.has(s.Id) && rowKey(rowOf(s)) === rowKey(r));
    if (match) {
      r.id = match.Id;
      claimed.add(match.Id);
    }
  }
  const remove = async (ids: string[]) => {
    if (!ids.length) return undefined;
    const d = await call("POST", `${SECTIONS(userId)}/Delete`, { Ids: ids });
    return d.ok ? undefined : { refused: `refused to remove rows (${d.status})` };
  };
  const goneIds = now.sections.filter((s) => !claimed.has(s.Id)).map((s) => s.Id);
  // Emby ignores removing a row from a home screen never changed (its defaults aren't saved
  // yet): saving one of the person's own rows as it is saves them all first.
  const first = now.sections[0];
  if (goneIds.length && first) {
    const k = await call("POST", SECTIONS(userId), rawOf(rowOf(first), first));
    if (!k.ok) return { refused: `refused to keep a row (${k.status})` };
  }
  const gone = await remove(goneIds);
  if (gone) return gone;
  const finalIds: string[] = [];
  const saved: EmbyRow[] = [];
  let known = new Set(((await readSections(call, userId)) ?? []).map((s) => s.Id));
  for (const r of wanted) {
    const was = r.id ? have.get(r.id) : undefined;
    if (was) {
      if (rowKey(rowOf(was)) !== rowKey(r)) {
        const u = await call("POST", SECTIONS(userId), rawOf(r, was));
        if (!u.ok) return { refused: `refused to change a row (${u.status})` };
      }
      finalIds.push(was.Id);
      saved.push(r);
      continue;
    }
    if (r.titles?.length) {
      // The same hand-picked row for several people is one collection.
      const key = `${r.name}
${r.titles.join(",")}`;
      let parent = made.get(key);
      if (!parent) {
        const c = await call<{ Id?: string }>(
          "POST",
          `/Collections?Name=${enc(r.name ?? "Hearth row")}&Ids=${r.titles.map(enc).join(",")}`,
        );
        if (!c.ok || !c.data?.Id)
          return { refused: `refused to make the collection ${r.name} (${c.status})` };
        parent = c.data.Id;
        made.set(key, parent);
      }
      r.parentId = parent;
      delete r.titles;
    }
    const a = await call("POST", SECTIONS(userId), rawOf(r));
    if (!a.ok) return { refused: `refused to add a row (${a.status})` };
    const after = (await readSections(call, userId)) ?? [];
    // A person who never changed their home has Emby's defaults unsaved: the first row added
    // saves them too, so the new row is the new section that is this row.
    const added = after.find((x) => !known.has(x.Id) && rowKey(rowOf(x)) === rowKey(r));
    if (!added) return { refused: "added a row Hearth can't find again" };
    known = new Set(after.map((x) => x.Id));
    finalIds.push(added.Id);
    saved.push(r);
  }
  // Anything left that isn't one of the rows (defaults Emby saved on the first add) goes.
  const left = ((await readSections(call, userId)) ?? []).filter((x) => !finalIds.includes(x.Id));
  const tidy = await remove(left.map((x) => x.Id));
  if (tidy) return tidy;
  // Put the rows in order, one move per row out of place.
  let cur = ((await readSections(call, userId)) ?? []).map((x) => x.Id);
  for (let i = 0; i < finalIds.length; i++) {
    const id = finalIds[i]!;
    if (cur[i] === id) continue;
    const m = await call("POST", `${SECTIONS(userId)}/Move`, { Ids: [id], NewIndex: i });
    if (!m.ok) return { refused: `refused to move a row (${m.status})` };
    cur = cur.filter((x) => x !== id);
    cur.splice(i, 0, id);
  }
  // Library order and My Media, as Jellyfin keeps them.
  const libIds = now.libraries.map((l) => l.id);
  if (!sameList(now.home.order, next.order) || !sameSet(now.home.media, next.media)) {
    const keepOff = (now.config.MyMediaExcludes ?? []).filter((x) => !libIds.includes(x));
    const config: RawConfig = {
      ...now.config,
      OrderedViews: [
        ...next.order.filter((x) => libIds.includes(x)),
        ...libIds.filter((x) => !next.order.includes(x)),
      ],
      MyMediaExcludes: [...keepOff, ...libIds.filter((x) => !next.media.includes(x))],
    };
    let c = await call("POST", `/Users/${enc(userId)}/Configuration`, config);
    if (c.status === 404)
      c = await call("POST", `/Users/Configuration?userId=${enc(userId)}`, config);
    if (!c.ok) return { refused: `refused the library settings (${c.status})` };
  }
  return { rows: saved };
}

/** Runs the home-screen op for Emby, then reads every person's home screen back. */
export async function runEmbyHome(
  call: JellyfinCallFn,
  service: { name: string },
  homes: Record<string, EmbyHome>,
  names: string,
): Promise<StepOutcome> {
  const users = await readUsers(call);
  const made = new Map<string, string>();
  const off: string[] = [];
  for (const [id, next] of Object.entries(homes)) {
    const who = users.find((u) => u.id === id)?.name;
    if (!who)
      return { ok: false, stale: true, result: `${service.name} no longer has that person.` };
    const w = await writeEmbyHome(call, id, next, made);
    if ("refused" in w) return { ok: false, result: `${service.name} ${w.refused} for ${who}.` };
    const back = (await readEmbyHome(call, id)).home;
    // New rows have new ids: what the rows are, in order, is what is compared.
    const ok = sameEmbyHome(back, { ...next, rows: w.rows });
    if (!ok) off.push(who);
  }
  return off.length
    ? {
        ok: false,
        result: `${service.name} took it, but ${off.join(" and ")}'s home screen does not read back as approved.`,
      }
    : {
        ok: true,
        verified: true,
        result: `${names || "That person"}'s home screen in ${service.name} is set (read back). Apps pick it up when they next open the home screen.`,
      };
}
