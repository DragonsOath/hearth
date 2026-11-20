import { eq } from "drizzle-orm";
import {
  aiDisplayName,
  buildGettingStarted,
  type CredentialStatus,
  type GettingStarted,
  type GettingStartedChoices,
  type KeyNeed,
} from "@dragon-control/core";
import type { Database } from "../db/client";
import * as t from "../db/schema";
import { InvalidRequestError } from "./errors";
import { getSetting, setSetting } from "./settings";

/**
 * Getting started, from the installation's real state: what is adopted, which adopted apps still
 * need a key in Secure Vault, notifications, a backup copy, voice, the AI operator, and whether
 * the owner has met the AI. Nothing here comes from the AI.
 */
export async function loadGettingStarted(
  db: Database,
  opts: {
    backupCopy: boolean;
    /** The credential broker's status per watched app (CredentialBroker.status): never values. */
    credentials: CredentialStatus[];
  },
): Promise<GettingStarted> {
  const real = (await getSetting(db, "environment")) === "real";
  const watched = real
    ? await db.select().from(t.services).where(eq(t.services.lifecycle, "active"))
    : [];
  // Sample data has nothing of yours to add keys for.
  const keys: KeyNeed[] = real
    ? opts.credentials.map((c) => ({
        serviceId: c.serviceId,
        name: c.serviceName,
        kind: c.need.kind,
        where: c.need.where,
        state: c.state,
      }))
    : [];
  const channels = await db
    .select({ id: t.notificationChannels.id })
    .from(t.notificationChannels)
    .where(eq(t.notificationChannels.status, "configured"));
  const voice = await getSetting(db, "voice_config");
  return buildGettingStarted(
    {
      adopted: watched.length > 0,
      planned: Boolean((await getSetting(db, "homelab_plan"))?.confirmed),
      keys,
      notifications: channels.length > 0,
      backupCopy: opts.backupCopy,
      voice: Boolean(voice?.host),
      operator: Boolean(await getSetting(db, "operator_agent")),
      met: Boolean(await getSetting(db, "meet_cove_at")),
    },
    await choicesOf(db),
    aiDisplayName(await getSetting(db, "ai_name")),
  );
}

async function choicesOf(db: Database): Promise<GettingStartedChoices> {
  return (await getSetting(db, "getting_started")) ?? { dismissed: [], hidden: false };
}

/** Dismiss or bring back one item, or hide or show the whole list. */
export async function updateGettingStarted(
  db: Database,
  change: { dismiss?: string; restore?: string; hidden?: boolean },
): Promise<void> {
  const id = change.dismiss ?? change.restore;
  if (
    id !== undefined &&
    !/^(plan|adopt|notifications|backup-copy|voice|operator|meet|key:[\w.-]{1,80})$/.test(id)
  )
    throw new InvalidRequestError("That is not a getting started item.");
  const current = await choicesOf(db);
  const dismissed = new Set(current.dismissed);
  if (change.dismiss) dismissed.add(change.dismiss);
  if (change.restore) dismissed.delete(change.restore);
  await setSetting(db, "getting_started", {
    dismissed: [...dismissed],
    hidden: change.hidden ?? current.hidden,
  });
}
