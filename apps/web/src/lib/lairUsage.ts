/**
 * Which systems you open most in the Lair, so they sit at the front of the strip. Each open
 * adds a point, and points fade by half every two weeks, so what you use now outranks what you
 * used a lot months ago. Kept in this browser only.
 */
const KEY = "hearth-lair-usage";
const HALF_LIFE = 14 * 24 * 60 * 60 * 1000;

export type LairUsage = Record<string, { s: number; at: number }>;

export function readUsage(): LairUsage {
  try {
    const u = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return u && typeof u === "object" ? (u as LairUsage) : {};
  } catch {
    return {};
  }
}

export function scoreOf(usage: LairUsage, key: string, now = Date.now()): number {
  const u = usage[key];
  if (!u || typeof u.s !== "number" || typeof u.at !== "number") return 0;
  return u.s * 0.5 ** (Math.max(0, now - u.at) / HALF_LIFE);
}

export function addUse(usage: LairUsage, key: string, now = Date.now()): LairUsage {
  return { ...usage, [key]: { s: scoreOf(usage, key, now) + 1, at: now } };
}

export function recordUse(keys: string[], now = Date.now()) {
  if (!keys.length) return;
  let u = readUsage();
  for (const k of keys) u = addUse(u, k, now);
  try {
    localStorage.setItem(KEY, JSON.stringify(u));
  } catch {
    // Only the ordering is lost.
  }
}

/**
 * Two counts put together (this device's and the one kept on Hearth from every device, 11-16):
 * for each system the later count wins, so every device ends up ranking the same way.
 */
export function mergeUsage(a: LairUsage, b: LairUsage | undefined): LairUsage {
  const out: LairUsage = { ...a };
  for (const [k, v] of Object.entries(b ?? {}))
    if (!out[k] || (typeof v?.at === "number" && v.at >= out[k].at)) out[k] = v;
  return out;
}

/** Most used first; never-used ones keep alphabetical order after them. */
export function rankByUse<T extends { key: string; name: string }>(
  items: T[],
  usage: LairUsage,
  now = Date.now(),
): T[] {
  return [...items]
    .map((it) => ({ it, s: scoreOf(usage, it.key, now) }))
    .sort((a, b) => b.s - a.s || a.it.name.localeCompare(b.it.name))
    .map((x) => x.it);
}

/** The order you set by hand (Arrange), kept in this browser; absent means most used first. */
const ORDER_KEY = "hearth-lair-order";

export function readOrder(): string[] | undefined {
  try {
    const o = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "null") as unknown;
    return Array.isArray(o) && o.every((k) => typeof k === "string") ? o : undefined;
  } catch {
    return undefined;
  }
}

export function writeOrder(order: string[] | undefined) {
  try {
    if (order) localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    else localStorage.removeItem(ORDER_KEY);
  } catch {
    // Only the order is lost.
  }
}

/**
 * The strip's order: yours where you set one, with anything added since at the end (most used
 * first among those); otherwise most used first.
 */
export function arrange<T extends { key: string; name: string }>(
  items: T[],
  order: string[] | undefined,
  usage: LairUsage,
  now = Date.now(),
): T[] {
  const ranked = rankByUse(items, usage, now);
  if (!order?.length) return ranked;
  const at = new Map(order.map((k, i) => [k, i]));
  const placed = items.filter((x) => at.has(x.key)).sort((a, b) => at.get(a.key)! - at.get(b.key)!);
  return [...placed, ...ranked.filter((x) => !at.has(x.key))];
}

/** Moves one key a place earlier (-1) or later (+1) in an order. */
export function move(order: string[], key: string, by: -1 | 1): string[] {
  const i = order.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Puts one key at a position in an order (dragging it there in Arrange). */
export function moveTo(order: string[], key: string, index: number): string[] {
  const i = order.indexOf(key);
  if (i < 0) return order;
  const next = order.filter((k) => k !== key);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, key);
  return next;
}
