import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Fetch } from "./http";
import { readTailscale, tailscaleDashboard } from "./tailscale";

/**
 * The reads from tailscale.test.ts against a real tailnet, read-only: it changes nothing. Not yet
 * run (Tailscale's API was out of reach where the panel was built). It runs only with
 * HEARTH_TAILSCALE_TEST_KEY_FILE (a file holding an API access token); run it from a machine that
 * can reach api.tailscale.com before calling the panel tested against a real server.
 */

const file = process.env.HEARTH_TAILSCALE_TEST_KEY_FILE;
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!file)("a real tailnet, read only", { timeout: 60_000 }, () => {
  const key = file ? readFileSync(file, "utf8").trim() : "";

  it("reads every device with its state, and no keys", async () => {
    const d = await tailscaleDashboard(realFetch, key);
    expect(d.devices.length).toBeGreaterThan(0);
    for (const x of d.devices) {
      expect(x.id).toMatch(/\w/);
      expect(x.addresses.some((a) => a.startsWith("100."))).toBe(true);
      expect(typeof x.online).toBe("boolean");
    }
    const json = JSON.stringify(d);
    for (const word of ["mkey:", "nodekey:", "nlpub:", key]) expect(json).not.toContain(word);
    const r = await readTailscale(key, realFetch);
    expect(r.facts[0]!.label).toBe("Devices online");
  });
});
