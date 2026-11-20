import { describe, expect, it } from "vitest";
import {
  CRUCIBLE_STATEMENTS,
  arrTitle,
  capSpecifications,
  explainTitle,
  groupPhrases,
  profileItems,
  rowFor,
  rowOverlaps,
  rowSentence,
  safeToMove,
  spaceEstimate,
  type ArrProfileItem,
  type CrucibleRow,
} from "./crucible";

/** Your rules in plain words (11-18, the owner): every definition visible and changeable. */
const YEAR = 2026;
const row = (
  id: string,
  group: CrucibleRow["group"],
  ladder: CrucibleRow["ladder"],
  more: Partial<CrucibleRow> = {},
): CrucibleRow => ({ id, name: id, group, ladder, upgrade: true, waitHours: 0, ...more });

const rules: CrucibleRow[] = [
  row("New on digital", { digitalWithinMonths: 6 }, [
    { quality: "2160p", maxGB: 15 },
    { quality: "1080p", maxGB: 6 },
  ]),
  row("The 80s", { fromYear: 1980, toYear: 1989 }, [{ quality: "1080p", maxGB: 10 }]),
  row("Comedies", { genres: ["Comedy"], notGenres: ["Animation"] }, [
    { quality: "1080p", maxGB: 4 },
  ]),
  row("Older", { olderThanYears: 20 }, [
    { quality: "720p", maxGB: 1.5 },
    { quality: "sd", maxGB: 1 },
  ]),
  row("Everything else", {}, [{ quality: "1080p", maxGB: 6 }]),
];

describe("your rules", () => {
  it("places titles by digital release, decade, genre and age, first rule wins", () => {
    const name = (t: Parameters<typeof rowFor>[0]) => rowFor(t, rules, YEAR)?.name;
    expect(name({ year: 2026, outDaysAgo: 40 })).toBe("New on digital");
    expect(name({ year: 2026, outDaysAgo: -20 })).toBe("New on digital"); // not out yet
    expect(name({ year: 2025, outDaysAgo: 250 })).toBe("Everything else");
    expect(name({ year: 1985, genres: ["Comedy"] })).toBe("The 80s");
    expect(name({ year: 2015, genres: ["Comedy"] })).toBe("Comedies");
    expect(name({ year: 2015, genres: ["Comedy", "Animation"] })).toBe("Everything else");
    expect(name({ year: 2004 })).toBe("Older");
    expect(name({})).toBe("Everything else");
  });

  it("skips a switched-off rule, but the last one always takes the rest", () => {
    const off = rules.map((r) => (r.id === "The 80s" ? { ...r, off: true } : r));
    expect(rowFor({ year: 1985 }, off, YEAR)?.name).toBe("Older");
    const allOff = rules.map((r) => ({ ...r, off: true }));
    expect(rowFor({ year: 1985 }, allOff, YEAR)?.name).toBe("Everything else");
  });

  it("matches any condition when a rule says so (Expert), ratings and runtime too", () => {
    const r = row("Best or long", { minRating: 8, minRuntime: 150, any: true }, [
      { quality: "2160p", maxGB: 40 },
    ]);
    const rest = row("Rest", {}, [{ quality: "1080p", maxGB: 6 }]);
    expect(rowFor({ rating: 8.4, runtime: 100 }, [r, rest], YEAR)?.name).toBe("Best or long");
    expect(rowFor({ rating: 6, runtime: 170 }, [r, rest], YEAR)?.name).toBe("Best or long");
    expect(rowFor({ rating: 6, runtime: 100 }, [r, rest], YEAR)?.name).toBe("Rest");
  });

  it("says every rule as a sentence with its definitions in it", () => {
    expect(rowSentence(rules[0]!, "movie", false)).toBe(
      "Movies out on digital less than 6 months ago get 4K up to 15 GB, else 1080p up to 6 GB.",
    );
    expect(rowSentence(rules[1]!, "movie", false)).toBe(
      "Movies made from 1980 to 1989 get 1080p up to 10 GB.",
    );
    expect(rowSentence(rules[2]!, "movie", false)).toBe(
      "Movies in Comedy and not Animation get 1080p up to 4 GB.",
    );
    expect(rowSentence(rules[3]!, "movie", false)).toBe(
      "Movies released more than 20 years ago get 720p up to 1.5 GB, else SD (DVD) up to 1 GB.",
    );
    expect(rowSentence(rules[4]!, "movie", true)).toBe("Every other movie gets 1080p up to 6 GB.");
    expect(groupPhrases({ minRating: 7, maxRating: 9 }).map((p) => p.text)).toEqual([
      "rated 7 to 9",
    ]);
  });

  it("explains why a title gets what it gets", () => {
    const e = explainTitle({ year: 2004, genres: ["Comedy", "Animation"] }, rules, YEAR);
    expect(e.row?.name).toBe("Older");
    expect(e.lines).toEqual([
      '"New on digital" doesn\'t fit: not out on digital less than 6 months ago.',
      '"The 80s" doesn\'t fit: not made from 1980 to 1989.',
      '"Comedies" doesn\'t fit: not not Animation.',
      '"Older" fits (released more than 20 years ago): 720p up to 1.5 GB, else SD (DVD) up to 1 GB.',
    ]);
  });

  it("shows where two rules want the same titles (the higher one wins)", () => {
    const o = rowOverlaps([{ year: 1985, genres: ["Comedy"] }, { year: 1987 }], rules, YEAR);
    expect(o).toEqual([
      { higher: "The 80s", lower: "Comedies", titles: 1 },
      { higher: "The 80s", lower: "Older", titles: 2 },
      { higher: "Comedies", lower: "Older", titles: 1 },
    ]);
  });

  it("estimates the space now and under the rules, never counting a delete", () => {
    const est = spaceEstimate(
      [
        { year: 2001, sizeGB: 8, fileQuality: "1080p", files: 1, hasFile: true },
        { year: 2001, sizeGB: 1.2, fileQuality: "720p", files: 1, hasFile: true },
        { year: 2026, outDaysAgo: 10 },
      ],
      rules,
      YEAR,
    );
    expect(est.nowGB).toBe(9);
    expect(est.overAllowance).toBe(1);
    expect(est.missing).toBe(1);
    expect(est.rulesGB).toBeLessThan(est.nowGB + est.missingGB);
  });

  it("moves an aging title only when nothing would be replaced", () => {
    const older = rules[3]!;
    expect(safeToMove({ files: 0 }, older)).toBe(true);
    expect(safeToMove({ files: 1, fileQuality: "720p", sizeGB: 1.2 }, older)).toBe(true);
    expect(safeToMove({ files: 1, fileQuality: "720p", sizeGB: 3 }, older)).toBe(false);
    expect(safeToMove({ files: 1, fileQuality: "1080p", sizeGB: 1 }, older)).toBe(false);
  });

  it("reads Radarr's dates, rating, runtime and language", () => {
    const now = new Date("2026-11-18T00:00:00Z");
    const t = arrTitle(
      {
        year: 2026,
        inCinemas: "2026-07-01T00:00:00Z",
        ratings: { tmdb: { value: 7.26 } },
        runtime: 132,
        originalLanguage: { name: "Japanese" },
        hasFile: true,
        sizeOnDisk: 6 * 1024 ** 3,
        movieFile: { quality: { quality: { resolution: 576 } } },
        tags: [3],
      },
      new Map([[3, "keep"]]),
      now,
    );
    expect(t).toMatchObject({
      outDaysAgo: 50, // cinema + 90 days, no digital date yet
      rating: 7.3,
      runtime: 132,
      language: "Japanese",
      fileQuality: "sd",
      sizeGB: 6,
      tags: ["keep"],
      files: 1,
    });
    expect(
      arrTitle({ digitalRelease: "2026-11-01T00:00:00Z", inCinemas: "2026-01-01" }, new Map(), now)
        .outDaysAgo,
    ).toBe(17);
  });

  it("an SD step allows DVD copies but never cinema recordings, and caps both DVD sizes", () => {
    const q = (id: number, name: string, resolution: number): ArrProfileItem => ({
      quality: { id, name, resolution },
      allowed: false,
    });
    const items = profileItems(
      [q(1, "SDTV", 480), q(2, "DVD", 480), q(3, "Bluray-576p", 576), q(4, "CAM", 480)],
      row("x", {}, [{ quality: "sd", maxGB: 1 }]),
    );
    expect(items.filter((i) => i.allowed).map((i) => i.quality?.name)).toEqual([
      "SDTV",
      "DVD",
      "Bluray-576p",
    ]);
    const specs = capSpecifications("sd", 1);
    expect(specs.filter((s) => s.implementation === "ResolutionSpecification")).toHaveLength(2);
    expect(specs.find((s) => s.implementation === "SizeSpecification")?.required).toBe(true);
  });

  it("the ready-made rules are neutral and each one is a valid rule", () => {
    for (const s of CRUCIBLE_STATEMENTS) {
      const r = s.make();
      expect(r.ladder.length).toBeGreaterThan(0);
      expect(rowSentence(r, s.kind, false)).toMatch(/get .+\.$/);
    }
  });
});
