import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actualDashboard, readActual } from "./actual";
import type { Fetch } from "./http";

/**
 * The same reads as actual.test.ts against a real Actual Budget server: only a throwaway one made
 * for this, with a server password and one uploaded budget file. Hearth only reads Actual, so this
 * changes nothing. It runs only with HEARTH_ACTUAL_TEST_URL, HEARTH_ACTUAL_TEST_KEY_FILE and
 * HEARTH_ACTUAL_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_ACTUAL_TEST_URL ?? "";
const file = process.env.HEARTH_ACTUAL_TEST_KEY_FILE;
const run = Boolean(url && file && process.env.HEARTH_ACTUAL_TEST_THROWAWAY === "yes");
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(
  `a real, throwaway Actual Budget server at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const password = run ? readFileSync(file!, "utf8").trim() : "";

    it("reads health, version, memory, sign-in and budget names, never the password or session", async () => {
      const d = await actualDashboard(realFetch, url, password);
      expect(d.healthy).toBe(true);
      expect(d.version).toMatch(/^\d+\.\d+/);
      expect(d.memoryMb).toBeGreaterThan(0);
      expect(d.loginMethods).toEqual(["Password"]);
      expect(d.budgets[0]).toMatchObject({ name: "Household 2026", encrypted: false, people: 1 });
      expect(JSON.stringify(d)).not.toContain(password);
      // A second read reuses the session instead of signing in again.
      expect((await actualDashboard(realFetch, url, password)).budgets).toHaveLength(
        d.budgets.length,
      );
      expect((await readActual(url, password, realFetch)).status).toBe("ok");
    });

    it("refuses a wrong password plainly", async () => {
      await expect(actualDashboard(realFetch, url, "wrong-password")).rejects.toThrow(
        /refused the server password/,
      );
    });
  },
);
