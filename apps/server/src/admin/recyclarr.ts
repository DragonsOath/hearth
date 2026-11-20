import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContainerExec } from "./docker-exec";

/**
 * Recyclarr's own checks (feature request 21): its preview (sync --preview, which changes nothing)
 * on a copy of a configuration, its real sync (only as an approved step), and what its logs say.
 * Every command here is fixed in code; the AI never supplies one.
 */

export interface ProfileSetting {
  instance: string;
  setting: string;
  from: string;
  to: string;
}

export interface RecyclarrReport {
  ok: boolean;
  exitCode: number;
  /** What Recyclarr would set (preview) or set (sync), per profile setting. */
  settings: ProfileSetting[];
  errors: string[];
  warnings: string[];
  /** The log it came from (host path). */
  log?: string;
  at: string;
}

const SETTING =
  /\] ([\w.-]+): (Upgrade Allowed|Cutoff|Cutoff Score|Minimum Upgrade Score|Min(?:imum)? Format Score|Language): (.*?) -> (.*)$/;

export function parseRecyclarrLog(
  text: string,
): Pick<RecyclarrReport, "settings" | "errors" | "warnings"> {
  const settings: ProfileSetting[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/api.?key/i.test(line)) continue;
    const m = SETTING.exec(line);
    if (m) settings.push({ instance: m[1]!, setting: m[2]!, from: m[3]!.trim(), to: m[4]!.trim() });
    else if (/\[(ERR|FTL)\]/.test(line))
      errors.push(line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 300));
    else if (/\[WRN\]/.test(line)) warnings.push(line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 300));
  }
  return { settings, errors, warnings };
}

/** The guide-fetch warning seen on the home server is not a configuration problem: kept as a warning. */
const HARMLESS = /Failed to fetch reference/i;

export class Recyclarr {
  constructor(private readonly exec: ContainerExec) {}

  private async logNames(logDir: string): Promise<Set<string>> {
    const names = await fs.readdir(logDir).catch(() => [] as string[]);
    return new Set(names.filter((x) => x.endsWith(".debug.log")));
  }

  /**
   * The newest debug log written since `since`, from the host folder behind the container's
   * /config. Logs already there before this run (`before`) are passed over when a new one exists:
   * two runs a moment apart can share a modified time, and the earlier run's log must not be read
   * as this one's.
   */
  private async newestLog(
    logDir: string,
    since: number,
    before?: Set<string>,
  ): Promise<{ file: string; text: string } | undefined> {
    const all = [...(await this.logNames(logDir))];
    const fresh = before ? all.filter((n) => !before.has(n)) : [];
    const recent: { file: string; mtime: number }[] = [];
    for (const n of fresh.length ? fresh : all) {
      const st = await fs.stat(path.join(logDir, n)).catch(() => undefined);
      if (st && st.mtimeMs >= since - 2000)
        recent.push({ file: path.join(logDir, n), mtime: st.mtimeMs });
    }
    const pick = recent.sort((a, b) => b.mtime - a.mtime)[0];
    if (!pick) return undefined;
    return { file: pick.file, text: await fs.readFile(pick.file, "utf8") };
  }

  private async run(container: string, logDir: string, cmd: string[]): Promise<RecyclarrReport> {
    const started = Date.now();
    const before = await this.logNames(logDir);
    const r = await this.exec.exec(container, cmd, 180_000);
    const log = await this.newestLog(logDir, started, before);
    const parsed = parseRecyclarrLog(log?.text ?? r.output);
    const errors = parsed.errors.filter((e) => !HARMLESS.test(e));
    return {
      ok: r.exitCode === 0 && errors.length === 0,
      exitCode: r.exitCode,
      settings: parsed.settings,
      errors: errors.length || r.exitCode === 0 ? errors : [r.output.slice(-500)],
      warnings: [...parsed.warnings, ...parsed.errors.filter((e) => HARMLESS.test(e))],
      ...(log ? { log: log.file } : {}),
      at: new Date().toISOString(),
    };
  }

  /** What a sync would do with this configuration (a copy in the container's /tmp; nothing changes). */
  async preview(container: string, logDir: string, config?: string): Promise<RecyclarrReport> {
    if (config === undefined)
      return this.run(container, logDir, ["recyclarr", "sync", "--preview"]);
    const name = `dragon-control-check-${randomUUID().slice(0, 8)}.yml`;
    await this.exec.putFile(container, "/tmp", name, Buffer.from(config, "utf8"));
    let report: RecyclarrReport | undefined;
    try {
      report = await this.run(container, logDir, [
        "recyclarr",
        "sync",
        "--preview",
        "--config",
        `/tmp/${name}`,
      ]);
      return report;
    } finally {
      // The copy is removed as the container's own user; a copy left behind is said, not hidden.
      const rm = await this.exec
        .exec(container, ["rm", "-f", `/tmp/${name}`], 30_000)
        .catch(() => ({ exitCode: -1, output: "" }));
      if (rm.exitCode !== 0 && report)
        report.warnings.push(`The check copy /tmp/${name} could not be removed from ${container}.`);
    }
  }

  /** A real sync (only ever an approved plan step). */
  sync(container: string, logDir: string): Promise<RecyclarrReport> {
    return this.run(container, logDir, ["recyclarr", "sync"]);
  }

  /** The last scheduled (or any) run: newest log in the folder, read only. */
  async lastRun(
    logDir: string,
  ): Promise<
    | (Pick<RecyclarrReport, "settings" | "errors" | "warnings"> & { log: string; at: string })
    | undefined
  > {
    const log = await this.newestLog(logDir, 0);
    if (!log) return undefined;
    const st = await fs.stat(log.file);
    return { ...parseRecyclarrLog(log.text), log: log.file, at: st.mtime.toISOString() };
  }
}

/** Plain words: "HD Bluray + WEB" instance names are Recyclarr's own (hd-bluray-web). */
export function describeSettings(settings: ProfileSetting[]): string[] {
  return settings.map((s) => `${s.instance} ${s.setting}: ${s.from} -> ${s.to}`);
}
