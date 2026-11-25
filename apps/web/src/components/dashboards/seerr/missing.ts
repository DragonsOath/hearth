import type { RequestedShow } from "@dragon-control/core";
import type { EpisodeRow } from "../sonarr/data";

/**
 * How complete a requested show is, episode by episode, from Sonarr's own episode list and
 * queue (What's Missing in the Seerr panel). Only aired episodes can be missing: an episode
 * still to air is upcoming, one with no air date is unknown, and a season with nothing aired is
 * not released yet. Specials (season 0) are left out.
 */

export type EpisodeState =
  "in-library" | "downloading" | "missing" | "not-monitored" | "next" | "upcoming" | "unknown";

export type SeasonState = "complete" | "missing" | "airing" | "unreleased" | "partial" | "unknown";

export interface QueuedEpisode {
  episodeId: number;
  status: string;
  progressPct?: number;
  release?: string;
}

export interface EpisodeStatus {
  e: EpisodeRow;
  state: EpisodeState;
  queued?: QueuedEpisode;
}

export interface SeasonSummary {
  season: number;
  /** Episodes Sonarr knows of in this season. */
  known: number;
  present: number;
  /** Aired, monitored, not on disk and not downloading. */
  missing: number;
  /** Aired and not on disk, but Sonarr isn't monitoring them. */
  notMonitored: number;
  state: SeasonState;
  episodes: EpisodeStatus[];
}

export interface Completeness {
  seasons: SeasonSummary[];
  known: number;
  present: number;
  missing: number;
  notMonitored: number;
  seasonsInLibrary: number;
  /** The next episode to air, if any is announced. */
  next?: EpisodeRow;
}

export function completeness(
  episodes: EpisodeRow[],
  queue: QueuedEpisode[] = [],
  now = Date.now(),
): Completeness {
  const queued = new Map(queue.map((q) => [q.episodeId, q]));
  const regular = episodes
    .filter((e) => e.season > 0)
    .sort((a, b) => a.season - b.season || a.number - b.number);
  const future = regular
    .filter((e) => e.airDate && Date.parse(e.airDate) > now)
    .sort((a, b) => Date.parse(a.airDate!) - Date.parse(b.airDate!));
  const next = future[0];
  const stateOf = (e: EpisodeRow): EpisodeState => {
    if (e.hasFile) return "in-library";
    if (queued.has(e.id)) return "downloading";
    if (!e.airDate || Number.isNaN(Date.parse(e.airDate))) return "unknown";
    if (Date.parse(e.airDate) > now) return e.id === next?.id ? "next" : "upcoming";
    return e.monitored ? "missing" : "not-monitored";
  };
  const bySeason = new Map<number, EpisodeStatus[]>();
  for (const e of regular) {
    const state = stateOf(e);
    bySeason.set(e.season, [
      ...(bySeason.get(e.season) ?? []),
      { e, state, ...(queued.has(e.id) ? { queued: queued.get(e.id)! } : {}) },
    ]);
  }
  const seasons: SeasonSummary[] = [...bySeason].map(([season, eps]) => {
    const count = (s: EpisodeState) => eps.filter((x) => x.state === s).length;
    const present = count("in-library");
    const missing = count("missing");
    const notMonitored = count("not-monitored");
    const coming = count("next") + count("upcoming");
    const unknown = count("unknown");
    const aired = eps.length - coming - unknown;
    const state: SeasonState =
      missing > 0
        ? "missing"
        : aired === 0 && present === 0 && count("downloading") === 0
          ? unknown === eps.length
            ? "unknown"
            : "unreleased"
          : coming > 0
            ? "airing"
            : notMonitored > 0
              ? "partial"
              : "complete";
    return { season, known: eps.length, present, missing, notMonitored, state, episodes: eps };
  });
  const sum = (k: "known" | "present" | "missing" | "notMonitored") =>
    seasons.reduce((n, s) => n + s[k], 0);
  return {
    seasons,
    known: sum("known"),
    present: sum("present"),
    missing: sum("missing"),
    notMonitored: sum("notMonitored"),
    seasonsInLibrary: seasons.filter((s) => s.present > 0).length,
    ...(next ? { next } : {}),
  };
}

export const EPISODE_WORDS: Record<EpisodeState, string> = {
  "in-library": "In library",
  downloading: "Downloading",
  missing: "Missing",
  "not-monitored": "Missing, not monitored",
  next: "Next to air",
  upcoming: "Not aired yet",
  unknown: "Air date unknown",
};

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
