import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Whether a folder is on the same physical disk as the operating system: a blueprint kept there
 * dies with that disk. Linux: the disk behind each one's mount, from the kernel's own tables.
 * Windows: the disk number behind each drive letter. A network share or cloud mount never matches.
 * undefined when it can't be told (the page then says nothing rather than guess).
 */

const NETWORK_FS = /^(nfs4?|cifs|smb3?|fuse\.(sshfs|rclone|s3fs|gcsfuse)|9p|davfs)$/;

interface MountLine {
  device: string;
  mountPoint: string;
  fsType: string;
}

/** /proc/self/mountinfo lines as device (major:minor), mount point and filesystem type. */
export function parseMountinfo(text: string): MountLine[] {
  const out: MountLine[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split(" ");
    const dash = parts.indexOf("-");
    if (parts.length < 10 || dash < 6) continue;
    out.push({
      device: parts[2]!,
      mountPoint: parts[4]!.replace(/\\040/g, " "),
      fsType: parts[dash + 1]!,
    });
  }
  return out;
}

/** The mount a path lives on: the longest mount point that contains it. */
export function mountOf(mounts: MountLine[], file: string): MountLine | undefined {
  let best: MountLine | undefined;
  for (const m of mounts) {
    const mp = m.mountPoint === "/" ? "/" : `${m.mountPoint}/`;
    if (
      (file === m.mountPoint || file.startsWith(mp)) &&
      (!best || m.mountPoint.length > best.mountPoint.length)
    )
      best = m;
  }
  return best;
}

/** The whole disk behind a block device: sda for sda1, nvme0n1 for nvme0n1p2. */
async function diskOf(device: string, sys = "/sys/dev/block"): Promise<string | undefined> {
  const real = await fs.realpath(path.join(sys, device)).catch(() => undefined);
  if (!real) return undefined;
  const isPartition = await fs.stat(path.join(real, "partition")).then(
    () => true,
    () => false,
  );
  return path.basename(isPartition ? path.dirname(real) : real);
}

async function linux(dest: string): Promise<boolean | undefined> {
  const text = await fs.readFile("/proc/self/mountinfo", "utf8").catch(() => undefined);
  if (!text) return undefined;
  const mounts = parseMountinfo(text);
  const real = await fs.realpath(dest).catch(() => dest);
  const there = mountOf(mounts, real);
  const root = mountOf(mounts, "/");
  if (!there || !root) return undefined;
  if (NETWORK_FS.test(there.fsType)) return false;
  if (there.device === root.device) return true;
  const [a, b] = await Promise.all([diskOf(there.device), diskOf(root.device)]);
  return a && b ? a === b : undefined;
}

function diskNumber(letter: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Partition -DriveLetter ${letter}).DiskNumber`],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        const n = Number(String(stdout).trim());
        resolve(err || !Number.isInteger(n) ? undefined : n);
      },
    );
  });
}

async function windows(dest: string): Promise<boolean | undefined> {
  if (/^\\\\/.test(dest)) return false; // a network share
  const letter = /^([A-Za-z]):/.exec(dest)?.[1]?.toUpperCase();
  const system = /^([A-Za-z]):/.exec(process.env.SystemDrive ?? "C:")?.[1]?.toUpperCase();
  if (!letter || !system) return undefined;
  if (letter === system) return true;
  const [a, b] = await Promise.all([diskNumber(letter), diskNumber(system)]);
  return a !== undefined && b !== undefined ? a === b : undefined;
}

export function sameDiskAsSystem(dest: string): Promise<boolean | undefined> {
  return process.platform === "win32" ? windows(dest) : linux(dest);
}
