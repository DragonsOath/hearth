import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Fetch } from "./http";
import { jellyfinDashboard, jellyfinPoster } from "./jellyfin";

/**
 * The Overview's library sizes and recently-added posters against a real, disposable Jellyfin
 * (the jellyfin-test that serves the test Wizarr). Skipped unless HEARTH_JELLYFIN_TEST_URL and
 * HEARTH_JELLYFIN_TEST_KEY_FILE point at such an instance. Read only.
 */

const url = process.env.HEARTH_JELLYFIN_TEST_URL;
const keyFile = process.env.HEARTH_JELLYFIN_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
const f = ((u: string, init: Parameters<typeof fetch>[1]) => fetch(u, init)) as unknown as Fetch;

describe.skipIf(!(url && key))("Jellyfin Overview against a real Jellyfin", () => {
  it("counts each library and serves the posters of what was added", async () => {
    const d = await jellyfinDashboard(f, url!, key);
    console.log(JSON.stringify({ libraries: d.libraries, recent: d.recent.slice(0, 4) }));
    for (const l of d.libraries.filter((x) => ["movies", "tvshows"].includes(x.kind)))
      expect(l.size?.length, l.name).toBeGreaterThan(0);
    const withPoster = d.recent.find((r) => r.poster);
    if (withPoster) {
      const pic = await jellyfinPoster(f, url!, key, withPoster.poster!);
      expect(pic?.type).toMatch(/^image\//);
      expect(pic!.bytes.length).toBeGreaterThan(100);
    }
    expect(await jellyfinPoster(f, url!, key, "../../System/Info")).toBeUndefined();
  });
});
