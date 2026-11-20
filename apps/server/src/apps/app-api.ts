import type { AppKind } from "@dragon-control/core";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { qbSignIn } from "./qbittorrent";

/**
 * Any request to a connected app's own API, with the app's credential from the Secure Vault
 * (10-27: "Hearth needs to have the same capabilities as you have"). Ember is not limited to
 * the operations Hearth happens to have built: it can read any endpoint, and change anything the
 * app's API allows, the way an administrator with the API key would. Reads are free; a change is
 * either an approved plan step (app-api-call) or, while Full access is on, done directly when the
 * owner asked for it. The credential is only ever sent to the app's own address and never shown:
 * secrets in answers are masked.
 */

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export const API_METHODS: readonly ApiMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface ApiRequest {
  method: ApiMethod;
  /** The path on the app, with any query: "/api/v1/queue?page=1". */
  path: string;
  /** JSON (or, for qBittorrent, a form body like "hashes=...&deleteFiles=false"). */
  body?: string;
  /**
   * For an app Hearth has no reader for: how its credential is sent (see GENERIC_AUTH). Left out,
   * a login goes as Basic auth and a key in an X-Api-Key header.
   */
  auth?: string;
}

/** An app Hearth watches but has no reader for: reached the same way, its key sent as asked. */
export type ApiApp = AppKind | "generic";

/**
 * How a key reaches an app Hearth has no reader for, as its API documentation says: a header of
 * its own ("header:X-Auth-Token"), "bearer", "basic" (a login), a query parameter
 * ("query:apikey"), or "none".
 */
export const GENERIC_AUTH =
  /^(header:[A-Za-z0-9-]{1,40}|bearer|basic|query:[A-Za-z0-9_-]{1,30}|session|none)$/;

/** Why an auth choice cannot be used, or undefined. */
export function authProblem(auth: string | undefined): string | undefined {
  if (auth === undefined || GENERIC_AUTH.test(auth)) return undefined;
  return 'Say how the key is sent: "header:<Name>", "bearer", "basic", "query:<name>", "session" (a saved sign-in) or "none".';
}

export interface ApiAnswer {
  status: number;
  ok: boolean;
  /** The app's answer, parsed when it is JSON, with secrets masked; shortened when very long. */
  body: unknown;
  /** Set when the answer was shortened. */
  note?: string;
}

/** The header each API-key app reads its key from. */
const KEY_HEADER: Partial<Record<AppKind, string>> = {
  sonarr: "X-Api-Key",
  radarr: "X-Api-Key",
  lidarr: "X-Api-Key",
  chaptarr: "X-Api-Key",
  prowlarr: "X-Api-Key",
  seerr: "X-Api-Key",
  bazarr: "X-API-KEY",
  syncthing: "X-API-Key",
  wizarr: "X-API-Key",
  immich: "x-api-key",
  plex: "X-Plex-Token",
};

/** Why a path cannot be used, or undefined. Only a path on the app itself, never another host. */
export function pathProblem(path: string): string | undefined {
  if (!path.startsWith("/")) return 'The path must start with "/" (a path on the app itself).';
  if (path.length > 2000) return "The path is too long.";
  if (/[\s\\]/.test(path) || path.includes("://") || path.startsWith("//"))
    return "The path must be a plain path on the app (no spaces, no other address).";
  if (/(^|\/)\.\.(\/|$)/.test(path)) return 'The path must not contain "..".';
  return undefined;
}

/** Why a body cannot be sent, or undefined. */
export function bodyProblem(app: ApiApp, body: string | undefined): string | undefined {
  if (body === undefined || body === "") return undefined;
  if (body.length > 200_000) return "The body is too large.";
  // qBittorrent, and apps Hearth has no reader for, may take a form body.
  if (app === "qbittorrent" || app === "generic") return undefined;
  try {
    JSON.parse(body);
    return undefined;
  } catch {
    return "The body must be valid JSON.";
  }
}

const SECRET_KEY =
  /^(api[_-]?key|apikey|password|passwd|pass|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|cookie|authorization|private[_-]?key|webhook(url)?)$/i;

/** The answer with secrets masked: fields named like a secret, and the credential itself. */
export function maskSecrets(value: unknown, credential?: string): unknown {
  if (typeof value === "string")
    return credential && credential.length >= 6 ? value.split(credential).join("[hidden]") : value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, credential));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // *arr "fields" lists: [{ name: "apiKey", value: "..." }]
      if (k === "value" && SECRET_KEY.test(String((value as { name?: unknown }).name ?? "")))
        out[k] = v ? "[hidden]" : v;
      else
        out[k] =
          SECRET_KEY.test(k) && typeof v === "string" && v
            ? "[hidden]"
            : maskSecrets(v, credential);
    }
    return out;
  }
  return value;
}

const MAX_CHARS = 60_000;

/** Long answers are shortened so they fit in a conversation; arrays keep their first items. */
export function shorten(body: unknown): { body: unknown; note?: string } {
  const size = (v: unknown) =>
    typeof v === "string" ? v.length : JSON.stringify(v ?? null).length;
  if (size(body) <= MAX_CHARS) return { body };
  if (Array.isArray(body)) {
    let n = body.length;
    while (n > 1 && size(body.slice(0, n)) > MAX_CHARS) n = Math.floor(n / 2);
    return {
      body: body.slice(0, n),
      note: `Shortened: showing ${n} of ${body.length} items. Ask with paging or a filter (for example ?page=1&pageSize=20) to see others.`,
    };
  }
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    const list = Object.entries(rec).find(([, v]) => Array.isArray(v) && size(v) > MAX_CHARS / 2);
    if (list) {
      const inner = shorten(list[1]);
      if (size({ ...rec, [list[0]]: inner.body }) <= MAX_CHARS)
        return { body: { ...rec, [list[0]]: inner.body }, note: inner.note };
    }
  }
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return {
    body: s.slice(0, MAX_CHARS),
    note: `Shortened: showing the first ${MAX_CHARS} of ${s.length} characters. Ask for less (paging, a filter, or one item).`,
  };
}

/** Sends one request to the app with its credential, the way the app expects it. */
export async function appApi(
  fetchImpl: Fetch,
  app: ApiApp,
  appName: string,
  base: string,
  credential: { value: string; username?: string } | undefined,
  req: ApiRequest,
  /** A saved sign-in's headers (auth "session"): its cookie or token, from the Secure Vault. */
  session?: Record<string, string>,
): Promise<ApiAnswer> {
  let path = req.path;
  const headers: Record<string, string> = { Accept: "application/json", ...session };
  const value = credential?.value ?? "";
  const withQuery = (k: string, v: string) =>
    `${path}${path.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}`;
  const send = async (url: string, init: Parameters<Fetch>[1]) => {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error))
        .split(value)
        .join("[hidden]");
      throw new AppUnreachableError(`${appName} did not answer at ${base}: ${why}`);
    }
  };
  if (credential && app === "generic" && !session) {
    const auth = req.auth ?? (credential.username ? "basic" : "header:X-Api-Key");
    if (auth.startsWith("header:")) headers[auth.slice(7)] = value;
    else if (auth === "bearer") headers.Authorization = `Bearer ${value}`;
    else if (auth === "basic")
      headers.Authorization = `Basic ${Buffer.from(`${credential.username ?? ""}:${value}`).toString("base64")}`;
    else if (auth.startsWith("query:")) path = withQuery(auth.slice(6), value);
  } else if (credential && app !== "generic") {
    if (KEY_HEADER[app]) headers[KEY_HEADER[app]!] = value;
    else if (app === "homeassistant" || app === "audiobookshelf")
      headers.Authorization = `Bearer ${value}`;
    else if (app === "jellyfin" || app === "emby")
      headers.Authorization = `MediaBrowser Client="Hearth", Device="Hearth", DeviceId="hearth", Version="1", Token="${value}"`;
    else if (app === "tautulli" || app === "sabnzbd") path = withQuery("apikey", value);
    else if (app === "romm")
      headers.Authorization = credential.username
        ? `Basic ${Buffer.from(`${credential.username}:${value}`).toString("base64")}`
        : `Bearer ${value}`;
    else if (app === "kavita") {
      const r = await send(
        joinUrl(
          base,
          `/api/Plugin/authenticate?apiKey=${encodeURIComponent(value)}&pluginName=Hearth`,
        ),
        {
          method: "POST",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      const token = r.ok
        ? ((await r.json().catch(() => null)) as { token?: string } | null)?.token
        : undefined;
      if (!token) throw new AppKeyError("Kavita refused the API key.");
      headers.Authorization = `Bearer ${token}`;
    } else if (app === "qbittorrent") {
      headers.Cookie = await qbSignIn(
        base,
        { username: credential.username ?? "", password: value },
        fetchImpl,
      );
    }
  }
  if (req.body) {
    const form =
      app === "qbittorrent" ||
      (app === "generic" &&
        (() => {
          try {
            JSON.parse(req.body!);
            return false;
          } catch {
            return true;
          }
        })());
    headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
  }
  const res = await send(joinUrl(base, path), {
    method: req.method,
    headers,
    ...(req.body ? { body: req.body } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS * 4),
  });
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError(
      `${appName} refused the request (${res.status}): its credential in the Secure Vault was not accepted for ${req.method} ${req.path.split("?")[0]}.`,
    );
  let raw: unknown;
  if (res.text) {
    const s = await res.text();
    try {
      raw = s ? JSON.parse(s) : null;
    } catch {
      raw = s;
    }
  } else raw = await res.json().catch(() => null);
  const masked = maskSecrets(raw, value);
  const short = shorten(masked);
  return {
    status: res.status,
    ok: res.ok,
    body: short.body,
    ...(short.note ? { note: short.note } : {}),
  };
}

/**
 * An *arr command (POST .../command) runs in the background: wait for it to finish, so the
 * answer says what happened, not just that it was queued.
 */
export async function followCommand(
  req: ApiRequest,
  answer: ApiAnswer,
  read: (path: string) => Promise<ApiAnswer>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxMs = 90_000,
): Promise<ApiAnswer> {
  const id = (answer.body as { id?: unknown } | null)?.id;
  if (req.method !== "POST" || !answer.ok || typeof id !== "number") return answer;
  const base = req.path.split("?")[0]!.replace(/\/+$/, "");
  if (!/\/api\/v\d\/command$/.test(base)) return answer;
  for (let waited = 0; waited < maxMs; waited += 2000) {
    await wait(2000);
    const r = await read(`${base}/${id}`).catch(() => undefined);
    const st = (r?.body as { status?: string } | null)?.status;
    if (r && st && ["completed", "failed", "aborted", "cancelled"].includes(st)) return r;
  }
  return {
    ...answer,
    note: "The command was still running after 90 seconds; read it again to see how it ended.",
  };
}
