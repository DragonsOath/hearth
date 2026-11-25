import { coverLink } from "../apps/chaptarr-cover";
import {
  RECOMMEND_KIND_NAMES,
  RECOMMEND_REACTIONS,
  type RecommendFilters,
  type RecommendRating,
  type RecommendItem,
  type RecommendRequest,
  type RecommendResult,
  type RecommendSeen,
  type RecommendSeenResult,
  type RecommendWatchStep,
} from "@dragon-control/core";
import type { Call } from "../apps/release-search";

/**
 * Recommend, Discover (checklist 48.1). Ember suggests titles for what you're in the
 * mood for; Hearth then checks every one against the real catalogue, so a title the AI made up is
 * dropped rather than shown, and against your library, so what you already have is hidden (and
 * counted, never silently). What's left can be requested: movies and shows through Seerr, music
 * through Lidarr (a plan you approve, like every change), books and audiobooks on Chaptarr's own
 * add page. Ember sees only what you typed and your filters: nothing from your library or history.
 */

/** One title as Ember suggests it, before it is checked. */
export interface Suggestion {
  title: string;
  year?: number;
  creator?: string;
  why: string;
  /** Think outside the box: a nearby pick, not squarely what was asked. */
  adjacent?: boolean;
}

/** A Seerr search hit (apps.seerrPanel "search"). */
export interface SeerrHit {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  poster?: string;
  status: string;
}

export interface RecommendDeps {
  /** Asks Ember (no tools, read only) and returns its text. */
  ask: (system: string, prompt: string) => Promise<string>;
  /** Connected apps by kind, the first one that isn't removed. */
  service: (
    app: "seerr" | "lidarr" | "chaptarr",
  ) => Promise<{ id: string; name: string } | undefined>;
  seerrSearch: (serviceId: string, query: string) => Promise<SeerrHit[]>;
  /** Lidarr and Chaptarr through their own API (the key stays in the vault). */
  arr: <T>(
    serviceId: string,
    purpose: string,
    fn: (call: Call, web: string) => Promise<T>,
  ) => Promise<T>;
  /** Titles you said you've seen, kept by Hearth (they survive a rebuilt Plex). */
  seen: {
    list: () => Promise<(RecommendSeen & { at: string })[]>;
    save: (all: (RecommendSeen & { at: string })[]) => Promise<void>;
  };
  /**
   * Your library's titles of a kind, for "In my library" (names, years, genres; nothing about
   * who watched what). Optional: without it that choice says it can't.
   */
  library?: (kind: RecommendRequest["kind"]) => Promise<LibraryTitle[]>;
  /** A movie or show on your Plex and Jellyfin servers, searched by title. */
  onServers: (kind: "movie" | "show", title: string) => Promise<ServerHit[]>;
  /**
   * Whether a movie or show is in your Plex or Jellyfin library (11-09: Seerr can be out of
   * date, and said "deleted" for films that are in Plex). Optional: without it, Seerr decides.
   */
  inLibrary?: (kind: "movie" | "show", title: string, year?: number) => Promise<boolean>;
}

/** One title in your library, as "In my library" offers it to Ember. */
export interface LibraryTitle {
  title: string;
  year?: number;
  creator?: string;
  genres?: string[];
  /** A picture through Hearth. */
  image?: string;
}

/** At most this many of your titles go to Ember in one ask (names and years: small). */
const LIBRARY_AT_MOST = 600;

/** A title found on a media server (Plex or Jellyfin library search). */
export interface ServerHit {
  serviceId: string;
  server: string;
  app: "plex" | "jellyfin";
  id: string;
  title: string;
  year?: number;
  watched: boolean;
}

/** A rating as given, trimmed to what it may hold; undefined when nothing was filled in. */
function cleanRating(r?: RecommendRating): RecommendRating | undefined {
  if (!r) return undefined;
  const stars = Number.isInteger(r.stars) && r.stars! >= 1 && r.stars! <= 5 ? r.stars : undefined;
  const reaction = r.reaction && RECOMMEND_REACTIONS.includes(r.reaction) ? r.reaction : undefined;
  const note = r.note?.trim().slice(0, 2000) || undefined;
  if (!stars && !reaction && !note) return undefined;
  return {
    ...(stars ? { stars } : {}),
    ...(reaction ? { reaction } : {}),
    ...(note ? { note } : {}),
  };
}

/** Liked or not, for a server that only keeps a thumbs up or down (Jellyfin). */
function likedOf(r?: RecommendRating): boolean | undefined {
  if (r?.reaction) return r.reaction === "loved" || r.reaction === "ok";
  if (r?.stars) return r.stars >= 3;
  return undefined;
}

/** How many seen titles are kept: plenty for anyone, small enough for one setting. */
const SEEN_KEEP = 3000;

export class RecommendError extends Error {}

/** How many Ember is asked for: more than shown, as some are owned or can't be found. */
const ASK_FOR = 18;
const SHOW_AT_MOST = 12;
/** Completing a niche: the whole set matters more than a short list. */
const NICHE_AT_MOST = 18;

/** Lower case, accents and punctuation folded, "The " dropped: "The Holiday" ~ "holiday". */
export const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");

/** The same title: equal once folded, or one is the other plus a subtitle ("Alien: Romulus"). */
export function sameTitle(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

/** Years agree, allowing one either side (release dates differ by country); unknown agrees. */
export const sameYear = (a?: number, b?: number) => !a || !b || Math.abs(a - b) <= 1;

/** How each mode asks Ember (11-09: Recommend is a place you come for different reasons). */
const MODE_RULES: Record<string, string> = {
  gap: "The person has few or none of these and wants a well-rounded starter set: the most loved, essential titles first, then a few broader picks.",
  niche:
    "This is a niche the person collects. List the strongest titles inside it, the ones a fan would want, including lesser-known gems. Stay strictly inside the niche.",
  expand:
    "The person already likes this and wants to go deeper: well-regarded titles beyond the obvious ones, varied across decades and countries.",
};

/**
 * Think outside the box (the owner, 11-10: "family snow movies as Christmas recommendations, or
 * movies that take place in fall as Thanksgiving movies if they still have that moral family
 * vibe"). Adjacent titles join the ones squarely on theme; each says how it connects.
 */
export const WIDE_RULE =
  'Think outside the box: besides titles squarely about this, include adjacent ones that are not about it directly but share its feel, season, setting, audience and values (for Christmas, warm family films set in snow and winter; for Thanksgiving, family films set in autumn with the same heart). Keep the spirit and audience of what was asked, never just the same keyword. For an adjacent title, "why" says how it connects, and add "adjacent": true to it.';

/**
 * What Ember is told: your words, your filters and the mode. Never your library, except in
 * "In my library", where it gets the names and years of the titles it may choose from.
 */
export function recommendPrompt(
  r: RecommendRequest,
  pickFrom?: string[],
): { system: string; prompt: string } {
  const what = RECOMMEND_KIND_NAMES[r.kind];
  const f: RecommendFilters = r.filters ?? {};
  const rules = [
    f.fromYear || f.toYear
      ? `Released ${f.fromYear ? `from ${f.fromYear}` : ""}${f.fromYear && f.toYear ? " " : ""}${f.toYear ? `up to ${f.toYear}` : ""}.`
      : "",
    f.genres?.length ? `Genres: ${f.genres.join(", ")}.` : "",
    f.minRating ? `Well reviewed: about ${f.minRating}/10 or better.` : "",
    f.length
      ? r.kind === "movie"
        ? { short: "Under 90 minutes.", medium: "90 minutes to 2 hours.", long: "Over 2 hours." }[
            f.length
          ]
        : r.kind === "book" || r.kind === "audiobook"
          ? { short: "Short reads.", medium: "Medium length.", long: "Long books." }[f.length]
          : ""
      : "",
    r.exclude?.length
      ? `Do not suggest any of these again: ${r.exclude.slice(0, 80).join("; ")}.`
      : "",
    r.mode && MODE_RULES[r.mode] ? MODE_RULES[r.mode] : "",
    r.wide ? WIDE_RULE : "",
    pickFrom?.length
      ? `Choose only from these titles, which the person already owns, and use their names exactly as written:\n${pickFrom.join("\n")}`
      : "",
  ].filter(Boolean);
  const creator =
    r.kind === "movie"
      ? "director"
      : r.kind === "show"
        ? "creator or network"
        : r.kind === "music"
          ? "a well-known album of theirs"
          : "author";
  return {
    system: [
      "You are Ember, recommending titles in Hearth. Suggest real, released titles only, the way a friend who knows their stuff would: the best fits first, varied, not only the obvious ones.",
      `Answer with JSON only, no other text: an array of up to ${ASK_FOR} objects {"title": string, "year": number, "creator": string, "why": string}.`,
      r.kind === "music"
        ? '"title" is the artist\'s name; "year" the year they started; "creator" one album of theirs.'
        : `"creator" is the ${creator}.`,
      '"why" is one short sentence in plain words saying why it fits what was asked. Never invent a title, a year or a fact; leave a field out if you are not sure.',
    ].join("\n"),
    prompt: [`Suggest ${what.many.toLowerCase()} for: ${r.interest.trim()}`, ...rules].join("\n"),
  };
}

/** Ember's answer as suggestions: the first JSON array in it, each entry checked. */
export function parseSuggestions(text: string): Suggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 200) : "";
    if (!title || seen.has(fold(title))) continue;
    seen.add(fold(title));
    const year = Number(o.year);
    out.push({
      title,
      ...(Number.isInteger(year) && year > 1800 && year < 2200 ? { year } : {}),
      ...(typeof o.creator === "string" && o.creator.trim()
        ? { creator: o.creator.trim().slice(0, 120) }
        : {}),
      why: typeof o.why === "string" ? o.why.trim().slice(0, 300) : "",
      ...(o.adjacent === true ? { adjacent: true } : {}),
    });
  }
  return out.slice(0, ASK_FOR);
}

/** Runs a few at a time: catalogue lookups are slow, and an app shouldn't get 18 at once. */
async function eachLimited<T, R>(list: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]!);
      }
    }),
  );
  return out;
}

type Checked =
  | { found: false; title: string }
  | { found: true; owned: true; title: string; year?: number; item: RecommendItem }
  | { found: true; owned: false; item: RecommendItem };

const sameSeen = (a: RecommendSeen, b: { kind: string; title: string; year?: number }) =>
  a.kind === b.kind && sameTitle(a.title, b.title) && sameYear(a.year, b.year);

export class Recommend {
  constructor(private readonly d: RecommendDeps) {}

  async find(r: RecommendRequest): Promise<RecommendResult> {
    const interest = r.interest.trim();
    if (interest.length < 2) throw new RecommendError("Say what you're in the mood for.");
    const app =
      r.kind === "music"
        ? "lidarr"
        : r.kind === "book" || r.kind === "audiobook"
          ? "chaptarr"
          : "seerr";
    const service = await this.d.service(app);
    const appName = { seerr: "Seerr", lidarr: "Lidarr", chaptarr: "Chaptarr" }[app];
    if (!service)
      return {
        kind: r.kind,
        items: [],
        owned: [],
        unverified: [],
        missingApp: `Recommending ${RECOMMEND_KIND_NAMES[r.kind].many.toLowerCase()} needs ${appName} connected to Hearth: it is how Hearth checks a title is real, whether you have it, and requests it.`,
      };
    const seen = (await this.d.seen.list().catch(() => [])).filter((s) => s.kind === r.kind);
    if (r.show === "have") return this.fromLibrary({ ...r, interest }, seen, service.id);
    const { system, prompt } = recommendPrompt({
      ...r,
      interest,
      // What you've seen is never suggested again (the most recent, if there are many).
      exclude: [...(r.exclude ?? []), ...seen.slice(-120).map((s) => s.title)],
    });
    const suggestions = parseSuggestions(await this.d.ask(system, prompt));
    if (!suggestions.length)
      throw new RecommendError(
        "Ember didn't come back with a list this time. Try again, or put it another way.",
      );
    const profiles: { id: number; name: string }[] = [];
    const checked =
      app === "seerr"
        ? await this.checkSeerr(service.id, r.kind === "show" ? "tv" : "movie", suggestions)
        : app === "lidarr"
          ? await this.checkLidarr(service.id, service.name, suggestions, profiles)
          : await this.checkChaptarr(
              service.id,
              r.kind === "audiobook" ? "audiobook" : "ebook",
              suggestions,
            );
    const items: RecommendItem[] = [];
    const owned: { title: string; year?: number }[] = [];
    const unverified: string[] = [];
    const both = r.show === "both";
    for (const c of checked) {
      if (!c.found) unverified.push(c.title);
      else if (seen.some((s) => sameSeen(s, c.item))) continue;
      else if (c.owned && !both)
        owned.push({ title: c.title, ...(c.year ? { year: c.year } : {}) });
      else if (!items.some((x) => x.key === c.item.key)) {
        // Only a "Think outside the box" answer has nearby picks.
        if (!r.wide) delete c.item.outside;
        items.push(c.item);
      }
    }
    return {
      kind: r.kind,
      items: items.slice(0, r.mode === "niche" ? NICHE_AT_MOST : SHOW_AT_MOST),
      owned,
      unverified,
      ...(profiles.length ? { qualityProfiles: profiles } : {}),
    };
  }

  /**
   * "In my library": Ember picks from what you own. Hearth narrows your titles by the filters it
   * can check here (years, genres), sends their names and years only, and keeps only answers
   * that match a title you have (anything else is listed as not found, never shown).
   */
  private async fromLibrary(
    r: RecommendRequest,
    seen: RecommendSeen[],
    seerrId?: string,
  ): Promise<RecommendResult> {
    const none = (note: string): RecommendResult => ({
      kind: r.kind,
      items: [],
      owned: [],
      unverified: [],
      note,
    });
    if (!this.d.library) return none("Hearth can't read your library for this yet.");
    const all = await this.d.library(r.kind).catch(() => [] as LibraryTitle[]);
    if (!all.length)
      return none(
        `Hearth found no ${RECOMMEND_KIND_NAMES[r.kind].many.toLowerCase()} in your library to choose from.`,
      );
    const f = r.filters ?? {};
    const genres = (f.genres ?? []).map((g) => fold(g));
    let list = all.filter(
      (t) =>
        (!f.fromYear || !t.year || t.year >= f.fromYear) &&
        (!f.toYear || !t.year || t.year <= f.toYear) &&
        (!genres.length ||
          !t.genres?.length ||
          t.genres.some((g) => genres.some((w) => fold(g).includes(w)))) &&
        !seen.some((s) => sameSeen(s, { kind: r.kind, title: t.title, year: t.year })) &&
        !(r.exclude ?? []).some((x) => sameTitle(x, t.title)),
    );
    if (!list.length) return none("Nothing in your library matches those filters.");
    // A big library is sampled: a fair spread, never always the same first titles.
    if (list.length > LIBRARY_AT_MOST)
      list = [...list].sort(() => Math.random() - 0.5).slice(0, LIBRARY_AT_MOST);
    const names = list.map((t) => (t.year ? `${t.title} (${t.year})` : t.title));
    const { system, prompt } = recommendPrompt(r, names);
    const suggestions = parseSuggestions(await this.d.ask(system, prompt));
    if (!suggestions.length)
      throw new RecommendError(
        "Ember didn't come back with a list this time. Try again, or put it another way.",
      );
    const items: RecommendItem[] = [];
    const unverified: string[] = [];
    for (const s of suggestions) {
      const t =
        list.find((x) => sameTitle(x.title, s.title) && sameYear(x.year, s.year)) ??
        list.find((x) => fold(x.title) === fold(s.title));
      if (!t) {
        unverified.push(s.title);
        continue;
      }
      const key = `${r.kind}:have:${fold(t.title)}:${t.year ?? ""}`;
      if (items.some((x) => x.key === key)) continue;
      items.push({
        key,
        kind: r.kind,
        title: t.title,
        ...(t.year ? { year: t.year } : {}),
        ...((t.creator ?? s.creator) ? { creator: t.creator ?? s.creator } : {}),
        why: s.why,
        ...(s.adjacent && r.wide ? { outside: true } : {}),
        ...(t.image ? { image: t.image } : {}),
        have: true,
      });
    }
    const shown = items.slice(0, SHOW_AT_MOST);
    // Movies and shows: their Seerr page, so tapping one opens it (trailer, ratings, cast).
    if (seerrId && (r.kind === "movie" || r.kind === "show")) {
      const type = r.kind === "show" ? "tv" : "movie";
      await eachLimited(shown, 4, async (it) => {
        const hits = await this.d.seerrSearch(seerrId, it.title).catch(() => [] as SeerrHit[]);
        const hit = hits.find(
          (h) => h.mediaType === type && sameTitle(h.title, it.title) && sameYear(h.year, it.year),
        );
        if (hit) Object.assign(it, { tmdbId: hit.tmdbId, mediaType: type });
      });
    }
    return {
      kind: r.kind,
      items: shown,
      owned: [],
      unverified,
      note: `Ember chose from ${list.length.toLocaleString("en-US")} ${list.length === 1 ? "title" : "titles"} in your library (names and years only).`,
    };
  }

  /**
   * "Seen it": Hearth remembers the title (never suggested again) right away. A movie or show
   * that is on your Plex or Jellyfin and not marked watched there comes back as steps to offer:
   * marking it watched is a change on your server, so it is only ever a plan you approve.
   */
  async markSeen(e: RecommendSeen): Promise<RecommendSeenResult> {
    const title = e.title.trim();
    if (!title) throw new RecommendError("Say which title.");
    const rating = cleanRating(e.rating);
    const all = await this.d.seen.list().catch(() => []);
    const entry = {
      kind: e.kind,
      title,
      ...(e.year ? { year: e.year } : {}),
      ...(rating ? { rating } : {}),
    };
    // Seen again with a rating: the newest rating is kept.
    const rest = all.filter((s) => !sameSeen(s, entry));
    await this.d.seen.save([...rest, { ...entry, at: new Date().toISOString() }].slice(-SEEN_KEEP));
    if (e.kind !== "movie" && e.kind !== "show") return { markWatched: [] };
    const hits = await this.d.onServers(e.kind, title).catch(() => [] as ServerHit[]);
    const markWatched: RecommendWatchStep[] = [];
    const done = new Set<string>();
    for (const h of hits) {
      if (!sameTitle(h.title, title) || !sameYear(h.year, e.year)) continue;
      // One title per server: the closest match only.
      if (done.has(h.serviceId)) continue;
      done.add(h.serviceId);
      const base = {
        serviceId: h.serviceId,
        server: h.server,
        title: h.year ? `${h.title} (${h.year})` : h.title,
      };
      const plex = h.app === "plex";
      if (!h.watched)
        markWatched.push({
          ...base,
          does: "watched",
          ...(plex
            ? { step: "app-plex-control", params: { op: "watched", ratingKey: h.id } }
            : { step: "app-jellyfin-control", params: { op: "watched", itemId: h.id } }),
        });
      // Your rating where the server keeps one: Plex's stars; Jellyfin's like and Favorite.
      const liked = likedOf(rating);
      if (plex && rating?.stars)
        markWatched.push({
          ...base,
          does: "rating",
          step: "app-plex-control",
          params: { op: "rate", ratingKey: h.id, stars: String(rating.stars) },
        });
      else if (!plex && liked !== undefined)
        markWatched.push({
          ...base,
          does: "rating",
          step: "app-jellyfin-control",
          params: {
            op: "like",
            itemId: h.id,
            liked: String(liked),
            favorite: String(rating?.reaction === "loved" || rating?.stars === 5),
          },
        });
    }
    return { markWatched };
  }

  /** Undo "Seen it": it can be suggested again. */
  async unmarkSeen(e: RecommendSeen): Promise<void> {
    const all = await this.d.seen.list().catch(() => []);
    const kept = all.filter((s) => !sameSeen(s, { ...e, title: e.title.trim() }));
    if (kept.length !== all.length) await this.d.seen.save(kept);
  }

  /** Movies and shows: Seerr's search (TMDB). "Available" is in your library. */
  private async checkSeerr(
    serviceId: string,
    type: "movie" | "tv",
    list: Suggestion[],
  ): Promise<Checked[]> {
    return eachLimited(list, 4, async (s): Promise<Checked> => {
      const hits = await this.d.seerrSearch(serviceId, s.title).catch(() => [] as SeerrHit[]);
      const hit =
        hits.find(
          (h) => h.mediaType === type && sameTitle(h.title, s.title) && sameYear(h.year, s.year),
        ) ??
        (s.year
          ? undefined
          : hits.find((h) => h.mediaType === type && sameTitle(h.title, s.title)));
      if (!hit) return { found: false, title: s.title };
      const status = hit.status.toLowerCase();
      const base: RecommendItem = {
        key: `${type}:${hit.tmdbId}`,
        kind: type === "tv" ? "show" : "movie",
        tmdbId: hit.tmdbId,
        mediaType: type,
        title: hit.title,
        ...(hit.year ? { year: hit.year } : {}),
        ...(s.creator ? { creator: s.creator } : {}),
        why: s.why,
        ...(s.adjacent ? { outside: true } : {}),
        ...(hit.poster
          ? {
              image: `/api/services/${encodeURIComponent(serviceId)}/dashboard/poster?path=${encodeURIComponent(hit.poster)}`,
            }
          : {}),
      };
      if (status === "available" || (status === "partly available" && type !== "tv"))
        return {
          found: true,
          owned: true,
          title: hit.title,
          ...(hit.year ? { year: hit.year } : {}),
          item: { ...base, have: true },
        };
      // A show you have some seasons of: offered, and the request asks only for the rest.
      if (status === "partly available" && type === "tv")
        return {
          found: true,
          owned: false,
          item: {
            ...base,
            partial: true,
            request: {
              kind: "plan",
              serviceId,
              step: "app-seerr-request",
              params: { mediaType: "tv", tmdbId: hit.tmdbId },
              label: `Request the missing seasons of ${hit.title}`,
            },
          },
        };
      // Seerr's own idea of what is in the library lags behind (a re-scan, a moved folder), so
      // the library itself is asked too: in Plex or Jellyfin is "you have it", whatever Seerr says.
      if (
        this.d.inLibrary &&
        (await this.d
          .inLibrary(type === "tv" ? "show" : "movie", hit.title, hit.year)
          .catch(() => false))
      )
        return {
          found: true,
          owned: true,
          title: hit.title,
          ...(hit.year ? { year: hit.year } : {}),
          item: { ...base, have: true },
        };
      const requested = ["pending", "processing", "requested", "approved"].includes(status);
      return {
        found: true,
        owned: false,
        item: {
          ...base,
          ...(requested
            ? { requested: true }
            : {
                request: {
                  kind: "plan",
                  serviceId,
                  step: "app-seerr-request",
                  params: { mediaType: type, tmdbId: hit.tmdbId },
                  label: `Request ${hit.title}`,
                },
              }),
        },
      };
    });
  }

  /**
   * Music: Lidarr's own search for the artist. In the library is owned; the rest is added with
   * the library's first quality and metadata profiles and root folder, as a plan you approve
   * (the plan shows each, and Lidarr's own panel can change them first).
   */
  private async checkLidarr(
    serviceId: string,
    name: string,
    list: Suggestion[],
    profilesOut: { id: number; name: string }[] = [],
  ): Promise<Checked[]> {
    return this.d.arr(serviceId, "check suggested artists", async (call) => {
      const [lib, quality, metadata, roots] = await Promise.all([
        call<{ foreignArtistId?: string; artistName?: string }[]>("GET", "/api/v1/artist"),
        call<{ id: number; name?: string }[]>("GET", "/api/v1/qualityprofile"),
        call<{ id: number }[]>("GET", "/api/v1/metadataprofile"),
        call<{ path: string }[]>("GET", "/api/v1/rootfolder"),
      ]);
      if (!lib.ok || !Array.isArray(lib.data))
        throw new RecommendError(
          `${name} didn't list its artists (${lib.status}), so nothing could be checked.`,
        );
      const have = new Set(lib.data.map((a) => a.foreignArtistId).filter(Boolean));
      const q = Array.isArray(quality.data) ? quality.data[0]?.id : undefined;
      // The profile a new artist gets: the first by default, and the panel lets you choose.
      if (Array.isArray(quality.data))
        for (const p of quality.data)
          profilesOut.push({ id: p.id, name: p.name ?? `Profile ${p.id}` });
      const m = Array.isArray(metadata.data) ? metadata.data[0]?.id : undefined;
      const root = Array.isArray(roots.data) ? roots.data[0]?.path : undefined;
      return eachLimited(list, 3, async (s): Promise<Checked> => {
        const found = await call<{ foreignArtistId?: string; artistName?: string }[]>(
          "GET",
          `/api/v1/artist/lookup?term=${encodeURIComponent(s.title)}`,
        );
        const hit = Array.isArray(found.data)
          ? found.data.find(
              (a) => a.artistName && a.foreignArtistId && sameTitle(a.artistName, s.title),
            )
          : undefined;
        if (!hit) return { found: false, title: s.title };
        const id = hit.foreignArtistId!;
        if (have.has(id))
          return {
            found: true,
            owned: true,
            title: hit.artistName!,
            item: {
              key: `music:${id}`,
              kind: "music",
              title: hit.artistName!,
              ...(s.creator ? { creator: s.creator } : {}),
              why: s.why,
              ...(s.adjacent ? { outside: true } : {}),
              have: true,
            },
          };
        return {
          found: true,
          owned: false,
          item: {
            key: `music:${id}`,
            kind: "music",
            title: hit.artistName!,
            ...(s.creator ? { creator: s.creator } : {}),
            why: s.why,
            ...(s.adjacent ? { outside: true } : {}),
            ...(q && m && root
              ? {
                  request: {
                    kind: "plan",
                    serviceId,
                    step: "app-arr-create",
                    params: {
                      resource: "artist",
                      body: JSON.stringify({
                        foreignArtistId: id,
                        rootFolderPath: root,
                        qualityProfileId: q,
                        metadataProfileId: m,
                        monitor: "all",
                        monitorNewItems: "all",
                        searchForMissingAlbums: true,
                      }),
                    },
                    label: `Add ${hit.artistName} to ${name}`,
                  },
                }
              : {}),
          },
        };
      });
    });
  }

  /**
   * Books and audiobooks: Chaptarr's own search. A book with a file of the same kind (ebook or
   * audiobook) in the library is owned; the rest open on Chaptarr's add page.
   */
  private async checkChaptarr(
    serviceId: string,
    kind: "ebook" | "audiobook",
    list: Suggestion[],
  ): Promise<Checked[]> {
    type Book = {
      title?: string;
      foreignBookId?: string;
      mediaType?: string;
      releaseDate?: string;
      author?: { authorName?: string };
      authorTitle?: string;
      statistics?: { bookFileCount?: number };
      monitored?: boolean;
      id?: number;
      images?: { url?: string; remoteUrl?: string; coverType?: string }[];
    };
    return this.d.arr(serviceId, "check suggested books", async (call, web) => {
      const [lib, roots, quality, metadata] = await Promise.all([
        call<Book[]>("GET", "/api/v1/book"),
        call<{ path: string; name?: string }[]>("GET", "/api/v1/rootfolder"),
        call<{ id: number }[]>("GET", "/api/v1/qualityprofile"),
        call<{ id: number }[]>("GET", "/api/v1/metadataprofile"),
      ]);
      // The folder for this kind: the one named for audiobooks, or for books.
      const folders = Array.isArray(roots.data) ? roots.data : [];
      const audio = (x: { path: string; name?: string }) => /audio/i.test(`${x.name} ${x.path}`);
      const root = (kind === "audiobook" ? folders.find(audio) : folders.find((x) => !audio(x)))
        ?.path;
      const qp = Array.isArray(quality.data) ? quality.data[0]?.id : undefined;
      const mp = Array.isArray(metadata.data) ? metadata.data[0]?.id : undefined;
      if (!lib.ok || !Array.isArray(lib.data))
        throw new RecommendError(
          `Chaptarr didn't list its books (${lib.status}), so nothing could be checked.`,
        );
      const isKind = (b: Book) => !b.mediaType || b.mediaType.toLowerCase() === kind;
      const yearOf = (b: Book) =>
        b.releaseDate ? Number(b.releaseDate.slice(0, 4)) || undefined : undefined;
      const authorOf = (b: Book) => b.author?.authorName ?? b.authorTitle;
      // Its cover, through Hearth (from Chaptarr, or the cover site it named); the browser
      // reaches nothing else.
      const coverOf = (b: Book) => {
        const image = coverLink(serviceId, b.images);
        return image ? { image } : {};
      };
      const sameBook = (b: Book, s: Suggestion) =>
        Boolean(b.title) &&
        sameTitle(b.title!.replace(/\s*\([^)]*#\s*[\d.]+\)\s*$/, ""), s.title) &&
        (!s.creator ||
          !authorOf(b) ||
          fold(authorOf(b)!).includes(fold(s.creator).split(" ").pop() ?? ""));
      return eachLimited(list, 3, async (s): Promise<Checked> => {
        // A copy with files first, then one Chaptarr wants, then any (a book can have many
        // editions in Chaptarr, most of them not wanted).
        const matches = lib.data.filter((b) => isKind(b) && sameBook(b, s));
        const mine =
          matches.find((b) => (b.statistics?.bookFileCount ?? 0) > 0) ??
          matches.find((b) => b.monitored) ??
          matches[0];
        if (mine && (mine.statistics?.bookFileCount ?? 0) > 0) {
          const title = mine.title!.replace(/\s*\([^)]*#\s*[\d.]+\)\s*$/, "");
          const author = authorOf(mine) ?? s.creator;
          return {
            found: true,
            owned: true,
            title: mine.title!,
            ...(yearOf(mine) ? { year: yearOf(mine) } : {}),
            item: {
              key: `${kind}:${mine.foreignBookId ?? fold(title)}`,
              kind: kind === "audiobook" ? "audiobook" : "book",
              ...coverOf(mine),
              title,
              ...(yearOf(mine) ? { year: yearOf(mine) } : {}),
              ...(author ? { creator: author } : {}),
              why: s.why,
              ...(s.adjacent ? { outside: true } : {}),
              have: true,
            },
          };
        }
        const found = await call<Book[]>(
          "GET",
          `/api/v1/book/lookup?term=${encodeURIComponent([s.title, s.creator].filter(Boolean).join(" "))}`,
        );
        const hit =
          mine ??
          (Array.isArray(found.data)
            ? found.data.find((b) => isKind(b) && sameBook(b, s))
            : undefined);
        if (!hit?.title) return { found: false, title: s.title };
        const year = yearOf(hit);
        const author = authorOf(hit) ?? s.creator;
        return {
          found: true,
          owned: false,
          item: {
            key: `${kind}:${hit.foreignBookId ?? fold(hit.title)}`,
            kind: kind === "audiobook" ? "audiobook" : "book",
            ...coverOf(hit),
            title: hit.title.replace(/\s*\([^)]*#\s*[\d.]+\)\s*$/, ""),
            ...(year ? { year } : {}),
            ...(author ? { creator: author } : {}),
            why: s.why,
            ...(s.adjacent ? { outside: true } : {}),
            // In the library without a file: "Requested" only when Chaptarr really wants it;
            // otherwise the request wants that copy and searches.
            ...(mine?.monitored
              ? { requested: true }
              : mine?.id !== undefined
                ? {
                    request: {
                      kind: "plan",
                      serviceId,
                      step: "app-chaptarr-control",
                      params: { op: "request", itemId: mine.id, name: hit.title },
                      label: `Request ${hit.title} in Chaptarr`,
                    },
                  }
                : hit.foreignBookId && root && qp && mp
                  ? {
                      // Added in Chaptarr, wanted and searched for: one approval, with this kind's
                      // folder and the library's own profiles (Chaptarr's panel can change them).
                      request: {
                        kind: "plan",
                        serviceId,
                        step: "app-chaptarr-control",
                        params: {
                          op: "request",
                          name: hit.title,
                          book: JSON.stringify({
                            ...hit,
                            mediaType: kind,
                            monitored: true,
                            addOptions: { searchForNewBook: true },
                            author: {
                              ...(hit.author ?? {}),
                              qualityProfileId: qp,
                              metadataProfileId: mp,
                              rootFolderPath: root,
                              monitored: true,
                              addOptions: { monitor: "none", searchForMissingBooks: false },
                            },
                          }),
                        },
                        label: `Request ${hit.title} in Chaptarr`,
                      },
                    }
                  : hit.foreignBookId
                    ? {
                        request: {
                          kind: "open",
                          url: `${web.replace(/\/$/, "")}/add/search?term=${encodeURIComponent(`${hit.title} ${author ?? ""}`.trim())}`,
                          label: "Add in Chaptarr",
                        },
                      }
                    : {}),
          },
        };
      });
    });
  }
}
