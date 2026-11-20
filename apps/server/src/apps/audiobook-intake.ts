import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  appKindOf,
  AUDIO_EXT,
  cleanName,
  identify,
  PARTIAL_EXT,
  type IntakeBook,
  type IntakeConfig,
  type IntakeJob,
  type IntakeView,
  type StepChange,
  type StepParams,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { CredentialBroker } from "../credentials/broker";
import { getSetting, setSetting } from "../store/settings";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import type { Session } from "./qbittorrent-control";

/**
 * Audiobook intake (the owner, 2026-11-07), Hearth's version of his own Audiobook Organizer.
 *
 * Finished releases in the download folders the owner chose are judged once (and again only when
 * they change): each book's author and title come from its first file's tags (ffprobe, when this
 * machine has it), an author already in the library, the folder layout, and the names. A sure
 * book is copied into the library as <Author>/<Title> (the owner's layout: first author, no
 * series folder, no subtitle), every file checked by size and SHA-256 in a hidden staging folder
 * before it is put in place in one rename, and Audiobookshelf scans that library. Unsure ones wait
 * in the Intake tab. Originals stay (a torrent keeps seeding); a folder may remove them some days
 * after a verified import, never before, and never anything outside it.
 *
 * Unlike the organizer, nothing is read again on every page load: a release is judged when it
 * first settles and whenever its files change.
 */

const QUIET_MS = 10 * 60_000;
const MAX_FILES = 4000;
const JOBS_MAX = 300;

type Tags = Record<string, string>;
export type Probe = (file: string) => Promise<Tags | undefined>;

/** Reads a file's tags with ffprobe; undefined when ffprobe is not installed here. */
export const ffprobeTags: Probe = (file) =>
  new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format_tags", "-of", "json", file],
      { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error)
          return resolve((error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : {});
        try {
          const tags =
            (JSON.parse(stdout) as { format?: { tags?: Record<string, unknown> } }).format?.tags ??
            {};
          resolve(
            Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), String(v)])),
          );
        } catch {
          resolve({});
        }
      },
    );
  });

interface ServiceRow {
  id: string;
  name: string;
  localUrl: string | null;
  image?: string | null;
  lifecycle?: string;
  checkTarget?: string | null;
}

export interface IntakeDeps {
  probe?: Probe;
  /** A container's mounts, to turn its paths into this machine's. */
  mounts?: (container: string) => Promise<{ source: string; destination: string }[]>;
  qbSession?: (service: { id: string; name: string; localUrl: string }) => Session;
  now?: () => number;
}

export class IntakeRefused extends Error {}

const now = () => new Date().toISOString();
const inside = (root: string, p: string) => {
  const r = path.relative(path.resolve(root), path.resolve(p));
  return r !== "" && !r.startsWith("..") && !path.isAbsolute(r);
};

async function sha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

interface FileInfo {
  rel: string;
  abs: string;
  size: number;
  mtime: number;
}

/** Every file under a folder (bounded), with paths relative to it. */
async function walk(root: string, max = MAX_FILES): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  const visit = async (dir: string, depth: number) => {
    if (out.length >= max || depth > 6) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await visit(abs, depth + 1);
      else if (e.isFile()) {
        const st = await fs.stat(abs).catch(() => undefined);
        if (st) out.push({ rel: path.relative(root, abs), abs, size: st.size, mtime: st.mtimeMs });
      }
      if (out.length >= max) return;
    }
  };
  await visit(root, 0);
  return out;
}

/** The books in a release: each folder holding audio is one; loose .m4b files are one each. */
function booksIn(
  release: string,
  files: FileInfo[],
): { source: string; files: FileInfo[]; parents: string[] }[] {
  const audio = files.filter((f) => AUDIO_EXT.test(f.rel));
  const groups = new Map<string, FileInfo[]>();
  const loose = audio.filter((f) => path.dirname(f.rel) === ".");
  const allM4b = loose.length > 1 && loose.every((f) => /\.m4b$/i.test(f.rel));
  for (const f of audio) {
    const dir = path.dirname(f.rel);
    const key = dir === "." ? (allM4b ? f.rel : ".") : dir;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const single = key !== "." && AUDIO_EXT.test(key);
      const source = key === "." ? release : path.join(release, key);
      const parents = key === "." || single ? [] : key.split(/[\\/]/).slice(0, -1);
      // A folder book takes every file in it (covers, cue sheets); a loose m4b takes its companions.
      const own = single
        ? files.filter(
            (f) => path.dirname(f.rel) === "." && path.parse(f.rel).name === path.parse(key).name,
          )
        : key === "."
          ? files.filter((f) => path.dirname(f.rel) === ".")
          : files.filter((f) => f.rel.startsWith(key + path.sep) || f.rel.startsWith(`${key}/`));
      return { source, files: own.length ? own : list, parents };
    });
}

export class AudiobookIntake {
  private running = false;
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly deps: IntakeDeps = {},
  ) {}

  private get probe(): Probe {
    return this.deps.probe ?? ffprobeTags;
  }
  private time() {
    return this.deps.now?.() ?? Date.now();
  }

  /* ---------------- stored state ---------------- */

  private async configs(): Promise<Record<string, IntakeConfig>> {
    return (await getSetting(this.handle.db, "audiobook_intake")) ?? {};
  }
  private async saveConfig(id: string, c: IntakeConfig | undefined) {
    const all = await this.configs();
    if (c) all[id] = c;
    else delete all[id];
    await setSetting(this.handle.db, "audiobook_intake", all);
  }
  private async allJobs(): Promise<Record<string, IntakeJob[]>> {
    return (await getSetting(this.handle.db, "audiobook_intake_jobs")) ?? {};
  }
  private async jobs(id: string) {
    return (await this.allJobs())[id] ?? [];
  }
  private async saveJobs(id: string, list: IntakeJob[]) {
    const all = await this.allJobs();
    all[id] = list.slice(0, JOBS_MAX);
    await setSetting(this.handle.db, "audiobook_intake_jobs", all);
  }
  private async putJob(id: string, job: IntakeJob) {
    const list = (await this.jobs(id)).filter((j) => j.id !== job.id);
    list.unshift(job);
    await this.saveJobs(id, list);
  }

  private async services(): Promise<ServiceRow[]> {
    return (await this.handle.db.select().from(t.services).all()) as ServiceRow[];
  }

  /* ---------------- Audiobookshelf ---------------- */

  private abs<T>(
    svc: { id: string; localUrl: string },
    access: "read" | "change",
    purpose: string,
    method: "GET" | "POST",
    p: string,
  ) {
    return this.broker.use(
      { serviceId: svc.id, purpose, access, destination: svc.localUrl },
      async ({ value }) => {
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(joinUrl(svc.localUrl, p), {
            method,
            headers: { Authorization: `Bearer ${value}`, Accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          } as Parameters<Fetch>[1]);
        } catch {
          throw new AppUnreachableError("Audiobookshelf did not answer.");
        }
        if (!res.ok) throw new AppUnreachableError(`Audiobookshelf answered ${res.status}.`);
        return (await res.json().catch(() => ({}))) as T;
      },
    );
  }

  /** A container path as this machine sees it, through the container's mounts. */
  private async hostPath(svc: ServiceRow, p: string): Promise<string> {
    const container = svc.checkTarget?.startsWith("container:")
      ? svc.checkTarget.slice(10)
      : undefined;
    if (!container || !this.deps.mounts) return p;
    const mounts = await this.deps.mounts(container).catch(() => []);
    const norm = (x: string) => x.replace(/\/+$/, "");
    const best = mounts
      .filter(
        (m) => norm(p) === norm(m.destination) || norm(p).startsWith(`${norm(m.destination)}/`),
      )
      .sort((a, b) => b.destination.length - a.destination.length)[0];
    return best ? `${norm(best.source)}${norm(p).slice(norm(best.destination).length)}` : p;
  }

  /* ---------------- the view and the proposal ---------------- */

  async view(svc: { id: string; name: string; localUrl: string }): Promise<IntakeView> {
    const config = (await this.configs())[svc.id];
    const tags = (await this.probe(path.join(process.cwd(), ".hearth-no-such-file"))) !== undefined;
    const out: IntakeView = { jobs: await this.jobs(svc.id), tags };
    if (config) out.config = config;
    else
      try {
        out.proposal = await this.propose(svc);
      } catch (error) {
        out.error = error instanceof Error ? error.message : String(error);
      }
    return out;
  }

  private async propose(svc: {
    id: string;
    name: string;
    localUrl: string;
  }): Promise<NonNullable<IntakeView["proposal"]>> {
    const rows = (await this.services()).filter(
      (s) => s.lifecycle === "active" && s.localUrl && !s.checkTarget?.startsWith("demo:"),
    );
    const absRow =
      rows.find((s) => s.id === svc.id) ?? ({ ...svc, checkTarget: null } as ServiceRow);
    const notes: string[] = [];
    const libs = await this.abs<{
      libraries?: {
        id: string;
        name: string;
        mediaType?: string;
        folders?: { fullPath?: string }[];
      }[];
    }>(svc, "read", "read its libraries for audiobook intake", "GET", "/api/libraries");
    const libraries: IntakeConfig["libraries"] = [];
    for (const l of libs.libraries ?? []) {
      if (l.mediaType && l.mediaType !== "book") continue;
      const folder = l.folders?.find((f) => f.fullPath)?.fullPath;
      if (!folder) continue;
      libraries.push({ id: l.id, name: l.name, folder: await this.hostPath(absRow, folder) });
    }
    if (!libraries.length)
      notes.push(`${svc.name} has no book library with a folder Hearth can see.`);

    // Folders that already receive audiobooks: download categories named for them, except the
    // ones an app (Chaptarr, Readarr) uses, since that app imports those itself.
    const intake: IntakeConfig["intake"] = [];
    const add = (folder: string, label: string, removeAfterDays: number) => {
      if (!intake.some((i) => i.folder === folder)) intake.push({ folder, label, removeAfterDays });
    };
    const used = await this.arrCategories(rows);
    for (const s of rows) {
      const kind = appKindOf({ name: s.name, image: s.image ?? undefined });
      try {
        if (kind === "sabnzbd") {
          const cfg = await this.sab<{
            config?: {
              misc?: { complete_dir?: string };
              categories?: { name: string; dir?: string }[];
            };
          }>(s, "get_config");
          const complete = cfg.config?.misc?.complete_dir ?? "";
          for (const c of cfg.config?.categories ?? [])
            if (/audio ?books?/i.test(c.name) && !used.has(c.name) && complete) {
              const dir = c.dir
                ? c.dir.startsWith("/")
                  ? c.dir
                  : `${complete.replace(/\/+$/, "")}/${c.dir}`
                : `${complete}/${c.name}`;
              // Usenet downloads are copies: the original may go a few days after a verified import.
              add(await this.hostPath(s, dir), `${s.name}'s "${c.name}" category`, 3);
            }
        }
        if (kind === "qbittorrent" && this.deps.qbSession) {
          const cats = await this.deps.qbSession({ id: s.id, name: s.name, localUrl: s.localUrl! })(
            "read",
            "find its audiobook category for audiobook intake",
            (q) => q.get<Record<string, { savePath?: string }>>("/api/v2/torrents/categories"),
          );
          for (const [name, c] of Object.entries(cats))
            if (/audio ?books?/i.test(name) && !used.has(name) && c.savePath)
              // A torrent keeps seeding from here: never removed.
              add(await this.hostPath(s, c.savePath), `${s.name}'s "${name}" category`, 0);
        }
      } catch {
        notes.push(`${s.name} could not be read for its audiobook folders.`);
      }
    }
    if (!intake.length)
      notes.push(
        "No download folder for audiobooks was found: add one below (where finished audiobooks land).",
      );
    if (used.size) notes.push(`Left out: ${[...used].join(", ")}, which an app imports itself.`);
    return {
      enabled: true,
      intake,
      libraries,
      library: libraries[0]?.id ?? "",
      threshold: 0.8,
      notes,
    };
  }

  private async sab<T>(s: ServiceRow, mode: string): Promise<T> {
    return this.broker.use(
      {
        serviceId: s.id,
        purpose: "read SABnzbd's categories for audiobook intake",
        access: "read",
        destination: s.localUrl!,
      },
      async ({ value }) => {
        const res = await this.fetchImpl(
          joinUrl(s.localUrl!, `/api?mode=${mode}&output=json&apikey=${encodeURIComponent(value)}`),
          { signal: AbortSignal.timeout(TIMEOUT_MS) } as Parameters<Fetch>[1],
        );
        if (!res.ok) throw new AppUnreachableError(`${s.name} answered ${res.status}.`);
        return (await res.json()) as T;
      },
    );
  }

  /** Download categories an *arr app uses (they import those downloads themselves). */
  private async arrCategories(rows: ServiceRow[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const s of rows) {
      const kind = appKindOf({ name: s.name, image: s.image ?? undefined });
      if (!kind || !["radarr", "sonarr", "lidarr", "chaptarr"].includes(kind)) continue;
      const v = kind === "radarr" || kind === "sonarr" ? "/api/v3" : "/api/v1";
      try {
        const clients = await this.broker.use(
          {
            serviceId: s.id,
            purpose: "check which download categories it uses",
            access: "read",
            destination: s.localUrl!,
          },
          async ({ value }) => {
            const res = await this.fetchImpl(joinUrl(s.localUrl!, `${v}/downloadclient`), {
              headers: { "X-Api-Key": value, Accept: "application/json" },
              signal: AbortSignal.timeout(TIMEOUT_MS),
            } as Parameters<Fetch>[1]);
            return res.ok
              ? ((await res.json()) as { fields?: { name?: string; value?: unknown }[] }[])
              : [];
          },
        );
        for (const c of clients)
          for (const f of c.fields ?? [])
            if (/category$/i.test(f.name ?? "") && typeof f.value === "string" && f.value)
              out.add(f.value);
      } catch {
        // Not readable: nothing is excluded on a guess either way; the owner sees the folders.
      }
    }
    return out;
  }

  /* ---------------- judging releases ---------------- */

  private async knownAuthors(config: IntakeConfig): Promise<string[]> {
    const names = new Set<string>();
    for (const l of config.libraries)
      for (const e of await fs.readdir(l.folder, { withFileTypes: true }).catch(() => []))
        if (e.isDirectory() && !e.name.startsWith(".")) names.add(e.name);
    return [...names];
  }

  /** One release judged: its books, where they would go, and whether to import on its own. */
  private async judge(
    config: IntakeConfig,
    folder: string,
    release: string,
    files: FileInfo[],
    signature: string,
    known: string[],
    previous?: IntakeJob,
    single = false,
  ): Promise<IntakeJob> {
    const library =
      config.libraries.find((l) => l.id === (previous?.library ?? config.library)) ??
      config.libraries[0];
    const books: IntakeBook[] = [];
    // A single file dropped straight into the folder is its own release and its own book.
    const groups = single
      ? [{ source: release, files, parents: [] as string[] }]
      : booksIn(release, files);
    for (const b of groups) {
      const first = [...b.files]
        .filter((f) => AUDIO_EXT.test(f.rel))
        .sort((x, y) => x.rel.localeCompare(y.rel))[0];
      const tags = (first && (await this.probe(first.abs))) || {};
      const who = identify({
        tags,
        name: path.basename(b.source),
        release: path.basename(release),
        parents: b.parents,
        knownAuthors: known,
        tracks: b.files.filter((f) => AUDIO_EXT.test(f.rel)).length,
      });
      const destination = library ? path.join(library.folder, who.author, who.title) : "";
      books.push({ ...who, source: b.source, destination, collision: false });
    }
    return this.place(config, {
      id: previous?.id ?? createHash("sha1").update(release).digest("hex").slice(0, 16),
      name: path.basename(release),
      source: release,
      folder,
      status: "review",
      library: library?.id ?? "",
      books,
      message: "",
      foundAt: previous?.foundAt ?? now(),
      signature,
    });
  }

  /** Where each book lands now, and so whether the job can go on its own. */
  private async place(config: IntakeConfig, job: IntakeJob): Promise<IntakeJob> {
    const library = config.libraries.find((l) => l.id === job.library);
    if (!library) return { ...job, status: "review", message: "Choose a library for it." };
    let same = 0;
    for (const b of job.books) {
      b.destination = path.join(library.folder, b.author, b.title);
      const there = await fs.stat(b.destination).catch(() => undefined);
      b.collision = Boolean(there);
      if (there && (await this.sameFiles(b.source, b.destination))) same += 1;
    }
    if (job.books.length && same === job.books.length)
      return {
        ...job,
        status: "imported",
        message: "Already in your library.",
        importedAt: job.importedAt ?? now(),
      };
    if (!job.books.length) return { ...job, status: "skipped", message: "No audio files in it." };
    const clash = job.books.find((b) => b.collision);
    if (clash)
      return {
        ...job,
        status: "review",
        message: `Something different is already at ${clash.destination}.`,
      };
    const unsure = job.books.filter((b) => b.confidence < config.threshold);
    if (unsure.length)
      return {
        ...job,
        status: "review",
        message: `Not sure who or what ${unsure.length === 1 ? "this book is" : `${unsure.length} of the books are`}: check the names, then Import.`,
      };
    return { ...job, status: "ready", message: "Sure of every book: importing." };
  }

  /** The book's files are already at the destination (same names and sizes). */
  private async sameFiles(source: string, destination: string): Promise<boolean> {
    const st = await fs.stat(source).catch(() => undefined);
    if (!st) return false;
    const src = st.isFile()
      ? [{ rel: path.basename(source), size: st.size }]
      : (await walk(source)).map((f) => ({ rel: f.rel, size: f.size }));
    const dst = new Map((await walk(destination)).map((f) => [f.rel, f.size]));
    const audio = src.filter((f) => AUDIO_EXT.test(f.rel));
    return audio.length > 0 && audio.every((f) => dst.get(f.rel) === f.size);
  }

  /* ---------------- every couple of minutes ---------------- */

  async tick(only?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const [id, config] of Object.entries(await this.configs())) {
        if (!config.enabled || (only && only !== id)) continue;
        await this.pass(id, config).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  private async pass(id: string, config: IntakeConfig) {
    const known = await this.knownAuthors(config);
    let jobs = await this.jobs(id);
    for (const watch of config.intake) {
      const entries = await fs.readdir(watch.folder, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const release = path.join(watch.folder, e.name);
        const files = e.isDirectory()
          ? await walk(release)
          : e.isFile() && AUDIO_EXT.test(e.name)
            ? [
                await fs
                  .stat(release)
                  .then((s) => ({ rel: e.name, abs: release, size: s.size, mtime: s.mtimeMs })),
              ]
            : [];
        if (!files.length) continue;
        // Still being written: wait until it has been quiet for a while.
        if (files.some((f) => PARTIAL_EXT.test(f.rel))) continue;
        if (this.time() - Math.max(...files.map((f) => f.mtime)) < QUIET_MS) continue;
        const signature = createHash("sha1")
          .update(files.map((f) => `${f.rel}:${f.size}:${Math.round(f.mtime)}`).join("|"))
          .digest("hex");
        const previous = jobs.find((j) => j.source === release);
        if (previous && previous.signature === signature) continue;
        if (previous && (previous.status === "imported" || previous.status === "skipped")) continue;
        const job = await this.judge(
          config,
          watch.folder,
          release,
          files,
          signature,
          known,
          previous,
          !e.isDirectory(),
        );
        jobs = [job, ...jobs.filter((j) => j.id !== job.id)];
      }
    }
    await this.saveJobs(id, jobs);
    for (const job of jobs.filter((j) => j.status === "ready"))
      await this.importJob(id, config, job);
    await this.cleanup(id, config);
  }

  /** Copies every book, verified, into place in one rename each; then Audiobookshelf scans. */
  private async importJob(id: string, config: IntakeConfig, job: IntakeJob): Promise<IntakeJob> {
    const library = config.libraries.find((l) => l.id === job.library);
    let next: IntakeJob;
    try {
      if (!library) throw new IntakeRefused("Choose a library for it.");
      for (const b of job.books) {
        if (!inside(library.folder, b.destination))
          throw new IntakeRefused(`${b.destination} is not inside ${library.folder}.`);
        if (await fs.stat(b.destination).catch(() => undefined)) {
          if (await this.sameFiles(b.source, b.destination)) continue;
          throw new IntakeRefused(`Something different is already at ${b.destination}.`);
        }
        const st = await fs.stat(b.source);
        const files = st.isFile()
          ? (await fs.readdir(path.dirname(b.source)))
              .filter((n) => path.parse(n).name === path.parse(b.source).name)
              .map((n) => ({ rel: n, abs: path.join(path.dirname(b.source), n) }))
          : (await walk(b.source)).filter((f) => !PARTIAL_EXT.test(f.rel));
        const parent = path.dirname(b.destination);
        await fs.mkdir(parent, { recursive: true });
        const staging = path.join(
          parent,
          `.${path.basename(b.destination)}.hearth-${randomBytes(4).toString("hex")}`,
        );
        try {
          for (const f of files) {
            const to = path.join(staging, f.rel);
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.copyFile(f.abs, to);
            const [a, z] = await Promise.all([fs.stat(f.abs), fs.stat(to)]);
            if (a.size !== z.size || (await sha256(f.abs)) !== (await sha256(to)))
              throw new IntakeRefused(`The copy of ${f.rel} did not match the original.`);
          }
          await fs.rename(staging, b.destination);
        } catch (error) {
          await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }
      let scanned = "";
      const svc = (await this.services()).find((s) => s.id === id);
      if (svc?.localUrl)
        await this.abs(
          { id: svc.id, localUrl: svc.localUrl },
          "change",
          `scan ${library.name} after importing "${job.name}" (standing approval for audiobook intake)`,
          "POST",
          `/api/libraries/${encodeURIComponent(library.id)}/scan`,
        )
          .then(() => (scanned = ` ${svc.name} is scanning ${library.name}.`))
          .catch(
            () =>
              (scanned = ` ${svc.name} could not be asked to scan; it finds them on its next scan.`),
          );
      next = {
        ...job,
        status: "imported",
        importedAt: now(),
        message: `Copied ${job.books.length === 1 ? `to ${job.books[0]!.destination}` : `${job.books.length} books into ${library.folder}`}, every file checked.${scanned}`,
      };
    } catch (error) {
      next = {
        ...job,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await this.putJob(id, next);
    return next;
  }

  /** Removes originals only after a verified import, only where the folder allows it, only inside it. */
  private async cleanup(id: string, config: IntakeConfig) {
    const jobs = await this.jobs(id);
    let changed = false;
    for (const j of jobs) {
      if (j.status !== "imported" || !j.importedAt || j.message.startsWith("Removed")) continue;
      const watch = config.intake.find((w) => w.folder === j.folder);
      if (!watch || watch.removeAfterDays <= 0) continue;
      if (this.time() - Date.parse(j.importedAt) < watch.removeAfterDays * 86_400_000) continue;
      if (j.source === watch.folder || !inside(watch.folder, j.source)) continue;
      await fs.rm(j.source, { recursive: true, force: true }).catch(() => undefined);
      j.message = `Removed the original after ${watch.removeAfterDays} days. ${j.message}`;
      changed = true;
    }
    if (changed) await this.saveJobs(id, jobs);
  }

  /* ---------------- plans ---------------- */

  async plan(
    svc: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "");
    const done = (change: StepChange, p: StepParams): PlannedStep => ({
      ...base,
      label: change.summary,
      serviceName: svc.name,
      params: p,
      change,
    });
    if (op === "intake-setup") {
      const config = parseConfig(params?.config);
      const settings: StepChange["settings"] = [
        ...config.intake.map((w) => ({
          name: `Watch ${w.folder}`,
          before: "Not watched",
          after: `${w.label ? `${w.label}; ` : ""}${w.removeAfterDays > 0 ? `originals removed ${w.removeAfterDays} days after a verified import` : "originals kept"}`,
        })),
        ...config.libraries.map((l) => ({
          name: `Library ${l.name}`,
          before: "",
          after: `${l.folder}${l.id === config.library ? " (books go here unless you pick another)" : ""}, as <Author>/<Title>`,
        })),
        {
          name: "From now on",
          before: "Off",
          after: `Every few minutes, finished releases are identified; books at least ${Math.round(config.threshold * 100)}% sure are copied in, checked file by file, and Audiobookshelf scans. Unsure ones wait for you. Nothing in your downloads is moved.`,
        },
      ];
      return done(
        { summary: `Import finished audiobooks into ${svc.name}`, settings },
        { op, config: JSON.stringify(config) },
      );
    }
    if (op === "intake-off") {
      if (!(await this.configs())[svc.id]?.enabled)
        throw new IntakeRefused("Audiobook intake is already off.");
      return done(
        {
          summary: `Stop audiobook intake for ${svc.name}`,
          settings: [{ name: "Intake", before: "On", after: "Off (nothing imported is touched)" }],
        },
        { op },
      );
    }
    const config = (await this.configs())[svc.id];
    if (!config) throw new IntakeRefused("Set up audiobook intake first.");
    const job = (await this.jobs(svc.id)).find((j) => j.id === params?.job);
    if (!job) throw new IntakeRefused("That release is no longer in the intake list.");
    if (op === "intake-skip")
      return done(
        {
          summary: `Leave "${job.name}" out of your library`,
          settings: [
            {
              name: job.name,
              before: job.status,
              after: "Skipped (its files stay where they are)",
            },
          ],
        },
        { op, job: job.id },
      );
    if (op !== "intake-import")
      throw new IntakeRefused(
        'Say what to do: op "intake-setup", "intake-import", "intake-skip" or "intake-off".',
      );
    const edits = parseEdits(params?.books);
    const library =
      typeof params?.library === "string" && params.library ? params.library : job.library;
    if (!config.libraries.some((l) => l.id === library))
      throw new IntakeRefused("Choose one of the libraries intake was set up with.");
    const placed = await this.place(config, {
      ...job,
      library,
      books: job.books.map((b, i) => ({ ...b, ...(edits[i] ?? {}), confidence: 1 })),
    });
    const clash = placed.books.find((b) => b.collision);
    if (clash && placed.status !== "imported")
      throw new IntakeRefused(
        `Something different is already at ${clash.destination}. Change the name.`,
      );
    return done(
      {
        summary: `Import "${job.name}" into your audiobooks`,
        settings: placed.books.map((b) => ({
          name: path.basename(b.source),
          before: b.source,
          after: b.destination,
        })),
      },
      {
        op,
        job: job.id,
        library,
        books: JSON.stringify(placed.books.map((b) => ({ author: b.author, title: b.title }))),
      },
    );
  }

  async run(
    step: StepRun,
    svc: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op ?? "");
    if (op === "intake-setup") {
      const config = parseConfig(p.config);
      for (const w of config.intake)
        if (!(await fs.stat(w.folder).catch(() => undefined))?.isDirectory())
          return { ok: false, result: `Hearth cannot see the folder ${w.folder} on this machine.` };
      for (const l of config.libraries)
        if (!(await fs.stat(l.folder).catch(() => undefined))?.isDirectory())
          return {
            ok: false,
            result: `Hearth cannot see the library folder ${l.folder} on this machine.`,
          };
      await this.saveConfig(svc.id, {
        ...config,
        enabled: true,
        approvedBy: step.job?.id ?? "approved plan",
      });
      return {
        ok: true,
        verified: true,
        result: `Audiobook intake is on for ${svc.name}: ${config.intake.length} folder${config.intake.length === 1 ? "" : "s"} watched.`,
      };
    }
    if (op === "intake-off") {
      const c = (await this.configs())[svc.id];
      if (c) await this.saveConfig(svc.id, { ...c, enabled: false });
      return { ok: true, verified: true, result: "Audiobook intake is off." };
    }
    const config = (await this.configs())[svc.id];
    const job = (await this.jobs(svc.id)).find((j) => j.id === p.job);
    if (!config || !job)
      return { ok: false, stale: true, result: "That release is no longer in the intake list." };
    if (op === "intake-skip") {
      await this.putJob(svc.id, {
        ...job,
        status: "skipped",
        message: "Skipped by you; its files stay where they are.",
      });
      return { ok: true, result: `"${job.name}" is skipped.` };
    }
    const edits = parseEdits(p.books);
    const placed = await this.place(config, {
      ...job,
      library: String(p.library ?? job.library),
      books: job.books.map((b, i) => ({ ...b, ...(edits[i] ?? {}), confidence: 1 })),
    });
    const done =
      placed.status === "imported" ? placed : await this.importJob(svc.id, config, placed);
    if (placed.status === "imported") await this.putJob(svc.id, placed);
    return {
      ok: done.status === "imported",
      verified: done.status === "imported",
      result: done.message,
    };
  }
}

function parseEdits(raw: unknown): { author?: string; title?: string }[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const list = JSON.parse(raw) as { author?: unknown; title?: unknown }[];
    return list.map((b) => ({
      ...(typeof b.author === "string" && b.author.trim()
        ? { author: cleanName(b.author.trim().slice(0, 120)) }
        : {}),
      ...(typeof b.title === "string" && b.title.trim()
        ? { title: cleanName(b.title.trim().slice(0, 160)) }
        : {}),
    }));
  } catch {
    throw new IntakeRefused("The corrected names are not readable (params.books).");
  }
}

function parseConfig(raw: unknown): IntakeConfig {
  let c: IntakeConfig;
  try {
    c = JSON.parse(String(raw ?? "")) as IntakeConfig;
  } catch {
    throw new IntakeRefused("The intake setup is not readable (params.config).");
  }
  const abs = (p: unknown) =>
    typeof p === "string" && path.isAbsolute(p) && !p.includes("..") && p.length < 500;
  const intake = (c.intake ?? []).filter((w) => abs(w.folder));
  const libraries = (c.libraries ?? []).filter(
    (l) => abs(l.folder) && typeof l.id === "string" && l.id,
  );
  if (!intake.length) throw new IntakeRefused("Say which download folder to watch.");
  if (!libraries.length) throw new IntakeRefused("Say which library the books go into.");
  for (const w of intake)
    for (const l of libraries)
      if (
        path.resolve(w.folder) === path.resolve(l.folder) ||
        inside(l.folder, w.folder) ||
        inside(w.folder, l.folder)
      )
        throw new IntakeRefused(
          "A download folder and a library folder cannot be inside each other.",
        );
  const threshold = Number(c.threshold);
  return {
    enabled: true,
    intake: intake.map((w) => ({
      folder: w.folder,
      ...(w.label ? { label: String(w.label).slice(0, 120) } : {}),
      removeAfterDays: Math.max(0, Math.min(365, Math.round(Number(w.removeAfterDays) || 0))),
    })),
    libraries: libraries.map((l) => ({
      id: l.id,
      name: String(l.name ?? l.id).slice(0, 120),
      folder: l.folder,
    })),
    library: libraries.some((l) => l.id === c.library) ? c.library : libraries[0]!.id,
    threshold: Number.isFinite(threshold) ? Math.max(0.5, Math.min(1, threshold)) : 0.8,
  };
}
