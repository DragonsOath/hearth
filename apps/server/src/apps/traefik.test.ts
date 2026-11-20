import { describe, expect, it } from "vitest";
import { fakeTraefik } from "./fake-traefik";
import { hostsOf, readTraefik, traefikDashboard, traefikSites } from "./traefik";

/**
 * Traefik against the stand-in (answering as a throwaway Traefik 3.7.17 did; traefik-real.test.ts
 * reads a real one): routers, refused routers, app servers down, certificates, the sites it gives
 * "Open web UI", and never a middleware's password hash.
 */

const BASE = "http://10.0.0.9:8082";

describe("reading Traefik", () => {
  it("finds the names a rule answers", () => {
    expect(hostsOf("Host(`a.example.com`) && PathPrefix(`/`)")).toEqual(["a.example.com"]);
    expect(hostsOf("Host(`a.example.com`, `b.example.com`) || HostSNI(`c.example.com`)")).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
    ]);
    expect(hostsOf("PathPrefix(`/api`)")).toEqual([]);
  });

  it("reads routers with their app servers, refused ones with Traefik's error, and certificates", async () => {
    const t = fakeTraefik();
    const d = await traefikDashboard(t.fetch, BASE);
    expect(d.version).toBe("3.7.17");
    expect(d.routers.map((r) => [r.hosts[0], r.status])).toEqual([
      ["broken.example.com", "disabled"],
      ["radarr.example.com", "enabled"],
      ["sonarr.example.com", "enabled"],
    ]);
    expect(d.routers[0]!.errors[0]).toMatch(/does not exist/);
    expect(d.routers[1]).toMatchObject({
      tls: true,
      middlewares: ["auth@file"],
      servers: [{ url: "http://172.18.0.5:7878", up: true }],
    });
    expect(d.counts).toEqual({ routers: 3, errors: 1, warnings: 0, servicesDown: 1 });
    expect(d.entryPoints.map((e) => e.name)).toEqual(["web", "websecure"]);
    expect(JSON.stringify(d)).not.toContain("e2e-SECRET");
    const r = await readTraefik(BASE, t.fetch);
    expect(r.issues.map((i) => i.key)).toEqual([
      "routers-refused",
      "apps-down",
      "certificates-expiring",
    ]);
  });

  it("gives its sites to Open web UI by app server address, and by service (container) name", async () => {
    expect(await traefikSites(fakeTraefik().fetch, BASE)).toEqual([
      { site: "radarr.example.com", upstream: "172.18.0.5:7878" },
      { site: "radarr.example.com", upstream: "radarr:7878" },
      { site: "sonarr.example.com", upstream: "172.18.0.6:8989" },
      { site: "sonarr.example.com", upstream: "sonarr:8989" },
    ]);
  });
});
