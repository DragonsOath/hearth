import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { InstallInfo } from "./link";

/** A UTF-8 byte-order mark at the very start of a file. */
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/**
 * How this installation was made. The one-command installers write install.json in Hearth's
 * folder, beside the app (HEARTH_HOME/install.json, with the app in HEARTH_HOME/app); an
 * installation made by hand has none.
 */
export function readInstallInfo(appDir = process.cwd()): InstallInfo | null {
  const file = path.join(path.dirname(path.resolve(appDir)), "install.json");
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(
      // Windows PowerShell 5.1 writes "utf8" with a byte-order mark, which JSON.parse refuses.
      readFileSync(file, "utf8").replace(BOM, ""),
    ) as Partial<InstallInfo>;
    if (j.kind !== "linux-user-service" && j.kind !== "windows-sign-in-task") return null;
    return {
      kind: j.kind,
      ...(typeof j.home === "string" ? { home: j.home } : {}),
      ...(typeof j.service === "string" ? { service: j.service } : {}),
      ...(j.channel === "stable" || j.channel === "fast" ? { channel: j.channel } : {}),
    };
  } catch {
    return null;
  }
}

/** The release this Hearth runs (its RELEASE file, from the installer), if it says. */
export function releaseVersion(appDir = process.cwd()): string | null {
  try {
    return (
      /^version=(.+)$/m.exec(readFileSync(path.join(appDir, "RELEASE"), "utf8"))?.[1]?.trim() ??
      null
    );
  } catch {
    return null;
  }
}
