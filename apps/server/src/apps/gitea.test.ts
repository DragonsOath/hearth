import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeGitea } from "./fake-gitea";
import { giteaDashboard, goDuration, intervalWords, readGitea } from "./gitea";
import { GiteaOperations } from "./gitea-control";

/**
 * Gitea against the stand-in (answering as a throwaway 1.27.3 did; gitea-real.test.ts runs the same
 * calls against a real one): repositories, a late mirror, runners, a failed run, and each change as
 * a plan read back.
 */

const BASE = "http://10.0.0.9:3030";
const TOKEN = "e2e-gitea-token";
const service = { id: "gt", name: "Gitea", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeGitea();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
  } as unknown as CredentialBroker;
  const ops = new GiteaOperations(handle, broker, fake.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-gitea-control" as const,
    serviceId: "gt",
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
  return { fake, ops, go };
}

describe("reading Gitea", () => {
  it("reads repositories, the mirror, runners, runs, people and tasks, and no token", async () => {
    const { fake } = setup();
    const d = await giteaDashboard(fake.fetch, BASE, TOKEN);
    expect(d).toMatchObject({
      version: "1.27.3",
      flavor: "Gitea",
      repos: 4,
      privateRepos: 1,
      archivedRepos: 1,
      users: 3,
      admins: 1,
      orgs: 1,
      failedRunsToday: 1,
    });
    expect(d.mirrors[0]).toMatchObject({
      fullName: "alex/upstream-mirror",
      interval: "every 8 hours",
      late: true,
    });
    expect(d.runners!.map((r) => [r.name, r.online])).toEqual([
      ["garage-runner", true],
      ["shed-runner", false],
    ]);
    expect(d.runs![0]).toMatchObject({
      workflow: "ci.yml",
      conclusion: "failure",
      owner: "alex",
      repo: "homelab",
    });
    expect(d.tasks.find((t) => t.name === "repo_health_check")!.prev).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it("reports a late mirror and failed runs, and refuses a wrong token plainly", async () => {
    const { fake } = setup();
    const r = await readGitea(BASE, TOKEN, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["mirrors-late", "runs-failed"]);
    expect(r.facts).toContainEqual({ label: "Runners online", value: "1 of 2" });
    await expect(giteaDashboard(fake.fetch, BASE, "wrong")).rejects.toThrow(
      /refused the access token/,
    );
  });

  it("reads Go durations and Forgejo's version", async () => {
    expect(goDuration("1h30m0s")).toBe(5_400_000);
    expect(intervalWords("10m0s")).toBe("every 10 minutes");
    expect(intervalWords("")).toBe("only when asked");
  });
});

describe("changing Gitea", () => {
  it("syncs the mirror and re-runs the failed jobs, read back", async () => {
    const { go, fake } = setup();
    const m = await go({ op: "mirror-sync", repoId: 3 });
    expect(m.planned.label).toBe("Sync the mirror alex/upstream-mirror now in Gitea");
    expect(m.outcome).toMatchObject({ ok: true, verified: true });
    expect((await giteaDashboard(fake.fetch, BASE, TOKEN)).mirrors[0]!.late).toBe(false);
    const r = await go({ op: "rerun-failed", runId: 7 });
    expect(r.planned.label).toContain('"Update compose files" in alex/homelab');
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    await expect(go({ op: "rerun-failed", runId: 7 })).rejects.toThrow(/did not fail/);
  });

  it("turns a runner off and undoes it, removes one, and runs a scheduled task", async () => {
    const { go, ops, fake } = setup();
    const off = await go({ op: "runner-off", runnerId: 2 });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(off.step, service)).toMatchObject({ ok: true, verified: true });
    expect((await giteaDashboard(fake.fetch, BASE, TOKEN)).runners![0]!.disabled).toBe(false);
    expect((await go({ op: "runner-remove", runnerId: 1 })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    const t = await go({ op: "task-run", task: "update_mirrors" });
    expect(t.planned.label).toBe("Sync every mirror now in Gitea");
    expect(t.outcome.ok).toBe(true);
    await expect(go({ op: "runner-off", runnerId: 99 })).rejects.toThrow(/no such runner/);
  });
});

describe("Forgejo through Gitea's panel", () => {
  it("names Forgejo, reads runs per repository without their payload, and has no runner list", async () => {
    const fake = fakeGitea({ forgejo: true });
    const d = await giteaDashboard(fake.fetch, BASE, TOKEN);
    expect(d).toMatchObject({ flavor: "Forgejo", canRerun: false, failedRunsToday: 1 });
    expect(d.runners).toBeUndefined();
    expect(d.runs!.map((r) => [r.id, r.status, r.conclusion])).toEqual([
      [3, "waiting", undefined],
      [2, "completed", "failure"],
    ]);
    expect(JSON.stringify(d)).not.toContain("alex@example.com");
    const r = await readGitea(BASE, TOKEN, fake.fetch);
    expect(r.facts.map((f) => f.label)).toEqual(["Repositories"]);
  });

  it("refuses a re-run plainly and still syncs a mirror", async () => {
    const fake = fakeGitea({ forgejo: true });
    const broker = {
      use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
    } as unknown as CredentialBroker;
    const ops = new GiteaOperations(handle, broker, fake.fetch);
    await expect(ops.plan(service, { op: "rerun-failed", runId: 2 }, base)).rejects.toThrow(
      /Forgejo cannot run a run's failed jobs again/,
    );
    const planned = await ops.plan(service, { op: "mirror-sync", repoId: 3 }, base);
    const out = await ops.run(
      { kind: "app-gitea-control", serviceId: "gt", requestedBy: "you", params: planned.params! },
      service,
    );
    expect(out).toMatchObject({ ok: true, verified: true });
  });
});
