import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  checkHomeRow,
  describeHomeRow,
  fuzzyRank,
  plexRowQuery,
  type HomeRow,
  type HomeRowPlacement,
  type StepParams,
} from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { hubOf, type RawHub } from "./plex-panel";

/**
 * Home Rows on Plex (design "Home Rows: design for DC", phase one): the owner's rows, saved in
 * Hearth, published to one Plex library each. A row built from Plex's own filters becomes a smart
 * collection Hearth creates; Hearth then promotes its row (Home, Library Recommended, Friends'
 * Home) and moves it into place. Hearth finds what it made only by Plex's ids (the collection's
 * ratingKey and its row id), never by title, so a hand-made collection is never touched.
 *
 * Before an apply, Hearth keeps the previous state of everything it will touch: the library's
 * rows (their places and order) and the collection's rules and name. If Plex refuses partway,
 * Hearth puts back what it changed, reads back, and says so. Undo restores that state the same way.
 */

type Hub = ReturnType<typeof hubOf>;
const code = (h: { recommended: boolean; home: boolean; shared: boolean }) =>
  `${h.recommended ? "r" : "-"}${h.home ? "h" : "-"}${h.shared ? "s" : "-"}`;
const flagsOf = (c: string) => ({
  recommended: c[0] === "r",
  home: c[1] === "h",
  shared: c[2] === "s",
});
const where = (h: HomeRowPlacement) =>
  [h.home && "Home", h.recommended && "Library Recommended", h.shared && "Friends' Home"]
    .filter(Boolean)
    .join(", ") || "Hidden";

/** Plex's type number for a collection's items, from the library's kind. */
const TYPE: Record<string, number> = { movie: 1, show: 2 };

/** What an apply changed, kept so Undo (or a failed apply) can put it back. */
interface Capture {
  libraryId: string;
  /** Every row of the library before, in order, with its places. */
  hubs: { id: string; code: string }[];
  /** The collection before: absent when the apply created it. A hand-picked one keeps its titles. */
  collection?: { key: string; title: string; content: string; members?: string[] };
  /** The collection the apply made or changed. */
  collectionKey?: string;
  created: boolean;
  at: string;
}

export interface HomeRowsOptions {
  /** Each library with its folders (two libraries are merged when one reads all of the other's). */
  libraries: { id: string; title: string; type: string; folders?: string[] }[];
  /** Plex's Merge Recently Added Items (null: this Plex has no such setting). */
  merge?: boolean | null;
  /** Recently Released goes by home release, not theaters (11-13). */
  digitalDates?: boolean;
  genres: Record<string, string[]>;
  rows: Record<string, (Hub & { hearth?: string })[]>;
  /**
   * Every collection in each library (11-07: "all of my collections ... needs to be an option
   * to put in the home row"); `row` is its row's id when it has one already.
   */
  collections: Record<string, { key: string; title: string; count: number; row?: string }[]>;
}

/** A collection's row in a library's row list, found by Plex's ids. */
const rowOfCollection = (list: Hub[], library: string, key: string) =>
  list.find(
    (h) =>
      h.id === `custom.collection.${library}.${key}` ||
      (h.id.includes("collection") && h.id.endsWith(`.${key}`)),
  );

/** A saved home screen: each library's rows, in order, with where each shows. */
export interface HomeLayout {
  id: string;
  serviceId: string;
  name: string;
  snapshot: Record<string, { id: string; code: string; row?: string; title?: string }[]>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The state before a switch, for Undo: each library's rows, and which screen was active. */
interface LayoutUndo {
  at: string;
  active?: string;
  libraries: Record<string, { id: string; code: string }[]>;
}

/** One title in a library, for Ember to choose from (GET /api/home-rows/catalog). */
export interface CatalogTitle {
  ratingKey: string;
  title: string;
  year?: number;
  libraryId: string;
  kind: "movie" | "show";
  genres: string[];
  rating?: number;
  /** Plex poster path, for a Forge item's image. */
  thumb?: string;
}

export class HomeRows {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
  ) {}

  /* ---------- Saved rows ---------- */

  private static toRow(r: typeof t.homeRows.$inferSelect): HomeRow {
    return {
      id: r.id,
      serviceId: r.serviceId,
      libraryId: r.libraryId,
      ...(r.libraryName ? { libraryName: r.libraryName } : {}),
      name: r.name,
      ...r.definition,
      ...(r.published ? { published: r.published } : {}),
      ...(r.undo && typeof r.undo.at === "string" ? { undoable: r.undo.at } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async list(serviceId?: string): Promise<HomeRow[]> {
    const rows = await this.handle.db.select().from(t.homeRows);
    return rows
      .filter((r) => !serviceId || r.serviceId === serviceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(HomeRows.toRow);
  }

  async get(id: string): Promise<HomeRow | undefined> {
    const r = await this.handle.db.select().from(t.homeRows).where(eq(t.homeRows.id, id)).get();
    return r ? HomeRows.toRow(r) : undefined;
  }

  /** Saves a new row, or changes one (a published row changes on Plex only when applied again). */
  async save(input: unknown, id?: string): Promise<HomeRow> {
    const v = checkHomeRow(input);
    await this.plexService(v.serviceId);
    const at = new Date().toISOString();
    const definition = {
      rules: v.rules,
      sort: v.sort,
      limit: v.limit,
      placement: v.placement,
      after: v.after,
    };
    if (id) {
      const was = await this.get(id);
      if (!was) throw new Error("That row is gone.");
      if (was.published && (was.serviceId !== v.serviceId || was.libraryId !== v.libraryId))
        throw new Error(
          "This row is on Plex already: undo it there before moving it to another library.",
        );
      await this.handle.db
        .update(t.homeRows)
        .set({
          serviceId: v.serviceId,
          libraryId: v.libraryId,
          libraryName: v.libraryName ?? null,
          name: v.name,
          definition,
          updatedAt: at,
        })
        .where(eq(t.homeRows.id, id));
      return (await this.get(id))!;
    }
    if ((await this.handle.db.select({ id: t.homeRows.id }).from(t.homeRows)).length >= 200)
      throw new Error("Two hundred rows are saved already; delete one you no longer use.");
    const newId = randomUUID();
    await this.handle.db.insert(t.homeRows).values({
      id: newId,
      serviceId: v.serviceId,
      libraryId: v.libraryId,
      libraryName: v.libraryName ?? null,
      name: v.name,
      definition,
      createdAt: at,
      updatedAt: at,
    });
    return (await this.get(newId))!;
  }

  /** A collection was renamed on Plex: a row Hearth made from it takes the new name, so applying
   *  it again (adding a title) does not put the old name back. */
  async renamed(collectionKey: string, name: string) {
    for (const r of await this.list())
      if (r.published?.collectionKey === collectionKey)
        await this.handle.db
          .update(t.homeRows)
          .set({ name, updatedAt: new Date().toISOString() })
          .where(eq(t.homeRows.id, r.id));
  }

  /** Deletes a saved row that is not on Plex (one that is gets undone there first). */
  async remove(id: string) {
    const row = await this.get(id);
    if (!row) return;
    if (row.published)
      throw new Error("This row is on Plex: use Undo to take it off Plex, then delete it.");
    await this.handle.db.delete(t.homeRows).where(eq(t.homeRows.id, id));
  }

  /* ---------- Plex ---------- */

  private async plexService(serviceId: string) {
    const s = await this.handle.db
      .select()
      .from(t.services)
      .where(eq(t.services.id, serviceId))
      .get();
    if (!s || !s.localUrl || s.lifecycle !== "active")
      throw new Error("That Plex isn't in Hearth.");
    return { id: s.id, name: s.name, localUrl: s.localUrl };
  }

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (token: string) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  private async req(base: string, token: string, path: string, method = "GET") {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(joinUrl(base, path), {
        method,
        headers: { Accept: "application/json", "X-Plex-Token": token },
        signal: AbortSignal.timeout(TIMEOUT_MS * 2),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : "no answer";
      throw new AppUnreachableError(`Plex did not answer: ${why.replaceAll(token, "[hidden]")}`);
    }
    if (res.status === 401) throw new AppKeyError("Plex refused the token. Link Plex again.");
    return res;
  }

  private async json<T>(base: string, token: string, path: string): Promise<T> {
    const res = await this.req(base, token, path);
    if (!res.ok)
      throw new AppUnreachableError(`Plex answered ${res.status} for ${path.split("?")[0]}.`);
    return (await res.json().catch(() => ({}))) as T;
  }

  private async libraries(base: string, token: string) {
    const r = await this.json<{
      MediaContainer?: {
        Directory?: {
          key?: string;
          title?: string;
          type?: string;
          Location?: { path?: string }[];
        }[];
      };
    }>(base, token, "/library/sections");
    const list = (r.MediaContainer?.Directory ?? [])
      .filter((d) => d.key && (d.type === "movie" || d.type === "show"))
      .map((d) => ({
        id: String(d.key),
        title: d.title ?? `Library ${d.key}`,
        type: d.type!,
        folders: (d.Location ?? []).map((l) => l.path ?? "").filter(Boolean),
      }));
    // Where each library shows (Plex's Visibility): two combined libraries are only whole when
    // the other one is off Home and out of search.
    return Promise.all(
      list.map(async (l) => {
        const p = await this.json<{
          MediaContainer?: { Setting?: { id?: string; value?: string | number }[] };
        }>(base, token, `/library/sections/${encodeURIComponent(l.id)}/prefs`).catch(
          () => undefined,
        );
        const v = p?.MediaContainer?.Setting?.find((x) => x.id === "hidden")?.value;
        return { ...l, visibility: v === undefined ? "0" : String(v) };
      }),
    );
  }

  /** A library's genres, name to Plex's id. */
  private async genres(base: string, token: string, library: string) {
    const r = await this.json<{
      MediaContainer?: { Directory?: { key?: string; fastKey?: string; title?: string }[] };
    }>(base, token, `/library/sections/${encodeURIComponent(library)}/genre`);
    const out = new Map<string, string>();
    for (const d of r.MediaContainer?.Directory ?? []) {
      const id = /^\d+$/.test(String(d.key ?? ""))
        ? String(d.key)
        : /[?&]genre=(\d+)/.exec(`${d.key ?? ""} ${d.fastKey ?? ""}`)?.[1];
      if (id && d.title) out.set(d.title, id);
    }
    return out;
  }

  private async hubs(base: string, token: string, library: string): Promise<Hub[]> {
    const r = await this.json<{ MediaContainer?: { Hub?: RawHub[] } }>(
      base,
      token,
      `/hubs/sections/${encodeURIComponent(library)}/manage`,
    );
    return (r.MediaContainer?.Hub ?? []).filter((h) => h.identifier).map(hubOf);
  }

  private async collection(base: string, token: string, key: string) {
    const res = await this.req(base, token, `/library/metadata/${encodeURIComponent(key)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new AppUnreachableError(`Plex answered ${res.status} for that collection.`);
    const body = (await res.json().catch(() => ({}))) as {
      MediaContainer?: {
        Metadata?: { type?: string; title?: string; content?: string; smart?: boolean | string }[];
      };
    };
    const m = body.MediaContainer?.Metadata?.[0];
    if (!m || m.type !== "collection") return undefined;
    const smart = m.smart === true || m.smart === "1" || Boolean(m.content);
    return {
      key,
      title: m.title ?? "",
      content: m.content ?? "",
      ...(smart ? {} : { members: await this.members(base, token, key) }),
    };
  }

  /** A collection's titles (ratingKeys), as Plex lists them. */
  private async members(base: string, token: string, key: string) {
    const r = await this.json<{ MediaContainer?: { Metadata?: { ratingKey?: string }[] } }>(
      base,
      token,
      `/library/collections/${encodeURIComponent(key)}/children`,
    );
    return (r.MediaContainer?.Metadata ?? []).map((m) => String(m.ratingKey));
  }

  /** Hand-picked titles as Plex has them: found ones in order, and the keys Plex does not have. */
  private async picked(base: string, token: string, keys: string[], library: string) {
    const found: { ratingKey: string; title: string; year?: number; thumb?: string }[] = [];
    const missing: string[] = [];
    for (const k of keys) {
      const res = await this.req(base, token, `/library/metadata/${encodeURIComponent(k)}`);
      const body = res.ok
        ? ((await res.json().catch(() => ({}))) as {
            MediaContainer?: {
              Metadata?: {
                title?: string;
                year?: number;
                thumb?: string;
                librarySectionID?: number | string;
                type?: string;
              }[];
            };
          })
        : {};
      const m = body.MediaContainer?.Metadata?.[0];
      if (!m || String(m.librarySectionID ?? "") !== library || m.type === "collection")
        missing.push(k);
      else
        found.push({
          ratingKey: k,
          title: m.title ?? k,
          ...(m.year ? { year: m.year } : {}),
          ...(m.thumb ? { thumb: m.thumb } : {}),
        });
    }
    return { found, missing };
  }

  /** The row a step is about: a saved one (rowId), or a whole definition from Ember (row). */
  private async rowOf(
    params: StepParams | undefined,
    serviceId: string,
  ): Promise<HomeRow | undefined> {
    if (params?.rowId) {
      const saved = await this.get(String(params.rowId));
      // One title added by hand to a row of hand-picked titles (11-11: the + on Ember's rows):
      // kept in the row too, so applying it again never drops it.
      const add = params.addTitle ? String(params.addTitle) : "";
      if (!saved || !add) return saved;
      if (!/^\d+$/.test(add)) throw new Error("addTitle must be a ratingKey.");
      if (!saved.rules.titles)
        throw new Error("Only a row of hand-picked titles takes one by hand.");
      if (saved.rules.titles.includes(add)) throw new Error("That title is in the row already.");
      return { ...saved, rules: { ...saved.rules, titles: [...saved.rules.titles, add] } };
    }
    if (!params?.row) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(String(params.row));
    } catch {
      throw new Error("params.row must be the row as JSON.");
    }
    const v = checkHomeRow({ ...(raw as object), serviceId });
    const at = new Date().toISOString();
    return { id: "", ...v, createdAt: at, updatedAt: at };
  }

  private async machine(base: string, token: string) {
    const r = await this.json<{ MediaContainer?: { machineIdentifier?: string } }>(
      base,
      token,
      "/identity",
    );
    const id = r.MediaContainer?.machineIdentifier;
    if (!id) throw new AppUnreachableError("Plex did not say which server it is.");
    return id;
  }

  /** The row's filter, with its genres as Plex's ids; unknown genres are named. */
  private async query(
    base: string,
    token: string,
    row: Pick<HomeRow, "rules" | "sort" | "limit" | "libraryId">,
  ) {
    const libs = await this.libraries(base, token);
    const lib = libs.find((l) => l.id === row.libraryId);
    if (!lib) throw new Error("Plex does not have that library any more.");
    const names = row.rules.genres ?? [];
    const known = names.length ? await this.genres(base, token, lib.id) : new Map<string, string>();
    const missing = names.filter((g) => !known.has(g));
    if (missing.length) throw new Error(`${lib.title} has no genre called ${missing.join(", ")}.`);
    return {
      lib,
      query: plexRowQuery(row, {
        type: TYPE[lib.type] ?? 1,
        genreIds: names.map((g) => known.get(g)!),
      }),
    };
  }

  /** Libraries, their genres and their rows (Hearth's marked), for the editor. */
  async options(serviceId: string): Promise<HomeRowsOptions> {
    const service = await this.plexService(serviceId);
    const mine = await this.list(serviceId);
    const saved = (await this.setting<string[]>(HomeRows.orderKey(serviceId))) ?? [];
    return this.use(service, "read Plex for Home Rows", "read", async (token) => {
      const base = service.localUrl;
      // In the order the owner set (their Plex sidebar's), then any new library after.
      const rank = (id: string) => (saved.includes(id) ? saved.indexOf(id) : saved.length);
      const libraries = (await this.libraries(base, token)).sort((a, b) => rank(a.id) - rank(b.id));
      const genres: HomeRowsOptions["genres"] = {};
      const rows: HomeRowsOptions["rows"] = {};
      const collections: HomeRowsOptions["collections"] = {};
      for (const l of libraries) {
        genres[l.id] = [...(await this.genres(base, token, l.id)).keys()].sort();
        const hubs = await this.hubs(base, token, l.id);
        rows[l.id] = hubs.map((h) => {
          const hearth = mine.find((r) => r.published?.hubId === h.id);
          return hearth ? { ...h, hearth: hearth.id } : h;
        });
        const c = await this.json<{
          MediaContainer?: {
            Metadata?: { ratingKey?: string; title?: string; childCount?: number }[];
          };
        }>(base, token, `/library/sections/${encodeURIComponent(l.id)}/collections`);
        collections[l.id] = (c.MediaContainer?.Metadata ?? [])
          .filter((m) => m.ratingKey)
          .map((m) => {
            const key = String(m.ratingKey);
            const row = rowOfCollection(hubs, l.id, key)?.id;
            return {
              key,
              title: m.title ?? key,
              count: Number(m.childCount ?? 0),
              ...(row ? { row } : {}),
            };
          })
          .sort((a, b) => a.title.localeCompare(b.title));
      }
      // Merge Recently Added Items, as Plex's Manage page has it (MergedRecentlyAdded).
      const prefs = await this.json<{
        MediaContainer?: { Setting?: { id?: string; value?: unknown }[] };
      }>(base, token, "/:/prefs").catch(() => ({}) as { MediaContainer?: undefined });
      const m = prefs.MediaContainer?.Setting?.find((x) => x.id === "MergedRecentlyAdded");
      const merge = m ? m.value === true || m.value === "1" || m.value === 1 : null;
      // Recently Released by home release (plex-digital.ts), as the switch shows it.
      const digital = Boolean(
        (await this.setting<{ on?: boolean }>(`plex-digital:${serviceId}`))?.on,
      );
      return { libraries, genres, rows, collections, merge, digitalDates: digital };
    });
  }

  /** Titles in a library whose name has these words, to hand-pick for a row. */
  async search(serviceId: string, libraryId: string, words: string) {
    const service = await this.plexService(serviceId);
    const q = words.trim().slice(0, 100);
    if (!/^\d+$/.test(libraryId) || !q) return { titles: [] };
    return this.use(service, "find titles for a Home row", "read", async (token) => {
      const r = await this.json<{
        MediaContainer?: {
          Metadata?: { ratingKey?: string; title?: string; year?: number; thumb?: string }[];
        };
      }>(
        service.localUrl,
        token,
        `/library/sections/${encodeURIComponent(libraryId)}/all?${new URLSearchParams({ title: q }).toString()}`,
      );
      return {
        titles: (r.MediaContainer?.Metadata ?? []).slice(0, 20).map((m) => ({
          ratingKey: String(m.ratingKey ?? ""),
          title: m.title ?? "",
          ...(m.year ? { year: m.year } : {}),
          ...(m.thumb ? { thumb: m.thumb } : {}),
        })),
      };
    });
  }

  /** The posters that match a row's rules right now: "Did I build the right row?" */
  async preview(input: unknown) {
    const v = checkHomeRow(input);
    const service = await this.plexService(v.serviceId);
    return this.use(service, "preview a Home Rows row", "read", async (token) => {
      if (v.rules.titles) {
        const { found } = await this.picked(service.localUrl, token, v.rules.titles, v.libraryId);
        return { titles: found, total: found.length };
      }
      const { query } = await this.query(service.localUrl, token, v);
      const r = await this.json<{
        MediaContainer?: {
          totalSize?: number;
          size?: number;
          Metadata?: { ratingKey?: string; title?: string; year?: number; thumb?: string }[];
        };
      }>(
        service.localUrl,
        token,
        `/library/sections/${encodeURIComponent(v.libraryId)}/all?${query}`,
      );
      const titles = (r.MediaContainer?.Metadata ?? []).slice(0, v.limit).map((m) => ({
        ratingKey: String(m.ratingKey ?? ""),
        title: m.title ?? "",
        ...(m.year ? { year: m.year } : {}),
        ...(m.thumb ? { thumb: m.thumb } : {}),
      }));
      return { titles, total: titles.length };
    });
  }

  /**
   * Every movie and show, compactly, so Ember can choose titles for a themed row in one read
   * ("Christmas movies", "horror night, shows too") with its own knowledge of each. Reads only.
   */
  async catalog(serviceId: string) {
    const service = await this.plexService(serviceId);
    return this.use(service, "list titles for a Home row", "read", async (token) => {
      const base = service.localUrl;
      const libraries = await this.libraries(base, token);
      const titles: CatalogTitle[] = [];
      for (const lib of libraries) {
        const r = await this.json<{
          MediaContainer?: {
            Metadata?: {
              ratingKey?: string;
              title?: string;
              year?: number;
              thumb?: string;
              audienceRating?: number;
              Genre?: { tag?: string }[];
            }[];
          };
        }>(
          base,
          token,
          `/library/sections/${encodeURIComponent(lib.id)}/all?type=${TYPE[lib.type] ?? 1}`,
        );
        for (const m of r.MediaContainer?.Metadata ?? [])
          if (m.ratingKey && m.title)
            titles.push({
              ratingKey: String(m.ratingKey),
              title: m.title,
              ...(m.year ? { year: m.year } : {}),
              libraryId: lib.id,
              kind: lib.type === "show" ? "show" : "movie",
              genres: (m.Genre ?? []).map((g) => g.tag ?? "").filter(Boolean),
              ...(typeof m.audienceRating === "number" ? { rating: m.audienceRating } : {}),
              ...(m.thumb ? { thumb: m.thumb } : {}),
            });
      }
      return { serviceId: service.id, libraries, titles };
    });
  }

  /** Each Plex's whole catalog, kept a few minutes: a forgiving search reads it many times. */
  private catalogs = new Map<string, { at: number; titles: CatalogTitle[] }>();

  /**
   * The whole library, searched forgivingly (11-07, the Forge's pick sheets): typos, missing
   * letters and "the" don't matter. Best first; posters go through Hearth's image proxy.
   */
  async find(serviceId: string, q: string, kind: "movie" | "show" | "any" = "any", limit = 30) {
    return this.findIn(serviceId, q, kind, limit);
  }

  /** Which Plex server this is (its machine id), for links to a title in Plex's own app. */
  async machineOf(serviceId: string): Promise<string> {
    const hit = this.machines.get(serviceId);
    if (hit) return hit;
    const service = await this.plexService(serviceId);
    const id = await this.use(service, "read which Plex server this is", "read", (token) =>
      this.machine(service.localUrl, token),
    );
    this.machines.set(serviceId, id);
    return id;
  }
  private readonly machines = new Map<string, string>();

  private async findIn(
    serviceId: string,
    q: string,
    kind: "movie" | "show" | "any",
    limit: number,
  ) {
    const words = q.trim().slice(0, 100);
    if (words.length < 2) return { titles: [] as CatalogTitle[], total: 0 };
    const key = serviceId;
    let cached = this.catalogs.get(key);
    if (!cached || Date.now() - cached.at > 10 * 60_000) {
      cached = { at: Date.now(), titles: (await this.catalog(serviceId)).titles };
      this.catalogs.set(key, cached);
    }
    const pool = kind === "any" ? cached.titles : cached.titles.filter((t) => t.kind === kind);
    const titles = fuzzyRank(pool, words, (t) => t.title, Math.min(60, Math.max(1, limit)));
    return { titles, total: pool.length };
  }

  /* ---------- Apply and undo (planned steps of app-plex-control) ---------- */

  async plan(
    op: "home-row-apply" | "home-row-undo",
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const row = await this.rowOf(params, service.id);
    if (!row) throw new Error("That Home Rows row is gone.");
    if (row.serviceId !== service.id) throw new Error("That row is for another Plex.");
    if (op === "home-row-undo" && !row.id) throw new Error("Say which saved row to undo (rowId).");
    return this.use(service, `read Plex to plan ${op}`, "read", async (token) => {
      const url = service.localUrl;
      const now = await this.hubs(url, token, row.libraryId);
      const snapshot = JSON.stringify(now.map((h) => `${h.id}:${code(h)}`));
      if (op === "home-row-undo") {
        const cap = await this.capture(row.id);
        if (!cap) throw new Error("There is nothing to undo for this row.");
        const settings = [
          {
            name: `“${row.name}”`,
            before: "on Plex",
            after: cap.created
              ? "taken off Plex (Hearth's collection deleted; the titles stay)"
              : "back to its rules and name before",
          },
          {
            name: "Rows",
            before: "as they are now",
            after: `places and order as they were on ${cap.at.slice(0, 10)}`,
          },
        ];
        return {
          ...base,
          label: `Undo the Home row “${row.name}” in ${service.name}`,
          serviceName: service.name,
          params: { op, rowId: row.id, from: snapshot },
          change: { summary: `Undo “${row.name}”`, settings },
        };
      }
      const handPicked = row.rules.titles;
      const libs = await this.libraries(url, token);
      const lib0 = libs.find((l) => l.id === row.libraryId);
      if (!lib0) throw new Error("Plex does not have that library any more.");
      const { lib, query } = handPicked
        ? { lib: lib0, query: "" }
        : await this.query(url, token, row);
      const existing = row.published
        ? await this.collection(url, token, row.published.collectionKey)
        : undefined;
      if (existing && Boolean(existing.members) !== Boolean(handPicked))
        throw new Error(
          handPicked
            ? "This row is on Plex as a collection that follows filters. Undo it, then apply it again with the titles."
            : "This row is on Plex as hand-picked titles. Undo it, then apply it again with filters.",
        );
      let titles: number;
      if (handPicked) {
        const { found, missing } = await this.picked(url, token, handPicked, row.libraryId);
        if (missing.length)
          throw new Error(
            `${lib.title} in Plex has no title with ${missing.length === 1 ? "ratingKey" : "ratingKeys"} ${missing.join(", ")}. Look them up again.`,
          );
        titles = found.length;
      } else {
        // How many titles match now (the poster preview's count).
        const count = await this.json<{
          MediaContainer?: { totalSize?: number; size?: number; Metadata?: unknown[] };
        }>(url, token, `/library/sections/${encodeURIComponent(row.libraryId)}/all?${query}`);
        titles = count.MediaContainer?.Metadata?.length ?? count.MediaContainer?.size ?? 0;
      }
      const after = row.after ? now.find((h) => h.id === row.after) : undefined;
      if (row.after && !after)
        throw new Error("The row this one goes after is gone from Plex. Pick its place again.");
      const audience = row.placement.shared
        ? "You on Home, and everyone you share the library with on Friends' Home"
        : row.placement.home
          ? "You and everyone using this library on Home (Plex rows are shared)"
          : "Everyone browsing the library";
      const settings = [
        {
          name: `“${row.name}”`,
          before: existing ? `on Plex as “${existing.title}”` : "not on Plex",
          after: `${describeHomeRow(row)} (${titles} ${titles === 1 ? "title" : "titles"} now)`,
        },
        { name: "Server and library", before: "", after: `${service.name}, ${lib.title}` },
        {
          name: "Shows on",
          before: "",
          after:
            code(row.placement) === "---" ? "nowhere yet: a collection only" : where(row.placement),
        },
        { name: "Who sees it", before: "", after: audience },
        {
          name: "Position",
          before: "",
          after: after ? `after “${after.title}” in ${lib.title}` : `first in ${lib.title}`,
        },
        handPicked
          ? {
              name: "Collection",
              before: existing ? `Hearth's collection of ${existing.members?.length ?? 0}` : "none",
              after: existing
                ? `the same collection, now exactly ${titles === 1 ? "this title" : `these ${titles}`}`
                : `a new collection of exactly ${titles === 1 ? "this title" : `these ${titles} titles`}`,
            }
          : {
              name: "Collection",
              before: existing ? "Hearth's smart collection" : "none",
              after: existing
                ? "the same collection, its rules updated"
                : "a new smart collection Plex keeps current",
            },
        {
          name: "Note",
          before: "",
          after: "Undo puts the library's rows and this collection back exactly as they are now.",
        },
      ];
      return {
        ...base,
        label: params?.addTitle
          ? `Add a title to the Home row “${row.name}” in ${service.name}`
          : `Apply the Home row “${row.name}” to ${service.name}`,
        serviceName: service.name,
        params: {
          op,
          ...(row.id ? { rowId: row.id } : { row: JSON.stringify(checkHomeRow(row)) }),
          ...(params?.addTitle ? { addTitle: String(params.addTitle) } : {}),
          libraryId: row.libraryId,
          type: String(TYPE[lib.type] ?? 1),
          ...(handPicked ? { titles: JSON.stringify(handPicked) } : { query }),
          title: row.name,
          flags: code(row.placement),
          after: row.after,
          from: snapshot,
          ...(existing ? { collectionKey: existing.key } : {}),
        } as StepParams,
        change: { summary: `Apply “${row.name}” to Plex`, settings },
      };
    });
  }

  private async capture(rowId: string): Promise<Capture | undefined> {
    const r = await this.handle.db.select().from(t.homeRows).where(eq(t.homeRows.id, rowId)).get();
    return r?.undo ? (r.undo as unknown as Capture) : undefined;
  }

  /** Moves a library's rows into the given order, only those out of place. */
  private async order(base: string, token: string, library: string, want: string[]) {
    const lib = encodeURIComponent(library);
    const cur = (await this.hubs(base, token, library)).map((h) => h.id);
    for (let i = 0; i < want.length; i++) {
      const id = want[i]!;
      const after = i ? want[i - 1]! : "";
      const at = cur.indexOf(id);
      if (at < 0) continue;
      if ((i === 0 && at === 0) || (i > 0 && cur[at - 1] === after)) continue;
      const r = await this.req(base, token, plexMovePath(lib, id, after), "PUT");
      if (!r.ok) throw new Error(`Plex refused moving a row (${r.status}).`);
      cur.splice(at, 1);
      cur.splice(i ? cur.indexOf(after) + 1 : 0, 0, id);
    }
  }

  private async promote(base: string, token: string, library: string, hub: string, c: string) {
    const f = flagsOf(c);
    const q = new URLSearchParams({
      promotedToRecommended: f.recommended ? "1" : "0",
      promotedToOwnHome: f.home ? "1" : "0",
      promotedToSharedHome: f.shared ? "1" : "0",
    });
    const r = await this.req(
      base,
      token,
      `/hubs/sections/${encodeURIComponent(library)}/manage/${encodeURIComponent(hub)}?${q.toString()}`,
      "PUT",
    );
    if (!r.ok) throw new Error(`Plex refused changing where a row shows (${r.status}).`);
  }

  /** Makes a hand-picked collection hold exactly these titles; false if Plex refused. */
  private async setMembers(
    base: string,
    token: string,
    key: string,
    now: string[],
    want: string[],
  ): Promise<boolean> {
    const add = want.filter((k) => !now.includes(k));
    if (add.length) {
      const uri = `server://${await this.machine(base, token)}/com.plexapp.plugins.library/library/metadata/${add.join(",")}`;
      const r = await this.req(
        base,
        token,
        `/library/collections/${encodeURIComponent(key)}/items?${new URLSearchParams({ uri }).toString()}`,
        "PUT",
      );
      if (!r.ok) return false;
    }
    for (const k of now.filter((x) => !want.includes(x))) {
      const r = await this.req(
        base,
        token,
        `/library/collections/${encodeURIComponent(key)}/children/${encodeURIComponent(k)}`,
        "DELETE",
      );
      if (!r.ok) return false;
    }
    return true;
  }

  /** Puts back what a capture holds, then reads back; returns what did not come back. */
  private async restore(base: string, token: string, cap: Capture): Promise<string[]> {
    const off: string[] = [];
    if (cap.collectionKey) {
      if (cap.created) {
        const r = await this.req(
          base,
          token,
          `/library/metadata/${encodeURIComponent(cap.collectionKey)}`,
          "DELETE",
        );
        if (!r.ok && r.status !== 404) off.push(`the collection (Plex answered ${r.status})`);
      } else if (cap.collection) {
        const now = await this.collection(base, token, cap.collectionKey);
        if (now && cap.collection.members && now.members) {
          const want = cap.collection.members;
          if (!(await this.setMembers(base, token, cap.collectionKey, now.members, want)))
            off.push("the collection's titles");
        }
        if (now && now.content !== cap.collection.content && cap.collection.content) {
          const r = await this.req(
            base,
            token,
            `/library/collections/${encodeURIComponent(cap.collectionKey)}/items?${new URLSearchParams({ uri: cap.collection.content }).toString()}`,
            "PUT",
          );
          if (!r.ok) off.push("the collection's rules");
        }
        if (now && now.title !== cap.collection.title) {
          const q = new URLSearchParams({
            type: "18",
            "title.value": cap.collection.title,
            "title.locked": "1",
          });
          const r = await this.req(
            base,
            token,
            `/library/metadata/${encodeURIComponent(cap.collectionKey)}?${q.toString()}`,
            "PUT",
          );
          if (!r.ok) off.push("the collection's name");
        }
      }
    }
    let now = await this.hubs(base, token, cap.libraryId);
    for (const h of cap.hubs) {
      const cur = now.find((x) => x.id === h.id);
      if (cur && code(cur) !== h.code)
        await this.promote(base, token, cap.libraryId, h.id, h.code).catch(() =>
          off.push(`where “${cur.title}” shows`),
        );
    }
    const kept = cap.hubs.map((h) => h.id).filter((id) => now.some((x) => x.id === id));
    const extra = now.map((h) => h.id).filter((id) => !kept.includes(id));
    await this.order(base, token, cap.libraryId, [...kept, ...extra]).catch(() =>
      off.push("the order"),
    );
    now = await this.hubs(base, token, cap.libraryId);
    for (const h of cap.hubs) {
      const cur = now.find((x) => x.id === h.id);
      if (cur && code(cur) !== h.code) off.push(`where “${cur.title}” shows`);
    }
    if (
      now
        .map((h) => h.id)
        .filter((id) => kept.includes(id))
        .join("|") !== kept.join("|")
    )
      off.push("the order");
    return [...new Set(off)];
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op);
    let row: HomeRow | undefined;
    try {
      row = await this.rowOf(p, service.id);
    } catch {
      row = undefined;
    }
    if (!row)
      return { ok: false, stale: true, result: "That Home Rows row is gone. Nothing was changed." };
    const outcome = await this.use(
      service,
      `${op} in Plex`,
      "change",
      async (token): Promise<StepOutcome> => {
        const base = service.localUrl;
        const now = await this.hubs(base, token, row.libraryId);
        if (JSON.stringify(now.map((h) => `${h.id}:${code(h)}`)) !== String(p.from))
          return {
            ok: false,
            stale: true,
            result: `The ${row.libraryName ?? "library"}'s rows changed in Plex since this was planned. Nothing was changed; plan it again.`,
          };
        if (op === "home-row-undo") {
          const cap = await this.capture(row.id);
          if (!cap)
            return {
              ok: false,
              stale: true,
              result: "There is nothing to undo. Nothing was changed.",
            };
          const off = await this.restore(base, token, cap);
          if (off.length)
            return {
              ok: false,
              result: `Plex put most of it back, but not ${off.join(", ")}. Check the Rows tab in the Plex panel.`,
            };
          await this.handle.db
            .update(t.homeRows)
            .set({
              undo: null,
              ...(cap.created ? { published: null } : {}),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(t.homeRows.id, row.id));
          return {
            ok: true,
            verified: true,
            result: cap.created
              ? `“${row.name}” is off Plex and the rows are back as they were (read back).`
              : `“${row.name}” and the rows are back as they were (read back).`,
          };
        }
        // Apply.
        const library = String(p.libraryId);
        const key = p.collectionKey ? String(p.collectionKey) : undefined;
        const before = key ? await this.collection(base, token, key) : undefined;
        if (key && !before)
          return {
            ok: false,
            stale: true,
            result: `Hearth's collection for “${row.name}” is gone from Plex. Nothing was changed; plan it again to make a new one.`,
          };
        const cap: Capture = {
          libraryId: library,
          hubs: now.map((h) => ({ id: h.id, code: code(h) })),
          ...(before ? { collection: before } : {}),
          ...(key ? { collectionKey: key } : {}),
          created: !key,
          at: new Date().toISOString(),
        };
        const picks = p.titles ? (JSON.parse(String(p.titles)) as string[]) : undefined;
        const machine = await this.machine(base, token);
        const uri = picks
          ? `server://${machine}/com.plexapp.plugins.library/library/metadata/${picks.join(",")}`
          : `server://${machine}/com.plexapp.plugins.library/library/sections/${encodeURIComponent(library)}/all?${String(p.query)}`;
        const title = String(p.title);
        const fail = async (why: string): Promise<StepOutcome> => {
          const off = await this.restore(base, token, cap).catch(() => [
            "everything (Plex stopped answering)",
          ]);
          return {
            ok: false,
            result: off.length
              ? `${why} Hearth tried to put things back, but not ${off.join(", ")} came back. Check the Rows tab in the Plex panel.`
              : `${why} Hearth put everything back as it was (read back).`,
          };
        };
        try {
          let collectionKey = key;
          if (!collectionKey) {
            const q = new URLSearchParams({
              type: String(p.type ?? String(p.query).match(/^type=(\d+)/)?.[1] ?? "1"),
              title,
              smart: picks ? "0" : "1",
              sectionId: library,
              uri,
            });
            const r = await this.req(base, token, `/library/collections?${q.toString()}`, "POST");
            if (!r.ok) return await fail(`Plex refused creating the collection (${r.status}).`);
            const made = (await r.json().catch(() => ({}))) as {
              MediaContainer?: { Metadata?: { ratingKey?: string }[] };
            };
            collectionKey = made.MediaContainer?.Metadata?.[0]?.ratingKey
              ? String(made.MediaContainer.Metadata[0].ratingKey)
              : undefined;
            if (!collectionKey) {
              // Found by Plex's ids: the one row of this library that was not there before.
              const fresh = (await this.hubs(base, token, library)).find(
                (h) =>
                  !cap.hubs.some((x) => x.id === h.id) &&
                  /^custom\.collection\.\d+\.\d+$/.test(h.id),
              );
              collectionKey = fresh ? fresh.id.split(".").at(-1) : undefined;
            }
            if (!collectionKey)
              return await fail("Plex accepted the collection but did not say which it is.");
            cap.collectionKey = collectionKey;
          } else if (picks) {
            if (!(await this.setMembers(base, token, collectionKey, before?.members ?? [], picks)))
              return await fail("Plex refused changing the collection's titles.");
          } else {
            const r = await this.req(
              base,
              token,
              `/library/collections/${encodeURIComponent(collectionKey)}/items?${new URLSearchParams({ uri }).toString()}`,
              "PUT",
            );
            if (!r.ok)
              return await fail(`Plex refused updating the collection's rules (${r.status}).`);
            if (before && before.title !== title) {
              const q = new URLSearchParams({
                type: "18",
                "title.value": title,
                "title.locked": "1",
              });
              const n = await this.req(
                base,
                token,
                `/library/metadata/${encodeURIComponent(collectionKey)}?${q.toString()}`,
                "PUT",
              );
              if (!n.ok) return await fail(`Plex refused renaming the collection (${n.status}).`);
            }
          }
          // Plex gives a new collection a row only when asked (the owner's server 11-06: the row was not
          // there): ask it to, with the row's places, then find the row by the collection's id.
          const own = (list: Hub[]) =>
            list.find(
              (h) =>
                h.id === `custom.collection.${library}.${collectionKey}` ||
                (h.id.includes("collection") && h.id.endsWith(`.${collectionKey}`)),
            );
          let hubs = await this.hubs(base, token, library);
          // Shown nowhere: a collection only, no row (11-07). A row it already had is hidden.
          const only = String(p.flags) === "---";
          let hubId = "";
          let order: string[] = [];
          if (only) {
            const had = own(hubs);
            if (had && code(had) !== "---") await this.promote(base, token, library, had.id, "---");
            hubId = had?.id ?? "";
          } else {
            if (!own(hubs)) {
              const f = flagsOf(String(p.flags));
              const q = new URLSearchParams({
                metadataItemId: collectionKey,
                promotedToRecommended: f.recommended ? "1" : "0",
                promotedToOwnHome: f.home ? "1" : "0",
                promotedToSharedHome: f.shared ? "1" : "0",
              });
              const r = await this.req(
                base,
                token,
                `/hubs/sections/${encodeURIComponent(library)}/manage?${q.toString()}`,
                "POST",
              );
              if (!r.ok)
                return await fail(`Plex refused giving the collection a row (${r.status}).`);
              hubs = await this.hubs(base, token, library);
            }
            const mineHub = own(hubs);
            if (!mineHub)
              return await fail(
                "Plex made the collection, but its row does not show in the library's rows.",
              );
            hubId = mineHub.id;
            await this.promote(base, token, library, hubId, String(p.flags));
            // Into place: after the chosen row, or first.
            order = hubs.map((h) => h.id).filter((id) => id !== hubId);
            const after = String(p.after ?? "");
            order.splice(after ? order.indexOf(after) + 1 : 0, 0, hubId);
            await this.order(base, token, library, order);
          }
          // Read back.
          const done = await this.hubs(base, token, library);
          if (!only) {
            const mine = done.find((h) => h.id === hubId);
            const placed = done.map((h) => h.id).join("|") === order.join("|");
            if (!mine || code(mine) !== String(p.flags) || !placed)
              return await fail(
                "Plex accepted, but the row does not read back where and as asked.",
              );
          }
          const members = await this.json<{ MediaContainer?: { Metadata?: unknown[] } }>(
            base,
            token,
            `/library/collections/${encodeURIComponent(collectionKey)}/children`,
          );
          const n = members.MediaContainer?.Metadata?.length ?? 0;
          if (picks) {
            const got = (members.MediaContainer?.Metadata ?? []).map((m) =>
              String((m as { ratingKey?: string }).ratingKey),
            );
            if (got.length !== picks.length || picks.some((k) => !got.includes(k)))
              return await fail(
                "Plex accepted, but the collection's titles do not read back as asked.",
              );
          }
          // A row Ember defined in its plan is saved now that it is on Plex.
          const libraryName =
            row.libraryName ??
            (await this.libraries(base, token)).find((l) => l.id === library)?.title;
          const rowId =
            row.id ||
            (
              await this.save({
                ...row,
                serviceId: service.id,
                ...(libraryName ? { libraryName } : {}),
              })
            ).id;
          await this.handle.db
            .update(t.homeRows)
            .set({
              ...(row.id && p.addTitle
                ? {
                    definition: {
                      rules: row.rules,
                      sort: row.sort,
                      limit: row.limit,
                      placement: row.placement,
                      after: row.after,
                    },
                  }
                : {}),
              published: { collectionKey, hubId, at: new Date().toISOString() },
              undo: cap as unknown as Record<string, unknown>,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(t.homeRows.id, rowId));
          const afterId = String(p.after ?? "");
          const pos = afterId
            ? `after “${done.find((h) => h.id === afterId)?.title ?? afterId}”`
            : "first";
          return {
            ok: true,
            verified: true,
            result: only
              ? `“${title}” is a collection on Plex: ${n} ${n === 1 ? "title" : "titles"}, not on Home (read back). Add it as a row any time in Home rows.`
              : `“${title}” is on Plex: ${n} ${n === 1 ? "title" : "titles"}, on ${where(flagsOf(String(p.flags)))}, ${pos} in its library (read back). Undo puts it all back.`,
          };
        } catch (e) {
          return await fail(e instanceof Error ? e.message : String(e));
        }
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, row: row.id, ok: outcome.ok },
    });
    return outcome;
  }
  /* ---------- A collection that is not a row yet, onto Home (11-07) ---------- */

  /**
   * The row a new collection row goes after: a row's id, or a collection's own row
   * (custom.collection.<library>.<key>) made earlier in the same plan, found by Plex's ids.
   */
  private static afterOf(list: Hub[], library: string, after: string) {
    if (!after) return { found: true, id: "" };
    const exact = list.find((h) => h.id === after);
    if (exact) return { found: true, id: exact.id };
    const key = /^custom\.collection\.\d+\.(\d+)$/.exec(after)?.[1];
    const made = key ? rowOfCollection(list, library, key) : undefined;
    return made ? { found: true, id: made.id } : { found: false, id: "" };
  }

  async planCollection(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const library = String(params?.libraryId ?? "");
    const key = String(params?.collectionKey ?? "");
    const flags = /^[r-][h-][s-]$/.test(String(params?.flags ?? ""))
      ? String(params?.flags)
      : "-h-";
    const after = String(params?.after ?? "");
    if (!/^\d+$/.test(library) || !/^\d+$/.test(key))
      throw new Error("Say which library (libraryId) and collection (collectionKey).");
    if (flags === "---") throw new Error("Choose at least one place for the row to show.");
    return this.use(service, "read Plex to plan a collection row", "read", async (token) => {
      const url = service.localUrl;
      const lib = (await this.libraries(url, token)).find((l) => l.id === library);
      if (!lib) throw new Error("Plex does not have that library.");
      const c = await this.collection(url, token, key);
      if (!c) throw new Error(`${lib.title} has no collection ${key}.`);
      const now = await this.hubs(url, token, library);
      if (rowOfCollection(now, library, key))
        throw new Error(`“${c.title}” is a row already: change where it shows with set-rows.`);
      const prev = now.find((h) => h.id === after);
      if (after && !prev && !/^custom\.collection\.\d+\.\d+$/.test(after))
        throw new Error("The row this one goes after is not in that library.");
      return {
        ...base,
        label: `Make the collection “${c.title}” a row in ${service.name}`,
        serviceName: service.name,
        params: {
          op: "home-collection-row",
          libraryId: library,
          collectionKey: key,
          title: c.title,
          flags,
          after,
        },
        change: {
          summary: `“${c.title}” as a row`,
          settings: [
            {
              name: `“${c.title}”`,
              before: "not a row",
              after: `a row on ${where(flagsOf(flags))}`,
            },
            {
              name: "Position",
              before: "",
              after: after
                ? `after “${prev?.title ?? "the row before it"}” in ${lib.title}`
                : `first in ${lib.title}`,
            },
            { name: "Note", before: "", after: "The collection and its titles are not changed." },
          ],
        },
      };
    });
  }

  async runCollection(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const library = String(p.libraryId);
    const key = String(p.collectionKey);
    const title = String(p.title ?? key);
    const flags = String(p.flags ?? "-h-");
    const outcome = await this.use(
      service,
      "make a collection a row in Plex",
      "change",
      async (token): Promise<StepOutcome> => {
        const base = service.localUrl;
        const now = await this.hubs(base, token, library);
        // What it acts on must still be as planned: the collection with no row yet, and the row
        // it goes after (other rows may have moved in the same plan; that is expected).
        if (rowOfCollection(now, library, key))
          return {
            ok: false,
            stale: true,
            result: `“${title}” is a row already. Nothing was changed.`,
          };
        const after = HomeRows.afterOf(now, library, String(p.after ?? ""));
        if (!after.found)
          return {
            ok: false,
            stale: true,
            result:
              "The row this one goes after is gone from Plex. Nothing was changed; plan it again.",
          };
        const f = flagsOf(flags);
        const q = new URLSearchParams({
          metadataItemId: key,
          promotedToRecommended: f.recommended ? "1" : "0",
          promotedToOwnHome: f.home ? "1" : "0",
          promotedToSharedHome: f.shared ? "1" : "0",
        });
        const r = await this.req(
          base,
          token,
          `/hubs/sections/${encodeURIComponent(library)}/manage?${q.toString()}`,
          "POST",
        );
        if (!r.ok)
          return {
            ok: false,
            result: `Plex refused making “${title}” a row (${r.status}). Nothing was changed.`,
          };
        const made = rowOfCollection(await this.hubs(base, token, library), library, key);
        const undo = async (why: string): Promise<StepOutcome> => {
          // Take the new row away again; the collection itself is never touched.
          if (made)
            await this.req(
              base,
              token,
              `/hubs/sections/${encodeURIComponent(library)}/manage/${encodeURIComponent(made.id)}`,
              "DELETE",
            ).catch(() => undefined);
          const left = rowOfCollection(await this.hubs(base, token, library), library, key);
          return {
            ok: false,
            result: left
              ? `${why} Hearth could not take the new row away again: take it off in Home rows.`
              : `${why} Hearth took the new row away again (read back).`,
          };
        };
        if (!made)
          return {
            ok: false,
            result: "Plex accepted, but no row for the collection shows. Nothing else was changed.",
          };
        let want: string[];
        try {
          await this.promote(base, token, library, made.id, flags);
          const ids = (await this.hubs(base, token, library))
            .map((h) => h.id)
            .filter((id) => id !== made.id);
          ids.splice(after.id ? ids.indexOf(after.id) + 1 : 0, 0, made.id);
          want = ids;
          await this.order(base, token, library, want);
        } catch (e) {
          return undo(e instanceof Error ? e.message : String(e));
        }
        const done = await this.hubs(base, token, library);
        const mine = done.find((h) => h.id === made.id);
        if (!mine || code(mine) !== flags || done.map((h) => h.id).join("|") !== want.join("|"))
          return undo("Plex accepted, but the row does not read back where and as asked.");
        return {
          ok: true,
          verified: true,
          result: `“${title}” is a row on ${where(f)}, ${after.id ? "in place" : "first in its library"} (read back).`,
        };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `home-collection-row in ${service.name}`,
      target: `service:${service.id}`,
      detail: { library, collection: key, ok: outcome.ok },
    });
    return outcome;
  }

  /**
   * A few posters for a row, so the editor looks like Home: a collection's first titles, or the
   * titles Plex shows in one of its own rows. Reads only.
   */
  async posters(
    serviceId: string,
    libraryId: string,
    rowId: string,
    title = "",
    /** Libraries a change not saved yet merges into this one (11-13): the row as it will be. */
    withIds: string[] = [],
    /** How many: a few for the editor, a full row for the server's Home tab (11-22). */
    count = 10,
  ) {
    const n = Math.max(1, Math.min(40, Math.floor(count) || 10));
    const service = await this.plexService(serviceId);
    if (!/^\d+$/.test(libraryId) || !rowId) return { titles: [] };
    const kind = /\.(recentlyadded|recentlyreleased)(\.\d+)?$/.exec(rowId)?.[1];
    const others = withIds.filter((x) => /^\d+$/.test(x) && x !== libraryId);
    if (kind && others.length)
      return this.use(service, "show a merged Home row's posters", "read", (token) =>
        this.mergedPosters(service.localUrl, token, [libraryId, ...others], kind, n),
      );
    return this.use(service, "show a Home row's posters", "read", async (token) => {
      const base = service.localUrl;
      type M = {
        ratingKey?: string;
        title?: string;
        thumb?: string;
        grandparentThumb?: string;
        grandparentTitle?: string;
        type?: string;
        year?: number;
        index?: number;
        parentIndex?: number;
      };
      const shape = (list: M[]) =>
        list.slice(0, n).map((m) => ({
          ratingKey: String(m.ratingKey ?? ""),
          title: (m.type === "episode" && m.grandparentTitle) || m.title || "",
          ...(m.year ? { year: m.year } : {}),
          ...(m.type === "episode" && m.index !== undefined
            ? { sub: `S${m.parentIndex ?? 1} · E${m.index}` }
            : {}),
          ...(((m.type === "episode" ? m.grandparentThumb : m.thumb) ?? m.thumb)
            ? { thumb: (m.type === "episode" ? m.grandparentThumb : m.thumb) ?? m.thumb }
            : {}),
        }));
      const key =
        /^custom\.collection\.\d+\.(\d+)$/.exec(rowId)?.[1] ??
        /^collection:(\d+)$/.exec(rowId)?.[1];
      if (key) {
        const r = await this.json<{ MediaContainer?: { Metadata?: M[] } }>(
          base,
          token,
          `/library/collections/${encodeURIComponent(key)}/children?X-Plex-Container-Start=0&X-Plex-Container-Size=${n}`,
        );
        return { titles: shape(r.MediaContainer?.Metadata ?? []) };
      }
      // Plex's own row: what Plex shows in it, matched by its id (with or without the library
      // number on the end) or its title.
      const r = await this.json<{
        MediaContainer?: {
          Hub?: { hubIdentifier?: string; title?: string; Metadata?: M[]; Directory?: M[] }[];
        };
      }>(base, token, `/hubs/sections/${encodeURIComponent(libraryId)}?count=${n}`).catch(() => ({
        MediaContainer: { Hub: [] },
      }));
      const bare = (id: string) => id.replace(/\.\d+$/, "");
      const list = r.MediaContainer?.Hub ?? [];
      const hub =
        list.find((h) => h.hubIdentifier === rowId) ??
        list.find((h) => h.hubIdentifier && bare(h.hubIdentifier) === bare(rowId)) ??
        (title ? list.find((h) => h.title?.toLowerCase() === title.toLowerCase()) : undefined);
      const got = hub?.Metadata ?? hub?.Directory ?? [];
      if (got.length) return { titles: shape(got) };
      // Not shown in the library's own page right now: fill it the way Plex does.
      const lib = (await this.libraries(base, token)).find((l) => l.id === libraryId);
      const type = TYPE[lib?.type ?? "movie"] ?? 1;
      const kind = rowId.split(".")[1] ?? "";
      const sec = `/library/sections/${encodeURIComponent(libraryId)}`;
      const size = `X-Plex-Container-Start=0&X-Plex-Container-Size=${n}`;
      const path: Record<string, string> = {
        recentlyadded: `${sec}/all?type=${type}&sort=addedAt:desc&${size}`,
        recentlyreleased: `${sec}/all?type=${type}&sort=originallyAvailableAt:desc&${size}`,
        inprogress: `${sec}/onDeck?${size}`,
        ondeck: `${sec}/onDeck?${size}`,
        recentlyviewed: `${sec}/all?type=${type}&sort=lastViewedAt:desc&${size}`,
        rediscover: `${sec}/all?type=${type}&unwatched=0&sort=lastViewedAt:asc&${size}`,
        topunwatched: `${sec}/all?type=${type}&unwatched=1&sort=audienceRating:desc&${size}`,
        newestepisodes: `${sec}/all?type=4&sort=originallyAvailableAt:desc&${size}`,
        recentlyaired: `${sec}/all?type=4&sort=originallyAvailableAt:desc&${size}`,
      };
      const f = await this.json<{ MediaContainer?: { Metadata?: M[] } }>(
        base,
        token,
        path[kind] ?? `${sec}/all?type=${type}&sort=addedAt:desc&${size}`,
      ).catch(() => ({ MediaContainer: { Metadata: [] } }));
      return { titles: shape(f.MediaContainer?.Metadata ?? []) };
    });
  }

  /**
   * Plex's Continue Watching as its Home shows it (11-22, the owner: the Home tab showed none
   * while Plex had a row of them). It is one row across every library, not a library's own row,
   * so it is read from Plex's Home: the continueWatching hub where Plex has it, then Home's own
   * hubs, then On Deck for older servers. Reads only.
   */
  async continueWatching(serviceId: string, count = 24) {
    const n = Math.max(1, Math.min(40, Math.floor(count) || 24));
    const service = await this.plexService(serviceId);
    return this.use(service, "show Continue Watching", "read", async (token) => {
      const base = service.localUrl;
      type M = {
        ratingKey?: string;
        title?: string;
        thumb?: string;
        grandparentThumb?: string;
        grandparentTitle?: string;
        type?: string;
        year?: number;
        index?: number;
        parentIndex?: number;
      };
      type Hub = { hubIdentifier?: string; Metadata?: M[] };
      type R = { MediaContainer?: { Hub?: Hub[]; Metadata?: M[] } };
      const read = (path: string) => this.json<R>(base, token, path).catch(() => undefined);
      const size = `X-Plex-Container-Start=0&X-Plex-Container-Size=${n}`;
      const fromHubs = (r: R | undefined, pick?: (h: Hub) => boolean) =>
        (r?.MediaContainer?.Hub ?? [])
          .filter((h) => !pick || pick(h))
          .flatMap((h) => h.Metadata ?? []);
      let got = fromHubs(await read(`/hubs/continueWatching?count=${n}`));
      if (!got.length) got = fromHubs(await read(`/hubs/home/continueWatching?count=${n}`));
      if (!got.length)
        got = fromHubs(await read(`/hubs?count=${n}`), (h) =>
          /^home\.(continue|ondeck)/.test(h.hubIdentifier ?? ""),
        );
      if (!got.length)
        got = (await read(`/library/onDeck?${size}`))?.MediaContainer?.Metadata ?? [];
      const seen = new Set<string>();
      return {
        titles: got
          .filter((m) => {
            const k = String(m.ratingKey ?? "");
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, n)
          .map((m) => {
            const ep = m.type === "episode";
            const thumb = (ep ? m.grandparentThumb : m.thumb) ?? m.thumb;
            return {
              ratingKey: String(m.ratingKey ?? ""),
              title: (ep && m.grandparentTitle) || m.title || "",
              ...(m.year ? { year: m.year } : {}),
              ...(ep && m.index !== undefined
                ? { sub: `S${m.parentIndex ?? 1} · E${m.index}` }
                : {}),
              ...(thumb ? { thumb } : {}),
            };
          }),
      };
    });
  }

  /**
   * A merged Recently Added or Recently Released row as Plex will show it once saved (11-13, the
   * owner: "if it's not showing the same thing in Home rows then my panel is useless"): every
   * library's films together, each film once, newest first. Added dates are each film's own (the
   * merge puts them back), so the order is the one Plex shows after saving.
   */
  private async mergedPosters(base: string, token: string, libs: string[], kind: string, n = 10) {
    type M = {
      ratingKey?: string;
      title?: string;
      thumb?: string;
      year?: number;
      addedAt?: number;
      originallyAvailableAt?: string;
      guid?: string;
      Media?: { Part?: { file?: string }[] }[];
    };
    const sort = kind === "recentlyadded" ? "addedAt:desc" : "originallyAvailableAt:desc";
    const seen = new Map<string, M & { at: number; out: string }>();
    for (const lib of libs) {
      const r = await this.json<{ MediaContainer?: { Metadata?: M[] } }>(
        base,
        token,
        `/library/sections/${encodeURIComponent(lib)}/all?type=1&sort=${sort}&X-Plex-Container-Start=0&X-Plex-Container-Size=300`,
      ).catch(() => ({ MediaContainer: { Metadata: [] as M[] } }));
      for (const m of r.MediaContainer?.Metadata ?? []) {
        const file = m.Media?.[0]?.Part?.[0]?.file;
        const id = file ? `f:${file}` : `g:${m.guid ?? m.ratingKey}`;
        const at = Number(m.addedAt ?? 0);
        const was = seen.get(id);
        if (!was) seen.set(id, { ...m, at, out: m.originallyAvailableAt ?? "" });
        else if (at && at < was.at) was.at = at;
      }
    }
    const list = [...seen.values()].sort((a, b) =>
      kind === "recentlyadded" ? b.at - a.at : b.out.localeCompare(a.out),
    );
    return {
      titles: list.slice(0, n).map((m) => ({
        ratingKey: String(m.ratingKey ?? ""),
        title: m.title ?? "",
        ...(m.year ? { year: m.year } : {}),
        ...(m.thumb ? { thumb: m.thumb } : {}),
      })),
    };
  }

  /* ---------- Saved home screens (11-06) ---------- */

  private async setting<T>(key: string): Promise<T | undefined> {
    const r = await this.handle.db.select().from(t.settings).where(eq(t.settings.key, key)).get();
    return r ? (r.value as T) : undefined;
  }

  private static orderKey = (serviceId: string) => `home-rows:library-order:${serviceId}`;

  /**
   * The order Home shows libraries in, as the owner's Plex sidebar has them (Plex keeps that on
   * the Plex account, not the server, so the owner sets it once here). Hearth only; Plex is not
   * changed.
   */
  async setLibraryOrder(serviceId: string, order: unknown) {
    await this.plexService(serviceId);
    if (!Array.isArray(order) || order.length > 100 || order.some((x) => !/^\d+$/.test(String(x))))
      throw new Error("The order is a list of library ids.");
    await this.put(HomeRows.orderKey(serviceId), [...new Set(order.map(String))]);
    return { ok: true };
  }

  private async put(key: string, value: unknown) {
    const at = new Date().toISOString();
    if (value === undefined) {
      await this.handle.db.delete(t.settings).where(eq(t.settings.key, key));
      return;
    }
    await this.handle.db
      .insert(t.settings)
      .values({ key, value: value as never, updatedAt: at })
      .onConflictDoUpdate({
        target: t.settings.key,
        set: { value: value as never, updatedAt: at },
      });
  }

  private static activeKey = (serviceId: string) => `home-layouts:active:${serviceId}`;
  private static undoKey = (serviceId: string) => `home-layouts:undo:${serviceId}`;

  async layouts(serviceId: string): Promise<{ layouts: HomeLayout[]; undoable?: string }> {
    const rows = await this.handle.db
      .select()
      .from(t.homeLayouts)
      .where(eq(t.homeLayouts.serviceId, serviceId));
    const active = await this.setting<string>(HomeRows.activeKey(serviceId));
    const undo = await this.setting<LayoutUndo>(HomeRows.undoKey(serviceId));
    return {
      layouts: rows
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => ({ ...r, active: r.id === active })),
      ...(undo ? { undoable: undo.at } : {}),
    };
  }

  /** Every library's rows as Plex shows them now, Hearth's by their row id. */
  private async current(service: { id: string; localUrl: string }, token: string) {
    const mine = await this.list(service.id);
    const out: HomeLayout["snapshot"] = {};
    for (const l of await this.libraries(service.localUrl, token))
      out[l.id] = (await this.hubs(service.localUrl, token, l.id)).map((h) => {
        const row = mine.find((r) => r.published?.hubId === h.id);
        return { id: h.id, code: code(h), title: h.title, ...(row ? { row: row.id } : {}) };
      });
    return out;
  }

  /** Saves the home screen as Plex shows it now, under a name (or over a saved one). */
  async saveLayout(serviceId: string, name: string, id?: string): Promise<HomeLayout> {
    const service = await this.plexService(serviceId);
    const n = name.trim().slice(0, 60);
    if (!n) throw new Error("Give the home screen a name.");
    const snapshot = await this.use(service, "save the Plex home screen", "read", (token) =>
      this.current(service, token),
    );
    const at = new Date().toISOString();
    if (id) {
      const was = await this.handle.db
        .select()
        .from(t.homeLayouts)
        .where(eq(t.homeLayouts.id, id))
        .get();
      if (!was || was.serviceId !== serviceId) throw new Error("That saved home screen is gone.");
      await this.handle.db
        .update(t.homeLayouts)
        .set({ name: n, snapshot, updatedAt: at })
        .where(eq(t.homeLayouts.id, id));
    } else {
      const count = (await this.layouts(serviceId)).layouts.length;
      if (count >= 20) throw new Error("Twenty home screens are saved already; delete one first.");
      id = randomUUID();
      await this.handle.db
        .insert(t.homeLayouts)
        .values({ id, serviceId, name: n, snapshot, createdAt: at, updatedAt: at });
    }
    // What is on Plex now is this screen.
    await this.put(HomeRows.activeKey(serviceId), id);
    return (await this.layouts(serviceId)).layouts.find((l) => l.id === id)!;
  }

  async renameLayout(id: string, name: string) {
    const n = name.trim().slice(0, 60);
    if (!n) throw new Error("Give the home screen a name.");
    await this.handle.db
      .update(t.homeLayouts)
      .set({ name: n, updatedAt: new Date().toISOString() })
      .where(eq(t.homeLayouts.id, id));
  }

  /** Deletes a saved screen (Plex is not changed). */
  async removeLayout(id: string) {
    const was = await this.handle.db
      .select()
      .from(t.homeLayouts)
      .where(eq(t.homeLayouts.id, id))
      .get();
    if (!was) return;
    await this.handle.db.delete(t.homeLayouts).where(eq(t.homeLayouts.id, id));
    if ((await this.setting<string>(HomeRows.activeKey(was.serviceId))) === id)
      await this.put(HomeRows.activeKey(was.serviceId), undefined);
  }

  /**
   * What each library's rows become for a saved screen: its rows in its order and places;
   * rows it does not know keep their places, after it; Hearth rows it does not have are hidden.
   */
  private static target(layout: HomeLayout, now: HomeLayout["snapshot"], rows: HomeRow[]) {
    const plan: Record<string, { id: string; code: string; title: string }[]> = {};
    const skipped: string[] = [];
    for (const [lib, cur] of Object.entries(now)) {
      const want: { id: string; code: string; title: string }[] = [];
      for (const e of layout.snapshot[lib] ?? []) {
        const hub = e.row ? rows.find((r) => r.id === e.row)?.published?.hubId : e.id;
        const here = hub ? cur.find((h) => h.id === hub) : undefined;
        if (!here) {
          if (e.row || e.title) skipped.push(e.title ?? e.id);
          continue;
        }
        if (!want.some((w) => w.id === here.id))
          want.push({ id: here.id, code: e.code, title: here.title ?? here.id });
      }
      for (const h of cur)
        if (!want.some((w) => w.id === h.id))
          want.push({ id: h.id, code: h.row ? "---" : h.code, title: h.title ?? h.id });
      plan[lib] = want;
    }
    return { plan, skipped };
  }

  async planLayout(
    op: "home-layout-apply" | "home-layout-undo",
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    return this.use(
      service,
      `read Plex to plan ${op}`,
      "read",
      async (token): Promise<PlannedStep> => {
        const now = await this.current(service, token);
        const libs = await this.libraries(service.localUrl, token);
        const libName = (id: string) => libs.find((l) => l.id === id)?.title ?? `Library ${id}`;
        const from = JSON.stringify(now);
        const places = (c: string) => where(flagsOf(c));
        if (op === "home-layout-undo") {
          const undo = await this.setting<LayoutUndo>(HomeRows.undoKey(service.id));
          if (!undo) throw new Error("There is no home screen switch to undo.");
          return {
            ...base,
            label: `Put the Plex home screen back as it was before the last switch in ${service.name}`,
            serviceName: service.name,
            params: { op, from },
            change: {
              summary: "Undo the last home screen switch",
              settings: [
                {
                  name: "Home screen",
                  before: "as it is now",
                  after: `every library's rows as they were on ${undo.at.slice(0, 10)}`,
                },
              ],
            },
          };
        }
        const layout = (await this.layouts(service.id)).layouts.find(
          (l) => l.id === String(params?.layoutId ?? ""),
        );
        if (!layout) throw new Error("That saved home screen is gone.");
        const { plan, skipped } = HomeRows.target(layout, now, await this.list(service.id));
        const settings: { name: string; before: string; after: string }[] = [];
        for (const [lib, want] of Object.entries(plan)) {
          const cur = now[lib] ?? [];
          for (const w of want) {
            const was = cur.find((h) => h.id === w.id);
            if (was && was.code !== w.code)
              settings.push({
                name: `${libName(lib)}: ${w.title}`,
                before: places(was.code),
                after: places(w.code),
              });
          }
          const moved = want.map((w) => w.id).join("|") !== cur.map((h) => h.id).join("|");
          if (moved)
            settings.push({
              name: `${libName(lib)}: order`,
              before: "as it is",
              after:
                want
                  .slice(0, 6)
                  .map((w) => w.title)
                  .join(", ") + (want.length > 6 ? ", …" : ""),
            });
        }
        if (skipped.length)
          settings.push({
            name: "Note",
            before: "",
            after: `Not on Plex now, so left out: ${skipped.slice(0, 6).join(", ")}${skipped.length > 6 ? ", …" : ""}.`,
          });
        settings.push({
          name: "Note",
          before: "",
          after: "Rows are only shown or hidden, never deleted. Undo puts this home screen back.",
        });
        if (settings.length === (skipped.length ? 2 : 1))
          throw new Error(`Plex already shows “${layout.name}”.`);
        return {
          ...base,
          label: `Switch the Plex home screen to “${layout.name}” in ${service.name}`,
          serviceName: service.name,
          params: {
            op,
            layoutId: layout.id,
            from,
            target: JSON.stringify(
              Object.fromEntries(
                Object.entries(plan).map(([k, v]) => [
                  k,
                  v.map((w) => ({ id: w.id, code: w.code })),
                ]),
              ),
            ),
          },
          change: { summary: `Switch to “${layout.name}”`, settings },
        };
      },
    );
  }

  async runLayout(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op);
    const outcome = await this.use(
      service,
      `${op} in Plex`,
      "change",
      async (token): Promise<StepOutcome> => {
        const base = service.localUrl;
        const now = await this.current(service, token);
        if (JSON.stringify(now) !== String(p.from))
          return {
            ok: false,
            stale: true,
            result:
              "Plex's rows changed since this was planned. Nothing was changed; plan it again.",
          };
        const asCaps = (
          libs: Record<string, { id: string; code: string }[]>,
          at: string,
        ): Capture[] =>
          Object.entries(libs).map(([libraryId, hubs]) => ({
            libraryId,
            hubs,
            created: false,
            at,
          }));
        const putBack = async (libs: Record<string, { id: string; code: string }[]>) => {
          const off: string[] = [];
          for (const c of asCaps(libs, "")) off.push(...(await this.restore(base, token, c)));
          return [...new Set(off)];
        };
        if (op === "home-layout-undo") {
          const undo = await this.setting<LayoutUndo>(HomeRows.undoKey(service.id));
          if (!undo)
            return {
              ok: false,
              stale: true,
              result: "There is nothing to undo. Nothing was changed.",
            };
          const off = await putBack(undo.libraries);
          if (off.length)
            return { ok: false, result: `Plex put most of it back, but not ${off.join(", ")}.` };
          await this.put(HomeRows.undoKey(service.id), undefined);
          await this.put(HomeRows.activeKey(service.id), undo.active);
          return {
            ok: true,
            verified: true,
            result: "The Plex home screen is back as it was (read back).",
          };
        }
        const layout = (await this.layouts(service.id)).layouts.find(
          (l) => l.id === String(p.layoutId),
        );
        if (!layout)
          return {
            ok: false,
            stale: true,
            result: "That saved home screen is gone. Nothing was changed.",
          };
        const before: LayoutUndo = {
          at: new Date().toISOString(),
          ...((await this.setting<string>(HomeRows.activeKey(service.id)))
            ? { active: await this.setting<string>(HomeRows.activeKey(service.id)) }
            : {}),
          libraries: Object.fromEntries(
            Object.entries(now).map(([k, v]) => [k, v.map((h) => ({ id: h.id, code: h.code }))]),
          ),
        };
        const target = JSON.parse(String(p.target)) as Record<
          string,
          { id: string; code: string }[]
        >;
        // The same steps as Undo, aimed at the saved screen: places, then order, then read back.
        const off = await putBack(target);
        if (off.length) {
          const back = await putBack(before.libraries);
          return {
            ok: false,
            result: back.length
              ? `Plex refused part of the switch (${off.join(", ")}), and not everything went back (${back.join(", ")}). Check the Plex panel's Manage tab.`
              : `Plex refused part of the switch (${off.join(", ")}). Hearth put the home screen back as it was (read back).`,
          };
        }
        await this.put(HomeRows.undoKey(service.id), before);
        await this.put(HomeRows.activeKey(service.id), layout.id);
        return {
          ok: true,
          verified: true,
          result: `The Plex home screen is “${layout.name}” now (read back). Undo puts the last one back.`,
        };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, layout: p.layoutId ? String(p.layoutId) : undefined, ok: outcome.ok },
    });
    return outcome;
  }
}

/**
 * Plex's move for a library's row (11-08: "Plex accepted, but the order does not read back as
 * asked"): the row's identifier in the path, and `after` always sent, empty for the top. With no
 * `after`, Plex answers OK and leaves the row where it was, so a row moved to the top never moved.
 * The same call Plezy makes. `lib` is already encoded.
 */
export function plexMovePath(lib: string, id: string, after: string): string {
  return `/hubs/sections/${lib}/manage/${encodeURIComponent(id)}/move?${new URLSearchParams({ after })}`;
}
