import { describe, expect, it } from "vitest";
import { isNight, particleCount, sceneFor } from "./weatherScene";

describe("the window's weather scene", () => {
  it("follows Home Assistant's condition", () => {
    expect(sceneFor("rainy", true)).toMatchObject({ kind: "rain", night: true, lightning: false });
    expect(sceneFor("lightning-rainy", false)).toMatchObject({ kind: "storm", lightning: true });
    expect(sceneFor("snowy", false)).toMatchObject({ kind: "snow" });
    expect(sceneFor("fog", false).kind).toBe("fog");
    // A clear night shows stars; a sunny day does not.
    expect(sceneFor("clear-night", false)).toMatchObject({ night: true, stars: true });
    expect(sceneFor("sunny", false)).toMatchObject({ night: false, stars: false, fall: 0 });
    // Something new from Home Assistant: a quiet cloudy sky, never a made-up storm.
    expect(sceneFor("exceptional", false)).toMatchObject({ kind: "cloudy", fall: 0 });
    // No weather at all: a clear sky with nothing falling.
    expect(sceneFor(undefined, true)).toMatchObject({ kind: "clear", fall: 0, stars: true });
  });

  it("knows night from the sun, or from the clock without it", () => {
    expect(isNight(true, 23)).toBe(false);
    expect(isNight(false, 12)).toBe(true);
    expect(isNight(undefined, 22)).toBe(true);
    expect(isNight(undefined, 10)).toBe(false);
  });

  it("draws less on a slow tablet and nothing when nothing falls", () => {
    const rain = sceneFor("rainy", true);
    const full = particleCount(rain, 1280, 800, "full");
    expect(full).toBeGreaterThan(100);
    expect(particleCount(rain, 1280, 800, "lite")).toBeLessThan(full / 2);
    expect(particleCount(sceneFor("sunny", false), 1280, 800, "full")).toBe(0);
    expect(particleCount(sceneFor("pouring", false), 4000, 4000, "full")).toBe(900);
  });
});
