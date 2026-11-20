import { describe, expect, it } from "vitest";
import { canImprovePanel, handBuiltDashboardOf, panelClassOf } from "./panel-class";

const svc = (
  name: string,
  image?: string,
  kind: "container" | "process" | "web" = "container",
) => ({
  name,
  image,
  container: image ? name.toLowerCase() : undefined,
  kind,
});

describe("which kind of panel a service gets (Panel Builder Phase 1)", () => {
  it("apps Hearth ships a panel for are first-party", () => {
    for (const s of [
      svc("Plex", "plexinc/pms-docker:latest"),
      svc("Radarr", "lscr.io/linuxserver/radarr"),
      svc("Gluetun", "qmcgaw/gluetun"),
      svc("Caddy", "caddy:2"),
      svc("FlareSolverr", "ghcr.io/flaresolverr/flaresolverr"),
    ])
      expect(panelClassOf(s), s.name).toBe("first-party");
  });

  it("a renamed copy of a first-party app is still first-party, never a guess", () => {
    expect(panelClassOf(svc("Plex (4K)"))).toBe("first-party");
    expect(panelClassOf(svc("Radarr (4K)"))).toBe("first-party");
  });

  it("infrastructure and processes are watch-only", () => {
    for (const s of [
      svc("Postgres", "postgres:16"),
      svc("Redis", "redis:7"),
      svc("MariaDB", "mariadb:11"),
      svc("A script", undefined, "process"),
    ])
      expect(panelClassOf(s), s.name).toBe("watch-only");
  });

  it("basic panels and Hearth's own app panels can be improved; network, security and infrastructure can't (11-19)", () => {
    const zm = svc("ZoneMinder", "zoneminderhq/zoneminder-base");
    expect(panelClassOf(zm)).toBe("basic");
    expect(canImprovePanel(zm)).toBe(true);
    expect(canImprovePanel(svc("Plex", "plexinc/pms-docker"))).toBe(true);
    expect(canImprovePanel(svc("Seerr", "ghcr.io/seerr-team/seerr:latest"))).toBe(true);
    expect(canImprovePanel(svc("Recyclarr", "recyclarr/recyclarr"))).toBe(true);
    for (const [name, image] of [
      ["Pi-hole", "pihole/pihole"],
      ["AdGuard Home", "adguard/adguardhome"],
      ["Vaultwarden", "vaultwarden/server"],
      ["Gluetun", "qmcgaw/gluetun"],
      ["Caddy", "caddy:2"],
      ["Postgres", "postgres:16"],
    ])
      expect(canImprovePanel(svc(name!, image)), name).toBe(false);
  });

  it("a service with no image and an odd name gets the rule's answer: basic", () => {
    expect(panelClassOf(svc("x-7 thing"))).toBe("basic");
  });

  it("names the hand-built dashboards", () => {
    expect(handBuiltDashboardOf(svc("Caddy", "caddy:2"))).toBe("caddy");
    expect(handBuiltDashboardOf(svc("Something", "caddy-docker-proxy-ui"))).toBeUndefined();
    expect(handBuiltDashboardOf(svc("ZoneMinder", "zoneminderhq/zoneminder-base"))).toBeUndefined();
  });
});
