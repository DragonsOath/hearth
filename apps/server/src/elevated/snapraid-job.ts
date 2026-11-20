/**
 * One SnapRAID job, start to finish: a sync (with SnapRAID-runner's safety stop: no sync after
 * many deletions), a scrub, or a fix. Shared by the Linux elevated executor (run as root in its
 * own systemd unit, since a sync takes hours) and by Hearth itself on Windows (where SnapRAID runs
 * as the owner's account). Node built-ins only: the executor ships as one file.
 *
 * The job writes its state (step, progress, outcome) to a small JSON file Hearth reads, and
 * SnapRAID's own output to a log beside it.
 */

export interface SnapraidJobSpec {
  /** snapraid (Linux) or the full path to snapraid.exe (Windows). */
  bin: string;
  conf: string;
  action: "sync" | "scrub" | "fix" | "fix-errors";
  /** sync: stop before syncing when more files than this were deleted. */
  deleteThreshold?: number;
  /** sync, then scrub this share of the array (0 for none); scrub: how much. */
  scrubPercent?: number;
  /** Scrub only blocks not scrubbed for this many days. */
  olderThanDays?: number;
  /** fix: the data drive's name in snapraid.conf. */
  disk?: string;
  /** Who asked: a plan (job id) or the schedule. */
  by: string;
}

export interface SnapraidJobState {
  action: SnapraidJobSpec["action"];
  by: string;
  startedAt: string;
  /** What it is doing now: touch, diff, sync, scrub, fix. */
  step: string;
  running: boolean;
  progressPct?: number;
  etaMinutes?: number;
  speedMBs?: number;
  finishedAt?: string;
  ok?: boolean;
  /** Plain words: what happened. */
  result?: string;
  /** What the diff found before a sync. */
  diff?: SnapraidDiff;
}

export interface SnapraidDiff {
  equal: number;
  added: number;
  removed: number;
  updated: number;
  moved: number;
  copied: number;
  restored: number;
}

export function parseDiff(out: string): SnapraidDiff {
  const n = (w: string) => Number(new RegExp(`^\\s*(\\d+)\\s+${w}\\s*$`, "m").exec(out)?.[1] ?? 0);
  return {
    equal: n("equal"),
    added: n("added"),
    removed: n("removed"),
    updated: n("updated"),
    moved: n("moved"),
    copied: n("copied"),
    restored: n("restored"),
  };
}

/** "45%, 123456 MB, 140 MB/s, CPU 12%, 1:23 ETA": SnapRAID's progress line. */
export function parseProgress(text: string) {
  const line = text
    .split(/[\r\n]+/)
    .filter((l) => /\d{1,3}%,\s*\d+ MB/.test(l))
    .at(-1);
  if (!line) return undefined;
  const speed = /(\d+) MB\/s/.exec(line);
  const left = /(\d+):(\d\d) ETA/.exec(line);
  return {
    progressPct: Number(/(\d{1,3})%,/.exec(line)![1]),
    ...(speed ? { speedMBs: Number(speed[1]) } : {}),
    ...(left ? { etaMinutes: Number(left[1]) * 60 + Number(left[2]) } : {}),
  };
}

export interface SnapraidJobDeps {
  /** Runs a program with no time limit, passing each piece of its output as it comes. */
  run(cmd: string, args: string[], onOutput: (text: string) => void): Promise<number>;
  save(state: SnapraidJobState): Promise<void>;
  log(text: string): Promise<void>;
  now(): number;
}

export async function runSnapraidJob(spec: SnapraidJobSpec, deps: SnapraidJobDeps) {
  const state: SnapraidJobState = {
    action: spec.action,
    by: spec.by,
    startedAt: new Date(deps.now()).toISOString(),
    step: "starting",
    running: true,
  };
  let saved = 0;
  const save = async (force = false) => {
    if (!force && deps.now() - saved < 5000) return;
    saved = deps.now();
    await deps.save({ ...state });
  };
  const step = async (name: string, args: string[]) => {
    state.step = name;
    delete state.progressPct;
    delete state.etaMinutes;
    await save(true);
    await deps.log(`\n== snapraid ${args.join(" ")}\n`);
    let out = "";
    const code = await deps.run(spec.bin, ["-c", spec.conf, ...args], (t) => {
      out = (out + t).slice(-200_000);
      void deps.log(t);
      const p = parseProgress(t);
      if (p) {
        // The first progress of a step is shown at once; later ones every few seconds.
        const first = state.progressPct === undefined;
        Object.assign(state, p);
        void save(first);
      }
    });
    return { code, out };
  };
  const finish = async (ok: boolean, result: string) => {
    Object.assign(state, {
      running: false,
      ok,
      result,
      finishedAt: new Date(deps.now()).toISOString(),
    });
    await save(true);
    return state;
  };
  const scrubArgs = (pct: number) => [
    "scrub",
    "-p",
    String(pct),
    "-o",
    String(spec.olderThanDays ?? 10),
  ];
  try {
    if (spec.action === "sync") {
      // Files with zero sub-second timestamps confuse SnapRAID's move detection; touch fixes them.
      await step("touch", ["touch"]);
      const d = await step("diff", ["diff"]);
      // diff exits 2 when there are differences, 0 when there are none.
      if (d.code !== 0 && d.code !== 2)
        return finish(
          false,
          `SnapRAID could not compare the drives with its last sync: ${tail(d.out)}`,
        );
      const diff = parseDiff(d.out);
      state.diff = diff;
      const limit = spec.deleteThreshold ?? 50;
      if (diff.removed > limit)
        return finish(
          false,
          `Stopped before syncing: ${diff.removed} files were deleted since the last sync (more than the ${limit} allowed). A missing or empty drive looks like that, and syncing would throw away the parity needed to rebuild it. Check the drives; if the deletions are real, sync once with a higher limit.`,
        );
      const changes =
        diff.added + diff.removed + diff.updated + diff.moved + diff.copied + diff.restored;
      let did = "Nothing changed since the last sync.";
      if (changes > 0) {
        const s = await step("sync", ["sync"]);
        if (s.code !== 0) return finish(false, `The sync did not finish: ${tail(s.out)}`);
        did = `Synced ${diff.added} added, ${diff.updated} changed, ${diff.removed} deleted, and ${diff.moved} moved files.`;
      }
      if (spec.scrubPercent) {
        const s = await step("scrub", scrubArgs(spec.scrubPercent));
        if (s.code !== 0)
          return finish(false, `${did} Then the scrub found problems: ${tail(s.out)}`);
        did += ` Scrubbed ${spec.scrubPercent}% of the array (the oldest blocks).`;
      }
      return finish(true, did);
    }
    if (spec.action === "scrub") {
      const s = await step("scrub", scrubArgs(spec.scrubPercent ?? 8));
      return s.code === 0
        ? finish(
            true,
            `Scrubbed ${spec.scrubPercent ?? 8}% of the array (blocks not checked for ${spec.olderThanDays ?? 10} days): no errors.`,
          )
        : finish(false, `The scrub found problems: ${tail(s.out)}`);
    }
    if (spec.action === "fix-errors") {
      const s = await step("fix", ["-e", "fix"]);
      return s.code === 0
        ? finish(true, "Fixed the blocks the last check marked as bad.")
        : finish(false, `The fix did not finish: ${tail(s.out)}`);
    }
    if (spec.action === "fix") {
      if (!spec.disk || !/^[\w.-]{1,32}$/.test(spec.disk))
        return finish(false, "No drive was named.");
      const s = await step("fix", ["-d", spec.disk, "fix"]);
      return s.code === 0
        ? finish(
            true,
            `Rebuilt the files of ${spec.disk} from parity. Files changed after the last sync could not be restored exactly; SnapRAID lists them in its output.`,
          )
        : finish(false, `The rebuild of ${spec.disk} did not finish: ${tail(s.out)}`);
    }
    return finish(false, "Unknown job.");
  } catch (error) {
    return finish(false, error instanceof Error ? error.message : String(error));
  }
}

const tail = (s: string) =>
  s
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/\d+%,\s*\d+ MB/.test(l))
    .slice(-4)
    .join(" ")
    .slice(-500);
