import type { RequestedShow } from "@dragon-control/core";
import type { EpisodeRow } from "../sonarr/data";

/**
 * What a requested show is missing: the aired, monitored episodes Sonarr has no file for,
 * grouped by season (specials left out). A season with nothing on disk at all reads as the
 * whole season. Episodes Sonarr isn't monitoring are only counted, since Sonarr won't look for
 * them anyway.
 */
export interface MissingSeason {
  season: number;
  /** Nothing from this season is on disk. */
  whole: boolean;
  episodes: EpisodeRow[];
}

export function missingBySeason(
  episodes: EpisodeRow[],
  now = Date.now(),
): { seasons: MissingSeason[]; total: number; notMonitored: number } {
  const aired = (e: EpisodeRow) => Boolean(e.airDate) && Date.parse(e.airDate!) <= now;
  const regular = episodes.filter((e) => e.season > 0);
  const gone = regular.filter((e) => e.monitored && !e.hasFile && aired(e));
  const bySeason = new Map<number, EpisodeRow[]>();
  for (const e of gone) bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), e]);
  const seasons = [...bySeason]
    .map(([season, eps]) => ({
      season,
      whole: !regular.some((e) => e.season === season && e.hasFile),
      episodes: eps.sort((a, b) => a.number - b.number),
    }))
    .sort((a, b) => a.season - b.season);
  return {
    seasons,
    total: gone.length,
    notMonitored: regular.filter((e) => !e.monitored && !e.hasFile && aired(e)).length,
  };
}

/** Where a show stands, in a few words, for its card. */
export function showState(m: RequestedShow): {
  label: string;
  tone: "good" | "warn" | "busy" | "quiet";
} {
  const s = m.sonarr;
  if (m.approval === "pending") return { label: "Waiting for approval", tone: "quiet" };
  if (m.approval === "declined") return { label: "Declined", tone: "quiet" };
  if (m.approval === "failed") return { label: "Request failed", tone: "warn" };
  if (!s) return { label: "Not in Sonarr", tone: "warn" };
  if (s.missing)
    return { label: `Missing ${s.missing} episode${s.missing === 1 ? "" : "s"}`, tone: "warn" };
  if (s.nextAiring) return { label: "Up to date, more coming", tone: "busy" };
  if (s.ended) return { label: "Complete", tone: "good" };
  return { label: "Up to date", tone: "good" };
}
