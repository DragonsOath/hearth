import type { FileEntry, ShelfKind } from "@dragon-control/core";
import type { FileSource } from "../storage/source";

/**
 * Builds the list for a collection PDF from folders on disk, the way people keep a library:
 *
 * - Movies (and stand-up, concerts, anything one-title-per-folder): every folder that holds a
 *   video is one title, named from the folder ("Heat (1995)"), else the video's file name, else
 *   the folder; the year comes from the name, else a year folder above it ("2024/Wicked").
 *   Extras and subtitles in its subfolders count toward its size. Loose videos are titles too.
 * - Shows (and cartoons, anime): every folder directly inside is one show; its size and episode
 *   count are everything below it; the year comes from the name, else from Sonarr when it knows
 *   the show.
 * - Audiobooks and ebooks: one book per folder of audio, or per title of ebook files, with the
 *   author from the folder above (see audiobooks() and ebooks()).
 *
 * Read only, through the same file sources as Storage & Files (so Hearth's secret folders stay
 * out), and bounded so a huge or slow drive cannot run forever.
 */

export type { ShelfKind };

export interface CatalogItem {
  /** Title. */
  t: string;
  /** Year, when known. */
  y?: number;
  /** Size in bytes. */
  s: number;
  /** Shows: episodes found. */
  n?: number;
  /** Books: author, when the folders say. */
  a?: string;
}

export interface ScanLimits {
  /** Folders listed at most, across one shelf. */
  maxFolders: number;
  /** Stop after this long (ms). */
  maxMs: number;
  /** Deepest folder looked into, below the shelf. */
  maxDepth: number;
}

export const SCAN_LIMITS: ScanLimits = { maxFolders: 200_000, maxMs: 20 * 60_000, maxDepth: 8 };

export const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|mpg|mpeg|ts|m2ts|webm|iso|divx|flv|vob)$/i;
const FOLDER_YEAR = /^(.+?)\s*[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$/;
const NAME_YEAR = /^(.+?)\s*[([]\s*((?:19|20)\d{2})\s*[)\]]/;
const SCENE_YEAR = /^(.+?)[ ._-]+((?:19|20)\d{2})(?:[ ._-]|$)/;
const YEAR_FOLDER = /^(?:19|20)\d{2}$/;

export const AUDIO = /\.(m4b|mp3|m4a|aac|flac|ogg|oga|opus|wma|wav|aax|aaxc|mka|mp4a)$/i;
export const EBOOK =
  /\.(epub|kepub|mobi|azw|azw3|azw4|kfx|pdf|cbz|cbr|cb7|cbt|fb2|djvu|lit|pdb|rtf|docx?)$/i;
/** "CD1", "Disc 2", "Part 03": pieces of one audiobook. */
const DISC = /^(?:cd|disc|disk|part|pt)[\s._-]*\d+\b/i;
/** Calibre's book folders end in its id: "Dune (123)". */
const CALIBRE_ID = /\s*\(\d+\)$/;

/**
 * A book's name from its folder or file, the way Audiobookshelf and Calibre read them:
 * "Book 1 - 1965 - Dune {Narrator}" → Dune (1965); "Dune - Frank Herbert" → Dune.
 */
export function bookTitle(raw: string, author?: string): { t: string; y?: number } {
  let s = raw
    .replace(CALIBRE_ID, "")
    .replace(/\s*\{[^}]*\}\s*/g, " ")
    .trim();
  // A leading volume or sequence number: "Book 1 - ", "Vol. 2 - ", "01 - ", "1. ".
  s = s.replace(/^(?:(?:book|vol(?:ume)?\.?|#)\s*)?\d{1,3}(?:\.\d)?\s*(?:[-.:]\s+|\s+-\s+)/i, "");
  let y: number | undefined;
  const lead = /^((?:19|20)\d{2})\s*-\s*(.+)$/.exec(s);
  if (lead) {
    y = Number(lead[1]);
    s = lead[2]!;
  } else {
    const named = titleAndYear(s);
    if (named && FOLDER_YEAR.test(s)) {
      y = named.y;
      s = named.t;
    }
  }
  if (author) {
    const tail = ` - ${author}`;
    if (s.toLowerCase().endsWith(tail.toLowerCase()) && s.length > tail.length)
      s = s.slice(0, -tail.length);
  }
  s = s.replace(/\s+/g, " ").trim() || raw;
  return y ? { t: s, y } : { t: s };
}

/** "Heat (1995)" or "Heat.1995.1080p.BluRay" → title and year. */
export function titleAndYear(name: string): { t: string; y?: number } | undefined {
  const m = FOLDER_YEAR.exec(name) ?? NAME_YEAR.exec(name);
  if (m) return { t: m[1]!.trim(), y: Number(m[2]) };
  const s = SCENE_YEAR.exec(name);
  if (s && /[._]/.test(name)) return { t: s[1]!.replace(/[._]+/g, " ").trim(), y: Number(s[2]) };
  return undefined;
}

const stem = (file: string) => file.replace(/\.[^.]+$/, "");

export class ScanStopped extends Error {}

export class Scanner {
  private folders = 0;
  private readonly started = Date.now();
  /** Folders listed so far, for progress. */
  get listed() {
    return this.folders;
  }
  stoppedEarly = false;

  constructor(
    private readonly source: FileSource,
    private readonly limits: ScanLimits = SCAN_LIMITS,
    private readonly onProgress?: (folders: number) => void,
  ) {}

  private async list(segments: string[]): Promise<FileEntry[]> {
    if (this.folders >= this.limits.maxFolders || Date.now() - this.started > this.limits.maxMs) {
      this.stoppedEarly = true;
      return [];
    }
    this.folders++;
    if (this.folders % 200 === 0) this.onProgress?.(this.folders);
    try {
      return (await this.source.list(segments, 1_000_000)).entries;
    } catch {
      return []; // unreadable folders are skipped, not fatal
    }
  }

  /** Everything below a folder: bytes and videos. */
  private async total(
    segments: string[],
    depth: number,
    media: RegExp = VIDEO,
  ): Promise<{ bytes: number; videos: number }> {
    const entries = await this.list(segments);
    let bytes = 0;
    let videos = 0;
    for (const e of entries) {
      if (e.kind === "file") {
        bytes += e.sizeBytes ?? 0;
        if (media.test(e.name)) videos++;
      } else if (depth < this.limits.maxDepth) {
        const sub = await this.total([...segments, e.name], depth + 1, media);
        bytes += sub.bytes;
        videos += sub.videos;
      }
    }
    return { bytes, videos };
  }

  async movies(base: string[]): Promise<CatalogItem[]> {
    const out: CatalogItem[] = [];
    const walk = async (segments: string[], depth: number, yearAbove?: number) => {
      const entries = await this.list(segments);
      const files = entries.filter((e) => e.kind === "file");
      const folders = entries.filter((e) => e.kind === "folder");
      const videos = files.filter((f) => VIDEO.test(f.name));
      const here = segments.at(-1);
      if (videos.length && segments.length > base.length) {
        // This folder is one title; its subfolders (extras, subtitles) add to its size.
        let bytes = files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
        for (const f of folders)
          bytes += (await this.total([...segments, f.name], depth + 1)).bytes;
        const named = titleAndYear(here!) ??
          titleAndYear(stem(videos[0]!.name)) ?? { t: here!, y: yearAbove };
        out.push({
          t: named.t,
          ...((named.y ?? yearAbove) ? { y: named.y ?? yearAbove } : {}),
          s: bytes,
        });
        return;
      }
      // Loose videos directly in a folder that is not itself a title.
      for (const v of videos) {
        const named = titleAndYear(stem(v.name)) ?? { t: stem(v.name).replace(/[._]+/g, " ") };
        out.push({
          t: named.t,
          ...((named.y ?? yearAbove) ? { y: named.y ?? yearAbove } : {}),
          s: v.sizeBytes ?? 0,
        });
      }
      if (depth >= this.limits.maxDepth) return;
      for (const f of folders) {
        const y = YEAR_FOLDER.test(f.name) ? Number(f.name) : yearAbove;
        await walk([...segments, f.name], depth + 1, y);
      }
    };
    await walk(base, 0);
    return out;
  }

  /**
   * Audiobooks, laid out the way Audiobookshelf, Plex, and Jellyfin expect: Author/Book,
   * Author/Series/Book, or just Book folders. A folder of audio is one book (with any "CD1",
   * "Disc 2" folders inside it); several .m4b files side by side are a book each; the author is
   * the first folder below the shelf, when the book sits deeper than that.
   */
  async audiobooks(base: string[]): Promise<CatalogItem[]> {
    const out: CatalogItem[] = [];
    const push = (raw: string, segments: string[], bytes: number, files: number) => {
      const author = segments.length > base.length ? segments[base.length] : undefined;
      const b = bookTitle(raw, author);
      out.push({ ...b, ...(author ? { a: author } : {}), s: bytes, n: files });
    };
    const walk = async (segments: string[], depth: number) => {
      const entries = await this.list(segments);
      const files = entries.filter((e) => e.kind === "file");
      const folders = entries.filter((e) => e.kind === "folder");
      const audio = files.filter((f) => AUDIO.test(f.name));
      const here = segments.at(-1);
      const discs = folders.filter((f) => DISC.test(f.name));
      const atBase = segments.length === base.length;
      const singles = audio.length > 1 && audio.every((f) => /\.m4b$/i.test(f.name));
      if (!atBase && !singles && (audio.length || discs.length)) {
        // This folder is one book; its other folders (CD1, covers, extras) add to it.
        let bytes = files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
        let count = audio.length;
        for (const f of folders) {
          const sub = await this.total([...segments, f.name], depth + 1, AUDIO);
          bytes += sub.bytes;
          count += sub.videos;
        }
        if (count) {
          push(here!, segments.slice(0, -1), bytes, count);
          return;
        }
      }
      // Loose audiobook files: each is a book (one .m4b, or one .mp3 per book).
      for (const f of audio) push(stem(f.name), segments, f.sizeBytes ?? 0, 1);
      if (depth >= this.limits.maxDepth) return;
      for (const f of folders) await walk([...segments, f.name], depth + 1);
    };
    await walk(base, 0);
    return out;
  }

  /**
   * Ebooks and comics, laid out the way Calibre, Calibre-Web, Kavita, and Komga keep them:
   * Author/Title (id)/Title - Author.epub, Author/Title.epub, or a plain folder of files. A
   * book's formats (epub, mobi, pdf...) count once; the author is the first folder below the
   * shelf, when the book sits deeper than that.
   */
  async ebooks(base: string[]): Promise<CatalogItem[]> {
    const out: CatalogItem[] = [];
    const walk = async (segments: string[], depth: number) => {
      const entries = await this.list(segments);
      const files = entries.filter((e) => e.kind === "file");
      const books = files.filter((f) => EBOOK.test(f.name));
      const here = segments.at(-1);
      const author = segments.length > base.length + 1 ? segments[base.length] : undefined;
      const byStem = new Map<string, { name: string; bytes: number }>();
      for (const f of books) {
        const k = stem(f.name).toLowerCase();
        const g = byStem.get(k) ?? { name: stem(f.name), bytes: 0 };
        g.bytes += f.sizeBytes ?? 0;
        byStem.set(k, g);
      }
      const calibre =
        segments.length > base.length &&
        byStem.size === 1 &&
        (CALIBRE_ID.test(here!) || files.some((f) => f.name === "metadata.opf"));
      if (calibre) {
        // A Calibre book folder: one book in one or more formats, plus its cover.
        const bytes = files.reduce((n, f) => n + (f.sizeBytes ?? 0), 0);
        const b = bookTitle(here!, author);
        out.push({ ...b, ...(author ? { a: author } : {}), s: bytes });
      } else {
        // Files named for their book: the author is the folder they are in, below the shelf.
        const folderAuthor = segments.length > base.length ? segments[base.length] : undefined;
        for (const g of byStem.values()) {
          const b = bookTitle(g.name, folderAuthor);
          out.push({ ...b, ...(folderAuthor ? { a: folderAuthor } : {}), s: g.bytes });
        }
      }
      if (depth >= this.limits.maxDepth) return;
      for (const f of entries.filter((e) => e.kind === "folder"))
        await walk([...segments, f.name], depth + 1);
    };
    await walk(base, 0);
    return out;
  }

  async shows(base: string[], knownYears: Map<string, number>): Promise<CatalogItem[]> {
    const out: CatalogItem[] = [];
    for (const f of (await this.list(base)).filter((e) => e.kind === "folder")) {
      const { bytes, videos } = await this.total([...base, f.name], 1);
      if (!videos) continue; // empty or not a show (artwork, metadata)
      const named = titleAndYear(f.name);
      const t = named?.t ?? f.name;
      const y = named?.y ?? knownYears.get(f.name.toLowerCase()) ?? knownYears.get(t.toLowerCase());
      out.push({ t, ...(y ? { y } : {}), s: bytes, n: videos });
    }
    return out;
  }
}
