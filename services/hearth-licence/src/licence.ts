/**
 * Hearth's licence service (docs/design/PREMIUM.md "Licence service"). It does two things a
 * Hearth can't do offline:
 *
 * - **Redeem a promo code** for any installation: it checks the code (only its hash is kept),
 *   claims one use, and signs a licence for that installation with its own signing key, which
 *   Hearth's releases trust next to the owner's.
 * - **Say which licences were taken back**, so every Hearth learns of a revocation.
 *
 * Codes and revocations come only from the owner's Hearth, in requests signed with the owner's
 * licence signing key (OWNER_KEY is its public half). No account, no card, no personal data:
 * an installation id is a random id Hearth made at first start.
 */

export interface Env {
  /** The service's own signing key: Ed25519, PKCS#8 PEM (a Worker secret, never in files). */
  SIGNING_KEY: string;
  /** The owner's licence signing key, public half (raw, base64url). Empty: owner requests refused. */
  OWNER_KEY: string;
  /** The owner's code site (owner.ts): GitHub sign-in. Empty: the site stays shut. */
  GITHUB_CLIENT_ID?: string;
  /** A Worker secret, never in files. */
  GITHUB_CLIENT_SECRET?: string;
  /** The only GitHub account (numeric id) that may sign in to the owner's site. */
  OWNER_GITHUB_ID?: string;
  /** Signs the owner's sign-in cookie (a Worker secret, made by setup.mjs, never shown). */
  SESSION_KEY?: string;
  /** The least a one-time GitHub sponsorship must be to claim Founder (claim.ts); default 60. */
  FOUNDER_MIN_USD?: string;
  /** Where the code page lives (hearth.dragonsoath.com/codes); its GitHub callback is here too. */
  SITE_ORIGIN?: string;
  /** The Hearth Discord server, and the forums the Founder offer can watch (the real one, the test one). */
  GUILD_ID?: string;
  FORUM_ID?: string;
  TEST_FORUM_ID?: string;
}

/** What the code page needs beyond codes: the Founder offer's record, and Ember Bot to DM a code. */
export interface Extras {
  founder?: FounderStore;
  ember?: EmberSender;
  /**
   * Premium Ember, the secret picture only code holders see (11-19): kept in this service's
   * private database, never in the repository or on the website. Null: not uploaded yet.
   */
  premiumEmber?: () => Promise<Picture | null>;
}

export interface Picture {
  type: string;
  data: ArrayBuffer;
}

/** What Send with Ember did. Nothing is sent unless it says "sent". */
export type SendResult =
  | { status: "sent"; name: string }
  | { status: "not-found" }
  | { status: "ambiguous"; names: string[] }
  | { status: "dm-closed"; name: string };

/** Ember Bot, reached through a Cloudflare service binding (never over the internet). */
export interface EmberSender {
  /** DMs a Founder code; false when their DMs are closed (she then asks them in the post). */
  sendFounderCode(a: {
    userId: string;
    postId: string;
    code: string;
    /** How long the code holds their spot, in words ("7 days"). */
    hold?: string;
    picture?: Picture | null;
  }): Promise<{ sent: boolean }>;
  /**
   * Tells someone why their Founder post was turned away: by DM, or in their post when their DMs
   * are closed. Here, the owner's rejection with his reason.
   */
  tellFounder(a: {
    userId: string;
    postId: string;
    denial: Denial;
  }): Promise<{ via: "dm" | "thread" }>;
  /** Send with Ember: DMs a code to a Discord name in the Hearth Discord server, with Premium Ember. */
  sendCode(a: {
    to: string;
    code: string;
    months: number | null;
    picture?: Picture | null;
  }): Promise<SendResult>;
}

export interface Code {
  id: string;
  hash: string;
  features: string[];
  maxUses: number;
  uses: number;
  /** How long a redeemed licence lasts; null: for good. */
  days: number | null;
  /** The last moment it can be redeemed (ISO); null: no limit. */
  redeemBy: string | null;
  /** Shown to the recipient on their licence (the campaign). */
  label: string | null;
  active: boolean;
  /** The owner's code site: which campaign, who it was given to, its first letters, when made. */
  campaignId?: string | null;
  note?: string | null;
  hint?: string | null;
  createdAt?: string | null;
}

/** A batch of codes the owner hands out ("Around the Fire launch"): Founder or some months. */
export interface Campaign {
  id: string;
  name: string;
  /** null: Founder, Premium for good. */
  months: number | null;
  /** How many codes it may give; null: no limit. */
  cap: number | null;
  /** Given free (the redeem page asks reviewers to say so). */
  gift: boolean;
  createdAt: string;
  active: boolean;
}

/** A licence the owner made straight for an installation of his own. */
export interface Grant {
  licenceId: string;
  install: string;
  label: string | null;
  at: string;
}

export interface Redemption {
  codeId: string;
  install: string;
  licenceId: string;
  at: string;
  ends: string | null;
}

export interface Store {
  codeByHash(hash: string): Promise<Code | null>;
  codeById(id: string): Promise<Code | null>;
  /** The licences redeemed from a code. */
  licencesOf(codeId: string): Promise<string[]>;
  redeemed(codeId: string, install: string): Promise<boolean>;
  /** Claims one use only while one is left and the code is on (one step, so never past the limit). */
  claim(codeId: string): Promise<boolean>;
  /** Gives a claimed use back (the redemption couldn't be recorded). */
  unclaim(codeId: string): Promise<void>;
  /** Records a redemption; false when this installation already has one for the code. */
  record(r: Redemption): Promise<boolean>;
  putCode(c: Omit<Code, "uses">): Promise<void>;
  setActive(id: string, active: boolean): Promise<boolean>;
  revoke(ids: string[], at: string): Promise<void>;
  unrevoke(id: string): Promise<void>;
  revoked(): Promise<string[]>;
  /** False when the nonce was already used (a replayed request). Old nonces are forgotten. */
  useNonce(nonce: string, now: number): Promise<boolean>;
  /** Adds this try, then counts this installation's tries in the last minute and hour. */
  tries(install: string, now: number): Promise<{ minute: number; hour: number }>;
  redemptions(): Promise<Redemption[]>;
  codes(): Promise<Code[]>;
  campaigns(): Promise<Campaign[]>;
  campaign(id: string): Promise<Campaign | null>;
  putCampaign(c: Campaign): Promise<void>;
  /** How many codes a campaign has given. */
  given(campaignId: string): Promise<number>;
  setNote(codeId: string, note: string | null): Promise<boolean>;
  grants(): Promise<Grant[]>;
  putGrant(g: Grant): Promise<void>;
}

import type { Denial, FounderStore } from "./founder";
import { owner } from "./owner";

const PREFIX = "HEARTHL1";
const enc = new TextEncoder();

export const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** The same folding Hearth uses (issuer.ts normalizeCode), so a code hashes the same here. */
export const normalizeCode = (code: string) =>
  code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/^HRTH(?=.{20}$)/, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

export async function codeHash(code: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(`hearth-promo:${normalizeCode(code)}`),
  );
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const pemBody = (pem: string) =>
  fromB64u(
    pem
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  );

/** The service key, imported once per Worker instance. */
let signer: { pem: string; key: CryptoKey; keyId: string } | undefined;
async function serviceKey(pem: string) {
  if (signer?.pem === pem) return signer;
  const key = await crypto.subtle.importKey("pkcs8", pemBody(pem), { name: "Ed25519" }, true, [
    "sign",
  ]);
  // The public half, from the private key's JWK (x is the raw public key, base64url).
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as { x?: string };
  signer = { pem, key, keyId: (jwk.x ?? "").slice(0, 12) };
  return signer;
}

/** The public half of the service key (for PRODUCTION_KEYS), raw base64url. */
export async function servicePublicKey(pem: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemBody(pem), { name: "Ed25519" }, true, [
    "sign",
  ]);
  return ((await crypto.subtle.exportKey("jwk", key)) as { x?: string }).x ?? "";
}

/** A licence in Hearth's format (apps/server/src/premium/license.ts), signed by the service. */
export async function signLicence(
  payload: {
    id: string;
    install: string;
    features: string[];
    kind: "complimentary";
    start: string;
    end?: string;
    issued: string;
    label?: string;
  },
  pem: string,
): Promise<string> {
  const k = await serviceKey(pem);
  const body = b64u(enc.encode(JSON.stringify({ v: 1, ...payload, key: k.keyId })));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, k.key, enc.encode(`${PREFIX}.${body}`));
  return `${PREFIX}.${body}.${b64u(sig)}`;
}

/** What the owner's Hearth signs: a fixed prefix and the exact request body. */
export const ownerMessage = (body: string) => enc.encode(`hearth-licence-owner:${body}`);

async function ownerSigned(body: string, sig: string | null, ownerKey: string) {
  if (!sig || !ownerKey) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromB64u(ownerKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromB64u(sig), ownerMessage(body));
  } catch {
    return false;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const refuse = (status: number, error: string) => json(status, { error });

const ID = /^[\w-]{8,80}$/;
const MAX_BODY = 16_384;
/** An owner request must be this fresh (and its nonce unused). */
const OWNER_WINDOW = 5 * 60_000;

/** Every route. `now` is injectable for tests. */
export async function handle(
  req: Request,
  env: Env,
  store: Store,
  now: () => number = Date.now,
  fetchImpl: typeof fetch = fetch,
  extras: Extras = {},
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "GET" && (path === "" || path === "/v1")) {
    return json(200, {
      service: "hearth-licence",
      key: env.SIGNING_KEY ? await servicePublicKey(env.SIGNING_KEY) : null,
    });
  }

  // The owner's Hearth shows how often a code was used (its id is random; no one else knows it).
  const codeMatch = /^\/v1\/codes\/([\w-]{8,80})$/.exec(path);
  if (req.method === "GET" && codeMatch) {
    const c = await store.codeById(codeMatch[1]!);
    if (!c) return refuse(404, "The licence service doesn't know that code.");
    return json(200, { uses: c.uses, maxUses: c.maxUses, active: c.active });
  }

  // Every Hearth asks this now and then: the licences taken back.
  if (req.method === "GET" && path === "/v1/revoked") {
    return json(200, { revoked: await store.revoked(), at: new Date(now()).toISOString() });
  }

  if (req.method === "POST" && path === "/v1/redeem") {
    const text = await req.text();
    if (text.length > MAX_BODY) return refuse(413, "That request is too big.");
    let body: { code?: unknown; install?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return refuse(400, "That request isn't readable.");
    }
    const code = typeof body.code === "string" ? body.code : "";
    const install = typeof body.install === "string" ? body.install : "";
    if (code.length < 8 || code.length > 64 || !ID.test(install))
      return refuse(400, "A code and this installation's ID are needed.");
    const t = now();
    // Five tries a minute and twenty an hour per installation, as on the owner's Hearth.
    const { minute, hour } = await store.tries(install, t);
    if (minute > 5 || hour > 20) return refuse(429, "Too many tries. Wait a little and try again.");
    const row = await store.codeByHash(await codeHash(code));
    if (!row) return refuse(404, "That code isn't right. Check it and try again.");
    if (!row.active) return refuse(409, "That code has been switched off.");
    if (row.redeemBy && t >= Date.parse(row.redeemBy)) return refuse(409, "That code has expired.");
    if (await store.redeemed(row.id, install))
      return refuse(409, "This installation already redeemed that code.");
    if (!(await store.claim(row.id))) return refuse(409, "That code has been used up.");
    const start = new Date(t).toISOString();
    const end = row.days ? new Date(t + row.days * 86_400_000).toISOString() : undefined;
    const licenceId = crypto.randomUUID();
    let licence: string;
    try {
      licence = await signLicence(
        {
          id: licenceId,
          install,
          features: row.features,
          kind: "complimentary",
          start,
          ...(end ? { end } : {}),
          issued: start,
          ...(row.label ? { label: row.label } : {}),
        },
        env.SIGNING_KEY,
      );
    } catch {
      await store.unclaim(row.id);
      return refuse(503, "The licence service can't sign right now. Try again later.");
    }
    const recorded = await store.record({
      codeId: row.id,
      install,
      licenceId,
      at: start,
      ends: end ?? null,
    });
    if (!recorded) {
      await store.unclaim(row.id);
      return refuse(409, "This installation already redeemed that code.");
    }
    const camp = row.campaignId ? await store.campaign(row.campaignId) : null;
    return json(200, { licence, licenceId, gifted: camp ? camp.gift : false });
  }

  // The owner's Hearth: add or switch off codes, take licences back, read redemptions.
  if (req.method === "POST" && path === "/v1/owner") {
    const text = await req.text();
    if (text.length > MAX_BODY) return refuse(413, "That request is too big.");
    if (!(await ownerSigned(text, req.headers.get("x-hearth-signature"), env.OWNER_KEY)))
      return refuse(403, "That request isn't signed by the owner's licence key.");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return refuse(400, "That request isn't readable.");
    }
    const t = now();
    const at = typeof body.at === "string" ? Date.parse(body.at) : NaN;
    if (!Number.isFinite(at) || Math.abs(t - at) > OWNER_WINDOW)
      return refuse(409, "That request is too old (or this computer's clock is off).");
    if (
      typeof body.nonce !== "string" ||
      !ID.test(body.nonce) ||
      !(await store.useNonce(body.nonce, t))
    )
      return refuse(409, "That request was already used.");
    switch (body.op) {
      case "code": {
        const c = body.code as Partial<Code> | undefined;
        if (
          !c ||
          typeof c.id !== "string" ||
          !ID.test(c.id) ||
          typeof c.hash !== "string" ||
          !/^[0-9a-f]{64}$/.test(c.hash) ||
          !Array.isArray(c.features) ||
          !c.features.length ||
          !c.features.every((f) => typeof f === "string" && /^[a-z_]{3,40}$/.test(f)) ||
          typeof c.maxUses !== "number" ||
          c.maxUses < 1 ||
          c.maxUses > 100_000
        )
          return refuse(400, "That code isn't complete.");
        await store.putCode({
          id: c.id,
          hash: c.hash,
          features: c.features,
          maxUses: Math.floor(c.maxUses),
          days: typeof c.days === "number" && c.days > 0 ? Math.floor(c.days) : null,
          redeemBy: typeof c.redeemBy === "string" ? c.redeemBy : null,
          label: typeof c.label === "string" ? c.label.slice(0, 60) : null,
          active: c.active !== false,
        });
        return json(200, { ok: true });
      }
      case "code-active": {
        if (typeof body.id !== "string" || typeof body.active !== "boolean")
          return refuse(400, "Which code, and on or off?");
        if (!(await store.setActive(body.id, body.active)))
          return refuse(404, "The licence service doesn't know that code.");
        return json(200, { ok: true });
      }
      case "revoke": {
        const ids = body.ids;
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          !ids.every((x) => typeof x === "string" && ID.test(x))
        )
          return refuse(400, "Which licences?");
        await store.revoke(ids as string[], new Date(t).toISOString());
        return json(200, { ok: true });
      }
      case "revoke-code": {
        if (typeof body.id !== "string") return refuse(400, "Which code?");
        const ids = await store.licencesOf(body.id);
        if (ids.length) await store.revoke(ids, new Date(t).toISOString());
        return json(200, { ok: true, revoked: ids.length });
      }
      case "unrevoke": {
        if (typeof body.id !== "string") return refuse(400, "Which licence?");
        await store.unrevoke(body.id);
        return json(200, { ok: true });
      }
      case "list": {
        const codes = (await store.codes()).map(({ hash: _hash, ...c }) => c);
        return json(200, { codes, redemptions: await store.redemptions() });
      }
      default:
        return refuse(400, "Unknown request.");
    }
  }

  if (path === "/codes" || path.startsWith("/codes/"))
    return owner(req, env, store, path, now, fetchImpl, extras);

  return refuse(404, "Not found.");
}

/** For tests: everything in memory, with the same one-step claim. */
export function memoryStore(): Store & { all: { codes: Map<string, Code> } } {
  const codes = new Map<string, Code>();
  const redemptions: Redemption[] = [];
  const revoked = new Map<string, string>();
  const nonces = new Map<string, number>();
  const tries: { install: string; at: number }[] = [];
  const campaigns = new Map<string, Campaign>();
  const grants: Grant[] = [];
  return {
    all: { codes },
    async codeByHash(hash) {
      return [...codes.values()].find((c) => c.hash === hash) ?? null;
    },
    async codeById(id) {
      return codes.get(id) ?? null;
    },
    async licencesOf(codeId) {
      return redemptions.filter((r) => r.codeId === codeId).map((r) => r.licenceId);
    },
    async redeemed(codeId, install) {
      return redemptions.some((r) => r.codeId === codeId && r.install === install);
    },
    async claim(codeId) {
      const c = codes.get(codeId);
      if (!c || !c.active || c.uses >= c.maxUses) return false;
      c.uses += 1;
      return true;
    },
    async unclaim(codeId) {
      const c = codes.get(codeId);
      if (c && c.uses > 0) c.uses -= 1;
    },
    async record(r) {
      if (redemptions.some((x) => x.codeId === r.codeId && x.install === r.install)) return false;
      redemptions.push(r);
      return true;
    },
    async putCode(c) {
      codes.set(c.id, { ...c, uses: codes.get(c.id)?.uses ?? 0 });
    },
    async campaigns() {
      return [...campaigns.values()];
    },
    async campaign(id) {
      return campaigns.get(id) ?? null;
    },
    async putCampaign(c) {
      campaigns.set(c.id, { ...c });
    },
    async given(campaignId) {
      return [...codes.values()].filter((c) => c.campaignId === campaignId).length;
    },
    async setNote(id, note) {
      const c = codes.get(id);
      if (!c) return false;
      c.note = note;
      return true;
    },
    async grants() {
      return [...grants];
    },
    async putGrant(g) {
      grants.push(g);
    },
    async setActive(id, active) {
      const c = codes.get(id);
      if (!c) return false;
      c.active = active;
      return true;
    },
    async revoke(ids, at) {
      for (const id of ids) revoked.set(id, at);
    },
    async unrevoke(id) {
      revoked.delete(id);
    },
    async revoked() {
      return [...revoked.keys()];
    },
    async useNonce(nonce, now) {
      for (const [n, at] of nonces) if (now - at > 2 * OWNER_WINDOW) nonces.delete(n);
      if (nonces.has(nonce)) return false;
      nonces.set(nonce, now);
      return true;
    },
    async tries(install, now) {
      tries.push({ install, at: now });
      const mine = tries.filter((x) => x.install === install);
      return {
        minute: mine.filter((x) => x.at >= now - 60_000).length,
        hour: mine.filter((x) => x.at >= now - 3_600_000).length,
      };
    },
    async redemptions() {
      return [...redemptions];
    },
    async codes() {
      return [...codes.values()];
    },
  };
}
