import type { Database } from "../db/client";
import * as t from "../db/schema";
import { getSetting } from "./settings";

/**
 * Settings that only an owner who has already made Hearth their own would have. Any one
 * of them means the welcome is not needed: it is for a brand new installation, never for an
 * owner who has set things up already.
 */
const ALREADY_SET = ["ai_name", "owner_name", "ui_theme", "voice_config"] as const;

/**
 * Whether the signed-in owner should be taken to the welcome ("Meet your AI"). Only a claimed
 * installation that has not finished or skipped it. Once the welcome has been started (a step is
 * saved), it resumes until it is finished or skipped, even after the owner's choices are saved
 * along the way. Otherwise, any of the owner's own choices means it is not needed. Installs
 * claimed before the welcome existed are marked done by a migration, so an existing owner is
 * never sent there.
 */
export async function onboardingNeeded(db: Database): Promise<boolean> {
  if (await getSetting(db, "onboarding_done_at")) return false;
  const claimed = await db.select({ id: t.owner.id }).from(t.owner).get();
  if (!claimed) return false;
  if (await getSetting(db, "onboarding_step")) return true;
  for (const key of ALREADY_SET) {
    if ((await getSetting(db, key)) !== undefined) return false;
  }
  return true;
}
