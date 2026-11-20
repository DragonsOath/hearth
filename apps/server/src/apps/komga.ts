import type { AppIssue, AppReport, KomgaDashboard } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Komga, through its REST API with an administrator's API key from the vault (X-API-Key).
 * Checked against a throwaway gotson/komga 1.30.0.
 *
 * Komga keeps reading progress per person and does not hand one person's to another, so "reading
 * activity" here is who used Komga lately, from its own sign-in log (which also shows failed
 * sign-ins), and what was added. The key never leaves this file.
 */

export class KomgaError extends Error {}

export async function km<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  method: string,
  path: string,
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: { "X-API-Key": key, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `Komga did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401)
    throw new AppKeyError("Komga refused the API key. Check the key in the vault.");
  if (res.status === 403)
    throw new AppKeyError(
      "Komga says this key's user is not an administrator. Use an administrator's API key.",
    );
  if (!res.ok) {
    const text = (await res.text?.().catch(() => "")) ?? "";
    const said = /"message"\s*:\s*"([^"]{1,200})"/.exec(text)?.[1];
    throw new KomgaError(
      `Komga refused ${method} ${path.split("?")[0]}: ${redactLine(said ?? `answer ${res.status}`)}.`,
    );
  }
  const text = (await res.text?.()) ?? "";
  return (text ? JSON.parse(text) : undefined) as T;
}

type Page<T> = { content?: T[]; totalElements?: number };

interface RawLibrary {
  id: string;
  name: string;
  root: string;
  scanInterval?: string;
}
interface RawBook {
  id: string;
  name: string;
  seriesTitle?: string;
  created?: string;
  media?: { status?: string; comment?: string };
}
interface RawUser {
  id: string;
  email: string;
  roles?: string[];
}
interface RawActivity {
  email?: string;
  ip?: string;
  success?: boolean;
  dateTime?: string;
}
interface RawHistory {
  type?: string;
  timestamp?: string;
  properties?: Record<string, string>;
}

const SCAN_WORDS: Record<string, string> = {
  DISABLED: "off",
  HOURLY: "every hour",
  EVERY_6H: "every 6 hours",
  EVERY_12H: "every 12 hours",
  DAILY: "every day",
  WEEKLY: "every week",
};

const HISTORY_WORDS: Record<string, string> = {
  BookImported: "Book imported",
  BookConverted: "Book converted",
  BookFileDeleted: "Book file deleted",
  SeriesFolderDeleted: "Series folder deleted",
  DuplicatePageDeleted: "Duplicate page removed",
};

/** Komga's own reason for a book it could not read, in plainer words. */
export function unreadableWhy(status?: string, comment?: string): string {
  const c = (comment ?? "").trim();
  if (status === "UNSUPPORTED")
    return c ? `not a format Komga reads (${c})` : "not a format Komga reads";
  return c ? redactLine(c).slice(0, 200) : "Komga could not open it";
}

const total = (p: Page<unknown>) => p.totalElements ?? (p.content ?? []).length;

export async function komgaDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<KomgaDashboard> {
  const get = <T>(path: string) => km<T>(fetchImpl, base, key, "GET", path);
  const [
    info,
    libs,
    series,
    books,
    broken,
    latest,
    users,
    activity,
    history,
    readLists,
    collections,
  ] = await Promise.all([
    get<{ build?: { version?: string } }>("/actuator/info").catch(
      () => ({}) as { build?: { version?: string } },
    ),
    get<RawLibrary[]>("/api/v1/libraries"),
    get<Page<unknown>>("/api/v1/series?size=1"),
    get<Page<unknown>>("/api/v1/books?size=1"),
    get<Page<RawBook>>("/api/v1/books?media_status=ERROR&media_status=UNSUPPORTED&size=20"),
    get<Page<RawBook>>("/api/v1/books/latest?size=8"),
    get<RawUser[]>("/api/v2/users"),
    get<Page<RawActivity>>("/api/v2/users/authentication-activity?size=200&sort=dateTime,desc"),
    get<Page<RawHistory>>("/api/v1/history?size=10&sort=timestamp,desc").catch(
      () => ({ content: [] }) as Page<RawHistory>,
    ),
    get<Page<unknown>>("/api/v1/readlists?size=1").catch(() => ({ totalElements: 0 })),
    get<Page<unknown>>("/api/v1/collections?size=1").catch(() => ({ totalElements: 0 })),
  ]);
  const counts = await Promise.all(
    (libs ?? []).map((l) =>
      Promise.all([
        get<Page<unknown>>(`/api/v1/series?library_id=${encodeURIComponent(l.id)}&size=1`),
        get<Page<unknown>>(`/api/v1/books?library_id=${encodeURIComponent(l.id)}&size=1`),
      ]),
    ),
  );
  const events = activity.content ?? [];
  const lastOk = new Map<string, string>();
  for (const e of events)
    if (e.success && e.email && e.dateTime && !lastOk.has(e.email)) lastOk.set(e.email, e.dateTime);
  const dayAgo = Date.now() - 86_400_000;
  return {
    app: "komga",
    ...(info.build?.version ? { version: info.build.version } : {}),
    libraries: (libs ?? []).map((l, i) => ({
      id: l.id,
      name: l.name,
      root: l.root,
      series: total(counts[i]![0]),
      books: total(counts[i]![1]),
      scanEvery: SCAN_WORDS[l.scanInterval ?? ""] ?? (l.scanInterval ?? "").toLowerCase(),
    })),
    series: total(series),
    books: total(books),
    unreadable: (broken.content ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      series: b.seriesTitle ?? "",
      why: unreadableWhy(b.media?.status, b.media?.comment),
    })),
    unreadableCount: total(broken),
    latest: (latest.content ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      series: b.seriesTitle ?? "",
      added: b.created ?? "",
    })),
    users: (users ?? []).map((u) => ({
      id: u.id,
      email: u.email,
      admin: (u.roles ?? []).includes("ADMIN"),
      ...(lastOk.get(u.email) ? { lastSeen: lastOk.get(u.email)! } : {}),
    })),
    failedSignIns: events
      .filter((e) => e.success === false && e.dateTime && Date.parse(e.dateTime) > dayAgo)
      .slice(0, 20)
      .map((e) => ({
        email: e.email ?? "(unknown)",
        at: e.dateTime!,
        ...(e.ip ? { ip: e.ip } : {}),
      })),
    history: (history.content ?? []).map((h) => ({
      type: h.type ?? "",
      at: h.timestamp ?? "",
      text: `${HISTORY_WORDS[h.type ?? ""] ?? h.type ?? "Change"}${h.properties?.name ? `: ${h.properties.name}` : ""}`,
    })),
    readLists: total(readLists),
    collections: total(collections),
  };
}

const FAILED_WARN = 5;

export async function readKomga(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await komgaDashboard(fetchImpl, base, key);
  const issues: AppIssue[] = [];
  if (d.unreadableCount)
    issues.push({
      level: "warning",
      key: "unreadable",
      text: `Komga could not read ${d.unreadableCount === 1 ? `"${d.unreadable[0]!.name}"` : `${d.unreadableCount} books`}${d.unreadableCount === 1 ? `: ${d.unreadable[0]!.why}` : "."}`,
    });
  if (d.failedSignIns.length >= FAILED_WARN)
    issues.push({
      level: "warning",
      key: "failed-sign-ins",
      text: `${d.failedSignIns.length} sign-ins to Komga failed in the last day.`,
    });
  return {
    app: "komga",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Series", value: d.series.toLocaleString() },
      { label: "Books", value: d.books.toLocaleString() },
    ],
  };
}
