import { useServarrView } from "../radarr/data";

/**
 * What the native Lidarr panel's own tabs read from Hearth (server: apps/lidarr-panel.ts).
 * Activity, Settings and System are the Radarr panel's shared tabs under a Lidarr context.
 */

interface Base {
  meta: { version: string; supported: boolean };
  sample?: boolean;
}
interface Named {
  id: number;
  name: string;
}
interface Lookups {
  profiles: Named[];
  tags: { id: number; label: string }[];
  metadataProfiles: Named[];
}
export interface Stats {
  albums: number;
  files: number;
  tracks: number;
  total: number;
  size: number;
}
export interface ArtistRow {
  id: number;
  name: string;
  sortName: string;
  foreignId?: string;
  disambiguation?: string;
  type?: string;
  status: string;
  monitored: boolean;
  monitorNewItems: string;
  profileId?: number;
  metadataProfileId?: number;
  tags: number[];
  path?: string;
  genres: string[];
  added?: string;
  stats: Stats;
}
export interface AlbumRow {
  id: number;
  artistId?: number;
  artist?: string;
  title: string;
  type: string;
  secondaryTypes: string[];
  released?: string;
  monitored: boolean;
  anyReleaseOk: boolean;
  stats: Stats;
  releases: number;
}
export interface LibraryView extends Base, Lookups {
  rootFolders: { id: number; path: string }[];
  artists: ArtistRow[];
}
export interface ArtistView extends Base, Lookups {
  artist: ArtistRow & { overview?: string };
  albums: AlbumRow[];
  history: {
    id: number;
    event: string;
    release?: string;
    album?: string;
    quality?: string;
    date?: string;
  }[];
}
export interface AlbumView extends Base {
  album: AlbumRow;
  tracks: {
    id: number;
    number: string;
    medium: number;
    title: string;
    duration?: number;
    hasFile: boolean;
    fileId?: number;
    quality?: string;
    size?: number;
  }[];
}
export interface WantedView extends Base {
  page: number;
  pageSize: number;
  total: number;
  records: AlbumRow[];
}
export interface ImportsView extends Base {
  folder: string;
  files: {
    path: string;
    name: string;
    size: number;
    quality?: string;
    artistId?: number;
    artist?: string;
    albumId?: number;
    album?: string;
    releaseId?: number;
    tracks: { id: number; title: string; number?: string }[];
    rejections: string[];
  }[];
}
export interface LookupView extends Base, Partial<Lookups> {
  rootFolders?: { id: number; path: string }[];
  results: {
    key: string;
    name: string;
    disambiguation?: string;
    type?: string;
    overview?: string;
    genres: string[];
    inLibrary: boolean;
  }[];
}
export interface MetadataView extends Base {
  profiles: {
    id: number;
    name: string;
    primary: { id: number; name: string; allowed: boolean }[];
    secondary: { id: number; name: string; allowed: boolean }[];
    statuses: { id: number; name: string; allowed: boolean }[];
  }[];
}

export interface LidarrViews {
  library: LibraryView;
  artist: ArtistView;
  album: AlbumView;
  missing: WantedView;
  cutoff: WantedView;
  imports: ImportsView;
  lookup: LookupView;
  metadata: MetadataView;
}

export function useLidarr<V extends keyof LidarrViews>(
  serviceId: string,
  view: V,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  return useServarrView<LidarrViews[V]>("lidarr", serviceId, view, q, enabled);
}

export const MONITOR = [
  { value: "all", label: "Every album" },
  { value: "future", label: "Future albums" },
  { value: "missing", label: "Missing albums" },
  { value: "existing", label: "Albums with files" },
  { value: "first", label: "The first album" },
  { value: "latest", label: "The latest album" },
  { value: "none", label: "Nothing" },
];
export const NEW_ITEMS = [
  { value: "all", label: "Every new album" },
  { value: "new", label: "New albums only" },
  { value: "none", label: "No new albums" },
];
export const minutes = (ms?: number) =>
  ms
    ? `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}`
    : "";
