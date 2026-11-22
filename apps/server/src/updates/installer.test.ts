import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";

/**
 * The one-command installers' questions (deploy/get.sh, deploy/get.ps1). Run by a script or an AI
 * assistant there is no terminal to ask in: every question takes "no" and says what it chose, so
 * an unattended install never opens Hearth to the home network on its own.
 */
const REPO_ROOT = path.resolve(SERVER_ROOT, "../..");
const GET_SH = path.join(REPO_ROOT, "deploy/get.sh").replaceAll("\\", "/");
const GET_PS1 = path.join(REPO_ROOT, "deploy/get.ps1");

const hasBash = spawnSync("bash", ["-c", "true"], { windowsHide: true }).status === 0;
const hasSetsid =
  process.platform !== "win32" && spawnSync("setsid", ["true"], { windowsHide: true }).status === 0;

/** Runs one of get.sh's choice functions with no terminal (its own session, stdin closed). */
function choose(fn: string, env: Record<string, string> = {}) {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("HEARTH_")),
  );
  const script = `HEARTH_GET_FUNCTIONS_ONLY=1 source "${GET_SH}" && ${fn}`;
  // A new session (setsid) has no controlling terminal, so /dev/tty can't be opened, as for an
  // agent. Where setsid is missing (Git Bash on Windows) there is no terminal to open anyway.
  const [cmd, args] = hasSetsid ? ["setsid", ["bash", "-c", script]] : ["bash", ["-c", script]];
  const r = spawnSync(cmd, args, {
    env: { ...clean, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
  });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: r.stderr ?? "" };
}

describe.skipIf(!hasBash)("get.sh with no terminal", () => {
  it("keeps Hearth on this computer and says so", () => {
    const r = choose("choose_network");
    expect(r.code).toBe(0);
    expect(r.out).toBe("no");
    expect(r.err).toContain("No terminal to ask in");
    expect(r.err).toContain("Home network: no");
    expect(r.err).toContain("HEARTH_NETWORK=yes");
  });

  it("takes the person's answer when an agent passes it", () => {
    expect(choose("choose_network", { HEARTH_NETWORK: "yes" }).out).toBe("yes");
    expect(choose("choose_network", { HEARTH_NETWORK: "no" }).out).toBe("no");
    expect(choose("choose_network", { HEARTH_NETWORK: "yes" }).err).toContain("Home network: yes");
    expect(choose("choose_network", { HEARTH_NETWORK: "maybe" }).code).not.toBe(0);
  });

  it("never opens a joining PC to the network", () => {
    expect(choose("choose_network", { HEARTH_JOIN: "http://10.0.0.2:7600/join?code=x" }).out).toBe(
      "no",
    );
  });

  it("sets up the admin helper only when HEARTH_HELPER=yes", () => {
    expect(choose("choose_helper").out).toBe("no");
    expect(choose("choose_helper", { HEARTH_HELPER: "no" }).out).toBe("no");
    expect(choose("choose_helper", { HEARTH_HELPER: "yes" }).out).toBe("yes");
    expect(choose("choose_helper", { HEARTH_HELPER: "sure" }).code).not.toBe(0);
  });

  it("follows the stable channel unless fast is asked for", () => {
    expect(choose("choose_channel").out).toBe("stable");
    expect(choose("choose_channel", { HEARTH_CHANNEL: "fast" }).out).toBe("fast");
    expect(choose("choose_channel", { HEARTH_CHANNEL: "beta" }).code).not.toBe(0);
  });
});

describe("the installers' text", () => {
  const sh = readFileSync(GET_SH, "utf8");
  const ps1 = readFileSync(GET_PS1, "utf8");

  it("get.sh no longer asks about the admin helper during install", () => {
    expect(sh).not.toMatch(/Set up the admin helper\? \[/);
    expect(sh).toContain("Admin helper: not set up. If a plan needs Docker or Tailscale");
  });

  it("get.sh picks releases by channel and never moves to an older one", () => {
    expect(sh).toContain("select(.isPrerelease | not)");
    expect(sh).toContain("releases/latest");
    expect(sh).toContain("so it stays as it is");
    expect(sh).toContain('"channel": "$channel"');
  });

  it("get.ps1 takes no with no one to ask, and follows a channel", () => {
    expect(ps1).toContain("No one to ask, so Hearth stays on this PC only (home network: no).");
    expect(ps1).toContain('Write-Host "Home network: $Network"');
    expect(ps1).toContain("-not $_.prerelease");
    expect(ps1).toContain("channel = $Channel");
  });
});
