import { b64u, fromB64u, servicePublicKey, type Env, type Store } from "./licence";

/**
 * Premium package delivery (11-22, docs/design/PREMIUM.md "Premium package delivery"): a Hearth
 * holding a licence in force gets the Premium package, from the private DragonsOath/hearth-premium
 * repository's releases, read with a read-only token kept as a Worker secret.
 *
 * This service only passes the package on. It can't sign one: Hearth checks every package against
 * the package key built into it, whose private half is on the owner's workstation only.
 *
 * A release is tagged v<version>-api<N> (N: the add-on contract it was built for) and carries
 * hearth-premium.tar.gz and hearth-premium.sig.json.
 */

const enc = new TextEncoder();
const PREFIX = "HEARTHL1";
const MAX_BODY = 16_384;
const TARBALL = "hearth-premium.tar.gz";
const SIGNED = "hearth-premium.sig.json";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const refuse = (status: number, error: string) => json(status, { error });

interface LicencePayload {
  id?: unknown;
  key?: unknown;
  start?: unknown;
  end?: unknown;
  features?: unknown;
}

/** The licence, if it is genuine (signed by this service or the owner's key) and in force. */
async function licenceInForce(
  token: string,
  env: Env,
  store: Store,
  now: number,
): Promise<{ id: string } | string> {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return "That isn't a Hearth licence.";
  let p: LicencePayload;
  try {
    p = JSON.parse(new TextDecoder().decode(fromB64u(parts[1]!))) as LicencePayload;
  } catch {
    return "That licence is damaged.";
  }
  const keys: Record<string, string> = {};
  if (env.SIGNING_KEY) {
    const pub = await servicePublicKey(env.SIGNING_KEY);
    keys[pub.slice(0, 12)] = pub;
  }
  if (env.OWNER_KEY) keys[env.OWNER_KEY.slice(0, 12)] = env.OWNER_KEY;
  const pub = typeof p.key === "string" ? keys[p.key] : undefined;
  if (!pub) return "That licence wasn't issued by Hearth.";
  try {
    const key = await crypto.subtle.importKey("raw", fromB64u(pub), { name: "Ed25519" }, false, [
      "verify",
    ]);
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromB64u(parts[2]!),
      enc.encode(`${PREFIX}.${parts[1]}`),
    );
    if (!ok) return "That licence's signature doesn't match.";
  } catch {
    return "That licence's signature doesn't match.";
  }
  if (typeof p.id !== "string" || !Array.isArray(p.features) || !p.features.length)
    return "That licence has no Premium features.";
  if (typeof p.start === "string" && Date.parse(p.start) > now)
    return "That licence hasn't started yet.";
  if (typeof p.end === "string" && Date.parse(p.end) <= now) return "That licence has ended.";
  if ((await store.revoked()).includes(p.id)) return "That licence was taken back.";
  return { id: p.id };
}

interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; url: string }[];
}

/** POST /v1/package {licence, api, have?}: 204 when `have` is the newest, else the package. */
export async function deliverPackage(
  req: Request,
  env: Env,
  store: Store,
  now: () => number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return refuse(413, "That request is too big.");
  let body: { licence?: unknown; api?: unknown; have?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return refuse(400, "That request isn't readable.");
  }
  const api = typeof body.api === "number" && Number.isInteger(body.api) ? body.api : NaN;
  if (typeof body.licence !== "string" || !(api > 0))
    return refuse(400, "A licence and the add-on version are needed.");
  const t = now();
  const lic = await licenceInForce(body.licence, env, store, t);
  if (typeof lic === "string") return refuse(403, lic);
  // Ten a minute and thirty an hour per licence: a Hearth asks once per redeem, start or update.
  const { minute, hour } = await store.tries(`package:${lic.id}`, t);
  if (minute > 10 || hour > 30) return refuse(429, "Too many requests. Hearth tries again later.");
  if (!env.PACKAGE_TOKEN)
    return refuse(503, "Premium package delivery isn't switched on yet. Hearth tries again later.");

  const repo = env.PACKAGE_REPO ?? "DragonsOath/hearth-premium";
  const gh = (url: string, accept = "application/vnd.github+json") =>
    fetchImpl(url, {
      headers: {
        authorization: `Bearer ${env.PACKAGE_TOKEN}`,
        accept,
        "user-agent": "hearth-licence",
        "x-github-api-version": "2022-11-28",
      },
    });
  const list = await gh(`https://api.github.com/repos/${repo}/releases?per_page=30`);
  if (!list.ok) return refuse(502, "The Premium package can't be reached right now. Try later.");
  const release = ((await list.json()) as Release[]).find(
    (r) =>
      !r.draft &&
      !r.prerelease &&
      new RegExp(`-api${api}$`).test(r.tag_name) &&
      r.assets.some((a) => a.name === TARBALL) &&
      r.assets.some((a) => a.name === SIGNED),
  );
  if (!release) return refuse(404, `There is no Premium package for add-on version ${api} yet.`);
  const asset = (name: string) => release.assets.find((a) => a.name === name)!.url;
  const signedRes = await gh(asset(SIGNED), "application/octet-stream");
  if (!signedRes.ok) return refuse(502, "The Premium package can't be reached right now.");
  const signedText = await signedRes.text();
  let version: unknown;
  try {
    version = (JSON.parse(signedText) as { version?: unknown }).version;
  } catch {
    return refuse(502, "The Premium package's description is damaged.");
  }
  if (typeof body.have === "string" && body.have === version)
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  const tar = await gh(asset(TARBALL), "application/octet-stream");
  if (!tar.ok || !tar.body) return refuse(502, "The Premium package can't be reached right now.");
  return new Response(tar.body, {
    status: 200,
    headers: {
      "content-type": "application/gzip",
      "cache-control": "no-store",
      "x-hearth-package": b64u(enc.encode(signedText)),
    },
  });
}
