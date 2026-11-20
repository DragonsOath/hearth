/**
 * Curator For You (11-13, approved by the owner; private/docs/RECOMMEND_DESIGN.md part 2).
 *
 * Ember suggests what to watch next from what you really watch: hidden gems already in your
 * library you never played, favourites worth revisiting, and (on the Discover tab, from the same
 * taste) what's missing from your collection. The owner's answers:
 *  - your own watch history only (11-13): other people on the Plex are never read, so their
 *    viewing never reaches the AI; a For You per Plex user, each opted in, comes later;
 *  - Tautulli's history when the lab has it, else Plex's own;
 *  - local only, never an outside service;
 *  - Premium (Discover stays free).
 *
 * Truthful by construction: the reasons are built here from Hearth's own records (counts, dates,
 * titles). Ember may only reword them, and a line from Ember that names a number or year the
 * facts don't hold is dropped for Hearth's own words.
 */

/** Hidden gem, New in your library, Worth revisiting, or More like (a seed). */
export type ForYouKind = "gem" | "fresh" | "revisit" | "like";

export interface ForYouPerson {
  /** "t:<Tautulli user id>" or "p:<Plex account id>". */
  id: string;
  name: string;
  plays: number;
  /** The owner switched this person off: nothing is read or kept for them. */
  off: boolean;
}

export interface ForYouPick {
  /** Plex's ratingKey (the movie, or the show). */
  key: string;
  kind: ForYouKind;
  type: "movie" | "show";
  title: string;
  year?: number;
  genres: string[];
  /** Hearth's own reason, from its records. */
  why: string;
  /** Ember's wording of the same reason, when it kept to the facts. */
  voice?: string;
  /** The poster through Hearth. */
  image?: string;
  /** Opens it in Plex. */
  open?: string;
  minutes?: number;
}

/** A title you'd probably like that isn't in your Plex, from Seerr's own lists. */
export interface MissingPick {
  /** "movie:<TMDB id>" or "tv:<TMDB id>" (Discover's keys, for Watch trailer). */
  key: string;
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  genres: string[];
  why: string;
  /** The poster through Hearth (TMDB's poster file, fetched by Hearth). */
  image?: string;
  /** Already requested in Seerr. */
  requested?: boolean;
}

/** A title Seerr lists (similar, recommended or search). */
export interface SeerrTitle {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  year?: number;
  poster?: string;
  status: string;
  genres?: string[];
}

export interface ForYouResult {
  person: ForYouPerson;
  /** Where the history came from, said on screen. */
  source: "Tautulli" | "Plex";
  /** What Hearth learned, in a line ("Mostly Comedy, Action and Sci-Fi, from 214 plays"). */
  taste: string;
  topGenres: string[];
  /** A few titles they finished and loved, for "Find ones I don't have". */
  loved: string[];
  picks: ForYouPick[];
  /** Kept back to fill a card's place after Seen it or Not for me (not shown). */
  reserve?: ForYouPick[];
  /** Not in your library: from Seerr's similar and recommended lists for what you finished. */
  missing: MissingPick[];
  missingReserve?: MissingPick[];
  /** Why Not in your library is empty, said plainly (no Seerr, nothing finished yet). */
  missingNote?: string;
  /** The Seerr the missing titles come from (Request and Watch trailer). */
  seerr?: string;
  /** "More like Anchorman": what these picks started from. */
  seed?: string;
  /** What "What should I watch?" understood ("Comedy, under 2 h"), or what Ember was asked. */
  said?: string;
  at: string;
}

/** One play, from Tautulli or Plex, joined to the library by ratingKey. */
export interface Play {
  /** The movie's or the show's ratingKey. */
  key: string;
  title: string;
  type: "movie" | "show";
  /** Seconds since 1970. */
  at: number;
  /** 0 to 100. */
  complete: number;
}

/** A movie or show in the library. */
export interface LibItem {
  key: string;
  title: string;
  year?: number;
  type: "movie" | "show";
  genres: string[];
  /** Seconds since 1970. */
  addedAt: number;
  library: string;
  thumb?: string;
  /** TMDB's id, from Plex's Guids (Not in your library starts from it). */
  tmdb?: number;
  minutes?: number;
}

export interface ForYouDeps {
  /** The Plex to read (the first real one), and its Tautulli when the lab has one. */
  servers: () => Promise<{ plex?: { id: string; name: string }; tautulli?: { id: string } }>;
  plexGet: <T>(serviceId: string, path: string, purpose: string) => Promise<T>;
  tautulliGet: <T>(
    serviceId: string,
    cmd: string,
    params: Record<string, string | number>,
    purpose: string,
  ) => Promise<T>;
  store: {
    get: <T>(key: string) => Promise<T | undefined>;
    set: (key: string, value: unknown) => Promise<void>;
    del: (key: string) => Promise<void>;
  };
  /** Ember rewords the reasons (no tools); optional, and checked. */
  ask?: (system: string, prompt: string) => Promise<string>;
  /** What you said you've seen in Curator, with your ratings (they steer the picks). */
  rated?: () => Promise<Rated[]>;
  /** Seen it: Curator's own (remembered, and the steps to mark it watched on your servers). */
  markSeen?: (e: Rated) => Promise<{ markWatched: unknown[] }>;
  /** The Seerr to ask, and its lists. */
  seerr?: () => Promise<{ id: string } | undefined>;
  similar?: (seerrId: string, type: "movie" | "tv", tmdbId: number) => Promise<SeerrTitle[]>;
  seerrSearch?: (seerrId: string, query: string) => Promise<SeerrTitle[]>;
  /**
   * A vague "What should I watch?" (no plain filter in it): Discover's own ask, in lean mode,
   * from your library's titles and genres only. Its items, owned or not.
   */
  vague?: (
    text: string,
    kind: "movie" | "show",
  ) => Promise<
    {
      key: string;
      title: string;
      year?: number;
      why: string;
      have?: boolean;
      requested?: boolean;
      image?: string;
    }[]
  >;
  now?: () => number;
}

export class ForYouError extends Error {}

const DAY = 86_400;
/** A list is made again after this long, or when asked. */
const FRESH_MS = 12 * 3_600_000;
const GEMS = 8;
const REVISITS = 4;
/** Picks kept back to fill a card's place after Seen it or Not for me. */
const RESERVE = 10;
/** Unplayed and added this recently: "New in your library", not a hidden gem. */
const NEW_DAYS = 90;
/** A favourite is only "worth revisiting" once it hasn't been watched for this long. */
const REVISIT_FLOORS = [365, 180, 90, 45];

/** A title you rated in Curator (Seen it): loved ones pull the picks towards them. */
export interface Rated {
  kind: string;
  title: string;
  year?: number;
  rating?: { stars?: number; reaction?: string };
}

/** What "More like this" starts from: one of your titles, or a missing one's genres. */
export interface Seed {
  title: string;
  genres: string[];
  key?: string;
  type?: "movie" | "show";
}

/** The plain filters a "What should I watch?" box understood. */
export interface WatchFilters {
  type?: "movie" | "show";
  genres: string[];
  maxMinutes?: number;
  minMinutes?: number;
  fromYear?: number;
  toYear?: number;
  /** "like Bad Boys": the title to start from. */
  like?: string;
  /** What is left over that no plain filter covers. */
  rest: string;
}

/* ---------- The taste, and the picks (pure: tested on their own) ---------- */

export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^(the|a|an) /, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const sameName = (a: string, b: string) => fold(a) === fold(b);
const nearYear = (a?: number, b?: number) => !a || !b || Math.abs(a - b) <= 1;

/** Each genre's weight from what was really watched: finished and repeated counts more. */
export function tasteOf(plays: Play[], lib: Map<string, LibItem>, rated: Rated[] = []) {
  const per = new Map<string, { plays: number; best: number; last: number }>();
  for (const p of plays) {
    const x = per.get(p.key) ?? { plays: 0, best: 0, last: 0 };
    x.plays += 1;
    x.best = Math.max(x.best, p.complete);
    x.last = Math.max(x.last, p.at);
    per.set(p.key, x);
  }
  const genres = new Map<string, number>();
  for (const [key, x] of per) {
    const item = lib.get(key);
    if (!item) continue;
    // Shows count by episodes, so cap them: one show watched a lot shouldn't be all of taste.
    const w = (x.best >= 50 ? 1 : 0.3) * Math.min(3, 1 + 0.5 * (x.plays - 1));
    for (const g of item.genres) genres.set(g, (genres.get(g) ?? 0) + w);
  }
  // Your ratings (Seen it): loved or 4 and 5 stars count like a favourite; Not for me, Horrible
  // or 1 and 2 stars pull its genres down.
  const all = [...lib.values()];
  for (const r of rated) {
    const item = all.find((i) => sameName(i.title, r.title) && nearYear(i.year, r.year));
    if (!item) continue;
    const s = r.rating?.stars;
    const good = r.rating?.reaction === "loved" || (s !== undefined && s >= 4);
    const bad =
      r.rating?.reaction === "not-for-me" ||
      r.rating?.reaction === "horrible" ||
      (s !== undefined && s <= 2);
    const w = good ? 2 : bad ? -1.5 : 0;
    if (w) for (const g of item.genres) genres.set(g, (genres.get(g) ?? 0) + w);
  }
  const top = [...genres.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([g]) => g);
  return { per, genres, top };
}

/** "A", "A and B", "A, B and C". */
const listed = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const yearOf = (s: number) => new Date(s * 1000).getUTCFullYear();
const monthYear = (s: number) =>
  new Date(s * 1000).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
/** How alike two titles are by genre: shared over all (0 to 1). */
const alike = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const shared = a.filter((g) => b.includes(g)).length;
  return shared / new Set([...a, ...b]).size;
};
/** "1 h 42 min", "52 min". */
export const runtime = (m?: number) =>
  !m ? "" : m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;

/** Whether a title fits the filters ("something funny under 2 hours"). */
export function fits(
  i: { type: string; genres: string[]; minutes?: number; year?: number },
  f: WatchFilters,
) {
  if (f.type && i.type !== f.type) return false;
  if (f.genres.length && !f.genres.some((g) => i.genres.includes(g))) return false;
  if (f.maxMinutes && (!i.minutes || i.minutes > f.maxMinutes)) return false;
  if (f.minMinutes && (!i.minutes || i.minutes < f.minMinutes)) return false;
  if (f.fromYear && (!i.year || i.year < f.fromYear)) return false;
  if (f.toYear && (!i.year || i.year > f.toYear)) return false;
  return true;
}

const base = (i: LibItem) => ({
  key: i.key,
  type: i.type,
  title: i.title,
  ...(i.year ? { year: i.year } : {}),
  genres: i.genres,
  ...(i.minutes ? { minutes: i.minutes } : {}),
  ...(i.thumb ? { image: i.thumb } : {}),
});

/**
 * The picks for one person: hidden gems and new arrivals, then favourites worth revisiting.
 * Started from a seed ("More like Anchorman"), the picks are the titles most like it instead;
 * with filters ("funny, under 2 hours"), only titles that fit.
 */
export function picksFor(
  name: string,
  plays: Play[],
  lib: LibItem[],
  opts: {
    now: number;
    hidden?: string[];
    rated?: Rated[];
    seed?: Seed;
    filters?: WatchFilters;
  },
): {
  picks: ForYouPick[];
  reserve: ForYouPick[];
  top: string[];
  loved: string[];
  finished: LibItem[];
} {
  const byKey = new Map(lib.map((i) => [i.key, i]));
  const rated = opts.rated ?? [];
  const { per, genres, top } = tasteOf(plays, byKey, rated);
  // Seen it in Curator counts as seen: never suggested as unplayed again.
  const ratedKeys = lib
    .filter((i) =>
      rated.some(
        (r) => r.kind === i.type && sameName(r.title, i.title) && nearYear(i.year, r.year),
      ),
    )
    .map((i) => i.key);
  const hidden = new Set([...(opts.hidden ?? []), ...ratedKeys]);
  const score = (i: LibItem) =>
    i.genres.length
      ? i.genres.reduce((n, g) => n + (genres.get(g) ?? 0), 0) / Math.sqrt(i.genres.length)
      : 0;
  // What they finished: the "like ..." in a reason, and Not in your library's starting points.
  // Most recent first, so a show watched a lot long ago doesn't speak for every pick.
  const finished = [...per.entries()]
    .filter(([k, x]) => x.best >= 80 && byKey.has(k))
    .sort((a, b) => b[1].last - a[1].last)
    .map(([k]) => byKey.get(k)!);
  // Each finished title backs at most two reasons (11-14, the owner: every reason named the
  // same two shows), and the closest one by genre is chosen, the same kind first.
  const used = new Map<string, number>();
  const likeFor = (i: LibItem) => {
    const best = finished
      .filter((f) => f.key !== i.key && (used.get(f.key) ?? 0) < 2)
      .map((f) => ({ f, s: alike(f.genres, i.genres) + (f.type === i.type ? 0.15 : 0) }))
      .filter((x) => x.s > 0.3)
      .sort((a, b) => b.s - a.s)[0]?.f;
    if (best) used.set(best.key, (used.get(best.key) ?? 0) + 1);
    return best;
  };

  const seed = opts.seed;
  const f = opts.filters;
  const pool = lib.filter(
    (i) => !per.has(i.key) && !hidden.has(i.key) && i.key !== seed?.key && (!f || fits(i, f)),
  );
  const want = GEMS + RESERVE;
  let chosen: LibItem[];
  if (seed) {
    chosen = pool
      .map((i) => ({ i, s: alike(seed.genres, i.genres) * 3 + score(i) * 0.05 }))
      .filter((x) => x.s > 0.3)
      .sort((a, b) => b.s - a.s)
      .map(({ i }) => i);
  } else {
    // Mixed across the top genres (the owner, 11-13: "not all one genre"): take the best
    // unplayed title of each top genre in turn, so Comedy, Drama and Action all get a turn.
    const ranked = pool
      .filter((i) => score(i) > 0 || f)
      .map((i) => ({ i, s: score(i) + (opts.now - i.addedAt > 365 * DAY ? 0.5 : 0) }))
      .sort((a, b) => b.s - a.s)
      .map(({ i }) => i);
    chosen = [];
    const lead = top.slice(0, 4);
    for (let round = 0; chosen.length < want && round < want; round++) {
      let added = false;
      for (const g of lead) {
        if (chosen.length >= want) break;
        const next = ranked.find((i) => !chosen.includes(i) && i.genres.includes(g));
        if (next) {
          chosen.push(next);
          added = true;
        }
      }
      if (!added) break;
    }
    for (const i of ranked) if (chosen.length < want && !chosen.includes(i)) chosen.push(i);
  }
  chosen = chosen.slice(0, want);

  const gems = chosen.map((i, n): ForYouPick => {
    const isNew = opts.now - i.addedAt <= NEW_DAYS * DAY;
    const since = yearOf(i.addedAt);
    const against = seed
      ? seed.genres
      : [...genres.entries()].filter(([, w]) => w > 0).map(([g]) => g);
    const kinds = i.genres
      .filter((g) => against.includes(g))
      .slice(0, 2)
      .join(" and ");
    const length = f?.maxMinutes || f?.minMinutes ? ` ${runtime(i.minutes)}.` : "";
    if (seed)
      return {
        ...base(i),
        kind: "like",
        why:
          [
            `Like ${seed.title}: ${kinds || "the same feel"}.`,
            `If ${seed.title} hit the spot, this is more ${kinds || "of the same"}.`,
            `Same ${kinds ? `${kinds} ` : ""}territory as ${seed.title}, and you haven't seen it.`,
          ][n % 3]! + length,
      };
    const like = likeFor(i);
    const unplayed = isNew
      ? [`New in your ${i.library}, not played yet.`, `Just arrived, and waiting for you.`][n % 2]!
      : [
          `In your ${i.library} since ${since}, and you've never played it.`,
          `Added in ${since} and still unplayed.`,
          `It's been waiting in your ${i.library} since ${since}.`,
          `You've had it since ${since} and never pressed play.`,
        ][n % 4]!;
    const taste = like
      ? [
          `${kinds || "Your kind of thing"}, like ${like.title}, which you finished.`,
          `If you enjoyed ${like.title}, this is more ${kinds || "of the same"}.`,
          `Same ${kinds ? `${kinds} ` : ""}streak as ${like.title}.`,
          `Because you finished ${like.title}.`,
        ][n % 4]!
      : kinds
        ? [`${kinds}, which you watch most.`, `More of the ${kinds} you keep coming back to.`][
            n % 2
          ]!
        : "";
    return {
      ...base(i),
      kind: isNew ? "fresh" : "gem",
      why: (n % 2 ? [taste, unplayed] : [unplayed, taste]).filter(Boolean).join(" ") + length,
    };
  });

  // Favourites worth revisiting: finished, and not watched for a while (over a year first,
  // then less, so a young history still has some). Never while a seed narrows the picks.
  const finishedOld = (days: number) =>
    [...per.entries()].filter(([k, x]) => {
      const i = byKey.get(k);
      return (
        i && !hidden.has(k) && x.best >= 80 && opts.now - x.last > days * DAY && (!f || fits(i, f))
      );
    });
  const floor = REVISIT_FLOORS.find((d) => finishedOld(d).length >= 2) ?? REVISIT_FLOORS.at(-1)!;
  const revisits = seed
    ? []
    : finishedOld(floor)
        .sort(
          (a, b) => b[1].plays - a[1].plays || score(byKey.get(b[0])!) - score(byKey.get(a[0])!),
        )
        .slice(0, REVISITS)
        .map(([k, x], n): ForYouPick => {
          const i = byKey.get(k)!;
          const when = monthYear(x.last);
          const times = x.plays === 1 ? "once" : `${x.plays} times`;
          const why =
            i.type === "show"
              ? [
                  `You watched ${x.plays} episode${x.plays === 1 ? "" : "s"}, the last in ${when}.`,
                  `The last episode you saw was in ${when}. Time to pick it back up?`,
                ][n % 2]!
              : [
                  `You watched it ${times}, last in ${when}.`,
                  `Not seen since ${when}, and you've watched it ${times}.`,
                  `A favourite you haven't put on since ${when}.`,
                ][n % 3]!;
          return { ...base(i), kind: "revisit", why };
        });

  // Revisits mixed in among the gems, not all at the end.
  const mixed: ForYouPick[] = [];
  gems.slice(0, GEMS).forEach((g, n) => {
    mixed.push(g);
    if (n % 2 === 1 && revisits.length) mixed.push(revisits.shift()!);
  });
  mixed.push(...revisits);

  return {
    picks: mixed,
    reserve: gems.slice(GEMS),
    top: top.slice(0, 5),
    loved: finished.slice(0, 5).map((x) => x.title),
    finished,
  };
}

/** Words that mean a genre ("funny" is Comedy), as Plex names them. */
const GENRE_WORDS: [RegExp, string[]][] = [
  [/\b(funny|comed(?:y|ies)|laughs?|hilarious|sitcoms?)\b/, ["Comedy"]],
  [/\b(scary|horror|frightening|creepy)\b/, ["Horror"]],
  [/\b(action|explosions?)\b/, ["Action", "Action/Adventure"]],
  [/\b(sci-?fi|science fiction|space)\b/, ["Science Fiction", "Sci-Fi & Fantasy"]],
  [/\b(romantic|romance|love stor(?:y|ies))\b/, ["Romance"]],
  [/\b(thrillers?|suspense|tense)\b/, ["Thriller"]],
  [/\b(dramas?|dramatic)\b/, ["Drama"]],
  [/\b(animated|animation|cartoons?)\b/, ["Animation"]],
  [/\b(family|kids?|children)\b/, ["Family", "Children"]],
  [/\b(crime|heist|detective)\b/, ["Crime"]],
  [/\b(myster(?:y|ies)|whodunn?its?)\b/, ["Mystery"]],
  [/\b(documentar(?:y|ies)|docs?)\b/, ["Documentary"]],
  [/\b(fantasy|magic)\b/, ["Fantasy", "Sci-Fi & Fantasy"]],
  [/\b(adventures?)\b/, ["Adventure", "Action/Adventure"]],
  [/\b(war)\b/, ["War", "War & Politics"]],
  [/\b(westerns?)\b/, ["Western"]],
  [/\b(musicals?)\b/, ["Music", "Musical"]],
];

/**
 * The plain filters in "What should I watch?" (no AI): genre words, length ("under 2 hours",
 * "short"), years and decades ("80s", "after 2010"), movie or show, and "like <title>".
 */
export function parseWatch(text: string, year = new Date().getUTCFullYear()): WatchFilters {
  let t = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const out: WatchFilters = { genres: [], rest: "" };
  const take = (re: RegExp) => {
    const m = re.exec(t);
    if (m) t = t.replace(m[0], " ");
    return m;
  };
  const like = take(
    /\b(?:more like|similar to|like)\s+(.+?)(?=\s+(?:but|under|over|from|after|before|that|and|with|in the)\b|[,.!?]|\s*$)/,
  );
  if (like) out.like = like[1]!.trim();
  if (take(/\b(movies?|films?)\b/)) out.type = "movie";
  if (take(/\b(shows?|series|tv)\b/)) out.type = "show";
  const minutes = (n: string, unit: string) =>
    Math.round(Number(n.replace(",", ".")) * (/^h/.test(unit) ? 60 : 1));
  const under = take(
    /\b(?:under|less than|shorter than|at most|within)\s+(?:an?\s+)?(\d+(?:[.,]5)?)?\s*(hours?|hrs?|h|minutes?|mins?)\b/,
  );
  if (under) out.maxMinutes = minutes(under[1] ?? "1", under[2]!);
  const over = take(
    /\b(?:over|more than|longer than|at least)\s+(?:an?\s+)?(\d+(?:[.,]5)?)?\s*(hours?|hrs?|h|minutes?|mins?)\b/,
  );
  if (over) out.minMinutes = minutes(over[1] ?? "1", over[2]!);
  if (take(/\b(short|quick)\b/)) out.maxMinutes ??= 95;
  if (take(/\b(long|epic)\b/)) out.minMinutes ??= 140;
  const decade = take(/\b(?:the\s+)?(19|20)?(\d)0'?s\b/);
  if (decade) {
    const d = Number(`${decade[1] ?? (Number(decade[2]) >= 3 ? "19" : "20")}${decade[2]}0`);
    out.fromYear = d;
    out.toYear = d + 9;
  }
  const after = take(/\b(?:after|since|from|newer than)\s+((?:19|20)\d\d)\b/);
  if (after) out.fromYear = Number(after[1]);
  const before = take(/\b(?:before|older than|until)\s+((?:19|20)\d\d)\b/);
  if (before) out.toYear = Number(before[1]);
  if (take(/\b(new|recent|latest)\b/)) out.fromYear ??= year - 3;
  if (take(/\b(old|classics?)\b/)) out.toYear ??= 1990;
  for (const [re, gs] of GENRE_WORDS)
    if (take(re)) for (const g of gs) if (!out.genres.includes(g)) out.genres.push(g);
  // Filler that says nothing on its own.
  out.rest = t
    .replace(
      /\b(something|anything|a|an|the|to|watch|tonight|i|i'm|want|wanna|me|give|find|good|great|nice|please|for|with|of|some|one|ones|that|is|are|what|should|can|could|kind|bit|really|very|and|or|but|in|on|feel|feeling|mood|like)\b/g,
      " ",
    )
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

/** Whether the filters say anything Hearth can use on its own. */
export const understood = (f: WatchFilters) =>
  Boolean(
    f.like || f.type || f.genres.length || f.maxMinutes || f.minMinutes || f.fromYear || f.toYear,
  );

/** "like Bad Boys, Comedy, under 2 h": what the box understood, said back. */
export function saidBack(f: WatchFilters) {
  return [
    f.like ? `like ${f.like}` : "",
    f.genres.length ? listed([...new Set(f.genres.map((g) => g.split(/ & |\//)[0]!))]) : "",
    f.maxMinutes ? `under ${runtime(f.maxMinutes)}` : "",
    f.minMinutes ? `over ${runtime(f.minMinutes)}` : "",
    f.fromYear && f.toYear
      ? `${f.fromYear} to ${f.toYear}`
      : f.fromYear
        ? `from ${f.fromYear}`
        : f.toYear
          ? `up to ${f.toYear}`
          : "",
    f.type === "movie" ? "movies" : f.type === "show" ? "shows" : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Ember's line is kept only if every number in it (counts, years) is in Hearth's own facts for
 * that title, and it names nothing the facts don't: the design's "truthful by construction".
 */
export function voiceKept(line: string, facts: string): boolean {
  const nums = line.match(/\d+/g) ?? [];
  const known = new Set(facts.match(/\d+/g) ?? []);
  return line.trim().length > 0 && line.length <= 400 && nums.every((n) => known.has(n));
}

/* ---------- The service ---------- */

const KEY = (person: string) => `for_you:${person}`;

export class ForYou {
  constructor(private readonly deps: ForYouDeps) {}

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  /** Everyone on the Plex who has watched something, with who is switched off. */
  async people(): Promise<{ people: ForYouPerson[]; source: "Tautulli" | "Plex" }> {
    // The owner only (11-13, the owner: "shared users' viewing shouldn't go to the AI without
    // their consent"). A For You per Plex user, each opted in, comes later.
    const { plex, tautulli } = await this.deps.servers();
    if (!plex) throw new ForYouError("For You needs Plex connected to Hearth.");
    // The Plex server's owner is its account 1.
    const a = await this.deps.plexGet<{
      MediaContainer?: { Account?: { id?: number; name?: string }[] };
    }>(plex.id, "/accounts", "find your own Plex account, for Curator For You");
    const owner = (a.MediaContainer?.Account ?? []).find((x) => x.id === 1);
    if (tautulli) {
      try {
        const t = await this.deps.tautulliGet<{
          data?: {
            user_id?: number;
            friendly_name?: string;
            username?: string;
            plays?: number;
            is_admin?: number;
          }[];
        }>(
          tautulli.id,
          "get_users_table",
          { length: 200 },
          "find your own account, for Curator For You",
        );
        const users = t.data ?? [];
        const named = (u: (typeof users)[number]) =>
          Boolean(
            owner?.name &&
            [u.username, u.friendly_name].some(
              (n) => n?.toLowerCase() === owner.name!.toLowerCase(),
            ),
          );
        const me = users.find((u) => u.is_admin === 1) ?? users.find(named);
        if (me?.user_id)
          return {
            people: [
              {
                id: `t:${me.user_id}`,
                name: me.friendly_name || me.username || owner?.name || "You",
                plays: me.plays ?? 0,
                off: false,
              },
            ],
            source: "Tautulli",
          };
      } catch {
        // Tautulli not answering: Plex's own history still works.
      }
    }
    if (!owner?.name) throw new ForYouError("Hearth couldn't find your own account on Plex.");
    return { people: [{ id: "p:1", name: owner.name, plays: 0, off: false }], source: "Plex" };
  }

  /** What was hidden with Not for me, per person (Plex keys and "movie:<id>" for missing ones). */
  private async hiddenFor(person: string) {
    return ((await this.deps.store.get<Record<string, string[]>>("for_you_hidden")) ?? {})[person];
  }

  /**
   * A card goes (Not for me, or Seen it): the kept list loses it and the next one waiting takes
   * its place. Returns that replacement, if there is one.
   */
  private async drop(person: string, key: string) {
    const kept = await this.deps.store.get<ForYouResult>(KEY(person));
    if (!kept) return {};
    const inPicks = kept.picks.some((p) => p.key === key);
    const inMissing = kept.missing?.some((p) => p.key === key);
    const reserve = (kept.reserve ?? []).filter((p) => p.key !== key);
    const missingReserve = (kept.missingReserve ?? []).filter((p) => p.key !== key);
    const pick = inPicks ? reserve.shift() : undefined;
    const missing = inMissing ? missingReserve.shift() : undefined;
    await this.deps.store.set(KEY(person), {
      ...kept,
      picks: [...kept.picks.filter((p) => p.key !== key), ...(pick ? [pick] : [])],
      reserve,
      missing: [
        ...(kept.missing ?? []).filter((p) => p.key !== key),
        ...(missing ? [missing] : []),
      ],
      missingReserve,
    } satisfies ForYouResult);
    return { ...(pick ? { pick } : {}), ...(missing ? { missing } : {}) };
  }

  /** "Not for me": never suggested again; the next pick waiting takes its place. */
  async hide(person: string, key: string) {
    const all = (await this.deps.store.get<Record<string, string[]>>("for_you_hidden")) ?? {};
    all[person] = [...new Set([...(all[person] ?? []), key])].slice(-2000);
    await this.deps.store.set("for_you_hidden", all);
    return this.drop(person, key);
  }

  /**
   * "Seen it" on one of your titles: Curator remembers it with your rating (which steers the
   * next picks), and the steps to mark it watched on your servers come back to approve. A new
   * pick takes its place.
   */
  async seen(
    person: string,
    key: string,
    rating?: { stars?: number; reaction?: string; note?: string },
  ) {
    const { plex } = await this.deps.servers();
    if (!plex) throw new ForYouError("For You needs Plex connected to Hearth.");
    const lib = await this.library(plex.id);
    const i = lib.find((x) => x.key === key);
    if (!i) throw new ForYouError("That title isn't in your Plex any more.");
    const r = this.deps.markSeen
      ? await this.deps.markSeen({
          kind: i.type,
          title: i.title,
          ...(i.year ? { year: i.year } : {}),
          ...(rating ? { rating } : {}),
        })
      : { markWatched: [] };
    return { markWatched: r.markWatched, ...(await this.drop(person, key)) };
  }

  /** One person's list: the kept one while fresh, else made again (or when `fresh`). */
  async forPerson(
    person: string,
    fresh = false,
    seed?: { key?: string; tmdb?: string; title?: string; genres?: string[] },
  ): Promise<ForYouResult> {
    const { people } = await this.people();
    const who = people.find((p) => p.id === person);
    if (!who) throw new ForYouError("That person isn't on your Plex.");
    if (who.off) throw new ForYouError(`For You is off for ${who.name}.`);
    if (!seed) {
      const kept = await this.deps.store.get<ForYouResult>(KEY(person));
      // A kept list names the Seerr its requests go to; if that Seerr was removed or another
      // took its place, the list is made again (its titles were checked against the old one).
      const seerr = kept?.missing ? await this.deps.seerr?.().catch(() => undefined) : undefined;
      if (
        !fresh &&
        kept &&
        kept.missing &&
        kept.seerr === seerr?.id &&
        this.now() - Date.parse(kept.at) < FRESH_MS
      )
        return kept;
    }
    const ctx = await this.context(who);
    // More like this: one of your titles, or a missing one (its genres, and Seerr's own list).
    let from: Seed | undefined;
    let tmdbFrom: { type: "movie" | "tv"; id: number; title: string } | undefined;
    if (seed?.key) {
      const i = ctx.lib.find((x) => x.key === seed.key);
      if (!i) throw new ForYouError("That title isn't in your Plex any more.");
      from = { key: i.key, title: i.title, genres: i.genres, type: i.type };
      if (i.tmdb)
        tmdbFrom = { type: i.type === "show" ? "tv" : "movie", id: i.tmdb, title: i.title };
    } else if (seed?.tmdb && /^(movie|tv):\d+$/.test(seed.tmdb)) {
      const [type, id] = seed.tmdb.split(":") as ["movie" | "tv", string];
      const title = (seed.title ?? "").slice(0, 200) || "that";
      from = {
        title,
        genres: (seed.genres ?? []).slice(0, 8),
        type: type === "tv" ? "show" : "movie",
      };
      tmdbFrom = { type, id: Number(id), title };
    }
    const result = await this.build(ctx, { ...(from ? { seed: from } : {}) }, tmdbFrom);
    if (!from) await this.deps.store.set(KEY(person), result);
    return result;
  }

  /**
   * "What should I watch?": plain filters and "like <title>" run here, without AI. Only a vague
   * ask goes to Ember (Discover's lean ask, from your library's titles and genres only).
   */
  async search(person: string, text: string): Promise<ForYouResult> {
    const { people } = await this.people();
    const who = people.find((p) => p.id === person);
    if (!who) throw new ForYouError("That person isn't on your Plex.");
    const ask = text.trim().slice(0, 200);
    if (ask.length < 2) throw new ForYouError("Say what you're in the mood for.");
    const f = parseWatch(ask);
    const ctx = await this.context(who);
    if (f.like) {
      // Like one of yours: start from it. Else Seerr finds the title, and its genres lead.
      const mine =
        ctx.lib.find((i) => fold(i.title) === fold(f.like!)) ??
        ctx.lib.find((i) => fold(i.title).startsWith(fold(f.like!)));
      if (mine) {
        const r = await this.build(
          ctx,
          {
            seed: { key: mine.key, title: mine.title, genres: mine.genres, type: mine.type },
            filters: f,
          },
          mine.tmdb
            ? { type: mine.type === "show" ? "tv" : "movie", id: mine.tmdb, title: mine.title }
            : undefined,
        );
        return { ...r, said: saidBack({ ...f, like: mine.title }) };
      }
      const seerr = await this.deps.seerr?.().catch(() => undefined);
      const hit =
        seerr && this.deps.seerrSearch
          ? (await this.deps.seerrSearch(seerr.id, f.like).catch(() => [] as SeerrTitle[])).find(
              (x) =>
                !f.type || (f.type === "show" ? x.mediaType === "tv" : x.mediaType === "movie"),
            )
          : undefined;
      if (hit) {
        const r = await this.build(
          ctx,
          {
            seed: {
              title: hit.title,
              genres: hit.genres ?? [],
              type: hit.mediaType === "tv" ? "show" : "movie",
            },
            filters: { ...f, like: undefined },
          },
          { type: hit.mediaType, id: hit.tmdbId, title: hit.title },
        );
        return { ...r, said: saidBack({ ...f, like: hit.title }) };
      }
      if (!understood({ ...f, like: undefined }))
        throw new ForYouError(`Hearth couldn't find "${f.like}" in your Plex or in Seerr.`);
    }
    if (understood({ ...f, like: undefined })) {
      const r = await this.build(ctx, { filters: { ...f, like: undefined } }, undefined);
      return {
        ...r,
        missing: r.missing.filter((m) =>
          fits(
            { ...m, type: m.mediaType === "tv" ? "show" : "movie" },
            { ...f, like: undefined, maxMinutes: undefined, minMinutes: undefined },
          ),
        ),
        said: saidBack({ ...f, like: undefined }),
      };
    }
    // Vague: Ember, in lean mode, with the same privacy rule (titles and genres only).
    if (!this.deps.vague) throw new ForYouError('Try plain words, like "funny under 2 hours".');
    const items = await this.deps.vague(ask, f.type ?? "movie");
    const picks: ForYouPick[] = [];
    const missing: MissingPick[] = [];
    for (const x of items) {
      const mine = x.have
        ? ctx.lib.find((i) => fold(i.title) === fold(x.title) && nearYear(i.year, x.year))
        : undefined;
      if (mine) picks.push({ ...base(mine), kind: "like", why: x.why });
      else if (/^(movie|tv):\d+$/.test(x.key)) {
        const [type, id] = x.key.split(":") as ["movie" | "tv", string];
        missing.push({
          key: x.key,
          tmdbId: Number(id),
          mediaType: type,
          title: x.title,
          ...(x.year ? { year: x.year } : {}),
          genres: [],
          why: x.why,
          ...(x.image ? { image: x.image } : {}),
          ...(x.requested ? { requested: true } : {}),
        });
      }
    }
    this.openLinks(ctx.machine, picks);
    const seerr = await this.deps.seerr?.().catch(() => undefined);
    return {
      person: who,
      source: ctx.source,
      taste: ctx.taste,
      topGenres: ctx.top,
      loved: ctx.loved,
      picks,
      missing,
      ...(seerr ? { seerr: seerr.id } : {}),
      said: `Ember's picks for "${ask}"`,
      at: new Date(this.now()).toISOString(),
    };
  }

  /** Everything a list is made from: the library, your plays, your ratings, what you hid. */
  private async context(who: ForYouPerson) {
    const { source } = await this.people();
    const { plex, tautulli } = await this.deps.servers();
    const lib = await this.library(plex!.id);
    let plays: Play[];
    let from = source;
    const person = who.id;
    if (source === "Tautulli" && tautulli && person.startsWith("t:")) {
      plays = await this.tautulliPlays(tautulli.id, person.slice(2), lib);
      // Tautulli watching another Plex, or none of its plays match this library: Plex's own
      // history for the account of the same name.
      if (!plays.length) {
        const acct = await this.plexAccount(plex!.id, who.name);
        if (acct) {
          plays = await this.plexPlays(plex!.id, acct, lib);
          from = "Plex";
        }
      }
    } else plays = await this.plexPlays(plex!.id, person.slice(2), lib);
    const hidden = (await this.hiddenFor(person)) ?? [];
    const rated = (await this.deps.rated?.().catch(() => [] as Rated[])) ?? [];
    const machine = await this.machine(plex!.id);
    const whole = picksFor(who.name, plays, lib, {
      now: Math.floor(this.now() / 1000),
      hidden,
      rated,
    });
    return {
      who,
      source: from,
      lib,
      plays,
      hidden,
      rated,
      machine,
      top: whole.top,
      loved: whole.loved,
      finished: whole.finished,
      taste: plays.length
        ? `Mostly ${listed(whole.top.slice(0, 3)) || "a bit of everything"}, from ${plays.length} play${plays.length === 1 ? "" : "s"} in ${from}.`
        : `${from} has no plays of yours for anything in your Plex yet.`,
    };
  }

  private openLinks(machine: string | undefined, picks: ForYouPick[]) {
    if (machine)
      for (const p of picks)
        p.open = `https://app.plex.tv/desktop/#!/server/${machine}/details?key=${encodeURIComponent(`/library/metadata/${p.key}`)}`;
  }

  private async build(
    ctx: Awaited<ReturnType<ForYou["context"]>>,
    opts: { seed?: Seed; filters?: WatchFilters },
    tmdbFrom: { type: "movie" | "tv"; id: number; title: string } | undefined,
  ): Promise<ForYouResult> {
    const { picks, reserve } = picksFor(ctx.who.name, ctx.plays, ctx.lib, {
      now: Math.floor(this.now() / 1000),
      hidden: ctx.hidden,
      rated: ctx.rated,
      ...opts,
    });
    this.openLinks(ctx.machine, picks);
    this.openLinks(ctx.machine, reserve);
    // Ember rewords only the main list; a seeded or filtered list keeps Hearth's own words, fast.
    if (!opts.seed && !opts.filters) await this.voice(picks);
    const m = await this.missing(ctx, tmdbFrom);
    return {
      person: ctx.who,
      source: ctx.source,
      taste: ctx.taste,
      topGenres: ctx.top,
      loved: ctx.loved,
      picks,
      reserve,
      ...m,
      ...(opts.seed ? { seed: opts.seed.title } : {}),
      at: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Not in your library: Seerr's own "recommended" and "similar" lists for up to four titles you
   * finished lately (or the one More like this started from). No AI and no tokens; only Seerr is
   * asked, as it always is. Titles in your Plex, available in Seerr, hidden or seen are left out.
   */
  private async missing(
    ctx: Awaited<ReturnType<ForYou["context"]>>,
    from?: { type: "movie" | "tv"; id: number; title: string },
  ): Promise<Pick<ForYouResult, "missing" | "missingReserve" | "missingNote" | "seerr">> {
    const seerr = await this.deps.seerr?.().catch(() => undefined);
    if (!seerr || !this.deps.similar)
      return { missing: [], missingNote: "Connect Seerr to see titles you don't have yet." };
    const starts = from
      ? [from]
      : ctx.finished
          .filter((f) => f.tmdb)
          .slice(0, 4)
          .map((f) => ({
            type: (f.type === "show" ? "tv" : "movie") as "movie" | "tv",
            id: f.tmdb!,
            title: f.title,
          }));
    if (!starts.length)
      return {
        missing: [],
        seerr: seerr.id,
        missingNote: "Once you've finished a few things in Plex, titles like them show up here.",
      };
    const lists = await Promise.all(
      starts.map((s) => this.deps.similar!(seerr.id, s.type, s.id).catch(() => [] as SeerrTitle[])),
    );
    const hidden = new Set(ctx.hidden);
    const owned = (x: SeerrTitle) =>
      ctx.lib.some(
        (i) =>
          (i.tmdb === x.tmdbId && (i.type === "show") === (x.mediaType === "tv")) ||
          (fold(i.title) === fold(x.title) && nearYear(i.year, x.year)),
      );
    const seen = (x: SeerrTitle) =>
      ctx.rated.some((r) => fold(r.title) === fold(x.title) && nearYear(r.year, x.year));
    const out: MissingPick[] = [];
    const keys = new Set<string>();
    // In turns, one from each starting title, so no single favourite fills the section.
    for (let n = 0; n < 40; n++) {
      let any = false;
      lists.forEach((list, k) => {
        const x = list[n];
        if (!x) return;
        any = true;
        const key = `${x.mediaType}:${x.tmdbId}`;
        if (keys.has(key) || hidden.has(key) || /available/.test(x.status) || owned(x) || seen(x))
          return;
        keys.add(key);
        const s = starts[k]!;
        out.push({
          key,
          tmdbId: x.tmdbId,
          mediaType: x.mediaType,
          title: x.title,
          ...(x.year ? { year: x.year } : {}),
          genres: x.genres ?? [],
          why: from
            ? [`Like ${s.title}.`, `If ${s.title} was your thing, try this.`][out.length % 2]!
            : [
                `Because you finished ${s.title}.`,
                `You finished ${s.title}: this is in the same vein.`,
                `Fans of ${s.title} like this one.`,
              ][out.length % 3]!,
          ...(x.poster && /^\/[\w-]+\.(jpg|jpeg|png|webp)$/i.test(x.poster)
            ? {
                image: `/api/services/${encodeURIComponent(seerr.id)}/dashboard/poster?path=${encodeURIComponent(x.poster)}`,
              }
            : {}),
          ...(x.status === "requested" || x.status === "processing" ? { requested: true } : {}),
        });
      });
      if (!any) break;
    }
    return {
      missing: out.slice(0, GEMS),
      missingReserve: out.slice(GEMS, GEMS + RESERVE),
      seerr: seerr.id,
      ...(out.length
        ? {}
        : { missingNote: "Seerr has nothing new like what you finished right now." }),
    };
  }

  /** Every movie and show in Plex, with genres and when it was added. */
  private async library(plexId: string): Promise<LibItem[]> {
    const secs = await this.deps.plexGet<{
      MediaContainer?: { Directory?: { key?: string; type?: string; title?: string }[] };
    }>(plexId, "/library/sections", "read your libraries, for Curator For You");
    const out: LibItem[] = [];
    const seen = new Set<string>();
    for (const d of secs.MediaContainer?.Directory ?? []) {
      if (!d.key || (d.type !== "movie" && d.type !== "show")) continue;
      const r = await this.deps.plexGet<{
        MediaContainer?: {
          Metadata?: {
            ratingKey?: string;
            title?: string;
            year?: number;
            addedAt?: number;
            thumb?: string;
            duration?: number;
            Genre?: { tag?: string }[];
            Guid?: { id?: string }[];
          }[];
        };
      }>(
        plexId,
        `/library/sections/${d.key}/all?type=${d.type === "movie" ? 1 : 2}&includeGuids=1`,
        "read your libraries, for Curator For You",
      );
      for (const m of r.MediaContainer?.Metadata ?? []) {
        if (!m.ratingKey || !m.title || seen.has(m.ratingKey)) continue;
        seen.add(m.ratingKey);
        out.push({
          key: String(m.ratingKey),
          title: m.title,
          ...(m.year ? { year: m.year } : {}),
          type: d.type,
          genres: (m.Genre ?? []).map((g) => g.tag ?? "").filter(Boolean),
          addedAt: Number(m.addedAt ?? 0),
          library: d.title ?? (d.type === "movie" ? "Movies" : "TV Shows"),
          ...(() => {
            const t = Number(
              (m.Guid ?? []).map((g) => /^tmdb:\/\/(\d+)$/.exec(g.id ?? "")?.[1]).find(Boolean),
            );
            return t ? { tmdb: t } : {};
          })(),
          // A movie's length (Plex gives milliseconds); a show's is an episode's, not used.
          ...(d.type === "movie" && m.duration ? { minutes: Math.round(m.duration / 60_000) } : {}),
          ...(m.thumb
            ? {
                thumb: `/api/services/${encodeURIComponent(plexId)}/dashboard/art?path=${encodeURIComponent(m.thumb)}`,
              }
            : {}),
        });
      }
    }
    return out;
  }

  private async tautulliPlays(tautulliId: string, userId: string, lib: LibItem[]): Promise<Play[]> {
    const r = await this.deps.tautulliGet<{
      data?: {
        rating_key?: number | string;
        grandparent_rating_key?: number | string;
        media_type?: string;
        title?: string;
        full_title?: string;
        grandparent_title?: string;
        date?: number;
        percent_complete?: number;
      }[];
    }>(
      tautulliId,
      "get_history",
      { user_id: userId, length: 3000 },
      "read what this person watched, for Curator For You",
    );
    const byTitle = new Map(lib.map((i) => [`${i.type}|${i.title.toLowerCase()}`, i.key]));
    const out: Play[] = [];
    for (const h of r.data ?? []) {
      const type =
        h.media_type === "movie" ? "movie" : h.media_type === "episode" ? "show" : undefined;
      if (!type) continue;
      // An episode's show: its own field, else the part of "Show - Episode" before the dash.
      const title =
        (type === "show"
          ? (h.grandparent_title ?? h.full_title?.split(" - ")[0])
          : (h.title ?? h.full_title)) ?? "";
      const rk = type === "show" ? h.grandparent_rating_key : h.rating_key;
      const key = (rk ? String(rk) : "") || byTitle.get(`${type}|${title.toLowerCase()}`) || "";
      if (!key) continue;
      out.push({
        key,
        title,
        type,
        at: Number(h.date ?? 0),
        complete: Number(h.percent_complete ?? 100),
      });
    }
    return out;
  }

  private async plexPlays(plexId: string, accountId: string, lib: LibItem[]): Promise<Play[]> {
    const r = await this.deps.plexGet<{
      MediaContainer?: {
        Metadata?: {
          ratingKey?: string;
          grandparentKey?: string;
          grandparentTitle?: string;
          title?: string;
          type?: string;
          viewedAt?: number;
          accountID?: number;
        }[];
      };
    }>(
      plexId,
      `/status/sessions/history/all?accountID=${encodeURIComponent(accountId)}&sort=viewedAt:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=3000`,
      "read what this person watched, for Curator For You",
    );
    const byTitle = new Map(lib.map((i) => [`${i.type}|${i.title.toLowerCase()}`, i.key]));
    const out: Play[] = [];
    for (const h of r.MediaContainer?.Metadata ?? []) {
      // Plex's own filter, checked again: a server that ignores it must not mix people up.
      if (h.accountID !== undefined && String(h.accountID) !== accountId) continue;
      const type = h.type === "movie" ? "movie" : h.type === "episode" ? "show" : undefined;
      if (!type) continue;
      const title = (type === "show" ? h.grandparentTitle : h.title) ?? "";
      const rk = type === "show" ? h.grandparentKey?.split("/").pop() : h.ratingKey;
      const key = rk || byTitle.get(`${type}|${title.toLowerCase()}`) || "";
      if (!key) continue;
      out.push({ key: String(key), title, type, at: Number(h.viewedAt ?? 0), complete: 100 });
    }
    return out;
  }

  /** The Plex account with this name (Tautulli's friendly name is often the same). */
  private async plexAccount(plexId: string, name: string): Promise<string | undefined> {
    try {
      const a = await this.deps.plexGet<{
        MediaContainer?: { Account?: { id?: number; name?: string }[] };
      }>(plexId, "/accounts", "read who watches, for Curator For You");
      const hit = (a.MediaContainer?.Account ?? []).find(
        (x) => x.id && x.name?.toLowerCase() === name.toLowerCase(),
      );
      return hit ? String(hit.id) : undefined;
    } catch {
      return undefined;
    }
  }

  private async machine(plexId: string): Promise<string | undefined> {
    try {
      const r = await this.deps.plexGet<{ MediaContainer?: { machineIdentifier?: string } }>(
        plexId,
        "/identity",
        "open titles in Plex, for Curator For You",
      );
      return r.MediaContainer?.machineIdentifier;
    } catch {
      return undefined;
    }
  }

  /** Ember rewords each reason, in her own voice; any line that strays from the facts is dropped. */
  private async voice(picks: ForYouPick[]) {
    if (!this.deps.ask || !picks.length) return;
    const facts = picks
      .map((p, n) => `${n + 1}. ${p.title}${p.year ? ` (${p.year})` : ""}: ${p.why}`)
      .join("\n");
    let text: string;
    try {
      text = await this.deps.ask(
        'You are Ember, a warm, funny homelab companion. Reword each numbered reason as one or two short sentences spoken straight to the owner as "you" (never a name), as a friend who knows their taste would say it. Vary how each one starts. Use only the facts given: no other numbers, dates, actors or plot details. Answer with JSON only: an array of strings, one per numbered item, in order.',
        `The suggestions are for the owner.\n${facts}`,
      );
    } catch {
      return;
    }
    let lines: unknown;
    try {
      lines = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    } catch {
      return;
    }
    if (!Array.isArray(lines)) return;
    picks.forEach((p, n) => {
      const line = lines[n];
      const own = `${p.title} ${p.year ?? ""} ${p.why}`;
      if (typeof line === "string" && voiceKept(line, own)) p.voice = line.trim();
    });
  }
}
