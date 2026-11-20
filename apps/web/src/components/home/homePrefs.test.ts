import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  WIDGETS,
  WIDGET_INFO,
  moveWidget,
  readPrefs,
  resize,
  spanOf,
} from "./homePrefs";

describe("the home dashboard's settings on this screen", () => {
  it("starts from a full default, and falls back field by field", () => {
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(readPrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(
      readPrefs(JSON.stringify({ clock: "24", start: "nowhere", motion: "lite", dim: 7 })),
    ).toMatchObject({
      clock: "24",
      start: "home",
      motion: "lite",
      dim: 10,
    });
  });

  it("carries a layout saved before the gallery over, less what was hidden", () => {
    const p = readPrefs(
      JSON.stringify({ order: ["lists", "music", "gone"], hidden: ["scenes", "x"] }),
    );
    expect(p.shown).toEqual(["lists", "music", "today", "status"]);
  });

  it("keeps the gallery's choices: widgets, widths and devices, dropping anything unknown", () => {
    const p = readPrefs(
      JSON.stringify({
        shown: ["news", "people", "news", "nope"],
        spans: { news: 12, people: 9, nope: 4 },
        devices: ["sensor.porch_temperature", "not an entity"],
        idlePhotos: true,
      }),
    );
    expect(p.shown).toEqual(["news", "people"]);
    expect(p.spans).toEqual({ news: 12 });
    expect(p.devices).toEqual(["sensor.porch_temperature"]);
    expect(p).toMatchObject({ idlePhotos: true, doorbellPopup: true });
  });

  it("has a gallery entry for every widget, and moves and resizes within bounds", () => {
    for (const w of WIDGETS) expect(WIDGET_INFO[w].name).toBeTruthy();
    expect(moveWidget(["music", "today", "lists"], "today", -1)).toEqual([
      "today",
      "music",
      "lists",
    ]);
    expect(moveWidget(["music", "today"], "music", -1)).toEqual(["music", "today"]);
    expect(spanOf(DEFAULT_PREFS, "music")).toBe(5);
    expect(resize(DEFAULT_PREFS, "music", 1)).toEqual({ music: 6 });
    expect(resize({ ...DEFAULT_PREFS, spans: { news: 12 } }, "news", 1)).toEqual({ news: 12 });
    expect(resize({ ...DEFAULT_PREFS, spans: { lists: 3 } }, "lists", -1)).toEqual({ lists: 3 });
  });
});
