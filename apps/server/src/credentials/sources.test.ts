import { describe, expect, it } from "vitest";
import { keyIn } from "./sources";

/** Keys read from apps' own settings files (the import path Ember's credential-import uses). */
describe("keys in apps' settings files", () => {
  it("reads Plex's server token from its preferences", () => {
    const prefs =
      '<?xml version="1.0" encoding="utf-8"?>\n<Preferences MachineIdentifier="abc" PlexOnlineToken="AbCdEf-1234567890_xyz" PlexOnlineUsername="alex"/>\n';
    expect(keyIn("plex", prefs)).toBe("AbCdEf-1234567890_xyz");
    expect(keyIn("plex", '<Preferences MachineIdentifier="abc"/>')).toBeUndefined();
  });

  it("reads the *arr API key, and nothing from a file without one", () => {
    expect(
      keyIn("sonarr", "<Config><ApiKey>0123456789abcdef0123456789abcdef</ApiKey></Config>"),
    ).toBe("0123456789abcdef0123456789abcdef");
    expect(keyIn("sonarr", "<Config></Config>")).toBeUndefined();
  });
});
