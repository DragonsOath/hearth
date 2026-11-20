import { describe, expect, it } from "vitest";
import { embedAddress, frameVerdict } from "./embed";

// Basic panels show the app itself when the app allows it (11-14). Headers read on the owner's
// apps on the home server, the same day.
const HEARTH = "http://192.168.1.77:7600";

describe("whether an app's page may be shown inside Hearth", () => {
  it("follows the app's own headers, as the owner's apps send them", () => {
    // Plex, Jellyfin, Immich, Seerr, the arr apps: nothing said, so it shows.
    expect(frameVerdict({}, HEARTH, "http://192.168.1.77:32400/web").ok).toBe(true);
    // Tasterr.
    expect(
      frameVerdict(
        { xFrameOptions: "DENY", csp: "default-src 'self'; frame-ancestors 'none'" },
        HEARTH,
        "http://192.168.1.77:8220",
      ),
    ).toEqual({ ok: false, reason: "The app doesn't allow being shown inside other pages." });
    // Kavita: SAMEORIGIN and 'none' (frame-ancestors wins).
    expect(
      frameVerdict(
        { xFrameOptions: "SAMEORIGIN", csp: "frame-ancestors 'none'" },
        HEARTH,
        "http://192.168.1.77:5000",
      ).ok,
    ).toBe(false);
    // Audiobookshelf: 'self' only.
    expect(
      frameVerdict({ csp: "frame-ancestors 'self'" }, HEARTH, "http://192.168.1.77:13378"),
    ).toEqual({ ok: false, reason: "The app only allows being shown inside its own pages." });
    // Home Assistant, Tautulli: SAMEORIGIN alone.
    expect(
      frameVerdict({ xFrameOptions: "SAMEORIGIN" }, HEARTH, "http://192.168.1.77:8123").ok,
    ).toBe(false);
  });

  it("an allow-list counts only when it names Hearth's exact address", () => {
    const csp = "frame-ancestors 'self' http://localhost:3000 https://*.example.com";
    expect(frameVerdict({ csp }, HEARTH, "http://192.168.1.77:4210").ok).toBe(false);
    expect(frameVerdict({ csp }, "http://localhost:3000", "http://192.168.1.77:4210").ok).toBe(
      true,
    );
    expect(
      frameVerdict({ csp }, "https://hearth.example.com", "https://forms.example.com").ok,
    ).toBe(true);
    expect(frameVerdict({ csp: "frame-ancestors *" }, HEARTH, "http://x:1").ok).toBe(true);
  });

  it("never mixes an https Hearth with an http app, and picks the address that matches", () => {
    expect(frameVerdict({}, "https://hearth.example.com", "http://192.168.1.77:5000").ok).toBe(
      false,
    );
    const s = { localUrl: "http://192.168.1.77:5000", publicUrl: "books.example.com" };
    expect(embedAddress(s, "http:")).toBe("http://192.168.1.77:5000");
    expect(embedAddress(s, "https:")).toBe("https://books.example.com");
    expect(embedAddress({ localUrl: "http://192.168.1.77:5000" }, "https:")).toBe(
      "http://192.168.1.77:5000",
    );
  });
});
