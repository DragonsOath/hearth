import { describe, expect, it } from "vitest";
import { fakeSonarr } from "./fake-sonarr";
import { SONARR_VIEWS, readSonarrView } from "./sonarr-panel";
import type { ServarrGet } from "./servarr-panel";

function getter() {
  const sonarr = fakeSonarr();
  const get: ServarrGet = async (path) => {
    const r = await sonarr.fetch(`http://sonarr.test:8990${path}`, {
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  };
  return { sonarr, get };
}

describe("the native Sonarr panel's reads", () => {
  it("lists the series with episode counts, profiles and version", async () => {
    const { get } = getter();
    const v = await readSonarrView(get, "library", {});
    expect(v.meta).toEqual({ version: "4.0.20.3014", supported: true });
    const series = v.series as {
      title: string;
      seasons: number;
      episodeFiles: number;
      episodes: number;
    }[];
    expect(series.map((s) => s.title)).toEqual([
      "Night Harbor",
      "The Copper Line",
      "Small Hours",
      "Northwind",
    ]);
    expect(series[1]).toMatchObject({ seasons: 2, episodeFiles: 13, episodes: 16 });
  });

  it("shows one series with its seasons, episodes and files", async () => {
    const { get } = getter();
    const v = await readSonarrView(get, "series", { id: "3" });
    expect((v.series as { title: string }).title).toBe("Small Hours");
    const seasons = v.seasons as { number: number; monitored: boolean; files: number }[];
    expect(seasons.map((s) => [s.number, s.monitored, s.files])).toEqual([
      [3, true, 0],
      [2, true, 9],
      [1, false, 10],
    ]);
    const eps = v.episodes as { code: string; hasFile: boolean; quality?: string }[];
    expect(eps.find((e) => e.code === "S02E01")).toMatchObject({
      hasFile: true,
      quality: "HDTV-720p",
    });
  });

  it("lists missing and below-cutoff episodes with their series", async () => {
    const { get } = getter();
    const missing = await readSonarrView(get, "missing", {});
    const rows = missing.records as { series: string; code: string }[];
    expect(rows.some((r) => r.series === "The Copper Line" && r.code === "S02E06")).toBe(true);
    // Northwind is not monitored, and Small Hours season 1 is not either.
    expect(rows.some((r) => r.series === "Northwind")).toBe(false);
    const cutoff = await readSonarrView(get, "cutoff", {});
    expect((cutoff.records as { series: string }[]).every((r) => r.series !== "Night Harbor")).toBe(
      true,
    );
  });

  it("history and blocklist name the series and episode", async () => {
    const { get } = getter();
    const h = await readSonarrView(get, "history", {});
    const first = (h.records as { item?: string; episode?: string }[])[0]!;
    expect(first.item).toBeTruthy();
    expect(first.episode).toMatch(/^S\d\dE\d\d/);
    const b = await readSonarrView(get, "blocklist", {});
    expect((b.records as { item?: string }[])[0]!.item).toBe("The Copper Line");
  });

  it("finds a show to add, imports and checks a release name", async () => {
    const { get } = getter();
    const look = await readSonarrView(get, "lookup", { title: "lantern" });
    expect((look.results as { title: string; inLibrary: boolean }[]).map((r) => r.title)).toEqual([
      "Lantern Bay",
      "Lantern Bay Stories",
    ]);
    const im = await readSonarrView(get, "imports", { folder: "/downloads" });
    expect(im.files).toEqual([
      expect.objectContaining({
        series: "The Copper Line",
        episodes: ["S02E07"],
        quality: "WEBDL-1080p",
        rejections: [],
      }),
      expect.objectContaining({ seriesId: undefined, rejections: ["Unknown Series"] }),
    ]);
    const parse = await readSonarrView(get, "parse", {
      title: "The.Copper.Line.S02E07.1080p.WEB-DL.x265-GRP",
    });
    expect(parse).toMatchObject({
      matched: "The Copper Line",
      episode: "S02E07",
      formats: ["x265 (HD)"],
    });
  });

  it("shares Radarr's settings views, with Sonarr's naming and exclusions", async () => {
    const { get } = getter();
    const media = await readSonarrView(get, "media", {});
    expect((media.naming as { seasonFolderFormat: string }).seasonFolderFormat).toBe(
      "Season {season}",
    );
    const ex = await readSonarrView(get, "exclusions", {});
    expect(ex.records).toEqual([{ id: 1, key: 99002, title: "The Orchard Road" }]);
    const profiles = await readSonarrView(get, "profiles", {});
    expect((profiles.profiles as { used: number }[])[0]!.used).toBe(4);
  });

  it("reads every view without failing", async () => {
    const { get } = getter();
    for (const view of SONARR_VIEWS) {
      const q =
        view === "series"
          ? { id: "2" }
          : view === "parse" || view === "lookup"
            ? { title: "lantern" }
            : view === "imports"
              ? { folder: "/downloads" }
              : {};
      await expect(readSonarrView(get, view, q)).resolves.toHaveProperty("meta");
    }
  });
});
