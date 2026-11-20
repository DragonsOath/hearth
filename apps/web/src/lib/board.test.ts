import { describe, expect, it } from "vitest";
import { daysBetween, fallsOn, nextOn, scheduleWords, standing, todayIn } from "./board";

describe("the household board's dates", () => {
  it("knows today in the home's own time zone", () => {
    const at = new Date("2026-11-05T03:30:00Z");
    expect(todayIn("America/Los_Angeles", at)).toBe("2026-11-04");
    expect(todayIn("UTC", at)).toBe("2026-11-05");
  });

  it("follows weekday and every-n-days schedules", () => {
    // 2026-11-05 is a Thursday.
    const mwf = { type: "week" as const, days: [1, 3, 5] };
    expect(fallsOn(mwf, "2026-11-05")).toBe(false);
    expect(fallsOn(mwf, "2026-11-06")).toBe(true);
    expect(nextOn(mwf, "2026-11-07")).toBe("2026-11-09");
    const every3 = { type: "every" as const, n: 3, start: "2026-11-01" };
    expect(fallsOn(every3, "2026-11-04")).toBe(true);
    expect(fallsOn(every3, "2026-11-05")).toBe(false);
    expect(fallsOn(every3, "2026-10-29")).toBe(false);
    expect(daysBetween("2026-11-05", "2026-12-25")).toBe(50);
  });

  it("says what is due, done, late, or next", () => {
    const daily = { schedule: { type: "every" as const, n: 1, start: "2026-11-01" }, done: [] };
    expect(standing(daily, "2026-11-05").state).toBe("due");
    expect(standing({ ...daily, done: ["2026-11-05"] }, "2026-11-05").state).toBe("done");
    const thu = { schedule: { type: "week" as const, days: [4] }, done: [] as string[] };
    // Missed last Thursday: late until it is done.
    expect(standing(thu, "2026-11-07").state).toBe("late");
    // Put on the board on Friday: last Thursday was before it, so not late.
    expect(standing(thu, "2026-11-07", "2026-11-06").state).toBe("later");
    expect(standing({ ...thu, done: ["2026-11-05"] }, "2026-11-07")).toEqual({
      state: "later",
      next: "2026-11-12",
    });
  });

  it("says a schedule in words", () => {
    expect(scheduleWords({ type: "week", days: [5, 1, 3] })).toBe("Every Mon, Wed and Fri");
    expect(scheduleWords({ type: "week", days: [2] })).toBe("Every Tue");
    expect(scheduleWords({ type: "every", n: 1 })).toBe("Every day");
    expect(scheduleWords({ type: "every", n: 3 })).toBe("Every 3 days");
  });
});
