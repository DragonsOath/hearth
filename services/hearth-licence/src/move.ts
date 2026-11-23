import { signLicence, type Env, type Store } from "./licence";
import { datesHold, genuineLicence } from "./package";

/**
 * Premium moves with the Lab Blueprint (11-23, docs/design/PREMIUM.md "Moving to a new Hearth"):
 * a new Hearth restored from a blueprint with the recovery key hands in the licence the old Hearth
 * held, and gets the same Premium for itself. The old licence is taken back, so Premium stays on
 * one Hearth at a time (linking is how one purchase covers several).
 *
 * Holding the licence is the proof: it only ever leaves a Hearth inside a blueprint encrypted to
 * the owner's recovery key. A licence moved before is followed to where it went, so an older
 * blueprint still works. A licence moves at most MOVES_A_YEAR times in a year.
 */

export const MOVES_A_YEAR = 3;
const YEAR = 365 * 86_400_000;
const ID = /^[\w-]{8,80}$/;
const MAX_BODY = 16_384;
const CHAIN = 50;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const refuse = (status: number, error: string) => json(status, { error });

/** A licence and every licence it was moved on to, in order. */
async function chain(store: Store, id: string): Promise<string[]> {
  const out = [id];
  for (let i = 0; i < CHAIN; i++) {
    const m = await store.moveFrom(out[out.length - 1]!);
    if (!m) break;
    out.push(m.toId);
  }
  return out;
}

/** Taking licences back takes back wherever they were moved to as well. */
export async function movedOn(store: Store, ids: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const id of ids) for (const x of await chain(store, id)) out.add(x);
  return [...out];
}

/** Giving licences back gives back only the newest of each (a moved-from one stays retired). */
export async function newestOf(store: Store, ids: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const id of ids) out.add((await chain(store, id)).at(-1)!);
  return [...out];
}

/** POST /v1/move {licence, install}: the licence for this installation, the old one taken back. */
export async function moveLicence(
  req: Request,
  env: Env,
  store: Store,
  now: () => number,
): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return refuse(413, "That request is too big.");
  let body: { licence?: unknown; install?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return refuse(400, "That request isn't readable.");
  }
  const install = typeof body.install === "string" ? body.install : "";
  if (typeof body.licence !== "string" || !ID.test(install))
    return refuse(400, "A licence and this installation's ID are needed.");
  const t = now();
  // As redeeming: five tries a minute and twenty an hour per installation.
  const { minute, hour } = await store.tries(`move:${install}`, t);
  if (minute > 5 || hour > 20) return refuse(429, "Too many tries. Wait a little and try again.");

  const p = await genuineLicence(body.licence, env);
  if (typeof p === "string") return refuse(403, p);
  const dates = datesHold(p, t);
  if (dates) return refuse(403, dates);
  const given = p.id as string;
  if (p.install === install)
    return json(200, { licence: body.licence.trim(), licenceId: given, moved: false });

  // Follow the licence to where it is now. Asked again for the same Hearth (an answer that got
  // lost), the same licence comes back and nothing counts twice.
  const ids = await chain(store, given);
  for (const id of ids.slice(1)) {
    const m = await store.moveTo(id);
    if (m?.toInstall === install)
      return json(200, { licence: m.licence, licenceId: m.toId, moved: true });
  }
  const current = ids.at(-1)!;
  if ((await store.revoked()).includes(current)) return refuse(403, "That licence was taken back.");

  const made = await store.moveTo(given);
  const root = made?.root ?? given;
  if ((await store.movesSince(root, new Date(t - YEAR).toISOString())) >= MOVES_A_YEAR)
    return refuse(
      429,
      `This Premium already moved to a new Hearth ${MOVES_A_YEAR} times this year. Ask in Hearth's Discord and it can be moved by hand.`,
    );

  const lastMove = current === given ? null : await store.moveTo(current);
  const fromInstall = lastMove?.toInstall ?? (typeof p.install === "string" ? p.install : "");
  const at = new Date(t).toISOString();
  const licenceId = crypto.randomUUID();
  let licence: string;
  try {
    licence = await signLicence(
      {
        id: licenceId,
        install,
        features: (p.features as unknown[]).filter((f): f is string => typeof f === "string"),
        kind: typeof p.kind === "string" ? p.kind : "complimentary",
        ...(typeof p.start === "string" ? { start: p.start } : { start: at }),
        ...(typeof p.end === "string" ? { end: p.end } : {}),
        issued: at,
        ...(typeof p.label === "string" ? { label: p.label } : {}),
      },
      env.SIGNING_KEY,
    );
  } catch {
    return refuse(503, "The licence service can't sign right now. Try again later.");
  }
  const recorded = await store.putMove({
    fromId: current,
    toId: licenceId,
    root,
    fromInstall,
    toInstall: install,
    at,
    licence,
  });
  if (!recorded) {
    // Moved somewhere at the same moment: only one wins.
    const won = await store.moveFrom(current);
    if (won?.toInstall === install)
      return json(200, { licence: won.licence, licenceId: won.toId, moved: true });
    return refuse(409, "That licence was just moved to another Hearth.");
  }
  await store.revoke([current], at);
  return json(200, { licence, licenceId, moved: true });
}
