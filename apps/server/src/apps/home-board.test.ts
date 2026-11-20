import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { BoardChange, changeBoard, readBoard } from "./home-board";

// The household board (11-05): notes, countdowns, chores with stars, reminders, feeds, photos.

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
async function db() {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  return handle;
}

describe("the household board", () => {
  it("keeps notes and countdowns, newest note first and countdowns by date", async () => {
    const h = await db();
    await changeBoard(h, { op: "note.add", text: "Dinner at 7", by: "Alex" });
    const b = await changeBoard(h, { op: "note.add", text: "Feed the cat" });
    expect(b.notes.map((n) => n.text)).toEqual(["Feed the cat", "Dinner at 7"]);
    await changeBoard(h, { op: "countdown.add", title: "Vacation", date: "2027-03-01" });
    const c = await changeBoard(h, { op: "countdown.add", title: "Birthday", date: "2026-12-02" });
    expect(c.countdowns.map((x) => x.title)).toEqual(["Birthday", "Vacation"]);
    const gone = await changeBoard(h, { op: "note.remove", id: b.notes[0]!.id });
    expect(gone.notes.map((n) => n.text)).toEqual(["Dinner at 7"]);
  });

  it("gives stars for a chore once a day, and takes them back on undo", async () => {
    const h = await db();
    const b = await changeBoard(h, {
      op: "task.add",
      kind: "chore",
      title: "Empty the dishwasher",
      who: "Sam",
      stars: 2,
      schedule: { type: "week", days: [1, 3, 5] },
    });
    const id = b.tasks[0]!.id;
    await changeBoard(h, { op: "task.done", id, on: "2026-11-05" });
    const twice = await changeBoard(h, { op: "task.done", id, on: "2026-11-05" });
    expect(twice.stars).toEqual({ Sam: 2 });
    expect(twice.tasks[0]!.done).toEqual(["2026-11-05"]);
    const undone = await changeBoard(h, { op: "task.undo", id, on: "2026-11-05" });
    expect(undone.stars).toEqual({ Sam: 0 });
    // A reminder has no stars.
    const r = await changeBoard(h, {
      op: "task.add",
      kind: "reminder",
      title: "Bins out",
      schedule: { type: "every", n: 7, start: "2026-11-03" },
    });
    expect(r.tasks[1]).toMatchObject({ kind: "reminder", title: "Bins out" });
    expect(r.tasks[1]!.stars).toBeUndefined();
  });

  it("refuses what makes no sense, and keeps every change when two screens tap at once", async () => {
    const h = await db();
    expect(() =>
      BoardChange.parse({ op: "task.add", kind: "chore", title: "x", schedule: { type: "week" } }),
    ).toThrow(/Which days/);
    expect(() => BoardChange.parse({ op: "countdown.add", title: "x", date: "soon" })).toThrow();
    await expect(
      changeBoard(h, { op: "feeds.set", feeds: [{ url: "file:///etc/passwd" }] }),
    ).rejects.toThrow(/http/);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => changeBoard(h, { op: "note.add", text: `n${i}` })),
    );
    expect((await readBoard(h)).notes).toHaveLength(8);
  });
});
