import { createHash } from "node:crypto";
import type {
  AppIssue,
  AppReport,
  VaultwardenDashboard,
  VaultwardenUser,
} from "@dragon-control/core";
import {
  AppBlockedError,
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  TIMEOUT_MS,
  worst,
  type Fetch,
} from "./http";

/**
 * Vaultwarden, through its admin page's own calls, signed in with the admin token from the vault.
 * Checked against a throwaway vaultwarden/server 1.37.5.
 *
 * Vaultwarden holds everyone's passwords, so Hearth reads only what an administrator needs and
 * copies fields by name: never a vault item, an account's keys or security stamp, the admin
 * token, or a setting that holds a secret (its settings come back masked, and Hearth still takes
 * only a short list of yes or no ones). The admin sign-in allows 3 tries in 5 minutes, so Hearth
 * keeps the session Vaultwarden gives (20 minutes) and signs in again only when it ends.
 */

export class VaultwardenError extends Error {}

const SESSIONS = new Map<string, { key: string; cookie: string; until: number }>();
const SESSION_MS = 15 * 60_000;

/** Forget the admin sessions (tests). */
export function forgetVaultwardenSessions() {
  SESSIONS.clear();
  SIGNING_IN.clear();
}

const keyOf = (token: string) => createHash("sha256").update(token).digest("hex");

async function send(
  fetchImpl: Fetch,
  base: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; manual?: boolean },
) {
  try {
    return await fetchImpl(joinUrl(base, path), {
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.manual ? { redirect: "manual" as const } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Vaultwarden did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const SIGNING_IN = new Map<string, Promise<string>>();

/**
 * The admin session cookie, kept between reads. Calls made at the same moment share one sign-in:
 * a dashboard read makes three calls, and three sign-ins would use up Vaultwarden's limit.
 */
function session(fetchImpl: Fetch, base: string, token: string, fresh = false): Promise<string> {
  const key = keyOf(token);
  const kept = SESSIONS.get(base);
  if (!fresh && kept?.key === key && kept.until > Date.now()) return Promise.resolve(kept.cookie);
  const flight = `${base}\n${key}`;
  const going = SIGNING_IN.get(flight);
  if (going) return going;
  const p = signIn(fetchImpl, base, token, key).finally(() => SIGNING_IN.delete(flight));
  SIGNING_IN.set(flight, p);
  return p;
}

async function signIn(fetchImpl: Fetch, base: string, token: string, key: string) {
  const res = await send(fetchImpl, base, "/admin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    manual: true,
  });
  if (res.status === 404)
    throw new AppKeyError(
      "Vaultwarden's admin page is off (no ADMIN_TOKEN is set). Turn it on to let Hearth read accounts.",
    );
  if (res.status === 429)
    throw new AppBlockedError("Vaultwarden is refusing admin sign-ins for a few minutes.");
  const cookie = /VW_ADMIN=([^;]+)/.exec(res.headers?.get("set-cookie") ?? "")?.[1];
  if (res.status === 401 || !cookie)
    throw new AppKeyError(
      "Vaultwarden refused the admin token. Check it in the vault: it is the plain token, not its hash.",
    );
  SESSIONS.set(base, { key, cookie, until: Date.now() + SESSION_MS });
  return cookie;
}

/** One admin call, signing in again once if the session ended. */
export async function admin<T>(
  fetchImpl: Fetch,
  base: string,
  token: string,
  method: string,
  path: string,
  as: "json" | "text" = "json",
): Promise<T> {
  for (const fresh of [false, true]) {
    const cookie = await session(fetchImpl, base, token, fresh);
    const res = await send(fetchImpl, base, path, {
      method,
      headers: {
        Cookie: `VW_ADMIN=${cookie}`,
        // Vaultwarden's admin actions answer only JSON requests.
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        Accept: as === "json" ? "application/json" : "text/html",
      },
      ...(method !== "GET" ? { body: "{}" } : {}),
    });
    if (res.status === 401 && !fresh) {
      SESSIONS.delete(base);
      continue;
    }
    if (!res.ok) {
      const text = ((await res.text?.().catch(() => "")) ?? "").replace(/<[^>]+>/g, " ");
      const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
      throw new VaultwardenError(
        `Vaultwarden refused ${method} ${path}: ${said ?? `answer ${res.status}`}.`,
      );
    }
    if (as === "text") return ((await res.text?.()) ?? "") as T;
    const text = (await res.text?.()) ?? "";
    // Some actions answer in plain words ("Backup to data/db.sqlite3 was successful").
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      return text.slice(0, 300) as T;
    }
  }
  throw new AppKeyError("Vaultwarden refused the admin session.");
}

/** An admin action on one account (disable, enable, deauth, remove-2fa, invite/resend, delete). */
export const userAction = (
  fetchImpl: Fetch,
  base: string,
  token: string,
  id: string,
  action: string,
) =>
  admin<unknown>(
    fetchImpl,
    base,
    token,
    "POST",
    `/admin/users/${encodeURIComponent(id)}/${action}`,
  );

export async function invite(fetchImpl: Fetch, base: string, token: string, email: string) {
  for (const fresh of [false, true]) {
    const cookie = await session(fetchImpl, base, token, fresh);
    const res = await send(fetchImpl, base, "/admin/invite", {
      method: "POST",
      headers: { Cookie: `VW_ADMIN=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.status === 401 && !fresh) continue;
    if (!res.ok) {
      const text = (await res.text?.().catch(() => "")) ?? "";
      const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
      throw new VaultwardenError(
        `Vaultwarden did not invite ${email}: ${said ?? `answer ${res.status}`}.`,
      );
    }
    return;
  }
}

export interface RawUser {
  id: string;
  email: string;
  name?: string;
  _status?: number;
  userEnabled?: boolean;
  twoFactorEnabled?: boolean;
  lastActive?: string | null;
  createdAt?: string;
  creationDate?: string;
  organizations?: { name?: string }[];
}

/** Vaultwarden writes "2026-11-08 08:40:36 +00:00" for some times. */
const iso = (t?: string | null) => {
  if (!t) return undefined;
  const d = new Date(t.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d:\d\d)$/, "$1T$2$3"));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** Only these fields: an account also carries its encrypted keys and security stamp. */
export function toUser(u: RawUser): VaultwardenUser {
  const lastActive = iso(u.lastActive);
  const created = iso(u.creationDate ?? u.createdAt);
  return {
    id: u.id,
    email: u.email,
    name: u.name && u.name !== u.email ? u.name : u.email.split("@")[0]!,
    status: u.userEnabled === false ? "disabled" : u._status === 1 ? "invited" : "active",
    twoFactor: u.twoFactorEnabled === true,
    ...(lastActive ? { lastActive } : {}),
    ...(created ? { created } : {}),
    orgs: (u.organizations ?? []).map((o) => o.name ?? "").filter(Boolean),
  };
}

type Config = Record<string, unknown>;
type Diagnostics = Record<string, unknown>;

/** The diagnostics page carries its facts as JSON inside the page. */
export function diagnosticsOf(html: string): Diagnostics {
  const m = /id="diagnostics_json"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return {};
  try {
    return JSON.parse(m[1]!) as Diagnostics;
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const yes = (v: unknown) => v === true;
const realVersion = (v: unknown) => (/^\d+\.\d+/.test(str(v)) ? str(v) : undefined);

/** Version strings compared part by part ("1.37.5" < "1.38.0"). */
export function newer(a: string, b: string) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function vaultwardenDashboard(
  fetchImpl: Fetch,
  base: string,
  token: string,
): Promise<VaultwardenDashboard> {
  const [users, config, diagHtml] = await Promise.all([
    admin<RawUser[]>(fetchImpl, base, token, "GET", "/admin/users"),
    admin<Config>(fetchImpl, base, token, "GET", "/admin/diagnostics/config"),
    admin<string>(fetchImpl, base, token, "GET", "/admin/diagnostics", "text"),
  ]);
  const diag = diagnosticsOf(diagHtml);
  const list = (users ?? []).map(toUser).sort((a, b) => a.email.localeCompare(b.email));
  const orgs = new Map<string, number>();
  for (const u of list) for (const o of u.orgs) orgs.set(o, (orgs.get(o) ?? 0) + 1);
  // The admin page's own address: Vaultwarden masks DOMAIN in its settings, not here.
  const address = str(diag.admin_url).replace(/\/admin(\/.*)?$/, "") || undefined;
  const version = realVersion(diag.current_release);
  const latest = realVersion(diag.latest_release);
  const checks: VaultwardenDashboard["checks"] = [];
  if (str(diag.invalid_env_vars))
    checks.push({
      key: "env",
      text: `Vaultwarden ignores settings it does not know: ${str(diag.invalid_env_vars).slice(0, 200)}.`,
    });
  if (diag.web_vault_compare === -1)
    checks.push({
      key: "web-vault",
      text: "Its web vault is older than the one this version expects.",
    });
  if (str(diag.config_file_status) === "Corrupt" || str(diag.config_file_status) === "Unreadable")
    checks.push({ key: "config", text: "Its settings file (config.json) cannot be read." });
  return {
    app: "vaultwarden",
    ...(version ? { version } : {}),
    ...(realVersion(diag.active_web_release)
      ? { webVault: realVersion(diag.active_web_release)! }
      : {}),
    ...(version && latest && newer(latest, version) ? { latest } : {}),
    ...(str(diag.db_type)
      ? { database: `${str(diag.db_type)} ${str(diag.db_version)}`.trim() }
      : {}),
    ...(address ? { address } : {}),
    https: address ? address.startsWith("https://") : false,
    users: list,
    orgs: [...orgs].map(([name, members]) => ({ name, members })),
    settings: {
      signupsAllowed: yes(config.signups_allowed),
      // A list of email domains, never a secret.
      signupDomains: str(config.signups_domains_whitelist).slice(0, 300),
      signupsVerify: yes(config.signups_verify),
      invitationsAllowed: yes(config.invitations_allowed),
      emergencyAccess: yes(config.emergency_access_allowed),
      sends: yes(config.sends_allowed),
      passwordHints: yes(config.password_hints_allowed),
      showPasswordHint: yes(config.show_password_hint),
      // Whether email is set up; its host and password are never read.
      emailConfigured: Boolean(config.smtp_host) || yes(config.use_sendmail),
      webVault: config.web_vault_enabled !== false,
    },
    checks,
  };
}

export async function readVaultwarden(
  base: string,
  token: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await vaultwardenDashboard(fetchImpl, base, token);
  const issues: AppIssue[] = [];
  if (d.settings.signupsAllowed && !d.settings.signupDomains)
    issues.push({
      level: "warning",
      key: "signups-open",
      text: "Anyone who can reach Vaultwarden can make an account: sign-ups are open to every email address.",
    });
  if (d.address && !d.https)
    issues.push({
      level: "warning",
      key: "no-https",
      text: `Vaultwarden says it is reached at ${d.address}, without https: the web vault and most apps need https to work.`,
    });
  if (d.settings.showPasswordHint)
    issues.push({
      level: "warning",
      key: "hints-shown",
      text: "Vaultwarden shows password hints on its sign-in page to anyone who asks.",
    });
  for (const c of d.checks) issues.push({ level: "warning", key: `check:${c.key}`, text: c.text });
  const active = d.users.filter((u) => u.status === "active");
  return {
    app: "vaultwarden",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Accounts", value: String(active.length) },
      ...(active.some((u) => !u.twoFactor)
        ? [
            {
              label: "Without two-step sign-in",
              value: String(active.filter((u) => !u.twoFactor).length),
            },
          ]
        : []),
      ...(d.latest ? [{ label: "Update", value: d.latest }] : []),
    ],
  };
}
