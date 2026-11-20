import type { LogRange } from "./tools";

/**
 * A log read with a time window and an optional text filter. Docker selects the
 * window itself, Hearth scans at most SCAN_LINES of it, redacts, filters,
 * and returns the latest `limit` lines. Nothing is stored or copied anywhere.
 */
export interface LogQuery {
  /** A time ("2026-10-09T12:00:00Z") or how long ago ("90m", "6h", "3d"). */
  since?: string;
  /** Same forms as since; default now. */
  until?: string;
  /** Plain text, case-insensitive, matched after secrets are hidden. Not a pattern. */
  filter?: string;
  /** Lines to return, default 200, at most MAX_LIMIT. */
  limit?: number;
}

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 200;
/** Lines of the window read from Docker before filtering: bounds the work, not the window. */
export const SCAN_LINES = 5000;
/** How far back a window may start: Docker keeps what its log driver keeps, this bounds the ask. */
export const MAX_DAYS = 30;
const MAX_FILTER = 100;

export interface PlannedLogQuery {
  range: LogRange;
  filter?: string;
  limit: number;
  /** Human words for the window, for the answer's header. */
  window: string;
}

/** "90m", "6h", "3d", "45s" or an ISO time, to Unix seconds. */
export function parseWhen(value: string, now: number): number {
  const v = value.trim();
  const rel = /^(\d{1,5})\s*(s|m|h|d)$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[rel[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
    return now - n * unit;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    throw new Error(
      `"${v}" is not a time. Use a time like 2026-10-09T12:00:00Z or how long ago, like 6h.`,
    );
  }
  return t / 1000;
}

const words = (s: number) =>
  new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Checks and bounds a query. Throws a plain sentence when it cannot be read as asked. */
export function planLogQuery(q: LogQuery, now = Date.now() / 1000): PlannedLogQuery {
  const until = q.until ? parseWhen(q.until, now) : undefined;
  let since = q.since ? parseWhen(q.since, now) : undefined;
  if (since !== undefined && until !== undefined && since >= until) {
    throw new Error("The start of the window must be before its end.");
  }
  const oldest = now - MAX_DAYS * 86400;
  const clipped = since !== undefined && since < oldest;
  if (clipped) since = oldest;
  const filter = q.filter?.trim() ? q.filter.trim().slice(0, MAX_FILTER) : undefined;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? DEFAULT_LIMIT)));
  const window =
    since !== undefined
      ? `${words(since)} to ${until !== undefined ? words(until) : "now"}${clipped ? ` (start moved to the ${MAX_DAYS}-day limit)` : ""}`
      : until !== undefined
        ? `up to ${words(until)}`
        : "the latest lines";
  return {
    range: { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) },
    ...(filter ? { filter } : {}),
    limit,
    window,
  };
}

/** Filters the redacted lines and keeps the latest `limit`, with a header saying what is shown. */
export function shapeLogLines(lines: string[], plan: PlannedLogQuery): string[] {
  const needle = plan.filter?.toLowerCase();
  const matched = needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;
  const shown = matched.slice(-plan.limit);
  const parts = [
    `${lines.length} lines in ${plan.window}`,
    ...(plan.filter ? [`${matched.length} containing "${plan.filter}"`] : []),
    `showing ${shown.length === matched.length ? "all" : `the latest ${shown.length}`}`,
  ];
  const capped =
    lines.length >= SCAN_LINES
      ? [
          `(Only the latest ${SCAN_LINES} lines of this window were read; narrow it to see earlier ones.)`,
        ]
      : [];
  return [`(${parts.join(", ")})`, ...capped, ...shown];
}
