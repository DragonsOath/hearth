import { describe, expect, it } from "vitest";
import { GitHub, GitHubError, fakeGhApi, repoOfRemote } from "./github";

describe("the War Room's GitHub panel", () => {
  it("finds a project's repository from its git remote", () => {
    expect(repoOfRemote("https://github.com/owner/repo.git\n")).toBe("owner/repo");
    expect(repoOfRemote("git@github.com:owner/my.repo.git")).toBe("owner/my.repo");
    expect(repoOfRemote("https://gitlab.com/owner/repo.git")).toBeUndefined();
  });

  it("draws your GitHub, a repo, and a pull request from gh's answers", async () => {
    const g = new GitHub(fakeGhApi);
    const o = await g.overview();
    expect(o.user.login).toBe("homelab-owner");
    expect(o.prs[0]).toMatchObject({ repo: "homelab-owner/media-scripts", number: 7 });
    const r = await g.repoPage("homelab-owner/media-scripts");
    expect(r.default_branch).toBe("main");
    expect(r.branches).toContain("rename-by-date");
    const p = await g.prPage("homelab-owner/media-scripts", 7);
    expect(p.checks).toEqual([{ name: "tests", state: "success" }]);
    expect(p.files[0]!.patch).toContain("+import os");
  });

  it("refuses a repository name that isn't owner/name", async () => {
    const g = new GitHub(fakeGhApi);
    await expect(g.repoPage("../../etc")).rejects.toBeInstanceOf(GitHubError);
  });
});
