import { describe, expect, it } from "vitest";
import { canOpenBeside, keyPageHref } from "./keyPage";

describe("keyPageHref", () => {
  const abs = {
    name: "Audiobookshelf",
    publicUrl: "abs.example.com",
    localUrl: "http://10.0.0.5:13378",
  };

  it("opens the key page through the reverse proxy first", () => {
    expect(keyPageHref(abs, "/audiobookshelf/config/api-keys")).toBe(
      "https://abs.example.com/audiobookshelf/config/api-keys",
    );
  });

  it("uses the address on your network when there is no proxy address", () => {
    expect(
      keyPageHref({ name: "Radarr", localUrl: "http://10.0.0.5:7878" }, "/settings/general"),
    ).toBe("http://10.0.0.5:7878/settings/general");
  });

  it("keeps a page inside a hash route", () => {
    expect(
      keyPageHref({ name: "Jellyfin", localUrl: "http://10.0.0.5:8096" }, "/web/#/dashboard/keys"),
    ).toBe("http://10.0.0.5:8096/web/#/dashboard/keys");
  });

  it("falls back to the app itself, and to nothing without an address", () => {
    expect(keyPageHref({ name: "qBittorrent", localUrl: "http://10.0.0.5:8080" }, undefined)).toBe(
      "http://10.0.0.5:8080",
    );
    expect(keyPageHref({ name: "Kavita" }, "/preferences")).toBeUndefined();
    expect(keyPageHref(undefined, "/preferences")).toBeUndefined();
  });
});

describe("canOpenBeside", () => {
  it("needs a wide screen and not the Android app", () => {
    const nav = (ua: string) => ({ userAgent: ua }) as Navigator;
    expect(canOpenBeside({ innerWidth: 1600, navigator: nav("Chrome") })).toBe(true);
    expect(canOpenBeside({ innerWidth: 800, navigator: nav("Chrome") })).toBe(false);
    expect(canOpenBeside({ innerWidth: 1600, navigator: nav("Chrome HearthApp/0.30.0") })).toBe(
      false,
    );
  });
});
