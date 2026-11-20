import { deflateSync } from "node:zlib";
import type { Fetch } from "./http";

/**
 * A stand-in Jellyfin (port 8096) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): two people watching (one converted for a phone away from home), two libraries, users,
 * a failed scheduled task, recent additions, and the calls the panel's controls make: users' access
 * (an administrator and two people), signed-in devices, the activity log, log files and plugins,
 * and the tabs that match Plex's (11-04): a library to browse, a title's details, watched marks and
 * edits, libraries' folders, plugins with an update and a catalog, settings, and a restart.
 */

export interface FakeJellyfin {
  fetch: Fetch;
  reset(): void;
  /** A new movie arrives in the library (media announcements). */
  arrive(title?: string): void;
}

interface FakeTask {
  Id: string;
  Name: string;
  State: string;
  Triggers: unknown[];
  LastExecutionResult: { Status: string; EndTimeUtc?: string; ErrorMessage?: string };
}

const DAILY = { Type: "DailyTrigger", TimeOfDayTicks: 108_000_000_000 };

const TASKS = (): FakeTask[] => [
  {
    Id: "t1",
    Name: "Scan Media Library",
    State: "Idle",
    Triggers: [{ Type: "IntervalTrigger", IntervalTicks: 432_000_000_000 }],
    LastExecutionResult: { Status: "Completed", EndTimeUtc: new Date().toISOString() },
  },
  {
    Id: "t2",
    Name: "Extract Chapter Images",
    State: "Idle",
    Triggers: [DAILY],
    LastExecutionResult: { Status: "Failed", ErrorMessage: "ffmpeg exited with code 1" },
  },
  {
    Id: "t3",
    Name: "Generate Trickplay Images",
    State: "Running",
    Triggers: [DAILY],
    LastExecutionResult: { Status: "Completed", EndTimeUtc: new Date().toISOString() },
  },
];

const SESSIONS = () => [
  {
    Id: "s1",
    UserName: "Alex",
    Client: "Jellyfin Android TV",
    DeviceName: "Living Room",
    RemoteEndPoint: "192.168.1.40",
    NowPlayingItem: {
      Name: "Woe's Hollow",
      SeriesName: "Severance",
      Type: "Episode",
      RunTimeTicks: 30_000_000_000,
    },
    PlayState: { PositionTicks: 12_000_000_000, IsPaused: false, PlayMethod: "DirectPlay" },
  },
  {
    Id: "s2",
    UserName: "sam",
    Client: "Jellyfin iOS",
    DeviceName: "iPhone",
    RemoteEndPoint: "203.0.113.9",
    NowPlayingItem: {
      Name: "Dune: Part Two",
      ProductionYear: 2024,
      Type: "Movie",
      RunTimeTicks: 100_000_000_000,
    },
    PlayState: { PositionTicks: 71_000_000_000, IsPaused: false, PlayMethod: "Transcode" },
    TranscodingInfo: {
      TranscodeReasons: ["VideoCodecNotSupported", "ContainerBitrateExceedsLimit"],
    },
  },
];

/** A 1x1 picture, standing in for posters. */
/**
 * Stand-in artwork: a soft ember glow on a dark ground (poster 2:3, backdrop 16:9), made here so
 * previews look like a real post without using anyone's artwork.
 */
export function placeholderArt(
  w: number,
  h: number,
  cx: number,
  cy: number,
  /** The glow's color, red, green and blue strength (an ember by default). */
  tint: [number, number, number] = [210, 90, 20],
): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      const k = Math.max(0, 1 - Math.hypot(u - cx, (v - cy) * 0.8) * 1.6) ** 2;
      const base = 18 + 20 * v;
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.min(255, Math.round(base + tint[0] * k));
      raw[o + 1] = Math.min(255, Math.round(base * 0.8 + tint[1] * k));
      raw[o + 2] = Math.min(255, Math.round(base * 1.1 + tint[2] * k));
    }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ART = {
  Primary: placeholderArt(40, 60, 0.5, 0.65),
  Backdrop: placeholderArt(96, 54, 0.7, 0.55),
};

const HARBOR_SERIES = {
  Id: "series-harbor",
  Name: "Harbor Lights",
  Type: "Series",
  ProductionYear: 2026,
  Overview: "A coastal town keeps its secrets until the lighthouse goes dark.",
  Genres: ["Mystery", "Drama"],
  ProviderIds: { Tvdb: "990001" },
  RemoteTrailers: [{ Url: "https://www.youtube.com/watch?v=harbor00001" }],
};

const movieItem = (
  id: string,
  name: string,
  year: number,
  tmdb: string,
  extra: Record<string, unknown> = {},
) => ({
  Id: id,
  Name: name,
  Type: "Movie",
  ProductionYear: year,
  ProviderIds: { Tmdb: tmdb },
  Overview: `${name}: a story worth staying in for.`,
  Genres: ["Drama"],
  RunTimeTicks: 5_640_000_000_0,
  CommunityRating: 7.2,
  OfficialRating: "PG-13",
  ImageTags: { Primary: "p" },
  BackdropImageTags: ["b"],
  DateCreated: new Date(Date.now() - 86_400_000).toISOString(),
  ...extra,
});

/**
 * A stand-in Jellyfin; with emby, a stand-in Emby 4.10 as well: Emby's own home rows
 * (HomeSections), collections, genres and tags, as the real 4.10.2 answered them (11-09).
 */
export function fakeJellyfin(opts: { emby?: boolean } = {}): FakeJellyfin {
  let sessions = SESSIONS();
  let scanning = false;
  let tasks = TASKS();
  const MOVIES = () => [
    movieItem("m-anora", "Anora", 2024, "1064213"),
    movieItem("m-dune2", "Dune: Part Two", 2024, "693134"),
  ];
  const EPISODES = () => [
    {
      Id: "e-harbor-101",
      Name: "Pilot",
      Type: "Episode",
      SeriesName: "Harbor Lights",
      SeriesId: "series-harbor",
      ParentIndexNumber: 1,
      IndexNumber: 1,
      ProviderIds: {},
      Overview: "The light goes out.",
      DateCreated: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ];
  const USERS = () => [
    {
      Id: "u1",
      Name: "Alex",
      LastActivityDate: new Date().toISOString(),
      Policy: {
        IsAdministrator: true,
        IsDisabled: false,
        EnableAllFolders: true,
        EnabledFolders: [] as string[],
        EnableContentDownloading: true,
      },
    },
    {
      Id: "u2",
      Name: "sam",
      LastActivityDate: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      Policy: {
        IsAdministrator: false,
        IsDisabled: false,
        EnableAllFolders: true,
        EnabledFolders: [] as string[],
        EnableContentDownloading: false,
      },
    },
    {
      Id: "u3",
      Name: "kim",
      Policy: {
        IsAdministrator: false,
        IsDisabled: false,
        EnableAllFolders: false,
        EnabledFolders: ["lib-movies"],
        EnableContentDownloading: false,
      },
    },
  ];
  const DEVICES = () => [
    {
      Id: "dev-tv",
      Name: "Living room TV",
      AppName: "Jellyfin Android TV",
      AppVersion: "0.18.1",
      LastUserName: "Alex",
      DateLastActivity: new Date().toISOString(),
    },
    {
      Id: "dev-phone",
      Name: "Pixel 8",
      AppName: "Findroid",
      AppVersion: "0.15",
      LastUserName: "sam",
      DateLastActivity: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ];
  let users = USERS();
  let devices = DEVICES();
  let libraryMovies = MOVIES();
  let libraryEpisodes = EPISODES();
  const PLUGINS = () => [
    {
      Id: "p1",
      Name: "TMDb",
      Version: "10.10.7.0",
      Status: "Active",
      Description: "Metadata from TheMovieDb.",
      CanUninstall: false,
    },
    {
      Id: "p2",
      Name: "Open Subtitles",
      Version: "20.0.0.0",
      Status: "Active",
      Description: "Download subtitles from OpenSubtitles.",
      CanUninstall: true,
    },
  ];
  const REPO = "https://repo.jellyfin.org/files/plugin/manifest.json";
  const PACKAGES = [
    {
      name: "Open Subtitles",
      guid: "p2",
      overview: "Download subtitles from OpenSubtitles.",
      category: "Subtitles",
      owner: "jellyfin",
      versions: [
        {
          version: "21.0.0.0",
          targetAbi: "10.10.0.0",
          repositoryName: "Jellyfin Stable",
          repositoryUrl: REPO,
        },
        {
          version: "20.0.0.0",
          targetAbi: "10.9.0.0",
          repositoryName: "Jellyfin Stable",
          repositoryUrl: REPO,
        },
      ],
    },
    {
      name: "Fanart",
      guid: "p3",
      overview: "Artwork from fanart.tv.",
      category: "Metadata",
      owner: "jellyfin",
      versions: [
        {
          version: "12.0.0.0",
          targetAbi: "10.10.0.0",
          repositoryName: "Jellyfin Stable",
          repositoryUrl: REPO,
        },
      ],
    },
    {
      name: "Too New",
      guid: "p4",
      overview: "Needs a newer Jellyfin.",
      category: "General",
      owner: "someone",
      versions: [{ version: "1.0.0.0", targetAbi: "11.0.0.0", repositoryName: "Jellyfin Stable" }],
    },
  ];
  const FOLDERS = () => [
    {
      Name: "Movies",
      CollectionType: "movies",
      ItemId: "lib-movies",
      Locations: ["/media/movies"],
    },
    {
      Name: "Shows",
      CollectionType: "tvshows",
      ItemId: "lib-shows",
      Locations: ["/media/tv", "/media/tv2"],
    },
  ];
  const CONFIG = (): Record<string, unknown> => ({
    ServerName: "homeserver",
    PreferredMetadataLanguage: "en",
    MetadataCountryCode: "US",
    EnableGroupingMoviesIntoCollections: false,
    DisplaySpecialsWithinSeasons: true,
    MinResumePct: 5,
    MaxResumePct: 90,
    RemoteClientBitrateLimit: 0,
    ActivityLogRetentionDays: 30,
    LogFileRetentionDays: 3,
    CachePath: "/cache",
  });
  const ENCODING = (): Record<string, unknown> => ({
    HardwareAccelerationType: "none",
    EnableHardwareEncoding: true,
    AllowHevcEncoding: false,
    EnableTonemapping: false,
    EncoderPreset: "auto",
    EnableThrottling: false,
  });
  let plugins = PLUGINS();
  let pendingRestart = false;
  let pendingInstall: { Id: string; Name: string; Version: string }[] = [];
  let folders = FOLDERS();
  let config = CONFIG();
  let encoding = ENCODING();
  let played = new Set<string>(["m-dune2"]);
  let likes = new Map<string, boolean>();
  let favorites = new Set<string>();
  let edits: Record<string, Record<string, unknown>> = {};
  // Each person's home screen (Home rows): Jellyfin's display preferences and user settings.
  let prefs: Record<string, Record<string, unknown>> = {};
  let userConfig: Record<string, Record<string, unknown>> = {};
  // Emby's home rows: unsaved (Emby's defaults) until a person's first change, as the real one.
  type Sec = Record<string, unknown> & { Id: string; SectionType: string };
  let homeSections: Record<string, Sec[]> = {};
  let boxsets: { Id: string; Name: string; Items: string[] }[] = [];
  let sectionIds = 0;
  const EMBY_DEFAULTS = (): Sec[] => [
    { Id: "smalllibrarytiles", SectionType: "userviews", Name: "My Media" },
    { Id: "resume", SectionType: "resume", Name: "Continue Watching" },
    {
      Id: "latestmediablock",
      SectionType: "latestmediablock",
      Name: "Latest Media",
      ExcludedFolders: [],
    },
  ];
  const sectionsOf = (id: string) => homeSections[id] ?? EMBY_DEFAULTS();
  const saveSections = (id: string) => (homeSections[id] ??= EMBY_DEFAULTS());
  const configOf = (id: string) =>
    (userConfig[id] ??= {
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      PlayDefaultAudioTrack: true,
    });
  const viewsOf = (id: string) => {
    const u = users.find((x) => x.Id === id);
    const order = (configOf(id).OrderedViews as string[]) ?? [];
    return folders
      .filter((f) => !u || u.Policy.EnableAllFolders || u.Policy.EnabledFolders.includes(f.ItemId))
      .map((f) => ({ Id: f.ItemId, Name: f.Name, CollectionType: f.CollectionType }))
      .sort((a, b) => {
        const ia = order.indexOf(a.Id);
        const ib = order.indexOf(b.Id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
  };
  const SEASON = {
    Id: "season-harbor-1",
    Name: "Season 1",
    Type: "Season",
    IndexNumber: 1,
    IsFolder: true,
    ChildCount: 1,
    SeriesId: "series-harbor",
    SeriesName: "Harbor Lights",
  };
  const withUser = (x: Record<string, unknown>): Record<string, unknown> => {
    const id = String(x.Id);
    const e = edits[id] ?? {};
    const folder = id === "season-harbor-1" || id === "series-harbor";
    const ep = played.has("e-harbor-101");
    return {
      ...x,
      ...e,
      ...(e.ForcedSortName ? { SortName: String(e.ForcedSortName).toLowerCase() } : {}),
      UserData: folder
        ? { Played: ep, UnplayedItemCount: ep ? 0 : 1 }
        : {
            Played: played.has(id),
            ...(likes.has(id) ? { Likes: likes.get(id) } : {}),
            IsFavorite: favorites.has(id),
          },
    };
  };
  const allItems = (): Record<string, unknown>[] =>
    [...libraryMovies, ...libraryEpisodes, HARBOR_SERIES, SEASON].map((x) => {
      const r = x as Record<string, unknown>;
      if (r.Type === "Movie")
        return {
          ...r,
          MediaSources: [
            {
              Path: `/media/movies/${String(r.Name)} (${String(r.ProductionYear)})/${String(r.Name)}.mkv`,
              Size: 4_200_000_000,
              Container: "mkv",
              MediaStreams: [
                { Type: "Video", Height: 1080, Codec: "hevc" },
                { Type: "Audio", DisplayTitle: "English - EAC3 5.1" },
              ],
            },
          ],
        };
      if (r.Type === "Series") return { ...r, IsFolder: true, ChildCount: 1 };
      return r;
    });
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const embyRoute = (u: URL, p: string, method: string, body?: string) => {
    const parse = () => JSON.parse(body ?? "{}") as Record<string, unknown>;
    const home = /^\/Users\/(\w+)\/HomeSections(\/Delete|\/Move)?$/.exec(p);
    if (home) {
      const id = home[1]!;
      if (!users.some((x) => x.Id === id)) return reply(404, {});
      if (method === "GET") {
        const list = sectionsOf(id);
        if (u.searchParams.get("IsEditMode") === "true") return reply(200, list);
        // On the home screen, Latest Media is a row per library.
        return reply(
          200,
          list.flatMap((sec) =>
            sec.SectionType !== "latestmediablock"
              ? [sec]
              : viewsOf(id)
                  .filter((v) => !((sec.ExcludedFolders as string[]) ?? []).includes(v.Id))
                  .map((v) => ({
                    Id: `latestmedia_${v.Id}`,
                    SectionType: "latestmedia",
                    Name: `Latest ${v.Name}`,
                    ParentId: v.Id,
                  })),
          ),
        );
      }
      const b = parse();
      if (home[2] === "/Delete") {
        // Emby's defaults aren't saved yet: removing one changes nothing (the real 4.10.2).
        const saved = homeSections[id];
        if (saved) {
          const ids = (b.Ids as string[]) ?? [];
          homeSections[id] = saved.filter((x) => !ids.includes(x.Id));
        }
        return reply(204, null);
      }
      const list = saveSections(id);
      if (home[2] === "/Move") {
        const ids = (b.Ids as string[]) ?? [];
        const moving = list.filter((x) => ids.includes(x.Id));
        const rest = list.filter((x) => !ids.includes(x.Id));
        rest.splice(Number(b.NewIndex ?? 0), 0, ...moving);
        homeSections[id] = rest;
        return reply(204, null);
      }
      const i = typeof b.Id === "string" ? list.findIndex((x) => x.Id === b.Id) : -1;
      const was = i >= 0 ? list[i] : undefined;
      const sec = {
        ...b,
        Name: (b.CustomName as string) || was?.Name || String(b.SectionType),
      } as unknown as Sec;
      if (i >= 0) list[i] = sec;
      else list.push({ ...sec, Id: `sec${++sectionIds}` });
      return reply(204, null);
    }
    const rows = /^\/Users\/(\w+)\/Sections\/([\w-]+)\/Items$/.exec(p);
    if (rows) {
      const sid = rows[2]!;
      const sec = sectionsOf(rows[1]!).find((x) => x.Id === sid);
      const items = sid.startsWith("latestmedia_")
        ? sid.endsWith("lib-shows")
          ? libraryEpisodes
          : libraryMovies
        : sec?.SectionType === "boxset"
          ? libraryMovies.filter((m) =>
              boxsets.find((c) => c.Id === sec.ParentId)?.Items.includes(String(m.Id)),
            )
          : sec?.SectionType === "items"
            ? libraryMovies
            : [];
      return reply(200, { Items: items.map(withUser), TotalRecordCount: items.length });
    }
    const views = /^\/Users\/(\w+)\/Views$/.exec(p);
    if (views) return reply(200, { Items: viewsOf(views[1]!) });
    const conf = /^\/Users\/(\w+)\/Configuration$/.exec(p);
    if (conf && method === "POST") {
      if (!users.some((x) => x.Id === conf[1])) return reply(404, {});
      userConfig[conf[1]!] = parse();
      return reply(204, null);
    }
    const userItems = /^\/Users\/(\w+)\/Items$/.exec(p);
    if (userItems) {
      const types = u.searchParams.get("IncludeItemTypes") ?? "";
      const words = (u.searchParams.get("SearchTerm") ?? "").toLowerCase();
      if (types === "BoxSet")
        return reply(200, {
          Items: boxsets.map((c) => ({ Id: c.Id, Name: c.Name, Type: "BoxSet" })),
        });
      if (types === "Playlist") return reply(200, { Items: [] });
      if (words)
        return reply(200, {
          Items: libraryMovies.filter((m) => String(m.Name).toLowerCase().includes(words)),
        });
    }
    if (p === "/Genres")
      return reply(200, {
        Items: [
          { Id: "g-comedy", Name: "Comedy" },
          { Id: "g-drama", Name: "Drama" },
        ],
      });
    if (p === "/Tags") return reply(200, { Items: [{ Id: "t-holiday", Name: "Holiday" }] });
    if (p === "/Collections" && method === "POST") {
      const c = {
        Id: `box${boxsets.length + 1}`,
        Name: u.searchParams.get("Name") ?? "Collection",
        Items: (u.searchParams.get("Ids") ?? "").split(",").filter(Boolean),
      };
      boxsets.push(c);
      return reply(200, { Id: c.Id, Name: c.Name });
    }
    return undefined;
  };
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    const auth = ((init.headers ?? {}) as Record<string, string>).Authorization ?? "";
    if (!/Token="e2e-/.test(auth)) return reply(401, {});
    if (p === "/System/Info")
      return reply(200, {
        Version: "10.10.7",
        ServerName: "homeserver",
        HasPendingRestart: pendingRestart,
      });
    if (p === "/Sessions")
      return reply(200, [...sessions, { Id: "idle", UserName: "Alex", Client: "Web" }]);
    if (p === "/Library/VirtualFolders" && method === "GET")
      return reply(
        200,
        folders.map((f, i) => ({ ...f, RefreshStatus: scanning && i === 0 ? "Active" : "Idle" })),
      );
    if (p === "/Items/Counts")
      return reply(200, { MovieCount: 812, SeriesCount: 140, EpisodeCount: 6123 });
    if (opts.emby) {
      const answer = embyRoute(u, p, method, init.body);
      if (answer) return answer;
    }
    if (p === "/Users") return reply(200, users);
    if (p === "/UserViews") {
      const id = u.searchParams.get("userId") ?? "";
      return reply(200, { Items: viewsOf(id), TotalRecordCount: viewsOf(id).length });
    }
    if (p === "/DisplayPreferences/usersettings") {
      const id = u.searchParams.get("userId") ?? "";
      if (!users.some((x) => x.Id === id)) return reply(404, {});
      if (method === "POST") {
        prefs[id] = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        return reply(204, null);
      }
      return reply(200, prefs[id] ?? { Id: "usersettings", Client: "emby", CustomPrefs: {} });
    }
    if (method === "POST" && p === "/Users/Configuration") {
      const id = u.searchParams.get("userId") ?? "";
      if (!users.some((x) => x.Id === id)) return reply(404, {});
      userConfig[id] = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return reply(204, null);
    }
    if (p === "/Items/Latest") {
      const parent = u.searchParams.get("parentId");
      const list =
        parent === "lib-movies" ? libraryMovies : parent === "lib-shows" ? libraryEpisodes : [];
      return reply(200, list.map(withUser));
    }
    if (p === "/UserItems/Resume")
      return reply(200, { Items: libraryMovies.slice(0, 1).map(withUser) });
    if (p === "/Shows/NextUp") return reply(200, { Items: libraryEpisodes.map(withUser) });
    const policy = /^\/Users\/(\w+)\/Policy$/.exec(p);
    if (method === "POST" && policy) {
      const u = users.find((x) => x.Id === policy[1]);
      if (!u) return reply(404, {});
      u.Policy = { ...u.Policy, ...(JSON.parse(init.body ?? "{}") as typeof u.Policy) };
      return reply(204, null);
    }
    const oneUser = /^\/Users\/(\w+)$/.exec(p);
    if (method === "DELETE" && oneUser) {
      users = users.filter((x) => x.Id !== oneUser[1]);
      return reply(204, null);
    }
    if (method === "GET" && oneUser) {
      const x = users.find((y) => y.Id === oneUser[1]);
      return x ? reply(200, { ...x, Configuration: configOf(x.Id) }) : reply(404, {});
    }
    if (p === "/Devices" && method === "DELETE") {
      devices = devices.filter((d) => d.Id !== u.searchParams.get("id"));
      return reply(204, null);
    }
    if (p === "/Devices") return reply(200, { Items: devices, TotalRecordCount: devices.length });
    if (p === "/System/ActivityLog/Entries")
      return reply(200, {
        TotalRecordCount: 3,
        Items: [
          {
            Id: 3,
            Name: "sam is playing Quiet Harbor on Pixel 8",
            Type: "VideoPlayback",
            Severity: "Information",
            Date: new Date().toISOString(),
          },
          {
            Id: 2,
            Name: "kim failed to sign in from 192.0.2.7",
            ShortOverview: "Invalid username or password",
            Type: "AuthenticationFailed",
            Severity: "Error",
            Date: new Date(Date.now() - 3_600_000).toISOString(),
          },
          {
            Id: 1,
            Name: "Scan Media Library completed",
            Type: "TaskCompleted",
            Severity: "Information",
            Date: new Date(Date.now() - 7_200_000).toISOString(),
          },
        ],
      });
    if (p === "/System/Logs")
      return reply(200, [
        { Name: "log_20261101.log", Size: 20480, DateModified: new Date().toISOString() },
      ]);
    if (p === "/System/Logs/Log")
      return {
        ok: true,
        status: 200,
        json: async () => null,
        text: async () =>
          [
            "[INF] Main: Jellyfin version: 10.10.7",
            "[INF] Request GET /Items?api_key=0123456789abcdef0123456789abcdef",
            "[ERR] ffmpeg exited with code 1",
          ].join(String.fromCharCode(10)),
      };
    if (p === "/Plugins") return reply(200, plugins);
    const plug = /^\/Plugins\/(\w+)\/([\d.]+)(?:\/(Enable|Disable))?$/.exec(p);
    if (plug) {
      const x = plugins.find((q) => q.Id === plug[1] && q.Version === plug[2]);
      if (!x) return reply(404, {});
      if (method === "DELETE") plugins = plugins.filter((q) => q !== x);
      else if (plug[3]) x.Status = plug[3] === "Enable" ? "Active" : "Disabled";
      pendingRestart = true;
      // Like the real one: the change is made, and the answer can still say 404.
      return reply(plug[3] ? 404 : 204, null);
    }
    if (p === "/Packages") return reply(200, PACKAGES);
    const install = /^\/Packages\/Installed\/(.+)$/.exec(p);
    if (method === "POST" && install) {
      const pkg = PACKAGES.find((k) => k.guid === u.searchParams.get("assemblyGuid"));
      if (!pkg) return reply(404, {});
      pendingInstall.push({
        Id: pkg.guid,
        Name: pkg.name,
        Version: u.searchParams.get("version") ?? "",
      });
      pendingRestart = true;
      return reply(204, null);
    }
    if (p === "/Repositories")
      return reply(200, [{ Name: "Jellyfin Stable", Url: REPO, Enabled: true }]);
    if (method === "POST" && p === "/System/Restart") {
      for (const n of pendingInstall) {
        plugins = plugins.filter((q) => q.Id !== n.Id);
        plugins.push({ ...n, Status: "Active", Description: "", CanUninstall: true });
      }
      pendingInstall = [];
      pendingRestart = false;
      return reply(204, null);
    }
    if (p === "/System/Configuration") {
      if (method !== "POST") return reply(200, config);
      config = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return reply(204, null);
    }
    if (p === "/System/Configuration/encoding") {
      if (method !== "POST") return reply(200, encoding);
      encoding = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return reply(204, null);
    }
    if (method === "POST" && p === "/Environment/ValidatePath") {
      const path = String((JSON.parse(init.body ?? "{}") as { Path?: string }).Path ?? "");
      return reply(path.startsWith("/media") ? 204 : 404, null);
    }
    if (p === "/Library/VirtualFolders/Paths") {
      if (method === "POST") {
        const b = JSON.parse(init.body ?? "{}") as { Name?: string; PathInfo?: { Path?: string } };
        const f = folders.find((x) => x.Name === b.Name);
        if (!f || !b.PathInfo?.Path) return reply(400, {});
        f.Locations = [...f.Locations, b.PathInfo.Path];
        return reply(204, null);
      }
      const f = folders.find((x) => x.Name === u.searchParams.get("name"));
      if (!f) return reply(404, {});
      f.Locations = f.Locations.filter((l) => l !== u.searchParams.get("path"));
      return reply(204, null);
    }
    if (p === "/Library/VirtualFolders" && method === "POST") {
      folders.push({
        Name: u.searchParams.get("name") ?? "New",
        CollectionType: u.searchParams.get("collectionType") ?? "movies",
        ItemId: `lib-${folders.length + 1}`,
        Locations: (u.searchParams.get("paths") ?? "").split(",").filter(Boolean),
      });
      return reply(204, null);
    }
    if (p === "/Library/VirtualFolders" && method === "DELETE") {
      folders = folders.filter((x) => x.Name !== u.searchParams.get("name"));
      return reply(204, null);
    }
    const ratedItem = /^\/UserItems\/([\w-]+)\/Rating$/.exec(p);
    if (ratedItem && method === "POST") {
      likes.set(ratedItem[1]!, u.searchParams.get("likes") === "true");
      return reply(200, {});
    }
    const favItem = /^\/UserFavoriteItems\/([\w-]+)$/.exec(p);
    if (favItem) {
      if (method === "POST") favorites.add(favItem[1]!);
      else favorites.delete(favItem[1]!);
      return reply(200, {});
    }
    const playedItem = /^\/UserPlayedItems\/([\w-]+)$/.exec(p);
    if (playedItem) {
      if (method === "POST") played.add(playedItem[1]!);
      else played.delete(playedItem[1]!);
      return reply(200, {});
    }
    const oneItem = /^\/Items\/([\w-]+)$/.exec(p);
    if (oneItem) {
      const it = allItems().find((x) => x.Id === oneItem[1]);
      if (!it) return reply(404, {});
      if (method === "POST") {
        const b = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        const keep: Record<string, unknown> = {};
        for (const k of ["Name", "ForcedSortName", "ProductionYear", "Overview", "LockedFields"])
          if (k in b) keep[k] = b[k];
        edits[String(it.Id)] = { ...(edits[String(it.Id)] ?? {}), ...keep };
        return reply(204, null);
      }
      return reply(200, withUser(it));
    }
    if (p === "/ScheduledTasks") return reply(200, tasks);
    const running = /^\/ScheduledTasks\/Running\/(\w+)$/.exec(p);
    if (method === "DELETE" && running) {
      const t = tasks.find((x) => x.Id === running[1]);
      if (t) t.State = "Idle";
      return reply(204, null);
    }
    const triggers = /^\/ScheduledTasks\/(\w+)\/Triggers$/.exec(p);
    if (method === "POST" && triggers) {
      const t = tasks.find((x) => x.Id === triggers[1]);
      if (!t) return reply(404, {});
      t.Triggers = JSON.parse(init.body ?? "[]") as unknown[];
      return reply(204, null);
    }
    // Media announcements read each library's newest items with their ids and details.
    const parent = u.searchParams.get("ParentId");
    // A library's size: the panel counts each kind with Limit=0.
    if (p === "/Items" && parent && u.searchParams.get("Limit") === "0") {
      const type = u.searchParams.get("IncludeItemTypes");
      const n =
        parent === "lib-movies" && type === "Movie"
          ? 812
          : parent === "lib-shows" && type === "Series"
            ? 140
            : parent === "lib-shows" && type === "Episode"
              ? 6123
              : 0;
      return reply(200, { Items: [], TotalRecordCount: n });
    }
    const ids = u.searchParams.get("Ids");
    if (p === "/Items" && ids) {
      const want = ids.split(",");
      return reply(200, {
        Items: allItems()
          .filter((x) => want.includes(String(x.Id)))
          .map(withUser),
      });
    }
    if (p === "/Items" && parent === "series-harbor")
      return reply(200, { Items: [withUser(SEASON)] });
    if (p === "/Items" && parent === "season-harbor-1")
      return reply(200, { Items: libraryEpisodes.map(withUser) });
    if (p === "/Items" && (parent === "lib-movies" || parent === "lib-shows")) {
      const types = u.searchParams.get("IncludeItemTypes");
      let list: Record<string, unknown>[] =
        parent === "lib-movies"
          ? libraryMovies
          : types === "Series"
            ? [{ ...HARBOR_SERIES, IsFolder: true, ImageTags: { Primary: "p" } }]
            : libraryEpisodes;
      list = list.map(withUser);
      const term = (u.searchParams.get("SearchTerm") ?? "").toLowerCase();
      if (term) list = list.filter((x) => String(x.Name).toLowerCase().includes(term));
      if (u.searchParams.get("Filters") === "IsUnplayed")
        list = list.filter((x) => !(x.UserData as { Played?: boolean }).Played);
      if (u.searchParams.get("SortBy")?.startsWith("SortName"))
        list = [...list].sort((a, b) =>
          String(a.SortName ?? a.Name).localeCompare(String(b.SortName ?? b.Name)),
        );
      const start = Number(u.searchParams.get("StartIndex") ?? 0);
      const limit = Number(u.searchParams.get("Limit") ?? 1000);
      return reply(200, { Items: list.slice(start, start + limit), TotalRecordCount: list.length });
    }
    if (p === "/Items" && u.searchParams.get("Ids") === "series-harbor")
      return reply(200, { Items: [HARBOR_SERIES] });
    const art = /^\/Items\/[\w-]+\/Images\/(Primary|Backdrop)$/.exec(p);
    if (art) {
      const img = ART[art[1] as keyof typeof ART];
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
        json: async () => ({}),
        text: async () => "",
        arrayBuffer: async () => img.buffer.slice(img.byteOffset, img.byteOffset + img.length),
      } as unknown as Awaited<ReturnType<Fetch>>;
    }
    if (p === "/Items")
      return reply(200, {
        Items: [
          {
            Id: "anora",
            Name: "Anora",
            Type: "Movie",
            ProductionYear: 2024,
            ImageTags: { Primary: "p1" },
            DateCreated: new Date().toISOString(),
          },
        ],
      });
    if (method === "POST" && p === "/Library/Refresh") {
      scanning = true;
      return reply(204, null);
    }
    if (method === "POST" && /^\/Items\/[\w-]+\/Refresh$/.test(p)) return reply(204, null);
    if (method === "POST" && /^\/ScheduledTasks\/Running\/\w+$/.test(p)) return reply(204, null);
    const stop = /^\/Sessions\/(\w+)\/Playing\/Stop$/.exec(p);
    if (method === "POST" && stop) {
      sessions = sessions.filter((s) => s.Id !== stop[1]);
      return reply(204, null);
    }
    if (method === "POST" && /^\/Sessions\/\w+\/Message$/.test(p)) return reply(204, null);
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    arrive: (title = "Quiet Harbor") => {
      // Each title is its own movie (its own ids), so separate runs each get a new arrival.
      const n = [...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 900_000, 7);
      libraryMovies = [
        movieItem(`m-${n}`, title, 2026, String(700_000 + n), {
          DateCreated: new Date().toISOString(),
          RemoteTrailers: [{ Url: "https://www.youtube.com/watch?v=quietharbor" }],
        }),
        ...libraryMovies,
      ];
    },
    reset: () => {
      libraryMovies = MOVIES();
      libraryEpisodes = EPISODES();
      sessions = SESSIONS();
      scanning = false;
      tasks = TASKS();
      users = USERS();
      devices = DEVICES();
      plugins = PLUGINS();
      pendingRestart = false;
      pendingInstall = [];
      folders = FOLDERS();
      config = CONFIG();
      encoding = ENCODING();
      played = new Set(["m-dune2"]);
      likes = new Map();
      favorites = new Set();
      edits = {};
      prefs = {};
      userConfig = {};
      homeSections = {};
      boxsets = [];
      sectionIds = 0;
    },
  };
}
