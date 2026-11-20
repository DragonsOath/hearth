import { describe, expect, it } from "vitest";
import { findMovies, radarrLibrary, tierOf } from "./radarr-library";
import { sampleRadarrLibrary } from "./samples";

describe("Radarr's library summary", () => {
  const now = new Date("2026-10-25T12:00:00Z");
  const { library: lib, index } = sampleRadarrLibrary(now);

  it("counts the library by how sharp it is, with codecs, HDR, size, and the biggest files", () => {
    expect(lib.onDisk).toBe(8);
    expect(lib.tiers.map((t) => [t.tier, t.count])).toEqual([
      ["4K", 1],
      ["1080p", 3],
      ["720p", 2],
      ["SD", 2],
    ]);
    expect(lib.hdr).toBe(1);
    expect(lib.codecs[0]).toEqual({ name: "x264", count: 3 });
    expect(lib.biggest.map((m) => m.title).slice(0, 3)).toEqual([
      "The Road",
      "Dune",
      "John Wick: Chapter 4",
    ]);
    expect(lib.biggest[0]).not.toHaveProperty("path");
    expect(lib.folders).toHaveLength(2);
  });

  it("lists what is coming by its next date, digital first, and only wanted movies without a file", () => {
    expect(lib.coming.map((c) => [c.title, c.kind])).toEqual([
      ["The Odyssey", "digital"],
      ["Street Fighter", "cinema"],
    ]);
  });

  it("counts upgrades per tier and lists the best-rated first", () => {
    expect(lib.upgrades.total).toBe(4);
    expect(lib.upgrades.byTier).toEqual([
      { tier: "720p", count: 2 },
      { tier: "SD", count: 2 },
    ]);
    expect(lib.upgrades.items.filter((m) => m.tier === "SD").map((m) => m.title)).toEqual([
      "Heat",
      "The Thing",
    ]);
  });

  it("shows only collections you have part of that miss a released movie", () => {
    expect(lib.collections.map((c) => [c.title, c.have, c.total])).toEqual([
      ["John Wick Collection", 2, 4],
      ["Wicked Collection", 1, 2],
    ]);
    expect(lib.collections[0]!.missing.map((m) => m.title)).toEqual([
      "John Wick: Chapter 2",
      "John Wick: Chapter 3 - Parabellum",
    ]);
  });

  it("finds movies by words of the title and the year, title starts first", () => {
    expect(findMovies(index, "wick").map((m) => m.title)).toEqual([
      "Wicked: For Good",
      "John Wick",
      "John Wick: Chapter 4",
    ]);
    expect(findMovies(index, "wick 2023").map((m) => m.title)).toEqual(["John Wick: Chapter 4"]);
    expect(findMovies(index, "  ")).toEqual([]);
    expect(findMovies(index, "dune")[0]).toMatchObject({ path: "/movies/Dune (2021)", tier: "4K" });
  });

  it("reads resolution into tiers, and copes with an empty library", () => {
    expect([2160, 1080, 720, 576, 0, undefined].map(tierOf)).toEqual([
      "4K",
      "1080p",
      "720p",
      "SD",
      "Unknown",
      "Unknown",
    ]);
    const empty = radarrLibrary([], new Set(), [], [], now).library;
    expect(empty).toMatchObject({ onDisk: 0, tiers: [], coming: [], collections: [] });
  });
});
