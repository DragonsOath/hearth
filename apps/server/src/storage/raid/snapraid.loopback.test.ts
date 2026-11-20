import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RaidDeps } from "../../elevated/raid";
import { snapraidRun } from "../../elevated/snapraid";
import type { SnapraidJobState } from "../../elevated/snapraid-job";
import { machineIO } from "./io";
import { parseBlocks, readCandidates } from "./read";
import { snapraidDriver, type SnapEnv } from "./snapraid";

/**
 * SnapRAID for real, on throwaway loop devices (files posing as drives) on CI's disposable
 * machine, never real disks; root and RAID_LOOPBACK_SNAPRAID=1 only. Two data drives and a parity
 * drive, each its own ext4 filesystem: a sync through the executor's own background unit
 * (systemd-run, job mode of the built executor), the safety stop after many deletions, a scrub,
 * and a lost drive's files rebuilt from parity, compared byte for byte.
 */

const on = process.env.RAID_LOOPBACK_SNAPRAID === "1" && process.getuid?.() === 0;
const CONF = "/etc/snapraid.conf";
const PROGRAM = path.resolve("apps/server/dist-elevated/hearth-elevated.js");

const sh = (cmd: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(cmd, args, { timeout: 600_000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? ((error as { code?: number }).code ?? 1) : 0,
        out: `${stdout}${stderr}`,
      }),
    ),
  );

describe.skipIf(!on)("SnapRAID on loop devices (root, throwaway)", () => {
  const dir = on ? mkdtempSync(path.join(os.tmpdir(), "hearth-snap-")) : "";
  const loops: string[] = [];
  const mounts = ["/mnt/hsnap-d1", "/mnt/hsnap-d2", "/mnt/hsnap-p"];
  const state = path.join(dir, "state");
  const logs = path.join(dir, "log");
  const scope = path.join(dir, "elevation.json");
  const deps: RaidDeps = {
    run: (cmd, args) => sh(cmd, args),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    jobs: {
      stateDir: state,
      logDir: logs,
      program: PROGRAM,
      config: scope,
      node: process.execPath,
    },
  };
  const job = () => {
    const f = path.join(logs, "snapraid-job.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as SnapraidJobState) : undefined;
  };
  const finished = async () => {
    for (let i = 0; i < 300; i++) {
      const j = job();
      if (j && !j.running) return j;
      await deps.wait(1000);
    }
    throw new Error(
      `The job did not finish: ${readFileSync(path.join(logs, "snapraid-job.log"), "utf8").slice(-800)}`,
    );
  };
  const run = async (params: Record<string, unknown>) => {
    rmSync(path.join(logs, "snapraid-job.json"), { force: true });
    await snapraidRun({ conf: CONF, ...params }, deps);
    return finished();
  };
  const sum = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

  beforeAll(async () => {
    for (const d of [state, logs]) await sh("mkdir", ["-p", d]);
    writeFileSync(
      scope,
      JSON.stringify({
        version: 1,
        roots: [],
        operations: ["snapraid.run"],
        units: [],
        backupRoot: path.join(dir, "backups"),
        stateDir: state,
        auditLog: path.join(logs, "elevated.jsonl"),
        keyFile: path.join(dir, "key"),
      }),
    );
    for (let i = 0; i < 3; i++) {
      const f = path.join(dir, `s${i}.img`);
      await sh("truncate", ["-s", "160M", f]);
      const l = (await sh("losetup", ["--find", "--show", f])).out.trim();
      loops.push(l);
      await sh("mkfs.ext4", ["-q", "-F", l]);
      await sh("mkdir", ["-p", mounts[i]!]);
      await sh("mount", [l, mounts[i]!]);
    }
    writeFileSync(
      CONF,
      [
        `parity ${mounts[2]}/snapraid.parity`,
        `content ${mounts[0]}/snapraid.content`,
        `content ${mounts[1]}/snapraid.content`,
        `content ${mounts[2]}/snapraid.content`,
        `data d1 ${mounts[0]}/`,
        `data d2 ${mounts[1]}/`,
        "exclude /lost+found/",
        "",
      ].join("\n"),
    );
    // Some files on each data drive.
    for (const [m, n] of [
      [mounts[0]!, 30],
      [mounts[1]!, 30],
    ] as const)
      for (let i = 0; i < n; i++)
        writeFileSync(path.join(m, `file${i}.bin`), Buffer.alloc(200_000, i + n));
  }, 180_000);

  afterAll(async () => {
    await sh("systemctl", ["stop", "hearth-snapraid"]);
    for (const m of mounts) await sh("umount", [m]);
    for (const l of loops) await sh("losetup", ["-d", l]);
    rmSync(dir, { recursive: true, force: true });
    rmSync(CONF, { force: true });
  });

  it("syncs through the executor's background unit, and the RAID tab reads it", async () => {
    const end = await run({ action: "sync", deleteThreshold: 50 });
    expect(end.ok, end.result).toBe(true);
    expect(end.result).toMatch(/Synced 60 added/);
    const blocks = parseBlocks(await machineIO.lsblk(), true);
    const env: SnapEnv = {
      io: machineIO,
      blocks,
      candidates: [],
      ready: { ready: true },
      sample: false,
      jobFile: path.join(logs, "snapraid-job.json"),
    };
    const [a] = await snapraidDriver.arrays(env);
    expect(a).toMatchObject({
      tech: "snapraid",
      health: "healthy",
      levelText: "1 parity drive, 2 data drives",
    });
    expect(a!.members.map((m) => [m.name, m.role, m.device])).toEqual([
      ["d1", "data", loops[0]],
      ["d2", "data", loops[1]],
      ["parity", "parity", loops[2]],
    ]);
    expect(readCandidates(blocks, [a!]).find((c) => c.device === loops[0])?.state).toBe("excluded");
  }, 300_000);

  it("stops before syncing after many deletions", async () => {
    for (let i = 0; i < 25; i++) rmSync(path.join(mounts[1]!, `file${i}.bin`));
    const end = await run({ action: "sync", deleteThreshold: 10 });
    expect(end.ok).toBe(false);
    expect(end.result).toMatch(/Stopped before syncing: 25 files were deleted/);
  }, 300_000);

  it("rebuilds the deleted files from parity, byte for byte", async () => {
    const before = sum(path.join(mounts[0]!, "file3.bin"));
    const end = await run({ action: "fix", disk: "d2" });
    expect(end.ok, end.result).toBe(true);
    for (let i = 0; i < 25; i++)
      expect(existsSync(path.join(mounts[1]!, `file${i}.bin`))).toBe(true);
    expect(
      readFileSync(path.join(mounts[1]!, "file7.bin")).equals(Buffer.alloc(200_000, 7 + 30)),
    ).toBe(true);
    expect(sum(path.join(mounts[0]!, "file3.bin"))).toBe(before);
  }, 300_000);

  it("scrubs, and refuses a second job while one runs", async () => {
    const end = await run({ action: "scrub", scrubPercent: 100, olderThanDays: 0 });
    expect(end.ok, end.result).toBe(true);
    await expect(snapraidRun({ conf: "/etc/fstab", action: "sync" }, deps)).rejects.toThrow(
      /must be one of/,
    );
    await expect(snapraidRun({ conf: CONF, action: "cancel" }, deps)).rejects.toThrow(
      /No SnapRAID job is running/,
    );
  }, 300_000);
});
