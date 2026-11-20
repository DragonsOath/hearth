import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { giteaDashboard, readGitea } from "./gitea";
import { GiteaOperations } from "./gitea-control";
import type { Fetch } from "./http";

/**
 * The same reads and changes as gitea.test.ts against a real Gitea: only a throwaway one made for
 * this, with a pull mirror, a workflow run that failed, one runner online and one offline (which this
 * removes). It runs only with HEARTH_GITEA_TEST_URL, HEARTH_GITEA_TEST_KEY_FILE and
 * HEARTH_GITEA_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_GITEA_TEST_URL ?? "";
const file = process.env.HEARTH_GITEA_TEST_KEY_FILE;
const run = Boolean(url && file && process.env.HEARTH_GITEA_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(`a real, throwaway Gitea at ${url || "(none)"}`, { timeout: 60_000 }, () => {
  const token = run ? readFileSync(file!, "utf8").trim() : "";
  const service = { id: "real", name: "Gitea", localUrl: url };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: token }),
  } as unknown as CredentialBroker;
  const ops = new GiteaOperations(handle, broker, realFetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-gitea-control" as const,
    serviceId: "real",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return {
      planned,
      step: step(planned.params),
      outcome: await ops.run(step(planned.params), service),
    };
  };

  it("reads repositories, mirrors, runners, runs, people and tasks, and no token", async () => {
    const d = await giteaDashboard(realFetch, url, token);
    expect(d.flavor).toBe("Gitea");
    expect(d.version).toMatch(/^\d+\.\d+/);
    expect(d.repos).toBeGreaterThanOrEqual(3);
    expect(d.privateRepos).toBeGreaterThanOrEqual(1);
    expect(d.mirrors[0]).toMatchObject({ interval: "every 8 hours", late: false });
    expect(d.runners!.some((r) => r.online)).toBe(true);
    expect(d.runners!.some((r) => !r.online)).toBe(true);
    expect(d.runs!.some((r) => r.conclusion === "failure")).toBe(true);
    expect(d.failedRunsToday).toBeGreaterThan(0);
    expect(d.users).toBeGreaterThanOrEqual(2);
    expect(d.admins).toBeGreaterThanOrEqual(1);
    expect(d.tasks.map((t) => t.name)).toContain("update_mirrors");
    expect(JSON.stringify(d)).not.toContain(token);
    const r = await readGitea(url, token, realFetch);
    expect(r.issues.map((i) => i.key)).toContain("runs-failed");
    await expect(giteaDashboard(realFetch, url, "wrong-token")).rejects.toThrow(
      /refused the access token/,
    );
  });

  it("syncs a mirror, re-runs failed jobs and runs a scheduled task, read back", async () => {
    const d = await giteaDashboard(realFetch, url, token);
    // Gitea records the sync time to the second.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await go({ op: "mirror-sync", repoId: d.mirrors[0]!.id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    const failed = d.runs!.find((r) => r.conclusion === "failure")!;
    expect((await go({ op: "rerun-failed", runId: failed.id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((await go({ op: "task-run", task: "repo_health_check" })).outcome.ok).toBe(true);
  });

  it("turns a runner off and back on (undo), and removes the offline one", async () => {
    const d = await giteaDashboard(realFetch, url, token);
    const online = d.runners!.find((r) => r.online)!;
    const off = await go({ op: "runner-off", runnerId: online.id });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(
      (await giteaDashboard(realFetch, url, token)).runners!.find((r) => r.id === online.id)!
        .disabled,
    ).toBe(true);
    expect(await ops.undo(off.step, service)).toMatchObject({ ok: true, verified: true });
    expect(
      (await giteaDashboard(realFetch, url, token)).runners!.find((r) => r.id === online.id)!
        .disabled,
    ).toBe(false);
    const offline = d.runners!.find((r) => !r.online)!;
    expect((await go({ op: "runner-remove", runnerId: offline.id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect(
      (await giteaDashboard(realFetch, url, token)).runners!.some((r) => r.id === offline.id),
    ).toBe(false);
  });
});
