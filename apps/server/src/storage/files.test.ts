import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import { setSetting } from "../store/settings";
import { FileManager, hostPathOf } from "./files";

/**
 * The file manager: drives from their mount points, secrets never shown, settings files never
 * opened, nothing reached outside a drive, search bounded, and container paths found on disk.
 */

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
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dc-files-")));
  dirs.push(root);
  const drive = path.join(root, "mnt", "d");
  const keys = path.join(drive, "hearth-keys");
  await fs.mkdir(path.join(drive, "Downloads", "completed", "Dune (2024)"), { recursive: true });
  await fs.mkdir(keys, { recursive: true });
  await fs.mkdir(path.join(drive, "appdata", "radarr"), { recursive: true });
  await fs.writeFile(
    path.join(drive, "Downloads", "completed", "Dune (2024)", "Dune.mkv"),
    "x".repeat(10),
  );
  await fs.writeFile(
    path.join(drive, "Downloads", "completed", "Dune (2024)", "movie.nfo"),
    "Title: Dune\napikey=abc123\n",
  );
  await fs.writeFile(
    path.join(drive, "appdata", "radarr", "config.xml"),
    "<ApiKey>secret</ApiKey>",
  );
  await fs.writeFile(path.join(drive, "server.key"), "PRIVATE");
  await fs.writeFile(path.join(keys, "vault.json"), "{}");
  await fs.symlink(root, path.join(drive, "escape"), "junction").catch(() => undefined);
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
  await handle.db.insert(t.volumes).values([
    {
      id: "d",
      hostId: "h1",
      label: "D",
      mount: drive,
      kind: "hdd",
      totalTb: 20,
      usedTb: 7,
      smart: "ok",
    },
    {
      id: "root",
      hostId: "h1",
      label: "System",
      mount: "/",
      kind: "ssd",
      totalTb: 1,
      usedTb: 0.1,
      smart: "ok",
    },
  ]);
  return { files: new FileManager(handle, [keys]), drive };
}

describe("FileManager", () => {
  it("starts at the drives, never the system disk", async () => {
    const { files, drive } = await setup();
    const roots = await files.roots();
    expect(roots).toEqual([
      { id: "vol-d", label: drive, path: drive, hostId: "h1", kind: "drive" },
    ]);
  });

  it("navigates anywhere inside a drive; secrets are left out and refused by path", async () => {
    const { files } = await setup();
    const top = await files.list("vol-d");
    const names = top.entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["Downloads", "appdata"]));
    expect(names).not.toContain("hearth-keys");
    expect(names).not.toContain("server.key");
    expect(top.hidden).toBeGreaterThanOrEqual(2);
    const deep = await files.list("vol-d", "Downloads/completed/Dune (2024)");
    expect(deep.entries.map((e) => e.name)).toEqual(["Dune.mkv", "movie.nfo"]);
    expect(deep.breadcrumbs.map((b) => b.name)).toEqual([
      expect.any(String),
      "Downloads",
      "completed",
      "Dune (2024)",
    ]);
    await expect(files.list("vol-d", "hearth-keys")).rejects.toThrow(/secrets/);
    await expect(files.preview("vol-d", "server.key")).rejects.toThrow(/secrets/);
    await expect(files.list("vol-d", "../..")).rejects.toThrow();
  });

  it("never leaves the drive through a link", async () => {
    const { files } = await setup();
    const top = await files.list("vol-d");
    if (top.entries.some((e) => e.name === "escape"))
      await expect(files.list("vol-d", "escape")).rejects.toThrow(/outside/);
  });

  it("previews text with keys redacted; settings files are listed but never opened", async () => {
    const { files } = await setup();
    const nfo = await files.preview("vol-d", "Downloads/completed/Dune (2024)/movie.nfo");
    expect(nfo).toMatchObject({ kind: "text" });
    if (nfo.kind === "text") {
      expect(nfo.text).toContain("Title: Dune");
      expect(nfo.text).not.toContain("abc123");
    }
    expect((await files.list("vol-d", "appdata/radarr")).entries.map((e) => e.name)).toEqual([
      "config.xml",
    ]);
    expect(await files.preview("vol-d", "appdata/radarr/config.xml")).toMatchObject({
      kind: "none",
    });
    await expect(files.open("vol-d", "appdata/radarr/config.xml")).rejects.toThrow(/API keys/);
    const video = await files.open("vol-d", "Downloads/completed/Dune (2024)/Dune.mkv");
    expect(video).toMatchObject({ name: "Dune.mkv", size: 10, image: false });
    (video.stream as unknown as { destroy(): void }).destroy();
  });

  it("searches below a folder by name, skipping secrets", async () => {
    const { files } = await setup();
    const r = await files.search("vol-d", "", "dune");
    expect(r.complete).toBe(true);
    expect(r.results.map((x) => x.name).sort()).toEqual(["Dune (2024)", "Dune.mkv"]);
    expect((await files.search("vol-d", "", "vault")).results).toEqual([]);
  });

  it("finds a path on this machine in the file manager (Open in folder)", async () => {
    const { files, drive } = await setup();
    const host = path.join(drive, "Downloads", "completed", "Dune (2024)", "Dune.mkv");
    expect(await files.locate(host)).toEqual({
      rootId: "vol-d",
      folder: "Downloads/completed/Dune (2024)",
      name: "Dune.mkv",
    });
    expect(await files.locate(path.join(drive, "hearth-keys", "vault.json"))).toBeUndefined();
  });
});

describe("hostPathOf", () => {
  it("turns a container path into this machine's path by the longest matching mount", () => {
    const mounts = [
      { source: "/mnt/d", destination: "/data" },
      { source: "/mnt/d/Downloads", destination: "/downloads" },
      { source: "/srv/config/qb", destination: "/config" },
    ];
    expect(hostPathOf("/downloads/completed/Dune", mounts)).toBe("/mnt/d/Downloads/completed/Dune");
    expect(hostPathOf("/data/Movies/Dune (2024)", mounts)).toBe("/mnt/d/Movies/Dune (2024)");
    expect(hostPathOf("/downloadsX/thing", mounts)).toBeUndefined();
    expect(hostPathOf("/elsewhere", mounts)).toBeUndefined();
  });
});
