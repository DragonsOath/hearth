import { afterEach, describe, expect, it, vi } from "vitest";
import { isTouchOnly } from "./media";

function device(pointers: { fine: boolean; coarse: boolean }) {
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      matches:
        (q === "(any-pointer: fine)" && pointers.fine) ||
        (q === "(any-pointer: coarse)" && pointers.coarse),
    }),
  });
}

describe("isTouchOnly", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is false with a mouse or trackpad", () => {
    device({ fine: true, coarse: false });
    expect(isTouchOnly()).toBe(false);
  });
  it("is true on a phone or tablet with only a touchscreen", () => {
    device({ fine: false, coarse: true });
    expect(isTouchOnly()).toBe(true);
  });
  it("is false for a touch laptop that also has a trackpad", () => {
    device({ fine: true, coarse: true });
    expect(isTouchOnly()).toBe(false);
  });
  it("is false when the browser reports no pointer at all (remote desktop)", () => {
    device({ fine: false, coarse: false });
    expect(isTouchOnly()).toBe(false);
  });
});
