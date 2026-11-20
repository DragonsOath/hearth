import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RaidDeps } from "../../elevated/raid";
import { zfsClear, zfsCreate, zfsMember, zfsScrub } from "../../elevated/zfs";
import type { DriverEnv } from "./driver";
import { machineIO } from "./io";
import { parseBlocks, readCandidates } from "./read";
import { zfsDriver } from "./zfs";

/**
 * The ZFS operations against real OpenZFS on throwaway loop devices (files posing as drives),
 * never real disks. Runs only as root with RAID_LOOPBACK_ZFS=1 on CI's disposable machine. It
 * creates a RAID-Z1 pool, refuses a drive holding data, adds a spare after approved erasing, takes
 * a drive offline and back, replaces one and waits for the rebuild, scrubs, and reads every step
 * back the way the RAID tab does.
 */

const on = process.env.RAID_LOOPBACK_ZFS === "1" && process.getuid?.() === 0;
const POOL = "hearthci";

const sh = (cmd: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(cmd, args, { timeout: 300_000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        out: `${stdout}${stderr}`,
      }),
    ),
  );

const deps: RaidDeps = {
  run: (cmd, args) => sh(cmd, args),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  allowLoop: true,
};

async function pool() {
  const blocks = parseBlocks(await machineIO.lsblk(), true);
  const env: DriverEnv = {
    io: machineIO,
    blocks,
    candidates: [],
    ready: { ready: true },
    sample: false,
  };
  const found = await zfsDriver.arrays(env);
  env.candidates = readCandidates(blocks, found);
  const a = found.find((x) => x.name === POOL);
  if (a) a.actions = zfsDriver.actions(a, env);
  return { a, candidates: env.candidates };
}

async function until(test: () => Promise<boolean>, what: string, timeoutMs = 240_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await test()) return;
    await deps.wait(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe.skipIf(!on)("ZFS on loop devices (root, throwaway)", () => {
  const dir = on ? mkdtempSync(path.join(os.tmpdir(), "hearth-zfs-")) : "";
  const loops: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `z${i}.img`);
      await sh("truncate", ["-s", "256M", f]);
      loops.push((await sh("losetup", ["--find", "--show", f])).out.trim());
    }
    // One holds a filesystem: refused unless erasing it is approved.
    await sh("mkfs.ext4", ["-q", "-F", loops[3]!]);
  }, 120_000);

  afterAll(async () => {
    await sh("zpool", ["destroy", "-f", POOL]);
    for (const l of loops) await sh("losetup", ["-d", l]);
    rmSync(dir, { recursive: true, force: true });
    await sh("rmdir", [`/mnt/${POOL}`]);
  });

  it("creates a RAID-Z1 pool and reads it back as healthy", async () => {
    const r = await zfsCreate(
      { name: POOL, level: "raidz1", devices: loops.slice(0, 3).map((device) => ({ device })) },
      deps,
    );
    expect(r.result).toMatch(/Created the ZFS pool hearthci \(raidz1\)/);
    const { a, candidates } = await pool();
    expect(a).toMatchObject({
      tech: "zfs",
      health: "healthy",
      level: "raidz1",
      canLose: 1,
      mount: `/mnt/${POOL}`,
    });
    expect(a!.members.filter((m) => m.role === "active")).toHaveLength(3);
    // Its drives are no longer offered; the empty one still is.
    expect(candidates.find((c) => c.device === loops[0])?.state).toBe("excluded");
    expect(candidates.find((c) => c.device === loops[4])?.state).toBe("usable");
  }, 120_000);

  it("refuses a drive holding data, then adds it as a spare once erasing is approved", async () => {
    await expect(
      zfsMember({ pool: POOL, action: "add-spare", device: loops[3]! }, deps),
    ).rejects.toThrow(/holds ext4/);
    // Loop devices have no serial, so the approval's serial is empty, as Hearth plans it.
    await expect(
      zfsMember({ pool: POOL, action: "add-spare", device: loops[3]!, erase: true }, deps),
    ).rejects.toThrow(/serial/);
    await sh("wipefs", ["--all", loops[3]!]);
    await zfsMember({ pool: POOL, action: "add-spare", device: loops[3]! }, deps);
    const { a } = await pool();
    expect(a!.members.find((m) => m.device === loops[3])?.role).toBe("spare");
    expect(a!.counts.spare).toBe(1);
  }, 120_000);

  it("takes a drive offline and brings it back", async () => {
    await zfsMember({ pool: POOL, action: "offline", device: loops[1]! }, deps);
    let { a } = await pool();
    expect(a!.health).toBe("degraded");
    expect(a!.members.find((m) => m.device === loops[1])?.role).toBe("offline");
    expect(a!.actions.find((x) => x.id === "re-add")?.status).toBe("available");
    await zfsMember({ pool: POOL, action: "online", device: loops[1]! }, deps);
    await until(async () => (await pool()).a?.health === "healthy", "the pool to be whole");
    ({ a } = await pool());
    expect(a!.members.find((m) => m.device === loops[1])?.role).toBe("active");
  }, 240_000);

  it("replaces a drive and rebuilds onto the new one", async () => {
    await zfsMember(
      { pool: POOL, action: "replace", replaces: loops[2]!, device: loops[4]! },
      deps,
    );
    await until(async () => {
      const { a } = await pool();
      return (
        a?.health === "healthy" &&
        a.members.some((m) => m.device === loops[4] && m.role === "active")
      );
    }, "the rebuild");
    const { a } = await pool();
    expect(a!.members.some((m) => m.device === loops[2])).toBe(false);
  }, 240_000);

  it("scrubs, and clears the error counts", async () => {
    await zfsScrub({ pool: POOL, action: "start" }, deps);
    await until(
      async () => /Last scrub/.test((await pool()).a?.lastCheck?.text ?? ""),
      "the scrub",
    );
    const { a } = await pool();
    expect(a!.lastCheck?.text).toMatch(/no errors/);
    expect((await zfsClear({ pool: POOL }, deps)).result).toMatch(/reports ONLINE/);
  }, 240_000);
});
