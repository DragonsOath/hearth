import { readFile } from "node:fs/promises";

/**
 * First-run setup of the apps Hearth installed for a homelab plan, through each app's own API:
 * the owner's account in each, its API key read back for Secure Vault, and the apps connected to
 * each other. Passwords and keys pass through here only: the caller stores them in the vault, and
 * nothing here logs or returns a password.
 *
 * Every call reads its result back: an account is proven by signing in with it, a connection by
 * the app listing it.
 */

export class SetupError extends Error {}

type Fetch = typeof fetch;

export interface SetupDeps {
  fetch?: Fetch;
  wait?: (ms: number) => Promise<void>;
  /** `docker logs` of a container (qBittorrent's first password is printed there). */
  logs?: (container: string) => Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(
  deps: SetupDeps,
  url: string,
  init: RequestInit & { json?: unknown; ok?: number[] } = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const { json, ok, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await (deps.fetch ?? fetch)(url, {
    ...rest,
    headers,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (ok ? !ok.includes(res.status) : !res.ok)
    throw new SetupError(
      `${rest.method ?? "GET"} ${new URL(url).pathname} answered ${res.status}: ${text.slice(0, 200)}`,
    );
  return { status: res.status, text, headers: res.headers };
}

const parse = <T>(text: string): T => (text ? (JSON.parse(text) as T) : (undefined as T));

/** Waits until the app answers at all (it may take a minute on first start). */
export async function waitForApp(
  url: string,
  deps: SetupDeps = {},
  timeoutMs = 180_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < until) {
    try {
      const res = await (deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(5_000) });
      if (res.status < 500) return;
      last = `answered ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await (deps.wait ?? sleep)(3_000);
  }
  throw new SetupError(`${url} did not answer within ${Math.round(timeoutMs / 1000)} s (${last}).`);
}

/* ---------- Jellyfin ---------- */

const JF_AUTH =
  'MediaBrowser Client="Hearth", Device="Hearth", DeviceId="hearth-homelab-build", Version="1.0"';

export interface Library {
  name: string;
  type: "movies" | "tvshows";
  /** The folder inside the Jellyfin container (/media/...). */
  path: string;
}

/**
 * The startup wizard, as Jellyfin's own first page does it: language, the owner's account,
 * remote access on (inside the home network), done. Then signs in with that account, makes an
 * API key for Hearth, and adds the libraries. Already set up: signs in, so a repeat is safe.
 */
export async function setupJellyfin(
  base: string,
  account: { username: string; password: string },
  libraries: Library[],
  deps: SetupDeps = {},
): Promise<{ apiKey: string; libraries: string[] }> {
  await waitForApp(`${base}/System/Info/Public`, deps);
  const info = parse<{ StartupWizardCompleted?: boolean }>(
    (await call(deps, `${base}/System/Info/Public`)).text,
  );
  if (!info.StartupWizardCompleted) {
    await call(deps, `${base}/Startup/Configuration`, {
      method: "POST",
      json: { UICulture: "en-US", MetadataCountryCode: "US", PreferredMetadataLanguage: "en" },
    });
    // Reading the first user first is what makes the wizard create it.
    await call(deps, `${base}/Startup/User`);
    await call(deps, `${base}/Startup/User`, {
      method: "POST",
      json: { Name: account.username, Password: account.password },
    });
    await call(deps, `${base}/Startup/RemoteAccess`, {
      method: "POST",
      json: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false },
    });
    await call(deps, `${base}/Startup/Complete`, { method: "POST" });
  }
  const auth = parse<{ AccessToken: string }>(
    (
      await call(deps, `${base}/Users/AuthenticateByName`, {
        method: "POST",
        headers: { Authorization: JF_AUTH },
        json: { Username: account.username, Pw: account.password },
      })
    ).text,
  );
  if (!auth?.AccessToken)
    throw new SetupError("Jellyfin did not accept the account it was just set up with.");
  const h = { Authorization: `${JF_AUTH}, Token="${auth.AccessToken}"` };
  const keys = async () =>
    parse<{ Items: { AccessToken: string; AppName: string }[] }>(
      (await call(deps, `${base}/Auth/Keys`, { headers: h })).text,
    ).Items ?? [];
  let key = (await keys()).find((k) => k.AppName === "Hearth")?.AccessToken;
  if (!key) {
    await call(deps, `${base}/Auth/Keys?app=Hearth`, {
      method: "POST",
      headers: h,
      ok: [200, 204],
    });
    key = (await keys()).find((k) => k.AppName === "Hearth")?.AccessToken;
  }
  if (!key) throw new SetupError("Jellyfin made no API key for Hearth.");
  const existing = parse<{ Name: string; Locations: string[] }[]>(
    (await call(deps, `${base}/Library/VirtualFolders`, { headers: h })).text,
  );
  for (const lib of libraries) {
    if (existing.some((e) => e.Name === lib.name || e.Locations?.includes(lib.path))) continue;
    const qs = new URLSearchParams({
      name: lib.name,
      collectionType: lib.type,
      refreshLibrary: "true",
    });
    await call(deps, `${base}/Library/VirtualFolders?${qs}`, {
      method: "POST",
      headers: h,
      json: { LibraryOptions: { PathInfos: [{ Path: lib.path }] } },
      ok: [200, 204],
    });
  }
  const after = parse<{ Name: string }[]>(
    (await call(deps, `${base}/Library/VirtualFolders`, { headers: h })).text,
  ).map((l) => l.Name);
  for (const lib of libraries)
    if (!after.includes(lib.name) && !existing.some((e) => e.Locations?.includes(lib.path)))
      throw new SetupError(`Jellyfin does not list the ${lib.name} library after adding it.`);
  return { apiKey: key, libraries: after };
}

/* ---------- Radarr, Sonarr, Prowlarr ---------- */

export type ArrApp = "radarr" | "sonarr" | "prowlarr";
const API: Record<ArrApp, string> = { radarr: "v3", sonarr: "v3", prowlarr: "v1" };
const ARR_NAMES: Record<ArrApp, string> = {
  radarr: "Radarr",
  sonarr: "Sonarr",
  prowlarr: "Prowlarr",
};

/** The API key the app wrote into its own config.xml on first start. */
export async function arrKey(configXml: string, deps: SetupDeps = {}): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const xml = await readFile(configXml, "utf8").catch(() => "");
    const key = /<ApiKey>([0-9a-f]{32})<\/ApiKey>/i.exec(xml)?.[1];
    if (key) return key;
    await (deps.wait ?? sleep)(3_000);
  }
  throw new SetupError(`No API key in ${configXml} yet.`);
}

/** What one sign-in try answered: whether it worked, and in words (never a cookie's value). */
export interface SignInTry {
  ok: boolean;
  said: string;
}

/**
 * Signs in on the app's own sign-in page with the owner's account, as the owner would: the forms
 * login answers with a redirect home and a sign-in cookie, or back to the page with loginFailed.
 * A few tries: the app may take a moment to start asking for the new sign-in.
 */
export async function arrSignIn(
  base: string,
  account: { username: string; password: string },
  deps: SetupDeps = {},
  tries = 5,
): Promise<SignInTry> {
  let said = "it did not answer";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await (deps.fetch ?? fetch)(`${base}/login?returnUrl=%2F`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: account.username,
          password: account.password,
          rememberMe: "on",
        }).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const to = res.headers.get("location") ?? "";
      const cookies = (res.headers.get("set-cookie") ?? "")
        .split(/,(?=\s*[^;,=\s]+=)/)
        .map((c) => c.split("=")[0]!.trim())
        .filter(Boolean);
      const failed = /loginFailed/i.test(to);
      if (res.status >= 300 && res.status < 400 && !failed && cookies.length)
        return { ok: true, said: `signed in (${res.status})` };
      said = `${res.status}${to ? ` to ${to.replace(/\?.*/, "")}${failed ? " (loginFailed)" : ""}` : ""}${cookies.length ? `, cookies ${cookies.join(", ")}` : ", no cookie"}`;
    } catch (e) {
      said = e instanceof Error ? e.message : String(e);
    }
    await (deps.wait ?? sleep)(2_000);
  }
  return { ok: false, said };
}

/** Whether the owner's account signs in on the app's own page. */
export async function arrSignsIn(
  base: string,
  account: { username: string; password: string },
  deps: SetupDeps = {},
): Promise<boolean> {
  return (await arrSignIn(base, account, deps)).ok;
}

/**
 * Turns on the app's sign-in with the owner's account (forms login, required everywhere but
 * from this home network's own addresses is not offered: the app asks everyone), and adds its
 * root folders. Checked by signing in with that account, the way the owner will (11-22: the app
 * keeps the user name in lower case, so comparing it to the one given failed a working sign-in
 * for any name with a capital letter, and the build stopped there).
 */
export async function setupArr(
  app: ArrApp,
  base: string,
  apiKey: string,
  account: { username: string; password: string },
  rootFolders: string[],
  deps: SetupDeps = {},
): Promise<void> {
  const v = API[app];
  const h = { "X-Api-Key": apiKey };
  await waitForApp(`${base}/api/${v}/system/status?apikey=${apiKey}`, deps);
  const host = parse<Record<string, unknown>>(
    (await call(deps, `${base}/api/${v}/config/host`, { headers: h })).text,
  );
  await call(deps, `${base}/api/${v}/config/host`, {
    method: "PUT",
    headers: h,
    json: {
      ...host,
      authenticationMethod: "forms",
      authenticationRequired: "enabled",
      username: account.username,
      password: account.password,
      passwordConfirmation: account.password,
    },
    ok: [200, 202],
  });
  const back = parse<{ authenticationMethod?: string; username?: string }>(
    (await call(deps, `${base}/api/${v}/config/host`, { headers: h })).text,
  );
  const name = ARR_NAMES[app];
  if (String(back.authenticationMethod).toLowerCase() !== "forms")
    throw new SetupError(`${name} did not turn its sign-in on.`);
  // Radarr, Sonarr and Prowlarr take a new sign-in method only after a restart: when signing in
  // does not work yet, Hearth restarts the app with its own API (it is Hearth's, just set up),
  // waits for it, and signs in again (11-22, the real apps in CI).
  let tried = await arrSignIn(base, account, deps, 2);
  if (!tried.ok) {
    await call(deps, `${base}/api/${v}/system/restart`, {
      method: "POST",
      headers: h,
      ok: [200, 202],
    });
    await (deps.wait ?? sleep)(5_000);
    await waitForApp(`${base}/api/${v}/system/status?apikey=${apiKey}`, deps);
    tried = await arrSignIn(base, account, deps);
  }
  if (!tried.ok)
    throw new SetupError(
      `${name} turned its sign-in on, but signing in as ${account.username} did not work (it answered ${tried.said}).`,
    );
  if (app === "prowlarr") return;
  const have = parse<{ path: string }[]>(
    (await call(deps, `${base}/api/${v}/rootfolder`, { headers: h })).text,
  ).map((r) => r.path.replace(/\/$/, ""));
  for (const folder of rootFolders) {
    if (have.includes(folder.replace(/\/$/, ""))) continue;
    await call(deps, `${base}/api/${v}/rootfolder`, {
      method: "POST",
      headers: h,
      json: { path: folder },
      ok: [200, 201],
    });
  }
}

/* ---------- qBittorrent ---------- */

async function qbtLogin(base: string, username: string, password: string, deps: SetupDeps) {
  const r = await call(deps, `${base}/api/v2/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Referer: base },
    body: new URLSearchParams({ username, password }).toString(),
    ok: [200, 204, 401, 403],
  });
  // The session cookie: SID in qBittorrent 4, QBT_SID_<port> in 5. Sent back as it came.
  const m = /(?:^|[\s,;])((?:QBT_)?SID(?:_\d+)?)=([^;]+)/.exec(r.headers.get("set-cookie") ?? "");
  const sid = m ? `${m[1]}=${m[2]}` : undefined;
  // qBittorrent 4 answers "Ok."; 5 answers 204 with no body. Either way, with a session.
  return (r.status === 204 || r.text.trim() === "Ok.") && sid ? sid : undefined;
}

/**
 * qBittorrent prints a one-time password on its first start: Hearth signs in with it, sets the
 * owner's account instead, and points downloads at the drive's Downloads folder. Then it signs
 * in with the new account to prove it took.
 */
export async function setupQbittorrent(
  base: string,
  container: string,
  account: { username: string; password: string },
  savePath: string,
  deps: SetupDeps = {},
): Promise<void> {
  await waitForApp(`${base}/api/v2/app/version`, deps);
  let sid = await qbtLogin(base, account.username, account.password, deps);
  if (!sid) {
    let temp: string | undefined;
    for (let i = 0; i < 20 && !temp; i++) {
      const log = (await deps.logs?.(container)) ?? "";
      temp = [...log.matchAll(/temporary password is provided for this session: (\S+)/gi)].at(
        -1,
      )?.[1];
      if (!temp) await (deps.wait ?? sleep)(3_000);
    }
    if (!temp) throw new SetupError("qBittorrent's first-start password is not in its log.");
    sid = await qbtLogin(base, "admin", temp, deps);
    if (!sid) throw new SetupError("qBittorrent did not accept its own first-start password.");
    await call(deps, `${base}/api/v2/app/setPreferences`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Cookie: sid,
        Referer: base,
      },
      body: new URLSearchParams({
        json: JSON.stringify({
          web_ui_username: account.username,
          web_ui_password: account.password,
          save_path: savePath,
          temp_path_enabled: false,
        }),
      }).toString(),
    });
    sid = await qbtLogin(base, account.username, account.password, deps);
    if (!sid) throw new SetupError("qBittorrent did not keep the account it was given.");
  }
  const prefs = parse<{ save_path?: string }>(
    (
      await call(deps, `${base}/api/v2/app/preferences`, {
        headers: { Cookie: sid, Referer: base },
      })
    ).text,
  );
  if ((prefs.save_path ?? "").replace(/\/$/, "") !== savePath.replace(/\/$/, ""))
    throw new SetupError(`qBittorrent saves to ${prefs.save_path}, not ${savePath}.`);
}

/* ---------- Seerr ---------- */

/**
 * Seerr's first page, through its API: it signs in with the owner's Jellyfin account (which makes
 * that the Seerr owner), turns on the Jellyfin libraries, and finishes setup. Returns Seerr's API
 * key for Secure Vault.
 */
export async function setupSeerr(
  base: string,
  jellyfin: { host: string; port: number; username: string; password: string; email: string },
  deps: SetupDeps = {},
): Promise<{ apiKey: string; cookie: string }> {
  await waitForApp(`${base}/api/v1/status`, deps);
  const login = await call(deps, `${base}/api/v1/auth/jellyfin`, {
    method: "POST",
    json: {
      username: jellyfin.username,
      password: jellyfin.password,
      hostname: jellyfin.host,
      port: jellyfin.port,
      useSsl: false,
      urlBase: "",
      email: jellyfin.email,
      serverType: 2,
    },
  });
  const cookie = /connect\.sid=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  if (!cookie) throw new SetupError("Seerr did not sign in with the Jellyfin account.");
  const h = { Cookie: `connect.sid=${cookie}` };
  // Seerr reads Jellyfin's libraries, then each is switched on (Movies and Shows).
  const libs = parse<{ id: string; enabled: boolean }[]>(
    (
      await call(deps, `${base}/api/v1/settings/jellyfin/library/sync`, {
        method: "POST",
        headers: h,
        ok: [200, 404],
      })
    ).text,
  );
  for (const lib of Array.isArray(libs) ? libs : [])
    await call(deps, `${base}/api/v1/settings/jellyfin/library/${encodeURIComponent(lib.id)}`, {
      method: "PUT",
      headers: h,
      json: { enabled: true },
    });
  const main = parse<{ apiKey: string; initialized?: boolean }>(
    (await call(deps, `${base}/api/v1/settings/main`, { headers: h })).text,
  );
  await call(deps, `${base}/api/v1/settings/initialize`, { method: "POST", headers: h });
  if (!main?.apiKey) throw new SetupError("Seerr has no API key.");
  return { apiKey: main.apiKey, cookie };
}

/* ---------- connecting the apps ---------- */

interface Field {
  name: string;
  value?: unknown;
}
interface Schema {
  implementation: string;
  configContract: string;
  fields: Field[];
  [k: string]: unknown;
}

/** Fills one of the app's own schema entries (so every field it expects is there). */
function fill(schema: Schema, name: string, values: Record<string, unknown>) {
  return {
    ...schema,
    name,
    enable: true,
    fields: schema.fields.map((f) => (f.name in values ? { ...f, value: values[f.name] } : f)),
  };
}

/** Adds qBittorrent to Radarr or Sonarr as its download client (once), and reads it back. */
export async function connectDownloadClient(
  app: "radarr" | "sonarr",
  base: string,
  apiKey: string,
  qbt: { host: string; port: number; username: string; password: string },
  deps: SetupDeps = {},
) {
  const h = { "X-Api-Key": apiKey };
  const listed = parse<{ implementation: string }[]>(
    (await call(deps, `${base}/api/v3/downloadclient`, { headers: h })).text,
  );
  if (listed.some((c) => c.implementation === "QBittorrent")) return "already";
  const schema = parse<Schema[]>(
    (await call(deps, `${base}/api/v3/downloadclient/schema`, { headers: h })).text,
  ).find((s) => s.implementation === "QBittorrent");
  if (!schema) throw new SetupError(`${app} has no qBittorrent download client.`);
  await call(deps, `${base}/api/v3/downloadclient`, {
    method: "POST",
    headers: h,
    json: fill(schema, "qBittorrent", {
      host: qbt.host,
      port: qbt.port,
      username: qbt.username,
      password: qbt.password,
      [app === "radarr" ? "movieCategory" : "tvCategory"]: app,
    }),
    ok: [200, 201],
  });
  const after = parse<{ implementation: string }[]>(
    (await call(deps, `${base}/api/v3/downloadclient`, { headers: h })).text,
  );
  if (!after.some((c) => c.implementation === "QBittorrent"))
    throw new SetupError(`${app} does not list qBittorrent after adding it.`);
  return "added";
}

/** Adds Radarr or Sonarr to Prowlarr, so the indexers the owner adds there reach them. */
export async function connectProwlarrApp(
  base: string,
  apiKey: string,
  target: { app: "Radarr" | "Sonarr"; url: string; apiKey: string; prowlarrUrl: string },
  deps: SetupDeps = {},
) {
  const h = { "X-Api-Key": apiKey };
  const listed = parse<{ implementation: string }[]>(
    (await call(deps, `${base}/api/v1/applications`, { headers: h })).text,
  );
  if (listed.some((a) => a.implementation === target.app)) return "already";
  const schema = parse<Schema[]>(
    (await call(deps, `${base}/api/v1/applications/schema`, { headers: h })).text,
  ).find((s) => s.implementation === target.app);
  if (!schema) throw new SetupError(`Prowlarr has no ${target.app} connection.`);
  await call(deps, `${base}/api/v1/applications`, {
    method: "POST",
    headers: h,
    json: {
      ...fill(schema, target.app, {
        prowlarrUrl: target.prowlarrUrl,
        baseUrl: target.url,
        apiKey: target.apiKey,
      }),
      syncLevel: "fullSync",
    },
    ok: [200, 201],
  });
  const after = parse<{ implementation: string }[]>(
    (await call(deps, `${base}/api/v1/applications`, { headers: h })).text,
  );
  if (!after.some((a) => a.implementation === target.app))
    throw new SetupError(`Prowlarr does not list ${target.app} after adding it.`);
  return "added";
}

/** Adds Radarr or Sonarr to Seerr with its first quality profile and root folder. */
export async function connectSeerrArr(
  base: string,
  cookieOrKey: { apiKey: string },
  target: {
    kind: "radarr" | "sonarr";
    host: string;
    port: number;
    apiKey: string;
    local: string;
  },
  deps: SetupDeps = {},
) {
  const h = { "X-Api-Key": cookieOrKey.apiKey };
  const listed = parse<unknown[]>(
    (await call(deps, `${base}/api/v1/settings/${target.kind}`, { headers: h })).text,
  );
  if (listed.length) return "already";
  const ah = { "X-Api-Key": target.apiKey };
  const profiles = parse<{ id: number; name: string }[]>(
    (await call(deps, `${target.local}/api/v3/qualityprofile`, { headers: ah })).text,
  );
  const roots = parse<{ path: string }[]>(
    (await call(deps, `${target.local}/api/v3/rootfolder`, { headers: ah })).text,
  );
  const profile = profiles.find((p) => /hd.*1080|1080/i.test(p.name)) ?? profiles[0];
  if (!profile || !roots[0])
    throw new SetupError(`${target.kind} has no quality profile or root folder yet.`);
  const body: Record<string, unknown> = {
    name: target.kind === "radarr" ? "Radarr" : "Sonarr",
    hostname: target.host,
    port: target.port,
    apiKey: target.apiKey,
    useSsl: false,
    baseUrl: "",
    activeProfileId: profile.id,
    activeProfileName: profile.name,
    activeDirectory: roots[0].path,
    is4k: false,
    isDefault: true,
    syncEnabled: false,
    preventSearch: false,
    ...(target.kind === "radarr" ? { minimumAvailability: "released" } : {}),
    ...(target.kind === "sonarr"
      ? {
          activeAnimeProfileId: profile.id,
          activeAnimeProfileName: profile.name,
          activeAnimeDirectory: roots[0].path,
          enableSeasonFolders: true,
        }
      : {}),
  };
  await call(deps, `${base}/api/v1/settings/${target.kind}`, {
    method: "POST",
    headers: h,
    json: body,
    ok: [200, 201],
  });
  const after = parse<unknown[]>(
    (await call(deps, `${base}/api/v1/settings/${target.kind}`, { headers: h })).text,
  );
  if (!after.length) throw new SetupError(`Seerr does not list ${target.kind} after adding it.`);
  return "added";
}

/* ---------- Plex ---------- */

/**
 * Plex's libraries, once the owner signed in to the server (its own token, from Preferences.xml):
 * Movies and TV Shows pointed at the drive, read back from Plex. One already there is kept.
 */
export async function setupPlexLibraries(
  base: string,
  token: string,
  libraries: { name: string; type: "movie" | "show"; path: string }[],
  deps: SetupDeps = {},
): Promise<string[]> {
  const h = { "X-Plex-Token": token, Accept: "application/json" };
  const list = async () =>
    (
      parse<{
        MediaContainer?: { Directory?: { title: string; Location?: { path: string }[] }[] };
      }>((await call(deps, `${base}/library/sections`, { headers: h })).text).MediaContainer
        ?.Directory ?? []
    ).map((d) => ({ title: d.title, paths: (d.Location ?? []).map((l) => l.path) }));
  const have = await list();
  for (const lib of libraries) {
    if (have.some((d) => d.title === lib.name || d.paths.includes(lib.path))) continue;
    const qs = new URLSearchParams({
      name: lib.name,
      type: lib.type,
      agent: lib.type === "movie" ? "tv.plex.agents.movie" : "tv.plex.agents.series",
      scanner: lib.type === "movie" ? "Plex Movie" : "Plex TV Series",
      language: "en-US",
      location: lib.path,
    });
    await call(deps, `${base}/library/sections?${qs}`, { method: "POST", headers: h });
  }
  const after = await list();
  for (const lib of libraries)
    if (!after.some((d) => d.title === lib.name || d.paths.includes(lib.path)))
      throw new SetupError(`Plex does not list the ${lib.name} library after adding it.`);
  return after.map((d) => d.title);
}
