import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  btrfsBalance,
  btrfsClear,
  btrfsCreate,
  btrfsMember,
  btrfsScrub,
} from "../../elevated/btrfs";
import type { RaidDeps } from "../../elevated/raid";
import { btrfsDriver } from "./btrfs";
import type { DriverEnv } from "./driver";
import { machineIO } from "./io";
import { parseBlocks } from "./read";

/**
 * Btrfs for real, on throwaway loop devices on CI's disposable machine (root and
 * RAID_LOOPBACK_BTRFS=1 only): a RAID 1 created and mounted, read back as the tab reads it, a
 * scrub, a third drive added, a conversion to RAID 1C3 in place, a drive replaced, and one removed
 * through the executor's own background unit.
 */

const on = process.env.RAID_LOOPBACK_BTRFS === "1" && process.getuid?.() === 0;
const MOUNT = "/mnt/hearth-btrfs";

const sh = (cmd: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(cmd, args, { timeout: 600_000 }, (error, stdout, stderr) =>
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

async function fs() {
  const blocks = parseBlocks(await machineIO.lsblk(), true);
  const env: DriverEnv = {
    io: machineIO,
    blocks,
    candidates: [],
    ready: { ready: true },
    sample: false,
  };
  const [a] = await btrfsDriver.arrays(env);
  return a;
}
async function until(test: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 240; i++) {
    if (await test()) return;
    await deps.wait(1000);
  }
  // Say what the reader and btrfs itself last showed, so a failure explains itself.
  const a = await fs();
  const df = await sh("btrfs", ["filesystem", "df", MOUNT]);
  const show = await sh("btrfs", ["filesystem", "show", MOUNT]);
  const bal = await sh("btrfs", ["balance", "status", MOUNT]);
  const rep = await sh("btrfs", ["replace", "status", "-1", MOUNT]);
  const unit = await sh("journalctl", ["-u", "hearth-btrfs", "--no-pager", "-n", "20"]);
  const kernel = await sh("sh", ["-c", "dmesg | grep -i btrfs | tail -n 25"]);
  throw new Error(
    `Timed out waiting for ${what}. Reader: ${JSON.stringify({ level: a?.level, sync: a?.sync, members: a?.members.map((m) => [m.device, m.role]) })}
${df.out}
${show.out}
${bal.out}
${rep.out}
${unit.out}
${kernel.out}`,
  );
}

describe.skipIf(!on)("Btrfs on loop devices (root, throwaway)", () => {
  const dir = on ? mkdtempSync(path.join(os.tmpdir(), "hearth-btrfs-")) : "";
  const loops: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 4; i++) {
      const f = path.join(dir, `b${i}.img`);
      // Sparse, so they cost nothing; at 512 MB btrfs's chunks are too small to move a 64 MB
      // file's extent into during a conversion.
      await sh("truncate", ["-s", "4G", f]);
      loops.push((await sh("losetup", ["--find", "--show", f])).out.trim());
    }
  }, 120_000);

  afterAll(async () => {
    await sh("systemctl", ["stop", "hearth-btrfs"]);
    await sh("umount", [MOUNT]);
    for (const l of loops) await sh("losetup", ["-d", l]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a RAID 1, and the tab reads it once mounted", async () => {
    const r = await btrfsCreate(
      {
        profile: "raid1",
        name: "hearthci",
        devices: loops.slice(0, 2).map((device) => ({ device })),
      },
      deps,
    );
    expect(r.result).toMatch(/Created the Btrfs filesystem hearthci \(raid1\)/);
    await sh("mkdir", ["-p", MOUNT]);
    expect((await sh("mount", [loops[0]!, MOUNT])).code).toBe(0);
    await sh("dd", ["if=/dev/urandom", `of=${MOUNT}/data.bin`, "bs=1M", "count=64"]);
    await sh("sync", []);
    const a = await fs();
    expect(a).toMatchObject({
      tech: "btrfs",
      name: "hearthci",
      level: "btrfs-raid1",
      health: "healthy",
      mount: MOUNT,
      canLose: 1,
    });
    expect(a!.members.map((m) => m.device).sort()).toEqual(loops.slice(0, 2).sort());
  }, 180_000);

  it("scrubs", async () => {
    await btrfsScrub({ mount: MOUNT, action: "start" }, deps);
    await until(
      async () => /finished/.test((await sh("btrfs", ["scrub", "status", MOUNT])).out),
      "the scrub",
    );
    expect((await fs())!.lastCheck?.text).toMatch(/no errors/);
  }, 300_000);

  it("adds a drive and converts to RAID 1C3 in place", async () => {
    await btrfsMember({ mount: MOUNT, action: "add", device: loops[2]! }, deps);
    expect((await fs())!.members).toHaveLength(3);
    await btrfsBalance({ mount: MOUNT, action: "start", convert: "raid1c3" }, deps);
    await until(
      async () => (await fs())!.level === "btrfs-raid1c3" && !(await fs())!.sync,
      "the conversion",
    );
    expect((await fs())!.canLose).toBe(2);
  }, 300_000);

  it("replaces a drive, then removes one in the background", async () => {
    await btrfsMember(
      { mount: MOUNT, action: "replace", replaces: loops[1]!, device: loops[3]! },
      deps,
    );
    await until(
      async () => (await fs())!.members.every((m) => m.device !== loops[1]) && !(await fs())!.sync,
      "the replace",
    );
    // RAID 1C3 needs three drives: removing one of the three is refused by btrfs itself.
    await btrfsBalance({ mount: MOUNT, action: "start", convert: "raid1" }, deps);
    await until(
      async () => (await fs())!.level === "btrfs-raid1" && !(await fs())!.sync,
      "the conversion back",
    );
    await btrfsMember({ mount: MOUNT, action: "remove", device: loops[3]! }, deps);
    await until(
      async () => (await fs())!.members.length === 2 && !(await fs())!.sync,
      "the removal",
    );
    expect((await btrfsClear({ mount: MOUNT }, deps)).result).toMatch(/counters .* were reset/);
  }, 600_000);
});
