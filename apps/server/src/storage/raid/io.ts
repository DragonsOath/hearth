import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

/**
 * What the RAID reader needs from the machine, all readable without root: the kernel's md files
 * under /sys and /proc, lsblk, and statfs. Tests stand in a fixture for it.
 */
export interface RaidIO {
  read(path: string): Promise<string | undefined>;
  list(dir: string): Promise<string[]>;
  readlink(path: string): Promise<string | undefined>;
  /** lsblk -J -b with the columns the reader asks for. */
  lsblk(): Promise<string>;
  /** Total and free bytes of a mounted filesystem. */
  statfs(mount: string): Promise<{ total: number; free: number } | undefined>;
  exists(path: string): Promise<boolean>;
  /**
   * Runs a read-only command (zpool status, snapraid status, PowerShell's Get-StoragePool) and
   * gives its exit code and output. Never a shell: a program and its arguments.
   */
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<RunOut>;
  /** The machine's platform ("linux", "win32"). */
  platform: NodeJS.Platform;
}

export interface RunOut {
  code: number;
  out: string;
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

const runOut = (cmd: string, args: string[], timeoutMs = 20_000) =>
  new Promise<RunOut>((resolve) =>
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 127) : 0,
          out: `${stdout}${error ? stderr : ""}`,
        }),
    ),
  );

export const LSBLK_COLUMNS =
  "NAME,KNAME,PKNAME,TYPE,SIZE,ROTA,TRAN,FSTYPE,MOUNTPOINT,MODEL,SERIAL,PARTTYPENAME,UUID";

export const machineIO: RaidIO = {
  read: (p) => fs.readFile(p, "utf8").catch(() => undefined),
  list: (d) => fs.readdir(d).catch(() => [] as string[]),
  readlink: (p) => fs.readlink(p).catch(() => undefined),
  lsblk: () => run("lsblk", ["-J", "-b", "-o", LSBLK_COLUMNS]),
  async statfs(mount) {
    try {
      const s = await fs.statfs(mount);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      return undefined;
    }
  },
  exists: (p) =>
    fs.access(p).then(
      () => true,
      () => false,
    ),
  run: (cmd, args, opts) => runOut(cmd, args, opts?.timeoutMs),
  platform: process.platform,
};

/**
 * A fixture machine: files by path, lsblk's JSON, and mounts' sizes. Directories are listed from
 * the file paths under them.
 */
export function fixtureIO(fx: {
  files: Record<string, string>;
  links?: Record<string, string>;
  lsblk: unknown;
  statfs?: Record<string, { total: number; free: number }>;
  /** Command output by "cmd arg1 arg2"; a missing command answers code 127. */
  commands?: Record<string, string | RunOut | (() => string | RunOut)>;
  platform?: NodeJS.Platform;
}): RaidIO {
  const all = [...Object.keys(fx.files), ...Object.keys(fx.links ?? {})];
  return {
    read: async (p) => fx.files[p],
    async list(dir) {
      const pre = dir.endsWith("/") ? dir : `${dir}/`;
      return [
        ...new Set(
          all.filter((p) => p.startsWith(pre)).map((p) => p.slice(pre.length).split("/")[0]!),
        ),
      ];
    },
    readlink: async (p) => fx.links?.[p],
    lsblk: async () => JSON.stringify(fx.lsblk),
    statfs: async (m) => fx.statfs?.[m],
    exists: async (p) => all.some((x) => x === p || x.startsWith(`${p}/`)),
    async run(cmd, args) {
      const got = fx.commands?.[[cmd, ...args].join(" ")];
      const v = typeof got === "function" ? got() : got;
      if (v === undefined) return { code: 127, out: `${cmd}: not found` };
      return typeof v === "string" ? { code: 0, out: v } : v;
    },
    platform: fx.platform ?? "linux",
  };
}
