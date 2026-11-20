import { eq } from "drizzle-orm";
import type { PhysicalDisk } from "@dragon-control/core";
import type { Database } from "../db/client";
import * as t from "../db/schema";

type DiskRow = typeof t.disks.$inferSelect;

const orUndefined = <T>(v: T | null): T | undefined => v ?? undefined;

export function toDisk(row: DiskRow): PhysicalDisk {
  return {
    id: row.id,
    hostId: row.hostId,
    model: row.model,
    type: row.type,
    bus: row.bus,
    sizeTb: row.sizeTb,
    health: row.health,
    temperatureC: orUndefined(row.temperatureC),
    powerOnHours: orUndefined(row.powerOnHours),
    wearPct: orUndefined(row.wearPct),
    readErrors: orUndefined(row.readErrors),
    writeErrors: orUndefined(row.writeErrors),
    volumes: row.volumes,
    checkedAt: row.checkedAt,
    limitation: orUndefined(row.limitation),
  };
}

/** Replace one host's drives with a fresh reading. Callers provide the transaction. */
export async function saveDisks(
  db: Database,
  hostId: string,
  disks: PhysicalDisk[],
): Promise<void> {
  await db.delete(t.disks).where(eq(t.disks.hostId, hostId));
  if (!disks.length) return;
  await db.insert(t.disks).values(
    disks.map((d) => ({
      ...d,
      temperatureC: d.temperatureC ?? null,
      powerOnHours: d.powerOnHours ?? null,
      wearPct: d.wearPct ?? null,
      readErrors: d.readErrors ?? null,
      writeErrors: d.writeErrors ?? null,
      limitation: d.limitation ?? null,
    })),
  );
}
