import type { Fetch } from "./http";

/**
 * A stand-in Nextcloud (port 11000) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering its OCS API and setup checks as a throwaway nextcloud:apache 35.0.2 did:
 * Basic auth with an e2e- password, three accounts (an administrator, a family member near their
 * quota, one turned off), groups, apps with one update, background jobs that last ran two hours
 * ago, public links without a password, and setup checks with an error. A password starting
 * "e2e-app-" acts as an app password: it reads, and every change asks for password confirmation,
 * as the real one does. Account details hold no password; the admin's is e2e-SECRET only in the
 * Authorization header the tests send.
 */

export interface FakeNextcloud {
  fetch: Fetch;
  reset(): void;
  /** Turn maintenance mode on or off (tests). */
  maintenance(on: boolean): void;
}

const GB = 1024 ** 3;

interface User {
  id: string;
  displayname: string;
  email: string | null;
  enabled: boolean;
  groups: string[];
  quota: number;
  used: number;
  lastLogin: number;
}

export function fakeNextcloud(): FakeNextcloud {
  let users: User[] = [];
  let groups: string[] = [];
  let apps: Record<string, { name: string; version: string; enabled: boolean; summary: string }> =
    {};
  let config: Record<string, string> = {};
  let maintenance = false;
  const now = () => Math.floor(Date.now() / 1000);
  const reset = () => {
    users = [
      {
        id: "admin",
        displayname: "Alex",
        email: "alex@example.com",
        enabled: true,
        groups: ["admin"],
        quota: -3,
        used: 12 * GB,
        lastLogin: Date.now() - 600_000,
      },
      {
        id: "sam",
        displayname: "Sam",
        email: "sam@example.com",
        enabled: true,
        groups: ["family"],
        quota: 10 * GB,
        used: 9.6 * GB,
        lastLogin: Date.now() - 86_400_000,
      },
      {
        id: "guest",
        displayname: "Old guest",
        email: null,
        enabled: false,
        groups: [],
        quota: 1 * GB,
        used: 0,
        lastLogin: 0,
      },
    ];
    groups = ["admin", "family"];
    apps = {
      files: { name: "Files", version: "2.5.0", enabled: true, summary: "File management" },
      serverinfo: {
        name: "Monitoring",
        version: "5.0.0",
        enabled: true,
        summary: "Monitoring app",
      },
      calendar: { name: "Calendar", version: "6.0.1", enabled: true, summary: "A calendar app" },
      photos: { name: "Photos", version: "5.0.0", enabled: true, summary: "Your memories" },
      admin_audit: {
        name: "Auditing / Logging",
        version: "1.22.0",
        enabled: false,
        summary: "Audit trail for Nextcloud",
      },
    };
    config = { lastcron: String(now() - 7200), backgroundjobs_mode: "" };
    maintenance = false;
  };
  reset();

  const reply = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const ocs = (status: number, data: unknown, message = "OK") =>
    reply(status, {
      ocs: {
        meta: { status: status < 400 ? "ok" : "failure", statuscode: status, message },
        data,
      },
    });
  const fail = (status: number, message: string) => ocs(status, [], message);

  const details = (u: User) => ({
    enabled: u.enabled,
    storageLocation: `/var/www/html/data/${u.id}`,
    id: u.id,
    lastLogin: u.lastLogin,
    backend: "Database",
    quota: { free: -3, used: u.used, total: -3, relative: 0, quota: u.quota },
    email: u.email,
    displayname: u.displayname,
    "display-name": u.displayname,
    groups: u.groups,
    language: "en",
    backendCapabilities: { setDisplayName: true, setPassword: true },
  });

  const serverinfo = () => ({
    nextcloud: {
      system: {
        version: "35.0.2.2",
        "memcache.local": "\\OC\\Memcache\\APCu",
        freespace: 412 * GB,
        cpuload: [0.42, 0.5, 0.61],
        cpunum: 4,
        mem_total: 16472064,
        mem_free: 9472064,
        apps: {
          num_installed: Object.keys(apps).length,
          num_updates_available: 1,
          app_updates: { calendar: "6.1.0" },
        },
        update: { lastupdatedat: now() - 3600, available: false },
      },
      // Cached counts, as the real one keeps them for a while.
      storage: { num_users: 3, num_disabled_users: 1, num_files: 48210 },
      shares: {
        num_shares: 14,
        num_shares_link: 5,
        num_shares_link_no_password: 3,
        num_fed_shares_sent: 0,
      },
    },
    server: {
      webserver: "Apache/2.4.69 (Debian)",
      php: { version: "8.5.12" },
      database: { type: "mysql", version: "11.4.5", size: 734003200 },
    },
    activeUsers: {
      last5minutes: 1,
      last1hour: 1,
      last24hours: 2,
      last7days: 2,
      last1month: 2,
    },
  });

  const check = (name: string, severity: string, description: string, link?: string) => ({
    name,
    severity,
    description,
    descriptionParameters: null,
    linkToDoc: link ?? null,
  });
  const setupchecks = () => ({
    system: {
      "OCA\\Settings\\SetupChecks\\CronInfo":
        now() - Number(config.lastcron) > 3600
          ? check(
              "Cron last run",
              "error",
              "Last background job execution ran 2 hours ago. Something seems wrong.",
              "https://docs.nextcloud.com/server/35/go.php?to=admin-background-jobs",
            )
          : check("Cron last run", "success", "Last background job execution ran seconds ago."),
      "OCA\\Settings\\SetupChecks\\MaintenanceWindowStart": check(
        "Maintenance window start",
        "warning",
        "Server has no maintenance window start time configured.",
      ),
      "OCA\\Settings\\SetupChecks\\DebugMode": check(
        "Debug mode",
        "success",
        "Debug mode is disabled.",
      ),
    },
    security: {
      "OCA\\Settings\\SetupChecks\\HttpsUrlGeneration": check(
        "HTTPS access and URLs",
        "error",
        "Accessing site insecurely via HTTP.",
      ),
      "OCA\\Settings\\SetupChecks\\TwoFactorConfiguration": check(
        "Second factor configuration",
        "info",
        "Second factor providers are available but two-factor authentication is not enforced.",
      ),
    },
  });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const path = u.pathname;
    if (path === "/status.php")
      return reply(200, {
        installed: true,
        maintenance,
        needsDbUpgrade: false,
        version: "35.0.2.2",
        versionstring: "35.0.2",
        productname: "Nextcloud",
      });
    const [user, pw] = Buffer.from(
      (init.headers.Authorization ?? "").replace(/^Basic /, ""),
      "base64",
    )
      .toString()
      .split(":");
    if (!user || !pw?.startsWith("e2e-"))
      return reply(401, { message: "Current user is not logged in" });
    if (maintenance) return reply(503, { message: "maintenance" });
    const appPassword = pw.startsWith("e2e-app-");
    const body = new URLSearchParams(init.body ?? "");
    const change = method !== "GET";
    if (change && appPassword) return fail(403, "Password confirmation is required");

    if (path === "/index.php/settings/setupcheck") return reply(200, setupchecks());
    if (path === "/ocs/v2.php/apps/serverinfo/api/v1/info") return ocs(200, serverinfo());
    if (path === "/ocs/v2.php/cloud/user") return ocs(200, details(users[0]!));
    if (path === "/ocs/v2.php/cloud/users/details")
      return ocs(200, { users: Object.fromEntries(users.map((x) => [x.id, details(x)])) });
    if (path === "/ocs/v2.php/cloud/groups") return ocs(200, { groups });
    if (path === "/ocs/v2.php/core/getapppassword")
      return ocs(200, { apppassword: "e2e-app-0123456789" });

    const cfg = /^\/ocs\/v2\.php\/apps\/provisioning_api\/api\/v1\/config\/apps\/core\/(\w+)$/.exec(
      path,
    );
    if (cfg) {
      const key = cfg[1]!;
      if (method === "POST") {
        const v = body.get("value") ?? "";
        // Typed yes or no settings are stored as 1 and 0, as Nextcloud 35 does.
        config[key] = key.startsWith("shareapi_") ? (v === "yes" ? "1" : "0") : v;
        return ocs(200, []);
      }
      return ocs(200, { data: config[key] ?? "" });
    }

    if (path === "/ocs/v2.php/cloud/apps") {
      const f = u.searchParams.get("filter");
      return ocs(200, {
        apps: Object.keys(apps).filter((id) =>
          f === "disabled" ? !apps[id]!.enabled : apps[id]!.enabled,
        ),
      });
    }
    const app = /^\/ocs\/v2\.php\/cloud\/apps\/(\w+)$/.exec(path);
    if (app) {
      const a = apps[app[1]!];
      if (!a) return fail(404, "The requested app was not found");
      if (method === "POST") a.enabled = true;
      else if (method === "DELETE") a.enabled = false;
      else return ocs(200, { id: app[1], name: a.name, version: a.version, summary: a.summary });
      return ocs(200, []);
    }

    const m = /^\/ocs\/v2\.php\/cloud\/users\/([^/]+)(?:\/(enable|disable|groups))?$/.exec(path);
    const target = m ? users.find((x) => x.id === decodeURIComponent(m[1]!)) : undefined;
    if (m && !target) return fail(404, "User does not exist");
    if (m && target) {
      const what = m[2];
      if (what === "enable" || what === "disable") {
        target.enabled = what === "enable";
        return ocs(200, []);
      }
      if (what === "groups") {
        const g = method === "DELETE" ? u.searchParams.get("groupid") : body.get("groupid");
        if (!g || !groups.includes(g)) return fail(102, "Group does not exist");
        if (method === "POST" && !target.groups.includes(g)) target.groups.push(g);
        if (method === "DELETE") target.groups = target.groups.filter((x) => x !== g);
        return ocs(200, []);
      }
      if (method === "PUT" && body.get("key") === "quota") {
        const v = body.get("value") ?? "";
        target.quota = v === "none" ? -3 : Number(v);
        return ocs(200, []);
      }
      return ocs(200, details(target));
    }
    return reply(404, { message: "Not found" });
  };

  return {
    fetch: fetchImpl,
    reset,
    maintenance: (on) => {
      maintenance = on;
    },
  };
}
