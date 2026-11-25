import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { SecretLink } from "./link-secret";
import { LINK_HEADER, LINK_SECRET, LINK_VERIFIED_HEADER } from "../pcs/link";
import {
  EMBER_HEADER,
  EMBER_PLAN_SECRET,
  EMBER_SECRET,
  emberRefusal,
  planRefusal,
} from "../agent/hearth-api";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  ForbiddenAuthError,
  REMEMBER_DAYS,
  UnauthorizedError,
  type SignInContext,
  type Auth,
  type RequestOrigin,
  type Session,
} from "./service";
import type { Vault } from "./vault";
import { KEY_SCOPES, ROUTE_SCOPES, type AccessKeys, type KeyPrincipal } from "./tokens";

export const SESSION_COOKIE = "dc_session";

/**
 * The public address (dragoncontrol.example.com) reaches Hearth through Caddy,
 * which sets this header on every request it forwards (replacing anything the client sent).
 * Tailscale and the home network never pass through it. Hearth listens on loopback
 * only, so nothing else can reach it to fake the difference.
 */
export const PUBLIC_HEADER = "x-dc-public";

export function viaPublic(request: FastifyRequest): boolean {
  return request.headers[PUBLIC_HEADER] === "1";
}

/** The client's address as Caddy saw it (public requests only). */
function clientIp(request: FastifyRequest): string {
  const fwd = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")[0]!
    .trim();
  return fwd || request.ip;
}

function signInContext(request: FastifyRequest, remember?: boolean): SignInContext {
  return {
    userAgent: request.headers["user-agent"],
    ...(remember !== undefined ? { remember } : {}),
    ...(viaPublic(request) ? { publicIp: clientIp(request) } : {}),
  };
}

/** Never reachable from the internet, whatever else allows them. */
const PRIVATE_ONLY = new Set([
  "POST /api/auth/setup",
  "POST /api/auth/pair",
  "POST /api/pcs/join",
  "POST /api/pcs/join-hub",
  "GET /api/pcs/hello",
  "POST /api/pcs/link",
  "POST /api/pcs/find",
  "POST /api/pcs/link-start",
  "POST /api/pcs/setup-scan",
  "POST /api/pcs/setup-add",
  "POST /api/layout/share",
]);

/** Routes anyone may call: health, and the ways to sign in or set up. */
/**
 * Everything a paired home tablet may reach (11-04): the home dashboard, its pictures, its
 * taps, and signing itself out. The rest of Hearth (plans, the vault, Ember, settings) answers 403.
 */
export const HOME_TABLET_ROUTES = new Set([
  "GET /api/home",
  "GET /api/home/picture",
  "POST /api/home/action",
  "GET /api/home/board",
  "POST /api/home/board",
  "GET /api/home/news",
  "GET /api/home/photos",
  "GET /api/home/photo",
  "GET /api/home/music/search",
  "GET /api/home/calendar",
  "GET /api/home/scene",
  "GET /api/home/speaker",
  "GET /api/home/music/video",
  "POST /api/home/music/video-tv",
  "POST /api/home/scene",
  "POST /api/home/calendar",
  "GET /api/home/music/library",
  "GET /api/home/music/home",
  "GET /api/home/music/open",
  "GET /api/home/music/art",
  "POST /api/home/music/play",
  "POST /api/auth/logout",
]);

export const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/status",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "POST /api/auth/pair",
  "POST /api/pcs/join",
  "POST /api/pcs/join-hub",
  "GET /api/pcs/hello",
  "POST /api/pcs/link",
  "POST /api/pcs/find",
  "POST /api/pcs/link-start",
  "POST /api/pcs/setup-scan",
  "POST /api/pcs/setup-add",
  // Another Hearth reading this one's layout, with this Hearth's API key (layout/copy.ts).
  "POST /api/layout/share",
  "POST /api/auth/recover",
  "POST /api/auth/passkey/options",
  "POST /api/auth/passkey/verify",
  // Music Assistant's sign-in returning to Hearth: carries its own one-time setup secret.
  "GET /api/home/music-assistant/back",
]);

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
    /** Set when the request came with an access key instead of a session. */
    key: KeyPrincipal | null;
  }
  interface FastifyInstance {
    apiRoutes: string[];
  }
}

const password = z.string().min(1).max(200);
const SECRET_KINDS = [
  "api-key",
  "password",
  "token",
  "login",
  "ssh-key",
  "database",
  "recovery",
  "certificate",
  "oauth-app",
  "other",
] as const;

const secretDetails = {
  category: z.string().max(60).nullable().optional(),
  username: z.string().max(200).nullable().optional(),
  endpoint: z.string().max(300).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
};

const schemas = {
  setup: z.object({ code: z.string().max(20), password }).strict(),
  login: z
    .object({
      password,
      username: z.string().max(60).optional(),
      remember: z.boolean().optional(),
    })
    .strict(),
  credentials: z.object({ username: z.string().max(60).optional(), password }).strict(),
  recover: z.object({ recoveryKey: z.string().max(60), newPassword: password }).strict(),
  change: z.object({ current: password, next: password }).strict(),
  confirm: z.object({ password }).strict(),
  passkeyOptions: z.object({ credentialId: z.string().max(512).optional() }).strict(),
  passkeyVerify: z
    .object({
      response: z.record(z.string(), z.unknown()),
      prf: z.string().max(200).optional(),
      remember: z.boolean().optional(),
    })
    .strict(),
  register: z
    .object({
      response: z.record(z.string(), z.unknown()),
      name: z.string().max(60),
      prf: z.string().max(200).optional(),
    })
    .strict(),
  rename: z.object({ name: z.string().min(1).max(60) }).strict(),
  key: z
    .object({
      name: z.string().min(1).max(60),
      scopes: z.array(z.enum(KEY_SCOPES)).min(1).max(4),
    })
    .strict(),
  secret: z
    .object({
      name: z.string().min(1).max(80),
      kind: z.enum(SECRET_KINDS),
      tier: z.enum(["automation", "protected"]),
      serviceId: z.string().max(200).optional(),
      value: z.string().min(1).max(8192),
      scope: z.enum(["read", "approved-changes"]).optional(),
      ...secretDetails,
    })
    .strict(),
  secretPatch: z
    .object({
      name: z.string().min(1).max(80).optional(),
      serviceId: z.string().max(200).nullable().optional(),
      value: z.string().min(1).max(8192).optional(),
      scope: z.enum(["read", "approved-changes"]).optional(),
      browserSignIn: z.boolean().optional(),
      ...secretDetails,
    })
    .strict(),
};

/** Where the browser is, as WebAuthn needs it. The server listens on loopback behind a proxy. */
export function originOf(request: FastifyRequest): RequestOrigin {
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost");
  const proto = String(request.headers["x-forwarded-proto"] ?? request.protocol ?? "http");
  const origin = request.headers.origin ?? `${proto}://${host}`;
  return { origin, rpId: new URL(origin).hostname };
}

/** A remembered device keeps its cookie; otherwise it ends when the browser closes. */
function setSession(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  persistent = true,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: originOf(request).origin.startsWith("https:"),
    ...(persistent ? { maxAge: REMEMBER_DAYS * 86_400 } : {}),
  });
}

export async function registerAuth(
  app: FastifyInstance,
  auth: Auth,
  vault: Vault,
  keys: AccessKeys,
  /** Finds (or adds) the app a new key belongs to when "Belongs to" was left empty (11-11). */
  linkSecret?: (input: {
    name: string;
    endpoint?: string | null;
  }) => Promise<SecretLink | undefined>,
) {
  await app.register(fastifyCookie);
  app.decorateRequest("session", null);
  app.decorateRequest("key", null);
  // Every route, so a test can prove each one is locked.
  const routes: string[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") routes.push(`${m} ${r.url}`);
  });
  app.decorate("apiRoutes", routes);

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/")) return;
    // Ember using Hearth itself (agent/hearth-api.ts): in-process only, within its rules, and
    // never "it's you just now" (verifiedAt is the epoch).
    if (request.headers[EMBER_HEADER] !== undefined) {
      const plan = request.headers[EMBER_HEADER] === EMBER_PLAN_SECRET;
      if (!plan && request.headers[EMBER_HEADER] !== EMBER_SECRET)
        throw new ForbiddenAuthError("That request is not from this Hearth.");
      // The body is checked again in the step (planRefusal with it) before the request is made.
      // An address Hearth has no route for runs nothing: outside the never-list it answers "not
      // found" with the methods that address does take (app.ts), instead of a refusal that sends
      // Ember into a plan for a request that can only fail.
      const refused = plan
        ? planRefusal(request.method, request.url)
        : emberRefusal(request.method, request.url, Boolean(request.routeOptions.url));
      if (refused) throw new ForbiddenAuthError(refused);
      request.session = {
        id: "ember",
        method: "paired",
        verifiedAt: new Date(0).toISOString(),
        createdAt: new Date().toISOString(),
      };
      return;
    }
    // Over this PC's link from your Hearth, where the owner is signed in (docs/design/ONE_ACCOUNT.md).
    if (request.headers[LINK_HEADER] === LINK_SECRET) {
      const at = String(request.headers[LINK_VERIFIED_HEADER] ?? "");
      request.session = {
        id: "hub-link",
        method: "paired",
        verifiedAt: Number.isNaN(Date.parse(at)) ? new Date(0).toISOString() : at,
        createdAt: new Date().toISOString(),
      };
      return;
    }
    // Requests from another site are refused outright (belt and braces with SameSite cookies).
    if (request.method !== "GET" && request.headers.origin) {
      const { origin } = originOf(request);
      const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "");
      if (new URL(origin).host !== host) {
        throw new ForbiddenAuthError("Requests from other sites are not accepted.");
      }
    }
    const route = `${request.method} ${path}`;
    // From the internet: no setup, no access keys, no AI tool endpoint; only you, signed in.
    if (viaPublic(request)) {
      if (PRIVATE_ONLY.has(route) || path === "/api/mcp" || path.startsWith("/api/mcp/")) {
        throw new ForbiddenAuthError("That only works on your home network or Tailscale.");
      }
      if (request.headers.authorization) {
        throw new ForbiddenAuthError("Access keys only work on your home network or Tailscale.");
      }
    }
    if (PUBLIC_ROUTES.has(route)) {
      // Public routes must answer even when the database cannot (health reports that).
      request.session = await auth.session(request.cookies[SESSION_COOKIE]).catch(() => null);
      return;
    }
    // Access keys: only the routes their scopes open, never settings, security, or the vault.
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    if (bearer) {
      const principal = await keys.verify(bearer);
      if (!principal) throw new UnauthorizedError("That access key is not valid.");
      const needed = ROUTE_SCOPES[`${request.method} ${request.routeOptions.url ?? path}`];
      if (!needed || !principal.scopes.includes(needed)) {
        throw new ForbiddenAuthError("This access key is not allowed to do that.");
      }
      request.key = principal;
      return;
    }
    request.session = await auth.session(request.cookies[SESSION_COOKIE]);
    if (!request.session) {
      throw new UnauthorizedError(
        (await auth.claimed()) ? "Sign in to continue." : "Hearth is not set up yet.",
      );
    }
    // A home tablet reaches the home dashboard and nothing else, whatever the page asks for.
    if (
      request.session.method === "home" &&
      !HOME_TABLET_ROUTES.has(`${request.method} ${request.routeOptions.url ?? path}`)
    )
      throw new ForbiddenAuthError("This is a home tablet: it opens the home dashboard only.");
  });

  const need = (request: FastifyRequest) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
    return request.session;
  };

  /* ---------- Access keys (you only, never another key) ---------- */

  app.get("/api/keys", async (request) => {
    need(request);
    return keys.list();
  });

  app.post("/api/keys", async (request) => {
    need(request);
    const { name, scopes } = schemas.key.parse(request.body);
    return keys.create(name, scopes);
  });

  app.delete<{ Params: { id: string } }>("/api/keys/:id", async (request, reply) => {
    need(request);
    await keys.revoke(request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/auth/status", async (request) => {
    const claimed = await auth.claimed();
    const s = request.session;
    return {
      claimed,
      signedIn: Boolean(s),
      usernameRequired: claimed ? await auth.usernameRequired() : false,
      viaInternet: viaPublic(request),
      // A PC that joined another Hearth: its own page points there.
      joinedTo: (await auth.joinedTo?.()) ?? null,
      ...(s?.method === "home"
        ? // A home tablet learns only that it is one.
          { method: s.method }
        : s
          ? {
              method: s.method,
              recentlyVerified: auth.recentlyVerified(s),
              vaultUnlockedUntil: auth.unlockedUntil(s),
              passkeys: await auth.passkeyList(),
            }
          : {}),
    };
  });

  app.post("/api/auth/setup", async (request, reply) => {
    const body = schemas.setup.parse(request.body);
    const { token, recoveryKey } = await auth.setup(body);
    setSession(request, reply, token);
    return { recoveryKey };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const { password: pw, username, remember } = schemas.login.parse(request.body);
    const result = await auth.withPassword(
      pw,
      request.session,
      signInContext(request, remember),
      username,
    );
    if (result.token) setSession(request, reply, result.token, result.persistent);
    return reply.code(204).send();
  });

  // Add a device: the one-time code from the QR signs this browser or app in.
  app.post("/api/auth/pair", async (request, reply) => {
    const { code } = z
      .object({ code: z.string().min(4).max(80) })
      .strict()
      .parse(request.body);
    const token = await auth.pairDevice(code, signInContext(request, true));
    setSession(request, reply, token);
    return reply.code(204).send();
  });

  app.post("/api/auth/recover", async (request, reply) => {
    const body = schemas.recover.parse(request.body);
    const token = await auth.recover(body, signInContext(request));
    setSession(request, reply, token);
    return reply.code(204).send();
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await auth.signOut(need(request));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.post("/api/auth/logout-all", async (request, reply) => {
    await auth.signOutEverywhere(need(request));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.post("/api/auth/password", async (request, reply) => {
    const { current, next } = schemas.change.parse(request.body);
    await auth.changePassword(need(request), current, next);
    return reply.code(204).send();
  });

  /** A new password (and sign-in name) without the old one, after confirming with a passkey. */
  app.post("/api/auth/credentials", async (request, reply) => {
    const body = schemas.credentials.parse(request.body);
    await auth.setCredentials(need(request), body);
    return reply.code(204).send();
  });

  /** Signed-in devices, to recognise and sign out. */
  app.get("/api/auth/devices", async (request) => ({ devices: await auth.devices(need(request)) }));
  app.delete<{ Params: { id: string } }>("/api/auth/devices/:id", async (request, reply) => {
    need(request);
    await auth.signOutDevice(request.params.id);
    return reply.code(204).send();
  });

  app.post("/api/auth/recovery-key", async (request) => {
    const { password: pw } = schemas.confirm.parse(request.body);
    return { recoveryKey: await auth.regenerateRecoveryKey(need(request), pw) };
  });

  app.post("/api/auth/passkey/options", async (request) => {
    const { credentialId } = schemas.passkeyOptions.parse(request.body ?? {});
    return auth.authenticationOptions(originOf(request), credentialId);
  });

  app.post("/api/auth/passkey/verify", async (request, reply) => {
    const body = schemas.passkeyVerify.parse(request.body);
    const result = await auth.withPasskey(
      originOf(request),
      { response: body.response as unknown as AuthenticationResponseJSON, prf: body.prf },
      request.session,
      signInContext(request, body.remember),
    );
    if (result.token) setSession(request, reply, result.token, body.remember !== false);
    return { unlocked: result.unlocked };
  });

  app.post("/api/auth/passkeys/options", async (request) =>
    auth.registrationOptions(need(request), originOf(request)),
  );

  app.post("/api/auth/passkeys", async (request) => {
    const body = schemas.register.parse(request.body);
    return auth.register(need(request), originOf(request), {
      response: body.response as unknown as RegistrationResponseJSON,
      name: body.name,
      prf: body.prf,
    });
  });

  app.patch<{ Params: { id: string } }>("/api/auth/passkeys/:id", async (request, reply) => {
    const { name } = schemas.rename.parse(request.body);
    await auth.renamePasskey(request.params.id, name);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/api/auth/passkeys/:id", async (request, reply) => {
    await auth.removePasskey(need(request), request.params.id);
    return reply.code(204).send();
  });

  /* ---------- Vault ---------- */

  // The list itself is behind the lock: names, accounts, and where they are used stay
  // hidden until you unlock (or have just confirmed it is you). Values never come in a list.
  app.get("/api/vault", async (request) => {
    const s = need(request);
    const unlockedUntil = auth.unlockedUntil(s);
    const recentlyVerified = auth.recentlyVerified(s);
    if (!unlockedUntil && !recentlyVerified) {
      return { locked: true, count: (await vault.list()).length, secrets: [], recentlyVerified };
    }
    return { locked: false, secrets: await vault.list(), unlockedUntil, recentlyVerified };
  });

  app.post<{ Params: { id: string } }>(
    "/api/vault/secrets/:id/verified",
    async (request, reply) => {
      need(request);
      await vault.markVerified(request.params.id);
      return reply.code(204).send();
    },
  );

  app.post("/api/vault/lock", async (request, reply) => {
    auth.lock(need(request));
    return reply.code(204).send();
  });

  app.post("/api/vault/secrets", async (request) => {
    const input = schemas.secret.parse(request.body);
    const link = input.serviceId ? undefined : await linkSecret?.(input).catch(() => undefined);
    const saved = await vault.add({ ...input, ...(link ? { serviceId: link.serviceId } : {}) });
    return { ...saved, ...(link ? { linked: { name: link.name, added: link.added } } : {}) };
  });

  app.patch<{ Params: { id: string } }>("/api/vault/secrets/:id", async (request, reply) => {
    const patch = schemas.secretPatch.parse(request.body);
    // Letting the browser sign in with a credential is a new use of it: only with the vault
    // open, or right after you confirmed it is you.
    if (patch.browserSignIn === true) {
      const s = need(request);
      if (!auth.unlockedUntil(s) && !auth.recentlyVerified(s))
        throw new ForbiddenAuthError("Unlock the Secure Vault (or confirm it's you) first.");
    }
    await vault.update(request.params.id, patch);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>("/api/vault/secrets/:id", async (request, reply) => {
    await vault.remove(need(request), request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/vault/secrets/:id/reveal", async (request) => ({
    value: await vault.reveal(need(request), request.params.id),
  }));
}
