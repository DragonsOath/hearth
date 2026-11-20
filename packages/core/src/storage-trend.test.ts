import { describe, expect, it } from "vitest";
import { trend } from "./storage-trend";

const days = (start: string, values: number[], step = 1) =>
  values.map((usedTb, i) => {
    const d = new Date(Date.parse(`${start}T00:00:00Z`) + i * step * 86_400_000);
    return { day: d.toISOString().slice(0, 10), usedTb };
  });

describe("trend", () => {
  it("needs three readings before it says anything about a trend", () => {
    expect(trend(days("2026-10-01", [10, 10.1]), 20, 10.1).words).toMatch(/at least three/);
  });

  it("a growing drive gets a rate and a plain forecast", () => {
    // 50 GB a day on a 22 TB drive with 4 TB free: full in about 80 days.
    const t = trend(days("2026-10-01", [17.9, 17.95, 18.0, 18.05, 18.1]), 22, 18.0);
    expect(t.perDay).toBeCloseTo(0.05, 5);
    expect(t.fullInDays).toBe(80);
    expect(t.words).toMatch(/50 GB a day over 4 days: full in about 3 months/);
    expect(t.tone).toBe("watch");
    // 1 TB free at the same rate: within a month.
    expect(trend(days("2026-10-01", [17.9, 17.95, 18.0]), 19, 18.0).tone).toBe("alert");
  });

  it("missing days are gaps by date, not jumps", () => {
    // Readings every other day: the rate per day is half the change between readings.
    const t = trend(days("2026-10-01", [10, 10.1, 10.2], 2), 20, 10.2);
    expect(t.perDay).toBeCloseTo(0.05, 5);
    expect(t.spanDays).toBe(4);
  });

  it("steady, freeing, and nearly full", () => {
    expect(trend(days("2026-10-01", [5, 5, 5, 5]), 20, 5)).toMatchObject({ tone: "fine" });
    expect(trend(days("2026-10-01", [5, 5, 5, 5]), 20, 5).words).toMatch(/Steady/);
    expect(trend(days("2026-10-01", [6, 5.8, 5.6]), 20, 5.6).words).toMatch(/freed/);
    expect(trend(days("2026-10-01", [19, 19, 19]), 20, 19).tone).toBe("alert");
  });
});
