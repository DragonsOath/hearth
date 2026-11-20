import type { Fetch } from "./http";

/**
 * A stand-in Traefik (port 8082; a real one's API is usually on 8080) for tests and safe previews
 * (DC_FAKE_APPS=1, never in a real install), answering as a throwaway traefik:v3 (3.7.17) did:
 * routers from Docker and a file (one refused, one whose app server is down), services with each
 * server's status, certificates (one expiring soon), and a basicAuth middleware whose password
 * hash must never reach the panel. Its API takes no key.
 */

export interface FakeTraefik {
  fetch: Fetch;
  reset(): void;
}

const DAY = 86_400_000;

export function fakeTraefik(): FakeTraefik {
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  const routers = [
    {
      name: "api@internal",
      provider: "internal",
      rule: "PathPrefix(`/api`)",
      service: "api@internal",
      status: "enabled",
      entryPoints: ["traefik"],
    },
    {
      name: "radarr@docker",
      provider: "docker",
      rule: "Host(`radarr.example.com`)",
      service: "radarr",
      status: "enabled",
      entryPoints: ["websecure"],
      tls: { certResolver: "le" },
      middlewares: ["auth@file"],
    },
    {
      name: "sonarr@docker",
      provider: "docker",
      rule: "Host(`sonarr.example.com`) && PathPrefix(`/`)",
      service: "sonarr",
      status: "enabled",
      entryPoints: ["websecure"],
      tls: {},
    },
    {
      name: "broken@file",
      provider: "file",
      rule: "Host(`broken.example.com`)",
      service: "missing-service",
      status: "disabled",
      entryPoints: ["web"],
      error: ['the service "missing-service@file" does not exist'],
    },
  ];
  const services = [
    {
      name: "radarr@docker",
      loadBalancer: { servers: [{ url: "http://172.18.0.5:7878" }] },
      serverStatus: { "http://172.18.0.5:7878": "UP" },
    },
    {
      name: "sonarr@docker",
      loadBalancer: { servers: [{ url: "http://172.18.0.6:8989" }] },
      serverStatus: { "http://172.18.0.6:8989": "DOWN" },
    },
  ];
  const fetchImpl: Fetch = async (url) => {
    const p = new URL(url).pathname;
    if (p === "/api/version") return reply(200, { Version: "3.7.17", Codename: "langres" });
    if (p === "/api/overview") return reply(200, { providers: ["Docker", "File"] });
    if (p === "/api/http/routers") return reply(200, routers);
    if (p === "/api/http/services") return reply(200, services);
    if (p === "/api/http/middlewares")
      return reply(200, [{ name: "auth@file", basicAuth: { users: ["alex:$apr1$e2e-SECRET"] } }]);
    if (p === "/api/certificates")
      return reply(200, [
        {
          sans: ["*.example.com"],
          commonName: "example.com",
          issuerCN: "R11",
          notAfter: new Date(Date.now() + 9 * DAY).toISOString(),
          status: "enabled",
        },
      ]);
    if (p === "/api/entrypoints")
      return reply(200, [
        { name: "web", address: ":80" },
        { name: "websecure", address: ":443" },
        { name: "traefik", address: ":8080" },
      ]);
    return reply(404, "404 page not found");
  };
  return { fetch: fetchImpl, reset: () => undefined };
}
