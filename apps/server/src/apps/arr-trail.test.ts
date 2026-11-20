import type { ArrHistoryEvent } from "@dragon-control/core";
import { describe, expect, it } from "vitest";
import { downloadTrails } from "./arr-trail";

/** Download trails, from history shaped like the owner's Radarr (Motor City, 10-26). */

const NOW = Date.parse("2026-10-26T13:00:00Z");
const HISTORY: ArrHistoryEvent[] = [
  {
    at: "2026-10-26T12:22:36Z",
    event: "imported",
    title: "Motor City (2026)",
    downloadId: "A1257D64",
    client: "SABnzbd",
    droppedPath:
      "/usenet-movies/Motor.City.2026.1080p.WEB-DL-BONE/Motor.City.2026.1080p.WEB-DL-BONE.mkv",
    importedPath: "/new releases/2026/Motor City/Motor City (2026).WEBDL-1080p.mkv",
  },
  {
    at: "2026-10-26T12:16:32Z",
    event: "grabbed",
    title: "Motor City (2026)",
    release: "Motor.City.2026.1080p.WEB-DL-BONE",
    downloadId: "A1257D64",
    client: "SABnzbd",
    indexer: "UsenetOne (Prowlarr)",
  },
  {
    at: "2026-10-26T12:16:02Z",
    event: "grabbed",
    title: "Motor City (2026)",
    release: "Motor.City.2026.2160p",
    downloadId: "0486A897",
    client: "SABnzbd",
    indexer: "UsenetOne (Prowlarr)",
  },
  {
    at: "2026-10-26T11:00:00Z",
    event: "renamed",
    title: "Anora (2024)",
    renamedFrom: "/movies/Anora (2024)/anora.2024.mkv",
    renamedTo: "/movies/Anora (2024)/Anora (2024) Bluray-1080p.mkv",
  },
];

describe("download trails", () => {
  it("follows a download from the grab, through the download folder, into the library", () => {
    const trails = downloadTrails("Radarr", HISTORY, [], NOW);
    const motor = trails.find((t) => t.key === "a1257d64")!;
    expect(motor).toMatchObject({
      title: "Motor City (2026)",
      release: "Motor.City.2026.1080p.WEB-DL-BONE",
      status: "imported",
    });
    expect(motor.steps).toEqual([
      {
        kind: "grabbed",
        at: "2026-10-26T12:16:32Z",
        text: "Radarr grabbed it from UsenetOne (Prowlarr) and sent it to SABnzbd",
      },
      {
        kind: "imported",
        at: "2026-10-26T12:22:36Z",
        text: "Radarr imported it, renamed into the library",
        from: "/usenet-movies/Motor.City.2026.1080p.WEB-DL-BONE/Motor.City.2026.1080p.WEB-DL-BONE.mkv",
        to: "/new releases/2026/Motor City/Motor City (2026).WEBDL-1080p.mkv",
      },
    ]);
    // The first grab never arrived and is in no queue: it says so, not "still grabbed".
    expect(trails.find((t) => t.key === "0486a897")).toMatchObject({ status: "failed" });
    // A later rename shows the name before and after.
    expect(trails.find((t) => t.status === "renamed")?.steps[0]).toMatchObject({
      from: "/movies/Anora (2024)/anora.2024.mkv",
      to: "/movies/Anora (2024)/Anora (2024) Bluray-1080p.mkv",
    });
    expect(trails.map((t) => t.updatedAt)).toEqual([
      "2026-10-26T12:22:36Z",
      "2026-10-26T12:16:02Z",
      "2026-10-26T11:00:00Z",
    ]);
  });

  it("shows what is downloading now, and where, and one waiting to be imported", () => {
    const trails = downloadTrails(
      "Sonarr",
      [
        {
          at: "2026-10-26T12:50:00Z",
          event: "grabbed",
          title: "Ghosts S02E10",
          downloadId: "abc",
          client: "SABnzbd",
        },
      ],
      [
        {
          downloadId: "ABC",
          title: "Ghosts S02E10",
          state: "downloading",
          progressPct: 40,
          timeLeft: "00:03:10",
          client: "SABnzbd",
          outputPath: "/usenet-tv/Ghosts.S02E10",
        },
        {
          downloadId: "def",
          title: "Ghosts S02E11",
          state: "importPending",
          outputPath: "/usenet-tv/Ghosts.S02E11",
        },
      ],
      NOW,
    );
    expect(trails.find((t) => t.key === "abc")?.steps[1]).toEqual({
      kind: "downloading",
      text: "Downloading in SABnzbd · 40% · 00:03:10 left",
      progressPct: 40,
      to: "/usenet-tv/Ghosts.S02E10",
    });
    expect(trails.find((t) => t.key === "def")).toMatchObject({
      status: "importing",
      steps: [{ kind: "importing", to: "/usenet-tv/Ghosts.S02E11" }],
    });
  });

  it("folds an album's many imported files into one step", () => {
    const tracks: ArrHistoryEvent[] = [1, 2, 3].map((n) => ({
      at: `2026-10-26T12:0${n}:00Z`,
      event: "imported",
      title: "Artist: Album",
      downloadId: "x",
      droppedPath: `/downloads/Album/0${n}.flac`,
      importedPath: `/music/Artist/Album/0${n} - Track.flac`,
    }));
    const [t] = downloadTrails("Lidarr", tracks, [], NOW);
    expect(t?.steps).toEqual([
      {
        kind: "imported",
        at: "2026-10-26T12:03:00Z",
        text: "Lidarr imported 3 files, renamed into the library",
        from: "/downloads/Album",
        to: "/music/Artist/Album",
      },
    ]);
  });
});
