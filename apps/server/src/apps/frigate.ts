import { createHash } from "node:crypto";
import type { AppIssue, AppReport, FrigateDashboard } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Frigate, through its API on its signed-in port (8971), with a username and password from the
 * vault. It signs in once (POST /api/login) and keeps the session cookie in memory, signing in again
 * when Frigate forgets it. Checked against a throwaway ghcr.io/blakeblackshear/frigate 0.18.2.
 *
 * Frigate's config holds each camera's stream address, which usually carries the camera's own
 * password, so this never reads /api/config: cameras come from /api/stats, which has none. It never
 * fetches an image or clip either. The password and session never leave this file.
 */

export class FrigateError extends Error {}

export interface FrigateLogin {
  username: string;
  password: string;
}

type Answer = Awaited<ReturnType<Fetch>>;

async function call(
  fetchImpl: Fetch,
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Answer> {
  try {
    return await fetchImpl(joinUrl(base, `/api${path}`), {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Frigate did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Sessions by server and login fingerprint, so a changed password signs in afresh. */
const SESSIONS = new Map<string, string>();
const keyOf = (base: string, login: FrigateLogin) =>
  `${base}#${createHash("sha256").update(`${login.username}\n${login.password}`).digest("hex").slice(0, 16)}`;

async function signIn(fetchImpl: Fetch, base: string, login: FrigateLogin): Promise<string> {
  const res = await call(
    fetchImpl,
    base,
    "POST",
    "/login",
    {},
    { user: login.username, password: login.password },
  );
  if (res.status === 401 || res.status === 400)
    throw new AppKeyError(
      "Frigate refused the username or password. Check the login in the vault.",
    );
  if (res.status === 429)
    throw new AppKeyError(
      "Frigate is refusing sign-ins for a while after too many tries. Try again later.",
    );
  const cookie = String(res.headers?.get("set-cookie") ?? "");
  const token = /frigate_token=([^;,\s]+)/.exec(cookie)?.[1];
  // Frigate's internal port (5000) needs no sign-in and sets no cookie: requests then go without one.
  if (!res.ok && !token) throw new FrigateError(`Frigate could not sign in: answer ${res.status}.`);
  return token ?? "";
}

/** One request with the session, signing in again once if Frigate forgot it. */
export async function fr<T>(
  fetchImpl: Fetch,
  base: string,
  login: FrigateLogin,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const k = keyOf(base, login);
  for (let attempt = 0; attempt < 2; attempt++) {
    let token = SESSIONS.get(k);
    if (token === undefined) {
      token = await signIn(fetchImpl, base, login);
      SESSIONS.set(k, token);
    }
    const res = await call(
      fetchImpl,
      base,
      method,
      path,
      token ? { Cookie: `frigate_token=${token}` } : {},
      body,
    );
    if (res.status === 401) {
      SESSIONS.delete(k);
      continue;
    }
    if (res.status === 403)
      throw new AppKeyError("Frigate says this user cannot do that. Use an administrator's login.");
    const text = (await res.text?.()) ?? "";
    if (!res.ok) {
      const said = /"(?:message|detail)"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
      throw new FrigateError(
        `Frigate refused ${method} ${path.split("?")[0]}: ${redactLine(said ?? `answer ${res.status}`)}.`,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // /api/version answers plain text.
      return text.trim() as T;
    }
  }
  throw new AppKeyError("Frigate keeps refusing the session. Check the login in the vault.");
}

interface RawCamera {
  camera_fps?: number;
  expected_fps?: number;
  detection_enabled?: boolean;
  connection_quality?: string;
  reconnects_last_hour?: number;
}
interface RawStats {
  cameras?: Record<string, RawCamera>;
  detectors?: Record<string, { inference_speed?: number }>;
  service?: {
    uptime?: number;
    version?: string;
    latest_version?: string;
    storage?: Record<string, { total?: number; used?: number; free?: number }>;
  };
}
interface RawEvent {
  id: string;
  camera: string;
  label: string;
  start_time?: number;
  has_snapshot?: boolean;
  retain_indefinitely?: boolean;
}

const gb = (mb?: number) => Math.round(((mb ?? 0) / 1024) * 10) / 10;

export async function frigateDashboard(
  fetchImpl: Fetch,
  base: string,
  login: FrigateLogin,
): Promise<FrigateDashboard> {
  const get = <T>(path: string) => fr<T>(fetchImpl, base, login, "GET", path);
  const [stats, events, review, recordings] = await Promise.all([
    get<RawStats>("/stats"),
    get<RawEvent[]>("/events?limit=20"),
    get<
      Record<
        string,
        {
          total_alert?: number;
          total_detection?: number;
          reviewed_alert?: number;
          reviewed_detection?: number;
        }
      >
    >("/review/summary").catch(
      () =>
        ({}) as Record<
          string,
          {
            total_alert?: number;
            total_detection?: number;
            reviewed_alert?: number;
            reviewed_detection?: number;
          }
        >,
    ),
    get<Record<string, { usage?: number | null }>>("/recordings/storage").catch(
      () => ({}) as Record<string, { usage?: number | null }>,
    ),
  ]);
  const svc = stats.service ?? {};
  const disk = svc.storage?.["/media/frigate/recordings"];
  const latest =
    svc.latest_version && /^\d/.test(svc.latest_version) ? svc.latest_version : undefined;
  const day = review.last24Hours ?? {};
  return {
    app: "frigate",
    ...(svc.version ? { version: svc.version } : {}),
    ...(latest ? { latest } : {}),
    ...(typeof svc.uptime === "number" ? { uptime: svc.uptime } : {}),
    cameras: Object.entries(stats.cameras ?? {}).map(([name, c]) => {
      const usage = recordings[name]?.usage;
      return {
        name,
        fps: Math.round((c.camera_fps ?? 0) * 10) / 10,
        ...(c.expected_fps ? { expectedFps: c.expected_fps } : {}),
        detecting: Boolean(c.detection_enabled),
        online: (c.camera_fps ?? 0) > 0,
        ...(c.connection_quality ? { connection: c.connection_quality } : {}),
        reconnects: c.reconnects_last_hour ?? 0,
        ...(typeof usage === "number" ? { storageMb: Math.round(usage) } : {}),
      };
    }),
    detectors: Object.entries(stats.detectors ?? {}).map(([name, d]) => ({
      name,
      inferenceMs: Math.round((d.inference_speed ?? 0) * 10) / 10,
    })),
    events: (events ?? []).map((e) => ({
      id: e.id,
      camera: e.camera,
      label: e.label,
      at: e.start_time ? new Date(e.start_time * 1000).toISOString() : "",
      snapshot: Boolean(e.has_snapshot),
      kept: Boolean(e.retain_indefinitely),
    })),
    alertsToday: day.total_alert ?? 0,
    detectionsToday: day.total_detection ?? 0,
    unreviewed:
      (day.total_alert ?? 0) -
      (day.reviewed_alert ?? 0) +
      (day.total_detection ?? 0) -
      (day.reviewed_detection ?? 0),
    ...(disk?.total
      ? { storage: { usedGb: gb(disk.used), totalGb: gb(disk.total), freeGb: gb(disk.free) } }
      : {}),
  };
}

/** A detector slower than this per frame falls behind with a few cameras. */
const SLOW_MS = 100;

export async function readFrigate(
  base: string,
  login: FrigateLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await frigateDashboard(fetchImpl, base, login);
  const issues: AppIssue[] = [];
  const down = d.cameras.filter((c) => !c.online);
  if (down.length)
    issues.push({
      level: down.length === d.cameras.length ? "error" : "warning",
      key: "camera-offline",
      text:
        down.length === 1
          ? `Frigate gets no picture from ${down[0]!.name}.`
          : `Frigate gets no picture from ${down.length} cameras.`,
    });
  if (d.storage && d.storage.totalGb && d.storage.freeGb / d.storage.totalGb < 0.05)
    issues.push({
      level: "warning",
      key: "storage",
      text: `Frigate's recordings disk is almost full (${d.storage.freeGb} GB free).`,
    });
  const slow = d.detectors.filter((x) => x.inferenceMs > SLOW_MS);
  if (slow.length)
    issues.push({
      level: "warning",
      key: "detector-slow",
      text: `Frigate's detector ${slow[0]!.name} takes ${slow[0]!.inferenceMs} ms a frame: it may miss things.`,
    });
  return {
    app: "frigate",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Cameras",
        value: `${d.cameras.filter((c) => c.online).length} of ${d.cameras.length} online`,
      },
      { label: "Alerts today", value: String(d.alertsToday) },
    ],
  };
}
