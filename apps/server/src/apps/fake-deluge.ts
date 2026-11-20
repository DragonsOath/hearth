import { bodyText, type Fetch } from "./http";
import { magnetHash } from "./qbittorrent-control";
import { readTorrentFile } from "./torrent-file";

/**
 * A stand-in Deluge 2.2 Web UI (port 8112) for tests and safe previews (DC_FAKE_APPS=1, never in a
 * real install). It answers the JSON-RPC calls Hearth makes, shaped as a throwaway Deluge 2.2.0
 * answered them: sign-in with a session cookie, the Web UI attaching to its daemon, torrents with
 * their files, trackers (an announce address with a passkey, which Hearth must never show) and
 * peers, the Label plugin (off until turned on), and the settings Hearth may change.
 */

const PASSWORD_PREFIX = "e2e-";
const COOKIE = "_session_id=e2e-deluge-session";

export interface FakeDeluge {
  fetch: Fetch;
  reset(): void;
}

interface Tor {
  hash: string;
  name: string;
  state: "Downloading" | "Seeding" | "Paused" | "Queued" | "Error" | "Checking";
  progress: number;
  total_size: number;
  download_payload_rate: number;
  upload_payload_rate: number;
  eta: number;
  num_seeds: number;
  total_seeds: number;
  num_peers: number;
  total_peers: number;
  ratio: number;
  queue: number;
  label: string;
  time_added: number;
  completed_time: number;
  download_location: string;
  message: string;
  files: { path: string; size: number }[];
  file_priorities: number[];
}

const NOW = Math.floor(Date.UTC(2026, 10, 7, 12) / 1000);
const torrents0 = (): Tor[] => [
  {
    hash: "1111111111111111111111111111111111111111",
    name: "Big.Buck.Bunny.2008.1080p",
    state: "Downloading",
    progress: 42.5,
    total_size: 1_610_612_736,
    download_payload_rate: 2_621_440,
    upload_payload_rate: 131_072,
    eta: 640,
    num_seeds: 12,
    total_seeds: 40,
    num_peers: 3,
    total_peers: 9,
    ratio: 0.08,
    queue: 0,
    label: "",
    time_added: NOW - 3600,
    completed_time: 0,
    download_location: "/downloads",
    message: "OK",
    files: [
      { path: "Big.Buck.Bunny.2008.1080p/Big.Buck.Bunny.2008.1080p.mkv", size: 1_600_000_000 },
      { path: "Big.Buck.Bunny.2008.1080p/Sample/sample.mkv", size: 10_612_736 },
    ],
    file_priorities: [4, 4],
  },
  {
    hash: "2222222222222222222222222222222222222222",
    name: "Sintel.S01E02.720p",
    state: "Downloading",
    progress: 3,
    total_size: 734_003_200,
    download_payload_rate: 0,
    upload_payload_rate: 0,
    eta: 0,
    num_seeds: 0,
    total_seeds: 0,
    num_peers: 0,
    total_peers: 2,
    ratio: 0,
    queue: 1,
    label: "",
    time_added: NOW - 86400,
    completed_time: 0,
    download_location: "/downloads",
    message: "OK",
    files: [{ path: "Sintel.S01E02.720p.mkv", size: 734_003_200 }],
    file_priorities: [4],
  },
  {
    hash: "3333333333333333333333333333333333333333",
    name: "Elephants.Dream.Audiobook",
    state: "Seeding",
    progress: 100,
    total_size: 268_435_456,
    download_payload_rate: 0,
    upload_payload_rate: 51_200,
    eta: 0,
    num_seeds: 0,
    total_seeds: 5,
    num_peers: 1,
    total_peers: 4,
    ratio: 1.42,
    queue: -1,
    label: "",
    time_added: NOW - 7 * 86400,
    completed_time: NOW - 6 * 86400,
    download_location: "/downloads/books",
    message: "OK",
    files: [{ path: "Elephants.Dream.Audiobook.m4b", size: 268_435_456 }],
    file_priorities: [4],
  },
];

const CONFIG0 = (): Record<string, unknown> => ({
  download_location: "/downloads",
  move_completed: false,
  move_completed_path: "/downloads",
  max_download_speed: -1.0,
  max_upload_speed: 500.0,
  max_connections_global: 200,
  max_upload_slots_global: 4,
  max_active_downloading: 3,
  max_active_seeding: 5,
  max_active_limit: 8,
  dont_count_slow_torrents: false,
  queue_new_to_top: false,
  add_paused: false,
  stop_seed_at_ratio: false,
  stop_seed_ratio: 2.0,
  remove_seed_at_ratio: false,
  share_ratio_limit: 2.0,
  seed_time_limit: 180,
  prioritize_first_last_pieces: false,
  sequential_download: false,
  pre_allocate_storage: false,
  // Settings Hearth must never show or change.
  listen_ports: [6881, 6891],
  proxy: { hostname: "", password: "never-shown", port: 8080, type: 0, username: "" },
});

export function fakeDeluge(): FakeDeluge {
  let torrents = torrents0();
  let config = CONFIG0();
  let plugins: string[] = [];
  let labels: string[] = [];
  let connected = false;

  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) =>
    ({
      ok: status < 400,
      status,
      headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
      json: async () => data,
      text: async () => JSON.stringify(data),
    }) as unknown as Awaited<ReturnType<Fetch>>;
  const ok = (id: unknown, result: unknown) => reply(200, { result, error: null, id });
  const err = (id: unknown, message: string, code = 3) =>
    reply(200, { result: null, error: { message, code }, id });

  const view = (t: Tor, keys: string[]) => {
    const full: Record<string, unknown> = {
      ...t,
      total_wanted: t.total_size,
      total_done: Math.round((t.total_size * t.progress) / 100),
      tracker_host: "tracker.example.org",
      last_seen_complete: t.total_seeds ? NOW - 600 : 0,
      distributed_copies: t.total_seeds ? 2.4 : 0.03,
      is_auto_managed: true,
      trackers: [
        {
          url: "https://tracker.example.org/announce?passkey=e2e-SECRET",
          message: t.total_seeds ? "" : "Error: unregistered torrent",
          fails: t.total_seeds ? 0 : 2,
          updating: false,
          verified: Boolean(t.total_seeds),
          scrape_complete: t.total_seeds,
          scrape_incomplete: t.total_peers,
        },
      ],
      tracker_status: t.total_seeds ? "Announce OK" : "Error: unregistered torrent",
      active_time: NOW - t.time_added,
      seeding_time: t.completed_time ? NOW - t.completed_time : 0,
      num_pieces: 400,
      all_time_download: Math.round((t.total_size * t.progress) / 100),
      total_uploaded: Math.round(t.total_size * t.ratio),
      max_download_speed: -1,
      max_upload_speed: -1,
      creator: "mktorrent 1.1",
      files: t.files.map((f, index) => ({ index, path: f.path, size: f.size, offset: 0 })),
      file_progress: t.files.map(() => t.progress / 100),
      peers: t.num_peers
        ? [
            {
              ip: "203.0.113.7:51413",
              client: "qBittorrent 5.0.1",
              country: "NL",
              progress: 1,
              down_speed: t.download_payload_rate,
              up_speed: 0,
              seed: 1,
            },
          ]
        : [],
    };
    // Deluge refuses "label" while its Label plugin is off.
    return Object.fromEntries(
      keys
        .filter((k) => k in full && (k !== "label" || plugins.includes("Label")))
        .map((k) => [k, full[k]]),
    );
  };
  const find = (hash: unknown) => torrents.find((t) => t.hash === hash);
  const each = (ids: unknown, fn: (t: Tor) => void) => {
    for (const id of (Array.isArray(ids) ? ids : [ids]) as string[]) {
      const t = find(id);
      if (t) fn(t);
    }
  };
  const reorder = () => {
    const queued = torrents.filter((t) => t.queue >= 0).sort((a, b) => a.queue - b.queue);
    queued.forEach((t, i) => (t.queue = i));
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname !== "/json" || (init.method ?? "GET") !== "POST") return reply(404, {});
    const {
      method,
      params = [],
      id,
    } = JSON.parse(await bodyText(init.body)) as {
      method: string;
      params: unknown[];
      id: unknown;
    };
    const cookie = ((init.headers ?? {}) as Record<string, string>).Cookie ?? "";
    if (method === "auth.login") {
      const right = String(params[0] ?? "").startsWith(PASSWORD_PREFIX);
      return right
        ? reply(200, { result: true, error: null, id }, { "set-cookie": `${COOKIE}; Path=/json` })
        : ok(id, false);
    }
    if (!cookie.includes(COOKIE)) return err(id, "Not authenticated", 1);
    const a = params;
    switch (method) {
      case "web.connected":
        return ok(id, connected);
      case "web.get_hosts":
        return ok(id, [["e2e-daemon", "127.0.0.1", 58846, "localclient"]]);
      case "web.get_host_status":
        return ok(id, [a[0], "Online", "2.2.0"]);
      case "web.connect":
        connected = true;
        return ok(id, ["core.add_torrent_file"]);
      default:
    }
    if (!connected) return err(id, "Not connected to a daemon");
    switch (method) {
      case "daemon.get_version":
        return ok(id, "2.2.0");
      case "core.get_enabled_plugins":
        return ok(id, plugins);
      case "core.enable_plugin":
        if (!plugins.includes(String(a[0]))) plugins = [...plugins, String(a[0])];
        return ok(id, true);
      case "web.update_ui":
        return ok(id, {
          connected: true,
          torrents: Object.fromEntries(torrents.map((t) => [t.hash, view(t, a[0] as string[])])),
          stats: {
            download_rate: torrents.reduce((n, t) => n + t.download_payload_rate, 0),
            upload_rate: torrents.reduce((n, t) => n + t.upload_payload_rate, 0),
            num_connections: 16,
            dht_nodes: 312,
            free_space: 412_316_860_416,
            has_incoming_connections: 1,
          },
        });
      case "core.get_torrent_status": {
        const t = find(a[0]);
        return ok(id, t ? view(t, a[1] as string[]) : {});
      }
      case "core.get_config":
        return ok(id, structuredClone(config));
      case "core.set_config":
        config = { ...config, ...(a[0] as Record<string, unknown>) };
        return ok(id, null);
      case "core.pause_torrent":
        each(a[0], (t) => (t.state = "Paused"));
        return ok(id, null);
      case "core.resume_torrent":
        each(a[0], (t) => (t.state = t.progress >= 100 ? "Seeding" : "Downloading"));
        return ok(id, null);
      case "core.force_recheck":
      case "core.force_reannounce":
        return ok(id, null);
      case "core.queue_top":
      case "core.queue_up":
      case "core.queue_down":
      case "core.queue_bottom":
        each(a[0], (t) => {
          if (t.queue < 0) return;
          t.queue =
            method === "core.queue_top"
              ? -0.5
              : method === "core.queue_bottom"
                ? 999
                : method === "core.queue_up"
                  ? t.queue - 1.5
                  : t.queue + 1.5;
        });
        reorder();
        return ok(id, null);
      case "core.remove_torrent":
        torrents = torrents.filter((t) => t.hash !== a[0]);
        return ok(id, true);
      case "core.set_torrent_options":
        each(a[0], (t) => {
          const fp = (a[1] as { file_priorities?: number[] }).file_priorities;
          if (fp) t.file_priorities = fp;
        });
        return ok(id, null);
      case "core.add_torrent_magnet":
      case "core.add_torrent_url":
      case "core.add_torrent_file": {
        let hash: string | undefined;
        let name = "Added torrent";
        let size = 104_857_600;
        if (method === "core.add_torrent_magnet") {
          hash = magnetHash(String(a[0]));
          name = decodeURIComponent(String(a[0]).match(/dn=([^&]+)/)?.[1] ?? name).replace(
            /\+/g,
            " ",
          );
        } else if (method === "core.add_torrent_url") {
          hash = "4444444444444444444444444444444444444444";
          name = decodeURIComponent(String(a[0]).split("/").pop() ?? name).replace(
            /\.torrent$/,
            "",
          );
        } else {
          const parsed = readTorrentFile(Buffer.from(String(a[1]), "base64"));
          if ("error" in parsed) return err(id, "Unable to add torrent: not a torrent file");
          hash = parsed.hash;
          name = parsed.name;
          size = parsed.sizeBytes ?? size;
        }
        if (!hash) return err(id, "Unable to add magnet, invalid magnet info");
        if (find(hash)) return err(id, "Torrent already in session");
        const opts = (method === "core.add_torrent_file" ? a[2] : a[1]) as
          { add_paused?: boolean } | undefined;
        torrents.push({
          ...torrents0()[1]!,
          hash,
          name,
          total_size: size,
          progress: 0,
          state: opts?.add_paused ? "Paused" : "Downloading",
          queue: torrents.filter((t) => t.queue >= 0).length,
          time_added: NOW,
          files: [{ path: name, size }],
          file_priorities: [4],
        });
        return ok(id, hash);
      }
    }
    if (method.startsWith("label.") && !plugins.includes("Label"))
      return err(id, "Unknown method", 2);
    switch (method) {
      case "label.get_labels":
        return ok(id, [...labels].sort());
      case "label.add": {
        const l = String(a[0]).toLowerCase();
        if (labels.includes(l)) return err(id, "Label already exists");
        labels = [...labels, l];
        return ok(id, null);
      }
      case "label.remove":
        labels = labels.filter((l) => l !== a[0]);
        for (const t of torrents) if (t.label === a[0]) t.label = "";
        return ok(id, null);
      case "label.set_torrent": {
        const t = find(a[0]);
        if (!t) return err(id, "Unknown torrent");
        if (a[1] && !labels.includes(String(a[1]))) return err(id, "Unknown Label");
        t.label = String(a[1] ?? "");
        return ok(id, null);
      }
      case "label.get_options":
        return ok(id, {
          apply_move_completed: a[0] === "tv-sonarr",
          move_completed_path: a[0] === "tv-sonarr" ? "/downloads/tv" : "",
        });
    }
    return err(id, "Unknown method", 2);
  };

  return {
    fetch: fetchImpl,
    reset: () => {
      torrents = torrents0();
      config = CONFIG0();
      plugins = [];
      labels = [];
      connected = false;
    },
  };
}
