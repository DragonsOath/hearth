import type { Fetch } from "./http";

/**
 * A stand-in wg-easy 15 (port 51821) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering its API as a throwaway ghcr.io/wg-easy/wg-easy:15 did: Basic auth with an
 * e2e- password, clients (one connected now, one idle, one turned off with an end date in the
 * past), the user and interface settings, and the client changes. Each client carries keys and the
 * interface carries hooks and its own keys (e2e-SECRET): none of it may reach the panel. Asking
 * for a client's configuration or QR code fails the test that asked.
 */

export interface FakeWgEasy {
  fetch: Fetch;
  reset(): void;
  /** Whether anything asked for a client's configuration, QR code or one-time link (tests). */
  askedForSecrets(): boolean;
}

interface Client {
  id: number;
  name: string;
  enabled: boolean;
  ipv4Address: string;
  latestHandshakeAt: string | null;
  endpoint: string | null;
  transferRx: number;
  transferTx: number;
  expiresAt: string | null;
}

const SECRET = "e2e-SECRET";

export function fakeWgEasy(): FakeWgEasy {
  let clients: Client[] = [];
  let next = 10;
  let secrets = false;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const reset = () => {
    clients = [
      {
        id: 1,
        name: "Alex's phone",
        enabled: true,
        ipv4Address: "10.8.0.2",
        latestHandshakeAt: ago(1),
        endpoint: "203.0.113.24:51413",
        transferRx: 482_000_000,
        transferTx: 3_100_000_000,
        expiresAt: null,
      },
      {
        id: 2,
        name: "laptop",
        enabled: true,
        ipv4Address: "10.8.0.3",
        latestHandshakeAt: ago(60 * 26),
        endpoint: "198.51.100.7:60211",
        transferRx: 12_000_000,
        transferTx: 90_000_000,
        expiresAt: null,
      },
      {
        id: 3,
        name: "guest tablet",
        enabled: false,
        ipv4Address: "10.8.0.4",
        latestHandshakeAt: null,
        endpoint: null,
        transferRx: 0,
        transferTx: 0,
        expiresAt: ago(60 * 24 * 3),
      },
    ];
    next = 10;
    secrets = false;
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
  const raw = (c: Client) => ({
    ...c,
    userId: 1,
    interfaceId: "wg0",
    ipv6Address: `fdcc::${c.id}`,
    publicKey: `pub-${SECRET}`,
    preUp: "",
    postUp: "",
    preDown: "",
    postDown: "",
    allowedIps: null,
    serverAllowedIps: [],
    dns: null,
    mtu: 1420,
    persistentKeepalive: 0,
    oneTimeLink: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
  });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    const [, pw] = Buffer.from((init.headers.Authorization ?? "").replace(/^Basic /, ""), "base64")
      .toString()
      .split(":");
    if (!pw?.startsWith("e2e-")) return reply(401, { message: "Session failed. No Authorization" });
    const body = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    if (/\/(configuration|qrcode\.svg|generateOneTimeLink)$/.test(path)) {
      secrets = true;
      return reply(200, { config: `[Interface]\nPrivateKey = ${SECRET}` });
    }
    if (path === "/api/information")
      return reply(200, {
        currentRelease: "15.2.2",
        latestRelease: { version: "15.3.0" },
        updateAvailable: true,
      });
    if (path === "/api/admin/userconfig")
      return reply(200, {
        host: "vpn.example.com",
        port: 51820,
        defaultDns: ["1.1.1.1"],
        defaultAllowedIps: ["0.0.0.0/0", "::/0"],
      });
    if (path === "/api/admin/interface")
      return reply(200, {
        name: "wg0",
        port: 51820,
        ipv4Cidr: "10.8.0.0/24",
        privateKey: SECRET,
        publicKey: `pub-${SECRET}`,
      });
    if (path === "/api/admin/interface/restart") return reply(200, { success: true });
    if (path === "/api/client" && method === "GET") return reply(200, clients.map(raw));
    if (path === "/api/client" && method === "POST") {
      const id = next++;
      clients.push({
        id,
        name: String(body.name),
        enabled: true,
        ipv4Address: `10.8.0.${id}`,
        latestHandshakeAt: null,
        endpoint: null,
        transferRx: 0,
        transferTx: 0,
        expiresAt: (body.expiresAt as string | null) ?? null,
      });
      return reply(200, { success: true, clientId: id });
    }
    const m = /^\/api\/client\/(\d+)(?:\/(enable|disable))?$/.exec(path);
    const c = m ? clients.find((x) => x.id === Number(m[1])) : undefined;
    if (!m) return reply(404, { message: `Page not found: ${path}` });
    if (!c) return reply(404, { message: "Client not found" });
    if (m[2]) {
      c.enabled = m[2] === "enable";
      return reply(200, { success: true });
    }
    if (method === "DELETE") {
      clients = clients.filter((x) => x !== c);
      return reply(200, { success: true });
    }
    if (method === "POST") {
      // Its update takes the whole client: a missing field is refused.
      if (!("ipv4Address" in body) || !("mtu" in body))
        return reply(400, { message: "Invalid body" });
      c.name = String(body.name);
      c.expiresAt = (body.expiresAt as string | null) ?? null;
      return reply(200, { success: true });
    }
    return reply(200, raw(c));
  };

  return { fetch: fetchImpl, reset, askedForSecrets: () => secrets };
}
