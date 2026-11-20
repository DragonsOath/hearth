/**
 * Interactive search (10-26): from a Sonarr, Radarr, Lidarr or Chaptarr panel, find a title,
 * see every release the indexers offer for it right now (with the app's own verdict on each),
 * and send the one you pick to the download client, as a plan you confirm.
 */

export type SearchApp = "sonarr" | "radarr" | "lidarr" | "chaptarr";

/** A title in the app's library: a movie, series, album, or book. */
export interface SearchTitle {
  id: number;
  title: string;
  kind: "movie" | "series" | "album" | "book";
  year?: number;
  /** The artist or author. */
  by?: string;
  /** Chaptarr: ebook or audiobook. */
  format?: string;
  hasFile?: boolean;
  monitored?: boolean;
  /** Sonarr: its season numbers. */
  seasons?: number[];
  /**
   * Chaptarr: found by Chaptarr's own search (what its site shows) but not in its library yet,
   * so there is nothing to search releases for until it is added. `id` is 0 then.
   */
  notInLibrary?: { foreignBookId: string; addUrl?: string };
}

/** Sonarr: one episode, to search for on its own. */
export interface SearchEpisode {
  id: number;
  season: number;
  episode: number;
  title?: string;
  hasFile?: boolean;
  airDate?: string;
}

/** What to search the indexers for. */
export type ReleaseScope =
  | { movieId: number }
  | { episodeId: number }
  | { seriesId: number; seasonNumber: number }
  | { albumId: number }
  | { bookId: number };

/** One release an indexer offers, with the app's verdict on it. */
export interface ReleaseOption {
  /** The app's id for this result; with indexerId, what downloading it needs. */
  guid: string;
  indexerId: number;
  title: string;
  indexer?: string;
  sizeGB?: number;
  quality?: string;
  protocol?: "torrent" | "usenet" | string;
  seeders?: number;
  leechers?: number;
  ageHours?: number;
  /** The app's custom format score. */
  score?: number;
  /** The app would grab this one itself. */
  approved: boolean;
  /** Why the app would not take it on its own (it can still be downloaded by hand). */
  rejections: string[];
  /** The app hides it on its own page (Chaptarr's "Hidden results"), usually a collection or pack. */
  hidden?: boolean;
}

export interface ReleaseSearchResult {
  releases: ReleaseOption[];
  /** How many the indexers returned (the list may be shortened). */
  found: number;
  sample?: boolean;
  /** Radarr and Sonarr: why nothing was taken, in plain words (Smart Quality, 11-17). */
  nearMiss?: import("./smart-quality").NearMiss;
}
