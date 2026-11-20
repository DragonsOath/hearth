import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { and, desc, eq, gte, isNull, like, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { getSetting, setSetting } from "../store/settings";
import type { FileManager, FileRoot } from "./files";

/**
 * Recently Added (spec section 7): an index of every file on this machine's drives, so a new
 * file shows with its path, size, and when it arrived, and history survives a move or a
 * delete. A full pass over the home server's three data drives (about 57,000 files) takes a few seconds,
 * so it runs every ten minutes and on request, reading folder entries and sizes only (never file
 * contents). The first pass over a drive cannot know arrival times, so it uses each file's own
 * modified time and says so ("timestamp"); after that, arrivals are what Hearth saw ("observed").
 */

/** Not files you add: recycle bins and system folders, and code projects' own machinery. */
const SKIP =
  /^(\$RECYCLE\.BIN|System Volume Information|\.Trash-\d+|lost\+found|@eaDir|\.snapshots?|node_modules|\.git|\.venv|venv|__pycache__|\.cache|\.pnpm-store|\.next|\.turbo)$/i;
const PARTIAL = /\.(!qb|part|partial|crdownload|tmp)$/i;
const BUDGET = { maxEntries: 600_000, maxMs: 120_000 };

export type AddedKind = "video" | "audio" | "book" | "image" | "subtitle" | "other";
const KINDS: [AddedKind, RegExp][] = [
  ["video", /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm|m2ts)$/i],
  ["audio", /\.(mp3|flac|m4a|m4b|aac|ogg|opus|wav|wma)$/i],
  ["book", /\.(epub|pdf|mobi|azw3?|cbz|cbr)$/i],
  ["image", /\.(jpe?g|png|gif|webp|bmp|tiff?|heic)$/i],
  ["subtitle", /\.(srt|ass|ssa|vtt|sub|idx)$/i],
];
export const kindOf = (name: string): AddedKind =>
  KINDS.find(([, re]) => re.test(name))?.[0] ?? "other";

export interface AddedFile {
  name: string;
  /** The file on this machine. */
  path: string;
  folder: string;
  drive: string;
  sizeBytes: number;
  kind: AddedKind;
  addedAt: string;
  /** observed: Hearth saw it arrive. timestamp: it was already there; its modified time stands in. */
  basis: "observed" | "timestamp";
  modifiedAt: string;
  partial: boolean;
  /** Moved or deleted since (Hearth no longer sees it here). */
  goneAt?: string;
  /** The same file (name and size) that left another place in the same pass. */
  movedFrom?: string;
  /** Where it is in your setup: a library folder Radarr, Sonarr, or Plex use, or a download folder. */
  place?: Place;
  /** Observed arrivals: the check before the one that saw it (it arrived in between). */
  seenAfter?: string;
  /** Other places the same file is (hardlinks: one copy of the data, no extra space). */
  sameFileAs?: string[];
  open?: { rootId: string; folder: string; name: string };
}

/** A folder your apps use, found from their own container mounts (this machine's path). */
export interface Place {
  path: string;
  /** The folder's own name ("New Releases"). */
  label: string;
  role: "library" | "downloads";
  /** The apps that use it ("Radarr, Plex"). */
  apps: string[];
}

export interface IndexRun {
  at: string;
  tookMs: number;
  files: number;
  added: number;
  gone: number;
  complete: boolean;
}

export class FileIndexer {
  private running: Promise<IndexRun | undefined> | undefined;
  last: IndexRun | undefined;
  private timer: NodeJS.Timeout | undefined;
  private next?: Promise<IndexRun | undefined>;
  /** Moves seen in the latest pass: new path -> old path. */
  private moves = new Map<string, string>();

  constructor(
    private readonly handle: DbHandle,
    private readonly files: FileManager,
    /**
     * Folders that are app internals, not files you add: settings (/config), caches, transcodes,
     * Docker's own storage. Found from the containers' mounts; skipped and cleared from the index.
     */
    private readonly noise: () => Promise<string[]> = async () => [],
    /** Your library and download folders (from the apps' mounts). */
    private readonly places: () => Promise<Place[]> = async () => [],
  ) {}

  /** Every ten minutes, first shortly after start; only for your own systems (not sample data). */
  start(everyMs = 10 * 60_000, firstMs = 30_000) {
    const tick = () => void this.run().catch(() => undefined);
    this.timer = setTimeout(tick, firstMs);
    const interval = setInterval(tick, everyMs);
    interval.unref?.();
    this.timer.unref?.();
    return () => {
      clearTimeout(this.timer);
      clearInterval(interval);
    };
  }

  /**
   * A pass that starts now or after the one in progress: a check asked for during a pass must
   * see what changed since that pass began (a folder just added). Requests made while one is
   * waiting share it, so passes never pile up.
   */
  run(): Promise<IndexRun | undefined> {
    if (!this.running) {
      this.running = this.pass().finally(() => {
        this.running = undefined;
      });
      return this.running;
    }
    this.next ??= this.running
      .catch(() => undefined)
      .then(() => {
        this.next = undefined;
        return this.run();
      });
    return this.next;
  }

  private async pass(): Promise<IndexRun | undefined> {
    const { db } = this.handle;
    if ((await getSetting(db, "environment")) !== "real") return undefined;
    const roots = (await this.files.roots()).filter(
      (r) => r.kind === "drive" || r.kind === "watched",
    );
    const started = Date.now();
    const now = new Date().toISOString();
    const noise = await this.noise().catch(() => []);
    const places = (await this.places().catch(() => [] as Place[])).map((p) => p.path);
    const watched = roots.filter((r) => r.kind === "watched").map((r) => r.path);
    // A watched folder you removed is no longer looked at: its files are cleared, not reported
    // as deleted. A drive that is missing (a USB drive unplugged) keeps its history.
    const current = new Set(roots.map((r) => r.id));
    const watchedIds = new Set(
      (await db.select({ id: t.storageLocations.id }).from(t.storageLocations)).map((l) => l.id),
    );
    for (const r of await db.selectDistinct({ rootId: t.fileIndex.rootId }).from(t.fileIndex))
      if (!current.has(r.rootId) && !r.rootId.startsWith("vol-") && !watchedIds.has(r.rootId))
        await db.delete(t.fileIndex).where(eq(t.fileIndex.rootId, r.rootId));
    for (const n of noise)
      await db
        .delete(t.fileIndex)
        .where(like(t.fileIndex.path, `${n.replace(/[\\/]+$/, "")}${path.sep}%`));
    let seen = 0;
    let added = 0;
    let gone = 0;
    let complete = true;
    const done = new Set<string>();
    this.moves = new Map();
    // Per root: when it was first walked completely, and which folders were walked. A file is an
    // arrival only when its folder was already watched completely before; otherwise it was
    // there all along and is dated by its file (an early pass that stopped short, or a folder
    // newly brought into scope, never makes old files look new).
    const state = { ...((await getSetting(db, "file_index_roots")) ?? {}) };
    // A watched folder inside a drive is already covered by the drive's pass.
    const ownPassSkipped = (root: (typeof roots)[number]) =>
      root.kind === "watched" && roots.some((r) => r.kind === "drive" && inside(root.path, r.path));
    for (const root of roots) {
      if (ownPassSkipped(root)) continue;
      // The app drive (it holds Hearth's own data) is mostly app internals: only your library
      // and download folders, and folders you chose to watch, are files you add. Data drives: all.
      const appDrive = this.files.holdsSecrets(root.path);
      // Drives and folders inside this one are walked on their own (a watched /mnt holds them).
      const others = roots
        .filter((r) => r.id !== root.id && r.path !== root.path && inside(r.path, root.path))
        .filter((r) => !ownPassSkipped(r))
        .map((r) => r.path);
      const starts = (
        appDrive
          ? outermost(
              [...places, ...watched.filter((w) => !this.files.holdsSecrets(w))].filter((p) =>
                inside(p, root.path),
              ),
            )
          : [root.path]
      ).filter((p) => !others.some((o) => inside(p, o)));
      const was = state[root.id];
      const established = (p: string) =>
        Boolean(was?.complete) && was!.starts.some((st) => inside(p, st));
      const inScope = (p: string) =>
        !p.split(/[\\/]/).some((seg) => SKIP.test(seg)) &&
        (!appDrive || starts.some((s) => inside(p, s)));
      const found = await this.walk(root, started, [...noise, ...others], starts);
      seen += found.files.size;
      if (!found.complete) complete = false;
      const known = new Map(
        (await db.select().from(t.fileIndex).where(eq(t.fileIndex.rootId, root.id))).map((r) => [
          r.path,
          r,
        ]),
      );
      const first = known.size === 0;
      state[root.id] = found.complete
        ? { complete: was?.complete ?? now, starts }
        : { ...(was?.complete ? { complete: was.complete } : {}), starts: was?.starts ?? [] };
      // The previous check of this drive: anything new arrived after it (honest after downtime).
      const previous = [...known.values()].reduce<string | undefined>(
        (m, k) => (!m || k.lastSeenAt > m ? k.lastSeenAt : m),
        undefined,
      );
      // Only a complete pass may say a file is gone (a stopped pass just did not get there).
      const left: (typeof t.fileIndex.$inferSelect)[] = [];
      // No longer looked at (an app folder, code machinery): cleared, not reported as deleted.
      const dropped: string[] = [];
      if (found.complete)
        for (const k of known.values())
          if (!found.files.has(k.path)) {
            if (!inScope(k.path)) dropped.push(k.path);
            else if (!k.goneAt) {
              left.push(k);
              gone += 1;
            }
          }
      // Where a new file came from: the same name and size that left elsewhere (a move or a
      // rename into a library folder), or its partial download that just finished ("x.mkv.!qB").
      const originOf = (p: string, size: number) =>
        left.find((l) => path.basename(l.path) === path.basename(p) && l.sizeBytes === size) ??
        left.find(
          (l) =>
            path.dirname(l.path) === path.dirname(p) &&
            PARTIAL.test(l.path) &&
            l.path.replace(PARTIAL, "") === p,
        );
      const rows: (typeof t.fileIndex.$inferInsert)[] = [];
      for (const [p, f] of found.files) {
        if (done.has(p)) continue;
        done.add(p);
        const k = known.get(p);
        const from = k ? undefined : originOf(p, f.size);
        const arrival = !k && !first && established(p);
        if (arrival) added += 1;
        if (from) this.moves.set(p, from.path);
        rows.push({
          path: p,
          rootId: root.id,
          hostId: root.hostId,
          sizeBytes: f.size,
          modifiedAt: f.mtime,
          firstSeenAt: k?.firstSeenAt ?? (arrival ? now : f.mtime),
          basis: k?.basis ?? (arrival ? "observed" : "timestamp"),
          lastSeenAt: now,
          goneAt: null,
          seenAfter: k ? k.seenAfter : arrival ? (previous ?? null) : null,
          movedFrom: k ? k.movedFrom : (from?.path ?? null),
          fileKey: f.key,
          links: f.links,
        });
      }
      await db.transaction(async (tx) => {
        for (let i = 0; i < rows.length; i += 500)
          await tx
            .insert(t.fileIndex)
            .values(rows.slice(i, i + 500))
            .onConflictDoUpdate({
              target: t.fileIndex.path,
              set: {
                sizeBytes: sqlExcluded("size_bytes"),
                modifiedAt: sqlExcluded("modified_at"),
                lastSeenAt: sqlExcluded("last_seen_at"),
                fileKey: sqlExcluded("file_key"),
                links: sqlExcluded("links"),
                goneAt: null,
              },
            });
        for (const l of left)
          await tx.update(t.fileIndex).set({ goneAt: now }).where(eq(t.fileIndex.path, l.path));
        for (const d of dropped) await tx.delete(t.fileIndex).where(eq(t.fileIndex.path, d));
      });
    }
    await setSetting(db, "file_index_roots", state);
    this.last = { at: now, tookMs: Date.now() - started, files: seen, added, gone, complete };
    return this.last;
  }

  private async walk(root: FileRoot, started: number, noise: string[], starts: string[]) {
    const files = new Map<string, { size: number; mtime: string; key: string; links: number }>();
    let complete = true;
    const stack = [...starts];
    let entries = 0;
    while (stack.length) {
      if (entries > BUDGET.maxEntries || Date.now() - started > BUDGET.maxMs) {
        complete = false;
        break;
      }
      const dir = stack.pop()!;
      const dirents: Dirent[] = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        entries += 1;
        if (d.isSymbolicLink() || SKIP.test(d.name)) continue;
        const full = path.join(dir, d.name);
        if (this.files.hidden(full)) continue;
        if (d.isDirectory()) {
          if (!noise.some((n) => inside(full, n))) stack.push(full);
        } else if (d.isFile()) {
          const st = await fs.stat(full).catch(() => undefined);
          if (st)
            files.set(full, {
              size: st.size,
              mtime: st.mtime.toISOString(),
              key: `${st.dev}:${st.ino}`,
              links: st.nlink,
            });
        }
      }
    }
    return { files, complete };
  }

  /** Files added in the window, newest first, with where to open them. */
  async added(opts: {
    days: number;
    kind?: AddedKind | "all";
    q?: string;
    includeGone?: boolean;
    /** observed (default): only files Hearth saw arrive. all: also those already there. */
    arrivals?: "observed" | "all";
    limit?: number;
    places?: Place[];
    role?: "library" | "downloads" | "all";
  }): Promise<{ files: AddedFile[]; total: number; last?: IndexRun; indexed: number }> {
    const { db } = this.handle;
    const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
    const rows = await db
      .select()
      .from(t.fileIndex)
      .where(
        and(
          gte(t.fileIndex.firstSeenAt, since),
          opts.includeGone ? undefined : isNull(t.fileIndex.goneAt),
          opts.arrivals === "all" ? undefined : eq(t.fileIndex.basis, "observed"),
        ),
      )
      .orderBy(desc(t.fileIndex.firstSeenAt))
      .limit(5000);
    const roots = await this.files.roots();
    const words = (opts.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const placeOf = (p: string) =>
      (opts.places ?? [])
        .filter((x) => inside(p, x.path))
        .sort((a, b) => b.path.length - a.path.length)[0];
    const matched = rows.filter((r) => {
      const name = path.basename(r.path);
      if (opts.kind && opts.kind !== "all" && kindOf(name) !== opts.kind) return false;
      if (opts.role && opts.role !== "all" && placeOf(r.path)?.role !== opts.role) return false;
      return words.every((w) => r.path.toLowerCase().includes(w));
    });
    const out: AddedFile[] = [];
    for (const r of matched.slice(0, opts.limit ?? 300)) {
      const name = path.basename(r.path);
      const drive = roots.find((x) => x.id === r.rootId);
      const open = r.goneAt ? undefined : await this.files.locate(r.path);
      const moved = r.movedFrom ?? this.moves.get(r.path);
      const twins =
        r.fileKey && (r.links ?? 1) > 1
          ? (
              await db
                .select({ path: t.fileIndex.path })
                .from(t.fileIndex)
                .where(and(eq(t.fileIndex.fileKey, r.fileKey), isNull(t.fileIndex.goneAt)))
            )
              .map((x) => x.path)
              .filter((x) => x !== r.path)
          : [];
      const place = placeOf(r.path);
      out.push({
        name,
        path: r.path,
        folder: path.dirname(r.path),
        drive: drive?.label ?? r.rootId,
        sizeBytes: r.sizeBytes,
        kind: kindOf(name),
        addedAt: r.firstSeenAt,
        basis: r.basis,
        ...(r.seenAfter ? { seenAfter: r.seenAfter } : {}),
        ...(twins.length ? { sameFileAs: twins } : {}),
        modifiedAt: r.modifiedAt,
        partial: PARTIAL.test(name),
        ...(r.goneAt ? { goneAt: r.goneAt } : {}),
        ...(moved ? { movedFrom: moved } : {}),
        ...(place ? { place } : {}),
        ...(open ? { open } : {}),
      });
    }
    const n = (await db.select({ n: countAll() }).from(t.fileIndex))[0]?.n ?? 0;
    return {
      files: out,
      total: matched.length,
      ...(this.last ? { last: this.last } : {}),
      indexed: n,
    };
  }
}

const sqlExcluded = (col: string) => sql.raw(`excluded.${col}`);
const countAll = () => sql<number>`count(*)`;

/** The folders to walk, without walking one twice because it sits inside another. */
function outermost(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((p) => !unique.some((o) => o !== p && inside(p, o)));
}

function inside(child: string, parent: string) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
