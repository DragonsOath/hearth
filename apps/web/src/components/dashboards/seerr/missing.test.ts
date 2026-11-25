import { describe, expect, it } from "vitest";
import type { RequestedShow } from "@dragon-control/core";
import type { EpisodeRow } from "../sonarr/data";
import { completeness, showState } from "./missing";

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

describe("how complete a show is", () => {
  const c = completeness(
    [
      ep(1, 1),
      ep(1, 2),
      // Season 2: one aired and missing, one downloading, one not monitored, one airing next.
      ep(2, 1),
      ep(2, 2, { hasFile: false }),
      ep(2, 3, { hasFile: false }),
      ep(2, 4, { hasFile: false, monitored: false }),
      ep(2, 5, { hasFile: false, airDate: "2026-12-04T01:00:00Z" }),
      // Season 3: nothing aired yet; one with no date at all.
      ep(3, 1, { hasFile: false, airDate: "2027-03-01T01:00:00Z" }),
      ep(3, 2, { hasFile: false, airDate: undefined }),
      // Specials are left out.
      ep(0, 1, { hasFile: false }),
    ],
    [{ episodeId: 203, status: "downloading", progressPct: 40 }],
    NOW,
  );

  it("never counts an episode that hasn't aired, or has no date, as missing", () => {
    expect(c.missing).toBe(1);
    expect(c.notMonitored).toBe(1);
    expect(c.known).toBe(9);
    expect(c.present).toBe(3);
    expect(c.next?.code).toBe("S02E05");
  });

  it("gives every episode its own state", () => {
    const states = Object.fromEntries(
      c.seasons.flatMap((s) => s.episodes.map((x) => [x.e.code, x.state])),
    );
    expect(states).toEqual({
      S01E01: "in-library",
      S01E02: "in-library",
      S02E01: "in-library",
      S02E02: "missing",
      S02E03: "downloading",
      S02E04: "not-monitored",
      S02E05: "next",
      S03E01: "upcoming",
      S03E02: "unknown",
    });
  });

  it("says which seasons are complete, missing something, or not released yet", () => {
    expect(c.seasons.map((s) => [s.season, s.state, s.present, s.known])).toEqual([
      [1, "complete", 2, 2],
      [2, "missing", 1, 5],
      [3, "unreleased", 0, 2],
    ]);
    expect(c.seasonsInLibrary).toBe(2);
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
