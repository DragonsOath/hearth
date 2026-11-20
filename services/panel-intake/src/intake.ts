import {
  RECEIPT_PREFIX,
  canonicalImage,
  contributionFile,
  contributionProblems,
  specHashInput,
  validatePanelSpec,
  type PanelContribution,
  type PanelReceiptPayload,
  type PanelSpec,
} from "@dragon-control/core";

/**
 * The panel donation service (Ember Panel Builder, Premium's Donate your panel). A Hearth with
 * Hearth Premium (Panel Builder) sends a custom panel here; it becomes a pull request on the
 * private Premium repository, where the owner reviews it and merges it as a Premium skin (label
 * `skin`, the default) or into Hearth for everyone (label `core-default`), crediting the donor.
 * Nobody needs a GitHub account; a donor who gives a GitHub handle is the commit's co-author.
 *
 * - Only a Hearth with a valid Premium licence that includes Panel Builder may donate: the
 *   licence is checked here, offline, against the public keys Hearth trusts (LICENCE_KEYS).
 * - Nothing the install sends is trusted. The published file is rebuilt here from the panel spec
 *   alone, with the same code Hearth's preview uses (contributionFile): the description is
 *   regenerated, the app name is the panel id's own, the image loses any registry host and tag.
 * - It is checked with Hearth's own validator and privacy checks before it is accepted.
 * - Accepting is durable and quick: the submission is stored, a signed receipt is returned (it
 *   marks a saved copy as a verified shared panel), and the pull request is filed later by the
 *   scheduled job, at a capped rate, with retries. A GitHub outage delays the pull request and
 *   loses nothing.
 * - Limits do not trust anything spoofable alone: per licence per day, per network address per
 *   day, and a daily total for the whole service. The same panel twice gets the same receipt and
 *   one PR.
 * - The GitHub token (the dragonsoath-dev machine account, Contents and Pull requests on REPO
 *   only) is used only by the scheduled job: a `donation/` branch, one file under donations/, a
 *   pull request. Its expiry date, which GitHub reports with every answer, is kept so Hearth can
 *   warn the owner 14 days ahead (GET /v1/status).
 */

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; limit?: number }): Promise<{ keys: { name: string }[] }>;
}

export interface Env {
  /** Submissions, the filing queue, and the daily counters (a Workers KV namespace). */
  STORE: KV;
  /** The receipt signing key: Ed25519 private key, PKCS#8, base64 (a secret). */
  RECEIPT_KEY: string;
  /** Its public half's id (first 12 letters of the raw public key, base64url). */
  RECEIPT_KEY_ID: string;
  /** A fine-grained GitHub token: Contents and Pull requests, read and write, on REPO only. */
  GITHUB_TOKEN: string;
  /** "DragonsOath/hearth-premium" (private). */
  REPO: string;
  /**
   * The licence public keys Hearth trusts, as JSON: { "<key id>": "<raw public key, base64url>" }
   * (PRODUCTION_KEYS in apps/server/src/premium/license.ts). Not secret.
   */
  LICENCE_KEYS: string;
  /** The branch pull requests go to ("main"). */
  BASE?: string;
  /** Daily limits (defaults: 3 per licence, 5 per network address, 50 in all). */
  PER_LICENCE?: string;
  PER_ADDRESS?: string;
  DAILY_TOTAL?: string;
  /** Pull requests filed per scheduled run (default 3). */
  PER_RUN?: string;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const MAX_BYTES = 64_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

const b64 = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64u = (bytes: Uint8Array) =>
  b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromB64u = (s: string) =>
  fromB64(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );

const LICENCE_PREFIX = "HEARTHL1";
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
/** Time zones and small clock drift, as Hearth allows. */
const SLACK_MS = 36 * 3_600_000;

/**
 * Checks a Hearth licence (apps/server/src/premium/license.ts readLicense) here: signed by a key
 * Hearth trusts, unchanged, in force now, not taken back (a `revoked:<id>` entry, put by the
 * owner), and including Panel Builder. Its id is all that is used afterwards (the daily limit).
 */
export async function checkLicence(
  token: unknown,
  env: Pick<Env, "LICENCE_KEYS" | "STORE">,
  now = Date.now(),
): Promise<{ id: string } | { error: string }> {
  const no = (why: string) => ({
    error: `Donating a panel needs Hearth Premium with Panel Builder. ${why}`,
  });
  if (typeof token !== "string" || !token || token.length > 4000)
    return no("This Hearth sent no licence.");
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== LICENCE_PREFIX) return no("That isn't a Hearth licence.");
  let p: { id?: unknown; key?: unknown; features?: unknown; start?: unknown; end?: unknown };
  try {
    p = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!))) as typeof p;
  } catch {
    return no("Its licence is damaged.");
  }
  let keys: Record<string, string>;
  try {
    keys = JSON.parse(env.LICENCE_KEYS || "{}") as Record<string, string>;
  } catch {
    keys = {};
  }
  const pub = typeof p.key === "string" ? keys[p.key] : undefined;
  if (!pub) return no("Its licence wasn't issued by a key Hearth trusts.");
  let ok: boolean;
  try {
    const key = await crypto.subtle.importKey("raw", fromB64u(pub), { name: "Ed25519" }, false, [
      "verify",
    ]);
    ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromB64u(parts[2]!),
      new TextEncoder().encode(`${LICENCE_PREFIX}.${parts[1]}`),
    );
  } catch {
    ok = false;
  }
  if (!ok) return no("Its licence's signature doesn't match.");
  if (typeof p.id !== "string" || typeof p.start !== "string" || !ISO.test(p.start))
    return no("Its licence isn't one this service understands.");
  if (!Array.isArray(p.features) || !p.features.includes("panel_builder"))
    return no("Its licence doesn't include Panel Builder.");
  if (Date.parse(p.start) > now + SLACK_MS) return no("Its licence hasn't started yet.");
  if (p.end !== undefined && (typeof p.end !== "string" || Date.parse(p.end) < now))
    return no("Its licence has ended.");
  if (await env.STORE.get(`revoked:${p.id}`)) return no("Its licence was taken back.");
  return { id: p.id };
}

/** Who to credit, as the donor gave it: a short name, a GitHub handle, both or neither. */
export interface Credit {
  name?: string;
  github?: string;
}

export function readCredit(raw: unknown): Credit | { error: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "The credit isn't readable." };
  const c = raw as { name?: unknown; github?: unknown };
  const out: Credit = {};
  if (c.name !== undefined && c.name !== "") {
    // Letters, numbers, spaces and a few marks: never an address, a link or a mention.
    if (typeof c.name !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,39}$/u.test(c.name.trim()))
      return { error: "Use a short name for the credit: letters, numbers and spaces, at most 40." };
    out.name = c.name.trim();
  }
  if (c.github !== undefined && c.github !== "") {
    const h = typeof c.github === "string" ? c.github.trim().replace(/^@/, "") : "";
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(h))
      return { error: "That isn't a GitHub user name." };
    out.github = h;
  }
  return out;
}

/** Signs a receipt as Hearth checks it (apps/server/src/panels/receipt.ts). */
export async function signReceipt(
  env: Pick<Env, "RECEIPT_KEY" | "RECEIPT_KEY_ID">,
  payload: Omit<PanelReceiptPayload, "v" | "key">,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    fromB64(env.RECEIPT_KEY),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const full: PanelReceiptPayload = { v: 1, ...payload, key: env.RECEIPT_KEY_ID };
  const body = b64u(new TextEncoder().encode(JSON.stringify(full)));
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(`${RECEIPT_PREFIX}.${body}`),
  );
  return `${RECEIPT_PREFIX}.${body}.${b64u(new Uint8Array(sig))}`;
}

/**
 * What would be published, rebuilt from the sent panel's spec alone, or why it is refused. The
 * install's own description, app name and anything else outside the checked fields are ignored.
 */
export function rebuild(raw: unknown): { file: PanelContribution } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Send { panel }." };
  const panel = (raw as { panel?: Partial<PanelContribution> }).panel;
  if (!panel || panel.format !== "hearth-panel" || panel.formatVersion !== 1)
    return { error: "This is not a Hearth panel file." };
  const terms = panel.terms;
  if (
    !terms ||
    typeof terms.version !== "number" ||
    terms.version < 1 ||
    typeof terms.acceptedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(terms.acceptedAt)
  )
    return { error: "The contribution agreement was not accepted." };
  if (!panel.spec || typeof panel.spec !== "object") return { error: "There is no panel in it." };
  if (panel.spec.serviceId !== "")
    return { error: "A submitted panel must not name an install's app." };
  const spec = { ...(panel.spec as PanelSpec), serviceId: "submitted" };
  const issues = validatePanelSpec(spec, "submitted");
  if (issues.length)
    return {
      error: `The panel does not pass Hearth's checks: ${issues
        .slice(0, 3)
        .map((i) => `${i.at}: ${i.message}`)
        .join(" ")}`,
    };
  const image = typeof panel.app?.image === "string" ? canonicalImage(panel.app.image) : undefined;
  const file = contributionFile(spec, image, {
    version: terms.version,
    acceptedAt: terms.acceptedAt,
  });
  const problems = contributionProblems(file);
  if (problems.length)
    return {
      error: `It holds something that must not be published: ${problems
        .slice(0, 3)
        .map((p) => `${p.where} ${p.problem}`)
        .join("; ")}.`,
    };
  return { file };
}

interface Stored {
  id: string;
  specHash: string;
  receipt: string;
  file: PanelContribution;
  /** Who to credit (the donor's choice). */
  credit?: Credit;
  receivedAt: string;
  status: "queued" | "filed" | "held";
  attempts: number;
  url?: string;
  lastError?: string;
}

const day = () => new Date().toISOString().slice(0, 10);

const count = async (env: Env, key: string) => Number((await env.STORE.get(key)) ?? "0");
const bump = async (env: Env, key: string) =>
  env.STORE.put(key, String((await count(env, key)) + 1), { expirationTtl: 60 * 60 * 26 });

/** POST /v1/panels: check, limit, store, sign. */
export async function accept(req: Request, env: Env): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BYTES) return json(413, { error: "The panel file is too large." });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: "Send JSON." });
  }
  const built = rebuild(raw);
  if ("error" in built) return json(422, { error: built.error });
  const { file } = built;
  const body = raw as { licence?: unknown; credit?: unknown };
  const licence = await checkLicence(body.licence, env);
  if ("error" in licence) return json(403, { error: licence.error });
  const credit = readCredit(body.credit);
  if ("error" in credit) return json(422, { error: credit.error });
  const specHash = await sha256(specHashInput(file.spec));

  // The same panel again: the same receipt, no second pull request, no limit used.
  const known = await env.STORE.get(`hash:${specHash}`);
  if (known) {
    const s = JSON.parse((await env.STORE.get(`sub:${known}`)) ?? "null") as Stored | null;
    if (s) return json(200, { receipt: s.receipt, id: s.id });
  }

  const address = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const today = day();
  // Only a salted hash of the address is kept, for a day.
  const who = (await sha256(`${today}|${address}`)).slice(0, 32);
  // Every limit is checked before any is counted: a refused request uses up nothing.
  const all = `limit:${today}:all`;
  const mine = `limit:${today}:${who}`;
  const theirs = `limit:${today}:lic:${(await sha256(licence.id)).slice(0, 32)}`;
  if ((await count(env, theirs)) >= Number(env.PER_LICENCE ?? 3))
    return json(429, {
      error: "At most a few donations a day from one Hearth. Try again tomorrow.",
    });
  if ((await count(env, mine)) >= Number(env.PER_ADDRESS ?? 5))
    return json(429, { error: "At most a few panels a day from one place. Try again tomorrow." });
  if ((await count(env, all)) >= Number(env.DAILY_TOTAL ?? 50))
    return json(429, { error: "The submission service is full for today. Try again tomorrow." });
  await bump(env, all);
  await bump(env, mine);
  await bump(env, theirs);

  const id = (await sha256(`${crypto.randomUUID()}|${specHash}`)).slice(0, 16);
  const at = new Date().toISOString();
  const receipt = await signReceipt(env, { id, specHash, at });
  const stored: Stored = {
    id,
    specHash,
    receipt,
    file,
    ...(credit.name || credit.github ? { credit } : {}),
    receivedAt: at,
    status: "queued",
    attempts: 0,
  };
  await env.STORE.put(`sub:${id}`, JSON.stringify(stored));
  await env.STORE.put(`hash:${specHash}`, id);
  await env.STORE.put(`queue:${at}:${id}`, id);
  return json(201, { receipt, id });
}

/** GET /v1/panels/:id: whether its pull request is filed. */
export async function status(id: string, env: Env): Promise<Response> {
  if (!/^[0-9a-f]{16}$/.test(id)) return json(404, { error: "Not here." });
  const s = JSON.parse((await env.STORE.get(`sub:${id}`)) ?? "null") as Stored | null;
  if (!s) return json(404, { error: "Not here." });
  return json(200, { status: s.status, ...(s.url ? { url: s.url } : {}) });
}

/** How a donor is named: "@handle", their name, or nobody. */
export const creditLine = (c?: Credit) =>
  c?.github ? `@${c.github}` : c?.name ? c.name : "a Hearth Premium member (no credit asked)";

/** The PR's words: generated text only, from checked fields (no markup). */
function prBody(s: Stored, path: string, coAuthor: boolean) {
  return [
    "A custom panel made with Ember Panel Builder, donated from a Hearth with Premium.",
    "",
    "```",
    s.file.readme.replace(/`/g, "'"),
    "```",
    "",
    // Inline code, so a handle never notifies anyone from here.
    `Donated by: \`${creditLine(s.credit)}\`${coAuthor ? " (co-author of the commit)" : ""}.`,
    s.credit?.github && !coAuthor
      ? "That GitHub user name wasn't found, so the commit has no co-author."
      : "",
    "",
    "Merge as it is for a **Premium skin** (label `skin`). To put it in Hearth for everyone",
    "instead, swap the label to `core-default`: it goes into the core with the donor credited.",
    "",
    `Contribution agreement version ${s.file.terms?.version}, accepted ${s.file.terms?.acceptedAt}.`,
    `Donation ${s.id}. This pull request adds only \`${path}\`.`,
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

/** GitHub's own answer about the token: when it expires ("2026-12-01 00:00:00 UTC"). */
async function noteExpiry(env: Env, r: Response) {
  const raw = r.headers.get("github-authentication-token-expiration");
  const at = raw ? Date.parse(raw.replace(" UTC", "Z").replace(" ", "T")) : NaN;
  await env.STORE.put(
    "token",
    JSON.stringify({
      ...(Number.isNaN(at) ? {} : { expiresAt: new Date(at).toISOString() }),
      checkedAt: new Date().toISOString(),
      ok: r.ok,
    }),
  );
}

/** GET /v1/status: the token's expiry, so Hearth can warn the owner in time. Nothing else. */
export async function serviceStatus(env: Env): Promise<Response> {
  const t = JSON.parse((await env.STORE.get("token")) ?? "null") as {
    expiresAt?: string;
    checkedAt?: string;
    ok?: boolean;
  } | null;
  return json(200, {
    service: "Hearth panel donations",
    ...(t?.expiresAt ? { tokenExpiresAt: t.expiresAt } : {}),
    ...(t?.checkedAt ? { tokenCheckedAt: t.checkedAt, tokenWorks: t.ok !== false } : {}),
  });
}

/** The scheduled job: files queued submissions as pull requests, a few per run, with retries. */
export async function fileQueued(env: Env, f: Fetcher): Promise<{ filed: number; failed: number }> {
  const base = env.BASE ?? "main";
  const gh = async (method: string, url: string, body?: unknown) => {
    const r = await f(`https://api.github.com/repos/${env.REPO}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "hearth-panel-intake",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    await noteExpiry(env, r);
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${method} ${url.split("?")[0]}`);
    return (await r.json()) as Record<string, unknown>;
  };
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "hearth-panel-intake",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // Twice a day even with nothing to file, so the expiry date stays known.
  const last = JSON.parse((await env.STORE.get("token")) ?? "null") as {
    checkedAt?: string;
  } | null;
  if (!last?.checkedAt || Date.now() - Date.parse(last.checkedAt) > 12 * 3_600_000)
    await f(`https://api.github.com/repos/${env.REPO}`, { headers })
      .then((r) => noteExpiry(env, r))
      .catch(() => undefined);
  /** The donor's GitHub account, for the co-author line (its public id and name only). */
  const coAuthor = async (handle?: string) => {
    if (!handle) return undefined;
    const r = await f(`https://api.github.com/users/${encodeURIComponent(handle)}`, {
      headers,
    }).catch(() => undefined);
    if (!r?.ok) return undefined;
    const u = (await r.json()) as { id?: number; login?: string };
    return typeof u.id === "number" && typeof u.login === "string"
      ? `Co-authored-by: ${u.login} <${u.id}+${u.login}@users.noreply.github.com>`
      : undefined;
  };
  const queue = await env.STORE.list({ prefix: "queue:", limit: Number(env.PER_RUN ?? 3) });
  let filed = 0;
  let failed = 0;
  for (const { name } of queue.keys) {
    const id = await env.STORE.get(name);
    const s = id
      ? (JSON.parse((await env.STORE.get(`sub:${id}`)) ?? "null") as Stored | null)
      : null;
    if (!s || s.status !== "queued") {
      await env.STORE.delete(name);
      continue;
    }
    const [, app, panel] = s.file.spec.id.split(".");
    const path = `donations/${app}/${panel}.json`;
    const branch = `donation/${app}-${panel}-${s.id.slice(0, 8)}`;
    // The committed file: the rebuilt contribution, who to credit, and the receipt.
    const content = `${JSON.stringify(
      { ...s.file, ...(s.credit ? { credit: s.credit } : {}), accepted: s.receipt },
      null,
      2,
    )}\n`;
    try {
      const ref = await gh("GET", `/git/ref/heads/${base}`);
      await gh("POST", "/git/refs", {
        ref: `refs/heads/${branch}`,
        sha: (ref.object as { sha: string }).sha,
      });
      const trailer = await coAuthor(s.credit?.github);
      await gh("PUT", `/contents/${path}`, {
        message: `Donated panel: ${app}: ${s.file.spec.title}${trailer ? `\n\n${trailer}` : ""}`,
        content: b64(new TextEncoder().encode(content)),
        branch,
      });
      const pr = await gh("POST", "/pulls", {
        title: `[Donated panel] ${app}: ${s.file.spec.title}`,
        head: branch,
        base,
        maintainer_can_modify: true,
        body: prBody(s, path, Boolean(trailer)),
      });
      // skin: the default outcome; the owner swaps it for core-default to put it in the core.
      await gh("POST", `/issues/${pr.number as number}/labels`, {
        labels: ["donation", "skin"],
      }).catch(() => undefined);
      s.status = "filed";
      s.url = String(pr.html_url);
      filed += 1;
      await env.STORE.delete(name);
    } catch (e) {
      s.attempts += 1;
      s.lastError = e instanceof Error ? e.message : String(e);
      failed += 1;
      // After many tries it waits for a maintainer, still stored and still accepted.
      if (s.attempts >= 10) {
        s.status = "held";
        await env.STORE.delete(name);
      }
    }
    await env.STORE.put(`sub:${s.id}`, JSON.stringify(s));
  }
  return { filed, failed };
}

export async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/v1/panels") return accept(req, env);
  const m = /^\/v1\/panels\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && m) return status(m[1]!, env);
  if (req.method === "GET" && url.pathname === "/v1/status") return serviceStatus(env);
  if (req.method === "GET" && url.pathname === "/")
    return json(200, { service: "Hearth panel donations", accepts: "POST /v1/panels" });
  return json(404, { error: "Not here." });
}
