import { describe, expect, it } from "vitest";
import { fakeRadarr } from "./fake-radarr";
import { RADARR_VIEWS, posterOf, readRadarrView, type RadarrGet } from "./radarr-panel";

function getter() {
  const radarr = fakeRadarr();
  const get: RadarrGet = async (path) => {
    const r = await radarr.fetch(`http://radarr.test:7879${path}`, {
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  };
  return { radarr, get };
}

describe("the native Radarr panel's reads", () => {
  it("lists the library with profiles, tags and version", async () => {
    const { get } = getter();
    const v = await readRadarrView(get, "library", {});
    expect(v.meta).toEqual({ version: "6.4.4.10685", supported: true });
    const movies = v.movies as { title: string; hasFile: boolean; quality?: string }[];
    expect(movies.length).toBe(12);
    expect(movies.find((m) => m.title === "Harbor Lights")).toMatchObject({
      hasFile: true,
      quality: "Bluray-1080p",
    });
    expect(v.profiles).toEqual([
      { id: 1, name: "HD-1080p" },
      { id: 2, name: "Ultra-HD" },
    ]);
  });

  it("shows one movie with its file and history", async () => {
    const { get } = getter();
    const v = await readRadarrView(get, "movie", { id: "1" });
    expect((v.movie as { title: string }).title).toBe("Harbor Lights");
    expect((v.file as { quality: string }).quality).toBe("Bluray-1080p");
    expect((v.history as { event: string }[]).map((h) => h.event)).toEqual([
      "downloadFolderImported",
      "grabbed",
    ]);
  });

  it("pages history, blocklist and wanted lists", async () => {
    const { get } = getter();
    const h = await readRadarrView(get, "history", {});
    expect(h.total).toBeGreaterThan(10);
    expect((h.records as { item?: string }[])[0]!.item).toBeTruthy();
    const failed = await readRadarrView(get, "history", { event: "4" });
    expect((failed.records as { event: string }[]).every((r) => r.event === "downloadFailed")).toBe(
      true,
    );
    const b = await readRadarrView(get, "blocklist", {});
    expect(b.total).toBe(1);
    const missing = await readRadarrView(get, "missing", {});
    expect((missing.records as { title: string }[]).map((m) => m.title)).toEqual([
      "Glass Meridian",
    ]);
    const cutoff = await readRadarrView(get, "cutoff", {});
    expect((cutoff.records as { title: string }[]).map((m) => m.title).sort()).toEqual([
      "Iron Orchard",
      "North of Nowhere",
      "Paper Lanterns",
      "The Last Lighthouse",
      "The Quiet Engine",
    ]);
  });

  it("never returns a connection's password or API key", async () => {
    const { get } = getter();
    const v = await readRadarrView(get, "connections", {});
    const text = JSON.stringify(v);
    expect(text).not.toContain("stand-in-secret");
    expect(text).not.toContain("stand-in-indexer-key");
    const client = (v.groups as { kind: string; items: { fields: { name: string }[] }[] }[]).find(
      (g) => g.kind === "downloadclient",
    )!.items[0]!;
    expect(client.fields.find((f) => f.name === "password")).toMatchObject({
      secret: true,
      set: true,
    });
    expect(client.fields.find((f) => f.name === "host")).toMatchObject({ value: "qbittorrent" });
  });

  it("asks Radarr itself which custom formats a release name matches (D13)", async () => {
    const { get } = getter();
    const v = await readRadarrView(get, "parse", {
      title: "Harbor.Lights.2019.1080p.WEB-DL.x265-FAKEGRP",
    });
    expect(v.formats).toEqual(["x265 (HD)", "Bad release group"]);
    expect(v.score).toBe(-1010);
  });

  it("reads every view without failing", async () => {
    const { get } = getter();
    for (const view of RADARR_VIEWS) {
      const q =
        view === "movie"
          ? { id: "2" }
          : view === "parse" || view === "lookup"
            ? { title: "lantern" }
            : view === "imports"
              ? { folder: "/downloads" }
              : {};
      await expect(readRadarrView(get, view, q)).resolves.toHaveProperty("meta");
    }
  });

  it("reads quality sizes, exclusions and files waiting to be imported", async () => {
    const { get } = getter();
    const sizes = await readRadarrView(get, "sizes", {});
    expect(sizes.limits).toEqual({ min: 0, max: 2000 });
    expect(
      (sizes.sizes as { name: string; maxSize: number | null }[]).find(
        (s) => s.name === "WEBDL-2160p",
      )?.maxSize,
    ).toBeNull();
    const ex = await readRadarrView(get, "exclusions", {});
    expect(ex.records).toEqual([{ id: 1, key: 9902, title: "The Orchard Keeper", year: 2021 }]);
    const im = await readRadarrView(get, "imports", { folder: "/downloads" });
    expect(im.files).toEqual([
      expect.objectContaining({
        movieId: 6,
        movie: expect.stringMatching(/^Glass Meridian/),
        quality: "Bluray-1080p",
        rejections: [],
      }),
      expect.objectContaining({
        name: "Holiday.Video.2024.mkv",
        movieId: undefined,
        rejections: ["Unknown Movie"],
      }),
    ]);
    await expect(readRadarrView(get, "imports", {})).rejects.toThrow(/which folder/);
  });

  it("marks a version it was not built for as unsupported", async () => {
    const get: RadarrGet = async (path) =>
      path === "/api/v3/system/status"
        ? { ok: true, status: 200, data: { version: "7.0.0.1" } }
        : { ok: true, status: 200, data: [] };
    const v = await readRadarrView(get, "system", {});
    expect(v.meta).toEqual({ version: "7.0.0.1", supported: false });
  });

  it("serves posters only as TMDB file names", () => {
    expect(
      posterOf({
        images: [{ coverType: "poster", remoteUrl: "https://image.tmdb.org/t/p/original/abc.jpg" }],
      }),
    ).toBe("/abc.jpg");
    expect(
      posterOf({ images: [{ coverType: "poster", remoteUrl: "https://evil.example/abc.jpg" }] }),
    ).toBe(undefined);
  });
});
