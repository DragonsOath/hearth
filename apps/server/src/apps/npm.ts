import { createHash } from "node:crypto";
import type { AppReport, NpmDashboard, NpmHost } from "@dragon-control/core";
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
 * Nginx Proxy Manager, through its own API (/api), signed in with an email and password from the
 * vault: it trades them for a token (POST /api/tokens) that lasts a day, which Hearth keeps and
 * reuses until NPM refuses it. Checked against a throwaway jc21/nginx-proxy-manager container
 * (2.16.0).
 *
 * The password and token never leave this file. Some of NPM's answers carry secrets (an uploaded
 * certificate's key, access list passwords, the audit log's copies of them), so Hearth reads only
 * the fields it shows and never passes NPM's own objects through.
 */

export class NpmError extends Error {}

export interface NpmLogin {
  username: string;
  password: string;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

const TOKENS = new Map<string, { key: string; token: string }>();

/** Forget the tokens (tests). */
export function forgetNpmTokens() {
  TOKENS.clear();
}

const keyOf = (l: NpmLogin) =>
  createHash("sha256").update(`${l.username}\n${l.password}`).digest("hex");

export class NpmClient {
  private pending?: Promise<void>;

  constructor(
    private readonly base: string,
    private readonly login: NpmLogin,
    private readonly fetchImpl: Fetch,
  ) {}

  private async raw(method: Method, path: string, body: unknown, token?: string) {
    try {
      return await this.fetchImpl(joinUrl(this.base, `/api${path}`), {
        method,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `Nginx Proxy Manager did not answer at ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async signIn() {
    const res = await this.raw("POST", "/tokens", {
      identity: this.login.username,
      secret: this.login.password,
    });
    if (res.status === 429)
      throw new AppBlockedError("Nginx Proxy Manager is refusing sign-ins for now.");
    const r = (await res.json().catch(() => ({}))) as { token?: string };
    if (!res.ok || !r.token) {
      TOKENS.delete(this.base);
      throw new AppKeyError(
        "Nginx Proxy Manager refused the email or password. Check them in the vault.",
      );
    }
    TOKENS.set(this.base, { key: keyOf(this.login), token: r.token });
  }

  private token() {
    const t = TOKENS.get(this.base);
    return t && t.key === keyOf(this.login) ? t.token : undefined;
  }

  /** A call with Hearth's token, signing in (once, for every call waiting) when there is none or NPM refused it. */
  async call<T>(method: Method, path: string, body?: unknown): Promise<T> {
    if (!this.token()) {
      this.pending ??= this.signIn().finally(() => (this.pending = undefined));
      await this.pending;
    }
    let sent = this.token();
    let res = await this.raw(method, path, body, sent);
    if (res.status === 401) {
      if (this.token() === sent) {
        this.pending ??= this.signIn().finally(() => (this.pending = undefined));
        await this.pending;
      }
      sent = this.token();
      res = await this.raw(method, path, body, sent);
      if (res.status === 401)
        throw new AppKeyError("Nginx Proxy Manager refused Hearth's sign-in.");
    }
    const json = (await res.json().catch(() => undefined)) as
      { error?: { message?: string } } | undefined;
    if (res.status === 403)
      throw new NpmError(
        "That Nginx Proxy Manager user may not do that: give it the permission in NPM (Users).",
      );
    if (!res.ok)
      throw new NpmError(
        `Nginx Proxy Manager said: ${json?.error?.message ?? `${res.status} for ${path.split("?")[0]}`}`,
      );
    return json as T;
  }
}

export interface RawHost {
  id: number;
  domain_names: string[];
  forward_scheme: "http" | "https";
  forward_host: string;
  forward_port: number;
  enabled: boolean | number;
  certificate_id: number | string;
  ssl_forced: boolean | number;
  access_list_id: number;
  allow_websocket_upgrade: boolean | number;
  block_exploits: boolean | number;
  meta?: { nginx_online?: boolean; nginx_err?: string | null };
  certificate?: { id: number; nice_name: string; expires_on?: string } | null;
  access_list?: { id: number; name: string } | null;
}

/** NPM writes times as "2026-11-28 01:39:05" in UTC. */
export const npmTime = (t?: string | null) =>
  t
    ? new Date(`${t.replace(" ", "T")}${/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? "" : "Z"}`).toISOString()
    : undefined;

/** The first line nginx gave, without the file path inside NPM's container. */
const nginxError = (e: string) =>
  e
    .split("\n")[0]!
    .replace(/^nginx: \[emerg\]\s*/, "")
    .replace(/ in \/data\/nginx\/[^\s]+/, "")
    .slice(0, 200);

export const toHost = (h: RawHost): NpmHost => {
  const online = h.meta?.nginx_online !== false;
  return {
    id: h.id,
    domains: h.domain_names,
    forward: `${h.forward_scheme}://${h.forward_host}:${h.forward_port}`,
    forwardScheme: h.forward_scheme,
    forwardHost: h.forward_host,
    forwardPort: h.forward_port,
    enabled: Boolean(h.enabled),
    online,
    ...(!online && h.meta?.nginx_err ? { error: nginxError(h.meta.nginx_err) } : {}),
    ...(h.certificate
      ? {
          certificate: {
            id: h.certificate.id,
            name: h.certificate.nice_name,
            ...(npmTime(h.certificate.expires_on)
              ? { expires: npmTime(h.certificate.expires_on)! }
              : {}),
          },
        }
      : {}),
    sslForced: Boolean(h.ssl_forced),
    ...(h.access_list ? { accessList: h.access_list.name } : {}),
    websockets: Boolean(h.allow_websocket_upgrade),
    blockExploits: Boolean(h.block_exploits),
  };
};

interface RawCert {
  id: number;
  nice_name: string;
  domain_names: string[];
  provider: string;
  expires_on?: string;
  proxy_hosts?: { domain_names: string[] }[];
}

/** The panel's live read: hosts, certificates, the other kinds of site, and recent changes. */
export async function npmDashboard(c: NpmClient): Promise<NpmDashboard> {
  const [info, hosts, certs, redirs, streams, dead, lists, audit] = await Promise.all([
    c.call<{ version?: { major: number; minor: number; revision: number } }>("GET", "/"),
    c.call<RawHost[]>("GET", "/nginx/proxy-hosts?expand=certificate,access_list"),
    c.call<RawCert[]>("GET", "/nginx/certificates?expand=proxy_hosts").catch(() => [] as RawCert[]),
    c
      .call<
        {
          id: number;
          domain_names: string[];
          forward_scheme: string;
          forward_domain_name: string;
          enabled: boolean | number;
        }[]
      >("GET", "/nginx/redirection-hosts")
      .catch(() => []),
    c
      .call<
        {
          id: number;
          incoming_port: number;
          forwarding_host: string;
          forwarding_port: number;
          enabled: boolean | number;
        }[]
      >("GET", "/nginx/streams")
      .catch(() => []),
    c
      .call<{ id: number; domain_names: string[]; enabled: boolean | number }[]>(
        "GET",
        "/nginx/dead-hosts",
      )
      .catch(() => []),
    c.call<{ id: number; name: string }[]>("GET", "/nginx/access-lists").catch(() => []),
    c
      .call<
        {
          created_on: string;
          action: string;
          object_type: string;
          meta?: { domain_names?: string[]; nice_name?: string; name?: string; email?: string };
          user?: { name?: string };
        }[]
      >("GET", "/audit-log?expand=user")
      .catch(() => []),
  ]);
  const v = info.version;
  return {
    app: "npm",
    ...(v ? { version: `${v.major}.${v.minor}.${v.revision}` } : {}),
    hosts: hosts.map(toHost).sort((a, b) => (a.domains[0] ?? "").localeCompare(b.domains[0] ?? "")),
    certificates: certs.map((x) => ({
      id: x.id,
      name: x.nice_name || x.domain_names[0] || `Certificate ${x.id}`,
      domains: x.domain_names,
      provider: x.provider,
      ...(npmTime(x.expires_on) ? { expires: npmTime(x.expires_on)! } : {}),
      usedBy: (x.proxy_hosts ?? []).map((h) => h.domain_names[0] ?? "").filter(Boolean),
    })),
    redirections: redirs.map((r) => ({
      id: r.id,
      domains: r.domain_names,
      to: `${r.forward_scheme === "$scheme" ? "" : `${r.forward_scheme}://`}${r.forward_domain_name}`,
      enabled: Boolean(r.enabled),
    })),
    streams: streams.map((s) => ({
      id: s.id,
      incomingPort: s.incoming_port,
      forward: `${s.forwarding_host}:${s.forwarding_port}`,
      enabled: Boolean(s.enabled),
    })),
    deadHosts: dead.map((d) => ({
      id: d.id,
      domains: d.domain_names,
      enabled: Boolean(d.enabled),
    })),
    accessLists: lists.map((l) => ({ id: l.id, name: l.name })),
    // Only who, when, what and to which site: the audit log's copies of objects can hold secrets.
    activity: audit.slice(0, 15).map((a) => ({
      at: npmTime(a.created_on) ?? a.created_on,
      who: a.user?.name ?? "someone",
      action: a.action,
      what: `${a.object_type.replace(/-/g, " ")}${a.meta?.domain_names?.[0] ? ` ${a.meta.domain_names[0]}` : a.meta?.nice_name ? ` ${a.meta.nice_name}` : ""}`,
    })),
  };
}

const DAY = 86_400_000;

/** The health check: hosts nginx could not load, certificates expiring or expired. */
export async function readNpm(
  base: string,
  login: NpmLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await npmDashboard(new NpmClient(base, login, fetchImpl));
  const issues: AppReport["issues"] = [];
  const broken = d.hosts.filter((h) => h.enabled && !h.online);
  if (broken.length)
    issues.push({
      level: "error",
      key: "hosts-offline",
      text: `nginx could not load ${broken.map((h) => h.domains[0]).join(", ")}.`,
    });
  const now = Date.now();
  const used = d.certificates.filter((x) => x.usedBy.length && x.expires);
  const expired = used.filter((x) => Date.parse(x.expires!) < now);
  const soon = used.filter(
    (x) => Date.parse(x.expires!) >= now && Date.parse(x.expires!) - now < 14 * DAY,
  );
  if (expired.length)
    issues.push({
      level: "error",
      key: "certificates-expired",
      text: `${expired.map((x) => x.name).join(", ")} ${expired.length === 1 ? "has" : "have"} expired.`,
    });
  if (soon.length)
    issues.push({
      level: "warning",
      key: "certificates-expiring",
      text: `${soon.map((x) => x.name).join(", ")} ${soon.length === 1 ? "expires" : "expire"} within two weeks.`,
    });
  return {
    app: "npm",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Proxy hosts",
        value: `${d.hosts.filter((h) => h.enabled).length} on${broken.length ? `, ${broken.length} not loading` : ""}`,
      },
      { label: "Certificates", value: String(d.certificates.length) },
    ],
  };
}

/** Sites and where they forward, for Hearth's "Open web UI" addresses (as Caddy's are read). */
export async function npmSites(c: NpmClient): Promise<{ site: string; upstream: string }[]> {
  const hosts = await c.call<RawHost[]>("GET", "/nginx/proxy-hosts");
  return hosts
    .filter((h) => h.enabled && h.domain_names[0] && !h.domain_names[0].startsWith("*"))
    .map((h) => ({
      site: h.domain_names[0]!,
      upstream: `${h.forward_host}:${h.forward_port}`.toLowerCase(),
    }));
}
