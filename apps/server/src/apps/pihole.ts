import { createHash } from "node:crypto";
import type {
  AppReport,
  PiholeCheck,
  PiholeDashboard,
  PiholeList,
  PiholeQueries,
  PiholeQuery,
  PiholeRule,
} from "@dragon-control/core";
import {
  AppBlockedError,
  AppIncompatibleError,
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  TIMEOUT_MS,
  worst,
  type Fetch,
} from "./http";

/**
 * Pi-hole 6, through its REST API (/api), with its app password (or web password) from the vault.
 * Pi-hole trades the password for a session id (POST /api/auth) and keeps only a few sessions at
 * once, so Hearth signs in once per Pi-hole and reuses the session until Pi-hole ends it. Routes and
 * answers were checked against a throwaway pihole/pihole container (Core v6.5, FTL v6.8).
 *
 * The password never leaves this file: it is not logged, not put in an error, and only its hash is
 * kept to know when the vault entry changed. Blocklist addresses can carry a key in their query
 * string, so the panel only ever sees them masked, and changes name a list by Pi-hole's id.
 */

export class PiholeError extends Error {}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** One live session per Pi-hole address. */
const SESSIONS = new Map<string, { key: string; sid: string | null }>();

/** Forget the sessions (tests, and a Pi-hole whose vault entry was removed). */
export function forgetPiholeSessions() {
  SESSIONS.clear();
}

const hashOf = (password: string) => createHash("sha256").update(password).digest("hex");

export class PiholeSession {
  private constructor(
    private readonly base: string,
    private readonly password: string,
    private readonly fetchImpl: Fetch,
    private sid: string | null,
  ) {}

  /** One sign-in at a time: the panel's reads run together and may all find the session ended. */
  private pending?: Promise<void>;

  /** A signed-in session, reused when Hearth already has one for this Pi-hole and password. */
  static async open(base: string, password: string, fetchImpl: Fetch): Promise<PiholeSession> {
    const key = hashOf(password);
    const known = SESSIONS.get(base);
    if (known && known.key === key) return new PiholeSession(base, password, fetchImpl, known.sid);
    const s = new PiholeSession(base, password, fetchImpl, null);
    await s.login();
    return s;
  }

  private async raw(
    method: Method,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Awaited<ReturnType<Fetch>>> {
    try {
      return await this.fetchImpl(joinUrl(this.base, `/api${path}`), {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(this.sid ? { "X-FTL-SID": this.sid } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `Pi-hole did not answer at ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async login() {
    const res = await this.raw("POST", "/auth", { password: this.password }, TIMEOUT_MS);
    if (res.status === 429)
      throw new AppBlockedError(
        "Pi-hole is refusing sign-ins for now (too many tries). Wait a minute.",
      );
    if (res.status === 404)
      throw new AppIncompatibleError(
        "This Pi-hole has no /api: Hearth works with Pi-hole 6 or newer.",
      );
    const answer = (await res.json().catch(() => ({}))) as {
      session?: { valid?: boolean; totp?: boolean; sid?: string | null };
    };
    const session = answer.session;
    if (!session?.valid) {
      SESSIONS.delete(this.base);
      throw new AppKeyError(
        session?.totp
          ? "Pi-hole asks for a two-factor code with this password: use an app password instead (Settings > Web interface / API)."
          : "Pi-hole refused the password. Put its app password in the vault.",
      );
    }
    // No password set on the Pi-hole: it answers valid with no session id, and every call works.
    this.sid = session.sid ?? null;
    SESSIONS.set(this.base, { key: hashOf(this.password), sid: this.sid });
  }

  /** A call to Pi-hole's API, signing in again once if Pi-hole ended the session. */
  async call<T>(
    method: Method,
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number; text?: boolean } = {},
  ): Promise<T> {
    const timeout = opts.timeoutMs ?? TIMEOUT_MS;
    const sent = this.sid;
    let res = await this.raw(method, path, body, timeout);
    if (res.status === 401) {
      // Another call may already have signed in again; otherwise this one does, once.
      if (this.sid === sent) {
        this.pending ??= this.login().finally(() => (this.pending = undefined));
        await this.pending;
      }
      res = await this.raw(method, path, body, timeout);
      if (res.status === 401)
        throw new AppKeyError("Pi-hole refused the password after signing in.");
    }
    if (res.status === 204) return undefined as T;
    if (opts.text && res.ok) return ((await res.text?.()) ?? "") as T;
    const json = (await res.json().catch(() => undefined)) as
      { error?: { message?: string; hint?: string | null } } | undefined;
    if (!res.ok) {
      const e = json?.error;
      throw new PiholeError(
        e?.message
          ? `Pi-hole said: ${e.message}${e.hint ? ` (${e.hint})` : ""}`
          : `Pi-hole answered ${res.status} for ${path.split("?")[0]}.`,
      );
    }
    return json as T;
  }
}

/** A list address without a key: the query string and any login are masked. */
export function maskAddress(address: string): string {
  return address.replace(/^(\w+:\/\/)[^/@\s]*@/, "$1…@").replace(/\?[^\s)]*/, "?…");
}

const LIST_STATUS: Record<number, PiholeList["status"]> = {
  0: "not yet updated",
  1: "updated",
  2: "unchanged",
  3: "unreachable, using the copy it had",
  4: "unreachable",
};

const when = (sec?: number | null) =>
  sec && sec > 0 ? new Date(sec * 1000).toISOString() : undefined;

export interface RawList {
  id: number;
  address: string;
  type: "block" | "allow";
  enabled: boolean;
  comment?: string | null;
  groups?: number[];
  number?: number;
  status?: number;
  date_updated?: number;
}

export interface RawDomain {
  domain: string;
  kind?: "exact" | "regex";
  type?: "allow" | "deny";
  comment?: string | null;
  enabled: boolean;
  groups?: number[];
}

export const toList = (l: RawList): PiholeList => ({
  id: l.id,
  address: maskAddress(l.address),
  type: l.type,
  enabled: l.enabled,
  ...(l.comment ? { comment: l.comment } : {}),
  domains: l.number ?? 0,
  status: LIST_STATUS[l.status ?? 0] ?? "not yet updated",
  ...(when(l.date_updated) ? { updatedAt: when(l.date_updated)! } : {}),
});

interface Version {
  version?: Record<
    string,
    { local?: { version?: string | null } | string; remote?: { version?: string | null } | string }
  >;
}

/** "6.5 (FTL 6.8)", and whether Pi-hole's own check found a newer one. */
export function versionOf(v: Version): { version?: string; update?: string } {
  const parts = v.version ?? {};
  const local = (k: string) => {
    const x = parts[k]?.local;
    const l = typeof x === "string" ? x : (x?.version ?? undefined);
    // "v6.5" as Pi-hole writes it; Hearth compares major versions as numbers.
    return l?.replace(/^v/, "");
  };
  const remote = (k: string) => {
    const x = parts[k]?.remote;
    const r = typeof x === "string" ? x : x?.version;
    return r && r !== "null" ? r.replace(/^v/, "") : undefined;
  };
  const core = local("core");
  const ftl = local("ftl");
  const newer = (["core", "web", "ftl", "docker"] as const)
    .filter((k) => remote(k) && local(k) && remote(k) !== local(k))
    .map(
      (k) =>
        `${k === "ftl" ? "FTL" : k === "docker" ? "the Docker image" : k === "web" ? "Web" : "Core"} ${remote(k)}`,
    );
  return {
    ...(core ? { version: `${core}${ftl ? ` (FTL ${ftl})` : ""}` } : {}),
    ...(newer.length ? { update: `${newer.join(", ")} is out.` } : {}),
  };
}

interface Summary {
  queries: {
    total: number;
    blocked: number;
    percent_blocked: number;
    unique_domains: number;
    forwarded: number;
    cached: number;
  };
  clients: { active: number; total: number };
  gravity: { domains_being_blocked: number; last_update?: number };
}

/** Pi-hole's 10-minute slots, added up into hours. */
export function hourly(slots: { timestamp: number; total: number; blocked: number }[]) {
  const hours = new Map<number, { total: number; blocked: number }>();
  for (const s of slots) {
    const h = Math.floor(s.timestamp / 3600) * 3600;
    const x = hours.get(h) ?? { total: 0, blocked: 0 };
    x.total += s.total;
    x.blocked += s.blocked;
    hours.set(h, x);
  }
  return [...hours.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-24)
    .map(([h, x]) => ({ at: new Date(h * 1000).toISOString(), ...x }));
}

export const toRule = (x: RawDomain): PiholeRule => ({
  domain: x.domain,
  match: x.kind === "regex" ? "regex" : "exact",
  ...(x.comment ? { comment: x.comment } : {}),
  enabled: x.enabled,
});
const domains = (d: { domains?: RawDomain[] }) => (d.domains ?? []).map(toRule);

/** "192.168.1.10 plex.home" lines, and "alias,target" ones, as Pi-hole keeps them. */
export const toRecord = (line: string) => {
  const [ip = "", ...names] = line.trim().split(/\s+/);
  return names.map((name) => ({ name, ip }));
};
export const toAlias = (line: string) => {
  const [name = "", target = ""] = line.split(",");
  return { name, target };
};

async function localDns(s: PiholeSession): Promise<PiholeDashboard["localDns"]> {
  const [hosts, cnames] = await Promise.all([
    s
      .call<{ config: { dns: { hosts: string[] } } }>("GET", "/config/dns/hosts")
      .then((r) => r.config.dns.hosts)
      .catch(() => [] as string[]),
    s
      .call<{ config: { dns: { cnameRecords: string[] } } }>("GET", "/config/dns/cnameRecords")
      .then((r) => r.config.dns.cnameRecords)
      .catch(() => [] as string[]),
  ]);
  return { records: hosts.flatMap(toRecord), aliases: cnames.map(toAlias) };
}

/** The panel's live read: every number on the Overview, in one pass. */
export async function piholeDashboard(s: PiholeSession): Promise<PiholeDashboard> {
  const [version, summary, blocking, top, clients, history, lists, allowed, denied, messages, dns] =
    await Promise.all([
      s.call<Version>("GET", "/info/version"),
      s.call<Summary>("GET", "/stats/summary"),
      s.call<{ blocking: PiholeDashboard["blocking"]; timer: number | null }>(
        "GET",
        "/dns/blocking",
      ),
      s.call<{ domains: { domain: string; count: number }[] }>(
        "GET",
        "/stats/top_domains?blocked=true&count=10",
      ),
      s.call<{ clients: { name: string; ip: string; count: number }[] }>(
        "GET",
        "/stats/top_clients?count=5",
      ),
      s
        .call<{ history: { timestamp: number; total: number; blocked: number }[] }>(
          "GET",
          "/history",
        )
        .catch(() => ({ history: [] })),
      s.call<{ lists: RawList[] }>("GET", "/lists"),
      s.call<{ domains: RawDomain[] }>("GET", "/domains/allow"),
      s.call<{ domains: RawDomain[] }>("GET", "/domains/deny"),
      s
        .call<{ messages: { id: number; type: string; plain: string; timestamp: number }[] }>(
          "GET",
          "/info/messages",
        )
        .catch(() => ({ messages: [] })),
      localDns(s),
    ]);
  const q = summary.queries;
  return {
    app: "pihole",
    ...versionOf(version),
    blocking: blocking.blocking,
    ...(blocking.timer ? { resumesInSec: Math.round(blocking.timer) } : {}),
    queries: {
      total: q.total,
      blocked: q.blocked,
      percentBlocked: Math.round(q.percent_blocked * 10) / 10,
      uniqueDomains: q.unique_domains,
      forwarded: q.forwarded,
      cached: q.cached,
    },
    clients: { active: summary.clients.active, total: summary.clients.total },
    gravity: {
      domains: summary.gravity.domains_being_blocked,
      ...(when(summary.gravity.last_update)
        ? { updatedAt: when(summary.gravity.last_update)! }
        : {}),
    },
    topBlocked: top.domains.slice(0, 10),
    topClients: clients.clients
      .slice(0, 5)
      .map((c) => ({ name: c.name || c.ip, ip: c.ip, count: c.count })),
    history: hourly(history.history),
    lists: lists.lists.map(toList),
    allowed: domains(allowed),
    denied: domains(denied),
    localDns: dns,
    messages: messages.messages
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((m) => ({
        id: m.id,
        type: m.type,
        text: maskAddress(m.plain),
        at: new Date(m.timestamp * 1000).toISOString(),
      })),
  };
}

const DAY = 86_400_000;

/** The health check: blocking on, queries and blocked, blocklists, in Hearth's report shape. */
export async function readPihole(
  base: string,
  password: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const s = await PiholeSession.open(base, password, fetchImpl);
  const [version, summary, blocking, lists] = await Promise.all([
    s.call<Version>("GET", "/info/version"),
    s.call<Summary>("GET", "/stats/summary"),
    s.call<{ blocking: string; timer: number | null }>("GET", "/dns/blocking"),
    s.call<{ lists: RawList[] }>("GET", "/lists"),
  ]);
  const issues: AppReport["issues"] = [];
  if (blocking.blocking !== "enabled")
    issues.push({
      level: "warning",
      key: "blocking-off",
      text:
        blocking.blocking === "failed"
          ? "Pi-hole could not turn ad blocking on."
          : `Ad blocking is paused${blocking.timer ? ` for ${Math.ceil(blocking.timer / 60)} more minutes` : " until it is turned back on"}.`,
    });
  const failing = lists.lists.filter((l) => l.enabled && (l.status === 3 || l.status === 4));
  if (failing.length)
    issues.push({
      level: "warning",
      key: "lists-unreachable",
      text: `${failing.length} ${failing.length === 1 ? "blocklist" : "blocklists"} could not be downloaded at the last update.`,
    });
  const updated = summary.gravity.last_update ? summary.gravity.last_update * 1000 : 0;
  if (updated && Date.now() - updated > 30 * DAY)
    issues.push({
      level: "warning",
      key: "gravity-old",
      text: `The blocklists were last updated ${Math.floor((Date.now() - updated) / DAY)} days ago.`,
    });
  const q = summary.queries;
  const v = versionOf(version);
  return {
    app: "pihole",
    ...(v.version ? { version: v.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Ad blocking",
        value:
          blocking.blocking === "enabled"
            ? "on"
            : blocking.blocking === "disabled"
              ? "paused"
              : blocking.blocking,
      },
      {
        label: "Queries, 24 hours",
        value: `${q.total}, ${q.blocked} blocked (${Math.round(q.percent_blocked)}%)`,
      },
      { label: "Domains on blocklists", value: String(summary.gravity.domains_being_blocked) },
    ],
  };
}

/** Pi-hole's query status, in plain words: blocked (and by what), allowed, or neither. */
const STATUS: Record<string, [PiholeQuery["verdict"], string]> = {
  GRAVITY: ["blocked", "blocked by a blocklist"],
  GRAVITY_CNAME: ["blocked", "blocked by a blocklist (through an alias)"],
  REGEX: ["blocked", "blocked by a pattern"],
  REGEX_CNAME: ["blocked", "blocked by a pattern (through an alias)"],
  DENYLIST: ["blocked", "blocked by name"],
  DENYLIST_CNAME: ["blocked", "blocked by name (through an alias)"],
  EXTERNAL_BLOCKED_IP: ["blocked", "blocked by the upstream DNS server"],
  EXTERNAL_BLOCKED_NULL: ["blocked", "blocked by the upstream DNS server"],
  EXTERNAL_BLOCKED_NXRA: ["blocked", "blocked by the upstream DNS server"],
  EXTERNAL_BLOCKED_EDE15: ["blocked", "blocked by the upstream DNS server"],
  SPECIAL_DOMAIN: ["blocked", "blocked as a special domain (for example Apple's private relay)"],
  FORWARDED: ["allowed", "allowed, asked the upstream DNS server"],
  CACHE: ["allowed", "allowed, answered from cache"],
  CACHE_STALE: ["allowed", "allowed, answered from an older cached copy"],
  RETRIED: ["allowed", "allowed, asked again"],
  RETRIED_DNSSEC: ["allowed", "allowed, asked again for DNSSEC"],
  IN_PROGRESS: ["other", "still waiting for an answer"],
  DBBUSY: ["other", "not answered: Pi-hole's database was busy"],
};

interface RawQuery {
  id: number;
  time: number;
  type: string;
  status: string;
  domain: string;
  reply?: { type?: string; time?: number };
  client: { ip: string; name?: string | null };
}

export const toQuery = (q: RawQuery): PiholeQuery => {
  const [verdict, why] = STATUS[q.status] ?? ["other", q.status.toLowerCase().replace(/_/g, " ")];
  const ms =
    q.reply?.time != null && q.reply.time >= 0 ? Math.round(q.reply.time * 10000) / 10 : undefined;
  return {
    id: q.id,
    at: new Date(q.time * 1000).toISOString(),
    domain: q.domain,
    type: q.type,
    client: { ip: q.client.ip, ...(q.client.name ? { name: q.client.name } : {}) },
    verdict,
    why,
    ...(ms !== undefined ? { ms } : {}),
  };
};

/** A filter the panel sends: blocked or allowed only, part of a domain, one device. */
export interface QueryFilter {
  show?: "all" | "blocked" | "allowed";
  domain?: string;
  client?: string;
  /** How many to skip (Show more). */
  start?: number;
}

/** The query log, newest first, 100 at a time. */
export async function piholeQueries(s: PiholeSession, f: QueryFilter): Promise<PiholeQueries> {
  const q = new URLSearchParams({ length: "100", start: String(Math.max(0, f.start ?? 0)) });
  if (f.show === "blocked") q.set("upstream", "blocklist");
  if (f.show === "allowed") q.set("upstream", "permitted");
  const domain = (f.domain ?? "").trim().toLowerCase();
  if (domain && /^[a-z0-9_.*-]{1,253}$/.test(domain))
    q.set("domain", domain.includes("*") ? domain : `*${domain}*`);
  if (f.client && /^[0-9a-f.:]{2,45}$/i.test(f.client)) q.set("client_ip", f.client);
  const [log, clients] = await Promise.all([
    s.call<{ queries: RawQuery[]; recordsFiltered: number }>("GET", `/queries?${q}`),
    s
      .call<{ clients: { name: string; ip: string }[] }>("GET", "/stats/top_clients?count=50")
      .catch(() => ({ clients: [] })),
  ]);
  return {
    queries: log.queries.map(toQuery),
    matching: log.recordsFiltered,
    clients: clients.clients.map((c) => ({ ip: c.ip, ...(c.name ? { name: c.name } : {}) })),
  };
}

/** Why Pi-hole blocks or allows one domain: the rules and lists that name it. */
export async function piholeCheck(s: PiholeSession, raw: string): Promise<PiholeCheck> {
  const domain = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9_.-]{1,253}$/.test(domain)) throw new PiholeError("Give one domain name.");
  const r = await s.call<{
    search: {
      domains: (RawDomain & { type: "allow" | "deny" })[];
      gravity: (RawList & { type: "block" | "allow" })[];
    };
  }>("GET", `/search/${encodeURIComponent(domain)}?partial=false&N=20`);
  const rules = r.search.domains.map((d) => ({ ...toRule(d), list: d.type }));
  const lists = r.search.gravity.map((l) => ({
    id: l.id,
    address: maskAddress(l.address),
    type: l.type,
    enabled: l.enabled,
  }));
  const on = <T extends { enabled: boolean }>(x: T[]) => x.filter((y) => y.enabled);
  const verdict = on(rules).some((x) => x.list === "allow")
    ? "Allowed: you allowed it, which wins over every blocklist."
    : on(rules).some((x) => x.list === "deny")
      ? "Blocked: you blocked it by name or by a pattern."
      : on(lists).some((l) => l.type === "allow")
        ? "Allowed by an allowlist."
        : on(lists).some((l) => l.type === "block")
          ? `Blocked by ${on(lists).filter((l) => l.type === "block").length === 1 ? "a blocklist" : "blocklists"}.`
          : "Not blocked: no list or rule names it.";
  return { domain, rules, lists, verdict };
}
