import type { FindingSource } from "@dragon-control/core";
import type { DbHandle } from "../../db/client";
import type { AnalyzerResult } from "../store";

/**
 * An analyzer looks at one part of the homelab and reports what it sees as finding drafts,
 * plus what it was able to look at. It never changes anything. Each one is small and reusable:
 * findings come from evidence it actually read, and anything it could not read is reported as
 * a gap (status "partial" or "unavailable"), never as healthy.
 */
export interface Analyzer {
  id: string;
  source: FindingSource;
  /** Shown in "What Hearth can see". */
  label: string;
  /** How often it runs (the monitoring pass calls it when due). */
  intervalMs: number;
  run(ctx: AnalyzerContext): Promise<AnalyzerResult>;
}

export interface AnalyzerContext {
  handle: DbHandle;
  now: Date;
  environment: "demo" | "real" | undefined;
  /** What this analyzer kept from its last run. */
  memo: unknown;
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** "3 days", "5 hours", "12 minutes". */
export function duration(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * A time as people say it, in this machine's own time zone (the owner, 11-13: "plain local
 * times"): "4:17 PM", "4:17 PM tomorrow", "9:02 AM yesterday", "Nov 20, 4:17 PM".
 */
export function clock(at: string | number | Date, now: Date = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / DAY);
  if (diff === 0) return time;
  if (diff === 1) return `${time} tomorrow`;
  if (diff === -1) return `${time} yesterday`;
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `${date}, ${time}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
