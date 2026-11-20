import { describe, expect, it } from "vitest";
import { voiceTraitsText, worstStatus } from "./index";

describe("worstStatus", () => {
  it("is ok when everything is ok or nothing is reported", () => {
    expect(worstStatus([])).toBe("ok");
    expect(worstStatus(["ok", "ok"])).toBe("ok");
  });

  it("surfaces the most severe component status", () => {
    expect(worstStatus(["ok", "degraded"])).toBe("degraded");
    expect(worstStatus(["degraded", "down", "ok"])).toBe("down");
  });
});

describe("voice personality dials", () => {
  it("say nothing when unset, and keep humor below accuracy when turned up", () => {
    expect(voiceTraitsText(undefined)).toBe("");
    expect(voiceTraitsText({})).toBe("");
    expect(voiceTraitsText({ warmth: 2 })).toBe("Dials: kindness and reassurance: a fair amount.");
    const loose = voiceTraitsText({ profanity: 1, innuendo: 0 });
    expect(loose).toContain("swearing: a little; cheeky innuendo and double meanings: none.");
    expect(loose).toContain("give way to accuracy");
  });
});
