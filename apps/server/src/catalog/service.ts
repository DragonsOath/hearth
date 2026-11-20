import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CATALOG_DEFAULT_TITLE,
  MAX_CATALOG_FILES,
  MAX_CATALOG_SHELVES,
  type CatalogFile,
  type CatalogSettings,
  type CatalogState,
  type CatalogStatus,
  SHELF_KINDS,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting, setSetting } from "../store/settings";
import type { FileManager } from "../storage/files";
import { toSegments } from "../storage/source";
import { renderCatalogPdf, type CatalogShelf } from "./pdf";
import { SCAN_LIMITS, Scanner, type ScanLimits } from "./scan";

/**
 * Collection PDF: the owner's shelves (folders to list), one scan at a time in the background,
 * and the PDFs it made, kept in the data folder's "catalogs" folder (the newest
 * MAX_CATALOG_FILES). Reading the folders changes nothing on them; the only files Hearth writes
 * are its own PDFs.
 */

const ID = /^cat-[a-z0-9]+$/;

export class CatalogService {
  private status: CatalogStatus = { running: false };
  private current?: Promise<void>;

  constructor(
    private readonly handle: DbHandle,
    private readonly files: FileManager,
    private readonly dataDir: string,
    private readonly showYears: () => Promise<Map<string, number>> = async () => new Map(),
    private readonly limits: ScanLimits = SCAN_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get dir() {
    return path.join(this.dataDir, "catalogs");
  }

  async settings(): Promise<CatalogSettings> {
    return (
      (await getSetting(this.handle.db, "collection_catalog")) ?? {
        title: CATALOG_DEFAULT_TITLE,
        shelves: [],
      }
    );
  }

  async state(): Promise<CatalogState> {
    return {
      settings: await this.settings(),
      status: this.status,
      files: (await getSetting(this.handle.db, "collection_catalog_files")) ?? [],
    };
  }

  async saveSettings(input: unknown): Promise<CatalogSettings> {
    const v = (input ?? {}) as Partial<CatalogSettings>;
    const title = String(v.title ?? "").trim() || CATALOG_DEFAULT_TITLE;
    if (title.length > 80) throw new InvalidRequestError("Keep the title under 80 characters.");
    if (!Array.isArray(v.shelves)) throw new InvalidRequestError("Say which folders to list.");
    if (v.shelves.length > MAX_CATALOG_SHELVES)
      throw new InvalidRequestError(`At most ${MAX_CATALOG_SHELVES} folders.`);
    const roots = new Set((await this.files.roots()).map((r) => r.id));
    const shelves = v.shelves.map((s, i) => {
      const name = String(s?.name ?? "").trim();
      if (!name || name.length > 60)
        throw new InvalidRequestError("Give each folder a short name (up to 60 characters).");
      if (!SHELF_KINDS.includes(s.kind))
        throw new InvalidRequestError(
          `Say whether ${name} holds movies, shows, audiobooks, or ebooks.`,
        );
      if (!roots.has(String(s.rootId)))
        throw new InvalidRequestError(`${name}: that drive or folder is not available in Hearth.`);
      const segments = toSegments(String(s.path ?? ""));
      return {
        id: /^[a-z0-9-]{1,40}$/i.test(String(s.id)) ? String(s.id) : `shelf-${i + 1}`,
        name,
        rootId: String(s.rootId),
        path: segments.join("/"),
        kind: s.kind,
      };
    });
    const saved = { title, shelves };
    await setSetting(this.handle.db, "collection_catalog", saved);
    return saved;
  }

  /** Starts a scan in the background; the state says how it is going. */
  async start(): Promise<CatalogStatus> {
    if (this.status.running) throw new ConflictError("A Collection PDF is already being made.");
    const settings = await this.settings();
    if (!settings.shelves.length)
      throw new InvalidRequestError("Add at least one folder to list first.");
    this.status = { running: true, startedAt: this.now().toISOString(), folders: 0 };
    this.current = this.run(settings)
      .catch((e: unknown) => {
        this.status = { running: false, error: e instanceof Error ? e.message : String(e) };
      })
      .finally(() => {
        this.current = undefined;
      });
    return this.status;
  }

  /** Tests: waits for the scan in progress. */
  async idle() {
    await this.current;
  }

  private async run(settings: CatalogSettings) {
    const years = await this.showYears().catch(() => new Map<string, number>());
    const shelves: CatalogShelf[] = [];
    const partial: string[] = [];
    const failed: { name: string; reason: string }[] = [];
    let folders = 0;
    for (const s of settings.shelves) {
      this.status = { ...this.status, shelf: s.name };
      try {
        const { segments, source } = await this.files.scanSource(s.rootId, s.path);
        const scan = new Scanner(source, this.limits, (n) => {
          this.status = { ...this.status, folders: folders + n };
        });
        const items =
          s.kind === "shows"
            ? await scan.shows(segments, years)
            : s.kind === "audiobooks"
              ? await scan.audiobooks(segments)
              : s.kind === "ebooks"
                ? await scan.ebooks(segments)
                : await scan.movies(segments);
        folders += scan.listed;
        this.status = { ...this.status, folders };
        if (scan.stoppedEarly) partial.push(s.name);
        shelves.push({ name: s.name, kind: s.kind, items });
      } catch (e) {
        failed.push({ name: s.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!shelves.some((s) => s.items.length))
      throw new Error(
        failed.length
          ? `Nothing could be read: ${failed.map((f) => `${f.name} (${f.reason})`).join("; ")}`
          : "No movies, shows, or books were found in those folders.",
      );

    const at = this.now();
    const made = at.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const pdf = await renderCatalogPdf({ title: settings.title, made, shelves, partial });
    const id = `cat-${at.getTime().toString(36)}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, `${id}.pdf`), pdf);

    const all = shelves.flatMap((s) => s.items);
    const file: CatalogFile = {
      id,
      at: at.toISOString(),
      title: settings.title,
      titles: all.length,
      libraryBytes: all.reduce((n, i) => n + i.s, 0),
      fileBytes: pdf.length,
      shelves: shelves.map((s) => ({ name: s.name, count: s.items.length })),
      ...(partial.length ? { partial } : {}),
      ...(failed.length ? { failed } : {}),
    };
    const before = (await getSetting(this.handle.db, "collection_catalog_files")) ?? [];
    const kept = [file, ...before].slice(0, MAX_CATALOG_FILES);
    for (const old of before.filter((b) => !kept.includes(b)))
      await fs.rm(path.join(this.dir, `${old.id}.pdf`), { force: true }).catch(() => undefined);
    await setSetting(this.handle.db, "collection_catalog_files", kept);
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Made a Collection PDF: ${all.length} titles from ${shelves.map((s) => s.name).join(", ")}`,
      target: `catalog:${id}`,
    });
    this.status = { running: false };
  }

  /** One PDF on disk, and the name to download it as. */
  async file(id: string): Promise<{ path: string; name: string }> {
    if (!ID.test(id)) throw new NotFoundError("No such Collection PDF.");
    const files = (await getSetting(this.handle.db, "collection_catalog_files")) ?? [];
    const f = files.find((x) => x.id === id);
    if (!f) throw new NotFoundError("No such Collection PDF.");
    const p = path.join(this.dir, `${id}.pdf`);
    await fs.access(p).catch(() => {
      throw new NotFoundError("That Collection PDF's file is missing; make a new one.");
    });
    const safe = f.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Collection";
    return { path: p, name: `${safe} ${f.at.slice(0, 10)}.pdf` };
  }

  async remove(id: string): Promise<void> {
    const { path: p } = await this.file(id);
    await fs.rm(p, { force: true });
    const files = (await getSetting(this.handle.db, "collection_catalog_files")) ?? [];
    await setSetting(
      this.handle.db,
      "collection_catalog_files",
      files.filter((f) => f.id !== id),
    );
  }
}
