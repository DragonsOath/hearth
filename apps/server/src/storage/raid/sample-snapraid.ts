import type { ElevatedResponse, Params } from "../../elevated/protocol";
import type { SnapraidJobState } from "../../elevated/snapraid-job";
import type { RaidIO, RunOut } from "./io";

/**
 * SnapRAID on the simulated machines (Linux and Windows): three data drives and one parity drive,
 * 1,204 files added since the last sync, the oldest block scrubbed 23 days ago. It answers
 * snapraid status, diff, and --version the way SnapRAID 12 prints them, and runs approved jobs
 * (sync, scrub, fix) that progress over time and report like the real job does.
 */

const TB = 1e12;

export class SampleSnapraid {
  private job?: SnapraidJobState & { durationMs: number; startMs: number };
  private added = 1204;
  private oldest = 23;
  readonly conf: string;
  readonly bin: string;
  readonly jobFile: string;
  readonly folders: {
    name: string;
    path: string;
    role: "data" | "parity";
    total: number;
    free: number;
  }[];

  constructor(
    private readonly now: () => number,
    private readonly runMs: number,
    readonly windows: boolean,
  ) {
    this.conf = windows ? "C:\\SnapRAID\\snapraid.conf" : "/etc/snapraid.conf";
    this.bin = windows ? "C:\\SnapRAID\\snapraid.exe" : "/usr/bin/snapraid";
    this.jobFile = windows ? "C:\\Hearth\\snapraid-job.json" : "/var/log/hearth/snapraid-job.json";
    const p = (l: string, n: number) => (windows ? `${l}:\\` : `/mnt/disk${n}/`);
    this.folders = [
      { name: "d1", path: p("F", 1), role: "data", total: 8 * TB, free: 1.1 * TB },
      { name: "d2", path: p("G", 2), role: "data", total: 8 * TB, free: 2.4 * TB },
      { name: "d3", path: p("H", 3), role: "data", total: 8 * TB, free: 5.7 * TB },
      {
        name: "parity",
        path: windows ? "P:\\" : "/mnt/parity1/",
        role: "parity",
        total: 10 * TB,
        free: 1.9 * TB,
      },
    ];
  }

  confText() {
    const data = this.folders.filter((f) => f.role === "data");
    const parity = this.folders.find((f) => f.role === "parity")!;
    return [
      "# SnapRAID configuration",
      `parity ${parity.path}snapraid.parity`,
      ...data.map((d) => `content ${d.path}snapraid.content`),
      ...data.map((d) => `data ${d.name} ${d.path}`),
      "exclude *.unrecoverable",
      "exclude /tmp/",
      "autosave 500",
      "",
    ].join(this.windows ? "\r\n" : "\n");
  }

  private tick() {
    const j = this.job;
    if (!j?.running) return;
    const pct = Math.min(100, Math.round(((this.now() - j.startMs) / j.durationMs) * 100));
    if (pct >= 100) {
      j.running = false;
      j.ok = true;
      j.finishedAt = new Date(j.startMs + j.durationMs).toISOString();
      if (j.action === "sync") {
        j.result = `Synced ${this.added} added, 3 changed, 0 deleted, and 0 moved files.`;
        this.added = 0;
      } else if (j.action === "scrub") {
        j.result = "Scrubbed 8% of the array (blocks not checked for 10 days): no errors.";
        this.oldest = 15;
      } else j.result = "Done.";
      delete j.progressPct;
      delete j.etaMinutes;
    } else {
      j.progressPct = pct;
      j.etaMinutes = Math.max(1, Math.round(((100 - pct) / 100) * 190));
      j.speedMBs = 168;
    }
  }

  jobJson() {
    this.tick();
    if (!this.job) return undefined;
    const { durationMs: _d, startMs: _s, ...state } = this.job;
    return JSON.stringify(state);
  }

  status(): string {
    this.tick();
    const rows = this.folders
      .filter((f) => f.role === "data")
      .map(
        (f, i) =>
          `   ${[31_226, 29_546, 12_877][i]}     ${[392, 394, 51][i]}    ${[1621, 1785, 203][i]}       -    ${Math.round((f.total - f.free) / 1e9)}    ${Math.round(f.free / 1e9)}  ${Math.round(((f.total - f.free) / f.total) * 100)}% ${f.name}`,
      );
    return [
      "Self test...",
      `Loading state from ${this.folders[0]!.path}snapraid.content...`,
      "Using 812 MiB of memory for the file-system.",
      "SnapRAID status report:",
      "",
      "   Files Fragmented Excess  Wasted  Used    Free  Use Name",
      "            Files  Fragments  GB      GB      GB",
      ...rows,
      " --------------------------------------------------------------------------",
      "   73649     837    3609     0.0   15123    9200  62%",
      "",
      `The oldest block was scrubbed ${this.oldest} days ago, the median 9, the newest 0.`,
      "",
      this.added ? "WARNING! The array is NOT fully synced." : "No sync is in progress.",
      "The 38% of the array is not scrubbed.",
      "No file has a zero sub-second timestamp.",
      "No rehash is in progress or needed.",
      "No error detected.",
      "",
    ].join("\n");
  }

  run(cmd: string, args: string[]): RunOut | undefined {
    if (cmd !== this.bin && cmd !== "snapraid") {
      if (cmd === "where" && args[0] === "snapraid") return { code: 1, out: "" };
      return undefined;
    }
    if (args[0] === "--version")
      return { code: 0, out: "snapraid v12.3 by Andrea Mazzoleni, http://www.snapraid.it\n" };
    if (args.at(-1) === "status") {
      if (this.job?.running)
        return { code: 1, out: "Error creating the lock file. It's already in use!\n" };
      return { code: 0, out: this.status() };
    }
    if (args.at(-1) === "diff")
      return {
        code: this.added ? 2 : 0,
        out: `Loading state...\n   73649 equal\n   ${String(this.added).padStart(5)} added\n       0 removed\n       3 updated\n       0 moved\n       0 copied\n       0 restored\n${this.added ? "There are differences!" : "No differences"}\n`,
      };
    return undefined;
  }

  /** What snapraid.run (the executor, or Hearth on Windows) does, on the simulation. */
  perform(params: Params): ElevatedResponse {
    this.tick();
    const fail = (result: string, outcome: "refused" | "stale" = "refused"): ElevatedResponse => ({
      ok: false,
      outcome,
      result,
    });
    if (params.conf !== this.conf) return fail("SnapRAID's configuration is not where it was.");
    if (params.action === "cancel") {
      if (!this.job?.running) return fail("No SnapRAID job is running.", "stale");
      Object.assign(this.job, {
        running: false,
        ok: false,
        finishedAt: new Date(this.now()).toISOString(),
        result: "Stopped on request; SnapRAID saved what it had done.",
      });
      return { ok: true, outcome: "done", result: "The SnapRAID job was stopped." };
    }
    if (this.job?.running) return fail("A SnapRAID job is already running.", "stale");
    const action = String(params.action) as SnapraidJobState["action"];
    if (!["sync", "scrub", "fix", "fix-errors"].includes(action))
      return fail("Not a SnapRAID job.");
    this.job = {
      action,
      by: String(params.by ?? "a plan"),
      startedAt: new Date(this.now()).toISOString(),
      step: action === "sync" ? "sync" : action === "scrub" ? "scrub" : "fix",
      running: true,
      progressPct: 0,
      startMs: this.now(),
      durationMs: this.runMs,
      ...(action === "sync"
        ? {
            diff: {
              equal: 73649,
              added: this.added,
              removed: 0,
              updated: 3,
              moved: 0,
              copied: 0,
              restored: 0,
            },
          }
        : {}),
    };
    return { ok: true, outcome: "done", result: `SnapRAID ${action} started in the background.` };
  }

  /** Adds SnapRAID's files, commands, and drives to a simulated machine's reads. */
  wrap(io: RaidIO): RaidIO {
    const files = (): Record<string, string | undefined> => ({
      [this.conf]: this.confText(),
      [this.bin]: "",
      [this.jobFile]: this.jobJson(),
    });
    return {
      ...io,
      read: async (p) => (p in files() ? files()[p] : io.read(p)),
      exists: async (p) =>
        p in files() ||
        this.folders.some((f) => f.path === p || `${f.path}` === `${p}\\`) ||
        io.exists(p),
      statfs: async (m) => {
        const f = this.folders.find(
          (x) => x.path.replace(/[\\/]$/, "") === m.replace(/[\\/]$/, "") || x.path.startsWith(m),
        );
        return f ? { total: f.total, free: f.free } : io.statfs(m);
      },
      run: async (cmd, args, opts) => this.run(cmd, args) ?? io.run(cmd, args, opts),
    };
  }
}
