import { describe, expect, it } from "vitest";
import { TABS } from "../command/ServiceWorkspace";
import { APP_PANELS } from "./registry";

describe("app panel tabs", () => {
  it("never reuse the id of Overview, Diagnostics or one of Hearth's own tools", () => {
    // With the same id, both the app's tab and Hearth's tool would show at once.
    const reserved = new Set([...TABS.map((t) => t.id), "diagnostics"]);
    for (const [app, panel] of Object.entries(APP_PANELS))
      for (const t of panel?.tabs ?? []) expect(reserved.has(t.id), `${app}: ${t.id}`).toBe(false);
  });
});

describe("capability addresses", () => {
  it("name a tab the app's panel has (or Overview)", async () => {
    const { CAPABILITIES } = await import("@dragon-control/core");
    for (const c of CAPABILITIES.filter((x) => x.panel)) {
      const tab = c.panel!.tab.split("/")[0]!;
      const tabs = (APP_PANELS[c.app]?.tabs ?? []).map((t) => t.id);
      expect(tab === "overview" || tabs.includes(tab), `${c.id}: ${c.panel!.tab}`).toBe(true);
    }
  });
});
