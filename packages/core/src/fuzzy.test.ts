import { describe, expect, it } from "vitest";
import { editDistance, foldTitle, fuzzyRank, fuzzyScore } from "./fuzzy";

const films = [
  "Hot Tub Time Machine",
  "Hot Tub Time Machine 2",
  "Out Cold",
  "Out of Time",
  "Groundhog Day",
  "Dumb and Dumber",
  "Dumb and Dumber To",
  "The Grand Budapest Hotel",
  "Home Alone",
  "Die Hard",
  "Time Machine",
  "Cold Mountain",
  "Amélie",
  "Fast & Furious",
];
const top = (q: string, n = 1) => fuzzyRank(films, q, (f) => f, n);

describe("forgiving title search (the Forge's pick sheets)", () => {
  it("folds case, accents, punctuation, & and a leading article", () => {
    expect(foldTitle("The Grand Budapest Hotel")).toBe("grand budapest hotel");
    expect(foldTitle("Amélie")).toBe("amelie");
    expect(foldTitle("Fast & Furious")).toBe("fast and furious");
    expect(foldTitle("Groundhog's Day!")).toBe("groundhogs day");
  });

  it("counts typos, missing, extra and swapped letters", () => {
    expect(editDistance("tube", "tub")).toBe(1);
    expect(editDistance("dum", "dumb")).toBe(1);
    expect(editDistance("teh", "the")).toBe(1);
  });

  it("finds Alex's films from the night it didn't (Out Cold, Hot Tub Time Machine)", () => {
    expect(top("out cold")).toEqual(["Out Cold"]);
    expect(top("hot tube time machine", 2)).toEqual([
      "Hot Tub Time Machine",
      "Hot Tub Time Machine 2",
    ]);
    expect(top("groundhogs day")).toEqual(["Groundhog Day"]);
    expect(top("dum and dumber")).toEqual(["Dumb and Dumber"]);
    expect(top("grand budapest")).toEqual(["The Grand Budapest Hotel"]);
    expect(top("amelie")).toEqual(["Amélie"]);
    expect(top("fast and furious")).toEqual(["Fast & Furious"]);
  });

  it("doesn't match what isn't there", () => {
    expect(fuzzyScore("star wars", "Home Alone")).toBe(0);
    expect(top("zzzz")).toEqual([]);
  });
});
