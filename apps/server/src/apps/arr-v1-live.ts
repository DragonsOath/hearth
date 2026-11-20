import { downloadTrails } from "./arr-trail";
import type {
  ArrHistoryEvent,
  BookFormat,
  BookItem,
  LibraryDashboard,
  StepParams,
} from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { grabChange, grabParams, grabRelease } from "./release-search";

/**
 * The panel and controls for the v1 *arr apps, Lidarr (artists and albums) and Chaptarr
 * (authors and books): the queue with what is stuck and why, what is missing, what is coming
 * out, recent history, and the app's own health; plus searching for one missing album or book,
 * searching everything missing, removing a stuck download so the app finds another, and wanting
 * (monitoring) one album or one format of a book, or no longer wanting it. For Chaptarr, also the
 * whole collection: what is wanted per format and on disk, each author, what is coming out, and
 * the library folders.
 */

export type V1App = "lidarr" | "chaptarr";
type Method = "GET" | "POST" | "PUT" | "DELETE";

const WORDS = {
  lidarr: {
    app: "Lidarr",
    who: "artist",
    what: "album",
    whats: "albums",
    include: "includeArtist=true&includeAlbum=true",
    search: "AlbumSearch",
    ids: "albumIds",
    all: "MissingAlbumSearch",
    items: "album",
  },
  chaptarr: {
    app: "Chaptarr",
    who: "author",
    what: "book",
    whats: "books",
    include: "includeAuthor=true&includeBook=true",
    search: "BookSearch",
    ids: "bookIds",
    all: "MissingBookSearch",
    items: "book",
  },
} as const;

async function call<T>(
  fetchImpl: Fetch,
  app: V1App,
  base: string,
  key: string,
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        "X-Api-Key": key,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(`${WORDS[app].app} did not answer at ${base}: ${why}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError(`${WORDS[app].app} refused the API key.`);
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

interface Person {
  artistName?: string;
  authorName?: string;
}
interface Work {
  id?: number;
  title?: string;
  releaseDate?: string;
  artist?: Person;
  author?: Person;
}
interface QueueRecord {
  id: number;
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { messages?: string[] }[];
  errorMessage?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  downloadClient?: string;
  indexer?: string;
  downloadId?: string;
  outputPath?: string;
  artist?: Person;
  album?: Work;
  author?: Person;
  book?: Work;
}

/** History event types in plain words: "downloadImported" reads "imported". */
const eventWords = (t?: string) =>
  ({
    grabbed: "grabbed",
    downloadImported: "imported",
    trackFileImported: "imported",
    bookFileImported: "imported",
    albumImportIncomplete: "import incomplete",
    downloadFailed: "download failed",
    importFailed: "import failed",
    downloadIgnored: "ignored",
    trackFileDeleted: "file deleted",
    bookFileDeleted: "file deleted",
    trackFileRenamed: "renamed",
    bookFileRenamed: "renamed",
    trackFileRetagged: "retagged",
    bookFileRetagged: "retagged",
  })[t ?? ""] ?? (t ?? "event").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const whoOf = (w?: Person) => w?.artistName ?? w?.authorName;

/* ---------- Chaptarr's collection ---------- */

interface BookRecord {
  id?: number;
  title?: string;
  authorId?: number;
  mediaType?: string;
  monitored?: boolean;
  hasFiles?: boolean;
  releaseDate?: string;
  seriesTitle?: string;
  narrator?: string;
  narratorNames?: string[];
  durationMinutes?: number;
  pageCount?: number;
  statistics?: { bookFileCount?: number; sizeOnDisk?: number };
}
interface AuthorRecord {
  id?: number;
  authorName?: string;
  monitored?: boolean;
  nextBook?: { title?: string; releaseDate?: string };
}
interface RootRecord {
  name?: string;
  path?: string;
  freeSpace?: number;
  totalSpace?: number;
}

type Collection = Pick<
  LibraryDashboard,
  "collection" | "wanted" | "coming" | "authors" | "folders"
>;

const FORMATS: BookFormat[] = ["audiobook", "ebook"];
const formatOf = (b: BookRecord): BookFormat =>
  b.mediaType === "audiobook" ? "audiobook" : "ebook";
const hasFile = (b: BookRecord) => Boolean(b.hasFiles || (b.statistics?.bookFileCount ?? 0) > 0);
const YEAR = 365 * 86_400_000;
// Chaptarr lists translated editions as books of their own; one in another script (Japanese,
// Russian, and so on) is a translation, not the next book, so it stays out of Coming.
const TRANSLATED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}]/u;

/** The collection from Chaptarr's book, author, and root folder lists. */
export function chaptarrCollection(
  books: BookRecord[],
  authors: AuthorRecord[],
  roots: RootRecord[],
  now = new Date(),
): Collection {
  const names = new Map(authors.map((a) => [a.id, a.authorName ?? "Unknown author"]));
  const item = (b: BookRecord): BookItem => ({
    id: b.id!,
    title: b.title ?? "Untitled",
    ...(names.get(b.authorId) ? { author: names.get(b.authorId)! } : {}),
    format: formatOf(b),
    wanted: b.monitored === true,
    have: hasFile(b),
    ...(b.releaseDate ? { released: b.releaseDate } : {}),
    ...(b.seriesTitle ? { series: b.seriesTitle } : {}),
    ...(b.statistics?.sizeOnDisk ? { sizeBytes: b.statistics.sizeOnDisk } : {}),
    ...(b.narrator || b.narratorNames?.length
      ? { narrator: b.narrator || b.narratorNames!.join(", ") }
      : {}),
    ...(b.durationMinutes ? { minutes: b.durationMinutes } : {}),
    ...(b.pageCount ? { pages: b.pageCount } : {}),
  });
  const known = books.filter((b) => b.id !== undefined);
  const t = now.getTime();
  const when = (b: BookRecord) => (b.releaseDate ? Date.parse(b.releaseDate) : NaN);
  return {
    collection: {
      known: known.length,
      formats: FORMATS.filter((f) => known.some((b) => formatOf(b) === f)).map((f) => {
        const of = known.filter((b) => formatOf(b) === f);
        const wanted = of.filter((b) => b.monitored);
        return {
          format: f,
          wanted: wanted.length,
          have: wanted.filter(hasFile).length,
          sizeBytes: of.reduce((n, b) => n + (b.statistics?.sizeOnDisk ?? 0), 0),
          unwanted: of.filter((b) => !b.monitored && hasFile(b)).length,
        };
      }),
    },
    wanted: known
      .filter((b) => b.monitored)
      .sort((a, b) => (when(b) || 0) - (when(a) || 0))
      .slice(0, 500)
      .map(item),
    coming: known
      .filter((b) => when(b) > t && when(b) <= t + YEAR && !TRANSLATED.test(b.title ?? ""))
      .sort((a, b) => when(a) - when(b))
      .slice(0, 40)
      .map(item),
    authors: authors
      .filter((a) => a.id !== undefined)
      .map((a) => {
        const own = known.filter((b) => b.authorId === a.id);
        const wanted: Partial<Record<BookFormat, number>> = {};
        for (const b of own.filter((x) => x.monitored))
          wanted[formatOf(b)] = (wanted[formatOf(b)] ?? 0) + 1;
        const next =
          a.nextBook?.releaseDate && Date.parse(a.nextBook.releaseDate) > t
            ? a.nextBook
            : undefined;
        return {
          id: a.id!,
          name: a.authorName ?? "Unknown author",
          monitored: a.monitored !== false,
          wanted,
          have: own.filter((b) => b.monitored && hasFile(b)).length,
          sizeBytes: own.reduce((n, b) => n + (b.statistics?.sizeOnDisk ?? 0), 0),
          ...(next ? { next: { title: next.title ?? "Untitled", on: next.releaseDate! } } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    folders: roots.map((r) => ({
      name: r.name ?? r.path ?? "Folder",
      path: r.path ?? "",
      ...(r.freeSpace !== undefined ? { freeBytes: r.freeSpace } : {}),
      ...(r.totalSpace !== undefined ? { totalBytes: r.totalSpace } : {}),
    })),
  };
}

// The book list is large (megabytes for a few thousand books), so it is read once a minute; the
// queue and the rest stay live. A change made from Hearth forgets the saved copy.
const COLLECTION_MS = 60_000;
const collections = new Map<string, { at: number; data: Promise<Collection> }>();
export function forgetCollection(base: string) {
  collections.delete(base);
}
function collectionOf(base: string, now: Date, read: () => Promise<Collection>) {
  const saved = collections.get(base);
  if (saved && now.getTime() - saved.at < COLLECTION_MS) return saved.data;
  const data = read();
  collections.set(base, { at: now.getTime(), data });
  data.catch(() => collections.delete(base));
  return data;
}
const label = (who?: string, title?: string) =>
  [who, title].filter(Boolean).join(" - ") || "Unknown";

export async function libraryDashboard(
  app: V1App,
  fetchImpl: Fetch,
  base: string,
  key: string,
  now = new Date(),
): Promise<LibraryDashboard> {
  const w = WORDS[app];
  const get = async <T>(path: string): Promise<T> => {
    const r = await call<T>(fetchImpl, app, base, key, "GET", path);
    if (!r.ok)
      throw new AppUnreachableError(`${w.app} answered ${r.status} for ${path.split("?")[0]}.`);
    return r.data;
  };
  const soon = new Date(now.getTime() + 14 * 86_400_000);
  const [status, health, queue, missing, upcoming, history, people] = await Promise.all([
    get<{ version?: string }>("/api/v1/system/status"),
    get<{ type?: string; message?: string }[]>("/api/v1/health").catch(() => []),
    get<{ totalRecords?: number; records?: QueueRecord[] }>(
      `/api/v1/queue?page=1&pageSize=50&${w.include}`,
    ),
    get<{ totalRecords?: number; records?: Work[] }>(
      `/api/v1/wanted/missing?page=1&pageSize=25&monitored=true&sortKey=releaseDate&sortDirection=descending&${app === "lidarr" ? "includeArtist=true" : "includeAuthor=true"}`,
    ).catch(() => ({ totalRecords: 0, records: [] as Work[] })),
    get<Work[]>(
      `/api/v1/calendar?start=${encodeURIComponent(now.toISOString())}&end=${encodeURIComponent(soon.toISOString())}&${app === "lidarr" ? "includeArtist=true" : "includeAuthor=true"}`,
    ).catch(() => [] as Work[]),
    get<{
      records?: {
        date?: string;
        eventType?: string;
        sourceTitle?: string;
        downloadId?: string;
        data?: Record<string, string | undefined>;
        quality?: { quality?: { name?: string } };
        artist?: Person;
        album?: Work;
        author?: Person;
        book?: Work;
      }[];
    }>(
      `/api/v1/history?page=1&pageSize=100&sortKey=date&sortDirection=descending&${app === "lidarr" ? "includeArtist=true&includeAlbum=true" : "includeAuthor=true&includeBook=true"}`,
    ).catch(() => ({
      records: [],
    })),
    get<{ monitored?: boolean }[]>(app === "lidarr" ? "/api/v1/artist" : "/api/v1/author").catch(
      () => [] as { monitored?: boolean }[],
    ),
  ]);
  const collection =
    app === "chaptarr"
      ? await collectionOf(base, now, async () => {
          const [books, authors, roots] = await Promise.all([
            get<BookRecord[]>("/api/v1/book"),
            get<AuthorRecord[]>("/api/v1/author"),
            get<RootRecord[]>("/api/v1/rootfolder").catch(() => [] as RootRecord[]),
          ]);
          return chaptarrCollection(books, authors, roots, now);
        }).catch(() => ({}) as Collection)
      : ({} as Collection);
  const records = queue.records ?? [];
  const items = records.map((r) => {
    const work = app === "lidarr" ? r.album : r.book;
    const person = app === "lidarr" ? r.artist : r.author;
    const problem =
      r.errorMessage ||
      [...new Set((r.statusMessages ?? []).flatMap((m) => m.messages ?? []))].join("; ") ||
      undefined;
    const stuck = Boolean(r.trackedDownloadStatus && r.trackedDownloadStatus !== "ok");
    return {
      id: r.id,
      title: work?.title ? label(whoOf(person), work.title) : (r.title ?? "Unknown"),
      ...(work?.title && r.title ? { release: r.title } : {}),
      status: r.trackedDownloadState ?? r.status ?? "queued",
      stuck,
      ...(r.size ? { progressPct: Math.round(((r.size - (r.sizeleft ?? 0)) / r.size) * 100) } : {}),
      ...(r.size ? { sizeBytes: r.size } : {}),
      ...(r.timeleft ? { timeLeft: r.timeleft } : {}),
      ...(stuck && problem ? { problem: problem.slice(0, 300) } : {}),
      ...(r.downloadClient ? { via: r.downloadClient } : {}),
      ...(r.indexer ? { indexer: r.indexer } : {}),
      ...(r.downloadId ? { downloadId: r.downloadId } : {}),
      ...(r.outputPath ? { outputPath: r.outputPath } : {}),
    };
  });
  // The download trails: the same events Sonarr and Radarr give, in Lidarr's and Chaptarr's names.
  const TRAIL: Record<string, ArrHistoryEvent["event"]> = {
    grabbed: "grabbed",
    trackFileImported: "imported",
    bookFileImported: "imported",
    downloadFailed: "failed",
    albumImportIncomplete: "failed",
    bookImportIncomplete: "failed",
    downloadIgnored: "ignored",
    trackFileRenamed: "renamed",
    bookFileRenamed: "renamed",
  };
  const events: ArrHistoryEvent[] = (history.records ?? [])
    .filter((h) => TRAIL[h.eventType ?? ""])
    .map((h) => {
      const d = h.data ?? {};
      const work = app === "lidarr" ? h.album : h.book;
      const person = app === "lidarr" ? h.artist : h.author;
      const renamed = TRAIL[h.eventType!] === "renamed";
      return {
        ...(h.date ? { at: h.date } : {}),
        event: TRAIL[h.eventType!]!,
        title: work?.title ? label(whoOf(person), work.title) : (h.sourceTitle ?? "A download"),
        ...(h.sourceTitle ? { release: h.sourceTitle } : {}),
        ...(h.downloadId ? { downloadId: h.downloadId } : {}),
        ...((d.downloadClientName ?? d.downloadClient)
          ? { client: d.downloadClientName ?? d.downloadClient }
          : {}),
        ...(d.indexer ? { indexer: d.indexer } : {}),
        ...(d.droppedPath ? { droppedPath: d.droppedPath } : {}),
        ...(d.importedPath ? { importedPath: d.importedPath } : {}),
        ...(d.message ? { message: d.message } : {}),
        ...(renamed && d.sourcePath ? { renamedFrom: d.sourcePath } : {}),
        ...(renamed && d.path ? { renamedTo: d.path } : {}),
      };
    });
  const trails = downloadTrails(
    app === "lidarr" ? "Lidarr" : "Chaptarr",
    events,
    items.map((i) => ({ ...i, state: i.status, client: i.via })),
  );
  return {
    app,
    ...(status.version ? { version: status.version } : {}),
    words: { who: w.who, what: w.what, whats: w.whats },
    totals: {
      people: people.length,
      monitored: people.filter((p) => p.monitored !== false).length,
      missing: missing.totalRecords ?? (missing.records ?? []).length,
      queue: queue.totalRecords ?? records.length,
      stuck: items.filter((i) => i.stuck).length,
    },
    queue: items.sort((a, b) => Number(b.stuck) - Number(a.stuck)),
    trails,
    missing: (missing.records ?? [])
      .filter((m) => m.id !== undefined)
      .map((m) => ({
        id: m.id!,
        title: label(whoOf(m.artist ?? m.author), m.title),
        ...(m.releaseDate ? { released: m.releaseDate } : {}),
      })),
    upcoming: upcoming
      .filter((m) => m.id !== undefined)
      .slice(0, 15)
      .map((m) => ({
        id: m.id!,
        title: label(whoOf(m.artist ?? m.author), m.title),
        ...(m.releaseDate ? { on: m.releaseDate } : {}),
      })),
    recent: (history.records ?? []).slice(0, 25).map((h) => {
      const event = eventWords(h.eventType);
      return {
        text: `${event}: ${h.sourceTitle ?? ""}`.trim(),
        ...(h.date ? { at: h.date } : {}),
        failed: /fail/i.test(h.eventType ?? ""),
        event,
        ...(h.sourceTitle ? { title: h.sourceTitle } : {}),
        ...(h.quality?.quality?.name ? { quality: h.quality.quality.name } : {}),
      };
    }),
    health: (health ?? [])
      .filter((h) => h.type === "warning" || h.type === "error")
      .map((h) => ({
        level: h.type === "error" ? ("error" as const) : ("warning" as const),
        text: h.message ?? "A health warning",
      })),
    ...collection,
  };
}

export const LIBRARY_OPS = [
  "search",
  "search-missing",
  "replace-download",
  "monitor",
  "grab",
  "request",
] as const;
type Op = (typeof LIBRARY_OPS)[number];

export class LibraryOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    app: V1App,
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const w = WORDS[app];
    const op = String(params?.op ?? "") as Op;
    if (!LIBRARY_OPS.includes(op)) throw new Error(`Say what to do: ${LIBRARY_OPS.join(", ")}.`);
    // Download one release picked from an interactive search (10-26).
    if (op === "grab") {
      const g = grabParams(params as Record<string, unknown> | undefined);
      if (typeof g === "string") throw new Error(g);
      const change = grabChange(service.name, g);
      return {
        ...base,
        label: change.summary,
        serviceName: service.name,
        params: { op, name: `${g.release} (for ${g.title})`, ...g },
        change,
      };
    }
    // Request a book (11-17, the Curator): add it if Chaptarr doesn't have it, want that one book,
    // and search. Chaptarr applies a new author's "monitor none" to every book after the add, so
    // wanting it is a separate call afterwards; the run reads both back.
    if (op === "request") {
      if (app !== "chaptarr") throw new Error("Requesting a book is for Chaptarr.");
      const book = typeof params?.book === "string" ? params.book : "";
      const itemId = params?.itemId !== undefined ? Number(params.itemId) : undefined;
      let title = String(params?.name ?? "");
      if (book) {
        try {
          title ||= String((JSON.parse(book) as { title?: string }).title ?? "");
        } catch {
          throw new Error("The book to add isn't readable.");
        }
      } else if (itemId === undefined || !Number.isInteger(itemId))
        throw new Error("Say which book: its Chaptarr id, or the book to add.");
      const named = title || "the book";
      const summary = `Request ${named} in ${service.name}: ${book ? "add it, " : ""}want it, and search for it`;
      return {
        ...base,
        label: summary,
        serviceName: service.name,
        params: { op, name: named, ...(book ? { book } : { itemId: itemId! }) },
        change: {
          summary,
          settings: [
            ...(book ? [{ name: "In Chaptarr", before: "Not yet", after: "Added" }] : []),
            {
              name: named,
              before: book ? "Not added" : "Not wanted",
              after: "Wanted, and searched for now",
            },
          ],
        },
      };
    }
    const d = await this.use(service, `read ${w.app}`, "read", (k) =>
      libraryDashboard(app, this.fetchImpl, service.localUrl, k),
    );
    let labelText: string;
    let target: { id?: number; name: string; before: string };
    if (op === "search") {
      const m = d.missing.find((x) => x.id === Number(params?.itemId));
      if (!m) throw new Error(`That ${w.what} is not missing any more.`);
      labelText = `Search for ${m.title} in ${service.name}`;
      target = { id: m.id, name: m.title, before: "missing" };
    } else if (op === "search-missing") {
      if (!d.totals.missing) throw new Error(`No monitored ${w.whats} are missing.`);
      labelText = `Search for all ${d.totals.missing} missing ${w.whats} in ${service.name}`;
      target = { name: `${d.totals.missing} ${w.whats}`, before: "missing" };
    } else if (op === "monitor") {
      if (typeof params?.monitored !== "boolean")
        throw new Error("Say whether to want it (monitored true or false).");
      const id = Number(params.itemId);
      const r = await this.use(service, `read ${w.app}`, "read", (k) =>
        call<BookRecord & { artist?: Person; author?: Person }>(
          this.fetchImpl,
          app,
          service.localUrl,
          k,
          "GET",
          `/api/v1/${w.items}/${id}`,
        ),
      );
      if (!r.ok || r.data?.id !== id) throw new Error(`${w.app} has no ${w.what} with id ${id}.`);
      const want = params.monitored;
      if ((r.data.monitored === true) === want)
        throw new Error(`${r.data.title ?? "That"} is already ${want ? "wanted" : "not wanted"}.`);
      const author =
        whoOf(r.data.artist ?? r.data.author) ??
        d.authors?.find((a) => a.id === r.data.authorId)?.name;
      const what =
        app === "chaptarr"
          ? `the ${formatOf(r.data)} of ${r.data.title ?? "Untitled"}`
          : (r.data.title ?? "Untitled");
      const named = author ? `${what} by ${author}` : what;
      labelText = want
        ? `Want ${named} in ${service.name}: it is downloaded when a release is found`
        : `Stop wanting ${named} in ${service.name}: no more searches or upgrades; files on disk stay`;
      const before = r.data.monitored ? "wanted" : "not wanted";
      return {
        ...base,
        label: labelText,
        serviceName: service.name,
        params: { op, name: named, itemId: id, monitored: want },
        change: {
          summary: labelText,
          settings: [{ name: named, before, after: want ? "wanted" : "not wanted" }],
        },
      };
    } else {
      const q = d.queue.find((x) => x.id === Number(params?.queueId));
      if (!q) throw new Error("That download is not in the queue any more.");
      labelText = `Remove ${q.title} from ${service.name}'s queue and its download client, block that release, and search for another`;
      target = { id: q.id, name: q.title, before: q.problem ?? q.status };
    }
    return {
      ...base,
      label: labelText,
      serviceName: service.name,
      params: {
        op,
        name: target.name,
        ...(op === "search"
          ? { itemId: target.id! }
          : op === "replace-download"
            ? { queueId: target.id! }
            : {}),
      },
      change: {
        summary: labelText,
        settings: [{ name: target.name, before: target.before, after: op }],
      },
    };
  }

  async run(
    app: V1App,
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const w = WORDS[app];
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const name = String(p.name || "it");
    const outcome = await this.use(
      service,
      `${op} in ${w.app}`,
      "change",
      async (key): Promise<StepOutcome> => {
        const base = service.localUrl;
        const c = <T>(method: Method, path: string, body?: unknown) =>
          call<T>(this.fetchImpl, app, base, key, method, path, body);
        if (op === "grab") {
          const g = grabParams(p as Record<string, unknown>);
          if (typeof g === "string") return { ok: false, result: g };
          const out = await grabRelease(app, (m, path, body) => c(m, path, body), g, this.wait);
          return { ok: out.ok, result: out.result, ...(out.stale ? { stale: true } : {}) };
        }
        if (op === "request") {
          let id = p.itemId !== undefined ? Number(p.itemId) : undefined;
          if (typeof p.book === "string" && p.book) {
            const body = JSON.parse(p.book) as { foreignBookId?: string };
            // Already added (a retry, or added meanwhile): use that one.
            const lib = await c<{ id: number; foreignBookId?: string }[]>("GET", "/api/v1/book");
            id =
              (lib.data ?? []).find(
                (b) => body.foreignBookId && b.foreignBookId === body.foreignBookId,
              )?.id ?? undefined;
            if (id === undefined) {
              const added = await c<{ id?: number }>("POST", "/api/v1/book", body);
              if (!added.ok || !added.data?.id)
                return { ok: false, result: `${w.app} did not add ${name} (${added.status}).` };
              id = added.data.id;
            }
          }
          if (id === undefined) return { ok: false, result: `${w.app} has no ${name}.` };
          // Chaptarr may still be applying the new author's settings: want it after a moment, and
          // once more if that pass turned it off again.
          let wanted = false;
          for (let i = 0; i < 4 && !wanted; i++) {
            if (i) await this.wait(1500);
            await c("PUT", "/api/v1/book/monitor", { bookIds: [id], monitored: true });
            const now = await c<{ monitored?: boolean }>("GET", `/api/v1/book/${id}`);
            wanted = now.data?.monitored === true;
          }
          forgetCollection(base);
          if (!wanted)
            return {
              ok: false,
              result: `${w.app} added ${name} but keeps it not wanted, so nothing was searched. Mark it wanted in ${w.app}.`,
            };
          const s = await c<{ id?: number }>("POST", "/api/v1/command", {
            name: w.search,
            bookIds: [id],
          });
          if (!s.ok || !s.data?.id)
            return {
              ok: false,
              result: `${name} is wanted in ${w.app}, but the search didn't start (${s.status}); it is searched on ${w.app}'s next check.`,
            };
          return {
            ok: true,
            verified: true,
            result: `${name} is wanted in ${w.app} (read back) and the search has started; it downloads when a release fits.`,
          };
        }
        if (op === "monitor") {
          const id = Number(p.itemId);
          const want = p.monitored === true;
          const r = await c("PUT", `/api/v1/${w.items}/monitor`, {
            [w.ids]: [id],
            monitored: want,
          });
          forgetCollection(base);
          if (!r.ok) return { ok: false, result: `${w.app} did not change it (${r.status}).` };
          const now = await c<{ monitored?: boolean }>("GET", `/api/v1/${w.items}/${id}`);
          return (now.data?.monitored === true) === want
            ? {
                ok: true,
                result: want
                  ? `${name} is wanted now; ${w.app} downloads it when it finds a release.`
                  : `${name} is no longer wanted; its files stay where they are.`,
              }
            : {
                ok: false,
                result: `${w.app} answered, but ${name} is still ${want ? "not wanted" : "wanted"}.`,
              };
        }
        if (op === "replace-download") {
          const id = Number(p.queueId);
          const r = await c(
            "DELETE",
            `/api/v1/queue/${id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
          );
          if (!r.ok) return { ok: false, result: `${w.app} did not remove it (${r.status}).` };
          const d = await libraryDashboard(app, this.fetchImpl, base, key);
          return d.queue.some((q) => q.id === id)
            ? { ok: false, result: `${w.app} answered, but ${name} is still in the queue.` }
            : {
                ok: true,
                result: `${name} is out of the queue and blocked; ${w.app} is searching for another release.`,
              };
        }
        const body =
          op === "search" ? { name: w.search, [w.ids]: [Number(p.itemId)] } : { name: w.all };
        const r = await c<{ id?: number }>("POST", "/api/v1/command", body);
        if (!r.ok || !r.data?.id)
          return { ok: false, result: `${w.app} did not start the search (${r.status}).` };
        for (let i = 0; i < 10; i++) {
          const s = await c<{ status?: string; message?: string }>(
            "GET",
            `/api/v1/command/${r.data.id}`,
          );
          if (s.data?.status === "completed")
            return {
              ok: true,
              result: `${w.app} searched for ${name}. Anything it found is in its queue.`,
            };
          if (s.data?.status === "failed")
            return {
              ok: false,
              result: `${w.app}'s search failed: ${s.data.message ?? "no reason given"}.`,
            };
          await this.wait(2000);
        }
        return { ok: true, result: `${w.app} is searching for ${name}; it is still going.` };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
