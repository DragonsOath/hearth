import { DEFAULT_KDF_COST, hashSecret, verifySecret } from "../auth/crypto";
import type { DbHandle } from "../db/client";
import { deleteSetting, getSetting, setSetting } from "../store/settings";

/**
 * The home's unlock PIN (11-04): opening a lock or a garage door, or disarming the alarm, from
 * the home dashboard needs it, so a guest or a child at the wall tablet cannot open the front door.
 * Only its hash is kept. Five wrong tries lock it for five minutes.
 */

const KEY = "home_unlock_pin";
const TRIES = 5;
const LOCK_MS = 5 * 60_000;

export class PinError extends Error {}

let failures = 0;
let until = 0;

export async function pinIsSet(handle: DbHandle): Promise<boolean> {
  return Boolean(await getSetting(handle.db, KEY));
}

/** Sets or changes the PIN (the owner only, signed in as themselves). Undefined clears it. */
export async function setPin(handle: DbHandle, pin: string | undefined) {
  if (pin === undefined) return deleteSetting(handle.db, KEY);
  if (!/^\d{4,8}$/.test(pin)) throw new PinError("A PIN of 4 to 8 digits.");
  await setSetting(handle.db, KEY, await hashSecret(pin, DEFAULT_KDF_COST));
}

/** Checks a PIN at the tablet; throws with a plain reason when it is wrong, missing or locked. */
export async function checkPin(handle: DbHandle, pin: string | undefined, now = Date.now()) {
  const kept = await getSetting(handle.db, KEY);
  if (!kept)
    throw new PinError(
      "No unlock PIN is set yet. Set one in Home Assistant's panel, Home tab, before opening doors from here.",
    );
  if (now < until)
    throw new PinError(
      `Too many wrong PINs. Try again in ${Math.ceil((until - now) / 60_000)} minutes.`,
    );
  if (!pin || !(await verifySecret(pin, kept))) {
    failures++;
    if (failures >= TRIES) {
      until = now + LOCK_MS;
      failures = 0;
    }
    throw new PinError("That PIN is not right.");
  }
  failures = 0;
}

/** Tests only. */
export function resetPinThrottle() {
  failures = 0;
  until = 0;
}
