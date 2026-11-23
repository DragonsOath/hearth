import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InstallInfo } from "./link";
import { backgroundPowerShell } from "./windows-launch";

/**
 * "Open to my home network", from Hearth itself: the one setting the installer asked about
 * (listen on this PC only, or on the home network too), changed in its settings file, then a
 * restart in its own background job so the answer gets back first. Your other PCs and devices
 * need this to reach this Hearth. Sign-in still guards everything, and codes and join links are
 * still refused from the internet.
 */

const SAFE_SERVICE = /^[A-Za-z0-9_-]{1,40}$/;

export function openNetworkPlan(
  info: InstallInfo | null,
  platform = process.platform,
):
  | {
      ok: true;
      file: string;
      edit: (text: string) => string;
      restart: { command: string; args: string[] };
    }
  | { ok: false; message: string } {
  if (!info?.home || info.kind === "manual")
    return {
      ok: false,
      message:
        "Hearth was installed on this PC by hand: set DC_HOST=0.0.0.0 where it is started, and restart it.",
    };
  const service = info.service ?? "hearth";
  if (!SAFE_SERVICE.test(service)) return { ok: false, message: "Its service name is not valid." };
  if (info.kind === "linux-user-service" && platform === "linux") {
    return {
      ok: true,
      file: path.join(info.home, "hearth.env"),
      edit: (text) =>
        /^DC_HOST=.*$/m.test(text)
          ? text.replace(/^DC_HOST=.*$/m, "DC_HOST=0.0.0.0")
          : `${text.replace(/\n?$/, "\n")}DC_HOST=0.0.0.0\n`,
      restart: {
        command: "systemd-run",
        args: [
          "--user",
          "--collect",
          `--unit=hearth-restart-${Date.now()}`,
          "/bin/bash",
          "-c",
          `sleep 2; systemctl --user restart ${service}`,
        ],
      },
    };
  }
  if (info.kind === "windows-sign-in-task" && platform === "win32") {
    const control = path.join(info.home, "hearth.ps1");
    return {
      ok: true,
      file: control,
      edit: (text) => text.replace(/\$env:DC_HOST = "[^"]*"/, '$env:DC_HOST = "0.0.0.0"'),
      restart: backgroundPowerShell(
        `Start-Sleep -Seconds 2; & '${control.replace(/'/g, "''")}' restart`,
        { bypass: true },
      ),
    };
  }
  return { ok: false, message: "Hearth can't change this on this system." };
}

/**
 * Restarts this Hearth in its own background job (a few seconds), as the installer set it up;
 * null where Hearth was started by hand (11-22: the Premium package reloads it this way).
 */
export function restartPlan(
  info: InstallInfo | null,
  platform = process.platform,
): { command: string; args: string[] } | null {
  if (!info?.home || info.kind === "manual") return null;
  const service = info.service ?? "hearth";
  if (!SAFE_SERVICE.test(service)) return null;
  if (info.kind === "linux-user-service" && platform === "linux")
    return {
      command: "systemd-run",
      args: [
        "--user",
        "--collect",
        `--unit=hearth-restart-${Date.now()}`,
        "/bin/bash",
        "-c",
        `sleep 2; systemctl --user restart ${service}`,
      ],
    };
  if (info.kind === "windows-sign-in-task" && platform === "win32") {
    const control = path.join(info.home, "hearth.ps1");
    return backgroundPowerShell(
      `Start-Sleep -Seconds 2; & '${control.replace(/'/g, "''")}' restart`,
      { bypass: true },
    );
  }
  return null;
}

/** Opens this Hearth to the home network and restarts it (a few seconds). */
export function openToNetwork(
  info: InstallInfo | null,
  launch: (command: string, args: string[]) => void = (command, args) =>
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(),
): { ok: boolean; message: string } {
  const plan = openNetworkPlan(info);
  if (!plan.ok) return plan;
  if (!existsSync(plan.file))
    return { ok: false, message: "Hearth could not find its settings file." };
  writeFileSync(plan.file, plan.edit(readFileSync(plan.file, "utf8")));
  launch(plan.restart.command, plan.restart.args);
  return {
    ok: true,
    message:
      "Opening to your home network: Hearth restarts in a few seconds, and this page reconnects by itself.",
  };
}
