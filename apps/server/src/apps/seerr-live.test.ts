import { describe, expect, it } from "vitest";
import { CredentialError } from "../credentials/broker";
import type { MovieReleases } from "../watches/movie-release";
import { SeerrLive } from "./seerr-live";

/**
 * The Seerr dashboard against realistic answers: requests from two people, movies split over two
 * Radarrs (each with its own root folder and quality profiles), a movie with no digital date, one
 * Seerr has no details for, and a third Radarr whose key is missing.
 */

const TODAY = "2026-10-19";
const NOW = new Date(`${TODAY}T15:00:00Z`);

const service = (id: string, name: string) => ({ id, name }) as never;
const seerr = service("seerr", "Overseerr");
const hd = service("radarr", "Radarr");
const uhd = service("radarr4k", "Radarr 4K");
const keyless = service("radarr-old", "Radarr Old");

const request = (
  id: number,
  tmdbId: number,
  by: 1 | 2,
  status = 2,
  createdAt = "2026-09-01T10:00:00Z",
) => ({
  id,
  status,
  type: "movie",
  createdAt,
  requestedBy: by === 1 ? { id: 1, displayName: "Alex" } : { id: 2, displayName: "Alex" },
  media: { tmdbId, status: 3 },
});

const releases = (digital?: string, theatrical = "2026-08-01") => ({
  results: [
    {
      iso_3166_1: "US",
      release_dates: [
        { type: 3, release_date: `${theatrical}T00:00:00.000Z` },
        ...(digital ? [{ type: 4, release_date: `${digital}T00:00:00.000Z` }] : []),
      ],
    },
  ],
});

const SEERR: Record<string, unknown> = {
  "/api/v1/status": { version: "1.33.2" },
  "/api/v1/auth/me": { id: 1, displayName: "Alex" },
  "/api/v1/movie/1": {
    title: "Night Signal",
    posterPath: "/night.jpg",
    releaseDate: "2026-08-01",
    releases: releases("2026-10-11"),
  },
  "/api/v1/movie/2": {
    title: "Paper Moons",
    posterPath: "/moons.jpg",
    releaseDate: "2026-07-01",
    releases: releases("2026-10-17"),
  },
  "/api/v1/movie/3": {
    title: "The Long Road",
    releaseDate: "2026-09-01",
    releases: releases(undefined, "2026-09-20"),
  },
  "/api/v1/movie/5": {
    title: "Pending One",
    releaseDate: "2026-09-01",
    releases: releases("2026-10-01"),
  },
};

const RADARR: Record<string, Record<string, unknown>> = {
  radarr: {
    "/api/v3/movie": [
      {
        id: 11,
        tmdbId: 1,
        monitored: true,
        hasFile: false,
        isAvailable: true,
        rootFolderPath: "/movies",
        path: "/movies/Night Signal (2026)",
        qualityProfileId: 4,
      },
      // No rootFolderPath reported (older Radarr): the folder above the movie's own.
      {
        id: 13,
        tmdbId: 3,
        monitored: true,
        hasFile: false,
        isAvailable: false,
        path: "/data/films/The Long Road (2026)",
        qualityProfileId: 4,
      },
    ],
    "/api/v3/qualityprofile": [{ id: 4, name: "HD-1080p" }],
    "/api/v3/queue": { records: [] },
    "/api/v3/history/movie": [],
  },
  radarr4k: {
    "/api/v3/movie": [
      {
        id: 21,
        tmdbId: 2,
        monitored: true,
        hasFile: false,
        isAvailable: true,
        rootFolderPath: "/movies-4k",
        path: "/movies-4k/Paper Moons (2026)",
        qualityProfileId: 9,
      },
    ],
    "/api/v3/qualityprofile": [{ id: 9, name: "Ultra-HD" }],
    "/api/v3/queue": {
      records: [
        {
          movieId: 21,
          status: "downloading",
          trackedDownloadState: "downloading",
          trackedDownloadStatus: "ok",
          size: 100,
          sizeleft: 25,
        },
      ],
    },
  },
};

function stub(requests: unknown[], radarrs = [hd, uhd]): MovieReleases {
  return {
    services: async (app: string) => (app === "radarr" ? radarrs : [seerr]),
    region: async () => "US",
    read: async (svc: { id: string }, path: string) => {
      const p = path.split("?")[0]!;
      if (svc.id === "seerr") {
        if (p === "/api/v1/request") {
          const skip = Number(/skip=(\d+)/.exec(path)?.[1] ?? 0);
          return { status: 200, data: { results: skip ? [] : requests } };
        }
        return p in SEERR ? { status: 200, data: SEERR[p] } : { status: 404 };
      }
      if (svc.id === "radarr-old") throw new CredentialError("No key.", "missing");
      const data = RADARR[svc.id]?.[p];
      return data === undefined ? { status: 404 } : { status: 200, data };
    },
  } as unknown as MovieReleases;
}

const opts = { region: "", overdueAfterDays: 2, now: NOW, today: TODAY };

describe("the Seerr dashboard", () => {
  it("joins each request to the Radarr that has it, with its real folder and profile", async () => {
    const d = await new SeerrLive(
      stub([
        request(1, 1, 1),
        request(2, 2, 1),
        request(3, 3, 2),
        request(4, 4, 2),
        request(5, 5, 2, 1, "2026-10-18T10:00:00Z"),
      ]),
    ).dashboard(seerr, opts);
    const by = (t: number) => d.movies.find((m) => m.tmdbId === t)!;

    expect(d.me).toBe("Alex");
    expect(d.totals).toEqual({ movies: 5, mine: 2, overdue: 2, awaitingApproval: 1 });

    // Out 8 days ago, monitored, nothing grabbed: overdue, with HD folder and profile.
    expect(by(1)).toMatchObject({
      title: "Night Signal",
      poster: "/night.jpg",
      mine: true,
      digital: { date: "2026-10-11", source: "tmdb" },
      theatrical: "2026-08-01",
      overdueDays: 8,
      stage: "searching",
      radarr: { instance: "Radarr", rootFolder: "/movies", quality: "HD-1080p" },
    });
    // In the second Radarr, downloading: not overdue, its own folder and profile.
    expect(by(2)).toMatchObject({
      stage: "downloading",
      radarr: {
        instance: "Radarr 4K",
        rootFolder: "/movies-4k",
        quality: "Ultra-HD",
        progressPct: 75,
      },
    });
    expect(by(2).overdueDays).toBeUndefined();
    // No digital date: never the theatrical one in its place, and never overdue.
    expect(by(3).digital).toBeUndefined();
    expect(by(3)).toMatchObject({
      theatrical: "2026-09-20",
      stage: "waiting-release",
      radarr: { rootFolder: "/data/films" },
    });
    // Seerr had no details for it, and no Radarr has it: said plainly.
    expect(by(4)).toMatchObject({ title: "A movie (TMDB 4)", stage: "not-in-radarr" });
    // Still waiting for approval 18 days after its digital date: overdue, and the stage says why.
    expect(by(5)).toMatchObject({
      approval: "pending",
      stage: "awaiting-approval",
      overdueDays: 18,
    });
  });

  it("does not call a movie 'not in Radarr' when a Radarr could not be read", async () => {
    const d = await new SeerrLive(stub([request(4, 4, 1)], [hd, keyless])).dashboard(seerr, opts);
    expect(d.movies[0]!.stage).toBe("radarr-unknown");
    expect(d.notes).toEqual(["Radarr Old: its key is not in Secure Vault"]);
  });

  it("clears the overdue mark once Radarr has the file", async () => {
    const movies = RADARR.radarr!["/api/v3/movie"] as { tmdbId: number; hasFile: boolean }[];
    const night = movies.find((m) => m.tmdbId === 1)!;
    night.hasFile = true;
    try {
      const d = await new SeerrLive(stub([request(1, 1, 1)])).dashboard(seerr, opts);
      expect(d.movies[0]).toMatchObject({ stage: "imported" });
      expect(d.totals.overdue).toBe(0);
    } finally {
      night.hasFile = false;
    }
  });

  it("counts overdue from the threshold the owner set (0 = on the day)", async () => {
    const live = new SeerrLive(stub([request(1, 1, 1)]));
    expect((await live.dashboard(seerr, { ...opts, overdueAfterDays: 10 })).totals.overdue).toBe(0);
    expect(
      (await live.dashboard(seerr, { ...opts, overdueAfterDays: 0 })).movies[0]!.overdueDays,
    ).toBe(8);
  });
});

describe("a requested show's seasons from Sonarr", () => {
  it("counts its seasons (specials left out) and the aired, monitored episodes not on disk", async () => {
    const { seasonsOf } = await import("./seerr-live");
    expect(
      seasonsOf({
        id: 1,
        seasons: [
          {
            seasonNumber: 0,
            monitored: false,
            statistics: { episodeFileCount: 0, episodeCount: 3 },
          },
          {
            seasonNumber: 2,
            monitored: true,
            statistics: { episodeFileCount: 2, episodeCount: 8 },
          },
          {
            seasonNumber: 1,
            monitored: true,
            statistics: { episodeFileCount: 10, episodeCount: 10 },
          },
        ],
      }),
    ).toEqual({
      seasons: [
        { number: 1, files: 10, episodes: 10, monitored: true },
        { number: 2, files: 2, episodes: 8, monitored: true },
      ],
      missing: 6,
    });
  });
});
