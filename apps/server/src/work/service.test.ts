import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import { Work } from "./service";

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  let now = new Date("2026-10-14T01:00:00Z");
  const work = new Work(handle, () => now);
  return {
    work,
    advance: (minutes: number) => {
      now = new Date(now.getTime() + minutes * 60_000);
    },
  };
}

const training = {
  title: "Voice training",
  machine: "Gaming-PC",
  stallMinutes: 10,
  reportedBy: "pc2-trainer",
};

describe("long work", () => {
  it("records progress, and any report is a heartbeat", async () => {
    const { work, advance } = await setup();
    const w = await work.start(training);
    expect(w).toMatchObject({ status: "running", heartbeatAt: "2026-10-14T01:00:00.000Z" });
    advance(8);
    const r = await work.report(w.id, { progress: 40, detail: "operator: 400 of 1012" });
    expect(r).toMatchObject({ progress: 40, detail: "operator: 400 of 1012" });
    advance(8);
    // 8 minutes after the last report: not stalled.
    expect(await work.sweep()).toEqual([]);
  });

  it("marks silent work stalled and says so once, then again only after it recovers and stops again", async () => {
    const { work, advance } = await setup();
    const w = await work.start(training);
    advance(11);
    const first = await work.sweep();
    expect(first.map((a) => a.kind)).toEqual(["stalled"]);
    expect((await work.get(w.id)).status).toBe("stalled");
    advance(5);
    expect(await work.sweep()).toEqual([]);
    // It reports again: back to running, and a later stall is news.
    await work.report(w.id, { progress: 50 });
    expect((await work.get(w.id)).status).toBe("running");
    advance(11);
    expect((await work.sweep()).map((a) => a.kind)).toEqual(["stalled"]);
  });

  it("warns once when it runs past its stop time", async () => {
    const { work, advance } = await setup();
    await work.start({ ...training, stopBy: "2026-10-14T01:30:00Z", stallMinutes: 60 });
    advance(29);
    expect(await work.sweep()).toEqual([]);
    advance(2);
    expect((await work.sweep()).map((a) => a.kind)).toEqual(["overdue"]);
    expect(await work.sweep()).toEqual([]);
  });

  it("closes on a finished status, tells once, and refuses reports after that", async () => {
    const { work } = await setup();
    const w = await work.start(training);
    const done = await work.report(w.id, { status: "done", progress: 100 });
    expect(done).toMatchObject({ status: "done", finishedAt: expect.any(String) });
    expect((await work.sweep()).map((a) => a.kind)).toEqual(["done"]);
    expect(await work.sweep()).toEqual([]);
    await expect(work.report(w.id, { progress: 1 })).rejects.toThrow(/already finished/);
    await expect(work.report("nope", {})).rejects.toThrow(/No such/);
  });

  it("lists what is running and what finished in the last two days", async () => {
    const { work, advance } = await setup();
    const old = await work.start({ ...training, title: "Old copy" });
    await work.report(old.id, { status: "done" });
    advance(3 * 24 * 60);
    await work.start({ ...training, title: "New training" });
    expect((await work.list()).map((w) => w.title)).toEqual(["New training"]);
  });

  it("needs a title and a machine, and a real stop time", async () => {
    const { work } = await setup();
    await expect(work.start({ ...training, title: " " })).rejects.toThrow(/title and a machine/);
    await expect(work.start({ ...training, stopBy: "tonight" })).rejects.toThrow(/not a date/);
  });
});
