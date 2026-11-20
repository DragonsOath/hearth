import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fsSource } from "../storage/fs-source";
import { byAuthor, byYear, formatSize, renderCatalogPdf } from "./pdf";
import { Scanner, bookTitle, titleAndYear } from "./scan";

const root = mkdtempSync(path.join(tmpdir(), "hearth-catalog-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Makes a file of a given size (sparse enough for tests). */
function file(rel: string, bytes = 1000) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes));
}

// Movies: "Title (Year)" folders, a year folder above a plain name, a scene-named file in a
// plain folder, extras and subtitles, a loose video, and a folder with no video.
file("Movies/Heat (1995)/Heat (1995).mkv", 5000);
file("Movies/Heat (1995)/Featurettes/Making of.mkv", 700);
file("Movies/Heat (1995)/Subs/en.srt", 300);
file("Movies/2024/Wicked/Wicked.mkv", 4000);
file("Movies/Collections/John Wick/John.Wick.2014.1080p.BluRay.x264.mkv", 3000);
file("Movies/Arrival.2016.2160p.mkv", 2000);
file("Movies/Artwork/poster.jpg", 100);
// Shows: years from the name or from Sonarr, episodes counted, an empty folder skipped.
file("Shows/Friends/Season 1/Friends - S01E01.mkv", 900);
file("Shows/Friends/Season 1/Friends - S01E02.mkv", 900);
file("Shows/Ghosts (2021)/Season 2/Ghosts - S02E10.mkv", 800);
file("Shows/Unknown Show/S01/ep1.mp4", 100);
mkdirSync(path.join(root, "Shows/Empty"), { recursive: true });
// Audiobooks (Audiobookshelf layout): Author/Book, Author/Series/Book, a book in CD folders,
// single .m4b files in an author folder, a loose book, and a cover-only folder.
file("Audiobooks/Frank Herbert/Dune Saga/Book 1 - 1965 - Dune {Scott Brick}/01.mp3", 500);
file("Audiobooks/Frank Herbert/Dune Saga/Book 1 - 1965 - Dune {Scott Brick}/02.mp3", 500);
file("Audiobooks/Frank Herbert/Dune Saga/Book 1 - 1965 - Dune {Scott Brick}/cover.jpg", 50);
file("Audiobooks/Andy Weir/Project Hail Mary/CD1/track1.mp3", 300);
file("Audiobooks/Andy Weir/Project Hail Mary/CD2/track1.mp3", 300);
file("Audiobooks/Stephen King/It.m4b", 900);
file("Audiobooks/Stephen King/The Shining.m4b", 800);
file("Audiobooks/Loose Book.m4b", 100);
file("Audiobooks/Artwork/folder.jpg", 10);
// Ebooks: a Calibre book in two formats, files in an author folder, and loose files.
file("Ebooks/Frank Herbert/Dune (12)/Dune - Frank Herbert.epub", 400);
file("Ebooks/Frank Herbert/Dune (12)/Dune - Frank Herbert.mobi", 600);
file("Ebooks/Frank Herbert/Dune (12)/cover.jpg", 50);
file("Ebooks/Frank Herbert/Dune (12)/metadata.opf", 5);
file("Ebooks/Terry Pratchett/Mort.epub", 200);
file("Ebooks/Terry Pratchett/Guards! Guards!.epub", 200);
file("Ebooks/Watchmen 01.cbz", 700);

describe("Collection PDF scanning", () => {
  it("reads titles and years the way people name folders and files", () => {
    expect(titleAndYear("Heat (1995)")).toEqual({ t: "Heat", y: 1995 });
    expect(titleAndYear("Blade Runner 2049 (2017)")).toEqual({ t: "Blade Runner 2049", y: 2017 });
    expect(titleAndYear("John.Wick.2014.1080p.BluRay.x264")).toEqual({ t: "John Wick", y: 2014 });
    expect(titleAndYear("Ghosts [2021]")).toEqual({ t: "Ghosts", y: 2021 });
    expect(titleAndYear("Friends")).toBeUndefined();
    expect(titleAndYear("2001 A Space Odyssey")).toBeUndefined();
  });

  it("lists movies: one per folder with a video, extras counted, year folders used, no-video folders skipped", async () => {
    const scan = new Scanner(fsSource(root, { listing: { maxEntries: 0, maxMs: 0 } }));
    const items = (await scan.movies(["Movies"])).sort((a, b) => a.t.localeCompare(b.t));
    expect(items).toEqual([
      { t: "Arrival", y: 2016, s: 2000 },
      { t: "Heat", y: 1995, s: 6000 },
      { t: "John Wick", y: 2014, s: 3000 },
      { t: "Wicked", y: 2024, s: 4000 },
    ]);
    expect(scan.stoppedEarly).toBe(false);
  });

  it("lists shows: one per folder, episodes counted, years from the name or Sonarr", async () => {
    const scan = new Scanner(fsSource(root, { listing: { maxEntries: 0, maxMs: 0 } }));
    const items = (await scan.shows(["Shows"], new Map([["friends", 1994]]))).sort((a, b) =>
      a.t.localeCompare(b.t),
    );
    expect(items).toEqual([
      { t: "Friends", y: 1994, s: 1800, n: 2 },
      { t: "Ghosts", y: 2021, s: 800, n: 1 },
      { t: "Unknown Show", s: 100, n: 1 },
    ]);
  });

  it("reads book names the way Audiobookshelf and Calibre write them", () => {
    expect(bookTitle("Book 1 - 1965 - Dune {Scott Brick}")).toEqual({ t: "Dune", y: 1965 });
    expect(bookTitle("Dune (12)")).toEqual({ t: "Dune" });
    expect(bookTitle("Dune - Frank Herbert", "Frank Herbert")).toEqual({ t: "Dune" });
    expect(bookTitle("01 - The Way of Kings")).toEqual({ t: "The Way of Kings" });
    expect(bookTitle("1984")).toEqual({ t: "1984" });
  });

  it("lists audiobooks: a folder of audio is one book, CD folders join it, .m4b files are a book each", async () => {
    const scan = new Scanner(fsSource(root, { listing: { maxEntries: 0, maxMs: 0 } }));
    const items = (await scan.audiobooks(["Audiobooks"])).sort((a, b) => a.t.localeCompare(b.t));
    expect(items).toEqual([
      { t: "Dune", y: 1965, a: "Frank Herbert", s: 1050, n: 2 },
      { t: "It", a: "Stephen King", s: 900, n: 1 },
      { t: "Loose Book", s: 100, n: 1 },
      { t: "Project Hail Mary", a: "Andy Weir", s: 600, n: 2 },
      { t: "The Shining", a: "Stephen King", s: 800, n: 1 },
    ]);
  });

  it("lists ebooks: a book's formats count once, authors from the folder above", async () => {
    const scan = new Scanner(fsSource(root, { listing: { maxEntries: 0, maxMs: 0 } }));
    const items = (await scan.ebooks(["Ebooks"])).sort((a, b) => a.t.localeCompare(b.t));
    expect(items).toEqual([
      { t: "Dune", a: "Frank Herbert", s: 1055 },
      { t: "Guards! Guards!", a: "Terry Pratchett", s: 200 },
      { t: "Mort", a: "Terry Pratchett", s: 200 },
      { t: "Watchmen 01", s: 700 },
    ]);
  });

  it("stops at its limit and says so", async () => {
    const scan = new Scanner(fsSource(root, { listing: { maxEntries: 0, maxMs: 0 } }), {
      maxFolders: 2,
      maxMs: 60_000,
      maxDepth: 8,
    });
    await scan.movies(["Movies"]);
    expect(scan.stoppedEarly).toBe(true);
  });
});

describe("Collection PDF document", () => {
  it("groups by year, newest first, unknown last, titles in natural order", () => {
    expect(
      byYear([
        { t: "B", y: 2001, s: 1 },
        { t: "Z", s: 1 },
        { t: "Season 10", y: 2024, s: 1 },
        { t: "Season 2", y: 2024, s: 1 },
      ]).map((g) => [g.year, g.items.map((i) => i.t)]),
    ).toEqual([
      ["2024", ["Season 2", "Season 10"]],
      ["2001", ["B"]],
      ["Year unknown", ["Z"]],
    ]);
    expect(
      byAuthor([
        { t: "Mort", a: "Terry Pratchett", s: 1 },
        { t: "The Hobbit", s: 1 },
        { t: "Dune", a: "Frank Herbert", s: 1 },
        { t: "Eric", a: "Terry Pratchett", s: 1 },
        { t: "1984", s: 1 },
      ]).map((g) => [g.year, g.items.map((i) => i.t)]),
    ).toEqual([
      ["F", ["Dune"]],
      ["H", ["The Hobbit"]],
      ["T", ["Eric", "Mort"]],
      ["#", ["1984"]],
    ]);
    expect(formatSize(1.5 * 1024 ** 3)).toBe("1.50G");
    expect(formatSize(300 * 1024 ** 2)).toBe("300M");
  });

  it("makes a PDF with links to every shelf and year, and prints other scripts without a font", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      t: `Movie ${i}`,
      y: 1990 + (i % 30),
      s: 2e9,
    }));
    const pdf = await renderCatalogPdf(
      {
        title: "My Collection",
        made: "October 25, 2026",
        shelves: [
          {
            name: "Movies",
            kind: "movies",
            items: [...many, { t: "千と千尋の神隠し", y: 2001, s: 1e9 }],
          },
          { name: "Shows", kind: "shows", items: [{ t: "Friends", y: 1994, s: 5e10, n: 236 }] },
          {
            name: "Audio Books",
            kind: "audiobooks",
            items: [{ t: "Dune", a: "Frank Herbert", s: 1e9, n: 40 }],
          },
        ],
      },
      { unicodeFont: null },
    );
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("/Dests");
    // Named destinations for the contents, each shelf, and a year.
    for (const dest of [
      "contents",
      "shelf-movies",
      "shelf-shows",
      "shelf-movies-2019",
      "shelf-audio-books-f",
    ])
      expect(text).toContain(`(${dest})`);
    const pages = (text.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(3);
    // Every page after the cover links back to the contents, not just each shelf's first page.
    expect((text.match(/\/D \(contents\)/g) ?? []).length).toBe(pages - 1);
    // Bookmarks open in the viewer's side panel.
    expect(text).toContain("/Outlines");
    expect(text).toContain("/PageMode /UseOutlines");
  });
});
