import { randomBytes } from "node:crypto";

/**
 * Ember using Hearth itself (the owner, 2026-11-02: "Ember should be able to do anything inside
 * Hearth"): the hearth_api tool calls Hearth's own API inside the process, as the owner but
 * marked as Ember. The rules below are enforced where every request is signed in
 * (auth/routes.ts), so no tool, prompt or page can widen them:
 *
 * - Reads: anything, except sign-in, the vault, credentials, access keys, Premium codes, grants and
 *   licence keys, and the AI tool endpoint.
 * - Changes: only the owner's own Hearth content (projects and their tasks, to-dos, release
 *   watches, the Lair's panels and layouts, workspaces, findings, memory). Settings, security,
 *   services, notifications, devices, updates and approving plans are not changed this way.
 * - Ember's session never counts as "it's you just now", so anything that needs the owner to
 *   confirm it is them is refused too.
 *
 * Everything else in Hearth (settings, services, notifications, panels' settings...) Ember changes
 * only through a plan the owner approves (the hearth-api-call step, the owner's OK of 2026-11-02),
 * run with EMBER_PLAN_SECRET under planRefusal(): never sign-in, the vault, credentials, keys,
 * Ember's own permissions (agents, Full access, autonomy, automatic repairs, host administration),
 * approving plans, Hearth updates, pairing PCs and devices, or restoring backups.
 */

/** Set on in-process requests only; the secret never leaves the process. */
export const EMBER_HEADER = "x-hearth-ember";
export const EMBER_SECRET = randomBytes(32).toString("base64url");

/** Never read or changed by Ember through this door. */
const NEVER = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/vault(\/|$)/,
  /^\/api\/credentials(\/|$)/,
  /^\/api\/keys(\/|$)/,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/test(\/|$)/,
  // Premium codes, grants and licence keys (11-13, Flint: "Ember can never create or see
  // codes"). Only the plain status (GET /api/premium) stays readable.
  /^\/api\/premium\/.+/,
];

/** The owner's own Hearth content: Ember may add to, change and remove it when asked. */
const CHANGES = [
  /^\/api\/projects(\/|$)/,
  /^\/api\/todos(\/|$)/,
  /^\/api\/watches(\/|$)/,
  // Briefs and watches (11-13): they only send messages; a change to a system is still a plan.
  /^\/api\/briefs(\/|$)/,
  /^\/api\/desk(\/|$)/,
  /^\/api\/workspaces(\/|$)/,
  /^\/api\/findings(\/|$)/,
  /^\/api\/memory(\/|$)/,
  // The Lab Blueprint's notes: things Hearth can't see, written into the blueprint.
  /^\/api\/blueprint\/notes$/,
  // The Crucible's suggested rules (11-18): Ember translates the owner's own words into a rule
  // the panel shows; the owner adds or dismisses it, and Save is still an approved plan.
  /^\/api\/crucible\/suggestions(\/|$)/,
];

export type HearthMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * The address a request reaches: one sent through another PC's link (/api/on/<pc>/vault/...) is
 * that PC's /api/vault/..., so the same rules apply to it as to this Hearth's own.
 */
function reached(path: string): string {
  return path.replace(/^\/api\/on\/[^/]+(?=\/)/, "/api");
}

/** Set on a plan step's in-process request (hearth-api-call), after the owner approved it. */
export const EMBER_PLAN_SECRET = randomBytes(32).toString("base64url");

/** Never changed by a plan either: Ember's own permissions, approvals, updates, new access. */
const PLAN_NEVER = [
  ...NEVER,
  /^\/api\/jobs(\/|$)/,
  /^\/api\/plan(\/|$)/,
  /^\/api\/actions(\/|$)/,
  /^\/api\/updates(\/|$)/,
  /^\/api\/agent(\/|$)/,
  /^\/api\/engine(\/|$)/,
  /^\/api\/autonomy(\/|$)/,
  /^\/api\/jurisdiction(\/|$)/,
  /^\/api\/admin(\/|$)/,
  /^\/api\/owner(\/|$)/,
  /^\/api\/pcs(\/|$)/,
  /^\/api\/devices(\/|$)/,
  /^\/api\/demo(\/|$)/,
  // Backups and their keys. Bringing back a removed system, watch or memory is not a restore of
  // a backup: those routes are ordinary undo, and plans may use them.
  /^\/api\/backups(\/|$)/,
  // The Lab Blueprint's folder, key, updates, key test and import are the owner's alone. Ember
  // reads the blueprint and writes notes, nothing else.
  /^\/api\/blueprint(\/(setup|update|test-key|import)(\/|$)|$)/,
  // Copying another Hearth's layout takes that Hearth's API key: typed by the owner only.
  /^\/api\/layout\/(share|preview|copy)(\/|$)/,
];

/** Settings a plan may not set: they decide what Hearth and Ember may do on their own. */
const PERMISSION_SETTINGS = ["liveRepairs"];

/** Why a plan step may not make this request, or undefined when it may (once approved). */
export function planRefusal(method: string, url: string, body?: string): string | undefined {
  const path = url.split("?")[0]!;
  if (!path.startsWith("/api/") || /\.\.|\/\/|\\|%2e|%2f|%5c/i.test(path))
    return "That is not one of Hearth's addresses.";
  if (method === "GET") return "A plan step only changes things; read with hearth_api instead.";
  if (PLAN_NEVER.some((r) => r.test(path) || r.test(reached(path))))
    return "Not even with your approval: sign-in, the vault, keys, Ember's own permissions, approving plans, updates, pairing and backups stay yours alone, on the screen.";
  if (reached(path) === "/api/settings" && body) {
    try {
      const keys = Object.keys(JSON.parse(body) as Record<string, unknown>);
      const bad = keys.filter((k) => PERMISSION_SETTINGS.includes(k));
      if (bad.length)
        return `Not even with your approval: ${bad.join(", ")} decides what Hearth may do on its own. Change it in Settings.`;
    } catch {
      return "The body is not valid JSON.";
    }
  }
  return undefined;
}

/**
 * Why Ember may not make this request, or undefined when it may. `exists` false (no route at that
 * address and method): only the never-list refuses; anything else answers "not found" with the
 * methods the address takes, rather than sending Ember into a plan that can only fail (11-15).
 */
export function emberRefusal(method: string, url: string, exists = true): string | undefined {
  const path = url.split("?")[0]!;
  if (!path.startsWith("/api/") || /\.\.|\/\/|\\|%2e|%2f|%5c/i.test(path))
    return "That is not one of Hearth's addresses.";
  if (NEVER.some((r) => r.test(path) || r.test(reached(path))))
    return "Sign-in, the vault, credentials, access keys and Premium codes and grants are the owner's alone: Ember never reads or changes them.";
  if (!exists || method === "GET" || method === "HEAD") return undefined;
  if (CHANGES.some((r) => r.test(reached(path)))) return undefined;
  return 'Not changed directly: this part of Hearth changes only through a plan the owner approves. Propose it with propose_job: one hearth-api-call step (serviceId "hearth", params method, path, body, why).';
}

/**
 * The methods Hearth takes at the address Ember asked for, when it is a real address asked with
 * the wrong method (11-15: Ember sent PATCH /api/home-rows/<id>, which only takes PUT and DELETE,
 * got a bare "not found" with no near match, and gave up on the saved row).
 */
export function methodsAt(
  routes: readonly { method: string; url: string }[],
  path: string,
): string[] {
  const want = path.split("?")[0]!;
  const found = new Set<string>();
  for (const r of routes) {
    if (r.method === "HEAD" || !r.url.startsWith("/api/")) continue;
    const pattern = r.url
      .split("/")
      .map((part) =>
        part.startsWith(":")
          ? "[^/]+"
          : part === "*"
            ? ".*"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/");
    if (new RegExp(`^${pattern}$`).test(want)) found.add(r.method);
  }
  return [...found].sort();
}

/**
 * Hearth's real addresses closest to one Ember guessed (11-14: it asked for /api/storage/history,
 * got "not found", answered from a snapshot, and elsewhere read Hearth's source code to find an
 * address). Scored by the words the two share, so /api/storage/history finds /api/storage-center.
 */
export function closestRoutes(
  routes: readonly { method: string; url: string }[],
  method: string,
  guess: string,
  max = 8,
): string[] {
  const words = (p: string) =>
    p
      .split("?")[0]!
      .toLowerCase()
      .split(/[/\-_.]+/)
      .filter((w) => w && w !== "api" && !w.startsWith(":"));
  const want = words(guess);
  if (!want.length) return [];
  const seen = new Set<string>();
  return routes
    .filter((r) => r.method === method && r.url.startsWith("/api/"))
    .filter((r) => !seen.has(r.url) && seen.add(r.url))
    .map((r) => {
      const have = words(r.url);
      let score = 0;
      for (const w of want) {
        if (have.includes(w)) score += 2;
        else if (w.length > 3 && have.some((h) => h.startsWith(w) || w.startsWith(h))) score += 1;
      }
      // The first word (the feature) counts most; shorter addresses first on a tie.
      if (have[0] && have[0] === want[0]) score += 2;
      return { url: r.url, score, len: have.length };
    })
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score || a.len - b.len || a.url.localeCompare(b.url))
    .slice(0, max)
    .map((r) => r.url);
}
