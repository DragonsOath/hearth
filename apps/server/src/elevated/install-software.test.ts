import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  InstallFailed,
  InstallRefused,
  SCRIPTS,
  dockerInstall,
  tailscaleInstall,
  type InstallDeps,
} from "./install-software";

const bash = spawnSync("bash", ["--version"]).status === 0;

function fake(out: string, code = 0) {
  const calls: { cmd: string; args: string[] }[] = [];
  const deps: InstallDeps = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code, out };
    },
  };
  return { deps, calls };
}

describe("installing Docker and Tailscale (elevated executor)", () => {
  it.skipIf(!bash)("both scripts are valid bash", () => {
    for (const s of Object.values(SCRIPTS)) {
      const r = spawnSync("bash", ["-n"], { input: s });
      expect(r.status, r.stderr.toString()).toBe(0);
    }
  });

  it("uses only the vendors' own package repositories, never a piped install script", () => {
    expect(SCRIPTS.docker).toContain("https://download.docker.com/linux/");
    expect(SCRIPTS.tailscale).toContain("https://pkgs.tailscale.com/stable/");
    for (const s of Object.values(SCRIPTS)) {
      expect(s).not.toMatch(/\|\s*(ba)?sh\b/);
      expect(s).not.toContain("get.docker.com");
      expect(s).not.toContain("install.sh");
    }
    // The account gets Docker's socket now, and again each time Docker starts.
    expect(SCRIPTS.docker).toContain("usermod -aG docker");
    expect(SCRIPTS.docker).toContain(
      "ExecStartPost=/usr/bin/setfacl -m u:$user:rw /run/docker.sock",
    );
    expect(SCRIPTS.tailscale).toContain('tailscale set --operator="$user"');
  });

  it("runs outside the sandbox through systemd-run, for the scope's account only", async () => {
    const { deps, calls } = fake("HEARTH-OK docker 29.1.0 compose 2.40.0");
    const r = await dockerInstall({}, deps, "alex");
    expect(calls[0]!.cmd).toBe("systemd-run");
    expect(calls[0]!.args).toContain("--wait");
    expect(calls[0]!.args.at(-1)).toBe("alex");
    expect(r.result).toContain("Installed Docker (Engine 29.1.0, Compose 2.40.0)");
  });

  it("takes no settings from the request and needs a real account in the scope", async () => {
    const { deps } = fake("HEARTH-OK docker 1 compose 2");
    await expect(dockerInstall({ user: "root" }, deps, "alex")).rejects.toThrow(InstallRefused);
    await expect(dockerInstall({}, deps, undefined)).rejects.toThrow(InstallRefused);
    await expect(dockerInstall({}, deps, "root")).rejects.toThrow(InstallRefused);
    await expect(tailscaleInstall({}, deps, "a b")).rejects.toThrow(InstallRefused);
  });

  it("says plainly when the system is not one it knows, and fails without its closing line", async () => {
    await expect(
      dockerInstall({}, fake("HEARTH-UNSUPPORTED Arch Linux", 3).deps, "alex"),
    ).rejects.toThrow(/Ubuntu, Debian and Fedora.*Arch Linux/);
    await expect(
      dockerInstall({}, fake("E: Unable to locate package", 100).deps, "alex"),
    ).rejects.toThrow(InstallFailed);
    await expect(dockerInstall({}, fake("all fine", 0).deps, "alex")).rejects.toThrow(
      InstallFailed,
    );
  });

  it("reports an install that was already there", async () => {
    const r = await tailscaleInstall(
      {},
      fake("Tailscale was already installed.\nHEARTH-OK tailscale 1.90.1").deps,
      "alex",
    );
    expect(r.result).toMatch(/^Tailscale was already installed \(1\.90\.1\)/);
  });
});
