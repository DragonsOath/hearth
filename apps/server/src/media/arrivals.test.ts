import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import { MediaArrivals, type ServerRead } from "./arrivals";
import type { LibraryItem } from "./sources";

async function db() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  return handle;
}

const movie = (
  title: string,
  year: number,
  ids: LibraryItem["ids"],
  itemId = title,
): LibraryItem => ({
  itemId,
  kind: "movie",
  title,
  year,
  ids,
  libraryId: "1",
  library: "Movies",
  addedAt: new Date().toISOString(),
  overview: `About ${title}.`,
});

const episode = (show: string, s: number, e: number, showIds: LibraryItem["ids"]): LibraryItem => ({
  itemId: `${show}-${s}-${e}`,
  kind: "episode",
  title: `Episode ${e}`,
  show,
  showIds,
  season: s,
  episode: e,
  ids: {},
  libraryId: "2",
  library: "TV",
  addedAt: new Date(Date.now() + s * 1000 + e).toISOString(),
});

const plex = (items: LibraryItem[]): ServerRead => ({
  serviceId: "plex",
  server: "plex",
  serverName: "Plex",
  items,
});
const jellyfin = (items: LibraryItem[]): ServerRead => ({
  serviceId: "jellyfin",
  server: "jellyfin",
  serverName: "Jellyfin",
  items,
});

const LIBRARY = [
  movie("Old Favorite", 1999, { tmdb: "1" }),
  episode("Long Show", 1, 1, { tvdb: "50" }),
];

describe("media arrivals: what really arrived in the library", () => {
  it("announces nothing already in the library when it starts watching", async () => {
    const a = new MediaArrivals(await db());
    expect(await a.take(plex(LIBRARY))).toEqual([]);
    // The same library read again: still nothing.
    expect(await a.take(plex(LIBRARY))).toEqual([]);
  });

  it("announces a new movie once, with its details, and never again on rescans or restarts", async () => {
    const handle = await db();
    const a = new MediaArrivals(handle);
    await a.take(plex(LIBRARY));
    const arrived = await a.take(
      plex([...LIBRARY, movie("Quiet Harbor", 2026, { tmdb: "700", imdb: "tt07" })]),
    );
    expect(arrived).toHaveLength(1);
    expect(arrived[0]).toMatchObject({
      kind: "movie",
      title: "Quiet Harbor",
      year: 2026,
      overview: "About Quiet Harbor.",
      where: [{ server: "plex", library: "Movies" }],
    });
    expect(await a.take(plex([...LIBRARY, movie("Quiet Harbor", 2026, { tmdb: "700" })]))).toEqual(
      [],
    );
    // A restart (a new instance on the same database) remembers it.
    const again = new MediaArrivals(handle);
    expect(
      await again.take(plex([...LIBRARY, movie("Quiet Harbor", 2026, { tmdb: "700" })])),
    ).toEqual([]);
  });

  it("counts a movie in both Plex and Jellyfin once, even under different ids, and lists both", async () => {
    const a = new MediaArrivals(await db());
    await a.take(plex(LIBRARY));
    await a.take(jellyfin([]));
    const first = await a.take(
      plex([movie("Quiet Harbor", 2026, { tmdb: "700", imdb: "tt07" }, "p1")]),
    );
    expect(first).toHaveLength(1);
    // Jellyfin knows it only by its IMDb id: still the same movie.
    expect(await a.take(jellyfin([movie("Quiet Harbor", 2026, { imdb: "tt07" }, "j1")]))).toEqual(
      [],
    );
    const saved = await a.get(first[0]!.key);
    expect(saved?.where.map((w) => w.server)).toEqual(["plex", "jellyfin"]);
  });

  it("can announce per library instead, when the owner chooses", async () => {
    const a = new MediaArrivals(await db());
    await a.take(plex([]), "per-library");
    await a.take(jellyfin([]), "per-library");
    expect(
      await a.take(plex([movie("Quiet Harbor", 2026, { tmdb: "700" })]), "per-library"),
    ).toHaveLength(1);
    expect(
      await a.take(jellyfin([movie("Quiet Harbor", 2026, { tmdb: "700" })]), "per-library"),
    ).toHaveLength(1);
  });

  it("TV: a new series is announced as a series, a new season as a season, then single episodes", async () => {
    const a = new MediaArrivals(await db());
    await a.take(plex(LIBRARY));
    // Three episodes of a series never seen: one series arrival, nothing else.
    const series = await a.take(
      plex([
        ...LIBRARY,
        episode("The Expanse", 1, 1, { tvdb: "280" }),
        episode("The Expanse", 1, 2, { tvdb: "280" }),
      ]),
    );
    expect(series.map((x) => [x.kind, x.title])).toEqual([["series", "The Expanse"]]);
    // A later season of it: a season arrival.
    const season = await a.take(plex([episode("The Expanse", 2, 1, { tvdb: "280" })]));
    expect(season.map((x) => [x.kind, x.season])).toEqual([["season", 2]]);
    // Another episode of that season: an episode arrival (announced only when turned on).
    const ep = await a.take(plex([episode("The Expanse", 2, 2, { tvdb: "280" })]));
    expect(ep.map((x) => [x.kind, x.season, x.episode, x.episodeTitle])).toEqual([
      ["episode", 2, 2, "Episode 2"],
    ]);
    // A new episode of a series that was already there: an episode, not a new series.
    expect(
      (await a.take(plex([episode("Long Show", 1, 2, { tvdb: "50" })]))).map((x) => x.kind),
    ).toEqual(["episode"]);
  });

  it("offers titles from the library as preview samples", async () => {
    const a = new MediaArrivals(await db());
    await a.take(plex(LIBRARY));
    expect((await a.samples("movie")).map((x) => x.title)).toEqual(["Old Favorite"]);
    expect((await a.samples("series")).map((x) => x.title)).toEqual(["Long Show"]);
  });
});

describe("one file, recognized by only one server", () => {
  // Jellyfin did not recognize the file (no ids, its name as the title, a frame as its picture);
  // Plex did. Both play the same file.
  const unrecognized = {
    ...movie("Batman VI - The Dark Knight", 2008, {}, "jf-1"),
    file: "the dark knight (2008).mkv",
    poster: "/Items/jf-1/Images/Primary",
  };
  const recognized = {
    ...movie("The Dark Knight", 2008, { tmdb: "155" }, "px-1"),
    file: "the dark knight (2008).mkv",
    poster: "/library/metadata/px-1/thumb",
  };

  it("joins them by file name, using the recognized details and picture", async () => {
    const a = new MediaArrivals(await db());
    await a.take(jellyfin([]));
    await a.take(plex([]));
    expect(await a.take(jellyfin([unrecognized]))).toHaveLength(1);
    // The same file on Plex is not a second arrival: the title just gains Plex.
    expect(await a.take(plex([recognized]))).toEqual([]);
    const [only] = await a.samples("movie");
    const t = (await a.get(only!.key))!;
    expect(t.title).toBe("The Dark Knight");
    expect(t.ids).toEqual({ tmdb: "155" });
    expect(t.where.map((w) => w.server)).toEqual(["plex", "jellyfin"]);
    expect(t.where[0]!.poster).toBe("/library/metadata/px-1/thumb");
  });

  it("joins two titles already known apart, once their file names are read, announcing nothing", async () => {
    const a = new MediaArrivals(await db());
    // Known from before Hearth read file names: two separate titles.
    const { file: _a, ...oldJf } = unrecognized;
    const { file: _b, ...oldPx } = recognized;
    await a.take(jellyfin([oldJf]));
    await a.take(plex([oldPx]));
    expect(await a.samples("movie")).toHaveLength(2);
    expect(await a.take(jellyfin([unrecognized]), "across", { linkOnly: true })).toEqual([]);
    expect(await a.take(plex([recognized]), "across", { linkOnly: true })).toEqual([]);
    const titles = await a.samples("movie");
    expect(titles.map((x) => x.title)).toEqual(["The Dark Knight"]);
    const t = (await a.get(titles[0]!.key))!;
    expect(t.where.map((w) => w.server).sort()).toEqual(["jellyfin", "plex"]);
    // A link-only read never adds a title it has not met.
    expect(
      await a.take(plex([movie("Brand New", 2026, { tmdb: "9" })]), "across", { linkOnly: true }),
    ).toEqual([]);
    expect(await a.samples("movie")).toHaveLength(1);
  });
});
