import type { AppReport, TraefikDashboard, TraefikRouter } from "@dragon-control/core";
import { AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Traefik, through its own API (/api, read only; usually api.insecure on port 8080 inside your
 * network, which takes no key). Checked against a throwaway traefik:v3 container (3.7.17).
 * Traefik has no API for changing its routes: they live in its files and container labels.
 *
 * Middlewares are read by name only: a basicAuth middleware's settings hold password hashes.
 */

export class TraefikError extends Error {}

async function get<T>(fetchImpl: Fetch, base: string, path: string): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, `/api${path}`), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Traefik did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 404)
    throw new TraefikError(
      "Traefik's API is not on at this address: turn it on (api.insecure=true, port 8080) and give Hearth that address.",
    );
  if (res.status === 401 || res.status === 403)
    throw new TraefikError(
      "Traefik's API asks for a password here: give Hearth the internal API address (port 8080) instead.",
    );
  if (!res.ok) throw new TraefikError(`Traefik answered ${res.status} for ${path}.`);
  return (await res.json()) as T;
}

interface RawRouter {
  name: string;
  provider: string;
  rule?: string;
  entryPoints?: string[];
  tls?: unknown;
  middlewares?: string[];
  service?: string;
  status?: string;
  error?: string[];
}

interface RawService {
  name: string;
  loadBalancer?: { servers?: { url?: string; address?: string }[] };
  serverStatus?: Record<string, string>;
}

/** The names a rule answers: every Host(`…`) and HostSNI(`…`) in it. */
export function hostsOf(rule = ""): string[] {
  const out: string[] = [];
  for (const m of rule.matchAll(/Host(?:SNI)?\(([^)]*)\)/g))
    for (const h of m[1]!.matchAll(/`([^`]+)`|"([^"]+)"/g)) out.push((h[1] ?? h[2])!.toLowerCase());
  return [...new Set(out)].filter((h) => h !== "*");
}

/** A service named without its provider ("radarr" in "radarr@file") is the router's provider's. */
const fullName = (service: string, provider: string) =>
  service.includes("@") ? service : `${service}@${provider}`;

export async function traefikDashboard(fetchImpl: Fetch, base: string): Promise<TraefikDashboard> {
  const [version, overview, routers, services, certs, entry] = await Promise.all([
    get<{ Version?: string }>(fetchImpl, base, "/version"),
    get<{ providers?: string[] }>(fetchImpl, base, "/overview"),
    get<RawRouter[]>(fetchImpl, base, "/http/routers?per_page=500"),
    get<RawService[]>(fetchImpl, base, "/http/services?per_page=500"),
    get<
      {
        sans?: string[];
        commonName?: string;
        issuerCN?: string;
        notAfter: string;
        status?: string;
      }[]
    >(fetchImpl, base, "/certificates").catch(() => []),
    get<{ name: string; address: string }[]>(fetchImpl, base, "/entrypoints").catch(() => []),
  ]);
  const byName = new Map(services.map((s) => [s.name, s]));
  const list: TraefikRouter[] = routers
    .filter((r) => r.provider !== "internal")
    .map((r) => {
      const s = r.service ? byName.get(fullName(r.service, r.provider)) : undefined;
      const servers = (s?.loadBalancer?.servers ?? []).map((x) => {
        const url = x.url ?? x.address ?? "";
        const st = s?.serverStatus?.[url];
        return { url, ...(st ? { up: st === "UP" } : {}) };
      });
      return {
        name: r.name,
        provider: r.provider,
        rule: r.rule ?? "",
        hosts: hostsOf(r.rule),
        entryPoints: r.entryPoints ?? [],
        tls: r.tls !== undefined && r.tls !== null,
        middlewares: r.middlewares ?? [],
        service: r.service ?? "",
        status: (r.status === "disabled"
          ? "disabled"
          : r.status === "warning"
            ? "warning"
            : "enabled") as TraefikRouter["status"],
        errors: (r.error ?? []).map((e) => e.slice(0, 300)),
        servers,
      };
    })
    .sort((a, b) => (a.hosts[0] ?? a.name).localeCompare(b.hosts[0] ?? b.name));
  return {
    app: "traefik",
    ...(version.Version ? { version: version.Version } : {}),
    providers: overview.providers ?? [],
    entryPoints: entry
      .filter((e) => e.name !== "traefik")
      .map((e) => ({ name: e.name, address: e.address })),
    routers: list,
    certificates: certs.map((c) => ({
      names: c.sans?.length ? c.sans : c.commonName ? [c.commonName] : [],
      issuer: c.issuerCN ?? "",
      expires: c.notAfter,
      status: c.status ?? "enabled",
    })),
    counts: {
      routers: list.length,
      errors: list.filter((r) => r.status === "disabled").length,
      warnings: list.filter((r) => r.status === "warning").length,
      servicesDown: new Set(
        list.filter((r) => r.servers.some((x) => x.up === false)).map((r) => r.service),
      ).size,
    },
  };
}

const DAY = 86_400_000;

/** The health check: routers refused, app servers down, certificates expiring or expired. */
export async function readTraefik(
  base: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await traefikDashboard(fetchImpl, base);
  const issues: AppReport["issues"] = [];
  const refused = d.routers.filter((r) => r.status === "disabled");
  if (refused.length)
    issues.push({
      level: "error",
      key: "routers-refused",
      text: `Traefik refused ${refused.length} ${refused.length === 1 ? "router" : "routers"}: ${refused.map((r) => r.hosts[0] ?? r.name).join(", ")}.`,
    });
  const down = d.routers.filter((r) => r.servers.length && r.servers.every((x) => x.up === false));
  if (down.length)
    issues.push({
      level: "warning",
      key: "apps-down",
      text: `Traefik sees the app behind ${down.map((r) => r.hosts[0] ?? r.name).join(", ")} down.`,
    });
  const now = Date.now();
  const expired = d.certificates.filter((c) => Date.parse(c.expires) < now);
  const soon = d.certificates.filter((c) => {
    const left = Date.parse(c.expires) - now;
    return left >= 0 && left < 14 * DAY;
  });
  if (expired.length)
    issues.push({
      level: "error",
      key: "certificates-expired",
      text: `The certificate for ${expired.map((c) => c.names[0]).join(", ")} has expired.`,
    });
  if (soon.length)
    issues.push({
      level: "warning",
      key: "certificates-expiring",
      text: `The certificate for ${soon.map((c) => c.names[0]).join(", ")} expires within two weeks.`,
    });
  return {
    app: "traefik",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Routers",
        value: `${d.counts.routers}${refused.length ? `, ${refused.length} refused` : ""}`,
      },
      { label: "Certificates", value: String(d.certificates.length) },
    ],
  };
}

/**
 * Sites and where they forward, for Hearth's "Open web UI" addresses (as Caddy's are read). Each
 * router's names, with its app server's address and port, and with its service's own name and
 * port too: a container's name, when Traefik reached it by its address on Docker's network.
 */
export async function traefikSites(
  fetchImpl: Fetch,
  base: string,
): Promise<{ site: string; upstream: string }[]> {
  const d = await traefikDashboard(fetchImpl, base);
  const out: { site: string; upstream: string }[] = [];
  for (const r of d.routers) {
    const site = r.hosts.find((h) => !h.includes("*") && !h.includes("{"));
    if (!site || r.status === "disabled") continue;
    for (const s of r.servers) {
      try {
        const u = new URL(s.url);
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        out.push({ site, upstream: `${u.hostname}:${port}`.toLowerCase() });
        const svc = r.service.split("@")[0]!;
        if (svc && svc !== u.hostname) out.push({ site, upstream: `${svc}:${port}`.toLowerCase() });
      } catch {
        /* A server address Traefik keeps that is not a URL is skipped. */
      }
    }
  }
  return out;
}
