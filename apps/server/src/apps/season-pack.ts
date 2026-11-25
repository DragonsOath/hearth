import type { StepChange } from "@dragon-control/core";
import { findReleases, grabRelease, type Call } from "./release-search";

/**
 * A season pack for one request (the owner, 11-24), offered when the Crucible's season pack
 * setting is off. It runs right after the Seerr request: once the show is in Sonarr, each
 * requested season is searched and a whole-season pack is downloaded only when Sonarr itself
 * would take it (its quality rules, its size limits, nothing already queued that meets them).
 * No such pack: nothing is downloaded and Sonarr's own episode search carries on as usual.
 */

export interface SeasonPackParams {
  tmdbId: number;
  title: string;
  /** The seasons asked for; none: every monitored season. */
  seasons?: number[];
}

export function seasonPackParams(
  p: Record<string, unknown> | undefined,
): SeasonPackParams | string {
  const tmdbId = Number(p?.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return "Say which show (params.tmdbId).";
  const title = String(p?.title ?? "").trim() || `TMDB ${tmdbId}`;
  const raw = p?.seasons;
  const list =
    raw === undefined || raw === ""
      ? undefined
      : (Array.isArray(raw) ? raw : String(raw).split(",")).map(Number);
  if (list && (!list.length || list.some((n) => !Number.isInteger(n) || n < 1 || n > 200)))
    return "Seasons are season numbers from 1 (params.seasons).";
  return { tmdbId, title: title.slice(0, 200), ...(list ? { seasons: [...new Set(list)] } : {}) };
}

export function seasonPackChange(serviceName: string, p: SeasonPackParams): StepChange {
  const which = p.seasons
    ? p.seasons.length === 1
      ? `Season ${p.seasons[0]}`
      : `Seasons ${p.seasons.join(", ")}`
    : "Every requested season";
  return {
    summary: `Try a season pack for ${p.title} in ${serviceName}`,
    settings: [
      {
        name: which,
        before: "Episode by episode (Sonarr's own search)",
        after:
          "A whole-season pack when Sonarr would take one under your quality rules; else episode by episode as before",
      },
      {
        name: "Already downloading",
        before: "Episodes Sonarr already sent to the download client",
        after:
          "Left alone: Sonarr turns a pack down when that season is already queued. If both start in the same few seconds, cancel one in the Queue tab",
      },
    ],
  };
}

interface RawSeries {
  id: number;
  tmdbId?: number;
  title?: string;
  seasons?: { seasonNumber: number; monitored?: boolean }[];
}

export async function grabSeasonPacks(
  call: Call,
  p: SeasonPackParams,
  wait: (ms: number) => Promise<void>,
  /** How long to wait for Seerr's request to reach Sonarr. */
  tries = 20,
): Promise<{ ok: boolean; result: string; grabbed: string[] }> {
  let series: RawSeries | undefined;
  for (let i = 0; i < tries && !series; i++) {
    const r = await call<RawSeries[]>("GET", "/api/v3/series");
    series = (Array.isArray(r.data) ? r.data : []).find((s) => s.tmdbId === p.tmdbId);
    if (!series && i < tries - 1) await wait(3000);
  }
  if (!series)
    return {
      ok: true,
      grabbed: [],
      result: `${p.title} has not reached Sonarr yet, so no pack was tried. Sonarr searches episode by episode once it arrives.`,
    };
  const seasons =
    p.seasons ??
    (series.seasons ?? [])
      .filter((s) => s.seasonNumber > 0 && s.monitored !== false)
      .map((s) => s.seasonNumber);
  const grabbed: string[] = [];
  const lines: string[] = [];
  for (const n of seasons) {
    let found;
    try {
      found = await findReleases("sonarr", call, { seriesId: series.id, seasonNumber: n });
    } catch {
      lines.push(`Season ${n}: the search did not finish; Sonarr searches episode by episode.`);
      continue;
    }
    const pack = found.releases.find((x) => x.fullSeason && x.approved);
    if (!pack) {
      lines.push(`Season ${n}: no pack Sonarr would take; episode by episode.`);
      continue;
    }
    const g = await grabRelease("sonarr", call, { ...pack, release: pack.title }, wait);
    if (g.ok) {
      grabbed.push(pack.title);
      lines.push(`Season ${n}: ${pack.title}${pack.sizeGB ? ` (${pack.sizeGB} GB)` : ""}.`);
    } else lines.push(`Season ${n}: the pack was not sent (${g.result}); episode by episode.`);
  }
  return {
    ok: true,
    grabbed,
    result: `${grabbed.length ? `Downloading ${grabbed.length} season pack${grabbed.length === 1 ? "" : "s"}. ` : "No season pack downloaded. "}${lines.join(" ")}`,
  };
}
