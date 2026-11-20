import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { SERVER_ROOT } from "../config";
import path from "node:path";
import { onboardingNeeded } from "./onboarding";
import { deleteSetting, setSetting } from "./settings";
import { DEFAULT_VOICE_PROFILES } from "@dragon-control/core";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function fresh(claimed: boolean) {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  if (claimed)
    handle.sqlite
      .exec(`INSERT INTO owner (id, password_hash, recovery_hash, created_at, password_changed_at)
      VALUES (1, 'x', 'y', '2026-10-14T00:00:00Z', '2026-10-14T00:00:00Z')`);
  return handle.db;
}

describe("the first-run welcome", () => {
  it("is not offered before anyone has claimed the installation", async () => {
    expect(await onboardingNeeded(await fresh(false))).toBe(false);
  });

  it("is offered once a new owner has claimed it, until they finish or skip it", async () => {
    const db = await fresh(true);
    expect(await onboardingNeeded(db)).toBe(true);
    await setSetting(db, "onboarding_done_at", new Date().toISOString());
    expect(await onboardingNeeded(db)).toBe(false);
    await deleteSetting(db, "onboarding_done_at");
    expect(await onboardingNeeded(db)).toBe(true);
  });

  it("is never offered to an owner who already made any of these choices", async () => {
    const choices = [
      (db: Awaited<ReturnType<typeof fresh>>) => setSetting(db, "ai_name", "Warden"),
      (db: Awaited<ReturnType<typeof fresh>>) => setSetting(db, "owner_name", "Sam"),
      (db: Awaited<ReturnType<typeof fresh>>) => setSetting(db, "ui_theme", { preset: "ember" }),
      (db: Awaited<ReturnType<typeof fresh>>) =>
        setSetting(db, "voice_config", {
          host: "",
          sttPort: 10300,
          ttsPort: 10200,
          profiles: DEFAULT_VOICE_PROFILES,
        }),
    ];
    for (const choose of choices) {
      const db = await fresh(true);
      await choose(db);
      expect(await onboardingNeeded(db)).toBe(false);
    }
  });
});
