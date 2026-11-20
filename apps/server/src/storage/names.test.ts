import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { VolumeNames } from "./names";

/** Drive names: by filesystem id when known (survive a remount), never inherited by a new drive. */

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

describe("VolumeNames", () => {
  it("names a drive by its filesystem id, so the name follows it to a new mount", async () => {
    const handle = await db();
    let uuids = new Map([
      ["/mnt/f", "AAAA"],
      ["/mnt/d", "BBBB"],
    ]);
    const names = new VolumeNames(handle, async () => uuids);
    await names.set("/mnt/f/", "Film");
    await names.set("/mnt/d", "TV");
    expect(Object.fromEntries(await names.all())).toEqual({ "/mnt/f": "Film", "/mnt/d": "TV" });
    // Remounted elsewhere: the same filesystem keeps its name.
    uuids = new Map([
      ["/mnt/film", "AAAA"],
      ["/mnt/d", "BBBB"],
    ]);
    const later = new VolumeNames(handle, async () => uuids);
    expect(await later.nameOf("/mnt/film")).toBe("Film");
    // A replacement drive at the old mount has another id: no inherited name.
    uuids = new Map([
      ["/mnt/f", "CCCC"],
      ["/mnt/d", "BBBB"],
    ]);
    const replaced = new VolumeNames(handle, async () => uuids);
    expect(await replaced.nameOf("/mnt/f")).toBeUndefined();
  });

  it("falls back to the mount point without an id, renames, clears, and refuses odd names", async () => {
    const handle = await db();
    const names = new VolumeNames(handle, async () => new Map());
    await names.set("E:\\", "Alternative Media");
    expect(await names.nameOf("E:")).toBe("Alternative Media");
    await names.set("E:", "Other");
    expect(await names.nameOf("E:")).toBe("Other");
    await names.set("E:", "");
    expect(await names.nameOf("E:")).toBeUndefined();
    await expect(names.set("/mnt/x", "<script>")).rejects.toThrow(/letters/);
  });
});
