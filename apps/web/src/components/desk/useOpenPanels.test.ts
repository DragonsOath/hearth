import { describe, expect, it } from "vitest";
import { openedPanel } from "./useOpenPanels";

describe("openedPanel", () => {
  it("reads the panel and tab from Ember's open_panel step", () => {
    expect(openedPanel("open:service:seerr")).toEqual({ kind: "service", id: "seerr" });
    expect(openedPanel("open:service:qbit@torrents")).toEqual({
      kind: "service",
      id: "qbit",
      tab: "torrents",
    });
  });
  it("ignores every other step", () => {
    expect(openedPanel("service:seerr")).toBeUndefined();
    expect(openedPanel(undefined)).toBeUndefined();
  });
});
