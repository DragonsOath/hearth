import type { Fetch } from "./http";
import type { RawHost } from "./npm";

/**
 * A stand-in Nginx Proxy Manager (port 81) for tests and safe previews (DC_FAKE_APPS=1, never in a
 * real install), answering as a throwaway jc21/nginx-proxy-manager 2.16.0 did: a token for an
 * e2e- password, proxy hosts (one that nginx could not load), certificates (one expiring soon,
 * one from Let's Encrypt), a redirection, an access list, and an audit log whose copies of objects
 * hold a secret that must never reach the panel.
 */

export interface FakeNpm {
  fetch: Fetch;
  reset(): void;
  hosts(): RawHost[];
}

const DAY = 86_400_000;
const npmTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export function fakeNpm(): FakeNpm {
  let hosts: RawHost[] = [];
  let certs: {
    id: number;
    nice_name: string;
    domain_names: string[];
    provider: string;
    expires_on: string;
  }[] = [];
  let next = 10;
  const reset = () => {
    const now = Date.now();
    certs = [
      {
        id: 1,
        nice_name: "example.com",
        domain_names: ["*.example.com"],
        provider: "letsencrypt",
        expires_on: npmTime(now + 6 * DAY),
      },
      {
        id: 2,
        nice_name: "Home test",
        domain_names: ["nas.home.example"],
        provider: "other",
        expires_on: npmTime(now + 200 * DAY),
      },
    ];
    hosts = [
      {
        id: 1,
        domain_names: ["radarr.example.com"],
        forward_scheme: "http",
        forward_host: "192.168.1.10",
        forward_port: 7878,
        enabled: true,
        certificate_id: 1,
        ssl_forced: true,
        access_list_id: 1,
        allow_websocket_upgrade: true,
        block_exploits: true,
        meta: { nginx_online: true, nginx_err: null },
      },
      {
        id: 2,
        domain_names: ["broken.example.com"],
        forward_scheme: "http",
        forward_host: "192.168.1.11",
        forward_port: 80,
        enabled: true,
        certificate_id: 0,
        ssl_forced: false,
        access_list_id: 0,
        allow_websocket_upgrade: false,
        block_exploits: false,
        meta: {
          nginx_online: false,
          nginx_err:
            'nginx: [emerg] unknown directive "this" in /data/nginx/proxy_host/2.conf:37\nnginx: configuration file /etc/nginx/nginx.conf test failed\n',
        },
      },
    ];
    next = 10;
  };
  reset();

  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  const err = (status: number, message: string) =>
    reply(status, { error: { code: status, message } });
  const expand = (h: RawHost) => {
    const cert = certs.find((x) => x.id === Number(h.certificate_id));
    return {
      ...h,
      certificate: cert ?? null,
      access_list: h.access_list_id === 1 ? { id: 1, name: "Family only" } : null,
    };
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (p === "/" && method === "GET")
      return reply(200, {
        status: "OK",
        setup: true,
        version: { major: 2, minor: 16, revision: 0 },
      });
    if (p === "/tokens" && method === "POST")
      return String(body.secret ?? "").startsWith("e2e-")
        ? reply(200, { token: "npm-e2e-token", expires: new Date(Date.now() + DAY).toISOString() })
        : err(400, "Invalid email or password");
    if ((init.headers as Record<string, string>).Authorization !== "Bearer npm-e2e-token")
      return err(401, "Permission Denied");

    if (p === "/nginx/proxy-hosts" && method === "GET")
      return reply(200, u.searchParams.get("expand") ? hosts.map(expand) : hosts);
    if (p === "/nginx/proxy-hosts" && method === "POST") {
      const domain = (body.domain_names as string[])[0]!;
      if (hosts.some((h) => h.domain_names.includes(domain)))
        return err(400, `${domain} is already in use`);
      const h: RawHost = {
        id: next++,
        domain_names: body.domain_names as string[],
        forward_scheme: body.forward_scheme as "http" | "https",
        forward_host: String(body.forward_host),
        forward_port: Number(body.forward_port),
        enabled: true,
        certificate_id: Number(body.certificate_id ?? 0),
        ssl_forced: Boolean(body.ssl_forced),
        access_list_id: Number(body.access_list_id ?? 0),
        allow_websocket_upgrade: Boolean(body.allow_websocket_upgrade),
        block_exploits: Boolean(body.block_exploits),
        meta: { nginx_online: true, nginx_err: null },
      };
      hosts.push(h);
      return reply(201, h);
    }
    const one = p.match(/^\/nginx\/proxy-hosts\/(\d+)(?:\/(enable|disable))?$/);
    if (one) {
      const h = hosts.find((x) => x.id === Number(one[1]));
      if (!h) return err(404, "Not Found");
      if (one[2]) {
        const on = one[2] === "enable";
        if (Boolean(h.enabled) === on)
          return err(400, `Host is already ${on ? "enabled" : "disabled"}`);
        h.enabled = on;
        return reply(200, true);
      }
      if (method === "PUT") {
        Object.assign(h, body);
        return reply(200, h);
      }
      if (method === "DELETE") {
        hosts = hosts.filter((x) => x !== h);
        return reply(200, true);
      }
      return reply(200, expand(h));
    }
    if (p === "/nginx/certificates")
      return reply(
        200,
        certs.map((c) => ({
          ...c,
          // As NPM sends an uploaded certificate's files with it at times: never shown by Hearth.
          meta:
            c.provider === "other"
              ? { certificate_key: "-----BEGIN PRIVATE KEY----- e2e-SECRET" }
              : {},
          ...(u.searchParams.get("expand")
            ? {
                proxy_hosts: hosts
                  .filter((h) => Number(h.certificate_id) === c.id)
                  .map((h) => ({ domain_names: h.domain_names })),
              }
            : {}),
        })),
      );
    const renew = p.match(/^\/nginx\/certificates\/(\d+)\/renew$/);
    if (renew) {
      const c = certs.find((x) => x.id === Number(renew[1]));
      if (!c) return err(404, "Not Found");
      if (c.provider !== "letsencrypt")
        return err(400, "Only Let'sEncrypt certificates can be renewed");
      c.expires_on = npmTime(Date.now() + 90 * DAY);
      return reply(200, c);
    }
    if (p === "/nginx/redirection-hosts")
      return reply(200, [
        {
          id: 1,
          domain_names: ["old.example.com"],
          forward_scheme: "https",
          forward_domain_name: "new.example.com",
          enabled: 1,
        },
      ]);
    if (p === "/nginx/streams") return reply(200, []);
    if (p === "/nginx/dead-hosts") return reply(200, []);
    if (p === "/nginx/access-lists")
      return reply(200, [
        { id: 1, name: "Family only", items: [{ username: "kid", password: "e2e-SECRET" }] },
      ]);
    if (p === "/audit-log")
      return reply(200, [
        {
          created_on: npmTime(Date.now() - DAY),
          action: "updated",
          object_type: "proxy-host",
          user: { name: "Alex" },
          meta: {
            domain_names: ["radarr.example.com"],
            advanced_config: "proxy_set_header Authorization e2e-SECRET;",
          },
        },
      ]);
    return err(404, "Not Found");
  };

  return { fetch: fetchImpl, reset, hosts: () => hosts };
}
