import { describe, expect, it } from "vitest";
import { planLeft } from "./PlanUsage";

const engine = (windows: object[], status = "live") => ({
  engines: [{ engine: "claude-code", label: "Claude Code", status, windows }],
});

describe("plan left, beside the AI's name", () => {
  it("shows the tightest window as a percentage left", () => {
    const p = planLeft(
      engine([
        { id: "five_hour", label: "5-hour", level: "ok", remaining_pct: 71.6, used_pct: 28.4 },
        { id: "seven_day", label: "Weekly", level: "low", remaining_pct: 22.2, used_pct: 77.8 },
      ]) as never,
    );
    expect(p).toMatchObject({ left: 22, tight: { label: "Weekly", level: "low" } });
    expect(p?.detail).toBe("5-hour: 72% left · Weekly: 22% left");
  });

  it("shows nothing without a reading, or once a window has reset", () => {
    expect(planLeft(undefined)).toBeNull();
    expect(planLeft(engine([]) as never)).toBeNull();
    expect(
      planLeft(
        engine([
          {
            id: "five_hour",
            label: "5-hour",
            level: "ok",
            remaining_pct: 10,
            used_pct: 90,
            reset_passed: true,
          },
        ]) as never,
      ),
    ).toBeNull();
    expect(
      planLeft(engine([{ id: "x", label: "x", remaining_pct: 5 }], "not_installed") as never),
    ).toBeNull();
  });
});
