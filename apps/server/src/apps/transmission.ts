import { createHash } from "node:crypto";
import type {
  AppIssue,
  AppQueueItem,
  AppReport,
  Torrent,
  TorrentDetail,
  TorrentStatus,
  TorrentTracker,
  TransmissionDashboard,
} from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import {
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  mb,
  TIMEOUT_MS,
  worst,
  type Fetch,
} from "./http";

/**
 * Transmission (3.x and 4.x), through its RPC (POST /transmission/rpc), signed in with the Web UI
 * username and password from the vault when it asks for them. Transmission answers 409 with a
 * session id the first time; Hearth keeps it per address and sends it from then on. Reads here
 * never add, pause or remove anything; changes are plans (transmission-control.ts). Torrents come
 * back in the same shapes as qBittorrent's, so the panels share one Torrents tab.
 *
 * A torrent's magnet link and its trackers' announce addresses carry private trackers' passkeys:
 * Hearth never asks for them and keeps only each tracker's host.
 */

export class TransmissionError extends Error {}

export interface TransmissionLogin {
  username: string;
  password: string;
}

/** The session id Transmission handed out, per address (it changes when Transmission restarts). */
const SESSION_IDS = new Map<string, string>();

/** Forget the session ids (tests). */
export function forgetTransmissionSessions() {
  SESSION_IDS.clear();
}

/** Where its RPC answers: the address as given when it already ends in /rpc. */
export const rpcUrl = (base: string) =>
  /\/rpc\/?$/.test(base) ? base.replace(/\/$/, "") : joinUrl(base, "/transmission/rpc");

export class TransmissionSession {
  constructor(
    readonly base: string,
    private readonly login: TransmissionLogin,
    private readonly fetchImpl: Fetch,
  ) {}

  async call<T>(method: string, args: Record<string, unknown> = {}, timeoutMs = TIMEOUT_MS * 2) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sid = SESSION_IDS.get(this.base);
      let res: Awaited<ReturnType<Fetch>>;
      try {
        res = await this.fetchImpl(rpcUrl(this.base), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(sid ? { "X-Transmission-Session-Id": sid } : {}),
            ...(this.login.username || this.login.password
              ? {
                  Authorization: `Basic ${Buffer.from(`${this.login.username}:${this.login.password}`).toString("base64")}`,
                }
              : {}),
          },
          body: JSON.stringify({ method, arguments: args }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AppUnreachableError(
          `Transmission did not answer at ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (res.status === 409) {
        const next = res.headers?.get("X-Transmission-Session-Id");
        if (!next) throw new AppUnreachableError("Transmission did not give a session id.");
        SESSION_IDS.set(this.base, next);
        continue;
      }
      if (res.status === 401)
        throw new AppKeyError(
          "Transmission refused the username or password. Check the login in the vault.",
        );
      if (res.status === 403)
        throw new AppKeyError(
          "Transmission refused Hearth's address: add it to rpc-whitelist (or turn the whitelist off) in Transmission's settings.json.",
        );
      if (!res.ok) throw new TransmissionError(`Transmission answered ${res.status} to ${method}.`);
      const body = (await res.json()) as { result?: string; arguments?: T };
      if (body.result !== "success")
        throw new TransmissionError(
          `Transmission refused ${method}: ${redactLine(String(body.result ?? "no reason")).slice(0, 200)}`,
        );
      return (body.arguments ?? {}) as T;
    }
    throw new AppUnreachableError("Transmission kept asking for a new session.");
  }
}

/** The fields Hearth reads for each torrent: never magnetLink or trackers (they hold passkeys). */
export const TORRENT_FIELDS = [
  "id",
  "hashString",
  "name",
  "status",
  "percentDone",
  "rateDownload",
  "rateUpload",
  "eta",
  "sizeWhenDone",
  "leftUntilDone",
  "uploadRatio",
  "labels",
  "error",
  "errorString",
  "addedDate",
  "doneDate",
  "queuePosition",
  "peersSendingToUs",
  "peersGettingFromUs",
  "isStalled",
  "isFinished",
  "downloadDir",
  "metadataPercentComplete",
  "trackerStats",
] as const;

export interface RawTrackerStat {
  host?: string;
  seederCount?: number;
  leecherCount?: number;
  lastAnnounceResult?: string;
  lastAnnounceSucceeded?: boolean;
  hasAnnounced?: boolean;
  announceState?: number;
}

export interface RawTorrent {
  id: number;
  hashString: string;
  name?: string;
  status?: number;
  percentDone?: number;
  rateDownload?: number;
  rateUpload?: number;
  eta?: number;
  sizeWhenDone?: number;
  leftUntilDone?: number;
  uploadRatio?: number;
  labels?: string[];
  error?: number;
  errorString?: string;
  addedDate?: number;
  doneDate?: number;
  queuePosition?: number;
  peersSendingToUs?: number;
  peersGettingFromUs?: number;
  isStalled?: boolean;
  isFinished?: boolean;
  downloadDir?: string;
  metadataPercentComplete?: number;
  trackerStats?: RawTrackerStat[];
}

/** Transmission's status numbers, in its own words. */
const STATE = [
  "Stopped",
  "Queued to check",
  "Checking",
  "Queued",
  "Downloading",
  "Queued to seed",
  "Seeding",
];

/** Transmission's state to one status, the way qBittorrent's are read (same panel, same words). */
export function transmissionStatus(r: RawTorrent): TorrentStatus {
  const done = (r.percentDone ?? 0) >= 1;
  // 3 is a local error (a missing folder, a full disk): the torrent cannot go on.
  if (r.error === 3) return "error";
  switch (r.status) {
    case 0:
      return done ? "completed" : "paused";
    case 1:
    case 2:
      return "checking";
    case 3:
      return "queued";
    case 4:
      if ((r.metadataPercentComplete ?? 1) < 1) return "metadata";
      return r.isStalled || ((r.rateDownload ?? 0) === 0 && (r.peersSendingToUs ?? 0) === 0)
        ? "stalled"
        : "downloading";
    case 5:
      return "queued";
    case 6:
      return "seeding";
    default:
      return done ? "completed" : "queued";
  }
}

const iso = (sec?: number) => (sec && sec > 0 ? new Date(sec * 1000).toISOString() : undefined);
const max0 = (n?: number) => (n !== undefined && n > 0 ? n : 0);

export function toTorrent(r: RawTorrent): Torrent {
  const status = transmissionStatus(r);
  const size = r.sizeWhenDone ?? 0;
  const left = Math.min(size, max0(r.leftUntilDone));
  const trackers = r.trackerStats ?? [];
  const seedsInSwarm = Math.max(0, ...trackers.map((t) => t.seederCount ?? 0));
  const leechersInSwarm = Math.max(0, ...trackers.map((t) => t.leecherCount ?? 0));
  const why = r.errorString ? redactLine(r.errorString).slice(0, 160) : "";
  const problem =
    status === "error"
      ? `Transmission reports an error${why ? `: ${why}` : "."}`
      : r.error === 2 || r.error === 1
        ? `Tracker ${r.error === 2 ? "error" : "warning"}${why ? `: ${why}` : "."}`
        : status === "stalled"
          ? seedsInSwarm === 0
            ? "Stalled: no seeders in the swarm."
            : `Stalled: no seeders connected (${seedsInSwarm} reported in the swarm).`
          : undefined;
  const labels = (r.labels ?? []).filter(Boolean);
  return {
    hash: r.hashString.toLowerCase(),
    name: r.name ?? "Unknown torrent",
    status,
    state: STATE[r.status ?? -1] ?? "unknown",
    progressPct: Math.round((r.percentDone ?? 0) * 1000) / 10,
    sizeBytes: size,
    downloadedBytes: size - left,
    leftBytes: left,
    downSpeed: r.rateDownload ?? 0,
    upSpeed: r.rateUpload ?? 0,
    ...(r.eta !== undefined && r.eta > 0 ? { etaSec: r.eta } : {}),
    seedsConnected: max0(r.peersSendingToUs),
    leechersConnected: max0(r.peersGettingFromUs),
    seedsInSwarm,
    leechersInSwarm,
    ratio: Math.max(0, Math.round((r.uploadRatio ?? 0) * 100) / 100),
    // Transmission numbers its queue from 0; only waiting torrents have a place that matters.
    ...(r.status === 3 || r.status === 5 || r.status === 4
      ? { queuePosition: (r.queuePosition ?? 0) + 1 }
      : {}),
    ...(trackers[0]?.host ? { tracker: trackers[0].host.replace(/:\d+$/, "") } : {}),
    // Its first label stands for qBittorrent's category; all of them show as tags.
    ...(labels[0] ? { category: labels[0] } : {}),
    ...(labels.length ? { tags: labels } : {}),
    ...(iso(r.addedDate) ? { addedAt: iso(r.addedDate) } : {}),
    ...(iso(r.doneDate) ? { completedAt: iso(r.doneDate) } : {}),
    ...(r.downloadDir ? { savePath: r.downloadDir } : {}),
    ...(r.downloadDir && r.name
      ? { contentPath: `${r.downloadDir.replace(/\/+$/, "")}/${r.name}` }
      : {}),
    ...(problem ? { problem } : {}),
  };
}

interface Stats {
  downloadSpeed?: number;
  uploadSpeed?: number;
  torrentCount?: number;
}

/** Whether its listening port is reachable from outside (it asks a Transmission server). */
async function portOpen(s: TransmissionSession): Promise<boolean | undefined> {
  return s
    .call<{ "port-is-open"?: boolean }>("port-test", {}, 6000)
    .then((r) => r["port-is-open"])
    .catch(() => undefined);
}

/** The health read every app gets: version, its own troubles, what is downloading. */
export async function readTransmission(
  base: string,
  login: TransmissionLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const s = new TransmissionSession(base, login, fetchImpl);
  const [session, list, stats] = await Promise.all([
    s.call<{ version?: string; "download-dir"?: string }>("session-get", {
      fields: ["version", "download-dir"],
    }),
    s.call<{ torrents?: RawTorrent[] }>("torrent-get", { fields: TORRENT_FIELDS }),
    s.call<Stats>("session-stats"),
  ]);
  const torrents = (list.torrents ?? []).map(toTorrent);
  const issues: AppIssue[] = [];
  const free = session["download-dir"]
    ? await s
        .call<{ "size-bytes"?: number }>("free-space", { path: session["download-dir"] })
        .catch(() => undefined)
    : undefined;
  if (free?.["size-bytes"] !== undefined && free["size-bytes"] < 5 * 1024 ** 3)
    issues.push({
      level: free["size-bytes"] < 1024 ** 3 ? "error" : "warning",
      key: "disk",
      text: `Transmission's download folder has ${(free["size-bytes"] / 1024 ** 3).toFixed(1)} GB free.`,
    });
  const broken = torrents.filter((t) => t.status === "error");
  if (broken.length)
    issues.push({
      level: "warning",
      key: "torrents:error",
      text: `${broken.length} ${broken.length === 1 ? "torrent is" : "torrents are"} in error in Transmission.`,
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
    app: "transmission",
    ...(session.version ? { version: session.version.replace(/\s*\(.*\)$/, "") } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Down / up",
        value: `${speed(stats.downloadSpeed)} / ${speed(stats.uploadSpeed)}`,
      },
      {
        label: "Downloading",
        value: `${incomplete.length} (${torrents.filter((t) => t.status === "stalled").length} stalled)`,
      },
      { label: "Seeding", value: String(torrents.filter((t) => t.status === "seeding").length) },
    ],
    queue,
    queueTotal: incomplete.length,
    activity: [],
  };
}

/** Transmission's global settings Hearth shows and may change (by plan), with their units. */
export const TRANSMISSION_PREFS: Record<
  string,
  { label: string; type: "bool" | "int" | "number"; unit?: string; note?: string }
> = {
  "speed-limit-down-enabled": { label: "Limit download speed", type: "bool" },
  "speed-limit-down": { label: "Download speed limit", type: "int", unit: "kB/s" },
  "speed-limit-up-enabled": { label: "Limit upload speed", type: "bool" },
  "speed-limit-up": { label: "Upload speed limit", type: "int", unit: "kB/s" },
  "alt-speed-enabled": {
    label: "Alternative speed limits on now (the turtle)",
    type: "bool",
  },
  "alt-speed-down": { label: "Alternative download limit", type: "int", unit: "kB/s" },
  "alt-speed-up": { label: "Alternative upload limit", type: "int", unit: "kB/s" },
  seedRatioLimited: { label: "Stop seeding at a share ratio", type: "bool" },
  seedRatioLimit: { label: "Share ratio to stop at", type: "number" },
  "idle-seeding-limit-enabled": { label: "Stop seeding when idle", type: "bool" },
  "idle-seeding-limit": { label: "Idle time before it stops", type: "int", unit: "minutes" },
  "download-queue-enabled": { label: "Limit active downloads", type: "bool" },
  "download-queue-size": { label: "Most active downloads", type: "int" },
  "seed-queue-enabled": { label: "Limit active seeding", type: "bool" },
  "seed-queue-size": { label: "Most active seeding", type: "int" },
  "queue-stalled-enabled": { label: "Do not count stalled torrents in these limits", type: "bool" },
  "queue-stalled-minutes": { label: "Stalled after", type: "int", unit: "minutes" },
  "start-added-torrents": { label: "Start torrents when they are added", type: "bool" },
  "peer-limit-global": { label: "Most peers overall", type: "int" },
  "peer-limit-per-torrent": { label: "Most peers per torrent", type: "int" },
  "rename-partial-files": { label: "Add .part to unfinished files", type: "bool" },
};

export function showPref(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  const p = TRANSMISSION_PREFS[key];
  return `${String(value)}${p?.unit ? ` ${p.unit}` : ""}`;
}

/** The Settings tab's read: the shown settings, the labels in use, the folders, the transfer. */
export async function readTransmissionSettings(s: TransmissionSession) {
  const [config, list, stats] = await Promise.all([
    s.call<Record<string, unknown>>("session-get", {
      fields: [
        ...Object.keys(TRANSMISSION_PREFS),
        "download-dir",
        "incomplete-dir",
        "incomplete-dir-enabled",
      ],
    }),
    s.call<{ torrents?: { labels?: string[] }[] }>("torrent-get", { fields: ["labels"] }),
    s.call<Stats>("session-stats"),
  ]);
  const labels = [...new Set((list.torrents ?? []).flatMap((t) => t.labels ?? []))].sort();
  const speedOn = (k: string) => config[`${k}-enabled`] === true;
  return {
    // Only the settings above: never the RPC password, whitelist, ports, proxy or blocklist.
    settings: Object.entries(TRANSMISSION_PREFS)
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
    categories: labels.map((name) => ({ name })),
    tags: labels,
    labelsEnabled: true,
    ...(typeof config["download-dir"] === "string"
      ? { defaultSavePath: config["download-dir"] }
      : {}),
    ...(config["incomplete-dir-enabled"] === true && typeof config["incomplete-dir"] === "string"
      ? { incompletePath: config["incomplete-dir"] }
      : {}),
    transfer: {
      connection: "connected",
      downSpeed: Number(stats.downloadSpeed ?? 0),
      upSpeed: Number(stats.uploadSpeed ?? 0),
      downLimit: speedOn("speed-limit-down") ? Number(config["speed-limit-down"]) * 1000 : 0,
      upLimit: speedOn("speed-limit-up") ? Number(config["speed-limit-up"]) * 1000 : 0,
      dhtNodes: 0,
      alternativeLimits: config["alt-speed-enabled"] === true,
    },
  };
}

const credentialId = (l: TransmissionLogin) =>
  createHash("sha256").update(`${l.username}\n${l.password}`).digest("hex");

/** Whether incoming connections reach it: asked at most every 10 minutes (it asks a server). */
const PORT_CHECK_MS = 10 * 60_000;

/** The live panel: a session per service, kept in memory; each refresh is two small calls. */
export class TransmissionLive {
  private sessions = new Map<string, { s: TransmissionSession; credential: string }>();
  private ports = new Map<string, { at: number; open?: boolean }>();

  constructor(private readonly fetchImpl: Fetch) {}

  session(serviceId: string, base: string, login: TransmissionLogin) {
    const credential = credentialId(login);
    let entry = this.sessions.get(serviceId);
    if (!entry || entry.s.base !== base || entry.credential !== credential) {
      entry = { s: new TransmissionSession(base, login, this.fetchImpl), credential };
      this.sessions.set(serviceId, entry);
    }
    return entry.s;
  }

  async dashboard(
    serviceId: string,
    base: string,
    login: TransmissionLogin,
  ): Promise<Omit<TransmissionDashboard, "vpn">> {
    const s = this.session(serviceId, base, login);
    const [session, list, stats] = await Promise.all([
      s.call<{ version?: string; "download-dir"?: string; "alt-speed-enabled"?: boolean }>(
        "session-get",
        { fields: ["version", "download-dir", "alt-speed-enabled"] },
      ),
      s.call<{ torrents?: RawTorrent[] }>("torrent-get", { fields: TORRENT_FIELDS }),
      s.call<Stats>("session-stats"),
    ]);
    const free = session["download-dir"]
      ? await s
          .call<{ "size-bytes"?: number }>("free-space", { path: session["download-dir"] })
          .catch(() => undefined)
      : undefined;
    let port = this.ports.get(serviceId);
    if (!port || Date.now() - port.at > PORT_CHECK_MS) {
      port = { at: Date.now(), open: await portOpen(s) };
      this.ports.set(serviceId, port);
    }
    return {
      app: "transmission",
      ...(session.version ? { version: session.version.replace(/\s*\(.*\)$/, "") } : {}),
      connection: port.open === true ? "connected" : port.open === false ? "firewalled" : "unknown",
      downSpeed: stats.downloadSpeed ?? 0,
      upSpeed: stats.uploadSpeed ?? 0,
      ...(free?.["size-bytes"] !== undefined && free["size-bytes"] >= 0
        ? { freeSpaceBytes: free["size-bytes"] }
        : {}),
      labelsEnabled: true,
      alternativeLimits: session["alt-speed-enabled"] === true,
      torrents: (list.torrents ?? []).map(toTorrent),
    };
  }

  /** One torrent in depth: trackers (host and status only), files, peers, transfer totals. */
  async detail(
    serviceId: string,
    base: string,
    login: TransmissionLogin,
    hash: string,
    more: { files?: boolean; peers?: boolean } = {},
  ): Promise<TorrentDetail> {
    if (!/^[a-f0-9]{40}$/i.test(hash)) throw new AppKeyError("Not a torrent hash.");
    const s = this.session(serviceId, base, login);
    const r = (
      await s.call<{
        torrents?: (RawTorrent & {
          pieceCount?: number;
          haveValid?: number;
          pieceSize?: number;
          secondsSeeding?: number;
          secondsDownloading?: number;
          downloadedEver?: number;
          uploadedEver?: number;
          downloadLimit?: number;
          downloadLimited?: boolean;
          uploadLimit?: number;
          uploadLimited?: boolean;
          creator?: string;
          peersConnected?: number;
          files?: { name?: string; length?: number; bytesCompleted?: number }[];
          fileStats?: { wanted?: boolean; priority?: number; bytesCompleted?: number }[];
          peers?: {
            address?: string;
            clientName?: string;
            progress?: number;
            rateToClient?: number;
            rateToPeer?: number;
            flagStr?: string;
          }[];
        })[];
      }>("torrent-get", {
        ids: [hash],
        fields: [
          ...TORRENT_FIELDS,
          "pieceCount",
          "haveValid",
          "pieceSize",
          "secondsSeeding",
          "secondsDownloading",
          "downloadedEver",
          "uploadedEver",
          "downloadLimit",
          "downloadLimited",
          "uploadLimit",
          "uploadLimited",
          "creator",
          "peersConnected",
          ...(more.files ? ["files", "fileStats"] : []),
          ...(more.peers ? ["peers"] : []),
        ],
      })
    ).torrents?.[0];
    if (!r) throw new AppKeyError("Transmission has no such torrent.");
    const trackers: TorrentTracker[] = (r.trackerStats ?? []).map((t) => ({
      // Host only: private trackers put a personal key in the announce address.
      host: (t.host ?? "unknown").replace(/:\d+$/, ""),
      status:
        t.announceState === 2 || t.announceState === 3
          ? "updating"
          : !t.hasAnnounced
            ? "not contacted"
            : t.lastAnnounceSucceeded
              ? "working"
              : "not working",
      ...(t.seederCount !== undefined && t.seederCount >= 0 ? { seeds: t.seederCount } : {}),
      ...(t.leecherCount !== undefined && t.leecherCount >= 0 ? { leechers: t.leecherCount } : {}),
      ...(t.lastAnnounceResult && !t.lastAnnounceSucceeded
        ? { message: redactLine(t.lastAnnounceResult).slice(0, 200) }
        : {}),
    }));
    const t = toTorrent(r);
    // Transmission's file priorities (-1 low, 0 normal, 1 high; unwanted = skip) as the panel's
    // 0, 1, 6, 7: it has no "highest", so high reads back as 6.
    const prio = (f?: { wanted?: boolean; priority?: number }): 0 | 1 | 6 | 7 =>
      f?.wanted === false ? 0 : (f?.priority ?? 0) > 0 ? 6 : 1;
    return {
      hash,
      trackers,
      ...(r.downloadDir ? { savePath: r.downloadDir } : {}),
      ...(r.secondsDownloading !== undefined || r.secondsSeeding !== undefined
        ? { activeSec: (r.secondsDownloading ?? 0) + (r.secondsSeeding ?? 0) }
        : {}),
      ...(r.secondsSeeding !== undefined ? { seedingSec: r.secondsSeeding } : {}),
      ...(r.pieceCount
        ? {
            piecesTotal: r.pieceCount,
            piecesHave: r.pieceSize
              ? Math.min(r.pieceCount, Math.round((r.haveValid ?? 0) / r.pieceSize))
              : Math.round((t.progressPct / 100) * r.pieceCount),
          }
        : {}),
      peers: {
        connected: r.peersConnected ?? 0,
        seeds: t.seedsConnected,
        leechers: t.leechersConnected,
      },
      transfer: {
        downloadedBytes: r.downloadedEver ?? 0,
        uploadedBytes: r.uploadedEver ?? 0,
        ratio: t.ratio,
        downLimit: r.downloadLimited ? (r.downloadLimit ?? 0) * 1000 : 0,
        upLimit: r.uploadLimited ? (r.uploadLimit ?? 0) * 1000 : 0,
        ...(t.addedAt ? { addedAt: t.addedAt } : {}),
        ...(t.completedAt ? { completedAt: t.completedAt } : {}),
        ...(r.creator ? { createdBy: r.creator.slice(0, 80) } : {}),
      },
      ...(more.files
        ? {
            files: (r.files ?? []).slice(0, 500).map((f, i) => ({
              index: i,
              name: f.name ?? `File ${i + 1}`,
              sizeBytes: f.length ?? 0,
              progressPct: f.length
                ? Math.round(((f.bytesCompleted ?? 0) / f.length) * 1000) / 10
                : 100,
              priority: prio(r.fileStats?.[i]),
            })),
          }
        : {}),
      ...(more.peers
        ? {
            peerList: (r.peers ?? []).slice(0, 200).map((p) => ({
              address: p.address ?? "unknown",
              ...(p.clientName ? { client: p.clientName.slice(0, 60) } : {}),
              progressPct: Math.round((p.progress ?? 0) * 1000) / 10,
              downSpeed: p.rateToClient ?? 0,
              upSpeed: p.rateToPeer ?? 0,
              ...(p.flagStr ? { flags: p.flagStr } : {}),
            })),
          }
        : {}),
    };
  }

  settings(serviceId: string, base: string, login: TransmissionLogin) {
    return readTransmissionSettings(this.session(serviceId, base, login));
  }
}
