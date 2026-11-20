import { describe, expect, it } from "vitest";
import {
  ForYou,
  parseWatch,
  picksFor,
  saidBack,
  understood,
  type LibItem,
  type Play,
  type SeerrTitle,
} from "./for-you";

// Curator For You, 11-14 (the owner, via Flint): varied reasons and labels, More like this,
// Seen it with a rating, Not in your library from Seerr's own lists, and What should I watch?.

const DAY = 86_400;
const NOW = Date.UTC(2026, 10, 14) / 1000;
const item = (
  key: string,
  title: string,
  genres: string[],
  extra: Partial<LibItem> = {},
): LibItem => ({
  key,
  title,
  type: "movie",
  genres,
  addedAt: NOW - 900 * DAY,
  library: "Movies",
  ...extra,
});
const play = (key: string, title: string, daysAgo: number, type: "movie" | "show" = "movie") =>
  ({ key, title, type, at: NOW - daysAgo * DAY, complete: 100 }) as Play;

// The owner's shape on the home server: two comedies watched episode after episode, and a few films.
const LIB: LibItem[] = [
  item("g", "The Goldbergs", ["Comedy"], { type: "show", library: "TV Shows" }),
  item("h", "Ghosts", ["Comedy", "Fantasy"], { type: "show", library: "TV Shows" }),
  item("a", "Anchorman", ["Comedy"], { tmdb: 8699, minutes: 94 }),
  item("b", "Bad Boys", ["Action", "Comedy", "Crime"], { tmdb: 9737, minutes: 119 }),
  item("i", "Interstellar", ["Science Fiction", "Drama"], { tmdb: 157336, minutes: 169 }),
  item("d", "Die Hard", ["Action", "Thriller"], { tmdb: 562, minutes: 132 }),
  item("1", "Step Brothers", ["Comedy"], { minutes: 98 }),
  item("2", "Hot Fuzz", ["Action", "Comedy", "Crime"], { minutes: 121 }),
  item("3", "Arrival", ["Science Fiction", "Drama"], { minutes: 116 }),
  item("4", "Speed", ["Action", "Thriller"], { minutes: 116 }),
  item("5", "Superbad", ["Comedy"], { minutes: 113, addedAt: NOW - 10 * DAY }),
  item("6", "The Martian", ["Science Fiction", "Drama", "Comedy"], { minutes: 144 }),
  item("7", "Lethal Weapon", ["Action", "Crime"], { minutes: 110 }),
  item("8", "What We Do in the Shadows", ["Comedy", "Fantasy"], {
    type: "show",
    library: "TV Shows",
  }),
  // More than one screen of picks, so a card's place can be filled.
  ...Array.from({ length: 10 }, (_, n) =>
    item(`x${n}`, `Spare Comedy ${n}`, ["Comedy", n % 2 ? "Crime" : "Romance"], { minutes: 100 }),
  ),
];
const PLAYS: Play[] = [
  ...Array.from({ length: 40 }, (_, n) => play("g", "The Goldbergs", 2 + n, "show")),
  ...Array.from({ length: 30 }, (_, n) => play("h", "Ghosts", 3 + n, "show")),
  play("a", "Anchorman", 20),
  play("b", "Bad Boys", 60),
  play("i", "Interstellar", 120),
  play("d", "Die Hard", 200),
];

describe("For You picks draw on everything you finished (11-14 bug)", () => {
  it("reasons name different titles you finished, and the labels are mixed", () => {
    const { picks } = picksFor("Alex", PLAYS, LIB, { now: NOW });
    const named = new Set(
      picks.flatMap((p) =>
        LIB.filter((i) => p.why.includes(i.title) && PLAYS.some((x) => x.key === i.key)).map(
          (i) => i.title,
        ),
      ),
    );
    // Not just the two shows watched most.
    expect(named.size).toBeGreaterThanOrEqual(4);
    for (const t of named)
      expect(picks.filter((p) => p.why.includes(t)).length).toBeLessThanOrEqual(2);
    const kinds = new Set(picks.map((p) => p.kind));
    expect(kinds.has("revisit")).toBe(true);
    expect(kinds.has("fresh")).toBe(true);
    expect(kinds.has("gem")).toBe(true);
    // A sci-fi pick is never backed by a sitcom.
    for (const p of picks.filter((x) => x.genres.includes("Science Fiction")))
      expect(p.why).not.toMatch(/Goldbergs|Ghosts/);
  });

  it("Seen it ratings steer the picks: a loved title's kind comes first, a seen one never again", () => {
    const rated = [
      { kind: "movie", title: "Speed", rating: { stars: 5 } },
      { kind: "movie", title: "Step Brothers", rating: { reaction: "horrible" } },
    ];
    const { picks } = picksFor("Alex", PLAYS, LIB, { now: NOW, rated });
    expect(picks.map((p) => p.title)).not.toContain("Speed");
    expect(picks.map((p) => p.title)).not.toContain("Step Brothers");
  });

  it("More like this starts from one title and says so in each reason", () => {
    const anchorman = LIB.find((i) => i.key === "a")!;
    const { picks } = picksFor("Alex", PLAYS, LIB, {
      now: NOW,
      seed: { key: "a", title: anchorman.title, genres: anchorman.genres },
    });
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((p) => p.kind === "like" && p.genres.includes("Comedy"))).toBe(true);
    expect(picks.every((p) => p.why.includes("Anchorman"))).toBe(true);
    expect(picks.map((p) => p.title)).not.toContain("Anchorman");
  });
});

describe("What should I watch? (plain filters, no AI)", () => {
  it("understands genre words, length, decades and like <title>", () => {
    const f = parseWatch("something funny under 2 hours");
    expect(f.genres).toEqual(["Comedy"]);
    expect(f.maxMinutes).toBe(120);
    expect(understood(f)).toBe(true);
    expect(saidBack(f)).toBe("Comedy, under 2 h");
    expect(parseWatch("like Bad Boys").like).toBe("bad boys");
    expect(parseWatch("an 80s action movie")).toMatchObject({
      fromYear: 1980,
      toYear: 1989,
      type: "movie",
      genres: ["Action", "Action/Adventure"],
    });
    expect(parseWatch("a scary show from 2015")).toMatchObject({
      genres: ["Horror"],
      type: "show",
      fromYear: 2015,
    });
    // Nothing plain in it: this one goes to Ember.
    const vague = parseWatch("something that feels like a rainy Sunday");
    expect(vague.like).toBe("a rainy sunday");
  });

  it("filters keep only titles that fit", () => {
    const { picks } = picksFor("Alex", PLAYS, LIB, {
      now: NOW,
      filters: parseWatch("funny under 2 hours"),
    });
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      expect(p.genres).toContain("Comedy");
      expect(p.minutes).toBeLessThanOrEqual(120);
    }
  });
});

/* ---------- The service, with a stand-in Plex and Seerr ---------- */

const store = () => {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    del: async (k: string) => void m.delete(k),
  };
};

const plexGet = async <T>(_id: string, path: string): Promise<T> => {
  if (path === "/library/sections")
    return {
      MediaContainer: {
        Directory: [
          { key: "1", type: "movie", title: "Movies" },
          { key: "2", type: "show", title: "TV Shows" },
        ],
      },
    } as T;
  if (path.startsWith("/library/sections/")) {
    const type = path.startsWith("/library/sections/1/") ? "movie" : "show";
    return {
      MediaContainer: {
        Metadata: LIB.filter((i) => i.type === type).map((i) => ({
          ratingKey: i.key,
          title: i.title,
          addedAt: i.addedAt,
          ...(i.minutes ? { duration: i.minutes * 60_000 } : {}),
          Genre: i.genres.map((tag) => ({ tag })),
          ...(i.tmdb ? { Guid: [{ id: `tmdb://${i.tmdb}` }] } : {}),
        })),
      },
    } as T;
  }
  if (path === "/identity") return { MediaContainer: { machineIdentifier: "abc" } } as T;
  if (path === "/accounts") return { MediaContainer: { Account: [{ id: 1, name: "Alex" }] } } as T;
  if (path.startsWith("/status/sessions/history/all"))
    return {
      MediaContainer: {
        Metadata: PLAYS.map((p) => ({
          ...(p.type === "movie"
            ? { ratingKey: p.key, title: p.title, type: "movie" }
            : {
                grandparentKey: `/library/metadata/${p.key}`,
                grandparentTitle: p.title,
                type: "episode",
              }),
          viewedAt: p.at,
          accountID: 1,
        })),
      },
    } as T;
  throw new Error(`unexpected ${path}`);
};

const film = (tmdbId: number, title: string, status = "not requested", genres = ["Comedy"]) =>
  ({
    tmdbId,
    mediaType: "movie",
    title,
    year: 2010,
    poster: `/p${tmdbId}.jpg`,
    status,
    genres,
  }) as SeerrTitle;

function service(extra: Partial<ConstructorParameters<typeof ForYou>[0]> = {}) {
  const asked: number[] = [];
  const marked: unknown[] = [];
  const f = new ForYou({
    servers: async () => ({ plex: { id: "plex", name: "Plex" } }),
    plexGet,
    tautulliGet: async () => ({}) as never,
    store: store(),
    now: () => NOW * 1000,
    seerr: async () => ({ id: "seerr" }),
    similar: async (_id, _type, tmdbId) => {
      asked.push(tmdbId);
      if (tmdbId === 8699)
        return [
          film(1, "Talladega Nights"),
          film(2, "Step Brothers"), // In your Plex: left out.
          film(3, "The Other Guys", "requested"),
          film(4, "Zoolander", "available"), // Seerr says you have it: left out.
          ...Array.from({ length: 12 }, (_, n) => film(100 + n, `Comedy ${n}`)),
        ];
      return [film(tmdbId + 1, `Like ${tmdbId}`, "not requested", ["Action"])];
    },
    seerrSearch: async () => [film(9737, "Bad Boys", "available", ["Action", "Comedy", "Crime"])],
    markSeen: async (e) => {
      marked.push(e);
      return { markWatched: [{ step: "app-plex-control" }] };
    },
    ...extra,
  });
  return { f, asked, marked };
}

describe("Not in your library: Seerr's own lists, no AI", () => {
  it("starts from what you finished lately, in turns, leaving out what you have", async () => {
    const { f, asked } = service();
    const r = await f.forPerson("p:1");
    // Films with a TMDB id you finished, newest first (the shows have none here).
    expect(asked).toEqual([8699, 9737, 157336, 562]);
    const titles = r.missing.map((m) => m.title);
    expect(titles[0]).toBe("Talladega Nights");
    expect(titles).not.toContain("Step Brothers");
    expect(titles).not.toContain("Zoolander");
    // One from each favourite in turn, so no single one fills the section.
    expect(titles.slice(1, 4)).toEqual(["Like 9737", "Like 157336", "Like 562"]);
    expect(r.missing.find((m) => m.title === "The Other Guys")?.requested).toBe(true);
    expect(r.missing[0]!.why).toBe("Because you finished Anchorman.");
    expect(r.missing[0]!.image).toBe("/api/services/seerr/dashboard/poster?path=%2Fp1.jpg");
    expect(r.missing.length).toBe(8);
    expect(r.seerr).toBe("seerr");
  });

  it("a kept list is made again when another Seerr took the old one's place", async () => {
    let id = "seerr";
    const { f, asked } = service({ seerr: async () => ({ id }) });
    expect((await f.forPerson("p:1")).seerr).toBe("seerr");
    const before = asked.length;
    // Kept while nothing changed.
    expect((await f.forPerson("p:1")).seerr).toBe("seerr");
    expect(asked.length).toBe(before);
    id = "seerr-2";
    expect((await f.forPerson("p:1")).seerr).toBe("seerr-2");
    expect(asked.length).toBeGreaterThan(before);
  });

  it("says why it is empty without Seerr", async () => {
    const { f } = service({ seerr: async () => undefined });
    const r = await f.forPerson("p:1");
    expect(r.missing).toEqual([]);
    expect(r.missingNote).toContain("Connect Seerr");
  });
});

describe("the buttons on a card", () => {
  it("Not for me and Seen it each bring the next pick in its place", async () => {
    const { f, marked } = service();
    const r = await f.forPerson("p:1");
    const first = r.picks.find((p) => p.kind !== "revisit")!;
    const h = await f.hide("p:1", first.key);
    expect(h.pick).toBeDefined();
    expect(h.pick!.key).not.toBe(first.key);
    const kept = await f.forPerson("p:1");
    expect(kept.picks.map((p) => p.key)).not.toContain(first.key);
    expect(kept.picks.map((p) => p.key)).toContain(h.pick!.key);

    const next = kept.picks.find((p) => p.kind !== "revisit")!;
    const s = await f.seen("p:1", next.key, { stars: 4 });
    expect(marked).toEqual([
      expect.objectContaining({ kind: next.type, title: next.title, rating: { stars: 4 } }),
    ]);
    expect(s.markWatched).toHaveLength(1);
    expect(s.pick).toBeDefined();

    // A missing title hidden: the next missing one comes in.
    const m = kept.missing[0]!;
    const hm = await f.hide("p:1", m.key);
    expect(hm.missing?.key).toBeDefined();
    expect((await f.forPerson("p:1")).missing.map((x) => x.key)).not.toContain(m.key);
  });

  it("More like this on one of yours, and on a missing one, says what it started from", async () => {
    const { f, asked } = service();
    const r = await f.forPerson("p:1", false, { key: "a" });
    expect(r.seed).toBe("Anchorman");
    expect(r.picks.every((p) => p.why.includes("Anchorman"))).toBe(true);
    expect(asked).toEqual([8699]);
    expect(r.missing[0]!.why).toMatch(/Anchorman/);
    const m = await f.forPerson("p:1", false, {
      tmdb: "movie:1",
      title: "Talladega Nights",
      genres: ["Comedy"],
    });
    expect(m.seed).toBe("Talladega Nights");
    expect(m.picks.length).toBeGreaterThan(0);
    // A seeded list is never kept as the main one.
    expect((await f.forPerson("p:1")).seed).toBeUndefined();
  });
});

describe("What should I watch? end to end", () => {
  it("plain filters and like <title> need no AI; a vague ask goes to Ember with titles only", async () => {
    const vagueAsks: string[] = [];
    const { f } = service({
      vague: async (text) => {
        vagueAsks.push(text);
        return [
          { key: "movie:9", title: "Step Brothers", why: "Silly and warm.", have: true },
          { key: "movie:77", title: "Paddington 2", year: 2017, why: "Pure comfort." },
        ];
      },
    });
    const funny = await f.search("p:1", "something funny under 2 hours");
    expect(funny.said).toBe("Comedy, under 2 h");
    expect(funny.picks.every((p) => p.genres.includes("Comedy"))).toBe(true);
    const like = await f.search("p:1", "like Bad Boys");
    expect(like.seed).toBe("Bad Boys");
    expect(like.said).toBe("like Bad Boys");
    expect(vagueAsks).toEqual([]);

    const cozy = await f.search("p:1", "cozy rainy day vibes");
    expect(vagueAsks).toEqual(["cozy rainy day vibes"]);
    expect(cozy.picks.map((p) => p.title)).toEqual(["Step Brothers"]);
    expect(cozy.picks[0]!.open).toContain("/server/abc/details");
    expect(cozy.missing.map((m) => m.title)).toEqual(["Paddington 2"]);
  });
});
