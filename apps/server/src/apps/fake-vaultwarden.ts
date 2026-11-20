import type { Fetch } from "./http";

/**
 * A stand-in Vaultwarden (port 8222) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering its admin page's calls as a throwaway vaultwarden/server 1.37.5 did: an admin
 * token starting "e2e-", a session cookie, Vaultwarden's 3 admin sign-ins in 5 minutes, accounts
 * (one with two-step sign-in, one invited, one turned off), open sign-ups, and the actions only
 * for JSON requests. Each account carries key material and the settings carry a masked token, and
 * the stand-in's secret (e2e-SECRET) sits in them: none of it may reach the panel.
 */

export interface FakeVaultwarden {
  fetch: Fetch;
  reset(): void;
  /** How many admin sign-ins it took (tests). */
  signIns(): number;
}

interface User {
  id: string;
  email: string;
  name: string;
  _status: number;
  userEnabled: boolean;
  twoFactorEnabled: boolean;
  lastActive: string | null;
  orgs: string[];
}

const SECRET = "e2e-SECRET";
const LIMIT = 3;

export function fakeVaultwarden(): FakeVaultwarden {
  let users: User[] = [];
  let logins: number[] = [];
  let total = 0;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const reset = () => {
    users = [
      {
        id: "u-alex",
        email: "alex@example.com",
        name: "Alex",
        _status: 0,
        userEnabled: true,
        twoFactorEnabled: true,
        lastActive: ago(15),
        orgs: ["Family"],
      },
      {
        id: "u-sam",
        email: "sam@example.com",
        name: "Sam",
        _status: 0,
        userEnabled: true,
        twoFactorEnabled: false,
        lastActive: ago(60 * 26),
        orgs: ["Family"],
      },
      {
        id: "u-gran",
        email: "gran@example.com",
        name: "gran@example.com",
        _status: 1,
        userEnabled: true,
        twoFactorEnabled: false,
        lastActive: null,
        orgs: [],
      },
      {
        id: "u-old",
        email: "old@example.com",
        name: "Old account",
        _status: 0,
        userEnabled: false,
        twoFactorEnabled: false,
        lastActive: ago(60 * 24 * 200),
        orgs: [],
      },
    ];
    logins = [];
    total = 0;
  };
  reset();

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    };
  };
  const notFound = () => reply(404, "<html><title>Page not found!</title></html>");

  const raw = (u: User) => ({
    _status: u._status,
    email: u.email,
    name: u.name,
    id: u.id,
    userEnabled: u.userEnabled,
    twoFactorEnabled: u.twoFactorEnabled,
    lastActive: u.lastActive,
    createdAt: "2026-01-04 10:00:00 +00:00",
    creationDate: "2026-01-04T10:00:00.000000Z",
    // What Hearth must never pass on.
    key: `2.${SECRET}|key`,
    privateKey: `2.${SECRET}|private`,
    securityStamp: SECRET,
    organizations: u.orgs.map((name) => ({ name, id: `org-${name}` })),
  });

  const diagnostics = () =>
    `<html><body><script type="application/json" id="diagnostics_json">${JSON.stringify({
      active_web_release: "2026.10.1",
      admin_url: "https://vault.example.com/admin/diagnostics",
      config_file_status: "Found",
      current_release: "1.37.5",
      latest_release: "1.38.0",
      db_type: "SQLite",
      db_version: "3.53.2",
      invalid_env_vars: "",
      ip_header_exists: true,
      uses_proxy: false,
      web_vault_compare: 0,
    })}</script></body></html>`;

  const config = () => ({
    admin_token: "***",
    signups_allowed: true,
    signups_domains_whitelist: "",
    signups_verify: false,
    invitations_allowed: true,
    emergency_access_allowed: true,
    sends_allowed: true,
    password_hints_allowed: true,
    show_password_hint: false,
    smtp_host: null,
    smtp_password: SECRET,
    use_sendmail: false,
    web_vault_enabled: true,
    hibp_api_key: SECRET,
  });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    if (path === "/admin" && method === "POST") {
      const now = Date.now();
      logins = logins.filter((t) => now - t < 300_000);
      if (logins.length >= LIMIT) return reply(429, "Too many requests");
      logins.push(now);
      total += 1;
      const token = new URLSearchParams(init.body ?? "").get("token") ?? "";
      if (!token.startsWith("e2e-")) return reply(401, "<html>Invalid admin token</html>");
      return reply(200, "<html>admin</html>", {
        "set-cookie": "VW_ADMIN=e2e-session; HttpOnly; Path=/admin; Max-Age=1200",
      });
    }
    if (!path.startsWith("/admin/")) return notFound();
    if (!/VW_ADMIN=e2e-session/.test(init.headers.Cookie ?? ""))
      return reply(401, "<html>login</html>");
    if (method === "GET") {
      if (path === "/admin/users") return reply(200, users.map(raw));
      if (path === "/admin/diagnostics/config") return reply(200, config());
      if (path === "/admin/diagnostics") return reply(200, diagnostics());
      return notFound();
    }
    // Vaultwarden routes its admin actions only for JSON requests.
    if (init.headers["Content-Type"] !== "application/json") return notFound();
    if (path === "/admin/invite") {
      const email = String((JSON.parse(init.body ?? "{}") as { email?: string }).email ?? "");
      if (users.some((x) => x.email === email))
        return reply(400, { message: "User already exists" });
      users.push({
        id: `u-${users.length + 1}`,
        email,
        name: email,
        _status: 1,
        userEnabled: true,
        twoFactorEnabled: false,
        lastActive: null,
        orgs: [],
      });
      return reply(200, {});
    }
    if (path === "/admin/config/backup_db")
      return reply(200, "Backup to 'data/db_20261108_090000.sqlite3' was successful");
    const m =
      /^\/admin\/users\/([^/]+)\/(disable|enable|deauth|remove-2fa|invite\/resend|delete)$/.exec(
        path,
      );
    const user = m ? users.find((x) => x.id === decodeURIComponent(m[1]!)) : undefined;
    if (!m) return notFound();
    if (!user) return reply(404, { message: "User doesn't exist" });
    if (m[2] === "disable") user.userEnabled = false;
    if (m[2] === "enable") user.userEnabled = true;
    if (m[2] === "remove-2fa") user.twoFactorEnabled = false;
    if (m[2] === "delete") users = users.filter((x) => x !== user);
    return reply(200, "");
  };

  return { fetch: fetchImpl, reset, signIns: () => total };
}
