import fs from "node:fs/promises";
import type { Params } from "./protocol";
import { RaidRefused, type RaidDeps } from "./raid";
import { SNAPRAID_CONFS, snapraidBin } from "./snapraid";

/**
 * storage.read: the few storage reads that need root, with fixed commands and nothing changed.
 * Switched on in the scope file like smart.read; each read is recorded in the log.
 *
 * - snapraid-status, snapraid-diff: SnapRAID's own report (its content files are often root's).
 * - btrfs-stats, btrfs-scrub: a mounted Btrfs filesystem's error counters and last scrub.
 */

const MAX = 1_000_000;

async function isBtrfsMount(deps: RaidDeps, mount: unknown) {
  if (typeof mount !== "string" || !/^\/[\w./ -]{0,200}$/.test(mount) || mount.includes(".."))
    throw new RaidRefused("The mount point is not valid.");
  const r = await deps.run("findmnt", ["-n", "-o", "FSTYPE,TARGET", "--mountpoint", mount], {
    timeoutMs: 15_000,
  });
  if (r.code !== 0 || !/^btrfs\s/.test(r.out.trim()))
    throw new RaidRefused(`${mount} is not a mounted Btrfs filesystem.`);
  return mount;
}

export async function storageRead(
  params: Params,
  deps: RaidDeps,
): Promise<{ target: string; result: string; data: unknown }> {
  const kind = params.kind;
  if (kind === "snapraid-status" || kind === "snapraid-diff") {
    const conf = params.conf;
    if (typeof conf !== "string" || !SNAPRAID_CONFS.includes(conf))
      throw new RaidRefused(
        `SnapRAID's configuration must be one of ${SNAPRAID_CONFS.join(", ")}.`,
      );
    await fs.access(conf).catch(() => {
      throw new RaidRefused(`${conf} is not there.`);
    });
    const bin = await snapraidBin();
    if (!bin) throw new RaidRefused("SnapRAID is not installed.");
    const r = await deps.run(bin, ["-c", conf, kind === "snapraid-status" ? "status" : "diff"], {
      timeoutMs: 600_000,
    });
    return {
      target: conf,
      result: `Read SnapRAID's ${kind === "snapraid-status" ? "status" : "differences"}.`,
      data: { code: r.code, out: r.out.slice(-MAX) },
    };
  }
  if (kind === "btrfs-stats" || kind === "btrfs-scrub") {
    const mount = await isBtrfsMount(deps, params.mount);
    const r = await deps.run(
      "btrfs",
      kind === "btrfs-stats" ? ["device", "stats", mount] : ["scrub", "status", "-R", mount],
      { timeoutMs: 60_000 },
    );
    return {
      target: mount,
      result: `Read Btrfs ${kind === "btrfs-stats" ? "error counters" : "scrub status"} for ${mount}.`,
      data: { code: r.code, out: r.out.slice(-MAX) },
    };
  }
  throw new RaidRefused("Not a storage read the executor knows.");
}
