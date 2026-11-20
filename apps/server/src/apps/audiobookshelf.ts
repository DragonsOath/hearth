import { AudiobookIntake, IntakeRefused } from "./audiobook-intake";
import type {
  AppReport,
  AudiobookshelfBook,
  AudiobookshelfDashboard,
  AudiobookshelfNow,
  AudiobookshelfShelf,
  AudiobookshelfList,
  StepParams,
} from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Audiobookshelf, with an API key an administrator creates in Audiobookshelf (Settings > API
 * Keys) and pastes once: it keeps keys in its database. The health read, the panel (who is
 * listening, libraries with their size and length, what was added, backups), and the controls:
 * scan a library and make a backup now. Each control is a plan confirmed in the panel.
 */

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function call<T>(
  fetchImpl: Fetch,
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
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.replaceAll(key, "[hidden]") : "no answer";
    throw new AppUnreachableError(`Audiobookshelf did not answer at ${base}: ${why}`);
  }
  if (res.status === 401)
    throw new AppKeyError(
      "Audiobookshelf refused the API key. Create one in Audiobookshelf and paste it in its panel.",
    );
  if (res.status === 403)
    throw new AppKeyError(
      "Audiobookshelf's key belongs to a user who is not an administrator. Create one as an administrator.",
    );
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

export async function get<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  path: string,
): Promise<T> {
  const r = await call<T>(fetchImpl, base, key, "GET", path);
  if (!r.ok)
    throw new AppUnreachableError(`Audiobookshelf answered ${r.status} for ${path.split("?")[0]}.`);
  return r.data;
}

interface Library {
  id: string;
  name?: string;
  mediaType?: string;
  folders?: unknown[];
}
interface OpenSession {
  id?: string;
  user?: { username?: string };
  userId?: string;
  displayTitle?: string;
  displayAuthor?: string;
  deviceInfo?: { clientName?: string; deviceName?: string; osName?: string };
  currentTime?: number;
  duration?: number;
  mediaType?: string;
  libraryItemId?: string;
}

interface RawItem {
  id?: string;
  addedAt?: number;
  media?: {
    coverPath?: string | null;
    duration?: number;
    metadata?: {
      title?: string;
      authorName?: string;
      narratorName?: string;
      seriesName?: string;
      publishedYear?: string;
      genres?: string[];
      description?: string;
    };
  };
}

/** Plain text, at most a few sentences: descriptions come as HTML from publishers. */
function plain(html: string | undefined, max = 320): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, "")}…` : text;
}

/** One book in plain fields, from an item Audiobookshelf listed. */
export function bookOf(r: RawItem): AudiobookshelfBook {
  const m = r.media?.metadata ?? {};
  const hrs = r.media?.duration ? Math.round((r.media.duration / 3600) * 10) / 10 : undefined;
  return {
    title: [m.title, m.authorName].filter(Boolean).join(" · ") || "Something",
    ...(r.addedAt ? { at: new Date(r.addedAt).toISOString() } : {}),
    ...(r.id ? { id: r.id } : {}),
    ...(m.title ? { name: m.title } : {}),
    ...(m.authorName ? { author: m.authorName } : {}),
    ...(m.narratorName ? { narrator: m.narratorName } : {}),
    ...(m.seriesName ? { series: m.seriesName } : {}),
    ...(m.publishedYear ? { year: m.publishedYear } : {}),
    ...(hrs ? { hours: hrs } : {}),
    ...(m.genres?.length ? { genres: m.genres.slice(0, 4) } : {}),
    ...(plain(m.description) ? { description: plain(m.description) } : {}),
    ...(r.media?.coverPath ? { cover: true } : {}),
  };
}

/** A collection or playlist you keep as a to-be-read list, by its name. */
const TBR =
  /\b(tbr|to[ -]?be[ -]?read|to[ -]?read|want[ -]?to[ -]?(read|listen)|to[ -]?listen|up[ -]?next|reading list|listen list)\b/i;

interface RawCollection {
  id?: string;
  libraryId?: string;
  name?: string;
  books?: RawItem[];
}
interface RawPlaylist {
  id?: string;
  libraryId?: string;
  name?: string;
  items?: { libraryItemId?: string; episodeId?: string | null; libraryItem?: RawItem }[];
}

type ListRead = Omit<AudiobookshelfList, "books"> & { raw: RawItem[] };

/** Your playlists (books only) and the collections, to-be-read lists first. */
export function listsOf(collections: RawCollection[], playlists: RawPlaylist[]): ListRead[] {
  const out: ListRead[] = [
    ...playlists
      .filter((p) => p.id && p.name)
      .map((p) => ({
        id: p.id!,
        kind: "playlist" as const,
        name: p.name!,
        libraryId: p.libraryId ?? "",
        tbr: TBR.test(p.name!),
        raw: (p.items ?? [])
          .filter((i) => !i.episodeId)
          .map((i) => i.libraryItem ?? ({ id: i.libraryItemId } as RawItem))
          .filter((x) => Boolean(x.id)),
      })),
    ...collections
      .filter((c) => c.id && c.name)
      .map((c) => ({
        id: c.id!,
        kind: "collection" as const,
        name: c.name!,
        libraryId: c.libraryId ?? "",
        tbr: TBR.test(c.name!),
        raw: c.books ?? [],
      })),
  ];
  return out.sort((a, b) => Number(b.tbr) - Number(a.tbr));
}

interface MediaProgress {
  libraryItemId?: string;
  progress?: number;
  isFinished?: boolean;
  lastUpdate?: number;
  currentTime?: number;
  duration?: number;
}

/** Where a listener is in a book: overall, and in which chapter and how far into it. */
export function positionIn(
  item: RawItem & { media?: { chapters?: { start?: number; end?: number; title?: string }[] } },
  positionSec: number,
  durationSec: number,
): Omit<AudiobookshelfNow, "book" | "live" | "lastListened"> {
  const chapters = item.media?.chapters ?? [];
  const i = chapters.findIndex(
    (c) => positionSec >= (c.start ?? 0) && positionSec < (c.end ?? Infinity),
  );
  const c = i >= 0 ? chapters[i]! : undefined;
  const span = c ? (c.end ?? durationSec) - (c.start ?? 0) : 0;
  return {
    positionSec: Math.round(positionSec),
    durationSec: Math.round(durationSec),
    progressPct: durationSec ? Math.min(100, Math.round((positionSec / durationSec) * 100)) : 0,
    ...(c
      ? {
          chapter: {
            title: c.title || `Chapter ${i + 1}`,
            number: i + 1,
            count: chapters.length,
            startSec: Math.round(c.start ?? 0),
            endSec: Math.round(c.end ?? durationSec),
            pct:
              span > 0
                ? Math.min(100, Math.round(((positionSec - (c.start ?? 0)) / span) * 100))
                : 0,
          },
        }
      : {}),
  };
}

/**
 * The shelves Audiobookshelf shows the account Hearth's key belongs to: what is in progress
 * (with how far along), a to-be-read collection or playlist when you keep one, the next book in
 * series you are listening to, and its own suggestions. Read only.
 */
async function shelvesOf(
  g: <T>(path: string) => Promise<T>,
  libraries: Library[],
  sessions: OpenSession[] = [],
): Promise<{
  shelves: AudiobookshelfShelf[];
  user?: string;
  now?: AudiobookshelfNow;
  lists: AudiobookshelfList[];
}> {
  const [me, inProgress, collections, playlists] = await Promise.all([
    g<{ username?: string; mediaProgress?: MediaProgress[] }>("/api/me").catch(
      () => ({}) as { username?: string; mediaProgress?: MediaProgress[] },
    ),
    g<{ libraryItems?: RawItem[] }>("/api/me/items-in-progress?limit=12").catch(() => ({
      libraryItems: [] as RawItem[],
    })),
    g<{ collections?: RawCollection[] }>("/api/collections").catch(() => ({
      collections: [] as RawCollection[],
    })),
    g<{ playlists?: RawPlaylist[] }>("/api/playlists").catch(() => ({
      playlists: [] as RawPlaylist[],
    })),
  ]);
  const progress = new Map(
    (me.mediaProgress ?? [])
      .filter((m) => m.libraryItemId)
      .map((m) => [m.libraryItemId!, m] as const),
  );
  const withProgress = (r: RawItem) => {
    const m = r.id ? progress.get(r.id) : undefined;
    return {
      ...bookOf(r),
      ...(m?.progress !== undefined ? { progressPct: Math.round(m.progress * 100) } : {}),
      ...(m?.lastUpdate ? { lastListened: new Date(m.lastUpdate).toISOString() } : {}),
    };
  };
  const shelves: AudiobookshelfShelf[] = [];
  const cont = (inProgress.libraryItems ?? []).map(withProgress);
  if (cont.length) shelves.push({ kind: "continue", label: "Continue listening", books: cont });
  const lists = listsOf(collections.collections ?? [], playlists.playlists ?? []);
  const tbr = lists.filter((l) => l.tbr);
  for (const t of tbr)
    if (t.raw.length)
      shelves.push({
        kind: "tbr",
        label: t.name,
        books: t.raw.slice(0, 24).map(withProgress),
        list: { id: t.id, kind: t.kind },
      });
  // No to-be-read list of your own: the books you have not started, newest first, so the row is
  // still there (and says what it is).
  if (!tbr.length) {
    const notStarted = Buffer.from("not-started").toString("base64");
    const lists = await Promise.all(
      libraries
        .filter((x) => x.mediaType !== "podcast")
        .map((l) =>
          g<{ results?: RawItem[] }>(
            `/api/libraries/${encodeURIComponent(l.id)}/items?filter=progress.${encodeURIComponent(notStarted)}&sort=addedAt&desc=1&limit=16`,
          ).catch(() => ({ results: [] as RawItem[] })),
        ),
    );
    const books = lists.flatMap((x) => x.results ?? []).slice(0, 24);
    if (books.length)
      shelves.push({
        kind: "tbr",
        label: "To be read (not started yet)",
        books: books.map(bookOf),
      });
  }
  // Audiobookshelf's own home shelves, per book library: next in series, and suggestions.
  const seen = new Set<string>();
  for (const l of libraries.filter((x) => x.mediaType !== "podcast")) {
    const home = await g<{ id?: string; label?: string; type?: string; entities?: RawItem[] }[]>(
      `/api/libraries/${encodeURIComponent(l.id)}/personalized?limit=12`,
    ).catch(() => []);
    for (const sh of Array.isArray(home) ? home : []) {
      const kind =
        sh.id === "continue-series" ? "series" : sh.id === "discover" ? "discover" : undefined;
      if (!kind || sh.type !== "book" || !sh.entities?.length) continue;
      const key = `${kind}:${l.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      shelves.push({
        kind,
        label: `${kind === "series" ? "Next in your series" : "Discover"}${libraries.length > 1 ? ` · ${l.name ?? "library"}` : ""}`,
        books: sh.entities.map(withProgress),
      });
    }
  }
  // What you listened to last: a session open right now wins; otherwise the newest saved place.
  let now: AudiobookshelfNow | undefined;
  const live = sessions.find((s) => s.libraryItemId && s.user?.username === me.username);
  const last = [...progress.values()]
    .filter((m) => !m.isFinished && (m.progress ?? 0) > 0)
    .sort((a, b) => (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0))[0];
  const itemId = live?.libraryItemId ?? last?.libraryItemId;
  if (itemId) {
    const item = await g<
      RawItem & { media?: { chapters?: { start?: number; end?: number; title?: string }[] } }
    >(`/api/items/${encodeURIComponent(itemId)}?expanded=1`).catch(() => undefined);
    if (item) {
      const m = progress.get(itemId);
      const pos = live?.currentTime ?? m?.currentTime ?? 0;
      const dur = live?.duration ?? m?.duration ?? item.media?.duration ?? 0;
      now = {
        book: bookOf(item),
        live: Boolean(live),
        ...positionIn(item, pos, dur),
        ...(m?.lastUpdate ? { lastListened: new Date(m.lastUpdate).toISOString() } : {}),
      };
    }
  }
  return {
    shelves,
    lists: lists.map(({ raw, ...l }) => ({ ...l, books: raw.map(bookOf) })),
    ...(me.username ? { user: me.username } : {}),
    ...(now ? { now } : {}),
  };
}

/** Library item ids as Audiobookshelf makes them (uuids or its older "li_" ids). */
export const ABS_ITEM = /^[A-Za-z0-9_-]{6,64}$/;

/** A book's cover, fetched with the key server side (the browser never sees it). */
export async function audiobookshelfCover(
  fetchImpl: Fetch,
  base: string,
  key: string,
  itemId: string,
): Promise<{ bytes: Buffer; type: string } | undefined> {
  if (!ABS_ITEM.test(itemId)) return undefined;
  const res = (await fetchImpl(
    joinUrl(base, `/api/items/${encodeURIComponent(itemId)}/cover?width=300&format=jpeg`),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "image/*" },
      signal: AbortSignal.timeout(10_000),
    },
  ).catch(() => undefined)) as unknown as Response | undefined;
  const type = res?.headers?.get?.("content-type") ?? "";
  if (!res?.ok || !type.startsWith("image/")) return undefined;
  return { bytes: Buffer.from(await res.arrayBuffer()), type };
}

const hours = (s?: number) => Math.round(((s ?? 0) / 3600) * 10) / 10;

export async function audiobookshelfDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<AudiobookshelfDashboard> {
  const g = <T>(path: string) => get<T>(fetchImpl, base, key, path);
  const [status, libs, online, backups] = await Promise.all([
    g<{ serverVersion?: string }>("/status").catch(() => ({}) as { serverVersion?: string }),
    g<{ libraries?: Library[] }>("/api/libraries"),
    g<{ usersOnline?: { username?: string }[]; openSessions?: OpenSession[] }>(
      "/api/users/online",
    ).catch(() => ({ usersOnline: [], openSessions: [] as OpenSession[] })),
    g<{ backups?: { id?: string; createdAt?: number; fileSize?: number }[] }>("/api/backups").catch(
      () => ({ backups: [] }),
    ),
  ]);
  const libraries = await Promise.all(
    (libs.libraries ?? []).map(async (l) => {
      const [stats, recent] = await Promise.all([
        g<{
          totalItems?: number;
          totalAuthors?: number;
          totalDuration?: number;
          totalSize?: number;
        }>(`/api/libraries/${encodeURIComponent(l.id)}/stats`).catch(
          () =>
            ({}) as {
              totalItems?: number;
              totalAuthors?: number;
              totalDuration?: number;
              totalSize?: number;
            },
        ),
        g<{ results?: RawItem[] }>(
          `/api/libraries/${encodeURIComponent(l.id)}/items?sort=addedAt&desc=1&limit=8`,
        ).catch(() => ({ results: [] })),
      ]);
      return {
        id: l.id,
        name: l.name ?? "A library",
        kind: l.mediaType === "podcast" ? "podcasts" : "books",
        items: stats.totalItems ?? 0,
        authors: stats.totalAuthors ?? 0,
        hours: Math.round(hours(stats.totalDuration)),
        sizeGb: Math.round(((stats.totalSize ?? 0) / 1024 ** 3) * 10) / 10,
        recent: (recent.results ?? []).map(bookOf),
      };
    }),
  );
  const newest = (backups.backups ?? []).map((b) => b.createdAt ?? 0).sort((a, b) => b - a)[0];
  const { shelves, user, now, lists } = await shelvesOf(
    g,
    libs.libraries ?? [],
    online.openSessions ?? [],
  ).catch(() => ({
    shelves: [] as AudiobookshelfShelf[],
    user: undefined,
    now: undefined,
    lists: [] as AudiobookshelfList[],
  }));
  return {
    app: "audiobookshelf",
    ...(shelves.length ? { shelves } : {}),
    lists,
    ...(now ? { nowListening: now } : {}),
    ...(user ? { shelfUser: user } : {}),
    ...(status.serverVersion ? { version: status.serverVersion } : {}),
    listening: (online.openSessions ?? []).map((s) => ({
      user: s.user?.username ?? "Someone",
      title: [s.displayTitle, s.displayAuthor].filter(Boolean).join(" · ") || "Something",
      device: [s.deviceInfo?.clientName, s.deviceInfo?.deviceName ?? s.deviceInfo?.osName]
        .filter(Boolean)
        .join(" · "),
      progressPct: s.duration ? Math.round(((s.currentTime ?? 0) / s.duration) * 100) : 0,
      ...(s.libraryItemId ? { itemId: s.libraryItemId } : {}),
    })),
    online: (online.usersOnline ?? []).map((u) => u.username ?? "Someone"),
    libraries,
    backups: {
      count: (backups.backups ?? []).length,
      ...(newest ? { newest: new Date(newest).toISOString() } : {}),
    },
  };
}

/** The background health read. */
export async function readAudiobookshelf(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await audiobookshelfDashboard(fetchImpl, base, key);
  const week = Date.now() - 7 * 86_400_000;
  const issues =
    !d.backups.newest || Date.parse(d.backups.newest) < week
      ? [
          {
            level: "warning" as const,
            key: "backups",
            text: d.backups.newest
              ? "Audiobookshelf has not made a backup in over a week."
              : "Audiobookshelf has no backups.",
          },
        ]
      : [];
  return {
    app: "audiobookshelf",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Listening now", value: String(d.listening.length) },
      {
        label: "Libraries",
        value: d.libraries.map((l) => `${l.name} (${l.items})`).join(", ") || "None",
      },
    ],
  };
}

export const ABS_OPS = [
  "scan-all",
  "scan-library",
  "backup",
  "list-create",
  "list-add",
  "list-remove",
  "list-order",
  "list-move",
  "continue-remove",
  "intake-setup",
  "intake-import",
  "intake-skip",
  "intake-off",
] as const;
const LIST_OPS = new Set<string>([
  "list-create",
  "list-add",
  "list-remove",
  "list-order",
  "list-move",
]);
type Op = (typeof ABS_OPS)[number];

export class AudiobookshelfOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    /** Audiobook intake: its setup, imports and skips are this panel's plans too. */
    private readonly intake?: AudiobookIntake,
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
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!ABS_OPS.includes(op)) throw new Error(`Say what to do: ${ABS_OPS.join(", ")}.`);
    if (op.startsWith("intake-")) {
      if (!this.intake) throw new Error("Audiobook intake is not available here.");
      try {
        return await this.intake.plan(service, params, base);
      } catch (error) {
        if (error instanceof IntakeRefused) throw new Error(error.message, { cause: error });
        throw error;
      }
    }
    const d = await this.use(service, "read Audiobookshelf", "read", (k) =>
      audiobookshelfDashboard(this.fetchImpl, service.localUrl, k),
    );
    if (LIST_OPS.has(op)) return planList(op, d, service, params ?? {}, base);
    if (op === "continue-remove") {
      const itemId = String(params?.itemId ?? "");
      const shelf = (d.shelves ?? []).find((s) => s.kind === "continue");
      const book = shelf?.books.find((b) => b.id === itemId);
      if (!book) throw new Error("That book isn't in Continue listening.");
      const label = `Take ${bookName(book)} out of Continue listening in ${service.name} (where you are in it is kept)`;
      return {
        ...base,
        label,
        serviceName: service.name,
        params: { op, itemId },
        change: {
          summary: label,
          settings: [{ name: "Continue listening", before: bookName(book), after: "not shown" }],
        },
      };
    }
    let label: string;
    let extra: Record<string, string> = {};
    if (op === "backup")
      label = `Make a backup of ${service.name} now (it keeps its usual number of backups)`;
    else if (op === "scan-all") {
      if (!d.libraries.length) throw new Error(`${service.name} has no libraries to scan.`);
      label = `Scan all ${d.libraries.length} ${d.libraries.length === 1 ? "library" : "libraries"} in ${service.name} for new and changed books`;
      extra = { libraryIds: d.libraries.map((l) => l.id).join(","), name: "all libraries" };
    } else {
      const l = d.libraries.find((x) => x.id === params?.libraryId);
      if (!l) throw new Error("Audiobookshelf does not have that library.");
      label = `Scan the ${l.name} library in ${service.name} for new and changed ${l.kind}`;
      extra = { libraryId: l.id, name: l.name };
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...extra },
      change: {
        summary: label,
        settings: [
          { name: extra.name ?? "Backups", before: `${d.backups.count} backups`, after: op },
        ],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    if (op.startsWith("intake-"))
      return this.intake
        ? this.intake.run(step, service)
        : { ok: false, result: "Audiobook intake is not available here." };
    const name = String(p.name || "Audiobookshelf");
    const outcome = await this.use(
      service,
      `${op} in Audiobookshelf`,
      "change",
      async (key): Promise<StepOutcome> => {
        const base = service.localUrl;
        if (LIST_OPS.has(op)) return runList(this.fetchImpl, base, key, op, p);
        if (op === "continue-remove") {
          // Audiobookshelf's own "Remove from continue listening": it hides the book's progress
          // from the shelf, and keeps the progress itself.
          const itemId = String(p.itemId ?? "");
          const me = await call<{ mediaProgress?: { id?: string; libraryItemId?: string }[] }>(
            this.fetchImpl,
            base,
            key,
            "GET",
            "/api/me",
          );
          const prog = me.data?.mediaProgress?.find((m) => m.libraryItemId === itemId);
          if (!prog?.id)
            return { ok: false, result: "Audiobookshelf has no progress for that book now." };
          const r = await call<unknown>(
            this.fetchImpl,
            base,
            key,
            "GET",
            `/api/me/progress/${encodeURIComponent(prog.id)}/remove-from-continue-listening`,
          );
          if (!r.ok)
            return { ok: false, result: `Audiobookshelf did not take it out (${r.status}).` };
          const back = await call<{ libraryItems?: { id?: string }[] }>(
            this.fetchImpl,
            base,
            key,
            "GET",
            "/api/me/items-in-progress?limit=50",
          );
          return back.ok && !(back.data?.libraryItems ?? []).some((x) => x.id === itemId)
            ? { ok: true, result: "Taken out, read back: it's no longer in Continue listening." }
            : {
                ok: false,
                result:
                  "Audiobookshelf answered, but the book still reads back in Continue listening.",
              };
        }
        if (op === "scan-all") {
          const ids = String(p.libraryIds ?? "")
            .split(",")
            .filter(Boolean);
          const failed: number[] = [];
          for (const id of ids) {
            const r = await call<unknown>(
              this.fetchImpl,
              base,
              key,
              "POST",
              `/api/libraries/${encodeURIComponent(id)}/scan`,
            );
            if (!r.ok) failed.push(r.status);
          }
          return failed.length < ids.length
            ? {
                ok: !failed.length,
                result: failed.length
                  ? `Audiobookshelf is scanning ${ids.length - failed.length} of ${ids.length} libraries; it refused the rest (${failed[0]}).`
                  : `Audiobookshelf is scanning all ${ids.length} ${ids.length === 1 ? "library" : "libraries"}; new books show up as it finds them.`,
              }
            : { ok: false, result: `Audiobookshelf refused the scan (${failed[0]}).` };
        }
        if (op === "scan-library") {
          const r = await call<unknown>(
            this.fetchImpl,
            base,
            key,
            "POST",
            `/api/libraries/${encodeURIComponent(String(p.libraryId))}/scan`,
          );
          return r.ok
            ? { ok: true, result: `Audiobookshelf is scanning ${name}.` }
            : { ok: false, result: `Audiobookshelf refused the scan (${r.status}).` };
        }
        const before = (await audiobookshelfDashboard(this.fetchImpl, base, key)).backups.count;
        const r = await call<unknown>(this.fetchImpl, base, key, "POST", "/api/backups");
        if (!r.ok)
          return { ok: false, result: `Audiobookshelf did not make the backup (${r.status}).` };
        const after = await audiobookshelfDashboard(this.fetchImpl, base, key);
        return after.backups.newest && Date.now() - Date.parse(after.backups.newest) < 10 * 60_000
          ? { ok: true, result: "Audiobookshelf made a backup now. It shows in its backup list." }
          : {
              ok: after.backups.count >= before,
              result: "Audiobookshelf answered; check its backup list for the new one.",
            };
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

/* ---------- Your lists: playlists and collections ---------- */

/** "playlist:<id>" or "collection:<id>", as the panel and Ember name a list. */
export function parseList(ref: unknown): { kind: "playlist" | "collection"; id: string } {
  const m = /^(playlist|collection):([A-Za-z0-9_-]{1,64})$/.exec(String(ref ?? ""));
  if (!m) throw new Error('Say which list: "playlist:<id>" or "collection:<id>".');
  return { kind: m[1] as "playlist" | "collection", id: m[2]! };
}

const listName = (l: AudiobookshelfList) =>
  `${l.kind === "playlist" ? "the playlist" : "the collection"} "${l.name}"`;

const bookName = (b?: { name?: string; title: string }) => (b ? (b.name ?? b.title) : "that book");

/** Plans one change to your lists, showing the list's books before and after. */
function planList(
  op: Op,
  d: AudiobookshelfDashboard,
  service: { name: string },
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const lists = d.lists ?? [];
  const find = (ref: unknown) => {
    const r = parseList(ref);
    const l = lists.find((x) => x.id === r.id && x.kind === r.kind);
    if (!l) throw new Error(`${service.name} has no such list (it may have been deleted).`);
    return l;
  };
  const allBooks = [
    ...d.libraries.flatMap((l) => l.recent),
    ...(d.shelves ?? []).flatMap((s) => s.books),
    ...lists.flatMap((l) => l.books),
    ...(d.nowListening ? [d.nowListening.book] : []),
  ];
  const itemId = p.itemId ? String(p.itemId) : "";
  if (itemId && !ABS_ITEM.test(itemId)) throw new Error("That is not an Audiobookshelf book id.");
  const book = allBooks.find((b) => b.id === itemId);
  const titles = (ids: string[], l: AudiobookshelfList) =>
    ids
      .map((id) => bookName(l.books.find((b) => b.id === id) ?? allBooks.find((b) => b.id === id)))
      .join(", ") || "(empty)";
  const step = (
    label: string,
    params: StepParams,
    settings: { name: string; before: string; after: string }[],
  ) => ({
    ...base,
    label,
    serviceName: service.name,
    params: { op, ...params },
    change: { summary: label, settings },
  });

  if (op === "list-create") {
    const name = String(p.newName ?? "")
      .trim()
      .slice(0, 100);
    if (!name) throw new Error("Give the new playlist a name.");
    if (lists.some((l) => l.kind === "playlist" && l.name.toLowerCase() === name.toLowerCase()))
      throw new Error(`You already have a playlist called "${name}".`);
    const lib =
      d.libraries.find((l) => l.id === p.libraryId) ??
      (d.libraries.filter((l) => l.kind === "books").length === 1
        ? d.libraries.find((l) => l.kind === "books")
        : undefined);
    if (!lib) throw new Error("Say which library the playlist is for.");
    if (!itemId)
      throw new Error(
        "Audiobookshelf keeps a playlist only while it has a book in it: choose the first book.",
      );
    const label = `Make a playlist "${name}" in ${lib.name}, starting with ${bookName(book)}`;
    return step(label, { newName: name, libraryId: lib.id, itemId }, [
      { name: `Playlist "${name}"`, before: "none", after: bookName(book) },
    ]);
  }

  const l = find(p.list);
  const ids = l.books.map((b) => b.id ?? "").filter(Boolean);
  if (op === "list-add") {
    if (!itemId) throw new Error("Say which book to add.");
    if (ids.includes(itemId)) throw new Error(`${bookName(book)} is already in ${listName(l)}.`);
    const after = [...ids, itemId];
    return step(
      `Add ${bookName(book)} to ${listName(l)}`,
      { list: `${l.kind}:${l.id}`, itemId, before: ids.join(",") },
      [{ name: l.name, before: titles(ids, l), after: titles(after, l) }],
    );
  }
  if (!ids.includes(itemId)) throw new Error(`That book is not in ${listName(l)}.`);
  const b = bookName(l.books.find((x) => x.id === itemId));
  if (op === "list-remove") {
    const after = ids.filter((x) => x !== itemId);
    const last = l.kind === "playlist" && !after.length;
    return step(
      `Take ${b} out of ${listName(l)}${last ? " (its last book: Audiobookshelf then deletes the playlist)" : ""}`,
      { list: `${l.kind}:${l.id}`, itemId, before: ids.join(",") },
      [
        {
          name: l.name,
          before: titles(ids, l),
          after: last ? "(playlist deleted)" : titles(after, l),
        },
      ],
    );
  }
  if (op === "list-order") {
    const at = ids.indexOf(itemId);
    const dir = String(p.direction ?? "");
    const to =
      dir === "up"
        ? at - 1
        : dir === "down"
          ? at + 1
          : dir === "top"
            ? 0
            : dir === "bottom"
              ? ids.length - 1
              : -1;
    if (to < 0 || to >= ids.length || to === at)
      throw new Error(`${b} can't move ${dir || "there"} in ${listName(l)}.`);
    const after = [...ids];
    after.splice(at, 1);
    after.splice(to, 0, itemId);
    return step(
      `Move ${b} ${dir === "top" ? "to the top of" : dir === "bottom" ? "to the end of" : dir} ${listName(l)}`,
      { list: `${l.kind}:${l.id}`, itemId, before: ids.join(","), order: after.join(",") },
      [{ name: l.name, before: titles(ids, l), after: titles(after, l) }],
    );
  }
  // list-move: into another list, then out of this one.
  const t = find(p.toList);
  if (t.id === l.id && t.kind === l.kind) throw new Error("Choose a different list to move it to.");
  const tIds = t.books.map((x) => x.id ?? "").filter(Boolean);
  if (tIds.includes(itemId)) throw new Error(`${b} is already in ${listName(t)}.`);
  const left = ids.filter((x) => x !== itemId);
  const last = l.kind === "playlist" && !left.length;
  return step(
    `Move ${b} from ${listName(l)} to ${listName(t)}${last ? " (its last book: Audiobookshelf then deletes that playlist)" : ""}`,
    {
      list: `${l.kind}:${l.id}`,
      toList: `${t.kind}:${t.id}`,
      itemId,
      before: ids.join(","),
      toBefore: tIds.join(","),
    },
    [
      {
        name: l.name,
        before: titles(ids, l),
        after: last ? "(playlist deleted)" : titles(left, l),
      },
      { name: t.name, before: titles(tIds, t), after: titles([...tIds, itemId], t) },
    ],
  );
}

/** One list as Audiobookshelf has it now: its books in order, or undefined when it is gone. */
async function readList(
  fetchImpl: Fetch,
  base: string,
  key: string,
  ref: { kind: "playlist" | "collection"; id: string },
): Promise<string[] | undefined> {
  const r = await call<RawPlaylist & RawCollection>(
    fetchImpl,
    base,
    key,
    "GET",
    `/api/${ref.kind === "playlist" ? "playlists" : "collections"}/${encodeURIComponent(ref.id)}`,
  );
  if (r.status === 404) return undefined;
  if (!r.ok) throw new AppUnreachableError(`Audiobookshelf answered ${r.status} reading the list.`);
  return ref.kind === "playlist"
    ? (r.data.items ?? [])
        .filter((i) => !i.episodeId)
        .map((i) => i.libraryItemId ?? i.libraryItem?.id ?? "")
    : (r.data.books ?? []).map((b) => b.id ?? "");
}

async function addTo(
  fetchImpl: Fetch,
  base: string,
  key: string,
  ref: { kind: "playlist" | "collection"; id: string },
  itemId: string,
) {
  return ref.kind === "playlist"
    ? call(fetchImpl, base, key, "POST", `/api/playlists/${encodeURIComponent(ref.id)}/item`, {
        libraryItemId: itemId,
      })
    : call(fetchImpl, base, key, "POST", `/api/collections/${encodeURIComponent(ref.id)}/book`, {
        id: itemId,
      });
}

async function removeFrom(
  fetchImpl: Fetch,
  base: string,
  key: string,
  ref: { kind: "playlist" | "collection"; id: string },
  itemId: string,
) {
  return ref.kind === "playlist"
    ? call(
        fetchImpl,
        base,
        key,
        "DELETE",
        `/api/playlists/${encodeURIComponent(ref.id)}/item/${encodeURIComponent(itemId)}`,
      )
    : call(
        fetchImpl,
        base,
        key,
        "DELETE",
        `/api/collections/${encodeURIComponent(ref.id)}/book/${encodeURIComponent(itemId)}`,
      );
}

/** Makes one list change, after checking the list is still as planned, then reads it back. */
async function runList(
  fetchImpl: Fetch,
  base: string,
  key: string,
  op: Op,
  p: StepParams,
): Promise<StepOutcome> {
  const itemId = String(p.itemId ?? "");
  if (op === "list-create") {
    const r = await call<{ id?: string }>(fetchImpl, base, key, "POST", "/api/playlists", {
      libraryId: String(p.libraryId),
      name: String(p.newName),
      items: [{ libraryItemId: itemId }],
    });
    if (!r.ok || !r.data?.id)
      return { ok: false, result: `Audiobookshelf did not make the playlist (${r.status}).` };
    const back = await readList(fetchImpl, base, key, { kind: "playlist", id: r.data.id });
    return back?.includes(itemId)
      ? {
          ok: true,
          result: `Made the playlist "${String(p.newName)}", read back with its first book.`,
        }
      : { ok: false, result: "Audiobookshelf answered, but the new playlist did not read back." };
  }
  const ref = parseList(p.list);
  const now = await readList(fetchImpl, base, key, ref);
  if (!now)
    return { ok: false, result: "That list no longer exists in Audiobookshelf. Nothing changed." };
  if (p.before !== undefined && now.join(",") !== String(p.before))
    return {
      ok: false,
      result:
        "The list changed in Audiobookshelf since this was planned. Nothing changed; plan it again.",
    };
  if (op === "list-add") {
    const r = await addTo(fetchImpl, base, key, ref, itemId);
    if (!r.ok) return { ok: false, result: `Audiobookshelf did not add it (${r.status}).` };
    const back = await readList(fetchImpl, base, key, ref);
    return back?.includes(itemId)
      ? { ok: true, result: "Added, read back: the book is in the list." }
      : {
          ok: false,
          result: "Audiobookshelf answered, but the book did not read back in the list.",
        };
  }
  if (op === "list-remove") {
    const r = await removeFrom(fetchImpl, base, key, ref, itemId);
    if (!r.ok) return { ok: false, result: `Audiobookshelf did not take it out (${r.status}).` };
    const back = await readList(fetchImpl, base, key, ref);
    return !back
      ? {
          ok: true,
          result:
            "Taken out, read back: that was its last book, so Audiobookshelf deleted the playlist.",
        }
      : !back.includes(itemId)
        ? { ok: true, result: "Taken out, read back: the book is no longer in the list." }
        : {
            ok: false,
            result: "Audiobookshelf answered, but the book still reads back in the list.",
          };
  }
  if (op === "list-order") {
    const order = String(p.order ?? "")
      .split(",")
      .filter(Boolean);
    const r =
      ref.kind === "playlist"
        ? await call(
            fetchImpl,
            base,
            key,
            "PATCH",
            `/api/playlists/${encodeURIComponent(ref.id)}`,
            {
              items: order.map((id) => ({ libraryItemId: id })),
            },
          )
        : await call(
            fetchImpl,
            base,
            key,
            "PATCH",
            `/api/collections/${encodeURIComponent(ref.id)}`,
            {
              books: order,
            },
          );
    if (!r.ok) return { ok: false, result: `Audiobookshelf did not reorder it (${r.status}).` };
    const back = await readList(fetchImpl, base, key, ref);
    return back?.join(",") === order.join(",")
      ? { ok: true, result: "Moved, read back: the list is in the new order." }
      : {
          ok: false,
          result: "Audiobookshelf answered, but the order did not read back as planned.",
        };
  }
  // list-move
  const to = parseList(p.toList);
  const tNow = await readList(fetchImpl, base, key, to);
  if (!tNow)
    return { ok: false, result: "The list to move it to no longer exists. Nothing changed." };
  if (p.toBefore !== undefined && tNow.join(",") !== String(p.toBefore))
    return {
      ok: false,
      result:
        "The list to move it to changed since this was planned. Nothing changed; plan it again.",
    };
  const added = await addTo(fetchImpl, base, key, to, itemId);
  if (!added.ok)
    return {
      ok: false,
      result: `Audiobookshelf did not add it to the new list (${added.status}). Nothing changed.`,
    };
  const removed = await removeFrom(fetchImpl, base, key, ref, itemId);
  const [inTo, inFrom] = await Promise.all([
    readList(fetchImpl, base, key, to),
    readList(fetchImpl, base, key, ref),
  ]);
  if (!removed.ok || inFrom?.includes(itemId))
    return {
      ok: false,
      result:
        "It was added to the new list, but Audiobookshelf did not take it out of the old one: it is in both now.",
    };
  return inTo?.includes(itemId)
    ? { ok: true, result: "Moved, read back: the book is in the new list and out of the old one." }
    : {
        ok: false,
        result: "Audiobookshelf answered, but the book did not read back in the new list.",
      };
}
