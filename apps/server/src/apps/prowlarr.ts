import type { AppActivity, AppIssue, AppReport } from "@dragon-control/core";
import { AppKeyError, AppUnreachableError, getJson, type Fetch } from "./http";
import { clock } from "../findings/analyzers/types";

/**
 * Prowlarr, read only: version, its own health messages, and indexer
 * failures. Only GET requests, with the API key from the vault in a header;
 * the key is never logged, stored elsewhere, or shown to the AI.
 */

interface HealthItem {
  source?: string;
  type?: string;
  message?: string;
  wikiUrl?: string;
}
interface Indexer {
  id: number;
  name: string;
  enable?: boolean;
  protocol?: string;
  tags?: number[];
  /** Only "baseUrl" is ever read from these; others can hold credentials and are ignored. */
  fields?: { name?: string; value?: unknown }[];
}
interface IndexerProxy {
  id: number;
  name: string;
  implementation?: string;
  tags?: number[];
}
interface Tag {
  id: number;
  label: string;
}
interface IndexerStatus {
  indexerId: number;
  disabledTill?: string;
  mostRecentFailure?: string;
  initialFailure?: string;
}
interface HistoryRecord {
  date?: string;
  eventType?: string;
  successful?: boolean;
  indexerId?: number;
  data?: { query?: string; grabTitle?: string; title?: string };
}

export { AppKeyError, AppUnreachableError, type Fetch };

const get = <T>(fetchImpl: Fetch, base: string, path: string, key: string) =>
  getJson<T>(fetchImpl, "Prowlarr", base, path, key);

export async function readProwlarr(
  base: string,
  key: string,
  fetchImpl: Fetch = fetch as unknown as Fetch,
  now = new Date(),
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const [status, health, indexers, statuses] = await Promise.all([
    get<{ version?: string }>(fetchImpl, base, "/api/v1/system/status", key),
    get<HealthItem[]>(fetchImpl, base, "/api/v1/health", key),
    get<Indexer[]>(fetchImpl, base, "/api/v1/indexer", key),
    get<IndexerStatus[]>(fetchImpl, base, "/api/v1/indexerstatus", key),
  ]);

  const issues: AppIssue[] = [];
  const names = new Map(indexers.map((i) => [i.id, i.name]));
  const enabled = indexers.filter((i) => i.enable !== false);
  let failing = 0;
  for (const s of statuses) {
    const indexer = indexers.find((i) => i.id === s.indexerId);
    if (indexer && indexer.enable === false) continue; // you switched it off
    const disabled = s.disabledTill && new Date(s.disabledTill) > now;
    if (!disabled && !s.mostRecentFailure) continue;
    failing++;
    issues.push({
      level: disabled ? "error" : "warning",
      key: `indexer:${s.indexerId}`,
      text: disabled
        ? `${names.get(s.indexerId) ?? `Indexer ${s.indexerId}`} is failing; Prowlarr paused it until ${clock(s.disabledTill!)}.`
        : `${names.get(s.indexerId) ?? `Indexer ${s.indexerId}`} failed recently (last at ${clock(s.mostRecentFailure!)}).`,
      since: s.initialFailure ?? s.mostRecentFailure,
    });
  }
  for (const h of health) {
    if (h.type !== "warning" && h.type !== "error") continue;
    // Prowlarr's own "indexers unavailable" notes repeat what the indexer list says.
    if (
      failing &&
      /indexer/i.test(h.source ?? "") &&
      /unavailable|failure/i.test(h.message ?? "")
    ) {
      continue;
    }
    issues.push({
      level: h.type === "error" ? "error" : "warning",
      key: `health:${h.source ?? "general"}`,
      text: h.message ?? "Prowlarr reports a problem.",
      link: h.wikiUrl,
    });
  }

  // Recent searches and grabs; optional (older Prowlarr versions answer differently).
  const history = await get<{ records?: HistoryRecord[] }>(
    fetchImpl,
    base,
    "/api/v1/history?page=1&pageSize=12&sortKey=date&sortDirection=descending",
    key,
  ).catch(() => ({ records: [] as HistoryRecord[] }));
  const activity: AppActivity[] = (history?.records ?? []).map((h) => {
    const who = h.indexerId !== undefined ? (names.get(h.indexerId) ?? "An indexer") : "Prowlarr";
    const what =
      h.eventType === "releaseGrabbed"
        ? `Grabbed${h.data?.grabTitle ? `: ${h.data.grabTitle}` : ""}`
        : h.eventType === "indexerRss"
          ? "RSS check"
          : h.eventType === "indexerAuth"
            ? "Signed in"
            : `Search${h.data?.query ? ` for "${h.data.query}"` : ""}`;
    return {
      ...(h.date ? { at: h.date } : {}),
      text: `${who}: ${what}${h.successful === false ? " (failed)" : ""}`,
      tone: h.successful === false ? "error" : undefined,
    };
  });
  // Which indexers go through a proxy such as FlareSolverr: a proxy applies to indexers sharing a tag.
  const [proxies, tags] = await Promise.all([
    get<IndexerProxy[]>(fetchImpl, base, "/api/v1/indexerProxy", key).catch(
      () => [] as IndexerProxy[],
    ),
    get<Tag[]>(fetchImpl, base, "/api/v1/tag", key).catch(() => [] as Tag[]),
  ]);
  const tagName = new Map((tags ?? []).map((t) => [t.id, t.label]));
  const proxyFor = (i: Indexer) =>
    (proxies ?? []).filter((p) => (p.tags ?? []).some((t) => (i.tags ?? []).includes(t)));
  const baseUrlOf = (i: Indexer) => {
    const v = i.fields?.find((f) => f.name === "baseUrl")?.value;
    return typeof v === "string" && v ? v : undefined;
  };
  const failingIds = new Set(
    issues.filter((i) => i.key.startsWith("indexer:")).map((i) => Number(i.key.slice(8))),
  );
  const connections = [
    ...indexers.map((i) => {
      const via = proxyFor(i).map((p) => p.name);
      const where = baseUrlOf(i);
      const notes = [
        i.enable === false ? "Switched off in Prowlarr" : failingIds.has(i.id) ? "Failing" : "",
        via.length ? `through ${via.join(", ")}` : "no proxy",
        where ? `address ${where}` : "",
      ].filter(Boolean);
      return {
        name: `${i.name}${i.protocol ? ` (${i.protocol})` : ""}`,
        ok: i.enable !== false && !failingIds.has(i.id),
        detail: notes.join("; "),
      };
    }),
    ...(proxies ?? []).map((p) => {
      const users = indexers.filter((i) => proxyFor(i).some((x) => x.id === p.id));
      const labels = (p.tags ?? []).map((t) => tagName.get(t) ?? String(t));
      return {
        name: `${p.name} (${p.implementation ?? "proxy"})`,
        ok: true,
        detail: `${labels.length ? `tag ${labels.join(", ")}; ` : "no tag, so no indexer uses it; "}used by ${
          users.length ? users.map((u) => u.name).join(", ") : "no indexer"
        }`,
      };
    }),
  ];

  return {
    activity,
    connections,
    app: "prowlarr",
    version: status.version,
    status: issues.some((i) => i.level === "error")
      ? "failing"
      : issues.length
        ? "attention"
        : "ok",
    issues,
    facts: [
      { label: "Indexers", value: `${enabled.length} enabled of ${indexers.length}` },
      { label: "Failing", value: String(failing) },
    ],
  };
}
