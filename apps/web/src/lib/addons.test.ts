import { describe, expect, it } from "vitest";
import { ADDON_MODULES, registerSlot } from "./addons";

// The add-on contract on the web side (11-14): every module promised to add-on screens is a real
// module with exports, so a Premium build that maps its imports here never finds a hole.
describe("what Hearth shares with add-on screens", () => {
  it("every shared module exists and exports something", () => {
    for (const [name, mod] of Object.entries(ADDON_MODULES)) {
      expect(mod, name).toBeTruthy();
      expect(Object.keys(mod as object).length, name).toBeGreaterThan(0);
    }
    // Panel Builder's screens use these (Premium repo, src/web/components/panels).
    for (const name of [
      "components/ui",
      "data/api",
      "components/shell/cave-context",
      "components/panels/SignInCard",
      "components/AddonSlot",
    ])
      expect(Object.keys(ADDON_MODULES)).toContain(name);
    expect(typeof registerSlot).toBe("function");
  });
});
