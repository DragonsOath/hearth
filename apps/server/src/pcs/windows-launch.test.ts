import { describe, expect, it } from "vitest";
import { backgroundPowerShell, decodedScript } from "./windows-launch";

describe("backgroundPowerShell", () => {
  it("starts PowerShell through cmd start with the script encoded", () => {
    const script = `Start-Sleep -Seconds 2; gh api x -H "Accept: raw" | Out-String | Invoke-Expression`;
    const plan = backgroundPowerShell(script);
    expect(plan.command).toBe("cmd.exe");
    expect(plan.args).toContain("-EncodedCommand");
    expect(plan.args).not.toContain("-ExecutionPolicy");
    expect(decodedScript(plan.args)).toBe(script);
    expect(backgroundPowerShell("x", { bypass: true }).args).toContain("Bypass");
  });
});
