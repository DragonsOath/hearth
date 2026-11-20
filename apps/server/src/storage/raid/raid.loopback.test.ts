import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  raidCreate,
  raidGrow,
  raidMember,
  raidSpeed,
  raidSync,
  type RaidDeps,
} from "../../elevated/raid";
import { machineIO } from "./io";
import { parseBlocks, readCandidates, readMdArrays } from "./read";
import { mdActions } from "./actions";

/**
 * The RAID operations against real Linux software RAID on throwaway loop devices (files posing
 * as drives), never real disks. Runs only as root with RAID_LOOPBACK=1 (CI's disposable machine:
 * .github/workflows/ci.yml). It creates an array, fails, removes, and replaces a member, waits for
 * the rebuild, runs a check, sets the speed, grows the array, and reads every step back the way
 * the RAID tab does.
 */

const on = process.env.RAID_LOOPBACK === "1" && process.getuid?.() === 0;

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

async function arrays() {
  const blocks = parseBlocks(await machineIO.lsblk(), true);
  const list = await readMdArrays(machineIO, blocks, { allowLoop: true });
  const candidates = readCandidates(blocks, list);
  for (const a of list) a.actions = mdActions(a, { candidates, changesReady: true });
  return { list, candidates };
}

/**
 * Waits until md has nothing to do, seen on three reads in a row: right after a member is added
 * or the array grows, md can still read "idle" for a moment before its rebuild starts, and one
 * idle read then let the next step run into the rebuild (CI, 10-29).
 */
async function settle(array: string, timeoutMs = 240_000) {
  const name = path.basename(array);
  const start = Date.now();
  let quiet = 0;
  while (Date.now() - start < timeoutMs) {
    const r = await sh("cat", [`/sys/block/${name}/md/sync_action`]);
    const done = await sh("cat", [`/sys/block/${name}/md/sync_completed`]);
    // "recover" with nothing in progress is a degraded array with no spare (newer kernels).
    const idle =
      r.out.trim() === "idle" || (r.out.trim() === "recover" && done.out.trim() === "none");
    quiet = idle ? quiet + 1 : 0;
    if (quiet >= 3) return;
    await deps.wait(1000);
  }
  throw new Error(`${array} did not settle`);
}

describe.skipIf(!on)("RAID on loop devices (root, throwaway)", () => {
  const dir = on ? mkdtempSync(path.join(os.tmpdir(), "hearth-raid-")) : "";
  const loops: string[] = [];
  let array = "";

  beforeAll(async () => {
    // Speed: tiny drives, and no throttling of the rebuild.
    await sh("sh", ["-c", "echo 500000 > /proc/sys/dev/raid/speed_limit_min"]);
    for (let i = 0; i < 4; i++) {
      const f = path.join(dir, `d${i}.img`);
      await sh("truncate", ["-s", "128M", f]);
      const r = await sh("losetup", ["--find", "--show", f]);
      loops.push(r.out.trim());
    }
    // One of them holds a filesystem: it must be refused unless erasing it is approved.
    await sh("mkfs.ext4", ["-q", "-F", loops[3]!]);
    // lsblk needs a serial for the approval check; loop devices have none, so none is passed.
  }, 120_000);

  afterAll(async () => {
    if (array) {
      await sh("mdadm", ["--stop", array]);
      for (const l of loops) await sh("mdadm", ["--zero-superblock", l]);
    }
    for (const l of loops) await sh("losetup", ["-d", l]);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("creates a RAID 1 and reads it back as healthy", async () => {
    const r = await raidCreate(
      { level: "raid1", name: "hearthtest", devices: [{ device: loops[0] }, { device: loops[1] }] },
      deps,
    );
    array = r.target;
    expect(array).toMatch(/^\/dev\/md\d+$/);
    await settle(array);
    const a = (await arrays()).list.find((x) => x.device === array)!;
    expect(a).toMatchObject({ level: "raid1", health: "healthy", raidDevices: 2 });
    expect(a.counts.active).toBe(2);
    expect(a.actions.find((x) => x.id === "check")?.status).toBe("available");
  }, 300_000);

  it("refuses a drive with a filesystem unless erasing it is approved", async () => {
    await expect(
      raidMember({ array, action: "add-spare", device: loops[3] }, deps),
    ).rejects.toThrow(/holds/);
  });

  it("fails, removes, and replaces a member; the rebuild is read as rebuilding, then healthy", async () => {
    await raidMember({ array, action: "fail", device: loops[1] }, deps);
    let a = (await arrays()).list.find((x) => x.device === array)!;
    expect(a.health).toBe("degraded");
    expect(a.counts.failed).toBe(1);
    expect(a.canLose).toBe(0);
    // With no redundancy left, failing the other one is refused.
    await expect(raidMember({ array, action: "fail", device: loops[0] }, deps)).rejects.toThrow(
      /no redundancy/,
    );
    await raidMember({ array, action: "remove", device: loops[1] }, deps);
    await raidMember({ array, action: "add", device: loops[2] }, deps);
    await settle(array);
    a = (await arrays()).list.find((x) => x.device === array)!;
    expect(a.health).toBe("healthy");
    expect(a.members.some((m) => m.device === loops[2] && m.role === "active")).toBe(true);
  }, 300_000);

  it("runs a consistency check, and sets the array's speed", async () => {
    await raidSync({ array, action: "check" }, deps);
    await settle(array);
    const a = (await arrays()).list.find((x) => x.device === array)!;
    expect(a.mismatches).toBe(0);
    const s = await raidSpeed({ array, minKiBs: 2000, maxKiBs: 100000 }, deps);
    expect(s.result).toMatch(/2000/);
  }, 300_000);

  it("grows the mirror to three members", async () => {
    // The removed member still carries its old superblock, so it counts as holding data: refused.
    await expect(
      raidGrow({ array, mode: "devices", raidDevices: 3, device: loops[1] }, deps),
    ).rejects.toThrow(/holds/);
    // Wiped by hand (as the owner would), it can join.
    await sh("mdadm", ["--zero-superblock", loops[1]!]);
    await raidGrow({ array, mode: "devices", raidDevices: 3, device: loops[1] }, deps);
    await settle(array);
    const a = (await arrays()).list.find((x) => x.device === array)!;
    expect(a.raidDevices).toBe(3);
    expect(a.health).toBe("healthy");
  }, 300_000);
});
