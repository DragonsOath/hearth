import type { IsoTime } from "./domain";

/**
 * Collection PDF: the owner picks folders ("shelves": Movies, Shows, Stand-Up, Cartoons, ...),
 * Hearth scans them and makes a PDF of everything in them, grouped by year, to open, download,
 * or share.
 */

/**
 * Movies: one title per folder (or loose video). Shows: one title per folder directly inside.
 * Audiobooks: one book per folder of audio (or single .m4b), author from the folder above.
 * Ebooks: one book per title (its formats together), author from the folder above.
 */
export type ShelfKind = "movies" | "shows" | "audiobooks" | "ebooks";

export const SHELF_KINDS: ShelfKind[] = ["movies", "shows", "audiobooks", "ebooks"];

/** Books are listed by author; movies and shows by year. */
export const isBookShelf = (kind: ShelfKind) => kind === "audiobooks" || kind === "ebooks";

export interface CatalogShelfSetting {
  id: string;
  /** What the PDF calls it ("Stand-Up"). */
  name: string;
  /** A Storage & Files location (a drive or a watched folder). */
  rootId: string;
  /** Folder inside it, "/" separated ("" is the location itself). */
  path: string;
  kind: ShelfKind;
}

export interface CatalogSettings {
  /** The PDF's title. */
  title: string;
  shelves: CatalogShelfSetting[];
}

export interface CatalogFile {
  id: string;
  at: IsoTime;
  title: string;
  titles: number;
  /** Size of everything listed (the library, not the PDF). */
  libraryBytes: number;
  /** Size of the PDF. */
  fileBytes: number;
  shelves: { name: string; count: number }[];
  /** Shelves that could not be read completely in time. */
  partial?: string[];
  /** Shelves that could not be read at all, with why. */
  failed?: { name: string; reason: string }[];
}

export interface CatalogStatus {
  running: boolean;
  startedAt?: IsoTime;
  /** The shelf being read now. */
  shelf?: string;
  /** Folders read so far. */
  folders?: number;
  /** The last run's error, if it failed. */
  error?: string;
}

export interface CatalogState {
  settings: CatalogSettings;
  status: CatalogStatus;
  /** Newest first. */
  files: CatalogFile[];
}

export const CATALOG_DEFAULT_TITLE = "The Full Collection";
export const MAX_CATALOG_SHELVES = 20;
/** PDFs kept; older ones are removed when a new one is made. */
export const MAX_CATALOG_FILES = 12;

/** A guess at a shelf's kind from its name, which the owner can change. */
export function guessShelfKind(name: string): ShelfKind {
  if (/audio\s*-?\s*books?|audible|listen/i.test(name)) return "audiobooks";
  if (/e-?\s*books?|books|kindle|calibre|epub|comics?|manga|novels?|reading|library/i.test(name))
    return "ebooks";
  return /show|tv|series|cartoon|anime|season|episod/i.test(name) ? "shows" : "movies";
}
