import path from "node:path";
import { describe, expect, it } from "vitest";
import { uninstallPlan } from "./uninstall";
import { decodedScript } from "./windows-launch";

const home = path.resolve("/home/alex/hearth");
const app = path.join(home, "app");

describe("Hearth removes itself", () => {
  it("on Linux: stops and removes its user service, and its folder only when asked", () => {
    const keep = uninstallPlan(
      { kind: "linux-user-service", home, service: "hearth" },
      false,
      app,
      "linux",
    );
    expect(keep).toMatchObject({ ok: true, command: "systemd-run" });
    const script = keep.ok ? keep.args.at(-1)! : "";
    expect(script).toContain("systemctl --user disable --now hearth");
    expect(script).not.toContain("rm -rf");
    const wipe = uninstallPlan(
      { kind: "linux-user-service", home, service: "hearth" },
      true,
      app,
      "linux",
    );
    expect(wipe.ok && wipe.args.at(-1)).toContain(`rm -rf '${home}'`);
  });

  it("on Windows: removes its sign-in task and stops Hearth only", () => {
    const plan = uninstallPlan(
      { kind: "windows-sign-in-task", home, service: "Hearth" },
      true,
      app,
      "win32",
    );
    // Through cmd start: a detached PowerShell has no console and never runs.
    expect(plan).toMatchObject({ ok: true, command: "cmd.exe" });
    const script = plan.ok ? decodedScript(plan.args) : "";
    expect(script).toContain("Unregister-ScheduledTask -TaskName 'Hearth'");
    expect(script).not.toContain("taskkill");
    expect(script).toContain("Remove-Item -Recurse -Force");
  });

  it("refuses an installation made by hand, a folder it isn't running from, or a strange name", () => {
    expect(uninstallPlan(null, true, app, "linux")).toMatchObject({ ok: false });
    expect(
      uninstallPlan(
        { kind: "linux-user-service", home: "/", service: "hearth" },
        true,
        app,
        "linux",
      ),
    ).toMatchObject({ ok: false });
    expect(
      uninstallPlan(
        { kind: "linux-user-service", home, service: "x; rm -rf ~" },
        true,
        app,
        "linux",
      ),
    ).toMatchObject({ ok: false });
  });
});
