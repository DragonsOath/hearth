/**
 * Space over time for one volume, from Hearth's dated daily readings. The rate is a least-squares
 * fit over the readings in the window (by their dates, so a missing day is a gap, not a jump), and
 * the forecast is only given when there is enough to say it honestly.
 */

export interface Reading {
  day: string;
  usedTb: number;
}

export interface Trend {
  /** Change per day in TB (negative when space is being freed). */
  perDay?: number;
  /** Days of readings the rate is based on (first to last). */
  spanDays: number;
  /** Days until full at this rate, when growing. */
  fullInDays?: number;
  /** The plain sentence the chart shows. */
  words: string;
  /** Attention: nearly full now, or full within a month at this rate. */
  tone: "fine" | "watch" | "alert";
}

const DAY = 86_400_000;
const at = (day: string) => Date.parse(`${day}T00:00:00Z`);

export function trend(history: Reading[], totalTb: number, usedTb: number): Trend {
  const pts = [...history].sort((a, b) => a.day.localeCompare(b.day));
  const usedPct = totalTb > 0 ? (usedTb / totalTb) * 100 : 0;
  const nearlyFull = usedPct >= 90;
  if (pts.length < 3) {
    return {
      spanDays: 0,
      words:
        pts.length === 0
          ? "No readings yet. Hearth records one a day."
          : `${pts.length} reading${pts.length === 1 ? "" : "s"} so far; a trend needs at least three days.`,
      tone: nearlyFull ? "alert" : "fine",
    };
  }
  const x0 = at(pts[0]!.day);
  const xs = pts.map((p) => (at(p.day) - x0) / DAY);
  const ys = pts.map((p) => p.usedTb);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const spanDays = Math.round(xs[n - 1]!);
  if (sxx === 0) return { spanDays, words: "All readings are from one day.", tone: "fine" };
  const perDay = sxy / sxx;
  const free = Math.max(0, totalTb - usedTb);
  // Under about 1 GB a day is steady for a multi-terabyte drive.
  if (Math.abs(perDay) < 0.001)
    return {
      perDay,
      spanDays,
      words: `Steady over ${spanDays} days.`,
      tone: nearlyFull ? "alert" : "fine",
    };
  if (perDay < 0)
    return {
      perDay,
      spanDays,
      words: `Space is being freed: about ${gb(-perDay)} a day over ${spanDays} days.`,
      tone: nearlyFull ? "watch" : "fine",
    };
  const fullInDays = Math.round(free / perDay);
  return {
    perDay,
    spanDays,
    fullInDays,
    words: `Growing about ${gb(perDay)} a day over ${spanDays} days: full in about ${days(fullInDays)} at this rate.`,
    tone: nearlyFull || fullInDays <= 30 ? "alert" : fullInDays <= 90 ? "watch" : "fine",
  };
}

const gb = (tb: number) => (tb >= 1 ? `${tb.toFixed(1)} TB` : `${Math.round(tb * 1000)} GB`);
const days = (d: number) =>
  d > 730 ? `${Math.round(d / 365)} years` : d > 60 ? `${Math.round(d / 30)} months` : `${d} days`;
