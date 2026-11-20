/**
 * The household board's dates (11-05): when a chore or reminder is due, and how many days to
 * a countdown, in the home's own time zone. Dates are plain YYYY-MM-DD strings, so a chore done
 * at 11 pm counts for that day wherever the server is.
 */

export interface Schedule {
  type: "week" | "every";
  days?: number[];
  n?: number;
  start?: string;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today in the home's time zone, as YYYY-MM-DD. */
export function todayIn(tz: string | undefined, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) =>
  new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);

/** Whole days from one date to another (negative when it has passed). */
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);

/** Whether a schedule falls on this day. */
export function fallsOn(s: Schedule, day: string): boolean {
  if (s.type === "week") return Boolean(s.days?.includes(weekday(day)));
  const n = Math.max(1, s.n ?? 1);
  const from = s.start ?? day;
  const k = daysBetween(from, day);
  return k >= 0 && k % n === 0;
}

/** The next day on or after this one that the schedule falls on (within a year). */
export function nextOn(s: Schedule, day: string): string | undefined {
  for (let i = 0; i <= 366; i++) {
    const d = addDays(day, i);
    if (fallsOn(s, d)) return d;
  }
  return undefined;
}

/**
 * Where a chore or reminder stands today: due (today, not done yet), done today, or next on some
 * later day. A chore missed on an earlier day stays due ("late") until it is done.
 */
export function standing(
  task: { schedule: Schedule; done: string[] },
  today: string,
  /** The day it was put on the board: nothing before it is late. */
  added?: string,
): { state: "due" | "late" | "done" | "later"; next?: string } {
  if (task.done.includes(today)) return { state: "done" };
  if (fallsOn(task.schedule, today)) return { state: "due" };
  // The last day it fell on in the past week or so: was it done?
  const look = task.schedule.type === "every" ? Math.min(task.schedule.n ?? 1, 31) : 7;
  for (let i = 1; i <= look; i++) {
    const d = addDays(today, -i);
    if (added && d < added) break;
    if (fallsOn(task.schedule, d)) {
      if (!task.done.some((x) => x >= d)) return { state: "late" };
      break;
    }
  }
  const next = nextOn(task.schedule, addDays(today, 1));
  return { state: "later", ...(next ? { next } : {}) };
}

/** "Every Mon, Wed and Fri", "Every 3 days", "Every day". */
export function scheduleWords(s: Schedule): string {
  if (s.type === "every")
    return s.n === 1 ? "Every day" : s.n === 7 ? "Every week" : `Every ${s.n} days`;
  const days = [...(s.days ?? [])].sort();
  if (days.length === 7) return "Every day";
  const names = days.map((d) => WEEKDAYS[d]);
  return `Every ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}`;
}
