import type { AppIssue, AppReport, MealieDashboard } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Mealie, a light panel through its admin API with an administrator's API token from the vault
 * (Authorization: Bearer). Checked against a throwaway ghcr.io/mealie-recipes/mealie v3.30.0.
 *
 * Mealie's admin overview also carries its database address, which can hold the database's
 * password, so only named fields are copied out of it. The token never leaves this file.
 */

export class MealieError extends Error {}

export async function ml<T>(
  fetchImpl: Fetch,
  base: string,
  token: string,
  method: string,
  path: string,
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, `/api${path}`), {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Mealie did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401)
    throw new AppKeyError("Mealie refused the API token. Check the token in the vault.");
  if (res.status === 403)
    throw new AppKeyError(
      "Mealie says this token's user is not an administrator. Use an administrator's API token.",
    );
  if (!res.ok) {
    const text = (await res.text?.().catch(() => "")) ?? "";
    const said = /"(?:message|detail)"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
    throw new MealieError(
      `Mealie refused ${method} ${path.split("?")[0]}: ${redactLine(said ?? `answer ${res.status}`)}.`,
    );
  }
  const text = (await res.text?.()) ?? "";
  return (text ? JSON.parse(text) : undefined) as T;
}

interface RawAbout {
  version?: string;
  versionLatest?: string;
  dbType?: string;
}
interface RawStats {
  totalRecipes?: number;
  totalUsers?: number;
  totalHouseholds?: number;
  totalGroups?: number;
  uncategorizedRecipes?: number;
  untaggedRecipes?: number;
}
interface RawCheck {
  emailReady?: boolean;
  baseUrlSet?: boolean;
  ldapReady?: boolean;
  ldapDisabled?: boolean;
  oidcReady?: boolean;
  oidcDisabled?: boolean;
}
interface RawBackup {
  name: string;
  date?: string;
  size?: string;
}

/** The account Mealie makes on its first start, documented with the password MyPassword. */
export const DEFAULT_ADMIN = "changeme@example.com";

const clean = (v?: string) => (v ?? "").replace(/^v/i, "");

export async function mealieDashboard(
  fetchImpl: Fetch,
  base: string,
  token: string,
): Promise<MealieDashboard> {
  const get = <T>(path: string) => ml<T>(fetchImpl, base, token, "GET", path);
  const [about, stats, check, maint, storage, backups, admin] = await Promise.all([
    get<RawAbout>("/admin/about"),
    get<RawStats>("/admin/about/statistics"),
    get<RawCheck>("/admin/about/check"),
    get<{ dataDirSize?: string; cleanableImages?: number; cleanableDirs?: number }>(
      "/admin/maintenance",
    ),
    get<{ tempDirSize?: string; backupsDirSize?: string }>("/admin/maintenance/storage"),
    get<{ imports?: RawBackup[] }>("/admin/backups"),
    // Mealie cannot filter users by email, so the list is read and only this match is kept.
    get<{ items?: { email?: string }[] }>("/admin/users?perPage=500").catch(() => ({ items: [] })),
  ]);
  const version = clean(about.version);
  // Mealie says "error fetching version" when it cannot reach GitHub.
  const latest = /^\d+\.\d+/.test(clean(about.versionLatest))
    ? clean(about.versionLatest)
    : undefined;
  return {
    app: "mealie",
    ...(version ? { version } : {}),
    ...(latest ? { latest } : {}),
    database:
      about.dbType === "postgres"
        ? "PostgreSQL"
        : about.dbType === "sqlite"
          ? "SQLite"
          : (about.dbType ?? ""),
    recipes: stats.totalRecipes ?? 0,
    users: stats.totalUsers ?? 0,
    households: stats.totalHouseholds ?? 0,
    groups: stats.totalGroups ?? 0,
    uncategorized: stats.uncategorizedRecipes ?? 0,
    untagged: stats.untaggedRecipes ?? 0,
    checks: {
      emailReady: Boolean(check.emailReady),
      baseUrlSet: Boolean(check.baseUrlSet),
      ...(check.ldapDisabled === false ? { ldap: Boolean(check.ldapReady) } : {}),
      ...(check.oidcDisabled === false ? { oidc: Boolean(check.oidcReady) } : {}),
    },
    storage: {
      data: maint.dataDirSize ?? "",
      temp: storage.tempDirSize ?? "",
      backups: storage.backupsDirSize ?? "",
      cleanableImages: maint.cleanableImages ?? 0,
      cleanableDirs: maint.cleanableDirs ?? 0,
    },
    backups: (backups.imports ?? [])
      .map((b) => ({ name: b.name, at: b.date ?? "", size: b.size ?? "" }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 10),
    defaultAdmin: (admin.items ?? []).some((u) => (u.email ?? "").toLowerCase() === DEFAULT_ADMIN),
  };
}

/** Older than this, the newest backup is worth a warning. */
const BACKUP_DAYS = 7;

export async function readMealie(
  base: string,
  token: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await mealieDashboard(fetchImpl, base, token);
  const issues: AppIssue[] = [];
  if (d.defaultAdmin)
    issues.push({
      level: "warning",
      key: "default-admin",
      text: `Mealie still has its first-run administrator (${DEFAULT_ADMIN}). Change its email and password in Mealie.`,
    });
  const newest = d.backups[0]?.at ? Date.parse(d.backups[0].at) : 0;
  if (!newest || Date.now() - newest > BACKUP_DAYS * 86_400_000)
    issues.push({
      level: "warning",
      key: "backup-old",
      text: newest
        ? `Mealie's newest backup is more than ${BACKUP_DAYS} days old.`
        : "Mealie has no backup.",
    });
  if (!d.checks.baseUrlSet)
    issues.push({
      level: "warning",
      key: "base-url",
      text: "Mealie's BASE_URL is not set, so links in its emails and shares point to the wrong address.",
    });
  return {
    app: "mealie",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Recipes", value: d.recipes.toLocaleString() },
      { label: "Newest backup", value: d.backups[0]?.at ? d.backups[0].at.slice(0, 10) : "none" },
    ],
  };
}
