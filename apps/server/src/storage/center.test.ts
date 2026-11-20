import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fstypesOf, parseLsblk, parseMdstat, recentFiles } from "./center";

/** Storage & Files: the readers and the journey rules, from captured shapes. */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe("parseLsblk", () => {
  it("reads Homeserver's shape: USB hard drives with NTFS, NVMe with ext4; loops left out", () => {
    const nodes = parseLsblk(
      JSON.stringify({
        blockdevices: [
          { name: "loop0", type: "loop", size: 1000, rota: false, mountpoint: "/snap/x" },
          {
            name: "sda",
            type: "disk",
            size: 20000588955648,
            rota: true,
            tran: "usb",
            model: "ST22000NT001-3LS101 ",
            children: [
              { name: "sda1", type: "part", size: 16777216, rota: true },
              {
                name: "sda2",
                type: "part",
                size: 20000569999360,
                rota: true,
                fstype: "ntfs",
                mountpoint: "/mnt/f",
              },
            ],
          },
          {
            name: "nvme0n1",
            type: "disk",
            size: 1000204886016,
            rota: "0",
            tran: "nvme",
            model: "CT1000P3PSSD8",
            children: [
              { name: "nvme0n1p2", type: "part", size: 999, fstype: "ext4", mountpoints: ["/"] },
            ],
          },
        ],
      }),
    );
    expect(nodes.map((n) => n.name)).toEqual(["sda", "nvme0n1"]);
    expect(nodes[0]).toMatchObject({
      rotational: true,
      transport: "usb",
      model: "ST22000NT001-3LS101",
    });
    expect(nodes[0]!.children[1]).toMatchObject({ fstype: "ntfs", mount: "/mnt/f" });
    expect(nodes[1]).toMatchObject({ rotational: false });
    expect(nodes[1]!.children[0]!.mount).toBe("/");
    expect(fstypesOf(nodes)).toEqual(["ntfs", "ext4"]);
  });
});

describe("parseMdstat", () => {
  it("reads a healthy mirror, a degraded one with its recovery, and no arrays", () => {
    const text = [
      "Personalities : [raid1] [raid6]",
      "md0 : active raid1 sdb1[1] sda1[0]",
      "      976630464 blocks super 1.2 [2/2] [UU]",
      "",
      "md1 : active raid6 sdc1[0] sdd1[1] sde1[2] sdf1[3](F)",
      "      5860270080 blocks super 1.2 level 6, 512k chunk [4/3] [UUU_]",
      "      [==>..................]  recovery = 12.6% (123/456) finish=80.1min",
      "",
      "unused devices: <none>",
    ].join("\n");
    const a = parseMdstat(text);
    expect(a.map((x) => [x.name, x.state])).toEqual([
      ["md0", "active"],
      ["md1", "degraded"],
    ]);
    expect(a[1]!.detail).toMatch(/raid6.*\[UUU_\].*recovery = 12\.6%/);
    expect(parseMdstat("Personalities : \nunused devices: <none>\n")).toEqual([]);
  });
});

describe("recentFiles", () => {
  it("lists files changed lately, flags partial downloads, skips old ones, and stays bounded", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dc-recent-"));
    dirs.push(root);
    await fs.mkdir(path.join(root, "completed", "Dune"), { recursive: true });
    await fs.writeFile(path.join(root, "completed", "Dune", "Dune.mkv"), "x");
    await fs.writeFile(path.join(root, "Movie.mkv.!qB"), "partial");
    await fs.writeFile(path.join(root, "old.mkv"), "old");
    const old = new Date("2020-01-01");
    await fs.utimes(path.join(root, "old.mkv"), old, old);
    const r = await recentFiles([{ id: "dl", label: "Downloads", path: root }], {
      sinceMs: 3_600_000,
    });
    expect(r.complete).toBe(true);
    expect(r.files.map((f) => f.path).sort()).toEqual(["Movie.mkv.!qB", "completed/Dune/Dune.mkv"]);
    expect(r.files.find((f) => f.name === "Movie.mkv.!qB")!.incomplete).toBe(true);
    expect(r.files.find((f) => f.name === "Dune.mkv")).toMatchObject({
      folder: "completed/Dune",
      locationId: "dl",
    });
    const capped = await recentFiles([{ id: "dl", label: "Downloads", path: root }], {
      sinceMs: 3_600_000,
      maxEntries: 1,
    });
    expect(capped.complete).toBe(false);
    const shallow = await recentFiles([{ id: "dl", label: "Downloads", path: root }], {
      sinceMs: 3_600_000,
      maxDepth: 0,
    });
    expect(shallow.files.map((f) => f.name)).toEqual(["Movie.mkv.!qB"]);
  });
});
