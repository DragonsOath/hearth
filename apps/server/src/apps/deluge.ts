import { createHash } from "node:crypto";
import type {
  AppIssue,
  AppQueueItem,
  AppReport,
  DelugeDashboard,
  Torrent,
  TorrentDetail,
  TorrentStatus,
  TorrentTracker,
} from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import {
  AppIncompatibleError,
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  mb,
  TIMEOUT_MS,
  worst,
  type Fetch,
} from "./http";
import { trackerHost } from "./qbittorrent-live";

/**
 * Deluge (2.x), through its Web UI's JSON-RPC API (POST /json). Deluge's Web UI has one password
 * and no username; Hearth signs in with it from the vault, and when the Web UI is not attached to
 * a Deluge daemon yet, attaches it to the one it lists as online (what the Web UI's own Connection
 * Manager does on first use). Reads here never add, pause, or remove anything; changes are plans
 * (deluge-control.ts). Torrents come back in the same shapes as qBittorrent's, so both panels
 * share one Torrents tab.
 */

export const TORRENT_FIELDS = [
  "name",
  "state",
  "progress",
  "total_size",
  "total_wanted",
  "total_done",
  "download_payload_rate",
  "upload_payload_rate",
  "eta",
  "num_seeds",
  "total_seeds",
  "num_peers",
  "total_peers",
  "ratio",
  "queue",
  "tracker_host",
  "label",
  "time_added",
  "completed_time",
  "last_seen_complete",
  "download_location",
  "distributed_copies",
  "message",
  "is_auto_managed",
];

export interface RawTorrent {
  name?: string;
  state?: string;
  progress?: number;
  total_size?: number;
  total_wanted?: number;
  total_done?: number;
  download_payload_rate?: number;
  upload_payload_rate?: number;
  eta?: number;
  num_seeds?: number;
  total_seeds?: number;
  num_peers?: number;
  total_peers?: number;
  ratio?: number;
  queue?: number;
  tracker_host?: string;
  label?: string;
  time_added?: number;
  completed_time?: number;
  last_seen_complete?: number;
  download_location?: string;
  distributed_copies?: number;
  message?: string;
}

interface Stats {
  download_rate?: number;
  upload_rate?: number;
  dht_nodes?: number;
  free_space?: number;
  has_incoming_connections?: number | boolean;
  num_connections?: number;
}

/** Thrown for a Deluge session that ended (its Web UI signs out after an idle hour). */
class SessionEnded extends Error {}

/** One signed-in Web UI session: a cookie, and calls by method name. */
export class DelugeSession {
  private id = 0;
  version?: string;

  private constructor(
    readonly base: string,
    private readonly fetchImpl: Fetch,
    private cookie: string,
  ) {}

  /** Signs in with the Web UI password, then makes sure the Web UI is attached to a daemon. */
  static async open(base: string, password: string, fetchImpl: Fetch): Promise<DelugeSession> {
    const res = await post(base, fetchImpl, { method: "auth.login", params: [password], id: 0 });
    const body = (await res.json().catch(() => undefined)) as
      { result?: unknown; error?: { message?: string } | null } | undefined;
    if (!res.ok || !body)
      throw new AppUnreachableError(`Deluge answered ${res.status} to the sign-in at ${base}.`);
    if (body.result !== true)
      throw new AppKeyError(
        "Deluge refused the Web UI password. Check it in the vault (Deluge: Preferences > Interface > Password).",
      );
    const cookie = res.headers
      ?.get("set-cookie")
      ?.match(/(?:^|[;,]\s*)(_session_id=[^;,\s]+)/)?.[1];
    if (!cookie)
      throw new AppIncompatibleError(
        "Deluge accepted the password but Hearth found no session it can use. Not a password problem.",
      );
    const s = new DelugeSession(base, fetchImpl, cookie);
    await s.attach();
    return s;
  }

  /** One call; an ended session throws SessionEnded so the caller signs in again. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await post(
      this.base,
      this.fetchImpl,
      {
        method,
        params,
        id: ++this.id,
      },
      this.cookie,
    );
    if (!res.ok) throw new AppUnreachableError(`Deluge answered ${res.status} for ${method}.`);
    const body = (await res.json()) as {
      result?: T;
      error?: { message?: string; code?: number } | null;
    };
    if (body.error) {
      // Code 1: not signed in (the session ended).
      if (body.error.code === 1) throw new SessionEnded();
      throw new DelugeError(method, body.error.message ?? "an error");
    }
    return body.result as T;
  }

  /**
   * The Web UI talks to a separate Deluge daemon. When it is not attached yet (a fresh Web UI, or
   * one restarted), it is attached to the daemon it lists as online, as its Connection Manager
   * would. With none online, Hearth says so instead.
   */
  private async attach() {
    if (await this.call<boolean>("web.connected")) return;
    const hosts = await this.call<[string, string, number, string?][]>("web.get_hosts");
    for (const [id] of hosts ?? []) {
      const status = await this.call<[string, string, string?]>("web.get_host_status", [id]).catch(
        () => undefined,
      );
      if (status?.[1] !== "Online" && status?.[1] !== "Connected") continue;
      await this.call("web.connect", [id]);
      if (await this.call<boolean>("web.connected")) return;
    }
    throw new AppUnreachableError(
      "Deluge's Web UI is running, but no Deluge daemon is online for it to connect to. Start Deluge (deluged) or check the Connection Manager in its Web UI.",
    );
  }
}

export class DelugeError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`Deluge refused ${method}: ${message.slice(0, 200)}`);
  }
}

async function post(base: string, fetchImpl: Fetch, body: unknown, cookie?: string) {
  try {
    return await fetchImpl(joinUrl(base, "/json"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Deluge did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Deluge's state word to one status, the way qBittorrent's are read (same panel, same words). */
export function delugeStatus(r: RawTorrent): TorrentStatus {
  const done = (r.progress ?? 0) >= 100;
  switch (r.state) {
    case "Downloading":
      if (!r.total_size) return "metadata";
      return (r.download_payload_rate ?? 0) === 0 && (r.num_seeds ?? 0) === 0
        ? "stalled"
        : "downloading";
    case "Seeding":
      return "seeding";
    case "Paused":
      return done ? "completed" : "paused";
    case "Checking":
    case "Allocating":
      return "checking";
    case "Queued":
      return done ? "completed" : "queued";
    case "Moving":
      return "moving";
    case "Error":
      return "error";
    default:
      return done ? "completed" : "queued";
  }
}

const iso = (sec?: number) => (sec && sec > 0 ? new Date(sec * 1000).toISOString() : undefined);

export function toTorrent(hash: string, r: RawTorrent): Torrent {
  const status = delugeStatus(r);
  const size = r.total_wanted || r.total_size || 0;
  const done = Math.min(size, r.total_done ?? 0);
  const seedsInSwarm = Math.max(0, r.total_seeds ?? 0);
  const problem =
    status === "error"
      ? `Deluge reports an error${r.message && r.message !== "OK" ? `: ${redactLine(r.message).slice(0, 160)}` : "."}`
      : status === "stalled"
        ? seedsInSwarm === 0
          ? "Stalled: no seeders in the swarm."
          : `Stalled: no seeders connected (${seedsInSwarm} reported in the swarm).`
        : undefined;
  return {
    hash,
    name: r.name ?? "Unknown torrent",
    status,
    state: r.state ?? "unknown",
    progressPct: Math.round((r.progress ?? 0) * 10) / 10,
    sizeBytes: size,
    downloadedBytes: done,
    leftBytes: Math.max(0, size - done),
    downSpeed: r.download_payload_rate ?? 0,
    upSpeed: r.upload_payload_rate ?? 0,
    ...(r.eta && r.eta > 0 && r.eta < 8640000 ? { etaSec: r.eta } : {}),
    seedsConnected: Math.max(0, r.num_seeds ?? 0),
    leechersConnected: Math.max(0, r.num_peers ?? 0),
    seedsInSwarm,
    leechersInSwarm: Math.max(0, r.total_peers ?? 0),
    ratio: Math.max(0, Math.round((r.ratio ?? 0) * 100) / 100),
    ...(r.queue !== undefined && r.queue >= 0 ? { queuePosition: r.queue + 1 } : {}),
    ...(r.tracker_host ? { tracker: r.tracker_host } : {}),
    // Deluge's labels (its Label plugin) take the place of qBittorrent's categories.
    ...(r.label ? { category: r.label } : {}),
    ...(iso(r.time_added) ? { addedAt: iso(r.time_added) } : {}),
    ...(iso(r.completed_time) ? { completedAt: iso(r.completed_time) } : {}),
    ...(iso(r.last_seen_complete) ? { lastSeenComplete: iso(r.last_seen_complete) } : {}),
    ...(r.download_location ? { savePath: r.download_location } : {}),
    ...(r.download_location && r.name
      ? { contentPath: `${r.download_location.replace(/\/+$/, "")}/${r.name}` }
      : {}),
    ...(r.distributed_copies !== undefined && r.distributed_copies >= 0
      ? { availability: Math.round(r.distributed_copies * 100) / 100 }
      : {}),
    ...(problem ? { problem } : {}),
  };
}

/** The fields to ask for: label only when the Label plugin is on (Deluge refuses it otherwise). */
export const fieldsFor = (labels: boolean) =>
  labels ? TORRENT_FIELDS : TORRENT_FIELDS.filter((f) => f !== "label");

/** The health read every app gets: version, its own troubles, what is downloading. */
export async function readDeluge(
  base: string,
  password: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const s = await DelugeSession.open(base, password, fetchImpl);
  const [version, plugins] = await Promise.all([
    s.call<string>("daemon.get_version").catch(() => undefined),
    s.call<string[]>("core.get_enabled_plugins").catch(() => [] as string[]),
  ]);
  const ui = await s.call<{
    torrents?: Record<string, RawTorrent>;
    stats?: Stats;
  }>("web.update_ui", [fieldsFor(plugins.includes("Label")), {}]);
  const torrents = Object.entries(ui.torrents ?? {}).map(([h, r]) => toTorrent(h, r));
  const issues: AppIssue[] = [];
  const stats = ui.stats ?? {};
  const incoming = Boolean(stats.has_incoming_connections);
  if (
    (stats.num_connections ?? 0) > 0 &&
    !incoming &&
    torrents.some((t) => t.status === "downloading")
  )
    issues.push({
      level: "warning",
      key: "connection",
      text: "Deluge has no incoming connections: its listening port may be blocked, so downloads can be slower.",
    });
  const broken = torrents.filter((t) => t.status === "error");
  if (broken.length)
    issues.push({
      level: "warning",
      key: "torrents:error",
      text: `${broken.length} ${broken.length === 1 ? "torrent is" : "torrents are"} in error in Deluge.`,
    });
  const incomplete = torrents.filter((t) => !["seeding", "completed"].includes(t.status));
  const order = (t: Torrent) => (t.status === "error" ? 0 : t.status === "stalled" ? 1 : 2);
  const queue: AppQueueItem[] = [...incomplete]
    .sort((a, b) => order(a) - order(b))
    .slice(0, 25)
    .map((t) => ({
      title: t.name,
      status: t.state,
      progressPct: Math.round(t.progressPct),
      ...(mb(t.sizeBytes) !== undefined ? { sizeMb: mb(t.sizeBytes) } : {}),
      ...(t.problem ? { problem: t.problem } : {}),
      ...(t.category ? { via: t.category } : {}),
    }));
  const speed = (n?: number) =>
    !n ? "0" : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB/s` : `${Math.round(n / 1024)} KB/s`;
  return {
    app: "deluge",
    ...(version ? { version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Down / up", value: `${speed(stats.download_rate)} / ${speed(stats.upload_rate)}` },
      {
        label: "Downloading",
        value: `${incomplete.length} (${torrents.filter((t) => t.status === "stalled").length} stalled)`,
      },
      { label: "Seeding", value: String(torrents.filter((t) => t.status === "seeding").length) },
    ],
    queue,
    queueTotal: incomplete.length,
    activity: [],
    connections: [
      {
        name: "Internet (peers)",
        ok: (stats.num_connections ?? 0) > 0 || torrents.length === 0,
        detail: `${stats.num_connections ?? 0} peers connected, ${stats.dht_nodes ?? 0} DHT nodes${incoming ? "" : ", no incoming connections yet"}`,
      },
    ],
  };
}

/** Deluge's global settings Hearth shows and may change (by plan), with their units. */
export const DELUGE_PREFS: Record<
  string,
  { label: string; type: "bool" | "int" | "number"; unit?: string; note?: string }
> = {
  max_download_speed: { label: "Download speed limit", type: "number", unit: "KiB/s, -1 = none" },
  max_upload_speed: { label: "Upload speed limit", type: "number", unit: "KiB/s, -1 = none" },
  max_connections_global: { label: "Most connections overall", type: "int" },
  max_upload_slots_global: { label: "Most upload slots overall", type: "int" },
  max_active_downloading: { label: "Most active downloads", type: "int" },
  max_active_seeding: { label: "Most active seeding", type: "int" },
  max_active_limit: { label: "Most active torrents", type: "int" },
  dont_count_slow_torrents: { label: "Do not count slow torrents in these limits", type: "bool" },
  queue_new_to_top: { label: "Put new torrents at the top of the queue", type: "bool" },
  add_paused: { label: "Add torrents paused", type: "bool" },
  stop_seed_at_ratio: { label: "Stop seeding at a share ratio", type: "bool" },
  stop_seed_ratio: { label: "Share ratio to stop at", type: "number" },
  remove_seed_at_ratio: {
    label: "Remove the torrent when it reaches that ratio",
    type: "bool",
    note: "Removes the torrent from Deluge; its files stay on disk",
  },
  share_ratio_limit: { label: "Queue: share ratio limit", type: "number" },
  seed_time_limit: { label: "Queue: seeding time limit", type: "int", unit: "minutes" },
  prioritize_first_last_pieces: { label: "Download first and last pieces first", type: "bool" },
  sequential_download: { label: "Download in order (sequential)", type: "bool" },
  pre_allocate_storage: { label: "Pre-allocate disk space", type: "bool" },
};

export function showPref(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if ((key === "max_download_speed" || key === "max_upload_speed") && Number(value) < 0)
    return "no limit";
  const p = DELUGE_PREFS[key];
  return `${String(value)}${p?.unit && !p.unit.includes("=") ? ` ${p.unit}` : p?.unit?.startsWith("KiB") ? " KiB/s" : ""}`;
}

/** The Settings tab's read: the shown settings, labels, the default folder, the transfer state. */
export async function readDelugeSettings(s: DelugeSession) {
  const [config, plugins, ui] = await Promise.all([
    s.call<Record<string, unknown>>("core.get_config"),
    s.call<string[]>("core.get_enabled_plugins").catch(() => [] as string[]),
    s.call<{ stats?: Stats }>("web.update_ui", [["name"], {}]),
  ]);
  const labelsOn = plugins.includes("Label");
  const labels = labelsOn ? await s.call<string[]>("label.get_labels").catch(() => []) : [];
  const withPaths = await Promise.all(
    labels.map(async (name) => {
      const o = await s
        .call<{ apply_move_completed?: boolean; move_completed_path?: string }>(
          "label.get_options",
          [name],
        )
        .catch(() => undefined);
      return {
        name,
        ...(o?.apply_move_completed && o.move_completed_path
          ? { savePath: o.move_completed_path }
          : {}),
      };
    }),
  );
  const stats = ui.stats ?? {};
  return {
    // Only the settings above: never the proxy (it holds a password) or ports and interfaces.
    settings: Object.entries(DELUGE_PREFS)
      .filter(([k]) => k in config)
      .map(([key, p]) => ({
        key,
        label: p.label,
        value: config[key] as boolean | number,
        shown: showPref(key, config[key]),
        type: p.type,
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.note ? { note: p.note } : {}),
      })),
    categories: withPaths,
    tags: [] as string[],
    labelsEnabled: labelsOn,
    ...(typeof config.download_location === "string"
      ? { defaultSavePath: config.download_location }
      : {}),
    ...(config.move_completed === true && typeof config.move_completed_path === "string"
      ? { completedPath: config.move_completed_path }
      : {}),
    transfer: {
      connection: stats.has_incoming_connections ? "connected" : "firewalled",
      downSpeed: Number(stats.download_rate ?? 0),
      upSpeed: Number(stats.upload_rate ?? 0),
      downLimit: Number(config.max_download_speed ?? -1),
      upLimit: Number(config.max_upload_speed ?? -1),
      dhtNodes: Number(stats.dht_nodes ?? 0),
      alternativeLimits: false,
    },
  };
}

const credentialId = (password: string) => createHash("sha256").update(password).digest("hex");

/**
 * The live panel: one signed-in session per service, kept in memory (Deluge's Web UI keeps a
 * session for an hour), so refreshing every few seconds costs one small request.
 */
export class DelugeLive {
  private sessions = new Map<string, { s: DelugeSession; credential: string }>();

  constructor(private readonly fetchImpl: Fetch) {}

  async with<T>(
    serviceId: string,
    base: string,
    password: string,
    fn: (s: DelugeSession, labels: boolean) => Promise<T>,
  ): Promise<T> {
    const credential = credentialId(password);
    let entry = this.sessions.get(serviceId);
    if (!entry || entry.s.base !== base || entry.credential !== credential) {
      entry = { s: await DelugeSession.open(base, password, this.fetchImpl), credential };
      this.sessions.set(serviceId, entry);
    }
    const run = async (e: NonNullable<typeof entry>) => {
      // Asked every time (one small call): the Label plugin can be turned on or off at any time.
      const labels = (
        await e.s.call<string[]>("core.get_enabled_plugins").catch(() => [] as string[])
      ).includes("Label");
      return fn(e.s, labels);
    };
    try {
      return await run(entry);
    } catch (error) {
      if (!(error instanceof SessionEnded)) throw error;
      entry = { s: await DelugeSession.open(base, password, this.fetchImpl), credential };
      this.sessions.set(serviceId, entry);
      return run(entry);
    }
  }

  async dashboard(
    serviceId: string,
    base: string,
    password: string,
  ): Promise<Omit<DelugeDashboard, "vpn">> {
    return this.with(serviceId, base, password, async (s, labels) => {
      s.version ??= await s.call<string>("daemon.get_version").catch(() => undefined);
      const ui = await s.call<{ torrents?: Record<string, RawTorrent>; stats?: Stats }>(
        "web.update_ui",
        [fieldsFor(labels), {}],
      );
      const stats = ui.stats ?? {};
      return {
        app: "deluge",
        ...(s.version ? { version: s.version } : {}),
        connection: stats.has_incoming_connections
          ? "connected"
          : (stats.num_connections ?? 0) > 0 || (stats.dht_nodes ?? 0) > 0
            ? "firewalled"
            : "disconnected",
        downSpeed: stats.download_rate ?? 0,
        upSpeed: stats.upload_rate ?? 0,
        ...(stats.dht_nodes !== undefined ? { dhtNodes: stats.dht_nodes } : {}),
        ...(stats.free_space !== undefined && stats.free_space >= 0
          ? { freeSpaceBytes: stats.free_space }
          : {}),
        labelsEnabled: labels,
        torrents: Object.entries(ui.torrents ?? {}).map(([h, r]) => toTorrent(h, r)),
      };
    });
  }

  /** One torrent in depth: trackers (host and status only), files, peers, transfer totals. */
  async detail(
    serviceId: string,
    base: string,
    password: string,
    hash: string,
    more: { files?: boolean; peers?: boolean } = {},
  ): Promise<TorrentDetail> {
    if (!/^[a-f0-9]{40}$/i.test(hash)) throw new AppKeyError("Not a torrent hash.");
    return this.with(serviceId, base, password, async (s) => {
      const r = await s.call<{
        trackers?: {
          url?: string;
          message?: string;
          fails?: number;
          updating?: boolean;
          verified?: boolean;
          scrape_complete?: number;
          scrape_incomplete?: number;
        }[];
        tracker_status?: string;
        download_location?: string;
        active_time?: number;
        seeding_time?: number;
        num_pieces?: number;
        progress?: number;
        num_seeds?: number;
        num_peers?: number;
        all_time_download?: number;
        total_uploaded?: number;
        ratio?: number;
        max_download_speed?: number;
        max_upload_speed?: number;
        time_added?: number;
        completed_time?: number;
        creator?: string;
        files?: { index?: number; path?: string; size?: number }[];
        file_progress?: number[];
        file_priorities?: number[];
        peers?: {
          ip?: string;
          client?: string;
          country?: string;
          progress?: number;
          down_speed?: number;
          up_speed?: number;
          seed?: number;
        }[];
      }>("core.get_torrent_status", [
        hash,
        [
          "trackers",
          "tracker_status",
          "download_location",
          "active_time",
          "seeding_time",
          "num_pieces",
          "progress",
          "num_seeds",
          "num_peers",
          "all_time_download",
          "total_uploaded",
          "ratio",
          "max_download_speed",
          "max_upload_speed",
          "time_added",
          "completed_time",
          "creator",
          ...(more.files ? ["files", "file_progress", "file_priorities"] : []),
          ...(more.peers ? ["peers"] : []),
        ],
      ]);
      if (!r || Object.keys(r).length === 0) throw new AppKeyError("Deluge has no such torrent.");
      const status = (r.tracker_status ?? "").replace(/^[^:]*:\s*/, "");
      const trackers: TorrentTracker[] = (r.trackers ?? []).map((t, i) => ({
        // Host only: private trackers put a personal key in the announce address.
        host: trackerHost(t.url) ?? "unknown",
        status: t.updating
          ? "updating"
          : (t.fails ?? 0) > 0 || (i === 0 && /error/i.test(r.tracker_status ?? ""))
            ? "not working"
            : t.verified
              ? "working"
              : "not contacted",
        ...(t.scrape_complete !== undefined && t.scrape_complete >= 0
          ? { seeds: t.scrape_complete }
          : {}),
        ...(t.scrape_incomplete !== undefined && t.scrape_incomplete >= 0
          ? { leechers: t.scrape_incomplete }
          : {}),
        ...(t.message || (i === 0 && status)
          ? { message: redactLine(t.message || status).slice(0, 200) }
          : {}),
      }));
      const kib = (n?: number) => (n !== undefined && n > 0 ? Math.round(n * 1024) : 0);
      // Deluge's priorities (0 skip, 1 low, 4 normal, 7 high) as the panel's 0, 1, 6, 7.
      const prio = (p?: number): 0 | 1 | 6 | 7 =>
        p === 0 ? 0 : p !== undefined && p >= 7 ? 7 : p !== undefined && p >= 5 ? 6 : 1;
      return {
        hash,
        trackers,
        ...(r.download_location ? { savePath: r.download_location } : {}),
        ...(r.active_time !== undefined ? { activeSec: r.active_time } : {}),
        ...(r.seeding_time !== undefined ? { seedingSec: r.seeding_time } : {}),
        ...(r.num_pieces
          ? {
              piecesTotal: r.num_pieces,
              piecesHave: Math.round(((r.progress ?? 0) / 100) * r.num_pieces),
            }
          : {}),
        peers: {
          connected: (r.num_seeds ?? 0) + (r.num_peers ?? 0),
          seeds: r.num_seeds ?? 0,
          leechers: r.num_peers ?? 0,
        },
        transfer: {
          downloadedBytes: r.all_time_download ?? 0,
          uploadedBytes: r.total_uploaded ?? 0,
          ratio: Math.max(0, Math.round((r.ratio ?? 0) * 100) / 100),
          downLimit: kib(r.max_download_speed),
          upLimit: kib(r.max_upload_speed),
          ...(iso(r.time_added) ? { addedAt: iso(r.time_added) } : {}),
          ...(iso(r.completed_time) ? { completedAt: iso(r.completed_time) } : {}),
          ...(r.creator ? { createdBy: r.creator.slice(0, 80) } : {}),
        },
        ...(more.files
          ? {
              files: (r.files ?? []).slice(0, 500).map((f, i) => ({
                index: f.index ?? i,
                name: f.path ?? `File ${i + 1}`,
                sizeBytes: f.size ?? 0,
                progressPct: Math.round((r.file_progress?.at(f.index ?? i) ?? 0) * 1000) / 10,
                priority: prio(r.file_priorities?.at(f.index ?? i)),
              })),
            }
          : {}),
        ...(more.peers
          ? {
              peerList: (r.peers ?? []).slice(0, 200).map((p) => ({
                address: p.ip ?? "unknown",
                ...(p.client ? { client: p.client.slice(0, 60) } : {}),
                ...(p.country?.trim() ? { country: p.country.trim() } : {}),
                progressPct: Math.round((p.progress ?? 0) * 1000) / 10,
                downSpeed: p.down_speed ?? 0,
                upSpeed: p.up_speed ?? 0,
                ...(p.seed ? { flags: "seed" } : {}),
              })),
            }
          : {}),
      };
    });
  }

  settings(serviceId: string, base: string, password: string) {
    return this.with(serviceId, base, password, (s) => readDelugeSettings(s));
  }

  forget(serviceId: string) {
    this.sessions.delete(serviceId);
  }
}
