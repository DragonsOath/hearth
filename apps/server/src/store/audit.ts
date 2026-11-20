import { desc } from "drizzle-orm";
import type { AuditRecord } from "@dragon-control/core";
import type { Database } from "../db/client";
import { auditLog } from "../db/schema";

export async function recordAudit(
  db: Database,
  entry: Omit<AuditRecord, "id" | "at">,
): Promise<void> {
  await db.insert(auditLog).values({ ...entry, detail: entry.detail ?? null });
}

export async function listAudit(db: Database, limit = 20): Promise<AuditRecord[]> {
  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
  return rows.map((r) => ({ ...r, detail: r.detail ?? undefined }));
}
