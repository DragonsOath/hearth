import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { appMeta } from "./schema";

export interface InstallIdentity {
  installId: string;
  firstStartedAt: string;
}

async function getMeta(db: Database, key: string): Promise<string | null> {
  const row = await db.select().from(appMeta).where(eq(appMeta.key, key)).get();
  return row?.value ?? null;
}

/** Created on first start and stable across restarts; proves persistence works. */
export async function ensureInstallIdentity(db: Database): Promise<InstallIdentity> {
  const existingId = await getMeta(db, "install_id");
  const existingStart = await getMeta(db, "first_started_at");
  if (existingId && existingStart) return { installId: existingId, firstStartedAt: existingStart };

  const identity = { installId: randomUUID(), firstStartedAt: new Date().toISOString() };
  await db
    .insert(appMeta)
    .values([
      { key: "install_id", value: identity.installId },
      { key: "first_started_at", value: identity.firstStartedAt },
    ])
    .onConflictDoNothing();
  return identity;
}

export async function readInstallIdentity(db: Database): Promise<InstallIdentity | null> {
  const installId = await getMeta(db, "install_id");
  const firstStartedAt = await getMeta(db, "first_started_at");
  return installId && firstStartedAt ? { installId, firstStartedAt } : null;
}
