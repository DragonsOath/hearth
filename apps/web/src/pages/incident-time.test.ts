import { describe, expect, it } from "vitest";
import { lineTime } from "./IncidentDetail";

// 11-11: a multi-day incident (INC-004727) showed times with no dates, so lines read out of order.
describe("incident timeline times", () => {
  const d1 = "2026-11-09T22:50:00";
  const d2 = "2026-11-10T08:15:00";
  it("shows only the time when the incident stays within one day", () => {
    expect(lineTime({ at: d1 }, undefined, false)).not.toMatch(/Nov/);
  });
  it("puts the date on the first line of each day", () => {
    expect(lineTime({ at: d1 }, undefined, true)).toMatch(/Nov/);
    expect(lineTime({ at: d2 }, d1, true)).toMatch(/Nov/);
    expect(lineTime({ at: "2026-11-10T09:00:00" }, d2, true)).not.toMatch(/Nov/);
  });
  it("dates a span of checks that crosses midnight", () => {
    expect(lineTime({ firstAt: d1, at: d2 }, d1, true)).toMatch(/to .*Nov/);
  });
});
