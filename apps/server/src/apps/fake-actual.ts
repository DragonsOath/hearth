import type { Fetch } from "./http";

/**
 * A stand-in Actual Budget sync server (port 5006) for tests and safe previews (DC_FAKE_APPS=1,
 * never in a real install), answering as a throwaway actualbudget/actual-server 26.11.0 did: health,
 * version, memory and uptime, password sign-in (any password starting "e2e-"), and its budget files,
 * one encrypted and one in the trash. It counts sign-ins, so tests can see the session is reused.
 */

export interface FakeActual {
  fetch: Fetch;
  reset(): void;
  signIns(): number;
}

export function fakeActual(): FakeActual {
  let signIns = 0;
  const tokens = new Set<string>();
  const reset = () => {
    signIns = 0;
    tokens.clear();
  };

  const reply = (status: number, body: unknown) => {
    const text = JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    };
  };

  const fetchImpl: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    if (path === "/health") return reply(200, { status: "UP" });
    if (path === "/info")
      return reply(200, { build: { name: "@actual-app/sync-server", version: "26.11.0" } });
    if (path === "/metrics")
      return reply(200, { mem: { rss: 188_743_680 }, uptime: 86_400 * 3 + 120 });
    if (path === "/account/needs-bootstrap")
      return reply(200, {
        status: "ok",
        data: { bootstrapped: true, loginMethod: "password", multiuser: false },
      });
    if (path === "/account/login-methods")
      return reply(200, {
        status: "ok",
        methods: [{ method: "password", active: 1, displayName: "Password" }],
      });
    if (path === "/account/login" && method === "POST") {
      const { password } = JSON.parse(init.body ?? "{}") as { password?: string };
      if (!password?.startsWith("e2e-"))
        return reply(400, { status: "error", reason: "invalid-password" });
      signIns += 1;
      const token = `session-${signIns}`;
      tokens.add(token);
      return reply(200, { status: "ok", data: { token } });
    }
    if (path === "/sync/list-user-files") {
      if (!tokens.has(init.headers["x-actual-token"] ?? ""))
        return reply(401, { status: "error", reason: "unauthorized", details: "token-not-found" });
      return reply(200, {
        status: "ok",
        data: [
          {
            fileId: "f-household",
            name: "Household 2026",
            deleted: 0,
            encryptKeyId: "key-1",
            usersWithAccess: [{ userId: "u1" }, { userId: "u2" }],
          },
          {
            fileId: "f-trip",
            name: "Summer trip",
            deleted: 0,
            encryptKeyId: null,
            usersWithAccess: [{ userId: "u1" }],
          },
          {
            fileId: "f-old",
            name: "Household 2024",
            deleted: 1,
            encryptKeyId: null,
            usersWithAccess: [],
          },
        ],
      });
    }
    return reply(404, { status: "error", reason: "not-found" });
  };

  return { fetch: fetchImpl, reset, signIns: () => signIns };
}
