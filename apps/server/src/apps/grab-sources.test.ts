import { describe, expect, it } from "vitest";
import { sourceIndex, trackerSource } from "./grab-sources";

describe("where a download came from", () => {
  it("matches by the download's id first, then by its name, newest record winning", () => {
    const idx = sourceIndex([
      {
        downloadId: "ABC123",
        title: "Show.S01E01.1080p",
        indexer: "Nyaa (Prowlarr)",
        via: "Sonarr",
      },
      { downloadId: "abc123", indexer: "Older", via: "Sonarr" },
      { title: "Movie 2024 1080p", indexer: "PublicTracker", via: "Prowlarr" },
    ]);
    expect(idx.find("abc123", undefined)).toEqual({ indexer: "Nyaa", via: "Sonarr" });
    expect(idx.find("nope", "Movie.2024.1080p")).toEqual({
      indexer: "PublicTracker",
      via: "Prowlarr",
    });
    expect(idx.find("nope", "Other")).toBeUndefined();
  });
  it("names a private tracker from its address, not a public one", () => {
    expect(trackerSource("https://tracker.torrentday.com/announce.php?passkey=x")?.indexer).toBe(
      "TorrentDay",
    );
    expect(trackerSource("udp://tracker.opentrackr.org:1337/announce")).toBeUndefined();
  });
});
