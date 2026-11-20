import type { StepParams } from "@dragon-control/core";
import type { PlannedStep, StepOutcome } from "../jobs/operations";
import {
  planEmbyHome,
  readEmbyHomeView,
  readSections,
  runEmbyHome,
  type EmbyHome,
} from "./emby-home";
import { sameGuid, type JellyfinCallFn } from "./jellyfin-manage";

/**
 * Home rows for Jellyfin (11-08: "start building out Jellyfin home rows"). Jellyfin has no rows
 * of its own making: each person's home screen is a list of Jellyfin's own sections (My Media,
 * Continue Watching, Next Up, Recently Added...), the order of their libraries, and which
 * libraries get a "Recently Added" row. All three are per person and live in Jellyfin; Hearth
 * reads them, shows them as rows with posters, and changes them as one plan the owner approves,
 * read back after. Collection rows need the Home Screen Sections plugin: Hearth says when it is
 * there, and builds those next.
 */

/** Jellyfin's home sections, in the words its own settings use. */
export const JELLYFIN_SECTIONS = {
  smalllibrarytiles: "My Media",
  librarybuttons: "My Media (small)",
  resume: "Continue Watching",
  resumeaudio: "Continue Listening",
  resumebook: "Continue Reading",
  nextup: "Next Up",
  latestmedia: "Recently Added",
  activerecordings: "Active Recordings",
  livetv: "Live TV",
} as const;
export type JellyfinSection = keyof typeof JELLYFIN_SECTIONS;
const isSection = (s: string): s is JellyfinSection => s in JELLYFIN_SECTIONS;

/** How many sections Jellyfin's home screen holds (homesection0 to homesection9). */
export const SECTION_SLOTS = 10;

/**
 * What a slot shows when the person never chose one: Jellyfin web's defaults, slot by slot
 * (checked in Jellyfin web's own code on the home server, 11-08; slots 7 to 9 are empty).
 */
const DEFAULT_SECTIONS: string[] = [
  "smalllibrarytiles",
  "resume",
  "resumeaudio",
  "resumebook",
  "livetv",
  "nextup",
  "latestmedia",
];

/** One person's home screen, as Hearth shows and sends it. */
export interface JellyfinHome {
  /** Sections top to bottom (no empty ones). */
  sections: JellyfinSection[];
  /** Every library the person can see, in their order. */
  order: string[];
  /** Libraries with their own "Recently Added" row. */
  latest: string[];
  /** Libraries shown in My Media. */
  media: string[];
  /** Watched titles left out of Recently Added. */
  hideWatched: boolean;
}

interface RawView {
  Id: string;
  Name?: string;
  CollectionType?: string;
}
interface RawPrefs {
  CustomPrefs?: Record<string, string | null>;
  [k: string]: unknown;
}
interface RawConfig {
  OrderedViews?: string[];
  LatestItemsExcludes?: string[];
  MyMediaExcludes?: string[];
  HidePlayedInLatest?: boolean;
  [k: string]: unknown;
}

const enc = encodeURIComponent;
const PREFS = (user: string) => `/DisplayPreferences/usersettings?userId=${enc(user)}&client=emby`;

/** Jellyfin 10.9 moved these; older servers answer the old address. */
async function getEither<T>(call: JellyfinCallFn, now: string, old: string) {
  const r = await call<T>("GET", now);
  return r.status === 404 ? call<T>("GET", old) : r;
}

async function readUsers(call: JellyfinCallFn) {
  const r = await call<
    { Id: string; Name?: string; Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean } }[]
  >("GET", "/Users");
  if (!r.ok) throw new Error(`Jellyfin answered ${r.status} for its users.`);
  return (r.data ?? [])
    .filter((u) => !u.Policy?.IsDisabled)
    .map((u) => ({
      id: u.Id,
      name: u.Name ?? "A user",
      admin: Boolean(u.Policy?.IsAdministrator),
    }));
}

/** One person's home screen as Jellyfin has it now, with what is needed to write it back. */
export async function readHome(call: JellyfinCallFn, userId: string) {
  const [views, prefs, user] = await Promise.all([
    getEither<{ Items?: RawView[] }>(
      call,
      `/UserViews?userId=${enc(userId)}`,
      `/Users/${enc(userId)}/Views`,
    ),
    call<RawPrefs>("GET", PREFS(userId)),
    call<{ Configuration?: RawConfig }>("GET", `/Users/${enc(userId)}`),
  ]);
  if (!views.ok) throw new Error(`Jellyfin answered ${views.status} for that person's libraries.`);
  if (!prefs.ok)
    throw new Error(`Jellyfin answered ${prefs.status} for that person's home screen.`);
  if (!user.ok) throw new Error(`Jellyfin answered ${user.status} for that person.`);
  // Live TV and other views without a library type are not libraries a person orders here.
  const libraries = (views.data?.Items ?? []).map((v) => ({
    id: v.Id,
    name: v.Name ?? "A library",
    type: v.CollectionType ?? "mixed",
  }));
  const custom = prefs.data?.CustomPrefs ?? {};
  const sections: JellyfinSection[] = [];
  for (let i = 0; i < SECTION_SLOTS; i++) {
    let s = custom[`homesection${i}`] || DEFAULT_SECTIONS[i] || "none";
    // An old name Jellyfin web still reads as slot 0's default.
    if (s === "folders") s = DEFAULT_SECTIONS[0]!;
    if (isSection(s)) sections.push(s);
  }
  const config = user.data?.Configuration ?? {};
  const latestOff = new Set(config.LatestItemsExcludes ?? []);
  const mediaOff = new Set(config.MyMediaExcludes ?? []);
  const home: JellyfinHome = {
    sections,
    // UserViews already come in the person's order.
    order: libraries.map((l) => l.id),
    latest: libraries.filter((l) => !latestOff.has(l.id)).map((l) => l.id),
    media: libraries.filter((l) => !mediaOff.has(l.id)).map((l) => l.id),
    hideWatched: config.HidePlayedInLatest !== false,
  };
  return { home, libraries, prefs: prefs.data ?? {}, config };
}

interface Poster {
  id: string;
  title: string;
}
type RawItem = {
  Id: string;
  Name?: string;
  Type?: string;
  SeriesId?: string;
  SeriesName?: string;
  ImageTags?: { Primary?: string };
};
/** An episode shows its show's poster, as Jellyfin's rows do. */
const poster = (x: RawItem): Poster => ({
  id: x.Type === "Episode" && x.SeriesId ? x.SeriesId : x.Id,
  title: x.Type === "Episode" && x.SeriesName ? x.SeriesName : (x.Name ?? ""),
});

/** What each row would show this person right now: a few posters per row. */
async function readPreviews(
  call: JellyfinCallFn,
  userId: string,
  libraries: { id: string }[],
  home: JellyfinHome,
): Promise<Record<string, Poster[]>> {
  const u = enc(userId);
  const out: Record<string, Poster[]> = {};
  const list = (r: { ok: boolean; data: unknown }) => {
    if (!r.ok) return [];
    const d = r.data as RawItem[] | { Items?: RawItem[] };
    return (Array.isArray(d) ? d : (d?.Items ?? [])).slice(0, 8).map(poster);
  };
  const jobs: Promise<void>[] = [];
  if (home.sections.includes("resume"))
    jobs.push(
      getEither(
        call,
        `/UserItems/Resume?userId=${u}&limit=8&mediaTypes=Video`,
        `/Users/${u}/Items/Resume?limit=8&mediaTypes=Video`,
      ).then((r) => void (out.resume = list(r))),
    );
  if (home.sections.includes("nextup"))
    jobs.push(
      call("GET", `/Shows/NextUp?userId=${u}&limit=8`).then((r) => void (out.nextup = list(r))),
    );
  // Every library, so turning one's Recently Added row on shows its posters straight away.
  for (const l of libraries)
    jobs.push(
      getEither(
        call,
        `/Items/Latest?userId=${u}&parentId=${enc(l.id)}&limit=8`,
        `/Users/${u}/Items/Latest?parentId=${enc(l.id)}&limit=8`,
      ).then((r) => void (out[`latest:${l.id}`] = list(r))),
    );
  await Promise.all(jobs.map((j) => j.catch(() => undefined)));
  return out;
}

/** Home Screen Sections, by its plugin id. */
const HSS_ID = "b8298e01-2697-407a-b44d-aa8dc795e850";

/**
 * Whether Home Screen Sections is switched on: then it draws the home screen instead of
 * Jellyfin's own sections, so the sections set here don't show. Its settings also hold other
 * apps' keys: only its Enabled switch is read, and nothing else leaves this function.
 */
async function hssOn(call: JellyfinCallFn, id: string): Promise<boolean> {
  const r = await call<{ Enabled?: unknown }>("GET", `/Plugins/${enc(id)}/Configuration`).catch(
    () => undefined,
  );
  return r?.ok ? r.data?.Enabled === true : false;
}

/** The panel's Jellyfin view: the people, one person's home screen, and what its rows show. */
export async function readHomeView(
  call: JellyfinCallFn,
  q: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const users = await readUsers(call);
  const who = users.find((u) => u.id === q.id) ?? users.find((u) => u.admin) ?? users[0];
  if (!who) throw new Error("Jellyfin has no one signed up yet.");
  // Emby 4.8 and later keep home rows of their own on the server (emby-home.ts).
  if (await readSections(call, who.id)) return readEmbyHomeView(call, { ...q, id: who.id });
  const [{ home, libraries }, plugins] = await Promise.all([
    readHome(call, who.id),
    call<{ Id?: string; Name?: string; Status?: string }[]>("GET", "/Plugins").catch(
      () => undefined,
    ),
  ]);
  const previews = await readPreviews(call, who.id, libraries, home);
  // Home Screen Sections (a community plugin) adds rows of collections and more.
  const sectionsPlugin = (plugins?.ok ? (plugins.data ?? []) : []).find(
    (p) => sameGuid(p.Id, HSS_ID) || /home\s*screen\s*sections/i.test(p.Name ?? ""),
  );
  const active = Boolean(sectionsPlugin && sectionsPlugin.Status !== "Disabled");
  const replacesHome = active && sectionsPlugin?.Id ? await hssOn(call, sectionsPlugin.Id) : false;
  return {
    users,
    userId: who.id,
    home,
    libraries,
    sections: Object.entries(JELLYFIN_SECTIONS).map(([id, name]) => ({ id, name })),
    slots: SECTION_SLOTS,
    previews,
    plugin: sectionsPlugin ? { name: sectionsPlugin.Name, active, replacesHome } : null,
  };
}

/** Checks a home screen from the panel or Ember against what the person can see. */
export function checkHome(raw: unknown, libraryIds: string[]): JellyfinHome {
  const o = (raw ?? {}) as Record<string, unknown>;
  const ids = (v: unknown, what: string) => {
    if (!Array.isArray(v)) throw new Error(`Say which libraries ${what}.`);
    const out = [...new Set(v.map(String))];
    const unknown = out.find((x) => !libraryIds.includes(x));
    if (unknown) throw new Error(`That person has no library ${unknown}.`);
    return out;
  };
  if (!Array.isArray(o.sections)) throw new Error("Say which sections the home screen shows.");
  const sections = o.sections.map(String).filter((s) => s !== "none");
  const bad = sections.find((s) => !isSection(s));
  if (bad) throw new Error(`Jellyfin has no home section called ${bad}.`);
  if (new Set(sections).size !== sections.length)
    throw new Error("Each section goes on the home screen once.");
  if (sections.length > SECTION_SLOTS)
    throw new Error(`Jellyfin's home screen holds up to ${SECTION_SLOTS} sections.`);
  const order = ids(o.order ?? [], "go in what order");
  // Libraries left out of the order keep their place after the ones named.
  for (const id of libraryIds) if (!order.includes(id)) order.push(id);
  return {
    sections: sections as JellyfinSection[],
    order,
    latest: ids(o.latest ?? [], "get a Recently Added row"),
    media: ids(o.media ?? libraryIds, "show in My Media"),
    hideWatched: o.hideWatched !== false,
  };
}

const sameList = (a: string[], b: string[]) => a.join("\n") === b.join("\n");
const sameSet = (a: string[], b: string[]) => sameList([...a].sort(), [...b].sort());
const named = (ids: string[], libs: { id: string; name: string }[]) =>
  ids.map((id) => libs.find((l) => l.id === id)?.name ?? id).join(", ") || "none";
const sectionWords = (s: JellyfinSection[]) =>
  s.map((x) => JELLYFIN_SECTIONS[x]).join(", ") || "nothing";

/** The before and after of one person's home screen, in words, for the approval. */
function differences(
  who: string,
  before: JellyfinHome,
  after: JellyfinHome,
  libs: { id: string; name: string }[],
) {
  const rows: { name: string; before: string; after: string }[] = [];
  if (!sameList(before.sections, after.sections))
    rows.push({
      name: `${who}: home sections`,
      before: sectionWords(before.sections),
      after: sectionWords(after.sections),
    });
  if (!sameList(before.order, after.order))
    rows.push({
      name: `${who}: library order`,
      before: named(before.order, libs),
      after: named(after.order, libs),
    });
  if (!sameSet(before.latest, after.latest))
    rows.push({
      name: `${who}: Recently Added rows`,
      before: named(
        before.order.filter((x) => before.latest.includes(x)),
        libs,
      ),
      after: named(
        after.order.filter((x) => after.latest.includes(x)),
        libs,
      ),
    });
  if (!sameSet(before.media, after.media))
    rows.push({
      name: `${who}: in My Media`,
      before: named(
        before.order.filter((x) => before.media.includes(x)),
        libs,
      ),
      after: named(
        after.order.filter((x) => after.media.includes(x)),
        libs,
      ),
    });
  if (before.hideWatched !== after.hideWatched)
    rows.push({
      name: `${who}: watched titles in Recently Added`,
      before: before.hideWatched ? "Hidden" : "Shown",
      after: after.hideWatched ? "Hidden" : "Shown",
    });
  return rows;
}

/**
 * Plans the home-screen op: params.homes, JSON of person id to their new home screen. Reads each
 * person's home screen now, so the approval shows exactly what changes, and keeps it in
 * params.before so the panel can put it back.
 */
export async function planHome(
  call: JellyfinCallFn,
  service: { name: string },
  params: StepParams,
  base: PlannedStep,
): Promise<PlannedStep> {
  let wanted: Record<string, unknown>;
  try {
    wanted = JSON.parse(String(params.homes ?? "")) as Record<string, unknown>;
  } catch {
    throw new Error("Say whose home screen changes, and how.");
  }
  const ids = Object.keys(wanted ?? {});
  if (!ids.length) throw new Error("Say whose home screen changes.");
  if (ids.length > 50) throw new Error("Up to 50 people at a time.");
  if (await readSections(call, ids[0]!)) return planEmbyHome(call, service, wanted, base);
  const users = await readUsers(call);
  const homes: Record<string, JellyfinHome> = {};
  const before: Record<string, JellyfinHome> = {};
  const rows: { name: string; before: string; after: string }[] = [];
  for (const id of ids) {
    const u = users.find((x) => x.id === id);
    if (!u) throw new Error(`${service.name} has no one with the id ${id}.`);
    const now = await readHome(call, id);
    const next = checkHome(
      wanted[id],
      now.libraries.map((l) => l.id),
    );
    const diff = differences(u.name, now.home, next, now.libraries);
    if (!diff.length) continue;
    homes[id] = next;
    before[id] = now.home;
    rows.push(...diff);
  }
  if (!rows.length) throw new Error("Nothing to change: that is the home screen already.");
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

/** Writes one person's home screen into Jellyfin, keeping everything else as it is. */
async function writeHome(call: JellyfinCallFn, userId: string, next: JellyfinHome) {
  const now = await readHome(call, userId);
  const custom: Record<string, string | null> = { ...(now.prefs.CustomPrefs ?? {}) };
  for (let i = 0; i < SECTION_SLOTS; i++) custom[`homesection${i}`] = next.sections[i] ?? "none";
  const p = await call<unknown>("POST", PREFS(userId), { ...now.prefs, CustomPrefs: custom });
  if (!p.ok) return `refused the home sections (${p.status})`;
  const ids = now.libraries.map((l) => l.id);
  const order = [
    ...next.order.filter((x) => ids.includes(x)),
    ...ids.filter((x) => !next.order.includes(x)),
  ];
  // Libraries this person can't see keep whatever Jellyfin had for them.
  const keepOff = (list: string[] | undefined) => (list ?? []).filter((x) => !ids.includes(x));
  const config: RawConfig = {
    ...now.config,
    OrderedViews: order,
    LatestItemsExcludes: [
      ...keepOff(now.config.LatestItemsExcludes),
      ...ids.filter((x) => !next.latest.includes(x)),
    ],
    MyMediaExcludes: [
      ...keepOff(now.config.MyMediaExcludes),
      ...ids.filter((x) => !next.media.includes(x)),
    ],
    HidePlayedInLatest: next.hideWatched,
  };
  let c = await call<unknown>("POST", `/Users/Configuration?userId=${enc(userId)}`, config);
  if (c.status === 404)
    c = await call<unknown>("POST", `/Users/${enc(userId)}/Configuration`, config);
  if (!c.ok) return `refused the library settings (${c.status})`;
  return undefined;
}

/** Runs the home-screen op, then reads every person's home screen back. */
export async function runHome(
  call: JellyfinCallFn,
  service: { name: string },
  p: StepParams,
): Promise<StepOutcome> {
  let homes: Record<string, JellyfinHome>;
  try {
    homes = JSON.parse(String(p.homes ?? "{}")) as Record<string, JellyfinHome>;
  } catch {
    return { ok: false, result: "The approved home screen is not readable." };
  }
  // Emby's home screens are rows (emby-home.ts); Jellyfin's are sections in slots.
  if (Object.values(homes).some((h) => Array.isArray((h as unknown as EmbyHome).rows)))
    return runEmbyHome(
      call,
      service,
      homes as unknown as Record<string, EmbyHome>,
      String(p.name || ""),
    );
  const users = await readUsers(call);
  const off: string[] = [];
  for (const [id, next] of Object.entries(homes)) {
    const who = users.find((u) => u.id === id)?.name;
    if (!who)
      return { ok: false, stale: true, result: `${service.name} no longer has that person.` };
    const refused = await writeHome(call, id, next);
    if (refused) return { ok: false, result: `${service.name} ${refused} for ${who}.` };
    const back = (await readHome(call, id)).home;
    const ok =
      sameList(back.sections, next.sections) &&
      sameList(back.order, next.order) &&
      sameSet(back.latest, next.latest) &&
      sameSet(back.media, next.media) &&
      back.hideWatched === next.hideWatched;
    if (!ok) off.push(who);
  }
  const names = String(p.name || "that person");
  return off.length
    ? {
        ok: false,
        result: `${service.name} took it, but ${off.join(" and ")}'s home screen does not read back as approved.`,
      }
    : {
        ok: true,
        verified: true,
        result: `${names}'s home screen in ${service.name} is set (read back). Apps pick it up when they next open the home screen.`,
      };
}
