import { afterEach, describe, expect, it, vi } from "vitest";
import { inAppWindow, noteAppWindow } from "./appWindow";

/** Hearth's own window (11-22): the launcher opens it with window=app, and it remembers. */
function stubBrowser(standalone = false) {
  const store = new Map<string, string>();
  const replaced: string[] = [];
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("history", {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => void replaced.push(url),
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: standalone }) });
  return { replaced };
}

afterEach(() => vi.unstubAllGlobals());

describe("Hearth's own app window", () => {
  it("is noted from the launcher's marker, and the marker leaves the address", () => {
    const { replaced } = stubBrowser();
    expect(inAppWindow()).toBe(false);
    noteAppWindow({ href: "http://localhost:7600/setup?code=abc&window=app" } as Location);
    expect(inAppWindow()).toBe(true);
    expect(replaced).toEqual(["/setup?code=abc"]);
  });

  it("a browser tab without the marker is not the app window", () => {
    stubBrowser();
    noteAppWindow({ href: "http://localhost:7600/setup?code=abc" } as Location);
    expect(inAppWindow()).toBe(false);
  });

  it("an installed app (standalone) counts too", () => {
    stubBrowser(true);
    expect(inAppWindow()).toBe(true);
  });
});
