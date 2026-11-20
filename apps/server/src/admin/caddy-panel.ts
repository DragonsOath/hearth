import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import net from "node:net";
import { X509Certificate } from "node:crypto";

/**
 * Caddy's panel, read only (it is protected): every site, where it sends visitors, and how they
 * sign in, from Caddy's own running configuration (its admin API inside the container), plus each
 * certificate's expiry from the public certificate files. Only host names, upstream addresses,
 * and the kind of sign-in are kept: usernames, password hashes, headers, and keys never leave here.
 */

export interface CaddySite {
  hosts: string[];
  /** Where it sends visitors (host:port). */
  upstreams: string[];
  /** password: Caddy's own basic auth; sign-in service: forward auth through another app. */
  signIn: "none" | "password" | "sign-in service";
  /** The sign-in service's address, for forward auth. */
  signInVia?: string;
  /** Answers by itself (a redirect or a fixed reply) instead of sending visitors on. */
  fixed?: boolean;
  /** Serves files from this machine instead of sending visitors on. */
  files?: boolean;
}

type Json = Record<string, unknown>;
const asArr = (x: unknown): Json[] => (Array.isArray(x) ? (x as Json[]) : []);

/** Walks a route's handlers (and nested subroutes), collecting proxies and sign-in kinds. */
function walk(handlers: Json[], site: CaddySite) {
  for (const h of handlers) {
    const kind = h.handler;
    if (kind === "subroute") for (const r of asArr(h.routes)) walk(asArr(r.handle), site);
    else if (kind === "authentication") site.signIn = "password";
    else if (kind === "static_response") site.fixed = true;
    else if (kind === "file_server") site.files = true;
    else if (kind === "reverse_proxy") {
      const dials = asArr(h.upstreams)
        .map((u) => String(u.dial ?? ""))
        .filter(Boolean);
      // forward_auth: a proxy that only answers "may they come in?" (handle_response), not the site.
      if (h.handle_response) {
        site.signIn = "sign-in service";
        if (dials[0]) site.signInVia = dials[0];
      } else site.upstreams.push(...dials);
    }
  }
}

export function parseCaddyConfig(config: unknown): CaddySite[] {
  const servers = ((config as Json)?.apps as Json)?.http as Json | undefined;
  const sites: CaddySite[] = [];
  for (const srv of Object.values((servers?.servers as Record<string, Json>) ?? {})) {
    for (const route of asArr(srv.routes)) {
      const hosts = asArr(route.match).flatMap((m) =>
        Array.isArray(m.host) ? (m.host as string[]) : [],
      );
      if (!hosts.length) continue;
      const site: CaddySite = { hosts, upstreams: [], signIn: "none" };
      walk(asArr(route.handle), site);
      site.upstreams = [...new Set(site.upstreams)];
      sites.push(site);
    }
  }
  return sites.sort((a, b) => a.hosts[0]!.localeCompare(b.hosts[0]!));
}

/** A certificate file's names and expiry (public data). */
export function certExpiry(pem: string): { names: string[]; expires: string } | undefined {
  try {
    const c = new X509Certificate(pem);
    const names = (c.subjectAltName ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^DNS:/, ""))
      .filter(Boolean);
    return { names, expires: new Date(c.validTo).toISOString() };
  } catch {
    return undefined;
  }
}

/** Whether something answers at host:port at all (a TCP connection), within the time limit. */
export function probeLocal(dial: string, timeoutMs = 3000): Promise<boolean> {
  const i = dial.lastIndexOf(":");
  const host = dial.slice(0, i).replace(/^\[|\]$/g, "");
  const port = Number(dial.slice(i + 1));
  if (!host || !port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/**
 * Whether the site works through Caddy, the way a visitor reaches it: a request to Caddy's own
 * address with the site's name (so it does not depend on the router sending the name back home),
 * certificate checked. Any answer below 500 counts as working; 502 to 504 mean Caddy is up but the
 * app behind it is not. The certificate's expiry is read from the same connection: the one
 * visitors actually get, with no certificate file read.
 */
export function probeThroughCaddy(
  caddy: { host: string; port: number },
  site: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status?: number; why?: string; certExpires?: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: caddy.host,
        port: caddy.port,
        method: "HEAD",
        path: "/",
        servername: site,
        headers: { Host: site, "User-Agent": "Hearth" },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        const validTo = (res.socket as TLSSocket).getPeerCertificate?.()?.valid_to;
        const exp = validTo ? new Date(validTo) : undefined;
        const cert = exp && !Number.isNaN(exp.getTime()) ? { certExpires: exp.toISOString() } : {};
        resolve(
          status >= 500
            ? {
                ...cert,
                ok: false,
                status,
                why:
                  status >= 502 && status <= 504
                    ? "Caddy is up, but the app behind it is not answering"
                    : `answered ${status}`,
              }
            : { ...cert, ok: true, status },
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, why: "no answer in time" });
    });
    req.on("error", (e) =>
      resolve({
        ok: false,
        why: /certificate|cert/i.test(e.message)
          ? "its certificate is not valid"
          : e.message.slice(0, 120),
      }),
    );
    req.end();
  });
}

/** Caddy's own listening address from its configuration (":443" means this machine). */
export function caddyAddress(config: unknown): { host: string; port: number } {
  const servers = (((config as Json)?.apps as Json)?.http as Json | undefined)?.servers as
    Record<string, Json> | undefined;
  const listen = Object.values(servers ?? {})
    .flatMap((s) => (Array.isArray(s.listen) ? (s.listen as string[]) : []))
    .find((l) => /:443$/.test(l));
  const host = listen?.replace(/:443$/, "").replace(/^\[|\]$/g, "") || "127.0.0.1";
  return { host: host === "" ? "127.0.0.1" : host, port: 443 };
}

/** A site change from the Caddy panel's form, as exact edits to the Caddyfile. */
export interface SiteChange {
  op: "add" | "change" | "remove";
  site: string;
  /** host:port the site sends visitors to. */
  upstream?: string;
  /** Behind the shared sign-in snippet (`import login`), or open. Passwords stay Ember's job. */
  signIn?: "none" | "sign-in service";
}

const SITE_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const UPSTREAM = /^[a-z0-9.-]+:\d{1,5}$/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The block of one site: from "name {" at the start of a line to its closing "}" line. */
function blockOf(file: string, site: string): string | undefined {
  const m = new RegExp(
    String.raw`^${escapeRe(site)}(\s*,[^{\n]*)?\s*\{\n[\s\S]*?\n\}[ \t]*$`,
    "m",
  ).exec(file);
  return m?.[0];
}

/**
 * The edits for a change, in the style the file already uses (tabs, the two header_up lines,
 * `import login` for the shared sign-in). Throws a plain reason when the change does not fit.
 */
export function siteEdits(file: string, c: SiteChange): { find: string; replace: string }[] {
  const site = c.site.trim().toLowerCase();
  if (!SITE_NAME.test(site))
    throw new Error(`"${c.site}" is not a site name like photos.example.com.`);
  const existing = blockOf(file, site);
  const login = /^\(login\)\s*\{/m.test(file);
  if ((c.signIn ?? "none") === "sign-in service" && !login)
    throw new Error("This Caddyfile has no shared sign-in snippet (login) to use.");
  const block = (upstream: string, signIn: string) =>
    [
      `${site} {`,
      ...(signIn === "sign-in service" ? ["\timport login"] : []),
      `\treverse_proxy ${upstream} {`,
      "\t\theader_up X-Forwarded-For 127.0.0.1",
      "\t\theader_up X-Real-IP 127.0.0.1",
      "\t}",
      "}",
    ].join("\n");
  if (c.op === "add") {
    if (existing) throw new Error(`${site} is already in the Caddyfile; change it instead.`);
    if (!c.upstream || !UPSTREAM.test(c.upstream.trim()))
      throw new Error("Say where it goes, as an address and port like 192.168.1.10:8080.");
    // Appended after the file's last line: the find is the file's ending, which is unique.
    const tail = file.replace(/\s+$/, "").slice(-120);
    if (file.split(tail).length !== 2)
      throw new Error("The end of the Caddyfile is not unique enough to add after.");
    return [{ find: tail, replace: `${tail}\n\n${block(c.upstream.trim(), c.signIn ?? "none")}` }];
  }
  if (!existing) throw new Error(`${site} is not in the Caddyfile as its own block.`);
  if (c.op === "remove") {
    const withGap = file.includes(`\n\n${existing}`) ? `\n\n${existing}` : existing;
    return [{ find: withGap, replace: "" }];
  }
  let next = existing;
  if (c.upstream) {
    if (!UPSTREAM.test(c.upstream.trim()))
      throw new Error("Say where it goes, as an address and port like 192.168.1.10:8080.");
    if (!/^\treverse_proxy \S+/m.test(next))
      throw new Error(
        `${site} does not send visitors anywhere to change (it serves files or redirects).`,
      );
    const to = c.upstream.trim();
    next = next.replace(/^(\treverse_proxy )\S+/m, (_m, lead: string) => `${lead}${to}`);
  }
  if (c.signIn) {
    const has = /^\timport login$/m.test(next);
    if (c.signIn === "sign-in service" && !has) next = next.replace(/\{\n/, "{\n\timport login\n");
    if (c.signIn === "none" && has) next = next.replace(/^\timport login\n/m, "");
  }
  if (next === existing) throw new Error(`${site} already looks like that.`);
  return [{ find: existing, replace: next }];
}

/**
 * Caddy's running configuration from its admin API, with a plain GET. Not fetch(): fetch adds
 * browser headers (Sec-Fetch-Mode) without an Origin, and Caddy's origin check refuses those
 * with 403. A plain request is what curl sends, and Caddy answers it. Read only.
 */
export function readCaddyConfig(url: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      url,
      { timeout: timeoutMs, headers: { Accept: "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 0) !== 200)
            return reject(new Error(`Caddy's admin API answered ${res.statusCode}.`));
          try {
            resolve(JSON.parse(body) as unknown);
          } catch {
            reject(new Error("Caddy's admin API did not answer with its configuration."));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Caddy's admin API did not answer in time.")));
    req.on("error", reject);
  });
}
