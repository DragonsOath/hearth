import { describe, expect, it } from "vitest";
import type { Fetch } from "./http";
import { readTraefik, traefikDashboard, traefikSites } from "./traefik";

/**
 * The same reads as traefik.test.ts against a real Traefik's API (read only, so any Traefik will
 * do, but a throwaway is used): HEARTH_TRAEFIK_TEST_URL=http://127.0.0.1:8282. It expects the
 * routers set up for this check: radarr.home.example (TLS, to 192.168.1.10:7878), sonarr, and a
 * broken one pointing at a missing service.
 */

const url = process.env.HEARTH_TRAEFIK_TEST_URL;
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!url)("a real Traefik", () => {
  it("reads routers, a refused one, certificates and sites, never a password hash", async () => {
    const d = await traefikDashboard(realFetch, url!);
    expect(d.version).toMatch(/^3\./);
    const radarr = d.routers.find((r) => r.hosts.includes("radarr.home.example"))!;
    expect(radarr).toMatchObject({
      tls: true,
      status: "enabled",
      servers: [{ url: "http://192.168.1.10:7878" }],
    });
    expect(d.routers.find((r) => r.hosts.includes("broken.home.example"))).toMatchObject({
      status: "disabled",
    });
    expect(d.certificates[0]!.names).toContain("radarr.home.example");
    expect(JSON.stringify(d)).not.toContain("$apr1$");
    expect((await readTraefik(url!, realFetch)).issues.map((i) => i.key)).toContain(
      "routers-refused",
    );
    expect(await traefikSites(realFetch, url!)).toContainEqual({
      site: "radarr.home.example",
      upstream: "192.168.1.10:7878",
    });
  });
});
