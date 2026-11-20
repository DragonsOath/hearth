import { describe, expect, it } from "vitest";
import { fakeJellyfin } from "./fake-jellyfin";
import { callFor } from "./jellyfin";
import {
  latestFor,
  newerVersion,
  planManage,
  readManageView,
  runManage,
  type JellyfinManageOp,
} from "./jellyfin-manage";

// Jellyfin's panel as Plex's (11-04): Library, a title, Manage, Plugins and Settings against the
// stand-in Jellyfin. Every change is planned from what Jellyfin has now and read back after.

const base = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first" as const,
  policyReason: "",
};
const svc = { name: "Jellyfin" };

function setup() {
  const fake = fakeJellyfin();
  const call = callFor(fake.fetch, "http://jellyfin.test:8096", "e2e-unit");
  const go = async (op: JellyfinManageOp, params: Record<string, string>) => {
    const plan = await planManage(call, svc, op, params, base);
    return { plan, out: await runManage(call, svc, op, plan.params!, async () => undefined) };
  };
  return { call, go };
}

describe("Jellyfin's Library, Manage, Plugins and Settings tabs", () => {
  it("browses a library with search and unwatched, and opens a title with its files", async () => {
    const { call } = setup();
    const lib = await readManageView(call, "library", {});
    expect(lib.sections).toHaveLength(2);
    const items = lib.items as { id: string; title: string; watched: boolean }[];
    expect(items.map((i) => i.title)).toEqual(["Anora", "Dune: Part Two"]);
    expect(items.find((i) => i.id === "m-dune2")!.watched).toBe(true);
    const found = await readManageView(call, "library", { q: "anor" });
    expect((found.items as { title: string }[]).map((i) => i.title)).toEqual(["Anora"]);
    const unwatched = await readManageView(call, "library", { filter: "unwatched" });
    expect((unwatched.items as { id: string }[]).map((i) => i.id)).toEqual(["m-anora"]);
    const item = await readManageView(call, "item", { id: "m-anora" });
    expect(item).toMatchObject({ title: "Anora", year: 2024, watched: false });
    expect((item.files as { file: string; resolution: string }[])[0]).toMatchObject({
      resolution: "1080p",
    });
    const shows = await readManageView(call, "library", { section: "lib-shows" });
    const series = await readManageView(call, "item", {
      id: (shows.items as { id: string }[])[0]!.id,
    });
    expect(series.children).toEqual([
      expect.objectContaining({ title: "Season 1", episodes: 1, episodesWatched: 0 }),
    ]);
  });

  it("marks watched and unwatched, edits details and keeps them, reading each back", async () => {
    const { call, go } = setup();
    const w = await go("watched", { itemId: "m-anora" });
    expect(w.plan.label).toBe("Mark Anora watched for Alex in Jellyfin");
    expect(w.out).toMatchObject({ ok: true, verified: true });
    expect((await go("unwatched", { itemId: "m-anora" })).out.ok).toBe(true);
    const e = await go("edit-item", {
      itemId: "m-anora",
      body: JSON.stringify({ sortTitle: "Anora (2024)", summary: "Brooklyn." }),
    });
    expect(e.plan.change!.settings).toEqual([
      { name: "Sort title", before: expect.any(String), after: "Anora (2024)" },
      { name: "Summary", before: expect.any(String), after: "Brooklyn." },
    ]);
    expect(e.out).toMatchObject({ ok: true, verified: true });
    expect(await readManageView(call, "item", { id: "m-anora" })).toMatchObject({
      summary: "Brooklyn.",
    });
    await expect(
      go("edit-item", { itemId: "m-anora", body: JSON.stringify({ year: "1700" }) }),
    ).rejects.toThrow(/A year like/);
    await expect(go("watched", { itemId: "nope" })).rejects.toThrow(/does not have that title/);
  });

  it("rates a title the way Jellyfin can: a like, and Favorite when you loved it", async () => {
    const { go } = setup();
    const r = await go("like", { itemId: "m-anora", liked: "true", favorite: "true" });
    expect(r.plan.label).toBe("Liked and a Favorite: Anora, for Alex in Jellyfin");
    expect(r.out).toMatchObject({ ok: true, verified: true });
    expect((await go("like", { itemId: "m-anora", liked: "false" })).out.ok).toBe(true);
  });

  it("adds and removes a library's folder and a library, only folders Jellyfin can see", async () => {
    const { call, go } = setup();
    expect((await go("add-folder", { library: "Movies", path: "/media/more" })).out.ok).toBe(true);
    await expect(go("add-folder", { library: "Movies", path: "/elsewhere" })).rejects.toThrow(
      /cannot see the folder/,
    );
    await expect(go("remove-folder", { library: "Movies", path: "/media/nope" })).rejects.toThrow(
      /does not read/,
    );
    expect((await go("remove-folder", { library: "Movies", path: "/media/more" })).out.ok).toBe(
      true,
    );
    await expect(go("remove-folder", { library: "Movies", path: "/media/movies" })).rejects.toThrow(
      /only folder/,
    );
    const add = await go("add-library", {
      name: "Concerts",
      type: "musicvideos",
      path: "/media/c",
    });
    expect(add.plan.label).toMatch(/Add a Music videos library called Concerts/);
    expect(add.out).toMatchObject({ ok: true, verified: true });
    const libs = (await readManageView(call, "libraries", {})).libraries as { name: string }[];
    expect(libs.map((l) => l.name)).toContain("Concerts");
    const rm = await go("remove-library", { library: "Concerts" });
    expect(rm.plan.label).toMatch(/files stay on disk/);
    expect(rm.out.ok).toBe(true);
  });

  it("lists plugins with an update and the catalog, installs, disables, removes, and restarts", async () => {
    const { call, go } = setup();
    const pl = await readManageView(call, "plugins", {});
    const installed = pl.installed as { name: string; update?: string; canRemove: boolean }[];
    expect(installed.find((p) => p.name === "Open Subtitles")).toMatchObject({
      update: "21.0.0.0",
      canRemove: true,
    });
    expect(installed.find((p) => p.name === "TMDb")!.canRemove).toBe(false);
    // Only versions this Jellyfin can run.
    const catalog = pl.catalog as { name: string }[];
    expect(catalog.map((k) => k.name)).toEqual(["Fanart", "Open Subtitles"]);
    expect(pl.restartNeeded).toBe(false);

    const up = await go("plugin-install", { guid: "p2" });
    expect(up.plan.label).toMatch(/Update the Open Subtitles plugin to 21.0.0.0/);
    expect((await go("plugin-install", { guid: "p3" })).out.ok).toBe(true);
    expect((await readManageView(call, "plugins", {})).restartNeeded).toBe(true);
    const restart = await go("restart", {});
    expect(restart.plan.label).toMatch(/cut off for about a minute/);
    expect(restart.out.ok).toBe(true);
    const after = (await readManageView(call, "plugins", {})).installed as { name: string }[];
    expect(after.map((p) => p.name)).toContain("Fanart");

    // Jellyfin can answer 404 to a disable it did: the read back decides.
    expect((await go("plugin-disable", { pluginId: "p2" })).out).toMatchObject({
      ok: true,
      verified: true,
    });
    await expect(go("plugin-uninstall", { pluginId: "p1" })).rejects.toThrow(/comes with Jellyfin/);
    expect((await go("plugin-uninstall", { pluginId: "p3" })).out.ok).toBe(true);
  });

  it("changes only Hearth's listed settings, checked, and reads them back", async () => {
    const { call, go } = setup();
    const s = await go("set-settings", {
      settings: JSON.stringify({ EnableTonemapping: true, ServerName: "Den" }),
    });
    expect(s.plan.change!.settings).toEqual([
      { name: "Tone mapping", before: "Off", after: "On" },
      { name: "Server name", before: "homeserver", after: "Den" },
    ]);
    expect(s.out).toMatchObject({ ok: true, verified: true });
    const read = (await readManageView(call, "settings", {})).settings as {
      id: string;
      value: unknown;
    }[];
    expect(read.find((x) => x.id === "ServerName")!.value).toBe("Den");
    await expect(
      go("set-settings", { settings: JSON.stringify({ PublicHttpsPort: 1 }) }),
    ).rejects.toThrow(/stays in Jellyfin/);
    await expect(
      go("set-settings", { settings: JSON.stringify({ HardwareAccelerationType: "magic" }) }),
    ).rejects.toThrow(/one of/);
    await expect(
      go("set-settings", { settings: JSON.stringify({ MaxResumePct: 500 }) }),
    ).rejects.toThrow(/whole number/);
  });

  it("compares plugin versions part by part and picks the newest this server can run", () => {
    expect(newerVersion("10.11.0.0", "10.10.7.0")).toBe(true);
    expect(newerVersion("10.10.7", "10.10.7.0")).toBe(false);
    expect(
      latestFor(
        {
          versions: [
            { version: "2.0.0.0", targetAbi: "11.0.0.0" },
            { version: "1.5.0.0", targetAbi: "10.9.0.0" },
          ],
        },
        "10.10.7",
      )?.version,
    ).toBe("1.5.0.0");
  });
});
