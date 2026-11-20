/**
 * Runs a PowerShell script in the background on Windows, so it keeps going after Hearth stops
 * (an update or uninstall stops Hearth part way through).
 *
 * Node's `detached` launch gives the child no console at all, and Windows PowerShell 5.1 then
 * exits at once without running anything (it was why Update now did nothing on Windows). So
 * `cmd start` opens PowerShell in its own minimized console instead, and cmd exits right away,
 * which also keeps PowerShell out of Hearth's process tree (the installer's stop ends that
 * whole tree). The script goes encoded, so cmd never reads its quotes or pipes.
 */
export function backgroundPowerShell(
  script: string,
  opts: { bypass?: boolean } = {},
): { command: string; args: string[] } {
  return {
    command: "cmd.exe",
    args: [
      "/d",
      "/c",
      "start",
      '""',
      "/min",
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      ...(opts.bypass ? ["-ExecutionPolicy", "Bypass"] : []),
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}

/** The script inside a plan made by backgroundPowerShell (for tests and logs). */
export function decodedScript(args: string[]): string {
  const i = args.indexOf("-EncodedCommand");
  return i < 0 ? "" : Buffer.from(args[i + 1] ?? "", "base64").toString("utf16le");
}
