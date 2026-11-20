import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { signIn, signInAppOf } from "./signin";

// Signing Ember's Browser in to an app, server side (checklist 45.14), against stand-in apps
// that answer as Radarr (forms or basic) and qBittorrent do.

let server: Server | undefined;
afterEach(() => server?.close());

async function app(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const a = server.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}

const body = (req: import("node:http").IncomingMessage) =>
  new Promise<URLSearchParams>((r) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => r(new URLSearchParams(s)));
  });

describe("Ember's Browser sign-in adapters", () => {
  it("knows which apps it can sign in to", () => {
    expect(signInAppOf("radarr")).toBe("servarr");
    expect(signInAppOf("prowlarr")).toBe("servarr");
    expect(signInAppOf("qbittorrent")).toBe("qbittorrent");
    expect(signInAppOf("plex")).toBeUndefined();
  });

  it("Radarr's sign-in form: the session cookie only; a wrong password is refused", async () => {
    const origin = await app(async (req, res) => {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(302, { location: "/login?returnUrl=%2F" }).end();
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/login")) {
        const f = await body(req);
        if (f.get("username") === "hearth-test" && f.get("password") === "right-one")
          res.writeHead(302, {
            location: "/",
            "set-cookie": "RadarrAuth=session-abc123; path=/; HttpOnly",
          });
        else res.writeHead(302, { location: "/login?returnUrl=%2F&loginFailed=true" });
        res.end();
        return;
      }
      res.end();
    });
    const s = await signIn("servarr", origin, { username: "hearth-test", password: "right-one" });
    expect(s.cookies).toEqual([
      { name: "RadarrAuth", value: "session-abc123", path: "/", httpOnly: true, secure: false },
    ]);
    expect(JSON.stringify(s)).not.toContain("right-one");
    await expect(
      signIn("servarr", origin, { username: "hearth-test", password: "wrong" }),
    ).rejects.toThrow(/refused the web login/);
  });

  it("HTTP basic sign-in becomes a header for that app; no sign-in when none is asked", async () => {
    const origin = await app((req, res) => {
      if (req.headers.authorization === `Basic ${Buffer.from("u:p").toString("base64")}`)
        res.end("ok");
      else res.writeHead(401, { "www-authenticate": 'Basic realm="Radarr"' }).end();
    });
    const s = await signIn("servarr", origin, { username: "u", password: "p" });
    expect(s.authorization).toMatch(/^Basic /);
    expect(s.cookies).toEqual([]);
    server!.close();
    const open = await app((_q, res) => res.end("<title>Radarr</title>"));
    expect((await signIn("servarr", open, { username: "u", password: "p" })).how).toMatch(
      /No sign-in needed/,
    );
  });

  it("qBittorrent: its own sign-in, the SID cookie", async () => {
    const origin = await app(async (req, res) => {
      const f = await body(req);
      if (req.url === "/api/v2/auth/login" && f.get("password") === "pw")
        res.writeHead(200, { "set-cookie": "SID=sid-value-1; HttpOnly; path=/" }).end("Ok.");
      else res.end("Fails.");
    });
    const s = await signIn("qbittorrent", origin, { username: "admin", password: "pw" });
    expect(s.cookies.map((c) => c.name)).toEqual(["SID"]);
    await expect(
      signIn("qbittorrent", origin, { username: "admin", password: "x" }),
    ).rejects.toThrow(/refused/);
  });
});
