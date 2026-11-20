import { describe, expect, it } from "vitest";
import { arrTitle, rowFor, safeToMove, type CrucibleSetup } from "@dragon-control/core";
import { planCrucible, runCrucible, type Arr } from "./crucible-apply";
import { followAging } from "./crucible-keeper";
import { fakeRadarr } from "./fake-radarr";

/**
 * Titles follow the rules as they age (11-18, the owner): a new release that is no longer new
 * moves to the rule it fits now, but only when that replaces nothing.
 */
function radarr() {
  const app = fakeRadarr();
  const arr: Arr = async (method, path, _purpose, body) => {
    const res = await app.fetch(`http://10.0.0.5:7879${path}`, {
      method,
      headers: { "X-Api-Key": "key", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      ok: res.ok,
      status: res.status,
      data: (await res.json().catch(() => undefined)) as never,
    };
  };
  const get = async <T>(path: string) => (await arr<T>("GET", path, "test")).data;
  return { arr, get };
}

const setup: CrucibleSetup = {
  preset: "custom",
  movies: [
    {
      id: "new",
      name: "New releases",
      group: { olderThanYears: 0, newerThanYears: 3 },
      ladder: [
        { quality: "2160p", maxGB: 15 },
        { quality: "1080p", maxGB: 6 },
      ],
      upgrade: true,
      waitHours: 0,
    },
    {
      id: "rest",
      name: "Everything else",
      group: {},
      ladder: [
        { quality: "720p", maxGB: 1.5 },
        { quality: "sd", maxGB: 1 },
      ],
      upgrade: false,
      waitHours: 0,
    },
  ],
  shows: [],
};

type M = { id: number; title: string; qualityProfileId: number };

describe("titles follow the rules as they age", () => {
  it("moves aged titles only when nothing would be replaced, and leaves the rest", async () => {
    const { arr, get } = radarr();
    const [, params] = await planCrucible(
      arr,
      "Radarr",
      { setup: JSON.stringify(setup), resort: true },
      2026,
    );
    expect(await runCrucible(arr, "Radarr", params)).toMatchObject({ ok: true });
    const profiles = await get<{ id: number; name: string }[]>("/api/v3/qualityprofile");
    const id = (n: string) => profiles.find((p) => p.name === n)!.id;
    const before = await get<(M & Record<string, unknown>)[]>("/api/v3/movie");
    const wasNew = before.filter((m) => m.qualityProfileId === id("Hearth · New releases"));
    expect(wasNew.length).toBeGreaterThan(1);

    // Ten years on, nothing is new any more.
    const later = 2036;
    const tags = new Map<number, string>();
    const safe = wasNew.filter((m) =>
      safeToMove(arrTitle(m, tags), rowFor(arrTitle(m, tags), setup.movies, later)!),
    );
    expect(safe.length).toBeGreaterThan(0);
    const r = await followAging(arr, setup, later);
    expect(r.moved.length).toBe(safe.length);
    expect(r.kept).toBe(wasNew.length - safe.length);
    // A 1080p file is never moved to 720p-only (that would replace it); a missing one moves.
    expect(r.kept).toBeGreaterThan(0);
    const after = await get<M[]>("/api/v3/movie");
    for (const m of safe)
      expect(after.find((x) => x.id === m.id)?.qualityProfileId).toBe(
        id("Hearth · Everything else"),
      );
    for (const m of wasNew.filter((x) => !safe.includes(x)))
      expect(after.find((x) => x.id === m.id)?.qualityProfileId).toBe(id("Hearth · New releases"));
    // Movies on a profile Hearth didn't make are never touched.
    for (const m of before.filter(
      (x) => !String(profiles.find((p) => p.id === x.qualityProfileId)?.name).startsWith("Hearth"),
    ))
      expect(after.find((x) => x.id === m.id)?.qualityProfileId).toBe(m.qualityProfileId);
    // Again: nothing more to do.
    expect((await followAging(arr, setup, later)).moved).toEqual([]);
  });
});
