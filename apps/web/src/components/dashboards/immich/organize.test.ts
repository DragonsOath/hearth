import { describe, expect, it } from "vitest";
import {
  ALBUM_CHUNK,
  AS_TAKEN,
  albumSteps,
  chunkIds,
  flip,
  previewTransform,
  turn,
} from "./organize";

/** The Photos tab's organizing: album steps, and flips and turns in Immich's terms. */

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("album steps", () => {
  it("makes the album with the first 500 and adds the rest to it by name", () => {
    const steps = albumSteps(ids(1100), { name: "Utah Road Trip 2026" });
    expect(steps.map((s) => s.params.op)).toEqual(["album-create", "album-add", "album-add"]);
    expect(steps[1]!.params).toMatchObject({ name: "Utah Road Trip 2026", made: true });
    expect(chunkIds(ids(1100)).map((c) => c.length)).toEqual([ALBUM_CHUNK, ALBUM_CHUNK, 100]);
  });

  it("adds to an existing album by its id", () => {
    const steps = albumSteps(ids(3), { albumId: "a1" });
    expect(steps).toEqual([
      {
        kind: "app-immich-control",
        params: { op: "album-add", albumId: "a1", body: "id-0,id-1,id-2" },
      },
    ]);
  });
});

describe("flip and turn", () => {
  it("turns in quarter turns, either way", () => {
    expect(turn(AS_TAKEN, -90).rotate).toBe(270);
    expect(turn(turn(AS_TAKEN, 90), 90).rotate).toBe(180);
  });

  it("flips what you see: sideways, a left to right flip is Immich's top to bottom mirror", () => {
    expect(flip(AS_TAKEN, "h")).toEqual({ rotate: 0, mirrorH: true, mirrorV: false });
    const sideways = turn(AS_TAKEN, 90);
    expect(flip(sideways, "h")).toEqual({ rotate: 90, mirrorH: false, mirrorV: true });
    expect(flip(sideways, "v")).toEqual({ rotate: 90, mirrorH: true, mirrorV: false });
  });

  it("previews mirror first, then the turn, as Immich draws it", () => {
    expect(previewTransform({ rotate: 90, mirrorH: true, mirrorV: false })).toBe(
      "rotate(90deg) scale(-1, 1)",
    );
  });
});
