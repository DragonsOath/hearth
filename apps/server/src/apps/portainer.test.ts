import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakePortainer } from "./fake-portainer";
import { PortainerClient, portainerDashboard, readPortainer } from "./portainer";
import { PortainerOperations } from "./portainer-control";

/**
 * Portainer against the stand-in (answering as a throwaway Portainer CE 2.45.3 did;
 * portainer-real.test.ts runs the same calls against a real one): the panel's reads, and every
 * change as a plan read back, protected when it touches networking, and never stopping Hearth.
 */

const BASE = "http://10.0.0.9:9000";
const KEY = "e2e-portainer";
const service = { id: "pt", name: "Portainer", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const pt = fakePortainer();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
  } as unknown as CredentialBroker;
  const ops = new PortainerOperations(handle, broker, pt.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-portainer-control" as const,
    serviceId: "pt",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  return { pt, ops, go, step, client: new PortainerClient(BASE, KEY, pt.fetch) };
}

describe("reading Portainer", () => {
  it("reads environments, stacks and containers live, and never a stack's variables", async () => {
    const { client } = setup();
    const d = await portainerDashboard(client);
    expect(d.version).toBe("2.45.3");
    expect(d.environments).toEqual([
      {
        id: 1,
        name: "local",
        kind: "docker",
        online: true,
        running: 4,
        stopped: 1,
        unhealthy: 1,
        stacks: 2,
        images: 24,
        cpus: 8,
        memoryBytes: 34359738368,
      },
      {
        id: 2,
        name: "nas",
        kind: "agent",
        online: false,
        running: 0,
        stopped: 0,
        unhealthy: 0,
        stacks: 0,
      },
    ]);
    expect(d.stacks[0]).toMatchObject({
      name: "media",
      running: true,
      containers: 2,
      containersRunning: 2,
      updatedBy: "alex",
    });
    expect(d.containers.find((x) => x.name === "media-sonarr-1")).toMatchObject({
      health: "unhealthy",
      stack: "media",
    });
    expect(d.updatesKnown).toBe(false);
    expect(JSON.stringify(d)).not.toContain("e2e-SECRET");
    const r = await readPortainer(BASE, KEY, setup().pt.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["environments-offline", "containers-unhealthy"]);
    await expect(readPortainer(BASE, "wrong", setup().pt.fetch)).rejects.toThrow(
      /refused the access token/,
    );
  });
});

describe("changing through Portainer, each a plan read back", () => {
  it("stops and starts a stack, refuses what would change nothing, and undoes", async () => {
    const { go, ops, step, pt } = setup();
    const stop = await go({ op: "stack-stop", environmentId: 1, stackId: 1 });
    expect(stop.planned.label).toBe("Stop the stack media (2 containers)");
    expect(stop.planned.params).not.toHaveProperty("protected");
    expect(stop.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "stack-stop", environmentId: 1, stackId: 1 }, base),
    ).rejects.toThrow(/already stopped/);
    expect(await ops.undo(step(stop.planned.params), service)).toMatchObject({ ok: true });
    expect(pt.containers().find((x) => x.Names[0] === "/media-radarr-1")!.State).toBe("running");
    const up = await go({ op: "stack-update", environmentId: 1, stackId: 1 });
    expect(up.planned.label).toMatch(/Update the stack media: pull its images and deploy it again/);
    expect(up.outcome).toMatchObject({ ok: true, verified: true });
  });

  it("protects networking, never stops Hearth, and restarts a container", async () => {
    const { go, ops } = setup();
    const vpn = await ops.plan(service, { op: "stack-stop", environmentId: 1, stackId: 2 }, base);
    expect(vpn.params).toMatchObject({ protected: "yes" });
    expect(vpn.label).toMatch(/runs networking: approving asks you to confirm it is you/);
    const g = await ops.plan(
      service,
      { op: "container-restart", environmentId: 1, container: "vpn-gluetun-1" },
      base,
    );
    expect(g.params).toMatchObject({ protected: "yes" });
    await expect(
      ops.plan(service, { op: "container-stop", environmentId: 1, container: "hearth" }, base),
    ).rejects.toThrow(/Hearth itself/);
    const r = await go({ op: "container-restart", environmentId: 1, container: "media-sonarr-1" });
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    const s = await go({ op: "container-start", environmentId: 1, container: "old-test" });
    expect(s.outcome).toMatchObject({ ok: true, verified: true, result: "old-test is running." });
    await expect(
      ops.plan(service, { op: "container-start", environmentId: 1, container: "nope" }, base),
    ).rejects.toThrow(/no container nope/);
  });
});
