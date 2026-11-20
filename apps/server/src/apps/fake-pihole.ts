import type { Fetch } from "./http";
import type { RawDomain, RawList } from "./pihole";

/**
 * A stand-in Pi-hole 6 (port 8053) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install). It answers as a throwaway pihole/pihole container did (Core v6.5, FTL v6.8): a session
 * id for an e2e- password, the summary, top blocked domains and clients, history in 10-minute
 * slots, blocking on or paused, lists (one of them carrying a key in its address, which must
 * never reach the panel), exact allow and deny domains, a blocklist update, and its warnings.
 */

export interface FakePihole {
  fetch: Fetch;
  reset(): void;
  /** What Pi-hole has now, for tests that read it back. */
  state(): {
    blocking: { enabled: boolean; timer: number | null };
    lists: RawList[];
    allow: RawDomain[];
    deny: RawDomain[];
    gravityAt: number;
    dns: { hosts: string[]; cnameRecords: string[] };
  };
  /** Ends every session, as Pi-hole does after its timeout or a restart. */
  endSessions(): void;
}

/** Domains the stand-in's first blocklist holds (what a search finds). */
const BLOCKED_BY_LIST = ["ads.example.com", "telemetry.example.net", "tracker.example.org"];

/** The last few minutes of lookups, newest first, as Pi-hole's query log has them. */
function queries() {
  const now = Date.now() / 1000;
  const rows: { domain: string; status: string; ip: string; name: string }[] = [
    { domain: "ads.example.com", status: "GRAVITY", ip: "192.168.1.40", name: "living-room-tv" },
    { domain: "www.example.org", status: "FORWARDED", ip: "192.168.1.52", name: "" },
    {
      domain: "telemetry.example.net",
      status: "GRAVITY",
      ip: "192.168.1.40",
      name: "living-room-tv",
    },
    { domain: "cdn.example.org", status: "CACHE", ip: "192.168.1.52", name: "" },
    { domain: "ads.doubleclick.net", status: "REGEX", ip: "192.168.1.52", name: "" },
  ];
  return rows.map((r, i) => ({
    id: 500 - i,
    time: now - i * 30,
    type: "A",
    status: r.status,
    dnssec: "UNKNOWN",
    domain: r.domain,
    upstream: r.status === "FORWARDED" ? "1.1.1.1#53" : null,
    reply: { type: r.status === "FORWARDED" || r.status === "CACHE" ? "IP" : "BLOB", time: 0.0012 },
    client: { ip: r.ip, name: r.name },
  }));
}

export const FAKE_PIHOLE_KEYED_LIST = "https://lists.example.org/private.txt?key=e2e-LISTKEY";

export function fakePihole(): FakePihole {
  const now = () => Math.floor(Date.now() / 1000);
  let sids = new Set<string>();
  let next = 1;
  let blocking = { enabled: true, timer: null as number | null };
  let gravityAt = now() - 3 * 86400;
  let lists: RawList[] = [];
  let allow: RawDomain[] = [];
  let deny: RawDomain[] = [];
  let dns: { hosts: string[]; cnameRecords: string[] } = { hosts: [], cnameRecords: [] };
  let listId = 10;
  const reset = () => {
    sids = new Set();
    blocking = { enabled: true, timer: null };
    gravityAt = now() - 3 * 86400;
    listId = 10;
    lists = [
      {
        id: 1,
        address: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
        type: "block",
        enabled: true,
        comment: "Migrated from /etc/pihole/adlists.list",
        groups: [0],
        number: 168420,
        status: 2,
        date_updated: gravityAt,
      },
      {
        id: 2,
        address: FAKE_PIHOLE_KEYED_LIST,
        type: "block",
        enabled: true,
        comment: "Private list",
        groups: [0],
        number: 0,
        status: 4,
        date_updated: 0,
      },
    ];
    allow = [
      {
        domain: "s.youtube.com",
        kind: "exact",
        type: "allow",
        comment: "Watch history",
        enabled: true,
        groups: [0],
      },
    ];
    deny = [];
    dns = { hosts: ["192.168.1.10 plex.home"], cnameRecords: [] };
  };
  reset();

  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });
  const err = (status: number, key: string, message: string, hint: string | null = null) =>
    reply(status, { error: { key, message, hint }, took: 0.0001 });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (p === "/api/auth" && method === "POST") {
      if (!String(body.password ?? "").startsWith("e2e-"))
        return reply(401, {
          session: {
            valid: false,
            totp: false,
            sid: null,
            validity: -1,
            message: "password incorrect",
          },
        });
      const sid = `sid-${next++}`;
      sids.add(sid);
      return reply(200, {
        session: {
          valid: true,
          totp: false,
          sid,
          csrf: "csrf",
          validity: 1800,
          message: "password correct",
        },
      });
    }
    const sid = (init.headers as Record<string, string>)["X-FTL-SID"];
    if (!sid || !sids.has(sid)) return err(401, "unauthorized", "Unauthorized");

    if (p === "/api/info/version")
      return reply(200, {
        version: {
          core: { local: { version: "v6.5" }, remote: { version: "v6.5" } },
          web: { local: { version: "v6.6.1" }, remote: { version: "v6.6.1" } },
          ftl: { local: { version: "v6.8" }, remote: { version: "v6.8.1" } },
          docker: { local: "2026.10.1", remote: "null" },
        },
      });
    if (p === "/api/stats/summary")
      return reply(200, {
        queries: {
          total: 41230,
          blocked: blocking.enabled ? 6112 : 6000,
          percent_blocked: 14.82,
          unique_domains: 2210,
          forwarded: 20100,
          cached: 15018,
        },
        clients: { active: 14, total: 19 },
        gravity: {
          domains_being_blocked: lists
            .filter((l) => l.enabled && l.type === "block")
            .reduce((n, l) => n + (l.number ?? 0), 0),
          last_update: gravityAt,
        },
      });
    if (p === "/api/dns/blocking") {
      if (method === "POST") {
        blocking = {
          enabled: body.blocking === true,
          timer: body.blocking === true ? null : ((body.timer as number | null) ?? null),
        };
      }
      return reply(200, {
        blocking: blocking.enabled ? "enabled" : "disabled",
        timer: blocking.timer,
      });
    }
    if (p === "/api/stats/top_domains")
      return reply(200, {
        domains: [
          { domain: "ads.example.com", count: 1420 },
          { domain: "telemetry.example.net", count: 980 },
          { domain: "tracker.example.org", count: 611 },
        ],
      });
    if (p === "/api/stats/top_clients")
      return reply(200, {
        clients: [
          { name: "living-room-tv", ip: "192.168.1.40", count: 9120 },
          { name: "", ip: "192.168.1.52", count: 6010 },
        ],
      });
    if (p === "/api/history") {
      const end = Math.floor(now() / 600) * 600;
      return reply(200, {
        history: Array.from({ length: 144 }, (_, i) => ({
          timestamp: end - (143 - i) * 600,
          total: 280,
          cached: 100,
          blocked: 40,
          forwarded: 140,
        })),
      });
    }
    if (p === "/api/info/messages")
      return reply(200, {
        messages: [
          {
            id: 3,
            timestamp: gravityAt,
            type: "LIST",
            plain: `List with ID 2 (${FAKE_PIHOLE_KEYED_LIST}) was inaccessible during last gravity run`,
            html: "",
          },
        ],
      });
    if (p === "/api/action/gravity" && method === "POST") {
      gravityAt = Math.max(now(), gravityAt + 1);
      for (const l of lists) {
        if (!l.enabled) continue;
        l.status = l.address.includes("private") ? 4 : 1;
        if (l.status === 1) l.date_updated = gravityAt;
      }
      return reply(200, "  [i] Neutrino emissions detected...\n  [✓] Done.\n");
    }
    if (p === "/api/lists" && method === "GET") return reply(200, { lists });
    if (p === "/api/lists" && method === "POST") {
      const type = u.searchParams.get("type");
      if (type !== "block" && type !== "allow")
        return err(
          400,
          "bad_request",
          'Invalid request: Specify type parameter (should be either "allow" or "block")',
        );
      if (lists.some((l) => l.address === body.address && l.type === type))
        return err(
          400,
          "database_error",
          "Could not add to gravity database",
          "The item is already present",
        );
      const l: RawList = {
        id: listId++,
        address: String(body.address),
        type,
        enabled: body.enabled !== false,
        comment: (body.comment as string | null) ?? null,
        groups: (body.groups as number[]) ?? [0],
        number: 0,
        status: 0,
        date_updated: 0,
      };
      lists.push(l);
      return reply(201, { lists: [l], processed: { errors: [], success: [{ item: l.address }] } });
    }
    const list = p.match(/^\/api\/lists\/(.+)$/);
    if (list) {
      const type = u.searchParams.get("type");
      const l = lists.find((x) => x.address === list[1] && x.type === type);
      if (!l) return err(404, "not_found", "Item not found");
      if (method === "PUT") {
        l.enabled = body.enabled === true;
        l.comment = (body.comment as string | null) ?? null;
        return reply(200, { lists: [l] });
      }
      if (method === "DELETE") {
        lists = lists.filter((x) => x !== l);
        return reply(204, undefined);
      }
      return reply(200, { lists: [l] });
    }
    const dom = p.match(/^\/api\/domains\/(allow|deny)(?:\/(exact|regex)(?:\/(.+))?)?$/);
    if (dom) {
      const type = dom[1] as "allow" | "deny";
      const kind = dom[2] as "exact" | "regex" | undefined;
      const name = dom[3];
      const all = () => (type === "allow" ? allow : deny);
      const which = () => all().filter((d) => !kind || d.kind === kind);
      if (method === "GET")
        return reply(200, { domains: name ? which().filter((d) => d.domain === name) : which() });
      if (method === "POST" && kind) {
        const d = String(body.domain);
        if (kind === "regex") {
          try {
            new RegExp(d);
          } catch {
            return err(400, "regex_error", "Regex validation failed", "Invalid pattern");
          }
        }
        if (which().some((x) => x.domain === d))
          return err(
            400,
            "database_error",
            "Could not add to gravity database",
            "The item is already present",
          );
        all().push({
          domain: d,
          kind,
          type,
          comment: (body.comment as string) ?? null,
          enabled: true,
          groups: [0],
        });
        return reply(201, { domains: [all().at(-1)] });
      }
      if (method === "DELETE" && kind) {
        if (!name || !which().some((x) => x.domain === name))
          return err(404, "not_found", "Item not found");
        const keep = (x: RawDomain) => !(x.domain === name && x.kind === kind);
        if (type === "allow") allow = allow.filter(keep);
        else deny = deny.filter(keep);
        return reply(204, undefined);
      }
    }
    const conf = p.match(/^\/api\/config\/dns\/(hosts|cnameRecords)(?:\/(.+))?$/);
    if (conf) {
      const key = conf[1] as "hosts" | "cnameRecords";
      const item = conf[2];
      const arr = dns[key];
      if (method === "GET") return reply(200, { config: { dns: { [key]: arr } } });
      if (method === "PUT" && item) {
        if (arr.includes(item))
          return err(400, "bad_request", "Item already present", "Uniqueness of items is enforced");
        arr.push(item);
        return reply(201, { config: { dns: { [key]: arr } } });
      }
      if (method === "DELETE" && item) {
        if (!arr.includes(item)) return err(404, "not_found", "Item not found");
        dns[key] = arr.filter((x) => x !== item);
        return reply(204, undefined);
      }
    }
    if (p === "/api/queries") {
      let rows = queries();
      const up = u.searchParams.get("upstream");
      if (up === "blocklist")
        rows = rows.filter((q) => q.status !== "FORWARDED" && q.status !== "CACHE");
      if (up === "permitted")
        rows = rows.filter((q) => q.status === "FORWARDED" || q.status === "CACHE");
      const dm = u.searchParams.get("domain");
      if (dm) {
        const re = new RegExp(`^${dm.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
        rows = rows.filter((q) => re.test(q.domain));
      }
      const ip = u.searchParams.get("client_ip");
      if (ip) rows = rows.filter((q) => q.client.ip === ip);
      const start = Number(u.searchParams.get("start") ?? 0);
      const length = Number(u.searchParams.get("length") ?? 100);
      return reply(200, {
        queries: rows.slice(start, start + length),
        recordsFiltered: rows.length,
        recordsTotal: queries().length,
      });
    }
    const search = p.match(/^\/api\/search\/(.+)$/);
    if (search) {
      const d = search[1]!;
      const rules = [...allow, ...deny].filter((x) =>
        x.kind === "regex" ? new RegExp(x.domain).test(d) : x.domain === d,
      );
      const inLists = BLOCKED_BY_LIST.includes(d) ? lists.filter((l) => l.id === 1) : [];
      return reply(200, { search: { domains: rules, gravity: inLists } });
    }
    return err(404, "not_found", "Not found");
  };

  return {
    fetch: fetchImpl,
    reset,
    state: () => ({ blocking, lists, allow, deny, gravityAt, dns }),
    endSessions: () => {
      sids = new Set();
    },
  };
}
