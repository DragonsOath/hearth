import type { Fetch } from "./http";

/**
 * A stand-in for Tailscale's API (api.tailscale.com, only with DC_FAKE_APPS=1, never in a real
 * install), with the routes, fields and request bodies of Tailscale's official API client: a
 * token starting "tskey-api-e2e" sent as Basic auth, a tailnet with a home server offering an
 * exit node and a subnet route, a laptop whose key runs out in 5 days, an offline phone with an
 * update, a Raspberry Pi waiting for approval and a device shared in from another tailnet. Each
 * device carries machine and node keys (e2e-SECRET): they may never reach the panel.
 */

export interface FakeTailscale {
  fetch: Fetch;
  reset(): void;
}

interface Dev {
  nodeId: string;
  name: string;
  hostname: string;
  os: string;
  user: string;
  tags: string[];
  addresses: string[];
  connectedToControl: boolean;
  lastSeen: string | null;
  authorized: boolean;
  expires: string;
  keyExpiryDisabled: boolean;
  clientVersion: string;
  updateAvailable: boolean;
  advertisedRoutes: string[];
  enabledRoutes: string[];
  isExternal: boolean;
}

const SECRET = "e2e-SECRET";
const DOMAIN = "tail1234.ts.net";

export function fakeTailscale(): FakeTailscale {
  let devices: Dev[] = [];
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const reset = () => {
    const dev = (name: string, over: Partial<Dev>): Dev => ({
      nodeId: `n${name}CNTRL`,
      name: `${name}.${DOMAIN}`,
      hostname: name,
      os: "linux",
      user: "alex@example.com",
      tags: [],
      addresses: ["fd7a:115c:a1e0::1", `100.64.0.${devices.length + 1}`],
      connectedToControl: true,
      lastSeen: null,
      authorized: true,
      expires: at(150),
      keyExpiryDisabled: false,
      clientVersion: "1.90.4-t1234abcd",
      updateAvailable: false,
      advertisedRoutes: [],
      enabledRoutes: [],
      isExternal: false,
      ...over,
    });
    devices = [];
    devices.push(
      dev("nas", {
        tags: ["tag:server"],
        keyExpiryDisabled: true,
        expires: "0001-01-01T00:00:00Z",
        advertisedRoutes: ["0.0.0.0/0", "::/0", "192.168.1.0/24"],
      }),
    );
    devices.push(dev("laptop", { os: "macOS", expires: at(5) }));
    devices.push(
      dev("phone", {
        os: "iOS",
        connectedToControl: false,
        lastSeen: at(-3),
        updateAvailable: true,
        clientVersion: "1.88.1",
      }),
    );
    devices.push(dev("new-pi", { authorized: false, user: "sam@example.com" }));
    devices.push(
      dev("friends-server", {
        name: `friends-server.other-tailnet.ts.net`,
        isExternal: true,
        user: "friend@example.com",
      }),
    );
  };
  reset();

  const reply = (status: number, body: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text || "null") as unknown,
      text: async () => text,
    };
  };
  const raw = (d: Dev) => ({
    ...d,
    id: d.nodeId.replace("CNTRL", ""),
    // What Hearth must never pass on.
    machineKey: `mkey:${SECRET}`,
    nodeKey: `nodekey:${SECRET}`,
    tailnetLockKey: `nlpub:${SECRET}`,
  });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const auth = Buffer.from(
      (init.headers.Authorization ?? "").replace(/^Basic /, ""),
      "base64",
    ).toString();
    if (!auth.startsWith("tskey-api-e2e")) return reply(401, { message: "API token invalid" });
    const path = u.pathname.replace(/^\/api\/v2/, "");
    const method = init.method ?? "GET";
    const body = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    if (path === "/tailnet/-/devices") return reply(200, { devices: devices.map(raw) });
    if (path === "/tailnet/-/dns/preferences") return reply(200, { magicDNS: true });
    if (path === "/tailnet/-/dns/nameservers") return reply(200, { dns: ["1.1.1.1", "9.9.9.9"] });
    const m = /^\/device\/([^/]+)(?:\/(authorized|key|routes|name))?$/.exec(path);
    const d = m ? devices.find((x) => x.nodeId === decodeURIComponent(m[1]!)) : undefined;
    if (!m) return reply(404, { message: "not found" });
    if (!d) return reply(404, { message: "device not found" });
    if (method === "DELETE" && !m[2]) {
      devices = devices.filter((x) => x !== d);
      return reply(200, undefined);
    }
    if (m[2] === "routes" && method === "GET")
      return reply(200, { advertisedRoutes: d.advertisedRoutes, enabledRoutes: d.enabledRoutes });
    if (method !== "POST") return reply(405, { message: "method not allowed" });
    if (m[2] === "authorized") d.authorized = body.authorized === true;
    if (m[2] === "key") d.keyExpiryDisabled = body.keyExpiryDisabled === true;
    if (m[2] === "routes") {
      const routes = (body.routes as string[]) ?? [];
      if (routes.some((r) => !d.advertisedRoutes.includes(r)))
        return reply(400, { message: "route not advertised by device" });
      d.enabledRoutes = routes;
    }
    if (m[2] === "name") {
      d.name = `${String(body.name)}.${DOMAIN}`;
    }
    return reply(
      200,
      m[2] === "routes"
        ? { advertisedRoutes: d.advertisedRoutes, enabledRoutes: d.enabledRoutes }
        : undefined,
    );
  };

  return { fetch: fetchImpl, reset };
}
