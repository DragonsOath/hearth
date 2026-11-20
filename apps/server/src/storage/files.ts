import { createReadStream, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type { FileEntry, FolderListing, ItemProperties } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { redactLine } from "../actions/redact";
import { classify } from "../admin/scope";
import { ForbiddenError, NotFoundError } from "../store/errors";
import { getSetting } from "../store/settings";
import { DEMO_TREES, demoSource } from "./demo-source";
import { fsSource, type WalkBudget } from "./fs-source";
import type { VolumeNames } from "./names";
import { extensionOf, joinRelative, toSegments, type FileSource } from "./source";

/**
 * The Storage & Files file manager (spec section 6): browse this machine's drives from their
 * mount points, plus any folder you chose to watch. Read only here: list, sort, search, folder
 * sizes on demand, properties, a preview of text and images, and download. Secrets never show:
 * Hearth's own data and key folders, private keys and credential stores are left out of every
 * listing and refused by path; app settings files (which hold API keys) are listed but never
 * previewed or downloaded. Symlinks never lead outside a drive (fsSource checks every real path).
 */

export interface FileRoot {
  id: string;
  /** Your name for the drive ("Film"), or its mount when it has none. */
  label: string;
  /** Set when you named it: the label is then a name, and path is the real mount. */
  named?: boolean;
  path: string;
  hostId: string;
  kind: "drive" | "watched" | "sample";
}

/** System mounts that are not storage you browse. */
const SYSTEM_MOUNT = /^(\/|\/boot(\/.*)?|\/efi|\/snap(\/.*)?|\/var\/snap(\/.*)?|\/run(\/.*)?)$/;
/** The operating system's own disk ("/" on Linux, the Windows drive on Windows): not storage. */
function systemMount(mount: string): boolean {
  if (SYSTEM_MOUNT.test(mount.replace(/\/+$/, "") || "/")) return true;
  const win = (process.env.SystemDrive ?? "C:").toUpperCase();
  return /^[A-Z]:[\\/]?$/i.test(mount) && mount.slice(0, 2).toUpperCase() === win;
}

/** Settings files: listed, but they hold API keys and passwords, so never opened here. */
const SETTINGS_FILE =
  /^(\.env(\..*)?|.*\.(env|ini|conf|cfg|config|toml|db|sqlite|sqlite3|db-wal|db-shm|kdbx)|config\.(xml|json|ya?ml)|settings\.(json|ya?ml)|.*credentials.*|.*secret.*|.*token.*|qBittorrent\.conf|sabnzbd\.ini)$/i;
const TEXT_FILE = /\.(txt|log|nfo|srt|ass|ssa|vtt|md|csv|tsv|sub)$/i;
const IMAGE_FILE = /\.(jpe?g|png|gif|webp|bmp)$/i;
const TEXT_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 15 * 1024 * 1024;
/** Listing a big drive's folders totals each subfolder within this budget; full sizes on request. */
const LISTING: WalkBudget = { maxEntries: 40_000, maxMs: 2_500 };

export class FileManager {
  constructor(
    private readonly handle: DbHandle,
    private readonly secretRoots: string[],
    private readonly names?: VolumeNames,
  ) {}

  /** Hidden from the file manager entirely: Hearth's own secrets and credential stores. */
  hidden(abs: string): boolean {
    // classify works in "/" paths; Windows paths are compared the same way.
    const slash = (x: string) => x.replaceAll("\\", "/");
    return (
      classify(slash(abs), {
        secretRoots: this.secretRoots.map(slash),
        protectedRoots: [],
      }).class === "secret"
    );
  }

  /** Whether a drive holds Hearth's own data or keys (the app drive, not a media drive). */
  holdsSecrets(rootPath: string): boolean {
    return this.secretRoots.some((r) => inside(r, rootPath));
  }

  async roots(): Promise<FileRoot[]> {
    const { db } = this.handle;
    const demo = (await getSetting(db, "environment")) === "demo";
    const [hosts, volumes, locations] = await Promise.all([
      db.select().from(t.hosts),
      db.select().from(t.volumes),
      db.select().from(t.storageLocations),
    ]);
    const local = hosts.find((h) => h.connection === "this-machine");
    const named = (await this.names?.all()) ?? new Map<string, string>();
    const out: FileRoot[] = [];
    if (!demo && local)
      for (const v of volumes.filter((v) => v.hostId === local.id)) {
        if (systemMount(v.mount)) continue;
        const name = named.get(v.mount.length > 1 ? v.mount.replace(/[\\/]+$/, "") : v.mount);
        out.push({
          id: `vol-${v.id}`,
          label: name ?? v.mount,
          ...(name ? { named: true } : {}),
          path: v.mount,
          hostId: v.hostId,
          kind: "drive",
        });
      }
    for (const l of locations) {
      if (l.source === "demo" && !demo) continue;
      // A watched folder is a shortcut, even when its drive is listed too.
      out.push({
        id: l.id,
        label: l.label,
        path: l.path,
        hostId: l.hostId,
        kind: l.source === "demo" ? "sample" : "watched",
      });
    }
    return out;
  }

  private async root(id: string): Promise<{ root: FileRoot; source: FileSource }> {
    const root = (await this.roots()).find((r) => r.id === id);
    if (!root) throw new NotFoundError("That drive or folder is not available in Hearth.");
    if (root.kind === "sample") {
      const tree = root.id.replace(/^demo-/, "");
      if (!(tree in DEMO_TREES)) throw new NotFoundError("This sample location has no contents.");
      return { root, source: demoSource(tree as keyof typeof DEMO_TREES, root.path) };
    }
    return { root, source: fsSource(root.path, { listing: LISTING }) };
  }

  /**
   * A whole folder tree to read (Collection PDF): listings without folder sizes (the scanner adds
   * them up itself), and Hearth's secret folders left out like everywhere else.
   */
  async scanSource(
    rootId: string,
    relative?: string,
  ): Promise<{ root: FileRoot; segments: string[]; source: FileSource }> {
    const { root, source: shown } = await this.root(rootId);
    const segments = toSegments(relative);
    this.refuseHidden(root, segments);
    if (root.kind === "sample") return { root, segments, source: shown };
    const raw = fsSource(root.path, { listing: { maxEntries: 0, maxMs: 0 } });
    const source: FileSource = {
      displayPath: (s) => raw.displayPath(s),
      properties: (s) => raw.properties(s),
      list: async (s, limit) => {
        const r = await raw.list(s, limit);
        return {
          ...r,
          entries: r.entries.filter((e) => !this.hidden(path.join(root.path, ...s, e.name))),
        };
      },
    };
    return { root, segments, source };
  }

  private refuseHidden(root: FileRoot, segments: string[]) {
    if (root.kind !== "sample" && this.hidden(path.join(root.path, ...segments)))
      throw new ForbiddenError("That holds secrets, so Hearth never opens it.");
  }

  async list(rootId: string, relative?: string): Promise<FolderListing & { hidden: number }> {
    const { root, source } = await this.root(rootId);
    const segments = toSegments(relative);
    this.refuseHidden(root, segments);
    const { entries, total } = await source.list(segments, 5000);
    const shown =
      root.kind === "sample"
        ? entries
        : entries.filter((e) => !this.hidden(path.join(root.path, ...segments, e.name)));
    const files = shown.filter((e) => e.kind === "file");
    return {
      locationId: root.id,
      path: joinRelative(segments),
      displayPath: source.displayPath(segments),
      breadcrumbs: [
        { name: root.label, path: "" },
        ...segments.map((name, i) => ({ name, path: joinRelative(segments.slice(0, i + 1)) })),
      ],
      entries: shown,
      truncated: total > entries.length,
      totals: {
        folders: shown.length - files.length,
        files: files.length,
        fileBytes: files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0),
      },
      hidden: entries.length - shown.length,
    };
  }

  async properties(rootId: string, relative?: string): Promise<ItemProperties> {
    const { root, source } = await this.root(rootId);
    const segments = toSegments(relative);
    this.refuseHidden(root, segments);
    const p = await source.properties(segments);
    return segments.length ? p : { ...p, name: root.label };
  }

  /**
   * Names containing the words, in this folder and below. Bounded (depth, entries, time) so a
   * search of a 20 TB drive answers in seconds and says when it stopped early.
   */
  async search(
    rootId: string,
    relative: string | undefined,
    query: string,
  ): Promise<{ results: (FileEntry & { folder: string })[]; complete: boolean; scanned: number }> {
    const { root } = await this.root(rootId);
    const segments = toSegments(relative);
    this.refuseHidden(root, segments);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || root.kind === "sample") return { results: [], complete: true, scanned: 0 };
    const results: (FileEntry & { folder: string })[] = [];
    const started = Date.now();
    let scanned = 0;
    let complete = true;
    const queue: { abs: string; rel: string[]; depth: number }[] = [
      { abs: path.join(root.path, ...segments), rel: segments, depth: 0 },
    ];
    while (queue.length) {
      if (scanned > 60_000 || Date.now() - started > 5000 || results.length >= 200) {
        complete = false;
        break;
      }
      const { abs, rel, depth } = queue.shift()!;
      const dirents: Dirent[] = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        scanned += 1;
        if (d.isSymbolicLink()) continue;
        const full = path.join(abs, d.name);
        if (this.hidden(full)) continue;
        const childRel = [...rel, d.name];
        if (d.isDirectory() && depth < 8)
          queue.push({ abs: full, rel: childRel, depth: depth + 1 });
        const name = d.name.toLowerCase();
        if (!words.every((w) => name.includes(w))) continue;
        const st = await fs.stat(full).catch(() => undefined);
        results.push({
          name: d.name,
          path: joinRelative(childRel),
          folder: joinRelative(rel),
          kind: d.isDirectory() ? "folder" : "file",
          ...(st && !d.isDirectory() ? { sizeBytes: st.size } : {}),
          ...(st ? { modifiedAt: st.mtime.toISOString() } : {}),
        });
      }
    }
    return { results, complete, scanned };
  }

  /** What a file can show inside Hearth: text (redacted) or an image; never settings files. */
  async preview(
    rootId: string,
    relative: string,
  ): Promise<
    | { kind: "text"; text: string; truncated: boolean }
    | { kind: "image" }
    | { kind: "none"; why: string }
  > {
    const { root, abs, size } = await this.file(rootId, relative);
    const name = path.basename(abs);
    if (SETTINGS_FILE.test(name))
      return {
        kind: "none",
        why: "Settings files can hold API keys and passwords, so Hearth does not open them here.",
      };
    if (root.kind === "sample") return { kind: "none", why: "Sample files have no contents." };
    if (IMAGE_FILE.test(name))
      return size <= IMAGE_LIMIT
        ? { kind: "image" }
        : { kind: "none", why: "The image is too large to preview." };
    if (!TEXT_FILE.test(name)) return { kind: "none", why: "No preview for this kind of file." };
    const fh = await fs.open(abs, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, TEXT_LIMIT));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.includes(0)) return { kind: "none", why: "This file is not text." };
      const text = buf
        .toString("utf8")
        .split("\n")
        .map((l) => redactLine(l))
        .join("\n");
      return { kind: "text", text, truncated: size > TEXT_LIMIT };
    } finally {
      await fh.close();
    }
  }

  /** A file to send to the owner's browser (download, or an image shown inline). */
  async open(
    rootId: string,
    relative: string,
  ): Promise<{ stream: NodeJS.ReadableStream; name: string; size: number; image: boolean }> {
    const { root, abs, size } = await this.file(rootId, relative);
    const name = path.basename(abs);
    if (root.kind === "sample") throw new NotFoundError("Sample files have no contents.");
    if (SETTINGS_FILE.test(name))
      throw new ForbiddenError(
        "Settings files can hold API keys and passwords, so Hearth does not hand them out.",
      );
    return { stream: createReadStream(abs), name, size, image: IMAGE_FILE.test(name) };
  }

  private async file(rootId: string, relative: string) {
    const { root, source } = await this.root(rootId);
    const segments = toSegments(relative);
    if (!segments.length) throw new NotFoundError("Choose a file.");
    this.refuseHidden(root, segments);
    // properties() resolves the real path and refuses anything outside the drive.
    const p = await source.properties(segments);
    if (p.kind !== "file") throw new NotFoundError("That is a folder.");
    const abs = path.join(root.path, ...segments);
    return { root, abs, size: p.sizeBytes ?? 0 };
  }

  /** Where a path on this machine is in the file manager (for "Open in folder"). */
  async locate(
    hostPath: string,
  ): Promise<{ rootId: string; folder: string; name: string } | undefined> {
    const roots = (await this.roots()).filter((r) => r.kind !== "sample");
    const best = roots
      .filter((r) => inside(hostPath, r.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!best || this.hidden(hostPath)) return undefined;
    const rel = path.relative(best.path, hostPath).split(path.sep).filter(Boolean);
    return { rootId: best.id, folder: joinRelative(rel.slice(0, -1)), name: rel.at(-1) ?? "" };
  }
}

export function inside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** A path as a container sees it, on this machine, from the container's mounts (longest match). */
export function hostPathOf(
  containerPath: string,
  mounts: { source: string; destination: string }[],
): string | undefined {
  const m = mounts
    .filter(
      (x) =>
        containerPath === x.destination ||
        containerPath.startsWith(x.destination.replace(/\/?$/, "/")),
    )
    .sort((a, b) => b.destination.length - a.destination.length)[0];
  if (!m) return undefined;
  return path.posix.join(m.source, containerPath.slice(m.destination.length));
}

export { extensionOf };
