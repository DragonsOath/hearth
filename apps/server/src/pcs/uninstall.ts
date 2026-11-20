import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import type { InstallInfo } from "./link";
import { backgroundPowerShell } from "./windows-launch";

/**
 * Hearth removes itself (Uninstall, from any device: docs/design/ONE_ACCOUNT.md), the way its
 * one-command installer would: its service or sign-in task goes, and its folder too if asked.
 * The work runs in a separate process a few seconds later, so the answer gets back first and
 * stopping Hearth does not stop the uninstall.
 */

const SAFE_SERVICE = /^[A-Za-z0-9_-]{1,40}$/;

/** What would run, or why it can't (for tests and the answer). */
export function uninstallPlan(
  info: InstallInfo | null,
  deleteData: boolean,
  appDir = process.cwd(),
  platform = process.platform,
): { ok: true; command: string; args: string[] } | { ok: false; message: string } {
  if (!info || info.kind === "manual" || !info.home)
    return {
      ok: false,
      message:
        "Hearth was installed on this PC by hand, so it can't remove itself. Run its installer there with --uninstall.",
    };
  const home = path.resolve(info.home);
  // Only the folder Hearth is running from: install.json never points anywhere else.
  if (path.resolve(appDir) !== path.join(home, "app"))
    return { ok: false, message: "Hearth isn't running from the folder it was installed in." };
  const service = info.service ?? "hearth";
  if (!SAFE_SERVICE.test(service)) return { ok: false, message: "Its service name is not valid." };

  if (info.kind === "linux-user-service" && platform === "linux") {
    const unit = path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
      "systemd",
      "user",
      `${service}.service`,
    );
    const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const script = [
      "sleep 3",
      `systemctl --user disable --now ${service}`,
      `rm -f ${q(unit)}`,
      "systemctl --user daemon-reload",
      // Its app menu entry and desktop icon (from the installer).
      `rm -f "\${XDG_DATA_HOME:-$HOME/.local/share}/applications/${service}.desktop" "\${XDG_DATA_HOME:-$HOME/.local/share}/icons/${service}.png" "$(xdg-user-dir DESKTOP 2>/dev/null || echo $HOME/Desktop)/${service}.desktop"`,
      ...(deleteData ? [`rm -rf ${q(home)}`] : []),
    ].join("; ");
    return {
      ok: true,
      command: "systemd-run",
      args: [
        "--user",
        "--collect",
        `--unit=hearth-uninstall-${Date.now()}`,
        "/bin/bash",
        "-c",
        script,
      ],
    };
  }
  if (info.kind === "windows-sign-in-task" && platform === "win32") {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = [
      "Start-Sleep -Seconds 3",
      `Unregister-ScheduledTask -TaskName ${q(service)} -Confirm:$false -ErrorAction SilentlyContinue`,
      // Its Start menu and desktop icons (from the installer).
      `Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'Hearth.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Hearth.lnk') -ErrorAction SilentlyContinue`,
      // Hearth only (not this process, which it started).
      `$p = Join-Path ${q(home)} 'hearth.pid'; if (Test-Path $p) { Stop-Process -Id ([int](Get-Content $p)) -Force -ErrorAction SilentlyContinue }`,
      "Start-Sleep -Seconds 2",
      ...(deleteData ? [`Remove-Item -Recurse -Force ${q(home)}`] : []),
    ].join("; ");
    return { ok: true, ...backgroundPowerShell(script) };
  }
  return {
    ok: false,
    message: "Hearth can't remove itself on this system. Run its installer with --uninstall.",
  };
}

/** Starts the uninstall; Hearth stops a few seconds later. */
export async function selfUninstall(
  info: InstallInfo | null,
  deleteData: boolean,
): Promise<{ ok: boolean; message: string }> {
  const plan = uninstallPlan(info, deleteData);
  if (!plan.ok) return plan;
  const child = spawn(plan.command, plan.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return {
    ok: true,
    message: deleteData
      ? "Hearth is uninstalling and deleting its folder there. It goes offline in a few seconds."
      : "Hearth is uninstalling there (its folder is kept). It goes offline in a few seconds.",
  };
}
