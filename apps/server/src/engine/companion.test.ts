import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexCompanionArgs, findCompanion } from "./companion";
import { Codex } from "./runners";

function claudeHome(withAddOn: boolean) {
  const home = mkdtempSync(path.join(tmpdir(), "hearth-claude-"));
  const install = path.join(home, "plugins", "cache", "dragon-control", "0.1.0");
  mkdirSync(path.join(install, "companion"), { recursive: true });
  writeFileSync(path.join(install, "companion", "companion.mjs"), "");
  writeFileSync(
    path.join(home, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: withAddOn ? { "dragon-control@dragon-control": [{ installPath: install }] } : {},
    }),
  );
  return { home, companion: path.join(install, "companion", "companion.mjs") };
}

const run = (resume: string | null) => ({
  prompt: "hi",
  cwd: ".",
  model: null,
  project: {
    path: ".",
    permissionMode: "",
    allowedTools: [],
    codexSandbox: "danger-full-access",
  },
  resume,
  attachments: [],
  timeoutMs: 1000,
  signal: new AbortController().signal,
  onLine: () => undefined,
  onStart: () => undefined,
});

describe("Hearth's memory tools for Codex (agent parity)", () => {
  it("finds the companion only when Claude Code has the Hearth add-on", () => {
    const yes = claudeHome(true);
    expect(findCompanion(yes.home)).toBe(yes.companion);
    expect(findCompanion(claudeHome(false).home)).toBeNull();
    expect(findCompanion(path.join(tmpdir(), "no-such-claude-home"))).toBeNull();
  });

  it("gives Codex the same tool server, in new and continued conversations", () => {
    const args = codexCompanionArgs("/x/companion.mjs", "/usr/bin/node");
    expect(args).toEqual([
      "-c",
      'mcp_servers.dragon-control.command="/usr/bin/node"',
      "-c",
      'mcp_servers.dragon-control.args=["/x/companion.mjs","serve"]',
    ]);
    expect(codexCompanionArgs(null)).toEqual([]);
    const codex = new Codex("codex", () => "/x/companion.mjs");
    for (const resume of [null, "thread-1"]) {
      const argv = codex["build"](run(resume)).join(" ");
      expect(argv).toContain("mcp_servers.dragon-control.command=");
      expect(argv).toContain('mcp_servers.dragon-control.args=["/x/companion.mjs","serve"]');
    }
    expect(codex["input"](run(null))).toContain("dragon-control tools");
    expect(new Codex("codex")["build"](run(null)).join(" ")).not.toContain("dragon-control");
  });
});
