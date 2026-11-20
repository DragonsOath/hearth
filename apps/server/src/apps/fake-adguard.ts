import type { Fetch } from "./http";
import type { RawFilter } from "./adguard";

/**
 * A stand-in AdGuard Home (port 3000) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install). It answers as a throwaway adguard/adguardhome container did (v0.107.80): HTTP Basic
 * sign-in with an e2e- password, status and protection, 24 hours of stats, filter lists (one with
 * a key in its address, which must never reach the panel, and which AdGuard repeats in its own
 * errors), custom rules, the query log, check host, DNS rewrites, blocked services, and the safe
 * browsing, parental and safe search switches.
 */

export interface FakeAdguard {
  fetch: Fetch;
  reset(): void;
  state(): {
    protection: { enabled: boolean; duration: number };
    filters: RawFilter[];
    allowlists: RawFilter[];
    rules: string[];
    rewrites: { domain: string; answer: string }[];
    services: string[];
    safety: { safebrowsing: boolean; parental: boolean; safesearch: boolean };
  };
}

export const FAKE_ADGUARD_KEYED_LIST = "https://lists.example.org/private.txt?key=e2e-LISTKEY";

const SERVICES = [
  { id: "tiktok", name: "TikTok", group_id: "social_network" },
  { id: "youtube", name: "YouTube", group_id: "streaming" },
  { id: "facebook", name: "Facebook", group_id: "social_network" },
  { id: "roblox", name: "Roblox", group_id: "gaming" },
];

/** What the stand-in's first filter list blocks. */
const LISTED = ["ads.example.com", "telemetry.example.net"];

export function fakeAdguard(): FakeAdguard {
  let protection = { enabled: true, duration: 0 };
  let filters: RawFilter[] = [];
  let allowlists: RawFilter[] = [];
  let rules: string[] = [];
  let rewrites: { domain: string; answer: string }[] = [];
  let services: string[] = [];
  let safety = { safebrowsing: false, parental: false, safesearch: false };
  let next = 10;
  const reset = () => {
    protection = { enabled: true, duration: 0 };
    filters = [
      {
        id: 1,
        name: "AdGuard DNS filter",
        url: "https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt",
        enabled: true,
        rules_count: 61204,
        last_updated: new Date(Date.now() - 5 * 3_600_000).toISOString(),
      },
      {
        id: 2,
        name: "Private list",
        url: FAKE_ADGUARD_KEYED_LIST,
        enabled: true,
        rules_count: 0,
        last_updated: "0001-01-01T00:00:00Z",
      },
    ];
    allowlists = [];
    rules = ["@@||s.youtube.com^"];
    rewrites = [{ domain: "plex.home", answer: "192.168.1.10" }];
    services = [];
    safety = { safebrowsing: false, parental: false, safesearch: false };
    next = 10;
  };
  reset();

  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
    text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
  });

  /** What AdGuard decides for a domain: your rules first, then blocked services, then lists. */
  const decide = (domain: string) => {
    const hit = (r: string) => {
      const m = r.match(/^(@@)?\|\|([^^]+)\^$/);
      return m && (domain === m[2] || domain.endsWith(`.${m[2]}`)) ? m : null;
    };
    const allow = rules.find((r) => r.startsWith("@@") && hit(r));
    if (allow)
      return { reason: "NotFilteredWhiteList", rules: [{ filter_list_id: 0, text: allow }] };
    const block = rules.find((r) => !r.startsWith("@@") && hit(r));
    if (block) return { reason: "FilteredBlackList", rules: [{ filter_list_id: 0, text: block }] };
    const svc = SERVICES.find((s) => services.includes(s.id) && domain.includes(s.id));
    if (svc)
      return {
        reason: "FilteredBlockedService",
        service_name: svc.id,
        rules: [{ filter_list_id: -2, text: `||${svc.id}.com^` }],
      };
    if (filters[0]!.enabled && LISTED.includes(domain))
      return { reason: "FilteredBlackList", rules: [{ filter_list_id: 1, text: `||${domain}^` }] };
    return { reason: "NotFilteredNotFound", rules: [] };
  };

  const log = () => {
    const now = Date.now();
    return [
      ["ads.example.com", "192.168.1.40", "living-room-tv"],
      ["www.example.org", "192.168.1.52", ""],
      ["telemetry.example.net", "192.168.1.40", "living-room-tv"],
      ["www.tiktok.com", "192.168.1.52", ""],
    ].map(([domain, ip, name], i) => ({
      time: new Date(now - i * 30_000).toISOString(),
      question: { name: domain!, type: "A", class: "IN" },
      client: ip!,
      client_info: { name: name! },
      elapsedMs: "1.25",
      cached: false,
      ...decide(domain!),
    }));
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    const auth = (init.headers as Record<string, string>).Authorization ?? "";
    const [, pass = ""] = Buffer.from(auth.replace(/^Basic /, ""), "base64")
      .toString()
      .split(":");
    if (!pass.startsWith("e2e-")) return reply(401, "");
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const all = () => [...filters, ...allowlists];
    const which = (w: unknown) => (w === true ? allowlists : filters);

    if (p === "/control/status")
      return reply(200, {
        version: "v0.107.80",
        protection_enabled: protection.enabled,
        protection_disabled_duration: protection.duration,
        running: true,
      });
    if (p === "/control/protection" && method === "POST") {
      protection = {
        enabled: body.enabled === true,
        duration: body.enabled === true ? 0 : Number(body.duration ?? 0),
      };
      return reply(200, "OK");
    }
    if (p === "/control/stats")
      return reply(200, {
        time_units: "hours",
        top_queried_domains: [{ "www.example.org": 3020 }],
        top_blocked_domains: [{ "ads.example.com": 1210 }, { "telemetry.example.net": 870 }],
        top_clients: [{ "192.168.1.40": 8120 }, { "192.168.1.52": 5210 }],
        dns_queries: Array.from({ length: 24 }, () => 1590),
        blocked_filtering: Array.from({ length: 24 }, () => 225),
        num_dns_queries: 38220,
        num_blocked_filtering: 5410,
        num_replaced_safebrowsing: 3,
        num_replaced_safesearch: 41,
        num_replaced_parental: 0,
        avg_processing_time: 0.0074,
      });
    if (p === "/control/filtering/status")
      return reply(200, {
        filters,
        whitelist_filters: allowlists.length ? allowlists : null,
        user_rules: rules,
        interval: 24,
        enabled: true,
      });
    if (p === "/control/filtering/set_rules") {
      rules = (body.rules as string[]).filter((r) => r !== "");
      return reply(200, "");
    }
    if (p === "/control/filtering/refresh") {
      let updated = 0;
      for (const f of filters)
        if (f.enabled && !f.url.includes("private")) {
          f.last_updated = new Date().toISOString();
          updated++;
        }
      return reply(200, { updated });
    }
    if (p === "/control/filtering/add_url") {
      const url = String(body.url);
      if (all().some((f) => f.url === url))
        return reply(400, `filter with URL ${url} already added`);
      if (url.includes("unreachable"))
        return reply(400, `Couldn't fetch filter from URL "${url}": no addresses`);
      which(body.whitelist).push({
        id: next++,
        name: String(body.name),
        url,
        enabled: true,
        rules_count: 12,
        last_updated: new Date().toISOString(),
      });
      return reply(200, `OK 12 rules`);
    }
    if (p === "/control/filtering/set_url") {
      const f = which(body.whitelist).find((x) => x.url === body.url);
      if (!f) return reply(400, "filter not found");
      const data = body.data as { name: string; url: string; enabled: boolean };
      Object.assign(f, { name: data.name, url: data.url, enabled: data.enabled });
      return reply(200, "");
    }
    if (p === "/control/filtering/remove_url") {
      const before = which(body.whitelist).length;
      if (body.whitelist === true) allowlists = allowlists.filter((x) => x.url !== body.url);
      else filters = filters.filter((x) => x.url !== body.url);
      return reply(200, `OK ${before - which(body.whitelist).length} rules`);
    }
    if (p === "/control/filtering/check_host")
      return reply(200, { ...decide(u.searchParams.get("name") ?? ""), cname: "", ip_addrs: null });
    if (p === "/control/querylog") {
      let rows = log();
      const status = u.searchParams.get("response_status");
      if (status === "blocked") rows = rows.filter((r) => r.reason.startsWith("Filtered"));
      if (status === "processed") rows = rows.filter((r) => r.reason.startsWith("NotFiltered"));
      const search = u.searchParams.get("search");
      if (search)
        rows = rows.filter((r) => r.question.name.includes(search) || r.client === search);
      return reply(200, { data: rows, oldest: rows.at(-1)?.time ?? "" });
    }
    if (p === "/control/rewrite/list")
      return reply(
        200,
        rewrites.map((r) => ({ ...r, enabled: true })),
      );
    if (p === "/control/rewrite/add") {
      if (!rewrites.some((r) => r.domain === body.domain && r.answer === body.answer))
        rewrites.push({ domain: String(body.domain), answer: String(body.answer) });
      return reply(200, "");
    }
    if (p === "/control/rewrite/delete") {
      rewrites = rewrites.filter((r) => !(r.domain === body.domain && r.answer === body.answer));
      return reply(200, "");
    }
    if (p === "/control/blocked_services/all") return reply(200, { blocked_services: SERVICES });
    if (p === "/control/blocked_services/get")
      return reply(200, { ids: services, schedule: { time_zone: "UTC" } });
    if (p === "/control/blocked_services/update") {
      services = body.ids as string[];
      return reply(200, "");
    }
    const sw = p.match(/^\/control\/(safebrowsing|parental)\/(status|enable|disable)$/);
    if (sw) {
      const key = sw[1] as "safebrowsing" | "parental";
      if (sw[2] !== "status") safety[key] = sw[2] === "enable";
      return reply(200, sw[2] === "status" ? { enabled: safety[key] } : "");
    }
    if (p === "/control/safesearch/status")
      return reply(200, { enabled: safety.safesearch, google: true, youtube: true, bing: true });
    if (p === "/control/safesearch/settings") {
      safety.safesearch = body.enabled === true;
      return reply(200, "");
    }
    return reply(404, "not found");
  };

  return {
    fetch: fetchImpl,
    reset,
    state: () => ({ protection, filters, allowlists, rules, rewrites, services, safety }),
  };
}
