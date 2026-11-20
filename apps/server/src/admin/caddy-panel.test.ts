import { describe, expect, it } from "vitest";
import { parseCaddyConfig, readCaddyConfig } from "./caddy-panel";

/** Caddy's panel reads its running configuration; this is the shape Caddy 2 returns from /config/. */

const proxy = (dial: string) => ({
  handler: "reverse_proxy",
  upstreams: [{ dial }],
  headers: { request: { set: { "X-Real-Ip": ["127.0.0.1"] } } },
});
const route = (host: string, handle: unknown[]) => ({
  match: [{ host: [host] }],
  handle: [{ handler: "subroute", routes: [{ handle }] }],
  terminal: true,
});
const CONFIG = {
  apps: {
    http: {
      servers: {
        srv0: {
          listen: [":443"],
          routes: [
            route("photos.example.com", [proxy("10.0.0.5:2283")]),
            route("admin.example.com", [
              {
                handler: "authentication",
                providers: {
                  http_basic: { accounts: [{ username: "owner", password: "$2a$14$secret-hash" }] },
                },
              },
              proxy("10.0.0.5:9000"),
            ]),
            route("books.example.com", [
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: "tinyauth:3000" }],
                handle_response: [{ match: { status_code: [2] }, routes: [] }],
              },
              proxy("10.0.0.5:13378"),
            ]),
            route("old.example.com", [{ handler: "static_response", status_code: 302 }]),
            { handle: [{ handler: "static_response" }] },
          ],
        },
      },
    },
  },
};

describe("the Caddy panel", () => {
  it("lists each site, where it goes, and how visitors sign in, sorted by name", () => {
    expect(parseCaddyConfig(CONFIG)).toEqual([
      { hosts: ["admin.example.com"], upstreams: ["10.0.0.5:9000"], signIn: "password" },
      {
        hosts: ["books.example.com"],
        upstreams: ["10.0.0.5:13378"],
        signIn: "sign-in service",
        signInVia: "tinyauth:3000",
      },
      { hosts: ["old.example.com"], upstreams: [], signIn: "none", fixed: true },
      { hosts: ["photos.example.com"], upstreams: ["10.0.0.5:2283"], signIn: "none" },
    ]);
  });

  it("never carries a username, password hash, or header out of the configuration", () => {
    const out = JSON.stringify(parseCaddyConfig(CONFIG));
    expect(out).not.toMatch(/secret-hash|owner|X-Real-Ip/);
  });
});

describe("readCaddyConfig", () => {
  it("reads with a plain GET that a Caddy-style origin check accepts", async () => {
    const { createServer } = await import("node:http");
    // Like Caddy's enforce_origin: a request that looks like a browser's (Sec-Fetch-Mode) but
    // carries no Origin is refused.
    const server = createServer((req, res) => {
      if (req.headers["sec-fetch-mode"] && !req.headers.origin) {
        res.writeHead(403).end('{"error":"client is not allowed to access from origin \'\'"}');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(CONFIG));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const url = `http://127.0.0.1:${port}/config/`;
      expect((await fetch(url)).status).toBe(403);
      expect(parseCaddyConfig(await readCaddyConfig(url)).length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
