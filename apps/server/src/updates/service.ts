import { execFile, spawn } from "node:child_process";
import type { InstallInfo } from "../pcs/link";
import { backgroundPowerShell } from "../pcs/windows-launch";

/**
 * Hearth updates: every few hours Hearth asks GitHub whether a newer release is out. When one
 * is, it says so once (the bell, and the "Hearth updates" notifications), and Update now runs the
 * same one-command installer you used, in its own background job (the installer stops Hearth while
 * it swaps the app, so it cannot run inside Hearth). Your data and settings are kept, as with any
 * run of the installer.
 */

export const REPO = "DragonsOath/hearth";

/** The commands to update by hand, the same as installing. */
export const UPDATE_COMMANDS = {
  linux: `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/deploy/get.sh | bash`,
  windows: `irm https://raw.githubusercontent.com/${REPO}/main/deploy/get.ps1 | iex`,
};

export interface Release {
  version: string;
  /** What's new, from the release's notes (plain text, trimmed). */
  notes: string;
  url: string;
}

export interface UpdateState {
  current: string | null;
  latest: Release | null;
  /** A newer release than this Hearth is out. */
  available: boolean;
  checkedAt: string | null;
  /** Why the last check could not tell (the GitHub CLI missing or signed out, say). */
  problem: string | null;
  /** Hearth can update itself here (it was installed by the one-command installer). */
  canUpdate: boolean;
  /** Why it can't, when it can't: what to do instead. */
  cannot: string | null;
  commands: typeof UPDATE_COMMANDS;
  /** An update was started and Hearth is about to restart. */
  updating: boolean;
  /** Work an update would stop right now (Ember answering, agent tasks), in plain words. */
  busy: string[];
  /** Hearth checks for updates on its own (Settings, About). */
  auto: boolean;
}

/** Where the newest release comes from (GitHub through its CLI; a stand-in in tests). */
export type ReleaseSource = () => Promise<Release | null>;

/** "0.31.0" vs "0.30.2": a positive number when a is newer. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const run = (cmd: string, args: string[], timeoutMs = 30_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout),
    ),
  );

/** One release as GitHub's public API lists it. */
interface ApiRelease {
  tag_name: string;
  draft: boolean;
  body?: string | null;
  html_url?: string;
}

/**
 * The newest published release. The repository is public: GitHub's API answers without signing
 * in (60 questions an hour per address; Hearth asks every few hours). If it can't (no internet
 * that way, the limit reached), the GitHub CLI is tried, when it is installed and signed in.
 */
export const githubReleases: ReleaseSource = async () => {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Hearth updates" },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      const list = (await r.json()) as ApiRelease[];
      const newest = list
        .filter((x) => !x.draft && /^v\d+\.\d+\.\d+$/.test(x.tag_name))
        .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
      if (!newest) return null;
      return {
        version: newest.tag_name.replace(/^v/, ""),
        notes: plainNotes(newest.body ?? ""),
        url: newest.html_url ?? "",
      };
    }
  } catch {
    /* fall back to the GitHub CLI below */
  }
  return cliReleases();
};

/** The same, through the GitHub CLI (signed in), when GitHub's API can't be asked directly. */
async function cliReleases(): Promise<Release | null> {
  const list = JSON.parse(
    await run("gh", ["release", "list", "-R", REPO, "--limit", "100", "--json", "tagName,isDraft"]),
  ) as { tagName: string; isDraft: boolean }[];
  // The highest version, not the first listed (GitHub's order is by when a release was made).
  const tag = list
    .filter((r) => !r.isDraft && /^v\d+\.\d+\.\d+$/.test(r.tagName))
    .map((r) => r.tagName)
    .sort((a, b) => compareVersions(b, a))[0];
  if (!tag) return null;
  const view = JSON.parse(
    await run("gh", ["release", "view", tag, "-R", REPO, "--json", "body,url"]),
  ) as { body?: string; url?: string };
  return {
    version: tag.replace(/^v/, ""),
    notes: plainNotes(view.body ?? ""),
    url: view.url ?? "",
  };
}

/**
 * Lines that are build details, not news for an owner: commit hashes, file paths, install and
 * changelog pointers. Older releases carried only these.
 */
const BUILD_DETAIL = [
  /^(built from|install:|full changelog)/i,
  /\b[0-9a-f]{12,}\b/i,
  /(^|[\s("'])(docs|apps|packages|deploy|\.github)\/\S+/,
  /^maintenance release\.?$/i,
];

/**
 * Release notes as a short plain summary: no headings marks, links, code marks or build details,
 * at most 1200 characters. "Fixes and improvements." when nothing readable is left.
 */
export function plainNotes(md: string): string {
  const text = md
    .replace(/\r/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .split("\n")
    .filter((line) => !BUILD_DETAIL.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1200);
  return text || "Fixes and improvements.";
}

const SAFE_SERVICE = /^[A-Za-z0-9_-]{1,40}$/;

/** What Update now runs, or why it can't. */
export function updatePlan(
  info: InstallInfo | null,
  platform = process.platform,
): { ok: true; command: string; args: string[] } | { ok: false; message: string } {
  if (!info || info.kind === "manual" || !info.home)
    return {
      ok: false,
      message: "Hearth was installed on this PC by hand, so update it the way you installed it.",
    };
  const service = info.service ?? "hearth";
  if (!SAFE_SERVICE.test(service)) return { ok: false, message: "Its service name is not valid." };
  if (info.kind === "linux-user-service" && platform === "linux") {
    const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    // Its own transient service: the installer stops Hearth, and this must outlive that.
    const script = `sleep 2; export HEARTH_HOME=${q(info.home)} HEARTH_SERVICE=${q(service)}; ${UPDATE_COMMANDS.linux}`;
    return {
      ok: true,
      command: "systemd-run",
      args: [
        "--user",
        "--collect",
        `--unit=hearth-update-${Date.now()}`,
        "/bin/bash",
        "-lc",
        script,
      ],
    };
  }
  if (info.kind === "windows-sign-in-task" && platform === "win32") {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = `Start-Sleep -Seconds 2; $env:HEARTH_HOME = ${q(info.home)}; ${UPDATE_COMMANDS.windows}`;
    return { ok: true, ...backgroundPowerShell(script) };
  }
  return {
    ok: false,
    message: "Hearth can't update itself on this system. Run the update command instead.",
  };
}

const EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATE_WINDOW_MS = 10 * 60 * 1000;

export class Updates {
  private latest: Release | null = null;
  private checkedAt: string | null = null;
  private problem: string | null = null;
  private updating = false;
  private updateStartedAt = 0;
  private checking: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: {
      current: () => string | null;
      install: () => InstallInfo | null;
      source: ReleaseSource;
      /** Says a new release is out, once per version (the bell, notifications). */
      announce: (release: Release, current: string | null) => Promise<void>;
      /** The last version announced (kept across restarts), and remembering one. */
      announced: () => Promise<string | undefined>;
      remember: (version: string) => Promise<void>;
      /** Starting the update; tests replace it. */
      launch?: (command: string, args: string[]) => void;
      /** The system Hearth runs on (tests set it). */
      platform?: NodeJS.Platform;
      /** Work an update would cut off (an update restarts Hearth). */
      busy?: () => Promise<string[]>;
      /**
       * Whether Hearth checks on its own (Settings, About: Check for updates). Off: it never asks
       * GitHub unless someone presses Check now (the Pledge, 11-20). On when not given.
       */
      auto?: () => Promise<boolean>;
    },
  ) {}

  private async auto() {
    return this.opts.auto ? this.opts.auto().catch(() => true) : true;
  }

  /** Checks a minute after starting, then every six hours, while Check for updates is on. */
  start() {
    const first = setTimeout(() => void this.autoCheck(), 60_000);
    first.unref();
    this.timer = setInterval(() => void this.autoCheck(), EVERY_MS);
    this.timer.unref();
  }

  private async autoCheck() {
    if (await this.auto()) await this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        this.latest = await this.opts.source();
        this.problem = null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.problem = /ENOENT|not found|not recognized/i.test(msg)
          ? "The GitHub CLI is not on this PC, so Hearth can't see new releases."
          : /auth|login|401|403/i.test(msg)
            ? "The GitHub CLI is signed out on this PC: run gh auth login there."
            : "GitHub could not be reached just now.";
      }
      this.checkedAt = new Date().toISOString();
      const current = this.opts.current();
      const latest = this.latest;
      if (latest && (!current || compareVersions(latest.version, current) > 0)) {
        if ((await this.opts.announced()) !== latest.version) {
          await this.opts.remember(latest.version);
          await this.opts.announce(latest, current).catch(() => undefined);
        }
      }
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** The state, checking first when it has never been checked (only while checks are on). */
  async state(): Promise<UpdateState> {
    const auto = await this.auto();
    if (!this.checkedAt && auto) await this.check();
    const current = this.opts.current();
    const plan = updatePlan(this.opts.install(), this.opts.platform);
    return {
      current,
      latest: this.latest,
      available: Boolean(
        this.latest && (!current || compareVersions(this.latest.version, current) > 0),
      ),
      checkedAt: this.checkedAt,
      problem: this.problem,
      canUpdate: plan.ok,
      cannot: plan.ok ? null : plan.message,
      commands: UPDATE_COMMANDS,
      updating: this.updating,
      busy: await this.busy(),
      auto,
    };
  }

  private async busy(): Promise<string[]> {
    return this.opts.busy ? await this.opts.busy().catch(() => []) : [];
  }

  /**
   * Update now: the installer runs in its own background job; Hearth restarts in a minute or two.
   * Updating restarts Hearth, which stops any work in progress (10-28: an update cut off
   * Ember mid-task). So while something is running it is only done when the owner says
   * "update anyway"; otherwise it says what would stop.
   */
  async install(opts: { anyway?: boolean } = {}): Promise<{
    ok: boolean;
    message: string;
    busy?: string[];
  }> {
    const plan = updatePlan(this.opts.install(), this.opts.platform);
    if (!plan.ok) return plan;
    // One update at a time: a second installer started while the first runs fights it over the app
    // folder and leaves Hearth stopped (Desktop-PC, 2026-10-31). After ten minutes a stuck or
    // failed update no longer blocks trying again.
    if (this.updating && Date.now() - this.updateStartedAt < UPDATE_WINDOW_MS)
      return {
        ok: true,
        message:
          "An update is already running. Hearth restarts when it is done; refresh this page then.",
      };
    const busy = await this.busy();
    if (busy.length && !opts.anyway)
      return {
        ok: false,
        busy,
        message: `Updating restarts Hearth, which would stop ${busy.join(" and ")}. Update when that is done, or update anyway.`,
      };
    const launch =
      this.opts.launch ??
      ((command: string, args: string[]) => {
        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
      });
    launch(plan.command, plan.args);
    this.updating = true;
    this.updateStartedAt = Date.now();
    return {
      ok: true,
      message:
        "Updating. Hearth downloads the new version and restarts in a minute or two; refresh this page then.",
    };
  }
}
