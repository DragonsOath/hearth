import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NearMiss } from "@dragon-control/core";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import { nearMissAnalyzer } from "../findings/analyzers/near-misses";
import type { Arr } from "./crucible-apply";
import { NearMissWatch } from "./crucible-near-miss";

/** Near misses on their own (the Crucible, step 8): a small daily budget, oldest missing first. */

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function library() {
  const movies = [
    { id: 1, title: "Snow Lantern", year: 1987, monitored: true, hasFile: false, added: ago(40) },
    { id: 2, title: "Glass Meridian", year: 1994, monitored: true, hasFile: false, added: ago(30) },
    { id: 3, title: "Night Ferry", year: 2001, monitored: true, hasFile: false, added: ago(20) },
    { id: 4, title: "Brand New", year: 2026, monitored: true, hasFile: false, added: ago(2) },
    { id: 5, title: "Already Here", year: 2010, monitored: true, hasFile: true, added: ago(90) },
    { id: 6, title: "Not Wanted", year: 2010, monitored: false, hasFile: false, added: ago(90) },
  ];
  const arr: Arr = async (_m, p) =>
    p === "/api/v3/movie"
      ? { ok: true, status: 200, data: movies as never }
      : { ok: false, status: 404, data: undefined as never };
  return { movies, arr };
}

const blocked = (sizeGB: number): NearMiss => ({
  kind: "blocked",
  found: 3,
  reasons: [{ why: "size", words: "over your size limit", count: 3 }],
  sizeOnly: 3,
  capGB: 8,
  closest: {
    guid: "g1",
    indexerId: 7,
    title: "Snow.Lantern.1987.1080p",
    sizeGB,
    quality: "Bluray-1080p",
    approved: false,
    rejections: [],
  },
  sentence: `Found 3 releases, but your own rules turned every one down. All are only over your size limit of 8 GB. Closest: ${sizeGB} GB Bluray-1080p.`,
});

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  const lib = library();
  const searched: number[] = [];
  let clock = NOW;
  const watch = new NearMissWatch(handle, {
    radarrs: async () => [{ id: "radarr", name: "Radarr", localUrl: "http://10.0.0.5:7879" }],
    arrFor: () => lib.arr,
    search: async (_s, movieId) => {
      searched.push(movieId);
      return movieId === 1
        ? blocked(8.9)
        : {
            kind: "none",
            sentence: "No releases found at all. Your indexers have nothing for it right now.",
          };
    },
    now: () => clock,
  });
  return { handle, lib, searched, watch, tick: (days: number) => (clock += days * DAY) };
}

describe("the daily near-miss check", () => {
  it("searches up to the budget, oldest missing first, skipping new, found and unwanted ones", async () => {
    const { watch, searched } = await setup();
    await watch.setSettings({ perDay: 2 });
    const r = await watch.check();
    expect(searched).toEqual([1, 2]);
    expect(r.items.map((i) => [i.title, i.kind])).toEqual([
      ["Snow Lantern (1987)", "blocked"],
      ["Glass Meridian (1994)", "none"],
    ]);
    expect(r.items[0]!.closest).toMatchObject({ guid: "g1", indexerId: 7, sizeGB: 8.9 });
  });

  it("the next day goes on down the list, and a title is looked at again only after a week", async () => {
    const { watch, searched, tick } = await setup();
    await watch.setSettings({ perDay: 2 });
    await watch.check();
    tick(1);
    expect(await watch.due()).toBe(true);
    await watch.check();
    expect(searched).toEqual([1, 2, 3]);
    tick(7);
    await watch.check();
    expect(searched.slice(3)).toEqual([1, 2]);
  });

  it("forgets a title once it has a file, and 0 a day searches nothing", async () => {
    const { watch, searched, lib } = await setup();
    await watch.check();
    lib.movies[0]!.hasFile = true;
    await watch.setSettings({ perDay: 0 });
    const r = await watch.check();
    expect(searched).toEqual([1, 2, 3]);
    expect(r.items.map((i) => i.movieId)).toEqual([2, 3]);
  });

  it("raises a finding for the bell only when the owner turned it on", async () => {
    const { watch, handle } = await setup();
    await watch.check();
    const a = nearMissAnalyzer();
    const run = () => a.run({ handle, now: new Date(NOW) } as Parameters<typeof a.run>[0]);
    expect((await run()).drafts).toEqual([]);
    await watch.setSettings({ notify: true });
    const drafts = (await run()).drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      key: "near-misses:radarr",
      title: "Radarr: Snow Lantern (1987) is held back by your own rules",
    });
  });
});

describe("one Radarr that can't be read", () => {
  it("never stops the check for the others", async () => {
    const handle = openDatabase(":memory:");
    await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
    const lib = library();
    const watch = new NearMissWatch(handle, {
      radarrs: async () => [
        { id: "nokey", name: "Old Radarr", localUrl: "http://10.0.0.9:7878" },
        { id: "radarr", name: "Radarr", localUrl: "http://10.0.0.5:7879" },
      ],
      arrFor: (s) =>
        s.id === "nokey"
          ? async () => {
              throw new Error("Radarr has no credential in the Secure Vault yet.");
            }
          : lib.arr,
      search: async () => blocked(8.9),
      now: () => NOW,
    });
    const r = await watch.check();
    expect(r.items.map((i) => i.serviceId)).toEqual(["radarr", "radarr", "radarr"]);
  });
});
