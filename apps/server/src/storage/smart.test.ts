import { describe, expect, it } from "vitest";
import type { Elevation } from "../admin/elevation";
import { SmartReader, drivesOf, parseSmart } from "./smart";

/** SMART in plain words, from the shapes smartctl 7.4 prints with --json. */

const AT = "2026-10-21T12:00:00Z";
const attr = (id: number, name: string, raw: number, over: Record<string, unknown> = {}) => ({
  id,
  name,
  value: 100,
  worst: 100,
  thresh: 10,
  when_failed: "",
  raw: { value: raw, string: String(raw) },
  ...over,
});

const seagate = (table: unknown[], passed = true) => ({
  smartctl: { version: [7, 4], exit_status: 0 },
  model_name: "ST20000NM007D",
  serial_number: "ZVT0ABCD",
  firmware_version: "SN03",
  smart_support: { available: true, enabled: true },
  smart_status: { passed },
  temperature: { current: 38 },
  power_on_time: { hours: 21_345 },
  power_cycle_count: 120,
  ata_smart_attributes: { table },
  ata_smart_self_test_log: {
    standard: {
      table: [
        {
          type: { string: "Short offline" },
          status: { string: "Completed without error", passed: true },
          lifetime_hours: 21_000,
        },
      ],
    },
  },
  hearth: { via: "sat", exitStatus: 0 },
});

describe("parseSmart", () => {
  it("a healthy hard drive behind a USB bridge, with its last self-test", () => {
    const r = parseSmart(
      "/dev/sda",
      seagate([
        attr(5, "Reallocated_Sector_Ct", 0),
        attr(194, "Temperature_Celsius", 0x2600000026),
      ]),
      AT,
    );
    expect(r).toMatchObject({
      verdict: "healthy",
      model: "ST20000NM007D",
      via: "USB (SAT passthrough)",
      temperatureC: 38,
      powerOnHours: 21_345,
      lastSelfTest: { kind: "Short offline", passed: true, atHours: 21_000 },
    });
    // Temperature's raw value packs min and max in the high bytes.
    expect(r.attributes.find((a) => a.id === 194)?.value).toBe(0x26);
    expect(r.reasons).toEqual([]);
  });

  it("pending and reallocated sectors are a warning, with the counts as the reason", () => {
    const r = parseSmart(
      "/dev/sdb",
      seagate([attr(5, "Reallocated_Sector_Ct", 8), attr(197, "Current_Pending_Sector", 16)]),
      AT,
    );
    expect(r.verdict).toBe("warning");
    expect(r.reasons).toEqual(["Reallocated sectors: 8.", "Pending sectors: 16."]);
    expect(r.attributes.every((a) => a.attention)).toBe(true);
  });

  it("the drive's own FAILED, or an attribute past its threshold, is failing", () => {
    expect(parseSmart("/dev/sdc", seagate([], false), AT).verdict).toBe("failing");
    const r = parseSmart(
      "/dev/sdc",
      seagate([attr(5, "Reallocated_Sector_Ct", 900, { value: 5, when_failed: "now" })]),
      AT,
    );
    expect(r.verdict).toBe("failing");
    expect(r.reasons[0]).toMatch(/failure threshold/);
  });

  it("an NVMe drive: rated life, spare, media errors", () => {
    const r = parseSmart(
      "/dev/nvme0n1",
      {
        model_name: "CT2000P3PSSD8",
        smart_status: { passed: true },
        temperature: { current: 41 },
        power_on_time: { hours: 3_000 },
        nvme_smart_health_information_log: {
          critical_warning: 0,
          percentage_used: 3,
          available_spare: 100,
          media_errors: 0,
          unsafe_shutdowns: 12,
        },
      },
      AT,
    );
    expect(r.verdict).toBe("healthy");
    expect(r.attributes.find((a) => a.name.startsWith("Rated life"))?.value).toBe(3);
  });

  it("a USB enclosure that hides SMART says so, without calling the drive bad", () => {
    const r = parseSmart(
      "/dev/sdd",
      {
        smartctl: {
          messages: [{ string: "/dev/sdd: Unknown USB bridge [0x0bc2:0xab38]", severity: "error" }],
        },
      },
      AT,
    );
    expect(r.verdict).toBe("unknown");
    expect(r.unavailable).toMatch(/USB enclosure does not pass SMART through/);
    expect(r.unavailable).toMatch(/may be fine/);
  });

  it("a sleeping drive is left asleep and says so", () => {
    const r = parseSmart(
      "/dev/sde",
      { smartctl: { messages: [{ string: "Device is in STANDBY mode, exit(0)" }] } },
      AT,
    );
    expect(r).toMatchObject({ asleep: true, verdict: "unknown" });
  });
});

describe("drivesOf and SmartReader", () => {
  const layout = [
    {
      name: "sda",
      type: "disk",
      sizeBytes: 1,
      children: [{ name: "sda2", type: "part", sizeBytes: 1, mount: "/mnt/f", children: [] }],
    },
    { name: "loop0", type: "loop", sizeBytes: 1, children: [] },
  ];

  it("lists whole drives with the mounts on them", () => {
    expect(drivesOf(layout)).toEqual([{ device: "/dev/sda", mounts: ["/mnt/f"] }]);
  });

  it("explains how to switch it on, and reads through the executor once it is on", async () => {
    if (process.platform === "win32") return;
    let on = false;
    let reads = 0;
    const elevation = {
      covers: async () =>
        on ? { ok: true } : { ok: false, scope: true, why: "smart.read is switched off." },
      read: async () => {
        reads += 1;
        return { ok: true, outcome: "done", result: "Read.", data: seagate([]) };
      },
    } as unknown as Elevation;
    const reader = new SmartReader(elevation);
    expect((await reader.blocker())?.detail).toMatch(/--add-operation smart.read/);
    expect(await reader.read(layout)).toEqual([]);
    on = true;
    const [r] = await reader.read(layout);
    expect(r).toMatchObject({ device: "/dev/sda", mounts: ["/mnt/f"], verdict: "healthy" });
    await reader.read(layout);
    expect(reads).toBe(1);
    await reader.read(layout, true);
    expect(reads).toBe(2);
  });
});
