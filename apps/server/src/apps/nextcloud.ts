import type {
  AppIssue,
  AppReport,
  NextcloudApp,
  NextcloudCheck,
  NextcloudDashboard,
  NextcloudUser,
} from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Nextcloud, through its OCS API (serverinfo, users, groups, apps, app config) and its own setup
 * checks, signed in with an administrator's username and password from the vault. Checked against
 * a throwaway nextcloud:apache 35.0.2.
 *
 * Nextcloud asks for the account's own password before any change ("password confirmation"), so
 * an app password can read but not change anything: Hearth says so plainly rather than failing
 * with Nextcloud's words. The password goes only in the Authorization header and never leaves
 * this file; Hearth reads only the fields it shows and never passes Nextcloud's own objects on.
 */

export class NextcloudError extends Error {}

export interface NextcloudLogin {
  username: string;
  password: string;
}

type Body = Record<string, string | string[]>;

/** A form body as Nextcloud's OCS API takes it (arrays as key[]=a&key[]=b). */
export function form(body: Body): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(body))
    if (Array.isArray(v)) for (const x of v) p.append(`${k}[]`, x);
    else p.append(k, v);
  return p.toString();
}

const auth = (l: NextcloudLogin) =>
  `Basic ${Buffer.from(`${l.username}:${l.password}`).toString("base64")}`;

async function call(
  fetchImpl: Fetch,
  base: string,
  login: NextcloudLogin,
  method: string,
  path: string,
  body?: Body,
) {
  try {
    return await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        Authorization: auth(login),
        "OCS-APIRequest": "true",
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body: form(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Nextcloud did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** One OCS call: its data, or a plain reason. */
export async function ocs<T>(
  fetchImpl: Fetch,
  base: string,
  login: NextcloudLogin,
  method: string,
  path: string,
  body?: Body,
): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await call(fetchImpl, base, login, method, `${path}${sep}format=json`, body);
  let parsed: { ocs?: { meta?: { statuscode?: number; message?: string }; data?: T } } = {};
  try {
    parsed = (await res.json()) as typeof parsed;
  } catch {
    // Not OCS at all (a proxy page, maintenance): the status below says why.
  }
  const meta = parsed.ocs?.meta;
  const code = meta?.statuscode ?? res.status;
  const message = redactLine(meta?.message ?? "").slice(0, 200);
  if (res.status === 401 || code === 997)
    throw new AppKeyError(
      "Nextcloud refused the username or password. Check the login in the vault (two-factor sign-in on that account also stops Hearth).",
    );
  if (/password confirmation/i.test(message))
    throw new NextcloudError(
      "Nextcloud asks for the account's own password before a change, and the vault holds an app password. Save the account's sign-in password in the vault instead.",
    );
  if (res.status === 403 && /admin/i.test(message))
    throw new AppKeyError(
      "Nextcloud says this account is not an administrator. Hearth needs an administrator's login.",
    );
  if (res.status === 503)
    throw new NextcloudError("Nextcloud is in maintenance mode and answers nothing else.");
  if (!res.ok || (code !== 100 && code !== 200))
    throw new NextcloudError(
      `Nextcloud refused ${method} ${path.split("?")[0]}: ${message || `answer ${res.status}`}.`,
    );
  return parsed.ocs?.data as T;
}

interface ServerInfo {
  nextcloud?: {
    system?: {
      version?: string;
      freespace?: number;
      cpuload?: number[];
      cpunum?: number;
      mem_total?: number;
      mem_free?: number;
      "memcache.local"?: string;
      apps?: { num_installed?: number; app_updates?: Record<string, string> | unknown[] };
      update?: { available?: boolean; available_version?: string };
    };
    storage?: { num_users?: number; num_disabled_users?: number; num_files?: number };
    shares?: {
      num_shares?: number;
      num_shares_link?: number;
      num_shares_link_no_password?: number;
      num_fed_shares_sent?: number;
    };
  };
  server?: {
    webserver?: string;
    php?: { version?: string };
    database?: { type?: string; version?: string; size?: number | string };
  };
  activeUsers?: Record<string, number>;
}

interface RawUser {
  id: string;
  displayname?: string;
  "display-name"?: string;
  email?: string | null;
  enabled?: boolean;
  groups?: string[];
  backend?: string;
  lastLogin?: number;
  quota?: { used?: number; quota?: number | string; total?: number };
}

const gb = (bytes?: number) =>
  typeof bytes === "number" && bytes >= 0 ? Math.round((bytes / 1073741824) * 10) / 10 : undefined;

/** A size in Nextcloud's words ("5 GB"), from bytes. */
export function sizeText(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${Math.round(n * 10) / 10} ${units[i]}`;
}

export function toUser(u: RawUser): NextcloudUser {
  const q = u.quota?.quota;
  const bytes = typeof q === "number" ? q : Number.NaN;
  const limited = Number.isFinite(bytes) && bytes >= 0;
  return {
    id: u.id,
    name: u.displayname ?? u["display-name"] ?? u.id,
    ...(u.email ? { email: u.email } : {}),
    enabled: u.enabled !== false,
    admin: (u.groups ?? []).includes("admin"),
    groups: u.groups ?? [],
    ...(limited ? { quotaBytes: bytes } : {}),
    quota: limited ? sizeText(bytes) : "none",
    usedBytes: Math.max(0, u.quota?.used ?? 0),
    ...(u.lastLogin ? { lastLogin: new Date(u.lastLogin).toISOString() } : {}),
    backend: u.backend ?? "Database",
  };
}

/** A config value from Nextcloud's app config ("" when it was never set). */
export const appConfig = (fetchImpl: Fetch, base: string, login: NextcloudLogin, key: string) =>
  ocs<{ data?: string }>(
    fetchImpl,
    base,
    login,
    "GET",
    `/ocs/v2.php/apps/provisioning_api/api/v1/config/apps/core/${key}`,
  ).then((d) => String(d?.data ?? ""));

type RawCheck = {
  name?: string;
  severity?: string;
  description?: string | null;
  linkToDoc?: string | null;
};

/** Checks that judge the request Hearth itself makes, not how people reach Nextcloud. */
const REQUEST_CHECKS =
  /\\(HttpsUrlGeneration|SecurityHeaders|ForwardedForHeaders|BruteForceThrottler)$/;

const CHECKS = new Map<string, { at: number; checks: NextcloudCheck[] }>();
const CHECK_TTL_MS = 5 * 60_000;

/** Forget the cached setup checks (tests, and after a change). */
export function forgetNextcloudChecks() {
  CHECKS.clear();
}

/**
 * Nextcloud's own setup checks (Administration settings > Overview), the ones not passing. They
 * take a moment, so Hearth keeps them for five minutes. A failure here is not Nextcloud failing.
 */
export async function setupChecks(
  fetchImpl: Fetch,
  base: string,
  login: NextcloudLogin,
): Promise<NextcloudCheck[]> {
  const kept = CHECKS.get(base);
  if (kept && Date.now() - kept.at < CHECK_TTL_MS) return kept.checks;
  const res = await call(fetchImpl, base, login, "GET", "/index.php/settings/setupcheck");
  if (!res.ok) return kept?.checks ?? [];
  const raw = (await res.json().catch(() => ({}))) as Record<string, Record<string, RawCheck>>;
  const plainHttp = base.startsWith("http://");
  const checks: NextcloudCheck[] = [];
  for (const group of Object.values(raw ?? {}))
    for (const [id, c] of Object.entries(group ?? {})) {
      const level = c.severity;
      if (level !== "info" && level !== "warning" && level !== "error") continue;
      const own = plainHttp && REQUEST_CHECKS.test(id);
      checks.push({
        id: id.split("\\").at(-1) ?? id,
        name: c.name ?? id,
        level: own ? "info" : level,
        text: redactLine((c.description ?? "").replace(/\s+/g, " ").trim()).slice(0, 400),
        ...(c.linkToDoc && /^https:\/\//.test(c.linkToDoc) ? { link: c.linkToDoc } : {}),
        ...(own ? { hearthsOwn: true } : {}),
      });
    }
  const rank = { error: 0, warning: 1, info: 2 } as const;
  checks.sort((a, b) => rank[a.level] - rank[b.level] || a.name.localeCompare(b.name));
  CHECKS.set(base, { at: Date.now(), checks });
  return checks;
}

const LATE_S = 3600;
const USER_PAGE = 500;

/** A yes or no setting: Nextcloud 32 and later store typed ones as "1" and "0". */
const yes = (v: string) => /^(yes|1|true)$/i.test(v);

/** Everything the panel shows, read in parallel. */
export async function nextcloudDashboard(
  fetchImpl: Fetch,
  base: string,
  login: NextcloudLogin,
): Promise<NextcloudDashboard> {
  const status = await call(fetchImpl, base, login, "GET", "/status.php");
  const st = (status.ok ? await status.json().catch(() => ({})) : {}) as {
    maintenance?: boolean;
    versionstring?: string;
  };
  const empty = {
    app: "nextcloud" as const,
    ...(st.versionstring ? { version: st.versionstring } : {}),
    signedInAs: login.username,
    files: 0,
    accounts: 0,
    disabledAccounts: 0,
    active: { last5min: 0, lastHour: 0, lastDay: 0, lastWeek: 0, lastMonth: 0 },
    shares: { total: 0, links: 0, linksNoPassword: 0, federated: 0 },
    system: {},
    jobs: { mode: "ajax" as const, health: "never" as const },
    apps: { installed: 0, updates: [] },
    checks: [],
    users: [],
    groups: [],
    settings: { linksNeedPassword: false, linksAllowed: true },
  };
  if (st.maintenance) return { ...empty, maintenance: true };

  const cfg = (key: string) => appConfig(fetchImpl, base, login, key).catch(() => "");
  const [info, me, users, groups, lastcron, mode, needPw, allowLinks, checks] = await Promise.all([
    ocs<ServerInfo>(
      fetchImpl,
      base,
      login,
      "GET",
      "/ocs/v2.php/apps/serverinfo/api/v1/info?skipApps=false&skipUpdate=false",
    ),
    ocs<{ id?: string }>(fetchImpl, base, login, "GET", "/ocs/v2.php/cloud/user"),
    ocs<{ users?: Record<string, RawUser> | RawUser[] }>(
      fetchImpl,
      base,
      login,
      "GET",
      `/ocs/v2.php/cloud/users/details?limit=${USER_PAGE}`,
    ),
    ocs<{ groups?: string[] }>(fetchImpl, base, login, "GET", "/ocs/v2.php/cloud/groups"),
    cfg("lastcron"),
    cfg("backgroundjobs_mode"),
    cfg("shareapi_enforce_links_password"),
    cfg("shareapi_allow_links"),
    setupChecks(fetchImpl, base, login).catch(() => [] as NextcloudCheck[]),
  ]);
  const list = (Array.isArray(users?.users) ? users.users : Object.values(users?.users ?? {}))
    .map(toUser)
    .sort((x, y) => x.name.localeCompare(y.name));
  const sys = info?.nextcloud?.system ?? {};
  const storage = info?.nextcloud?.storage ?? {};
  const shares = info?.nextcloud?.shares ?? {};
  const db = info?.server?.database ?? {};
  const a = info?.activeUsers ?? {};
  const updates = sys.apps?.app_updates;
  const last = Number(lastcron) || 0;
  const now = Math.floor(Date.now() / 1000);
  const dbBytes = Number(db.size);
  const memcache = (sys["memcache.local"] ?? "").replace(/^\\?OC\\Memcache\\/, "");
  return {
    ...empty,
    ...(sys.version ? { version: st.versionstring ?? sys.version } : {}),
    ...(sys.update?.available && sys.update.available_version
      ? { updateTo: sys.update.available_version }
      : {}),
    maintenance: false,
    signedInAs: me?.id ?? login.username,
    ...(gb(sys.freespace) !== undefined ? { freeGb: gb(sys.freespace)! } : {}),
    files: storage.num_files ?? 0,
    // serverinfo caches its counts for a while, so count the account list when it is whole.
    accounts:
      list.length && list.length < USER_PAGE ? list.length : (storage.num_users ?? list.length),
    disabledAccounts:
      list.length && list.length < USER_PAGE
        ? list.filter((u) => !u.enabled).length
        : (storage.num_disabled_users ?? 0),
    active: {
      last5min: a.last5minutes ?? 0,
      lastHour: a.last1hour ?? 0,
      lastDay: a.last24hours ?? 0,
      lastWeek: a.last7days ?? 0,
      lastMonth: a.last1month ?? 0,
    },
    shares: {
      total: shares.num_shares ?? 0,
      links: shares.num_shares_link ?? 0,
      linksNoPassword: shares.num_shares_link_no_password ?? 0,
      federated: shares.num_fed_shares_sent ?? 0,
    },
    system: {
      ...(info?.server?.php?.version ? { php: info.server.php.version } : {}),
      ...(db.type ? { database: `${db.type}${db.version ? ` ${db.version}` : ""}` } : {}),
      ...(Number.isFinite(dbBytes) && dbBytes > 0
        ? { databaseMb: Math.round(dbBytes / 1048576) }
        : {}),
      ...(info?.server?.webserver ? { webserver: info.server.webserver } : {}),
      // serverinfo gives memory in KB.
      ...(sys.mem_total ? { memoryGb: Math.round((sys.mem_total / 1048576) * 10) / 10 } : {}),
      ...(sys.mem_free ? { memoryFreeGb: Math.round((sys.mem_free / 1048576) * 10) / 10 } : {}),
      ...(sys.cpuload?.length ? { load: Math.round(sys.cpuload[0]! * 100) / 100 } : {}),
      ...(sys.cpunum ? { cpus: sys.cpunum } : {}),
      ...(memcache ? { memcache } : {}),
    },
    jobs: {
      mode: mode === "cron" || mode === "webcron" ? mode : "ajax",
      ...(last ? { lastRun: new Date(last * 1000).toISOString() } : {}),
      health: !last ? "never" : now - last > LATE_S ? "late" : "ok",
    },
    apps: {
      installed: sys.apps?.num_installed ?? 0,
      updates:
        updates && !Array.isArray(updates)
          ? Object.entries(updates).map(([id, version]) => ({ id, version: String(version) }))
          : [],
    },
    checks,
    users: list,
    groups: groups?.groups ?? [],
    settings: {
      linksNeedPassword: yes(needPw),
      // Allowed unless set off (unset means Nextcloud's default, on).
      linksAllowed: allowLinks === "" || yes(allowLinks),
    },
  };
}

/** Installed apps with their names and updates, for the Apps tab (one call per app). */
export async function nextcloudApps(
  fetchImpl: Fetch,
  base: string,
  login: NextcloudLogin,
): Promise<NextcloudApp[]> {
  const list = (filter: string) =>
    ocs<{ apps?: string[] }>(
      fetchImpl,
      base,
      login,
      "GET",
      `/ocs/v2.php/cloud/apps?filter=${filter}`,
    ).then((d) => d?.apps ?? []);
  const [on, off, info] = await Promise.all([
    list("enabled"),
    list("disabled"),
    ocs<ServerInfo>(
      fetchImpl,
      base,
      login,
      "GET",
      "/ocs/v2.php/apps/serverinfo/api/v1/info?skipApps=false",
    ),
  ]);
  const upd = info?.nextcloud?.system?.apps?.app_updates;
  const updates = upd && !Array.isArray(upd) ? (upd as Record<string, string>) : {};
  const ids = [...on.map((id) => [id, true] as const), ...off.map((id) => [id, false] as const)];
  const out: NextcloudApp[] = [];
  // A few at a time: Nextcloud reads each app's info file for these.
  for (let i = 0; i < ids.length; i += 8) {
    const batch = await Promise.all(
      ids.slice(i, i + 8).map(async ([id, enabled]) => {
        const a = await ocs<{ name?: string; version?: string; summary?: string }>(
          fetchImpl,
          base,
          login,
          "GET",
          `/ocs/v2.php/cloud/apps/${encodeURIComponent(id)}`,
        ).catch(() => undefined);
        const summary = typeof a?.summary === "string" ? a.summary.slice(0, 200) : undefined;
        return {
          id,
          name: typeof a?.name === "string" ? a.name : id,
          ...(typeof a?.version === "string" ? { version: a.version } : {}),
          enabled,
          ...(updates[id] ? { update: String(updates[id]) } : {}),
          ...(summary ? { summary } : {}),
        };
      }),
    );
    out.push(...batch);
  }
  return out.sort((x, y) => Number(y.enabled) - Number(x.enabled) || x.name.localeCompare(y.name));
}

const FREE_WARN_GB = 5;

/** The health check: maintenance, background jobs, setup errors, space, open links. */
export async function readNextcloud(
  base: string,
  login: NextcloudLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await nextcloudDashboard(fetchImpl, base, login);
  const issues: AppIssue[] = [];
  if (d.maintenance)
    issues.push({
      level: "error",
      key: "maintenance",
      text: "Nextcloud is in maintenance mode: nobody can use it until it is turned off.",
    });
  if (!d.maintenance && d.jobs.health !== "ok")
    issues.push({
      level: "warning",
      key: "jobs",
      text:
        d.jobs.health === "never"
          ? "Nextcloud's background jobs have never run."
          : `Nextcloud's background jobs last ran ${Math.round((Date.now() - Date.parse(d.jobs.lastRun!)) / 3600000)} hours ago (${d.jobs.mode} mode). Cleanup, previews and notifications wait until they run.`,
    });
  for (const c of d.checks.filter((x) => x.level === "error"))
    issues.push({
      level: "warning",
      key: `check:${c.id}`,
      text: `${c.name}: ${c.text}`.slice(0, 300),
      ...(c.link ? { link: c.link } : {}),
    });
  if (d.freeGb !== undefined && d.freeGb < FREE_WARN_GB)
    issues.push({
      level: "warning",
      key: "space",
      text: `Nextcloud has ${d.freeGb} GB free for files.`,
    });
  return {
    app: "nextcloud",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: d.maintenance
      ? [{ label: "Maintenance mode", value: "on" }]
      : [
          { label: "Accounts", value: String(d.accounts) },
          ...(d.freeGb !== undefined ? [{ label: "Free space", value: `${d.freeGb} GB` }] : []),
          { label: "Active today", value: String(d.active.lastDay) },
          ...(d.apps.updates.length
            ? [{ label: "App updates", value: String(d.apps.updates.length) }]
            : []),
          ...(d.updateTo ? [{ label: "Update", value: `Nextcloud ${d.updateTo}` }] : []),
          ...(d.shares.linksNoPassword
            ? [{ label: "Links without a password", value: String(d.shares.linksNoPassword) }]
            : []),
        ],
  };
}
