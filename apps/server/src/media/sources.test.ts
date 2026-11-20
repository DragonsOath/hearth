import { describe, expect, it } from "vitest";
import type { Fetch } from "../apps/http";
import { jellyfinRecent, plexRecent } from "./sources";

/** A server answering from a map of paths (query strings ignored except where given). */
function server(routes: Record<string, unknown>, seen: string[] = []): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    seen.push(u.pathname + u.search);
    const h = new Headers(init?.headers);
    if (!h.get("X-Plex-Token") && !h.get("Authorization")) return new Response("", { status: 401 });
    const body = routes[u.pathname + u.search] ?? routes[u.pathname];
    return body === undefined
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as Fetch;
}

describe("reading what a media server just added", () => {
  it("Plex: movies and episodes with their outside ids, the series' ids, and the library", async () => {
    const seen: string[] = [];
    const f = server(
      {
        "/library/sections": {
          MediaContainer: {
            Directory: [
              { key: "1", title: "Movies", type: "movie" },
              { key: "2", title: "TV Shows", type: "show" },
              { key: "3", title: "Music", type: "artist" },
            ],
          },
        },
        "/library/sections/1/all": {
          MediaContainer: {
            Metadata: [
              {
                ratingKey: "101",
                type: "movie",
                title: "Quiet Harbor",
                year: 2026,
                summary: "A lighthouse keeper.",
                duration: 6_120_000,
                audienceRating: 7.4,
                contentRating: "PG-13",
                thumb: "/library/metadata/101/thumb/1",
                art: "/library/metadata/101/art/1",
                addedAt: 1_793_000_000,
                Guid: [{ id: "imdb://tt0700" }, { id: "tmdb://700" }],
                Genre: [{ tag: "Drama" }],
              },
            ],
          },
        },
        "/library/sections/2/all": {
          MediaContainer: {
            Metadata: [
              {
                ratingKey: "201",
                type: "episode",
                title: "Triple Point",
                grandparentTitle: "The Expanse",
                grandparentRatingKey: "200",
                parentIndex: 3,
                index: 5,
                Guid: [{ id: "tvdb://9001" }],
              },
            ],
          },
        },
        "/library/metadata/200": {
          MediaContainer: {
            Metadata: [
              { title: "The Expanse", year: 2015, summary: "Space.", Guid: [{ id: "tvdb://280" }] },
            ],
          },
        },
      },
      seen,
    );
    const items = await plexRecent(f, "http://plex.local:32400", "token");
    expect(items).toEqual([
      expect.objectContaining({
        kind: "movie",
        title: "Quiet Harbor",
        year: 2026,
        ids: { imdb: "tt0700", tmdb: "700" },
        library: "Movies",
        runtimeMin: 102,
        rating: 7.4,
        contentRating: "PG-13",
        genres: ["Drama"],
        poster: "/library/metadata/101/thumb/1",
      }),
      expect.objectContaining({
        kind: "episode",
        title: "Triple Point",
        show: "The Expanse",
        showYear: 2015,
        showIds: { tvdb: "280" },
        season: 3,
        episode: 5,
        library: "TV Shows",
      }),
    ]);
    // Only the newest of each library, never the music library; the token stays in a header.
    expect(seen.some((p) => p.includes("/sections/3/"))).toBe(false);
    expect(seen.find((p) => p.startsWith("/library/sections/1/all"))).toContain(
      "sort=addedAt:desc",
    );
    expect(seen.join(" ")).not.toContain("token");
  });

  it("Jellyfin: movies and episodes, with the trailers it lists and the series' ids", async () => {
    const f = server({
      "/Library/VirtualFolders": [
        { Name: "Films", ItemId: "lib1", CollectionType: "movies" },
        { Name: "Shows", ItemId: "lib2", CollectionType: "tvshows" },
        { Name: "Books", ItemId: "lib3", CollectionType: "books" },
      ],
      "/Items": { Items: [] },
    });
    const g = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname === "/Items" && u.searchParams.get("ParentId") === "lib1")
        return new Response(
          JSON.stringify({
            Items: [
              {
                Id: "m1",
                Name: "Quiet Harbor",
                Type: "Movie",
                ProductionYear: 2026,
                ProviderIds: { Tmdb: "700" },
                RemoteTrailers: [
                  { Url: "https://www.youtube.com/watch?v=abc123" },
                  { Url: "javascript:x" },
                ],
                ImageTags: { Primary: "t" },
                RunTimeTicks: 61_200_000_000,
              },
            ],
          }),
        );
      if (u.pathname === "/Items" && u.searchParams.get("ParentId") === "lib2")
        return new Response(
          JSON.stringify({
            Items: [
              {
                Id: "e1",
                Name: "Pilot",
                Type: "Episode",
                SeriesName: "Harbor Lights",
                SeriesId: "s1",
                ParentIndexNumber: 1,
                IndexNumber: 1,
              },
            ],
          }),
        );
      if (u.pathname === "/Items" && u.searchParams.get("Ids") === "s1")
        return new Response(
          JSON.stringify({
            Items: [
              {
                Id: "s1",
                Name: "Harbor Lights",
                ProductionYear: 2026,
                ProviderIds: { Tvdb: "77" },
              },
            ],
          }),
        );
      return f(String(input), init as Parameters<Fetch>[1]);
    }) as Fetch;
    const items = await jellyfinRecent(g, "http://jf.local:8096", "key");
    expect(items).toEqual([
      expect.objectContaining({
        kind: "movie",
        title: "Quiet Harbor",
        ids: { tmdb: "700" },
        library: "Films",
        runtimeMin: 102,
        trailers: ["https://www.youtube.com/watch?v=abc123"],
        poster: "/Items/m1/Images/Primary",
      }),
      expect.objectContaining({
        kind: "episode",
        show: "Harbor Lights",
        showIds: { tvdb: "77" },
        season: 1,
        episode: 1,
        library: "Shows",
      }),
    ]);
  });
});

describe("fileName", () => {
  it("keeps only the file's own name, from either kind of path", async () => {
    const { fileName } = await import("./sources");
    expect(fileName("/mnt/f/Movies/2008/The Dark Knight (2008).mkv")).toBe(
      "the dark knight (2008).mkv",
    );
    expect(fileName(String.raw`F:\Movies\2008\The Dark Knight (2008).mkv`)).toBe(
      "the dark knight (2008).mkv",
    );
    expect(fileName(undefined)).toBeUndefined();
  });
});
