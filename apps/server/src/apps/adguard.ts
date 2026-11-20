import type {
  AdguardCheck,
  AdguardDashboard,
  AdguardFilter,
  AdguardQueries,
  AdguardQuery,
  AdguardRule,
  AppReport,
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
 * AdGuard Home, through its own API (/control), signed in with the username and password from the
 * vault (HTTP Basic, as its API asks). Routes and answers were checked against a throwaway
 * adguard/adguardhome container (v0.107.80).
 *
 * The password never leaves this file: it is not logged or put in an error. Filter list addresses
 * can hold a key, and AdGuard repeats an address in its own errors, so both are masked before they
 * reach the panel, a plan, or Ember.
 */

export class AdguardError extends Error {}

export interface AdguardLogin {
  username: string;
  password: string;
}

type Method = "GET" | "POST" | "PUT";

/** A list address without a key: the query string and any login are masked. */
export function maskAddress(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/@\s"]*@/g, "$1…@")
    .replace(/(\w+:\/\/[^\s"?]*)\?[^\s")]*/g, "$1?…");
}

export class AdguardClient {
  constructor(
    private readonly base: string,
    private readonly login: AdguardLogin,
    private readonly fetchImpl: Fetch,
  ) {}

  /** A call to AdGuard Home's API; its error text comes back masked. */
  async call<T>(method: Method, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(joinUrl(this.base, `/control${path}`), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${this.login.username}:${this.login.password}`).toString("base64")}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `AdGuard Home did not answer at ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new AppKeyError(
        "AdGuard Home refused the username or password. Check them in the vault.",
      );
    if (res.status === 429)
      throw new AppBlockedError("AdGuard Home is refusing sign-ins for now (too many tries).");
    const text = (await res.text?.()) ?? "";
    if (!res.ok)
      throw new AdguardError(
        `AdGuard Home said: ${maskAddress(text.trim().split("\n")[0]?.slice(0, 300) || String(res.status))}`,
      );
    if (!text.trim() || /^OK\b/.test(text.trim())) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }
}

export interface RawStatus {
  version?: string;
  protection_enabled: boolean;
  protection_disabled_duration?: number;
  running?: boolean;
}

export interface RawFilter {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  rules_count?: number;
  last_updated?: string;
}

export interface RawFiltering {
  filters: RawFilter[] | null;
  whitelist_filters: RawFilter[] | null;
  user_rules: string[] | null;
  interval: number;
  enabled: boolean;
}

interface RawStats {
  time_units: "hours" | "days";
  top_queried_domains: Record<string, number>[];
  top_blocked_domains: Record<string, number>[];
  top_clients: Record<string, number>[];
  dns_queries: number[];
  blocked_filtering: number[];
  num_dns_queries: number;
  num_blocked_filtering: number;
  num_replaced_safebrowsing: number;
  num_replaced_safesearch: number;
  num_replaced_parental: number;
  avg_processing_time: number;
}

const pairs = (x: Record<string, number>[] | null | undefined) =>
  (x ?? []).flatMap((o) => Object.entries(o).map(([k, v]) => ({ key: k, count: v })));

/** "v0.107.80" as AdGuard writes it: Hearth keeps "0.107.80". */
export const versionOf = (v?: string) => v?.replace(/^v/, "") || undefined;

export const toFilter = (f: RawFilter, allowlist: boolean): AdguardFilter => ({
  id: f.id,
  name: f.name,
  url: maskAddress(f.url),
  enabled: f.enabled,
  allowlist,
  rules: f.rules_count ?? 0,
  ...(f.last_updated && !f.last_updated.startsWith("0001") ? { updatedAt: f.last_updated } : {}),
});

/** A custom rule in plain words: "||ads.example.com^" blocks it, "@@||…^" allows it. */
export function toRule(text: string): AdguardRule {
  const t = text.trim();
  if (!t || t.startsWith("!") || t.startsWith("#")) return { text, kind: "comment" };
  const m = t.match(/^(@@)?\|\|([a-z0-9_.-]+)\^(\$important)?$/i);
  if (m) return { text, kind: m[1] ? "allow" : "block", domain: m[2]!.toLowerCase() };
  return { text, kind: "other" };
}

/** The rule Hearth writes to block or allow one domain and every subdomain. */
export const ruleFor = (domain: string, allow: boolean) => `${allow ? "@@" : ""}||${domain}^`;

/** The 24 hourly counts AdGuard keeps, newest last, as times. */
export function hourly(
  stats: Pick<RawStats, "time_units" | "dns_queries" | "blocked_filtering">,
  now = Date.now(),
) {
  if (stats.time_units !== "hours") return [];
  const hour = 3_600_000;
  const top = Math.floor(now / hour) * hour;
  const n = stats.dns_queries.length;
  return stats.dns_queries.map((total, i) => ({
    at: new Date(top - (n - 1 - i) * hour).toISOString(),
    total,
    blocked: stats.blocked_filtering[i] ?? 0,
  }));
}

/** The panel's live read: every number on the Overview and the other tabs, in one pass. */
export async function adguardDashboard(c: AdguardClient): Promise<AdguardDashboard> {
  const [status, stats, filtering, rewrites, services, all, sb, parental, safesearch] =
    await Promise.all([
      c.call<RawStatus>("GET", "/status"),
      c.call<RawStats>("GET", "/stats"),
      c.call<RawFiltering>("GET", "/filtering/status"),
      c.call<{ domain: string; answer: string; enabled?: boolean }[]>("GET", "/rewrite/list"),
      c.call<{ ids: string[] | null }>("GET", "/blocked_services/get").catch(() => ({ ids: [] })),
      c
        .call<{ blocked_services: { id: string; name: string; group_id?: string }[] }>(
          "GET",
          "/blocked_services/all",
        )
        .catch(() => ({ blocked_services: [] })),
      c.call<{ enabled: boolean }>("GET", "/safebrowsing/status"),
      c.call<{ enabled: boolean }>("GET", "/parental/status"),
      c.call<{ enabled: boolean }>("GET", "/safesearch/status"),
    ]);
  const total = stats.num_dns_queries;
  return {
    app: "adguard",
    ...(versionOf(status.version) ? { version: versionOf(status.version)! } : {}),
    protection: {
      enabled: status.protection_enabled,
      ...(!status.protection_enabled && status.protection_disabled_duration
        ? { resumesInSec: Math.round(status.protection_disabled_duration / 1000) }
        : {}),
    },
    filteringEnabled: filtering.enabled,
    queries: {
      total,
      blocked: stats.num_blocked_filtering,
      percentBlocked: total ? Math.round((stats.num_blocked_filtering / total) * 1000) / 10 : 0,
      safeBrowsing: stats.num_replaced_safebrowsing,
      parental: stats.num_replaced_parental,
      safeSearch: stats.num_replaced_safesearch,
      avgMs: Math.round(stats.avg_processing_time * 10000) / 10,
    },
    topBlocked: pairs(stats.top_blocked_domains)
      .slice(0, 10)
      .map((p) => ({ domain: p.key, count: p.count })),
    topQueried: pairs(stats.top_queried_domains)
      .slice(0, 10)
      .map((p) => ({ domain: p.key, count: p.count })),
    topClients: pairs(stats.top_clients)
      .slice(0, 5)
      .map((p) => ({ client: p.key, count: p.count })),
    history: hourly(stats),
    filters: [
      ...(filtering.filters ?? []).map((f) => toFilter(f, false)),
      ...(filtering.whitelist_filters ?? []).map((f) => toFilter(f, true)),
    ],
    updateEveryHours: filtering.interval,
    userRules: (filtering.user_rules ?? []).filter((r) => r.trim()).map(toRule),
    rewrites: rewrites.map((r) => ({
      domain: r.domain,
      answer: r.answer,
      enabled: r.enabled !== false,
    })),
    blockedServices: {
      ids: services.ids ?? [],
      all: all.blocked_services.map((s) => ({
        id: s.id,
        name: s.name,
        ...(s.group_id ? { group: s.group_id } : {}),
      })),
    },
    safety: {
      safeBrowsing: sb.enabled,
      parental: parental.enabled,
      safeSearch: safesearch.enabled,
    },
  };
}

/** AdGuard's reason for an answer, in plain words. */
const REASON: Record<string, [AdguardQuery["verdict"], string]> = {
  NotFilteredNotFound: ["allowed", "allowed"],
  NotFilteredWhiteList: ["allowed", "allowed by an allow rule"],
  NotFilteredError: ["other", "not checked: an error"],
  FilteredBlackList: ["blocked", "blocked by a filter"],
  FilteredSafeBrowsing: ["blocked", "blocked as a dangerous site (safe browsing)"],
  FilteredParental: ["blocked", "blocked by parental control"],
  FilteredInvalid: ["blocked", "blocked as an invalid request"],
  FilteredSafeSearch: ["allowed", "changed to safe search"],
  FilteredBlockedService: ["blocked", "blocked service"],
  Rewrite: ["allowed", "answered by a DNS rewrite"],
  RewriteEtcHosts: ["allowed", "answered from the hosts file"],
  RewriteRule: ["allowed", "answered by a rewrite rule"],
};

interface RawRule {
  filter_list_id: number;
  text: string;
}

/** Which list a rule came from: a filter list by name, or your own custom rules. */
function listName(id: number, filters: RawFilter[]) {
  if (id === 0) return "your custom rules";
  if (id === -2) return "blocked services";
  if (id === -1) return "the hosts file";
  const f = filters.find((x) => x.id === id);
  return f ? f.name : `filter list ${id}`;
}

export function toQuery(
  q: {
    time: string;
    question: { name: string; type: string };
    client: string;
    client_info?: { name?: string };
    reason: string;
    rules?: RawRule[];
    service_name?: string;
    elapsedMs?: string;
    cached?: boolean;
  },
  filters: RawFilter[],
): AdguardQuery {
  const [verdict, base] = REASON[q.reason] ?? ["other", q.reason];
  const rule = q.rules?.[0];
  const why =
    q.reason === "FilteredBlackList" && rule?.filter_list_id === 0
      ? "blocked by your custom rule"
      : q.reason === "FilteredBlockedService" && q.service_name
        ? `blocked service: ${q.service_name}`
        : q.reason === "NotFilteredNotFound" && q.cached
          ? "allowed, answered from cache"
          : base;
  const ms = q.elapsedMs ? Math.round(Number(q.elapsedMs) * 10) / 10 : undefined;
  return {
    at: q.time,
    domain: q.question.name,
    type: q.question.type,
    client: q.client,
    ...(q.client_info?.name ? { clientName: q.client_info.name } : {}),
    verdict,
    why,
    ...(rule ? { rule: rule.text, list: maskAddress(listName(rule.filter_list_id, filters)) } : {}),
    ...(ms !== undefined && Number.isFinite(ms) ? { ms } : {}),
  };
}

export interface QueryFilter {
  show?: "all" | "blocked" | "allowed";
  /** Part of a domain, or a device's address or name. */
  search?: string;
  /** From the last page: the next 100 older lookups. */
  older?: string;
}

/** The query log, newest first, 100 at a time. */
export async function adguardQueries(c: AdguardClient, f: QueryFilter): Promise<AdguardQueries> {
  const q = new URLSearchParams({ limit: "100" });
  if (f.show === "blocked") q.set("response_status", "blocked");
  if (f.show === "allowed") q.set("response_status", "processed");
  const search = (f.search ?? "").trim();
  if (search && /^[\w.:-]{1,253}$/.test(search)) q.set("search", search);
  if (f.older && /^[\d:.TZ+-]{10,40}$/.test(f.older)) q.set("older_than", f.older);
  const [log, filtering] = await Promise.all([
    c.call<{ data: Parameters<typeof toQuery>[0][]; oldest: string }>("GET", `/querylog?${q}`),
    c.call<RawFiltering>("GET", "/filtering/status"),
  ]);
  const filters = [...(filtering.filters ?? []), ...(filtering.whitelist_filters ?? [])];
  return {
    queries: log.data.map((x) => toQuery(x, filters)),
    ...(log.oldest && log.data.length === 100 ? { older: log.oldest } : {}),
  };
}

/** Why AdGuard Home blocks or allows one domain. */
export async function adguardCheck(c: AdguardClient, raw: string): Promise<AdguardCheck> {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9_.-]{1,253}$/.test(domain)) throw new AdguardError("Give one domain name.");
  const [r, filtering] = await Promise.all([
    c.call<{ reason: string; rules?: RawRule[]; service_name?: string }>(
      "GET",
      `/filtering/check_host?name=${encodeURIComponent(domain)}`,
    ),
    c.call<RawFiltering>("GET", "/filtering/status"),
  ]);
  const filters = [...(filtering.filters ?? []), ...(filtering.whitelist_filters ?? [])];
  const [verdict, base] = REASON[r.reason] ?? ["other", r.reason];
  const rules = (r.rules ?? []).map((x) => ({
    text: x.text,
    list: maskAddress(listName(x.filter_list_id, filters)),
  }));
  const why =
    r.reason === "NotFilteredNotFound"
      ? "Not blocked: no filter, rule or service matches it."
      : r.reason === "FilteredBlockedService"
        ? `Blocked: it belongs to ${r.service_name ?? "a service"}, which you block.`
        : r.reason === "FilteredBlackList"
          ? `Blocked by ${rules[0]?.list ?? "a filter"}.`
          : r.reason === "NotFilteredWhiteList"
            ? `Allowed by an allow rule in ${rules[0]?.list ?? "a list"}, which wins over blocklists.`
            : `${base[0]!.toUpperCase()}${base.slice(1)}.`;
  return {
    domain,
    verdict,
    why,
    rules,
    ...(r.service_name ? { service: r.service_name } : {}),
  };
}

/** The health check: protection on, queries and blocked, filter lists, in Hearth's report shape. */
export async function readAdguard(
  base: string,
  login: AdguardLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const c = new AdguardClient(base, login, fetchImpl);
  const [status, stats, filtering] = await Promise.all([
    c.call<RawStatus>("GET", "/status"),
    c.call<RawStats>("GET", "/stats"),
    c.call<RawFiltering>("GET", "/filtering/status"),
  ]);
  const issues: AppReport["issues"] = [];
  if (!status.protection_enabled)
    issues.push({
      level: "warning",
      key: "protection-off",
      text: `Protection is paused${status.protection_disabled_duration ? ` for ${Math.ceil(status.protection_disabled_duration / 60_000)} more minutes` : " until it is turned back on"}.`,
    });
  if (!filtering.enabled)
    issues.push({ level: "warning", key: "filtering-off", text: "Filtering is switched off." });
  const enabled = (filtering.filters ?? []).filter((f) => f.enabled);
  const never = enabled.filter((f) => !f.last_updated || f.last_updated.startsWith("0001"));
  if (never.length)
    issues.push({
      level: "warning",
      key: "filters-not-downloaded",
      text: `${never.length} ${never.length === 1 ? "filter list has" : "filter lists have"} never downloaded.`,
    });
  const v = versionOf(status.version);
  const pct = stats.num_dns_queries
    ? Math.round((stats.num_blocked_filtering / stats.num_dns_queries) * 100)
    : 0;
  return {
    app: "adguard",
    ...(v ? { version: v } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Protection", value: status.protection_enabled ? "on" : "paused" },
      {
        label: "Queries, 24 hours",
        value: `${stats.num_dns_queries}, ${stats.num_blocked_filtering} blocked (${pct}%)`,
      },
      { label: "Filter lists on", value: String(enabled.length) },
    ],
  };
}
