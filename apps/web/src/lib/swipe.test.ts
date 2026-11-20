import { describe, expect, it } from "vitest";
import { lockDirection, swipeStep, wrapIndex } from "./swipe";

// Fields, sliders, sideways scrollers and a focused field are checked in a real browser
// (tests/e2e/panel-swipe.spec.ts).

describe("swiping between panels", () => {
  it("decides sideways only when the move is clearly sideways", () => {
    expect(lockDirection(4, 3)).toBeUndefined();
    expect(lockDirection(40, 5)).toBe("x");
    // A scroll that drifts a little sideways stays a scroll.
    expect(lockDirection(18, 20)).toBe("y");
    expect(lockDirection(20, 14)).toBe("y");
    expect(lockDirection(-30, 10)).toBe("x");
  });

  it("switches only past a small distance, left for next and right for previous", () => {
    expect(swipeStep(-20)).toBe(0);
    expect(swipeStep(-80)).toBe(1);
    expect(swipeStep(80)).toBe(-1);
  });

  it("wraps round both ways", () => {
    // Ember, Plex, Sonarr, Radarr: right from Ember is Radarr, left from Radarr is Ember.
    expect(wrapIndex(0, -1, 4)).toBe(3);
    expect(wrapIndex(3, 1, 4)).toBe(0);
    expect(wrapIndex(1, 1, 4)).toBe(2);
    expect(wrapIndex(0, 1, 1)).toBe(0);
  });
});
