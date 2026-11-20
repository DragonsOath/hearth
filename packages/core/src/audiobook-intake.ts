/**
 * Audiobook intake (the owner, 2026-11-07; from his own Audiobook Organizer): finished audiobook
 * downloads in the folders the owner chose are identified (author, title, series) from their tags
 * and folder names, copied into an Audiobookshelf library as <Author>/<Title>, verified, and the
 * library scanned. Sure matches go on their own; anything unsure waits for the owner to correct
 * and import. Nothing is ever moved out of a download folder (torrents keep seeding).
 */

/** A library the books go into: Audiobookshelf's id and its folder on this machine. */
export interface IntakeLibrary {
  id: string;
  name: string;
  folder: string;
}

export interface IntakeFolder {
  /** A download folder on this machine, watched for finished releases. */
  folder: string;
  /** Where it comes from, in plain words ("SABnzbd's audiobooks category"). */
  label?: string;
  /** Days after an import before the original is removed; 0 keeps it (a torrent still seeds). */
  removeAfterDays: number;
}

export interface IntakeConfig {
  enabled: boolean;
  intake: IntakeFolder[];
  libraries: IntakeLibrary[];
  /** The library a book goes to unless the owner picks another. */
  library: string;
  /** Books at or above this confidence import on their own (0 to 1). */
  threshold: number;
  /** The plan that switched it on: the owner's standing approval. */
  approvedBy?: string;
}

export interface IntakeBook {
  /** The book's folder, or its one file, inside the release. */
  source: string;
  author: string;
  title: string;
  series: string;
  sequence: string;
  tracks: number;
  confidence: number;
  /** Why it is this sure, in plain words. */
  reasons: string[];
  destination: string;
  /** Something is already at the destination. */
  collision: boolean;
}

export type IntakeStatus = "review" | "ready" | "imported" | "failed" | "skipped" | "waiting";

export interface IntakeJob {
  id: string;
  name: string;
  source: string;
  folder: string;
  status: IntakeStatus;
  library: string;
  books: IntakeBook[];
  message: string;
  foundAt: string;
  importedAt?: string;
  /** What the release looked like when judged (names, sizes, times): a change judges it again. */
  signature: string;
}

export interface IntakeView {
  config?: IntakeConfig;
  proposal?: IntakeConfig & { notes: string[] };
  jobs: IntakeJob[];
  /** ffprobe is installed here, so tags can be read (else folder names only). */
  tags: boolean;
  error?: string;
}

// Characters no folder name may hold on Linux or Windows (control characters on purpose).
// eslint-disable-next-line no-control-regex
const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;

/** A name safe as a folder on Linux and Windows. */
export function cleanName(value: string, fallback = "Unknown"): string {
  const v = (value ?? "")
    .replace(INVALID, "-")
    .trim()
    .replace(/^[ .]+|[ .]+$/g, "");
  return v || fallback;
}

/** "Book 3", "03", "Vol. 12" → "03"; none → "00". */
export function parseSequence(value: string): string {
  const m = /(?<!\d)(\d{1,3})(?:\.0)?(?!\d)/.exec(value ?? "");
  return m ? String(Number(m[1])).padStart(2, "0") : "00";
}

const SCENE =
  /\b(unabridged|abridged|audiobook|m4b|mp3|\d{2,3}k(bps)?|retail|\[[^\]]*\]|\([^)]*rip[^)]*\))/gi;

/** A release or folder name as words: dots and underscores to spaces, scene tags removed. */
export function releaseWords(name: string): string {
  return name.replace(/[._]/g, " ").replace(SCENE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Title, series and number from what a book shows: "Title Series, Book N", "Series 03 - Title",
 * "Author - Title". The tagged title wins when there is one.
 */
export function inferIdentity(
  evidence: string,
  taggedTitle = "",
): { title: string; series: string; sequence: string; author?: string } {
  const text = releaseWords(evidence);
  const book =
    /(?<title>.+?)[\s-]+(?<series>[A-Z][\w'&-]+),?\s+(?:book|volume|vol)\s*(?<num>\d{1,3})/i.exec(
      text,
    );
  if (book?.groups) {
    let title = taggedTitle || book.groups.title!;
    title = title.replace(/\s*\((un)?abridged\)\s*$/i, "").trim();
    return {
      title: cleanName(title),
      series: cleanName(book.groups.series!),
      sequence: String(Number(book.groups.num)).padStart(2, "0"),
    };
  }
  // "Author - Title"
  const dash = /^(?<author>[^-]{3,60}?)\s+-\s+(?<title>.{2,})$/.exec(text);
  if (dash?.groups && !taggedTitle)
    return {
      author: cleanName(dash.groups.author!),
      title: cleanName(dash.groups.title!.replace(/^\d{1,3}\s*[-.]\s*/, "")),
      series: "Standalone",
      sequence: parseSequence(dash.groups.title!),
    };
  const title = taggedTitle || text.replace(/^\s*\d{1,3}(?:\.\d+)?\s*[-. ]+/, "");
  return { title: cleanName(title), series: "Standalone", sequence: parseSequence(text) };
}

/** The first credited author, and the title without a subtitle or "(Unabridged)". */
export function shelfNames(author: string, title: string): { author: string; title: string } {
  const a = (author.split(/\s*[,;&]\s*|\s+and\s+/i)[0] ?? author).trim() || author;
  const t =
    title
      .replace(/\s*\((un)?abridged\)/gi, "")
      .split(/\s*[:–]\s+|\s+-\s+/)[0]!
      .trim()
      .replace(/^[ .-]+|[ .-]+$/g, "") || title;
  return { author: cleanName(a), title: cleanName(t) };
}

export interface BookEvidence {
  /** Tags of the book's first file, lower-case keys (album, album_artist, artist, title, series...). */
  tags: Record<string, string>;
  /** The book's folder or file name, and the release's name. */
  name: string;
  release: string;
  /** Folder names between the release and the book (an "Author/Series/Book" layout). */
  parents: string[];
  /** Author folders already in the library. */
  knownAuthors: string[];
  tracks: number;
}

/**
 * Who and what a book is, and how sure: tags count most, then a known author in the library, then
 * the folder layout and the names. Never above 0.95: a person can always be surer.
 */
export function identify(
  e: BookEvidence,
): Omit<IntakeBook, "source" | "destination" | "collision"> {
  const reasons: string[] = [];
  let score = 0.2;
  const tagAuthor = e.tags.album_artist || e.tags.artist || e.tags.composer || "";
  const tagTitle = e.tags.album || (e.tracks === 1 ? e.tags.title : "") || "";
  const words = releaseWords(`${e.release} ${e.name}`).toLowerCase();
  const known = e.knownAuthors.find((a) => a.length > 3 && words.includes(a.toLowerCase()));
  const inferred = inferIdentity(`${e.name}`, tagTitle);
  let author = tagAuthor;
  if (tagAuthor) {
    score += 0.3;
    reasons.push("author from the file's tags");
  } else if (known) {
    author = known;
    score += 0.25;
    reasons.push("an author already in your library is in the name");
  } else if (e.parents.length >= 2) {
    author = e.parents[0]!;
    score += 0.15;
    reasons.push("author from the folder layout");
  } else if (inferred.author) {
    author = inferred.author;
    score += 0.1;
    reasons.push('author from the name ("Author - Title")');
  } else reasons.push("no author found");
  if (tagTitle) {
    score += 0.3;
    reasons.push("title from the file's tags");
  } else if (inferred.title && inferred.title !== "Unknown") {
    score += 0.15;
    reasons.push("title from the folder name");
  }
  const series = e.tags.series || e.tags.grouping || e.tags["mvnm"] || inferred.series;
  const sequence = e.tags["series-part"] ? parseSequence(e.tags["series-part"]) : inferred.sequence;
  if (series !== "Standalone") {
    score += 0.1;
    reasons.push(`series ${series}${sequence !== "00" ? ` #${Number(sequence)}` : ""}`);
  }
  if (known && author && known.toLowerCase() === author.toLowerCase() && tagAuthor) score += 0.1;
  const names = shelfNames(author || "Unknown", inferred.title);
  return {
    author: names.author,
    title: names.title,
    series: cleanName(series, "Standalone"),
    sequence,
    tracks: e.tracks,
    confidence: Math.min(0.95, Math.round(score * 100) / 100),
    reasons,
  };
}

export const AUDIO_EXT = /\.(m4b|mp3|m4a|aac|flac|ogg|opus|wma)$/i;
/** Files still being written by a download client. */
export const PARTIAL_EXT = /\.(!qb|part|tmp|crdownload|aria2)$/i;
