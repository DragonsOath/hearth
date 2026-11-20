import { describe, expect, it } from "vitest";
import { classifyFiles, classifyName, mapPath } from "./manual-sort";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe("classifyFiles", () => {
  it("files a single film, ignoring its sample and subtitles", () => {
    expect(
      classifyFiles([
        { name: "Heat.1995.1080p/Heat.1995.1080p.mkv", size: 9 * GB },
        { name: "Heat.1995.1080p/Sample/heat-sample.mkv", size: 60 * MB },
        { name: "Heat.1995.1080p/Heat.srt", size: 90_000 },
      ]).type,
    ).toBe("movie");
  });

  it("files a season pack and a single episode as a show", () => {
    expect(
      classifyFiles(
        Array.from({ length: 10 }, (_, i) => ({
          name: `Show.S01/Show.S01E${String(i + 1).padStart(2, "0")}.mkv`,
          size: 1.2 * GB,
        })),
      ).type,
    ).toBe("tv");
    expect(classifyFiles([{ name: "Ghosts.2021.S02E09.1080p.mkv", size: 2 * GB }]).type).toBe("tv");
  });

  it("files an album, an audiobook by chapters, an m4b and ebooks", () => {
    expect(
      classifyFiles([
        { name: "Artist - Album (2020) [FLAC]/01 - Intro.flac", size: 30 * MB },
        { name: "Artist - Album (2020) [FLAC]/02 - Song.flac", size: 40 * MB },
        { name: "Artist - Album (2020) [FLAC]/cover.jpg", size: 2 * MB },
      ]).type,
    ).toBe("music");
    expect(
      classifyFiles([
        { name: "Book/Chapter 01.mp3", size: 50 * MB },
        { name: "Book/Chapter 02.mp3", size: 50 * MB },
        { name: "Book/Chapter 03.mp3", size: 50 * MB },
      ]).type,
    ).toBe("audiobook");
    expect(classifyFiles([{ name: "Dune.m4b", size: 900 * MB }]).type).toBe("audiobook");
    expect(
      classifyFiles([
        { name: "Pack/a.epub", size: 2 * MB },
        { name: "Pack/b.mobi", size: 3 * MB },
      ]).type,
    ).toBe("ebook");
  });

  it("never guesses: a mix, long numbered MP3s, or look-alike videos are Unsorted", () => {
    expect(
      classifyFiles([
        { name: "x/film.mkv", size: 2 * GB },
        { name: "x/score/01 - a.flac", size: 1.5 * GB },
      ]).type,
    ).toBe("unsorted");
    expect(
      classifyFiles([
        { name: "x/01.mp3", size: 200 * MB },
        { name: "x/02.mp3", size: 200 * MB },
      ]).type,
    ).toBe("unsorted");
    expect(
      classifyFiles([
        { name: "x/a.mkv", size: 2 * GB },
        { name: "x/b.mkv", size: 2 * GB },
      ]).type,
    ).toBe("unsorted");
    expect(classifyFiles([{ name: "setup.exe", size: 2 * GB }]).type).toBe("unsorted");
    expect(classifyFiles([]).type).toBe("unsorted");
  });
});

describe("classifyName", () => {
  it("reads release names", () => {
    expect(classifyName("Doctor.Who.2005.S09E12.Hell.Bent.720p.WEB-DL").type).toBe("tv");
    expect(classifyName("Heat.1995.1080p.BluRay.x264-GROUP").type).toBe("movie");
    expect(classifyName("Artist - Album (2019) [FLAC]").type).toBe("music");
    expect(classifyName("Author - Title (Unabridged) Audiobook").type).toBe("audiobook");
    expect(classifyName("Author - Title EPUB").type).toBe("ebook");
    expect(classifyName("random stuff").type).toBe("unsorted");
  });
});

describe("mapPath", () => {
  it("maps through the longest matching remote path", () => {
    const maps = [
      { remotePath: "/usenet/", localPath: "/mnt/d/Downloads/Usenet/" },
      { remotePath: "/movies-temp/", localPath: "/mnt/f/Qbit/Temp Movies/" },
    ];
    expect(mapPath("/movies-temp/Heat (1995)", maps)).toBe("/mnt/f/Qbit/Temp Movies/Heat (1995)");
    expect(mapPath("/usenet/Complete/TV/x", maps)).toBe("/mnt/d/Downloads/Usenet/Complete/TV/x");
    expect(mapPath("/other/x", maps)).toBe("/other/x");
  });
});
