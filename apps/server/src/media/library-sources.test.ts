import { describe, expect, it } from "vitest";
import type { Fetch } from "../apps/http";
import {
  absEpisode,
  absItem,
  audiobookshelfRecent,
  jellyfinAlbum,
  kavitaItem,
  navidromeAlbum,
  plexAlbum,
  plexAlbums,
} from "./library-sources";

// "New in your library": what each library app just added, in one shape. Raw shapes follow each
// app's API (Audiobookshelf checked against its source; Kavita not yet against a real install).

const lib = { id: "7", name: "Music" };

/** A fetch that answers each path (query included) from a table, and records what was asked. */
function stub(routes: Record<string, unknown>): { f: Fetch; asked: string[] } {
  const asked: string[] = [];
  const f = (async (url: string) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    asked.push(path);
    const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
    return {
      ok: Boolean(hit),
      status: hit ? 200 : 404,
      json: async () => hit?.[1],
      text: async () => JSON.stringify(hit?.[1] ?? null),
      headers: new Headers(),
    };
  }) as unknown as Fetch;
  return { f, asked };
}

describe("music", () => {
  it("Plex: an album with its artist, tracks and MusicBrainz id", () => {
    const a = plexAlbum(
      {
        ratingKey: "55",
        title: "Rumours",
        parentTitle: "Fleetwood Mac",
        year: 1977,
        addedAt: 1_700_000_000,
        leafCount: 11,
        thumb: "/library/metadata/55/thumb/1",
        Genre: [{ tag: "Rock" }],
        Guid: [{ id: "mbid://abc-123" }],
      },
      lib,
    );
    expect(a).toMatchObject({
      kind: "album",
      title: "Rumours",
      creators: ["Fleetwood Mac"],
      tracks: 11,
      year: 1977,
      ids: { mbid: "abc-123" },
      genres: ["Rock"],
      poster: "/library/metadata/55/thumb/1",
      addedAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("Plex: only music libraries are read; photos and home videos never are", async () => {
    const { f, asked } = stub({
      "/library/sections/3/all": { MediaContainer: { Metadata: [{ ratingKey: "1", title: "A" }] } },
      "/library/sections": {
        MediaContainer: {
          Directory: [
            { key: "1", type: "movie", title: "Movies" },
            { key: "2", type: "photo", title: "Family photos" },
            { key: "3", type: "artist", title: "Music" },
          ],
        },
      },
    });
    const albums = await plexAlbums(f, "http://plex:32400", "t");
    expect(albums.map((a) => a.title)).toEqual(["A"]);
    expect(asked.some((p) => p.includes("/sections/2/"))).toBe(false);
    expect(asked.find((p) => p.includes("/sections/3/"))).toContain("type=9");
  });

  it("Jellyfin and Emby: an album with its artists and length", () => {
    const a = jellyfinAlbum(
      {
        Id: "x1",
        Name: "Kind of Blue",
        AlbumArtists: [{ Name: "Miles Davis" }],
        ProductionYear: 1959,
        ChildCount: 5,
        RunTimeTicks: 46 * 60 * 10_000_000,
        Genres: ["Jazz"],
        ImageTags: { Primary: "t" },
        ProviderIds: { MusicBrainzAlbum: "mb-1" },
      },
      lib,
    );
    expect(a).toMatchObject({
      kind: "album",
      creators: ["Miles Davis"],
      tracks: 5,
      runtimeMin: 46,
      ids: { mbid: "mb-1" },
      poster: "/Items/x1/Images/Primary",
    });
  });

  it("Navidrome: an album from the newest list", () => {
    expect(
      navidromeAlbum({
        id: "al-1",
        name: "Blue Train",
        artist: "John Coltrane",
        year: 1957,
        songCount: 5,
        duration: 2580,
        genre: "Jazz",
        created: "2026-11-10T10:00:00Z",
        coverArt: "al-1",
      }),
    ).toMatchObject({
      kind: "album",
      creators: ["John Coltrane"],
      runtimeMin: 43,
      genres: ["Jazz"],
    });
  });
});

describe("Audiobookshelf", () => {
  const books = { id: "lib-b", name: "Books" };

  it("an item with audio is an audiobook: author, narrator, series, length", () => {
    expect(
      absItem(
        {
          id: "li_1",
          addedAt: 1_763_000_000_000,
          media: {
            numTracks: 30,
            duration: 72_600,
            coverPath: "/covers/1.jpg",
            metadata: {
              title: "Leviathan Wakes",
              authorName: "James S. A. Corey",
              narratorName: "Jefferson Mays",
              seriesName: "The Expanse #1",
              publishedYear: "2011",
              genres: ["Science Fiction"],
            },
          },
        },
        books,
      ),
    ).toMatchObject({
      kind: "audiobook",
      creators: ["James S. A. Corey"],
      narrators: ["Jefferson Mays"],
      seriesName: "The Expanse",
      seriesIndex: 1,
      runtimeMin: 1210,
      year: 2011,
      poster: "/api/items/li_1/cover",
    });
  });

  it("only a book file is an ebook; an item with neither is skipped", () => {
    expect(
      absItem(
        { id: "li_2", media: { numTracks: 0, ebookFormat: "epub", metadata: { title: "Dune" } } },
        books,
      )?.kind,
    ).toBe("book");
    expect(absItem({ id: "li_3", media: { numTracks: 0 } }, books)).toBeUndefined();
  });

  it("a podcast episode names its show", () => {
    expect(
      absEpisode(
        {
          id: "ep1",
          libraryItemId: "li_9",
          title: "Episode 200",
          publishedAt: 1_763_000_000_000,
          podcast: { metadata: { title: "Homelab Hour", author: "Two Friends" } },
        },
        { id: "lib-p", name: "Podcasts" },
      ),
    ).toMatchObject({ kind: "podcast", itemId: "li_9/ep1", podcastShow: "Homelab Hour" });
  });

  it("reads book libraries newest first and podcast libraries by recent episode", async () => {
    const { f, asked } = stub({
      "/api/libraries/lib-b/items": {
        results: [{ id: "li_1", media: { numTracks: 2, metadata: { title: "A" } } }],
      },
      "/api/libraries/lib-p/recent-episodes": {
        episodes: [{ id: "e", libraryItemId: "p", title: "B" }],
      },
      "/api/libraries": {
        libraries: [
          { id: "lib-b", name: "Books", mediaType: "book" },
          { id: "lib-p", name: "Podcasts", mediaType: "podcast" },
        ],
      },
    });
    const items = await audiobookshelfRecent(f, "http://abs", "k");
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ["audiobook", "A"],
      ["podcast", "B"],
    ]);
    expect(asked.find((p) => p.includes("lib-b"))).toContain("sort=addedAt&desc=1");
  });
});

describe("one library failing never hides the others", () => {
  it("a podcast route an older Audiobookshelf lacks still leaves its books", async () => {
    const { f } = stub({
      "/api/libraries/lib-b/items": {
        results: [{ id: "li_1", media: { numTracks: 2, metadata: { title: "A" } } }],
      },
      "/api/libraries": {
        libraries: [
          { id: "lib-b", name: "Books", mediaType: "book" },
          { id: "lib-p", name: "Podcasts", mediaType: "podcast" },
        ],
      },
    });
    expect((await audiobookshelfRecent(f, "http://abs", "k")).map((i) => i.title)).toEqual(["A"]);
  });

  it("but when every library fails, the read fails (a down server is not an empty one)", async () => {
    const f = (async (url: string) => {
      const ok = new URL(url).pathname === "/api/libraries";
      const body = ok ? { libraries: [{ id: "lib-b", name: "Books", mediaType: "book" }] } : {};
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
        text: async () => JSON.stringify(body),
        headers: new Headers(),
      };
    }) as unknown as Fetch;
    await expect(audiobookshelfRecent(f, "http://abs", "k")).rejects.toThrow();
  });
});

describe("Kavita", () => {
  it("a comic chapter carries its series and number; image libraries are never announced", () => {
    expect(
      kavitaItem({
        seriesId: 4,
        seriesName: "Saga",
        libraryId: 2,
        libraryType: 1,
        title: "Chapter 12",
        chapterId: 99,
        created: "2026-11-10T10:00:00",
      }),
    ).toMatchObject({
      kind: "comic",
      seriesName: "Saga",
      seriesIndex: 12,
      itemId: "4/99",
      addedAt: "2026-11-10T10:00:00Z",
    });
    expect(kavitaItem({ seriesId: 1, seriesName: "Holiday 2024", libraryType: 3 })).toBeUndefined();
    expect(kavitaItem({ seriesId: 2, seriesName: "Dune", libraryType: 2 })?.kind).toBe("book");
  });
});
