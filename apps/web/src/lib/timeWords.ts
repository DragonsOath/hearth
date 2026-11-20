/**
 * The home dashboard's written-out time (11-04): "Seven Thirteen" "in the Evening", with the
 * greeting above it. Pure helpers, in the home's own time zone, so they are tested without a clock.
 */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty"];

/** 1 to 59 in words: "Thirteen", "Twenty-Five". */
export function numberWords(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  const t = TENS[Math.floor(n / 10)] ?? "";
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

/** The hour and minute (0 to 23, 0 to 59) somewhere, by its time zone. */
export function clockParts(now: Date, timeZone?: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour") % 24, minute: get("minute") };
}

export interface TimeInWords {
  /** "Seven Thirteen", "Seven O'Clock", "Noon". */
  main: string;
  /** "in the Evening"; empty for noon and midnight. */
  part: string;
  /** "Good Evening". */
  greeting: string;
}

export function timeInWords(hour: number, minute: number): TimeInWords {
  const greeting =
    hour >= 5 && hour < 12
      ? "Good Morning"
      : hour >= 12 && hour < 17
        ? "Good Afternoon"
        : hour >= 17
          ? "Good Evening"
          : "Hello";
  if (minute === 0 && hour === 12) return { main: "Noon", part: "", greeting };
  if (minute === 0 && hour === 0) return { main: "Midnight", part: "", greeting };
  const h = numberWords(hour % 12 || 12);
  const m =
    minute === 0 ? "O'Clock" : minute < 10 ? `Oh ${numberWords(minute)}` : numberWords(minute);
  const part =
    hour >= 5 && hour < 12
      ? "in the Morning"
      : hour >= 12 && hour < 17
        ? "in the Afternoon"
        : hour >= 17 && hour < 21
          ? "in the Evening"
          : "at Night";
  return { main: `${h} ${m}`, part, greeting };
}

/** The same time as digits: "7:13 PM" or "19:13". */
export function digitalTime(hour: number, minute: number, cycle: "12" | "24"): string {
  const mm = String(minute).padStart(2, "0");
  if (cycle === "24") return `${String(hour).padStart(2, "0")}:${mm}`;
  return `${hour % 12 || 12}:${mm} ${hour < 12 ? "AM" : "PM"}`;
}
