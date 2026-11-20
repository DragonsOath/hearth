import { promises as fs, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import type { FileEntry } from "@dragon-control/core";
import { ForbiddenError, NotFoundError } from "../store/errors";
import { extensionOf, joinRelative, sortEntries, type FileSource } from "./source";

const iso = (d: Date | undefined) => (d && d.getTime() > 0 ? d.toISOString() : undefined);
const isWindows = process.platform === "win32";

function within(child: string, parent: string): boolean {
  const c = isWindows ? child.toLowerCase() : child;
  const p = isWindows ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function explain(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR")
    throw new NotFoundError("That item no longer exists.");
  if (code === "EACCES" || code === "EPERM") {
    throw new ForbiddenError("The operating system did not allow reading this item.");
  }
  throw error;
}

export interface WalkBudget {
  maxEntries: number;
  maxMs: number;
}

/** Properties of one folder may take a while; a whole listing's sizes share a smaller budget. */
export const DEFAULT_BUDGET: WalkBudget = { maxEntries: 400_000, maxMs: 8_000 };
export const LISTING_BUDGET: WalkBudget = { maxEntries: 150_000, maxMs: 6_000 };

interface FolderTotals {
  bytes: number;
  files: number;
  folders: number;
  complete: boolean;
}

/** Folder sizes are expensive on big media drives; complete results are remembered for a while. */
const sizeCache = new Map<string, { at: number; value: FolderTotals }>();
const SIZE_CACHE_MS = 10 * 60_000;

function cachedTotals(dir: string): FolderTotals | undefined {
  const hit = sizeCache.get(isWindows ? dir.toLowerCase() : dir);
  return hit && Date.now() - hit.at < SIZE_CACHE_MS ? hit.value : undefined;
}

/** Shared allowance so many folder walks together stay within one budget. */
class Allowance {
  private seen = 0;
  private readonly started = Date.now();
  constructor(private readonly budget: WalkBudget) {}
  spend(): boolean {
    this.seen++;
    return this.seen <= this.budget.maxEntries && Date.now() - this.started <= this.budget.maxMs;
  }
  get exhausted() {
    return this.seen > this.budget.maxEntries || Date.now() - this.started > this.budget.maxMs;
  }
}

/**
 * Totals a folder at any depth. Symlinks and junctions are never followed,
 * so nothing is counted twice and nothing outside the folder is reached.
 */
async function folderTotals(dir: string, allowance: Allowance): Promise<FolderTotals> {
  const cached = cachedTotals(dir);
  if (cached) return cached;
  const totals: FolderTotals = { bytes: 0, files: 0, folders: 0, complete: true };
  const stack = [dir];
  outer: while (stack.length) {
    const current = stack.pop()!;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue; // protected system folders
    }
    for (const d of dirents) {
      if (!allowance.spend()) {
        totals.complete = false;
        break outer;
      }
      if (d.isSymbolicLink()) continue;
      const full = path.join(current, d.name);
      if (d.isDirectory()) {
        totals.folders++;
        stack.push(full);
      } else if (d.isFile()) {
        totals.files++;
        totals.bytes += await fs.lstat(full).then(
          (s) => s.size,
          () => 0,
        );
      }
    }
  }
  if (totals.complete)
    sizeCache.set(isWindows ? dir.toLowerCase() : dir, { at: Date.now(), value: totals });
  return totals;
}

/**
 * A watched folder on this machine. Every access resolves the real path
 * (following junctions and symlinks) and refuses anything that lands
 * outside the watched root, so a link inside the folder cannot be used to
 * reach the rest of the disk.
 */
export function fsSource(
  root: string,
  budgets: { properties?: WalkBudget; listing?: WalkBudget } = {},
): FileSource {
  const propertiesBudget = budgets.properties ?? DEFAULT_BUDGET;
  const listingBudget = budgets.listing ?? LISTING_BUDGET;

  const resolveInside = async (segments: string[]) => {
    const target = path.join(root, ...segments);
    let real: string;
    let realRoot: string;
    try {
      [real, realRoot] = await Promise.all([fs.realpath(target), fs.realpath(root)]);
    } catch (e) {
      explain(e);
    }
    if (!within(real, realRoot))
      throw new ForbiddenError("That item is outside the watched folder.");
    return real;
  };

  return {
    displayPath: (segments) => path.join(root, ...segments),

    async list(segments, limit) {
      const dir = await resolveInside(segments);
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        explain(e);
      }
      const allowance = new Allowance(listingBudget);
      const entries: FileEntry[] = [];
      for (const d of dirents) {
        const full = path.join(dir, d.name);
        let st: Stats;
        try {
          st = await fs.stat(full);
        } catch {
          continue; // protected system items (e.g. "System Volume Information")
        }
        const rel = joinRelative([...segments, d.name]);
        if (st.isDirectory()) {
          // A link inside the folder may point elsewhere; never total what is behind it.
          const isLink = d.isSymbolicLink();
          const totals =
            isLink || allowance.exhausted
              ? cachedTotals(full)
              : await folderTotals(full, allowance);
          entries.push({
            name: d.name,
            path: rel,
            kind: "folder",
            modifiedAt: iso(st.mtime),
            itemCount: isLink
              ? undefined
              : await fs.readdir(full).then(
                  (x) => x.length,
                  () => undefined,
                ),
            sizeBytes: totals?.complete ? totals.bytes : undefined,
          });
        } else if (st.isFile()) {
          entries.push({
            name: d.name,
            path: rel,
            kind: "file",
            sizeBytes: st.size,
            modifiedAt: iso(st.mtime),
          });
        }
      }
      sortEntries(entries);
      return { entries: entries.slice(0, limit), total: entries.length };
    },

    async properties(segments) {
      const target = await resolveInside(segments);
      let st: Stats;
      try {
        st = await fs.stat(target);
      } catch (e) {
        explain(e);
      }
      const name = segments.at(-1) ?? (path.basename(root) || root);
      const base = {
        name,
        displayPath: path.join(root, ...segments),
        createdAt: iso(st.birthtime),
        modifiedAt: iso(st.mtime),
        accessedAt: iso(st.atime),
        readOnly: (st.mode & 0o200) === 0,
      };
      if (st.isFile()) {
        return {
          ...base,
          kind: "file",
          extension: extensionOf(name),
          sizeBytes: st.size,
          complete: true,
        };
      }
      const totals = await folderTotals(target, new Allowance(propertiesBudget));
      return {
        ...base,
        kind: "folder",
        sizeBytes: totals.bytes,
        files: totals.files,
        folders: totals.folders,
        complete: totals.complete,
      };
    },
  };
}

/** For tests: forget remembered folder sizes. */
export function clearSizeCache() {
  sizeCache.clear();
}
