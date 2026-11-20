import { describe, expect, it } from "vitest";
import { requestKey, tmdbDate } from "./movie-release";

/** TMDB's release dates as Seerr passes them on (types: 3 theatrical, 4 digital, 5 physical). */
const releases = {
  results: [
    {
      iso_3166_1: "US",
      release_dates: [
        { type: 3, release_date: "2026-09-12T00:00:00.000Z" },
        { type: 4, release_date: "2026-11-21T00:00:00.000Z" },
        { type: 4, release_date: "2026-11-14T00:00:00.000Z" },
        { type: 5, release_date: "2026-12-09T00:00:00.000Z" },
      ],
    },
    {
      iso_3166_1: "GB",
      release_dates: [{ type: 3, release_date: "2026-09-19T00:00:00.000Z" }],
    },
  ],
};

describe("release dates from Seerr", () => {
  it("takes the earliest date of a type, for the owner's country only", () => {
    expect(tmdbDate(releases, "US", 4)).toBe("2026-11-14");
    expect(tmdbDate(releases, "us", 5)).toBe("2026-12-09");
    expect(tmdbDate(releases, "US", 3)).toBe("2026-09-12");
    // Another country's dates never stand in: Great Britain has no digital date yet.
    expect(tmdbDate(releases, "GB", 4)).toBeUndefined();
    expect(tmdbDate(releases, "FR", 3)).toBeUndefined();
    expect(tmdbDate(undefined, "US", 4)).toBeUndefined();
  });

  it("keys a watch by its Seerr and request, so the same request is watched once", () => {
    expect(requestKey("seerr-1", 42)).toBe("seerr-1:42");
  });
});
