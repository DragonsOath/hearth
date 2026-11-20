import type { Fetch } from "./http";

/**
 * A stand-in Mealie (port 9925) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as a throwaway ghcr.io/mealie-recipes/mealie v3.30.0 did: a token starting
 * "e2e-", its admin overview (with a database address Hearth must never copy), counts, setup checks,
 * storage, an old backup, its first-run administrator still present and a locked account. A backup
 * adds one to the list; unlocking frees the account.
 */

export interface FakeMealie {
  fetch: Fetch;
  reset(): void;
}

export function fakeMealie(): FakeMealie {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  let backups: { name: string; date: string; size: string }[] = [];
  let locked = 1;
  let images = 3;
  const reset = () => {
    backups = [{ name: "mealie_v3.30.0_2026.10.01.03.00.00.zip", date: ago(30), size: "18.2 MB" }];
    locked = 1;
    images = 3;
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

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    if (!(init.headers.Authorization ?? "").startsWith("Bearer e2e-"))
      return reply(401, { detail: "Not authenticated" });
    if (path === "/admin/about")
      return reply(200, {
        production: true,
        version: "v3.30.0",
        versionLatest: "v3.31.0",
        dbType: "postgres",
        dbUrl: "postgresql://mealie:e2e-SECRET-db-password@db:5432/mealie",
      });
    if (path === "/admin/about/statistics")
      return reply(200, {
        totalRecipes: 214,
        totalUsers: 3,
        totalHouseholds: 1,
        totalGroups: 1,
        uncategorizedRecipes: 40,
        untaggedRecipes: 12,
      });
    if (path === "/admin/about/check")
      return reply(200, {
        emailReady: false,
        ldapReady: false,
        ldapDisabled: true,
        oidcReady: false,
        oidcDisabled: true,
        baseUrlSet: true,
        isUpToDate: false,
      });
    if (path === "/admin/maintenance")
      return reply(200, { dataDirSize: "412.5 MB", cleanableImages: images, cleanableDirs: 0 });
    if (path === "/admin/maintenance/storage")
      return reply(200, {
        tempDirSize: "2.1 MB",
        backupsDirSize: "18.2 MB",
        groupsDirSize: "4.0 KB",
        recipesDirSize: "390 MB",
        userDirSize: "1.2 MB",
      });
    if (path === "/admin/backups" && method === "GET")
      return reply(200, { imports: backups, templates: [] });
    if (path === "/admin/backups" && method === "POST") {
      backups = [
        ...backups,
        {
          name: `mealie_v3.30.0_${Date.now()}.zip`,
          date: new Date().toISOString(),
          size: "18.3 MB",
        },
      ];
      return reply(201, { message: "Backup created successfully", error: false });
    }
    if (path === "/admin/users")
      return reply(200, {
        total: 3,
        items: [
          { email: "changeme@example.com", admin: true, tokens: [{ name: "hearth" }] },
          { email: "alex@example.com", admin: true },
          { email: "kid@example.com", admin: false },
        ],
      });
    if (path === "/admin/users/unlock" && method === "POST") {
      const n = locked;
      locked = 0;
      return reply(200, { unlocked: n });
    }
    if (path === "/admin/maintenance/clean/images" && method === "POST") {
      const n = images;
      images = 0;
      return reply(200, { message: `${n} Images cleaned`, error: false });
    }
    if (path === "/admin/maintenance/clean/temp" && method === "POST")
      return reply(200, { message: "'.temp' directory cleaned", error: false });
    if (path === "/admin/maintenance/clean/recipe-folders" && method === "POST")
      return reply(200, { message: "0 Recipe folders removed", error: false });
    return reply(404, { detail: "Not Found" });
  };

  return { fetch: fetchImpl, reset };
}
