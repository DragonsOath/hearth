import { maskSecrets } from "./app-api";
import {
  PAGE_SIZE,
  ServarrReadError,
  connectionShape,
  fieldShape,
  list,
  needer,
  num,
  nums,
  obj,
  page,
  readSharedView,
  str,
  versionInfo,
  type Json,
  type ServarrGet,
} from "./servarr-panel";

/**
 * Prowlarr's native panel reads (native panels Phase 3): its indexers with how each is doing, one
 * indexer's settings, the indexer definitions Prowlarr can add, a manual search across indexers,
 * the apps it feeds with their sync profiles, its history and tags. Connections (download
 * clients, indexer proxies, notifications), System and the log are the shared Servarr reads on
 * Prowlarr's v1 API.
 *
 * Reading changes nothing; every change is a plan step, the same one Ember plans. Secrets never
 * leave the server: private fields come back only as "set" or "not set", and links that carry a
 * key (a search result's download link carries Prowlarr's own API key) are never returned.
 */

export const PROWLARR_VIEWS = [
  "indexers",
  "indexer",
  "definitions",
  "definition",
  "search",
  "apps",
  "history",
  "tags",
  "connections",
  "system",
  "logs",
] as const;
export type ProwlarrView = (typeof PROWLARR_VIEWS)[number];

export { ServarrReadError as ProwlarrReadError };

const V1 = "/api/v1";
/** A URL without anything that looks like a key in its query (passkey, apikey, token...). */
export function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()])
      if (/key|token|auth|sig|pass|rss|uid/i.test(k)) u.searchParams.set(k, "hidden");
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Whether a definition (or an indexer) needs a password, key or cookie to work. */
function needsSecret(fields: Json[]): boolean {
  return fields.some(
    (f) =>
      (typeof f.privacy === "string" && f.privacy !== "normal") ||
      f.type === "password" ||
      /cookie|passkey|apikey|api key|password|token/i.test(`${str(f.name)} ${str(f.label)}`),
  );
}

const categoriesOf = (caps: unknown) =>
  list(obj(caps).categories)
    .filter((c) => (num(c.id) ?? 0) < 100_000)
    .map((c) => str(c.name) ?? String(num(c.id)));

function definitionShape(d: Json) {
  const fields = list(d.fields);
  return {
    name: str(d.name) ?? str(d.definitionName) ?? "?",
    definition: str(d.definitionName) ?? str(d.implementation) ?? "",
    implementation: str(d.implementation) ?? "",
    description: str(d.description),
    privacy: str(d.privacy) ?? "public",
    protocol: str(d.protocol) ?? "torrent",
    language: str(d.language),
    needsSecret: needsSecret(fields),
  };
}

/** The search result rows the panel shows: never the download or magnet link. */
function resultShape(r: Json) {
  return {
    guid: str(r.guid) ?? "",
    indexerId: num(r.indexerId)!,
    indexer: str(r.indexer) ?? "?",
    title: str(r.title) ?? "?",
    size: num(r.size) ?? 0,
    age: num(r.age),
    ageHours: num(r.ageHours),
    published: str(r.publishDate),
    seeders: num(r.seeders),
    leechers: num(r.leechers),
    grabs: num(r.grabs),
    protocol: str(r.protocol) ?? "torrent",
    categories: list(r.categories)
      .map((c) => str(c.name))
      .filter((c): c is string => Boolean(c)),
    info: scrubUrl(str(r.infoUrl)),
    flags: list(r.indexerFlags).map((f) => (typeof f === "string" ? f : (str(obj(f).name) ?? ""))),
  };
}

const SEARCH_TYPES = ["search", "movie", "tvsearch", "music", "book"] as const;

export async function readProwlarrView(
  get: ServarrGet,
  view: ProwlarrView,
  q: Record<string, string | undefined>,
): Promise<Json> {
  const need = needer("prowlarr", get);
  const status = obj(await need(`${V1}/system/status`, "its version"));
  if (view === "connections" || view === "system" || view === "logs")
    return readSharedView("prowlarr", get, view, q, status);
  const meta = versionInfo(status, "prowlarr");
  const lookups = async () => {
    const [profiles, tags] = await Promise.all([
      need(`${V1}/appprofile`, "its sync profiles"),
      need(`${V1}/tag`, "its tags"),
    ]);
    return {
      appProfiles: list(profiles).map((p) => ({
        id: num(p.id)!,
        name: str(p.name) ?? "?",
        rss: p.enableRss === true,
        automatic: p.enableAutomaticSearch === true,
        interactive: p.enableInteractiveSearch === true,
        minimumSeeders: num(p.minimumSeeders) ?? 0,
      })),
      tags: list(tags).map((t) => ({ id: num(t.id)!, label: str(t.label) ?? "?" })),
    };
  };

  switch (view) {
    case "indexers": {
      const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [indexers, statuses, stats, proxies, look, clients] = await Promise.all([
        need(`${V1}/indexer`, "its indexers"),
        need(`${V1}/indexerstatus`, "its indexer status"),
        get(`${V1}/indexerstats?startDate=${encodeURIComponent(week)}`),
        get(`${V1}/indexerproxy`),
        lookups(),
        get(`${V1}/downloadclient`),
      ]);
      const byId = new Map(
        list(obj(stats.ok ? stats.data : {}).indexers).map((s) => [num(s.indexerId), s]),
      );
      const now = Date.now();
      return {
        meta,
        ...look,
        proxies: list(proxies.ok ? proxies.data : []).map((p) => ({
          id: num(p.id)!,
          name: str(p.name) ?? "?",
          tags: nums(p.tags),
        })),
        downloadClients: list(clients.ok ? clients.data : []).map((c) => ({
          id: num(c.id)!,
          name: str(c.name) ?? "?",
        })),
        indexers: list(indexers).map((i) => {
          const id = num(i.id)!;
          const st = list(statuses).find((s) => num(s.indexerId) === id);
          const till = str(st?.disabledTill);
          const paused = till && Date.parse(till) > now ? till : undefined;
          const s = byId.get(id);
          return {
            id,
            name: str(i.name) ?? "?",
            definition: str(i.definitionName) ?? str(i.implementation) ?? "",
            enabled: i.enable !== false,
            protocol: str(i.protocol) ?? "torrent",
            privacy: str(i.privacy) ?? "public",
            priority: num(i.priority) ?? 25,
            appProfileId: num(i.appProfileId),
            downloadClientId: num(i.downloadClientId) || undefined,
            tags: nums(i.tags),
            url: scrubUrl(str(list(i.indexerUrls)[0] as unknown) ?? undefined),
            categories: categoriesOf(i.capabilities),
            failing: i.enable !== false && Boolean(paused || st?.mostRecentFailure),
            pausedUntil: paused,
            lastFailure: str(st?.mostRecentFailure),
            queries: num(s?.numberOfQueries) ?? 0,
            grabs: num(s?.numberOfGrabs) ?? 0,
            failedQueries: num(s?.numberOfFailedQueries) ?? 0,
            failedGrabs: num(s?.numberOfFailedGrabs) ?? 0,
            avgMs: num(s?.averageResponseTime),
          };
        }),
      };
    }
    case "indexer": {
      const id = Number(q.id);
      if (!Number.isInteger(id) || id <= 0) throw new ServarrReadError("Say which indexer (id).");
      const [one, look, hist] = await Promise.all([
        need(`${V1}/indexer/${id}`, "the indexer"),
        lookups(),
        get(
          `${V1}/history?page=1&pageSize=20&sortKey=date&sortDirection=descending&indexerIds=${id}`,
        ),
      ]);
      const i = obj(one);
      return {
        meta,
        ...look,
        indexer: {
          ...connectionShape(i, "indexer"),
          definition: str(i.definitionName) ?? str(i.implementation) ?? "",
          description: str(i.description),
          privacy: str(i.privacy) ?? "public",
          appProfileId: num(i.appProfileId),
          urls: list(i.indexerUrls)
            .map((u) => scrubUrl(String(u)))
            .filter(Boolean),
          categories: categoriesOf(i.capabilities),
          supportsRss: i.supportsRss === true,
          supportsSearch: i.supportsSearch === true,
        },
        history: list(obj(hist.ok ? hist.data : {}).records).map(historyShape),
      };
    }
    case "definitions": {
      const all = list(await need(`${V1}/indexer/schema`, "its indexer definitions"));
      const term = (q.term ?? "").trim().toLowerCase();
      const privacy =
        q.privacy && /^(public|semiPrivate|private)$/.test(q.privacy) ? q.privacy : "";
      const protocol = q.protocol && /^(torrent|usenet)$/.test(q.protocol) ? q.protocol : "";
      const rows = all
        .map(definitionShape)
        .filter(
          (d) =>
            (!term ||
              d.name.toLowerCase().includes(term) ||
              (d.description ?? "").toLowerCase().includes(term)) &&
            (!privacy || d.privacy === privacy) &&
            (!protocol || d.protocol === protocol),
        );
      return { meta, total: all.length, matches: rows.length, definitions: rows.slice(0, 60) };
    }
    case "definition": {
      const name = (q.name ?? "").trim();
      if (!name) throw new ServarrReadError("Say which definition (name).");
      const [all, look] = await Promise.all([
        need(`${V1}/indexer/schema`, "its indexer definitions"),
        lookups(),
      ]);
      const d = list(all).find((x) => str(x.name) === name || str(x.definitionName) === name);
      if (!d) throw new ServarrReadError(`Prowlarr has no indexer definition called ${name}.`);
      return {
        meta,
        ...look,
        definition: {
          ...definitionShape(d),
          fields: list(d.fields).map((f) => ({
            ...fieldShape(f),
            advanced: f.advanced === true,
            ...(list(f.selectOptions).length
              ? {
                  options: list(f.selectOptions).map((o) => ({
                    value: o.value as unknown,
                    name: str(o.name) ?? String(o.value),
                  })),
                }
              : {}),
          })),
        },
      };
    }
    case "search": {
      const query = (q.query ?? "").trim().slice(0, 200);
      const type = (SEARCH_TYPES as readonly string[]).includes(q.type ?? "") ? q.type! : "search";
      const ids = (q.indexerIds ?? "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      const cats = (q.categories ?? "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      const look = await need(`${V1}/indexer`, "its indexers");
      const indexers = list(look).map((i) => ({
        id: num(i.id)!,
        name: str(i.name) ?? "?",
        enabled: i.enable !== false,
        protocol: str(i.protocol) ?? "torrent",
      }));
      if (!query) return { meta, indexers, query, results: [] };
      const params = new URLSearchParams({ query, type, limit: "100", offset: "0" });
      for (const id of ids) params.append("indexerIds", String(id));
      for (const c of cats) params.append("categories", String(c));
      const found = list(await need(`${V1}/search?${params.toString()}`, "search results"));
      return {
        meta,
        indexers,
        query,
        results: found.map(resultShape).sort((a, b) => (b.seeders ?? 0) - (a.seeders ?? 0)),
      };
    }
    case "apps": {
      const [apps, look, schema] = await Promise.all([
        need(`${V1}/applications`, "the apps it feeds"),
        lookups(),
        get(`${V1}/applications/schema`),
      ]);
      return {
        meta,
        ...look,
        apps: list(apps).map((a) => ({
          ...connectionShape(a, "application"),
          syncLevel: str(a.syncLevel) ?? "disabled",
        })),
        kinds: list(schema.ok ? schema.data : []).map((s) => str(s.implementation) ?? ""),
      };
    }
    case "history": {
      const id = Number(q.indexer);
      const filter = Number.isInteger(id) && id > 0 ? `&indexerIds=${id}` : "";
      // Prowlarr filters history by its event number.
      const EVENTS: Record<string, number> = {
        releaseGrabbed: 1,
        indexerQuery: 2,
        indexerRss: 3,
        indexerAuth: 4,
        indexerInfo: 5,
      };
      const event = q.event && EVENTS[q.event] ? `&eventType=${EVENTS[q.event]}` : "";
      const data = obj(
        await need(
          `${V1}/history?page=${page(q)}&pageSize=${PAGE_SIZE}&sortKey=date&sortDirection=descending${filter}${event}`,
          "its history",
        ),
      );
      return {
        meta,
        page: num(data.page) ?? 1,
        pageSize: PAGE_SIZE,
        total: num(data.totalRecords) ?? 0,
        records: list(data.records).map(historyShape),
      };
    }
    case "tags": {
      const tags = list(await need(`${V1}/tag/detail`, "its tags"));
      return {
        meta,
        tags: tags.map((t) => ({
          id: num(t.id)!,
          label: str(t.label) ?? "?",
          indexers: nums(t.indexerIds).length,
          apps: nums(t.applicationIds).length,
          proxies: nums(t.indexerProxyIds).length,
          notifications: nums(t.notificationIds).length,
          downloadClients: nums(t.downloadClientIds).length,
        })),
      };
    }
  }
}

function historyShape(h: Json) {
  const d = obj(maskSecrets(h.data));
  return {
    id: num(h.id)!,
    indexerId: num(h.indexerId),
    date: str(h.date),
    event: str(h.eventType) ?? "unknown",
    successful: h.successful !== false,
    query: str(d.query),
    title: str(d.grabTitle) ?? str(d.title),
    source: str(d.source),
    host: str(d.host),
    results: Number(d.queryResults ?? NaN) || undefined,
    elapsedMs: Number(d.elapsedTime ?? NaN) || undefined,
  };
}
