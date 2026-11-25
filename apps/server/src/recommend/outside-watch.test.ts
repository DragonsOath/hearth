import { describe, expect, it } from "vitest";
import { parseSuggestions, recommendPrompt } from "./service";
import { browserBase, watchUrl } from "./watch";

describe("think outside the box: Ember's nearby picks are marked", () => {
  it("reads adjacent: true, and the wide rule asks for it", () => {
    const got = parseSuggestions(
      '[{"title":"Groundhog Day","year":1993,"why":"A time loop."},{"title":"Arrival","year":2016,"why":"Time folds back on itself.","adjacent":true},{"title":"Primer","adjacent":"yes","why":"x"}]',
    );
    expect(got.map((s) => s.adjacent ?? false)).toEqual([false, true, false]);
    const { prompt } = recommendPrompt({ kind: "movie", interest: "time loops", wide: true });
    expect(prompt).toContain('"adjacent": true');
  });
});

describe("Watch it: a link to the title in the app that has it", () => {
  it("Plex through app.plex.tv, Jellyfin and Emby at their address", () => {
    expect(watchUrl("plex", { id: "42", machine: "abc" })).toBe(
      "https://app.plex.tv/desktop/#!/server/abc/details?key=%2Flibrary%2Fmetadata%2F42",
    );
    expect(watchUrl("plex", { id: "42" })).toBeUndefined();
    expect(watchUrl("jellyfin", { id: "x1", base: "https://jf.example.com/" })).toBe(
      "https://jf.example.com/web/#/details?id=x1",
    );
    expect(watchUrl("emby", { id: "9", base: "http://10.0.0.5:8096" })).toBe(
      "http://10.0.0.5:8096/web/index.html#!/item?id=9",
    );
    expect(watchUrl("jellyfin", { id: "x1" })).toBeUndefined();
    // Its public https address first, else its own.
    expect(
      browserBase({ publicUrl: "https://jf.example.com", localUrl: "http://10.0.0.5:8096" }),
    ).toBe("https://jf.example.com");
    expect(browserBase({ publicUrl: "http://plain", localUrl: "http://10.0.0.5:8096" })).toBe(
      "http://10.0.0.5:8096",
    );
  });
});
