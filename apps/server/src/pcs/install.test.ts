import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readInstallInfo } from "./install";

describe("readInstallInfo", () => {
  it("reads install.json written by Windows PowerShell, byte-order mark and all", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hearth-install-"));
    const app = path.join(home, "app");
    mkdirSync(app);
    writeFileSync(
      path.join(home, "install.json"),
      `${String.fromCharCode(0xfeff)}${JSON.stringify({ home, service: "Hearth", kind: "windows-sign-in-task" })}`,
    );
    expect(readInstallInfo(app)).toEqual({ kind: "windows-sign-in-task", home, service: "Hearth" });
  });

  it("treats a folder with no install.json as installed by hand", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hearth-install-"));
    expect(readInstallInfo(path.join(home, "app"))).toBeNull();
  });
});
