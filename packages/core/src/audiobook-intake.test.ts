import { describe, expect, it } from "vitest";
import { cleanName, identify, inferIdentity, parseSequence, shelfNames } from "./audiobook-intake";

const base = { tags: {}, parents: [], knownAuthors: [], tracks: 1, release: "" };

describe("audiobook intake names", () => {
  it("reads series releases and plain ones", () => {
    expect(inferIdentity("The Final Empire Mistborn, Book 1")).toMatchObject({
      series: "Mistborn",
      sequence: "01",
    });
    expect(inferIdentity("Will.Wight.Waybound.Cradle.Book.12").sequence).toBe("12");
    expect(inferIdentity("Andy Weir - Project Hail Mary")).toMatchObject({
      author: "Andy Weir",
      title: "Project Hail Mary",
    });
    expect(parseSequence("Vol. 3")).toBe("03");
    expect(cleanName('A: "B"?')).toBe("A- -B--");
  });

  it("keeps the owner's layout: first author, no subtitle, no (Unabridged)", () => {
    expect(
      shelfNames("Brandon Sanderson, Kaladin", "The Way of Kings: Stormlight 1 (Unabridged)"),
    ).toEqual({ author: "Brandon Sanderson", title: "The Way of Kings" });
  });

  it("is sure when the tags say who and what, unsure from a bare folder name", () => {
    const tagged = identify({
      ...base,
      name: "Dune",
      tags: { album_artist: "Frank Herbert", album: "Dune" },
    });
    expect(tagged).toMatchObject({ author: "Frank Herbert", title: "Dune" });
    expect(tagged.confidence).toBeGreaterThanOrEqual(0.8);
    const bare = identify({ ...base, name: "random_rip_2021" });
    expect(bare.author).toBe("Unknown");
    expect(bare.confidence).toBeLessThan(0.5);
  });

  it("uses an author already in the library", () => {
    const b = identify({
      ...base,
      name: "Cradle 01 Unsouled",
      release: "Cradle-Will.Wight.Books.1-11",
      knownAuthors: ["Will Wight"],
    });
    expect(b.author).toBe("Will Wight");
    expect(b.reasons.join(" ")).toContain("already in your library");
  });
});
