import { describe, expect, it } from "vitest";
import { CAPABILITIES, REAL_TESTED, SUPPORTED_MAJORS, versionFit } from "./capabilities";
import { ACTIONS, ACTION_KINDS } from "./policy";
import lidarr from "./fixtures/api-lidarr-3.1.0.4875.json";
import prowlarr from "./fixtures/api-prowlarr-2.6.5.5623.json";
import qbittorrent from "./fixtures/api-qbittorrent-5.2.4.json";
import radarr from "./fixtures/api-radarr-6.4.4.10685.json";
import sabnzbd from "./fixtures/api-sabnzbd-5.1.3.json";
import seerr from "./fixtures/api-seerr-3.5.0.json";
import sonarr from "./fixtures/api-sonarr-4.0.20.3014.json";
import wizarr from "./fixtures/api-wizarr-2.2.1.json";
import wizarrAdmin from "./fixtures/api-wizarr-admin-2026.9.1.json";
import tautulliSpec from "./fixtures/api-tautulli-2.18.2.json";
import plexSpec from "./fixtures/api-plex-1.43.4.10903.json";
import jellyfin from "./fixtures/api-jellyfin-12.2.0.json";
import romm from "./fixtures/api-romm-5.3.1.json";
import pihole from "./fixtures/api-pihole-6.5.json";
import adguard from "./fixtures/api-adguard-0.107.80.json";
import proxmox from "./fixtures/api-proxmox-9-api.json";
import npm from "./fixtures/api-npm-2.16.0.json";
import traefik from "./fixtures/api-traefik-3.7.17.json";
import portainer from "./fixtures/api-portainer-2.45.3.json";
import kuma1 from "./fixtures/api-uptimekuma-1.23.17.json";
import kuma2 from "./fixtures/api-uptimekuma-2.5.9.json";
import transmission from "./fixtures/api-transmission-4.1.4.json";
import nzbget from "./fixtures/api-nzbget-26.3.json";
import nextcloud from "./fixtures/api-nextcloud-35.0.2.json";
import paperless from "./fixtures/api-paperless-3.4.2.json";
import vaultwarden from "./fixtures/api-vaultwarden-1.37.5.json";
import tailscale from "./fixtures/api-tailscale-2.json";
import wgeasy from "./fixtures/api-wgeasy-15.json";
import navidrome from "./fixtures/api-navidrome-0.64.2.json";
import komga from "./fixtures/api-komga-1.30.0.json";
import gitea from "./fixtures/api-gitea-1.27.3.json";
import forgejo from "./fixtures/api-forgejo-13.0.5.json";
import mealie from "./fixtures/api-mealie-3.30.0.json";
import actual from "./fixtures/api-actual-26.11.0.json";
import authentik from "./fixtures/api-authentik-2026.8.5.json";
import frigate from "./fixtures/api-frigate-0.18.2.json";
import authelia from "./fixtures/api-authelia-4.39.28.json";
import emby from "./fixtures/api-emby-4.10.2.0.json";

// The endpoint lists of the exact versions checked on 2026-10-31 (native panels Phase 0):
// Radarr, Sonarr and Prowlarr from their official API documents, Wizarr from its own swagger;
// Lidarr (Phase 3, 2026-11-01) from its official API document at the tag the test Lidarr runs.
const endpoints = new Map<string, Set<string>>(
  [
    jellyfin,
    adguard,
    lidarr,
    npm,
    pihole,
    portainer,
    kuma1,
    kuma2,
    transmission,
    nzbget,
    nextcloud,
    paperless,
    vaultwarden,
    tailscale,
    wgeasy,
    navidrome,
    komga,
    gitea,
    forgejo,
    mealie,
    actual,
    authentik,
    frigate,
    authelia,
    emby,
    proxmox,
    plexSpec,
    prowlarr,
    qbittorrent,
    radarr,
    romm,
    sabnzbd,
    seerr,
    sonarr,
    tautulliSpec,
    traefik,
    wizarr,
    wizarrAdmin,
  ].map((d) => [`${d.app}@${d.version}`, new Set(d.endpoints)]),
);

describe("capability registry", () => {
  it("has unique ids", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only operations the policy knows, and agrees with it about changes", () => {
    for (const c of CAPABILITIES) {
      if (c.risk === "read") {
        expect(c.operation, c.id).toBeUndefined();
        continue;
      }
      expect(c.operation, `${c.id} needs the typed operation that performs it`).toBeDefined();
      expect(ACTION_KINDS, c.id).toContain(c.operation);
      // A change in the registry is a change to the policy too: approval rules stay the policy's.
      expect(ACTIONS[c.operation!].changes, c.id).toBe(true);
    }
  });

  it("never calls a delete routine", () => {
    for (const c of CAPABILITIES)
      if (c.api.some((a) => a.startsWith("DELETE "))) expect(c.risk, c.id).not.toBe("routine");
  });

  it("names only endpoints that exist in the version it was checked on", () => {
    for (const c of CAPABILITIES) {
      const versions = c.evidence.filter((e) => e.how !== "stand-in").map((e) => e.version);
      expect(versions.length, `${c.id} has no real-app evidence`).toBeGreaterThan(0);
      for (const v of new Set(versions)) {
        const known = endpoints.get(`${c.app}@${v}`);
        expect(known, `no endpoint list for ${c.app} ${v}`).toBeDefined();
        for (const a of c.api) {
          // Endpoints are written without query strings.
          expect(known!.has(a), `${c.id}: ${a} is not in ${c.app} ${v}`).toBe(true);
        }
      }
    }
  });

  it("gives every app with capabilities a supported major version", () => {
    for (const app of new Set(CAPABILITIES.map((c) => c.app)))
      expect(SUPPORTED_MAJORS[app]?.length, app).toBeGreaterThan(0);
  });

  it("matches versions: verified build, supported major, or unknown", () => {
    expect(versionFit("radarr", "6.4.4.10685")).toBe("verified");
    expect(versionFit("radarr", "6.5.0.11000")).toBe("supported");
    expect(versionFit("radarr", "5.26.2.10099")).toBe("unknown");
    expect(versionFit("radarr", undefined)).toBe("unknown");
    expect(versionFit("prowlarr", "2.6.5.5623")).toBe("verified");
    expect(versionFit("prowlarr", "1.24.3.4754")).toBe("unknown");
  });
});

describe("evidence from the real test Radarr", () => {
  it("names only capabilities that exist, and each carries it", () => {
    for (const area of REAL_TESTED) {
      const c = CAPABILITIES.find((x) => x.id === `radarr.${area}`);
      expect(c, area).toBeDefined();
      expect(
        c!.evidence.some((e) => e.how === "test-instance"),
        area,
      ).toBe(true);
    }
  });
});
