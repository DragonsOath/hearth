import { describe, expect, it } from "vitest";
import type { HomelabBuild } from "@dragon-control/core";
import { showFinished } from "./BuildFinished";

const now = Date.parse("2026-11-22T12:00:00Z");
const build = (b: Partial<HomelabBuild>): HomelabBuild => ({
  steps: [],
  notBuilt: [],
  appsFolder: "/apps",
  done: true,
  ...b,
});

describe("the everything-is-built card (11-22)", () => {
  it("shows for a build that just finished", () => {
    expect(showFinished(build({ finishedAt: "2026-11-22T11:00:00Z" }), now)).toBe(true);
  });
  it("not once closed, not while unfinished, not for a build finished long ago", () => {
    expect(showFinished(build({ finishedAt: "2026-11-22T11:00:00Z", celebrated: true }), now)).toBe(
      false,
    );
    expect(showFinished(build({ done: false, finishedAt: "2026-11-22T11:00:00Z" }), now)).toBe(
      false,
    );
    expect(showFinished(build({ finishedAt: "2026-11-01T11:00:00Z" }), now)).toBe(false);
    expect(showFinished(undefined, now)).toBe(false);
  });
});
