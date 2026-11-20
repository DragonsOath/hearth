import { describe, expect, it } from "vitest";
import type { HomeRowsOptions } from "../../data/homeRows";
import {
  carriedOf,
  extraAdded,
  halfJoined,
  keeperOf,
  kindStatus,
  onHome,
  pickedOf,
  setupFrom,
  setupOf,
  setupSteps,
  type Setup,
} from "./HomeSetup";

// Home screen setup (11-10): the owner's Plex as it is, Movies with New Releases combined in,
// Stand Up Specials on its own. Row ids without the library number, as the real Plex names them.

const on = { home: true };
const off = { home: false };
const opts = (nrHidden = "2"): HomeRowsOptions => ({
  libraries: [
    { id: "2", title: "Movies", type: "movie", folders: ["/f/nr", "/f/movies"], visibility: "0" },
    { id: "1", title: "New Releases", type: "movie", folders: ["/f/nr"], visibility: nrHidden },
    { id: "7", title: "Stand Up Specials", type: "movie", folders: ["/f/comedy"], visibility: "0" },
    { id: "3", title: "TV Shows", type: "show", folders: ["/d/shows"], visibility: "0" },
  ],
  merge: true,
  genres: {},
  rows: {
    "2": [
      {
        id: "movie.recentlyadded",
        title: "Recently Added Movies",
        home: true,
        shared: false,
        recommended: true,
      },
      {
        id: "movie.recentlyreleased",
        title: "Recently Released Movies",
        home: true,
        shared: false,
        recommended: true,
      },
    ],
    "1": [],
    "7": [],
    "3": [],
  },
  collections: {},
});
const rows = (standUp = on) => ({
  "2": [
    { id: "movie.recentlyadded", flags: on },
    { id: "movie.recentlyreleased", flags: on },
  ],
  "1": [
    { id: "movie.recentlyadded", flags: off },
    { id: "movie.recentlyreleased", flags: off },
  ],
  "7": [
    { id: "movie.recentlyadded", flags: standUp },
    { id: "movie.recentlyreleased", flags: on },
  ],
  "3": [{ id: "tv.recentlyadded", flags: on }],
});

describe("Merge rows on Home", () => {
  it("reads what Plex has: New Releases merged into Movies, Stand Up Specials on its own", () => {
    const o = opts();
    const base = setupOf(o);
    expect(base).toEqual({ merge: true, joins: [{ into: "2", from: "1" }] });
    expect(pickedOf(o, base)).toEqual({ movie: ["2", "1"], show: [] });
    expect(onHome(o, base, base, "movie").map((l) => l.title)).toEqual([
      "Movies",
      "Stand Up Specials",
    ]);
    expect(halfJoined(o)).toEqual([]);
    // Folders in, but New Releases still on Home: its films show twice.
    expect(halfJoined(opts("0"))).toEqual([{ into: "2", from: "1" }]);
  });

  it("merges the libraries tapped on into the one Plex has already; the rest keep their rows", () => {
    const o = opts();
    const base = setupOf(o);
    // Nothing tapped differently: nothing changes, Merge Recently Added stays as it is.
    expect(setupFrom(o, base, pickedOf(o, base))).toEqual(base);
    expect(kindStatus(o, base, pickedOf(o, base), "movie")).toBe("saved");
    // Stand Up Specials tapped on too: it joins Movies.
    const all = setupFrom(o, base, { movie: ["2", "1", "7"], show: [] });
    expect(all.joins).toEqual([
      { into: "2", from: "1" },
      { into: "2", from: "7" },
    ]);
    expect(all.merge).toBe(true);
    expect(kindStatus(o, base, { movie: ["2", "1", "7"], show: [] }, "movie")).toBe("changed");
    // New Releases tapped off: separated. Merge Recently Added is its own choice: it stays as it
    // is until you change it (11-11, "an option not a force").
    const none = setupFrom(o, base, { movie: ["2"], show: [] });
    expect(none).toEqual({ merge: true, joins: [] });
    expect(setupFrom(o, base, { movie: ["2"], show: [] }, {}, false)).toEqual({
      merge: false,
      joins: [],
    });
    // Recently Released merged, Recently Added left as a row per library.
    expect(setupFrom(o, base, { movie: ["2", "1"], show: [] }, {}, false)).toEqual({
      merge: false,
      joins: [{ into: "2", from: "1" }],
    });
    // Plex without the setting: nothing to choose.
    expect(setupFrom(o, { ...base, merge: null }, { movie: [], show: [] }, {}, true).merge).toBe(
      null,
    );
    expect(keeperOf(o, base, ["1", "7"])).toBe("1");
    expect(keeperOf(o, base, ["2", "7"])).toBe("2");
  });

  it("takes a duplicate Recently Added row off by itself, never asking", () => {
    const o = opts();
    const base = setupOf(o);
    expect(extraAdded(o, base, base, rows())).toEqual(["7"]);
    expect(extraAdded(o, base, base, rows(off))).toEqual([]);
    expect(extraAdded(o, base, { ...base, merge: false }, rows())).toEqual([]);
  });

  it("plans it with the rows: merge first, separate before combine, rows left to those steps", () => {
    const o = opts();
    const base = setupOf(o);
    const next: Setup = { merge: false, joins: [{ into: "2", from: "7" }] };
    const plan = setupSteps(o, base, next);
    expect(plan.before).toEqual([{ op: "merge-recent", on: false }]);
    expect(plan.after).toEqual([
      { op: "merge-released", intoId: "2", fromId: "1", on: false },
      { op: "merge-released", intoId: "2", fromId: "7", on: true },
    ]);
    expect(plan.skip("1")).toBe(true);
    expect(plan.skip("7")).toBe(true);
    expect(plan.skip("2", "movie.recentlyreleased")).toBe(true);
    expect(plan.skip("2", "custom.collection.2.5")).toBe(false);
    expect(plan.skip("3")).toBe(false);
    expect(setupSteps(o, base, base)).toMatchObject({ before: [], after: [] });
  });

  it("moves the merged rows to the other library in one step, and back (11-11: toggle back and forth)", () => {
    const o = opts();
    const base = setupOf(o);
    const picked = pickedOf(o, base);
    const moved = setupFrom(o, base, picked, { movie: "1" });
    expect(moved.joins).toEqual([{ into: "1", from: "2" }]);
    expect(kindStatus(o, base, picked, "movie", moved)).toBe("changed");
    expect(kindStatus(o, base, picked, "movie", base)).toBe("saved");
    const plan = setupSteps(o, base, moved);
    expect(plan.after).toEqual([{ op: "move-released", intoId: "1", fromId: "2", withIds: "2" }]);
    expect(plan.skip("1")).toBe(true);
    expect(plan.skip("2")).toBe(true);
    expect(plan.skip("3")).toBe(false);
    // Moving and adding Stand Up Specials too: still one step, each library changed once.
    const more = setupFrom(o, base, { ...picked, movie: [...picked.movie, "7"] }, { movie: "1" });
    expect(setupSteps(o, base, more).after).toEqual([
      { op: "move-released", intoId: "1", fromId: "2", withIds: "2,7" },
    ]);
  });

  it("names your own Home rows that come along when the merged rows move (11-13)", () => {
    const o = opts();
    o.rows["2"]!.push(
      {
        id: "custom.collection.2.104942",
        title: "Christmas Favorites",
        home: true,
        shared: true,
        recommended: true,
      },
      {
        id: "custom.collection.2.107822",
        title: "Thanksgiving Movies",
        home: true,
        shared: false,
        recommended: false,
      },
      {
        id: "custom.collection.2.52300",
        title: "Time Loop Movies",
        home: false,
        shared: false,
        recommended: true,
      },
    );
    const base = setupOf(o);
    const picked = pickedOf(o, base);
    expect(carriedOf(o, base, base, "movie")).toEqual([]);
    const moved = setupFrom(o, base, picked, { movie: "1" });
    expect(carriedOf(o, base, moved, "movie")).toEqual([
      "Christmas Favorites",
      "Thanksgiving Movies",
    ]);
  });
});
