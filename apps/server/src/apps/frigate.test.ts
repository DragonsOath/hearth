import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeFrigate } from "./fake-frigate";
import { frigateDashboard, readFrigate } from "./frigate";
import { FrigateOperations } from "./frigate-control";

/**
 * Frigate against the stand-in (answering as a throwaway 0.18.2 did; frigate-real.test.ts runs the
 * same calls against a real one): cameras, detectors, events, alerts and storage without any stream
 * address, and each change as a plan read back.
 */

const at = (n: number) => `https://10.0.0.${n}:8971`;
const login = { username: "admin", password: "e2e-frigate-pass" };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup(n: number) {
  const fake = fakeFrigate();
  const calls: string[] = [];
  const fetchImpl: typeof fake.fetch = (url, init) => {
    calls.push(new URL(url).pathname);
    return fake.fetch(url, init);
  };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: login.password, username: login.username }),
  } as unknown as CredentialBroker;
  const ops = new FrigateOperations(handle, broker, fetchImpl, async () => undefined);
  const service = { id: "fr", name: "Frigate", localUrl: at(n) };
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-frigate-control" as const,
    serviceId: "fr",
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
  return { fake, fetchImpl, calls, ops, service, go };
}

describe("reading Frigate", () => {
  it("reads cameras, detectors, events, alerts and storage, never the config or a stream address", async () => {
    const { fetchImpl, calls } = setup(11);
    const d = await frigateDashboard(fetchImpl, at(11), login);
    expect(d).toMatchObject({
      version: "0.18.2-cfa08c5",
      alertsToday: 3,
      detectionsToday: 7,
      unreviewed: 2,
    });
    expect(d.cameras).toEqual([
      {
        name: "front_door",
        fps: 5,
        expectedFps: 5,
        detecting: true,
        online: true,
        connection: "good",
        reconnects: 0,
        storageMb: 812000,
      },
      {
        name: "garage",
        fps: 0,
        expectedFps: 5,
        detecting: true,
        online: false,
        connection: "unusable",
        reconnects: 4,
        storageMb: 168000,
      },
    ]);
    expect(d.detectors).toEqual([{ name: "coral", inferenceMs: 8.4 }]);
    expect(d.storage).toEqual({ usedGb: 957, totalGb: 1000, freeGb: 43 });
    expect(d.events[0]).toMatchObject({ camera: "front_door", label: "person", kept: false });
    expect(JSON.stringify(d)).not.toMatch(/rtsp|SECRET|e2e-frigate-pass/);
    expect(calls).not.toContain("/api/config");
  });

  it("reports the camera with no picture and the full disk, and refuses a wrong password plainly", async () => {
    const { fetchImpl } = setup(12);
    expect((await readFrigate(at(12), login, fetchImpl)).issues.map((i) => i.key)).toEqual([
      "camera-offline",
      "storage",
    ]);
    await expect(
      frigateDashboard(fetchImpl, at(13), { username: "admin", password: "wrong" }),
    ).rejects.toThrow(/refused the username or password/);
  });
});

describe("changing Frigate", () => {
  it("turns detection off, read back, and undoes it", async () => {
    const { go, ops, service, fetchImpl } = setup(14);
    const off = await go({ op: "detect-off", camera: "garage" });
    expect(off.planned.label).toBe(
      "Turn off object detection for garage (no new events until it is back on) in Frigate",
    );
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect((await frigateDashboard(fetchImpl, at(14), login)).cameras[1]!.detecting).toBe(false);
    expect(await ops.undo(off.step, service)).toMatchObject({ ok: true, verified: true });
  });

  it("keeps and deletes events, switches recording and restarts", async () => {
    const { go } = setup(15);
    expect((await go({ op: "event-keep", eventId: "1794184751.37-a1" })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    const del = await go({ op: "event-delete", eventId: "1794184001.12-b2" });
    expect(del.planned.label).toBe(
      "Delete the event car on front_door and its snapshot and clip in Frigate",
    );
    expect(del.outcome).toMatchObject({ ok: true, verified: true });
    expect((await go({ op: "record-off", camera: "front_door" })).outcome.ok).toBe(true);
    expect((await go({ op: "restart" })).outcome).toMatchObject({ ok: true, verified: true });
    await expect(go({ op: "detect-on", camera: "attic" })).rejects.toThrow(/no camera called that/);
  });
});
