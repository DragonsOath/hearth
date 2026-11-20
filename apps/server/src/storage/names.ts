import { execFile } from "node:child_process";
import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";
import { InvalidRequestError } from "../store/errors";

/**
 * Your names for drives ("Film" for /mnt/f), shown everywhere in Storage & Files with the real
 * mount beside them. Keyed by the filesystem's UUID when Linux shares it (lsblk, no root), so a
 * remount at another path or a reordered disk keeps its name; a replaced drive has a new UUID,
 * so it does not inherit an old name by accident. Without a UUID (Windows, network mounts) the
 * mount point is the key. Display only: no mount, filesystem, label, or file is ever changed.
 */
export class VolumeNames {
  private uuidCache: { at: number; map: Map<string, string> } | undefined;

  constructor(
    private readonly handle: DbHandle,
    /** mount -> filesystem UUID (replaced in tests). */
    private readonly readUuids: () => Promise<Map<string, string>> = lsblkUuids,
  ) {}

  private async uuids(): Promise<Map<string, string>> {
    if (this.uuidCache && Date.now() - this.uuidCache.at < 5 * 60_000) return this.uuidCache.map;
    const map = await this.readUuids().catch(() => new Map<string, string>());
    this.uuidCache = { at: Date.now(), map };
    return map;
  }

  private async keyOf(mount: string): Promise<string> {
    const uuid = (await this.uuids()).get(clean(mount));
    return uuid ? `uuid:${uuid}` : `mount:${clean(mount)}`;
  }

  /** Every named mount as it is now: mount -> name. */
  async all(): Promise<Map<string, string>> {
    const rows = await this.handle.db.select().from(t.volumeNames);
    const uuids = await this.uuids();
    const byUuid = new Map([...uuids].map(([m, u]) => [u, m]));
    const out = new Map<string, string>();
    for (const r of rows) {
      if (r.key.startsWith("uuid:")) {
        // Wherever that filesystem is mounted now; if it is not mounted, it has no name to show.
        const now = byUuid.get(r.key.slice(5));
        if (now) out.set(now, r.name);
      } else if (!out.has(r.key.slice(6))) out.set(r.key.slice(6), r.name);
    }
    return out;
  }

  async nameOf(mount: string): Promise<string | undefined> {
    return (await this.all()).get(clean(mount));
  }

  /** Name a drive, or clear its name (null or empty). Audited. */
  async set(mount: string, name: string | null): Promise<{ mount: string; name?: string }> {
    const m = clean(mount);
    const n = (name ?? "").trim();
    if (n && !/^[\p{L}\p{N} ._&'()+-]{1,40}$/u.test(n))
      throw new InvalidRequestError("Use up to 40 letters, numbers, spaces, or . _ & ' ( ) + -.");
    const key = await this.keyOf(m);
    const { db } = this.handle;
    // A drive known by mount before its UUID was readable: move the name to the UUID key.
    await db.delete(t.volumeNames).where(eq(t.volumeNames.key, `mount:${m}`));
    await db.delete(t.volumeNames).where(eq(t.volumeNames.key, key));
    if (n)
      await db
        .insert(t.volumeNames)
        .values({ key, name: n, mount: m, updatedAt: new Date().toISOString() });
    await recordAudit(db, {
      actor: "you",
      action: n ? `Named the drive at ${m} "${n}"` : `Cleared the name of the drive at ${m}`,
      target: `volume:${m}`,
    });
    return { mount: m, ...(n ? { name: n } : {}) };
  }
}

const clean = (m: string) => (m.length > 1 ? m.replace(/[\\/]+$/, "") : m);

/** Mount point -> filesystem UUID, from lsblk (read without root). Linux only. */
export function lsblkUuids(): Promise<Map<string, string>> {
  if (process.platform !== "linux") return Promise.resolve(new Map());
  return new Promise((resolve) =>
    execFile("lsblk", ["-J", "-o", "MOUNTPOINT,UUID"], { timeout: 10_000 }, (error, stdout) => {
      const map = new Map<string, string>();
      if (error) return resolve(map);
      try {
        const walk = (b: {
          mountpoint?: string | null;
          uuid?: string | null;
          children?: unknown[];
        }) => {
          if (b.mountpoint && b.uuid) map.set(clean(b.mountpoint), b.uuid);
          for (const c of (b.children ?? []) as (typeof b)[]) walk(c);
        };
        for (const b of (JSON.parse(stdout) as { blockdevices?: Parameters<typeof walk>[0][] })
          .blockdevices ?? [])
          walk(b);
      } catch {
        // An unreadable answer means no UUIDs: names fall back to mount points.
      }
      resolve(map);
    }),
  );
}
