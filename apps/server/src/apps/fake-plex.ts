import { readFileSync } from "node:fs";
import path from "node:path";
import type { Fetch } from "./http";

/**
 * A stand-in Plex Media Server 1.43 (port 32400) for tests and safe previews (DC_FAKE_APPS=1, never
 * in a real installation). Shapes follow a real Plex 1.43.4 (the disposable plex-hearth-test):
 * libraries, titles with their files, seasons and episodes, watch history, maintenance tasks,
 * activities and server settings, with the changes the Plex panel makes. Accepts tokens starting
 * "e2e-".
 */

export interface FakePlex {
  fetch: Fetch;
  /** Back to the start; with New Releases, a second movie library (browser tests). */
  reset(o?: { newReleases?: boolean; kidsTv?: boolean; family?: boolean }): void;
  /** Plex is scanning a library (its Activities list it), as after a folder change. */
  scanning(libraryId: string | undefined): void;
  /** Where a library's rows really are on Home ("id:h" or "id:-"), whatever Plex reports. */
  homeTruth(libraryId: string): string[];
}

interface Item {
  ratingKey: string;
  /** The owner's own rating, out of 10. */
  userRating?: number;
  type: "movie" | "show" | "season" | "episode";
  title: string;
  titleSort?: string;
  year?: number;
  summary: string;
  section: number;
  parent?: string;
  index?: number;
  viewCount?: number;
  lastViewedAt?: number;
  addedAt: number;
  /** The library folder its file is in: a library reading that folder lists it (11-13). */
  folder?: string;
  guid?: string;
  /** Plex's release date (originallyAvailableAt), YYYY-MM-DD. */
  released?: string;
  /** TMDB's id, as Plex lists it among a film's Guids. */
  tmdb?: string;
  file?: string;
  size?: number;
  genres?: string[];
  audienceRating?: number;
}

/** Plex's genre ids (tags), as GET /library/sections/<id>/genre lists them. */
const GENRES: Record<string, string> = {
  Drama: "1001",
  Mystery: "1002",
  Horror: "1003",
  Animation: "1004",
  Family: "1005",
  Comedy: "1006",
};

/**
 * A family film library for the website's Show & Tell clip (11-19: Ember builds a row of animated
 * movies kids love and grown-ups enjoy too). Real titles and posters are the recording PC's own
 * (DC_FAKE_PLEX_POSTERS: a folder with films.json and the poster files), never in this repo.
 */
export interface FamilyFilm {
  title: string;
  year: number;
  rating: number;
  /** Why it works for kids and grown-ups (the stand-in Ember's notes). */
  why: string;
  /** In Ember's suggested row, or offered as an alternative. */
  pick: boolean;
  /** Its poster's file name in the folder. */
  poster?: string;
}
export function familyFilms(): FamilyFilm[] {
  const dir = process.env.DC_FAKE_PLEX_POSTERS;
  if (!dir) return [];
  try {
    return JSON.parse(readFileSync(path.join(dir, "films.json"), "utf8")) as FamilyFilm[];
  } catch {
    return [];
  }
}
export const FAMILY_KEY = 301;

/** A drawn title card for a stand-in title without a poster: its own colors and its name. */
function posterSvg(title: string, year?: number): string {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const words = title.split(" ");
  const lines: string[] = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (last !== undefined && (last + " " + w).length <= 12)
      lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  const esc = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
  const top = 250 - lines.length * 17;
  const text = lines
    .map(
      (l, i) =>
        `<text x="120" y="${top + i * 36}" text-anchor="middle" font-family="Verdana,sans-serif" font-size="27" font-weight="700" fill="#fff8ec" stroke="hsl(${h},55%,18%)" stroke-width="5" paint-order="stroke">${esc(l)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360" viewBox="0 0 240 360"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${h},75%,62%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},70%,32%)"/></linearGradient></defs><rect width="240" height="360" fill="url(#g)"/><circle cx="${60 + (h % 120)}" cy="92" r="${38 + (h % 22)}" fill="hsl(${(h + 180) % 360},85%,72%)" opacity="0.85"/><circle cx="${190 - (h % 90)}" cy="70" r="14" fill="#fff8ec" opacity="0.7"/><path d="M0 300 Q60 ${262 + (h % 30)} 120 296 T240 288 V360 H0Z" fill="hsl(${(h + 90) % 360},60%,40%)" opacity="0.9"/>${text}<text x="120" y="340" text-anchor="middle" font-family="Verdana,sans-serif" font-size="15" fill="#fff8ec" opacity="0.85">${year ?? ""}</text></svg>`;
}

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

const ITEMS = (family = false): Item[] => {
  const t = now();
  const movie = (k: string, title: string, year: number, ago: number, extra: Partial<Item> = {}) =>
    ({
      ratingKey: k,
      type: "movie",
      title,
      year,
      summary: `${title}: a sample film.`,
      section: 1,
      addedAt: t - ago * DAY,
      folder: "/media/movies",
      guid: `plex://movie/sample-${k}`,
      released: `${year}-06-01`,
      tmdb: `9${k}`,
      file: `/data/movies/${title} (${year})/${title} (${year}).mkv`,
      size: 4_200_000_000,
      ...extra,
    }) as Item;
  const items: Item[] = [
    movie("101", "Harbor Lights", 2019, 2, { genres: ["Drama"], audienceRating: 7.4 }),
    movie("102", "Quiet Harbor", 2021, 9, {
      viewCount: 1,
      lastViewedAt: t - 3 * DAY,
      genres: ["Drama", "Mystery"],
      audienceRating: 8.1,
    }),
    movie("103", "Ember Lake", 2026, 1, { genres: ["Horror"], audienceRating: 6.2 }),
    {
      ratingKey: "200",
      type: "show",
      title: "Signal Hill",
      year: 2018,
      summary: "A sample show.",
      genres: ["Mystery"],
      section: 2,
      addedAt: t - 20 * DAY,
    },
  ];
  for (const s of [1, 2]) {
    items.push({
      ratingKey: `2${s}0`,
      type: "season",
      title: `Season ${s}`,
      summary: "",
      section: 2,
      parent: "200",
      index: s,
      addedAt: t - 20 * DAY,
    });
    for (const e of [1, 2, 3]) {
      items.push({
        ratingKey: `2${s}${e}`,
        type: "episode",
        title: `Episode ${e}`,
        summary: "",
        section: 2,
        parent: `2${s}0`,
        index: e,
        addedAt: t - 20 * DAY,
        viewCount: s === 1 ? 1 : undefined,
        lastViewedAt: s === 1 ? t - 10 * DAY : undefined,
        file: `/data/tv/Signal Hill (2018)/Season 0${s}/Signal Hill (2018) - S0${s}E0${e}.mkv`,
        size: 900_000_000,
      });
    }
  }
  // The family library replaces the made-up sample movies, so every film on screen is real.
  if (family && familyFilms().length)
    items.splice(0, items.length, ...items.filter((x) => x.section !== 1));
  if (family)
    familyFilms().forEach((f, i) =>
      items.push(
        movie(String(FAMILY_KEY + i), f.title, f.year, 30 + i * 11, {
          genres: ["Animation", "Family", "Comedy"],
          audienceRating: f.rating,
          summary: `${f.title}: an animated film for the whole family.`,
        }),
      ),
    );
  return items;
};

const SETTINGS = () => [
  {
    id: "FriendlyName",
    label: "Friendly name",
    summary: "This name will be used to identify this media server to other computers.",
    type: "text",
    default: "",
    value: "Sample Plex",
    hidden: false,
    advanced: false,
    group: "general",
  },
  {
    id: "FSEventLibraryUpdatesEnabled",
    label: "Scan my library automatically",
    summary: "Your library will be updated automatically when changes are detected.",
    type: "bool",
    default: false,
    value: false,
    hidden: false,
    advanced: false,
    group: "library",
  },
  {
    id: "autoEmptyTrash",
    label: "Empty trash automatically after every scan",
    summary: "",
    type: "bool",
    default: true,
    value: true,
    hidden: false,
    advanced: false,
    group: "library",
  },
  {
    id: "TranscoderQuality",
    label: "Transcoder quality",
    summary: "Quality profile used by the transcoder.",
    type: "int",
    default: 0,
    value: 0,
    hidden: false,
    advanced: false,
    group: "transcoder",
    enumValues:
      "0:Automatic|1:Prefer higher speed encoding|2:Prefer higher quality encoding|3:Make my CPU hurt",
  },
  {
    id: "TranscoderTempDirectory",
    label: "Transcoder temporary directory",
    summary: "Directory to use when transcoding for temporary files.",
    type: "text",
    default: "",
    value: "/transcode",
    hidden: false,
    advanced: true,
    group: "transcoder",
  },
  {
    id: "ManualPortMappingPort",
    label: "Manually specify public port",
    summary: "",
    type: "int",
    default: 32400,
    value: 32400,
    hidden: false,
    advanced: false,
    group: "network",
  },
  {
    id: "MergedRecentlyAdded",
    label: "",
    summary: "",
    type: "bool",
    default: false,
    value: false,
    hidden: true,
    advanced: false,
    group: "",
  },
  {
    id: "PlexOnlineToken",
    label: "",
    summary: "",
    type: "text",
    default: "",
    value: "e2e-never-shown-token",
    hidden: true,
    advanced: false,
    group: "",
  },
];

/** Each library's rows, as Plex's Manage Libraries page lists them (r: Library Recommended, h: Home, s: Friends' Home). */
const HUBS = (): Record<string, { identifier: string; title: string; on: string }[]> => ({
  "1": [
    { identifier: "movie.inprogress.1", title: "Continue Watching", on: "rh-" },
    { identifier: "movie.recentlyadded.1", title: "Recently Added Movies", on: "rhs" },
    { identifier: "movie.recentlyreleased.1", title: "Recently Released Movies", on: "r--" },
    { identifier: "custom.collection.1.9001", title: "Time Loop Movies", on: "r--" },
    { identifier: "custom.collection.1.9002", title: "Seasonal Movies", on: "---" },
  ],
  "2": [
    { identifier: "tv.inprogress.2", title: "Continue Watching", on: "rh-" },
    { identifier: "tv.recentlyadded.2", title: "Recently Added TV", on: "rhs" },
    { identifier: "tv.ondeck.2", title: "On Deck", on: "rh-" },
  ],
});

const TASKS = () => [
  {
    name: "BackupDatabase",
    title: "Backup Database",
    description: "Create a backup copy of the server's database",
    interval: 3,
    enabled: true,
    scheduleRandomized: false,
  },
  {
    name: "CleanOldBundles",
    title: "Remove Old Bundles",
    description: "Remove old bundles from the database",
    interval: 7,
    enabled: true,
    scheduleRandomized: false,
  },
  {
    name: "OptimizeDatabase",
    title: "Optimize Database",
    description: "Optimize the database",
    interval: 7,
    enabled: true,
    scheduleRandomized: false,
  },
  {
    name: "ButlerTaskGenerateIntroMarkers",
    interval: 1,
    enabled: false,
    scheduleRandomized: false,
  },
];

/** The libraries and their folders; New Releases (an empty second movie library) on request. */
const LIBS = (newReleases: boolean, kidsTv = false) => [
  { key: "1", title: "Movies", type: "movie", folders: ["/media/movies"], hidden: "0" },
  { key: "2", title: "TV Shows", type: "show", folders: ["/media/tv"], hidden: "0" },
  ...(newReleases
    ? [
        {
          key: "3",
          title: "New Releases",
          type: "movie",
          folders: ["/media/new-releases"],
          hidden: "0",
        },
      ]
    : []),
  ...(kidsTv
    ? [{ key: "4", title: "Kids TV", type: "show", folders: ["/media/kids-tv"], hidden: "0" }]
    : []),
];
/** A second show library's rows (the preview only: TV Shows has something to merge with). */
const KIDS_HUBS = [
  { identifier: "tv.inprogress", title: "Continue Watching", on: "rh-" },
  { identifier: "tv.recentlyadded", title: "Recently Added TV", on: "rhs" },
];
// As the owner's real Plex names a library's rows: without the library's number (11-10).
const NEW_HUBS = [
  { identifier: "movie.recentlyadded", title: "Recently Added Movies", on: "rhs" },
  { identifier: "movie.recentlyreleased", title: "Recently Released Movies", on: "rh-" },
];

export function fakePlex(opts: { newReleases?: boolean } = {}): FakePlex {
  let extra = opts.newReleases ?? false;
  let family = false;
  let kids = false;
  let libs = LIBS(extra);
  let lagged: { at: (typeof libs)[number]; folders: string[] } | undefined;
  let items = ITEMS();
  let settings = SETTINGS();
  let hubs: ReturnType<typeof HUBS> = {
    ...HUBS(),
    ...(extra ? { "3": NEW_HUBS.map((h) => ({ ...h })) } : {}),
  };
  let activities: { uuid: string; type: string; title: string; progress: number }[] = [];
  let collections: {
    key: string;
    title: string;
    section: number;
    members: string[];
    /** A smart collection's filter (server://.../library/sections/<id>/all?...): Plex keeps it current. */
    content?: string;
  }[] = [];
  // After the sample rows' own collections (9001, 9002).
  let nextCollection = 9101;
  // Films a library lists once it reads another's folders (11-13).
  let nextItem = 5001;
  // One of the owner's own collections that is not a row yet.
  const OWN = () => [
    { key: "9003", title: "Harbor Classics", section: 1, members: ["101", "102"] },
  ];
  collections.push(...OWN());
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const leaves = (k: string): Item[] =>
    items
      .filter((x) => x.parent === k)
      .flatMap((x) => (x.type === "episode" ? [x] : leaves(x.ratingKey)));
  const meta = (x: Item) => {
    const base: Record<string, unknown> = {
      ratingKey: x.ratingKey,
      key: `/library/metadata/${x.ratingKey}`,
      type: x.type,
      title: x.title,
      titleSort: x.titleSort,
      summary: x.summary,
      year: x.year,
      index: x.index,
      thumb: `/library/metadata/${x.ratingKey}/thumb/1`,
      addedAt: x.addedAt,
      ...(x.guid ? { guid: x.guid } : {}),
      ...(x.released ? { originallyAvailableAt: x.released } : {}),
      ...(x.tmdb ? { Guid: [{ id: `imdb://tt${x.tmdb}` }, { id: `tmdb://${x.tmdb}` }] } : {}),
      librarySectionID: x.section,
      librarySectionTitle:
        libs.find((l) => l.key === String(x.section))?.title ??
        (x.section === 1 ? "Movies" : "TV Shows"),
      audienceRating: x.audienceRating,
      ...(x.userRating !== undefined ? { userRating: x.userRating } : {}),
      Genre: (x.genres ?? []).map((g) => ({ id: Number(GENRES[g]), tag: g })),
    };
    if (x.type === "show" || x.type === "season") {
      const l = leaves(x.ratingKey);
      base.leafCount = l.length;
      base.viewedLeafCount = l.filter((e) => (e.viewCount ?? 0) > 0).length;
      base.childCount = items.filter((c) => c.parent === x.ratingKey).length;
    } else {
      base.viewCount = x.viewCount;
      base.lastViewedAt = x.lastViewedAt;
    }
    if (x.type === "season") base.parentTitle = "Signal Hill";
    if (x.type === "episode") {
      const season = items.find((s) => s.ratingKey === x.parent);
      base.grandparentTitle = "Signal Hill";
      base.parentIndex = season?.index;
    }
    if (x.file)
      base.Media = [
        {
          id: Number(x.ratingKey),
          videoResolution: x.type === "movie" ? "1080" : "720",
          videoCodec: "h264",
          audioCodec: "aac",
          bitrate: 8000,
          container: "mkv",
          Part: [{ id: Number(x.ratingKey), file: x.file, size: x.size, container: "mkv" }],
        },
      ];
    return base;
  };
  const mark = (k: string, watched: boolean) => {
    const target = items.find((x) => x.ratingKey === k);
    if (!target) return false;
    const list = target.type === "show" || target.type === "season" ? leaves(k) : [target];
    for (const x of list) {
      x.viewCount = watched ? 1 : undefined;
      x.lastViewedAt = watched ? now() : undefined;
    }
    return true;
  };

  /** Plex's library filter (Home Rows): the titles of a section that match, sorted and limited. */
  const filtered = (section: number, q: URLSearchParams) => {
    let list = items.filter(
      (x) => x.section === section && (x.type === "movie" || x.type === "show"),
    );
    const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
    const genre = q.get("genre");
    if (genre) {
      const ids = genre.split(",");
      list = list.filter((x) => (x.genres ?? []).some((g) => ids.includes(GENRES[g] ?? "")));
    }
    const after = num("year>>");
    if (after !== undefined) list = list.filter((x) => (x.year ?? 0) > after);
    const before = num("year<<");
    if (before !== undefined) list = list.filter((x) => (x.year ?? 0) < before);
    const rating = num("audienceRating>>");
    if (rating !== undefined) list = list.filter((x) => (x.audienceRating ?? 0) > rating);
    const added = /^-(\d+)d$/.exec(q.get("addedAt>>") ?? "");
    if (added) list = list.filter((x) => x.addedAt > now() - Number(added[1]) * DAY);
    const res = q.get("resolution");
    if (res) list = list.filter((x) => x.type === "movie" && res === "1080");
    if (q.get("unwatched") === "1")
      list = list.filter((x) => {
        const m = meta(x);
        return m.leafCount !== undefined
          ? (m.viewedLeafCount as number) < (m.leafCount as number)
          : !m.viewCount;
      });
    const sort = q.get("sort") ?? "";
    if (sort.startsWith("titleSort")) list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort.startsWith("year")) list.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    else if (sort.startsWith("audienceRating"))
      list.sort((a, b) => (b.audienceRating ?? 0) - (a.audienceRating ?? 0));
    else list.sort((a, b) => b.addedAt - a.addedAt);
    const limit = num("limit");
    return limit !== undefined ? list.slice(0, limit) : list;
  };
  const smartOf = (content: string) => {
    const m = /\/library\/sections\/(\d+)\/all\?(.*)$/.exec(content);
    return m ? { section: Number(m[1]), q: new URLSearchParams(m[2]) } : undefined;
  };
  const membersOf = (c: (typeof collections)[number]) => {
    const smart = c.content ? smartOf(c.content) : undefined;
    return smart ? filtered(smart.section, smart.q).map((x) => x.ratingKey) : c.members;
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    const token = init.headers["X-Plex-Token"] ?? u.searchParams.get("X-Plex-Token") ?? "";
    if (!token.startsWith("e2e-")) return reply(401, {});
    // Posters (only with the family films: other tests keep Plex's pictures missing).
    if (p === "/photo/:/transcode" && family) {
      const key = /^\/library\/metadata\/(\d+)\//.exec(u.searchParams.get("url") ?? "")?.[1];
      const x = items.find((i) => i.ratingKey === key);
      if (!x) return reply(404, {});
      // The film's own poster when the folder has it, else a drawn title card.
      const film = familyFilms()[Number(key) - FAMILY_KEY];
      const file =
        film?.poster && process.env.DC_FAKE_PLEX_POSTERS
          ? path.join(process.env.DC_FAKE_PLEX_POSTERS, film.poster)
          : undefined;
      let img: Buffer;
      let type = "image/svg+xml";
      try {
        img = readFileSync(file!);
        type = /\.png$/i.test(file!) ? "image/png" : "image/jpeg";
      } catch {
        img = Buffer.from(posterSvg(x.title, x.year));
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? type : null) },
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () => img.buffer.slice(img.byteOffset, img.byteOffset + img.length),
      } as unknown as Awaited<ReturnType<Fetch>>;
    }
    if (p === "/" || p === "/identity")
      return reply(200, {
        MediaContainer: {
          version: "1.43.4.10903-e5521bd8c",
          friendlyName: "Sample Plex",
          machineIdentifier: "sample-plex-machine",
        },
      });
    // plex.tv, as the account sees this server's sharing (XML, as plex.tv answers).
    const xml = (body: string) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => body,
    });
    if (u.hostname === "plex.tv" && p === "/api/users/")
      return xml(`<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" machineIdentifier="x" totalSize="4" size="4">
  <User id="101" title="Alex Rivers" username="alexr" email="never-shown@example.com" thumb="https://plex.tv/users/a/avatar" home="0" restricted="0" protected="0">
    <Server id="9" serverId="1" machineIdentifier="sample-plex-machine" name="Sample Plex" lastSeenAt="1700000000" numLibraries="2" allLibraries="1" owned="1" pending="0"/>
  </User>
  <User id="102" title="sam" username="sam" email="never-shown@example.com" thumb="" home="0" restricted="0" protected="0">
    <Server id="10" serverId="1" machineIdentifier="sample-plex-machine" name="Sample Plex" lastSeenAt="1700000000" numLibraries="1" allLibraries="0" owned="1" pending="0"/>
  </User>
  <User id="103" title="Kids" username="" home="1" restricted="1" protected="0"/>
  <User id="104" title="Jordan" username="jordan" home="0" restricted="0">
    <Server id="11" serverId="1" machineIdentifier="sample-plex-machine" name="Sample Plex" numLibraries="1" allLibraries="0" owned="1" pending="1"/>
  </User>
  <User id="105" title="Elsewhere" username="other" home="0">
    <Server id="12" serverId="2" machineIdentifier="another-server" name="Not this one" numLibraries="5" allLibraries="1" owned="0" pending="0"/>
  </User>
</MediaContainer>`);
    if (u.hostname === "plex.tv" && p === "/api/servers/sample-plex-machine/shared_servers")
      return xml(`<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" machineIdentifier="sample-plex-machine">
  <SharedServer id="9" username="alexr" email="never-shown@example.com" userID="101" accessToken="never-shown-token" name="Sample Plex" allLibraries="1" owned="1">
    <Section id="1" key="1" title="Movies" type="movie" shared="1"/>
    <Section id="2" key="2" title="TV Shows" type="show" shared="1"/>
  </SharedServer>
  <SharedServer id="10" username="sam" userID="102" accessToken="never-shown-token" allLibraries="0">
    <Section id="1" key="1" title="Movies" type="movie" shared="0"/>
    <Section id="2" key="2" title="TV Shows" type="show" shared="1"/>
  </SharedServer>
  <SharedServer id="11" username="jordan" userID="104" accessToken="never-shown-token" allLibraries="0">
    <Section id="1" key="1" title="Movies" type="movie" shared="1"/>
  </SharedServer>
</MediaContainer>`);
    // Collections (a library's own, as Plex keeps them).
    const sectionColls = /^\/library\/sections\/(\d+)\/collections$/.exec(p);
    if (sectionColls)
      return reply(200, {
        MediaContainer: {
          Metadata: collections
            .filter((c) => c.section === Number(sectionColls[1]))
            .map((c) => ({
              ratingKey: c.key,
              title: c.title,
              childCount: membersOf(c).length,
              smart: c.content ? true : undefined,
              type: "collection",
            })),
        },
      });
    // Several titles at once, as Plex takes them: .../library/metadata/101,102.
    const keysOfUri = (uri: string | null) =>
      (/\/library\/metadata\/([\d,]+)$/.exec(uri ?? "")?.[1] ?? "").split(",").filter(Boolean);
    if (p === "/library/collections" && method === "POST") {
      const title = u.searchParams.get("title") ?? "";
      const section = Number(u.searchParams.get("sectionId"));
      let c: (typeof collections)[number];
      if (u.searchParams.get("smart") === "1") {
        const content = u.searchParams.get("uri") ?? "";
        const smart = smartOf(content);
        if (!title || !smart || smart.section !== section) return reply(400, {});
        c = { key: String(nextCollection++), title, section, members: [], content };
      } else {
        const rks = keysOfUri(u.searchParams.get("uri"));
        if (!rks.length || rks.some((k) => !items.some((x) => x.ratingKey === k)) || !title)
          return reply(400, {});
        c = { key: String(nextCollection++), title, section, members: rks };
      }
      collections.push(c);
      // As on a real Plex 1.43: a new collection has no row in its library until one is asked
      // for (POST /hubs/sections/<id>/manage?metadataItemId=<key>).
      return reply(200, { MediaContainer: { Metadata: [{ ratingKey: c.key, title }] } });
    }
    const coll = /^\/library\/collections\/(\d+)\/(children|items)(?:\/(\d+))?$/.exec(p);
    if (coll) {
      const c = collections.find((x) => x.key === coll[1]);
      if (!c) return reply(404, {});
      if (coll[2] === "children" && method === "GET")
        return reply(200, {
          MediaContainer: {
            Metadata: membersOf(c)
              .map((k) => items.find((x) => x.ratingKey === k))
              .filter((x): x is Item => Boolean(x))
              .map(meta),
          },
        });
      if (coll[2] === "children" && method === "DELETE" && coll[3]) {
        c.members = c.members.filter((m) => m !== coll[3]);
        return reply(200, {});
      }
      if (coll[2] === "items" && method === "PUT" && c.content) {
        const content = u.searchParams.get("uri") ?? "";
        const smart = smartOf(content);
        if (!smart || smart.section !== c.section) return reply(400, {});
        c.content = content;
        return reply(200, {});
      }
      if (coll[2] === "items" && method === "PUT") {
        const rks = keysOfUri(u.searchParams.get("uri"));
        if (!rks.length || rks.some((k) => !items.some((x) => x.ratingKey === k)))
          return reply(400, {});
        for (const rk of rks) if (!c.members.includes(rk)) c.members.push(rk);
        return reply(200, {});
      }
      return reply(405, {});
    }
    const collMeta = /^\/library\/metadata\/(\d+)$/.exec(p);
    if (collMeta && collections.some((c) => c.key === collMeta[1])) {
      const c = collections.find((x) => x.key === collMeta[1])!;
      const hubOfIt = `custom.collection.${c.section}.${c.key}`;
      if (method === "DELETE") {
        collections = collections.filter((x) => x.key !== collMeta[1]);
        const list = hubs[String(c.section)];
        if (list) hubs[String(c.section)] = list.filter((h) => h.identifier !== hubOfIt);
        return reply(200, {});
      }
      if (method === "PUT") {
        const title = u.searchParams.get("title.value");
        if (title) {
          c.title = title;
          const h = hubs[String(c.section)]?.find((x) => x.identifier === hubOfIt);
          if (h) h.title = title;
        }
        return reply(200, {});
      }
      return reply(200, {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: c.key,
              title: c.title,
              type: "collection",
              librarySectionID: c.section,
              childCount: membersOf(c).length,
              ...(c.content ? { smart: true, content: c.content } : {}),
            },
          ],
        },
      });
    }
    if (p === "/library/sections") {
      const lag = lagged;
      lagged = undefined;
      return reply(200, {
        MediaContainer: {
          Directory: libs.map((l) => ({
            ...l,

            agent: l.type === "show" ? "tv.plex.agents.series" : "tv.plex.agents.movie",
            scanner: l.type === "show" ? "Plex TV Series" : "Plex Movie",
            language: "en-US",
            Location: (lag?.at === l ? lag.folders : l.folders).map((path, i) => ({
              id: i + 1,
              path,
            })),
          })),
        },
      });
    }
    // A library's advanced settings: Visibility ("hidden"), as the real Plex lists it.
    const libPrefs = /^\/library\/sections\/(\d+)\/prefs$/.exec(p);
    if (libPrefs) {
      const l = libs.find((x) => x.key === libPrefs[1]);
      if (!l) return reply(404, {});
      if (method === "PUT") {
        const v = u.searchParams.get("hidden");
        if (v !== null) {
          if (!["0", "1", "2"].includes(v)) return reply(400, {});
          l.hidden = v;
        }
        return reply(200, {});
      }
      return reply(200, {
        MediaContainer: {
          Setting: [
            {
              id: "hidden",
              label: "Visibility",
              type: "int",
              default: "0",
              value: l.hidden,
              enumValues:
                "0:Include in home screen and global search|1:Exclude from home screen|2:Exclude from home screen and global search",
            },
          ],
        },
      });
    }
    // Editing a library (as Plex's Edit Library sends it): every folder is listed again.
    const editLib = /^\/library\/sections\/(\d+)$/.exec(p);
    if (editLib && method === "PUT") {
      const l = libs.find((x) => x.key === editLib[1]);
      if (!l) return reply(404, {});
      const folders = u.searchParams.getAll("location");
      if (!u.searchParams.get("agent") || !folders.length) return reply(400, {});
      // Like the real Plex: the next read of the library list still has the old folders.
      lagged = { at: l, folders: l.folders };
      l.folders = folders;
      l.title = u.searchParams.get("name") || l.title;
      return reply(200, {});
    }
    const genreList = /^\/library\/sections\/(\d+)\/genre$/.exec(p);
    if (genreList) {
      const id = Number(genreList[1]);
      const present = [
        ...new Set(items.filter((x) => x.section === id).flatMap((x) => x.genres ?? [])),
      ];
      return reply(200, {
        MediaContainer: {
          Directory: present.sort().map((g) => ({
            key: GENRES[g],
            fastKey: `/library/sections/${id}/all?genre=${GENRES[g]}`,
            title: g,
          })),
        },
      });
    }
    // Home Rows' poster preview: the same filter a smart collection keeps.
    const preview = /^\/library\/sections\/(\d+)\/all$/.exec(p);
    if (preview && u.searchParams.has("limit")) {
      const id = Number(preview[1]);
      if (!libs.some((l) => l.key === preview[1])) return reply(404, {});
      const q = new URLSearchParams(u.searchParams);
      q.delete("limit");
      const all = filtered(id, q);
      const limit = Number(u.searchParams.get("limit"));
      return reply(200, {
        MediaContainer: {
          totalSize: all.length,
          size: Math.min(all.length, limit),
          Metadata: all.slice(0, limit).map(meta),
        },
      });
    }
    const section = /^\/library\/sections\/(\d+)\/(all|refresh|emptyTrash)$/.exec(p);
    if (section) {
      const id = Number(section[1]);
      const lib = libs.find((l) => l.key === section[1]);
      if (!lib) return reply(404, {});
      if (section[2] === "refresh") {
        // A scan, done at once: films in folders it reads are listed (new ones dated now, as
        // the owner's Plex dated films folded in on 11-11), ones in folders it no longer reads go.
        if (lib.type === "movie") {
          items = items.filter(
            (x) => x.section !== id || x.type !== "movie" || lib.folders.includes(x.folder ?? ""),
          );
          for (const x of [...items])
            if (
              x.type === "movie" &&
              x.section !== id &&
              lib.folders.includes(x.folder ?? "") &&
              !items.some((y) => y.section === id && y.file === x.file)
            )
              items.push({ ...x, ratingKey: String(nextItem++), section: id, addedAt: now() });
        }
        return reply(200, {});
      }
      // Several titles' fields at once (Plex's edit), e.g. their added date.
      if (section[2] === "all" && method === "PUT") {
        const ids = (u.searchParams.get("id") ?? "").split(",").filter(Boolean);
        const at = u.searchParams.get("addedAt.value");
        const hit = items.filter((x) => x.section === id && ids.includes(x.ratingKey));
        if (!ids.length || hit.length !== ids.length) return reply(400, {});
        if (at !== null) for (const x of hit) x.addedAt = Number(at);
        const out = u.searchParams.get("originallyAvailableAt.value");
        if (out !== null) for (const x of hit) x.released = out;
        return reply(200, {});
      }
      if (section[2] === "emptyTrash") {
        if (method !== "PUT") return reply(405, {});
        return reply(200, {});
      }
      if (u.searchParams.get("duplicate")) return reply(200, { MediaContainer: { size: 0 } });
      let list = items.filter((x) => x.section === id && (x.type === "movie" || x.type === "show"));
      const title = u.searchParams.get("title");
      if (title) list = list.filter((x) => x.title.toLowerCase().includes(title.toLowerCase()));
      const shaped = list.map(meta);
      if (u.searchParams.get("unwatched"))
        list = list.filter((_, i) => {
          const m = shaped[i]!;
          return m.leafCount !== undefined
            ? (m.viewedLeafCount as number) < (m.leafCount as number)
            : !m.viewCount;
        });
      const sort = u.searchParams.get("sort") ?? "";
      const out = list.map(meta);
      if (sort.startsWith("titleSort"))
        out.sort((a, b) =>
          String(a.titleSort ?? a.title).localeCompare(String(b.titleSort ?? b.title)),
        );
      else if (sort.startsWith("year"))
        out.sort((a, b) => Number(b.year ?? 0) - Number(a.year ?? 0));
      else out.sort((a, b) => Number(b.addedAt) - Number(a.addedAt));
      const start = Number(u.searchParams.get("X-Plex-Container-Start") ?? 0);
      const size = Number(u.searchParams.get("X-Plex-Container-Size") ?? 1000);
      return reply(200, {
        MediaContainer: {
          totalSize: out.length,
          size: out.length,
          Metadata: out.slice(start, start + size),
        },
      });
    }
    if (p === "/library/recentlyAdded")
      return reply(200, {
        MediaContainer: {
          Metadata: items.filter((x) => x.type === "movie").map(meta),
        },
      });
    const children = /^\/library\/metadata\/(\d+)\/children$/.exec(p);
    if (children)
      return reply(200, {
        MediaContainer: {
          Metadata: items
            .filter((x) => x.parent === children[1])
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map(meta),
        },
      });
    const refresh = /^\/library\/metadata\/(\d+)\/refresh$/.exec(p);
    if (refresh)
      return items.some((x) => x.ratingKey === refresh[1]) ? reply(200, {}) : reply(404, {});
    const one = /^\/library\/metadata\/(\d+)$/.exec(p);
    if (one) {
      const x = items.find((i) => i.ratingKey === one[1]);
      if (!x) return reply(404, {});
      if (method === "PUT") {
        const q = u.searchParams;
        if (q.get("title.value") !== null) x.title = q.get("title.value")!;
        if (q.get("titleSort.value") !== null) x.titleSort = q.get("titleSort.value")!;
        if (q.get("summary.value") !== null) x.summary = q.get("summary.value")!;
        if (q.get("year.value") !== null) x.year = Number(q.get("year.value")) || undefined;
        return reply(200, {});
      }
      return reply(200, { MediaContainer: { size: 1, Metadata: [meta(x)] } });
    }
    if (p === "/:/rate") {
      if (method !== "PUT") return reply(405, {});
      const x = items.find((i) => i.ratingKey === u.searchParams.get("key"));
      if (!x) return reply(404, {});
      x.userRating = Number(u.searchParams.get("rating"));
      return reply(200, {});
    }
    if (p === "/:/scrobble" || p === "/:/unscrobble") {
      if (method !== "PUT") return reply(405, {});
      return mark(u.searchParams.get("key") ?? "", p === "/:/scrobble")
        ? reply(200, {})
        : reply(404, {});
    }
    if (p === "/status/sessions") return reply(200, { MediaContainer: { size: 0 } });
    if (p === "/status/sessions/history/all") {
      const t = now();
      const entries = [
        {
          historyKey: "/status/sessions/history/3",
          ratingKey: "102",
          title: "Quiet Harbor",
          type: "movie",
          viewedAt: t - 3 * DAY,
          accountID: 1,
        },
        {
          historyKey: "/status/sessions/history/2",
          ratingKey: "213",
          title: "Episode 3",
          grandparentTitle: "Signal Hill",
          parentIndex: 1,
          index: 3,
          type: "episode",
          viewedAt: t - 10 * DAY,
          accountID: 2,
        },
      ];
      return reply(200, {
        MediaContainer: { totalSize: entries.length, size: entries.length, Metadata: entries },
      });
    }
    if (p === "/accounts")
      return reply(200, {
        MediaContainer: {
          Account: [
            { id: 1, name: "Alex" },
            { id: 2, name: "sam" },
          ],
        },
      });
    if (p === "/butler") return reply(200, { ButlerTasks: { ButlerTask: TASKS() } });
    const butler = /^\/butler\/(\w+)$/.exec(p);
    if (butler) {
      const task = TASKS().find((t) => t.name === butler[1]);
      if (!task) return reply(404, {});
      if (method === "POST")
        activities = [
          ...activities,
          { uuid: `a-${task.name}`, type: "butler", title: task.title ?? task.name, progress: 10 },
        ];
      else if (method === "DELETE")
        activities = activities.filter((a) => a.uuid !== `a-${task.name}`);
      return reply(200, {});
    }
    if (p === "/library/clean/bundles" || p === "/library/optimize") {
      if (method !== "PUT") return reply(405, {});
      activities = [
        ...activities,
        {
          uuid: p,
          type: "maintenance",
          title: p.endsWith("bundles") ? "Cleaning bundles" : "Optimizing database",
          progress: 5,
        },
      ];
      return reply(200, {});
    }
    if (p === "/activities")
      return reply(200, { MediaContainer: { size: activities.length, Activity: activities } });
    // A library's rows with their titles (what Home shows in each).
    const sectionHubs = /^\/hubs\/sections\/(\d+)$/.exec(p);
    if (sectionHubs && method === "GET") {
      const id = Number(sectionHubs[1]);
      const list = hubs[String(id)];
      if (!list) return reply(404, {});
      const titles = items.filter(
        (x) => x.section === id && (x.type === "movie" || x.type === "show"),
      );
      return reply(200, {
        MediaContainer: {
          Hub: list.map((h) => ({
            hubIdentifier: h.identifier,
            title: h.title,
            Metadata: titles.map(meta),
          })),
        },
      });
    }
    const manage = /^\/hubs\/sections\/(\d+)\/manage(?:\/(.+))?$/.exec(p);
    if (manage) {
      const list = hubs[manage[1]!];
      if (!list) return reply(404, {});
      const sub = manage[2] ? decodeURIComponent(manage[2]) : undefined;
      if (!sub && method === "POST") {
        const key = u.searchParams.get("metadataItemId") ?? "";
        const c = collections.find((x) => x.key === key && x.section === Number(manage[1]));
        if (!c) return reply(400, {});
        const identifier = `custom.collection.${c.section}.${c.key}`;
        if (!list.some((h) => h.identifier === identifier)) {
          const flag = (k: string, ch: string) => (u.searchParams.get(k) === "1" ? ch : "-");
          list.push({
            identifier,
            title: c.title,
            on:
              flag("promotedToRecommended", "r") +
              flag("promotedToOwnHome", "h") +
              flag("promotedToSharedHome", "s"),
          });
        }
        return reply(200, {});
      }
      // A sidebar-only library (Visibility 2) reports its rows as off Home whatever they are set
      // to, as the owner's real Plex does (11-10).
      const sidebarOnly = libs.find((l) => l.key === manage[1])?.hidden === "2";
      if (!sub && method === "GET")
        return reply(200, {
          MediaContainer: {
            size: list.length,
            Hub: list.map((h) => ({
              identifier: h.identifier,
              title: h.title,
              promotedToRecommended: h.on[0] === "r",
              promotedToOwnHome: !sidebarOnly && h.on[1] === "h",
              promotedToSharedHome: h.on[2] === "s",
            })),
          },
        });
      // Plex's own move: the row in the path and `after` always there (empty: the top). Without
      // `after` real Plex answers OK and moves nothing; the stand-in refuses so tests catch it.
      const move = sub ? /^(.+)\/move$/.exec(sub) : null;
      if (move && method === "PUT") {
        if (!u.searchParams.has("after")) return reply(400, {});
        const id = move[1]!;
        const after = u.searchParams.get("after") ?? "";
        const at = list.findIndex((h) => h.identifier === id);
        if (at < 0 || (after && !list.some((h) => h.identifier === after))) return reply(400, {});
        const [h] = list.splice(at, 1);
        list.splice(after ? list.findIndex((x) => x.identifier === after) + 1 : 0, 0, h!);
        return reply(200, {});
      }
      const h = list.find((x) => x.identifier === sub);
      if (h && method === "DELETE" && h.identifier.startsWith("custom.collection.")) {
        list.splice(list.indexOf(h), 1);
        return reply(200, {});
      }
      if (!h || method !== "PUT") return reply(404, {});
      const f = (k: string, c: string, i: number) =>
        u.searchParams.has(k) ? (u.searchParams.get(k) === "1" ? c : "-") : h.on[i]!;
      h.on =
        f("promotedToRecommended", "r", 0) +
        f("promotedToOwnHome", "h", 1) +
        f("promotedToSharedHome", "s", 2);
      return reply(200, {});
    }
    if (p === "/:/prefs") {
      if (method === "PUT") {
        for (const [k, v] of u.searchParams) {
          const s = settings.find((x) => x.id === k);
          if (!s) return reply(400, {});
          s.value = (
            s.type === "bool" ? v === "1" || v === "true" : s.type === "int" ? Number(v) : v
          ) as never;
        }
        return reply(200, {});
      }
      return reply(200, { MediaContainer: { size: settings.length, Setting: settings } });
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    homeTruth: (libraryId) =>
      (hubs[libraryId] ?? []).map((h) => `${h.identifier}:${h.on[1] === "h" ? "h" : "-"}`),
    scanning: (libraryId) => {
      activities = activities.filter((a) => a.type !== "library.update.section");
      const lib = libs.find((l) => l.key === libraryId);
      if (lib)
        activities.push({
          uuid: `scan-${lib.key}`,
          type: "library.update.section",
          title: `Scanning ${lib.title}`,
          progress: 40,
        });
    },
    reset: (o) => {
      extra = o?.newReleases ?? opts.newReleases ?? false;
      family = o?.family ?? false;
      items = ITEMS(family);
      settings = SETTINGS();
      kids = o?.kidsTv ?? false;
      hubs = {
        ...HUBS(),
        ...(extra ? { "3": NEW_HUBS.map((h) => ({ ...h })) } : {}),
        ...(kids ? { "4": KIDS_HUBS.map((h) => ({ ...h })) } : {}),
      };
      libs = LIBS(extra, kids);
      activities = [];
      collections = OWN();
      nextCollection = 9101;
      nextItem = 5001;
    },
  };
}
