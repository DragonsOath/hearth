import type { Fetch } from "./http";

/**
 * A stand-in Authentik (port 9010) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as a throwaway ghcr.io/goauthentik/server 2026.8.5 did: a token starting
 * "e2e-", sign-ins and failed sign-ins (whose context carries a password field, as Authentik's
 * does), people and its outpost service account, protected applications, an outpost that stopped
 * checking in, a failed background task and a certificate near expiry. Turning an account off or on
 * and retrying the task change what it answers next. /admin/system/ echoes the token, as the real
 * one does, so tests can show Hearth never asks for it.
 */

export interface FakeAuthentik {
  fetch: Fetch;
  reset(): void;
}

export function fakeAuthentik(): FakeAuthentik {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  let users: {
    pk: number;
    username: string;
    name: string;
    is_active: boolean;
    is_superuser: boolean;
    type: string;
    last_login: string | null;
  }[] = [];
  let failedTask = true;
  const reset = () => {
    users = [
      {
        pk: 6,
        username: "akadmin",
        name: "Alex",
        is_active: true,
        is_superuser: true,
        type: "internal",
        last_login: ago(30),
      },
      {
        pk: 7,
        username: "sam",
        name: "Sam",
        is_active: true,
        is_superuser: false,
        type: "internal",
        last_login: ago(60 * 5),
      },
      {
        pk: 2,
        username: "ak-outpost-0f1e",
        name: "Outpost Service-Account",
        is_active: true,
        is_superuser: false,
        type: "internal_service_account",
        last_login: null,
      },
    ];
    failedTask = true;
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
  const page = (results: unknown[]) =>
    reply(200, { pagination: { count: results.length }, results });
  const event = (action: string, username: string, min: number, ip: string) => ({
    action,
    created: ago(min),
    client_ip: ip,
    user: { pk: 7, username, email: `${username}@example.com` },
    context:
      action === "login_failed"
        ? {
            stage: { name: "default-authentication-password" },
            username,
            password: "e2e-SECRET-typed",
          }
        : {},
  });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v3/, "");
    const method = init.method ?? "GET";
    const auth = init.headers.Authorization ?? "";
    if (!auth.startsWith("Bearer e2e-")) return reply(403, { detail: "Token invalid/expired" });
    if (path === "/admin/system/")
      return reply(200, { http_headers: { HTTP_AUTHORIZATION: auth } });
    if (path === "/admin/version/")
      return reply(200, {
        version_current: "2026.8.5",
        version_latest: "2026.8.5",
        version_latest_valid: true,
        outdated: false,
      });
    if (path === "/events/events/") {
      const action = u.searchParams.get("action");
      if (action === "login")
        return page([
          event("login", "akadmin", 30, "10.0.0.5"),
          event("login", "sam", 300, "10.0.0.8"),
        ]);
      if (action === "login_failed")
        return page(
          Array.from({ length: 12 }, (_, i) => event("login_failed", "sam", 20 + i, "203.0.113.9")),
        );
      return page([]);
    }
    if (path === "/core/users/me/") return reply(200, { user: { pk: 6, username: "akadmin" } });
    if (path === "/core/users/") return page(users);
    const um = /^\/core\/users\/(\d+)\/$/.exec(path);
    if (um) {
      const user = users.find((x) => x.pk === Number(um[1]));
      if (!user) return reply(404, { detail: "No User matches the given query." });
      if (method === "PATCH")
        user.is_active = Boolean(
          (JSON.parse(init.body ?? "{}") as { is_active?: boolean }).is_active,
        );
      return reply(200, user);
    }
    if (path === "/core/applications/")
      return page([
        {
          slug: "paperless",
          name: "Paperless",
          meta_launch_url: "https://paperless.example.com",
          provider_obj: { verbose_name: "Proxy Provider", client_secret: "e2e-SECRET-client" },
        },
        {
          slug: "grafana",
          name: "Grafana",
          meta_launch_url: "",
          provider_obj: { verbose_name: "OAuth2/OpenID Provider" },
        },
      ]);
    if (path === "/outposts/instances/")
      return page([
        { pk: "op-embedded", name: "authentik Embedded Outpost", type: "proxy" },
        { pk: "op-ldap", name: "LDAP outpost", type: "ldap" },
      ]);
    if (path === "/outposts/instances/op-embedded/health/")
      return reply(200, [{ last_seen: ago(1), version_outdated: false }]);
    if (path === "/outposts/instances/op-ldap/health/")
      return reply(200, [{ last_seen: ago(60 * 3), version_outdated: true }]);
    if (path === "/tasks/workers/") return reply(200, [{ worker_id: "w1", version: "2026.8.5" }]);
    if (path === "/tasks/tasks/status/")
      return reply(200, {
        queued: 0,
        running: 1,
        preprocess: 0,
        postprocess: 0,
        done: 0,
        info: 190,
        warning: 0,
        error: failedTask ? 1 : 0,
      });
    if (path === "/tasks/tasks/")
      return page(
        failedTask
          ? [
              {
                message_id: "t-1",
                uid: "authentik.outposts.tasks.outpost_send_update",
                description: "Update outpost configuration.",
                mtime: ago(15),
                logs: [{ event: "e2e-SECRET-log" }],
              },
            ]
          : [],
      );
    if (path === "/tasks/tasks/t-1/retry/" && method === "POST") {
      failedTask = false;
      return reply(204, undefined);
    }
    if (path === "/crypto/certificatekeypairs/")
      return page([
        {
          name: "authentik Self-signed Certificate",
          cert_expiry: new Date(Date.now() + 9 * 86_400_000).toISOString(),
          private_key_download_url: "/e2e-SECRET-key",
        },
        {
          name: "wildcard.example.com",
          cert_expiry: new Date(Date.now() + 200 * 86_400_000).toISOString(),
        },
      ]);
    return reply(404, { detail: "Not found." });
  };

  return { fetch: fetchImpl, reset };
}
