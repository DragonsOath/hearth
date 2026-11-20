import { describe, expect, it } from "vitest";
import { addUse, arrange, move, moveTo, rankByUse, scoreOf, type LairUsage } from "./lairUsage";

const DAY = 24 * 60 * 60 * 1000;
const items = ["Sonarr", "Bazarr", "Radarr", "Plex"].map((name) => ({ key: name, name }));

describe("Lair usage order", () => {
  it("puts the most opened first and keeps the rest alphabetical", () => {
    let u: LairUsage = {};
    u = addUse(u, "Radarr", 0);
    u = addUse(u, "Radarr", 0);
    u = addUse(u, "Sonarr", 0);
    expect(rankByUse(items, u, 0).map((i) => i.name)).toEqual([
      "Radarr",
      "Sonarr",
      "Bazarr",
      "Plex",
    ]);
  });

  it("lets recent use outrank old habits", () => {
    let u: LairUsage = {};
    for (let i = 0; i < 4; i++) u = addUse(u, "Plex", 0);
    u = addUse(u, "Bazarr", 60 * DAY);
    expect(scoreOf(u, "Plex", 60 * DAY)).toBeLessThan(1);
    expect(rankByUse(items, u, 60 * DAY)[0]!.name).toBe("Bazarr");
  });
});

describe("the order you set by hand", () => {
  const items = ["Plex", "Bazarr", "Radarr", "Immich"].map((name) => ({ key: name, name }));

  it("follows your order, with apps added since at the end", () => {
    const order = ["Radarr", "Plex", "Gone"];
    expect(arrange(items, order, {}).map((x) => x.key)).toEqual([
      "Radarr",
      "Plex",
      "Bazarr",
      "Immich",
    ]);
    expect(arrange(items, undefined, {}).map((x) => x.key)).toEqual([
      "Bazarr",
      "Immich",
      "Plex",
      "Radarr",
    ]);
  });

  it("moves an app one place, and not past either end", () => {
    expect(move(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(move(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(move(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("drops a dragged app at any place", () => {
    expect(moveTo(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveTo(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveTo(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
    expect(moveTo(["a", "b"], "x", 0)).toEqual(["a", "b"]);
  });
});
