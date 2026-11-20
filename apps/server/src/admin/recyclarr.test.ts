import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerExec } from "./docker-exec";
import { Recyclarr } from "./recyclarr";

/**
 * Which log a Recyclarr run reads. A plan check runs two previews back to back (without and with
 * the change), and their logs can carry the same modified time; each run must read its own log.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function setup() {
  // The current whole second, the same for every log: as a busy machine or a coarse file system
  // records two runs a moment apart.
  const sameTime = new Date(Math.floor(Date.now() / 1000) * 1000);
  const logs = await fs.mkdtemp(path.join(tmpdir(), "dc-recyclarr-"));
  dirs.push(logs);
  let n = 0;
  const exec: ContainerExec = {
    async putFile() {},
    async exec(_container, cmd) {
      if (cmd[0] !== "recyclarr") return { exitCode: 0, output: "" };
      // Each run writes its own log, saying which run it was.
      n += 1;
      const file = path.join(logs, `recyclarr.${String(n).padStart(3, "0")}.debug.log`);
      await fs.writeFile(
        file,
        `[2026-10-15 12:00:00 INF] hd-bluray-web: Upgrade Allowed: False -> run${n}\n`,
      );
      await fs.utimes(file, sameTime, sameTime);
      return { exitCode: 0, output: "done" };
    },
  };
  return { logs, recyclarr: new Recyclarr(exec) };
}

describe("Recyclarr runs read their own log", () => {
  it("reads the log this run wrote, even when an earlier one has the same modified time", async () => {
    const { logs, recyclarr } = await setup();
    // Directory order is not creation order on every file system, so try both name orders.
    for (let run = 1; run <= 6; run += 1) {
      const report = await recyclarr.preview("recyclarr", logs, "radarr: {}\n");
      expect(report.settings[0]?.to).toBe(`run${run}`);
      expect(report.log).toBe(
        path.join(logs, `recyclarr.${String(run).padStart(3, "0")}.debug.log`),
      );
    }
  });

  it("still reads the newest log when a run left no new file", async () => {
    const { logs } = await setup();
    const old = path.join(logs, "recyclarr.000.debug.log");
    await fs.writeFile(old, "[2026-10-15 12:00:00 INF] hd-bluray-web: Upgrade Allowed: A -> B\n");
    const quiet = new Recyclarr({
      async putFile() {},
      async exec() {
        return { exitCode: 0, output: "done" };
      },
    });
    const report = await quiet.preview("recyclarr", logs);
    expect(report.log).toBe(old);
    expect(report.settings[0]?.to).toBe("B");
  });

  it("the last scheduled run is the newest log in the folder", async () => {
    const { logs, recyclarr } = await setup();
    await recyclarr.preview("recyclarr", logs);
    const last = await recyclarr.lastRun(logs);
    expect(last?.settings[0]?.to).toBe("run1");
  });
});
