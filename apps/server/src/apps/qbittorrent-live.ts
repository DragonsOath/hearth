import { createHash } from "node:crypto";
import type {
  QbittorrentDashboard,
  Torrent,
  TorrentDetail,
  TorrentStatus,
  TorrentTracker,
} from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, type Fetch } from "./http";
import { qbCall, qbSignIn } from "./qbittorrent";
import { readSettings } from "./qbittorrent-control";

/**
 * qBittorrent's live dashboard, read only. One signed-in session per service is
 * kept in memory (qBittorrent sessions last an hour by default) and each refresh
 * asks only for what changed since the last one (`/api/v2/sync/maindata` with its
 * response id), so refreshing every couple of seconds costs one small request and
 * no repeated sign-ins. Nothing here adds, pauses, removes, or changes anything.
 */

interface RawTorrent {
  name?: string;
  state?: string;
  progress?: number;
  size?: number;
  total_size?: number;
  downloaded?: number;
  amount_left?: number;
  dlspeed?: number;
  upspeed?: number;
  eta?: number;
  num_seeds?: number;
  num_leechs?: number;
  num_complete?: number;
  num_incomplete?: number;
  ratio?: number;
  priority?: number;
  tracker?: string;
  category?: string;
  added_on?: number;
  completion_on?: number;
  seen_complete?: number;
  content_path?: string;
  availability?: number;
  tags?: string;
  save_path?: string;
  auto_tmm?: boolean;
  force_start?: boolean;
  seeding_time?: number;
}

interface ServerState {
  connection_status?: string;
  dl_info_speed?: number;
  up_info_speed?: number;
  dht_nodes?: number;
  free_space_on_disk?: number;
}

interface MainData {
  rid?: number;
  full_update?: boolean;
  torrents?: Record<string, RawTorrent>;
  torrents_removed?: string[];
  server_state?: ServerState;
}

interface Session {
  base: string;
  /** Which credential this session was made with (a hash, never the value). */
  credential: string;
  cookie: string;
  rid: number;
  torrents: Map<string, RawTorrent>;
  server: ServerState;
  version?: string;
}

/** qBittorrent's state word to one status (v4 "paused*" and v5 "stopped*" alike). */
export function torrentStatus(state: string, progress: number): TorrentStatus {
  switch (state) {
    case "downloading":
    case "forcedDL":
      return "downloading";
    case "metaDL":
    case "forcedMetaDL":
      return "metadata";
    case "stalledDL":
      return "stalled";
    case "queuedDL":
    case "queuedUP":
      return "queued";
    case "pausedDL":
    case "stoppedDL":
      return "paused";
    case "pausedUP":
    case "stoppedUP":
      return "completed";
    case "checkingDL":
    case "checkingUP":
    case "checkingResumeData":
    case "allocating":
      return "checking";
    case "moving":
      return "moving";
    case "uploading":
    case "forcedUP":
    case "stalledUP":
      return "seeding";
    case "error":
    case "missingFiles":
      return "error";
    default:
      return progress >= 1 ? "completed" : "queued";
  }
}

/** Host only: private trackers put a personal key in the announce URL. */
export function trackerHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

const iso = (sec?: number) => (sec && sec > 0 ? new Date(sec * 1000).toISOString() : undefined);

export function toTorrent(hash: string, r: RawTorrent): Torrent {
  const progress = r.progress ?? 0;
  const state = r.state ?? "unknown";
  const status = torrentStatus(state, progress);
  const size = r.size ?? r.total_size ?? 0;
  const left = r.amount_left ?? Math.max(0, size - (r.downloaded ?? 0));
  const seedsInSwarm = Math.max(0, r.num_complete ?? 0);
  const problem =
    state === "missingFiles"
      ? "Its files are missing from disk."
      : status === "error"
        ? "qBittorrent reports an error for this torrent."
        : status === "stalled"
          ? (r.num_seeds ?? 0) === 0 && seedsInSwarm === 0
            ? "Stalled: no seeders in the swarm."
            : (r.num_seeds ?? 0) === 0
              ? `Stalled: no seeders connected (${seedsInSwarm} reported in the swarm).`
              : "Stalled: connected peers are not sending data."
          : undefined;
  return {
    hash,
    name: r.name ?? "Unknown torrent",
    status,
    state,
    progressPct: Math.round(progress * 1000) / 10,
    sizeBytes: size,
    downloadedBytes: Math.max(0, size - left),
    leftBytes: left,
    downSpeed: r.dlspeed ?? 0,
    upSpeed: r.upspeed ?? 0,
    ...(r.eta !== undefined && r.eta > 0 && r.eta < 8640000 ? { etaSec: r.eta } : {}),
    seedsConnected: r.num_seeds ?? 0,
    leechersConnected: r.num_leechs ?? 0,
    seedsInSwarm,
    leechersInSwarm: Math.max(0, r.num_incomplete ?? 0),
    ratio: Math.round((r.ratio ?? 0) * 100) / 100,
    ...(r.seeding_time !== undefined && r.seeding_time >= 0 ? { seedingSec: r.seeding_time } : {}),
    ...(r.priority && r.priority > 0 ? { queuePosition: r.priority } : {}),
    ...(trackerHost(r.tracker) ? { tracker: trackerHost(r.tracker) } : {}),
    ...(r.category ? { category: r.category } : {}),
    ...(iso(r.added_on) ? { addedAt: iso(r.added_on) } : {}),
    ...(iso(r.completion_on) ? { completedAt: iso(r.completion_on) } : {}),
    ...(iso(r.seen_complete) ? { lastSeenComplete: iso(r.seen_complete) } : {}),
    ...(r.content_path ? { contentPath: r.content_path } : {}),
    ...(r.availability !== undefined && r.availability >= 0
      ? { availability: Math.round(r.availability * 100) / 100 }
      : {}),
    ...(problem ? { problem } : {}),
    ...(r.tags
      ? {
          tags: r.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        }
      : {}),
    ...(r.save_path ? { savePath: r.save_path } : {}),
    ...(r.auto_tmm !== undefined ? { autoTmm: r.auto_tmm } : {}),
    ...(r.force_start ? { forceStart: true } : {}),
  };
}

const credentialId = (username: string, password: string) =>
  createHash("sha256").update(`${username}\n${password}`).digest("hex");

export class QbittorrentLive {
  private sessions = new Map<string, Session>();

  constructor(private readonly fetchImpl: Fetch) {}

  /** Signs in (or reuses the session) and runs `fn`; signs in again once if the session ended. */
  private async withSession<T>(
    serviceId: string,
    base: string,
    login: { username: string; password: string },
    fn: (s: Session) => Promise<T>,
  ): Promise<T> {
    const credential = credentialId(login.username, login.password);
    let s = this.sessions.get(serviceId);
    if (!s || s.base !== base || s.credential !== credential) {
      s = await this.open(base, login, credential);
      this.sessions.set(serviceId, s);
    }
    try {
      return await fn(s);
    } catch (error) {
      if (!(error instanceof SessionEnded)) throw error;
      s = await this.open(base, login, credential);
      this.sessions.set(serviceId, s);
      return fn(s);
    }
  }

  private async open(
    base: string,
    login: { username: string; password: string },
    credential: string,
  ): Promise<Session> {
    const cookie = await qbSignIn(base, login, this.fetchImpl);
    return { base, credential, cookie, rid: 0, torrents: new Map(), server: {} };
  }

  private async get<T>(s: Session, path: string, asText = false): Promise<T> {
    const res = await qbCall(s.base, this.fetchImpl)(path, { cookie: s.cookie });
    if (res.status === 403) throw new SessionEnded();
    if (!res.ok)
      throw new AppUnreachableError(
        `qBittorrent answered ${res.status} for ${path.split("?")[0]}.`,
      );
    return (asText && res.text ? await res.text() : await res.json()) as T;
  }

  /** The dashboard now: only the changes since the last read are fetched. */
  async dashboard(
    serviceId: string,
    base: string,
    login: { username: string; password: string },
  ): Promise<Omit<QbittorrentDashboard, "vpn">> {
    return this.withSession(serviceId, base, login, async (s) => {
      if (!s.version) {
        s.version = (await this.get<string>(s, "/api/v2/app/version", true)).replace(/^v/, "");
      }
      const d = await this.get<MainData>(s, `/api/v2/sync/maindata?rid=${s.rid}`);
      if (d.full_update) s.torrents.clear();
      for (const [hash, change] of Object.entries(d.torrents ?? {})) {
        s.torrents.set(hash, { ...s.torrents.get(hash), ...change });
      }
      for (const hash of d.torrents_removed ?? []) s.torrents.delete(hash);
      s.server = { ...s.server, ...d.server_state };
      if (typeof d.rid === "number") s.rid = d.rid;
      const conn = s.server.connection_status;
      return {
        app: "qbittorrent",
        version: s.version,
        connection:
          conn === "connected" || conn === "firewalled" || conn === "disconnected"
            ? conn
            : "unknown",
        downSpeed: s.server.dl_info_speed ?? 0,
        upSpeed: s.server.up_info_speed ?? 0,
        ...(s.server.dht_nodes !== undefined ? { dhtNodes: s.server.dht_nodes } : {}),
        ...(s.server.free_space_on_disk !== undefined
          ? { freeSpaceBytes: s.server.free_space_on_disk }
          : {}),
        torrents: [...s.torrents.entries()].map(([hash, r]) => toTorrent(hash, r)),
      };
    });
  }

  /** One torrent in depth: trackers (host and status only), peers, properties. */
  async detail(
    serviceId: string,
    base: string,
    login: { username: string; password: string },
    hash: string,
    /** Also its files or its connected peers (read only while that view is open). */
    more: { files?: boolean; peers?: boolean } = {},
  ): Promise<TorrentDetail> {
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(hash)) throw new AppKeyError("Not a torrent hash.");
    return this.withSession(serviceId, base, login, async (s) => {
      const [files, peers] = await Promise.all([
        more.files
          ? this.get<
              {
                index?: number;
                name?: string;
                size?: number;
                progress?: number;
                priority?: number;
              }[]
            >(s, `/api/v2/torrents/files?hash=${hash}`)
          : undefined,
        more.peers
          ? this.get<{
              peers?: Record<
                string,
                {
                  ip?: string;
                  port?: number;
                  client?: string;
                  country?: string;
                  progress?: number;
                  dl_speed?: number;
                  up_speed?: number;
                  flags?: string;
                  flags_desc?: string;
                }
              >;
            }>(s, `/api/v2/sync/torrentPeers?hash=${hash}&rid=0`)
          : undefined,
      ]);
      const [trackers, props] = await Promise.all([
        this.get<
          {
            url?: string;
            status?: number;
            num_seeds?: number;
            num_leeches?: number;
            msg?: string;
          }[]
        >(s, `/api/v2/torrents/trackers?hash=${hash}`),
        this.get<{
          save_path?: string;
          time_elapsed?: number;
          seeding_time?: number;
          pieces_have?: number;
          pieces_num?: number;
          seeds?: number;
          peers?: number;
          total_downloaded?: number;
          total_uploaded?: number;
          share_ratio?: number;
          dl_limit?: number;
          up_limit?: number;
          addition_date?: number;
          completion_date?: number;
          created_by?: string;
        }>(s, `/api/v2/torrents/properties?hash=${hash}`),
      ]);
      const STATUS: TorrentTracker["status"][] = [
        "disabled",
        "not contacted",
        "working",
        "updating",
        "not working",
      ];
      return {
        hash,
        trackers: trackers.map((t) => {
          const pseudo = t.url?.startsWith("** [")
            ? t.url.replace(/^\*\* \[|\] \*\*$/g, "")
            : undefined;
          return {
            host: pseudo ?? trackerHost(t.url) ?? "unknown",
            status: STATUS[t.status ?? 1] ?? "not contacted",
            ...(t.num_seeds !== undefined && t.num_seeds >= 0 ? { seeds: t.num_seeds } : {}),
            ...(t.num_leeches !== undefined && t.num_leeches >= 0
              ? { leechers: t.num_leeches }
              : {}),
            ...(t.msg ? { message: redactLine(t.msg).slice(0, 200) } : {}),
          };
        }),
        ...(props.save_path ? { savePath: props.save_path } : {}),
        ...(props.time_elapsed !== undefined ? { activeSec: props.time_elapsed } : {}),
        ...(props.seeding_time !== undefined ? { seedingSec: props.seeding_time } : {}),
        ...(props.pieces_have !== undefined ? { piecesHave: props.pieces_have } : {}),
        ...(props.pieces_num !== undefined ? { piecesTotal: props.pieces_num } : {}),
        peers: {
          connected: (props.seeds ?? 0) + (props.peers ?? 0),
          seeds: props.seeds ?? 0,
          leechers: props.peers ?? 0,
        },
        transfer: {
          downloadedBytes: props.total_downloaded ?? 0,
          uploadedBytes: props.total_uploaded ?? 0,
          ratio: Math.round((props.share_ratio ?? 0) * 100) / 100,
          downLimit: Math.max(0, props.dl_limit ?? 0),
          upLimit: Math.max(0, props.up_limit ?? 0),
          ...(iso(props.addition_date) ? { addedAt: iso(props.addition_date) } : {}),
          ...(iso(props.completion_date) ? { completedAt: iso(props.completion_date) } : {}),
          ...(props.created_by ? { createdBy: props.created_by.slice(0, 80) } : {}),
        },
        ...(files
          ? {
              files: files.slice(0, 500).map((f, i) => ({
                index: f.index ?? i,
                name: f.name ?? `File ${i + 1}`,
                sizeBytes: f.size ?? 0,
                progressPct: Math.round((f.progress ?? 0) * 1000) / 10,
                priority: ([0, 1, 6, 7] as const).includes(f.priority as 0 | 1 | 6 | 7)
                  ? (f.priority as 0 | 1 | 6 | 7)
                  : 1,
              })),
            }
          : {}),
        ...(peers
          ? {
              peerList: Object.entries(peers.peers ?? {})
                .slice(0, 200)
                .map(([key, p]) => ({
                  address: p.ip ? `${p.ip}${p.port ? `:${p.port}` : ""}` : key,
                  ...(p.client ? { client: p.client.slice(0, 60) } : {}),
                  ...(p.country ? { country: p.country } : {}),
                  progressPct: Math.round((p.progress ?? 0) * 1000) / 10,
                  downSpeed: p.dl_speed ?? 0,
                  upSpeed: p.up_speed ?? 0,
                  ...(p.flags
                    ? {
                        flags: p.flags_desc
                          ? `${p.flags} (${p.flags_desc.replace(/\n/g, "; ")})`
                          : p.flags,
                      }
                    : {}),
                })),
            }
          : {}),
      };
    });
  }

  /** Global seeding, speed, and queue settings, categories, tags, and the transfer state (read only). */
  async settings(
    serviceId: string,
    base: string,
    login: { username: string; password: string },
  ): Promise<Awaited<ReturnType<typeof readSettings>>> {
    return this.withSession(serviceId, base, login, (s) =>
      readSettings((_access, _purpose, fn) =>
        fn({
          get: <T>(path: string) => this.get<T>(s, path),
          post: () => Promise.reject(new Error("Reading only.")),
          postForm: () => Promise.reject(new Error("Reading only.")),
        }),
      ),
    );
  }

  /** Forgets a service's session (its credential was replaced or removed). */
  forget(serviceId: string) {
    this.sessions.delete(serviceId);
  }
}

class SessionEnded extends Error {}
