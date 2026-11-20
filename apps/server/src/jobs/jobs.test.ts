import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobStepInput, Requester } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { expireApprovals } from "../actions/approval";
import { listAudit } from "../store/audit";
import { Jobs } from "./engine";
import type { JobOperations, StepRun } from "./operations";

/**
 * The engine on its own, with stand-in operations so failure and rollback can
 * be driven exactly. Today's real operations have no undo; these do.
 */
const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function db() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  return handle;
}

function fakeOps(opts: { fail?: string[]; refuse?: string[]; ask?: string[]; undo?: boolean }) {
  const ran: string[] = [];
  const undone: string[] = [];
  const ops: JobOperations = {
    async plan(step: JobStepInput, _by: Requester) {
      return {
        label: `${step.kind} ${step.serviceId}`,
        serviceName: step.serviceId,
        changes: step.kind === "restart-container",
        policy: opts.refuse?.includes(step.serviceId)
          ? "refuse"
          : opts.ask?.includes(step.serviceId)
            ? "approve-first"
            : "allow",
        policyReason: opts.refuse?.includes(step.serviceId) ? "Monitor only here." : "Allowed.",
      };
    },
    async run(step: StepRun) {
      ran.push(step.serviceId);
      const ok = !opts.fail?.includes(step.serviceId);
      return { ok, result: ok ? `${step.serviceId} done` : `${step.serviceId} broke` };
    },
    ...(opts.undo
      ? {
          async undo(step: StepRun) {
            undone.push(step.serviceId);
            return { ok: true, result: `${step.serviceId} put back` };
          },
        }
      : {}),
  };
  return { ops, ran, undone };
}

const steps = (...ids: string[]): JobStepInput[] =>
  ids.map((serviceId) => ({ kind: "restart-container", serviceId }));

describe("jobs", () => {
  it("your plans wait for review; approving runs every step in order and verifies each", async () => {
    const handle = await db();
    const { ops, ran } = fakeOps({});
    const jobs = new Jobs(handle, ops);
    const job = await jobs.create({
      title: "Bring it back",
      steps: steps("a", "b", "c"),
      requestedBy: "you",
    });
    expect(job).toMatchObject({
      status: "awaiting-approval",
      approval: { fingerprint: expect.any(String) },
    });
    expect(ran).toEqual([]);

    const done = await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    expect(done.approvedAt).toBeTruthy();
    await jobs.idle();
    const finished = await jobs.get(job.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.summary).toBe("All 3 steps done and verified.");
    expect(finished.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(ran).toEqual(["a", "b", "c"]);
    const audit = (await listAudit(handle.db, 10)).map((a) => a.action);
    expect(audit).toEqual(
      expect.arrayContaining([
        "Planned a job: Bring it back",
        "Approved a job: Bring it back",
        "Finished a job: Bring it back",
      ]),
    );
  });

  it("approval is bound to the exact plan, expires, and works once", async () => {
    const handle = await db();
    const jobs = new Jobs(handle, fakeOps({}).ops);
    const job = await jobs.create({ title: "Plan", steps: steps("a", "b"), requestedBy: "you" });
    const fp = job.approval!.fingerprint;

    await expect(jobs.decide(job.id, "approve")).rejects.toThrow(/fingerprint/);
    await expect(jobs.decide(job.id, "approve", "f".repeat(32))).rejects.toThrow(/changed/);
    // Editing the plan behind its back (here: a step's target) invalidates the approval.
    handle.sqlite
      .prepare("UPDATE job_steps SET service_id = 'z' WHERE job_id = ? AND seq = 2")
      .run(job.id);
    await expect(jobs.decide(job.id, "approve", fp)).rejects.toThrow(/changed/);
    handle.sqlite
      .prepare("UPDATE job_steps SET service_id = 'b' WHERE job_id = ? AND seq = 2")
      .run(job.id);

    await jobs.decide(job.id, "approve", fp);
    await expect(jobs.decide(job.id, "approve", fp)).rejects.toThrow(/not waiting/);
    await jobs.idle();

    const late = await jobs.create({ title: "Late", steps: steps("a"), requestedBy: "you" });
    handle.sqlite
      .prepare("UPDATE jobs SET expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), late.id);
    const lateFp = (await jobs.get(late.id)).approval!.fingerprint;
    await expect(jobs.decide(late.id, "approve", lateFp)).rejects.toThrow(/expired/);
    expect(await expireApprovals(handle)).toBe(1);
    const expired = await jobs.get(late.id);
    expect(expired).toMatchObject({ status: "expired", approval: undefined });
    expect(expired.steps[0]!.status).toBe("skipped");
    await expect(jobs.decide(late.id, "approve", lateFp)).rejects.toThrow(/not waiting/);
  });

  it("declining revokes a waiting plan; nothing runs", async () => {
    const handle = await db();
    const { ops, ran } = fakeOps({});
    const jobs = new Jobs(handle, ops);
    const job = await jobs.create({ title: "Plan", steps: steps("a"), requestedBy: "you" });
    const declined = await jobs.decide(job.id, "decline");
    expect(declined).toMatchObject({
      status: "cancelled",
      summary: expect.stringMatching(/declined/),
    });
    expect(ran).toEqual([]);
  });

  it("a plan with a refused step is refused as a whole", async () => {
    const handle = await db();
    const { ops, ran } = fakeOps({ refuse: ["b"] });
    const jobs = new Jobs(handle, ops);
    const job = await jobs.create({ title: "Plan", steps: steps("a", "b"), requestedBy: "agent" });
    expect(job).toMatchObject({ status: "refused", summary: "Not allowed: Monitor only here." });
    expect(job.approval).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it("the AI's plan runs at once only when the policy allows every step", async () => {
    const handle = await db();
    const { ops, ran } = fakeOps({ ask: ["b"] });
    const jobs = new Jobs(handle, ops);
    const waits = await jobs.create({
      title: "Needs you",
      steps: steps("a", "b"),
      requestedBy: "agent",
    });
    expect(waits.status).toBe("awaiting-approval");
    const runs = await jobs.create({ title: "Allowed", steps: steps("a"), requestedBy: "agent" });
    expect(runs.status).toBe("running");
    await jobs.idle();
    expect((await jobs.get(runs.id)).status).toBe("succeeded");
    expect(ran).toEqual(["a"]);
  });

  it("stops at the first failure and skips the rest", async () => {
    const handle = await db();
    const { ops, ran } = fakeOps({ fail: ["b"] });
    const jobs = new Jobs(handle, ops);
    const job = await jobs.create({
      title: "Plan",
      steps: steps("a", "b", "c"),
      requestedBy: "you",
    });
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status).toBe("failed");
    expect(done.steps.map((s) => s.status)).toEqual(["succeeded", "failed", "skipped"]);
    expect(done.summary).toMatch(/^Stopped at step 2 of 3 .*b broke/);
    expect(ran).toEqual(["a", "b"]);
  });

  it("undoes completed steps newest first when a later step fails", async () => {
    const handle = await db();
    const { ops, undone } = fakeOps({ fail: ["c"], undo: true });
    const jobs = new Jobs(handle, ops);
    const job = await jobs.create({
      title: "Plan",
      steps: steps("a", "b", "c"),
      requestedBy: "you",
    });
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status).toBe("rolled-back");
    expect(undone).toEqual(["b", "a"]);
    expect(done.steps.map((s) => s.status)).toEqual(["rolled-back", "rolled-back", "failed"]);
    expect(done.steps[0]!.result).toBe("a done Rollback: a put back");
    expect(done.summary).toMatch(/2 earlier steps were undone/);
  });

  it("a job running when Hearth restarts is marked interrupted, never resumed", async () => {
    const handle = await db();
    const jobs = new Jobs(handle, fakeOps({}).ops);
    const job = await jobs.create({ title: "Plan", steps: steps("a", "b"), requestedBy: "you" });
    // As if Hearth stopped during step 1.
    handle.sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);
    handle.sqlite
      .prepare("UPDATE job_steps SET status = 'running' WHERE job_id = ? AND seq = 1")
      .run(job.id);
    const { ops, ran } = fakeOps({});
    const restarted = new Jobs(handle, ops);
    expect(await restarted.recoverInterrupted()).toBe(1);
    const after = await restarted.get(job.id);
    expect(after.status).toBe("interrupted");
    expect(after.steps.map((s) => s.status)).toEqual(["interrupted", "skipped"]);
    expect(ran).toEqual([]);
  });

  it("when Hearth stops, a running job finishes its current step and stops there", async () => {
    const handle = await db();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ran: string[] = [];
    const jobs = new Jobs(handle, {
      ...fakeOps({}).ops,
      async run(step) {
        ran.push(step.serviceId);
        if (step.serviceId === "a") await gate;
        return { ok: true, result: "done" };
      },
    });
    const job = await jobs.create({ title: "Plan", steps: steps("a", "b"), requestedBy: "you" });
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    const closed = jobs.close();
    release();
    await closed;
    const after = await jobs.get(job.id);
    expect(after.status).toBe("interrupted");
    expect(after.steps.map((s) => s.status)).toEqual(["succeeded", "skipped"]);
    expect(after.summary).toMatch(/stopping, so the job stopped after 1 of 2 steps/);
    expect(ran).toEqual(["a"]);
  });

  it("checks plans before saving them", async () => {
    const jobs = new Jobs(await db(), fakeOps({}).ops);
    await expect(
      jobs.create({ title: " ", steps: steps("a"), requestedBy: "you" }),
    ).rejects.toThrow(/title/);
    await expect(jobs.create({ title: "x", steps: [], requestedBy: "you" })).rejects.toThrow(
      /at least one/,
    );
    await expect(
      jobs.create({
        title: "x",
        steps: steps(...Array.from({ length: 13 }, (_, i) => `s${i}`)),
        requestedBy: "you",
      }),
    ).rejects.toThrow(/at most 12/);
    await expect(
      jobs.create({
        title: "x",
        steps: [{ kind: "rm-rf" as never, serviceId: "a" }],
        requestedBy: "agent",
      }),
    ).rejects.toThrow(/not something Hearth can do/);
  });
});
