import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Runner } from "../admin/host";

/**
 * Your reverse proxy's addresses for your systems ("Open web UI" should go to
 * radarr.example.com, not the host's IP and port). Read from Caddy's own configuration: each site
 * and where it sends traffic, matched to a system by that address. Read only.
 */

export interface ProxySite {
  /** The site's first address, e.g. radarr.example.com. */
  site: string;
  /** Where it forwards, e.g. 192.168.1.10:7878. */
  upstream: string;
}

/** Sites and their first reverse_proxy target, from a Caddyfile. Snippets and global blocks are skipped. */
export function parseCaddyfile(text: string): ProxySite[] {
  const out: ProxySite[] = [];
  const lines = text.split(/\r?\n/);
  let depth = 0;
  let names: string[] = [];
  let pending: string[] = [];
  let found = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (depth === 0) {
      // Site addresses, possibly over several lines ending with commas, then "{".
      const head = line.replace(/\{$/, "").trim();
      const parts = head
        .split(/[,\s]+/)
        .map((p) => p.trim())
        .filter(Boolean);
      pending.push(...parts);
      if (line.endsWith("{")) {
        names = pending.filter((n) => /^(https?:\/\/)?[a-z0-9*.-]+\.[a-z]{2,}(:\d+)?$/i.test(n));
        pending = [];
        found = false;
        depth = 1;
      } else if (!line.endsWith(",")) pending = [];
      continue;
    }
    if (line.endsWith("{")) depth++;
    if (line.startsWith("}")) {
      depth--;
      continue;
    }
    if (!found && names.length) {
      const m = /^reverse_proxy\s+(?:\S*\s+)?(?:https?:\/\/)?([a-z0-9._-]+:\d+)/i.exec(line);
      if (m) {
        found = true;
        const site = names[0]!.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
        if (!site.startsWith("*")) out.push({ site, upstream: m[1]!.toLowerCase() });
      }
    }
  }
  return out;
}

/** The host and port a system's own address points at ("http://192.168.1.10:7878"). */
function hostPort(url: string): { host: string; port: string } | undefined {
  try {
    const u = new URL(url);
    return {
      host: u.hostname.toLowerCase(),
      port: u.port || (u.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return undefined;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

/** Which proxy site belongs to which system: same port, and the same host (or this machine). */
export function matchSites(
  sites: ProxySite[],
  services: { id: string; localUrl: string | null; checkTarget?: string | null }[],
  hostIps: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const s of services) {
    const own = s.localUrl ? hostPort(s.localUrl) : undefined;
    if (!own) continue;
    const container = s.checkTarget?.startsWith("container:") ? s.checkTarget.slice(10) : undefined;
    const site = sites.find((p) => {
      const [host, port] = p.upstream.split(":");
      if (port !== own.port) return false;
      const local = (h: string) => LOOPBACK.has(h) || hostIps.includes(h);
      return host === own.host || (local(host!) && local(own.host)) || host === container;
    });
    if (site) result.set(s.id, site.site);
  }
  return result;
}

/** Where Caddy's configuration is: DC_CADDYFILE, or the file mounted into a running Caddy container. */
export async function findCaddyfile(
  run: Runner,
  mountsOf: (c: string) => Promise<{ source: string; destination: string }[]>,
): Promise<string | undefined> {
  if (process.env.DC_CADDYFILE) return process.env.DC_CADDYFILE;
  const r = await run("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"], 20_000).catch(
    () => undefined,
  );
  for (const line of r?.out.split("\n") ?? []) {
    const [name, image] = line.split("\t");
    if (!name || !/caddy/i.test(`${name} ${image ?? ""}`)) continue;
    for (const m of await mountsOf(name).catch(() => [])) {
      if (m.destination === "/etc/caddy/Caddyfile") return m.source;
      if (m.destination === "/etc/caddy") return path.posix.join(m.source, "Caddyfile");
    }
  }
  return undefined;
}

export async function readProxySites(file: string): Promise<ProxySite[]> {
  return parseCaddyfile(await readFile(file, "utf8"));
}
