import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";

/**
 * Notes waiting in Memory > Review (imported, never approved by the owner).
 * They are not memory and never become memory by being read here.
 * Ember may use them as leads, always labelled as unreviewed, so the owner's
 * own history is not invisible just because it has not been reviewed yet.
 */

export interface UnreviewedHit {
  id: string;
  title: string;
  /** Where it was imported from (a file name or a past session). */
  origin: string;
  snippet: string;
  score: number;
}

const STOP = new Set(
  "about after again also been being check could does doing down from have having into just like look looking make more much need only over really should some still than that their them then there these they this those very want what when where which while will with would your yours please being fixed fixing working issue issues problem problems".split(
    " ",
  ),
);

/** Words worth searching for: 4+ letters, or anything with a digit (names like "PublicTracker"). */
export function termsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w)))].slice(
    0,
    12,
  );
}

function textOf(payload: unknown): { title: string; body: string } {
  const p = payload as {
    entry?: { title?: string; body?: string };
    session?: { title?: string; messages?: { text?: string }[] };
    project?: { name?: string; summary?: string };
  };
  if (p.entry) return { title: p.entry.title ?? "Note", body: p.entry.body ?? "" };
  if (p.session) {
    return {
      title: p.session.title ?? "Past session",
      body: (p.session.messages ?? []).map((m) => m.text ?? "").join("\n"),
    };
  }
  if (p.project) return { title: p.project.name ?? "Project", body: p.project.summary ?? "" };
  return { title: "Note", body: JSON.stringify(payload) };
}

function snippetAround(body: string, term: string, size = 420): string {
  const flat = body.replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(term);
  if (i < 0) return flat.slice(0, size);
  const start = Math.max(0, i - Math.floor(size / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + size)}${start + size < flat.length ? "…" : ""}`;
}

/**
 * Pending notes matching the words, best first. A note must match a word
 * that is specific (contains a digit or is not a service-wide word), so a
 * question about "Prowlarr" alone does not drag in every note mentioning it.
 */
export async function searchUnreviewed(
  handle: DbHandle,
  words: string[],
  limit = 3,
): Promise<UnreviewedHit[]> {
  if (!words.length) return [];
  const rows = await handle.db
    .select({
      id: t.memoryImportDrafts.id,
      origin: t.memoryImportDrafts.origin,
      payload: t.memoryImportDrafts.payload,
    })
    .from(t.memoryImportDrafts)
    .where(eq(t.memoryImportDrafts.status, "pending"));
  const hits: UnreviewedHit[] = [];
  for (const r of rows) {
    const { title, body } = textOf(
      typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    );
    const hay = `${title}\n${body}`.toLowerCase();
    const found = words.filter((w) => hay.includes(w));
    if (!found.length) continue;
    // Rarer, longer, and digit-bearing words count for more; many mentions help a little.
    const score =
      found.reduce((n, w) => n + (/\d/.test(w) ? 3 : 1) + Math.min(w.length, 10) / 10, 0) +
      Math.min(3, hay.split(found[0]!).length - 1) * 0.2;
    const best = [...found].sort(
      (a, b) => (/\d/.test(b) ? 1 : 0) - (/\d/.test(a) ? 1 : 0) || b.length - a.length,
    )[0]!;
    hits.push({
      id: r.id,
      title,
      origin: r.origin.split(/[\\/]/).slice(-2).join("/"),
      snippet: snippetAround(body, best),
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
