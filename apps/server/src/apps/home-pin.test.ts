import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import { checkPin, pinIsSet, resetPinThrottle, setPin } from "./home-pin";

// The home's unlock PIN (11-04): only its hash is kept, and wrong tries lock it for a while.

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
beforeEach(() => resetPinThrottle());

async function db() {
  const handle = openDatabase(":memory:");
  handles.push(handle);
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  return handle;
}

describe("the home's unlock PIN", () => {
  it("is set as digits only, kept as a hash, and checked", async () => {
    const h = await db();
    await expect(checkPin(h, "1234")).rejects.toThrow(/No unlock PIN is set/);
    await expect(setPin(h, "12a4")).rejects.toThrow(/4 to 8 digits/);
    await setPin(h, "2468");
    expect(await pinIsSet(h)).toBe(true);
    const kept = h.sqlite
      .prepare("SELECT value FROM settings WHERE key = 'home_unlock_pin'")
      .get() as {
      value: string;
    };
    expect(kept.value).not.toContain("2468");
    await expect(checkPin(h, "2468")).resolves.toBeUndefined();
    await expect(checkPin(h, "1111")).rejects.toThrow(/not right/);
    await setPin(h, undefined);
    expect(await pinIsSet(h)).toBe(false);
  });

  it("locks for five minutes after five wrong tries, even for the right PIN", async () => {
    const h = await db();
    await setPin(h, "2468");
    const t = Date.now();
    for (let i = 0; i < 5; i++) await expect(checkPin(h, "0000", t)).rejects.toThrow(/not right/);
    await expect(checkPin(h, "2468", t + 1000)).rejects.toThrow(/Too many wrong PINs/);
    await expect(checkPin(h, "2468", t + 5 * 60_000 + 1)).resolves.toBeUndefined();
  });
});
