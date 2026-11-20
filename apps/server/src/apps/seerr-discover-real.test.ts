import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ServarrGet } from "./servarr-panel";
import { readSeerrView } from "./seerr-panel";

/**
 * Discover's rows against a real, disposable Seerr (seerr-test). Skipped unless
 * HEARTH_SEERR_TEST_URL and HEARTH_SEERR_TEST_KEY_FILE point at one. Read only.
 */

const url = process.env.HEARTH_SEERR_TEST_URL;
const keyFile = process.env.HEARTH_SEERR_TEST_KEY_FILE;
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";

const read: ServarrGet = async (path) => {
  const r = await fetch(`${url}${path}`, {
    headers: { "X-Api-Key": key, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
};

describe.skipIf(!(url && key))("Seerr Discover rows against a real Seerr", () => {
  it("reads trending movies, recent releases and trending shows, with posters and status", async () => {
    const { rows } = (await readSeerrView(read, "discover", {})) as {
      rows: {
        id: string;
        error?: string;
        pages: number;
        results: { mediaType: string; poster?: string; status: string; year?: number }[];
      }[];
    };
    expect(rows.map((r) => r.id)).toEqual([
      "trending-movies",
      "recent-movies",
      "upcoming-movies",
      "trending-tv",
    ]);
    for (const r of rows) {
      expect(r.error, r.id).toBeUndefined();
      expect(r.results.length, r.id).toBeGreaterThan(5);
      expect(
        r.results.every((x) => x.mediaType === (r.id === "trending-tv" ? "tv" : "movie")),
      ).toBe(true);
      expect(r.results.filter((x) => x.poster).length, r.id).toBeGreaterThan(3);
    }
    // Recent releases really are recent: released in the last 60 days (by year at least).
    const recent = rows.find((r) => r.id === "recent-movies")!;
    expect(recent.results.every((x) => !x.year || x.year >= new Date().getFullYear() - 1)).toBe(
      true,
    );
    // See all: a later page of one row.
    const two = (await readSeerrView(read, "discover", { row: "trending-tv", page: "2" })) as {
      page: number;
      results: unknown[];
    };
    expect(two.page).toBe(2);
    expect(two.results.length).toBeGreaterThan(0);
  });
});
