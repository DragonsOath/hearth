import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import si from "systeminformation";
import type { PhysicalDisk } from "@dragon-control/core";

/**
 * Physical drives and their health, roughly what CrystalDiskInfo shows.
 * Read only. Detail depends on what the operating system shares with an
 * unprivileged process: on Windows, temperature, power-on hours, and wear
 * need elevated access, and USB enclosures often hide the drive itself.
 */

export interface RawWindowsDisks {
  disks: {
    DeviceId: string | number;
    FriendlyName?: string;
    MediaType?: string;
    BusType?: string;
    HealthStatus?: string;
    Size?: number;
  }[];
  partitions: { DiskNumber: number; DriveLetter: string }[];
  reliability: {
    DeviceId: string | number;
    Temperature?: number | null;
    PowerOnHours?: number | null;
    Wear?: number | null;
    ReadErrorsTotal?: number | null;
    WriteErrorsTotal?: number | null;
  }[];
}

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$d = @(Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,MediaType,BusType,HealthStatus,Size)",
  "$p = @(Get-Partition | Where-Object DriveLetter | Select-Object DiskNumber,DriveLetter)",
  "$r = @(Get-PhysicalDisk | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue | Select-Object DeviceId,Temperature,PowerOnHours,Wear,ReadErrorsTotal,WriteErrorsTotal)",
  "@{ disks = $d; partitions = $p; reliability = $r } | ConvertTo-Json -Depth 4 -Compress",
].join("; ");

const asArray = <T>(value: T | T[] | null | undefined): T[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

const num = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Pure conversion, unit tested with captured shapes. */
export function fromWindows(
  raw: RawWindowsDisks,
  hostId: string,
  checkedAt: string,
): PhysicalDisk[] {
  const reliability = asArray(raw.reliability);
  const partitions = asArray(raw.partitions);
  return asArray(raw.disks)
    .map((d) => {
      const id = String(d.DeviceId);
      const r = reliability.find((x) => String(x.DeviceId) === id);
      const media = (d.MediaType ?? "").toUpperCase();
      const bus = d.BusType ?? "Unknown";
      const status = (d.HealthStatus ?? "").toLowerCase();
      const type: PhysicalDisk["type"] =
        media === "SSD" ? "ssd" : media === "HDD" ? "hdd" : "unknown";
      const temperatureC = num(r?.Temperature);
      const limitations: string[] = [];
      if (!r) limitations.push("Temperature, power-on hours, and wear need elevated access.");
      if (bus.toUpperCase() === "USB" && type === "unknown") {
        limitations.push("It sits behind a USB enclosure that hides the drive's own details.");
      }
      return {
        id: `${hostId}-disk-${id}`,
        hostId,
        model: (d.FriendlyName ?? "Unknown drive").trim(),
        type,
        bus,
        sizeTb: (d.Size ?? 0) / 1e12,
        health:
          status === "healthy"
            ? "healthy"
            : status === "warning"
              ? "warning"
              : status === "unhealthy"
                ? "failing"
                : "unknown",
        temperatureC: temperatureC && temperatureC > 0 ? temperatureC : undefined,
        powerOnHours: num(r?.PowerOnHours),
        wearPct: num(r?.Wear),
        readErrors: num(r?.ReadErrorsTotal),
        writeErrors: num(r?.WriteErrorsTotal),
        volumes: partitions
          .filter((p) => String(p.DiskNumber) === id && p.DriveLetter)
          .map((p) => `${p.DriveLetter}:`)
          .sort(),
        checkedAt,
        limitation: limitations.join(" ") || undefined,
      } satisfies PhysicalDisk;
    })
    .sort((a, b) => (a.volumes[0] ?? "~").localeCompare(b.volumes[0] ?? "~"));
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

export async function readDisks(hostId: string): Promise<PhysicalDisk[]> {
  const checkedAt = new Date().toISOString();
  if (process.platform === "win32") {
    const out = await runPowerShell(WINDOWS_SCRIPT);
    return fromWindows(JSON.parse(out) as RawWindowsDisks, hostId, checkedAt);
  }
  // Elsewhere: what systeminformation can see without root. SMART detail needs smartctl.
  const [layout, blocks] = await Promise.all([si.diskLayout(), si.blockDevices()]);
  const temps = process.platform === "linux" ? linuxTemperatures() : new Map<string, number>();
  return layout.map((d, i) => {
    const type: PhysicalDisk["type"] = /ssd|nvme/i.test(`${d.type} ${d.interfaceType}`)
      ? "ssd"
      : /hd/i.test(d.type)
        ? "hdd"
        : "unknown";
    const smart = d.smartStatus?.toLowerCase();
    return {
      id: `${hostId}-disk-${i}`,
      hostId,
      model: [d.vendor, d.name].filter(Boolean).join(" ").trim() || "Unknown drive",
      type,
      bus: d.interfaceType || "Unknown",
      sizeTb: d.size / 1e12,
      health: smart === "ok" ? "healthy" : smart === "predicted failure" ? "failing" : "unknown",
      temperatureC: d.temperature ?? temps.get(d.device) ?? undefined,
      volumes: blocks
        .filter((b) => b.mount && d.device && b.name.startsWith(d.device.replace("/dev/", "")))
        .map((b) => b.mount),
      checkedAt,
      limitation:
        (d.temperature ?? temps.get(d.device)) == null
          ? "Temperature and wear need smartmontools."
          : "Wear and power-on hours need smartmontools.",
    } satisfies PhysicalDisk;
  });
}

/**
 * Linux shares drive temperatures without root through hwmon: NVMe drives
 * always, SATA drives when the drivetemp module is loaded. Each sensor's
 * device link is matched to the drive's own device link. Returns
 * "/dev/nvme0n1" -> degrees C. USB enclosures usually report nothing.
 */
export function linuxTemperatures(sys = "/sys"): Map<string, number> {
  const out = new Map<string, number>();
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const sensors = new Map<string, number>();
  const list = (dir: string) => {
    try {
      return readdirSync(path.join(sys, dir));
    } catch {
      return [];
    }
  };
  const hwmons = list("class/hwmon");
  for (const h of hwmons) {
    const dir = path.join(sys, "class/hwmon", h);
    try {
      const name = readFileSync(path.join(dir, "name"), "utf8").trim();
      if (name !== "nvme" && name !== "drivetemp") continue;
      const milli = Number(readFileSync(path.join(dir, "temp1_input"), "utf8").trim());
      const device = real(path.join(dir, "device"));
      if (device && Number.isFinite(milli)) sensors.set(device, Math.round(milli / 1000));
    } catch {
      // A sensor that cannot be read is simply left out.
    }
  }
  for (const b of list("block")) {
    const device = real(path.join(sys, "block", b, "device"));
    const temp = device ? sensors.get(device) : undefined;
    if (temp !== undefined) out.set(`/dev/${b}`, temp);
  }
  return out;
}
