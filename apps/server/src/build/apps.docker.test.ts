import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realRun } from "../admin/host";
import { applyCompose } from "../admin/protected";
import { RECIPES, RECIPE_IDS, NETWORK, internalHost, type RecipeContext } from "./recipes";
import {
  arrKey,
  connectDownloadClient,
  connectProwlarrApp,
  connectSeerrArr,
  setupArr,
  setupJellyfin,
  setupQbittorrent,
  setupSeerr,
} from "./setup";

/**
 * The real apps (build-apps.yml, on a Linux machine with Docker): every recipe started from its
 * Compose file, each account made through the app's own API and signed in with, and the apps
 * connected to each other, all read back from the apps themselves. Only the VPN is left out (CI has
 * no VPN account): qBittorrent runs on its own here.
 */
const ON = process.env.DC_BUILD_DOCKER_TEST === "1";

describe.skipIf(!ON)("Build my plan, on the real apps", () => {
  let root = "";
  let ctx: RecipeContext;
  // A capital letter on purpose: the *arr apps keep user names in lower case (11-22).
  const account = { username: "HearthTest", password: "Hearth-test-Password-1" };
  const keys: Record<string, string> = {};
  const file = (id: string) => path.join(root, id, "compose.yaml");
  const logs = async (c: string) =>
    (await realRun("docker", ["logs", "--tail", "400", c], 20_000)).out;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hearth-apps-"));
    const drive = await mkdtemp(path.join(os.tmpdir(), "hearth-drive-"));
    for (const d of ["Movies", "Shows", "Downloads"]) await mkdir(path.join(drive, d));
    const me = os.userInfo();
    ctx = { uid: me.uid, gid: me.gid, tz: "UTC", drive, noVpnForTests: true };
    await realRun("docker", ["network", "create", NETWORK], 30_000);
    for (const id of RECIPE_IDS) {
      await mkdir(path.join(root, id, "config"), { recursive: true });
      if (id === "jellyfin") await mkdir(path.join(root, id, "cache"));
      await writeFile(file(id), RECIPES[id].compose(ctx));
      const up = await applyCompose(realRun, file(id));
      if (!up.ok) console.error(id, up.detail, await logs(id));
      expect(up.ok, `${id}: ${up.detail}`).toBe(true);
    }
  }, 900_000);

  afterAll(async () => {
    if (!ON) return;
    for (const id of RECIPE_IDS)
      await realRun("docker", ["compose", "-f", file(id), "down", "-v"], 120_000).catch(
        () => undefined,
      );
    await realRun("docker", ["network", "rm", NETWORK], 30_000).catch(() => undefined);
  }, 300_000);

  it("Jellyfin: the owner's account, an API key, and the Movies and Shows libraries", async () => {
    const r = await setupJellyfin(RECIPES.jellyfin.local, account, [
      { name: "Movies", type: "movies", path: "/media/Movies" },
      { name: "Shows", type: "tvshows", path: "/media/Shows" },
    ]);
    expect(r.apiKey).toMatch(/^[0-9a-f]{32}$/);
    expect(r.libraries).toEqual(expect.arrayContaining(["Movies", "Shows"]));
    // A second run is safe: it signs in and changes nothing.
    const again = await setupJellyfin(RECIPES.jellyfin.local, account, [
      { name: "Movies", type: "movies", path: "/media/Movies" },
    ]);
    expect(again.apiKey).toBe(r.apiKey);
  }, 300_000);

  for (const app of ["radarr", "sonarr", "prowlarr"] as const)
    it(`${app}: its API key, the owner's sign-in, and its library folder`, async () => {
      keys[app] = await arrKey(path.join(root, app, "config", "config.xml"));
      await setupArr(
        app,
        RECIPES[app].local,
        keys[app]!,
        account,
        app === "radarr" ? ["/data/Movies"] : app === "sonarr" ? ["/data/Shows"] : [],
      );
    }, 300_000);

  it("qBittorrent: the owner's account instead of the first-start password, saving to Downloads", async () => {
    await setupQbittorrent(RECIPES.qbittorrent.local, "qbittorrent", account, "/data/Downloads", {
      logs,
    });
    // A second run signs in with the new account.
    await setupQbittorrent(RECIPES.qbittorrent.local, "qbittorrent", account, "/data/Downloads", {
      logs,
    });
  }, 300_000);

  it("Seerr: signs in with the Jellyfin account and finishes its setup", async () => {
    const r = await setupSeerr(RECIPES.seerr.local, {
      host: "jellyfin",
      port: 8096,
      username: account.username,
      password: account.password,
      email: "owner@example.com",
    });
    keys.seerr = r.apiKey;
    expect(r.apiKey.length).toBeGreaterThan(10);
  }, 300_000);

  it("connects the apps, each read back from the app it was added to", async () => {
    for (const app of ["radarr", "sonarr"] as const) {
      expect(
        await connectDownloadClient(app, RECIPES[app].local, keys[app]!, {
          host: internalHost("qbittorrent", ctx),
          port: 8080,
          ...account,
        }),
      ).toBe("added");
      expect(
        await connectProwlarrApp(RECIPES.prowlarr.local, keys.prowlarr!, {
          app: app === "radarr" ? "Radarr" : "Sonarr",
          url: `http://${app}:${RECIPES[app].port}`,
          apiKey: keys[app]!,
          prowlarrUrl: "http://prowlarr:9696",
        }),
      ).toBe("added");
      expect(
        await connectSeerrArr(
          RECIPES.seerr.local,
          { apiKey: keys.seerr! },
          {
            kind: app,
            host: app,
            port: RECIPES[app].port,
            apiKey: keys[app]!,
            local: RECIPES[app].local,
          },
        ),
      ).toBe("added");
      // Again: nothing is added twice.
      expect(
        await connectDownloadClient(app, RECIPES[app].local, keys[app]!, {
          host: internalHost("qbittorrent", ctx),
          port: 8080,
          ...account,
        }),
      ).toBe("already");
    }
  }, 300_000);
});
