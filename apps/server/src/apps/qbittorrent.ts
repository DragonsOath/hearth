import type { AppIssue, AppQueueItem, AppReport } from "@dragon-control/core";
import {
  AppBlockedError,
  AppIncompatibleError,
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  mb,
  TIMEOUT_MS,
  worst,
  type Fetch,
} from "./http";

/**
 * qBittorrent (Web API v2), read only. It has no API keys: Hearth
 * signs in with the Web UI username and password from the vault, reads the
 * connection status, speeds, and the torrents that are downloading, stalled,
 * or in error, then signs out. It never adds, pauses, or removes anything.
 */

interface Torrent {
  name?: string;
  state?: string;
  progress?: number;
  size?: number;
  eta?: number;
  category?: string;
  dlspeed?: number;
  num_seeds?: number;
}

const STATE: Record<string, string> = {
  downloading: "Downloading",
  metaDL: "Getting metadata",
  forcedDL: "Downloading (forced)",
  stalledDL: "Stalled",
  queuedDL: "Queued",
  pausedDL: "Paused",
  stoppedDL: "Stopped",
  checkingDL: "Checking",
  allocating: "Allocating",
  moving: "Moving",
  error: "Error",
  missingFiles: "Missing files",
};
const INCOMPLETE = new Set(Object.keys(STATE));

function eta(seconds?: number): string | undefined {
  if (!seconds || seconds >= 8640000) return undefined; // qBittorrent's "infinity"
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

const speed = (bytesPerSec?: number) =>
  bytesPerSec === undefined
    ? "0"
    : bytesPerSec >= 1048576
      ? `${(bytesPerSec / 1048576).toFixed(1)} MB/s`
      : `${Math.round(bytesPerSec / 1024)} KB/s`;

/** A plain request to qBittorrent: errors name the address, never the password. */
export function qbCall(base: string, fetchImpl: Fetch) {
  return async (
    path: string,
    init: { method?: string; body?: string; cookie?: string; contentType?: string } = {},
  ) => {
    try {
      return await fetchImpl(joinUrl(base, path), {
        method: init.method ?? "GET",
        headers: {
          ...(init.body
            ? { "Content-Type": init.contentType ?? "application/x-www-form-urlencoded" }
            : {}),
          ...(init.cookie ? { Cookie: init.cookie } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `qBittorrent did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

/**
 * Signs in and returns the session cookie, telling a wrong login apart from
 * everything that is not the credential's fault.
 */
export async function qbSignIn(
  base: string,
  login: { username: string; password: string },
  fetchImpl: Fetch,
): Promise<string> {
  const call = qbCall(base, fetchImpl);
  const signIn = await call("/api/v2/auth/login", {
    method: "POST",
    body: `username=${encodeURIComponent(login.username)}&password=${encodeURIComponent(login.password)}`,
  });
  if (signIn.status === 403) {
    throw new AppBlockedError(
      "qBittorrent is refusing sign-ins from Hearth for now (too many failed attempts). It lifts by itself after a while.",
    );
  }
  const said = signIn.text ? (await signIn.text()).trim() : "";
  if (/fails/i.test(said)) {
    throw new AppKeyError(
      "qBittorrent refused the username or password. Check the login in the vault.",
    );
  }
  if (signIn.status === 401) {
    // Refused before the password is checked: host header validation or CSRF settings.
    throw new AppIncompatibleError(
      "qBittorrent refused the request itself (401), before checking the password: its Web UI host or origin checks do not accept Hearth's address. Not a credential problem.",
    );
  }
  if (!signIn.ok) {
    throw new AppUnreachableError(`qBittorrent answered ${signIn.status} to the sign-in.`);
  }
  // The session cookie: "SID" before qBittorrent 5, "QBT_SID_<port>" since.
  const cookie = signIn.headers
    ?.get("set-cookie")
    ?.match(/(?:^|[;,]\s*)((?:QBT_)?SID(?:_\w+)?=[^;,\s]+)/)?.[1];
  if (!cookie) {
    throw new AppIncompatibleError(
      `qBittorrent accepted the sign-in${said ? ` ("${said.slice(0, 20)}")` : ""} but Hearth found no session it can use. Not a credential problem.`,
    );
  }
  return cookie;
}

export async function readQbittorrent(
  base: string,
  login: { username: string; password: string },
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const call = qbCall(base, fetchImpl);
  const cookie = await qbSignIn(base, login, fetchImpl);

  try {
    const read = async <T>(path: string, asText = false): Promise<T> => {
      const res = await call(path, { cookie });
      if (res.status === 403) throw new AppKeyError("qBittorrent ended the session.");
      if (!res.ok) throw new AppUnreachableError(`qBittorrent answered ${res.status} for ${path}.`);
      return (asText && res.text ? await res.text() : await res.json()) as T;
    };
    const [version, transfer, torrents] = await Promise.all([
      read<string>("/api/v2/app/version", true),
      read<{
        connection_status?: string;
        dl_info_speed?: number;
        up_info_speed?: number;
        dht_nodes?: number;
      }>("/api/v2/transfer/info"),
      read<Torrent[]>("/api/v2/torrents/info?sort=added_on&reverse=true"),
    ]);

    const issues: AppIssue[] = [];
    const conn = transfer.connection_status ?? "unknown";
    if (conn === "disconnected") {
      issues.push({
        level: "error",
        key: "connection",
        text: "qBittorrent has no connection to the internet (disconnected).",
      });
    } else if (conn === "firewalled") {
      issues.push({
        level: "warning",
        key: "connection",
        text: "qBittorrent is firewalled: incoming connections are not reaching it, so downloads can be slower.",
      });
    }
    const incomplete = torrents.filter((t) => INCOMPLETE.has(t.state ?? ""));
    const broken = incomplete.filter((t) => t.state === "error" || t.state === "missingFiles");
    const stalled = incomplete.filter((t) => t.state === "stalledDL");
    if (broken.length) {
      issues.push({
        level: "warning",
        key: "torrents:error",
        text: `${broken.length} ${broken.length === 1 ? "torrent is" : "torrents are"} in error or missing files.`,
      });
    }

    // Problems first, then what is moving.
    const order = (t: Torrent) =>
      t.state === "error" || t.state === "missingFiles" ? 0 : t.state === "stalledDL" ? 1 : 2;
    const queue: AppQueueItem[] = [...incomplete]
      .sort((a, b) => order(a) - order(b))
      .slice(0, 25)
      .map((t) => ({
        title: t.name ?? "Unknown torrent",
        status: STATE[t.state ?? ""] ?? t.state ?? "Unknown",
        ...(t.progress !== undefined ? { progressPct: Math.round(t.progress * 100) } : {}),
        ...(mb(t.size) !== undefined ? { sizeMb: mb(t.size) } : {}),
        ...(eta(t.eta) ? { timeLeft: eta(t.eta) } : {}),
        ...(t.state === "error" || t.state === "missingFiles"
          ? { problem: STATE[t.state] }
          : t.state === "stalledDL"
            ? { problem: `Stalled: ${t.num_seeds ?? 0} seeds connected.` }
            : {}),
        ...(t.category ? { via: t.category } : {}),
      }));

    return {
      app: "qbittorrent",
      version: version.replace(/^v/, ""),
      status: worst(issues),
      issues,
      facts: [
        { label: "Connection", value: conn.charAt(0).toUpperCase() + conn.slice(1) },
        {
          label: "Down / up",
          value: `${speed(transfer.dl_info_speed)} / ${speed(transfer.up_info_speed)}`,
        },
        { label: "Downloading", value: `${incomplete.length} (${stalled.length} stalled)` },
      ],
      queue,
      queueTotal: incomplete.length,
      activity: [],
      connections: [
        {
          name: "Internet (peers)",
          ok: conn === "connected",
          detail:
            conn === "connected"
              ? `${transfer.dht_nodes ?? 0} DHT nodes`
              : conn === "firewalled"
                ? "Firewalled: incoming connections blocked"
                : "Disconnected",
        },
      ],
    };
  } finally {
    // Sign out again; nothing is left open.
    await call("/api/v2/auth/logout", { method: "POST", cookie }).catch(() => undefined);
  }
}
