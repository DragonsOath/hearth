import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { Vault } from "../auth/vault";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { pathProblem } from "../apps/app-api";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "../apps/http";
import { CredentialError, fitsNeed, type CredentialBroker } from "./broker";

/**
 * Saved sign-ins (11-11, the owner: "a custom panel with a login that can be stored in the
 * Secure Vault so sign ins get saved"). Some apps have no API key at all: Tasterr only lets in a
 * browser that signed in, with a Plex PIN or a login, and keeps it signed in with a cookie. Hearth
 * signs in to such an app itself, server to server, and keeps the session in the Secure Vault
 * like any credential: encrypted, sent only by the backend and only to the app's own address,
 * never to the browser or an AI. Ember (app_api, Panel Builder) then reads the app with
 * auth "session".
 *
 * How to sign in (the recipe) comes from the app's own API, read by Ember and kept with the
 * session. A login recipe signs in again by itself when the session runs out; a Plex PIN needs the
 * owner to press Allow on plex.tv, once, and again only if the app ever forgets the session.
 */

export type SignInRecipe =
  | {
      type: "login";
      /** Where the app takes its sign-in: "/api/v1/auth/local". */
      path: string;
      format: "json" | "form";
      /** The field names for the username (or email) and the password. */
      userField: string;
      passField: string;
      /** A field in the answer that holds a token, for an app that answers one instead of a cookie. */
      tokenField?: string;
    }
  | {
      type: "plex-pin";
      /** The app's own PIN start, answering a handle and a plex.tv address: "/api/v1/auth/plex/pin". */
      start: string;
      /** Where it is polled with the handle until the owner allowed it: "/api/v1/auth/plex/pin/poll". */
      poll: string;
      /** The answer's field names (Tasterr: pin_id, auth_url). */
      handleField: string;
      urlField: string;
      /**
       * A page that needs the session (Tasterr: "/api/v1/auth/me"). Read now and then so the app
       * renews the session while it is used, and so a session it ended is noticed.
       */
      check?: string;
    };

type Way = SignInRecipe["type"];

/** What the vault keeps for a saved sign-in (encrypted, one value). */
interface SessionValue {
  /** The way it signed in last (or will sign in by default). */
  recipe: SignInRecipe;
  /** Every way the app offers (Tasterr: Plex and its local login), for the panel to show. */
  ways?: SignInRecipe[];
  cookie?: string;
  bearer?: string;
  signedInAt?: string;
}

export interface SignInStatus {
  /** How the app signs in now (the way used last), when known. */
  how?: Way;
  /** Every way the app offers, in the order the panel shows them. */
  ways?: Way[];
  signedIn: boolean;
  signedInAt?: string;
  /** A Plex PIN sign-in waiting for Allow on plex.tv. */
  waiting?: { attempt: string; url: string; since: string };
  /** Why the last sign-in did not work, in words. */
  problem?: string;
  /** The app offers its own login and none is in the Secure Vault yet: the panel asks for it. */
  needsLogin?: boolean;
  /** The app's login in the vault, for a login sign-in (its id and user name; never the password). */
  login?: { id: string; username: string };
}

/** The vault entry's note: how the app signs in, never a claim that it is signed in. */
function noteFor(r: SignInRecipe): string {
  return r.type === "plex-pin"
    ? "Signs in with Plex: press Sign in with Plex on the app's panel, then Allow on plex.tv. Hearth keeps the session; delete this to sign out."
    : "Signs in with the app's own login, kept in the Secure Vault next to this. Hearth signs in again when the session runs out; delete this to sign out.";
}

const FIELD = /^[A-Za-z0-9_.-]{1,40}$/;

/** Why a recipe cannot be used, or undefined. Only paths on the app itself. */
export function recipeProblem(r: SignInRecipe): string | undefined {
  if (r.type === "login") {
    if (r.format !== "json" && r.format !== "form") return 'format must be "json" or "form".';
    if (!FIELD.test(r.userField) || !FIELD.test(r.passField))
      return "userField and passField must be plain field names.";
    if (r.tokenField !== undefined && !FIELD.test(r.tokenField))
      return "tokenField must be a plain field name.";
    return pathProblem(r.path);
  }
  if (r.type === "plex-pin") {
    if (!FIELD.test(r.handleField) || !FIELD.test(r.urlField))
      return "handleField and urlField must be plain field names.";
    return (
      pathProblem(r.start) ?? pathProblem(r.poll) ?? (r.check ? pathProblem(r.check) : undefined)
    );
  }
  return 'type must be "login" or "plex-pin".';
}

/** The cookies an answer set, as one Cookie header ("a=1; b=2"); cleared ones left out. */
export function cookiesOf(setCookie: string | null | undefined): string | undefined {
  if (!setCookie) return undefined;
  const pairs = setCookie
    // Several Set-Cookie headers arrive joined by commas; dates inside one also have commas.
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
    .map((c) => {
      const [pair, ...attrs] = c.split(";").map((x) => x.trim());
      const cleared = attrs.some((a) => /^max-age=0$/i.test(a)) || /=$/.test(pair ?? "");
      return cleared ? undefined : pair;
    })
    .filter((p): p is string => Boolean(p && /^[^=\s]+=/.test(p)));
  return pairs.length ? pairs.join("; ") : undefined;
}

/**
 * Ways to sign in that Hearth knows from the app's own source, offered before Ember has set
 * anything up. Tasterr (read from its source on the home server, 11-13, tasterr/api/auth.py): a Plex PIN
 * (POST /api/v1/auth/plex/pin answers pin_id and an app.plex.tv auth_url; POST
 * /api/v1/auth/plex/pin/poll with pin_id answers "ok" and sets the session cookie, 30 days,
 * renewed while used) and its local login (POST /api/v1/auth/local, email and password: a Seerr
 * local account). It takes no Plex token directly: the Plex token goes from plex.tv to Tasterr
 * only, so a Plex sign-in is always the owner pressing Allow on plex.tv once.
 */
export function knownWays(service: { name: string; image?: string | null }): SignInRecipe[] {
  if (/tasterr/i.test(`${service.image ?? ""} ${service.name}`))
    return [
      {
        type: "plex-pin",
        start: "/api/v1/auth/plex/pin",
        poll: "/api/v1/auth/plex/pin/poll",
        handleField: "pin_id",
        urlField: "auth_url",
        check: "/api/v1/auth/me",
      },
      {
        type: "login",
        path: "/api/v1/auth/local",
        format: "json",
        userField: "email",
        passField: "password",
      },
    ];
  return [];
}

/** One recipe per way: the saved ones first (Ember's or yours), then what Hearth knows. */
function mergeWays(...lists: (SignInRecipe[] | undefined)[]): SignInRecipe[] {
  const out: SignInRecipe[] = [];
  for (const list of lists)
    for (const r of list ?? []) if (!out.some((x) => x.type === r.type)) out.push(r);
  return out;
}

/** Plex first: most people sign in to these apps with Plex. */
const ORDER: Record<Way, number> = { "plex-pin": 0, login: 1 };

const PIN_MS = 10 * 60_000;
/** How often saved Plex sign-ins are looked at (the app renews a session that is used). */
const KEEP_ALIVE_MS = 12 * 3_600_000;

export class AppSessions {
  private readonly attempts = new Map<
    string,
    {
      serviceId: string;
      handle: string;
      url: string;
      since: string;
      done?: boolean;
      problem?: string;
    }
  >();

  constructor(
    private readonly handle: DbHandle,
    private readonly vault: Vault,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: () => Fetch,
    private readonly pollMs = 2000,
  ) {}

  private async service(serviceId: string) {
    const s = (
      await this.handle.db.select().from(t.services).where(eq(t.services.id, serviceId))
    )[0];
    if (!s || s.lifecycle !== "active") throw new NotFoundError("Not a system Hearth watches.");
    if (!/^https?:\/\//.test(s.localUrl ?? ""))
      throw new ConflictError(`Hearth does not know a web address for ${s.name}.`);
    return s as typeof s & { localUrl: string };
  }

  private async row(serviceId: string) {
    return (
      await this.handle.db
        .select()
        .from(t.vaultSecrets)
        .where(and(eq(t.vaultSecrets.serviceId, serviceId), eq(t.vaultSecrets.kind, "session")))
    )[0];
  }

  private async read(serviceId: string, purpose: string): Promise<SessionValue | undefined> {
    const row = await this.row(serviceId);
    if (!row) return undefined;
    const raw = await this.vault.use(row.id, purpose, { actor: "dragon-control", audit: false });
    try {
      return JSON.parse(raw) as SessionValue;
    } catch {
      return undefined;
    }
  }

  /** Called when Hearth has just signed in to an app (its panel reads again at once). */
  onSignedIn?: (serviceId: string) => void;

  private async write(serviceId: string, value: SessionValue) {
    if (value.cookie || value.bearer) queueMicrotask(() => this.onSignedIn?.(serviceId));
    const row = await this.row(serviceId);
    const s = await this.service(serviceId);
    if (row)
      await this.vault.update(row.id, {
        value: JSON.stringify(value),
        notes: noteFor(value.recipe),
      });
    else
      await this.vault.add({
        name: `${s.name} sign-in`,
        kind: "session",
        tier: "automation",
        serviceId,
        value: JSON.stringify(value),
        // A session reads; a change still goes through an approved plan with the app's own rules.
        scope: "approved-changes",
        endpoint: s.localUrl,
        category: "Saved sign-ins",
        notes: noteFor(value.recipe),
        actor: "dragon-control",
        source: "generated: saved sign-in",
      });
  }

  /** The app's own login (a username and its password) in the vault for it, if there is one. */
  private async loginOf(serviceId: string): Promise<{ id: string; username: string } | undefined> {
    const rows = await this.handle.db
      .select({
        id: t.vaultSecrets.id,
        kind: t.vaultSecrets.kind,
        username: t.vaultSecrets.username,
        tier: t.vaultSecrets.tier,
      })
      .from(t.vaultSecrets)
      .where(eq(t.vaultSecrets.serviceId, serviceId));
    const r = rows.find((x) => x.tier === "automation" && fitsNeed({ kind: "login" }, x));
    return r ? { id: r.id, username: r.username ?? "" } : undefined;
  }

  /** Sets how an app signs in (Ember reads it from the app's API; nothing is sent yet). */
  async setRecipe(serviceId: string, recipe: SignInRecipe, by: "agent" | "you") {
    const problem = recipeProblem(recipe);
    if (problem) throw new InvalidRequestError(problem);
    const s = await this.service(serviceId);
    const now = await this.read(serviceId, "saved sign-in: keep the session with a new recipe");
    // The same recipe keeps the session; a new one starts signed out. Other ways stay offered.
    const same = JSON.stringify(now?.recipe) === JSON.stringify(recipe);
    const ways = mergeWays([recipe], now?.ways, now ? [now.recipe] : []);
    await this.write(serviceId, same && now ? { ...now, ways } : { recipe, ways });
    await recordAudit(this.handle.db, {
      actor: by === "agent" ? "agent" : "you",
      action: `Set how Hearth signs in to ${s.name} (${recipe.type === "plex-pin" ? "Plex PIN" : "login"})`,
      target: `service:${serviceId}`,
      detail: { how: recipe.type },
    });
  }

  /** The ways this app offers: saved with its sign-in, else what Hearth knows of the app. */
  private async waysOf(serviceId: string, v?: SessionValue): Promise<SignInRecipe[]> {
    const s = await this.service(serviceId);
    return mergeWays(v ? [v.recipe] : [], v?.ways, knownWays(s)).sort(
      (a, b) => ORDER[a.type] - ORDER[b.type],
    );
  }

  async status(serviceId: string): Promise<SignInStatus> {
    const v = await this.read(serviceId, "saved sign-in: status");
    const ways = await this.waysOf(serviceId, v);
    const waiting = [...this.attempts.entries()].find(
      ([, a]) => a.serviceId === serviceId && !a.done && !a.problem,
    );
    const failed = [...this.attempts.values()]
      .filter((a) => a.serviceId === serviceId && a.problem)
      .at(-1);
    const signedIn = Boolean(v?.cookie || v?.bearer);
    const offersLogin = ways.some((w) => w.type === "login");
    const login = offersLogin ? await this.loginOf(serviceId) : undefined;
    const needsLogin = offersLogin && !signedIn && !login;
    const how = v?.recipe.type ?? ways[0]?.type;
    return {
      ...(how ? { how } : {}),
      ...(ways.length ? { ways: ways.map((w) => w.type) } : {}),
      signedIn,
      ...(needsLogin ? { needsLogin: true } : {}),
      ...(login ? { login } : {}),
      ...(v?.signedInAt ? { signedInAt: v.signedInAt } : {}),
      ...(waiting
        ? { waiting: { attempt: waiting[0], url: waiting[1].url, since: waiting[1].since } }
        : {}),
      ...(failed && !v?.cookie && !v?.bearer ? { problem: failed.problem } : {}),
    };
  }

  /**
   * Signs in now: a login straight away with the app's login from the vault; a Plex PIN starts and
   * answers plex.tv's Allow page for the owner, then Hearth keeps polling until it is allowed.
   */
  async start(serviceId: string, how?: Way): Promise<SignInStatus> {
    try {
      return await this.startNow(serviceId, how);
    } catch (e) {
      // Said plainly on the panel: the app refused, did not answer, or has no login saved.
      if (e instanceof ConflictError || e instanceof NotFoundError) throw e;
      throw new ConflictError(e instanceof Error ? e.message : String(e));
    }
  }

  private async startNow(serviceId: string, how?: Way): Promise<SignInStatus> {
    const s = await this.service(serviceId);
    const v = await this.read(serviceId, "saved sign-in: start");
    const ways = await this.waysOf(serviceId, v);
    const chosen = (how ? ways.find((w) => w.type === how) : v?.recipe) ?? ways[0];
    if (!chosen)
      throw new ConflictError(
        how
          ? `${s.name} doesn't offer that way to sign in.`
          : `Hearth doesn't know how to sign in to ${s.name} yet. Ask Ember to set it up from its API.`,
      );
    if (chosen.type === "login") {
      await this.login(s, chosen, ways);
      return this.status(serviceId);
    }
    const r = chosen;
    const res = await this.post(s, r.start, {});
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = body?.[r.handleField];
    const url = body?.[r.urlField];
    if (!res.ok || typeof handle !== "string" || typeof url !== "string")
      throw new AppUnreachableError(
        `${s.name} did not start a Plex sign-in (it answered ${res.status}).`,
      );
    // Only plex.tv's own Allow page is handed to the owner.
    if (!/^https:\/\/([a-z0-9-]+\.)*plex\.tv\//i.test(url))
      throw new ConflictError(
        `${s.name} answered a sign-in page that is not on plex.tv, so Hearth did not open it.`,
      );
    const attempt = randomUUID();
    const since = new Date().toISOString();
    this.attempts.set(attempt, { serviceId, handle, url, since });
    void this.watch(attempt, s, r);
    return this.status(serviceId);
  }

  /** Polls the app until the owner allowed it on plex.tv (ten minutes at most). */
  private async watch(
    attempt: string,
    s: { id: string; name: string; localUrl: string },
    r: Extract<SignInRecipe, { type: "plex-pin" }>,
  ) {
    const a = this.attempts.get(attempt)!;
    const until = Date.now() + PIN_MS;
    while (Date.now() < until && this.attempts.get(attempt) === a) {
      await new Promise((ok) => setTimeout(ok, this.pollMs));
      try {
        const res = await this.post(s, r.poll, { [r.handleField]: a.handle });
        const cookie = cookiesOf(res.headers?.get("set-cookie"));
        if (res.ok && cookie) {
          const v = await this.read(s.id, "saved sign-in: keep the new session");
          await this.write(s.id, {
            recipe: r,
            ways: await this.waysOf(s.id, v),
            cookie,
            signedInAt: new Date().toISOString(),
          });
          a.done = true;
          await recordAudit(this.handle.db, {
            actor: "you",
            action: `Signed Hearth in to ${s.name} with Plex (session kept in the Secure Vault)`,
            target: `service:${s.id}`,
            detail: { how: "plex-pin" },
          });
          return;
        }
        if (res.status === 404 || res.status === 401 || res.status === 403) {
          a.problem = `${s.name} did not accept the Plex sign-in (it answered ${res.status}). Try again.`;
          return;
        }
      } catch {
        // The app may be restarting: keep trying until the time runs out.
      }
    }
    if (this.attempts.get(attempt) === a && !a.done)
      a.problem = "Plex wasn't allowed within ten minutes. Press Sign in again.";
  }

  private post(
    s: { name: string; localUrl: string },
    path: string,
    body: Record<string, string>,
    form = false,
  ) {
    return this.fetchImpl()(joinUrl(s.localUrl, path), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
      },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((e: unknown) => {
      throw new AppUnreachableError(
        `${s.name} did not answer the sign-in: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  /** A login sign-in with the app's own login from the vault (never shown, never logged). */
  private async login(
    s: { id: string; name: string; localUrl: string },
    r: Extract<SignInRecipe, { type: "login" }>,
    ways?: SignInRecipe[],
  ) {
    const got = await this.broker
      .use(
        {
          serviceId: s.id,
          purpose: `saved sign-in: sign in to ${s.name}`,
          access: "read",
          destination: joinUrl(s.localUrl, r.path),
          login: true,
        },
        async (cred) => {
          const res = await this.post(
            s,
            r.path,
            { [r.userField]: cred.username ?? "", [r.passField]: cred.value },
            r.format === "form",
          );
          if (res.status === 401 || res.status === 403)
            throw new AppKeyError(`${s.name} refused its login from the Secure Vault.`);
          if (!res.ok && (res.status < 300 || res.status >= 400))
            throw new AppUnreachableError(`${s.name} answered ${res.status} to the sign-in.`);
          const cookie = cookiesOf(res.headers?.get("set-cookie"));
          const token = r.tokenField
            ? ((await res.json().catch(() => null)) as Record<string, unknown> | null)?.[
                r.tokenField
              ]
            : undefined;
          return { cookie, bearer: typeof token === "string" ? token : undefined };
        },
      )
      .catch((e: unknown) => {
        // No login saved for it: the sign-in box on its panel is where it goes.
        if (e instanceof CredentialError && e.reason === "missing")
          throw new AppKeyError(signInHere(s.name));
        throw e;
      });
    if (!got.cookie && !got.bearer)
      throw new AppUnreachableError(
        `${s.name} accepted the sign-in but gave no session Hearth can keep.`,
      );
    await this.write(s.id, {
      recipe: r,
      ways: ways ?? (await this.waysOf(s.id, await this.read(s.id, "saved sign-in: its ways"))),
      ...(got.cookie ? { cookie: got.cookie } : {}),
      ...(got.bearer ? { bearer: got.bearer } : {}),
      signedInAt: new Date().toISOString(),
    });
  }

  /**
   * One request with the saved session (auth "session"): the session goes only to the app's own
   * address. Refused, a login signs in again once and retries; a Plex PIN session is marked
   * signed out so the panel asks the owner.
   */
  async withSession<T>(
    serviceId: string,
    purpose: string,
    fn: (credential: { value: string }, headers: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    const s = await this.service(serviceId);
    const v = await this.read(serviceId, purpose);
    if (!v?.cookie && !v?.bearer) {
      const ways = await this.waysOf(serviceId, v);
      if (!ways.length)
        throw new AppKeyError(
          `Hearth has no saved sign-in for ${s.name}. Ask Ember to set one up from its API.`,
        );
      // Signs in by itself when it can (the app's login is saved); a Plex sign-in needs Allow.
      const byLogin = await this.loginWay(serviceId, ways);
      if (!byLogin) throw new AppKeyError(signInHere(s.name));
      await this.login(s, byLogin, ways);
    }
    const once = async () => {
      const now = (await this.read(serviceId, purpose))!;
      const headers: Record<string, string> = {
        ...(now.cookie ? { Cookie: now.cookie } : {}),
        ...(now.bearer ? { Authorization: `Bearer ${now.bearer}` } : {}),
      };
      return fn({ value: now.cookie ?? now.bearer ?? "" }, headers);
    };
    try {
      return await once();
    } catch (e) {
      if (!(e instanceof AppKeyError)) throw e;
      const now = await this.read(serviceId, purpose);
      const ways = await this.waysOf(serviceId, now);
      const byLogin = await this.loginWay(serviceId, ways);
      if (byLogin) {
        await this.login(s, byLogin, ways);
        return once();
      }
      if (now) await this.write(serviceId, { recipe: now.recipe, ways });
      throw new AppKeyError(`${s.name} signed Hearth out. ${signInHere(s.name)}`);
    }
  }

  /** The login way, when the app offers one and its login is in the Secure Vault. */
  private async loginWay(serviceId: string, ways: SignInRecipe[]) {
    const r = ways.find((w): w is Extract<SignInRecipe, { type: "login" }> => w.type === "login");
    return r && (await this.loginOf(serviceId)) ? r : undefined;
  }

  /**
   * Keeps saved Plex sign-ins alive: the app renews a session that is used (Tasterr: 30 days from
   * the last use), so a light read now and then keeps it from running out. A session the app
   * ended is signed in again with the app's login when one is saved; otherwise it is marked signed
   * out, and the panel asks for Sign in with Plex (the one step only the owner can do).
   */
  async keepAlive(): Promise<{ checked: number; signedOut: string[] }> {
    const rows = await this.handle.db
      .select({ serviceId: t.vaultSecrets.serviceId })
      .from(t.vaultSecrets)
      .where(eq(t.vaultSecrets.kind, "session"));
    const signedOut: string[] = [];
    let checked = 0;
    for (const { serviceId } of rows) {
      if (!serviceId) continue;
      try {
        const v = await this.read(serviceId, "saved sign-in: keep it alive");
        if (!v?.cookie || v.recipe.type !== "plex-pin" || !v.recipe.check) continue;
        const s = await this.service(serviceId);
        checked++;
        const res = await this.fetchImpl()(joinUrl(s.localUrl, v.recipe.check), {
          method: "GET",
          headers: { Accept: "application/json", Cookie: v.cookie },
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.status !== 401 && res.status !== 403) continue;
        const ways = await this.waysOf(serviceId, v);
        const byLogin = await this.loginWay(serviceId, ways);
        if (byLogin) await this.login(s, byLogin, ways);
        else {
          await this.write(serviceId, { recipe: v.recipe, ways });
          signedOut.push(s.name);
          await recordAudit(this.handle.db, {
            actor: "dragon-control",
            action: `${s.name} ended Hearth's Plex sign-in; it needs Sign in with Plex on its panel again`,
            target: `service:${serviceId}`,
          });
        }
      } catch {
        // The app may be down: looked at again next time.
      }
    }
    return { checked, signedOut };
  }

  private timer?: ReturnType<typeof setInterval>;

  /** Starts keeping saved Plex sign-ins alive (twice a day). */
  startKeepAlive(everyMs = KEEP_ALIVE_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.keepAlive(), everyMs);
    this.timer.unref?.();
  }

  stopKeepAlive() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** What a panel (and Ember) says when the app needs Hearth signed in: where to do it. */
export function signInHere(name: string): string {
  return `${name} has no API key, so Hearth signs in to it like a browser. Sign Hearth in to ${name} above to fill these in.`;
}
