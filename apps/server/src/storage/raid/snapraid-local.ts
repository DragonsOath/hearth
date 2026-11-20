import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElevatedResponse, Params } from "../../elevated/protocol";
import { runSnapraidJob, type SnapraidJobSpec } from "../../elevated/snapraid-job";
import { dataNames } from "../../elevated/snapraid";
import type { RaidIO } from "./io";
import { locate } from "./snapraid";

/**
 * SnapRAID jobs on Windows, where SnapRAID runs as the owner's own account (no administrator
 * rights needed): the same job as the Linux executor runs (snapraid-job.ts), started by Hearth
 * for an approved plan step, one at a time, reporting its state to Hearth's data folder.
 */
export class LocalSnapraid {
  private child?: ChildProcess;
  private running = false;

  constructor(
    private readonly dir: string,
    private readonly io: RaidIO,
  ) {}

  get jobFile() {
    return path.join(this.dir, "snapraid-job.json");
  }

  async perform(params: Params): Promise<ElevatedResponse> {
    const refuse = (
      result: string,
      outcome: "refused" | "stale" = "refused",
    ): ElevatedResponse => ({
      ok: false,
      outcome,
      result,
    });
    if (params.action === "cancel") {
      if (!this.child || !this.running) return refuse("No SnapRAID job is running.", "stale");
      this.child.kill();
      return {
        ok: true,
        outcome: "done",
        result: "The SnapRAID job was stopped. The next sync carries on from what it saved.",
      };
    }
    if (this.running) return refuse("A SnapRAID job is already running.", "stale");
    const place = await locate(this.io);
    if (!place || place.conf !== params.conf)
      return refuse("SnapRAID's configuration is not where it was.");
    const action = params.action;
    if (!["sync", "scrub", "fix", "fix-errors"].includes(String(action)))
      return refuse("The SnapRAID action is not valid.");
    const int = (v: unknown, lo: number, hi: number) =>
      typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;
    const spec: SnapraidJobSpec = {
      bin: place.bin,
      conf: place.conf,
      action: action as SnapraidJobSpec["action"],
      by: typeof params.by === "string" ? params.by.slice(0, 80) : "a plan",
    };
    const t = int(params.deleteThreshold, 0, 1_000_000);
    const p = int(params.scrubPercent, 0, 100);
    const o = int(params.olderThanDays, 0, 3650);
    if (t !== undefined) spec.deleteThreshold = t;
    if (p !== undefined) spec.scrubPercent = p;
    if (o !== undefined) spec.olderThanDays = o;
    if (action === "fix") {
      const names = dataNames((await this.io.read(place.conf)) ?? "");
      if (typeof params.disk !== "string" || !names.includes(params.disk))
        return refuse(`Name one of the data drives in snapraid.conf (${names.join(", ")}).`);
      spec.disk = params.disk;
    }
    await mkdir(this.dir, { recursive: true });
    const log = path.join(this.dir, "snapraid-job.log");
    await writeFile(log, "");
    this.running = true;
    void runSnapraidJob(spec, {
      now: () => Date.now(),
      log: (text) => appendFile(log, text),
      save: async (s) => {
        await writeFile(`${this.jobFile}.tmp`, JSON.stringify(s));
        await rename(`${this.jobFile}.tmp`, this.jobFile);
      },
      run: (cmd, args, onOutput) =>
        new Promise((resolve) => {
          const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          this.child = child;
          child.stdout?.on("data", (b: Buffer) => onOutput(b.toString("utf8")));
          child.stderr?.on("data", (b: Buffer) => onOutput(b.toString("utf8")));
          child.on("error", () => resolve(127));
          child.on("close", (code) => resolve(code ?? 1));
        }),
    }).finally(() => {
      this.running = false;
      this.child = undefined;
    });
    return {
      ok: true,
      outcome: "done",
      result: `SnapRAID ${spec.action === "fix-errors" ? "fix" : spec.action}${spec.disk ? ` of ${spec.disk}` : ""} started in the background; the RAID tab shows its progress.`,
    };
  }
}
