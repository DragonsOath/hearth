import { PREMIUM_FEATURES } from "../../../packages/core/src/premium";
import { CLAIM_STATE, claimCallback, claimRoute } from "./claim";
import {
  HOLD_MINUTES,
  holdWords,
  standing,
  statusLine,
  TEST_HOLD_MINUTES,
  type Entry,
} from "./founder";
import {
  b64u,
  codeHash,
  signLicence,
  type Campaign,
  type Env,
  type Extras,
  type Store,
} from "./licence";

/**
 * The owner's code site (11-17), at hearth.dragonsoath.com/codes: the one place Premium codes are
 * made, apart from anyone's Hearth. Only the owner's GitHub account gets in (GitHub sign-in, then
 * its numeric id must be OWNER_GITHUB_ID). He makes campaigns ("Around the Fire launch", Founder
 * or some months, an optional cap), gives one code at a time with the person's Discord name next
 * to it, sees what was used, switches a code off or takes Premium back, and makes licence keys for
 * his own installations. A code is shown once, when given; only its hash and first letters stay.
 * The Founder offer's queue is here too: Approve has Ember Bot DM the person a code.
 *
 * Every /codes/api request is checked here, on the server: a signed cookie naming the owner's
 * GitHub id, made only after GitHub said that account signed in. Nothing is only hidden.
 */

const COOKIE = "__Host-hearth-owner";
const STATE_COOKIE = "__Host-hearth-state";
const SESSION_HOURS = 12;
const enc = new TextEncoder();
const ID = /^[\w-]{8,80}$/;
/** Crockford's letters (no I, L, O, U), the same as codes made on a Hearth. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const refuse = (status: number, error: string) => json(status, { error });

async function hmac(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
}

/** Equal without leaking where they differ. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return undefined;
}

const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

/** The signed-in owner, or undefined. */
async function signedIn(req: Request, env: Env, t: number): Promise<boolean> {
  const v = cookie(req, COOKIE);
  if (!v || !env.SESSION_KEY || !env.OWNER_GITHUB_ID) return false;
  const [uid, exp, sig] = v.split(".");
  if (!uid || !exp || !sig) return false;
  if (uid !== env.OWNER_GITHUB_ID || !(Number(exp) > t)) return false;
  return same(sig, await hmac(env.SESSION_KEY, `${uid}.${exp}`));
}

/** A new code: HRTH- and 20 letters (100 random bits). */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const letters = [...bytes].map((b) => ALPHABET[b & 31]).join("");
  return `HRTH-${letters.slice(0, 5)}-${letters.slice(5, 10)}-${letters.slice(10, 15)}-${letters.slice(15)}`;
}

const what = (months: number | null) =>
  months ? `Hearth Premium for ${months} month${months === 1 ? "" : "s"}` : "Hearth Founder";

/** The message the owner pastes to the person, with the code in it. */
export const giftMessage = (code: string, months: number | null) =>
  `Thanks for sharing! Here's your free ${what(months)} code: ${code}\n` +
  `In Hearth, open Settings, Premium, and enter it under Redeem a code. It works once, on one Hearth.`;

/** A Discord post link (or a bare id): the post's id. */
export function threadOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ids = v.match(/\d{17,20}/g) ?? [];
  // discord.com/channels/<server>/<post>[/<message>]: the post is the second id.
  return ids.length >= 2 ? ids[1]! : (ids[0] ?? null);
}

/** One one-use code from a campaign (never past its cap, unless it replaces an undelivered one). */
export async function makeCode(
  store: Store,
  c: Campaign,
  note: string | null,
  iso: string,
  replacing = false,
  redeemBy: string | null = null,
): Promise<{ id: string; code: string } | { error: string }> {
  if (!c.active && !replacing) return { error: "That campaign is switched off." };
  if (!replacing && c.cap !== null && (await store.given(c.id)) >= c.cap)
    return { error: `That campaign has given all ${c.cap} of its codes.` };
  const code = newCode();
  const id = crypto.randomUUID();
  await store.putCode({
    id,
    hash: await codeHash(code),
    features: [...PREMIUM_FEATURES],
    maxUses: 1,
    days: c.months ? Math.round(c.months * 30.44) : null,
    redeemBy,
    label: c.months ? `Premium, ${c.months} months` : "Founder",
    active: true,
    campaignId: c.id,
    note,
    hint: code.slice(5, 10),
    createdAt: iso,
  });
  return { id, code };
}

/** Every route under /codes. */
export async function owner(
  req: Request,
  env: Env,
  store: Store,
  path: string,
  now: () => number,
  fetchImpl: typeof fetch,
  extras: Extras = {},
): Promise<Response> {
  const t = now();
  const url = new URL(req.url);
  // One home for the page: on any other address (licence.dragonsoath.com), go there.
  const site = env.SITE_ORIGIN || url.origin;
  if (url.origin !== site && req.method === "GET")
    return new Response(null, { status: 302, headers: { location: `${site}${path}` } });
  if (url.origin !== site) return refuse(404, "Not found.");
  if (
    !env.GITHUB_CLIENT_ID ||
    !env.GITHUB_CLIENT_SECRET ||
    !env.SESSION_KEY ||
    !env.OWNER_GITHUB_ID
  )
    return page(
      "The code site isn't set up yet: it needs its GitHub sign-in (see the service's README).",
    );

  // The sponsor claim page: the one public part (claim.ts).
  const claim = claimRoute(req, env, path, site);
  if (claim) return claim;

  if (req.method === "GET" && path === "/codes/login") {
    const state = b64u(crypto.getRandomValues(new Uint8Array(24)));
    const to = new URL("https://github.com/login/oauth/authorize");
    to.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    to.searchParams.set("redirect_uri", `${site}/codes/callback`);
    to.searchParams.set("state", state);
    to.searchParams.set("allow_signup", "false");
    return new Response(null, {
      status: 302,
      headers: { location: to.toString(), "set-cookie": setCookie(STATE_COOKIE, state, 600) },
    });
  }

  if (req.method === "GET" && path === "/codes/callback") {
    const state = url.searchParams.get("state") ?? "";
    if (state.startsWith(CLAIM_STATE))
      return claimCallback(req, env, store, site, t, fetchImpl, extras.premiumEmber);
    const code = url.searchParams.get("code") ?? "";
    const expected = cookie(req, STATE_COOKIE) ?? "";
    if (!code || !state || !expected || !same(state, expected))
      return page("That sign-in didn't come from this page. Start again.", 400);
    let uid: string | undefined;
    try {
      const tok = (await (
        await fetchImpl("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${site}/codes/callback`,
          }),
        })
      ).json()) as { access_token?: string };
      if (tok.access_token) {
        const user = (await (
          await fetchImpl("https://api.github.com/user", {
            headers: {
              authorization: `Bearer ${tok.access_token}`,
              accept: "application/vnd.github+json",
              "user-agent": "hearth-licence",
            },
          })
        ).json()) as { id?: number };
        if (typeof user.id === "number") uid = String(user.id);
      }
    } catch {
      return page("GitHub couldn't be reached. Try again in a minute.", 502);
    }
    // Anyone else who signs in sees the same as a stranger: nothing.
    if (uid !== env.OWNER_GITHUB_ID) return page("This page is private.", 403);
    const exp = String(t + SESSION_HOURS * 3_600_000);
    const value = `${uid}.${exp}.${await hmac(env.SESSION_KEY, `${uid}.${exp}`)}`;
    const headers = new Headers({ location: "/codes", "cache-control": "no-store" });
    headers.append("set-cookie", setCookie(COOKIE, value, SESSION_HOURS * 3600));
    headers.append("set-cookie", setCookie(STATE_COOKIE, "", 0));
    return new Response(null, { status: 302, headers });
  }

  const ok = await signedIn(req, env, t);

  if (req.method === "GET" && path === "/codes") {
    return ok ? page(null) : page("", 200, true);
  }

  if (!path.startsWith("/codes/api/")) return refuse(404, "Not found.");
  if (!ok) return refuse(401, "Sign in again.");
  if (req.method === "POST") {
    // Only this page may change things: a custom header (other sites can't send it without
    // asking first, and nothing here allows them), and the same origin when the browser says.
    const origin = req.headers.get("origin");
    if (req.headers.get("x-hearth-owner") !== "1" || (origin && origin !== url.origin))
      return refuse(403, "Not from this page.");
  }
  const body = async (): Promise<Record<string, unknown>> => {
    const text = await req.text();
    if (text.length > 4096) throw new Error("big");
    return JSON.parse(text || "{}") as Record<string, unknown>;
  };
  const iso = new Date(t).toISOString();
  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

  try {
    if (req.method === "POST" && path === "/codes/api/logout")
      return json(200, { ok: true }, { "set-cookie": setCookie(COOKIE, "", 0) });

    if (req.method === "GET" && path === "/codes/api/state") {
      const [campaigns, codes, redemptions, revoked, grants] = await Promise.all([
        store.campaigns(),
        store.codes(),
        store.redemptions(),
        store.revoked(),
        store.grants(),
      ]);
      const gone = new Set(revoked);
      const byCode = new Map(redemptions.map((r) => [r.codeId, r]));
      const names = new Map(campaigns.map((c) => [c.id, c.name]));
      const list = codes
        .filter((c) => c.campaignId)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        .slice(0, 500)
        .map((c) => {
          const r = byCode.get(c.id);
          return {
            id: c.id,
            hint: c.hint,
            note: c.note,
            campaign: names.get(c.campaignId!) ?? "",
            createdAt: c.createdAt,
            redeemedAt: r?.at ?? null,
            status: r
              ? gone.has(r.licenceId)
                ? "taken back"
                : "redeemed"
              : c.active
                ? "waiting"
                : "switched off",
          };
        });
      return json(200, {
        campaigns: campaigns.map((c) => {
          const mine = codes.filter((x) => x.campaignId === c.id);
          return {
            ...c,
            given: mine.length,
            redeemed: mine.filter((x) => byCode.has(x.id)).length,
          };
        }),
        codes: list,
        grants: grants.map((g) => ({ ...g, takenBack: gone.has(g.licenceId) })),
      });
    }

    if (req.method === "POST" && path === "/codes/api/campaign") {
      const b = await body();
      const name = str(b.name, 60);
      const months =
        b.months === null || b.months === undefined ? null : Math.floor(Number(b.months));
      const cap =
        b.cap === null || b.cap === undefined || b.cap === "" ? null : Math.floor(Number(b.cap));
      if (!name) return refuse(400, "Give the campaign a name.");
      if (months !== null && !(months >= 1 && months <= 120))
        return refuse(400, "Months: 1 to 120, or Founder.");
      if (cap !== null && !(cap >= 1 && cap <= 10_000))
        return refuse(400, "Cap: 1 to 10,000, or none.");
      const c: Campaign = {
        id: crypto.randomUUID(),
        name,
        months,
        cap,
        gift: true,
        createdAt: iso,
        active: true,
      };
      await store.putCampaign(c);
      return json(200, c);
    }

    if (req.method === "POST" && path === "/codes/api/campaign-active") {
      const b = await body();
      const c = typeof b.id === "string" ? await store.campaign(b.id) : null;
      if (!c || typeof b.active !== "boolean") return refuse(404, "Which campaign?");
      await store.putCampaign({ ...c, active: b.active });
      return json(200, { ok: true });
    }

    if (req.method === "POST" && path === "/codes/api/give") {
      const b = await body();
      const c = typeof b.campaignId === "string" ? await store.campaign(b.campaignId) : null;
      if (!c) return refuse(404, "Pick a campaign.");
      const made = await makeCode(store, c, str(b.note, 80), iso);
      if ("error" in made) return refuse(409, made.error);
      return json(200, { ...made, message: giftMessage(made.code, c.months) });
    }

    // Send with Ember (11-19): Ember Bot DMs the code just made, with Premium Ember, to a Discord
    // name in the Hearth Discord server. Only a code that is on and not yet used; nothing is sent on any doubt.
    if (req.method === "POST" && path === "/codes/api/send") {
      const b = await body();
      const to = str(b.to, 80);
      const code = str(b.code, 64);
      if (!to) return refuse(400, "Type their Discord name.");
      const c = code ? await store.codeByHash(await codeHash(code)) : null;
      if (!c || !c.active || c.uses >= c.maxUses)
        return refuse(409, "That code isn't waiting to be given.");
      if (!extras.ember) return refuse(503, "Ember Bot isn't connected here. Use Copy message.");
      const camp = c.campaignId ? await store.campaign(c.campaignId) : null;
      const months = camp ? camp.months : c.days ? Math.round(c.days / 30.44) : null;
      try {
        const r = await extras.ember.sendCode({
          to,
          code: code!,
          months,
          picture: (await extras.premiumEmber?.()) ?? null,
        });
        if (r.status === "sent" && !c.note)
          await store.setNote(c.id, `Discord ${r.name}`.slice(0, 80));
        return json(200, r);
      } catch {
        return refuse(
          502,
          "Ember Bot couldn't reach Discord. Nothing was sent; try again, or use Copy message.",
        );
      }
    }

    // The Founder offer (Ember Bot counts posts in #around-the-fire; the owner approves here).
    const founder = extras.founder;
    if (path.startsWith("/codes/api/founder")) {
      if (!founder) return refuse(503, "The Founder offer isn't connected here.");
      const offer = await founder.offer();
      const cap = async () => (offer ? await store.campaign(offer.campaignId) : null)?.cap ?? 25;

      if (req.method === "POST" && path === "/codes/api/founder-start") {
        const b = await body();
        const c = typeof b.campaignId === "string" ? await store.campaign(b.campaignId) : null;
        if (!c || c.months !== null || c.cap === null)
          return refuse(400, "Pick a Founder campaign with a number of codes (for example 25).");
        const forumId = b.where === "test" ? env.TEST_FORUM_ID : env.FORUM_ID;
        if (!forumId) return refuse(409, "That channel isn't set up yet.");
        if (offer?.active) return refuse(409, "An offer is already running. Stop it first.");
        await founder.putOffer({
          campaignId: c.id,
          forumId,
          startsAt: iso,
          minAgeDays: 7,
          pinnedThreadId: threadOf(b.pinned),
          statusMessageId: null,
          statusLine: null,
          active: true,
          // A code holds its spot 7 days; in #founder-test a short time, so expiry can be tried.
          holdMinutes: b.where === "test" ? TEST_HOLD_MINUTES : HOLD_MINUTES,
          claimsAnnounced: 0,
          introPosted: false,
          endedAt: null,
        });
        return json(200, { ok: true });
      }
      if (!offer) return refuse(409, "No Founder offer yet.");

      if (req.method === "POST" && path === "/codes/api/founder-active") {
        const b = await body();
        if (typeof b.active !== "boolean") return refuse(400, "On or off?");
        // Stopped: Ember answers new entries for 7 days that it has ended. Resumed: back on.
        await founder.putOffer({ ...offer, active: b.active, endedAt: b.active ? null : iso });
        return json(200, { ok: true });
      }
      if (req.method === "POST" && path === "/codes/api/founder-pinned") {
        const b = await body();
        const thread = threadOf(b.pinned);
        if (b.pinned && !thread)
          return refuse(400, "Paste the link to the pinned post (Copy Link in Discord).");
        await founder.putOffer({
          ...offer,
          pinnedThreadId: thread,
          statusMessageId: null,
          statusLine: null,
        });
        return json(200, { ok: true });
      }

      const b = req.method === "POST" ? await body() : {};
      const e = typeof b.postId === "string" ? await founder.entry(b.postId) : null;

      // Reject, with his reason: Ember tells them (DM, or their post when DMs are closed) before it
      // counts as done, so nobody is turned away silently. They may post again later.
      if (req.method === "POST" && path === "/codes/api/founder-reject") {
        const used = async (id: string) => ((await store.codeById(id))?.uses ?? 0) > 0;
        const st = await standing(await founder.entries(), used, t);
        const expired = e ? st.of.get(e.postId) === "expired" : false;
        if (!e || (e.status !== "waiting" && e.status !== "dm-closed" && !expired))
          return refuse(409, "That post isn't waiting.");
        const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 300) : "";
        if (!reason) return refuse(400, "Pick or type the reason Ember sends them.");
        if (!extras.ember) return refuse(503, "Ember Bot isn't connected here.");
        const denial = { why: "rejected" as const, reason };
        let via: "dm" | "thread";
        try {
          via = (await extras.ember.tellFounder({ userId: e.userId, postId: e.postId, denial }))
            .via;
        } catch {
          return refuse(502, "Ember Bot couldn't reach them. Nothing changed; try again.");
        }
        if (e.codeId) await store.setActive(e.codeId, false);
        await founder.putEntry({
          ...e,
          status: "skipped",
          decidedAt: iso,
          reason: JSON.stringify(denial),
          toldAt: iso,
        });
        return json(200, { via });
      }

      // Approve (Try again after they opened their DMs, or Send again after a code expired): a new
      // one-use code, sent by Ember, holding the spot for the offer's hold time. Never more than the
      // cap live at once (redeemed, plus sent and still held); waiting posts hold nothing.
      if (req.method === "POST" && path === "/codes/api/founder-approve") {
        const used = async (id: string) => ((await store.codeById(id))?.uses ?? 0) > 0;
        const st = await standing(await founder.entries(), used, t);
        const expired = e ? st.of.get(e.postId) === "expired" : false;
        if (!e || (e.status !== "waiting" && e.status !== "dm-closed" && !expired))
          return refuse(409, "That post isn't waiting.");
        if (!extras.ember) return refuse(503, "Ember Bot isn't connected here.");
        const c = await store.campaign(offer.campaignId);
        if (!c) return refuse(409, "The offer's campaign is gone.");
        const max = c.cap ?? 25;
        if (st.claimed + st.held >= max)
          return refuse(
            409,
            `All ${max} spots are claimed or held right now. Approve again when a held code is redeemed or expires.`,
          );
        // A code that couldn't be delivered, or expired, is switched off; it isn't a new spot.
        if (e.codeId) await store.setActive(e.codeId, false);
        const heldUntil = new Date(t + offer.holdMinutes * 60_000).toISOString();
        // The offer keeps its own count (codes live at once), so the campaign's cap doesn't apply.
        const made = await makeCode(store, c, e.userName, iso, true, heldUntil);
        if ("error" in made) return refuse(409, made.error);
        let sent = false;
        try {
          sent = (
            await extras.ember.sendFounderCode({
              userId: e.userId,
              postId: e.postId,
              code: made.code,
              hold: holdWords(offer.holdMinutes),
              picture: (await extras.premiumEmber?.()) ?? null,
            })
          ).sent;
        } catch {
          await store.setActive(made.id, false);
          return refuse(502, "Ember Bot couldn't be reached. Nothing was sent; try again.");
        }
        if (!sent) await store.setActive(made.id, false);
        await founder.putEntry({
          ...e,
          status: sent ? "sent" : "dm-closed",
          codeId: made.id,
          decidedAt: iso,
          heldUntil: sent ? heldUntil : null,
        });
        return json(200, { sent });
      }

      if (req.method === "GET" && path === "/codes/api/founder") {
        const entries = (await founder.entries()).sort((x, y) =>
          x.postedAt.localeCompare(y.postedAt),
        );
        const used = async (id: string) => ((await store.codeById(id))?.uses ?? 0) > 0;
        const st = await standing(entries, used, t);
        const max = await cap();
        return json(200, {
          offer: { ...offer, where: offer.forumId === env.TEST_FORUM_ID ? "test" : "live" },
          cap: max,
          claimed: st.claimed,
          held: st.held,
          hold: holdWords(offer.holdMinutes),
          line: statusLine(st.claimed, max),
          entries: entries.map((x: Entry) => ({
            ...x,
            standing: st.of.get(x.postId) ?? null,
            link: env.GUILD_ID ? `https://discord.com/channels/${env.GUILD_ID}/${x.postId}` : null,
          })),
        });
      }
    }

    if (req.method === "POST" && path === "/codes/api/note") {
      const b = await body();
      if (typeof b.id !== "string" || !(await store.setNote(b.id, str(b.note, 80))))
        return refuse(404, "Which code?");
      return json(200, { ok: true });
    }

    if (req.method === "POST" && path === "/codes/api/code-active") {
      const b = await body();
      if (typeof b.id !== "string" || typeof b.active !== "boolean")
        return refuse(400, "Which code?");
      if (!(await store.setActive(b.id, b.active))) return refuse(404, "Which code?");
      return json(200, { ok: true });
    }

    // Takes Premium back from whoever redeemed a code (every Hearth learns within hours), or
    // gives it back.
    if (req.method === "POST" && path === "/codes/api/take-back") {
      const b = await body();
      if (typeof b.id !== "string") return refuse(400, "Which code?");
      const ids = await store.licencesOf(b.id);
      if (!ids.length)
        return refuse(409, "Nobody has redeemed that code yet. Switch it off instead.");
      if (b.undo === true) for (const l of ids) await store.unrevoke(l);
      else await store.revoke(ids, iso);
      return json(200, { ok: true });
    }

    // A licence key for one of the owner's own installations, for good.
    if (req.method === "POST" && path === "/codes/api/licence") {
      const b = await body();
      const install = typeof b.install === "string" ? b.install.trim() : "";
      if (!ID.test(install))
        return refuse(
          400,
          "Paste the installation's ID (Settings, Premium, This installation's ID).",
        );
      const licenceId = crypto.randomUUID();
      const label = str(b.label, 60);
      const licence = await signLicence(
        {
          id: licenceId,
          install,
          features: [...PREMIUM_FEATURES],
          kind: "complimentary",
          start: iso,
          issued: iso,
          ...(label ? { label } : {}),
        },
        env.SIGNING_KEY,
      );
      await store.putGrant({ licenceId, install, label, at: iso });
      return json(200, { licence, licenceId });
    }

    if (req.method === "POST" && path === "/codes/api/grant") {
      const b = await body();
      if (typeof b.licenceId !== "string" || !ID.test(b.licenceId))
        return refuse(400, "Which licence?");
      if (b.takeBack === false) await store.unrevoke(b.licenceId);
      else await store.revoke([b.licenceId], iso);
      return json(200, { ok: true });
    }
  } catch {
    return refuse(400, "That request isn't readable.");
  }
  return refuse(404, "Not found.");
}

/** The page: a sign-in button, or the code tools. Everything shown is set as text, never HTML. */
function page(message: string | null, status = 200, signIn = false): Response {
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const body =
    message !== null
      ? `<main class="narrow"><h1>Hearth codes</h1>${message ? `<p>${message}</p>` : ""}${
          signIn ? `<a class="btn primary" href="/codes/login">Sign in with GitHub</a>` : ""
        }</main>`
      : APP;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Hearth codes</title><style nonce="${nonce}">${CSS}</style></head><body>${body}${
      message === null ? `<script nonce="${nonce}">${SCRIPT}</script>` : ""
    }</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

export const CSS = `
:root{color-scheme:dark;--bg:#14100d;--panel:#1d1713;--raised:#271f19;--line:#3a2e25;--ink:#f3e9df;--muted:#b9a797;--faint:#8a7867;--gold:#e8a248;--ok:#7fc58a;--bad:#e58a7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:20px 16px 60px}.narrow{max-width:420px;text-align:center;padding-top:15vh}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 10px;color:var(--gold)}p{color:var(--muted);margin:6px 0 14px}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin:14px 0}
label{display:block;font-size:.85rem;color:var(--muted);margin:8px 0 4px}
input,select{width:100%;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit;min-height:44px}
input:focus,select:focus,button:focus-visible,a:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.row>*{flex:1 1 160px}
.btn,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:var(--raised);color:var(--ink);font:inherit;cursor:pointer;text-decoration:none}
.primary{background:var(--gold);border-color:var(--gold);color:#1a120b;font-weight:600}
.small{min-height:36px;padding:0 10px;font-size:.85rem}
.code{font:600 1.25rem/1.3 ui-monospace,Consolas,monospace;letter-spacing:.04em;word-break:break-all;background:var(--bg);border:1px dashed var(--gold);border-radius:10px;padding:12px;margin:8px 0}
textarea{width:100%;min-height:96px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit}
.list{display:flex;flex-direction:column;gap:8px}.item{border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.item .grow{flex:1 1 220px;min-width:0}.item b{color:var(--ink)}.meta{color:var(--faint);font-size:.82rem}
.tag{font-size:.78rem;border-radius:999px;padding:2px 9px;border:1px solid var(--line);color:var(--muted)}
.tag.redeemed{color:var(--ok);border-color:#3f6a46}.tag.waiting{color:var(--gold);border-color:#6d5128}.tag.off,.tag.back{color:var(--bad);border-color:#6d3a31}
.top{display:flex;justify-content:space-between;align-items:center;gap:10px}.err{color:var(--bad)}.hide{display:none}
.tight{flex:0 0 auto}.mt{margin-top:12px}.sub{font-size:.9rem;color:var(--muted);margin:16px 0 8px}.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.filters input{flex:1 1 200px}
`;

const APP = `<main>
<div class="top"><div><h1>Hearth codes</h1><p>Make Premium codes and hand them out. A code is shown once, when you make it.</p></div><button id="out">Sign out</button></div>
<p id="err" class="err" role="alert"></p>
<section aria-labelledby="give-h"><h2 id="give-h">Give a code</h2>
<div class="row"><div><label for="give-camp">Campaign</label><select id="give-camp"></select></div>
<div><label for="give-note">Who it's for (Discord name)</label><input id="give-note" maxlength="80" autocomplete="off" placeholder="name on Discord"></div>
<div class="tight"><button id="give" class="primary">Make code</button></div></div>
<div id="given" class="hide"><label>The code (copy it now; it isn't shown again)</label><div class="code" id="given-code"></div>
<label for="given-msg">Message to send them</label><textarea id="given-msg" readonly></textarea>
<div class="row mt"><div><label for="send-to">Their Discord name</label><input id="send-to" maxlength="80" autocomplete="off" placeholder="name on Discord"></div>
<div class="tight"><button id="send" class="primary">Send with Ember</button></div></div>
<p id="send-out" class="meta" role="status"></p>
<div class="row mt"><button id="copy-code">Copy code</button><button id="copy-msg">Copy message</button></div></div>
</section>
<section aria-labelledby="f-h" id="f-sec"><h2 id="f-h">Founder offer</h2>
<div id="f-none"><p>Ember Bot puts each post with a screenshot in #around-the-fire in line (one per Discord account, accounts at least 7 days old) and tells you in #founder-queue. You approve or reject each one here; on Approve, Ember DMs them Premium Ember and a Founder code that holds their spot for 7 days. A spot is claimed when the code is redeemed, and Ember counts down in #general. Starting posts the announcement. Try it on #founder-test first (codes hold 30 minutes there, and Ember's posts go in its pinned post).</p>
<div class="row"><div><label for="f-camp">Founder campaign</label><select id="f-camp"></select></div>
<div><label for="f-where">Where</label><select id="f-where"><option value="test">#founder-test (only you and Ember)</option><option value="live">#around-the-fire (everyone)</option></select></div></div>
<label for="f-pin">Pinned post link (Ember keeps "Founder spots claimed: 7 of 25" in it; needed for #founder-test)</label><input id="f-pin" autocomplete="off" placeholder="https://discord.com/channels/...">
<div class="row mt"><button id="f-start" class="primary tight">Start the offer</button></div></div>
<div id="f-run" class="hide"><div class="top"><div><b id="f-line"></b><div class="meta" id="f-meta"></div></div><button id="f-toggle" class="small"></button></div>
<div class="row mt"><div><label for="f-pin2">Pinned post link</label><input id="f-pin2" autocomplete="off" placeholder="https://discord.com/channels/..."></div><div class="tight"><button id="f-pin-save">Save</button></div></div>
<h3 class="sub">Waiting for you</h3><div class="list" id="f-wait"></div><p id="f-out" class="meta" role="status"></p>
<h3 class="sub">Done</h3><div class="list" id="f-done"></div></div>
</section>
<section aria-labelledby="camp-h"><h2 id="camp-h">Campaigns</h2>
<div class="list" id="camps"></div>
<div class="row mt"><div><label for="c-name">New campaign</label><input id="c-name" maxlength="60" placeholder="Around the Fire launch"></div>
<div><label for="c-kind">Gives</label><select id="c-kind"><option value="">Founder (for good)</option><option value="1">1 month</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option></select></div>
<div><label for="c-cap">How many codes (blank: no limit)</label><input id="c-cap" inputmode="numeric" placeholder="25"></div>
<div class="tight"><button id="c-add">Add campaign</button></div></div>
</section>
<section aria-labelledby="codes-h"><h2 id="codes-h">Codes given</h2>
<div class="filters"><input id="find" placeholder="Find a name or the first letters of a code" aria-label="Find a code"></div>
<div class="list" id="codes"></div></section>
<section aria-labelledby="own-h"><h2 id="own-h">Your own Hearths</h2>
<p>A licence key for one of your installations, for good. Its ID is in Settings, Premium, This installation's ID.</p>
<div class="row"><div><label for="g-id">Installation ID</label><input id="g-id" autocomplete="off"></div><div><label for="g-label">Name</label><input id="g-label" maxlength="60" placeholder="Home server"></div><div class="tight"><button id="g-add">Make licence key</button></div></div>
<div id="g-out" class="hide"><label>Licence key (paste it in that Hearth's Settings, Premium, Add a licence key)</label><div class="code" id="g-key"></div><button id="g-copy">Copy licence key</button></div>
<div class="list mt" id="grants"></div></section>
</main>`;

const SCRIPT = `
const $=(id)=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
const day=(s)=>s?new Date(s).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'';
let state={campaigns:[],codes:[],grants:[]};
async function api(path,body){$('err').textContent='';const r=await fetch('/codes/api/'+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-hearth-owner':'1'},body:JSON.stringify(body)});
 const j=await r.json().catch(()=>({}));if(r.status===401){location.href='/codes';throw new Error('signin')}if(!r.ok){$('err').textContent=j.error||'Something went wrong.';throw new Error(j.error)}return j}
const copy=async(t,b)=>{try{await navigator.clipboard.writeText(t);const o=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=o,1500)}catch{}};
function render(){
 const sel=$('give-camp');const keep=sel.value;sel.replaceChildren();
 const live=state.campaigns.filter(c=>c.active);
 if(!live.length){const o=el('option',null,'Add a campaign first');o.value='';sel.append(o)}
 for(const c of live){const left=c.cap==null?'':' ('+Math.max(0,c.cap-c.given)+' left)';const o=el('option',null,c.name+left);o.value=c.id;sel.append(o)}
 if(live.some(c=>c.id===keep))sel.value=keep;
 const camps=$('camps');camps.replaceChildren();
 if(!state.campaigns.length)camps.append(el('p',null,'No campaigns yet. Add one below, for example Around the Fire launch, Founder, 25 codes.'));
 for(const c of state.campaigns){const it=el('div','item');const g=el('div','grow');g.append(el('b',null,c.name));
  g.append(el('div','meta',(c.months?c.months+' months':'Founder')+' · given '+c.given+(c.cap!=null?' of '+c.cap:'')+' · redeemed '+c.redeemed+(c.active?'':' · switched off')));
  const b=el('button','small',c.active?'Switch off':'Switch on');b.onclick=async()=>{await api('campaign-active',{id:c.id,active:!c.active});load()};it.append(g,b);camps.append(it)}
 const q=$('find').value.trim().toLowerCase();const list=$('codes');list.replaceChildren();
 const shown=state.codes.filter(c=>!q||(c.note||'').toLowerCase().includes(q)||(c.hint||'').toLowerCase().includes(q.replace(/^hrth-?/,'')));
 if(!shown.length)list.append(el('p',null,state.codes.length?'No code matches.':'No codes given yet.'));
 for(const c of shown){const it=el('div','item');const g=el('div','grow');
  const top=el('div');top.append(el('b',null,c.note||'(no name)'),document.createTextNode(' '));
  const cls={redeemed:'redeemed',waiting:'waiting','switched off':'off','taken back':'back'}[c.status];top.append(el('span','tag '+cls,c.status));g.append(top);
  g.append(el('div','meta','HRTH-'+c.hint+'… · '+c.campaign+' · given '+day(c.createdAt)+(c.redeemedAt?' · redeemed '+day(c.redeemedAt):'')));
  const name=el('button','small','Name');name.onclick=async()=>{const n=prompt('Discord name for this code',c.note||'');if(n===null)return;await api('note',{id:c.id,note:n});load()};
  it.append(g,name);
  if(c.status==='waiting'){const b=el('button','small','Switch off');b.onclick=async()=>{await api('code-active',{id:c.id,active:false});load()};it.append(b)}
  if(c.status==='switched off'){const b=el('button','small','Switch on');b.onclick=async()=>{await api('code-active',{id:c.id,active:true});load()};it.append(b)}
  if(c.status==='redeemed'){const b=el('button','small','Take Premium back');b.onclick=async()=>{if(!confirm('Take Premium back from '+(c.note||'this person')+'? Their Hearth stops Premium the next time it reaches the licence service (when a code is entered there). You can give it back later.'))return;await api('take-back',{id:c.id});load()};it.append(b)}
  if(c.status==='taken back'){const b=el('button','small','Give it back');b.onclick=async()=>{await api('take-back',{id:c.id,undo:true});load()};it.append(b)}
  list.append(it)}
 const gr=$('grants');gr.replaceChildren();
 for(const g of state.grants){const it=el('div','item');const d=el('div','grow');d.append(el('b',null,g.label||'(no name)'));d.append(el('div','meta',g.install.slice(0,8)+'… · made '+day(g.at)+(g.takenBack?' · taken back':'')));
  const b=el('button','small',g.takenBack?'Give it back':'Take back');b.onclick=async()=>{if(!g.takenBack&&!confirm('Take Premium back from '+(g.label||'this Hearth')+'?'))return;await api('grant',{licenceId:g.licenceId,takeBack:!g.takenBack});load()};it.append(d,b);gr.append(it)}
}
let fstate=null;
async function loadFounder(){const r=await fetch('/codes/api/founder');const j=await r.json().catch(()=>({}));fstate=r.ok?j:null;renderFounder()}
function renderFounder(){
 const fc=$('f-camp');fc.replaceChildren();
 const founders=state.campaigns.filter(c=>c.active&&c.months==null&&c.cap!=null);
 if(!founders.length){const o=el('option',null,'Add a Founder campaign with a number of codes first');o.value='';fc.append(o)}
 for(const c of founders){const o=el('option',null,c.name+' ('+c.cap+' spots)');o.value=c.id;fc.append(o)}
 const f=fstate;$('f-none').classList.toggle('hide',!!(f&&f.offer.active));$('f-run').classList.toggle('hide',!f);
 if(f&&!f.offer.active)$('f-none').classList.remove('hide');
 if(!f)return;
 $('f-line').textContent=f.line;
 $('f-meta').textContent=(f.offer.where==='test'?'Watching #founder-test':'Watching #around-the-fire')+' since '+day(f.offer.startsAt)+' · '+f.held+' held (codes hold '+f.hold+')'+(f.offer.active?'':(f.claimed>=f.cap?' · all claimed, closed':' · stopped'));
 $('f-toggle').textContent=f.offer.active?'Stop the offer':'Resume';
 $('f-toggle').onclick=async()=>{if(f.offer.active&&!confirm('Stop putting new posts in line? Posts already in line stay in the queue.'))return;await api('founder-active',{active:!f.offer.active});loadFounder()};
 if(document.activeElement!==$('f-pin2'))$('f-pin2').value=f.offer.pinnedThreadId?'(set)':'';
 const w=$('f-wait'),d=$('f-done');w.replaceChildren();d.replaceChildren();
 const full=f.claimed+f.held>=f.cap;
 const waiting=f.entries.filter(e=>e.status==='waiting'||e.status==='dm-closed'||e.standing==='expired');
 if(!waiting.length)w.append(el('p',null,'Nothing waiting.'));
 for(const e of waiting){const it=el('div','item');const g=el('div','grow');
  const top=el('div');top.append(el('b',null,'#'+e.number+' '+e.userName));if(e.status==='dm-closed'||e.standing==='expired'){top.append(document.createTextNode(' '));top.append(el('span','tag off',e.standing==='expired'?'code expired':'DMs closed'))}g.append(top);
  g.append(el('div','meta','posted '+day(e.postedAt)+(e.standing==='expired'?' · not redeemed in time; the spot came back':e.status==='dm-closed'?' · Ember asked them to open DMs':'')));
  it.append(g);
  if(e.link){const a=el('a','btn small','Open post');a.href=e.link;a.target='_blank';a.rel='noopener';it.append(a)}
  const ok=el('button','small primary',e.standing==='expired'?'Send again':e.status==='dm-closed'?'Try again':'Approve');ok.disabled=full;if(full)ok.title='All spots are claimed or held right now';ok.onclick=async()=>{ok.disabled=true;try{const r=await api('founder-approve',{postId:e.postId});if(!r.sent)$('err').textContent=e.userName+"'s DMs are closed. Ember asked them in their post to open DMs; tap Try again after.";}finally{loadFounder();load()}};it.append(ok);
  const rj=el('button','small','Reject');rj.onclick=()=>rejectForm(e,it,rj);it.append(rj);
  w.append(it)}
 const done=f.entries.filter(e=>(e.status==='sent'&&e.standing!=='expired')||e.status==='skipped'||e.status==='late'||e.status==='denied');
 if(!done.length)d.append(el('p',null,'Nothing yet.'));
 for(const e of done.slice().reverse()){const it=el('div','item');const g=el('div','grow');const top=el('div');
  top.append(el('b',null,(e.number?'#'+e.number+' ':'')+e.userName),document.createTextNode(' '));
  const k=e.standing||e.status;
  top.append(el('span','tag '+({redeemed:'redeemed',held:'waiting',skipped:'off',late:'waiting',denied:'off'}[k]),{redeemed:'claimed',held:'code sent, holding the spot',skipped:'rejected',late:'the spots ran out',denied:'turned away'}[k]));
  g.append(top);g.append(el('div','meta','posted '+day(e.postedAt)+(k==='held'&&e.heldUntil?' · holds until '+new Date(e.heldUntil).toLocaleString():'')+(e.reason?' · '+why(JSON.parse(e.reason))+(e.toldAt?' (told)':' (Ember tells them shortly)'):'')));it.append(g);
  if(e.link){const a=el('a','btn small','Open post');a.href=e.link;a.target='_blank';a.rel='noopener';it.append(a)}d.append(it)}
}
const REASONS=["The screenshot isn't of a Hearth Lair.","We can only accept one entry per person."];
function why(d){return{'too-new':'account under 7 days old','in-line':'already in line','has-code':'already has a code','founder':'already a Founder','dms-closed':'already in line, DMs were closed','expired':'their code had expired','full':'all spots gone','ended':'offer had ended','no-image':'no screenshot yet','rejected':'you rejected it: '+(d.reason||'')}[d.why]||d.why}
function rejectForm(e,it,btn){btn.disabled=true;const box=el('div','row mt reject-box');const s=el('select');for(const r of REASONS){const o=el('option',null,r);o.value=r;s.append(o)}const other=el('option',null,'Type my own reason...');other.value='';s.append(other);
 s.setAttribute('aria-label','Reason for '+e.userName);const t=el('input');t.maxLength=300;t.placeholder='Your reason, sent to them as written';t.setAttribute('aria-label','Your reason');t.classList.add('hide');s.onchange=()=>t.classList.toggle('hide',s.value!=='');
 const go=el('button','small primary','Reject and tell them');const no=el('button','small','Cancel');no.onclick=()=>{box.remove();btn.disabled=false};
 go.onclick=async()=>{const reason=s.value||t.value.trim();if(!reason){t.focus();return}go.disabled=true;const out=$('f-out');out.textContent='Ember is telling '+e.userName+'...';
  try{const r=await api('founder-reject',{postId:e.postId,reason});out.textContent=r.via==='dm'?'Rejected. Ember DMed '+e.userName+' your reason.':'Rejected. '+e.userName+"'s DMs are closed, so Ember replied in their post asking them to open DMs and post again."}catch(x){out.textContent='Not rejected: '+(x.message||'Ember Bot had a problem')+'.';go.disabled=false;return}
  loadFounder()};
 box.append(s,t,go,no);it.after(box)}
async function load(){state=await api('state');render();renderFounder()}
$('f-start').onclick=async()=>{const id=$('f-camp').value;if(!id){$('err').textContent='Add a Founder campaign with a number of codes first.';return}
 const where=$('f-where').value;if(where==='live'&&!confirm('Start the Founder offer in #around-the-fire, for everyone?'))return;
 await api('founder-start',{campaignId:id,where,pinned:$('f-pin').value});loadFounder()};
$('f-pin-save').onclick=async()=>{const v=$('f-pin2').value;if(v==='(set)')return;await api('founder-pinned',{pinned:v});loadFounder()};
// Not while he's writing a rejection: the refresh would clear it.
setInterval(()=>{if(!document.hidden&&!document.querySelector('.reject-box'))loadFounder()},30000);
$('give').onclick=async()=>{const id=$('give-camp').value;if(!id){$('err').textContent='Add a campaign first.';return}
 const r=await api('give',{campaignId:id,note:$('give-note').value});$('given-code').textContent=r.code;$('given-msg').value=r.message;$('send-to').value=$('give-note').value;$('send-out').textContent='';$('send').disabled=false;$('given').classList.remove('hide');$('give-note').value='';load()};
$('send').onclick=async()=>{const to=$('send-to').value.trim();const out=$('send-out');if(!to){out.textContent='Type their Discord name first.';return}
 const b=$('send');b.disabled=true;out.textContent='Ember is on her way...';let r;try{r=await api('send',{code:$('given-code').textContent,to})}catch(e){out.textContent='Not sent. Use Copy message instead.';b.disabled=false;return}
 if(r.status==='sent'){out.textContent='Sent! Ember DMed '+r.name+' the code with Premium Ember.';load();return}
 b.disabled=false;
 if(r.status==='not-found')out.textContent='Not sent: nobody called "'+to+'" is in the Hearth Discord server. Check the name, or use Copy message.';
 else if(r.status==='ambiguous')out.textContent='Not sent: more than one person matches. Type one exactly: '+r.names.join(', ')+'. Or use Copy message.';
 else if(r.status==='dm-closed')out.textContent='Not sent: '+r.name+' has DMs closed for this server. Use Copy message, or ask them to open DMs and send again.';
 else out.textContent='Not sent. Use Copy message instead.'};
$('copy-code').onclick=(e)=>copy($('given-code').textContent,e.target);
$('copy-msg').onclick=(e)=>copy($('given-msg').value,e.target);
$('c-add').onclick=async()=>{const k=$('c-kind').value;const cap=$('c-cap').value.trim();await api('campaign',{name:$('c-name').value,months:k?Number(k):null,cap:cap?Number(cap):null});$('c-name').value='';$('c-cap').value='';load()};
$('g-add').onclick=async()=>{const r=await api('licence',{install:$('g-id').value,label:$('g-label').value});$('g-key').textContent=r.licence;$('g-out').classList.remove('hide');$('g-id').value='';load()};
$('g-copy').onclick=(e)=>copy($('g-key').textContent,e.target);
$('find').oninput=render;
$('out').onclick=async()=>{await api('logout',{});location.href='/codes'};
load().then(loadFounder);
`;
