import { describe, expect, it } from "vitest";
import { groupWithPanels, parsePanels, samePanels, serializePanels } from "../desk/layout";
import { PANEL_WIDTHS, PHONE_WIDTH, sizeFor } from "./size";
import { joinTab, splitTab, tabTarget } from "./targets";

describe("panel size classes", () => {
  it("follows the panel's own width on the desk", () => {
    expect(sizeFor(PANEL_WIDTHS.normal - 1, 1600)).toBe("compact");
    expect(sizeFor(PANEL_WIDTHS.normal, 1600)).toBe("normal");
    expect(sizeFor(PANEL_WIDTHS.expanded, 1600)).toBe("expanded");
    expect(sizeFor(PANEL_WIDTHS.maximized, 2560)).toBe("maximized");
  });

  it("is mobile on a phone, however wide the panel is", () => {
    expect(sizeFor(400, PHONE_WIDTH - 1)).toBe("mobile");
    expect(sizeFor(2000, 412)).toBe("mobile");
  });
});

describe("tab positions in the address", () => {
  it("reads old addresses unchanged", () => {
    expect(splitTab("logs")).toEqual({ tab: "logs", sub: null });
    expect(splitTab(null)).toEqual({ tab: null, sub: null });
  });

  it("reads and writes a position inside a tab", () => {
    expect(splitTab("overview/missing")).toEqual({ tab: "overview", sub: "missing" });
    expect(splitTab("library/movie/42")).toEqual({ tab: "library", sub: "movie/42" });
    expect(joinTab("overview", "missing")).toBe("overview/missing");
    expect(joinTab("overview", null)).toBe("overview");
  });

  it("keeps saved layouts from before working, and round-trips positions", () => {
    // A layout saved by an older Hearth: pinned Radarr on Logs, Sonarr, the Storage tool.
    const old = "!service:radarr@logs,service:sonarr,tool:storage@volumes";
    const panels = parsePanels(old);
    expect(panels).toEqual([
      { kind: "service", id: "radarr", tab: "logs", pinned: true },
      { kind: "service", id: "sonarr" },
      { kind: "tool", id: "storage", tab: "volumes" },
    ]);
    expect(serializePanels(panels)).toBe(old);
    const withPosition = serializePanels([
      { kind: "service", id: "radarr", tab: "overview/missing" },
    ]);
    expect(parsePanels(withPosition)).toEqual([
      { kind: "service", id: "radarr", tab: "overview/missing" },
    ]);
  });

  it("names tabs as stable targets", () => {
    expect(tabTarget("overview")).toBe("tab:overview");
  });
});

describe("reusing a workspace group for the same panels", () => {
  const group = (id: string, search: string, updatedAt: string) => ({ id, search, updatedAt });

  it("matches the same panels whatever their order, tab, focus, or pin", () => {
    expect(
      samePanels(parsePanels("service:a,!project:b@logs"), parsePanels("project:b,service:a")),
    ).toBe(true);
    expect(samePanels(parsePanels("service:a"), parsePanels("service:a,service:b"))).toBe(false);
    expect(samePanels(parsePanels("service:a"), parsePanels("service:b"))).toBe(false);
  });

  it("finds the most recently used group with exactly those panels", () => {
    const groups = [
      group("old", "panels=service%3Aa", "2026-10-01T10:00:00.000Z"),
      group("new", "panels=service%3Aa&focus=service%3Aa", "2026-10-02T10:00:00.000Z"),
      group("wider", "panels=service%3Aa%2Cservice%3Ab", "2026-10-03T10:00:00.000Z"),
    ];
    expect(groupWithPanels(groups, parsePanels("service:a"))?.id).toBe("new");
    expect(groupWithPanels(groups, parsePanels("service:a,service:b"))?.id).toBe("wider");
    expect(groupWithPanels(groups, parsePanels("service:c"))).toBeUndefined();
    // An empty desk is never a saved group.
    expect(
      groupWithPanels([group("none", "panels=", "2026-10-04T10:00:00.000Z")], []),
    ).toBeUndefined();
  });

  it("reads older single-panel links as the same panel", () => {
    const groups = [group("legacy", "service=a&tab=logs", "2026-10-01T10:00:00.000Z")];
    expect(groupWithPanels(groups, parsePanels("service:a"))?.id).toBe("legacy");
  });
});
