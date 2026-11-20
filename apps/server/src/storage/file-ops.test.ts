import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { StepRun } from "../jobs/operations";
import { setSetting } from "../store/settings";
import { FileOperations } from "./file-ops";
import { FileManager } from "./files";
import type { Elevation } from "../admin/elevation";

/** File operations: approved, never deleting or replacing, and never in folders apps manage. */

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
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dc-fileops-")));
  dirs.push(base);
  const drive = path.join(base, "f");
  await fs.mkdir(path.join(drive, "Movies", "Heat (1995)"), { recursive: true });
  await fs.mkdir(path.join(drive, "Home Videos"), { recursive: true });
  await fs.mkdir(path.join(drive, "Plex Only"), { recursive: true });
  await fs.writeFile(path.join(drive, "Movies", "Heat (1995)", "Heat.mkv"), "h".repeat(10));
  await fs.writeFile(path.join(drive, "Home Videos", "beach.mp4"), "b".repeat(6));
  await fs.writeFile(path.join(drive, "Home Videos", "config.xml"), "<x/>");
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
    id: "f",
    hostId: "h1",
    label: "F",
    mount: drive,
    kind: "hdd",
    totalTb: 20,
    usedTb: 7,
    smart: "ok",
  });
  const ops = new FileOperations(new FileManager(handle, []));
  ops.usePlaces(async () => [
    {
      path: path.join(drive, "Movies"),
      label: "Movies",
      role: "library",
      apps: ["Radarr", "Plex"],
    },
    { path: path.join(drive, "Plex Only"), label: "Plex Only", role: "library", apps: ["Plex"] },
  ]);
  return { ops, drive };
}

const ROOT = "vol-f";
const step = (params: Record<string, string | number | boolean>): StepRun => ({
  kind: "file-manage",
  serviceId: "this-host",
  requestedBy: "you",
  params,
});

/** Plans the step, and (when it may run) runs it with what the plan recorded. */
async function planAndRun(ops: FileOperations, params: Record<string, string>) {
  const plan = await ops.plan({ kind: "file-manage", serviceId: "this-host", params });
  if (plan.policy === "refuse") return { plan };
  const run = await ops.run(step(plan.params as Record<string, string | number>));
  return { plan, run };
}

describe("FileOperations", () => {
  it("creates a folder, renames, and copies, each checked and approved first", async () => {
    const { ops, drive } = await setup();
    const mk = await planAndRun(ops, {
      op: "mkdir",
      root: ROOT,
      path: "Home Videos",
      name: "2026",
    });
    expect(mk.plan).toMatchObject({
      policy: "approve-first",
      label: `Create the folder ${path.join(drive, "Home Videos", "2026")}`,
    });
    expect(mk.run).toMatchObject({ ok: true });
    expect((await fs.stat(path.join(drive, "Home Videos", "2026"))).isDirectory()).toBe(true);

    const rn = await planAndRun(ops, {
      op: "rename",
      root: ROOT,
      path: "Home Videos/beach.mp4",
      name: "Beach 2026.mp4",
    });
    expect(rn.run).toMatchObject({ ok: true });
    await expect(fs.stat(path.join(drive, "Home Videos", "Beach 2026.mp4"))).resolves.toBeTruthy();

    const cp = await planAndRun(ops, {
      op: "copy",
      root: ROOT,
      path: "Home Videos/Beach 2026.mp4",
      to: "Home Videos/2026",
    });
    expect(cp.run?.result).toMatch(/6 bytes, checked\). The original is unchanged/);
    await expect(fs.stat(path.join(drive, "Home Videos", "Beach 2026.mp4"))).resolves.toBeTruthy();
  });

  it("refuses folders Radarr manages, and says to do it in Radarr", async () => {
    const { ops } = await setup();
    const { plan } = await planAndRun(ops, {
      op: "rename",
      root: ROOT,
      path: "Movies/Heat (1995)/Heat.mkv",
      name: "Heat 1995.mkv",
    });
    expect(plan).toMatchObject({ policy: "refuse" });
    expect(plan.policyReason).toMatch(/Radarr manages Movies.*Do it in Radarr/);
    // Copying out of it is fine: the original is untouched.
    const out = await planAndRun(ops, {
      op: "copy",
      root: ROOT,
      path: "Movies/Heat (1995)/Heat.mkv",
      to: "Home Videos",
    });
    expect(out.run).toMatchObject({ ok: true });
    // Into it is not.
    const into = await planAndRun(ops, {
      op: "copy",
      root: ROOT,
      path: "Home Videos/beach.mp4",
      to: "Movies",
    });
    expect(into.plan.policy).toBe("refuse");
  });

  it("a folder only Plex reads is allowed, with a note that Plex picks it up", async () => {
    const { ops } = await setup();
    const { plan, run } = await planAndRun(ops, {
      op: "move",
      root: ROOT,
      path: "Home Videos/beach.mp4",
      to: "Plex Only",
    });
    expect(plan.policyReason).toMatch(/Plex reads this folder/);
    expect(run).toMatchObject({ ok: true });
  });

  it("never replaces, never touches settings, never leaves the drive", async () => {
    const { ops, drive } = await setup();
    await fs.writeFile(path.join(drive, "Home Videos", "taken.mp4"), "t");
    const clash = await ops.plan({
      kind: "file-manage",
      serviceId: "this-host",
      params: { op: "rename", root: ROOT, path: "Home Videos/beach.mp4", name: "taken.mp4" },
    });
    expect(clash.policyReason).toMatch(/already exists.*never replaces/);
    const settings = await ops.plan({
      kind: "file-manage",
      serviceId: "this-host",
      params: { op: "copy", root: ROOT, path: "Home Videos/config.xml", to: "" },
    });
    expect(settings.policyReason).toMatch(/secrets or settings/);
    for (const name of ["../x", "a/b", ".."])
      expect(
        (
          await ops.plan({
            kind: "file-manage",
            serviceId: "this-host",
            params: { op: "rename", root: ROOT, path: "Home Videos/beach.mp4", name },
          })
        ).policy,
      ).toBe("refuse");
    const up = await ops.plan({
      kind: "file-manage",
      serviceId: "this-host",
      params: { op: "move", root: ROOT, path: "Home Videos/beach.mp4", to: "../.." },
    });
    expect(up.policy).toBe("refuse");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "says before approval when Hearth's account cannot write there",
    async () => {
      const { ops, drive } = await setup();
      await fs.chmod(path.join(drive, "Home Videos"), 0o555);
      try {
        const plan = await ops.plan({
          kind: "file-manage",
          serviceId: "this-host",
          params: { op: "mkdir", root: ROOT, path: "Home Videos", name: "2026" },
        });
        expect(plan.policy).toBe("refuse");
        expect(plan.policyReason).toMatch(/not allowed to write.*executor cannot either/);
      } finally {
        await fs.chmod(path.join(drive, "Home Videos"), 0o755);
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "where Hearth cannot write, the approved step goes through the elevated executor",
    async () => {
      const { ops, drive } = await setup();
      const asked: { op: string; params: Record<string, unknown> }[] = [];
      ops.useElevation({
        covers: async () => ({ ok: true }),
        perform: async (op: string, params: Record<string, unknown>) => {
          asked.push({ op, params });
          return { ok: true, outcome: "done", result: "Moved." };
        },
      } as unknown as Elevation);
      await fs.chmod(path.join(drive, "Home Videos"), 0o555);
      try {
        const plan = await ops.plan({
          kind: "file-manage",
          serviceId: "this-host",
          params: { op: "rename", root: ROOT, path: "Home Videos/beach.mp4", name: "Beach.mp4" },
        });
        expect(plan.policy).toBe("approve-first");
        expect(plan.policyReason).toMatch(/elevated executor/);
        const run = await ops.run(step(plan.params as Record<string, string | number>));
        expect(run).toMatchObject({ ok: true });
        expect(asked[0]).toMatchObject({
          op: "file.rename",
          params: {
            from: path.join(drive, "Home Videos", "beach.mp4"),
            to: path.join(drive, "Home Videos", "Beach.mp4"),
            size: 6,
          },
        });
      } finally {
        await fs.chmod(path.join(drive, "Home Videos"), 0o755);
      }
    },
  );

  it("does nothing when the item changed after approval, and puts a move back on undo", async () => {
    const { ops, drive } = await setup();
    const plan = await ops.plan({
      kind: "file-manage",
      serviceId: "this-host",
      params: { op: "move", root: ROOT, path: "Home Videos/beach.mp4", to: "Plex Only" },
    });
    await fs.appendFile(path.join(drive, "Home Videos", "beach.mp4"), "more");
    const stale = await ops.run(step(plan.params as Record<string, string | number>));
    expect(stale).toMatchObject({ ok: false });
    expect(stale.result).toMatch(/changed after the plan was approved/);

    const fresh = await ops.plan({
      kind: "file-manage",
      serviceId: "this-host",
      params: { op: "move", root: ROOT, path: "Home Videos/beach.mp4", to: "Plex Only" },
    });
    const s = step(fresh.params as Record<string, string | number>);
    expect(await ops.run(s)).toMatchObject({ ok: true });
    expect(await ops.undo(s)).toMatchObject({ ok: true });
    await expect(fs.stat(path.join(drive, "Home Videos", "beach.mp4"))).resolves.toBeTruthy();
    // A copy is not undone by deleting it.
    expect(await ops.undo(step({ op: "copy", root: ROOT, path: "x", to: "" }))).toBeUndefined();
  });
});
