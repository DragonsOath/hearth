import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeHomeRow, plexRowQuery } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import type { CredentialBroker } from "../credentials/broker";
import { openDatabase, runMigrations } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep } from "../jobs/operations";
import { fakePlex } from "./fake-plex";
import type { Fetch } from "./http";
import { PlexOperations } from "./plex-control";

// Home Rows phase one (design "Home Rows: design for DC"): a row from Plex's own filters becomes a
// smart collection Hearth creates, promotes and places; Undo and a failed apply put the library's
// rows back exactly; Hearth finds its collection by Plex's id, never by title.

const BASE = "http://10.0.0.9:32400";
const service = { id: "plex", name: "Plex", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: "e2e-plex-token" }),
} as unknown as CredentialBroker;
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

async function setup(fetchWrap?: (f: Fetch) => Fetch) {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Home Server",
    role: "server",
    os: "Linux",
    address: "127.0.0.1",
    cpuModel: "x",
    cpuCores: 8,
    cpuUsagePct: 0,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 1,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeenAt: "2026-11-06T00:00:00Z",
  });
  await handle.db.insert(t.services).values({
    id: "plex",
    name: "Plex",
    category: "media",
    hostId: "h1",
    kind: "container",
    image: "plexinc/pms-docker",
    localUrl: BASE,
    health: "healthy",
    autonomyArea: "media",
  });
  const plex = fakePlex();
  const fetchImpl = fetchWrap ? fetchWrap(plex.fetch) : plex.fetch;
  const ops = new PlexOperations(handle, broker, fetchImpl);
  // The same rows, read straight from the stand-in.
  const { HomeRows } = await import("./home-rows");
  const rows = new HomeRows(handle, broker, fetchImpl);
  const hubs = async () => (await rows.options("plex")).rows["1"]!;
  return { handle, plex, ops, rows, hubs };
}

const DRAMA = {
  serviceId: "plex",
  libraryId: "1",
  libraryName: "Movies",
  name: "Drama Night",
  rules: { genres: ["Drama"], yearFrom: 2015, yearTo: 2022 },
  sort: "rating",
  limit: 20,
  placement: { home: true },
  after: "",
};

describe("Home Rows: the rules as Plex's filter", () => {
  it("makes inclusive years and ratings into Plex's strict operators, with genre ids", () => {
    const q = plexRowQuery(
      {
        rules: { yearFrom: 1980, yearTo: 1989, unwatched: true, minRating: 7 },
        sort: "random",
        limit: 30,
      },
      { type: 1, genreIds: ["1003"] },
    );
    expect(q).toBe(
      "type=1&genre=1003&year>>=1979&year<<=1990&unwatched=1&audienceRating>>=6.95&sort=random&limit=30",
    );
    expect(
      describeHomeRow({
        rules: { genres: ["Horror"], yearFrom: 1980, yearTo: 1989 },
        sort: "random",
        limit: 30,
      }),
    ).toBe("Horror, 1980 to 1989; random, up to 30");
  });
});

describe("Home Rows on Plex", () => {
  it("saves a row, previews its posters, applies it first on Home, and undoes it exactly", async () => {
    const { ops, rows, hubs } = await setup();
    const row = await rows.save(DRAMA);
    expect(row).toMatchObject({
      name: "Drama Night",
      placement: { home: true, recommended: false },
    });
    // Did I build the right row? Two dramas from 2015 to 2022, best rated first.
    const preview = await rows.preview(DRAMA);
    expect(preview.titles.map((x) => x.title)).toEqual(["Quiet Harbor", "Harbor Lights"]);

    const before = await hubs();
    const plan = await ops.plan(service, { op: "home-row-apply", rowId: row.id }, base);
    expect(plan.label).toBe("Apply the Home row “Drama Night” to Plex");
    const shown = Object.fromEntries(plan.change!.settings.map((s) => [s.name, s.after]));
    expect(shown["“Drama Night”"]).toMatch(
      /Drama, 2015 to 2022; highest rated, up to 20 \(2 titles now\)/,
    );
    expect(shown["Shows on"]).toBe("Home");
    expect(shown.Position).toBe("first in Movies");
    expect(shown.Collection).toMatch(/new smart collection/);

    const done = await ops.run(step(plan.params), service);
    expect(done).toMatchObject({ ok: true, verified: true });
    expect(done.result).toMatch(/“Drama Night” is on Plex: 2 titles, on Home, first/);
    const after = await hubs();
    expect(after[0]).toMatchObject({
      title: "Drama Night",
      home: true,
      recommended: false,
      hearth: row.id,
    });
    expect(after.slice(1).map((h) => h.id)).toEqual(before.map((h) => h.id));
    const saved = await rows.get(row.id);
    expect(saved?.published?.hubId).toBe(after[0]!.id);
    expect(saved?.undoable).toBeTruthy();

    // Undo: the collection goes and the library's rows are exactly as before.
    const undo = await ops.plan(service, { op: "home-row-undo", rowId: row.id }, base);
    expect(undo.change!.settings[0]!.after).toMatch(/taken off Plex/);
    expect(await ops.run(step(undo.params), service)).toMatchObject({ ok: true, verified: true });
    expect((await hubs()).map((h) => `${h.id}:${h.home}${h.recommended}`)).toEqual(
      before.map((h) => `${h.id}:${h.home}${h.recommended}`),
    );
    expect((await rows.get(row.id))?.published).toBeUndefined();
    await rows.remove(row.id);
    expect(await rows.get(row.id)).toBeUndefined();
  });

  it("applies a changed row to the same collection, after a chosen row, and undo restores its rules", async () => {
    const { ops, rows, hubs } = await setup();
    const row = await rows.save(DRAMA);
    await ops.run(
      step((await ops.plan(service, { op: "home-row-apply", rowId: row.id }, base)).params),
      service,
    );
    const key = (await rows.get(row.id))!.published!.collectionKey;
    // A published row can't be deleted from Hearth before it is undone on Plex.
    await expect(rows.remove(row.id)).rejects.toThrow(/Undo/);

    await rows.save(
      {
        ...DRAMA,
        name: "Mysteries",
        rules: { genres: ["Mystery"] },
        after: "movie.recentlyadded.1",
      },
      row.id,
    );
    const plan = await ops.plan(service, { op: "home-row-apply", rowId: row.id }, base);
    expect(Object.fromEntries(plan.change!.settings.map((s) => [s.name, s.after])).Position).toBe(
      "after “Recently Added Movies” in Movies",
    );
    const done = await ops.run(step(plan.params), service);
    expect(done).toMatchObject({ ok: true });
    expect(done.result).toMatch(/1 title/);
    const now = await hubs();
    const at = now.findIndex((h) => h.title === "Mysteries");
    expect(now[at - 1]!.id).toBe("movie.recentlyadded.1");
    expect((await rows.get(row.id))!.published!.collectionKey).toBe(key);

    // Undo goes back to Drama Night, first.
    await ops.run(
      step((await ops.plan(service, { op: "home-row-undo", rowId: row.id }, base)).params),
      service,
    );
    const back = await hubs();
    expect(back[0]!.title).toBe("Drama Night");
  });

  it("puts everything back when Plex refuses partway", async () => {
    let refuse = false;
    const { ops, rows, hubs } = await setup(
      (f) => async (url, init) =>
        refuse && url.includes("/move?")
          ? { ok: false, status: 500, json: async () => ({}) }
          : f(url, init),
    );
    const row = await rows.save({ ...DRAMA, after: "movie.recentlyreleased.1" });
    const before = (await hubs()).map((h) => h.id);
    const plan = await ops.plan(service, { op: "home-row-apply", rowId: row.id }, base);
    refuse = true;
    const out = await ops.run(step(plan.params), service);
    refuse = false;
    expect(out.ok).toBe(false);
    expect(out.result).toMatch(/refused moving a row.*put everything back/);
    expect((await hubs()).map((h) => h.id)).toEqual(before);
    expect((await rows.get(row.id))?.published).toBeUndefined();
  });

  it("refuses a plan when the library's rows changed in Plex since", async () => {
    const { ops, rows } = await setup();
    const row = await rows.save(DRAMA);
    const plan = await ops.plan(service, { op: "home-row-apply", rowId: row.id }, base);
    const other = await ops.plan(
      service,
      {
        op: "set-rows",
        libraryId: "1",
        rows: JSON.stringify({ "movie.recentlyreleased.1": { home: true } }),
      },
      base,
    );
    await ops.run(step(other.params), service);
    expect(await ops.run(step(plan.params), service)).toMatchObject({ ok: false, stale: true });
  });

  it("makes a row of hand-picked titles from one step (Ember's way), on Home, and undoes it", async () => {
    const { ops, rows, hubs } = await setup();
    const before = (await hubs()).map((h) => h.id);
    // 11-06: "make me a Thanksgiving collection and make it a row": no genre needed.
    const row = JSON.stringify({
      name: "Thanksgiving",
      libraryId: "1",
      rules: { titles: ["103", "101"] },
      placement: { home: true },
    });
    const plan = await ops.plan(service, { op: "home-row-apply", row }, base);
    const shown = Object.fromEntries(plan.change!.settings.map((x) => [x.name, x.after]));
    expect(shown["“Thanksgiving”"]).toMatch(/2 hand-picked titles \(2 titles now\)/);
    expect(shown.Collection).toBe("a new collection of exactly these 2 titles");
    // Nothing is saved until it runs.
    expect(await rows.list("plex")).toEqual([]);
    const done = await ops.run(step(plan.params), service);
    expect(done).toMatchObject({ ok: true, verified: true });
    expect(done.result).toMatch(/“Thanksgiving” is on Plex: 2 titles, on Home, first/);
    const saved = (await rows.list("plex"))[0]!;
    expect(saved).toMatchObject({ name: "Thanksgiving", rules: { titles: ["103", "101"] } });
    expect((await hubs())[0]).toMatchObject({
      title: "Thanksgiving",
      home: true,
      hearth: saved.id,
    });
    expect((await rows.preview(saved)).titles.map((x) => x.title)).toEqual([
      "Ember Lake",
      "Harbor Lights",
    ]);

    // A changed list goes to the same collection: one out, one in.
    await rows.save({ ...saved, rules: { titles: ["101", "102"] } }, saved.id);
    const again = await ops.run(
      step((await ops.plan(service, { op: "home-row-apply", rowId: saved.id }, base)).params),
      service,
    );
    expect(again).toMatchObject({ ok: true });
    expect((await rows.get(saved.id))!.published!.collectionKey).toBe(
      saved.published!.collectionKey,
    );

    // One title added with the + (11-11): into the row's own list too, so it stays.
    const addPlan = await ops.plan(
      service,
      { op: "home-row-apply", rowId: saved.id, addTitle: "103" },
      base,
    );
    expect(addPlan.label).toBe("Add a title to the Home row “Thanksgiving” in Plex");
    expect(await ops.run(step(addPlan.params), service)).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((await rows.get(saved.id))!.rules.titles).toEqual(["101", "102", "103"]);
    expect((await rows.preview((await rows.get(saved.id))!)).titles).toHaveLength(3);
    await expect(
      ops.plan(service, { op: "home-row-apply", rowId: saved.id, addTitle: "103" }, base),
    ).rejects.toThrow(/in the row already/);

    // Undo the last apply: back to the first two titles; then undo needs a new apply first.
    const undo = await ops.plan(service, { op: "home-row-undo", rowId: saved.id }, base);
    expect(await ops.run(step(undo.params), service)).toMatchObject({ ok: true });
    expect((await hubs())[0]!.title).toBe("Thanksgiving");
    expect((await hubs()).map((h) => h.id).filter((id) => before.includes(id))).toEqual(before);
  });

  it("lists every movie and show for Ember, and puts a mixed theme on Home as one row per library", async () => {
    const { ops, rows } = await setup();
    // 11-06: "a horror theme but there's also horror TV shows ... a row of mixed stuff".
    const cat = await rows.catalog("plex");
    expect(cat.libraries.map((l) => l.type)).toEqual(["movie", "show"]);
    expect(cat.titles.find((x) => x.ratingKey === "102")).toMatchObject({
      title: "Quiet Harbor",
      kind: "movie",
      libraryId: "1",
      genres: ["Drama", "Mystery"],
      rating: 8.1,
      thumb: "/library/metadata/102/thumb/1",
    });
    expect(cat.titles.find((x) => x.ratingKey === "200")).toMatchObject({
      kind: "show",
      libraryId: "2",
      genres: ["Mystery"],
    });
    expect(cat.titles.some((x) => x.ratingKey === "210")).toBe(false); // no seasons
    // One plan, one step per library, same name.
    const movies = await ops.plan(
      service,
      {
        op: "home-row-apply",
        row: JSON.stringify({ name: "Mystery Night", libraryId: "1", rules: { titles: ["102"] } }),
      },
      base,
    );
    const shows = await ops.plan(
      service,
      {
        op: "home-row-apply",
        row: JSON.stringify({ name: "Mystery Night", libraryId: "2", rules: { titles: ["200"] } }),
      },
      base,
    );
    expect(await ops.run(step(movies.params), service)).toMatchObject({ ok: true, verified: true });
    expect(await ops.run(step(shows.params), service)).toMatchObject({ ok: true, verified: true });
    const saved = await rows.list("plex");
    expect(saved.map((r) => [r.name, r.libraryId]).sort()).toEqual([
      ["Mystery Night", "1"],
      ["Mystery Night", "2"],
    ]);
    const o = await rows.options("plex");
    expect(o.rows["1"]![0]).toMatchObject({ title: "Mystery Night", home: true });
    expect(o.rows["2"]![0]).toMatchObject({ title: "Mystery Night", home: true });
  });

  it("lists every collection, and one Send puts Plex's own row and a collection on Home, in place", async () => {
    const { ops, rows, hubs } = await setup();
    // 11-07: "all of my collections, recently added, recently released ... needs to be an option".
    const o = await rows.options("plex");
    expect(o.collections["1"]).toEqual([{ key: "9003", title: "Harbor Classics", count: 2 }]);
    // The editor's one plan: Recently Released onto Home and first, then the collection after it.
    const before = await hubs();
    const order = [
      "movie.recentlyreleased.1",
      ...before.map((h) => h.id).filter((id) => id !== "movie.recentlyreleased.1"),
    ];
    const setRows = await ops.plan(
      service,
      {
        op: "set-rows",
        libraryId: "1",
        rows: JSON.stringify({
          "movie.recentlyreleased.1": { recommended: true, home: true, shared: false },
        }),
        order: JSON.stringify(order),
      },
      base,
    );
    const coll = await ops.plan(
      service,
      {
        op: "home-collection-row",
        libraryId: "1",
        collectionKey: "9003",
        flags: "-h-",
        after: "movie.recentlyreleased.1",
      },
      base,
    );
    expect(Object.fromEntries(coll.change!.settings.map((x) => [x.name, x.after]))).toMatchObject({
      "“Harbor Classics”": "a row on Home",
      Position: "after “Recently Released Movies” in Movies",
    });
    expect(await ops.run(step(setRows.params), service)).toMatchObject({ ok: true });
    // The collection step still runs although the rows moved since it was planned.
    expect(await ops.run(step(coll.params), service)).toMatchObject({ ok: true, verified: true });
    const now = await hubs();
    expect(now.slice(0, 2).map((h) => [h.title, h.home])).toEqual([
      ["Recently Released Movies", true],
      ["Harbor Classics", true],
    ]);
    expect((await rows.options("plex")).collections["1"]![0]!.row).toBe("custom.collection.1.9003");
    // Twice is refused: it is a row now.
    await expect(
      ops.plan(service, { op: "home-collection-row", libraryId: "1", collectionKey: "9003" }, base),
    ).rejects.toThrow(/is a row already/);
    // Posters: the collection's titles, and the titles in one of Plex's own rows.
    expect(
      (await rows.posters("plex", "1", "custom.collection.1.9003")).titles.map((t) => t.title),
    ).toEqual(["Harbor Lights", "Quiet Harbor"]);
    expect(
      (await rows.posters("plex", "1", "movie.recentlyadded.1")).titles.length,
    ).toBeGreaterThan(0);
  });

  it("reads libraries in the owner's sidebar order, and fills Plex's own rows with posters", async () => {
    const { rows } = await setup();
    // 11-07: "I just want to read the rows in the same order as Plex is".
    expect((await rows.options("plex")).libraries.map((l) => l.title)).toEqual([
      "Movies",
      "TV Shows",
    ]);
    await rows.setLibraryOrder("plex", ["2", "1"]);
    expect((await rows.options("plex")).libraries.map((l) => l.title)).toEqual([
      "TV Shows",
      "Movies",
    ]);
    await expect(rows.setLibraryOrder("plex", ["x"])).rejects.toThrow(/list of library ids/);
    // A row Plex does not list in the library's page right now is filled the way Plex does.
    const top = await rows.posters("plex", "1", "movie.topunwatched.1", "Top Unwatched");
    expect(top.titles.length).toBeGreaterThan(0);
    // Matched by title when the id differs.
    const byTitle = await rows.posters("plex", "1", "movie.other.1", "Recently Added Movies");
    expect(byTitle.titles.length).toBeGreaterThan(0);
  });

  it("shows a merge not saved yet as Plex will: both libraries' titles in one row, newest first (11-13)", async () => {
    const { rows } = await setup();
    // Plex's own row for Movies alone, and the same row with TV Shows merged in.
    const alone = await rows.posters("plex", "1", "movie.recentlyadded.1", "Recently Added Movies");
    expect(alone.titles.map((t) => t.title)).not.toContain("Signal Hill");
    const merged = await rows.posters("plex", "1", "movie.recentlyadded.1", "", ["2"]);
    expect(merged.titles.map((t) => t.title)).toEqual([
      "Ember Lake",
      "Harbor Lights",
      "Quiet Harbor",
      "Signal Hill",
    ]);
  });

  it("sorts Recently Released by home release as a switch, and puts every date back when off (11-13)", async () => {
    // The owner: Heart of the Beast (theaters in September, digital in November) should count
    // as newer than Masterplan (straight to streaming in October).
    const RADARR = "http://10.0.0.9:7878";
    const radarr: { tmdbId: number; inCinemas?: string; digitalRelease?: string }[] = [
      // Harbor Lights: in theaters, then digital two months later.
      { tmdbId: 9101, inCinemas: "2019-04-20T00:00:00Z", digitalRelease: "2019-06-20T00:00:00Z" },
      // Quiet Harbor: a re-release years later (a new disc) keeps its own date.
      { tmdbId: 9102, digitalRelease: "2026-10-16T00:00:00Z" },
      // Ember Lake: no home date, keeps Plex's.
      { tmdbId: 9103 },
    ];
    const { handle, plex, ops } = await setup(
      (f) => async (url, init) =>
        url.startsWith(RADARR) ? { ok: true, status: 200, json: async () => radarr } : f(url, init),
    );
    await handle.db.insert(t.services).values({
      id: "radarr",
      name: "Radarr",
      category: "media",
      hostId: "h1",
      kind: "container",
      image: "linuxserver/radarr",
      localUrl: RADARR,
      health: "healthy",
      autonomyArea: "media",
    });
    const dates = async () => {
      const r = await plex.fetch(`${BASE}/library/sections/1/all`, {
        method: "GET",
        headers: { "X-Plex-Token": "e2e-plex-token" },
        signal: AbortSignal.timeout(5000),
      });
      const list = (
        (await r.json()) as {
          MediaContainer: { Metadata: { title: string; originallyAvailableAt?: string }[] };
        }
      ).MediaContainer.Metadata;
      return Object.fromEntries(list.map((m) => [m.title, m.originallyAvailableAt]));
    };
    const before = await dates();
    expect(before).toMatchObject({ "Harbor Lights": "2019-06-01", "Quiet Harbor": "2021-06-01" });

    const on = await ops.plan(service, { op: "digital-dates", on: true }, base);
    expect(on.label).toBe("Sort Recently Released by home release in Plex");
    expect(on.change?.settings).toContainEqual({
      name: "Films given their home release date",
      before: "",
      after: "1",
    });
    expect(await ops.run(step(on.params), service)).toMatchObject({ ok: true });
    expect(await dates()).toEqual({ ...before, "Harbor Lights": "2019-06-20" });
    const { HomeRows } = await import("./home-rows");
    expect((await new HomeRows(handle, broker, plex.fetch).options("plex")).digitalDates).toBe(
      true,
    );
    await expect(ops.plan(service, { op: "digital-dates", on: true }, base)).rejects.toThrow(
      /already on/,
    );

    // A new film while it is on gets its home date on the next check.
    radarr[2] = { tmdbId: 9103, digitalRelease: "2026-08-01T00:00:00Z" };
    await ops.digital.tick();
    expect((await dates())["Ember Lake"]).toBe("2026-08-01");

    const off = await ops.plan(service, { op: "digital-dates", on: false }, base);
    expect(await ops.run(step(off.params), service)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/^2 release dates put back/),
    });
    expect(await dates()).toEqual(before);
    expect((await new HomeRows(handle, broker, plex.fetch).options("plex")).digitalDates).toBe(
      false,
    );
  });

  it("makes a collection only, with no row, when it is shown nowhere", async () => {
    const { ops, rows, hubs } = await setup();
    // 11-07: "maybe you just want to build a collection".
    const before = (await hubs()).map((h) => h.id);
    const row = JSON.stringify({
      name: "Rainy Day",
      libraryId: "1",
      rules: { titles: ["101", "102"] },
      placement: { home: false, recommended: false, shared: false },
    });
    const plan = await ops.plan(service, { op: "home-row-apply", row }, base);
    expect(plan.change!.settings.find((x) => x.name === "Shows on")!.after).toBe(
      "nowhere yet: a collection only",
    );
    const done = await ops.run(step(plan.params), service);
    expect(done).toMatchObject({ ok: true, verified: true });
    expect(done.result).toMatch(/is a collection on Plex: 2 titles, not on Home/);
    expect((await hubs()).map((h) => h.id)).toEqual(before);
    const o = await rows.options("plex");
    expect(o.collections["1"]!.find((c) => c.title === "Rainy Day")).toMatchObject({ count: 2 });
    expect(o.collections["1"]!.find((c) => c.title === "Rainy Day")!.row).toBeUndefined();
  });

  it("refuses titles Plex does not have in that library", async () => {
    const { ops } = await setup();
    const row = JSON.stringify({ name: "Nope", libraryId: "1", rules: { titles: ["200", "999"] } });
    await expect(ops.plan(service, { op: "home-row-apply", row }, base)).rejects.toThrow(
      /Movies in Plex has no title with ratingKeys 200, 999/,
    );
  });

  it("says plainly when a genre isn't in the library", async () => {
    const { rows } = await setup();
    await expect(rows.preview({ ...DRAMA, rules: { genres: ["Western"] } })).rejects.toThrow(
      /Movies has no genre called Western/,
    );
  });
});

describe("Saved home screens", () => {
  it("saves home screens by name, switches between them, and undoes a switch", async () => {
    const { ops, rows, hubs } = await setup();
    const normal = await rows.saveLayout("plex", "Normal");
    expect(normal.active).toBe(true);
    // Build a second screen: a Hearth row first on Home.
    const row = await rows.save(DRAMA);
    await ops.run(
      step((await ops.plan(service, { op: "home-row-apply", rowId: row.id }, base)).params),
      service,
    );
    const holiday = await rows.saveLayout("plex", "Holiday");
    expect((await rows.layouts("plex")).layouts.map((l) => [l.name, l.active])).toEqual([
      ["Normal", false],
      ["Holiday", true],
    ]);

    // Back to Normal: the Hearth row is hidden (not deleted), the order is as saved.
    const plan = await ops.plan(service, { op: "home-layout-apply", layoutId: normal.id }, base);
    expect(plan.label).toBe("Switch the Plex home screen to “Normal” in Plex");
    const shown = Object.fromEntries(
      plan.change!.settings.map((x) => [x.name, `${x.before} > ${x.after}`]),
    );
    expect(shown["Movies: Drama Night"]).toBe("Home > Hidden");
    expect(await ops.run(step(plan.params), service)).toMatchObject({ ok: true, verified: true });
    const now = await hubs();
    expect(now.find((h) => h.title === "Drama Night")).toMatchObject({
      home: false,
      recommended: false,
    });
    expect(now[0]!.title).toBe("Continue Watching");
    expect((await rows.get(row.id))?.published).toBeTruthy();
    expect((await rows.layouts("plex")).layouts.find((l) => l.active)?.name).toBe("Normal");

    // And Holiday again: the row is back, first on Home.
    await ops.run(
      step(
        (await ops.plan(service, { op: "home-layout-apply", layoutId: holiday.id }, base)).params,
      ),
      service,
    );
    expect((await hubs())[0]).toMatchObject({ title: "Drama Night", home: true });
    // Already showing: nothing to plan.
    await expect(
      ops.plan(service, { op: "home-layout-apply", layoutId: holiday.id }, base),
    ).rejects.toThrow(/already shows “Holiday”/);

    // Undo the last switch: Normal again.
    const undo = await ops.plan(service, { op: "home-layout-undo" }, base);
    expect(await ops.run(step(undo.params), service)).toMatchObject({ ok: true });
    expect((await hubs())[0]!.title).toBe("Continue Watching");
    expect((await rows.layouts("plex")).layouts.find((l) => l.active)?.name).toBe("Normal");
    await rows.removeLayout(holiday.id);
    expect((await rows.layouts("plex")).layouts.map((l) => l.name)).toEqual(["Normal"]);
  });

  it("puts the home screen back when Plex refuses partway through a switch", async () => {
    let refuse = false;
    const { ops, rows, hubs } = await setup(
      (f) => async (url, init) =>
        refuse && url.includes("promotedToOwnHome=0")
          ? { ok: false, status: 500, json: async () => ({}) }
          : f(url, init),
    );
    const bare = await rows.saveLayout("plex", "Bare");
    const row = await rows.save(DRAMA);
    await ops.run(
      step((await ops.plan(service, { op: "home-row-apply", rowId: row.id }, base)).params),
      service,
    );
    const before = (await hubs()).map((h) => `${h.id}:${h.home}`);
    const plan = await ops.plan(service, { op: "home-layout-apply", layoutId: bare.id }, base);
    refuse = true;
    const out = await ops.run(step(plan.params), service);
    refuse = false;
    expect(out.ok).toBe(false);
    expect(out.result).toMatch(/put the home screen back as it was/);
    expect((await hubs()).map((h) => `${h.id}:${h.home}`)).toEqual(before);
  });
});
