import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { open, seal } from "./crypto";

/**
 * Protects the key that automation secrets are encrypted with, so it can
 * be used unattended (at 3am) without being readable from a copy of the
 * database or a backup.
 *
 * - Windows: DPAPI, bound to the Windows account Hearth runs as.
 * - Elsewhere: a key file next to the database, readable only by its owner.
 *   That protects database copies and backups, not someone with full access
 *   to the machine; documented as such.
 */
export interface KeyGuard {
  kind: "dpapi" | "file" | "memory";
  seal(key: Buffer): Promise<string>;
  unseal(sealed: string): Promise<Buffer>;
}

function powershell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 20_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    child.stdin?.end(input);
  });
}

const DPAPI = (op: "Protect" | "Unprotect") =>
  [
    "$in = [Console]::In.ReadToEnd().Trim()",
    "Add-Type -AssemblyName System.Security",
    `$out = [System.Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($in), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Convert]::ToBase64String($out)",
  ].join("; ");

export const dpapiKeyGuard: KeyGuard = {
  kind: "dpapi",
  async seal(key) {
    return powershell(DPAPI("Protect"), key.toString("base64"));
  },
  async unseal(sealed) {
    return Buffer.from(await powershell(DPAPI("Unprotect"), sealed), "base64");
  },
};

export function fileKeyGuard(dataDir: string): KeyGuard {
  const file = path.join(dataDir, "vault.key");
  const fileKey = () => {
    if (!existsSync(file)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        // Not supported on every filesystem; the mode above usually applies.
      }
    }
    return Buffer.from(readFileSync(file, "utf8"), "base64");
  };
  return {
    kind: "file",
    async seal(key) {
      return seal(fileKey(), key, "automation-key");
    },
    async unseal(sealed) {
      return open(fileKey(), sealed, "automation-key");
    },
  };
}

/** Tests only: nothing persists beyond the process. */
export function memoryKeyGuard(): KeyGuard {
  const key = randomBytes(32);
  return {
    kind: "memory",
    async seal(k) {
      return seal(key, k, "automation-key");
    },
    async unseal(sealed) {
      return open(key, sealed, "automation-key");
    },
  };
}

export function defaultKeyGuard(dataDir: string): KeyGuard {
  return process.platform === "win32" ? dpapiKeyGuard : fileKeyGuard(dataDir);
}
