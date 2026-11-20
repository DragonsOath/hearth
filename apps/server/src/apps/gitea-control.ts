import type { GiteaDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { giteaDashboard, GiteaError, gt } from "./gitea";
import type { Fetch } from "./http";

/**
 * Changes in Gitea, each a plan the owner approves (app-gitea-control, params.op): sync a pull
 * mirror now, re-run a workflow run's failed jobs, turn an Actions runner off or on, remove one,
 * and run one of Gitea's scheduled tasks now. Each is read back from Gitea. Repositories, people,
 * secrets and settings stay in Gitea; Hearth never makes a runner registration token.
 */

export const GITEA_OPS = [
  "mirror-sync",
  "rerun-failed",
  "runner-off",
  "runner-on",
  "runner-remove",
  "task-run",
] as const;
export type GiteaOp = (typeof GITEA_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

export class GiteaOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as GiteaOp;
    if (!GITEA_OPS.includes(op)) throw new Error(`Say what to do: ${GITEA_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Gitea", "read", async (token) =>
      planGitea(
        await giteaDashboard(this.fetchImpl, service.localUrl, token),
        service.name,
        op,
        params ?? {},
        base,
      ),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    return this.record(step, service, () =>
      this.use(service, "change Gitea", "change", (token) =>
        runGitea(this.fetchImpl, service.localUrl, token, step.params ?? {}),
      ),
    );
  }

  /** A runner turned off or on is put back; nothing else is undone (a removed runner registers again). */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    if (p.op !== "runner-off" && p.op !== "runner-on") return undefined;
    const back = { ...p, op: p.op === "runner-off" ? "runner-on" : "runner-off" };
    return this.record({ ...step, params: back }, service, () =>
      this.use(service, "undo a change in Gitea", "change", (token) =>
        runGitea(this.fetchImpl, service.localUrl, token, back),
      ),
    );
  }

  private async record(
    step: StepRun,
    service: Service,
    fn: () => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await fn();
    } catch (error) {
      if (!(error instanceof GiteaError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: {
        op: p.op,
        ok: out.ok,
        repo: p.repo ?? null,
        runnerId: p.runnerId ?? null,
        runId: p.runId ?? null,
        task: p.task ?? null,
      },
    });
    return out;
  }
}

/** Gitea's scheduled task names in plain words; unknown ones keep their own name. */
export const TASK_WORDS: Record<string, string> = {
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
export const taskWords = (name: string) => TASK_WORDS[name] ?? name.replace(/_/g, " ");

export function planGitea(
  d: GiteaDashboard,
  name: string,
  op: GiteaOp,
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams,
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: label, settings: [setting] },
  });
  if (op === "mirror-sync") {
    const m = d.mirrors.find(
      (x) => x.id === Number(p.repoId) || x.fullName === String(p.repo ?? ""),
    );
    if (!m) throw new Error(`${name} has no such mirror: read the panel again.`);
    return step(
      `Sync the mirror ${m.fullName} now in ${name}`,
      {
        name: m.fullName,
        before: m.lastSync ? `synced ${m.lastSync}` : "never synced",
        after: "synced now",
      },
      { repoId: m.id, repo: m.fullName, owner: m.owner, name: m.name, lastSync: m.lastSync ?? "" },
    );
  }
  if (op === "rerun-failed") {
    const r = (d.runs ?? []).find((x) => x.id === Number(p.runId));
    if (!r) throw new Error(`${name} has no such workflow run: read the panel again.`);
    if (!d.canRerun)
      throw new Error(
        `${d.flavor} cannot run a run's failed jobs again from its API: do it on its Actions page.`,
      );
    if (r.conclusion !== "failure")
      throw new Error(`That run did not fail: only failed jobs are run again.`);
    return step(
      `Run the failed jobs of "${r.title || r.workflow}" in ${r.owner}/${r.repo} again in ${name}`,
      {
        name: `${r.owner}/${r.repo} run ${r.id}`,
        before: `attempt ${r.attempt}, failed`,
        after: `attempt ${r.attempt + 1}`,
      },
      {
        runId: r.id,
        owner: r.owner,
        repo: `${r.owner}/${r.repo}`,
        name: r.repo,
        attempt: r.attempt,
      },
    );
  }
  if (op === "task-run") {
    const t = d.tasks.find((x) => x.name === String(p.task ?? ""));
    if (!t) throw new Error(`${name} has no scheduled task with that name: read the panel again.`);
    return step(
      `${taskWords(t.name)} now in ${name}`,
      {
        name: taskWords(t.name),
        before: t.prev ? `last ran ${t.prev}` : "not run yet",
        after: "run now",
      },
      { task: t.name, prev: t.prev ?? "" },
    );
  }
  const runner = (d.runners ?? []).find((x) => x.id === Number(p.runnerId));
  if (!runner) throw new Error(`${name} has no such runner: read the panel again.`);
  const was = runner.disabled ? "off" : runner.online ? "on, online" : "on, offline";
  if (op === "runner-remove")
    return step(
      `Remove the runner ${runner.name} from ${name} (it must register again to come back)`,
      { name: runner.name, before: was, after: "removed" },
      { runnerId: runner.id, name: runner.name },
    );
  const off = op === "runner-off";
  return step(
    off
      ? `Turn off the runner ${runner.name} in ${name} (it takes no new jobs)`
      : `Turn on the runner ${runner.name} in ${name}`,
    { name: runner.name, before: was, after: off ? "off" : "on" },
    { runnerId: runner.id, name: runner.name },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seg = (s: unknown) => encodeURIComponent(String(s));

export async function runGitea(
  fetchImpl: Fetch,
  base: string,
  token: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as GiteaOp;
  const call = <T>(method: string, path: string, body?: unknown) =>
    gt<T>(fetchImpl, base, token, method, path, body);
  if (op === "mirror-sync") {
    const path = `/repos/${seg(p.owner)}/${seg(p.name)}`;
    await call("POST", `${path}/mirror-sync`);
    // Gitea syncs in the background and records when it finished.
    for (let i = 0; i < 10; i++) {
      const now = (await call<{ mirror_updated?: string }>("GET", path)).body?.mirror_updated ?? "";
      if (now && now !== String(p.lastSync ?? ""))
        return { ok: true, verified: true, result: `Gitea synced ${String(p.repo)}.` };
      await sleep(1000);
    }
    return {
      ok: true,
      result: `Gitea is syncing ${String(p.repo)}; the panel shows when it finishes.`,
    };
  }
  if (op === "rerun-failed") {
    const path = `/repos/${seg(p.owner)}/${seg(p.name)}/actions/runs/${seg(p.runId)}`;
    await call("POST", `${path}/rerun-failed-jobs`);
    const run = (await call<{ run_attempt?: number; status?: string }>("GET", path)).body;
    const again =
      (run?.run_attempt ?? 0) > Number(p.attempt ?? 0) || (run?.status ?? "") !== "completed";
    return again
      ? {
          ok: true,
          verified: true,
          result: `Gitea is running the failed jobs again (attempt ${run?.run_attempt ?? "?"}).`,
        }
      : { ok: false, result: "Gitea accepted it, but the run shows no new attempt." };
  }
  if (op === "task-run") {
    await call("POST", `/admin/cron/${seg(p.task)}`);
    return { ok: true, result: `Gitea started "${taskWords(String(p.task))}".` };
  }
  const id = seg(p.runnerId);
  if (op === "runner-remove") {
    await call("DELETE", `/admin/actions/runners/${id}`);
    const left =
      (await call<{ runners?: { id: number }[] }>("GET", "/admin/actions/runners")).body?.runners ??
      [];
    return left.some((r) => r.id === Number(p.runnerId))
      ? { ok: false, result: `${String(p.name)} is still listed in Gitea.` }
      : { ok: true, verified: true, result: `Gitea removed the runner ${String(p.name)}.` };
  }
  const off = op === "runner-off";
  await call("PATCH", `/admin/actions/runners/${id}`, { disabled: off });
  const now = (await call<{ disabled?: boolean }>("GET", `/admin/actions/runners/${id}`)).body;
  return Boolean(now?.disabled) === off
    ? {
        ok: true,
        verified: true,
        result: `The runner ${String(p.name)} is ${off ? "off" : "on"} in Gitea.`,
      }
    : { ok: false, result: `Gitea still shows ${String(p.name)} ${off ? "on" : "off"}.` };
}
