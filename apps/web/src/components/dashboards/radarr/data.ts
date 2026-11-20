import { createContext, useContext } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "../../../data/api";
import { useLiveQuery } from "../../panels/lifecycle";

/**
 * What the native Radarr panel's tabs read from Hearth (server: apps/radarr-panel.ts). The query
 * keys start with "dashboard" so a change approved from a panel refreshes them, like every other
 * dashboard. Each view is read only while its tab is on screen (useLiveQuery).
 */

/** Which Servarr app a shared tab is showing (Radarr's and Sonarr's panels share their tabs). */
export type ServarrApp = "radarr" | "sonarr" | "prowlarr" | "lidarr";
export const ServarrContext = createContext<ServarrApp>("radarr");
const WORDS = {
  radarr: { app: "radarr", name: "Radarr", item: "movie", items: "movies" },
  sonarr: { app: "sonarr", name: "Sonarr", item: "series", items: "series" },
  prowlarr: { app: "prowlarr", name: "Prowlarr", item: "indexer", items: "indexers" },
  lidarr: { app: "lidarr", name: "Lidarr", item: "artist", items: "artists" },
} as const;
/** The app's name and what it keeps ("movie"/"movies" or "series"), for words on screen. */
export function useServarr() {
  return WORDS[useContext(ServarrContext)];
}

export interface RadarrMeta {
  version: string;
  supported: boolean;
}
export interface Named {
  id: number;
  name: string;
}
export interface TagRef {
  id: number;
  label: string;
}

export interface MovieRow {
  id: number;
  title: string;
  sortTitle: string;
  year?: number;
  status: string;
  monitored: boolean;
  hasFile: boolean;
  isAvailable: boolean;
  profileId?: number;
  minimumAvailability?: string;
  tags: number[];
  sizeOnDisk: number;
  quality?: string;
  resolution?: number;
  codec?: string;
  hdr?: string;
  added?: string;
  genres: string[];
  rating?: number;
  collection?: string;
  poster?: string;
  path?: string;
  tmdbId?: number;
}

export interface HistoryRow {
  id: number;
  /** The movie or series it is about, and for Sonarr the episode. */
  itemId?: number;
  item?: string;
  year?: number;
  episode?: string;
  event: string;
  release?: string;
  quality?: string;
  formats: string[];
  score?: number;
  date?: string;
  indexer?: string;
  client?: string;
  message?: string;
}

export interface Base {
  meta: RadarrMeta;
  sample?: boolean;
}
export interface Paged<T> extends Base {
  page: number;
  pageSize: number;
  total: number;
  records: T[];
}

export interface LibraryView extends Base {
  movies: MovieRow[];
  profiles: Named[];
  tags: TagRef[];
  rootFolders: { path: string; freeSpace?: number }[];
}
export interface MovieView extends Base {
  movie: MovieRow & {
    overview?: string;
    runtime?: number;
    studio?: string;
    certification?: string;
    inCinemas?: string;
    digitalRelease?: string;
    physicalRelease?: string;
    imdbId?: string;
    rootFolderPath?: string;
  };
  file: {
    id: number;
    path?: string;
    size: number;
    added?: string;
    quality?: string;
    formats: string[];
    score: number;
    video: string;
    audio: string;
  } | null;
  history: HistoryRow[];
  profiles: Named[];
  tags: TagRef[];
}
export type HistoryView = Paged<HistoryRow>;
export type BlocklistView = Paged<{
  id: number;
  itemId?: number;
  item?: string;
  release?: string;
  quality?: string;
  date?: string;
  protocol?: string;
  indexer?: string;
  message?: string;
}>;
export interface WantedView extends Paged<MovieRow> {
  profiles: Named[];
}

export interface ProfileShape {
  id: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff?: number;
  cutoffName?: string;
  items: { id: number; name: string; allowed: boolean; group?: string[] }[];
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore: number;
  formatItems: { format: number; name: string; score: number }[];
  language?: string;
  /** How many movies or series use it. */
  used: number;
}
export interface ProfilesView extends Base {
  profiles: ProfileShape[];
  formats: Named[];
}

export interface Condition {
  name: string;
  type: string;
  typeName: string;
  negate: boolean;
  required: boolean;
  value: unknown;
}
export interface FormatShape {
  id: number;
  name: string;
  includeWhenRenaming: boolean;
  conditions: Condition[];
}
export interface FormatsView extends Base {
  formats: FormatShape[];
  conditionTypes: { type: string; name: string }[];
  scores: { profile: string; profileId: number; scores: { format: number; score: number }[] }[];
}

export interface TagsView extends Base {
  tags: { id: number; label: string; used: number; other: number }[];
  delayProfiles: {
    id: number;
    preferredProtocol?: string;
    usenet: boolean;
    torrent: boolean;
    usenetDelay: number;
    torrentDelay: number;
    bypassIfHighestQuality: boolean;
    tags: number[];
    isDefault: boolean;
  }[];
  releaseProfiles: {
    id: number;
    name: string;
    enabled: boolean;
    required: string[];
    ignored: string[];
    tags: number[];
  }[];
}

export interface MediaView extends Base {
  naming: Record<string, unknown>;
  media: Record<string, unknown>;
  rootFolders: {
    id: number;
    path: string;
    accessible: boolean;
    freeSpace?: number;
    unmapped: number;
  }[];
}

export interface ConnectionField {
  name: string;
  label: string;
  type: string;
  secret: boolean;
  set?: boolean;
  value?: unknown;
  help?: string;
}
export interface Connection {
  kind: string;
  id: number;
  name: string;
  implementation: string;
  enabled: boolean;
  protocol?: string;
  priority?: number;
  tags: number[];
  switches: Record<string, boolean>;
  fields: ConnectionField[];
}
export interface ConnectionsView extends Base {
  groups: { kind: string; label: string; readable: boolean; items: Connection[] }[];
}

export interface SystemView extends Base {
  status: {
    version: string;
    branch?: string;
    os?: string;
    docker: boolean;
    runtime?: string;
    started?: string;
    database?: string;
  };
  health: { source: string; type: string; message: string; wiki?: string }[];
  tasks: {
    id: number;
    name: string;
    command: string;
    interval: number;
    last?: string;
    next?: string;
    duration?: string;
  }[];
  backups: { id: number; name: string; type?: string; size?: number; time?: string }[];
  disks: { path: string; label?: string; free?: number; total?: number }[];
}
export type LogsView = Paged<{
  id: number;
  time?: string;
  level: string;
  logger?: string;
  message: string;
}>;
export interface ParseView extends Base {
  title: string;
  /** The movie or series the app thinks it is. */
  matched?: string;
  year?: number;
  quality?: string;
  formats: string[];
  score: number;
}

export interface LookupView extends Base {
  results: {
    /** The TMDB id (Radarr) or TVDB id (Sonarr). */
    key: number;
    tmdbId: number;
    title: string;
    year?: number;
    genres?: string[];
    popularity?: number;
    overview?: string;
    poster?: string;
    inLibrary: boolean;
    libraryId?: number;
  }[];
  profiles: Named[];
  tags: TagRef[];
  rootFolders: { path: string; freeSpace?: number }[];
}

export interface SizesView extends Base {
  limits: { min: number; max: number };
  sizes: {
    id: number;
    name: string;
    title: string;
    weight: number;
    minSize: number;
    maxSize: number | null;
    preferredSize: number | null;
  }[];
}
/** key: the TMDB id (Radarr) or TVDB id (Sonarr). */
export type ExclusionsView = Paged<{ id: number; key?: number; title: string; year?: number }>;
export interface ImportsView extends Base {
  folder: string;
  files: {
    path: string;
    name: string;
    size: number;
    movieId?: number;
    movie?: string;
    quality?: string;
    rejections: string[];
  }[];
  movies: { id: number; title: string }[];
}

export interface RadarrViews {
  library: LibraryView;
  movie: MovieView;
  history: HistoryView;
  blocklist: BlocklistView;
  missing: WantedView;
  cutoff: WantedView;
  profiles: ProfilesView;
  formats: FormatsView;
  tags: TagsView;
  media: MediaView;
  connections: ConnectionsView;
  system: SystemView;
  logs: LogsView;
  parse: ParseView;
  lookup: LookupView;
  sizes: SizesView;
  exclusions: ExclusionsView;
  imports: ImportsView;
}

/** How often a view refreshes while it is on screen. Settings change only through plans. */
const REFRESH: Partial<Record<keyof RadarrViews, number>> = {
  library: 60_000,
  movie: 30_000,
  history: 30_000,
  blocklist: 60_000,
  missing: 60_000,
  cutoff: 60_000,
  system: 30_000,
  logs: 15_000,
};

/** One view of a Servarr panel (Radarr's or Sonarr's), read while its tab is on screen. */
export function useServarrView<T>(
  app: ServarrApp,
  serviceId: string,
  view: string,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return useLiveQuery({
    queryKey: ["dashboard", app, serviceId, view, qs],
    queryFn: () =>
      api<T>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/${app}/${view}${qs ? `?${qs}` : ""}`,
      ),
    enabled,
    refetchInterval: (REFRESH as Record<string, number | undefined>)[view] ?? false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

/** A Radarr view, or the same shared view of Sonarr when a Sonarr panel shows the tab. */
export function useRadarr<V extends keyof RadarrViews>(
  serviceId: string,
  view: V,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  return useServarrView<RadarrViews[V]>(useContext(ServarrContext), serviceId, view, q, enabled);
}

/** A movie poster through Hearth (TMDB's image, fetched by the server). */
export const posterUrl = (serviceId: string, poster: string) =>
  `/api/services/${encodeURIComponent(serviceId)}/dashboard/poster?path=${encodeURIComponent(poster)}`;
