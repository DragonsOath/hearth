import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeSyncthing } from "./fake-syncthing";
import { syncthingDashboard, SyncthingOperations } from "./syncthing-live";

/** Syncthing's panel and controls, against a stand-in that answers like Syncthing 1.29. */

const BASE = "http://10.0.0.9:8384";
const KEY = "e2e-sync-key";
const service = { id: "sync", name: "Syncthing", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-syncthing-control" as const,
  serviceId: "sync",
  requestedBy: "you" as const,
  params,
});
const ops = () => new SyncthingOperations(handle, broker, fakeSyncthing().fetch);

describe("the Syncthing panel", () => {
  it("puts failing folders first, shows progress and who each is shared with, and leaves this machine out", async () => {
    const d = await syncthingDashboard(fakeSyncthing().fetch, BASE, KEY);
    expect(d.folders.map((f) => f.name)).toEqual(["Documents", "Phone photos", "Music"]);
    expect(d.folders[0]).toMatchObject({
      errors: 1,
      failed: [{ path: "taxes/2025.pdf", why: "permission denied" }],
      sharedWith: ["Laptop"],
      kind: "send and receive",
    });
    expect(d.folders[1]).toMatchObject({
      syncedPct: 80,
      needFiles: 140,
      needMb: 2048,
      kind: "receive only",
    });
    expect(d.devices.map((x) => [x.name, x.connected])).toEqual([
      ["Pixel", true],
      ["Laptop", false],
    ]);
    expect(d.devices[0]?.address).toBe("192.168.1.50:22000");
  });
});

describe("Syncthing controls", () => {
  it("pauses and resumes a folder, reading it back", async () => {
    const o = ops();
    const pause = await o.plan(service, { op: "pause-folder", folderId: "music" }, base);
    expect(pause.label).toBe("Pause the folder Music in Syncthing (nothing is deleted)");
    expect(await o.run(step(pause.params), service)).toEqual({
      ok: true,
      result: "Music is paused. Syncthing confirms it.",
    });
    await expect(o.plan(service, { op: "rescan", folderId: "music" }, base)).rejects.toThrow(
      /paused/,
    );
    const resume = await o.plan(service, { op: "resume-folder", folderId: "music" }, base);
    expect(await o.run(step(resume.params), service)).toMatchObject({ ok: true });
  });

  it("rescans a folder and pauses a machine", async () => {
    const o = ops();
    const scan = await o.plan(service, { op: "rescan", folderId: "docs" }, base);
    expect(await o.run(step(scan.params), service)).toEqual({
      ok: true,
      result: "Syncthing is rescanning Documents.",
    });
    const dev = await o.plan(service, { op: "pause-device", deviceId: "CCCCCCC-LAPTOPL" }, base);
    expect(dev.label).toContain("Pause syncing with Laptop");
    expect(await o.run(step(dev.params), service)).toMatchObject({ ok: true });
    await expect(
      o.plan(service, { op: "pause-device", deviceId: "CCCCCCC-LAPTOPL" }, base),
    ).rejects.toThrow(/already paused/);
  });
});
