import { describe, expect, it } from "vitest";
import { isHomeQuery } from "./homeRows";

describe("isHomeQuery: what a media server's Home tab reads again on Refresh", () => {
  it("takes Plex's rows, their options, posters and saved layouts, for that server only", () => {
    expect(isHomeQuery(["home-rows", "plex"], "plex")).toBe(true);
    expect(isHomeQuery(["home-rows-options", "plex"], "plex")).toBe(true);
    expect(isHomeQuery(["home-rows-posters", "plex", "2", "movie.recentlyadded", ""], "plex")).toBe(
      true,
    );
    expect(isHomeQuery(["home-layouts", "plex"], "plex")).toBe(true);
    expect(isHomeQuery(["home-rows-options", "plex-2"], "plex")).toBe(false);
  });

  it("takes Jellyfin's and Emby's home screens, not the rest of their panel", () => {
    expect(isHomeQuery(["dashboard", "jf", "jellyfin", "home", "alex"], "jf")).toBe(true);
    expect(isHomeQuery(["dashboard", "jf", "jellyfin", "home-find", "alex", "x"], "jf")).toBe(true);
    expect(isHomeQuery(["dashboard", "jf", "jellyfin", "sessions"], "jf")).toBe(false);
    expect(isHomeQuery(["dashboard", "other", "jellyfin", "home"], "jf")).toBe(false);
  });

  it("leaves everything else alone", () => {
    expect(isHomeQuery(["workspace"], "plex")).toBe(false);
    expect(isHomeQuery(["home-rows-search", "plex", "2", "alien"], "plex")).toBe(false);
  });
});
