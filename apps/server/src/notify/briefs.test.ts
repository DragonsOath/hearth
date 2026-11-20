import { describe, expect, it } from "vitest";
import { clock } from "../findings/analyzers/types";
import { changeLines } from "./briefs";

describe("the server summary reads plainly (11-13)", () => {
  it("folds the problems that cleared into one line", () => {
    expect(
      changeLines([
        { text: "Found 2 new things" },
        { text: "Resolved: Sonarr isn't answering" },
        { text: "Resolved: Disk D is 95% full" },
        { text: "Resolved: Radarr isn't answering" },
      ]),
    ).toEqual(["Found 2 new things.", "3 earlier problems cleared up."]);
    expect(changeLines([{ text: "Resolved: Sonarr isn't answering." }])).toEqual([
      "Resolved: Sonarr isn't answering.",
    ]);
  });

  it("says times as people do, in this machine's own time zone", () => {
    const now = new Date(2026, 10, 13, 10, 0);
    expect(clock(new Date(2026, 10, 13, 16, 17), now)).toBe("4:17 PM");
    expect(clock(new Date(2026, 10, 14, 16, 17), now)).toBe("4:17 PM tomorrow");
    expect(clock(new Date(2026, 10, 12, 9, 2), now)).toBe("9:02 AM yesterday");
    expect(clock(new Date(2026, 10, 20, 16, 17), now)).toBe("Nov 20, 4:17 PM");
    expect(clock(new Date(2025, 0, 2, 8, 0), now)).toBe("Jan 2, 2025, 8:00 AM");
    expect(clock(new Date(2026, 10, 14, 16, 17).toISOString(), now)).not.toMatch(/UTC|T\d/);
  });
});
