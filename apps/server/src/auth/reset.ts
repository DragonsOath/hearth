import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { recordAudit } from "../store/audit";

/**
 * Returns the installation to "not set up": removes the owner, passkeys,
 * sessions, and the vault (its keys go with the owner, so its secrets
 * could never be opened again). Monitoring data, settings, and history
 * are kept. Only reachable from the machine itself (the reset-owner
 * command), never over the network.
 */
export async function resetOwner(handle: DbHandle): Promise<{ secretsRemoved: number }> {
  const { db } = handle;
  let secretsRemoved = 0;
  await withTransaction(handle, async () => {
    secretsRemoved = (await db.select().from(t.vaultSecrets)).length;
    await db.delete(t.vaultSecrets);
    await db.delete(t.vaultKeys);
    await db.delete(t.passkeys);
    await db.delete(t.sessions);
    await db.delete(t.owner);
    await recordAudit(db, {
      actor: "you",
      action: "Reset the owner from this machine",
      target: "security",
      detail: { secretsRemoved },
    });
  });
  return { secretsRemoved };
}
