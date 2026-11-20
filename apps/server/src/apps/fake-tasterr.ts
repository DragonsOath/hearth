import type { Fetch } from "./http";

/**
 * A stand-in Tasterr (port 8220) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): an app with no API key, as the real Tasterr is (checked against its source, 11-11).
 * Only /api/v1/health answers without signing in; everything else needs its session cookie,
 * from a Plex PIN sign-in (allowed on the second poll, as if the owner pressed Allow) or a local
 * login. Sign-ins and reads answer as the real one's shapes.
 */

export const FAKE_TASTERR_LOGIN = { email: "owner@example.com", password: "e2e-tasterr-login" };
const COOKIE = "tasterr_session=e2e-tasterr-session";

export interface FakeTasterr {
  fetch: Fetch;
  reset(): void;
  /** The session is forgotten (the app signed everyone out). */
  signOutAll(): void;
  /** Requests it was sent (a code panel's Request, approved as a plan). */
  requests: Record<string, unknown>[];
}

export function fakeTasterr(): FakeTasterr {
  let polls = new Map<string, number>();
  let valid = new Set<string>([COOKIE]);
  let nextPin = 1;
  const requests: Record<string, unknown>[] = [];
  const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  });
  const signed = (cookie: string | undefined) =>
    Boolean(cookie && [...valid].some((v) => cookie.split(/;\s*/).includes(v)));
  const session = {
    "set-cookie": `${COOKIE}; Max-Age=2592000; HttpOnly; SameSite=Lax; Path=/`,
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const body = (() => {
      try {
        return JSON.parse(init.body ?? "{}") as Record<string, string>;
      } catch {
        return {} as Record<string, string>;
      }
    })();
    // Its page refuses to be shown inside another page, as the real Tasterr's does (11-14).
    if (p === "/")
      return reply(200, "<!doctype html>", {
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      });
    if (p === "/api/v1/health")
      return reply(200, { status: "ok", tmdb: "connected", seerr: "connected" });
    if (p === "/api/v1/auth/plex/pin" && init.method === "POST") {
      const id = `pin-${nextPin++}`;
      polls.set(id, 0);
      return reply(200, { pin_id: id, auth_url: `https://app.plex.tv/auth#?code=E2E${id}` });
    }
    if (p === "/api/v1/auth/plex/pin/poll" && init.method === "POST") {
      const n = polls.get(body.pin_id ?? "");
      if (n === undefined) return reply(404, { detail: "Unknown or expired sign-in attempt" });
      polls.set(body.pin_id!, n + 1);
      if (n < 1) return reply(200, { status: "pending", user: null });
      polls.delete(body.pin_id!);
      valid.add(COOKIE);
      return reply(
        200,
        { status: "ok", user: { id: 1, display_name: "Owner", avatar_url: null, is_admin: true } },
        session,
      );
    }
    if (p === "/api/v1/auth/local" && init.method === "POST") {
      if (body.email !== FAKE_TASTERR_LOGIN.email || body.password !== FAKE_TASTERR_LOGIN.password)
        return reply(401, { detail: "Invalid email or password" });
      valid.add(COOKIE);
      return reply(
        200,
        { id: 1, display_name: "Owner", avatar_url: null, is_admin: true },
        session,
      );
    }
    if (!signed(init.headers.Cookie)) return reply(401, { detail: "Not authenticated" });
    if (p === "/api/v1/auth/me")
      return reply(200, { id: 1, display_name: "Owner", avatar_url: null, is_admin: true });
    if (p === "/api/v1/home/rows")
      return reply(200, {
        rows: [
          {
            title: "Because you liked Arrival",
            items: [
              { title: "Contact", year: 1997, rating: 7.5 },
              { title: "Annihilation", year: 2018, rating: 6.8 },
              { title: "Interstellar", year: 2014, rating: 8.7 },
            ],
          },
          {
            title: "Cozy autumn picks",
            items: [
              { title: "Fantastic Mr. Fox", year: 2009, rating: 7.9 },
              { title: "Paddington 2", year: 2017, rating: 7.8 },
            ],
          },
        ],
      });
    // A request, as Tasterr takes it (it passes it on to Seerr).
    if (p === "/api/v1/request" && init.method === "POST") {
      requests.push(body);
      return reply(201, { ok: true, status: "requested" });
    }
    if (p === "/api/v1/taste/profile")
      return reply(200, {
        top_genres: [
          { name: "Science fiction", weight: 0.42 },
          { name: "Comedy", weight: 0.27 },
          { name: "Animation", weight: 0.18 },
        ],
        rated: 214,
      });
    return reply(404, { detail: "Not Found" });
  };

  return {
    fetch: fetchImpl,
    requests,
    reset() {
      requests.length = 0;
      polls = new Map();
      valid = new Set([COOKIE]);
      nextPin = 1;
    },
    signOutAll() {
      valid = new Set();
    },
  };
}
