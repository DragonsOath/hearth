import {
  useServarrView,
  type Base,
  type HistoryRow,
  type Named,
  type Paged,
  type TagRef,
} from "../radarr/data";

/**
 * What the native Sonarr panel's own tabs read (server: apps/sonarr-panel.ts). The tabs Sonarr
 * shares with Radarr (Activity, Settings, System) use the Radarr panel's components under a Sonarr
 * context instead.
 */

export interface SeriesRow {
  id: number;
  title: string;
  sortTitle: string;
  year?: number;
  status: string;
  network?: string;
  monitored: boolean;
  profileId?: number;
  seriesType: string;
  seasonFolder: boolean;
  tags: number[];
  seasons: number;
  episodeFiles: number;
  episodes: number;
  totalEpisodes: number;
  sizeOnDisk: number;
  nextAiring?: string;
  previousAiring?: string;
  added?: string;
  genres: string[];
  rating?: number;
  poster?: string;
  path?: string;
  tvdbId?: number;
}

export interface EpisodeRow {
  id: number;
  seriesId?: number;
  season: number;
  number: number;
  code: string;
  title: string;
  airDate?: string;
  monitored: boolean;
  hasFile: boolean;
  fileId?: number;
  quality?: string;
  size?: number;
}

export interface SonarrLibraryView extends Base {
  series: SeriesRow[];
  profiles: Named[];
  tags: TagRef[];
  rootFolders: { path: string; freeSpace?: number }[];
}

export interface SeriesView extends Base {
  series: SeriesRow & { overview?: string; rootFolderPath?: string; monitorNewItems?: string };
  seasons: {
    number: number;
    monitored: boolean;
    files: number;
    episodes: number;
    total: number;
    size: number;
  }[];
  episodes: EpisodeRow[];
  history: HistoryRow[];
  profiles: Named[];
  tags: TagRef[];
}

export type EpisodeWantedView = Paged<EpisodeRow & { series: string }>;

export interface ShowLookupView extends Base {
  results: {
    key: number;
    tvdbId: number;
    title: string;
    year?: number;
    overview?: string;
    network?: string;
    seasons: number;
    poster?: string;
    inLibrary: boolean;
    libraryId?: number;
  }[];
  profiles: Named[];
  tags: TagRef[];
  rootFolders: { path: string; freeSpace?: number }[];
}

export interface EpisodeImportsView extends Base {
  folder: string;
  files: {
    path: string;
    name: string;
    size: number;
    seriesId?: number;
    series?: string;
    season?: number;
    episodeIds: number[];
    episodes: string[];
    quality?: string;
    rejections: string[];
  }[];
  series: { id: number; title: string }[];
}

export interface SonarrViews {
  library: SonarrLibraryView;
  series: SeriesView;
  missing: EpisodeWantedView;
  cutoff: EpisodeWantedView;
  lookup: ShowLookupView;
  imports: EpisodeImportsView;
}

export function useSonarr<V extends keyof SonarrViews>(
  serviceId: string,
  view: V,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  return useServarrView<SonarrViews[V]>("sonarr", serviceId, view, q, enabled);
}

/** An air date as a short date, for lists. */
export const airDay = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
