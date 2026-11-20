import { describe, expect, it } from "vitest";
import { ForYou, picksFor, voiceKept, type LibItem, type Play } from "./for-you";

const DAY = 86_400;
const NOW = Date.UTC(2026, 10, 13) / 1000;
const item = (key: string, title: string, genres: string[], addedDaysAgo = 900): LibItem => ({
  key,
  title,
  type: "movie",
  genres,
  addedAt: NOW - addedDaysAgo * DAY,
  library: "Movies",
});
const LIB = [
  item("1", "Hot Tub Time Machine", ["Comedy", "Science Fiction"]),
  item("2", "Dodgeball", ["Comedy", "Sport"]),
  item("3", "Out Cold", ["Comedy", "Sport"]),
  item("4", "The Notebook", ["Romance", "Drama"]),
  item("5", "Back to the Future", ["Comedy", "Science Fiction"]),
];
const play = (key: string, title: string, daysAgo: number, complete = 100): Play => ({
  key,
  title,
  type: "movie",
  at: NOW - daysAgo * DAY,
  complete,
});

describe("Curator For You (11-13): picks from what each person really watched", () => {
  it("finds a hidden gem they never played, says why from Hearth's records, and skips what doesn't suit", () => {
    const plays = [
      play("1", "Hot Tub Time Machine", 30),
      play("1", "Hot Tub Time Machine", 100),
      play("1", "Hot Tub Time Machine", 200),
      play("2", "Dodgeball", 40),
      play("2", "Dodgeball", 500),
    ];
    const { picks, top, loved } = picksFor("Alex", plays, LIB, { now: NOW });
    const gems = picks.filter((p) => p.kind === "gem").map((p) => p.title);
    expect(gems.slice(0, 2).sort()).toEqual(["Back to the Future", "Out Cold"]);
    // Nothing they show any taste for is suggested.
    expect(gems).not.toContain("The Notebook");
    const outCold = picks.find((p) => p.title === "Out Cold")!;
    expect(outCold.why).toMatch(/2024/);
    expect(outCold.why).not.toContain("Alex");
    expect(outCold.why).toMatch(/(Hot Tub Time Machine|Dodgeball)/);
    expect(top[0]).toBe("Comedy");
    expect(loved[0]).toBe("Hot Tub Time Machine");
  });

  it("offers a finished favourite not watched in over a year, never one watched lately", () => {
    const plays = [
      play("4", "The Notebook", 800),
      play("4", "The Notebook", 900),
      play("2", "Dodgeball", 10),
    ];
    const { picks } = picksFor("Sam", plays, LIB, { now: NOW });
    const revisit = picks.filter((p) => p.kind === "revisit");
    expect(revisit.map((p) => p.title)).toEqual(["The Notebook"]);
    expect(revisit[0]!.why).toMatch(/^You watched it 2 times, last in /);
  });

  it("mixes the top genres and puts favourites among the gems, with varied reasons", () => {
    const lib = [
      ...Array.from({ length: 6 }, (_, n) => item(`c${n}`, `Comedy ${n}`, ["Comedy"])),
      ...Array.from({ length: 6 }, (_, n) => item(`d${n}`, `Drama ${n}`, ["Drama"])),
      ...Array.from({ length: 6 }, (_, n) => item(`a${n}`, `Action ${n}`, ["Action"])),
      item("w", "Watched Comedy", ["Comedy"]),
      item("v", "Old Drama", ["Drama"]),
      item("x", "Watched Action", ["Action"]),
    ];
    const plays = [
      play("w", "Watched Comedy", 20),
      play("w", "Watched Comedy", 25),
      play("w", "Watched Comedy", 30),
      play("v", "Old Drama", 400),
      play("v", "Old Drama", 420),
      play("x", "Watched Action", 200),
    ];
    const { picks } = picksFor("Alex", plays, lib, { now: NOW });
    const gems = picks.filter((p) => p.kind === "gem");
    const firstThree = gems.slice(0, 3).map((p) => p.genres[0]);
    expect(new Set(firstThree)).toEqual(new Set(["Comedy", "Drama", "Action"]));
    // A favourite worth revisiting among the first few, not only at the end.
    const at = picks.findIndex((p) => p.kind === "revisit");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(4);
    // The reasons don't all start the same way.
    expect(new Set(gems.map((p) => p.why.split(" ").slice(0, 3).join(" "))).size).toBeGreaterThan(
      2,
    );
    for (const p of picks) expect(p.why).not.toContain("Alex");
  });

  it("never suggests what was hidden for that person", () => {
    const plays = [play("2", "Dodgeball", 40)];
    const { picks } = picksFor("Alex", plays, LIB, { now: NOW, hidden: ["3"] });
    expect(picks.map((p) => p.key)).not.toContain("3");
  });

  it("keeps Ember's wording only when its numbers are Hearth's own", () => {
    const facts = "Out Cold 2001 In your Movies since 2022, and Alex has never played it.";
    expect(
      voiceKept("It's been in your Movies since 2022. Why haven't you watched it?", facts),
    ).toBe(true);
    expect(voiceKept("You've watched three comedies 14 times this month!", facts)).toBe(false);
  });
});

describe("Curator For You: whose history, and where from", () => {
  const store = () => {
    const m = new Map<string, unknown>();
    return {
      get: async <T>(k: string) => m.get(k) as T | undefined,
      set: async (k: string, v: unknown) => void m.set(k, v),
      del: async (k: string) => void m.delete(k),
      m,
    };
  };
  const plexGet = async <T>(_id: string, path: string): Promise<T> => {
    if (path === "/library/sections")
      return { MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Movies" }] } } as T;
    if (path.startsWith("/library/sections/1/all"))
      return {
        MediaContainer: {
          Metadata: LIB.map((i) => ({
            ratingKey: i.key,
            title: i.title,
            addedAt: i.addedAt,
            Genre: i.genres.map((tag) => ({ tag })),
          })),
        },
      } as T;
    if (path === "/identity") return { MediaContainer: { machineIdentifier: "abc" } } as T;
    if (path === "/accounts")
      return {
        MediaContainer: {
          Account: [
            { id: 1, name: "Alex" },
            { id: 2, name: "Sam" },
          ],
        },
      } as T;
    if (path.startsWith("/status/sessions/history/all"))
      return {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "2",
              title: "Dodgeball",
              type: "movie",
              viewedAt: NOW - 40 * DAY,
              accountID: 1,
            },
            // Another person's play, even if Plex ignored the filter: never mixed in.
            {
              ratingKey: "4",
              title: "The Notebook",
              type: "movie",
              viewedAt: NOW - 9 * DAY,
              accountID: 2,
            },
          ],
        },
      } as T;
    throw new Error(`unexpected ${path}`);
  };

  it("uses Tautulli when the lab has it, for the owner only", async () => {
    const s = store();
    const f = new ForYou({
      servers: async () => ({ plex: { id: "plex", name: "Plex" }, tautulli: { id: "tau" } }),
      plexGet,
      tautulliGet: async <T>(_id: string, cmd: string, p: Record<string, string | number>) => {
        if (cmd === "get_users_table")
          return {
            data: [
              { user_id: 8, friendly_name: "Sam", plays: 30 },
              { user_id: 7, friendly_name: "Alex", plays: 3, is_admin: 1 },
            ],
          } as T;
        expect(p.user_id).toBe("7");
        return {
          data: [
            {
              rating_key: 2,
              media_type: "movie",
              title: "Dodgeball",
              date: NOW - 5 * DAY,
              percent_complete: 100,
            },
          ],
        } as T;
      },
      store: s,
      now: () => NOW * 1000,
    });
    const { people, source } = await f.people();
    expect(source).toBe("Tautulli");
    expect(people.map((p) => p.name)).toEqual(["Alex"]);
    const r = await f.forPerson("t:7");
    expect(r.source).toBe("Tautulli");
    expect(r.picks[0]!.title).toBe("Out Cold");
    expect(r.picks[0]!.open).toContain("/server/abc/details");
  });

  it("falls back to Plex's own history without Tautulli, the owner's account only", async () => {
    const f = new ForYou({
      servers: async () => ({ plex: { id: "plex", name: "Plex" } }),
      plexGet,
      tautulliGet: async () => {
        throw new Error("no Tautulli");
      },
      store: store(),
      now: () => NOW * 1000,
    });
    const { people, source } = await f.people();
    expect(source).toBe("Plex");
    expect(people.map((p) => p.id)).toEqual(["p:1"]);
    const r = await f.forPerson("p:1");
    expect(r.taste).toContain("from 1 play in Plex");
    expect(r.picks.map((p) => p.title)).not.toContain("Dodgeball");
  });

  it("never reads anyone else's history: another person on the Plex is refused (11-13)", async () => {
    const seen: string[] = [];
    const f = new ForYou({
      servers: async () => ({ plex: { id: "plex", name: "Plex" } }),
      plexGet: async <T>(id: string, path: string) => {
        seen.push(path);
        return plexGet<T>(id, path);
      },
      tautulliGet: async () => ({}) as never,
      store: store(),
      now: () => NOW * 1000,
    });
    await expect(f.forPerson("p:2")).rejects.toThrow("That person isn't on your Plex.");
    expect(seen.some((x) => x.includes("accountID=2"))).toBe(false);
  });
});

describe("reasons draw on everything you finished (the owner, 11-14)", () => {
  // Two sitcoms watched episode after episode, and a few films: every reason used to name the
  // two sitcoms, and every label said Hidden gem.
  const at = (key: string, title: string, genres: string[], extra: Partial<LibItem> = {}) => ({
    ...item(key, title, genres),
    ...extra,
  });
  const lib: LibItem[] = [
    at("g", "The Goldbergs", ["Comedy"], { type: "show" }),
    at("h", "Ghosts", ["Comedy", "Fantasy"], { type: "show" }),
    at("a", "Anchorman", ["Comedy"]),
    at("b", "Bad Boys", ["Action", "Comedy", "Crime"]),
    at("i", "Interstellar", ["Science Fiction", "Drama"]),
    at("d", "Die Hard", ["Action", "Thriller"]),
    at("1", "Step Brothers", ["Comedy"]),
    at("2", "Hot Fuzz", ["Action", "Comedy", "Crime"]),
    at("3", "Arrival", ["Science Fiction", "Drama"]),
    at("4", "Speed", ["Action", "Thriller"]),
    at("5", "Superbad", ["Comedy"], { addedAt: NOW - 10 * DAY }),
    at("6", "The Martian", ["Science Fiction", "Drama", "Comedy"]),
  ];
  const ep = (key: string, title: string, daysAgo: number): Play => ({
    ...play(key, title, daysAgo),
    type: "show",
  });
  const plays: Play[] = [
    ...Array.from({ length: 40 }, (_, n) => ep("g", "The Goldbergs", 2 + n)),
    ...Array.from({ length: 30 }, (_, n) => ep("h", "Ghosts", 3 + n)),
    play("a", "Anchorman", 20),
    play("b", "Bad Boys", 60),
    play("i", "Interstellar", 120),
    play("d", "Die Hard", 200),
  ];

  it("names different titles you finished, and mixes the labels", () => {
    const { picks } = picksFor("Alex", plays, lib, { now: NOW });
    const finished = [
      "The Goldbergs",
      "Ghosts",
      "Anchorman",
      "Bad Boys",
      "Interstellar",
      "Die Hard",
    ];
    const named = finished.filter((t) => picks.some((p) => p.why.includes(t)));
    expect(named.length).toBeGreaterThanOrEqual(4);
    for (const t of named)
      expect(picks.filter((p) => p.why.includes(t)).length).toBeLessThanOrEqual(2);
    const kinds = new Set(picks.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(["fresh", "gem", "revisit"]);
    for (const p of picks.filter((x) => x.genres.includes("Science Fiction")))
      expect(p.why).not.toMatch(/Goldbergs|Ghosts/);
  });
});
