import { describe, expect, it } from "vitest";
import { pageSizeFor } from "./browser";

describe("Ember's Browser fills its panel (11-04)", () => {
  it("keeps the panel's shape, scaled into the sizes a page can have", () => {
    expect(pageSizeFor(1200, 900)).toEqual({ width: 1200, height: 900 });
    // A phone panel: a wider page, shown smaller, same shape.
    const phone = pageSizeFor(360, 600)!;
    expect(phone.width).toBe(800);
    expect(phone.height / phone.width).toBeCloseTo(600 / 360, 2);
    // A huge screen: no bigger than the browser allows.
    const big = pageSizeFor(5000, 2500)!;
    expect(big.width).toBeLessThanOrEqual(2560);
    expect(big.width / big.height).toBeCloseTo(2, 2);
    expect(pageSizeFor(0, 500)).toBeNull();
  });
});
