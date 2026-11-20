import { describe, expect, it } from "vitest";
import { CRUCIBLE_PRESETS } from "@dragon-control/core";
import { SHAPES, planCrucible, runCrucible, undoCrucible, type Arr } from "./crucible-apply";
import { keepNewMovies } from "./crucible-keeper";
import { fakeSonarr } from "./fake-sonarr";

/** The Crucible's shows (step 9): Sonarr, judged per episode, against the stand-in Sonarr. */

function sonarr() {
  const app = fakeSonarr();
  const arr: Arr = async (method, path, _purpose, body) => {
    const res = await app.fetch(`http://10.0.0.5:8989${path}`, {
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
  return { arr, get, app };
}
type Def = {
  id: number;
  title: string;
  maxSize: number | null;
  preferredSize: number | null;
  quality: { resolution: number };
};

describe("the Crucible's shows in Sonarr", () => {
  it("makes a profile per show row and sets the main row's sizes as Sonarr's per-minute limits", async () => {
    const { arr, get } = sonarr();
    const setup = JSON.stringify(CRUCIBLE_PRESETS["storage-smart"].setup());
    const before = await get<Def[]>("/api/v3/qualitydefinition");
    const [change, params] = await planCrucible(arr, "Sonarr", { setup, app: "sonarr" }, 2026);
    expect(change.summary).toBe("Save the Crucible's show rows in Sonarr");
    const names = change.settings.map((s) => s.name);
    expect(names).toContain("All shows");
    expect(names).toContain("Shows you already have");
    const size = change.settings.find((s) => s.name === "Size limit, WEBDL-1080p")!;
    expect(size.after).toContain("about 2.5 GB for an hour-long episode");
    expect(size.after).toContain("season packs judged per episode");

    expect(await runCrucible(arr, "Sonarr", params)).toMatchObject({ ok: true, verified: true });
    const profiles =
      await get<{ name: string; formatItems: { score: number }[] }[]>("/api/v3/qualityprofile");
    const all = profiles.find((p) => p.name === "Hearth · All shows")!;
    expect(all).toBeDefined();
    // No size filters inside a show profile (they would count a season pack's total).
    expect(all.formatItems.every((f) => f.score > -10000)).toBe(true);
    const defs = await get<Def[]>("/api/v3/qualitydefinition");
    for (const d of defs.filter((x) => x.quality.resolution === 1080)) expect(d.maxSize).toBe(42.7);
    for (const d of defs.filter((x) => x.quality.resolution === 720)) expect(d.maxSize).toBe(25.6);

    expect(await undoCrucible(arr, "Sonarr", params)).toMatchObject({ ok: true, verified: true });
    expect(await get<Def[]>("/api/v3/qualitydefinition")).toEqual(before);
    expect(
      (await get<{ name: string }[]>("/api/v3/qualityprofile")).some((p) =>
        p.name.startsWith("Hearth · "),
      ),
    ).toBe(false);
  });

  it("leaves Sonarr's sizes alone when Recyclarr or Profilarr manages them", async () => {
    const { arr, get } = sonarr();
    const setup = JSON.stringify(CRUCIBLE_PRESETS["storage-smart"].setup());
    const before = await get<Def[]>("/api/v3/qualitydefinition");
    const [change, params] = await planCrucible(
      arr,
      "Sonarr",
      { setup, app: "sonarr", sizesManaged: true },
      2026,
    );
    expect(change.settings.find((s) => s.name === "Episode sizes")?.before).toBe(
      "Managed by Recyclarr or Profilarr",
    );
    await runCrucible(arr, "Sonarr", params);
    expect(await get<Def[]>("/api/v3/qualitydefinition")).toEqual(before);
  });

  it("moves existing shows only when asked, and the keeper gives a new show its row", async () => {
    const { arr, get } = sonarr();
    const setup = CRUCIBLE_PRESETS["storage-smart"].setup();
    const [, params] = await planCrucible(
      arr,
      "Sonarr",
      { setup: JSON.stringify(setup), app: "sonarr", resort: true },
      2026,
    );
    expect(await runCrucible(arr, "Sonarr", params)).toMatchObject({ ok: true, verified: true });
    const all = (await get<{ id: number; name: string }[]>("/api/v3/qualityprofile")).find(
      (p) => p.name === "Hearth · All shows",
    )!;
    const shows = await get<{ id: number; qualityProfileId: number }[]>("/api/v3/series");
    expect(shows.every((x) => x.qualityProfileId === all.id)).toBe(true);
    const lastId = Math.max(...shows.map((x) => x.id));
    const made = (
      await arr<{ id: number }>("POST", "/api/v3/series", "test", {
        title: "Harbour Lights",
        year: 2026,
        tvdbId: 777001,
        qualityProfileId: 1,
        rootFolderPath: "/tv",
        monitored: true,
        seasons: [{ seasonNumber: 1, monitored: true }],
        addOptions: { searchForMissingEpisodes: false },
      })
    ).data;
    const r = await keepNewMovies(arr, setup, lastId, 2026, false, SHAPES.sonarr);
    expect(r.moved).toEqual([{ title: "Harbour Lights (2026)", to: "All shows" }]);
    expect(
      (await get<{ qualityProfileId: number }>(`/api/v3/series/${made.id}`)).qualityProfileId,
    ).toBe(all.id);
  });
});
