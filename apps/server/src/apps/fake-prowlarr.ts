import type { Fetch } from "./http";

/**
 * A stand-in Prowlarr 2.6 (port 9696) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), shaped like the real test Prowlarr's answers (checklist 46.10g): a working usenet
 * indexer, a torrent indexer that fails its test (Cloudflare) and is paused, one switched off,
 * Radarr and Sonarr as apps, indexer definitions to add from, a manual search whose download links
 * carry a key (which Hearth must never pass on), grabs, history, sync profiles, proxies, download
 * clients, tags, tasks, backups and a log.
 */

export interface FakeProwlarr {
  fetch: Fetch;
  reset(): void;
}

type Json = Record<string, unknown>;
const VERSION = "2.6.5.5623";
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const field = (name: string, label: string, value: unknown, extra: Json = {}): Json => ({
  name,
  label,
  value,
  type: "textbox",
  privacy: "normal",
  advanced: false,
  ...extra,
});
const CATS = {
  categories: [
    { id: 2000, name: "Movies", subCategories: [] },
    { id: 5000, name: "TV", subCategories: [] },
  ],
};

const INDEXERS = (): Json[] => [
  {
    id: 1,
    name: "Usenet Prime",
    definitionName: "Newznab",
    implementation: "Newznab",
    description: "Newznab is an API search specification for Usenet",
    enable: true,
    protocol: "usenet",
    privacy: "private",
    priority: 25,
    appProfileId: 1,
    downloadClientId: 0,
    tags: [],
    indexerUrls: ["https://prime.example"],
    capabilities: CATS,
    supportsRss: true,
    supportsSearch: true,
    fields: [
      field("baseUrl", "URL", "https://prime.example"),
      field("apiPath", "API Path", "/api", { advanced: true }),
      field("apiKey", "API Key", "secret-indexer-key", { privacy: "apiKey" }),
    ],
  },
  {
    id: 2,
    name: "Torrent Alpha",
    definitionName: "torrentalpha",
    implementation: "Cardigann",
    description: "A public torrent site",
    enable: true,
    protocol: "torrent",
    privacy: "public",
    priority: 25,
    appProfileId: 1,
    downloadClientId: 0,
    tags: [5],
    indexerUrls: ["https://alpha.example"],
    capabilities: CATS,
    supportsRss: true,
    supportsSearch: true,
    fields: [field("baseUrl", "Base Url", "https://alpha.example", { type: "select" })],
  },
  {
    id: 3,
    name: "Old Tracker",
    definitionName: "oldtracker",
    implementation: "Cardigann",
    description: "A tracker that needs a login",
    enable: false,
    protocol: "torrent",
    privacy: "semiPrivate",
    priority: 30,
    appProfileId: 1,
    downloadClientId: 0,
    tags: [],
    indexerUrls: ["https://old.example"],
    capabilities: CATS,
    supportsRss: true,
    supportsSearch: true,
    fields: [
      field("username", "Username", "someone", { privacy: "userName" }),
      field("password", "Password", "hunter2", { type: "password", privacy: "password" }),
    ],
  },
];

/** A few of the definitions Prowlarr ships (the real one has hundreds). */
const SCHEMA: Json[] = [
  {
    name: "Generic Torznab",
    definitionName: "Torznab",
    implementation: "Torznab",
    description: "A Newznab-like api for torrents.",
    protocol: "torrent",
    privacy: "private",
    language: "en-US",
    fields: [
      field("baseUrl", "Url", ""),
      field("apiPath", "API Path", "/api", { advanced: true }),
      field("apiKey", "API Key", "", { privacy: "apiKey" }),
      field("torrentBaseSettings.seedRatio", "Seed Ratio", null, { type: "number" }),
    ],
  },
  {
    name: "Generic Newznab",
    definitionName: "Newznab",
    implementation: "Newznab",
    description: "Newznab is an API search specification for Usenet",
    protocol: "usenet",
    privacy: "private",
    language: "en-US",
    fields: [
      field("baseUrl", "URL", ""),
      field("apiPath", "API Path", "/api", { advanced: true }),
      field("apiKey", "API Key", "", { privacy: "apiKey" }),
    ],
  },
  {
    name: "Lantern Public",
    definitionName: "lanternpublic",
    implementation: "Cardigann",
    description: "A public general tracker for old films and series",
    protocol: "torrent",
    privacy: "public",
    language: "en-US",
    fields: [
      field("baseUrl", "Base Url", "https://lantern.example", {
        type: "select",
        selectOptions: [
          { value: "https://lantern.example", name: "https://lantern.example" },
          { value: "https://lantern.mirror", name: "https://lantern.mirror" },
        ],
      }),
      field("baseSettings.queryLimit", "Query Limit", null, { type: "number", advanced: true }),
    ],
  },
  {
    name: "Members Only",
    definitionName: "membersonly",
    implementation: "Cardigann",
    description: "A private tracker",
    protocol: "torrent",
    privacy: "private",
    language: "en-US",
    fields: [
      field("username", "Username", "", { privacy: "userName" }),
      field("password", "Password", "", { type: "password", privacy: "password" }),
    ],
  },
];

const RESULTS: Json[] = [
  ["Lantern.Season.2024.1080p.WEB-DL.x264-GRP", 2, 2000, 4.2, 120],
  ["Lantern.Season.2024.2160p.WEB-DL.x265-GRP", 2, 2000, 14.8, 64],
  ["Lantern.Season.2024.1080p.WEB.h264-OTHER", 1, 2000, 3.9, undefined],
  ["Night.Harbor.S02E07.1080p.WEB.h264-GRP", 2, 5000, 1.4, 33],
].map(([title, indexerId, cat, gb, seeders], i) => ({
  guid: `stand-in-${i + 1}`,
  indexerId,
  indexer: indexerId === 1 ? "Usenet Prime" : "Torrent Alpha",
  title,
  size: Math.round(Number(gb) * 1024 ** 3),
  age: 3 + i,
  ageHours: (3 + i) * 24,
  publishDate: iso((3 + i) * 24 * HOUR),
  seeders,
  leechers: seeders ? 4 : undefined,
  grabs: 10 + i,
  protocol: indexerId === 1 ? "usenet" : "torrent",
  categories: [{ id: cat, name: cat === 2000 ? "Movies" : "TV", subCategories: [] }],
  // The real Prowlarr puts its own API key in these links; Hearth must never pass them on.
  downloadUrl: `http://prowlarr.local:9696/${String(indexerId)}/download?apikey=e2e-stand-in-prowlarr-key&link=abc`,
  magnetUrl: undefined,
  infoUrl: `https://alpha.example/details/${i + 1}?passkey=stand-in-passkey`,
  indexerFlags: [],
}));

const APPS = (): Json[] =>
  ["Radarr", "Sonarr"].map((name, i) => ({
    id: i + 1,
    name,
    implementation: name,
    implementationName: name,
    configContract: `${name}Settings`,
    syncLevel: "fullSync",
    enable: true,
    tags: [],
    fields: [
      field("prowlarrUrl", "Prowlarr Server", "http://prowlarr:9696"),
      field(
        "baseUrl",
        `${name} Server`,
        name === "Radarr" ? "http://radarr:7878" : "http://sonarr:8989",
      ),
      field("apiKey", "API Key", "********", { privacy: "apiKey" }),
    ],
  }));

const STATE = () => ({
  indexers: INDEXERS(),
  apps: APPS(),
  profiles: [
    {
      id: 1,
      name: "Standard",
      enableRss: true,
      enableAutomaticSearch: true,
      enableInteractiveSearch: true,
      minimumSeeders: 1,
    },
  ] as Json[],
  proxies: [
    {
      id: 1,
      name: "FlareSolverr",
      implementation: "FlareSolverr",
      implementationName: "FlareSolverr",
      configContract: "FlareSolverrSettings",
      tags: [5],
      fields: [
        field("host", "Host", "http://flaresolverr:8191/"),
        field("requestTimeout", "Request Timeout", 60, { type: "number" }),
      ],
    },
  ] as Json[],
  clients: [
    {
      id: 1,
      name: "Stand-in qBittorrent",
      implementation: "QBittorrent",
      implementationName: "qBittorrent",
      configContract: "QBittorrentSettings",
      protocol: "torrent",
      enable: true,
      priority: 1,
      tags: [],
      fields: [
        field("host", "Host", "qbittorrent"),
        field("port", "Port", 8080, { type: "number" }),
        field("username", "Username", "admin", { privacy: "userName" }),
        field("password", "Password", "stand-in-secret", { type: "password", privacy: "password" }),
      ],
    },
  ] as Json[],
  notifications: [] as Json[],
  tags: [{ id: 5, label: "flaresolverr" }] as Json[],
  history: [
    { indexerId: 1, eventType: "indexerQuery", query: "lantern season", source: "Radarr", h: 2 },
    { indexerId: 2, eventType: "indexerQuery", query: "lantern season", source: "Radarr", h: 2 },
    { indexerId: 2, eventType: "indexerRss", query: "", source: "Sonarr", h: 3, ok: false },
    {
      indexerId: 1,
      eventType: "releaseGrabbed",
      title: "Copper.Sky.2025.1080p.WEB-DL-GROUP",
      source: "Radarr",
      h: 5,
    },
  ].map((h, i) => ({
    id: i + 1,
    indexerId: h.indexerId,
    date: iso(h.h * HOUR),
    successful: h.ok !== false,
    eventType: h.eventType,
    data: {
      query: h.query ?? "",
      grabTitle: h.title,
      source: h.source,
      host: h.source.toLowerCase(),
      queryResults: "12",
      elapsedTime: "310",
      url: "https://prime.example/api?t=search&apikey=secret-indexer-key",
    },
  })) as Json[],
  backups: [
    {
      id: 1,
      name: "prowlarr_backup_v2.6.5.5623_2026.10.25.zip",
      type: "scheduled",
      size: 412_000,
      time: iso(7 * 24 * HOUR),
    },
  ] as Json[],
  nextId: 100,
  synced: false,
});

const EVENT_NUMBER: Record<string, number> = {
  releaseGrabbed: 1,
  indexerQuery: 2,
  indexerRss: 3,
  indexerAuth: 4,
  indexerInfo: 5,
};
const TASKS = [
  ["Application Indexer Sync", "ApplicationIndexerSync", 360],
  ["Backup", "Backup", 10080],
  ["Check Health", "CheckHealth", 360],
  ["Clean Up History", "CleanUpHistory", 1440],
  ["Housekeeping", "Housekeeping", 1440],
  ["Indexer Definition Update", "IndexerDefinitionUpdate", 1440],
].map(([name, taskName, interval], i) => ({
  id: i + 1,
  name,
  taskName,
  interval,
  lastExecution: iso(2 * HOUR),
  nextExecution: new Date(Date.now() + 4 * HOUR).toISOString(),
  lastDuration: "00:00:01.2",
}));

export function fakeProwlarr(): FakeProwlarr {
  let s = STATE();
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const cloudflare = [{ propertyName: "", errorMessage: "Blocked by CloudFlare Protection" }];
  const collections: Record<string, [() => Json[], (l: Json[]) => void]> = {
    "/api/v1/indexer": [() => s.indexers, (l) => (s.indexers = l)],
    "/api/v1/applications": [() => s.apps, (l) => (s.apps = l)],
    "/api/v1/appprofile": [() => s.profiles, (l) => (s.profiles = l)],
    "/api/v1/indexerproxy": [() => s.proxies, (l) => (s.proxies = l)],
    "/api/v1/downloadclient": [() => s.clients, (l) => (s.clients = l)],
    "/api/v1/notification": [() => s.notifications, (l) => (s.notifications = l)],
    "/api/v1/tag": [() => s.tags, (l) => (s.tags = l)],
  };
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    // Prowlarr's own paths are case-insensitive (the old panel reads /indexerProxy).
    const p = u.pathname.replace(/\/+$/, "").toLowerCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (!headers["X-Api-Key"]?.startsWith("e2e-")) return reply(401, {});
    const body = init.body ? (JSON.parse(String(init.body)) as Json) : {};

    if (p === "/api/v1/system/status")
      return reply(200, {
        version: VERSION,
        branch: "master",
        osName: "ubuntu",
        isDocker: true,
        runtimeVersion: "8.0.27",
        startTime: iso(30 * HOUR),
        databaseType: "sqLite",
      });
    if (p === "/api/v1/health") return reply(200, []);
    if (p === "/api/v1/system/task") return reply(200, TASKS);
    if (p === "/api/v1/system/backup") return reply(200, s.backups);
    if (p === "/api/v1/log")
      return reply(200, {
        page: 1,
        pageSize: 50,
        totalRecords: 2,
        records: [
          {
            id: 2,
            time: iso(HOUR),
            level: "info",
            logger: "IndexerFactory",
            message: "Searching Torrent Alpha for lantern season",
          },
          {
            id: 1,
            time: iso(2 * HOUR),
            level: "warn",
            logger: "Torznab",
            message:
              "Request to https://alpha.example/api?t=caps&apikey=e2e-stand-in-prowlarr-key failed",
          },
        ],
      });
    if (p === "/api/v1/indexer/schema") return reply(200, SCHEMA);
    if (p === "/api/v1/applications/schema")
      return reply(
        200,
        ["Lidarr", "Radarr", "Readarr", "Sonarr", "Whisparr"].map((implementation) => ({
          implementation,
        })),
      );
    if (p === "/api/v1/tag/detail")
      return reply(
        200,
        s.tags.map((t) => ({
          ...t,
          indexerIds: s.indexers
            .filter((i) => (i.tags as number[]).includes(t.id as number))
            .map((i) => i.id),
          applicationIds: s.apps
            .filter((a) => (a.tags as number[]).includes(t.id as number))
            .map((a) => a.id),
          indexerProxyIds: s.proxies
            .filter((x) => (x.tags as number[]).includes(t.id as number))
            .map((x) => x.id),
          notificationIds: [],
          downloadClientIds: [],
        })),
      );
    if (p === "/api/v1/indexer/test" && method === "POST")
      return body.id === 2 ? reply(400, cloudflare) : reply(200, {});
    if (p === "/api/v1/indexer/testall" && method === "POST")
      return reply(
        200,
        s.indexers
          .filter((i) => i.enable)
          .map((i) => ({
            id: i.id,
            isValid: i.id !== 2,
            validationFailures: i.id === 2 ? cloudflare : [],
          })),
      );
    if (p === "/api/v1/indexerstatus")
      return reply(
        200,
        s.indexers.find((i) => i.id === 2)?.enable
          ? [
              {
                indexerId: 2,
                disabledTill: new Date(Date.now() + 2 * HOUR).toISOString(),
                mostRecentFailure: new Date(Date.now() - HOUR).toISOString(),
              },
            ]
          : [],
      );
    if (p === "/api/v1/indexerstats")
      return reply(200, {
        indexers: [
          { indexerId: 1, averageResponseTime: 310, numberOfQueries: 292, numberOfGrabs: 33 },
          {
            indexerId: 2,
            averageResponseTime: 2400,
            numberOfQueries: 120,
            numberOfGrabs: 4,
            numberOfFailedQueries: 31,
          },
        ],
      });
    if (p === "/api/v1/search" && method === "GET") {
      const words = (u.searchParams.get("query") ?? "")
        .toLowerCase()
        .split(/[\s.]+/)
        .filter(Boolean);
      const ids = u.searchParams.getAll("indexerIds").map(Number);
      return reply(
        200,
        RESULTS.filter(
          (r) =>
            words.every((w) => String(r.title).toLowerCase().includes(w)) &&
            (ids.length === 0 || ids.includes(r.indexerId as number)),
        ),
      );
    }
    if (p === "/api/v1/search" && method === "POST") {
      const r = RESULTS.find((x) => x.guid === body.guid && x.indexerId === body.indexerId);
      if (!r)
        return reply(404, {
          message: "Couldn't find requested release in cache, cache timeout probably expired.",
        });
      s.history.unshift({
        id: s.nextId++,
        indexerId: r.indexerId,
        date: new Date().toISOString(),
        successful: true,
        eventType: "releaseGrabbed",
        data: { grabTitle: r.title, source: "Prowlarr", host: "hearth" },
      });
      return reply(200, r);
    }
    if (p === "/api/v1/history") {
      const ev = Number(u.searchParams.get("eventType") ?? 0);
      const ids = u.searchParams.getAll("indexerIds").map(Number);
      const rows = s.history.filter(
        (h) =>
          (!ev || EVENT_NUMBER[String(h.eventType)] === ev) &&
          (ids.length === 0 || ids.includes(h.indexerId as number)),
      );
      return reply(200, {
        page: 1,
        pageSize: 50,
        totalRecords: rows.length,
        records: rows.slice(0, 50),
      });
    }
    if (p === "/api/v1/command" && method === "POST") {
      if (body.name === "ApplicationIndexerSync") {
        s.synced = true;
        return reply(201, { id: 77, name: body.name, status: "queued" });
      }
      if (body.name === "Backup")
        s.backups.unshift({
          id: s.nextId++,
          name: "prowlarr_backup_manual.zip",
          type: "manual",
          size: 415_000,
          time: new Date().toISOString(),
        });
      return reply(201, { id: 78, name: body.name, status: "completed" });
    }
    if (p === "/api/v1/command/77")
      return reply(200, { id: 77, status: s.synced ? "completed" : "queued" });
    if (p === "/api/v1/command/78") return reply(200, { id: 78, status: "completed" });

    // Collections: list, add, read one, change, remove.
    for (const [base, [all, set]] of Object.entries(collections)) {
      if (p === base && method === "GET") return reply(200, all());
      if (p === base && method === "POST") {
        const made: Json = { ...body, id: s.nextId++ };
        if (base === "/api/v1/indexer") {
          // Prowlarr tests a new indexer on save: a Torznab or Newznab without a URL fails.
          const urlField = (made.fields as Json[] | undefined)?.find((f) => f.name === "baseUrl");
          if (urlField && !urlField.value)
            return reply(400, [{ propertyName: "BaseUrl", errorMessage: "Url is required" }]);
          if (
            (made.fields as Json[] | undefined)?.some((f) => f.privacy === "password" && !f.value)
          )
            return reply(400, [{ errorMessage: "Unable to connect to indexer, check the login" }]);
        }
        set([...all(), made]);
        return reply(201, made);
      }
      const one = new RegExp(`^${base}/(\\d+)$`).exec(p);
      if (one) {
        const id = Number(one[1]);
        const item = all().find((x) => x.id === id);
        if (!item) return reply(404, {});
        if (method === "DELETE") {
          set(all().filter((x) => x.id !== id));
          return reply(200, {});
        }
        if (method === "PUT") {
          // Prowlarr refuses a save that lost the settings; the panel must send them back.
          if (item.fields && !("fields" in body))
            return reply(400, [{ errorMessage: "Fields missing" }]);
          const next: Json = { ...item, ...body, id };
          // A private value sent back as Prowlarr's own placeholder keeps the stored one.
          next.fields = (
            (body.fields as Json[] | undefined) ?? (item.fields as Json[] | undefined)
          )?.map((f) => {
            const old = (item.fields as Json[] | undefined)?.find((o) => o.name === f.name);
            return f.value === "********" && old ? { ...f, value: old.value } : f;
          });
          if (!item.fields && !body.fields) delete next.fields;
          set(all().map((x) => (x.id === id ? next : x)));
          return reply(202, next);
        }
        return reply(200, item);
      }
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      s = STATE();
    },
  };
}
