import { describe, expect, it } from "vitest";
import {
  minutesUntilReservation,
  reservationActive,
  reservationText,
  type Reservation,
} from "./profile";
import { freshnessText, memoryFreshness } from "./memory";

const at = (iso: string) => new Date(iso);
const gaming: Reservation = {
  id: "r1",
  machine: "Gaming-PC",
  resource: "gpu",
  from: "19:00",
  until: "23:00",
};

describe("reservations", () => {
  it("covers its daily window and nothing else", () => {
    expect(reservationActive(gaming, at("2026-10-14T18:59:00"))).toBe(false);
    expect(reservationActive(gaming, at("2026-10-14T19:00:00"))).toBe(true);
    expect(reservationActive(gaming, at("2026-10-14T22:59:00"))).toBe(true);
    expect(reservationActive(gaming, at("2026-10-14T23:00:00"))).toBe(false);
  });

  it("runs past midnight and belongs to the day it started on", () => {
    // Friday night only (5): 22:00 to 02:00.
    const late: Reservation = { ...gaming, from: "22:00", until: "02:00", days: [5] };
    expect(reservationActive(late, at("2026-10-16T23:30:00"))).toBe(true); // Friday
    expect(reservationActive(late, at("2026-10-17T01:30:00"))).toBe(true); // early Saturday
    expect(reservationActive(late, at("2026-10-17T23:30:00"))).toBe(false); // Saturday night
    expect(reservationActive(late, at("2026-10-16T01:30:00"))).toBe(false); // early Friday
  });

  it("says how long until it starts", () => {
    expect(minutesUntilReservation(gaming, at("2026-10-14T18:00:00"))).toBe(60);
    expect(minutesUntilReservation(gaming, at("2026-10-14T20:00:00"))).toBe(0);
    expect(minutesUntilReservation(gaming, at("2026-10-14T23:30:00"))).toBe(19 * 60 + 30);
  });

  it("reads plainly", () => {
    expect(reservationText({ ...gaming, note: "gaming" })).toBe(
      "The GPU on Gaming-PC, 7 PM to 11 PM every day (gaming)",
    );
    expect(
      reservationText({
        ...gaming,
        resource: "machine",
        from: "09:30",
        until: "09:30",
        days: [6, 0],
      }),
    ).toBe("The whole machine on Gaming-PC, all day Sun, Sat");
  });
});

describe("memory freshness", () => {
  const now = at("2026-10-14T12:00:00Z");
  it("ages setup facts and marks them stale past their kind's limit", () => {
    const old = memoryFreshness({ kind: "note", happenedAt: "2026-09-01T00:00:00Z" }, now);
    expect(old).toMatchObject({ ageDays: 43, stale: true, ages: true });
    expect(freshnessText(old)).toBe("last checked 43 days ago, may be out of date");
    const hw = memoryFreshness({ kind: "hardware", happenedAt: "2026-09-01T00:00:00Z" }, now);
    expect(hw.stale).toBe(false);
  });

  it("counts from the latest check, not when it was first written", () => {
    const f = memoryFreshness(
      {
        kind: "note",
        happenedAt: "2026-08-01T00:00:00Z",
        verification: {
          at: "2026-10-14T08:00:00Z",
          check: "vhclient -t LIST",
          result: "still true",
        },
      },
      now,
    );
    expect(f).toMatchObject({ ageDays: 0, stale: false });
    expect(freshnessText(f)).toBe("last checked today");
  });

  it("never ages history or open work", () => {
    for (const kind of ["journal", "win", "thread"] as const) {
      const f = memoryFreshness({ kind, happenedAt: "2025-01-01T00:00:00Z" }, now);
      expect(f.stale).toBe(false);
      expect(f.ages).toBe(false);
    }
  });
});
