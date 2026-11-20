import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openNetworkPlan, openToNetwork } from "./network";
import { decodedScript } from "./windows-launch";

describe("open to the home network", () => {
  it("Linux: DC_HOST in hearth.env, then a restart of its own service", () => {
    const plan = openNetworkPlan(
      { kind: "linux-user-service", home: "/home/alex/hearth", service: "hearth" },
      "linux",
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.file).toBe(path.join("/home/alex/hearth", "hearth.env"));
    expect(plan.edit("NODE_ENV=production\nDC_HOST=127.0.0.1\nDC_PORT=7600\n")).toBe(
      "NODE_ENV=production\nDC_HOST=0.0.0.0\nDC_PORT=7600\n",
    );
    expect(plan.edit("DC_PORT=7600")).toBe("DC_PORT=7600\nDC_HOST=0.0.0.0\n");
    expect(plan.restart.args.join(" ")).toContain("systemctl --user restart hearth");
  });

  it("Windows: the control script's DC_HOST, then its restart", () => {
    const plan = openNetworkPlan(
      { kind: "windows-sign-in-task", home: "C:\\Users\\alex\\Hearth", service: "Hearth" },
      "win32",
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edit('$env:DC_PORT = "7600"\n$env:DC_HOST = "127.0.0.1"\n')).toBe(
      '$env:DC_PORT = "7600"\n$env:DC_HOST = "0.0.0.0"\n',
    );
    expect(decodedScript(plan.restart.args)).toContain("restart");
  });

  it("an install made by hand says what to do instead", () => {
    expect(openNetworkPlan(null, "linux")).toMatchObject({ ok: false });
  });

  it("changes the file and starts the restart", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hearth-net-"));
    const platform = process.platform === "win32" ? "windows-sign-in-task" : "linux-user-service";
    const file = path.join(home, platform === "linux-user-service" ? "hearth.env" : "hearth.ps1");
    writeFileSync(
      file,
      platform === "linux-user-service" ? "DC_HOST=127.0.0.1\n" : '$env:DC_HOST = "127.0.0.1"\n',
    );
    const launched: string[] = [];
    const r = openToNetwork({ kind: platform, home, service: "hearth" }, (cmd) =>
      launched.push(cmd),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("0.0.0.0");
    expect(launched).toHaveLength(1);
  });
});
