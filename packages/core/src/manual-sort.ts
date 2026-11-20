/**
 * Sorting manual downloads (the owner, 2026-11-07): a torrent or Usenet job added by hand, with
 * no category, is judged by its files (or, for Usenet, its name) and filed as a movie, show,
 * music, audiobook or ebook, then handed to the app that imports that type. Anything the rules
 * cannot place, or that fits two, goes to Unsorted for the owner: never a guess.
 */

export type SortType = "movie" | "tv" | "music" | "audiobook" | "ebook";
export const SORT_TYPES: readonly SortType[] = ["movie", "tv", "music", "audiobook", "ebook"];
/** Plural, for lists ("Shows go to Unsorted"). */
export const SORT_TYPE_PLURAL: Record<SortType, string> = {
  movie: "Movies",
  tv: "Shows",
  music: "Music",
  audiobook: "Audiobooks",
  ebook: "Ebooks",
};
export const SORT_TYPE_LABEL: Record<SortType | "unsorted", string> = {
  movie: "Movie",
  tv: "Show",
  music: "Music",
  audiobook: "Audiobook",
  ebook: "Ebook",
  unsorted: "Unsorted",
};

/** The app that imports one type: its kind decides the API it speaks. */
export type SortApp = "radarr" | "sonarr" | "lidarr" | "chaptarr";

export interface SortTarget {
  /** The qBittorrent category manual downloads of this type get. */
  category: string;
  /** That category's folder (inside qBittorrent). */
  savePath: string;
  /** Created by the setup plan (it did not exist). */
  create?: boolean;
  /** The app that imports it; none: the folder is the end (a watched folder, for example). */
  appServiceId?: string;
  app?: SortApp;
  appName?: string;
  /** Radarr and Sonarr: a title they do not have yet is added (no search) here, then imported. */
  rootFolder?: string;
  qualityProfileId?: number;
}

export interface ManualSortConfig {
  enabled: boolean;
  types: Partial<Record<SortType, SortTarget>>;
  unsorted: { category: string; savePath: string; create?: boolean };
  /** SABnzbd services whose manual jobs (no category) are sorted too. */
  sab: string[];
  /** Only downloads finished after this are sorted (older ones stay as they are). */
  since: string;
  /** The plan that switched it on: the owner's standing approval. */
  approvedBy?: string;
}

export type SortStatus = "moving" | "sent" | "done" | "unsorted" | "failed" | "undone";

/** One manual download the sorter handled, newest first in the history. */
export interface ManualSortEvent {
  id: string;
  at: string;
  source: "qbittorrent" | "sabnzbd";
  serviceId: string;
  /** Torrent hash or SABnzbd job id. */
  ref: string;
  name: string;
  type: SortType | "unsorted";
  reason: string;
  status: SortStatus;
  message: string;
  category?: string;
  /** Where the files were before (qBittorrent), to undo. */
  fromPath?: string;
  /** The app's command id while its import runs. */
  commandId?: number;
  updatedAt: string;
}

/** What the panel shows: the setup, what it would set up, the history and what waits for you. */
export interface ManualSortView {
  config?: ManualSortConfig;
  /** A ready setup for this homelab, from its categories and apps (absent once set up). */
  proposal?: ManualSortConfig & {
    notes: string[];
    defaultSavePath?: { now: string; suggested?: string; relocates: boolean };
    existing: { hash: string; name: string; type: SortType | "unsorted" }[];
  };
  events: ManualSortEvent[];
  apps: { serviceId: string; name: string; app: SortApp }[];
  sabServices: { serviceId: string; name: string }[];
  error?: string;
}

export interface SortFile {
  name: string;
  size: number;
}

const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i;
const AUDIO = /\.(mp3|flac|m4a|aac|ogg|opus|wav|alac|wma)$/i;
const BOOK = /\.(epub|mobi|azw3?|pdf|cbz|cbr|djvu|fb2)$/i;
const AUDIOBOOK = /\.(m4b|aax)$/i;
/** Never judged: samples, extras, subtitles, art, notes. */
const IGNORED =
  /(^|[\\/._ -])(sample|trailer|extras?|featurettes?|behind the scenes|deleted scenes)([\\/._ -]|$)|\.(srt|sub|idx|ass|ssa|vtt|nfo|txt|jpg|jpeg|png|gif|sfv|md5|url|cue|log|m3u8?|exe|lnk)$/i;
const EPISODE =
  /(^|[^a-z0-9])(s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3}|season[ ._-]?\d{1,2}|s\d{1,2}[ ._-]?complete)([^a-z0-9]|$)/i;
const TRACK = /(^|[\\/])(\d{1,2}[ ._-]?[-.]|\d{1,2} )\s*\S/;
const CHAPTER = /(chapter|chap|part|pt|track|disc|cd)[ ._-]?\d+|^\d{2,3}[ ._-]/i;
const BOOKWORDS = /audiobook|unabridged|narrated|read by|\bm4b\b/i;

const base = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Judges a download by its files: the biggest ones decide, and the first rule that fits wins
 * (ebook, audiobook, music, show, movie). Two kinds of media in strength, or none: Unsorted.
 */
export function classifyFiles(
  files: SortFile[],
  name = "",
): { type: SortType | "unsorted"; reason: string } {
  const real = files.filter((f) => f.size > 0 && !IGNORED.test(f.name));
  if (!real.length) return { type: "unsorted", reason: "No files to judge by." };
  const total = real.reduce((n, f) => n + f.size, 0);
  const share = (re: RegExp) =>
    real.filter((f) => re.test(f.name)).reduce((n, f) => n + f.size, 0) / total;
  const video = share(VIDEO);
  const audio = share(AUDIO);
  const m4b = share(AUDIOBOOK);
  const books = share(BOOK);
  const audioFiles = real.filter((f) => AUDIO.test(f.name));
  const videos = real.filter((f) => VIDEO.test(f.name));

  // A real mix (a film with its soundtrack is still a film: the video is far bigger).
  const strong = [video >= 0.25, audio + m4b >= 0.25, books >= 0.25].filter(Boolean).length;
  if (strong > 1)
    return { type: "unsorted", reason: "It mixes kinds of files (video, audio, books)." };

  if (books >= 0.6 && video < 0.05 && audio + m4b < 0.05)
    return { type: "ebook", reason: "Book files (epub, mobi, azw3, pdf), no audio or video." };
  if (m4b >= 0.5) return { type: "audiobook", reason: "Audiobook files (m4b)." };
  if (audio >= 0.6) {
    const named = audioFiles.filter((f) => CHAPTER.test(base(f.name))).length;
    const chapters = /(chapter|chap|part|pt)[ ._-]?\d+/i;
    const chaptered = audioFiles.filter((f) => chapters.test(base(f.name))).length;
    const big = audioFiles.length > 0 && total / audioFiles.length > 60 * 1024 ** 2;
    const words = BOOKWORDS.test(name) || audioFiles.some((f) => BOOKWORDS.test(f.name));
    const flac = audioFiles.some((f) => /\.flac$/i.test(f.name));
    if (words || chaptered >= Math.max(2, audioFiles.length / 2))
      return { type: "audiobook", reason: "Audio files named as chapters or parts of a book." };
    if (flac || audioFiles.filter((f) => TRACK.test(f.name)).length >= audioFiles.length / 2) {
      if (big && !flac)
        return {
          type: "unsorted",
          reason: "Long numbered MP3s: could be an audiobook or an album.",
        };
      return { type: "music", reason: "Numbered audio tracks, as on an album." };
    }
    if (named && big)
      return { type: "audiobook", reason: "Long numbered audio files, as in an audiobook." };
    return { type: "unsorted", reason: "Audio files that look like neither an album nor a book." };
  }
  if (video >= 0.6) {
    const episodes = videos.filter((f) => EPISODE.test(f.name)).length;
    if (episodes > 0 || EPISODE.test(name))
      return { type: "tv", reason: "Video named with an episode or season (S01E02, 1x02)." };
    const main = [...videos].sort((a, b) => b.size - a.size);
    const second = main[1]?.size ?? 0;
    if (main.length === 1 || second < main[0]!.size * 0.4)
      return { type: "movie", reason: "One main video file and no episode numbers." };
    return {
      type: "unsorted",
      reason: "Several videos of a similar size without episode numbers.",
    };
  }
  return { type: "unsorted", reason: "No kind of media makes up most of it." };
}

/**
 * Judges a Usenet job by its name only (SABnzbd lists no files for a finished job). Release names
 * follow a pattern, so this is reliable for shows and films; anything else goes to Unsorted.
 */
export function classifyName(name: string): { type: SortType | "unsorted"; reason: string } {
  const n = name.replace(/_/g, " ");
  const tv = EPISODE.test(n);
  const book = /\b(epub|mobi|azw3|ebooks?)\b/i.test(n);
  const audiobook = BOOKWORDS.test(n);
  const music =
    /\b(flac|mp3|320(kbps)?|v0|discography|album|lossless|web ?flac|24bit|16bit)\b/i.test(n);
  const film =
    /(^|[ .([-])(19[2-9]\d|20[0-4]\d)([ .)\]-]|$)/.test(n) &&
    /\b(2160p|1080p|720p|480p|576p|blu-?ray|bdrip|brrip|web-?dl|webrip|hdtv|dvdrip|remux|x264|x265|h ?264|h ?265|hevc|uhd)\b/i.test(
      n,
    );
  const hits = [tv, book && !audiobook, audiobook, music && !audiobook, film && !tv].filter(
    Boolean,
  ).length;
  if (hits !== 1) return { type: "unsorted", reason: "Its name does not say clearly what it is." };
  if (tv) return { type: "tv", reason: "Its name has an episode or season (S01E02)." };
  if (audiobook) return { type: "audiobook", reason: "Its name says audiobook." };
  if (book) return { type: "ebook", reason: "Its name says ebook (epub, mobi)." };
  if (music) return { type: "music", reason: "Its name says music (FLAC, MP3, album)." };
  return { type: "movie", reason: "Its name has a year and a video quality, as films do." };
}

/** A container path as the importing app sees it, through that app's remote path mappings. */
export function mapPath(
  path: string,
  mappings: { remotePath: string; localPath: string }[],
): string {
  const norm = (p: string) => (p.endsWith("/") ? p : `${p}/`);
  const best = [...mappings]
    .filter((m) => norm(path).startsWith(norm(m.remotePath)))
    .sort((a, b) => b.remotePath.length - a.remotePath.length)[0];
  if (!best) return path;
  const rest = norm(path).slice(norm(best.remotePath).length).replace(/\/$/, "");
  return rest ? `${norm(best.localPath)}${rest}` : norm(best.localPath).replace(/\/$/, "");
}
