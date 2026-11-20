import { describe, expect, it } from "vitest";
import { clockParts, digitalTime, numberWords, timeInWords } from "./timeWords";

describe("the written-out time", () => {
  it("says the minutes in words", () => {
    expect(numberWords(13)).toBe("Thirteen");
    expect(numberWords(25)).toBe("Twenty-Five");
    expect(numberWords(40)).toBe("Forty");
  });

  it("reads like Alex's example, and through the day", () => {
    expect(timeInWords(19, 13)).toEqual({
      main: "Seven Thirteen",
      part: "in the Evening",
      greeting: "Good Evening",
    });
    expect(timeInWords(7, 5)).toMatchObject({ main: "Seven Oh Five", part: "in the Morning" });
    expect(timeInWords(15, 0)).toMatchObject({ main: "Three O'Clock", part: "in the Afternoon" });
    expect(timeInWords(22, 45)).toMatchObject({ main: "Ten Forty-Five", part: "at Night" });
    expect(timeInWords(0, 30)).toMatchObject({ main: "Twelve Thirty", part: "at Night" });
    expect(timeInWords(12, 0)).toMatchObject({ main: "Noon", part: "" });
    expect(timeInWords(0, 0)).toMatchObject({ main: "Midnight", part: "" });
  });

  it("has digital alternatives, in the home's own time zone", () => {
    expect(digitalTime(19, 13, "12")).toBe("7:13 PM");
    expect(digitalTime(0, 5, "12")).toBe("12:05 AM");
    expect(digitalTime(7, 5, "24")).toBe("07:05");
    const at = new Date("2026-11-05T03:13:00Z");
    expect(clockParts(at, "America/New_York")).toEqual({ hour: 22, minute: 13 });
    expect(clockParts(at, "UTC")).toEqual({ hour: 3, minute: 13 });
  });
});
