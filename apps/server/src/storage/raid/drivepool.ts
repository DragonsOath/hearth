import { Refuse, type RaidDriver } from "./driver";

/**
 * StableBit DrivePool (Windows): pools ordinary drives into one, often with SnapRAID adding
 * parity. Hearth says when it is installed; the pool itself is managed in DrivePool's own app,
 * and its drives' health and SnapRAID over them are shown in Hearth.
 */

const PLACES = [
  "C:\\Program Files\\StableBit\\DrivePool\\DrivePool.Service.exe",
  "C:\\Program Files (x86)\\StableBit\\DrivePool\\DrivePool.Service.exe",
];

export const drivepoolDriver: RaidDriver = {
  tech: "drivepool",
  platforms: ["win32"],
  operations: [],
  async present({ io }) {
    for (const p of PLACES) if (await io.exists(p)) return true;
    return false;
  },
  async support(env) {
    let here = false;
    for (const p of PLACES) if (await env.io.exists(p)) here = true;
    return {
      tech: "drivepool",
      seen: here
        ? "StableBit DrivePool is installed: its pool is managed in DrivePool's own app. Hearth shows its drives' health, and SnapRAID over them, here."
        : "StableBit DrivePool is not installed",
      support: here ? "detect" : "none",
      verified: "none",
    };
  },
  async arrays() {
    return [];
  },
  actions() {
    return [];
  },
  async plan() {
    throw new Refuse("DrivePool is managed in its own app.");
  },
  async run() {
    throw new Refuse("DrivePool is managed in its own app.");
  },
};
