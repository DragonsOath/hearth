import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakePlex } from "./fake-plex";
import type { ServarrGet } from "./servarr-panel";
import { PlexOperations } from "./plex-control";
import { readPlexView } from "./plex-panel";

// The Plex panel's Manage tab (the owner, 2026-11-02): where each library's rows show and in what
// order, and Merge Recently Added Items, as Plex's own Manage Libraries page sets them.

const BASE = "http://10.0.0.9:32400";
const TOKEN = "e2e-plex-token";
const service = { id: "plex", name: "Plex", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: TOKEN }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-plex-control" as const,
  serviceId: "plex",
  requestedBy: "you" as const,
  params,
});

function setup(newReleases = false) {
  const plex = fakePlex({ newReleases });
  const ops = new PlexOperations(handle, broker, plex.fetch);
  ops.settleMs = 0;
  const read: ServarrGet = async (path) => {
    const r = await plex.fetch(`${BASE}${path}`, {
      method: "GET",
      headers: { Accept: "application/json", "X-Plex-Token": TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  };
  const view = async () =>
    (await readPlexView(read, "manage", { section: "1" })) as {
      rows: { id: string; title: string; recommended: boolean; home: boolean; shared: boolean }[];
      merge: boolean | null;
      sections: { id: string }[];
    };
  const lib = async (id: string) =>
    (
      (await read("/library/sections")).data as {
        MediaContainer: { Directory: { key: string; Location: { path: string }[] }[] };
      }
    ).MediaContainer.Directory.find((d) => d.key === id)!.Location.map((l) => l.path);
  const homeOf = async (id: string) =>
    (
      (await read(`/hubs/sections/${id}/manage`)).data as {
        MediaContainer: { Hub: { identifier: string; promotedToOwnHome: boolean }[] };
      }
    ).MediaContainer.Hub.map((h) => `${h.identifier}:${h.promotedToOwnHome ? "h" : "-"}`);
  const shows = async (id: string) =>
    (
      (await read(`/library/sections/${id}/prefs`)).data as {
        MediaContainer: { Setting: { id: string; value: string }[] };
      }
    ).MediaContainer.Setting.find((x) => x.id === "hidden")!.value;
  return { ops, view, lib, homeOf, shows, plex };
}

describe("Plex Manage", () => {
  it("lists the libraries and a library's rows with where each shows", async () => {
    const { view } = setup();
    const v = await view();
    expect(v.sections.map((s) => s.id)).toEqual(["1", "2"]);
    expect(v.rows[1]).toMatchObject({
      title: "Recently Added Movies",
      recommended: true,
      home: true,
      shared: true,
    });
    expect(v.merge).toBe(false);
  });

  it("changes where rows show and their order in one plan, read back", async () => {
    const { ops, view } = setup();
    const before = await view();
    const ids = before.rows.map((r) => r.id);
    const order = [ids[3]!, ...ids.filter((i) => i !== ids[3])];
    const planned = await ops.plan(
      service,
      {
        op: "set-rows",
        libraryId: "1",
        rows: JSON.stringify({ "custom.collection.1.9001": { home: true, shared: true } }),
        order: JSON.stringify(order),
      },
      base,
    );
    expect(planned.change?.settings).toEqual(
      expect.arrayContaining([
        {
          name: "Time Loop Movies",
          before: "Library Recommended",
          after: "Library Recommended, Home, Friends' Home",
        },
        expect.objectContaining({ name: "Order" }),
      ]),
    );
    const done = await ops.run(step(planned.params), service);
    expect(done).toMatchObject({ ok: true });
    const after = await view();
    expect(after.rows.map((r) => r.id)).toEqual(order);
    expect(after.rows[0]).toMatchObject({ title: "Time Loop Movies", home: true, shared: true });
    // A retry of the same plan finds the rows moved on and changes nothing.
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: false, stale: true });
  });

  it("refuses a row Plex does not have, an order that drops rows, and a change to nothing", async () => {
    const { ops } = setup();
    await expect(
      ops.plan(service, { op: "set-rows", libraryId: "1", rows: '{"nope":{"home":true}}' }, base),
    ).rejects.toThrow(/no row/);
    await expect(
      ops.plan(service, { op: "set-rows", libraryId: "1", order: '["movie.inprogress.1"]' }, base),
    ).rejects.toThrow(/every row/);
    await expect(
      ops.plan(
        service,
        { op: "set-rows", libraryId: "1", rows: '{"movie.inprogress.1":{"home":true}}' },
        base,
      ),
    ).rejects.toThrow(/already/);
  });

  it("turns Merge Recently Added Items on, read back", async () => {
    const { ops, view } = setup();
    const planned = await ops.plan(service, { op: "merge-recent", on: true }, base);
    expect(planned.change?.settings[0]).toMatchObject({ before: "off", after: "on" });
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: true });
    expect((await view()).merge).toBe(true);
  });

  it("combines two libraries on Home: Movies reads New Releases' folder, New Releases goes sidebar-only, so no film shows twice; separated again", async () => {
    const { ops, lib, homeOf, shows, plex } = setup(true);
    const planned = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: true },
      base,
    );
    expect(planned.label).toBe("Combine New Releases with Movies on Home in Plex");
    expect(planned.change?.settings).toEqual(
      expect.arrayContaining([
        {
          name: "Folders Movies reads",
          before: "/media/movies",
          after: "/media/movies, /media/new-releases",
        },
        {
          name: "Where New Releases shows",
          before: "Sidebar, Home and search",
          after: "Sidebar only (not on Home or in search)",
        },
      ]),
    );
    expect(JSON.stringify(planned.change?.settings)).toMatch(
      /stays in your sidebar.*no film shows twice/,
    );
    expect(JSON.stringify(planned.change?.settings)).not.toMatch(/4K/);
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: true });
    expect(await lib("1")).toEqual(["/media/movies", "/media/new-releases"]);
    expect(await lib("3")).toEqual(["/media/new-releases"]);
    expect(await shows("3")).toBe("2");
    expect(plex.homeTruth("3")).toEqual(["movie.recentlyadded:-", "movie.recentlyreleased:-"]);
    // Movies' own Recently Released was off Home: combining put it on, so Home has both rows.
    expect(planned.change?.settings).toContainEqual({
      name: "Movies: Recently Released Movies",
      before: "off Home",
      after: "on Home",
    });
    expect(await homeOf("1")).toEqual(
      expect.arrayContaining(["movie.recentlyadded.1:h", "movie.recentlyreleased.1:h"]),
    );
    // A retry finds Movies changed and changes nothing; planning it again says it's done.
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: false, stale: true });
    await expect(
      ops.plan(service, { op: "merge-released", intoId: "1", fromId: "3", on: true }, base),
    ).rejects.toThrow(/combined on Home already/);

    const undo = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: false },
      base,
    );
    expect(undo.label).toBe("Separate New Releases from Movies again in Plex");
    // Still scanning Movies from the combine (11-10: the owner's Plex stopped answering): wait.
    plex.scanning("1");
    expect(await ops.run(step(undo.params), service)).toMatchObject({
      ok: false,
      result: expect.stringMatching(/still scanning Movies \(40%\).*Nothing was changed/),
    });
    expect(await lib("1")).toEqual(["/media/movies", "/media/new-releases"]);
    plex.scanning(undefined);
    expect(await ops.run(step(undo.params), service)).toMatchObject({ ok: true });
    expect(await lib("1")).toEqual(["/media/movies"]);
    expect(await shows("3")).toBe("0");
    expect(plex.homeTruth("3")).toEqual(["movie.recentlyadded:h", "movie.recentlyreleased:h"]);
  });

  it("moves a merge to the other library and back in one step each (11-11: rows show under New Releases, then Movies again)", async () => {
    const { ops, lib, homeOf, shows, plex } = setup(true);
    const join = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: true },
      base,
    );
    expect(await ops.run(step(join.params), service)).toMatchObject({ ok: true });

    const move = await ops.plan(
      service,
      { op: "move-released", intoId: "3", fromId: "1", withIds: "1" },
      base,
    );
    expect(move.label).toBe("Show the merged films under New Releases instead of Movies in Plex");
    expect(move.change?.settings).toEqual(
      expect.arrayContaining([
        {
          name: "Folders New Releases reads",
          before: "/media/new-releases",
          after: "/media/new-releases, /media/movies",
        },
        {
          name: "Folders Movies reads",
          before: "/media/movies, /media/new-releases",
          after: "/media/movies",
        },
        {
          name: "Where Movies shows",
          before: "Sidebar, Home and search",
          after: "Sidebar only (not on Home or in search)",
        },
        {
          name: "Where New Releases shows",
          before: "Sidebar only (not on Home or in search)",
          after: "Sidebar, Home and search",
        },
      ]),
    );
    expect(await ops.run(step(move.params), service)).toMatchObject({ ok: true });
    expect(await lib("3")).toEqual(["/media/new-releases", "/media/movies"]);
    expect(await lib("1")).toEqual(["/media/movies"]);
    expect(await shows("1")).toBe("2");
    expect(await shows("3")).toBe("0");
    expect(plex.homeTruth("1").filter((x) => /recentlyadded|recentlyreleased/.test(x))).toEqual([
      "movie.recentlyadded.1:-",
      "movie.recentlyreleased.1:-",
    ]);
    expect(plex.homeTruth("3")).toEqual(["movie.recentlyadded:h", "movie.recentlyreleased:h"]);
    // A retry finds the libraries changed and changes nothing.
    expect(await ops.run(step(move.params), service)).toMatchObject({ ok: false, stale: true });

    // And back: Movies shows the merged rows again, exactly as the first combine left it.
    const back = await ops.plan(
      service,
      { op: "move-released", intoId: "1", fromId: "3", withIds: "3" },
      base,
    );
    expect(await ops.run(step(back.params), service)).toMatchObject({ ok: true });
    expect([...(await lib("1"))].sort()).toEqual(["/media/movies", "/media/new-releases"]);
    expect(await lib("3")).toEqual(["/media/new-releases"]);
    expect(await shows("1")).toBe("0");
    expect(await shows("3")).toBe("2");
    expect(await homeOf("1")).toEqual(
      expect.arrayContaining(["movie.recentlyadded.1:h", "movie.recentlyreleased.1:h"]),
    );
  });

  it("brings your own rows and the films' added dates along when the merge moves (11-13)", async () => {
    // The owner: "recently added and recently released shouldn't affect my custom Thanksgiving
    // and Christmas rows". Plex scans for a while after the move, as a big library does.
    const plex = fakePlex({ newReleases: true });
    let scanningNew = false;
    const fetchImpl: typeof plex.fetch = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === "/library/sections/3/refresh") scanningNew = true;
      if (u.pathname === "/activities" && scanningNew)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            MediaContainer: {
              Activity: [
                {
                  type: "library.update.section",
                  title: "Scanning New Releases",
                  Context: { librarySectionID: "3" },
                },
              ],
            },
          }),
        };
      return plex.fetch(url, init);
    };
    const ops = new PlexOperations(handle, broker, fetchImpl);
    ops.settleMs = 0;
    const call = async (path: string, method = "GET") => {
      const r = await plex.fetch(`${BASE}${path}`, {
        method,
        headers: { Accept: "application/json", "X-Plex-Token": TOKEN },
        signal: AbortSignal.timeout(5000),
      });
      return (await r.json()) as unknown;
    };
    const join = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: true },
      base,
    );
    expect(await ops.run(step(join.params), service)).toMatchObject({ ok: true });
    // One of the owner's own rows in Movies, on Home and friends' Home.
    const made = (await call(
      "/library/collections?type=1&title=Christmas%20Favorites&smart=0&sectionId=1&uri=server%3A%2F%2Fsample-plex-machine%2Fcom.plexapp.plugins.library%2Flibrary%2Fmetadata%2F102%2C101",
      "POST",
    )) as { MediaContainer: { Metadata: { ratingKey: string }[] } };
    const xmas = made.MediaContainer.Metadata[0]!.ratingKey;
    await call(
      `/hubs/sections/1/manage?metadataItemId=${xmas}&promotedToOwnHome=1&promotedToSharedHome=1`,
      "POST",
    );

    const move = await ops.plan(
      service,
      { op: "move-released", intoId: "3", fromId: "1", withIds: "1" },
      base,
    );
    expect(move.change?.settings).toContainEqual({
      name: "Christmas Favorites",
      before: "Home, Friends' Home, from Movies",
      after: "Home, Friends' Home, from New Releases (made again there)",
    });
    expect(move.change?.settings).toContainEqual({
      name: "Note",
      before: "",
      after: expect.stringMatching(/added date back, so Recently Added does not fill/),
    });
    // Time Loop Movies is only in Library Recommended: it stays with Movies.
    expect(move.change?.settings.map((x) => x.name)).not.toContain("Time Loop Movies");

    const moved = await ops.run(step(move.params), service);
    expect(moved).toMatchObject({
      ok: true,
      result: expect.stringMatching(
        /3 added dates put back\. Hearth finishes the rest \(Christmas Favorites\)/,
      ),
    });
    // Every film New Releases lists now keeps the date it was added to Movies.
    type All = {
      MediaContainer: { Metadata: { ratingKey: string; addedAt: number; guid: string }[] };
    };
    const movies = ((await call("/library/sections/1/all")) as All).MediaContainer.Metadata;
    const fresh = ((await call("/library/sections/3/all")) as All).MediaContainer.Metadata;
    expect(fresh).toHaveLength(3);
    for (const f of fresh) expect(f.addedAt).toBe(movies.find((m) => m.guid === f.guid)!.addedAt);
    expect(
      (
        (await call("/library/sections/3/collections")) as {
          MediaContainer: { Metadata: unknown[] };
        }
      ).MediaContainer.Metadata,
    ).toEqual([]);

    // Plex finishes scanning: the row is made in New Releases, same films, same places, placed
    // after the new-title rows.
    scanningNew = false;
    await ops.carry.tick();
    const colls = (
      (await call("/library/sections/3/collections")) as {
        MediaContainer: { Metadata: { ratingKey: string; title: string }[] };
      }
    ).MediaContainer.Metadata;
    expect(colls.map((c) => c.title)).toEqual(["Christmas Favorites"]);
    const kids = (
      (await call(`/library/collections/${colls[0]!.ratingKey}/children`)) as {
        MediaContainer: { Metadata: { guid: string }[] };
      }
    ).MediaContainer.Metadata.map((m) => m.guid);
    expect(kids).toEqual(["plex://movie/sample-102", "plex://movie/sample-101"]);
    expect(plex.homeTruth("3")).toEqual([
      "movie.recentlyadded:h",
      "movie.recentlyreleased:h",
      `custom.collection.3.${colls[0]!.ratingKey}:h`,
    ]);
    expect(await ops.carry.waiting("plex")).toEqual([]);

    // Moving back and forth again brings the same row up to date, never a second one.
    scanningNew = false;
    const back = await ops.plan(
      service,
      { op: "move-released", intoId: "1", fromId: "3", withIds: "3" },
      base,
    );
    expect(await ops.run(step(back.params), service)).toMatchObject({ ok: true });
  });

  it("puts back the added dates a merge made before 11-13 left as the merge's day", async () => {
    // The owner's Movies: 81 films folded in on 11-10 all said "added 11-10 20:17", so Heart of
    // the Beast (added 11-09) sat behind films added after it.
    const { ops, plex } = setup(true);
    const send = (path: string, method = "GET") =>
      plex.fetch(`${BASE}${path}`, {
        method,
        headers: { Accept: "application/json", "X-Plex-Token": TOKEN },
        signal: AbortSignal.timeout(5000),
      });
    // As an old merge left it: New Releases reads Movies' folder, every film dated today.
    await send(
      "/library/sections/3?name=New%20Releases&agent=tv.plex.agents.movie&location=%2Fmedia%2Fnew-releases&location=%2Fmedia%2Fmovies",
      "PUT",
    );
    await send("/library/sections/3/refresh");
    type All = { MediaContainer: { Metadata: { addedAt: number; guid: string }[] } };
    const all = async (id: string) =>
      ((await (await send(`/library/sections/${id}/all`)).json()) as All).MediaContainer.Metadata;
    const movies = await all("1");
    expect(
      (await all("3")).every((f) => f.addedAt > movies.find((m) => m.guid === f.guid)!.addedAt),
    ).toBe(true);

    const planned = await ops.plan(service, { op: "merge-dates", intoId: "3", fromIds: "1" }, base);
    expect(planned.label).toBe("Put back the added dates of 3 films in New Releases in Plex");
    expect(planned.change?.settings[0]).toEqual({
      name: "Added date of 3 films in New Releases",
      before: "the day they were merged in",
      after: "the day they were added to Movies",
    });
    expect(await ops.run(step(planned.params), service)).toMatchObject({
      ok: true,
      result: "3 added dates put back in New Releases (read back).",
    });
    for (const f of await all("3"))
      expect(f.addedAt).toBe(movies.find((m) => m.guid === f.guid)!.addedAt);
    await expect(
      ops.plan(service, { op: "merge-dates", intoId: "3", fromIds: "1" }, base),
    ).rejects.toThrow(/already has its own added date/);
  });

  it("refuses to move a merge while Plex scans, and when nothing is merged", async () => {
    const { ops, lib, plex } = setup(true);
    await expect(
      ops.plan(service, { op: "move-released", intoId: "3", fromId: "1", withIds: "1" }, base),
    ).rejects.toThrow(/no merged libraries to move/);
    const join = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: true },
      base,
    );
    await ops.run(step(join.params), service);
    const move = await ops.plan(
      service,
      { op: "move-released", intoId: "3", fromId: "1", withIds: "1" },
      base,
    );
    plex.scanning("1");
    expect(await ops.run(step(move.params), service)).toMatchObject({
      ok: false,
      result: expect.stringMatching(/still scanning Movies.*Nothing was changed/),
    });
    expect(await lib("3")).toEqual(["/media/new-releases"]);
  });

  it("finishes a combine from before 11-09 (folders only, every film twice) without touching folders", async () => {
    const { ops, lib, shows, plex } = setup(true);
    // As the 0.60 version left it: Movies reads both folders, New Releases still on Home.
    await plex.fetch(
      `${BASE}/library/sections/1?name=Movies&agent=tv.plex.agents.movie&scanner=Plex%20Movie&language=en-US&location=%2Fmedia%2Fmovies&location=%2Fmedia%2Fnew-releases`,
      { method: "PUT", headers: { "X-Plex-Token": TOKEN }, signal: AbortSignal.timeout(5000) },
    );
    await lib("1"); // Plex's first read after an edit still has the old folders.
    const planned = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: true },
      base,
    );
    expect(planned.change?.settings.map((s) => s.name)).not.toContain("Folders Movies reads");
    expect(planned.change?.settings).toContainEqual({
      name: "Where New Releases shows",
      before: "Sidebar, Home and search",
      after: "Sidebar only (not on Home or in search)",
    });
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: true });
    expect(await shows("3")).toBe("2");
    expect(await lib("1")).toEqual(["/media/movies", "/media/new-releases"]);
  });

  it("a combine whose rows went off Home (11-10) is planned again to put them back", async () => {
    const { ops, homeOf, plex } = setup(true);
    const go = async () => {
      const planned = await ops.plan(
        service,
        { op: "merge-released", intoId: "1", fromId: "3", on: true },
        base,
      );
      return ops.run(step(planned.params), service);
    };
    expect(await go()).toMatchObject({ ok: true });
    // Later, a "keep one" save takes Movies' new-title rows off Home: neither library shows them.
    for (const id of ["movie.recentlyadded.1", "movie.recentlyreleased.1"])
      await plex.fetch(`${BASE}/hubs/sections/1/manage/${id}?promotedToOwnHome=0`, {
        method: "PUT",
        headers: { "X-Plex-Token": TOKEN },
        signal: AbortSignal.timeout(5000),
      });
    const again = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: true },
      base,
    );
    // New Releases' rows read as off once it is sidebar-only, so they are taken off again too.
    expect(again.change?.settings.map((s) => s.name).filter((n) => n !== "Note")).toEqual([
      "New Releases: Recently Added Movies",
      "New Releases: Recently Released Movies",
      "Movies: Recently Added Movies",
      "Movies: Recently Released Movies",
    ]);
    expect(await ops.run(step(again.params), service)).toMatchObject({ ok: true });
    expect(await homeOf("1")).toEqual(
      expect.arrayContaining(["movie.recentlyadded.1:h", "movie.recentlyreleased.1:h"]),
    );
  });

  it("warns about the 4K copy when a 4K library is combined", async () => {
    const { ops, plex, lib } = setup(true);
    await plex.fetch(
      `${BASE}/library/sections/3?name=4K&agent=tv.plex.agents.movie&scanner=Plex%20Movie&language=en-US&location=%2Fmedia%2Fnew-releases`,
      { method: "PUT", headers: { "X-Plex-Token": TOKEN }, signal: AbortSignal.timeout(5000) },
    );
    await lib("1"); // Plex's first read after an edit still has the old folders.
    const planned = await ops.plan(
      service,
      { op: "merge-released", intoId: "1", fromId: "3", on: true },
      base,
    );
    expect(JSON.stringify(planned.change?.settings)).toMatch(/may be offered the 4K copy/);
  });

  it("refuses merging a movie library with a show library", async () => {
    const { ops } = setup(true);
    await expect(
      ops.plan(service, { op: "merge-released", intoId: "1", fromId: "2", on: true }, base),
    ).rejects.toThrow(/must be movies/);
  });
});
