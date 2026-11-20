import { describe, expect, it } from "vitest";
import type { ServarrGet } from "./servarr-panel";
import { readSeerrView } from "./seerr-panel";

// Overseerr 1.x (the owner's, 1.35.0) refuses trending's mediaType and timeWindow with a 400 that
// Seerr 3 accepts; the plain trending list mixes movies and shows (2026-11-02).
const overseerr1: ServarrGet = async (path) => {
  if (path.startsWith("/api/v1/discover/trending?mediaType"))
    return { ok: false, status: 400, data: { message: "bad request" } };
  if (path.startsWith("/api/v1/discover/trending?page=")) {
    const page = Number(/page=(\d+)/.exec(path)![1]);
    return {
      ok: true,
      status: 200,
      data: {
        page,
        totalPages: 10,
        results: [
          { id: page * 10 + 1, mediaType: "movie", title: `Film ${page}`, posterPath: "/f.jpg" },
          { id: page * 10 + 2, mediaType: "tv", name: `Show ${page}`, posterPath: "/s.jpg" },
          { id: page * 10 + 3, mediaType: "person", name: "Someone" },
        ],
      },
    };
  }
  if (path.startsWith("/api/v1/discover/movies/upcoming?page="))
    return {
      ok: true,
      status: 200,
      data: { page: 1, totalPages: 1, results: [{ id: 6, title: "Soon" }] },
    };
  if (path.startsWith("/api/v1/discover/movies"))
    return {
      ok: true,
      status: 200,
      data: { page: 1, totalPages: 1, results: [{ id: 5, title: "New" }] },
    };
  return { ok: false, status: 404, data: null };
};

describe("Seerr Discover rows", () => {
  it("work on Overseerr 1.x too: the plain trending list, split into movies and shows", async () => {
    const { rows } = (await readSeerrView(overseerr1, "discover", {})) as {
      rows: {
        id: string;
        error?: string;
        pages: number;
        results: { title: string; mediaType: string }[];
      }[];
    };
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by["trending-movies"]!.error).toBeUndefined();
    expect(by["trending-movies"]!.results.map((r) => r.title)).toEqual(["Film 1", "Film 2"]);
    expect(by["trending-tv"]!.results.map((r) => r.title)).toEqual(["Show 1", "Show 2"]);
    expect(by["trending-tv"]!.pages).toBe(5);
    expect(by["recent-movies"]!.results.map((r) => r.mediaType)).toEqual(["movie"]);
    expect(by["upcoming-movies"]!.results.map((r) => r.title)).toEqual(["Soon"]);
    // See all, page 2: trending pages 3 and 4.
    const two = (await readSeerrView(overseerr1, "discover", {
      row: "trending-movies",
      page: "2",
    })) as {
      results: { title: string }[];
    };
    expect(two.results.map((r) => r.title)).toEqual(["Film 3", "Film 4"]);
  });
});

// The details the panel shows front and center (11-19, the owner: like Ember's Tasterr panel):
// the banner, tagline, age rating, director, cast, and IMDb and Rotten Tomatoes, as Seerr gives
// them (field names checked against Seerr 3's own code on the owner's server).
describe("Seerr title details and ratings", () => {
  const seerr: ServarrGet = async (path) => {
    if (path === "/api/v1/movie/7")
      return {
        ok: true,
        status: 200,
        data: {
          id: 7,
          title: "Seven Seas",
          releaseDate: "2026-07-15",
          backdropPath: "/back7.jpg",
          tagline: "Defy the gods.",
          externalIds: { imdbId: "tt0000007" },
          releases: {
            results: [
              { iso_3166_1: "GB", release_dates: [{ certification: "15" }] },
              { iso_3166_1: "US", release_dates: [{ certification: "" }, { certification: "R" }] },
            ],
          },
          credits: {
            cast: [
              { name: "Second", character: "B", order: 1 },
              { name: "First", character: "A", profilePath: "/a.jpg", order: 0 },
            ],
            crew: [
              { name: "Writer", job: "Screenplay" },
              { name: "Director One", job: "Director" },
            ],
          },
          relatedVideos: [{ site: "YouTube", type: "Trailer", key: "abcdefghijk" }],
        },
      };
    if (path === "/api/v1/movie/7/ratingscombined")
      return {
        ok: true,
        status: 200,
        data: {
          rt: { criticsScore: 88, audienceScore: 70, url: "https://www.rottentomatoes.com/m/x" },
          imdb: { criticsScore: 8.1, url: "https://evil.example/tt" },
        },
      };
    if (path === "/api/v1/tv/8/ratings") return { ok: false, status: 404, data: null };
    return { ok: false, status: 404, data: null };
  };

  it("reads the banner, tagline, US rating, director and cast in billing order", async () => {
    const t = (await readSeerrView(seerr, "title", { type: "movie", id: "7" })) as Record<
      string,
      unknown
    >;
    expect(t).toMatchObject({
      backdrop: "/back7.jpg",
      tagline: "Defy the gods.",
      certification: "R",
      director: "Director One",
      imdbId: "tt0000007",
      trailer: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    expect(t.cast).toEqual([
      { name: "First", character: "A", photo: "/a.jpg" },
      { name: "Second", character: "B" },
    ]);
  });

  it("gives IMDb and Rotten Tomatoes only with their own addresses, and nothing when missing", async () => {
    expect(await readSeerrView(seerr, "ratings", { type: "movie", id: "7" })).toEqual({
      rottenTomatoes: { critics: 88, audience: 70, url: "https://www.rottentomatoes.com/m/x" },
      imdb: { score: 8.1 },
    });
    expect(await readSeerrView(seerr, "ratings", { type: "tv", id: "8" })).toEqual({});
  });
});
