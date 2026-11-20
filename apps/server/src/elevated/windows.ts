import path from "node:path";
import { POWERSHELL_EXE } from "./spaces";

/**
 * The Windows executor's own setup, checked before every request like the Linux one's (root
 * ownership and modes): the program, Node.js, the scope file, the key, and the state folder may
 * be changed only by SYSTEM, Administrators, and TrustedInstaller, and the key may be read only
 * by them and Hearth's own account. Access rules are compared by SID, so it holds in every
 * language Windows is installed in.
 */

const TRUSTED = new Set([
  "S-1-5-18", // SYSTEM
  "S-1-5-32-544", // Administrators
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", // TrustedInstaller
  "S-1-3-0", // CREATOR OWNER (applies to what an owner creates, not to this object)
]);
const BROAD = new Set(["S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-5-4", "S-1-5-7"]);

// FileSystemRights that let someone change the object or its permissions.
const WRITE =
  /FullControl|Modify|Write|AppendData|CreateFiles|CreateDirectories|Delete|ChangePermissions|TakeOwnership|268435456|1073741824/;

export interface AclEntry {
  path: string;
  sid: string;
  rights: string;
  allow: boolean;
  inheritOnly: boolean;
}

/** Every allow rule on each path, by SID (one PowerShell call). */
export const ACL_SCRIPT = (paths: string[]) => `$ErrorActionPreference = 'Stop'
$out = @()
foreach ($p in @(${paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(", ")})) {
  if (-not (Test-Path -LiteralPath $p)) { $out += [pscustomobject]@{ path = $p; missing = $true }; continue }
  foreach ($a in (Get-Acl -LiteralPath $p).Access) {
    $sid = try { $a.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { "$($a.IdentityReference)" }
    $out += [pscustomobject]@{ path = $p; sid = $sid; rights = "$($a.FileSystemRights)"; allow = ("$($a.AccessControlType)" -eq 'Allow'); inheritOnly = ("$($a.PropagationFlags)" -match 'InheritOnly') }
  }
}
ConvertTo-Json -InputObject @($out) -Compress`;

export async function windowsProblems(
  items: { path: string; label: string; readers?: string[] }[],
  run: (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ) => Promise<{ code: number; out: string }>,
): Promise<string[]> {
  const r = await run(
    POWERSHELL_EXE,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      ACL_SCRIPT(items.map((i) => i.path)),
    ],
    { timeoutMs: 60_000 },
  );
  let entries: (AclEntry & { missing?: boolean })[];
  try {
    entries = JSON.parse(r.out.trim() || "[]") as (AclEntry & { missing?: boolean })[];
  } catch {
    return [`The executor could not read its own files' permissions: ${r.out.trim().slice(-200)}`];
  }
  const problems: string[] = [];
  for (const item of items) {
    const mine = entries.filter((e) => path.normalize(e.path) === path.normalize(item.path));
    if (mine.some((e) => e.missing)) {
      problems.push(`${item.label} (${item.path}) is missing.`);
      continue;
    }
    for (const e of mine) {
      if (!e.allow || e.inheritOnly || TRUSTED.has(e.sid)) continue;
      if (WRITE.test(e.rights))
        problems.push(
          `${item.label} (${item.path}) can be changed by ${e.sid}, and the executor runs as SYSTEM.`,
        );
      else if (item.readers && !item.readers.includes(e.sid))
        problems.push(
          `${item.label} (${item.path}) is readable by ${BROAD.has(e.sid) ? "everyone" : e.sid}.`,
        );
    }
  }
  return problems;
}

/**
 * The folders whose permissions decide who could change the program: its own folder and those
 * above it, up to (not including) the drive's root, where Windows lets any account create
 * folders but not change Program Files.
 */
export function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = path.dirname(p);
  while (path.dirname(cur) !== cur) {
    out.push(cur);
    cur = path.dirname(cur);
  }
  return out;
}
