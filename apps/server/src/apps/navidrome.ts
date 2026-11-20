import { createHash } from "node:crypto";
import type { AppIssue, AppReport, NavidromeDashboard } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Navidrome, signed in once with an administrator's username and password from the vault
 * (/auth/login), then through its own API with the session token and its Subsonic API with the
 * Subsonic token the sign-in returns: the password is not sent again until the session ends.
 * Checked against a throwaway deluan/navidrome 0.64.2.
 *
 * Navidrome locks an account out after a few failed sign-ins, so a refused password is never
 * retried. The tokens never leave this file.
 */

export class NavidromeError extends Error {}

export interface NdLogin {
  username: string;
  password: string;
}

interface Session {
  key: string;
  jwt: string;
  user: string;
  subsonic: string;
  salt: string;
}

const SESSIONS = new Map<string, Session>();

/** Forget the sessions (tests). */
export function forgetNavidromeSessions() {
  SESSIONS.clear();
}

const keyOf = (l: NdLogin) =>
  createHash("sha256").update(`${l.username}\n${l.password}`).digest("hex");

async function send(
  fetchImpl: Fetch,
  base: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  try {
    return await fetchImpl(joinUrl(base, path), {
      method: init.method ?? "GET",
      headers: { Accept: "application/json", ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Navidrome did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function session(
  fetchImpl: Fetch,
  base: string,
  login: NdLogin,
  fresh = false,
): Promise<Session> {
  const key = keyOf(login);
  const kept = SESSIONS.get(base);
  if (!fresh && kept?.key === key) return kept;
  const res = await send(fetchImpl, base, "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: login.username, password: login.password }),
  });
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError(
      "Navidrome refused the username or password. Check the login in the vault (Navidrome locks an account for a while after a few wrong tries).",
    );
  if (!res.ok) throw new NavidromeError(`Navidrome's sign-in answered ${res.status}.`);
  const r = (await res.json()) as {
    token?: string;
    isAdmin?: boolean;
    subsonicToken?: string;
    subsonicSalt?: string;
  };
  if (!r.token || !r.subsonicToken || !r.subsonicSalt)
    throw new NavidromeError("Navidrome's sign-in gave no session.");
  if (!r.isAdmin)
    throw new AppKeyError(
      "This Navidrome account is not an administrator. Hearth needs an administrator's login.",
    );
  const s = {
    key,
    jwt: r.token,
    user: login.username,
    subsonic: r.subsonicToken,
    salt: r.subsonicSalt,
  };
  SESSIONS.set(base, s);
  return s;
}

/** Navidrome's own API (users, libraries, players, missing files). */
export async function nd<T>(
  fetchImpl: Fetch,
  base: string,
  login: NdLogin,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: T; total?: number }> {
  for (const fresh of [false, true]) {
    const s = await session(fetchImpl, base, login, fresh);
    const res = await send(fetchImpl, base, path, {
      method,
      headers: {
        "x-nd-authorization": `Bearer ${s.jwt}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && !fresh) continue;
    // Navidrome renews the session token as it is used.
    const renewed = res.headers?.get("x-nd-authorization")?.replace(/^Bearer /, "");
    if (renewed) s.jwt = renewed;
    if (!res.ok) {
      const text = (await res.text?.().catch(() => "")) ?? "";
      throw new NavidromeError(
        `Navidrome refused ${method} ${path.split("?")[0]}: ${redactLine(text).slice(0, 200) || `answer ${res.status}`}.`,
      );
    }
    const total = Number(res.headers?.get("x-total-count"));
    const text = (await res.text?.()) ?? "";
    return {
      data: (text ? JSON.parse(text) : undefined) as T,
      ...(Number.isFinite(total) ? { total } : {}),
    };
  }
  throw new AppKeyError("Navidrome refused the session.");
}

/** Its Subsonic API (scan status and starting a scan, who is playing now). */
export async function subsonic<T>(
  fetchImpl: Fetch,
  base: string,
  login: NdLogin,
  method: string,
  params: Record<string, string> = {},
): Promise<{ body: T; version?: string }> {
  for (const fresh of [false, true]) {
    const s = await session(fetchImpl, base, login, fresh);
    const q = new URLSearchParams({
      u: s.user,
      t: s.subsonic,
      s: s.salt,
      v: "1.16.1",
      c: "hearth",
      f: "json",
      ...params,
    });
    const res = await send(fetchImpl, base, `/rest/${method}?${q.toString()}`);
    const r = (await res.json().catch(() => ({}))) as {
      "subsonic-response"?: {
        status?: string;
        serverVersion?: string;
        error?: { code?: number; message?: string };
      } & Record<string, unknown>;
    };
    const sr = r["subsonic-response"];
    if (sr?.status === "ok")
      return { body: sr as T, ...(sr.serverVersion ? { version: sr.serverVersion } : {}) };
    if (sr?.error?.code === 40 && !fresh) continue;
    throw new NavidromeError(
      `Navidrome refused ${method}: ${redactLine(sr?.error?.message ?? `answer ${res.status}`)}.`,
    );
  }
  throw new AppKeyError("Navidrome refused the session.");
}

/** An album's cover (Subsonic getCoverArt), for media announcements. Only plain cover ids. */
export async function navidromeCover(
  fetchImpl: Fetch,
  base: string,
  login: NdLogin,
  id: string,
): Promise<{ bytes: Buffer; type: string } | undefined> {
  if (!/^[\w-]{1,80}$/.test(id)) return undefined;
  const s = await session(fetchImpl, base, login);
  const q = new URLSearchParams({
    u: s.user,
    t: s.subsonic,
    s: s.salt,
    v: "1.16.1",
    c: "hearth",
    id,
    size: "600",
  });
  const res = (await send(
    fetchImpl,
    base,
    `/rest/getCoverArt?${q.toString()}`,
  )) as unknown as Response;
  const type = res.headers?.get?.("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/") || typeof res.arrayBuffer !== "function")
    return undefined;
  return { bytes: Buffer.from(await res.arrayBuffer()), type };
}

interface RawLibrary {
  id: number;
  name: string;
  path: string;
  totalSongs?: number;
  totalAlbums?: number;
  totalArtists?: number;
  totalMissingFiles?: number;
  lastScanAt?: string;
}
interface RawUser {
  id: string;
  userName: string;
  name?: string;
  email?: string;
  isAdmin?: boolean;
  lastAccessAt?: string | null;
  lastLoginAt?: string | null;
}
interface RawPlayer {
  id: string;
  name?: string;
  userName?: string;
  client?: string;
  lastSeen?: string;
}
interface RawSong {
  id: string;
  title?: string;
  artist?: string;
  path?: string;
}

const when = (t?: string | null) => (t && !t.startsWith("0001-") ? t : undefined);

export async function navidromeDashboard(
  fetchImpl: Fetch,
  base: string,
  login: NdLogin,
): Promise<NavidromeDashboard> {
  // Sign in first, so the calls below share one session instead of each signing in.
  await session(fetchImpl, base, login);
  const [scan, playing, libs, users, players, missing, playlists, shares] = await Promise.all([
    subsonic<{
      scanStatus?: {
        scanning?: boolean;
        count?: number;
        folderCount?: number;
        lastScan?: string;
        scanType?: string;
      };
    }>(fetchImpl, base, login, "getScanStatus"),
    subsonic<{
      nowPlaying?: {
        entry?: {
          username?: string;
          title?: string;
          artist?: string;
          album?: string;
          playerName?: string;
          minutesAgo?: number;
        }[];
      };
    }>(fetchImpl, base, login, "getNowPlaying"),
    nd<RawLibrary[]>(fetchImpl, base, login, "GET", "/api/library"),
    nd<RawUser[]>(fetchImpl, base, login, "GET", "/api/user?_sort=userName&_order=ASC"),
    nd<RawPlayer[]>(
      fetchImpl,
      base,
      login,
      "GET",
      "/api/player?_sort=lastSeen&_order=DESC&_end=50",
    ),
    nd<RawSong[]>(fetchImpl, base, login, "GET", "/api/missing?_end=50"),
    nd<unknown[]>(fetchImpl, base, login, "GET", "/api/playlist?_end=1"),
    nd<unknown[]>(fetchImpl, base, login, "GET", "/api/share?_end=1").catch(() => ({
      data: [],
      total: 0,
    })),
  ]);
  const st = scan.body.scanStatus ?? {};
  return {
    app: "navidrome",
    ...(scan.version ? { version: scan.version.split(" ")[0]! } : {}),
    scan: {
      scanning: st.scanning === true,
      ...(when(st.lastScan) ? { lastScan: st.lastScan! } : {}),
      ...(st.scanType ? { type: st.scanType } : {}),
      files: st.count ?? 0,
      folders: st.folderCount ?? 0,
    },
    libraries: (libs.data ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      path: l.path,
      songs: l.totalSongs ?? 0,
      albums: l.totalAlbums ?? 0,
      artists: l.totalArtists ?? 0,
      missing: l.totalMissingFiles ?? 0,
      ...(when(l.lastScanAt) ? { lastScan: l.lastScanAt! } : {}),
    })),
    nowPlaying: (playing.body.nowPlaying?.entry ?? []).map((e) => ({
      user: e.username ?? "",
      title: e.title ?? "",
      artist: e.artist ?? "",
      album: e.album ?? "",
      player: e.playerName ?? "",
      minutesAgo: e.minutesAgo ?? 0,
    })),
    users: (users.data ?? []).map((u) => {
      const seen = when(u.lastAccessAt) ?? when(u.lastLoginAt);
      return {
        id: u.id,
        userName: u.userName,
        name: u.name || u.userName,
        ...(u.email ? { email: u.email } : {}),
        admin: u.isAdmin === true,
        ...(seen ? { lastSeen: seen } : {}),
      };
    }),
    players: (players.data ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? "",
      user: p.userName ?? "",
      client: p.client ?? "",
      ...(when(p.lastSeen) ? { lastSeen: p.lastSeen! } : {}),
    })),
    missing: (missing.data ?? []).map((m) => ({
      id: m.id,
      title: m.title ?? "",
      artist: m.artist ?? "",
      path: m.path ?? "",
    })),
    missingCount: missing.total ?? (missing.data ?? []).length,
    playlists: playlists.total ?? 0,
    shares: shares.total ?? 0,
  };
}

const STALE_SCAN_DAYS = 7;

export async function readNavidrome(
  base: string,
  login: NdLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await navidromeDashboard(fetchImpl, base, login);
  const issues: AppIssue[] = [];
  if (d.missingCount)
    issues.push({
      level: "warning",
      key: "missing",
      text: `Navidrome can no longer find ${d.missingCount === 1 ? "1 file" : `${d.missingCount} files`} in its library (moved or deleted).`,
    });
  if (
    !d.scan.scanning &&
    d.scan.lastScan &&
    Date.now() - Date.parse(d.scan.lastScan) > STALE_SCAN_DAYS * 86_400_000
  )
    issues.push({
      level: "warning",
      key: "scan-stale",
      text: `Navidrome last scanned its library ${Math.floor((Date.now() - Date.parse(d.scan.lastScan)) / 86_400_000)} days ago: new music does not show until it scans.`,
    });
  const songs = d.libraries.reduce((n, l) => n + l.songs, 0);
  return {
    app: "navidrome",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Songs", value: songs.toLocaleString() },
      { label: "Listening now", value: String(d.nowPlaying.length) },
      ...(d.scan.scanning ? [{ label: "Scan", value: "running" }] : []),
    ],
  };
}
