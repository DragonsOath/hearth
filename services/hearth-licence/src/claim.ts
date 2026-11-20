import { b64u, type Campaign, type Env, type Picture, type Store } from "./licence";
import { CSS, makeCode } from "./owner";

/**
 * The sponsor claim page (11-19), at hearth.dragonsoath.com/codes/claim: the one public part of
 * the code site. A sponsor signs in with GitHub; the service asks GitHub, as that person, which
 * sponsorships they have to Dragon's Oath, and shows a one-use code right there:
 *
 * - Founder: a one-time sponsorship of at least the Founder price. Once per GitHub account.
 * - Supporter: an active monthly sponsorship. One month of Premium, claimed again each month
 *   while they sponsor (28 days after the last claim).
 *
 * The person's GitHub token is used for that one question and never kept. The codes go into two
 * campaigns the owner sees on his page, each noted with the GitHub account that claimed it.
 * GitHub allows one callback per sign-in app, so this shares /codes/callback with the owner's
 * page; its sign-in state starts with "c." so the callback knows which one it is.
 */

export const CLAIM_STATE = "c.";
const STATE_COOKIE = "__Host-hearth-claim";
const SPONSORABLE = "DragonsOath";
const FOUNDER_ID = "sponsor-founder";
const SUPPORTER_ID = "sponsor-supporter";
const SUPPORTER_MIN_USD = 5;
const DAY = 86_400_000;
/** A Supporter can claim again this long after their last claim (a month of Premium each time). */
const AGAIN_AFTER_DAYS = 28;

interface Sponsorship {
  isActive?: boolean;
  isOneTimePayment?: boolean;
  sponsorable?: { login?: string };
  tier?: { monthlyPriceInDollars?: number; isOneTime?: boolean };
}

/** What a set of sponsorships to Dragon's Oath earns: Founder beats Supporter. */
export function earned(list: Sponsorship[], founderMin: number): "founder" | "supporter" | null {
  const ours = list.filter(
    (s) => (s.sponsorable?.login ?? "").toLowerCase() === SPONSORABLE.toLowerCase(),
  );
  const price = (s: Sponsorship) => s.tier?.monthlyPriceInDollars ?? 0;
  const once = (s: Sponsorship) => Boolean(s.isOneTimePayment || s.tier?.isOneTime);
  if (ours.some((s) => once(s) && price(s) >= founderMin)) return "founder";
  if (ours.some((s) => !once(s) && s.isActive !== false && price(s) >= SUPPORTER_MIN_USD))
    return "supporter";
  return null;
}

const CAMPAIGNS: Record<"founder" | "supporter", Omit<Campaign, "createdAt">> = {
  founder: {
    id: FOUNDER_ID,
    name: "GitHub Sponsors: Founder",
    months: null,
    cap: null,
    gift: false,
    active: true,
  },
  supporter: {
    id: SUPPORTER_ID,
    name: "GitHub Sponsors: Supporter",
    months: 1,
    cap: null,
    gift: false,
    active: true,
  },
};

async function campaignFor(store: Store, kind: "founder" | "supporter", iso: string) {
  const have = await store.campaign(CAMPAIGNS[kind].id);
  if (have) return have;
  const c = { ...CAMPAIGNS[kind], createdAt: iso };
  await store.putCampaign(c);
  return c;
}

const setCookie = (value: string, maxAge: number) =>
  `${STATE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function cookie(req: Request): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === STATE_COOKIE) return part.slice(i + 1);
  }
  return undefined;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** GET /codes/claim and /codes/claim/login. */
export function claimRoute(req: Request, env: Env, path: string, site: string): Response | null {
  if (req.method !== "GET") return null;
  if (path === "/codes/claim") return claimPage({ kind: "start" });
  if (path === "/codes/claim/login") {
    const state = CLAIM_STATE + b64u(crypto.getRandomValues(new Uint8Array(24)));
    const to = new URL("https://github.com/login/oauth/authorize");
    to.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    to.searchParams.set("redirect_uri", `${site}/codes/callback`);
    to.searchParams.set("state", state);
    // Sponsorships a person made are only readable with read:user.
    to.searchParams.set("scope", "read:user");
    return new Response(null, {
      status: 302,
      headers: { location: to.toString(), "set-cookie": setCookie(state, 600) },
    });
  }
  return null;
}

/** The GitHub round trip came back with a claim's state. */
export async function claimCallback(
  req: Request,
  env: Env,
  store: Store,
  site: string,
  t: number,
  fetchImpl: typeof fetch,
  premiumEmber?: () => Promise<Picture | null>,
): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const expected = cookie(req) ?? "";
  const clear = { "set-cookie": setCookie("", 0) };
  if (!code || !state || state !== expected)
    return claimPage(
      { kind: "error", text: "That sign-in didn't come from this page. Start again." },
      400,
      clear,
    );

  let login: string;
  let uid: string;
  let list: Sponsorship[];
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
    if (!tok.access_token)
      return claimPage(
        { kind: "error", text: "GitHub didn't sign you in. Start again." },
        400,
        clear,
      );
    const r = (await (
      await fetchImpl("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok.access_token}`,
          "content-type": "application/json",
          "user-agent": "hearth-licence",
        },
        body: JSON.stringify({
          query:
            "query{viewer{databaseId login sponsorshipsAsSponsor(first:100,activeOnly:false){nodes{isActive isOneTimePayment sponsorable{...on Organization{login} ...on User{login}} tier{monthlyPriceInDollars isOneTime}}}}}",
        }),
      })
    ).json()) as {
      data?: {
        viewer?: {
          databaseId?: number;
          login?: string;
          sponsorshipsAsSponsor?: { nodes?: Sponsorship[] };
        };
      };
    };
    const v = r.data?.viewer;
    if (!v || typeof v.databaseId !== "number")
      return claimPage(
        { kind: "error", text: "GitHub didn't say who you are. Try again in a minute." },
        502,
        clear,
      );
    uid = String(v.databaseId);
    login = v.login ?? "";
    list = v.sponsorshipsAsSponsor?.nodes ?? [];
  } catch {
    return claimPage(
      { kind: "error", text: "GitHub couldn't be reached. Try again in a minute." },
      502,
      clear,
    );
  }

  const founderMin = Number(env.FOUNDER_MIN_USD) > 0 ? Number(env.FOUNDER_MIN_USD) : 60;
  const kind = earned(list, founderMin);
  if (!kind) return claimPage({ kind: "none", login }, 200, clear);

  const iso = new Date(t).toISOString();
  const campaign = await campaignFor(store, kind, iso);
  const tag = `(id ${uid})`;
  const mine = (await store.codes())
    .filter((c) => c.campaignId === campaign.id && (c.note ?? "").includes(tag))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  if (kind === "founder" && mine[0])
    return claimPage({ kind: "had", login, founder: true, hint: mine[0].hint ?? "" }, 200, clear);
  if (kind === "supporter" && mine[0]) {
    const next = Date.parse(mine[0].createdAt ?? "") + AGAIN_AFTER_DAYS * DAY;
    if (next > t)
      return claimPage(
        {
          kind: "had",
          login,
          founder: false,
          hint: mine[0].hint ?? "",
          next: new Date(next).toISOString().slice(0, 10),
        },
        200,
        clear,
      );
  }
  // The owner can pause claims by switching the campaign off on his page.
  const made = await makeCode(store, campaign, `GitHub @${login} ${tag}`.slice(0, 80), iso);
  if ("error" in made)
    return claimPage(
      {
        kind: "error",
        text: "Claims are paused for a moment. Try again later, or ask in the Hearth Discord server.",
      },
      503,
      clear,
    );
  // Premium Ember, the secret picture only code holders see, comes with the code (never before).
  const pic = await premiumEmber?.().catch(() => null);
  return claimPage(
    {
      kind: "code",
      login,
      founder: kind === "founder",
      code: made.code,
      ...(pic ? { picture: `data:${pic.type};base64,${b64(pic.data)}` } : {}),
    },
    200,
    clear,
  );
}

type View =
  | { kind: "start" }
  | { kind: "error"; text: string }
  | { kind: "none"; login: string }
  | { kind: "had"; login: string; founder: boolean; hint: string; next?: string }
  | { kind: "code"; login: string; founder: boolean; code: string; picture?: string };

/** Plain base64 (a data: address), in pieces so a big picture can't overflow the call stack. */
function b64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const PICTURE_TYPES = /^image\/(webp|png|jpeg|gif|avif)$/;

const SPONSORS = "https://github.com/sponsors/DragonsOath";
const HOW =
  "In Hearth, open Settings, Premium, and enter it under Redeem a code. It works once, on one Hearth.";

function claimPage(v: View, status = 200, headers: Record<string, string> = {}): Response {
  const signIn = `<a class="btn primary" href="/codes/claim/login">Sign in with GitHub</a>`;
  let body: string;
  if (v.kind === "start")
    body = `<p>Sponsor Dragon's Oath on GitHub, then sign in here with the same GitHub account to get your Hearth Premium code.</p>${signIn}<p class="meta">Hearth only asks GitHub which sponsorships you have. Nothing else is read or kept.</p>`;
  else if (v.kind === "error") body = `<p>${esc(v.text)}</p>${signIn}`;
  else if (v.kind === "none")
    body = `<p>Signed in as <b>@${esc(v.login)}</b>, but GitHub shows no sponsorship of Dragon's Oath from this account yet.</p><p>If you just sponsored, give GitHub a minute and sign in again. If you sponsored from another account, sign in with that one.</p><a class="btn primary" href="${SPONSORS}">Sponsor Dragon's Oath</a> <a class="btn" href="/codes/claim/login">Sign in again</a>`;
  else if (v.kind === "had")
    body = v.founder
      ? `<p><b>@${esc(v.login)}</b>, your Founder code was already made (it starts <b>HRTH-${esc(v.hint)}</b>). If you lost it, ask in the Hearth Discord server and we'll sort it out.</p>`
      : `<p><b>@${esc(v.login)}</b>, you already have this month's code (it starts <b>HRTH-${esc(v.hint)}</b>). Your next one is ready from ${esc(v.next ?? "")}. Thanks for supporting Hearth.</p>`;
  else
    body = `${v.picture && PICTURE_TYPES.test(v.picture.slice(5, v.picture.indexOf(";"))) ? `<img class="premium-ember" src="${v.picture}" alt="Premium Ember, with a crown and a golden key" width="200" height="200">` : ""}<p>Thank you, <b>@${esc(v.login)}</b>! Here's your ${v.founder ? "Hearth Founder code: Premium for good" : "Hearth Premium code for one month"}.</p><div class="code">${esc(v.code)}</div><p>${HOW}</p><p class="meta">${v.founder ? "Copy it now: it is shown only this once." : "Copy it now: it is shown only this once. Come back each month while you sponsor for the next one."}</p>`;
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Claim Hearth Premium</title><style nonce="${nonce}">${CSS}.premium-ember{display:block;width:200px;height:auto;margin:0 auto 8px}</style></head><body><main class="narrow"><h1>Claim Hearth Premium</h1>${body}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        ...headers,
      },
    },
  );
}
