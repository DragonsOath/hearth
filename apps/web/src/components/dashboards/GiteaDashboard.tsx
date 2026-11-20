import { ExternalLink, GitBranch, Lock, Play, Power, RefreshCw, Trash2 } from "lucide-react";
import type { GiteaDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Gitea (or Forgejo) from Hearth. The Overview answers "are my repositories and mirrors fine?":
 * repositories, mirrors and when each last synced (with Sync now), runners online, failed runs,
 * people and the version, and what changed lately. Actions lists the runners (off, on, remove),
 * recent workflow runs (run the failed jobs again) and Gitea's scheduled tasks (run one now). Each
 * change is a plan you approve; repositories, people and secrets are changed in Gitea.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const KIND = "app-gitea-control" as const;

/** Gitea's scheduled task names in plain words (the server plans with the same words). */
const TASKS: Record<string, string> = {
  update_mirrors: "Sync every mirror",
  repo_health_check: "Check every repository's health",
  check_repo_stats: "Recount repository statistics",
  archive_cleanup: "Delete old repository archives",
  sync_external_users: "Sync users from external sign-in sources",
  deleted_branches_cleanup: "Clean up deleted branches",
  cleanup_actions: "Clean up old Actions logs and artifacts",
  cleanup_hook_task_table: "Clean up old webhook deliveries",
  cleanup_packages: "Clean up expired packages",
  git_gc_repos: "Garbage collect every repository",
  update_checker: "Check for a new Gitea version",
};
const taskWords = (name: string) => TASKS[name] ?? name.replace(/_/g, " ");

function useGitea(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "gitea" ? q.data.data : undefined;
  return { q, d };
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useGitea>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="gt-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add an administrator's access token for Gitea to Secure Vault, for this service. Make
            one in Gitea: Settings, Applications, Generate new token, with read and write access to
            admin and repository.
          </p>
        )}
      </div>
    );
  return null;
}

const size = (kb: number) =>
  kb >= 1024 * 1024
    ? `${(kb / 1024 / 1024).toFixed(1)} GB`
    : kb >= 1024
      ? `${Math.round(kb / 1024)} MB`
      : `${kb} KB`;

export function GiteaDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useGitea(serviceId);
  const act = useApproveHere(serviceId, `Proposed from ${d?.flavor ?? "Gitea"}'s panel.`);
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  if (!d) return <Gate name={name} q={q} />;
  const runners = d.runners ?? [];
  const online = runners.filter((r) => r.online && !r.disabled).length;
  const waiting = (d.runs ?? []).filter((r) => r.status === "waiting").length;
  const web = keyPageHref(service, "/");
  return (
    <section
      className="@container space-y-4"
      data-testid="gt-dashboard"
      aria-label={`${name}: repositories`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Repositories</p>
          <p className="stat-value text-ink tabular" data-testid="gt-repos">
            {d.repos.toLocaleString()}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.privateRepos} private · {d.archivedRepos} archived
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Mirrors</p>
          <p
            className={cx(
              "stat-value tabular",
              d.mirrors.some((m) => m.late) ? "text-amber" : "text-ink",
            )}
            data-testid="gt-mirrors"
          >
            {d.mirrors.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.mirrors.filter((m) => m.late).length
              ? `${d.mirrors.filter((m) => m.late).length} late`
              : "all on time"}
          </p>
        </div>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("actions")}
          data-hearth-target="tab:actions:open"
        >
          {d.runners ? (
            <>
              <p className={eyebrow}>Runners</p>
              <p
                className={cx(
                  "stat-value tabular",
                  runners.length && !online ? "text-amber" : online ? "text-ok" : "text-ink",
                )}
                data-testid="gt-runners"
              >
                {online} of {runners.length}
              </p>
              <p className="text-[0.74rem] text-faint">online</p>
            </>
          ) : (
            <>
              {/* Forgejo does not list runners in its API; runs waiting for one tell the same story. */}
              <p className={eyebrow}>Waiting runs</p>
              <p
                className={cx("stat-value tabular", waiting ? "text-amber" : "text-ink")}
                data-testid="gt-waiting"
              >
                {waiting}
              </p>
              <p className="text-[0.74rem] text-faint">for a runner</p>
            </>
          )}
        </button>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("actions")}
        >
          <p className={eyebrow}>Failed runs</p>
          <p
            className={cx("stat-value tabular", d.failedRunsToday ? "text-amber" : "text-ink")}
            data-testid="gt-failed"
          >
            {d.failedRunsToday}
          </p>
          <p className="text-[0.74rem] text-faint">in the last day</p>
        </button>
      </div>

      <div data-hearth-target="gitea:mirrors" data-testid="gt-mirror-list">
        <p className={eyebrow}>Mirrors</p>
        {d.mirrors.length === 0 ? (
          <p className="text-[0.84rem] text-faint">
            No pull mirrors. Make one in Gitea with New migration.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {d.mirrors.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
                data-testid="gt-mirror"
              >
                <span className="text-[0.88rem] text-ink">{m.fullName}</span>
                <span className={cx("text-[0.76rem]", m.late ? "text-amber" : "text-faint")}>
                  {m.lastSync ? `synced ${ago(m.lastSync).toLowerCase()}` : "never synced"} ·{" "}
                  {m.interval}
                  {m.late ? " · late" : ""}
                </span>
                <button
                  type="button"
                  className={cx(btn, "ml-auto")}
                  onClick={() =>
                    void act.propose(
                      KIND,
                      { op: "mirror-sync", repoId: String(m.id) },
                      `Sync ${m.fullName} now`,
                    )
                  }
                  data-testid="gt-sync"
                >
                  <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Sync now
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div data-hearth-target="gitea:repos" data-testid="gt-recent">
        <p className={eyebrow}>Changed lately</p>
        <ul className="space-y-1 text-[0.84rem]">
          {d.recent.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
              <GitBranch strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-gold" />
              <span className="text-ink">{r.fullName}</span>
              {r.private && (
                <Lock
                  strokeWidth={1.5}
                  className="h-3 w-3 self-center text-faint"
                  aria-label="private"
                />
              )}
              {r.mirror && <span className="text-[0.74rem] text-faint">mirror</span>}
              {r.updated && <span className="text-faint">{ago(r.updated).toLowerCase()}</span>}
            </li>
          ))}
        </ul>
      </div>

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${d.flavor} ${d.version} · ` : ""}live, every 30 s · {d.users} people (
        {d.admins} {d.admins === 1 ? "administrator" : "administrators"}) · {d.orgs}{" "}
        {d.orgs === 1 ? "organization" : "organizations"} · {size(d.sizeKb)} in the listed
        repositories.{" "}
        {web && (
          <a
            href={web}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          >
            Open {d.flavor} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}

export function GiteaActions({ serviceId, name }: AppViewProps) {
  const { q, d } = useGitea(serviceId);
  const act = useApproveHere(serviceId, `Proposed from ${d?.flavor ?? "Gitea"}'s panel.`);
  if (!d) return <Gate name={name} q={q} />;
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-4"
      data-testid="gt-actions-tab"
      aria-label={`${name}: actions`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div data-hearth-target="actions:runners">
        <p className={eyebrow}>Runners</p>
        {!d.runners ? (
          <p className="text-[0.84rem] text-faint">
            {d.flavor} lists its runners only on its own page (Site administration, Actions,
            Runners), not in its API, so Hearth cannot show or change them.
          </p>
        ) : d.runners.length === 0 ? (
          <p className="text-[0.84rem] text-faint">
            No runners. Workflows wait until one registers (Site administration, Actions, Runners).
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {d.runners.map((r) => (
              <li
                key={r.id}
                className="space-y-1 py-2.5"
                data-testid="gt-runner"
                data-capture-item
                data-capture-label={r.name}
              >
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[0.88rem] text-ink">{r.name}</span>
                  <span
                    className={cx(
                      "text-[0.76rem]",
                      r.disabled ? "text-faint" : r.online ? "text-ok" : "text-amber",
                    )}
                  >
                    {r.disabled
                      ? "off"
                      : r.online
                        ? r.busy
                          ? "online, running a job"
                          : "online"
                        : "offline"}
                  </span>
                  <span className="text-[0.74rem] text-faint">{r.labels.join(", ")}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose(
                        { op: r.disabled ? "runner-on" : "runner-off", runnerId: String(r.id) },
                        `${r.disabled ? "Turn on" : "Turn off"} the runner ${r.name}`,
                      )
                    }
                    data-testid="gt-runner-toggle"
                  >
                    <Power strokeWidth={1.5} className="h-3.5 w-3.5" />{" "}
                    {r.disabled ? "Turn on" : "Turn off"}
                  </button>
                  <button
                    type="button"
                    className={cx(btn, "ml-auto hover:border-alert/60 hover:text-alert")}
                    onClick={() =>
                      propose(
                        { op: "runner-remove", runnerId: String(r.id) },
                        `Remove the runner ${r.name}`,
                      )
                    }
                    data-testid="gt-runner-remove"
                  >
                    <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {d.runners && (
          <p className="mt-1 text-[0.74rem] text-faint">
            A runner turned off finishes its job and takes no new ones. A removed runner must
            register again with a new token from {d.flavor}.
          </p>
        )}
      </div>

      <div data-hearth-target="actions:runs" data-testid="gt-runs">
        <p className={eyebrow}>Recent runs</p>
        {!d.runs || d.runs.length === 0 ? (
          <p className="text-[0.84rem] text-faint">No workflow runs yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.runs.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
                data-testid="gt-run"
              >
                <span className="text-[0.86rem] text-ink">{r.title || r.workflow}</span>
                <span className="text-[0.76rem] text-muted">
                  {r.owner}/{r.repo} · {r.workflow} · {r.branch}
                </span>
                <span
                  className={cx(
                    "text-[0.76rem]",
                    r.conclusion === "failure"
                      ? "text-alert"
                      : r.conclusion === "success"
                        ? "text-ok"
                        : "text-faint",
                  )}
                >
                  {r.conclusion === "failure"
                    ? "failed"
                    : r.conclusion === "success"
                      ? "passed"
                      : r.conclusion || r.status}
                  {r.attempt > 1 ? ` (attempt ${r.attempt})` : ""}
                </span>
                {r.started && (
                  <span className="text-[0.74rem] text-faint">{ago(r.started).toLowerCase()}</span>
                )}
                {r.conclusion === "failure" && d.canRerun && (
                  <button
                    type="button"
                    className={cx(btn, "ml-auto")}
                    onClick={() =>
                      propose(
                        { op: "rerun-failed", runId: String(r.id) },
                        `Run the failed jobs of ${r.title || r.workflow} again`,
                      )
                    }
                    data-testid="gt-rerun"
                  >
                    <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Run failed jobs again
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <details data-hearth-target="actions:tasks">
        <summary className={cx(eyebrow, "cursor-pointer")}>Scheduled tasks</summary>
        <ul className="divide-y divide-line">
          {d.tasks.map((t) => (
            <li
              key={t.name}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
              data-testid="gt-task"
            >
              <span className="text-[0.84rem] text-ink">{taskWords(t.name)}</span>
              <span className="text-[0.74rem] text-faint">
                {t.schedule}
                {t.prev ? ` · last ran ${ago(t.prev).toLowerCase()}` : ""}
              </span>
              <button
                type="button"
                className={cx(btn, "ml-auto")}
                onClick={() =>
                  propose({ op: "task-run", task: t.name }, `${taskWords(t.name)} now`)
                }
              >
                <Play strokeWidth={1.5} className="h-3.5 w-3.5" /> Run now
              </button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
