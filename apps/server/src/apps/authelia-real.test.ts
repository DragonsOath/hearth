import { describe, expect, it } from "vitest";
import { autheliaDashboard, readAuthelia } from "./authelia";
import type { Fetch } from "./http";

/**
 * The same reads as authelia.test.ts against a real Authelia: only a throwaway one made for this,
 * with its metrics on (port 9959) after two successful and several failed sign-ins, the last of them
 * refused while Authelia had banned the account. Hearth only reads
 * Authelia, so this changes nothing. It runs only with HEARTH_AUTHELIA_TEST_URL and
 * HEARTH_AUTHELIA_TEST_THROWAWAY=yes.
 */

const url = process.env.HEARTH_AUTHELIA_TEST_URL ?? "";
const run = Boolean(url && process.env.HEARTH_AUTHELIA_TEST_THROWAWAY === "yes");
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(
  `a real, throwaway Authelia at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    it("reads health and sign-in counts from its metrics, with no name or secret", async () => {
      const d = await autheliaDashboard(realFetch, url);
      expect(d).toMatchObject({ healthy: true, metrics: true });
      expect(d.signIns).toBeGreaterThanOrEqual(2);
      expect(d.failed).toBeGreaterThanOrEqual(3);
      expect(d.banned).toBeGreaterThan(0);
      expect(d.signInMs).toBeGreaterThan(0);
      expect(d.memoryMb).toBeGreaterThan(0);
      expect(Date.parse(d.since!)).toBeLessThan(Date.now());
      expect(JSON.stringify(d)).not.toMatch(/alex|sam|e2e-/i);
      expect((await readAuthelia(url, realFetch)).issues.map((i) => i.key)).toEqual(["banned"]);
    });
  },
);
