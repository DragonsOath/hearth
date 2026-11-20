import { describe, expect, it } from "vitest";
import {
  CRUCIBLE_PRESETS,
  capFormats,
  cutoffOf,
  explainStep,
  ladderWords,
  profileItems,
  rowBlocks,
  rowCounts,
  rowFor,
  setupFromAnswers,
  type ArrProfileItem,
} from "./crucible";

const YEAR = 2026;
const q = (id: number, name: string, resolution: number) => ({
  quality: { id, name, resolution, source: "x" },
  items: [],
  allowed: false,
});
/** Radarr's own list, lowest first, with one group as Radarr ships it. */
const TEMPLATE: ArrProfileItem[] = [
  q(1, "SDTV", 480),
  q(4, "HDTV-720p", 720),
  q(6, "Bluray-720p", 720),
  q(7, "Bluray-1080p", 1080),
  {
    id: 1001,
    name: "WEB 1080p",
    items: [q(3, "WEBDL-1080p", 1080), q(15, "WEBRip-1080p", 1080)],
    allowed: false,
  },
  q(30, "Remux-1080p", 1080),
  q(19, "Bluray-2160p", 2160),
  q(31, "Remux-2160p", 2160),
  q(22, "BR-DISK", 1080),
];

describe("the Crucible", () => {
  it("places a title in the first row that fits, the last row taking the rest", () => {
    const rows = CRUCIBLE_PRESETS["storage-smart"].setup().movies;
    const name = (t: Parameters<typeof rowFor>[0]) => rowFor(t, rows, YEAR)?.name;
    expect(name({ year: 2025, popularity: 120 })).toBe("Big new releases");
    expect(name({ year: 2025, popularity: 5 })).toBe("Newer movies");
    expect(name({ year: 2015, genres: ["Animation", "Comedy"] })).toBe("Kids' and animated movies");
    expect(name({ year: 1990 })).toBe("Classics (30+ years)");
    expect(name({ year: 2005 })).toBe("Older movies (15+ years)");
    expect(name({})).toBe("Newer movies");
  });

  it("counts each row's titles and those bigger than its top step", () => {
    const rows = CRUCIBLE_PRESETS["storage-smart"].setup().movies;
    const c = rowCounts(
      [
        { year: 1985, sizeGB: 9 },
        { year: 1980, sizeGB: 3 },
        { year: 2022, sizeGB: 12 },
      ],
      rows,
      YEAR,
    );
    expect(c.get("classics")).toEqual({ titles: 2, bigger: 1 });
    expect(c.get("all")).toEqual({ titles: 1, bigger: 1 });
  });

  it("the guided setup: no care for space is No limits; otherwise the answers make the rows", () => {
    expect(
      setupFromAnswers({
        careAboutSpace: false,
        best: "none",
        olderIs720Fine: true,
        olderYears: 15,
        episodeGB: 2,
      }).preset,
    ).toBe("no-limits");
    const s = setupFromAnswers({
      careAboutSpace: true,
      best: "new-releases",
      olderIs720Fine: true,
      olderYears: 20,
      episodeGB: 3,
    });
    expect(s.movies.map((r) => r.name)).toEqual([
      "Big new releases",
      "Kids' and animated movies",
      "Older movies (20+ years)",
      "Newer movies",
    ]);
    expect(ladderWords(s.movies[0]!)).toBe("4K up to 25 GB, else 1080p up to 10 GB");
    expect(ladderWords(s.shows[0]!, "episode")).toBe(
      "1080p up to 3 GB an episode, else 720p up to 1.8 GB an episode",
    );
  });

  it("a row's profile allows its ladder's qualities, never a whole disc, and stops at the top step", () => {
    const row = CRUCIBLE_PRESETS["storage-smart"].setup().movies[0]!; // 4K, else 1080p
    const items = profileItems(TEMPLATE, row);
    const allowed = (n: string) =>
      items.flatMap((i) => (i.items?.length ? i.items : [i])).find((i) => i.quality?.name === n)
        ?.allowed;
    expect(allowed("Bluray-2160p")).toBe(true);
    expect(allowed("WEBDL-1080p")).toBe(true);
    expect(allowed("Bluray-720p")).toBe(false);
    expect(allowed("BR-DISK")).toBe(false);
    expect(items.find((i) => i.name === "WEB 1080p")?.allowed).toBe(true);
    // Radarr stops upgrading at the best allowed 4K.
    expect(cutoffOf(items, row)).toBe(31);
    // A 1080p-first row stops at 1080p (the group counts as one item).
    const older = CRUCIBLE_PRESETS["storage-smart"].setup().movies[3]!;
    expect(cutoffOf(profileItems(TEMPLATE, older), older)).toBe(30);
  });

  it("turns down each step's oversize releases with one shared format per quality and cap", () => {
    const rows = CRUCIBLE_PRESETS["storage-smart"].setup().movies;
    const f = capFormats(rows).map((x) => x.name);
    expect(f).toContain("Hearth · 2160p over 25 GB");
    expect(f).toContain("Hearth · 1080p over 10 GB");
    expect(new Set(f).size).toBe(f.length);
    expect(rowBlocks(rows[0]!)).toEqual(["Hearth · 2160p over 25 GB", "Hearth · 1080p over 10 GB"]);
    // No limits: nothing to turn down.
    expect(capFormats(CRUCIBLE_PRESETS["no-limits"].setup().movies)).toEqual([]);
  });

  it("explains a step in sizes people can picture", () => {
    expect(explainStep("movie", { quality: "1080p", maxGB: 15 })).toBe(
      "Most 2-hour movies in 1080p are 4 to 15 GB. At 15 GB you'll get almost all of them.",
    );
    expect(explainStep("movie", { quality: "2160p", maxGB: 25 })).toContain("some of them");
    expect(explainStep("episode", { quality: "1080p", maxGB: null })).toContain("No limit");
  });
});

describe("requestProfile (Hearth's own requests go out on their row's profile)", () => {
  it("names the row's profile from the app's list, or nothing when the Crucible has no rows there", async () => {
    const { requestProfile, CRUCIBLE_PRESETS } = await import("./crucible");
    const setup = CRUCIBLE_PRESETS["storage-smart"].setup();
    const profiles = [
      { id: 4, name: "HD-1080p" },
      { id: 22, name: "Hearth · Classics (30+ years)" },
    ];
    expect(
      requestProfile({ year: 1979, genres: ["Drama"] }, [setup], profiles, 2026),
    ).toMatchObject({
      id: 22,
      name: "Hearth · Classics (30+ years)",
    });
    expect(requestProfile({ year: 1979 }, [], profiles, 2026)).toBeUndefined();
  });
});
