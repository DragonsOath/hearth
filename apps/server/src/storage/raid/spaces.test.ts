import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../../config";
import { openDatabase, runMigrations, type DbHandle } from "../../db/client";
import type { StepRun } from "../../jobs/operations";
import { spacesCreate, spacesMember } from "../../elevated/spaces";
import type { RaidDeps } from "../../elevated/raid";
import { SampleRaid } from "./sample";
import { RaidService } from "./service";
import { candidatesFrom, poolsToArrays, spacesActions } from "./spaces";

// What Get-StoragePool and friends answer (READ_SCRIPT), for a parity space being repaired.
const READ = {
  pools: [
    {
      name: "Vault",
      id: "{abc}",
      health: "Warning",
      op: ["Degraded"],
      size: 24e12,
      alloc: 18e12,
      disks: [
        {
          name: "ST8000VN004",
          serial: "ZA1",
          id: "u1",
          number: "1",
          size: 8e12,
          alloc: 6e12,
          media: "HDD",
          bus: "SATA",
          health: "Healthy",
          op: ["OK"],
          usage: "Auto-Select",
        },
        {
          name: "ST8000VN004",
          serial: "ZA2",
          id: "u2",
          number: "2",
          size: 8e12,
          alloc: 6e12,
          media: "HDD",
          bus: "SATA",
          health: "Healthy",
          op: ["OK"],
          usage: "Auto-Select",
        },
        {
          name: "ST8000VN004",
          serial: "ZA3",
          id: "u3",
          number: "",
          size: 8e12,
          alloc: 6e12,
          media: "HDD",
          bus: "SATA",
          health: "Warning",
          op: ["Lost Communication"],
          usage: "Auto-Select",
        },
      ],
      vdisks: [
        {
          name: "Media",
          id: "v1",
          resiliency: "Parity",
          copies: 1,
          redundancy: 1,
          columns: 3,
          health: "Warning",
          op: ["InService"],
          size: 14e12,
          footprint: 18e12,
          provisioning: "Fixed",
          letter: "D",
          fs: "NTFS",
          volSize: 14e12,
          free: 4e12,
        },
      ],
    },
  ],
  jobs: [{ name: "Media-Repair", state: "Running", pct: 37 }],
};

describe("reading Storage Spaces", () => {
  it("reads a parity space being repaired after a drive stopped answering", () => {
    const [a] = poolsToArrays(READ);
    expect(a).toMatchObject({
      id: "spaces:{abc}",
      tech: "storage-spaces",
      name: "Vault",
      level: "spaces-parity",
      levelText: "Parity, 3 drives",
      health: "rebuilding",
      canLose: 0,
      mount: "D:",
      fstype: "ntfs",
      sizeBytes: 14e12,
      usedBytes: 10e12,
      sync: { action: "recover", progressPct: 37 },
    });
    expect(a!.members.map((m) => [m.device, m.role])).toEqual([
      ["\\\\.\\PHYSICALDRIVE1", "active"],
      ["\\\\.\\PHYSICALDRIVE2", "active"],
      ["disk:u3", "missing"],
    ]);
    expect(a!.warnings.join(" ")).toMatch(/ZA3\) is not answering/);
    expect(a!.groups?.[0]).toMatchObject({ name: "Media (D:)", level: "spaces-parity" });
  });

  it("reads a status Windows sent as one word instead of a list (found on a real machine)", () => {
    const [a] = poolsToArrays({
      pools: [
        {
          name: "One",
          id: "{one}",
          health: "Healthy",
          op: "OK" as unknown as string[],
          size: 12e9,
          alloc: 6e9,
          disks: [
            {
              name: "Msft Virtual Disk",
              id: "d1",
              number: "2",
              size: 6e9,
              health: "Healthy",
              op: "OK" as unknown as string[],
              usage: "Auto-Select",
            },
          ],
          vdisks: [
            {
              name: "One",
              id: "v1",
              resiliency: "Mirror",
              copies: 2,
              redundancy: 1,
              health: "Healthy",
              op: "OK" as unknown as string[],
              size: 3e9,
              letter: "E",
              fs: "NTFS",
            },
          ],
        },
      ],
    });
    expect(a).toMatchObject({ health: "healthy", mount: "E:" });
    expect(a!.members[0]!.role).toBe("active");
  });

  it("offers only drives Windows can pool, never the Windows drive or one in use", () => {
    const c = candidatesFrom([
      {
        number: "0",
        name: "NVMe",
        system: true,
        canPool: false,
        why: ["Insufficient Capacity"],
        parts: [{ letter: "C", size: 1e12, fs: "NTFS" }],
      },
      { number: "1", name: "Blank", serial: "B1", canPool: true, why: [], parts: [] },
      {
        number: "2",
        name: "Old",
        serial: "O2",
        canPool: false,
        why: ["Insufficient Capacity"],
        parts: [{ letter: null, size: 2e12, fs: "NTFS", label: "Old" }],
      },
      {
        number: "3",
        name: "Plex Meta",
        serial: "M3",
        canPool: false,
        why: ["Insufficient Capacity"],
        parts: [{ letter: "M", size: 2e12, fs: "NTFS", label: "Plex Meta" }],
      },
      { number: "4", name: "Pooled", canPool: false, why: ["In a Pool"], parts: [] },
    ]);
    expect(c.map((x) => [x.device, x.state])).toEqual([
      ["\\\\.\\PHYSICALDRIVE0", "excluded"],
      ["\\\\.\\PHYSICALDRIVE1", "usable"],
      ["\\\\.\\PHYSICALDRIVE2", "has-data"],
      ["\\\\.\\PHYSICALDRIVE3", "excluded"],
      ["\\\\.\\PHYSICALDRIVE4", "excluded"],
    ]);
    expect(c[0]!.reason).toMatch(/Holds Windows/);
    expect(c[3]!.reason).toMatch(/In use as M: \(Plex Meta, NTFS\)/);
  });

  it("decides what can be done on a degraded mirror", () => {
    const [a] = poolsToArrays({
      pools: [
        {
          ...READ.pools[0]!,
          vdisks: [
            { ...READ.pools[0]!.vdisks[0]!, resiliency: "Mirror", copies: 2, op: ["Degraded"] },
          ],
        },
      ],
      jobs: [],
    });
    const free = [
      {
        device: "\\\\.\\PHYSICALDRIVE9",
        kind: "disk" as const,
        state: "usable" as const,
        sizeBytes: 8e12,
      },
    ];
    const by = Object.fromEntries(
      spacesActions(a!, { candidates: free, ready: { ready: true } }).map((x) => [x.id, x]),
    );
    expect(a!.health).toBe("degraded");
    expect(by.replace!.status).toBe("available");
    expect(by.repair!.status).toBe("available");
    expect(by["mark-failed"]!.status).toBe("blocked");
    expect(by.remove!.status).toBe("available");
    expect(by.check!.status).toBe("unsupported");
    expect(by["change-level"]!.status).toBe("unsupported");
  });
});

/* ---------- the simulated Windows machine, through plans ---------- */

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  const sample = new SampleRaid({ runMs: 60_000, windows: true });
  return { raid: new RaidService(handle, { sample, hostName: () => "Winbox" }) };
}
const approved = (params: Record<string, string | number | boolean>): StepRun => ({
  kind: "storage-raid",
  serviceId: "this-host",
  requestedBy: "you",
  params,
  job: { id: "job-1", seq: 1, approvedAt: new Date().toISOString() },
});

describe("Storage Spaces through plans", () => {
  it("shows the degraded pool and its drives, and no Linux technologies", async () => {
    const { raid } = await setup();
    const r = await raid.report(true);
    expect(r.platform).toBe("windows");
    expect(r.arrays.map((a) => [a.name, a.health])).toEqual([
      ["MediaPool", "degraded"],
      ["SnapRAID", "healthy"],
    ]);
    expect(r.tech.map((t) => t.tech)).toEqual([
      "storage-spaces",
      "snapraid",
      "drivepool",
      "hardware",
    ]);
    expect(r.tech.find((t) => t.tech === "drivepool")?.support).toBe("detect");
    expect(r.create?.map((c) => c.tech)).toEqual(["storage-spaces"]);
    expect(r.candidates.find((c) => c.serial === "WXK2A1EXTERNAL")?.state).toBe("excluded");
    expect(r.candidates.find((c) => c.serial === "ZDHNEWSPACE")?.state).toBe("usable");
  });

  it("replaces the drive that stopped answering, then removes it once repaired", async () => {
    const { raid } = await setup();
    const lost = (await raid.report(true)).arrays[0]!.members.find((m) => m.role === "missing")!;
    expect(lost.device).toBe("disk:60014055WD-WX12D80CCCCC");
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: {
        action: "replace",
        arrayId: "spaces:{pool-media}",
        replaces: lost.device!,
        device: "\\\\.\\PHYSICALDRIVE5",
      },
    });
    expect(p.policy, p.policyReason).toBe("approve-first");
    expect(p.label).toMatch(/Replace .*WD-WX12D80CCCCC.* with .*ZDHNEWSPACE.* in pool MediaPool/);
    expect((await raid.run(approved(p.params!))).ok).toBe(true);
    const a = (await raid.report(true)).arrays[0]!;
    expect(a.health).toBe("rebuilding");
    expect(a.members.find((m) => m.serial === "ZDHNEWSPACE")?.role).toBe("active");
  });

  it("refuses a drive that holds data unless erasing it was approved", async () => {
    const { raid } = await setup();
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: {
        action: "grow-devices",
        arrayId: "spaces:{pool-media}",
        device: "\\\\.\\PHYSICALDRIVE6",
      },
    });
    expect(p.policy).toBe("refuse");
    expect(p.policyReason).toMatch(/holds data/);
  });

  it("plans a new mirrored pool with an NTFS volume", async () => {
    const { raid } = await setup();
    const p = await raid.plan({
      kind: "storage-raid",
      serviceId: "this-host",
      params: {
        action: "create",
        tech: "storage-spaces",
        level: "spaces-mirror",
        name: "Photos",
        fs: "ntfs",
        devices: "\\\\.\\PHYSICALDRIVE5,\\\\.\\PHYSICALDRIVE6",
        eraseDevices: "\\\\.\\PHYSICALDRIVE6",
      },
    });
    expect(p.policy, p.policyReason).toBe("approve-first");
    expect(p.label).toMatch(
      /Create a Storage Spaces pool "Photos" with a two-way mirror space and an NTFS volume/,
    );
    expect(p.policyReason).toMatch(/ERASES EVERYTHING/);
    expect((await raid.run(approved(p.params!))).ok).toBe(true);
    expect((await raid.report(true)).arrays.some((a) => a.name === "Photos")).toBe(true);
  });
});

/* ---------- the Windows executor's checks, before PowerShell ---------- */

describe("the Windows executor's Storage Spaces checks", () => {
  const ran: string[][] = [];
  const deps: RaidDeps = {
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      return { code: 0, out: '{"ok":true,"outcome":"done","result":"Done."}' };
    },
    wait: async () => undefined,
  };
  it("takes only drive numbers, pool ids, and serials in their strict shapes", async () => {
    await expect(
      spacesMember(
        { pool: "x'; Remove-Item C:\\", action: "add", disk: "\\\\.\\PHYSICALDRIVE1" },
        deps,
      ),
    ).rejects.toThrow(/pool's id is not valid/);
    await expect(
      spacesMember({ pool: "{abc}", action: "add", disk: "C:\\" }, deps),
    ).rejects.toThrow(/PHYSICALDRIVE/);
    await expect(
      spacesMember(
        { pool: "{abc}", action: "add", disk: "\\\\.\\PHYSICALDRIVE1", serial: "a'b" },
        deps,
      ),
    ).rejects.toThrow(/serial number is not valid/);
    await expect(
      spacesCreate(
        {
          name: "Media",
          level: "spaces-mirror",
          disks: [{ disk: "\\\\.\\PHYSICALDRIVE1" }, { disk: "\\\\.\\PHYSICALDRIVE1" }],
        },
        deps,
      ),
    ).rejects.toThrow(/listed twice/);
    await expect(spacesCreate({ name: "Media", level: "raid5", disks: [] }, deps)).rejects.toThrow(
      /layout is not valid/,
    );
  });

  it("checks the drive in Windows itself before adding it, and passes refusals on", async () => {
    const r = await spacesMember(
      { pool: "{abc}", action: "add", disk: "\\\\.\\PHYSICALDRIVE4", serial: "ZA9" },
      deps,
    );
    expect(r.result).toBe("Done.");
    const script = ran.at(-1)!.at(-1)!;
    expect(script).toMatch(/NewDrive 4 'ZA9' \$false/);
    expect(script).toMatch(/IsSystem -or \$disk\.IsBoot/);
    const refusing: RaidDeps = {
      ...deps,
      run: async () => ({
        code: 0,
        out: '{"ok":false,"outcome":"refused","result":"Drive 4 holds Windows. Never used."}',
      }),
    };
    await expect(
      spacesMember({ pool: "{abc}", action: "add", disk: "\\\\.\\PHYSICALDRIVE4" }, refusing),
    ).rejects.toThrow(/holds Windows/);
  });
});
