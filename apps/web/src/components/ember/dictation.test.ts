import { describe, expect, it } from "vitest";
import { joinDictation } from "./dictation";

describe("joinDictation", () => {
  it("starts an empty box with a capital", () => {
    expect(joinDictation("", "check my torrents")).toBe("Check my torrents");
  });

  it("adds a space after what was typed", () => {
    expect(joinDictation("Hey", "check my torrents")).toBe("Hey check my torrents");
    expect(joinDictation("Hey ", "check")).toBe("Hey check");
  });

  it("capitalises after the end of a sentence", () => {
    expect(joinDictation("Done.", "next one")).toBe("Done. Next one");
  });

  it("ignores silence", () => {
    expect(joinDictation("Hey", "  ")).toBe("Hey");
  });
});
