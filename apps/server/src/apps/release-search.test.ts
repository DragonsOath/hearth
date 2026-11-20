import { describe, expect, it } from "vitest";
import {
  findReleases,
  grabChange,
  grabParams,
  grabRelease,
  scopeQuery,
  searchTitles,
  seriesEpisodes,
  type Call,
} from "./release-search";

/** A stand-in app: answers by path, and records what was asked. */
function app(routes: Record<string, { status?: number; data: unknown }>) {
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const call: Call = async (method, path, body) => {
    asked.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    const r = key ? routes[key]! : { status: 404, data: undefined };
    const status = r.status ?? 200;
    return { ok: status < 400, status, data: r.data as never };
  };
  return { call, asked };
}

const noWait = async () => undefined;

describe("interactive search", () => {
  it("finds titles by every word typed, in the title or the author", async () => {
    const { call, asked } = app({
      "GET /api/v1/book": {
        data: [
          {
            id: 1,
            title: "The Primal Hunter, Vol. 1",
            author: { authorName: "Zogarth" },
            mediaType: "audiobook",
          },
          { id: 2, title: "He Who Fights with Monsters", author: { authorName: "Shirtaloon" } },
        ],
      },
    });
    const t = await searchTitles("chaptarr", call, "primal zogarth");
    expect(asked[0]!.path).toBe("/api/v1/book");
    expect(t).toEqual([
      {
        id: 1,
        title: "The Primal Hunter, Vol. 1",
        kind: "book",
        by: "Zogarth",
        format: "audiobook",
      },
    ]);
    expect(await searchTitles("chaptarr", call, "   ")).toEqual([]);
  });

  it("Chaptarr: finds a book shaped like Alex's real library, and what Chaptarr's own search adds", async () => {
    // Chaptarr's real books carry authorId and authorTitle, not an author object (2026-11-07).
    const { call } = app({
      "GET /api/v1/book/lookup": {
        data: [
          {
            title: "A Court of Mist and Fury (A Court of Thorns and Roses, #2)",
            foreignBookId: "gr:25126749",
            mediaType: "audiobook",
            author: { authorName: "Sarah J. Maas" },
          },
          {
            title: "A Court of Mist and Fury (Part 1 of 2) [Dramatized Adaptation]",
            foreignBookId: "gr:96172636",
            mediaType: "audiobook",
          },
          {
            title: "A Court of Mist and Fury: Rhysand's POV",
            foreignBookId: "gr:211168839",
            mediaType: "audiobook",
            author: { authorName: "illyrian tremors" },
          },
        ],
      },
      "GET /api/v1/author": { data: [{ id: 5, authorName: "Sarah J. Maas" }] },
      "GET /api/v1/book": {
        data: [
          {
            id: 9333,
            title: "A Court of Mist and Fury",
            authorId: 5,
            authorTitle: "maas, sarah j. A Court of Mist and Fury",
            foreignBookId: "hc:428929",
            mediaType: "audiobook",
            monitored: true,
          },
          {
            id: 9356,
            title: "A Court of Mist and Fury (Part 1 of 2) [Dramatized Adaptation]",
            authorId: 5,
            foreignBookId: "gr:96172636",
            mediaType: "audiobook",
          },
          { id: 12, title: "Mistborn", authorId: 9, mediaType: "audiobook" },
        ],
      },
    });
    const t = await searchTitles("chaptarr", call, "a court of mist & fury");
    expect(t.map((x) => [x.id, x.by])).toEqual([
      [9333, "Sarah J. Maas"],
      [9356, "Sarah J. Maas"],
      [0, "illyrian tremors"],
    ]);
    expect(t[2]!.notInLibrary).toMatchObject({ foreignBookId: "gr:211168839" });
    // By author, last name first or not.
    expect((await searchTitles("chaptarr", call, "sarah j maas")).length).toBeGreaterThanOrEqual(2);
  });

  it("Chaptarr: a library it can't read is an error, never 'nothing matches'", async () => {
    const { call } = app({ "GET /api/v1/book": { data: "<html>" } });
    await expect(searchTitles("chaptarr", call, "anything")).rejects.toThrow(/couldn't read/);
  });

  it("lists a series' seasons and episodes, leaving out specials", async () => {
    const { call } = app({
      "GET /api/v3/series": {
        data: [
          {
            id: 7,
            title: "Ghosts (US)",
            year: 2021,
            seasons: [{ seasonNumber: 0 }, { seasonNumber: 2 }, { seasonNumber: 1 }],
          },
        ],
      },
      "GET /api/v3/episode?seriesId=7": {
        data: [
          { id: 3, seasonNumber: 2, episodeNumber: 1 },
          { id: 1, seasonNumber: 0, episodeNumber: 1 },
          { id: 2, seasonNumber: 1, episodeNumber: 5, title: "Pilot", hasFile: true },
        ],
      },
    });
    expect((await searchTitles("sonarr", call, "ghosts"))[0]!.seasons).toEqual([1, 2]);
    expect((await seriesEpisodes(call, 7)).map((e) => e.id)).toEqual([2, 3]);
  });

  it("asks each app for one item's releases in its own words", () => {
    expect(scopeQuery("radarr", { movieId: 5 })).toBe("movieId=5");
    expect(scopeQuery("sonarr", { episodeId: 9 })).toBe("episodeId=9");
    expect(scopeQuery("sonarr", { seriesId: 7, seasonNumber: 2 })).toBe(
      "seriesId=7&seasonNumber=2",
    );
    expect(scopeQuery("lidarr", { albumId: 4 })).toBe("albumId=4");
    expect(scopeQuery("chaptarr", { bookId: 3 })).toBe("bookId=3");
    // The wrong kind of id for the app is refused.
    expect(() => scopeQuery("radarr", { bookId: 3 })).toThrow("Say what to search for.");
  });

  it("lists releases with the app's verdict, the ones it would take first", async () => {
    const { call, asked } = app({
      "GET /api/v3/release?movieId=5": {
        data: [
          {
            guid: "a",
            indexerId: 2,
            title: "Movie.2160p.REMUX",
            size: 60 * 1024 ** 3,
            protocol: "torrent",
            seeders: 40,
            approved: false,
            rejections: [{ reason: "Not wanted in profile" }],
          },
          {
            guid: "b",
            indexerId: 1,
            title: "Movie.1080p.WEB",
            protocol: "usenet",
            approved: true,
            customFormatScore: 100,
          },
          { title: "no guid, skipped" },
        ],
      },
    });
    const r = await findReleases("radarr", call, { movieId: 5 });
    expect(asked[0]!.path).toBe("/api/v3/release?movieId=5");
    expect(r.found).toBe(2);
    expect(r.releases[0]).toMatchObject({ guid: "b", approved: true, score: 100 });
    expect(r.releases[1]).toMatchObject({
      guid: "a",
      sizeGB: 60,
      seeders: 40,
      approved: false,
      rejections: ["Not wanted in profile"],
    });
  });

  it("includes the releases Chaptarr hides (collections and packs), marked hidden", async () => {
    const { call } = app({
      "GET /api/v1/release": {
        data: {
          releases: [],
          hiddenReleases: [
            {
              guid: "c",
              indexerId: 8,
              title: "Series Books 1-12",
              size: 30 * 1024 ** 3,
              approved: false,
              rejected: true,
              rejections: ["Title/Author mismatch"],
            },
          ],
        },
      },
    });
    const r = await findReleases("chaptarr", call, { bookId: 7 });
    expect(r.found).toBe(1);
    expect(r.releases[0]).toMatchObject({
      guid: "c",
      hidden: true,
      approved: false,
      rejections: ["Title/Author mismatch"],
    });
  });

  it("downloads the picked release and finds it in the queue", async () => {
    const { call, asked } = app({
      "POST /api/v1/release": { data: { title: "Book.m4b" } },
      "GET /api/v1/queue": { data: { records: [{ title: "Book.m4b" }] } },
    });
    const out = await grabRelease(
      "chaptarr",
      call,
      { guid: "g", indexerId: 3, release: "Book.m4b" },
      noWait,
    );
    expect(asked[0]).toEqual({
      method: "POST",
      path: "/api/v1/release",
      body: { guid: "g", indexerId: 3 },
    });
    expect(out).toEqual({
      ok: true,
      result: "Sent Book.m4b to the download client. It is in the queue and downloading.",
    });
  });

  it("says when a search result has expired, so it is searched again", async () => {
    const { call } = app({ "POST /api/v3/release": { status: 404, data: undefined } });
    const out = await grabRelease(
      "sonarr",
      call,
      { guid: "g", indexerId: 1, release: "x" },
      noWait,
    );
    expect(out.ok).toBe(false);
    expect(out.stale).toBe(true);
    expect(out.result).toContain("Search again");
  });

  it("plans a download with what it is, and refuses one without a picked release", () => {
    expect(grabParams({ guid: "g" })).toBe(
      "Say which release to download (pick one from a search).",
    );
    const g = grabParams({
      guid: "g",
      indexerId: 2,
      release: "Movie.1080p.WEB",
      title: "Movie (2024)",
      quality: "WEBDL-1080p",
      sizeGB: 7.8,
      indexer: "UsenetOne",
    });
    expect(typeof g).toBe("object");
    const c = grabChange("Radarr", g as Exclude<typeof g, string>);
    expect(c.summary).toBe("Download Movie.1080p.WEB for Movie (2024) in Radarr");
    expect(c.settings[0]!.after).toBe(
      "Radarr sends Movie.1080p.WEB (WEBDL-1080p, 7.8 GB, from UsenetOne) to the download client",
    );
  });
});
