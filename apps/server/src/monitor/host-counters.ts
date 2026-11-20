import { readFile } from "node:fs/promises";

/**
 * The machine Hearth runs on, read from Linux's /proc (read only,
 * no commands). Elsewhere (Windows during development) there is no host
 * history and these return undefined.
 */
export interface HostCounters {
  /** CPU time in clock ticks: busy and total, summed over all cores. */
  cpuBusy: number;
  cpuTotal: number;
  memoryMb: number;
  memoryTotalMb: number;
  load1: number;
  /** Bytes read and written by the physical disks since boot. */
  readBytes: number;
  writeBytes: number;
}

export function parseProcStat(text: string): { busy: number; total: number } | undefined {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return undefined;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal (guest time is already in user).
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, total };
}

export function parseMeminfo(text: string): { usedMb: number; totalMb: number } | undefined {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total === undefined || available === undefined) return undefined;
  return { usedMb: (total - available) / 1024, totalMb: total / 1024 };
}

/** Whole physical disks only: partitions, loop devices, and RAM disks would count twice or not at all. */
const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function parseDiskstats(text: string): { readBytes: number; writeBytes: number } {
  let readBytes = 0;
  let writeBytes = 0;
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !WHOLE_DISK.test(f[2]!)) continue;
    // Sectors are 512 bytes in /proc/diskstats whatever the disk's own sector size.
    readBytes += Number(f[5]) * 512;
    writeBytes += Number(f[9]) * 512;
  }
  return { readBytes, writeBytes };
}

export async function readHostCounters(): Promise<HostCounters | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const [stat, mem, load, disks] = await Promise.all([
      readFile("/proc/stat", "utf8"),
      readFile("/proc/meminfo", "utf8"),
      readFile("/proc/loadavg", "utf8"),
      readFile("/proc/diskstats", "utf8"),
    ]);
    const cpu = parseProcStat(stat);
    const memory = parseMeminfo(mem);
    if (!cpu || !memory) return undefined;
    return {
      cpuBusy: cpu.busy,
      cpuTotal: cpu.total,
      memoryMb: memory.usedMb,
      memoryTotalMb: memory.totalMb,
      load1: Number(load.split(/\s+/)[0]) || 0,
      ...parseDiskstats(disks),
    };
  } catch {
    return undefined;
  }
}
