import { bodyText, type Fetch } from "./http";
import { magnetHash } from "./qbittorrent-control";
import { readTorrentFile } from "./torrent-file";

/**
 * A stand-in qBittorrent 5.2 (port 8090, since the SABnzbd stand-in has 8080) for tests and safe
 * previews (DC_FAKE_APPS=1, never in a real install): sign-in with a session cookie, the settings
 * Hearth may change (read and set, as qBittorrent's Web API answers them on the disposable test
 * instance), categories, tags, the transfer state, and three torrents with their files, trackers
 * and peers. Adding (links or uploaded .torrent files), start and stop, recheck, categories, tags,
 * file priorities and removing behave as qBittorrent's Web API does, including automatic torrent
 * management moving a torrent's folder when its category changes.
 */

const PASSWORD_PREFIX = "e2e-";
const SID = "QBT_SID_8090=e2e-session";

export interface FakeQbittorrent {
  fetch: Fetch;
  reset(): void;
  /** The settings now, for tests. */
  preferences(): Record<string, unknown>;
  /** The torrents now, for tests. */
  torrents(): Tor[];
  /** Two finished torrents added by hand (no category): a film and something unclear. */
  addManual(): void;
}

const INITIAL: Record<string, unknown> = {
  max_ratio_enabled: false,
  max_ratio: 1,
  max_seeding_time_enabled: false,
  max_seeding_time: 1440,
  max_inactive_seeding_time_enabled: false,
  max_inactive_seeding_time: 1440,
  max_ratio_act: 0,
  dl_limit: 0,
  up_limit: 0,
  alt_dl_limit: 10240,
  alt_up_limit: 10240,
  scheduler_enabled: false,
  schedule_from_hour: 8,
  schedule_from_min: 0,
  schedule_to_hour: 20,
  schedule_to_min: 0,
  scheduler_days: 0,
  queueing_enabled: true,
  max_active_downloads: 3,
  max_active_uploads: 3,
  max_active_torrents: 5,
  dont_count_slow_torrents: false,
  slow_torrent_dl_rate_threshold: 2,
  slow_torrent_ul_rate_threshold: 2,
  slow_torrent_inactive_timer: 60,
  max_connec: 500,
  max_connec_per_torrent: 100,
  max_uploads: 20,
  max_uploads_per_torrent: 4,
  preallocate_all: false,
  incomplete_files_ext: false,
  // Settings Hearth never changes (refused), present as in the real app.
  listen_port: 6881,
  save_path: "/downloads",
  web_ui_port: 8090,
  dht: false,
};

interface Tor {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  num_seeds: number;
  num_leechs: number;
  num_complete: number;
  num_incomplete: number;
  ratio: number;
  priority: number;
  tracker: string;
  category: string;
  tags: string;
  save_path: string;
  auto_tmm: boolean;
  force_start: boolean;
  added_on: number;
  completion_on: number;
  seeding_time?: number;
  files: { name: string; size: number; progress: number; priority: number }[];
}

const NOW = () => Math.floor(Date.now() / 1000);

function initialTorrents(): Tor[] {
  const base = {
    dlspeed: 0,
    upspeed: 0,
    eta: 8640000,
    num_seeds: 0,
    num_leechs: 0,
    num_complete: 12,
    num_incomplete: 3,
    ratio: 0,
    priority: 0,
    tracker: "https://tracker.example.org/announce?passkey=e2e-secret",
    tags: "",
    force_start: false,
    added_on: NOW() - 3600,
    completion_on: 0,
  };
  return [
    {
      ...base,
      hash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      name: "Ubuntu 24.04 Desktop",
      state: "downloading",
      progress: 0.42,
      size: 6_000_000_000,
      dlspeed: 4_200_000,
      eta: 900,
      num_seeds: 14,
      num_leechs: 2,
      priority: 1,
      category: "",
      save_path: "/downloads",
      auto_tmm: false,
      files: [
        {
          name: "ubuntu-24.04-desktop-amd64.iso",
          size: 5_990_000_000,
          progress: 0.42,
          priority: 1,
        },
        { name: "SHA256SUMS", size: 10_000_000, progress: 1, priority: 1 },
      ],
    },
    {
      ...base,
      hash: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
      name: "Night.Signal.S01E01.1080p.WEB",
      state: "uploading",
      // Four days of seeding (11-11): a TrackerOne grab in the stand-in Sonarr, for seeding rules.
      seeding_time: 4 * 86400,
      progress: 1,
      size: 1_800_000_000,
      upspeed: 350_000,
      ratio: 1.42,
      category: "tv-sonarr",
      tags: "keep",
      save_path: "/downloads/tv",
      auto_tmm: true,
      completion_on: NOW() - 1800,
      files: [
        {
          name: "Night.Signal.S01E01.1080p.WEB.mkv",
          size: 1_790_000_000,
          progress: 1,
          priority: 1,
        },
        { name: "Sample/sample.mkv", size: 10_000_000, progress: 1, priority: 0 },
      ],
    },
    {
      ...base,
      hash: "c3d4e5f60718293a4b5c6d7e8f9012345678901a",
      name: "Quiet.Harbor.2024.1080p.BluRay",
      state: "stoppedDL",
      progress: 0.63,
      size: 9_000_000_000,
      priority: 2,
      category: "radarr",
      save_path: "/downloads/movies",
      auto_tmm: true,
      files: [
        {
          name: "Quiet.Harbor.2024.1080p.BluRay.mkv",
          size: 8_990_000_000,
          progress: 0.63,
          priority: 1,
        },
        { name: "Quiet.Harbor.2024.nfo", size: 10_000_000, progress: 1, priority: 1 },
      ],
    },
  ];
}

/** Form fields and uploaded files from a request body (urlencoded or multipart). */
function formOf(
  body: unknown,
  contentType = "",
): {
  fields: URLSearchParams;
  files: { filename: string; data: Uint8Array }[];
} {
  const text = bodyText(body);
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) return { fields: new URLSearchParams(text), files: [] };
  const fields = new URLSearchParams();
  const files: { filename: string; data: Uint8Array }[] = [];
  for (const part of text.split(`--${boundary}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const value = part.slice(split + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (!name) continue;
    if (filename !== undefined)
      files.push({ filename, data: new Uint8Array(Buffer.from(value, "latin1")) });
    else fields.append(name, value);
  }
  return { fields, files };
}

export function fakeQbittorrent(): FakeQbittorrent {
  let prefs = { ...INITIAL };
  let list = initialTorrents();
  const initialCategories = () => ({
    radarr: { name: "radarr", savePath: "/downloads/movies" },
    "tv-sonarr": { name: "tv-sonarr", savePath: "/downloads/tv" },
  });
  let categories: Record<string, { name: string; savePath: string }> = initialCategories();
  let tags = ["keep"];
  const reply = (status: number, data: unknown, cookie?: string) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
    headers: {
      get: (name: string) => (cookie && name.toLowerCase() === "set-cookie" ? cookie : null),
    },
  });
  const folderOf = (category: string) =>
    category
      ? categories[category]?.savePath || `${String(prefs.save_path)}/${category}`
      : String(prefs.save_path);
  const pick = (hashes: string | null) => {
    if (!hashes || hashes === "all") return list;
    const wanted = new Set(hashes.toLowerCase().split("|"));
    return list.filter((t) => wanted.has(t.hash));
  };
  const info = (t: Tor) => {
    const { files: _files, ...rest } = t;
    return {
      ...rest,
      amount_left: Math.round(t.size * (1 - t.progress)),
      downloaded: Math.round(t.size * t.progress),
      total_size: t.size,
      content_path: `${t.save_path}/${t.name}`,
      ratio_limit: -2,
      seeding_time_limit: -2,
      inactive_seeding_time_limit: -2,
      availability: t.progress < 1 ? 1.4 : -1,
    };
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    const contentType = init.headers["Content-Type"] ?? init.headers["content-type"] ?? "";
    if (p === "/api/v2/auth/login" && method === "POST") {
      const form = new URLSearchParams(bodyText(init.body));
      return form.get("password")?.startsWith(PASSWORD_PREFIX)
        ? reply(200, "Ok.", `${SID}; HttpOnly; path=/; SameSite=Strict`)
        : reply(200, "Fails.");
    }
    if (!init.headers.Cookie?.includes(SID) && !init.headers.cookie?.includes(SID))
      return reply(403, "Forbidden");
    if (p === "/api/v2/auth/logout") return reply(200, "");
    if (p === "/api/v2/app/version") return reply(200, "v5.2.4");
    if (p === "/api/v2/app/webapiVersion") return reply(200, "2.15.1");
    if (p === "/api/v2/app/preferences") return reply(200, prefs);
    const { fields, files } =
      method === "POST" ? formOf(init.body, contentType) : { fields: u.searchParams, files: [] };
    if (p === "/api/v2/app/setPreferences" && method === "POST") {
      const json = fields.get("json");
      try {
        const changes = JSON.parse(json ?? "{}") as Record<string, unknown>;
        // Like qBittorrent: unknown keys are ignored, known ones take the new value.
        for (const [k, v] of Object.entries(changes)) if (k in prefs) prefs[k] = v;
        return reply(200, "");
      } catch {
        return reply(400, "Bad JSON");
      }
    }
    if (p === "/api/v2/torrents/categories") return reply(200, categories);
    if (p === "/api/v2/torrents/tags") return reply(200, tags);
    if (p === "/api/v2/torrents/info") {
      const category = u.searchParams.get("category");
      return reply(
        200,
        pick(u.searchParams.get("hashes"))
          .filter((t) => category === null || t.category === category)
          .map(info),
      );
    }
    const one = () => list.find((t) => t.hash === (u.searchParams.get("hash") ?? "").toLowerCase());
    if (p === "/api/v2/torrents/files") {
      const t = one();
      return t
        ? reply(
            200,
            t.files.map((f, index) => ({ index, ...f, piece_range: [0, 1], availability: 1 })),
          )
        : reply(404, "Not Found");
    }
    if (p === "/api/v2/torrents/trackers") {
      const t = one();
      return t
        ? reply(200, [
            { url: "** [DHT] **", status: 2, num_seeds: 3, num_leeches: 1, msg: "" },
            {
              url: t.tracker,
              status: 2,
              num_seeds: t.num_complete,
              num_leeches: t.num_incomplete,
              msg: "",
            },
          ])
        : reply(404, "Not Found");
    }
    if (p === "/api/v2/torrents/properties") {
      const t = one();
      return t
        ? reply(200, {
            save_path: t.save_path,
            time_elapsed: 3600,
            seeding_time: t.progress >= 1 ? 1800 : 0,
            pieces_have: Math.round(t.progress * 1000),
            pieces_num: 1000,
            seeds: t.num_seeds,
            peers: t.num_leechs,
            total_downloaded: Math.round(t.size * t.progress),
            total_uploaded: Math.round(t.size * t.ratio),
            share_ratio: t.ratio,
            dl_limit: -1,
            up_limit: -1,
            addition_date: t.added_on,
            completion_date: t.completion_on || -1,
            created_by: "mktorrent 1.1",
          })
        : reply(404, "Not Found");
    }
    if (p === "/api/v2/sync/torrentPeers") {
      const t = one();
      if (!t) return reply(404, "Not Found");
      return reply(200, {
        full_update: true,
        rid: 1,
        peers:
          t.state === "stoppedDL"
            ? {}
            : {
                "203.0.113.24:51413": {
                  ip: "203.0.113.24",
                  port: 51413,
                  client: "qBittorrent/5.1.0",
                  country: "Netherlands",
                  progress: 1,
                  dl_speed: t.dlspeed,
                  up_speed: 0,
                  flags: "D",
                  flags_desc: "D = Currently downloading (interested and not choked)",
                },
              },
      });
    }
    if (p === "/api/v2/transfer/speedLimitsMode") return reply(200, 0);
    const server_state = {
      connection_status: "connected",
      dl_info_speed: list.reduce((a, t) => a + t.dlspeed, 0),
      up_info_speed: list.reduce((a, t) => a + t.upspeed, 0),
      dl_info_data: 0,
      up_info_data: 0,
      dl_rate_limit: prefs.dl_limit,
      up_rate_limit: prefs.up_limit,
      dht_nodes: 0,
      use_alt_speed_limits: false,
      free_space_on_disk: 2_000_000_000_000,
    };
    if (p === "/api/v2/transfer/info") return reply(200, server_state);
    if (p === "/api/v2/sync/maindata")
      return reply(200, {
        rid: 1,
        full_update: true,
        torrents: Object.fromEntries(list.map((t) => [t.hash, info(t)])),
        categories,
        tags,
        server_state,
      });

    if (method !== "POST") return reply(404, "Not Found");
    const chosen = pick(fields.get("hashes"));
    if (p === "/api/v2/torrents/add") {
      const category = fields.get("category") ?? "";
      if (category && !categories[category])
        categories[category] = { name: category, savePath: "" };
      const added: { hash: string; name: string }[] = [];
      for (const link of (fields.get("urls") ?? "").split("\n").filter(Boolean)) {
        const hash = magnetHash(link);
        if (!hash) continue; // A .torrent URL: the stand-in has no internet to fetch it.
        const dn = /[?&]dn=([^&]+)/.exec(link)?.[1];
        added.push({ hash, name: dn ? decodeURIComponent(dn.replace(/\+/g, " ")) : hash });
      }
      for (const f of files) {
        const r = readTorrentFile(f.data);
        if ("error" in r) return reply(200, "Fails.");
        added.push({ hash: r.hash, name: r.name });
      }
      if (!added.length) return reply(200, "Fails.");
      const stopped = fields.get("stopped") === "true" || fields.get("paused") === "true";
      const auto = fields.get("autoTMM") !== "false";
      for (const a of added) {
        if (list.some((t) => t.hash === a.hash)) continue;
        list.push({
          ...initialTorrents()[0]!,
          hash: a.hash,
          name: a.name,
          state: stopped ? "stoppedDL" : "metaDL",
          progress: 0,
          dlspeed: 0,
          category,
          tags: fields.get("tags") ?? "",
          save_path: fields.get("savepath") || folderOf(category),
          auto_tmm: auto && !fields.get("savepath"),
          added_on: NOW(),
          files: [{ name: a.name, size: 1_000_000_000, progress: 0, priority: 1 }],
        });
      }
      return reply(200, "Ok.");
    }
    if (p === "/api/v2/torrents/stop" || p === "/api/v2/torrents/pause") {
      for (const t of chosen) t.state = t.progress >= 1 ? "stoppedUP" : "stoppedDL";
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/start" || p === "/api/v2/torrents/resume") {
      for (const t of chosen) t.state = t.progress >= 1 ? "uploading" : "downloading";
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/recheck" || p === "/api/v2/torrents/reannounce")
      return reply(200, "");
    if (p === "/api/v2/torrents/setForceStart") {
      for (const t of chosen) {
        t.force_start = fields.get("value") === "true";
        if (t.force_start) t.state = t.progress >= 1 ? "forcedUP" : "forcedDL";
      }
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/setAutoManagement") {
      for (const t of chosen) t.auto_tmm = fields.get("enable") === "true";
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/setCategory") {
      const category = fields.get("category") ?? "";
      if (category && !categories[category]) return reply(409, "Incorrect category name");
      for (const t of chosen) {
        t.category = category;
        // Automatic torrent management moves the files to the category's folder.
        if (t.auto_tmm) t.save_path = folderOf(category);
      }
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/addTags" || p === "/api/v2/torrents/removeTags") {
      const change = (fields.get("tags") ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      for (const t of chosen) {
        const now = new Set(
          t.tags
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        );
        for (const x of change) {
          if (p.endsWith("addTags")) now.add(x);
          else now.delete(x);
        }
        t.tags = [...now].join(", ");
      }
      if (p.endsWith("addTags")) tags = [...new Set([...tags, ...change])];
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/filePrio") {
      const t = list.find((x) => x.hash === (fields.get("hash") ?? "").toLowerCase());
      if (!t) return reply(404, "Not Found");
      const prio = Number(fields.get("priority"));
      const ids = (fields.get("id") ?? "").split("|").map(Number);
      if (![0, 1, 6, 7].includes(prio) || ids.some((i) => !t.files[i]))
        return reply(400, "Bad Request");
      for (const i of ids) t.files[i]!.priority = prio;
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/createCategory") {
      const name = fields.get("category") ?? "";
      if (!name || categories[name]) return reply(409, "Incorrect category name");
      categories[name] = { name, savePath: fields.get("savePath") ?? "" };
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/removeCategories") {
      for (const name of (fields.get("categories") ?? "").split("\n")) {
        delete categories[name];
        for (const t of list) if (t.category === name) t.category = "";
      }
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/delete") {
      const gone = new Set(chosen.map((t) => t.hash));
      list = list.filter((t) => !gone.has(t.hash));
      return reply(200, "");
    }
    if (p === "/api/v2/torrents/setShareLimits") return reply(200, "");
    if (/\/api\/v2\/torrents\/(topPrio|bottomPrio|increasePrio|decreasePrio)$/.test(p))
      return reply(200, "");
    return reply(404, "Not Found");
  };
  return {
    fetch: fetchImpl,
    addManual() {
      const done = {
        dlspeed: 0,
        upspeed: 0,
        eta: 8640000,
        num_seeds: 0,
        num_leechs: 0,
        num_complete: 20,
        num_incomplete: 0,
        ratio: 0.1,
        priority: 0,
        tracker: "https://tracker.example.org/announce",
        tags: "",
        force_start: false,
        added_on: NOW() - 900,
        completion_on: NOW() - 60,
        state: "uploading",
        progress: 1,
        category: "",
        save_path: String(prefs.save_path),
        auto_tmm: false,
      };
      list.push(
        {
          ...done,
          hash: "d4e5f60718293a4b5c6d7e8f9012345678901a2b",
          name: "The.Orchard.Keeper.2021.1080p.BluRay.x264",
          size: 7_000_000_000,
          files: [
            {
              name: "The.Orchard.Keeper.2021.1080p.BluRay.x264/The.Orchard.Keeper.2021.mkv",
              size: 6_990_000_000,
              progress: 1,
              priority: 1,
            },
            {
              name: "The.Orchard.Keeper.2021.1080p.BluRay.x264/Sample/sample.mkv",
              size: 10_000_000,
              progress: 1,
              priority: 1,
            },
          ],
        },
        {
          ...done,
          hash: "e5f60718293a4b5c6d7e8f9012345678901a2b3c",
          name: "Mystery Pack",
          size: 4_000_000_000,
          files: [
            { name: "Mystery Pack/part-a.mkv", size: 2_000_000_000, progress: 1, priority: 1 },
            { name: "Mystery Pack/part-b.mkv", size: 2_000_000_000, progress: 1, priority: 1 },
          ],
        },
      );
    },
    reset: () => {
      prefs = { ...INITIAL };
      list = initialTorrents();
      categories = initialCategories();
      tags = ["keep"];
    },
    preferences: () => ({ ...prefs }),
    torrents: () => list.map((t) => ({ ...t })),
  };
}
