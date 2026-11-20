import type { FileEntry, ItemProperties } from "@dragon-control/core";
import { InvalidRequestError } from "../store/errors";

/**
 * Read-only access to one watched location. Implementations can list a
 * folder and describe an item. There is deliberately no way to read file
 * contents, write, rename, move, or delete.
 */
export interface FileSource {
  displayPath(segments: string[]): string;
  list(segments: string[], limit: number): Promise<{ entries: FileEntry[]; total: number }>;
  properties(segments: string[]): Promise<ItemProperties>;
}

/**
 * Turns a user-supplied relative path into safe segments. Anything that
 * could step outside the watched folder is refused here, before any disk
 * access: "..", absolute paths, drive letters, and Windows alternate data
 * streams ("file:stream").
 */
export function toSegments(relative: string | undefined): string[] {
  if (!relative) return [];
  if (relative.includes("\0")) throw new InvalidRequestError("That path is not valid.");
  const segments = relative.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  for (const s of segments) {
    if (s === ".." || s.includes(":")) {
      throw new InvalidRequestError("Paths cannot leave the watched folder.");
    }
  }
  return segments;
}

export const joinRelative = (segments: string[]) => segments.join("/");

/** Folders first, then natural name order ("Season 2" before "Season 10"). */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind === "folder"
        ? -1
        : 1
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : undefined;
}
