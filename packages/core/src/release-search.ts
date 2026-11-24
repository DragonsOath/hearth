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
  /** "2160p", from the app's own quality. */
  resolution?: string;
  /** Where it came from: "WEB-DL", "WEBRip", "Blu-ray", "Remux", "HDTV", "DVD". */
  source?: string;
  /** Read from the release name: "HEVC", "H.264", "AV1". */
  codec?: string;
  /** Read from the release name: "DD+ 5.1", "TrueHD Atmos", "AAC 2.0". */
  audio?: string;
  /** Read from the release name: "Dolby Vision", "HDR10+", "HDR". */
  hdr?: string;
}

/** What a release name says about its video and sound, for comparing releases side by side. */
export function releaseDetails(name: string): Pick<ReleaseOption, "codec" | "audio" | "hdr"> {
  const t = name.replace(/[._]/g, " ");
  const codec = /\b(x265|h ?265|hevc)\b/i.test(t)
    ? "HEVC"
    : /\b(x264|h ?264|avc)\b/i.test(t)
      ? "H.264"
      : /\bav1\b/i.test(t)
        ? "AV1"
        : /\bxvid\b/i.test(t)
          ? "XviD"
          : undefined;
  // Channels as written ("5 1" once dots are spaces) back to "5.1".
  const ch = (m: RegExpExecArray | null) => (m?.[1] ? ` ${m[1].replace(" ", ".")}` : "");
  let audio: string | undefined;
  let m: RegExpExecArray | null;
  if ((m = /\b(?:ddp|dd\+|e-?ac-?3)\s?(\d \d)?/i.exec(t))) audio = `DD+${ch(m)}`;
  else if ((m = /\btruehd\s?(\d \d)?/i.exec(t))) audio = `TrueHD${ch(m)}`;
  else if ((m = /\bdts(?:-?hd(?: ?ma)?|-?x)?\s?(\d \d)?/i.exec(t))) audio = `DTS${ch(m)}`;
  else if ((m = /\b(?:dd|ac-?3)\s?(\d \d)\b/i.exec(t))) audio = `DD${ch(m)}`;
  else if ((m = /\baac\s?(\d \d)?/i.exec(t))) audio = `AAC${ch(m)}`;
  else if (/\bflac\b/i.test(t)) audio = "FLAC";
  else if (/\bopus\b/i.test(t)) audio = "Opus";
  if (audio && /\batmos\b/i.test(t)) audio += " Atmos";
  const hdr = /\b(dv|dovi|dolby ?vision)\b/i.test(t)
    ? "Dolby Vision"
    : /\bhdr10(\+|plus)/i.test(t)
      ? "HDR10+"
      : /\bhdr(10)?\b/i.test(t)
        ? "HDR"
        : undefined;
  return { ...(codec ? { codec } : {}), ...(audio ? { audio } : {}), ...(hdr ? { hdr } : {}) };
}

export interface ReleaseSearchResult {
  releases: ReleaseOption[];
  /** How many the indexers returned (the list may be shortened). */
  found: number;
  sample?: boolean;
  /** Radarr and Sonarr: why nothing was taken, in plain words (Smart Quality, 11-17). */
  nearMiss?: import("./smart-quality").NearMiss;
}
