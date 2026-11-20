import { SUPPORTED_MAJORS } from "@dragon-control/core";
import { maskSecrets } from "./app-api";

/**
 * What Radarr's and Sonarr's native panels share (native panels Phase 3: "shared components
 * reused, no copied Radarr code"). Both apps are the same Servarr engine, so quality profiles,
 * custom formats, quality sizes, tags with delay and release profiles, naming and media
 * management, connections, system, logs and history read the same way. The app-specific parts
 * (Radarr's movies, Sonarr's series and episodes) live in radarr-panel.ts and sonarr-panel.ts.
 *
 * Reading changes nothing; every change is a plan step (arr-resource-operations.ts), the same one
 * Ember plans. Secrets never leave the server: answers are masked (maskSecrets) and connection
 * fields marked private come back only as "set" or "not set".
 */

export type ServarrApp = "radarr" | "sonarr" | "prowlarr" | "lidarr";
/** Each app's API base: Prowlarr is on v1, Radarr and Sonarr on v3. */
export const apiOf = (app: ServarrApp) =>
  app === "prowlarr" || app === "lidarr" ? "/api/v1" : "/api/v3";
export type ServarrGet = (path: string) => Promise<{ ok: boolean; status: number; data: unknown }>;

/** The views both apps answer, read by the functions in this file. */
export const SHARED_VIEWS = [
  "history",
  "blocklist",
  "profiles",
  "formats",
  "tags",
  "media",
  "connections",
  "system",
  "logs",
  "sizes",
  "exclusions",
] as const;
export type SharedView = (typeof SHARED_VIEWS)[number];

export class ServarrReadError extends Error {}

/**
 * Text an app wrote (a log line) without anything key-shaped: "apikey=..." style parameters, an
 * X-Api-Key header, and 32-character hex strings (Servarr API keys). Apps' logs can carry their
 * own key or another app's in a URL; it never leaves the server.
 */
export function scrubText(text: string): string {
  return text
    .replace(/((?:api_?key|passkey|token|auth|password)\s*[=:]\s*)[^\s&"',;]+/gi, "$1[hidden]")
    .replace(/\b[a-f0-9]{32}\b/gi, "[hidden]");
}

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
export const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
export const str = (v: unknown) => (typeof v === "string" ? v : undefined);
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const nums = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
export const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const NAME: Record<ServarrApp, string> = {
  radarr: "Radarr",
  sonarr: "Sonarr",
  prowlarr: "Prowlarr",
  lidarr: "Lidarr",
};
/** Where each app keeps its library, and its import list exclusions. */
const LIBRARY: Record<ServarrApp, string> = {
  radarr: "/api/v3/movie",
  sonarr: "/api/v3/series",
  prowlarr: "/api/v1/indexer",
  lidarr: "/api/v1/artist",
};
/** The connection lists each app has, in the order the Connections page shows them. */
const CONNECTION_KINDS: Record<ServarrApp, readonly (readonly [string, string])[]> = {
  radarr: [
    ["downloadclient", "Download clients"],
    ["indexer", "Indexers"],
    ["notification", "Connections"],
    ["importlist", "Import lists"],
  ],
  sonarr: [
    ["downloadclient", "Download clients"],
    ["indexer", "Indexers"],
    ["notification", "Connections"],
    ["importlist", "Import lists"],
  ],
  prowlarr: [
    ["downloadclient", "Download clients"],
    ["indexerproxy", "Indexer proxies"],
    ["notification", "Connections"],
  ],
  lidarr: [
    ["downloadclient", "Download clients"],
    ["indexer", "Indexers"],
    ["notification", "Connections"],
    ["importlist", "Import lists"],
  ],
};

/** A poster as a TMDB or TVDB file name, which Hearth's poster route serves. */
export function posterOf(m: Json): string | undefined {
  for (const img of list(m.images)) {
    if (img.coverType !== "poster") continue;
    const url = str(img.remoteUrl) ?? str(img.url) ?? "";
    const file = /\/([\w-]+\.(?:jpg|jpeg|png|webp))(?:\?.*)?$/i.exec(url)?.[1];
    if (file && /image\.tmdb\.org/.test(url)) return `/${file}`;
  }
  return undefined;
}

export function qualityOf(file: Json | undefined) {
  const q = obj(obj(file?.quality).quality);
  return { name: str(q.name), resolution: num(q.resolution), id: num(q.id) };
}

/** "S01E02" for an episode, or undefined. */
export function episodeCode(e: Json): string | undefined {
  const s = num(e.seasonNumber);
  const n = num(e.episodeNumber);
  if (s === undefined || n === undefined) return undefined;
  return `S${String(s).padStart(2, "0")}E${String(n).padStart(2, "0")}`;
}

/** One history event: the movie or series it is about, and for Sonarr the episode. */
export function historyRow(h: Json) {
  const data = obj(h.data);
  const item = h.movie ? obj(h.movie) : h.series ? obj(h.series) : obj(h.artist);
  const ep = obj(h.episode);
  const album = obj(h.album);
  return {
    id: num(h.id)!,
    itemId: num(h.movieId) ?? num(h.seriesId) ?? num(h.artistId),
    item: str(item.title) ?? str(item.artistName),
    year: num(item.year),
    // Sonarr's episode, or Lidarr's album, as the line under the title.
    episode: episodeCode(ep)
      ? `${episodeCode(ep)}${str(ep.title) ? ` ${str(ep.title)}` : ""}`
      : str(album.title),
    event: str(h.eventType) ?? "unknown",
    release: str(h.sourceTitle),
    quality: qualityOf(h).name,
    formats: list(h.customFormats).map((f) => str(f.name) ?? ""),
    score: num(h.customFormatScore),
    date: str(h.date),
    indexer: str(data.indexer),
    client: str(data.downloadClient) ?? str(data.downloadClientName),
    message: str(data.message) ?? str(data.reason),
  };
}

function profileShape(p: Json) {
  const items = list(p.items).map((i) => {
    const q = obj(i.quality);
    return {
      id: num(q.id) ?? num(i.id)!,
      name: str(q.name) ?? str(i.name) ?? "?",
      allowed: i.allowed === true,
      group:
        list(i.items).length > 0
          ? list(i.items).map((x) => str(obj(x.quality).name) ?? "")
          : undefined,
    };
  });
  return {
    id: num(p.id)!,
    name: str(p.name) ?? "?",
    upgradeAllowed: p.upgradeAllowed === true,
    cutoff: num(p.cutoff),
    cutoffName: items.find((i) => i.id === num(p.cutoff))?.name,
    items,
    minFormatScore: num(p.minFormatScore) ?? 0,
    cutoffFormatScore: num(p.cutoffFormatScore) ?? 0,
    minUpgradeFormatScore: num(p.minUpgradeFormatScore) ?? 0,
    formatItems: list(p.formatItems).map((f) => ({
      format: num(f.format)!,
      name: str(f.name) ?? "?",
      score: num(f.score) ?? 0,
    })),
    language: str(obj(p.language).name),
  };
}

function formatShape(f: Json) {
  return {
    id: num(f.id)!,
    name: str(f.name) ?? "?",
    includeWhenRenaming: f.includeCustomFormatWhenRenaming === true,
    conditions: list(f.specifications).map((s) => ({
      name: str(s.name) ?? "",
      type: str(s.implementation) ?? "",
      typeName: str(s.implementationName) ?? str(s.implementation) ?? "",
      negate: s.negate === true,
      required: s.required === true,
      value: list(s.fields).find((x) => x.name === "value")?.value as unknown,
    })),
  };
}

/** A connection's field, with private values reduced to whether they are set. */
export function fieldShape(f: Json) {
  const secret = typeof f.privacy === "string" && f.privacy !== "normal";
  const isPassword = f.type === "password";
  const hidden = secret || isPassword;
  return {
    name: str(f.name) ?? "",
    label: str(f.label) ?? str(f.name) ?? "",
    type: str(f.type) ?? "textbox",
    secret: hidden,
    ...(hidden
      ? { set: f.value !== undefined && f.value !== null && f.value !== "" }
      : { value: maskSecrets(f.value) }),
    ...(str(f.helpText) ? { help: str(f.helpText) } : {}),
  };
}

export function connectionShape(c: Json, kind: string) {
  return {
    kind,
    id: num(c.id)!,
    name: str(c.name) ?? "?",
    implementation: str(c.implementationName) ?? str(c.implementation) ?? "",
    enabled:
      c.enable === true ||
      c.enableRss === true ||
      c.enableAutomaticSearch === true ||
      c.enableInteractiveSearch === true ||
      c.enableAuto === true ||
      c.onGrab === true ||
      c.onDownload === true,
    protocol: str(c.protocol),
    priority: num(c.priority),
    tags: nums(c.tags),
    /** Its own on/off settings (enable, RSS, on grab...), as the app names them. */
    switches: Object.fromEntries(
      Object.entries(c).filter(
        ([k, v]) => typeof v === "boolean" && !/^(supports|is[A-Z]|has[A-Z])/.test(k),
      ),
    ) as Record<string, boolean>,
    fields: list(c.fields).map(fieldShape),
  };
}

export const PAGE_SIZE = 50;
export const page = (q: Record<string, string | undefined>) =>
  Math.max(1, Math.min(10_000, Number(q.page ?? 1) || 1));

export function needer(app: ServarrApp, get: ServarrGet) {
  return async (path: string, what: string): Promise<unknown> => {
    const r = await get(path);
    if (!r.ok) throw new ServarrReadError(`${NAME[app]} did not give ${what} (${r.status}).`);
    return r.data;
  };
}

/** The version the app reports and whether Hearth's panel is built for it (D8). */
export function versionInfo(status: Json, app: ServarrApp = "radarr") {
  const version = str(status.version) ?? "unknown";
  const major = Number(version.split(".")[0]);
  const supported = (SUPPORTED_MAJORS[app] ?? []).includes(major);
  return { version, supported };
}

/** Quality profiles and tags, by id and name, for the pickers every tab has. */
export async function lookupsOf(app: ServarrApp, get: ServarrGet) {
  const need = needer(app, get);
  const [profiles, tags] = await Promise.all([
    need(`${apiOf(app)}/qualityprofile`, "its quality profiles"),
    need(`${apiOf(app)}/tag`, "its tags"),
  ]);
  return {
    profiles: list(profiles).map((p) => ({ id: num(p.id)!, name: str(p.name) ?? "?" })),
    tags: list(tags).map((t) => ({ id: num(t.id)!, label: str(t.label) ?? "?" })),
  };
}

/**
 * One shared view. `status` is the app's /system/status (already read for the version check).
 */
export async function readSharedView(
  app: ServarrApp,
  get: ServarrGet,
  view: SharedView,
  q: Record<string, string | undefined>,
  status: Json,
): Promise<Json> {
  const need = needer(app, get);
  const meta = versionInfo(status, app);
  const paged = (data: Json) => ({
    page: num(data.page) ?? 1,
    pageSize: PAGE_SIZE,
    total: num(data.totalRecords) ?? 0,
  });

  switch (view) {
    case "history": {
      const event = q.event && /^\d$/.test(q.event) ? `&eventType=${q.event}` : "";
      const include =
        app === "radarr"
          ? "&includeMovie=true"
          : app === "lidarr"
            ? "&includeArtist=true&includeAlbum=true"
            : "&includeSeries=true&includeEpisode=true";
      const data = obj(
        await need(
          `${apiOf(app)}/history?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=date&sortDirection=descending${include}${event}`,
          "its history",
        ),
      );
      return { meta, ...paged(data), records: list(data.records).map(historyRow) };
    }
    case "blocklist": {
      const data = obj(
        await need(
          `${apiOf(app)}/blocklist?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=date&sortDirection=descending`,
          "its blocklist",
        ),
      );
      return {
        meta,
        ...paged(data),
        records: list(data.records).map((b) => ({
          id: num(b.id)!,
          itemId: num(b.movieId) ?? num(b.seriesId) ?? num(b.artistId),
          item:
            str(obj(b.movie).title) ?? str(obj(b.series).title) ?? str(obj(b.artist).artistName),
          release: str(b.sourceTitle),
          quality: qualityOf(b).name,
          date: str(b.date),
          protocol: str(b.protocol),
          indexer: str(b.indexer),
          message: str(b.message),
        })),
      };
    }
    case "profiles": {
      const [profiles, formats, items] = await Promise.all([
        need(`${apiOf(app)}/qualityprofile`, "its quality profiles"),
        need(`${apiOf(app)}/customformat`, "its custom formats"),
        need(LIBRARY[app], "its library"),
      ]);
      const used = new Map<number, number>();
      for (const m of list(items)) {
        const id = num(m.qualityProfileId);
        if (id !== undefined) used.set(id, (used.get(id) ?? 0) + 1);
      }
      return {
        meta,
        profiles: list(profiles).map((p) => ({
          ...profileShape(p),
          used: used.get(num(p.id) ?? -1) ?? 0,
        })),
        formats: list(formats).map((f) => ({ id: num(f.id)!, name: str(f.name) ?? "?" })),
      };
    }
    case "formats": {
      const [formats, schema, profiles] = await Promise.all([
        need(`${apiOf(app)}/customformat`, "its custom formats"),
        need(`${apiOf(app)}/customformat/schema`, "its custom format conditions"),
        need(`${apiOf(app)}/qualityprofile`, "its quality profiles"),
      ]);
      return {
        meta,
        formats: list(formats).map(formatShape),
        conditionTypes: list(schema).map((s) => ({
          type: str(s.implementation) ?? "",
          name: str(s.implementationName) ?? str(s.implementation) ?? "",
        })),
        scores: list(profiles).map((p) => ({
          profile: str(p.name) ?? "?",
          profileId: num(p.id)!,
          scores: list(p.formatItems).map((f) => ({
            format: num(f.format)!,
            score: num(f.score) ?? 0,
          })),
        })),
      };
    }
    case "tags": {
      const [tags, delay, release] = await Promise.all([
        need(`${apiOf(app)}/tag/detail`, "its tags"),
        need(`${apiOf(app)}/delayprofile`, "its delay profiles"),
        need(`${apiOf(app)}/releaseprofile`, "its release profiles"),
      ]);
      const n = (v: unknown) => list(v).length;
      return {
        meta,
        tags: list(tags).map((t) => ({
          id: num(t.id)!,
          label: str(t.label) ?? "?",
          used: n(t.movieIds) + n(t.seriesIds),
          other:
            n(t.delayProfileIds) +
            n(t.releaseProfileIds) +
            n(t.downloadClientIds) +
            n(t.indexerIds) +
            n(t.notificationIds) +
            n(t.importListIds) +
            n(t.autoTagIds),
        })),
        delayProfiles: list(delay).map((d) => ({
          id: num(d.id)!,
          preferredProtocol: str(d.preferredProtocol),
          usenet: d.enableUsenet === true,
          torrent: d.enableTorrent === true,
          usenetDelay: num(d.usenetDelay) ?? 0,
          torrentDelay: num(d.torrentDelay) ?? 0,
          bypassIfHighestQuality: d.bypassIfHighestQuality === true,
          tags: nums(d.tags),
          isDefault: num(d.id) === 1,
        })),
        releaseProfiles: list(release).map((r) => ({
          id: num(r.id)!,
          name: str(r.name) ?? "",
          enabled: r.enabled !== false,
          required: strs(r.required),
          ignored: strs(r.ignored),
          tags: nums(r.tags),
        })),
      };
    }
    case "media": {
      const [naming, media, roots] = await Promise.all([
        need(`${apiOf(app)}/config/naming`, "its naming settings"),
        need(`${apiOf(app)}/config/mediamanagement`, "its media management settings"),
        need(`${apiOf(app)}/rootfolder`, "its root folders"),
      ]);
      return {
        meta,
        naming: maskSecrets(naming) as Json,
        media: maskSecrets(media) as Json,
        rootFolders: list(roots).map((r) => ({
          id: num(r.id)!,
          path: str(r.path) ?? "",
          accessible: r.accessible !== false,
          freeSpace: num(r.freeSpace),
          unmapped: list(r.unmappedFolders).length,
        })),
      };
    }
    case "connections": {
      const kinds = CONNECTION_KINDS[app];
      const lists = await Promise.all(kinds.map(([k]) => get(`${apiOf(app)}/${k}`)));
      return {
        meta,
        groups: kinds.map(([kind, label], i) => ({
          kind,
          label,
          readable: lists[i]!.ok,
          items: lists[i]!.ok ? list(lists[i]!.data).map((c) => connectionShape(c, kind)) : [],
        })),
      };
    }
    case "system": {
      const [health, tasks, backups, disks] = await Promise.all([
        need(`${apiOf(app)}/health`, "its health"),
        need(`${apiOf(app)}/system/task`, "its scheduled tasks"),
        get(`${apiOf(app)}/system/backup`),
        app === "prowlarr"
          ? Promise.resolve({ ok: false, status: 404, data: [] })
          : get(`${apiOf(app)}/diskspace`),
      ]);
      return {
        meta,
        status: {
          version: meta.version,
          branch: str(status.branch),
          os: str(status.osName),
          docker: status.isDocker === true,
          runtime: str(status.runtimeVersion),
          started: str(status.startTime),
          database: str(status.databaseType),
        },
        health: list(health).map((h) => ({
          source: str(h.source) ?? "",
          type: str(h.type) ?? "notice",
          message: str(h.message) ?? "",
          wiki: str(h.wikiUrl),
        })),
        tasks: list(tasks).map((t) => ({
          id: num(t.id)!,
          name: str(t.name) ?? str(t.taskName) ?? "?",
          command: str(t.taskName) ?? "",
          interval: num(t.interval) ?? 0,
          last: str(t.lastExecution),
          next: str(t.nextExecution),
          duration: str(t.lastDuration),
        })),
        backups: backups.ok
          ? list(backups.data).map((b) => ({
              id: num(b.id)!,
              name: str(b.name) ?? "",
              type: str(b.type),
              size: num(b.size),
              time: str(b.time),
            }))
          : [],
        disks: disks.ok
          ? list(disks.data).map((d) => ({
              path: str(d.path) ?? "",
              label: str(d.label),
              free: num(d.freeSpace),
              total: num(d.totalSpace),
            }))
          : [],
      };
    }
    case "logs": {
      const data = obj(
        await need(
          `${apiOf(app)}/log?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=time&sortDirection=descending${q.level && /^(info|warn|error)$/.test(q.level) ? `&level=${q.level}` : ""}`,
          "its log",
        ),
      );
      return {
        meta,
        ...paged(data),
        records: list(maskSecrets(data.records)).map((l) => ({
          id: num(l.id)!,
          time: str(l.time),
          level: str(l.level) ?? "info",
          logger: str(l.logger),
          message: scrubText(str(l.message) ?? ""),
        })),
      };
    }
    case "sizes": {
      const [defs, limits] = await Promise.all([
        need(`${apiOf(app)}/qualitydefinition`, "its quality sizes"),
        get(`${apiOf(app)}/qualitydefinition/limits`).then((r) => (r.ok ? r.data : {})),
      ]);
      return {
        meta,
        limits: { min: num(obj(limits).min) ?? 0, max: num(obj(limits).max) ?? 2000 },
        sizes: list(defs)
          .map((d) => ({
            id: num(d.id)!,
            name: str(obj(d.quality).name) ?? str(d.title) ?? "?",
            title: str(d.title) ?? str(obj(d.quality).name) ?? "?",
            weight: num(d.weight) ?? 0,
            minSize: num(d.minSize) ?? 0,
            maxSize: num(d.maxSize) ?? null,
            preferredSize: num(d.preferredSize) ?? null,
          }))
          .sort((a, b) => a.weight - b.weight),
      };
    }
    case "exclusions": {
      // Radarr keeps them at /exclusions (by TMDB id), Sonarr at /importlistexclusion (by TVDB id).
      // Lidarr keeps them at /importlistexclusion by MusicBrainz id, with no paged list.
      const path =
        app === "radarr"
          ? `${apiOf(app)}/exclusions/paged?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=movieTitle&sortDirection=ascending`
          : app === "lidarr"
            ? `${apiOf(app)}/importlistexclusion`
            : `${apiOf(app)}/importlistexclusion/paged?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=title&sortDirection=ascending`;
      const raw = await need(path, "its import list exclusions");
      // Lidarr answers with the whole list: page it here.
      const data = Array.isArray(raw)
        ? {
            page: page(q),
            totalRecords: raw.length,
            records: raw.slice((page(q) - 1) * PAGE_SIZE, page(q) * PAGE_SIZE),
          }
        : obj(raw);
      return {
        meta,
        ...paged(data),
        records: list(data.records).map((e) => ({
          id: num(e.id)!,
          key: num(e.tmdbId) ?? num(e.tvdbId) ?? str(e.foreignId),
          title: str(e.movieTitle) ?? str(e.artistName) ?? str(e.title) ?? "?",
          year: num(e.movieYear) || undefined,
        })),
      };
    }
  }
}
