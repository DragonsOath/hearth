import { describe, expect, it } from "vitest";
import { effectiveAutonomy, isOpen, needsYou } from "./domain";

describe("effectiveAutonomy", () => {
  const rules = [
    { id: "media", level: "auto" as const },
    { id: "automation", level: "default" as const },
  ];

  it("uses the area override when one is set", () => {
    expect(effectiveAutonomy("media", rules, "ask")).toBe("auto");
  });

  it("falls back to the default for 'default' and for unknown areas", () => {
    expect(effectiveAutonomy("automation", rules, "diagnose")).toBe("diagnose");
    expect(effectiveAutonomy("nonexistent", rules, "monitor")).toBe("monitor");
  });
});

describe("incident state helpers", () => {
  it("treats approved incidents as open but not needing you", () => {
    expect(isOpen({ status: "approved" })).toBe(true);
    expect(needsYou({ status: "approved" })).toBe(false);
  });

  it("needs you when open or awaiting approval, never when resolved", () => {
    expect(needsYou({ status: "open" })).toBe(true);
    expect(needsYou({ status: "awaiting-approval" })).toBe(true);
    expect(needsYou({ status: "resolved" })).toBe(false);
    expect(isOpen({ status: "resolved" })).toBe(false);
  });
});
