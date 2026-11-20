/**
 * What Hearth's stand-in Radarr and Sonarr share (native panels Phase 3): quality profiles,
 * custom formats and their name check, quality sizes, tags, delay and release profiles,
 * connections, naming and media management, scheduled tasks, backups, health, logs and commands.
 * Both apps are the same Servarr engine, so the stand-ins answer these the same way; the movie
 * and series parts live in fake-radarr.ts and fake-sonarr.ts. Titles are invented.
 */

export type Json = Record<string, unknown>;
export type ServarrApp = "radarr" | "sonarr" | "lidarr";

export const DAY = 86_400_000;
export const GB = 1024 ** 3;
export const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY).toISOString();

export const QUALITIES: Record<
  string,
  { id: number; name: string; resolution: number; source: string }
> = {
  sdtv: { id: 1, name: "SDTV", resolution: 480, source: "tv" },
  dvd: { id: 2, name: "DVD", resolution: 480, source: "dvd" },
  hdtv720: { id: 4, name: "HDTV-720p", resolution: 720, source: "tv" },
  web720: { id: 14, name: "WEBDL-720p", resolution: 720, source: "webdl" },
  bluray720: { id: 6, name: "Bluray-720p", resolution: 720, source: "bluray" },
  hdtv1080: { id: 9, name: "HDTV-1080p", resolution: 1080, source: "tv" },
  web1080: { id: 3, name: "WEBDL-1080p", resolution: 1080, source: "webdl" },
  bluray1080: { id: 7, name: "Bluray-1080p", resolution: 1080, source: "bluray" },
  web2160: { id: 18, name: "WEBDL-2160p", resolution: 2160, source: "webdl" },
  bluray2160: { id: 19, name: "Bluray-2160p", resolution: 2160, source: "bluray" },
};

export const reply = (status: number, data: unknown) => ({
  ok: status < 400,
  status,
  json: async () => data,
});

function qualityItems(allowed: string[]) {
  return Object.entries(QUALITIES).map(([key, q]) => ({
    quality: q,
    items: [],
    allowed: allowed.includes(key),
  }));
}

function initialProfiles(): Json[] {
  return [
    {
      id: 1,
      name: "HD-1080p",
      upgradeAllowed: true,
      cutoff: QUALITIES.bluray1080!.id,
      items: qualityItems(["hdtv1080", "web1080", "bluray1080", "web720", "bluray720"]),
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: 1,
      formatItems: [
        { format: 1, name: "Remux", score: 0 },
        { format: 2, name: "x265 (HD)", score: -10 },
        { format: 3, name: "Bad release group", score: -1000 },
      ],
      language: { id: 1, name: "English" },
    },
    {
      id: 2,
      name: "Ultra-HD",
      upgradeAllowed: false,
      cutoff: QUALITIES.bluray2160!.id,
      items: qualityItems(["web2160", "bluray2160"]),
      minFormatScore: 0,
      cutoffFormatScore: 0,
      minUpgradeFormatScore: 1,
      formatItems: [
        { format: 1, name: "Remux", score: 50 },
        { format: 2, name: "x265 (HD)", score: 0 },
        { format: 3, name: "Bad release group", score: -1000 },
      ],
      language: { id: 1, name: "English" },
    },
  ];
}

const spec = (
  name: string,
  implementation: string,
  implementationName: string,
  value: unknown,
  negate = false,
  required = false,
) => ({
  name,
  implementation,
  implementationName,
  negate,
  required,
  fields: [
    {
      order: 0,
      name: "value",
      label: implementation === "ReleaseTitleSpecification" ? "Regular Expression" : "Value",
      value,
      type: implementation === "ReleaseTitleSpecification" ? "textbox" : "select",
    },
  ],
});

function initialFormats(): Json[] {
  return [
    {
      id: 1,
      name: "Remux",
      includeCustomFormatWhenRenaming: false,
      specifications: [spec("Remux", "ReleaseTitleSpecification", "Release Title", "\\bremux\\b")],
    },
    {
      id: 2,
      name: "x265 (HD)",
      includeCustomFormatWhenRenaming: false,
      specifications: [
        spec(
          "x265",
          "ReleaseTitleSpecification",
          "Release Title",
          "[xh][ .]?265|\\bHEVC\\b",
          false,
          true,
        ),
        spec("Not 2160p", "ResolutionSpecification", "Resolution", 2160, true, true),
      ],
    },
    {
      id: 3,
      name: "Bad release group",
      includeCustomFormatWhenRenaming: false,
      specifications: [
        spec("Group", "ReleaseGroupSpecification", "Release Group", "^(BADGRP|FAKEGRP)$"),
      ],
    },
  ];
}

/** The condition types the custom format editor offers, as /customformat/schema lists them. */
const FORMAT_SCHEMA = [
  ["ReleaseTitleSpecification", "Release Title", "textbox"],
  ["ReleaseGroupSpecification", "Release Group", "textbox"],
  ["EditionSpecification", "Edition", "textbox"],
  ["LanguageSpecification", "Language", "select"],
  ["IndexerFlagSpecification", "Indexer Flag", "select"],
  ["SourceSpecification", "Source", "select"],
  ["ResolutionSpecification", "Resolution", "select"],
  ["QualityModifierSpecification", "Quality Modifier", "select"],
  ["SizeSpecification", "Size", "number"],
  ["YearSpecification", "Year", "number"],
].map(([implementation, implementationName, type]) => ({
  implementation,
  implementationName,
  negate: false,
  required: false,
  // Radarr 6.4's Size condition is a range in GB (checked on a real install, 11-17).
  fields:
    implementation === "SizeSpecification"
      ? [
          { order: 0, name: "min", label: "Minimum Size", type: "number", unit: "GB", value: 0 },
          { order: 1, name: "max", label: "Maximum Size", type: "number", unit: "GB", value: 0 },
        ]
      : [{ order: 0, name: "value", label: "Value", type }],
}));

/** Every regex the stand-in's formats test, applied the way the Release Title condition does. */
export function formatsMatching(formats: Json[], title: string) {
  const out: { id: number; name: string }[] = [];
  for (const f of formats) {
    const specs = (f.specifications as Json[]) ?? [];
    const results = specs.map((s) => {
      const value = ((s.fields as Json[])?.[0]?.value ?? "") as unknown;
      let hit = false;
      if (s.implementation === "ReleaseTitleSpecification" && typeof value === "string")
        hit = new RegExp(value, "i").test(title);
      else if (s.implementation === "ReleaseGroupSpecification" && typeof value === "string")
        hit = new RegExp(value, "i").test(/-([A-Za-z0-9]+)$/.exec(title)?.[1] ?? "");
      else if (s.implementation === "ResolutionSpecification")
        hit = title.includes(`${String(value)}p`);
      return { hit: s.negate ? !hit : hit, required: Boolean(s.required) };
    });
    const required = results.filter((r) => r.required);
    const optional = results.filter((r) => !r.required);
    const ok =
      results.length > 0 &&
      required.every((r) => r.hit) &&
      (optional.length === 0 || optional.some((r) => r.hit));
    if (ok) out.push({ id: f.id as number, name: f.name as string });
  }
  return out;
}

/** The score the first profile gives a set of matched formats (the name check's score). */
export function scoreOf(profiles: Json[], formats: { id: number }[]) {
  const profile = profiles[0]!;
  return formats.reduce(
    (sum, f) =>
      sum +
      (((profile.formatItems as Json[]).find((i) => i.format === f.id)?.score as number) ?? 0),
    0,
  );
}

/** A page of a list, as the paged endpoints answer. */
export function paged(list: Json[], u: URL) {
  const page = Math.max(1, Number(u.searchParams.get("page") ?? 1));
  const pageSize = Math.min(1000, Math.max(1, Number(u.searchParams.get("pageSize") ?? 20)));
  return {
    page,
    pageSize,
    sortKey: u.searchParams.get("sortKey") ?? "date",
    sortDirection: u.searchParams.get("sortDirection") ?? "descending",
    totalRecords: list.length,
    records: list.slice((page - 1) * pageSize, page * pageSize),
  };
}

const NAME: Record<ServarrApp, string> = { radarr: "Radarr", sonarr: "Sonarr", lidarr: "Lidarr" };
export const VERSION: Record<ServarrApp, string> = {
  radarr: "6.4.4.10685",
  sonarr: "4.0.20.3014",
  lidarr: "3.1.0.4875",
};

/** The state both stand-ins keep; each adds its own library, history, queue and naming. */
export function sharedState(app: ServarrApp) {
  const short = VERSION[app].split(".").slice(0, 3).join(".");
  return {
    profiles: initialProfiles(),
    formats: initialFormats(),
    tags: [
      { id: 1, label: "kids" },
      { id: 2, label: "4k-later" },
    ] as Json[],
    delayProfiles: [
      {
        id: 1,
        enableUsenet: true,
        enableTorrent: true,
        preferredProtocol: "usenet",
        usenetDelay: 0,
        torrentDelay: 60,
        bypassIfHighestQuality: true,
        bypassIfAboveCustomFormatScore: false,
        minimumCustomFormatScore: 0,
        order: 2147483647,
        tags: [],
      },
    ] as Json[],
    releaseProfiles: [
      {
        id: 1,
        name: "No samples",
        enabled: true,
        required: [],
        ignored: ["sample"],
        indexerId: 0,
        tags: [],
      },
    ] as Json[],
    // Quality sizes in MB per minute (maxSize null means no limit).
    sizes: Object.values(QUALITIES).map((q) => ({
      id: q.id,
      quality: q,
      title: q.name,
      weight: q.id,
      minSize: 0,
      maxSize: q.resolution >= 2160 ? null : 400,
      preferredSize: 95,
    })) as Json[],
    downloadClients: [
      {
        id: 1,
        name: "Stand-in Client",
        enable: true,
        protocol: "torrent",
        priority: 1,
        removeCompletedDownloads: true,
        removeFailedDownloads: true,
        implementation: "QBittorrent",
        implementationName: "qBittorrent",
        configContract: "QBittorrentSettings",
        fields: [
          { order: 0, name: "host", label: "Host", value: "qbittorrent", type: "textbox" },
          { order: 1, name: "port", label: "Port", value: 8080, type: "number" },
          {
            order: 2,
            name: "username",
            label: "Username",
            value: "admin",
            type: "textbox",
            privacy: "userName",
          },
          {
            order: 3,
            name: "password",
            label: "Password",
            value: "stand-in-secret",
            type: "password",
            privacy: "password",
          },
          {
            order: 4,
            name: { radarr: "movieCategory", sonarr: "tvCategory", lidarr: "musicCategory" }[app],
            label: "Category",
            value: { radarr: "radarr", sonarr: "tv-sonarr", lidarr: "lidarr" }[app],
            type: "textbox",
          },
        ],
        tags: [],
      },
    ] as Json[],
    indexers: [
      {
        id: 1,
        name: "Stand-in Indexer",
        enableRss: true,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        protocol: "torrent",
        priority: 25,
        implementation: "Torznab",
        implementationName: "Torznab",
        configContract: "TorznabSettings",
        fields: [
          {
            order: 0,
            name: "baseUrl",
            label: "URL",
            value: "http://prowlarr:9696/1/",
            type: "textbox",
          },
          {
            order: 1,
            name: "apiKey",
            label: "API Key",
            value: "stand-in-indexer-key",
            type: "textbox",
            privacy: "apiKey",
          },
          { order: 2, name: "minimumSeeders", label: "Minimum Seeders", value: 1, type: "number" },
        ],
        tags: [],
      },
    ] as Json[],
    notifications: [] as Json[],
    importLists: [] as Json[],
    tasks: (
      [
        ["Application Update Check", "ApplicationUpdateCheck", 360],
        ["Backup", "Backup", 10080],
        ["Check Health", "CheckHealth", 360],
        ["Clean Up Recycle Bin", "CleanUpRecycleBin", 1440],
        ["Housekeeping", "Housekeeping", 1440],
        ["Import List Sync", "ImportListSync", 1440],
        ...(app === "radarr"
          ? [
              ["Refresh Collections", "RefreshCollections", 1440],
              ["Refresh Monitored Downloads", "RefreshMonitoredDownloads", 1],
              ["Refresh Movie", "RefreshMovie", 1440],
            ]
          : [
              ["Refresh Monitored Downloads", "RefreshMonitoredDownloads", 1],
              ["Refresh Series", "RefreshSeries", 720],
            ]),
        ["RSS Sync", "RssSync", app === "radarr" ? 30 : 15],
      ] as [string, string, number][]
    ).map(([name, taskName, interval], i) => ({
      id: i + 1,
      name,
      taskName,
      interval,
      lastExecution: iso(-0.05 * (i + 1)),
      lastStartTime: iso(-0.05 * (i + 1)),
      nextExecution: iso(0.1 * (i + 1)),
      lastDuration: "00:00:01.2000000",
    })) as Json[],
    backups: [
      {
        id: 1,
        name: `${app}_backup_v${short}_2026.10.25.zip`,
        path: `/backup/scheduled/${app}_backup_v${short}_2026.10.25.zip`,
        type: "scheduled",
        size: 1_900_000,
        time: iso(-7),
      },
    ] as Json[],
    commands: [] as Json[],
    nextId: 1000,
  };
}
export type SharedState = ReturnType<typeof sharedState> & {
  naming: Json;
  media: Json;
  health: Json[];
  exclusions: Json[];
};

export interface CoreOptions<S extends SharedState> {
  app: ServarrApp;
  state: () => S;
  /** The library (movies or series), for tag details. */
  items: () => Json[];
  /** Root folder and disk path ("/movies" or "/tv"). */
  root: string;
  /** App-specific work a command does (ManualImport, refresh...). */
  onCommand?: (body: Json) => void;
}

/**
 * The shared part of a stand-in's request handling. Answers what both apps answer the same way;
 * returns undefined for anything app-specific.
 */
export function servarrCore<S extends SharedState>(o: CoreOptions<S>) {
  const nextId = () => ++o.state().nextId;
  const tagDetail = (t: Json) => {
    const s = o.state();
    const has = (list: Json[]) =>
      list.filter((x) => ((x.tags as number[]) ?? []).includes(t.id as number)).map((x) => x.id);
    return {
      ...t,
      [{ radarr: "movieIds", sonarr: "seriesIds", lidarr: "artistIds" }[o.app]]: has(o.items()),
      delayProfileIds: has(s.delayProfiles),
      releaseProfileIds: has(s.releaseProfiles),
      downloadClientIds: has(s.downloadClients),
      indexerIds: has(s.indexers),
      notificationIds: has(s.notifications),
      importListIds: has(s.importLists),
    };
  };
  /** A collection resource: list, one, create, change, delete. */
  const resource = (
    list: () => Json[],
    set: (l: Json[]) => void,
    p: string,
    base: string,
    method: string,
    body: Json,
  ) => {
    if (p === base) {
      if (method === "GET") return reply(200, list());
      if (method === "POST") {
        const made = { ...body, id: nextId() };
        set([...list(), made]);
        return reply(201, made);
      }
    }
    const one = new RegExp(`^${base}/(\\d+)$`).exec(p);
    if (one) {
      const id = Number(one[1]);
      const found = list().find((x) => x.id === id);
      // Real Radarr 6.4 answers a missing custom format with 500, not 404 (found on the test Radarr).
      if (!found)
        return reply(base === "/api/v3/customformat" ? 500 : 404, { message: "NotFound" });
      if (method === "GET") return reply(200, found);
      if (method === "PUT") {
        const next = { ...body, id };
        set(list().map((x) => (x.id === id ? next : x)));
        return reply(202, next);
      }
      if (method === "DELETE") {
        set(list().filter((x) => x.id !== id));
        return reply(200, {});
      }
    }
    return undefined;
  };
  const exclusions = o.app === "radarr" ? "/api/v3/exclusions" : "/api/v3/importlistexclusion";

  return (u: URL, p: string, method: string, body: Json) => {
    const s = o.state();
    if (p === "/api/v3/system/status")
      return reply(200, {
        appName: NAME[o.app],
        instanceName: NAME[o.app],
        version: VERSION[o.app],
        branch: o.app === "radarr" ? "master" : "main",
        osName: "ubuntu",
        isDocker: true,
        runtimeVersion: "8.0.27",
        startTime: iso(-3),
        databaseType: "sqLite",
        authentication: "forms",
        urlBase: "",
      });
    if (p === "/api/v3/health") return reply(200, s.health);
    if (p === "/api/v3/diskspace")
      return reply(200, [
        {
          path: o.root,
          label: { radarr: "Movies", sonarr: "TV", lidarr: "Music" }[o.app],
          freeSpace: 1.2e12,
          totalSpace: 8e12,
        },
      ]);
    if (p === "/api/v3/system/task") return reply(200, s.tasks);
    if (p === "/api/v3/system/backup") return reply(200, s.backups);
    if (p === "/api/v3/log")
      return reply(
        200,
        paged(
          [
            {
              id: 3,
              time: iso(-0.01),
              level: "info",
              logger: "RssSyncService",
              message: "RSS Sync Completed. Reports found: 12, Reports grabbed: 0",
            },
            {
              id: 2,
              time: iso(-0.5),
              level: "warn",
              logger: "DownloadClientCheck",
              message: "Stand-in: download client answered slowly",
            },
            {
              id: 1,
              time: iso(-1),
              level: "info",
              logger: "Bootstrap",
              message: `${NAME[o.app]} started`,
            },
          ],
          u,
        ),
      );

    // Commands: accepted and finished at once.
    if (p === "/api/v3/command" && method === "POST") {
      const cmd = {
        id: nextId(),
        name: body.name,
        body,
        status: "completed",
        queued: iso(0),
        ended: iso(0),
      };
      s.commands.push(cmd);
      o.onCommand?.(body);
      if (body.name === "Backup")
        s.backups = [
          {
            id: nextId(),
            name: `${o.app}_backup_manual_${s.backups.length + 1}.zip`,
            path: "/backup/manual",
            type: "manual",
            size: 1_950_000,
            time: iso(0),
          },
          ...s.backups,
        ];
      const task = s.tasks.find((t) => t.taskName === body.name);
      if (task) task.lastExecution = iso(0);
      return reply(201, cmd);
    }
    const cmdOne = /^\/api\/v3\/command\/(\d+)$/.exec(p);
    if (cmdOne) {
      const c = s.commands.find((x) => x.id === Number(cmdOne[1]));
      return c ? reply(200, c) : reply(404, { message: "NotFound" });
    }

    // Settings.
    if (p === "/api/v3/customformat/schema") return reply(200, FORMAT_SCHEMA);
    if (p === "/api/v3/qualitydefinition/limits") return reply(200, { min: 0, max: 2000 });
    if (p === `${exclusions}/paged`) {
      const size = Number(u.searchParams.get("pageSize") ?? 50);
      const pg = Number(u.searchParams.get("page") ?? 1);
      return reply(200, {
        page: pg,
        pageSize: size,
        totalRecords: s.exclusions.length,
        records: s.exclusions.slice((pg - 1) * size, pg * size),
      });
    }
    if (p === "/api/v3/config/naming") return reply(200, s.naming);
    if (p === "/api/v3/config/naming/1" && method === "PUT") {
      s.naming = { ...body, id: 1 };
      return reply(202, s.naming);
    }
    if (p === "/api/v3/config/mediamanagement") return reply(200, s.media);
    if (p === "/api/v3/config/mediamanagement/1" && method === "PUT") {
      s.media = { ...body, id: 1 };
      return reply(202, s.media);
    }
    if (p === "/api/v3/tag/detail") return reply(200, s.tags.map(tagDetail));
    if (
      p === "/api/v3/downloadclient/schema" ||
      p === "/api/v3/indexer/schema" ||
      p === "/api/v3/notification/schema" ||
      p === "/api/v3/importlist/schema"
    )
      return reply(200, []);

    const table: [string, () => Json[], (l: Json[]) => void][] = [
      ["/api/v3/qualityprofile", () => s.profiles, (l) => (s.profiles = l)],
      ["/api/v3/customformat", () => s.formats, (l) => (s.formats = l)],
      ["/api/v3/qualitydefinition", () => s.sizes, (l) => (s.sizes = l)],
      [exclusions, () => s.exclusions, (l) => (s.exclusions = l)],
      ["/api/v3/tag", () => s.tags, (l) => (s.tags = l)],
      ["/api/v3/delayprofile", () => s.delayProfiles, (l) => (s.delayProfiles = l)],
      ["/api/v3/releaseprofile", () => s.releaseProfiles, (l) => (s.releaseProfiles = l)],
      ["/api/v3/downloadclient", () => s.downloadClients, (l) => (s.downloadClients = l)],
      ["/api/v3/indexer", () => s.indexers, (l) => (s.indexers = l)],
      ["/api/v3/notification", () => s.notifications, (l) => (s.notifications = l)],
      ["/api/v3/importlist", () => s.importLists, (l) => (s.importLists = l)],
    ];
    for (const [base, get, set] of table) {
      const r = resource(get, set, p, base, method, body);
      if (r) return r;
    }
    return undefined;
  };
}
