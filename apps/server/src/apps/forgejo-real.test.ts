import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { giteaDashboard, readGitea } from "./gitea";
import { GiteaOperations } from "./gitea-control";
import type { Fetch } from "./http";

/**
 * Gitea's panel against a real Forgejo, which answers the same API with fewer Actions calls: only a
 * throwaway one made for this, with a private repository holding a workflow (its run waits, as no
 * runner is registered) and a pull mirror. It runs only with HEARTH_FORGEJO_TEST_URL,
 * HEARTH_FORGEJO_TEST_KEY_FILE and HEARTH_FORGEJO_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_FORGEJO_TEST_URL ?? "";
const file = process.env.HEARTH_FORGEJO_TEST_KEY_FILE;
const run = Boolean(url && file && process.env.HEARTH_FORGEJO_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(
  `a real, throwaway Forgejo at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const token = run ? readFileSync(file!, "utf8").trim() : "";
    const service = { id: "real", name: "Forgejo", localUrl: url };
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
      return { planned, outcome: await ops.run(step(planned.params), service) };
    };

    it("reads repositories, the mirror, runs per repository and tasks; no runner list", async () => {
      const d = await giteaDashboard(realFetch, url, token);
      expect(d.flavor).toBe("Forgejo");
      expect(d.version).toMatch(/\+gitea-/);
      expect(d.repos).toBeGreaterThanOrEqual(3);
      expect(d.privateRepos).toBeGreaterThanOrEqual(1);
      expect(d.mirrors[0]).toMatchObject({ interval: "every 8 hours", late: false });
      expect(d.runners).toBeUndefined();
      expect(d.canRerun).toBe(false);
      expect(d.runs!.find((r) => r.workflow === "ci.yml")).toMatchObject({
        status: "waiting",
        branch: "main",
      });
      expect(d.tasks.map((t) => t.name)).toContain("update_mirrors");
      expect(JSON.stringify(d)).not.toContain(token);
      // Forgejo hands back each run's push payload; none of it (addresses, messages) is kept.
      expect(JSON.stringify(d)).not.toContain("admin@example.com");
      const r = await readGitea(url, token, realFetch);
      expect(r.facts.map((f) => f.label)).toEqual(["Repositories"]);
      await expect(giteaDashboard(realFetch, url, "wrong-token")).rejects.toThrow(
        /refused the access token/,
      );
    });

    it("syncs a mirror and runs a scheduled task, read back; a re-run is refused plainly", async () => {
      const d = await giteaDashboard(realFetch, url, token);
      await new Promise((r) => setTimeout(r, 1100));
      expect((await go({ op: "mirror-sync", repoId: d.mirrors[0]!.id })).outcome).toMatchObject({
        ok: true,
        verified: true,
      });
      expect((await go({ op: "task-run", task: "repo_health_check" })).outcome.ok).toBe(true);
      await expect(go({ op: "rerun-failed", runId: d.runs![0]!.id })).rejects.toThrow(
        /Forgejo cannot run/,
      );
      await expect(go({ op: "runner-off", runnerId: 1 })).rejects.toThrow(/no such runner/);
    });
  },
);
