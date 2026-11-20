/**
 * Briefs and watches (Talome Gap Plan, item 3, 2026-11-13): things the owner asks for in plain
 * words, such as "every morning at 7, send me a server summary" or "tell me if a disk goes over
 * 90%". They only read and tell: a brief never changes anything on a system. Anything that would
 * is still an approved plan.
 */

/** Days of the week, 0 = Sunday (as Date.getDay()). */
export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type BriefWhat =
  /** A server summary on a schedule. */
  | { kind: "summary"; days: WeekDay[]; time: string }
  /** A disk (or any of them) goes over a share of its space. */
  | { kind: "disk"; percent: number; volumeId?: string }
  /** A service stops answering. */
  | { kind: "service-down"; serviceId: string }
  /** A machine goes offline (or any of them). */
  | { kind: "host-offline"; hostId?: string };

export interface Brief {
  id: string;
  /** The owner's own words, or a plain name made from what it does. */
  name: string;
  what: BriefWhat;
  /** Notification channels it goes to. */
  channels: string[];
  enabled: boolean;
  createdAt: string;
  createdBy: "owner" | "ember";
  /** When it last went out. */
  lastSentAt?: string;
  /** A summary: the local day it last went out (YYYY-MM-DD), so it goes once a day. */
  sentFor?: string;
  /** A watch that is tripped right now (told once until it clears). */
  tripped?: string[];
}

export const BRIEF_LIMIT = 40;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "07:00", "19:30": a 24-hour local time. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "7:00 AM" from "07:00". */
export function clockLabel(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "every day", "weekdays", "weekends", "Mon, Wed and Fri". */
export function daysLabel(days: readonly WeekDay[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 7) return "every day";
  if (set.join() === "1,2,3,4,5") return "weekdays";
  if (set.join() === "0,6") return "weekends";
  const names = set.map((d) => DAY_NAMES[d]);
  return names.length <= 1
    ? `every ${names[0] ?? "day"}`
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What a brief does, in one plain sentence (names filled in by the caller when it knows them). */
export function describeBrief(
  what: BriefWhat,
  names: { volume?: string; service?: string; host?: string } = {},
): string {
  switch (what.kind) {
    case "summary":
      return `A server summary, ${daysLabel(what.days)} at ${clockLabel(what.time)}.`;
    case "disk":
      return `Tell me when ${names.volume ?? "any disk"} goes over ${what.percent}% full.`;
    case "service-down":
      return `Tell me if ${names.service ?? "this service"} stops answering.`;
    case "host-offline":
      return `Tell me if ${names.host ?? "any machine"} goes offline.`;
  }
}
