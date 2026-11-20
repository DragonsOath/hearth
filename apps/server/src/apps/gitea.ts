import type { AppIssue, AppReport, GiteaDashboard } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Gitea (and Forgejo, which answers the same API), through its REST API with an administrator's
 * access token from the vault (Authorization: token ...). Checked against a throwaway
 * gitea/gitea 1.27.3 with a pull mirror and two act_runner runners.
 *
 * It reads repositories, pull mirrors, Actions runners and runs, and counts of people. It never
 * asks for a runner registration token, a secret, a deploy key or a file, and the token never
 * leaves this file.
 */

export class GiteaError extends Error {}

export interface GiteaAnswer<T> {
  body: T;
  total?: number;
}

export async function gt<T>(
  fetchImpl: Fetch,
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<GiteaAnswer<T>> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, `/api/v1${path}`), {
      method,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Gitea did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401)
    throw new AppKeyError("Gitea refused the access token. Check the token in the vault.");
  if (res.status === 403)
    throw new AppKeyError(
      "Gitea says this token cannot do that. Use an administrator's token with read and write access to admin and repository.",
    );
  if (!res.ok) {
    const text = (await res.text?.().catch(() => "")) ?? "";
    const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
    throw new GiteaError(
      `Gitea refused ${method} ${path.split("?")[0]}: ${redactLine(said ?? `answer ${res.status}`)}.`,
    );
  }
  const text = (await res.text?.()) ?? "";
  const total = Number(res.headers?.get("x-total-count") ?? NaN);
  return {
    body: (text ? JSON.parse(text) : undefined) as T,
    ...(Number.isFinite(total) ? { total } : {}),
  };
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  owner?: { login?: string };
  private?: boolean;
  mirror?: boolean;
  archived?: boolean;
  size?: number;
  updated_at?: string;
  mirror_interval?: string;
  mirror_updated?: string;
}
interface RawRunner {
  id: number;
  name: string;
  status?: string;
  busy?: boolean;
  disabled?: boolean;
  labels?: { name: string }[];
}
interface RawRun {
  id: number;
  display_title?: string;
  path?: string;
  head_branch?: string;
  status?: string;
  conclusion?: string;
  run_attempt?: number;
  started_at?: string;
  html_url?: string;
  repository?: { name?: string; owner?: { login?: string } };
}
/** A run as Forgejo lists it per repository (it has no site-wide list): one status, no attempts. */
interface RawForgejoRun {
  id: number;
  title?: string;
  workflow_id?: string;
  prettyref?: string;
  status?: string;
  started?: string;
  created?: string;
  repository?: { name?: string; owner?: { login?: string } };
}
const FINISHED = new Set(["success", "failure", "cancelled", "skipped"]);

interface RawUser {
  is_admin?: boolean;
}
interface RawTask {
  name: string;
  schedule: string;
  next?: string;
  prev?: string;
}

const NEVER = /^0001-01-01/;
const when = (t?: string) => (t && !NEVER.test(t) && !t.startsWith("1970-") ? t : undefined);

/** Go's duration ("8h0m0s", "10m0s") in milliseconds, or undefined. */
export function goDuration(text?: string): number | undefined {
  if (!text) return undefined;
  let ms = 0;
  let any = false;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g)) {
    any = true;
    ms += Number(n) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
  }
  return any ? ms : undefined;
}

/** "8h0m0s" as "every 8 hours". */
export function intervalWords(text?: string): string {
  const ms = goDuration(text);
  if (!ms) return "only when asked";
  const h = ms / 3_600_000;
  if (h >= 1 && Number.isInteger(h)) return h === 1 ? "every hour" : `every ${h} hours`;
  const m = Math.round(ms / 60_000);
  return m === 1 ? "every minute" : `every ${m} minutes`;
}

/** "ci.yml@refs/heads/main" as "ci.yml". */
const workflowOf = (path?: string) => (path ?? "").split("@")[0] ?? "";

export async function giteaDashboard(
  fetchImpl: Fetch,
  base: string,
  token: string,
): Promise<GiteaDashboard> {
  const get = <T>(path: string) => gt<T>(fetchImpl, base, token, "GET", path);
  const optional = <T>(path: string) =>
    get<T>(path).catch((error: unknown) => {
      // An older Gitea or a Forgejo without this list answers 404: the panel says so.
      if (error instanceof GiteaError && /answer 404|not found/i.test(error.message))
        return undefined;
      throw error;
    });
  const [version, repos, users, orgs, runners, runs, tasks] = await Promise.all([
    get<{ version?: string }>("/version"),
    get<{ data?: RawRepo[] }>("/repos/search?limit=50&sort=updated&order=desc"),
    get<RawUser[]>("/admin/users?limit=50"),
    get<unknown[]>("/admin/orgs?limit=1"),
    optional<{ runners?: RawRunner[] }>("/admin/actions/runners"),
    optional<{ workflow_runs?: RawRun[] }>("/admin/actions/runs?limit=20"),
    get<RawTask[]>("/admin/cron?limit=50").catch(() => ({ body: [] as RawTask[] })),
  ]);
  // The search answers at most 50 a page; mirrors are fetched on their own so none is missed.
  const mirrorList = await get<{ data?: RawRepo[] }>("/repos/search?limit=50&mode=mirror").catch(
    () => ({
      body: { data: [] as RawRepo[] },
    }),
  );
  const list = (repos.body?.data ?? []).filter((r) => r && typeof r.id === "number");
  const v = version.body?.version ?? "";
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  // Gitea lists every run; Forgejo only per repository, so read the most recently changed ones.
  type Row = NonNullable<GiteaDashboard["runs"]>[number];
  let runRows: Row[] | undefined = runs
    ? (runs.body?.workflow_runs ?? []).map((r) => ({
        id: r.id,
        owner: r.repository?.owner?.login ?? "",
        repo: r.repository?.name ?? "",
        title: r.display_title ?? "",
        workflow: workflowOf(r.path),
        branch: r.head_branch ?? "",
        status: r.status ?? "",
        ...(r.conclusion ? { conclusion: r.conclusion } : {}),
        attempt: r.run_attempt ?? 1,
        ...(when(r.started_at) ? { started: r.started_at! } : {}),
      }))
    : undefined;
  if (!runRows) {
    const perRepo = await Promise.all(
      list
        .filter((r) => !r.mirror && !r.archived)
        .slice(0, 8)
        .map((r) =>
          optional<{ workflow_runs?: RawForgejoRun[] }>(
            `/repos/${r.full_name.split("/").map(encodeURIComponent).join("/")}/actions/runs?limit=5`,
          ).catch(() => undefined),
        ),
    );
    if (perRepo.some(Boolean))
      runRows = perRepo
        .flatMap((p) => p?.body?.workflow_runs ?? [])
        .map((r) => {
          const done = FINISHED.has(r.status ?? "");
          const started = when(r.started) ?? when(r.created);
          return {
            id: r.id,
            owner: r.repository?.owner?.login ?? "",
            repo: r.repository?.name ?? "",
            title: r.title ?? "",
            workflow: r.workflow_id ?? "",
            branch: r.prettyref ?? "",
            status: done ? "completed" : (r.status ?? ""),
            ...(done ? { conclusion: r.status! } : {}),
            attempt: 1,
            ...(started ? { started } : {}),
          };
        })
        .sort((a, b) => (b.started ?? "").localeCompare(a.started ?? ""))
        .slice(0, 20);
  }
  const runList = runRows ?? [];
  const userList = users.body ?? [];
  return {
    app: "gitea",
    ...(v ? { version: v } : {}),
    flavor: /forgejo|\+gitea-/i.test(v) ? "Forgejo" : "Gitea",
    repos: repos.total ?? list.length,
    privateRepos: list.filter((r) => r.private).length,
    archivedRepos: list.filter((r) => r.archived).length,
    sizeKb: list.reduce((n, r) => n + (r.size ?? 0), 0),
    recent: list.slice(0, 8).map((r) => ({
      id: r.id,
      fullName: r.full_name,
      private: Boolean(r.private),
      mirror: Boolean(r.mirror),
      updated: r.updated_at ?? "",
    })),
    mirrors: (mirrorList.body?.data ?? [])
      .filter((r) => r.mirror)
      .map((r) => {
        const every = goDuration(r.mirror_interval);
        const last = when(r.mirror_updated);
        const late = !last || now - Date.parse(last) > (every ? every * 2 : 86_400_000);
        return {
          id: r.id,
          owner: r.owner?.login ?? r.full_name.split("/")[0] ?? "",
          name: r.name,
          fullName: r.full_name,
          interval: intervalWords(r.mirror_interval),
          ...(last ? { lastSync: last } : {}),
          late: Boolean(every) && late,
        };
      }),
    ...(runners
      ? {
          runners: (runners.body?.runners ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            online: r.status !== "offline",
            busy: Boolean(r.busy),
            disabled: Boolean(r.disabled),
            labels: (r.labels ?? []).map((l) => l.name),
          })),
        }
      : {}),
    ...(runRows ? { runs: runRows } : {}),
    // Only Gitea can run a run's failed jobs again; Forgejo has no such call.
    canRerun: Boolean(runs),
    failedRunsToday: runList.filter(
      (r) => r.conclusion === "failure" && r.started && Date.parse(r.started) > dayAgo,
    ).length,
    users: users.total ?? userList.length,
    admins: userList.filter((u) => u.is_admin).length,
    orgs: orgs.total ?? (orgs.body ?? []).length,
    tasks: (tasks.body ?? []).map((t) => ({
      name: t.name,
      schedule: t.schedule,
      ...(when(t.next) ? { next: t.next! } : {}),
      ...(when(t.prev) ? { prev: t.prev! } : {}),
    })),
  };
}

export async function readGitea(
  base: string,
  token: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await giteaDashboard(fetchImpl, base, token);
  const issues: AppIssue[] = [];
  const late = d.mirrors.filter((m) => m.late);
  if (late.length)
    issues.push({
      level: "warning",
      key: "mirrors-late",
      text:
        late.length === 1
          ? `The mirror ${late[0]!.fullName} has not synced for longer than it should.`
          : `${late.length} mirrors have not synced for longer than they should.`,
    });
  const runners = d.runners ?? [];
  if (runners.length && !runners.some((r) => r.online && !r.disabled))
    issues.push({
      level: "warning",
      key: "runners-offline",
      text: "No Actions runner is online: workflows wait until one is.",
    });
  if (d.failedRunsToday)
    issues.push({
      level: "warning",
      key: "runs-failed",
      text: `${d.failedRunsToday === 1 ? "1 workflow run" : `${d.failedRunsToday} workflow runs`} failed in the last day.`,
    });
  return {
    app: "gitea",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Repositories", value: d.repos.toLocaleString() },
      ...(d.runners
        ? [
            {
              label: "Runners online",
              value: `${runners.filter((r) => r.online).length} of ${runners.length}`,
            },
          ]
        : []),
    ],
  };
}
