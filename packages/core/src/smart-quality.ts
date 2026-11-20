import type { ReleaseOption, ReleaseSearchResult } from "./release-search";

/**
 * Smart Quality (11-17, the owner and Flint): Radarr's and Sonarr's quality rules in plain words.
 * This part is the near-miss check: when a wanted title isn't grabbed, tell apart "nothing exists"
 * from "something exists, and your own rules blocked it", and name the closest release.
 * Radarr and Sonarr return every search result with their own rejection reasons; this reads them.
 */

/** Why a release was turned down, in a few plain words. */
export type BlockReason =
  | "size"
  | "too-small"
  | "quality"
  | "already-have"
  | "score"
  | "blocklist"
  | "language"
  | "seeders"
  | "other";

export const BLOCK_WORDS: Record<BlockReason, string> = {
  size: "over your size limit",
  "too-small": "under your minimum size",
  quality: "a quality your settings don't allow",
  "already-have": "no better than what you already have",
  score: "scored too low by your release preferences",
  blocklist: "on your blocklist",
  language: "in a language you didn't ask for",
  seeders: "too few seeders",
  other: "turned down for another reason",
};

/** One app's rejection text, sorted into a plain reason. */
export function blockReason(text: string): BlockReason {
  const t = text.toLowerCase();
  if (
    /larger than (the )?maximum|greater than (the )?maximum|exceeds? .*(max|size)|too large/.test(t)
  )
    return "size";
  if (/smaller than (the )?minimum|less than (the )?minimum|too small/.test(t)) return "too-small";
  if (/blocklist|blacklist/.test(t)) return "blocklist";
  if (
    /existing file|not an upgrade|cutoff (has been |already )?(met|reached)|already meets/.test(t)
  )
    return "already-have";
  if (/custom format score|format score/.test(t)) return "score";
  if (
    /not wanted in profile|quality .*not wanted|quality profile does not allow|unwanted quality/.test(
      t,
    )
  )
    return "quality";
  if (/language/.test(t)) return "language";
  if (/seeder/.test(t)) return "seeders";
  return "other";
}

/** The size limit an app named in a rejection ("... larger than maximum allowed 8 GiB"), in GB. */
export function sizeCapGB(text: string): number | undefined {
  const m = /maximum(?: allowed)?(?: size)?[^\d]*([\d.]+)\s*([KMGT])i?B/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  const gb = unit === "T" ? n * 1024 : unit === "G" ? n : unit === "M" ? n / 1024 : n / 1024 / 1024;
  return Number.isFinite(gb) ? Math.round(gb * 10) / 10 : undefined;
}

export type NearMiss =
  | { kind: "none"; sentence: string }
  | { kind: "available"; count: number; sentence: string }
  | {
      kind: "blocked";
      found: number;
      /** Each reason with how many releases it turned down, most first. */
      reasons: { why: BlockReason; words: string; count: number }[];
      /** Releases turned down only for being over the size limit. */
      sizeOnly: number;
      /** The size limit, when the app named it. */
      capGB?: number;
      /** The smallest of those: the one "Grab it anyway" offers. */
      closest?: ReleaseOption;
      sentence: string;
    };

const gbText = (n: number) => `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10} GB`;

/** What a search's results say about why nothing was grabbed. */
export function nearMiss(result: ReleaseSearchResult, app = "Radarr"): NearMiss {
  const list = result.releases.filter((r) => !r.hidden);
  if (!list.length)
    return {
      kind: "none",
      sentence: "No releases found at all. Your indexers have nothing for it right now.",
    };
  const ok = list.filter((r) => r.approved);
  if (ok.length)
    return {
      kind: "available",
      count: ok.length,
      sentence: `${ok.length} ${ok.length === 1 ? "release fits" : "releases fit"} your rules, so ${app} can take one. An automatic search should pick it up; or download one now.`,
    };
  const counts = new Map<BlockReason, number>();
  let sizeOnly: ReleaseOption[] = [];
  let capGB: number | undefined;
  for (const r of list) {
    const why = new Set(r.rejections.map(blockReason));
    if (!why.size) why.add("other");
    for (const w of why) counts.set(w, (counts.get(w) ?? 0) + 1);
    if (why.size === 1 && why.has("size")) sizeOnly.push(r);
    for (const t of r.rejections) capGB ??= sizeCapGB(t);
  }
  sizeOnly = sizeOnly.sort((a, b) => (a.sizeGB ?? Infinity) - (b.sizeGB ?? Infinity));
  const closest = sizeOnly[0];
  const reasons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([why, count]) => ({ why, words: BLOCK_WORDS[why], count }));
  const n = list.length;
  const found = `Found ${n} ${n === 1 ? "release" : "releases"}, but your own rules turned ${n === 1 ? "it" : "every one"} down`;
  let sentence: string;
  if (closest) {
    const what = [closest.sizeGB !== undefined ? gbText(closest.sizeGB) : "", closest.quality ?? ""]
      .filter(Boolean)
      .join(" ");
    sentence =
      `${found}. ${sizeOnly.length === n ? (n === 1 ? "It is" : "All are") : `${sizeOnly.length} ${sizeOnly.length === 1 ? "is" : "are"}`} only over your size limit${capGB ? ` of ${gbText(capGB)}` : ""}.` +
      (what ? ` Closest: ${what}.` : "");
  } else {
    sentence = `${found}: ${reasons
      .slice(0, 3)
      .map((r) => `${r.count} ${r.words}`)
      .join(", ")}.`;
  }
  return {
    kind: "blocked",
    found: n,
    reasons,
    sizeOnly: sizeOnly.length,
    ...(capGB ? { capGB } : {}),
    ...(closest ? { closest } : {}),
    sentence,
  };
}
