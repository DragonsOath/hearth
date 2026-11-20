import { describe, expect, it } from "vitest";
import { founderPriceLine } from "./premium";

describe("the Founder price line (one launch setting, 11-13)", () => {
  it("shows the launch price with its end date, then the regular price", () => {
    const ends = "2027-07-01";
    expect(founderPriceLine(new Date("2027-06-30T23:00:00Z"), ends)).toBe(
      "Founder: $60 launch price, $99 after July 1, 2027",
    );
    expect(founderPriceLine(new Date("2027-07-01T10:00:00Z"), ends)).toBe(
      "Founder: $60 launch price, $99 after July 1, 2027",
    );
    expect(founderPriceLine(new Date("2027-07-02T00:00:01Z"), ends)).toBe("Founder: $99");
  });
  it("before launch (no date set) it says the launch price lasts the first 7 months", () => {
    expect(founderPriceLine(new Date(), null)).toBe(
      "Founder: $60 launch price, $99 after the first 7 months",
    );
  });
});
