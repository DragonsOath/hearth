import { describe, expect, it } from "vitest";
import type { Call } from "../apps/release-search";
import {
  parseSuggestions,
  Recommend,
  recommendPrompt,
  sameTitle,
  type RecommendDeps,
  type SeerrHit,
  type ServerHit,
} from "./service";
import type { RecommendSeen } from "@dragon-control/core";

// Recommend, Discover (checklist 48.1): Ember suggests, Hearth checks each title is real and
// whether you have it, and offers the right request for the rest.

const answer = (list: unknown[]) => `Here you go:\n${JSON.stringify(list)}\nEnjoy!`;

function deps(over: Partial<RecommendDeps> & { said?: object[] } = {}): RecommendDeps & {
  asked: { system: string; prompt: string }[];
} {
  const asked: { system: string; prompt: string }[] = [];
  return {
    asked,
    ask: async (system, prompt) => {
      asked.push({ system, prompt });
      return answer(over.said ?? []);
    },
    service: async (app) => ({ id: `${app}-1`, name: app === "seerr" ? "Seerr" : app }),
    seerrSearch: async () => [],
    arr: async () => {
      throw new Error("no arr in this test");
    },
    seen: memorySeen(),
    onServers: async () => [],
    ...over,
  };
}

function memorySeen(start: (RecommendSeen & { at: string })[] = []) {
  let all = start;
  return {
    list: async () => all,
    save: async (next: typeof all) => {
      all = next;
    },
  };
}

describe("reading Ember's list", () => {
  it("takes the JSON array out of the answer and drops bad or repeated entries", () => {
    const got = parseSuggestions(
      answer([
        { title: "Elf", year: 2003, creator: "Alex Favreau", why: "Pure joy." },
        { title: "elf", year: 2003, why: "again" },
        { title: "", why: "no title" },
        { title: "Krampus", year: "soon", why: "Dark fun." },
        "not an object",
      ]),
    );
    expect(got).toEqual([
      { title: "Elf", year: 2003, creator: "Alex Favreau", why: "Pure joy." },
      { title: "Krampus", why: "Dark fun." },
    ]);
    expect(parseSuggestions("no list at all")).toEqual([]);
  });

  it("matches titles loosely: case, punctuation, a leading The, a subtitle", () => {
    expect(sameTitle("The Holiday", "holiday")).toBe(true);
    expect(sameTitle("Alien: Romulus", "Alien")).toBe(true);
    expect(sameTitle("Home Alone", "Home Alone 2: Lost in New York")).toBe(true);
    expect(sameTitle("Elf", "Elvis")).toBe(false);
  });

  it("tells Ember only what you typed and your filters, never your library", () => {
    const { system, prompt } = recommendPrompt({
      kind: "movie",
      interest: "Christmas comedies",
      filters: { fromYear: 1980, toYear: 1999, genres: ["Comedy"], minRating: 7, length: "short" },
      exclude: ["Elf"],
    });
    expect(system).toMatch(/JSON only/);
    expect(prompt).toContain("Christmas comedies");
    expect(prompt).toContain("from 1980 up to 1999");
    expect(prompt).toContain("Genres: Comedy");
    expect(prompt).toContain("7/10");
    expect(prompt).toContain("Under 90 minutes");
    expect(prompt).toContain("Elf");
  });
});

describe("movies and shows, through Seerr", () => {
  const hits: Record<string, SeerrHit[]> = {
    Elf: [
      {
        tmdbId: 10719,
        mediaType: "movie",
        title: "Elf",
        year: 2003,
        poster: "/elf.jpg",
        status: "not requested",
      },
    ],
    "Home Alone": [
      { tmdbId: 771, mediaType: "movie", title: "Home Alone", year: 1990, status: "available" },
    ],
    Krampus: [
      { tmdbId: 287903, mediaType: "movie", title: "Krampus", year: 2015, status: "pending" },
    ],
    "Jingle All the Way": [
      // Same title, but a TV special and another year: not the one Ember meant.
      {
        tmdbId: 5,
        mediaType: "tv",
        title: "Jingle All the Way",
        year: 2014,
        status: "not requested",
      },
    ],
  };
  const said = [
    { title: "Elf", year: 2003, why: "Pure joy." },
    { title: "Home Alone", year: 1990, why: "A classic." },
    { title: "Krampus", year: 2015, why: "Dark fun." },
    { title: "Jingle All the Way", year: 1996, why: "Arnold." },
    { title: "The Christmas That Never Was", year: 1987, why: "Made up." },
  ];

  it("hides what you have, keeps requested ones marked, drops what doesn't exist", async () => {
    const d = deps({ said, seerrSearch: async (_id, q) => hits[q] ?? [] });
    const r = await new Recommend(d).find({ kind: "movie", interest: "Christmas movies" });
    expect(r.items.map((i) => i.title)).toEqual(["Elf", "Krampus"]);
    expect(r.items[0]).toMatchObject({
      key: "movie:10719",
      image: "/api/services/seerr-1/dashboard/poster?path=%2Felf.jpg",
      request: {
        kind: "plan",
        step: "app-seerr-request",
        params: { mediaType: "movie", tmdbId: 10719 },
      },
    });
    expect(r.items[1]).toMatchObject({ requested: true });
    expect(r.items[1]!.request).toBeUndefined();
    expect(r.owned).toEqual([{ title: "Home Alone", year: 1990 }]);
    expect(r.unverified).toEqual(["Jingle All the Way", "The Christmas That Never Was"]);
  });

  it("asks the library itself: Seerr can say 'deleted' for a film that is in Plex", async () => {
    const d = deps({
      said: [{ title: "Groundhog Day", year: 1993, why: "The classic." }],
      seerrSearch: async () => [
        { tmdbId: 137, mediaType: "movie", title: "Groundhog Day", year: 1993, status: "deleted" },
      ],
      inLibrary: async (kind, title, year) =>
        kind === "movie" && title === "Groundhog Day" && year === 1993,
    });
    const r = await new Recommend(d).find({ kind: "movie", interest: "time loops" });
    expect(r.items).toEqual([]);
    expect(r.owned).toEqual([{ title: "Groundhog Day", year: 1993 }]);
  });

  it("asked for both: what you have is shown, marked, instead of hidden", async () => {
    const d = deps({ said, seerrSearch: async (_id, q) => hits[q] ?? [] });
    const r = await new Recommend(d).find({ kind: "movie", interest: "x mas", show: "both" });
    expect(r.items.map((i) => [i.title, Boolean(i.have)])).toEqual([
      ["Elf", false],
      ["Home Alone", true],
      ["Krampus", false],
    ]);
    expect(r.items[1]!.request).toBeUndefined();
    expect(r.owned).toEqual([]);
  });

  it("what you've seen is never suggested again, and Ember is told so", async () => {
    const d = deps({
      said,
      seerrSearch: async (_id, q) => hits[q] ?? [],
      seen: memorySeen([{ kind: "movie", title: "Elf", year: 2003, at: "2026-11-09" }]),
    });
    const r = await new Recommend(d).find({ kind: "movie", interest: "Christmas movies" });
    expect(r.items.map((i) => i.title)).toEqual(["Krampus"]);
    expect(d.asked[0]!.prompt).toContain("Elf");
  });

  it("says plainly when the app that checks and requests isn't connected", async () => {
    const d = deps({ said, service: async () => undefined });
    const r = await new Recommend(d).find({ kind: "show", interest: "cozy mysteries" });
    expect(r.items).toEqual([]);
    expect(r.missingApp).toMatch(/needs Seerr/);
    expect(d.asked).toHaveLength(0);
  });
});

/** A stand-in for Lidarr or Chaptarr's API, by path. */
const fakeCall =
  (routes: Record<string, unknown>): Call =>
  async <T>(_m: "GET" | "POST", path: string) => {
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    return {
      ok: Boolean(key),
      status: key ? 200 : 404,
      data: (key ? routes[key] : undefined) as T,
    };
  };

describe("music, through Lidarr", () => {
  it("adds a missing artist with the library's own profiles and folder, as a plan", async () => {
    const d = deps({
      said: [
        { title: "Khruangbin", why: "Laid-back grooves." },
        { title: "Radiohead", why: "Already loved." },
      ],
      arr: async (_id, _p, fn) =>
        fn(
          fakeCall({
            "/api/v1/artist/lookup?term=Khruangbin": [
              { foreignArtistId: "8bb7cda2-0000-4000-8000-000000000001", artistName: "Khruangbin" },
            ],
            "/api/v1/artist/lookup?term=Radiohead": [
              { foreignArtistId: "a74b1b7f-0000-4000-8000-000000000002", artistName: "Radiohead" },
            ],
            "/api/v1/artist": [
              { foreignArtistId: "a74b1b7f-0000-4000-8000-000000000002", artistName: "Radiohead" },
            ],
            "/api/v1/qualityprofile": [{ id: 3 }],
            "/api/v1/metadataprofile": [{ id: 7 }],
            "/api/v1/rootfolder": [{ path: "/music" }],
          }),
          "http://lidarr",
        ),
    });
    const r = await new Recommend(d).find({ kind: "music", interest: "chill instrumental" });
    expect(r.owned).toEqual([{ title: "Radiohead" }]);
    expect(r.items).toHaveLength(1);
    const req = r.items[0]!.request!;
    expect(req).toMatchObject({ kind: "plan", step: "app-arr-create", serviceId: "lidarr-1" });
    if (req.kind !== "plan") throw new Error("expected a plan");
    expect(JSON.parse(String(req.params.body))).toMatchObject({
      foreignArtistId: "8bb7cda2-0000-4000-8000-000000000001",
      rootFolderPath: "/music",
      qualityProfileId: 3,
      metadataProfileId: 7,
    });
  });
});

describe("books and audiobooks, through Chaptarr", () => {
  const lib = [
    // Owned as an audiobook (has a file), wanted as an ebook (no file yet).
    {
      title: "Project Hail Mary",
      foreignBookId: "1",
      mediaType: "audiobook",
      author: { authorName: "Andy Weir" },
      statistics: { bookFileCount: 1 },
    },
    {
      id: 12,
      title: "Dune",
      foreignBookId: "2",
      mediaType: "ebook",
      monitored: true,
      author: { authorName: "Frank Herbert" },
      statistics: { bookFileCount: 0 },
    },
    // In Chaptarr but not wanted (a new author's other books): not "requested".
    {
      id: 13,
      title: "Project Hail Mary",
      foreignBookId: "9",
      mediaType: "ebook",
      monitored: false,
      author: { authorName: "Andy Weir" },
      statistics: { bookFileCount: 0 },
    },
  ];
  const look = {
    "/api/v1/book/lookup?term=The%20Martian": [
      {
        title: "The Martian",
        foreignBookId: "3",
        mediaType: "audiobook",
        releaseDate: "2014-02-11",
        author: { authorName: "Andy Weir" },
      },
    ],
  };
  const arr: RecommendDeps["arr"] = async (_id, _p, fn) =>
    fn(fakeCall({ ...look, "/api/v1/book": lib }), "http://chaptarr.home");

  it("hides an audiobook you have, and opens Chaptarr's add page for one you don't", async () => {
    const d = deps({
      said: [
        { title: "Project Hail Mary", creator: "Andy Weir", why: "Same voice you liked." },
        { title: "The Martian", why: "Funny survival." },
      ],
      arr,
    });
    const r = await new Recommend(d).find({ kind: "audiobook", interest: "funny sci-fi" });
    expect(r.owned).toEqual([{ title: "Project Hail Mary" }]);
    expect(r.items).toEqual([
      expect.objectContaining({
        kind: "audiobook",
        title: "The Martian",
        year: 2014,
        creator: "Andy Weir",
        request: {
          kind: "open",
          url: "http://chaptarr.home/add/search?term=The%20Martian%20Andy%20Weir",
          label: "Add in Chaptarr",
        },
      }),
    ]);
  });

  it("a book Chaptarr already wants (no file yet) is shown as requested", async () => {
    const d = deps({
      said: [{ title: "Dune", creator: "Frank Herbert", why: "The classic." }],
      arr,
    });
    const r = await new Recommend(d).find({ kind: "book", interest: "epic sci-fi" });
    expect(r.items).toEqual([expect.objectContaining({ title: "Dune", requested: true })]);
  });

  it("a book in Chaptarr it doesn't want is offered as a request (want it and search), not shown as requested", async () => {
    const d = deps({
      said: [{ title: "Project Hail Mary", creator: "Andy Weir", why: "Funny science." }],
      arr,
    });
    const r = await new Recommend(d).find({ kind: "book", interest: "funny sci-fi" });
    expect(r.items[0]).not.toHaveProperty("requested");
    expect(r.items[0]!.request).toMatchObject({
      kind: "plan",
      step: "app-chaptarr-control",
      params: { op: "request", itemId: 13 },
    });
  });
});

describe("Seen it", () => {
  const servers: ServerHit[] = [
    {
      serviceId: "plex-1",
      server: "Plex",
      app: "plex",
      id: "501",
      title: "Elf",
      year: 2003,
      watched: false,
    },
    // Another film with the same name, years apart: not the one you saw.
    {
      serviceId: "plex-1",
      server: "Plex",
      app: "plex",
      id: "777",
      title: "Elf",
      year: 2023,
      watched: false,
    },
    {
      serviceId: "jf-1",
      server: "Jellyfin",
      app: "jellyfin",
      id: "abc",
      title: "Elf",
      year: 2003,
      watched: true,
    },
  ];

  it("is remembered at once; marking it watched is only offered, where it isn't yet", async () => {
    const seen = memorySeen();
    const r = new Recommend(deps({ seen, onServers: async () => servers }));
    const out = await r.markSeen({ kind: "movie", title: "Elf", year: 2003 });
    expect(out.markWatched).toEqual([
      {
        serviceId: "plex-1",
        server: "Plex",
        title: "Elf (2003)",
        does: "watched",
        step: "app-plex-control",
        params: { op: "watched", ratingKey: "501" },
      },
    ]);
    expect((await seen.list()).map((s) => s.title)).toEqual(["Elf"]);
    // Twice is still once.
    await r.markSeen({ kind: "movie", title: "elf", year: 2003 });
    expect(await seen.list()).toHaveLength(1);
  });

  it("books and music are only remembered, and undo forgets", async () => {
    const seen = memorySeen();
    let looked = false;
    const r = new Recommend(
      deps({
        seen,
        onServers: async () => {
          looked = true;
          return [];
        },
      }),
    );
    expect(await r.markSeen({ kind: "book", title: "Dune" })).toEqual({ markWatched: [] });
    expect(looked).toBe(false);
    await r.unmarkSeen({ kind: "book", title: "Dune" });
    expect(await seen.list()).toEqual([]);
  });
});

describe("Seen it, with a rating", () => {
  it("keeps your rating and words, and offers Plex's stars and Jellyfin's like", async () => {
    const seen = memorySeen();
    const r = new Recommend(
      deps({
        seen,
        onServers: async () => [
          {
            serviceId: "plex-1",
            server: "Plex",
            app: "plex",
            id: "501",
            title: "Elf",
            year: 2003,
            watched: true,
          },
          {
            serviceId: "jf-1",
            server: "Jellyfin",
            app: "jellyfin",
            id: "abc",
            title: "Elf",
            year: 2003,
            watched: false,
          },
        ],
      }),
    );
    const out = await r.markSeen({
      kind: "movie",
      title: "Elf",
      year: 2003,
      rating: { stars: 5, reaction: "loved", note: "  Every December.  " },
    });
    // Plex: already watched, so only the stars; Jellyfin: watched, then a like and Favorite.
    expect(out.markWatched.map((m) => [m.server, m.does, m.params])).toEqual([
      ["Plex", "rating", { op: "rate", ratingKey: "501", stars: "5" }],
      ["Jellyfin", "watched", { op: "watched", itemId: "abc" }],
      ["Jellyfin", "rating", { op: "like", itemId: "abc", liked: "true", favorite: "true" }],
    ]);
    expect((await seen.list())[0]!.rating).toEqual({
      stars: 5,
      reaction: "loved",
      note: "Every December.",
    });
  });

  it("an empty rating is no rating, and nothing is offered but watched", async () => {
    const seen = memorySeen();
    const r = new Recommend(
      deps({
        seen,
        onServers: async () => [
          {
            serviceId: "plex-1",
            server: "Plex",
            app: "plex",
            id: "501",
            title: "Elf",
            year: 2003,
            watched: false,
          },
        ],
      }),
    );
    const out = await r.markSeen({
      kind: "movie",
      title: "Elf",
      year: 2003,
      rating: { note: " " },
    });
    expect(out.markWatched.map((m) => m.does)).toEqual(["watched"]);
    expect((await seen.list())[0]!.rating).toBeUndefined();
  });
});

describe("in my library", () => {
  const lib = [
    { title: "Groundhog Day", year: 1993, genres: ["Comedy"], image: "/art/1" },
    { title: "Palm Springs", year: 2020, genres: ["Comedy", "Romance"] },
    { title: "Edge of Tomorrow", year: 2014, genres: ["Action"] },
  ];

  it("Ember picks only from your titles; anything else is left out", async () => {
    const d = deps({
      library: async () => lib,
      said: [
        { title: "Groundhog Day", year: 1993, why: "The classic." },
        { title: "Happy Death Day", year: 2017, why: "Not owned." },
      ],
    });
    const r = await new Recommend(d).find({
      kind: "movie",
      interest: "time loops",
      show: "have",
      filters: { genres: ["Comedy"] },
    });
    expect(r.items).toEqual([
      expect.objectContaining({ title: "Groundhog Day", have: true, image: "/art/1" }),
    ]);
    expect(r.unverified).toEqual(["Happy Death Day"]);
    expect(r.note).toMatch(/2 titles in your library/);
    // Only the filtered titles, names and years, went to Ember.
    expect(d.asked[0]!.prompt).toContain("Palm Springs (2020)");
    expect(d.asked[0]!.prompt).not.toContain("Edge of Tomorrow");
  });

  it("says so when nothing you have matches", async () => {
    const d = deps({ library: async () => lib });
    const r = await new Recommend(d).find({
      kind: "movie",
      interest: "westerns",
      show: "have",
      filters: { fromYear: 1950, toYear: 1960 },
    });
    expect(r.note).toMatch(/Nothing in your library matches/);
    expect(d.asked).toHaveLength(0);
  });
});

describe("modes and the rest", () => {
  it("asks for the strongest titles in a niche, and shows more of them", () => {
    const { prompt } = recommendPrompt({
      kind: "movie",
      interest: "time loop movies",
      mode: "niche",
    });
    expect(prompt).toMatch(/niche the person collects/);
  });

  it("thinks outside the box only when asked: adjacent titles with the same feel, said how", () => {
    const ask = { kind: "movie" as const, interest: "Christmas movies the family can watch" };
    expect(recommendPrompt(ask).prompt).not.toMatch(/outside the box/);
    const { prompt } = recommendPrompt({ ...ask, wide: true });
    expect(prompt).toMatch(/Think outside the box/);
    expect(prompt).toMatch(/same keyword/);
    expect(prompt).toMatch(/says how it connects/);
  });

  it("a show you have some seasons of offers the missing ones", async () => {
    const d = deps({
      said: [{ title: "Signal Hill", year: 2018, why: "Finish it." }],
      seerrSearch: async () => [
        {
          tmdbId: 9102,
          mediaType: "tv",
          title: "Signal Hill",
          year: 2018,
          status: "partly available",
        },
      ],
      inLibrary: async () => true,
    });
    const r = await new Recommend(d).find({ kind: "show", interest: "small-town mysteries" });
    expect(r.items).toEqual([
      expect.objectContaining({
        partial: true,
        request: expect.objectContaining({
          step: "app-seerr-request",
          params: { mediaType: "tv", tmdbId: 9102 },
        }),
      }),
    ]);
  });

  it("music: lists Lidarr's quality profiles to choose from", async () => {
    const d = deps({
      said: [{ title: "Khruangbin", why: "Grooves." }],
      arr: async (_id, _p, fn) =>
        fn(
          fakeCall({
            "/api/v1/artist/lookup": [
              { foreignArtistId: "8bb7cda2-0000-4000-8000-000000000001", artistName: "Khruangbin" },
            ],
            "/api/v1/artist": [],
            "/api/v1/qualityprofile": [
              { id: 3, name: "Lossless" },
              { id: 4, name: "Standard" },
            ],
            "/api/v1/metadataprofile": [{ id: 7 }],
            "/api/v1/rootfolder": [{ path: "/music" }],
          }),
          "http://lidarr",
        ),
    });
    const r = await new Recommend(d).find({ kind: "music", interest: "chill" });
    expect(r.qualityProfiles).toEqual([
      { id: 3, name: "Lossless" },
      { id: 4, name: "Standard" },
    ]);
  });

  it("books: added in Chaptarr with one approval, into the audiobook folder", async () => {
    const d = deps({
      said: [{ title: "The Martian", creator: "Andy Weir", why: "Funny survival." }],
      arr: async (_id, _p, fn) =>
        fn(
          fakeCall({
            "/api/v1/book/lookup": [
              {
                title: "The Martian",
                foreignBookId: "3",
                mediaType: "audiobook",
                author: { authorName: "Andy Weir", foreignAuthorId: "a1" },
                images: [
                  {
                    coverType: "cover",
                    url: "/MediaCoverProxy/2ffd1b9e06652603/59661342._SX500_.jpg",
                    remoteUrl: "https://i.gr-assets.com/images/S/books/59661342._SX500_.jpg",
                  },
                ],
              },
            ],
            "/api/v1/book": [],
            "/api/v1/rootfolder": [
              { name: "Books", path: "/ebooks" },
              { name: "Audio Books", path: "/audiobooks" },
            ],
            "/api/v1/qualityprofile": [{ id: 1 }],
            "/api/v1/metadataprofile": [{ id: 2 }],
          }),
          "http://chaptarr",
        ),
    });
    const r = await new Recommend(d).find({ kind: "audiobook", interest: "funny sci-fi" });
    const req = r.items[0]!.request!;
    // Its cover, through Hearth from Chaptarr's own cache.
    expect(r.items[0]!.image).toBe(
      "/api/services/chaptarr-1/dashboard/book-cover?remote=https%3A%2F%2Fi.gr-assets.com%2Fimages%2FS%2Fbooks%2F59661342._SX500_.jpg",
    );
    expect(req).toMatchObject({
      kind: "plan",
      step: "app-chaptarr-control",
      serviceId: "chaptarr-1",
    });
    if (req.kind !== "plan") throw new Error("expected a plan");
    expect(req.params).toMatchObject({ op: "request" });
    expect(JSON.parse(String(req.params.book))).toMatchObject({
      foreignBookId: "3",
      monitored: true,
      addOptions: { searchForNewBook: true },
      author: { rootFolderPath: "/audiobooks", qualityProfileId: 1, metadataProfileId: 2 },
    });
  });
});

describe("Chaptarr covers (the Curator's book covers)", () => {
  it("allows only Chaptarr's own cover cache, or https covers from the sites it uses", async () => {
    const { CHAPTARR_COVER, remoteCover, coverLink } = await import("../apps/chaptarr-cover");
    expect(CHAPTARR_COVER.test("/MediaCover/Books/9465/cover.jpg?v=639305673193593539")).toBe(true);
    for (const bad of [
      "/api/v1/book",
      "/MediaCover/../config.xml",
      "/MediaCoverProxy/2ffd/x.jpg",
      "/MediaCover/Books/1/cover.jpg?apikey=1",
    ])
      expect(CHAPTARR_COVER.test(bad)).toBe(false);
    expect(remoteCover("https://assets.hardcover.app/editions/1/2.jpg")).toBeDefined();
    for (const bad of [
      "http://i.gr-assets.com/x.jpg",
      "https://evil.example.com/x.jpg",
      "https://i.gr-assets.com.evil.example/x.jpg",
      "https://user@i.gr-assets.com/x.jpg",
      "https://i.gr-assets.com:8443/x.jpg",
    ])
      expect(remoteCover(bad)).toBeUndefined();
    // In the library: Chaptarr's own cache first.
    expect(
      coverLink("c1", [
        {
          coverType: "cover",
          url: "/MediaCover/Books/9465/cover.jpg?v=1",
          remoteUrl: "https://assets.hardcover.app/x.jpg",
        },
      ]),
    ).toBe(
      "/api/services/c1/dashboard/book-cover?path=%2FMediaCover%2FBooks%2F9465%2Fcover.jpg%3Fv%3D1",
    );
    expect(
      coverLink("c1", [{ coverType: "cover", url: "/x", remoteUrl: "https://evil.example/x.jpg" }]),
    ).toBeUndefined();
  });
});
