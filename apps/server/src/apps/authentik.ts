import type { AppIssue, AppReport, AuthentikDashboard } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Authentik, through its API with an administrator's API token from the vault (Authorization:
 * Bearer). Checked against a throwaway ghcr.io/goauthentik/server 2026.8.5.
 *
 * Authentik holds everyone's sign-in secrets, so this reads only what is safe to show and copies
 * fields by name:
 * - never /admin/system/: it echoes the request's own headers, the token among them;
 * - never an event's context: a failed sign-in's context carries a password field;
 * - never a task's logs, a provider's settings, or a certificate's key or download link.
 * The token never leaves this file.
 */

export class AuthentikError extends Error {}

export async function ak<T>(
  fetchImpl: Fetch,
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, `/api/v3${path}`), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Authentik did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    // Authentik answers 403 both for a token it does not know and for one without the right.
    const text = (await res.text?.().catch(() => "")) ?? "";
    if (res.status === 401 || /token invalid|expired|not authenticated/i.test(text))
      throw new AppKeyError("Authentik refused the API token. Check the token in the vault.");
    throw new AppKeyError(
      "Authentik says this token cannot see that. Use a token of an administrator (a superuser).",
    );
  }
  if (!res.ok) {
    const text = (await res.text?.().catch(() => "")) ?? "";
    const said = /"detail"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
    throw new AuthentikError(
      `Authentik refused ${method} ${path.split("?")[0]}: ${redactLine(said ?? `answer ${res.status}`)}.`,
    );
  }
  const text = (await res.text?.()) ?? "";
  // Authentik answers its web page for a path it does not know.
  if (text.trimStart().startsWith("<"))
    throw new AuthentikError(`Authentik has no ${path.split("?")[0]} in this version.`);
  return (text ? JSON.parse(text) : undefined) as T;
}

type Page<T> = { pagination?: { count?: number }; results?: T[] };

interface RawEvent {
  created?: string;
  client_ip?: string | null;
  user?: { username?: string };
}
interface RawUser {
  pk: number;
  username: string;
  name?: string;
  is_active?: boolean;
  is_superuser?: boolean;
  last_login?: string | null;
  type?: string;
}
interface RawApp {
  slug: string;
  name: string;
  meta_launch_url?: string;
  provider_obj?: { verbose_name?: string; name?: string } | null;
}
interface RawOutpost {
  pk: string;
  name: string;
  type?: string;
}
interface RawHealth {
  last_seen?: string;
  version_outdated?: boolean;
}
interface RawTask {
  message_id: string;
  uid?: string;
  actor_name?: string;
  description?: string;
  mtime?: string;
}
interface RawCert {
  name: string;
  cert_expiry?: string | null;
  managed?: string | null;
}

const DAY = 86_400_000;
/** An outpost that has not checked in for this long is shown as not healthy. */
const OUTPOST_STALE = 10 * 60_000;
/** Certificates expiring within this many days are listed. */
const CERT_DAYS = 30;

/** "https://paperless.example.com/" as "paperless.example.com". */
const hostOf = (url?: string) => {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
};

export async function authentikDashboard(
  fetchImpl: Fetch,
  base: string,
  token: string,
): Promise<AuthentikDashboard> {
  const get = <T>(path: string) => ak<T>(fetchImpl, base, token, "GET", path);
  const [version, logins, failed, users, apps, outposts, workers, status, failedTasks, certs] =
    await Promise.all([
      get<{
        version_current?: string;
        version_latest?: string;
        version_latest_valid?: boolean;
        outdated?: boolean;
      }>("/admin/version/"),
      get<Page<RawEvent>>("/events/events/?action=login&ordering=-created&page_size=200"),
      get<Page<RawEvent>>("/events/events/?action=login_failed&ordering=-created&page_size=200"),
      get<Page<RawUser>>("/core/users/?page_size=200&include_groups=false&include_roles=false"),
      get<Page<RawApp>>("/core/applications/?page_size=200"),
      get<Page<RawOutpost>>("/outposts/instances/?page_size=50"),
      get<unknown[]>("/tasks/workers/").catch(() => [] as unknown[]),
      get<Record<string, number>>("/tasks/tasks/status/").catch(
        () => ({}) as Record<string, number>,
      ),
      get<Page<RawTask>>(
        "/tasks/tasks/?aggregated_status=error&ordering=-mtime&page_size=20",
      ).catch(() => ({ results: [] }) as Page<RawTask>),
      get<Page<RawCert>>("/crypto/certificatekeypairs/?page_size=100"),
    ]);
  const health = await Promise.all(
    (outposts.results ?? []).map((o) =>
      get<RawHealth[]>(`/outposts/instances/${encodeURIComponent(o.pk)}/health/`).catch(
        () => [] as RawHealth[],
      ),
    ),
  );
  const now = Date.now();
  const lastDay = (e: RawEvent) => Boolean(e.created && now - Date.parse(e.created) < DAY);
  const failedToday = (failed.results ?? []).filter(lastDay);
  // Service accounts (outposts) are Authentik's own, not people.
  const people = (users.results ?? []).filter(
    (u) => u.type !== "internal_service_account" && !u.username.startsWith("ak-outpost-"),
  );
  return {
    app: "authentik",
    ...(version.version_current ? { version: version.version_current } : {}),
    ...(version.version_latest_valid && version.version_latest
      ? { latest: version.version_latest }
      : {}),
    outdated: Boolean(version.outdated),
    signIns: (logins.results ?? []).filter(lastDay).length,
    failedSignIns: failedToday.slice(0, 20).map((e) => ({
      username: e.user?.username ?? "(unknown)",
      at: e.created!,
      ...(e.client_ip ? { ip: e.client_ip } : {}),
    })),
    failedCount: failedToday.length,
    users: people.map((u) => ({
      id: u.pk,
      username: u.username,
      name: u.name ?? "",
      active: u.is_active !== false,
      admin: Boolean(u.is_superuser),
      ...(u.last_login ? { lastLogin: u.last_login } : {}),
    })),
    activeUsers: people.filter((u) => u.is_active !== false).length,
    applications: (apps.results ?? []).map((a) => {
      const protects = hostOf(a.meta_launch_url);
      const provider = a.provider_obj?.verbose_name;
      return {
        slug: a.slug,
        name: a.name,
        ...(protects ? { protects } : {}),
        ...(provider ? { provider } : {}),
      };
    }),
    outposts: (outposts.results ?? []).map((o, i) => {
      const seen = (health[i] ?? [])
        .map((h) => h.last_seen)
        .filter((t): t is string => Boolean(t))
        .sort()
        .pop();
      return {
        id: o.pk,
        name: o.name,
        type: o.type ?? "",
        healthy: Boolean(seen && now - Date.parse(seen) < OUTPOST_STALE),
        ...(seen ? { lastSeen: seen } : {}),
        outdated: (health[i] ?? []).some((h) => h.version_outdated),
      };
    }),
    workers: workers.length,
    tasks: {
      failed: status.error ?? 0,
      warning: status.warning ?? 0,
      running: (status.running ?? 0) + (status.preprocess ?? 0) + (status.postprocess ?? 0),
      queued: status.queued ?? 0,
    },
    failedTasks: (failedTasks.results ?? []).map((t) => ({
      id: t.message_id,
      name: t.uid ?? t.actor_name ?? "",
      description: t.description ?? "",
      at: t.mtime ?? "",
    })),
    certificates: (certs.results ?? [])
      .filter((c) => c.cert_expiry)
      .map((c) => ({
        name: c.name,
        expires: c.cert_expiry!,
        days: Math.round((Date.parse(c.cert_expiry!) - now) / DAY),
      }))
      .filter((c) => c.days <= CERT_DAYS)
      .sort((a, b) => a.days - b.days),
  };
}

/** Failed sign-ins in a day that are worth a warning. */
const FAILED_WARN = 10;

export async function readAuthentik(
  base: string,
  token: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await authentikDashboard(fetchImpl, base, token);
  const issues: AppIssue[] = [];
  if (d.workers === 0)
    issues.push({
      level: "error",
      key: "no-worker",
      text: "Authentik's worker is not running: emails, outposts and clean-ups wait.",
    });
  const down = d.outposts.filter((o) => !o.healthy);
  if (down.length)
    issues.push({
      level: "warning",
      key: "outpost-down",
      text:
        down.length === 1
          ? `Authentik's outpost "${down[0]!.name}" has not checked in.`
          : `${down.length} Authentik outposts have not checked in.`,
    });
  if (d.failedCount >= FAILED_WARN)
    issues.push({
      level: "warning",
      key: "failed-sign-ins",
      text: `${d.failedCount} sign-ins to Authentik failed in the last day.`,
    });
  if (d.tasks.failed)
    issues.push({
      level: "warning",
      key: "tasks-failed",
      text: `${d.tasks.failed === 1 ? "1 background task" : `${d.tasks.failed} background tasks`} failed in Authentik.`,
    });
  const expiring = d.certificates.filter((c) => c.days <= 14);
  if (expiring.length)
    issues.push({
      level: expiring.some((c) => c.days < 0) ? "error" : "warning",
      key: "certificate",
      text:
        expiring[0]!.days < 0
          ? `Authentik's certificate "${expiring[0]!.name}" has expired.`
          : `Authentik's certificate "${expiring[0]!.name}" expires in ${expiring[0]!.days} days.`,
    });
  return {
    app: "authentik",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Sign-ins today", value: String(d.signIns) },
      { label: "Failed today", value: String(d.failedCount) },
    ],
  };
}
