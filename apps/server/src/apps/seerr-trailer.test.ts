import { describe, expect, it } from "vitest";
import { trailerOf } from "./seerr-panel";

// Watch trailer (the owner, 11-10): the title's own YouTube trailer from TMDB's videos, or nothing.
describe("a title's trailer", () => {
  it("takes the YouTube trailer before a teaser or a featurette", () => {
    expect(
      trailerOf([
        { site: "YouTube", type: "Featurette", key: "featurette1" },
        { site: "YouTube", type: "Teaser", key: "teaser00001" },
        { site: "YouTube", type: "Trailer", key: "trailer0001" },
      ]),
    ).toEqual({ trailer: "https://www.youtube.com/watch?v=trailer0001" });
    expect(trailerOf([{ site: "YouTube", type: "Teaser", key: "teaser00001" }])).toEqual({
      trailer: "https://www.youtube.com/watch?v=teaser00001",
    });
  });

  it("gives nothing rather than a guess", () => {
    expect(trailerOf(undefined)).toEqual({});
    expect(trailerOf([{ site: "Vimeo", type: "Trailer", key: "12345678901" }])).toEqual({});
    expect(trailerOf([{ site: "YouTube", type: "Trailer", key: "bad key&x=1" }])).toEqual({});
    expect(trailerOf([{ site: "YouTube", type: "Featurette", key: "featurette1" }])).toEqual({});
  });
});
