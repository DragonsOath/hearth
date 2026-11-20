import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import { setSetting } from "../store/settings";
import { FileIndexer, kindOf } from "./file-index";
import { FileManager } from "./files";

/** Recently Added: arrivals, moves, and deletions across passes; secrets and recycle bins skipped. */

const handles: DbHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dc-index-")));
  dirs.push(root);
  const drive = path.join(root, "d");
  await fs.mkdir(path.join(drive, "Movies", "Old (1999)"), { recursive: true });
  await fs.mkdir(path.join(drive, "$RECYCLE.BIN"), { recursive: true });
  await fs.mkdir(path.join(drive, "secrets"), { recursive: true });
  await fs.writeFile(path.join(drive, "Movies", "Old (1999)", "Old.mkv"), "x".repeat(5));
  await fs.writeFile(path.join(drive, "$RECYCLE.BIN", "trash.mkv"), "t");
  await fs.writeFile(path.join(drive, "secrets", "token.txt"), "s");
  await fs.mkdir(path.join(drive, "projects", "app", "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(drive, "projects", "app", "node_modules", "x", "index.js"), "j");
  const old = new Date("2020-01-01T00:00:00Z");
  await fs.utimes(path.join(drive, "Movies", "Old (1999)", "Old.mkv"), old, old);
  await setSetting(handle.db, "environment", "real");
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Homeserver",
    role: "server",
    os: "Linux",
    address: "127.0.0.1",
    cpuModel: "x",
    cpuCores: 8,
    cpuUsagePct: 0,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 1,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeenAt: "2026-10-10T00:00:00Z",
  });
  await handle.db.insert(t.volumes).values({
    id: "d",
    hostId: "h1",
    label: "D",
    mount: drive,
    kind: "hdd",
    totalTb: 20,
    usedTb: 7,
    smart: "ok",
  });
  const files = new FileManager(handle, []);
  return { indexer: new FileIndexer(handle, files), drive };
}

describe("FileIndexer", () => {
  it("the first pass uses each file's own time; later arrivals are observed, with Open in folder", async () => {
    const { indexer, drive } = await setup();
    const first = await indexer.run();
    expect(first).toMatchObject({ files: 1, added: 0, complete: true });
    const year = await indexer.added({ days: 365 * 10, arrivals: "all" });
    expect(year.files).toEqual([
      expect.objectContaining({
        name: "Old.mkv",
        basis: "timestamp",
        addedAt: "2020-01-01T00:00:00.000Z",
      }),
    ]);
    expect((await indexer.added({ days: 7 })).files).toEqual([]);

    await fs.mkdir(path.join(drive, "Downloads"), { recursive: true });
    await fs.writeFile(path.join(drive, "Downloads", "Dune.Part.Two.mkv"), "y".repeat(9));
    await fs.writeFile(path.join(drive, "Downloads", "Next.mkv.!qB"), "z");
    const second = await indexer.run();
    expect(second).toMatchObject({ added: 2, gone: 0 });
    const week = await indexer.added({ days: 7 });
    expect(week.files.map((f) => f.name).sort()).toEqual(["Dune.Part.Two.mkv", "Next.mkv.!qB"]);
    const dune = week.files.find((f) => f.name === "Dune.Part.Two.mkv")!;
    expect(dune).toMatchObject({
      basis: "observed",
      sizeBytes: 9,
      kind: "video",
      partial: false,
      open: { rootId: "vol-d", folder: "Downloads", name: "Dune.Part.Two.mkv" },
    });
    expect(week.files.find((f) => f.name === "Next.mkv.!qB")!.partial).toBe(true);
    // Never the recycle bin or a secrets folder.
    expect(week.indexed).toBe(3);
  });

  it("keeps a moved file's history and says where it came from", async () => {
    const { indexer, drive } = await setup();
    await indexer.run();
    await fs.mkdir(path.join(drive, "Downloads"), { recursive: true });
    await fs.writeFile(path.join(drive, "Downloads", "Heat.mkv"), "h".repeat(7));
    await indexer.run();
    await fs.mkdir(path.join(drive, "Movies", "Heat (1995)"), { recursive: true });
    await fs.rename(
      path.join(drive, "Downloads", "Heat.mkv"),
      path.join(drive, "Movies", "Heat (1995)", "Heat.mkv"),
    );
    const third = await indexer.run();
    expect(third).toMatchObject({ added: 1, gone: 1 });
    const now = await indexer.added({ days: 7 });
    expect(now.files).toEqual([
      expect.objectContaining({
        path: path.join(drive, "Movies", "Heat (1995)", "Heat.mkv"),
        movedFrom: path.join(drive, "Downloads", "Heat.mkv"),
      }),
    ]);
    const withGone = await indexer.added({ days: 7, includeGone: true });
    expect(withGone.files.find((f) => f.goneAt)).toMatchObject({
      path: path.join(drive, "Downloads", "Heat.mkv"),
    });
  });

  it("filters by kind and words", async () => {
    const { indexer, drive } = await setup();
    await indexer.run();
    await fs.writeFile(path.join(drive, "book.epub"), "b");
    await fs.writeFile(path.join(drive, "Song.flac"), "a");
    await indexer.run();
    expect((await indexer.added({ days: 7, kind: "book" })).files.map((f) => f.name)).toEqual([
      "book.epub",
    ]);
    expect((await indexer.added({ days: 7, q: "song" })).files.map((f) => f.name)).toEqual([
      "Song.flac",
    ]);
    expect(kindOf("x.m4b")).toBe("audio");
  });

  it("skips app internals (settings, caches) and clears them from the index", async () => {
    const { drive } = await setup();
    const handle = handles[0]!;
    await fs.mkdir(path.join(drive, "docker", "config", "plex", "Metadata"), { recursive: true });
    await fs.writeFile(path.join(drive, "docker", "config", "plex", "Metadata", "poster.jpg"), "p");
    const plain = new FileIndexer(handle, new FileManager(handle, []));
    await plain.run();
    expect((await plain.added({ days: 365 * 10, arrivals: "all" })).indexed).toBe(2);
    const noise = path.join(drive, "docker", "config");
    const quiet = new FileIndexer(handle, new FileManager(handle, []), async () => [noise]);
    await quiet.run();
    const all = await quiet.added({ days: 365 * 10, includeGone: true, arrivals: "all" });
    expect(all.indexed).toBe(1);
    expect(all.files.map((f) => f.name)).toEqual(["Old.mkv"]);
  });

  it("on the app drive (it holds Hearth's data) indexes only library and download folders", async () => {
    const { drive } = await setup();
    const handle = handles[0]!;
    const keys = path.join(drive, "hearth-data");
    await fs.mkdir(keys, { recursive: true });
    await fs.mkdir(path.join(drive, "backups", "plex"), { recursive: true });
    await fs.writeFile(path.join(drive, "backups", "plex", "meta.bin"), "b");
    const downloads = path.join(drive, "docker", "downloads");
    await fs.mkdir(downloads, { recursive: true });
    await fs.writeFile(path.join(downloads, "Film.mkv"), "f");
    // First as a data drive: everything; then known to be the app drive: only /downloads stays.
    const files = new FileManager(handle, [keys]);
    const asData = new FileIndexer(handle, new FileManager(handle, []));
    await asData.run();
    expect((await asData.added({ days: 365 * 10, arrivals: "all" })).indexed).toBe(3);
    const asApp = new FileIndexer(
      handle,
      files,
      async () => [],
      async () => [
        { path: downloads, label: "downloads", role: "downloads", apps: ["qBittorrent"] },
      ],
    );
    const run = await asApp.run();
    expect(run).toMatchObject({ gone: 0 });
    const all = await asApp.added({ days: 365 * 10, includeGone: true, arrivals: "all" });
    expect(all.files.map((f) => f.name)).toEqual(["Film.mkv"]);
    // A folder you chose to watch on the app drive is yours: indexed too.
    const films = path.join(drive, "Films");
    await fs.mkdir(films, { recursive: true });
    await fs.writeFile(path.join(films, "Big.mkv"), "m");
    await handle.db.insert(t.storageLocations).values({
      id: "w1",
      hostId: "h1",
      label: "Films",
      path: films,
      source: "fs",
      addedAt: "2026-10-20T00:00:00Z",
    });
    await asApp.run();
    const mine = await asApp.added({ days: 365 * 10, arrivals: "all" });
    expect(mine.files.map((f) => f.name).sort()).toEqual(["Big.mkv", "Film.mkv"]);
    // It was there before the folder was watched: dated by its file, not an arrival.
    expect(mine.files.find((f) => f.name === "Big.mkv")!.basis).toBe("timestamp");
    expect((await asApp.added({ days: 7 })).files).toEqual([]);
    // Once watched, a new file is an arrival.
    await fs.writeFile(path.join(films, "New.mkv"), "n");
    await asApp.run();
    expect((await asApp.added({ days: 7 })).files.map((f) => f.name)).toEqual(["New.mkv"]);
    // A watched folder that holds the drives (a watched /mnt) never walks the app's internals.
    await handle.db.insert(t.storageLocations).values({
      id: "w-all",
      hostId: "h1",
      label: "mnt",
      path: path.dirname(drive),
      source: "fs",
      addedAt: "2026-10-20T00:00:00Z",
    });
    await asApp.run();
    const after = await asApp.added({ days: 365 * 10, arrivals: "all", includeGone: true });
    expect(after.files.map((f) => f.name).sort()).toEqual(["Big.mkv", "Film.mkv", "New.mkv"]);
  });

  it("a watched folder you remove is cleared; a missing drive keeps its history", async () => {
    const { indexer, drive } = await setup();
    const handle = handles[0]!;
    const outside = path.join(path.dirname(drive), "elsewhere");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "Kept.mkv"), "k");
    await handle.db.insert(t.storageLocations).values({
      id: "w2",
      hostId: "h1",
      label: "Elsewhere",
      path: outside,
      source: "fs",
      addedAt: "2026-10-20T00:00:00Z",
    });
    await indexer.run();
    expect((await indexer.added({ days: 365 * 10, arrivals: "all" })).indexed).toBe(2);
    await handle.db.delete(t.storageLocations);
    await handle.db.delete(t.volumes);
    await indexer.run();
    const left = await indexer.added({ days: 365 * 10, arrivals: "all", includeGone: true });
    expect(left.files.map((f) => f.name)).toEqual(["Old.mkv"]);
    expect(left.files[0]!.goneAt).toBeUndefined();
  });

  it("old files recorded as arrivals before arrival windows existed are dated by their file", async () => {
    const { indexer, drive } = await setup();
    const handle = handles[0]!;
    const row = (name: string, over: Partial<typeof t.fileIndex.$inferInsert>) => ({
      path: path.join(drive, name),
      rootId: "vol-d",
      hostId: "h1",
      sizeBytes: 1,
      modifiedAt: "2024-09-03T02:31:44.000Z",
      firstSeenAt: "2026-10-21T03:48:14.876Z",
      basis: "observed" as const,
      lastSeenAt: "2026-10-21T03:48:14.876Z",
      ...over,
    });
    await handle.db
      .insert(t.fileIndex)
      .values([
        row("Prologue.mp3", {}),
        row("Fresh.mkv", { modifiedAt: "2026-10-21T03:40:00.000Z" }),
        row("Windowed.mkv", { seenAfter: "2026-10-21T03:38:00.000Z" }),
      ]);
    const sql = await fs.readFile(
      path.join(SERVER_ROOT, "drizzle", "0053_arrivals_before_tracking.sql"),
      "utf8",
    );
    handle.sqlite.exec(sql);
    const all = await indexer.added({ days: 365 * 10, arrivals: "all" });
    const basis = Object.fromEntries(all.files.map((f) => [f.name, f.basis]));
    expect(basis).toMatchObject({
      "Prologue.mp3": "timestamp",
      "Fresh.mkv": "observed",
      "Windowed.mkv": "observed",
    });
  });

  it("a check asked for during a pass gets a pass that sees what changed since", async () => {
    const { indexer, drive } = await setup();
    const during = indexer.run();
    await fs.writeFile(path.join(drive, "Late.mkv"), "l");
    const asked = indexer.run();
    const again = indexer.run();
    expect(asked).toBe(again);
    await during;
    await asked;
    const all = await indexer.added({ days: 365 * 10, arrivals: "all" });
    expect(all.files.map((f) => f.name)).toContain("Late.mkv");
  });

  it("records the window an arrival happened in, a finished download, and hardlinks", async () => {
    const { indexer, drive } = await setup();
    const first = await indexer.run();
    await fs.mkdir(path.join(drive, "Downloads"), { recursive: true });
    await fs.writeFile(path.join(drive, "Downloads", "Arrival.mkv.!qB"), "a".repeat(4));
    await indexer.run();
    // qBittorrent finishes: the partial is renamed to its final name.
    await fs.rename(
      path.join(drive, "Downloads", "Arrival.mkv.!qB"),
      path.join(drive, "Downloads", "Arrival.mkv"),
    );
    // Radarr hardlinks it into the library (same data, no extra space).
    await fs.mkdir(path.join(drive, "Movies", "Arrival (2016)"), { recursive: true });
    const linked = await fs
      .link(
        path.join(drive, "Downloads", "Arrival.mkv"),
        path.join(drive, "Movies", "Arrival (2016)", "Arrival.mkv"),
      )
      .then(
        () => true,
        () => false,
      );
    await indexer.run();
    const week = await indexer.added({ days: 7 });
    const done = week.files.find((f) => f.path === path.join(drive, "Downloads", "Arrival.mkv"))!;
    expect(done.movedFrom).toBe(path.join(drive, "Downloads", "Arrival.mkv.!qB"));
    expect(done.seenAfter).toBeDefined();
    expect(done.seenAfter! >= first!.at).toBe(true);
    if (linked) {
      expect(done.sameFileAs).toEqual([
        path.join(drive, "Movies", "Arrival (2016)", "Arrival.mkv"),
      ]);
    }
    // The files already there at the start are not "arrivals".
    expect(week.files.some((f) => f.basis === "timestamp")).toBe(false);
  });

  it("does nothing on sample data", async () => {
    const { indexer } = await setup();
    await setSetting(handles[0]!.db, "environment", "demo");
    expect(await indexer.run()).toBeUndefined();
  });
});
