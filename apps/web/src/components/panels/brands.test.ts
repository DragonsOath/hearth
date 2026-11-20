import { describe, expect, it } from "vitest";
import { PANEL_LOOKS } from "@dragon-control/core";
import {
  BRAND_COLORS,
  EMBER_FRAME,
  HEARTH_BRAND,
  HEARTH_FRAME,
  HEARTH_ORANGE,
  PAINTED_KINDS,
  brandFor,
  brandStyle,
} from "./brands";
import { contrast } from "../../lib/theme";

describe("service panel branding", () => {
  it("uses the owner's painting for Sonarr, Radarr, Overseerr and qBittorrent", () => {
    expect(PAINTED_KINDS).toEqual(["sonarr", "radarr", "seerr", "qbittorrent"]);
    for (const kind of PAINTED_KINDS) {
      const b = brandFor({ kind, name: kind });
      expect(b.frame.src).toBe(`/brands/${kind}-frame.webp`);
      expect(b.frame.slice).toEqual([200, 520, 170, 230]);
      expect(b.auto).toBeUndefined();
    }
  });

  it("gives every other service Hearth's frame lit in its own color, with its own logo", () => {
    const plex = brandFor({ name: "Plex", image: "plexinc/pms-docker" });
    expect(plex.frame).toBe(HEARTH_FRAME);
    expect(plex.primary).toBe(BRAND_COLORS.plex);
    expect(plex.auto?.logo).toBe("/logos/plex.svg");
    // Prowlarr has no painting yet: it gets the automatic look in its orange.
    const prowlarr = brandFor({ kind: "prowlarr", name: "Prowlarr" });
    expect(prowlarr.frame).toBe(HEARTH_FRAME);
    expect(prowlarr.auto?.logo).toBe("/logos/prowlarr.svg");
    // Two services look different: their own colors and logos.
    const bazarr = brandFor({ name: "Bazarr" });
    expect(bazarr.primary).not.toBe(plex.primary);
  });

  it("falls back to Hearth's orange for a service Hearth has no logo for", () => {
    const own = brandFor({ name: "My own tool" });
    expect(own.primary).toBe(HEARTH_ORANGE);
    expect(own.auto?.logo).toBeUndefined();
    expect(HEARTH_BRAND.primary).toBe(HEARTH_ORANGE);
  });

  it("keeps every service color bright enough to glow on the charcoal panel", () => {
    for (const [logo, color] of Object.entries(BRAND_COLORS))
      expect(contrast(color, "#0e1016"), logo).toBeGreaterThanOrEqual(3);
  });

  it("gives a branded frame its colors as variables", () => {
    const style = brandStyle(brandFor({ name: "Plex" })) as Record<string, string>;
    expect(style["--brand-primary"]).toBe(BRAND_COLORS.plex);
    expect(brandStyle(undefined)).toBeUndefined();
  });

  it("gives Ember's panel its own painted frame", () => {
    expect(EMBER_FRAME.src).toBe("/brands/ember-frame.webp");
    expect(EMBER_FRAME.slice).toEqual([240, 60, 330, 60]);
  });

  it("offers three looks, minimal first (the default)", () => {
    expect(PANEL_LOOKS).toEqual(["minimal", "service", "hearth"]);
  });
});
