/**
 * Forgiving title search (11-07, the Forge's pick sheets): "hot tube time machine",
 * "groundhogs day" and "dum and dumber" still find the film. Text is folded (case, accents,
 * punctuation, "&", a leading "the/a/an"), then each typed word is matched to the title's
 * words exactly, by prefix, or within a small edit distance (a typo, a missing or extra letter,
 * two letters swapped, a plural "s").
 */

/** Lower case, accents and punctuation folded, "&" as "and", a leading article dropped. */
export function foldTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

/** Damerau-Levenshtein (optimal string alignment) distance, stopping early past `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]!;
    prev = cur;
  }
  return prev[b.length]!;
}

/** How close a typed word is to a title word: 1 exact, less for prefixes and typos, 0 none. */
function wordScore(q: string, w: string): number {
  if (q === w) return 1;
  if (w.startsWith(q) && q.length >= 2) return 0.85;
  if (q.endsWith("s") && q.slice(0, -1) === w) return 0.9;
  if (w.endsWith("s") && w.slice(0, -1) === q) return 0.9;
  if (q.length < 3) return 0;
  const allowed = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
  const d = editDistance(q, w, allowed);
  if (d <= allowed) return 0.75 - d * 0.1;
  // A typo in a longer word typed only partly ("termin" for "terminator").
  if (w.length > q.length && editDistance(q, w.slice(0, q.length), 1) <= 1) return 0.55;
  return 0;
}

/**
 * How well `query` matches `text`, from 0 (no) to about 1 (exact). Every typed word must match
 * one of the text's words (a short word like "of" may be missing); whole-title matches rank first.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = foldTitle(query);
  const t = foldTitle(text);
  if (!q) return 0;
  if (q === t) return 1.2;
  const qWords = q.split(" ");
  const tWords = t.split(" ");
  let total = 0;
  let missed = 0;
  for (const qw of qWords) {
    let best = 0;
    for (const tw of tWords) best = Math.max(best, wordScore(qw, tw));
    if (best === 0) {
      // Little words don't sink a match; anything else does.
      if (qw.length <= 3 && missed === 0 && qWords.length > 2) {
        missed += 1;
        continue;
      }
      return 0;
    }
    total += best;
  }
  const words = total / qWords.length;
  // Titles that are about as long as what was typed come first ("Out Cold" over "Out Cold Again").
  const fit = Math.min(qWords.length, tWords.length) / Math.max(qWords.length, tWords.length);
  const starts = t.startsWith(q) ? 0.1 : 0;
  return Math.max(0, words * 0.8 + fit * 0.2 + starts - missed * 0.1);
}

/** The items that match, best first (at most `limit`), by the text `of` each one. */
export function fuzzyRank<T>(
  items: readonly T[],
  query: string,
  of: (item: T) => string,
  limit = 50,
  min = 0.45,
): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, of(item));
    if (score >= min) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}
