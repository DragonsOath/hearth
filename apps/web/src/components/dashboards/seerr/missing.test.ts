import { describe, expect, it } from "vitest";
import type { RequestedShow } from "@dragon-control/core";
import type { EpisodeRow } from "../sonarr/data";
import { missingBySeason, showState } from "./missing";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const ep = (season: number, number: number, o: Partial<EpisodeRow> = {}): EpisodeRow => ({
  id: season * 100 + number,
  season,
  number,
  code: `S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`,
  title: `Episode ${number}`,
  airDate: "2026-01-01T00:00:00Z",
  monitored: true,
  hasFile: true,
  ...o,
});

describe("what a show is missing", () => {
  it("lists aired, monitored episodes with no file, by season, and marks a season with nothing on disk", () => {
    const m = missingBySeason(
      [
        ep(1, 1),
        ep(1, 2, { hasFile: false }),
        ep(1, 3),
        ep(2, 1, { hasFile: false }),
        ep(2, 2, { hasFile: false }),
        // Not aired yet: not missing.
        ep(2, 3, { hasFile: false, airDate: "2026-12-04T01:00:00Z" }),
        // Specials are left out.
        ep(0, 1, { hasFile: false }),
        // Not monitored: only counted.
        ep(3, 1, { hasFile: false, monitored: false }),
      ],
      NOW,
    );
    expect(m.total).toBe(3);
    expect(m.notMonitored).toBe(1);
    expect(m.seasons.map((s) => [s.season, s.whole, s.episodes.map((e) => e.code)])).toEqual([
      [1, false, ["S01E02"]],
      [2, true, ["S02E01", "S02E02"]],
    ]);
  });

  it("says nothing is missing when every aired episode is on disk", () => {
    expect(missingBySeason([ep(1, 1), ep(1, 2)], NOW)).toEqual({
      seasons: [],
      total: 0,
      notMonitored: 0,
    });
  });
});

describe("where a show stands", () => {
  const show = (
    sonarr?: Partial<NonNullable<RequestedShow["sonarr"]>>,
    o: Partial<RequestedShow> = {},
  ) =>
    ({
      requestId: 1,
      tmdbId: 1,
      title: "A show",
      requestedAt: "2026-11-01T00:00:00Z",
      requestedBy: "Alex",
      mine: true,
      approval: "approved",
      seasons: [],
      ...(sonarr
        ? {
            sonarr: {
              serviceId: "sonarr",
              seriesId: 1,
              instance: "Sonarr",
              monitored: true,
              episodesOnDisk: 10,
              episodes: 10,
              ...sonarr,
            },
          }
        : {}),
      ...o,
    }) as RequestedShow;

  it("puts missing episodes first, then what's coming, then complete", () => {
    expect(showState(show({ missing: 4, nextAiring: "2026-12-04T01:00:00Z" })).label).toBe(
      "Missing 4 episodes",
    );
    expect(showState(show({ nextAiring: "2026-12-04T01:00:00Z" })).label).toBe(
      "Up to date, more coming",
    );
    expect(showState(show({ ended: true }))).toEqual({ label: "Complete", tone: "good" });
    expect(showState(show()).label).toBe("Not in Sonarr");
    expect(showState(show({}, { approval: "pending" })).label).toBe("Waiting for approval");
  });
});
