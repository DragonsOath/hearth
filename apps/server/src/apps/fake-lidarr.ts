import { fakeArrV1 } from "./fake-arr-v1";
import { iso, reply, servarrCore, sharedState, type Json } from "./fake-servarr";
import type { Fetch } from "./http";

/**
 * A stand-in Lidarr 3.1 (port 8686) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), shaped like the real test Lidarr's answers (checklist 46.10): artists, albums, tracks
 * and files, audio quality and metadata profiles, Lidarr's own artist search, a file waiting to be
 * imported, and the shared settings, connections, system and log through the Servarr stand-in core
 * (on v1 paths). The queue, missing albums, calendar, release search and their commands are the
 * older Lidarr dashboard's stand-in (fake-arr-v1.ts), so its tests keep their data.
 */

export interface FakeLidarr {
  fetch: Fetch;
  reset(): void;
}

const MB = 1024 ** 2;
const AUDIO = {
  flac: { id: 6, name: "FLAC" },
  alac: { id: 7, name: "ALAC" },
  mp3320: { id: 4, name: "MP3-320" },
  mp3256: { id: 3, name: "MP3-256" },
  aac320: { id: 10, name: "AAC-320" },
} as const;

const ARTISTS: [number, string, string, string, string][] = [
  [1, "Radiohead", "a74b1b7f-71a5-4011-9441-d0b5e4122711", "Group", "English rock band"],
  [2, "Bjork", "87c5dedd-371d-4a53-9f7f-80522fb7f3cb", "Person", "Icelandic singer"],
  [3, "Low", "9d4e6b4f-5f1a-4f61-bc0c-3f4e0c1c4d11", "Group", "Minnesota band"],
];
/** [id, artistId, title, released, monitored, track titles, files on disk] */
const ALBUMS: [number, number, string, string, boolean, string[], boolean][] = [
  [
    31,
    1,
    "Kid A",
    "2000-10-02",
    true,
    ["Everything in Its Right Place", "Kid A", "The National Anthem"],
    false,
  ],
  [
    32,
    1,
    "OK Computer",
    "1997-05-21",
    true,
    ["Airbag", "Paranoid Android", "Subterranean Homesick Alien"],
    true,
  ],
  [33, 1, "Pablo Honey", "1993-02-22", false, ["You", "Creep", "How Do You?"], false],
  [41, 2, "Post", "1995-06-13", true, ["Army of Me", "Hyperballad", "The Modern Things"], true],
  [42, 2, "Homogenic", "1997-09-22", true, ["Hunter", "Joga", "Unravel"], false],
  [
    51,
    3,
    "Things We Lost in the Fire",
    "2001-01-29",
    false,
    ["Sunflower", "Whitetail", "Dinosaur Act"],
    false,
  ],
];

function build() {
  let trackId = 1000;
  let fileId = 500;
  const artists: Json[] = ARTISTS.map(([id, name, mbid, type, note]) => ({
    id,
    artistName: name,
    sortName: name.toLowerCase(),
    foreignArtistId: mbid,
    artistType: type,
    disambiguation: note,
    status: id === 3 ? "ended" : "continuing",
    overview: `${name}: a stand-in artist for Hearth's tests.`,
    path: `/music/${name}`,
    rootFolderPath: "/music",
    qualityProfileId: 1,
    metadataProfileId: 1,
    monitored: id !== 3,
    monitorNewItems: "all",
    genres: id === 2 ? ["Electronic", "Art Pop"] : ["Rock", "Alternative"],
    tags: id === 2 ? [1] : [],
    added: iso(-200 + id),
  }));
  const albums: Json[] = [];
  const tracks: Json[] = [];
  const files: Json[] = [];
  for (const [id, artistId, title, released, monitored, names, onDisk] of ALBUMS) {
    albums.push({
      id,
      artistId,
      title,
      foreignAlbumId: `stand-in-album-${id}`,
      albumType: "Album",
      secondaryTypes: [],
      releaseDate: `${released}T00:00:00Z`,
      monitored,
      anyReleaseOk: true,
      releases: [{ id: id * 10, title, trackCount: names.length, monitored: true }],
    });
    names.forEach((t, i) => {
      const fid = onDisk ? ++fileId : 0;
      if (onDisk)
        files.push({
          id: fid,
          artistId,
          albumId: id,
          path: `/music/${String(artists.find((a) => a.id === artistId)!.artistName)}/${title}/${String(i + 1).padStart(2, "0")} - ${t}.flac`,
          size: 32 * MB + i * MB,
          quality: { quality: AUDIO.flac },
        });
      tracks.push({
        id: ++trackId,
        artistId,
        albumId: id,
        trackNumber: String(i + 1),
        absoluteTrackNumber: i + 1,
        mediumNumber: 1,
        title: t,
        duration: 240_000 + i * 30_000,
        hasFile: onDisk,
        trackFileId: fid,
      });
    });
  }
  return { artists, albums, tracks, files };
}

function stats(lib: ReturnType<typeof build>, filter: (x: Json) => boolean) {
  const t = lib.tracks.filter(filter);
  const f = lib.files.filter(filter);
  return {
    albumCount: lib.albums.filter(filter).length,
    trackFileCount: f.length,
    trackCount: t.filter((x) => x.hasFile).length + t.filter((x) => !x.hasFile).length,
    totalTrackCount: t.length,
    sizeOnDisk: f.reduce((n, x) => n + Number(x.size), 0),
    percentOfTracks: t.length ? Math.round((f.length / t.length) * 100) : 0,
  };
}

function initialState() {
  const lib = build();
  const base = sharedState("lidarr");
  const item = (q: { id: number; name: string }, allowed: boolean) => ({
    quality: q,
    items: [],
    allowed,
  });
  return {
    ...base,
    ...lib,
    profiles: [
      {
        id: 1,
        name: "Lossless",
        upgradeAllowed: true,
        cutoff: AUDIO.flac.id,
        items: [
          item(AUDIO.flac, true),
          item(AUDIO.alac, true),
          item(AUDIO.mp3320, false),
          item(AUDIO.mp3256, false),
          item(AUDIO.aac320, false),
        ],
        minFormatScore: 0,
        cutoffFormatScore: 0,
        minUpgradeFormatScore: 1,
        formatItems: [],
      },
      {
        id: 2,
        name: "Standard",
        upgradeAllowed: false,
        cutoff: AUDIO.mp3320.id,
        items: [
          item(AUDIO.flac, false),
          item(AUDIO.alac, false),
          item(AUDIO.mp3320, true),
          item(AUDIO.mp3256, true),
          item(AUDIO.aac320, true),
        ],
        minFormatScore: 0,
        cutoffFormatScore: 0,
        minUpgradeFormatScore: 1,
        formatItems: [],
      },
    ] as Json[],
    formats: [] as Json[],
    sizes: Object.values(AUDIO).map((q, i) => ({
      id: i + 1,
      quality: q,
      title: q.name,
      weight: i + 1,
      minSize: 0,
      maxSize: null,
      preferredSize: null,
    })) as Json[],
    metadataProfiles: [
      {
        id: 1,
        name: "Standard",
        primaryAlbumTypes: [
          { albumType: { id: 0, name: "Album" }, allowed: true },
          { albumType: { id: 1, name: "EP" }, allowed: false },
          { albumType: { id: 2, name: "Single" }, allowed: false },
        ],
        secondaryAlbumTypes: [
          { albumType: { id: 0, name: "Studio" }, allowed: true },
          { albumType: { id: 6, name: "Live" }, allowed: false },
          { albumType: { id: 1, name: "Compilation" }, allowed: false },
        ],
        releaseStatuses: [{ releaseStatus: { id: 0, name: "Official" }, allowed: true }],
      },
      { id: 2, name: "None", primaryAlbumTypes: [], secondaryAlbumTypes: [], releaseStatuses: [] },
    ] as Json[],
    naming: {
      id: 1,
      renameTracks: true,
      replaceIllegalCharacters: true,
      standardTrackFormat: "{Album Title} ({Release Year})/{track:00} - {Track Title}",
      multiDiscTrackFormat:
        "{Album Title} ({Release Year})/{Medium Format} {medium:00}/{track:00} - {Track Title}",
      artistFolderFormat: "{Artist Name}",
    } as Json,
    media: {
      id: 1,
      autoUnmonitorPreviouslyDownloadedTracks: false,
      recycleBin: "",
      recycleBinCleanupDays: 7,
      downloadPropersAndRepacks: "preferAndUpgrade",
      createEmptyArtistFolders: false,
      deleteEmptyFolders: false,
      fileDate: "none",
      rescanAfterRefresh: "always",
      allowFingerprinting: "newFiles",
      copyUsingHardlinks: true,
      importExtraFiles: false,
      extraFileExtensions: "jpg,png",
      minimumFreeSpaceWhenImporting: 100,
      skipFreeSpaceCheckWhenImporting: false,
    } as Json,
    health: [] as Json[],
    exclusions: [
      {
        id: 1,
        foreignId: "2f3b6e7a-0000-4000-8000-000000000001",
        artistName: "The Excluded Quartet",
      },
    ] as Json[],
    history: [
      {
        id: 1,
        artistId: 2,
        albumId: 41,
        date: iso(-1),
        eventType: "downloadImported",
        sourceTitle: "Bjork - Post",
        quality: { quality: AUDIO.flac },
        data: { indexer: "UsenetOne (Prowlarr)", downloadClient: "SABnzbd" },
      },
      {
        id: 2,
        artistId: 1,
        albumId: 32,
        date: iso(-3),
        eventType: "grabbed",
        sourceTitle: "Radiohead-OK_Computer-1997-FLAC",
        quality: { quality: AUDIO.flac },
        data: { indexer: "UsenetOne (Prowlarr)", downloadClient: "SABnzbd" },
      },
    ] as Json[],
    blocklist: [] as Json[],
    waiting: [
      {
        path: "/downloads/Bjork-Homogenic-1997-FLAC/01 - Hunter.flac",
        name: "01 - Hunter",
        size: 31 * MB,
        artistId: 2,
        albumId: 42,
        title: "Hunter",
      },
    ],
    roots: [
      {
        id: 1,
        path: "/music",
        name: "Music",
        accessible: true,
        freeSpace: 900 * 1024 * MB,
        totalSpace: 4000 * 1024 * MB,
      },
    ] as Json[],
  };
}

/** What Lidarr's own artist search finds (the first is not in the library yet). */
const LOOKUP: Json[] = [
  {
    artistName: "The Lantern Choir",
    foreignArtistId: "6c0f1d2e-1111-4a2b-9c3d-123456789abc",
    artistType: "Group",
    disambiguation: "stand-in choir",
    overview: "A stand-in artist that is not in the library yet.",
    genres: ["Choral"],
  },
  {
    artistName: "Lantern Season",
    foreignArtistId: "6c0f1d2e-2222-4a2b-9c3d-123456789abc",
    artistType: "Person",
    disambiguation: "stand-in singer",
    genres: ["Folk"],
  },
];

export function fakeLidarr(): FakeLidarr {
  const legacy = fakeArrV1("lidarr");
  let s = initialState();
  const withStats = (a: Json) => ({
    ...a,
    statistics: stats(s, (x) => x.artistId === a.id),
  });
  const albumOut = (al: Json) => ({
    ...al,
    artist: { artistName: s.artists.find((a) => a.id === al.artistId)?.artistName },
    statistics: stats(s, (x) => (x.albumId ?? x.id) === al.id && x.artistId === al.artistId),
  });
  const core = servarrCore({
    app: "lidarr",
    state: () =>
      s as unknown as ReturnType<typeof sharedState> & {
        naming: Json;
        media: Json;
        health: Json[];
        exclusions: Json[];
      },
    items: () => s.artists,
    root: "/music",
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (!headers["X-Api-Key"]?.startsWith("e2e-")) return reply(401, {});
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : {};

    // The older dashboard's stand-in: queue, missing albums, calendar, release search, commands.
    if (
      p.startsWith("/api/v1/queue") ||
      p === "/api/v1/wanted/missing" ||
      p === "/api/v1/calendar" ||
      p === "/api/v1/release" ||
      (p === "/api/v1/manualimport" && u.searchParams.has("downloadId")) ||
      (p === "/api/v1/command" &&
        method === "POST" &&
        body.name !== "Backup" &&
        !(
          body.name === "ManualImport" &&
          Array.isArray(body.files) &&
          (body.files as Json[]).some((f) => f.trackIds)
        ))
    )
      return legacy.fetch(url, init);
    if (/^\/api\/v1\/command\/9\d\d$/.test(p)) return legacy.fetch(url, init);

    if (p === "/api/v1/artist" && method === "GET") return reply(200, s.artists.map(withStats));
    if (p === "/api/v1/artist" && method === "POST") {
      const made = {
        ...body,
        id: Math.max(...s.artists.map((a) => Number(a.id))) + 1,
        path: `/music/${String(body.artistName)}`,
      };
      s.artists.push(made);
      return reply(201, withStats(made));
    }
    const artist = /^\/api\/v1\/artist\/(\d+)$/.exec(p);
    if (artist) {
      const id = Number(artist[1]);
      const a = s.artists.find((x) => x.id === id);
      if (!a) return reply(404, { message: "NotFound" });
      if (method === "PUT") {
        Object.assign(a, body, { id });
        return reply(202, withStats(a));
      }
      if (method === "DELETE") {
        s.artists = s.artists.filter((x) => x.id !== id);
        if (u.searchParams.get("deleteFiles") === "true")
          s.files = s.files.filter((f) => f.artistId !== id);
        return reply(200, {});
      }
      return reply(200, withStats(a));
    }
    if (p === "/api/v1/artist/lookup") {
      const term = (u.searchParams.get("term") ?? "").toLowerCase();
      const byId = term.startsWith("lidarr:") ? term.slice(7) : "";
      const all = [...LOOKUP, ...s.artists];
      return reply(
        200,
        all.filter((a) =>
          byId ? a.foreignArtistId === byId : String(a.artistName).toLowerCase().includes(term),
        ),
      );
    }
    if (p === "/api/v1/album" && method === "GET") {
      const artistId = Number(u.searchParams.get("artistId"));
      return reply(200, s.albums.filter((a) => !artistId || a.artistId === artistId).map(albumOut));
    }
    const album = /^\/api\/v1\/album\/(\d+)$/.exec(p);
    if (album) {
      const a = s.albums.find((x) => x.id === Number(album[1]));
      if (!a) return reply(404, { message: "NotFound" });
      if (method === "PUT") Object.assign(a, body, { id: a.id });
      return reply(method === "PUT" ? 202 : 200, albumOut(a));
    }
    if (p === "/api/v1/track")
      return reply(
        200,
        s.tracks.filter((t) => t.albumId === Number(u.searchParams.get("albumId"))),
      );
    if (p === "/api/v1/trackfile")
      return reply(
        200,
        s.files.filter((f) => f.albumId === Number(u.searchParams.get("albumId"))),
      );
    if (p === "/api/v1/wanted/cutoff")
      return reply(200, { page: 1, pageSize: 50, totalRecords: 0, records: [] });
    if (p === "/api/v1/metadataprofile" && method === "GET") return reply(200, s.metadataProfiles);
    const meta = /^\/api\/v1\/metadataprofile\/(\d+)$/.exec(p);
    if (meta) {
      const m = s.metadataProfiles.find((x) => x.id === Number(meta[1]));
      return m ? reply(200, m) : reply(404, {});
    }
    if (p === "/api/v1/rootfolder" && method === "GET") return reply(200, s.roots);
    if (p === "/api/v1/history" || p === "/api/v1/history/artist") {
      const artistId = Number(u.searchParams.get("artistId"));
      const rows = s.history
        .filter((h) => !artistId || h.artistId === artistId)
        .map((h) => ({
          ...h,
          artist: { artistName: s.artists.find((a) => a.id === h.artistId)?.artistName },
          album: { title: s.albums.find((a) => a.id === h.albumId)?.title },
        }));
      return reply(
        200,
        p.endsWith("/artist")
          ? rows
          : { page: 1, pageSize: 50, totalRecords: rows.length, records: rows },
      );
    }
    if (p === "/api/v1/blocklist")
      return reply(200, {
        page: 1,
        pageSize: 50,
        totalRecords: s.blocklist.length,
        records: s.blocklist,
      });
    if (p === "/api/v1/manualimport" && method === "GET")
      return reply(
        200,
        s.waiting.map((w) => ({
          path: w.path,
          name: w.name,
          size: w.size,
          quality: { quality: AUDIO.flac },
          artist: {
            id: w.artistId,
            artistName: s.artists.find((a) => a.id === w.artistId)?.artistName,
          },
          album: { id: w.albumId, title: s.albums.find((a) => a.id === w.albumId)?.title },
          albumReleaseId: w.albumId * 10,
          tracks: s.tracks
            .filter((t) => t.albumId === w.albumId && t.title === w.title)
            .map((t) => ({ id: t.id, title: t.title, trackNumber: t.trackNumber })),
          rejections: [],
        })),
      );
    if (p === "/api/v1/command" && method === "POST" && body.name === "ManualImport") {
      for (const f of body.files as Json[]) {
        for (const id of (f.trackIds as number[]) ?? []) {
          const t = s.tracks.find((x) => x.id === id);
          if (!t) continue;
          const fid = 900 + s.files.length;
          s.files.push({
            id: fid,
            artistId: t.artistId,
            albumId: t.albumId,
            path: String(f.path),
            size: 31 * MB,
            quality: { quality: AUDIO.flac },
          });
          t.hasFile = true;
          t.trackFileId = fid;
        }
        if (body.importMode !== "copy") s.waiting = s.waiting.filter((w) => w.path !== f.path);
      }
      const cmd = {
        id: ++s.nextId,
        name: "ManualImport",
        status: "completed",
        started: new Date().toISOString(),
      };
      s.commands.push(cmd);
      return reply(201, cmd);
    }

    // Everything both apps answer the same way, on v1 paths.
    const shared = core(u, p.replace(/^\/api\/v1\//, "/api/v3/"), method, body);
    if (shared) return shared;
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      legacy.reset();
      s = initialState();
    },
  };
}
