import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeJellyfin } from "./fake-jellyfin";
import { jellyfinDashboard, JellyfinOperations, readJellyfin, whyTranscode } from "./jellyfin";

/** Jellyfin's health read, panel, and controls, against a stand-in answering like 10.10. */

const BASE = "http://10.0.0.9:8096";
const KEY = "e2e-jf-key";
const service = { id: "jf", name: "Jellyfin", localUrl: BASE };
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
  kind: "app-jellyfin-control" as const,
  serviceId: "jf",
  requestedBy: "you" as const,
  params,
});

describe("the Jellyfin panel", () => {
  it("shows who is watching and why it converts, libraries, users, failed tasks", async () => {
    const d = await jellyfinDashboard(fakeJellyfin().fetch, BASE, KEY);
    expect(d.streams).toHaveLength(2);
    expect(d.streams[0]).toMatchObject({
      user: "Alex",
      title: "Severance: Woe's Hollow",
      progressPct: 40,
      converting: false,
      away: false,
    });
    expect(d.streams[1]).toMatchObject({
      user: "sam",
      title: "Dune: Part Two (2024)",
      converting: true,
      away: true,
      why: "Converting: the player cannot play the video format; the file's bitrate is above the streaming limit.",
    });
    expect(d.libraries.map((l) => [l.name, l.folders])).toEqual([
      ["Movies", 1],
      ["Shows", 2],
    ]);
    expect(d.counts).toMatchObject({ movies: 812, shows: 140 });
    expect(d.tasks[0]).toMatchObject({
      name: "Extract Chapter Images",
      failed: true,
      error: "ffmpeg exited with code 1",
    });
  });

  it("reports a failed task as a health warning, and says plainly when the key is refused", async () => {
    const r = await readJellyfin(BASE, KEY, fakeJellyfin().fetch);
    expect(r.issues[0]?.text).toBe(
      'The task "Extract Chapter Images" failed: ffmpeg exited with code 1.',
    );
    await expect(readJellyfin(BASE, "wrong", fakeJellyfin().fetch)).rejects.toThrow(
      /refused the API key/,
    );
    expect(whyTranscode([])).toBeUndefined();
  });
});

describe("Jellyfin controls", () => {
  it("stops a stream with a message and checks it ended", async () => {
    const o = new JellyfinOperations(handle, broker, fakeJellyfin().fetch, async () => undefined);
    const planned = await o.plan(
      service,
      { op: "stop-stream", sessionId: "s2", message: "Maintenance" },
      base,
    );
    expect(planned.label).toBe(
      'Stop sam\'s stream of Dune: Part Two (2024) on iPhone · Jellyfin iOS with the message "Maintenance"',
    );
    expect(await o.run(step(planned.params), service)).toEqual({
      ok: true,
      result: "Stopped sam's stream; it is no longer playing.",
    });
    await expect(o.plan(service, { op: "stop-stream", sessionId: "s2" }, base)).rejects.toThrow(
      /already ended/,
    );
  });

  it("scans a library and runs a task", async () => {
    const o = new JellyfinOperations(handle, broker, fakeJellyfin().fetch, async () => undefined);
    const scan = await o.plan(service, { op: "scan-library", libraryId: "lib-shows" }, base);
    expect(await o.run(step(scan.params), service)).toEqual({
      ok: true,
      result: "Jellyfin is scanning Shows.",
    });
    const task = await o.plan(service, { op: "run-task", taskId: "t2" }, base);
    expect(task.label).toBe('Run Jellyfin\'s task "Extract Chapter Images" now');
    expect(await o.run(step(task.params), service)).toMatchObject({ ok: true });
  });

  it("stops a running task, turns one off keeping its schedule, and turns it back on", async () => {
    const jf = fakeJellyfin();
    const kept = new Map<string, unknown[]>();
    const schedules = {
      get: async (k: string) => kept.get(k),
      set: async (k: string, v: unknown[] | undefined) => {
        if (v) kept.set(k, v);
        else kept.delete(k);
      },
    };
    const o = new JellyfinOperations(handle, broker, jf.fetch, async () => undefined, schedules);
    const tasks = async () => (await jellyfinDashboard(jf.fetch, BASE, KEY)).tasks;

    // Generate Trickplay Images is running: turning it off removes its schedule and stops it.
    const off = await o.plan(service, { op: "turn-off-task", taskId: "t3" }, base);
    expect(off.label).toBe(
      'Turn off Jellyfin\'s task "Generate Trickplay Images" and stop it now: it stops running on its schedule. Hearth keeps the schedule to put back.',
    );
    expect(await o.run(step(off.params), service)).toEqual({
      ok: true,
      result:
        "Turned off Generate Trickplay Images: it no longer runs on its own, and the run in progress was stopped. Turn it back on from the panel any time.",
    });
    expect((await tasks()).find((t) => t.id === "t3")).toMatchObject({
      running: false,
      scheduled: false,
    });
    await expect(o.plan(service, { op: "turn-off-task", taskId: "t3" }, base)).rejects.toThrow(
      "already off",
    );

    // Back on, with exactly the schedule it had.
    const on = await o.plan(service, { op: "turn-on-task", taskId: "t3" }, base);
    expect(await o.run(step(on.params), service)).toMatchObject({ ok: true });
    expect((await tasks()).find((t) => t.id === "t3")?.scheduled).toBe(true);
    expect(kept.size).toBe(0);
    await expect(o.plan(service, { op: "turn-on-task", taskId: "t1" }, base)).rejects.toThrow(
      "already on",
    );

    // Stopping only a run leaves the schedule alone; a task that is not running cannot stop.
    await expect(o.plan(service, { op: "stop-task", taskId: "t1" }, base)).rejects.toThrow(
      "is not running",
    );
  });
});
