import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { frigateDashboard, readFrigate } from "./frigate";
import { FrigateOperations } from "./frigate-control";
import { localTlsFetch } from "./local-tls";

/**
 * The same reads and changes as frigate.test.ts against a real Frigate: only a throwaway one made for
 * this, on its signed-in port (8971, self-signed, reached through the pinned connection Hearth uses),
 * with one camera looping a test video, one pointed at a missing file, and one event. It runs only
 * with HEARTH_FRIGATE_TEST_URL, HEARTH_FRIGATE_TEST_PASSWORD_FILE (the admin password) and
 * HEARTH_FRIGATE_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_FRIGATE_TEST_URL ?? "";
const file = process.env.HEARTH_FRIGATE_TEST_PASSWORD_FILE;
const run = Boolean(url && file && process.env.HEARTH_FRIGATE_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

describe.skipIf(!run)(
  `a real, throwaway Frigate at ${url || "(none)"}`,
  { timeout: 180_000 },
  () => {
    const login = { username: "admin", password: run ? readFileSync(file!, "utf8").trim() : "" };
    const service = { id: "real", name: "Frigate", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
        fn({ value: login.password, username: login.username }),
    } as unknown as CredentialBroker;
    const ops = new FrigateOperations(handle, broker, localTlsFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-frigate-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });
    const go = async (params: PlannedStep["params"]) => {
      const planned = await ops.plan(service, params, base);
      return { planned, outcome: await ops.run(step(planned.params), service) };
    };

    it("reads cameras, detectors, events, alerts and storage, and no stream address or password", async () => {
      const d = await frigateDashboard(localTlsFetch, url, login);
      expect(d.version).toMatch(/^0\.\d+/);
      expect(d.cameras.find((c) => c.name === "front_door")).toMatchObject({ online: true });
      expect(d.cameras.find((c) => c.name === "garage")).toMatchObject({ online: false, fps: 0 });
      expect(d.detectors[0]!.inferenceMs).toBeGreaterThan(0);
      expect(d.events.length).toBeGreaterThan(0);
      expect(d.storage!.totalGb).toBeGreaterThan(0);
      const text = JSON.stringify(d);
      expect(text).not.toContain(login.password);
      expect(text).not.toContain("/media/frigate/");
      expect((await readFrigate(url, login, localTlsFetch)).issues.map((i) => i.key)).toContain(
        "camera-offline",
      );
      await expect(
        frigateDashboard(localTlsFetch, url, { username: "admin", password: "wrong-password" }),
      ).rejects.toThrow(/refused the username or password/);
    });

    it("turns detection on and off by undo, read back from the stats; keeps an event and lets it go", async () => {
      const d = await frigateDashboard(localTlsFetch, url, login);
      const was = d.cameras.find((c) => c.name === "front_door")!.detecting;
      const flip = await go({ op: was ? "detect-off" : "detect-on", camera: "front_door" });
      expect(flip.outcome).toMatchObject({ ok: true, verified: true });
      expect(await ops.undo(step(flip.planned.params), service)).toMatchObject({
        ok: true,
        verified: true,
      });
      const e = d.events[0]!;
      const keep = await go({ op: e.kept ? "event-unkeep" : "event-keep", eventId: e.id });
      expect(keep.outcome).toMatchObject({ ok: true, verified: true });
      expect(await ops.undo(step(keep.planned.params), service)).toMatchObject({
        ok: true,
        verified: true,
      });
      expect((await go({ op: "record-off", camera: "front_door" })).outcome.ok).toBe(true);
      expect((await go({ op: "record-on", camera: "front_door" })).outcome.ok).toBe(true);
    });
  },
);
