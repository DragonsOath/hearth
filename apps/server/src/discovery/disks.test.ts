import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromWindows, linuxTemperatures, type RawWindowsDisks } from "./disks";

// Shapes as Get-PhysicalDisk / Get-Partition return them for an unprivileged user.
const unprivileged: RawWindowsDisks = {
  disks: [
    {
      DeviceId: "1",
      FriendlyName: "CT1000P3PSSD8",
      MediaType: "SSD",
      BusType: "NVMe",
      HealthStatus: "Healthy",
      Size: 1_000_204_886_016,
    },
    {
      DeviceId: "2",
      FriendlyName: "JMicron Generic DISK00",
      MediaType: "Unspecified",
      BusType: "USB",
      HealthStatus: "Healthy",
      Size: 22_000_969_973_760,
    },
    {
      DeviceId: "3",
      FriendlyName: "Old Drive",
      MediaType: "HDD",
      BusType: "SATA",
      HealthStatus: "Warning",
      Size: 4e12,
    },
  ],
  // ConvertTo-Json emits a single object, not an array, when there is one item.
  partitions: [
    { DiskNumber: 1, DriveLetter: "C" },
    { DiskNumber: 2, DriveLetter: "F" },
    { DiskNumber: 3, DriveLetter: "G" },
  ],
  reliability: [],
};

describe("fromWindows", () => {
  it("maps drives to letters, types, and health, and explains missing detail", () => {
    const disks = fromWindows(unprivileged, "vault", "2026-10-01T00:00:00Z");
    expect(disks.map((d) => [d.volumes.join(","), d.type, d.bus, d.health])).toEqual([
      ["C:", "ssd", "NVMe", "healthy"],
      ["F:", "unknown", "USB", "healthy"],
      ["G:", "hdd", "SATA", "warning"],
    ]);
    expect(disks[0]!.sizeTb).toBeCloseTo(1.0, 1);
    expect(disks[0]!.temperatureC).toBeUndefined();
    expect(disks[0]!.limitation).toMatch(/elevated access/);
    expect(disks[1]!.limitation).toMatch(/USB enclosure/);
  });

  it("uses reliability counters when the process is elevated", () => {
    const disks = fromWindows(
      {
        ...unprivileged,
        reliability: [
          {
            DeviceId: "1",
            Temperature: 41,
            PowerOnHours: 9412,
            Wear: 3,
            ReadErrorsTotal: 0,
            WriteErrorsTotal: 0,
          },
        ],
      },
      "vault",
      "2026-10-01T00:00:00Z",
    );
    expect(disks[0]).toMatchObject({
      temperatureC: 41,
      powerOnHours: 9412,
      wearPct: 3,
      readErrors: 0,
    });
    expect(disks[0]!.limitation).toBeUndefined();
  });

  it("accepts single objects where PowerShell drops the array", () => {
    const disks = fromWindows(
      {
        disks: unprivileged.disks[0] as unknown as RawWindowsDisks["disks"],
        partitions: unprivileged.partitions[0] as unknown as RawWindowsDisks["partitions"],
        reliability: null as unknown as RawWindowsDisks["reliability"],
      },
      "vault",
      "now",
    );
    expect(disks).toHaveLength(1);
    expect(disks[0]!.volumes).toEqual(["C:"]);
  });
});

// Symlinks need privileges on Windows; this layout only exists on Linux anyway.
describe.skipIf(process.platform === "win32")("Linux drive temperatures", () => {
  it("matches hwmon sensors to drives through their device links", () => {
    const sys = mkdtempSync(path.join(tmpdir(), "dc-sys-"));
    try {
      const dev = (p: string) => {
        mkdirSync(path.join(sys, p), { recursive: true });
        return path.join(sys, p);
      };
      const nvme0 = dev("devices/pci/0000:02:00.0/nvme/nvme0");
      const sata = dev("devices/pci/ata1/host0/0:0:0:0");
      const cpu = dev("devices/pci/0000:00:18.3");
      const sensor = (id: string, name: string, milli: number, device: string) => {
        const d = dev(`class/hwmon/${id}`);
        writeFileSync(path.join(d, "name"), `${name}\n`);
        writeFileSync(path.join(d, "temp1_input"), `${milli}\n`);
        symlinkSync(device, path.join(d, "device"));
      };
      sensor("hwmon2", "nvme", 39850, nvme0);
      sensor("hwmon3", "drivetemp", 31000, sata);
      sensor("hwmon4", "k10temp", 60000, cpu);
      for (const [b, device] of [
        ["nvme0n1", nvme0],
        ["sda", sata],
        ["sdb", dev("devices/usb/jmicron")],
      ] as const) {
        symlinkSync(device, path.join(dev(`block/${b}`), "device"));
      }

      const temps = linuxTemperatures(sys);
      expect(Object.fromEntries(temps)).toEqual({ "/dev/nvme0n1": 40, "/dev/sda": 31 });
    } finally {
      rmSync(sys, { recursive: true, force: true });
    }
  });

  it("returns nothing when sysfs is not there", () => {
    expect(linuxTemperatures(path.join(tmpdir(), "no-such-sys")).size).toBe(0);
  });
});
