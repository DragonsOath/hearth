import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { authentikDashboard, readAuthentik } from "./authentik";
import { AuthentikOperations } from "./authentik-control";
import { fakeAuthentik } from "./fake-authentik";

/**
 * Authentik against the stand-in (answering as a throwaway 2026.8.5 did; authentik-real.test.ts runs
 * the same calls against a real one): sign-in health and failed sign-ins without any secret, apps,
 * outposts, tasks, certificates, and the protected account changes.
 */

const BASE = "http://10.0.0.9:9010";
const TOKEN = "e2e-authentik-token";
const service = { id: "ak", name: "Authentik", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeAuthentik();
  const calls: string[] = [];
  const fetchImpl: typeof fake.fetch = (url, init) => {
    calls.push(new URL(url).pathname);
    return fake.fetch(url, init);
  };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
  } as unknown as CredentialBroker;
  const ops = new AuthentikOperations(handle, broker, fetchImpl);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-authentik-control" as const,
    serviceId: "ak",
    requestedBy: "you" as const,
    params: params!,
  });
  return { fake, fetchImpl, calls, ops, step };
}

describe("reading Authentik", () => {
  it("reads sign-ins, failed sign-ins, people, apps, outposts, tasks and certificates, and nothing secret", async () => {
    const { fetchImpl, calls } = setup();
    const d = await authentikDashboard(fetchImpl, BASE, TOKEN);
    expect(d).toMatchObject({
      version: "2026.8.5",
      signIns: 2,
      failedCount: 12,
      activeUsers: 2,
      workers: 1,
    });
    expect(d.failedSignIns[0]).toEqual({
      username: "sam",
      at: expect.any(String),
      ip: "203.0.113.9",
    });
    expect(d.users.map((u) => u.username)).toEqual(["akadmin", "sam"]);
    expect(d.applications[0]).toEqual({
      slug: "paperless",
      name: "Paperless",
      protects: "paperless.example.com",
      provider: "Proxy Provider",
    });
    expect(d.outposts.map((o) => [o.name, o.healthy, o.outdated])).toEqual([
      ["authentik Embedded Outpost", true, false],
      ["LDAP outpost", false, true],
    ]);
    expect(d.certificates).toEqual([
      { name: "authentik Self-signed Certificate", expires: expect.any(String), days: 9 },
    ]);
    const text = JSON.stringify(d);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain(TOKEN);
    // /admin/system/ echoes the token back: never asked.
    expect(calls).not.toContain("/api/v3/admin/system/");
  });

  it("reports the outpost, failed sign-ins, the failed task and the certificate; a wrong token plainly", async () => {
    const { fetchImpl } = setup();
    const r = await readAuthentik(BASE, TOKEN, fetchImpl);
    expect(r.issues.map((i) => i.key)).toEqual([
      "outpost-down",
      "failed-sign-ins",
      "tasks-failed",
      "certificate",
    ]);
    expect(r.issues[3]!.text).toBe(
      'Authentik\'s certificate "authentik Self-signed Certificate" expires in 9 days.',
    );
    await expect(authentikDashboard(fetchImpl, BASE, "wrong")).rejects.toThrow(
      /refused the API token/,
    );
  });
});

describe("changing Authentik", () => {
  it("turns an account off as a protected plan, read back, and undoes it", async () => {
    const { ops, step } = setup();
    const planned = await ops.plan(service, { op: "user-off", userId: 7 }, base);
    expect(planned.label).toBe(
      "Turn off sam's account in Authentik (they cannot sign in anywhere it guards)",
    );
    expect(planned.params).toMatchObject({ protected: "yes", userId: 7 });
    expect(await ops.run(step(planned.params), service)).toMatchObject({
      ok: true,
      verified: true,
    });
    expect(await ops.undo(step(planned.params), service)).toMatchObject({
      ok: true,
      verified: true,
      result: "sam's account is on in Authentik.",
    });
  });

  it("never turns off the token's own account or the last administrator, and retries a failed task", async () => {
    const { ops, step } = setup();
    await expect(ops.plan(service, { op: "user-off", userId: 6 }, base)).rejects.toThrow(
      /Hearth's token belongs to/,
    );
    const t = await ops.plan(service, { op: "retry-task", taskId: "t-1" }, base);
    expect(t.label).toBe(
      'Retry the failed task "authentik.outposts.tasks.outpost_send_update" in Authentik',
    );
    expect((await ops.run(step(t.params), service)).ok).toBe(true);
    await expect(ops.plan(service, { op: "retry-task", taskId: "t-1" }, base)).rejects.toThrow(
      /no failed task/,
    );
  });
});
