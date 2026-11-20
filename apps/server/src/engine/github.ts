import { execFile } from "node:child_process";
import { cleanEnv, findBinary } from "./runners";

/**
 * The War Room's GitHub panel (ported from EMBER): your repos, pull requests and a PR's commits,
 * checks and diffs, read live with the gh tool already signed in on Hearth's machine. Read only.
 * Real github.com pages cannot be embedded (GitHub forbids it), so the panel draws this data.
 */

/** Runs gh with the given API path and returns its JSON (no shell; arguments as a list). */
export type GhApi = (path: string) => Promise<unknown>;

const REPO = /^[\w.-]+\/[\w.-]+$/;
const TTL_MS = 30_000;

export function ghApi(binary = findBinary("gh") ?? "gh"): GhApi {
  return (path) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        ["api", "-H", "Accept: application/vnd.github+json", path],
        { env: cleanEnv(), windowsHide: true, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const why = (stderr || err.message).trim().split("\n").at(-1) ?? "";
            reject(
              new GitHubError(
                /auth login|not logged|authentication/i.test(why)
                  ? "GitHub isn't signed in on this computer. Sign in once with: gh auth login"
                  : /ENOENT|not recognized|not found/i.test(why)
                    ? "The GitHub tool (gh) isn't installed on this computer."
                    : `GitHub said: ${why || "no answer"}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout || "null"));
          } catch {
            reject(new GitHubError("GitHub's answer could not be read."));
          }
        },
      );
    });
}

export class GitHubError extends Error {}

type J = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" ? v : 0);
const arr = (v: unknown) => (Array.isArray(v) ? (v as J[]) : []);
const firstLine = (m: string) => m.split("\n")[0] ?? "";

/** owner/name from a GitHub remote address, or undefined. */
export function repoOfRemote(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

export class GitHub {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly api: GhApi = ghApi()) {}

  private async get(path: string, fresh: boolean): Promise<unknown> {
    const hit = this.cache.get(path);
    if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.api(path);
    this.cache.set(path, { at: Date.now(), value });
    return value;
  }

  private repo(repo: string) {
    if (!REPO.test(repo)) throw new GitHubError("That isn't a repository name (owner/name).");
    return repo;
  }

  /** You, your open pull requests, ones waiting for your review, and your recent repos. */
  async overview(fresh = false) {
    const [user, mine, review, repos] = await Promise.all([
      this.get("user", fresh) as Promise<J>,
      this.get("search/issues?q=is:pr+is:open+author:@me&sort=updated&per_page=20", fresh),
      this.get(
        "search/issues?q=is:pr+is:open+review-requested:@me&sort=updated&per_page=20",
        fresh,
      ),
      this.get("user/repos?sort=pushed&per_page=20", fresh),
    ]);
    const prs = (r: unknown) =>
      arr((r as J)?.items).map((i) => ({
        repo: s(i.repository_url).split("/repos/")[1] ?? "",
        number: n(i.number),
        title: s(i.title),
        updated: s(i.updated_at),
        ...(i.draft ? { draft: true } : {}),
      }));
    return {
      user: {
        login: s(user?.login),
        ...(user?.name ? { name: s(user.name) } : {}),
        avatar: s(user?.avatar_url),
      },
      prs: prs(mine),
      review: prs(review),
      repos: arr(repos).map((r) => ({
        full: s(r.full_name),
        private: Boolean(r.private),
        ...(r.language ? { language: s(r.language) } : {}),
        pushed: s(r.pushed_at),
      })),
    };
  }

  /** One repository: its pull requests, latest commits on the default branch, and branches. */
  async repoPage(name: string, fresh = false) {
    const repo = this.repo(name);
    const info = (await this.get(`repos/${repo}`, fresh)) as J;
    const [pulls, commits, branches] = await Promise.all([
      this.get(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=15`, fresh),
      this.get(`repos/${repo}/commits?per_page=15`, fresh),
      this.get(`repos/${repo}/branches?per_page=50`, fresh),
    ]);
    return {
      full: s(info.full_name) || repo,
      private: Boolean(info.private),
      default_branch: s(info.default_branch),
      ...(info.language ? { language: s(info.language) } : {}),
      ...(info.description ? { description: s(info.description) } : {}),
      pulls: arr(pulls).map((p) => ({
        number: n(p.number),
        title: s(p.title),
        head: s((p.head as J)?.ref),
        state: p.merged_at ? "merged" : s(p.state),
        ...(p.draft ? { draft: true } : {}),
        updated: s(p.updated_at),
      })),
      commits: arr(commits).map((c) => ({
        sha: s(c.sha).slice(0, 7),
        message: firstLine(s((c.commit as J)?.message)),
        author: s(((c.commit as J)?.author as J)?.name) || s((c.author as J)?.login),
        date: s(((c.commit as J)?.author as J)?.date),
      })),
      branches: arr(branches).map((b) => s(b.name)),
    };
  }

  /** One pull request: its commits, checks, review state, and each file's diff. */
  async prPage(name: string, num: number, fresh = false) {
    const repo = this.repo(name);
    if (!Number.isInteger(num) || num <= 0) throw new GitHubError("Say which pull request.");
    const pr = (await this.get(`repos/${repo}/pulls/${num}`, fresh)) as J;
    const sha = s((pr.head as J)?.sha);
    const [commits, files, reviews, checks] = await Promise.all([
      this.get(`repos/${repo}/pulls/${num}/commits?per_page=50`, fresh),
      this.get(`repos/${repo}/pulls/${num}/files?per_page=100`, fresh),
      this.get(`repos/${repo}/pulls/${num}/reviews?per_page=50`, fresh),
      sha
        ? this.get(`repos/${repo}/commits/${sha}/check-runs?per_page=50`, fresh).catch(() => null)
        : Promise.resolve(null),
    ]);
    const lastReview = arr(reviews)
      .map((r) => s(r.state))
      .filter((x) => x && x !== "COMMENTED")
      .at(-1);
    return {
      number: num,
      title: s(pr.title),
      state: pr.merged_at ? "merged" : s(pr.state),
      ...(pr.draft ? { draft: true } : {}),
      author: s((pr.user as J)?.login),
      head: s((pr.head as J)?.ref),
      base: s((pr.base as J)?.ref),
      commits: arr(commits).map((c) => ({
        sha: s(c.sha).slice(0, 7),
        message: firstLine(s((c.commit as J)?.message)),
        ...(((c.commit as J)?.author as J)?.name
          ? { author: s(((c.commit as J)?.author as J)?.name) }
          : {}),
      })),
      changed: n(pr.changed_files),
      additions: n(pr.additions),
      deletions: n(pr.deletions),
      updated: s(pr.updated_at),
      ...(lastReview ? { review: lastReview.toLowerCase().replace(/_/g, " ") } : {}),
      ...(pr.body ? { body: s(pr.body) } : {}),
      checks: arr((checks as J | null)?.check_runs).map((c) => ({
        name: s(c.name),
        state: s(c.conclusion) || s(c.status),
      })),
      files: arr(files).map((f) => ({
        name: s(f.filename),
        status: s(f.status),
        additions: n(f.additions),
        deletions: n(f.deletions),
        ...(f.patch ? { patch: s(f.patch) } : {}),
      })),
    };
  }
}

/** A stand-in GitHub for tests and demos (DC_FAKE_AGENT): one repo with one open pull request. */
export const fakeGhApi: GhApi = async (path) => {
  const now = new Date().toISOString();
  if (path === "user") return { login: "homelab-owner", name: "Homelab Owner", avatar_url: "" };
  if (path.startsWith("search/issues") && path.includes("author:@me"))
    return {
      items: [
        {
          repository_url: "https://api.github.com/repos/homelab-owner/media-scripts",
          number: 7,
          title: "Rename downloads by date",
          updated_at: now,
        },
      ],
    };
  if (path.startsWith("search/issues")) return { items: [] };
  if (path.startsWith("user/repos"))
    return [
      {
        full_name: "homelab-owner/media-scripts",
        private: true,
        language: "Python",
        pushed_at: now,
      },
    ];
  if (path === "repos/homelab-owner/media-scripts")
    return {
      full_name: "homelab-owner/media-scripts",
      private: true,
      default_branch: "main",
      language: "Python",
      description: "Small scripts for the media library.",
    };
  if (path.startsWith("repos/homelab-owner/media-scripts/pulls/7/files"))
    return [
      {
        filename: "rename.py",
        status: "added",
        additions: 12,
        deletions: 0,
        patch: "@@ -0,0 +1,2 @@\n+import os\n+print('rename')",
      },
    ];
  if (path.startsWith("repos/homelab-owner/media-scripts/pulls/7/commits"))
    return [
      { sha: "abc1234def", commit: { message: "Add rename script", author: { name: "Ember" } } },
    ];
  if (path.startsWith("repos/homelab-owner/media-scripts/pulls/7/reviews")) return [];
  if (path === "repos/homelab-owner/media-scripts/pulls/7")
    return {
      title: "Rename downloads by date",
      state: "open",
      user: { login: "homelab-owner" },
      head: { ref: "rename-by-date", sha: "abc1234def" },
      base: { ref: "main" },
      changed_files: 1,
      additions: 12,
      deletions: 0,
      updated_at: now,
    };
  if (path.includes("/check-runs"))
    return { check_runs: [{ name: "tests", status: "completed", conclusion: "success" }] };
  if (path.startsWith("repos/homelab-owner/media-scripts/pulls"))
    return [
      {
        number: 7,
        title: "Rename downloads by date",
        head: { ref: "rename-by-date" },
        state: "open",
        updated_at: now,
      },
    ];
  if (path.startsWith("repos/homelab-owner/media-scripts/commits"))
    return [
      {
        sha: "9f8e7d6c5b",
        commit: { message: "First scripts", author: { name: "Homelab Owner", date: now } },
      },
    ];
  if (path.startsWith("repos/homelab-owner/media-scripts/branches"))
    return [{ name: "main" }, { name: "rename-by-date" }];
  throw new GitHubError("Not found");
};
