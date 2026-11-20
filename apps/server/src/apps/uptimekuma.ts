import { createHash } from "node:crypto";
import type {
  AppReport,
  KumaDashboard,
  KumaEvent,
  KumaMonitor,
  KumaStatus,
} from "@dragon-control/core";
import { AppBlockedError, AppKeyError, worst, type Fetch } from "./http";
import { SocketSession } from "./socketio";

/**
 * Uptime Kuma, through its own socket (socket.io: it has no REST API for monitors), signed in with
 * the username and password from the vault. Checked against throwaway louislam/uptime-kuma
 * containers, 1.23.17 and 2.5.9.
 *
 * A sign-in gives a token, which Hearth keeps and signs in with next time (loginByToken), so the
 * password is sent once, not every 30 seconds: Uptime Kuma allows 20 password sign-ins a minute.
 * Monitor settings carry passwords, tokens, headers and connection strings, and notifications
 * carry webhook addresses: Hearth reads only the fields it shows and never passes Uptime Kuma's
 * own objects through. The password and token never leave this file.
 */

export class KumaError extends Error {}

export interface KumaLogin {
  username: string;
  password: string;
}

const TOKENS = new Map<string, { key: string; token: string }>();

/** Forget the sign-in tokens (tests). */
export function forgetKumaTokens() {
  TOKENS.clear();
}

const keyOf = (l: KumaLogin) =>
  createHash("sha256").update(`${l.username}\n${l.password}`).digest("hex");

const STATUS: Record<number, KumaStatus> = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };

/** Its major version: the socket's events differ a little between 1.x and 2.x. */
export const majorOf = (version?: string) => Number(/^v?(\d+)/.exec(version ?? "")?.[1] ?? 0);

/** A signed-in session; close it when done. */
export async function kumaSession(
  fetchImpl: Fetch,
  base: string,
  login: KumaLogin,
): Promise<SocketSession> {
  const s = await SocketSession.connect(fetchImpl, base, "Uptime Kuma");
  try {
    const key = keyOf(login);
    const kept = TOKENS.get(base);
    if (kept?.key === key) {
      const r = await s.ask<{ ok?: boolean }>("loginByToken", [kept.token]);
      if (r?.ok) return s;
      TOKENS.delete(base);
    }
    const r = await s.ask<{ ok?: boolean; token?: string; tokenRequired?: boolean; msg?: string }>(
      "login",
      [{ username: login.username, password: login.password, token: "" }],
    );
    if (r?.tokenRequired)
      throw new AppKeyError(
        "Uptime Kuma asks for a two-factor code for this user: Hearth cannot sign in while two-factor sign-in is on (Settings > Security).",
      );
    if (!r?.ok) {
      if (/too frequently/i.test(r?.msg ?? ""))
        throw new AppBlockedError("Uptime Kuma is refusing sign-ins for a minute.");
      throw new AppKeyError(
        "Uptime Kuma refused the username or password. Check the login in the vault.",
      );
    }
    if (r.token) TOKENS.set(base, { key, token: r.token });
    return s;
  } catch (error) {
    await s.close();
    throw error;
  }
}

interface RawMonitor {
  id: number;
  name: string;
  type: string;
  url?: string | null;
  hostname?: string | null;
  port?: number | null;
  docker_container?: string | null;
  parent?: number | null;
  pathName?: string;
  active?: boolean | number;
  interval?: number;
  notificationIDList?: Record<string, boolean>;
  tags?: { name?: string; value?: string | null }[];
}

interface RawBeat {
  status: number;
  time: string;
  msg?: string;
  ping?: number | null;
  important?: boolean | number;
  monitor_id?: number;
  monitorID?: number;
}

/** Uptime Kuma writes its times in UTC without a zone ("2026-11-08 02:43:51.727"). */
export const kumaTime = (t: string) =>
  /[zZ]|[+-]\d\d:?\d\d$/.test(t) ? new Date(t).toISOString() : `${t.replace(" ", "T")}Z`;

/** An address without its password, query string or fragment (those can hold secrets). */
export function cleanUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** What a monitor checks, in a form safe to show. */
export function targetOf(m: RawMonitor): string | undefined {
  if (["http", "keyword", "json-query", "real-browser", "grpc-keyword"].includes(m.type))
    return cleanUrl(m.url);
  if (m.type === "docker") return m.docker_container ?? undefined;
  if (m.type === "push" || m.type === "group") return undefined;
  if (m.hostname) return m.port ? `${m.hostname}:${m.port}` : m.hostname;
  return undefined;
}

const toBeat = (b: RawBeat) => ({
  status: STATUS[b.status] ?? "pending",
  at: kumaTime(b.time),
  ...(typeof b.ping === "number" ? { pingMs: b.ping } : {}),
});

/** Reads everything the panel shows in one signed-in session. */
export async function kumaDashboard(
  fetchImpl: Fetch,
  base: string,
  login: KumaLogin,
  waitMs = 15_000,
): Promise<KumaDashboard> {
  const s = await kumaSession(fetchImpl, base, login);
  try {
    // Uptime Kuma 2 holds back heartbeats until the page says it has drawn the monitor list.
    await s.send("dashboardRendered");
    const monitorsOf = () =>
      (s.all("monitorList").at(-1)?.[0] ?? undefined) as Record<string, RawMonitor> | undefined;
    const ids = () => Object.keys(monitorsOf() ?? {});
    const has = (name: string, id: string, extra?: (a: unknown[]) => boolean) =>
      s.all(name).some((a) => String(a[0]) === id && (!extra || extra(a)));
    await s.waitFor(() => {
      const list = monitorsOf();
      if (!list || !s.all("info").some((a) => (a[0] as { version?: string })?.version))
        return false;
      return ids().every(
        (id) => has("heartbeatList", id) && has("uptime", id, (a) => String(a[1]) === "720"),
      );
    }, waitMs);
    // Certificates come just after each monitor's uptime.
    await s.waitFor(() => false, 300);
    const info = (s.all("info").find((a) => (a[0] as { version?: string })?.version)?.[0] ??
      {}) as { version?: string; latestVersion?: string };
    const raw = Object.values(monitorsOf() ?? {});
    const v2 = majorOf(info.version) >= 2;

    const beatsOf = new Map<number, RawBeat[]>();
    for (const [id, list] of s.all("heartbeatList"))
      beatsOf.set(Number(id), (list as RawBeat[]) ?? []);
    const important = new Map<number, RawBeat[]>();
    for (const [id, list] of s.all("importantHeartbeatList"))
      important.set(Number(id), (list as RawBeat[]) ?? []);
    if (v2) {
      // 2.x sends state changes on request, a page at a time.
      const pages = await Promise.all(
        raw.slice(0, 100).map((m) =>
          s
            .ask<{ ok?: boolean; data?: RawBeat[] }>(
              "monitorImportantHeartbeatListPaged",
              [m.id, 0, 10],
              8000,
            )
            .then((r) => [m.id, r?.data ?? []] as const)
            .catch(() => [m.id, [] as RawBeat[]] as const),
        ),
      );
      for (const [id, list] of pages) important.set(id, list);
    }
    const uptime = (id: number, period: string) => {
      const u = s
        .all("uptime")
        .filter((a) => Number(a[0]) === id && String(a[1]) === period)
        .at(-1)?.[2];
      return typeof u === "number" ? u : undefined;
    };
    const avg = (id: number) => {
      const a = s
        .all("avgPing")
        .filter((x) => Number(x[0]) === id)
        .at(-1)?.[1];
      return typeof a === "number" ? a : undefined;
    };
    const cert = (id: number) => {
      const c = s
        .all("certInfo")
        .filter((x) => Number(x[0]) === id)
        .at(-1)?.[1];
      if (typeof c !== "string") return undefined;
      try {
        const j = JSON.parse(c) as { valid?: boolean; certInfo?: { daysRemaining?: number } };
        return typeof j.certInfo?.daysRemaining === "number"
          ? { days: j.certInfo.daysRemaining, valid: j.valid !== false }
          : undefined;
      } catch {
        return undefined;
      }
    };
    const byId = new Map(raw.map((m) => [m.id, m]));
    const monitors: KumaMonitor[] = raw.map((m) => {
      const beats = [...(beatsOf.get(m.id) ?? [])].sort((a, b) => a.time.localeCompare(b.time));
      const last = beats.at(-1);
      const changes = [...(important.get(m.id) ?? []), ...beats.filter((b) => b.important)].sort(
        (a, b) => a.time.localeCompare(b.time),
      );
      const active = m.active === true || m.active === 1;
      const status: KumaStatus = !active
        ? "paused"
        : last
          ? (STATUS[last.status] ?? "pending")
          : "pending";
      const group = m.parent
        ? (byId.get(m.parent)?.pathName ?? byId.get(m.parent)?.name)
        : undefined;
      const c = cert(m.id);
      const target = targetOf(m);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        ...(target ? { target } : {}),
        ...(group ? { group } : {}),
        ...(m.parent ? { parentId: m.parent } : {}),
        status,
        ...(last?.msg ? { message: last.msg.slice(0, 300) } : {}),
        ...(changes.at(-1) ? { since: kumaTime(changes.at(-1)!.time) } : {}),
        ...(typeof last?.ping === "number" ? { pingMs: last.ping } : {}),
        ...(avg(m.id) !== undefined ? { avgPingMs: avg(m.id)! } : {}),
        ...(uptime(m.id, "24") !== undefined ? { uptime24h: uptime(m.id, "24")! } : {}),
        ...(uptime(m.id, "720") !== undefined ? { uptime30d: uptime(m.id, "720")! } : {}),
        ...(c ? { certDaysLeft: c.days, certValid: c.valid } : {}),
        intervalSeconds: m.interval ?? 60,
        alerts: Object.values(m.notificationIDList ?? {}).filter(Boolean).length,
        tags: (m.tags ?? [])
          .map((t) => (t.value ? `${t.name}: ${t.value}` : (t.name ?? "")))
          .filter(Boolean),
        beats: beats.slice(-40).map(toBeat),
      };
    });
    const events: KumaEvent[] = [];
    for (const m of raw)
      for (const b of important.get(m.id) ?? [])
        events.push({
          monitorId: m.id,
          monitor: m.name,
          status: STATUS[b.status] ?? "pending",
          at: kumaTime(b.time),
          ...(b.msg ? { message: b.msg.slice(0, 300) } : {}),
        });
    events.sort((a, b) => b.at.localeCompare(a.at));
    const maint = (s.all("maintenanceList").at(-1)?.[0] ?? {}) as Record<
      string,
      { id: number; title: string; status?: string; active?: boolean | number }
    >;
    const pages = (s.all("statusPageList").at(-1)?.[0] ?? {}) as Record<
      string,
      { slug: string; title: string; published?: boolean | number }
    >;
    const notes = (s.all("notificationList").at(-1)?.[0] ?? []) as { name?: string }[];
    return {
      app: "uptimekuma",
      ...(info.version ? { version: info.version } : {}),
      ...(info.latestVersion && info.latestVersion !== info.version
        ? { latestVersion: info.latestVersion }
        : {}),
      monitors: monitors.sort((a, b) =>
        `${a.group ?? ""}/${a.name}`.localeCompare(`${b.group ?? ""}/${b.name}`),
      ),
      events: events.slice(0, 50),
      maintenance: Object.values(maint).map((x) => ({
        id: x.id,
        title: x.title,
        status: x.status ?? "unknown",
        active: x.active === true || x.active === 1,
      })),
      statusPages: Object.values(pages).map((p) => ({
        slug: p.slug,
        title: p.title,
        published: p.published !== false && p.published !== 0,
      })),
      notifications: (Array.isArray(notes) ? notes : []).map((n) => n.name ?? "").filter(Boolean),
    };
  } finally {
    await s.close();
  }
}

const DAYS_WARN = 14;

/** The health check: monitors down, certificates running out. */
export async function readUptimeKuma(
  base: string,
  login: KumaLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await kumaDashboard(fetchImpl, base, login);
  const issues: AppReport["issues"] = [];
  const checks = d.monitors.filter((m) => m.type !== "group");
  const down = checks.filter((m) => m.status === "down");
  if (down.length)
    issues.push({
      level: "warning",
      key: "monitors-down",
      text: `Uptime Kuma sees ${down.map((m) => m.name).join(", ")} down.`,
    });
  const certs = checks.filter(
    (m) => m.certDaysLeft !== undefined && (m.certDaysLeft < DAYS_WARN || m.certValid === false),
  );
  if (certs.length)
    issues.push({
      level: "warning",
      key: "certificates-expiring",
      text: `The certificate for ${certs.map((m) => m.name).join(", ")} ${certs.length === 1 ? "is" : "are"} invalid or expires within two weeks.`,
    });
  return {
    app: "uptimekuma",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Monitors up",
        value: `${checks.filter((m) => m.status === "up").length} of ${checks.length}`,
      },
      ...(down.length ? [{ label: "Down", value: String(down.length) }] : []),
      ...(checks.some((m) => m.status === "paused")
        ? [{ label: "Paused", value: String(checks.filter((m) => m.status === "paused").length) }]
        : []),
    ],
  };
}

/** A signed-in session with Uptime Kuma's version read, for a change; closed afterwards. */
export async function withKuma<T>(
  fetchImpl: Fetch,
  base: string,
  login: KumaLogin,
  fn: (s: SocketSession, major: number) => Promise<T>,
): Promise<T> {
  const s = await kumaSession(fetchImpl, base, login);
  try {
    const version = () =>
      (
        s.all("info").find((a) => (a[0] as { version?: string })?.version)?.[0] as
          { version?: string } | undefined
      )?.version;
    await s.waitFor(() => Boolean(version()), 5000);
    return await fn(s, majorOf(version()));
  } finally {
    await s.close();
  }
}
