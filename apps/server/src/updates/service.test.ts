import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Updates,
  compareVersions,
  githubReleases,
  onChannel,
  plainNotes,
  updatePlan,
  type Release,
} from "./service";
import { decodedScript } from "../pcs/windows-launch";

describe("compareVersions", () => {
  it("orders versions by number, not by text", () => {
    expect(compareVersions("0.31.0", "0.30.9")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.30.0", "0.31.0")).toBeLessThan(0);
  });
});

describe("plainNotes", () => {
  it("keeps the words, drops headings, bold, and link addresses", () => {
    expect(plainNotes("## What's new\r\n\r\n**Faster** [War Room](https://x.y)\n\n\n\nMore")).toBe(
      "What's new\n\nFaster War Room\n\nMore",
    );
  });

  it("drops build details that mean nothing to an owner", () => {
    expect(
      plainNotes(
        "Built from de356f28e8c0af892253d2226a6ac6ad73d9e05c. Install: docs/INSTALL_RELEASE.md.",
      ),
    ).toBe("Fixes and improvements.");
    expect(
      plainNotes(
        [
          "Maintenance release.",
          "",
          "- Storage: a failed mirror shows **Degraded**.",
          "- Fixed in `read.ts` (apps/server/src/storage/raid/read.ts)",
          "**Full Changelog**: [v1...v2](https://github.com/example/compare/v1...v2)",
        ].join("\n"),
      ),
    ).toBe("- Storage: a failed mirror shows Degraded.");
    expect(plainNotes("")).toBe("Fixes and improvements.");
  });
});

describe("updatePlan", () => {
  it("runs the installer in its own background job, on the same install", () => {
    const linux = updatePlan(
      { kind: "linux-user-service", home: "/home/alex/hearth", service: "hearth" },
      "linux",
    );
    expect(linux.ok).toBe(true);
    if (linux.ok) {
      expect(linux.command).toBe("systemd-run");
      expect(linux.args.join(" ")).toContain("HEARTH_HOME='/home/alex/hearth'");
      expect(linux.args.join(" ")).toContain("deploy/get.sh");
    }
    const win = updatePlan(
      { kind: "windows-sign-in-task", home: "C:\\Users\\alex\\Hearth", service: "Hearth" },
      "win32",
    );
    // Through cmd start, never a detached PowerShell (it has no console and exits at once).
    expect(win.ok && win.command).toBe("cmd.exe");
    if (win.ok) {
      expect(win.args.slice(0, 6)).toEqual(["/d", "/c", "start", '""', "/min", "powershell.exe"]);
      const script = decodedScript(win.args);
      expect(script).toContain(String.raw`$env:HEARTH_HOME = 'C:\Users\alex\Hearth'`);
      expect(script).toContain("deploy/get.ps1");
      // Nothing cmd could misread: the script only goes encoded.
      expect(win.args.filter((a) => /[|"&<>]/.test(a))).toEqual(['""']);
    }
  });

  it("installs exactly the version the check found, never another channel's newer one", () => {
    const linux = updatePlan(
      { kind: "linux-user-service", home: "/home/alex/hearth", service: "hearth" },
      "linux",
      "0.88.0",
    );
    expect(linux.ok && linux.args.join(" ")).toContain("HEARTH_VERSION='0.88.0'");
    const win = updatePlan(
      { kind: "windows-sign-in-task", home: "C:\\Users\\alex\\Hearth", service: "Hearth" },
      "win32",
      "0.88.0",
    );
    expect(win.ok && decodedScript(win.args)).toContain("$env:HEARTH_VERSION = '0.88.0'");
    expect(
      updatePlan({ kind: "linux-user-service", home: "/x", service: "hearth" }, "linux", "1; rm"),
    ).toMatchObject({ ok: false });
  });

  it("says what to do when Hearth can't update itself", () => {
    expect(updatePlan(null, "linux")).toMatchObject({ ok: false });
    expect(
      updatePlan({ kind: "linux-user-service", home: "/x", service: "bad name;" }, "linux"),
    ).toMatchObject({ ok: false });
  });
});

describe("release channels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stable takes only releases marked stable; fast takes every published one", () => {
    const pre = { draft: false, prerelease: true, tag: "v0.88.0" };
    const stable = { draft: false, prerelease: false, tag: "v0.87.1" };
    expect(onChannel(pre, "stable")).toBe(false);
    expect(onChannel(pre, "fast")).toBe(true);
    expect(onChannel(stable, "stable")).toBe(true);
    expect(onChannel({ ...stable, draft: true }, "fast")).toBe(false);
    expect(onChannel({ ...stable, tag: "voices-v2" }, "fast")).toBe(false);
  });

  it("the check asks GitHub and picks the newest release on the channel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { tag_name: "v0.88.0", draft: false, prerelease: true, body: "Fast one." },
          { tag_name: "v0.87.1", draft: false, prerelease: false, body: "Stable one." },
          { tag_name: "v0.89.0", draft: true, prerelease: true, body: "Draft." },
        ],
      })),
    );
    expect((await githubReleases("stable"))?.version).toBe("0.87.1");
    expect((await githubReleases("fast"))?.version).toBe("0.88.0");
  });

  it("follows the chosen channel, says which, and Update now pins that version", async () => {
    const asked: string[] = [];
    const launched: string[][] = [];
    const u = new Updates({
      current: () => "0.87.1",
      install: () => ({ kind: "linux-user-service", home: "/home/alex/hearth", service: "hearth" }),
      source: async (channel) => {
        asked.push(channel);
        return channel === "fast"
          ? { version: "0.88.0", notes: "", url: "" }
          : { version: "0.87.1", notes: "", url: "" };
      },
      announce: async () => {},
      announced: async () => undefined,
      remember: async () => {},
      launch: (_cmd, args) => launched.push(args),
      platform: "linux",
      channel: async () => "fast",
    });
    expect(await u.state()).toMatchObject({ channel: "fast", available: true });
    expect(asked).toEqual(["fast"]);
    await u.install();
    expect(launched[0]!.join(" ")).toContain("HEARTH_VERSION='0.88.0'");
  });

  it("is stable when nothing is chosen", async () => {
    const u = new Updates({
      current: () => "0.87.1",
      install: () => null,
      source: async () => null,
      announce: async () => {},
      announced: async () => undefined,
      remember: async () => {},
    });
    expect((await u.state()).channel).toBe("stable");
  });
});

describe("Updates", () => {
  const make = (latest: Release | null, current = "0.30.0", fail?: string, busy: string[] = []) => {
    let announced: string | undefined;
    const said: string[] = [];
    const launched: string[] = [];
    const u = new Updates({
      current: () => current,
      install: () => ({ kind: "linux-user-service", home: "/home/alex/hearth", service: "hearth" }),
      source: async () => {
        if (fail) throw new Error(fail);
        return latest;
      },
      announce: async (r) => {
        said.push(r.version);
      },
      announced: async () => announced,
      remember: async (v) => {
        announced = v;
      },
      launch: (cmd) => launched.push(cmd),
      platform: "linux",
      busy: async () => busy,
    });
    return { u, said, launched };
  };
  const release = { version: "0.31.0", notes: "New look.", url: "https://example.com" };

  it("with Check for updates off, never asks on its own; Check now still does", async () => {
    let asked = 0;
    const u = new Updates({
      current: () => "0.30.0",
      install: () => null,
      source: async () => {
        asked++;
        return release;
      },
      announce: async () => {},
      announced: async () => undefined,
      remember: async () => {},
      auto: async () => false,
    });
    expect(await u.state()).toMatchObject({ auto: false, checkedAt: null, available: false });
    expect(asked).toBe(0);
    await u.check();
    expect(asked).toBe(1);
    expect(await u.state()).toMatchObject({ auto: false, available: true });
  });

  it("says a new release is out once, however often it checks", async () => {
    const { u, said } = make(release);
    await u.check();
    await u.check();
    expect(said).toEqual(["0.31.0"]);
    expect(await u.state()).toMatchObject({ available: true, current: "0.30.0", problem: null });
  });

  it("is quiet when this Hearth is the newest", async () => {
    const { u, said } = make(release, "0.31.0");
    expect(await u.state()).toMatchObject({ available: false });
    expect(said).toEqual([]);
  });

  it("explains a check that could not tell", async () => {
    const { u } = make(
      null,
      "0.30.0",
      "gh: To get started with GitHub CLI, please run: gh auth login",
    );
    expect((await u.state()).problem).toContain("gh auth login");
  });

  it("Update now starts the installer and says Hearth restarts", async () => {
    const { u, launched } = make(release);
    expect(await u.install()).toMatchObject({ ok: true });
    expect(launched.length).toBe(1);
    expect((await u.state()).updating).toBe(true);
  });

  it("clicking Update now twice starts one installer, not two", async () => {
    const { u, launched } = make(release);
    expect(await u.install()).toMatchObject({ ok: true });
    const again = await u.install();
    expect(again).toMatchObject({ ok: true });
    expect(again.message).toContain("already running");
    expect(launched.length).toBe(1);
  });

  it("never cuts off work in progress unless the owner says update anyway", async () => {
    const { u, launched } = make(release, "0.30.0", undefined, ["Ember answering a question"]);
    expect((await u.state()).busy).toEqual(["Ember answering a question"]);
    const refused = await u.install();
    expect(refused).toMatchObject({ ok: false, busy: ["Ember answering a question"] });
    expect(refused.message).toContain("would stop Ember answering a question");
    expect(launched.length).toBe(0);
    expect(await u.install({ anyway: true })).toMatchObject({ ok: true });
    expect(launched.length).toBe(1);
  });
});
