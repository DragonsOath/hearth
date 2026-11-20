import { describe, expect, it } from "vitest";
import { PROJECT_COLORS } from "@dragon-control/core";
import { PROJECT_GLOW, glowOf } from "./projectGlow";

describe("project glow", () => {
  it("gives every project color its own bright glow", () => {
    expect(PROJECT_COLORS.map((c) => PROJECT_GLOW[c])).toHaveLength(6);
    expect(new Set(Object.values(PROJECT_GLOW)).size).toBe(6);
    for (const hex of Object.values(PROJECT_GLOW)) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("has no glow without a color, so the card stays plain", () => {
    expect(glowOf({})).toBeUndefined();
    expect(glowOf({ color: "purple" })).toBe(PROJECT_GLOW.purple);
  });
});
