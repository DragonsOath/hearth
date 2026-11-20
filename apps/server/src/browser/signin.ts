/**
 * Ember's Browser signs in to the owner's apps (checklist 45.14, the owner's option A): Hearth's
 * backend signs in server to server with the app's web login from Secure Vault (through the
 * credential broker), and the browser only receives the resulting session for that app's own
 * address. No password is ever typed into a page or sent over the DevTools connection, and no
 * AI sees one.
 *
 * Each app has a small adapter for its own sign-in; an app without one cannot be signed in to.
 */

/** What the browser gets for one origin: cookies, or a header added to its requests. */
export interface SessionMaterial {
  cookies: { name: string; value: string; path?: string; httpOnly?: boolean; secure?: boolean }[];
  /** An Authorization header for that origin only (HTTP basic sign-in). */
  authorization?: string;
  /** What was done, in words (no values). */
  how: string;
}

export class SignInError extends Error {}

type Fetch = typeof fetch;

/** The apps whose web sign-in Hearth knows. */
export type SignInApp = "servarr" | "qbittorrent";

/** Which adapter an app uses, from its kind ("radarr", "sonarr", ...). */
export function signInAppOf(appKind: string | undefined): SignInApp | undefined {
  if (!appKind) return undefined;
  if (
    ["radarr", "sonarr", "lidarr", "prowlarr", "readarr", "whisparr", "chaptarr"].includes(appKind)
  )
    return "servarr";
  if (appKind === "qbittorrent") return "qbittorrent";
  return undefined;
}

/** The cookies a response sets (name and value only; attributes are re-applied by origin). */
function cookiesOf(res: Response): SessionMaterial["cookies"] {
  const raw =
    (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
  return raw
    .map((c) => {
      const [pair, ...attrs] = c.split(";");
      const i = pair!.indexOf("=");
      const lower = attrs.map((a) => a.trim().toLowerCase());
      return {
        name: pair!.slice(0, i).trim(),
        value: pair!.slice(i + 1).trim(),
        path: attrs
          .find((a) => a.trim().toLowerCase().startsWith("path="))
          ?.split("=")[1]
          ?.trim(),
        httpOnly: lower.includes("httponly"),
        secure: lower.includes("secure"),
      };
    })
    .filter((c) => c.name && c.value);
}

/**
 * Signs in to the app at `origin` and returns its session. Throws SignInError with a plain
 * reason (never containing the credential) when the app refuses.
 */
export async function signIn(
  app: SignInApp,
  origin: string,
  login: { username: string; password: string },
  fetchImpl: Fetch = fetch,
): Promise<SessionMaterial> {
  const timeout = () => AbortSignal.timeout(15_000);
  if (app === "qbittorrent") {
    const res = await fetchImpl(`${origin}/api/v2/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: origin, origin },
      body: new URLSearchParams({ username: login.username, password: login.password }),
      signal: timeout(),
    });
    const text = (await res.text()).trim();
    const cookies = cookiesOf(res).filter((c) => c.name === "SID");
    if (!res.ok || text !== "Ok." || !cookies.length)
      throw new SignInError(
        res.status === 403
          ? "qBittorrent has blocked sign-ins from Hearth for now (too many failed attempts)."
          : "qBittorrent refused the web login in Secure Vault.",
      );
    return { cookies, how: "qBittorrent's own sign-in" };
  }
  // Radarr, Sonarr, Lidarr, Prowlarr...: how the app asks you to sign in decides the way.
  const probe = await fetchImpl(`${origin}/`, { redirect: "manual", signal: timeout() });
  const location = probe.headers.get("location") ?? "";
  if (probe.status === 401 && /basic/i.test(probe.headers.get("www-authenticate") ?? "")) {
    const authorization = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`;
    const check = await fetchImpl(`${origin}/`, {
      headers: { authorization },
      redirect: "manual",
      signal: timeout(),
    });
    if (check.status === 401)
      throw new SignInError("The app refused the web login in Secure Vault.");
    return { cookies: [], authorization, how: "HTTP basic sign-in" };
  }
  if (!(probe.status >= 300 && probe.status < 400 && /\/login/i.test(location)))
    return { cookies: [], how: "No sign-in needed: the app opened without one" };
  const base = new URL(location, origin);
  const res = await fetchImpl(`${base.origin}${base.pathname}?returnUrl=%2F`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: base.toString() },
    body: new URLSearchParams({
      username: login.username,
      password: login.password,
      rememberMe: "on",
    }),
    redirect: "manual",
    signal: timeout(),
  });
  const cookies = cookiesOf(res).filter((c) => /auth/i.test(c.name));
  const back = res.headers.get("location") ?? "";
  if (!cookies.length || /loginFailed/i.test(back))
    throw new SignInError("The app refused the web login in Secure Vault.");
  return { cookies, how: "The app's own sign-in form, sent by Hearth" };
}
