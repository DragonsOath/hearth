import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { HomeRows, plexMovePath } from "./home-rows";
import { PlexDigitalDates } from "./plex-digital";
import { PlexCarry, placesOf, rowsToCarry, type CarryPass, type CarryRow } from "./plex-carry";
import { hubOf, plexSettingLocked, watchedOf, type RawHub, type RawItem } from "./plex-panel";

/**
 * Plex changes from Hearth (the panel and Ember plan the same steps):
 * - scan-all, scan-library: scan for new and changed files, as "Scan Library Files" in Plex.
 * - watched, unwatched: mark a film, episode, season or show watched or not.
 * - rate: your star rating (1 to 5, Plex keeps it out of 10), as you'd set it in Plex itself.
 * - refresh-item: refresh one title's details and artwork.
 * - edit-item: change a title's name, sort title, summary or year (each change is locked in Plex
 *   so the next refresh keeps it).
 * - empty-trash: remove a library's entries for files that are gone from disk (files are untouched).
 * - clean-bundles, optimize-db: Plex's own maintenance.
 * - run-task, stop-task: one of Plex's scheduled maintenance tasks, now.
 * - set-settings: Plex server settings, never networking, remote access or credentials.
 * - set-rows: a library's rows (hubs): shown in Library Recommended, on Home, on Friends' Home,
 *   and their order, as Plex's Manage Libraries page sets them.
 * - merge-recent: Merge Recently Added Items on Home, as on that page.
 * - merge-released: combine two libraries of the same kind on Home (11-07: New Releases and
 *   Movies): one Recently Added and one Recently Released row, every title once. Plex has no
 *   setting for it and every row reads one library, so the other library's folders are added to
 *   this one, and the other library is left off Home and out of search (Plex's Visibility,
 *   "Exclude from home screen and global search"; 11-09: without it Plex listed each film twice).
 *   It stays in the sidebar as it is. Off separates them again.
 * - collection-add: put one movie (or show) in a library's collection by name, creating the
 *   collection with it when there is none yet; read back from the collection's members.
 * - collection-remove: take one title out of a collection (the title stays in the library).
 * - collection-delete: delete one collection (its titles stay in the library).
 * - collection-rename: give a collection (and so its Home row) a new name, locked so Plex keeps it;
 *   a Home row Hearth made keeps the new name too.
 * - home-row-apply, home-row-undo: a Home Rows row on Plex (home-rows.ts): its smart collection,
 *   placed and positioned, and putting the library's rows back as they were.
 * - home-layout-apply, home-layout-undo: switch the home screen to a saved one (every library's
 *   rows, their places and order), and put the last one back.
 * - home-collection-row: a collection that is not a row yet becomes one, first on Home (the
 *   collection itself is not changed); taken away again if Plex refuses partway.
 * Plans record what they start from; a plan whose starting point changed is refused as stale, so a
 * retried plan never applies twice.
 */

export const PLEX_OPS = [
  "scan-all",
  "scan-library",
  "watched",
  "unwatched",
  "rate",
  "refresh-item",
  "edit-item",
  "empty-trash",
  "clean-bundles",
  "optimize-db",
  "run-task",
  "stop-task",
  "set-settings",
  "set-rows",
  "merge-recent",
  "merge-released",
  "move-released",
  "merge-dates",
  "digital-dates",
  "collection-add",
  "collection-remove",
  "collection-delete",
  "collection-rename",
  "home-row-apply",
  "home-row-undo",
  "home-layout-apply",
  "home-layout-undo",
  "home-collection-row",
] as const;
type Op = (typeof PLEX_OPS)[number];

interface Section {
  key: string;
  title: string;
}

/** Plex's numbers for item types, used when editing. */
const TYPE_NUMBER: Record<string, number> = { movie: 1, show: 2, season: 3, episode: 4 };
const EDITABLE = ["title", "sortTitle", "summary", "year"] as const;
type Editable = (typeof EDITABLE)[number];
const FIELD: Record<Editable, string> = {
  title: "title",
  sortTitle: "titleSort",
  summary: "summary",
  year: "year",
};

interface Setting {
  id: string;
  label?: string;
  type?: string;
  value?: unknown;
  hidden?: boolean;
  group?: string;
  enumValues?: string;
}

interface Flags {
  recommended: boolean;
  home: boolean;
  shared: boolean;
}

/** A name's possessive: Movies', New Release's. */
const names = (n: string[]) =>
  n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
const poss = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

const show = (v: unknown) =>
  v === true ? "on" : v === false ? "off" : v === "" || v === undefined ? "(empty)" : String(v);

/** How long a folder change may take on a busy Plex. */
const FOLDER_WAIT_MS = 90_000;

export class PlexOperations {
  private readonly rows: HomeRows;
  /** How long to wait between read-backs while Plex catches up (tests set it to 0). */
  settleMs = 500;
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {
    this.rows = new HomeRows(handle, broker, fetchImpl);
    this.carry = new PlexCarry(handle, broker, fetchImpl);
    this.carry.resume();
    this.digital = new PlexDigitalDates(handle, broker, fetchImpl);
    this.digital.resume();
  }

  /** Recently Released by home release, as a switch (plex-digital.ts). */
  readonly digital: PlexDigitalDates;

  /** The owner's own rows and added dates, brought along after a merge (plex-carry.ts). */
  readonly carry: PlexCarry;

  /** The approval's lines for the rows brought along, and the note on added dates. */
  private static carryLines(rows: CarryRow[], fromTitle: (lib: string) => string, into: string) {
    return rows.map((c) => ({
      name: c.title,
      before: `${placesOf(c.code)}, from ${fromTitle(c.lib)}`,
      after: `${placesOf(c.code)}, from ${into} (made again there)`,
    }));
  }

  private static carryNote(into: string, rows: CarryRow[], what: string) {
    return [
      `Plex lists the ${what} new to ${into} as added today. As it scans them in, Hearth gives each its own added date back, so Recently Added does not fill with old ${what}.`,
      ...(rows.length
        ? [
            `Your own rows (${names(rows.map((r) => r.title))}) are made again in ${into} with the same ${what}, places and order once Plex has scanned them in, usually minutes, longer for a big library.`,
          ]
        : []),
    ];
  }

  /** After a merge: the owner's rows and the added dates brought along (plex-carry.ts). */
  private async carryAfter(
    p: StepParams,
    service: { id: string; localUrl: string },
    into: { id: string; title: string },
    folded: boolean,
  ) {
    const rows = JSON.parse(String(p.carry ?? "[]")) as CarryRow[];
    if (!folded && !rows.length) return "";
    const sources = String(p.sources ?? "")
      .split(",")
      .filter((x) => /^\d+$/.test(x));
    if (!sources.length) return "";
    const pass = await this.carry.start({
      serviceId: service.id,
      url: service.localUrl,
      into: into.id,
      intoTitle: into.title,
      type: Number(p.type) === 2 ? 2 : 1,
      sources,
      rows,
    });
    return PlexOperations.carrySaid(pass, rows, into.title);
  }

  /** What the carry did on the first pass, for the step's result. */
  private static carrySaid(pass: CarryPass, rows: CarryRow[], into: string) {
    const parts: string[] = [];
    if (pass.dated) parts.push(`${pass.dated} added dates put back`);
    if (pass.made.length) parts.push(`${names(pass.made)} made in ${into}`);
    const left = rows.filter((r) => !pass.made.includes(r.title)).map((r) => r.title);
    const later = pass.done
      ? ""
      : ` Hearth finishes the rest${left.length ? ` (${names(left)})` : ""} and the remaining dates once Plex has scanned ${into}.`;
    return `${parts.length ? ` ${parts.join("; ")}.` : ""}${later}`;
  }

  private async req(base: string, token: string, path: string, method = "GET", waitMs?: number) {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(joinUrl(base, path), {
        method,
        headers: { Accept: "application/json", "X-Plex-Token": token },
        signal: AbortSignal.timeout(waitMs ?? TIMEOUT_MS * 2),
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

  private async sections(base: string, token: string): Promise<Section[]> {
    const body = await this.json<{
      MediaContainer?: { Directory?: { key?: string; title?: string }[] };
    }>(base, token, "/library/sections");
    return (body.MediaContainer?.Directory ?? [])
      .filter((d) => d.key)
      .map((d) => ({ key: String(d.key), title: d.title ?? `Library ${d.key}` }));
  }

  /** A library as Plex lists it, with what editing it needs (agent, scanner) and its folders. */
  private async library(base: string, token: string, id: string) {
    return (await this.libraries(base, token)).find((l) => l.id === id);
  }

  /** Every library as Plex lists it, with its folders. */
  private async libraries(base: string, token: string) {
    const body = await this.json<{
      MediaContainer?: {
        Directory?: {
          key?: string;
          title?: string;
          type?: string;
          agent?: string;
          scanner?: string;
          language?: string;
          Location?: { path?: string }[];
        }[];
      };
    }>(base, token, "/library/sections");
    return (body.MediaContainer?.Directory ?? [])
      .filter((d) => d.key !== undefined)
      .map((d) => {
        const id = String(d.key);
        return {
          id,
          title: d.title ?? `Library ${id}`,
          type: d.type ?? "",
          agent: d.agent ?? "",
          scanner: d.scanner ?? "",
          language: d.language ?? "",
          folders: (d.Location ?? []).map((l) => l.path ?? "").filter(Boolean),
        };
      });
  }

  /**
   * A library's Visibility (Plex's setting "hidden", in Edit Library > Advanced): 0 on Home and in
   * search, 1 left off Home, 2 left off Home and out of search. Named as in Plex's own settings list.
   */
  private async visibility(base: string, token: string, id: string) {
    const r = await this.json<{
      MediaContainer?: { Setting?: { id?: string; value?: string | number }[] };
    }>(base, token, `/library/sections/${encodeURIComponent(id)}/prefs`);
    const v = r.MediaContainer?.Setting?.find((x) => x.id === "hidden")?.value;
    return v === undefined ? "0" : String(v);
  }

  private async setVisibility(base: string, token: string, id: string, value: string) {
    const r = await this.req(
      base,
      token,
      `/library/sections/${encodeURIComponent(id)}/prefs?hidden=${encodeURIComponent(value)}`,
      "PUT",
    );
    return r.ok ? undefined : r.status;
  }

  /** Sets a library's folders, keeping its name, agent, scanner and language. */
  private async setFolders(
    base: string,
    token: string,
    lib: { id: string; title: string; agent: string; scanner: string; language: string },
    folders: string[],
  ) {
    const q = new URLSearchParams({
      name: lib.title,
      agent: lib.agent,
      scanner: lib.scanner,
      language: lib.language,
    });
    for (const f of folders) q.append("location", f);
    const r = await this.req(
      base,
      token,
      `/library/sections/${encodeURIComponent(lib.id)}?${q.toString()}`,
      "PUT",
      // A busy Plex (scanning) can take a while to answer a folder change (11-10).
      FOLDER_WAIT_MS,
    );
    return r.ok ? undefined : r.status;
  }

  /**
   * A scan Plex is running on one of these libraries, if any (its own Activities). Changing a
   * library's folders mid-scan made the owner's Plex stop answering (11-10).
   */
  private async scanning(base: string, token: string, libs: { id: string; title: string }[]) {
    const r = await this.json<{
      MediaContainer?: {
        Activity?: {
          type?: string;
          title?: string;
          progress?: number;
          Context?: { librarySectionID?: string | number };
        }[];
      };
    }>(base, token, "/activities").catch(() => ({}) as { MediaContainer?: undefined });
    for (const a of r.MediaContainer?.Activity ?? []) {
      if (!/library|scan|refresh/i.test(`${a.type ?? ""} ${a.title ?? ""}`)) continue;
      const lib = libs.find(
        (l) =>
          String(a.Context?.librarySectionID ?? "") === l.id ||
          (Boolean(l.title) && (a.title ?? "").toLowerCase().endsWith(l.title.toLowerCase())),
      );
      if (lib) return { lib: lib.title, progress: a.progress };
    }
    return undefined;
  }

  /** A library's Recently Released and Recently Added rows: what would show twice once merged. */
  private static newRows<T extends { id: string }>(list: T[]) {
    // Real Plex names them without the number ("movie.recentlyadded"); only the numbered form
    // was matched, so combining never moved the owner's rows (11-10).
    return list.filter((h) => /^[a-z]+\.(recentlyreleased|recentlyadded)(\.\d+)?$/.test(h.id));
  }

  private async item(base: string, token: string, id: string): Promise<RawItem | undefined> {
    const res = await this.req(base, token, `/library/metadata/${encodeURIComponent(id)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new AppUnreachableError(`Plex answered ${res.status} for that item.`);
    const body = (await res.json().catch(() => ({}))) as {
      MediaContainer?: { Metadata?: RawItem[] };
    };
    return body.MediaContainer?.Metadata?.[0];
  }

  /** The library's collections (Plex keeps them as items of the library). */
  private async collections(base: string, token: string, section: string) {
    const r = await this.json<{
      MediaContainer?: { Metadata?: { ratingKey?: string; title?: string; childCount?: number }[] };
    }>(base, token, `/library/sections/${encodeURIComponent(section)}/collections`);
    return (r.MediaContainer?.Metadata ?? [])
      .filter((c) => c.ratingKey)
      .map((c) => ({ key: String(c.ratingKey), title: c.title ?? "", count: c.childCount ?? 0 }));
  }

  /** The ratingKeys in a collection, read from Plex. */
  private async members(base: string, token: string, key: string) {
    const r = await this.json<{ MediaContainer?: { Metadata?: { ratingKey?: string }[] } }>(
      base,
      token,
      `/library/collections/${encodeURIComponent(key)}/children`,
    );
    return (r.MediaContainer?.Metadata ?? []).map((m) => String(m.ratingKey));
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

  private async tasks(base: string, token: string) {
    const b = await this.json<{
      ButlerTasks?: { ButlerTask?: { name: string; title?: string }[] };
    }>(base, token, "/butler");
    return b.ButlerTasks?.ButlerTask ?? [];
  }

  private async hubs(base: string, token: string, section: string) {
    const r = await this.json<{ MediaContainer?: { Hub?: RawHub[] } }>(
      base,
      token,
      `/hubs/sections/${encodeURIComponent(section)}/manage`,
    );
    return (r.MediaContainer?.Hub ?? []).filter((h) => h.identifier).map(hubOf);
  }

  private async merged(base: string, token: string) {
    const list = await this.settings(base, token);
    const s = list.find((x) => x.id === "MergedRecentlyAdded");
    if (!s) return undefined;
    return s.value === true || s.value === "1" || s.value === 1;
  }

  private async settings(base: string, token: string): Promise<Setting[]> {
    const r = await this.json<{ MediaContainer?: { Setting?: Setting[] } }>(
      base,
      token,
      "/:/prefs",
    );
    return r.MediaContainer?.Setting ?? [];
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

  /** The item's current values for the fields an edit changes, as text. */
  private static current(m: RawItem): Record<Editable, string> {
    return {
      title: m.title ?? "",
      sortTitle: m.titleSort ?? m.title ?? "",
      summary: m.summary ?? "",
      year: m.year !== undefined ? String(m.year) : "",
    };
  }

  private static nameOf(m: RawItem) {
    if (m.type === "episode" && m.grandparentTitle)
      return `${m.grandparentTitle} S${String(m.parentIndex ?? 0).padStart(2, "0")}E${String(m.index ?? 0).padStart(2, "0")}`;
    if (m.type === "season" && m.parentTitle) return `${m.parentTitle}, ${m.title ?? "a season"}`;
    return m.title ?? "that title";
  }

  /** A row's three places as one code: r, h, s for each place it shows. */
  private static code(h: Flags) {
    return `${h.recommended ? "r" : "-"}${h.home ? "h" : "-"}${h.shared ? "s" : "-"}`;
  }

  /** The rows asked to change, and the order asked for, checked against what Plex lists. */
  private static rowsWanted(
    params: StepParams | undefined,
    now: (Flags & { id: string; title: string })[],
  ) {
    let asked: Record<string, Partial<Flags>>;
    let order: string[] | undefined;
    try {
      asked = JSON.parse(String(params?.rows ?? "{}")) as Record<string, Partial<Flags>>;
      order = params?.order ? (JSON.parse(String(params.order)) as string[]) : undefined;
    } catch {
      throw new Error(
        "rows must be JSON of row ids to {recommended, home, shared}; order a JSON list of row ids.",
      );
    }
    const flags: { row: (typeof now)[number]; to: Flags }[] = [];
    for (const [id, want] of Object.entries(asked)) {
      const row = now.find((h) => h.id === id);
      if (!row) throw new Error(`Plex has no row ${id} in that library.`);
      const to: Flags = {
        recommended: want.recommended ?? row.recommended,
        home: want.home ?? row.home,
        shared: want.shared ?? row.shared,
      };
      if (PlexOperations.code(to) !== PlexOperations.code(row)) flags.push({ row, to });
    }
    if (order) {
      const ids = now.map((h) => h.id);
      if (
        !Array.isArray(order) ||
        order.length !== ids.length ||
        new Set(order).size !== ids.length ||
        order.some((id) => !ids.includes(id))
      )
        throw new Error("order must list every row of the library once.");
      if (order.every((id, i) => id === ids[i])) order = undefined;
    }
    return { flags, order };
  }

  /** Settings asked for, checked against what Plex lists and what Hearth may change. */
  private static wanted(params: StepParams | undefined, list: Setting[]) {
    let asked: Record<string, unknown>;
    try {
      asked = JSON.parse(String(params?.preferences ?? "{}")) as Record<string, unknown>;
    } catch {
      throw new Error("preferences must be JSON of setting ids and their new values.");
    }
    const entries = Object.entries(asked);
    if (!entries.length) throw new Error("Say which settings to change.");
    return entries.map(([id, raw]) => {
      const s = list.find((x) => x.id === id);
      if (!s || s.hidden || !s.label) throw new Error(`Plex has no setting called ${id}.`);
      if (plexSettingLocked({ id, group: s.group }))
        throw new Error(
          `${s.label} is networking, remote access or a credential: change it in Plex itself.`,
        );
      let value: string | boolean | number;
      if (s.type === "bool") value = raw === true || raw === "true" || raw === 1 || raw === "1";
      else if (s.type === "int" || s.type === "double") {
        value = Number(raw);
        if (!Number.isFinite(value)) throw new Error(`${s.label} takes a number.`);
      } else value = String(raw ?? "").slice(0, 500);
      if (s.enumValues) {
        const allowed = s.enumValues.split("|").map((o) => o.split(":")[0]);
        if (!allowed.includes(String(value)))
          throw new Error(`${s.label} takes one of: ${allowed.join(", ")}.`);
      }
      return { setting: s, value };
    });
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!PLEX_OPS.includes(op)) throw new Error(`Say what to do: ${PLEX_OPS.join(", ")}.`);
    if (op === "home-row-apply" || op === "home-row-undo")
      return this.rows.plan(op, service, params, base);
    if (op === "home-layout-apply" || op === "home-layout-undo")
      return this.rows.planLayout(op, service, params, base);
    if (op === "home-collection-row") return this.rows.planCollection(service, params, base);
    const out = (
      label: string,
      p: Record<string, string>,
      settings: { name: string; before: string; after: string }[],
      warnings?: string[],
    ): PlannedStep => ({
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...p },
      change: {
        summary: label,
        // A warning shows in the approval as a Note row, as the other panels do.
        settings: [
          ...settings,
          ...(warnings ?? []).map((w) => ({ name: "Note", before: "", after: w })),
        ],
      },
    });
    return this.use(service, `read Plex to plan ${op}`, "read", async (t) => {
      const url = service.localUrl;
      if (op === "scan-all" || op === "scan-library" || op === "empty-trash") {
        const libs = await this.sections(url, t);
        if (!libs.length) throw new Error(`${service.name} has no libraries.`);
        if (op === "scan-all") {
          const label = `Scan all ${libs.length} ${libs.length === 1 ? "library" : "libraries"} in ${service.name} for new and changed files`;
          return out(label, {}, [{ name: "Libraries", before: "as it is", after: op }]);
        }
        const l = libs.find((x) => x.key === String(params?.libraryId ?? ""));
        if (!l) throw new Error("Plex does not have that library.");
        if (op === "scan-library")
          return out(
            `Scan the ${l.title} library in ${service.name}`,
            { libraryId: l.key, name: l.title },
            [{ name: l.title, before: "as it is", after: op }],
          );
        return out(
          `Empty the ${l.title} library's trash in ${service.name}`,
          { libraryId: l.key, name: l.title },
          [
            {
              name: l.title,
              before: "entries for files gone from disk",
              after: "those entries removed (files on disk are not touched)",
            },
          ],
          ["Watched state and edits of those missing titles go with them."],
        );
      }
      if (op === "clean-bundles" || op === "optimize-db") {
        const what = op === "clean-bundles" ? "Clean bundles" : "Optimize the database";
        return out(`${what} in ${service.name}`, {}, [
          {
            name: what,
            before: "as it is",
            after:
              op === "clean-bundles"
                ? "unused artwork and metadata bundles removed"
                : "database compacted and reindexed",
          },
        ]);
      }
      if (op === "run-task" || op === "stop-task") {
        const name = String(params?.taskId ?? "");
        const task = (await this.tasks(url, t)).find((x) => x.name === name);
        if (!task) throw new Error("Plex has no task by that name.");
        const title = task.title ?? task.name;
        return out(
          `${op === "run-task" ? "Run" : "Stop"} ${title} in ${service.name} now`,
          { taskId: task.name, name: title },
          [
            {
              name: title,
              before: op === "run-task" ? "on its schedule" : "running",
              after: op === "run-task" ? "running now" : "stopped",
            },
          ],
        );
      }
      if (op === "set-rows") {
        const libs = await this.sections(url, t);
        const l = libs.find((x) => x.key === String(params?.libraryId ?? ""));
        if (!l) throw new Error("Plex does not have that library.");
        const now = await this.hubs(url, t, l.key);
        if (!now.length) throw new Error(`Plex lists no rows for ${l.title}.`);
        const plan = PlexOperations.rowsWanted(params, now);
        if (!plan.flags.length && !plan.order)
          throw new Error("Those rows already show that way, in that order.");
        const where = (h: Flags) =>
          [h.recommended && "Library Recommended", h.home && "Home", h.shared && "Friends' Home"]
            .filter(Boolean)
            .join(", ") || "Hidden";
        const settings = plan.flags.map(({ row, to }) => ({
          name: row.title,
          before: where(row),
          after: where(to),
        }));
        if (plan.order) {
          const moved = plan.order
            .map((id, i) => ({ id, i, was: now.findIndex((h) => h.id === id) }))
            .filter((x) => x.i !== x.was);
          settings.push({
            name: "Order",
            before: `${moved.length} ${moved.length === 1 ? "row" : "rows"} as they are`,
            after: moved
              .slice(0, 8)
              .map((x) => `${now[x.was]!.title} to position ${x.i + 1}`)
              .join("; ")
              .concat(moved.length > 8 ? `; and ${moved.length - 8} more` : ""),
          });
        }
        const n = plan.flags.length;
        return out(
          `Change ${n && plan.order ? `${n} ${n === 1 ? "row" : "rows"} and the order` : n ? `where ${n} ${n === 1 ? "row shows" : "rows show"}` : "the order of the rows"} in ${l.title} in ${service.name}`,
          {
            libraryId: l.key,
            name: l.title,
            rows: JSON.stringify(
              Object.fromEntries(
                plan.flags.map(({ row, to }) => [
                  row.id,
                  { recommended: to.recommended, home: to.home, shared: to.shared },
                ]),
              ),
            ),
            ...(plan.order ? { order: JSON.stringify(plan.order) } : {}),
            from: JSON.stringify(now.map((h) => `${h.id}:${PlexOperations.code(h)}`)),
          },
          settings,
        );
      }
      if (op === "merge-recent") {
        const on = params?.on === true || params?.on === "true" || params?.on === "1";
        const was = await this.merged(url, t);
        if (was === undefined) throw new Error("This Plex has no Merge Recently Added setting.");
        if (was === on)
          throw new Error(`Merge Recently Added Items is already ${on ? "on" : "off"}.`);
        return out(
          `Turn ${on ? "on" : "off"} Merge Recently Added Items in ${service.name}`,
          { on: on ? "1" : "0", from: was ? "1" : "0" },
          [
            {
              name: "Merge Recently Added Items",
              before: was ? "on" : "off",
              after: on ? "on" : "off",
            },
          ],
          on
            ? [
                "Recently added from libraries of the same type show as one row on Home (only libraries pinned in the app's sidebar).",
              ]
            : undefined,
        );
      }
      if (op === "merge-released") {
        const on = params?.on !== false && params?.on !== "false" && params?.on !== "0";
        const into = await this.library(url, t, String(params?.intoId ?? ""));
        const from = await this.library(url, t, String(params?.fromId ?? ""));
        if (!into || !from) throw new Error("Say which two libraries (intoId, fromId).");
        if (into.id === from.id) throw new Error("Choose two different libraries.");
        if (into.type !== from.type || (into.type !== "movie" && into.type !== "show"))
          throw new Error("Both libraries must be movies, or both shows.");
        if (!from.folders.length) throw new Error(`Plex lists no folders for ${from.title}.`);
        const has = from.folders.every((f) => into.folders.includes(f));
        const vis = await this.visibility(url, t, from.id);
        // Combined means both: the folders are in, and the other library is off Home and search.
        // A combine from before 11-09 (folders only) shows every title twice: on finishes it.
        // The rows that show both: if they're off Home (11-10: the owner's Movies had both off from
        // an earlier "keep one", so combining left Home with neither), combining puts them back.
        const intoRows = on
          ? PlexOperations.newRows(await this.hubs(url, t, into.id)).filter((h) => !h.home)
          : [];
        if (on && has && vis === "2" && !intoRows.length)
          throw new Error(`${from.title} and ${into.title} are combined on Home already.`);
        if (!on && !has) throw new Error(`${from.title} is not combined with ${into.title}.`);
        const after = on
          ? [...into.folders, ...from.folders.filter((f) => !into.folders.includes(f))]
          : into.folders.filter((f) => !from.folders.includes(f));
        if (!after.length) throw new Error(`${into.title} would have no folders left.`);
        const hidden = on ? "2" : vis === "2" ? "0" : vis;
        // Combining takes every one of the other library's new-title rows off Home. Once it is
        // sidebar-only, Plex reports its rows as off Home even when they are on (seen on the
        // owner's Plex 11-10: they stayed on and every new film showed twice), so all of them go.
        const rows = PlexOperations.newRows(await this.hubs(url, t, from.id)).filter(
          (h) => on || !h.home,
        );
        const what = into.type === "show" ? "shows" : "films";
        const one = what === "films" ? "film" : "show";
        const carry =
          on && vis !== "2" ? rowsToCarry(from.id, await this.hubs(url, t, from.id)) : [];
        const shown = (v: string) =>
          v === "2"
            ? "Sidebar only (not on Home or in search)"
            : v === "1"
              ? "Sidebar and search (not on Home)"
              : "Sidebar, Home and search";
        const fourK = [into.title, from.title].some((x) => /\b(4k|uhd|2160p?)\b/i.test(x));
        return out(
          on
            ? `Combine ${from.title} with ${into.title} on Home in ${service.name}`
            : `Separate ${from.title} from ${into.title} again in ${service.name}`,
          {
            on: on ? "1" : "0",
            intoId: into.id,
            fromId: from.id,
            name: into.title,
            fromName: from.title,
            folders: JSON.stringify(after),
            before: JSON.stringify(into.folders),
            hidden,
            hiddenFrom: vis,
            intoRows: JSON.stringify(intoRows.map((h) => h.id)),
            intoRowsFrom: JSON.stringify(intoRows.map((h) => `${h.id}:${PlexOperations.code(h)}`)),
            rows: JSON.stringify(rows.map((h) => h.id)),
            rowsFrom: JSON.stringify(rows.map((h) => `${h.id}:${PlexOperations.code(h)}`)),
            carry: JSON.stringify(carry),
            sources: from.id,
            type: into.type === "show" ? "2" : "1",
          },
          [
            ...(after.join("|") !== into.folders.join("|")
              ? [
                  {
                    name: `Folders ${into.title} reads`,
                    before: into.folders.join(", "),
                    after: after.join(", "),
                  },
                ]
              : []),
            ...(hidden !== vis
              ? [{ name: `Where ${from.title} shows`, before: shown(vis), after: shown(hidden) }]
              : []),
            ...rows.map((h) => ({
              name: `${from.title}: ${h.title}`,
              before: on ? "on Home" : "off Home",
              after: on ? "off Home" : "on Home",
            })),
            ...intoRows.map((h) => ({
              name: `${into.title}: ${h.title}`,
              before: "off Home",
              after: "on Home",
            })),
            ...PlexOperations.carryLines(carry, () => from.title, into.title),
          ],
          on
            ? [
                `${poss(into.title)} Recently Added and Recently Released rows will also show ${poss(from.title)} ${what}, each ${one} once.`,
                `${from.title} stays in your sidebar and opens as it does now. It is left off Home and out of search, so no ${one} shows twice. No file moves.`,
                ...(fourK
                  ? [
                      `When a ${one} is in both, Plex keeps one entry with two versions and picks one per player, so friends streaming from outside your home may be offered the 4K copy. Keep 4K separate if that matters.`,
                    ]
                  : []),
                ...(after.join("|") !== into.folders.join("|") || carry.length
                  ? PlexOperations.carryNote(into.title, carry, what)
                  : []),
              ]
            : [
                `${poss(from.title)} ${what} leave ${poss(into.title)} rows. ${from.title} is back on Home and in search, with its own rows. No file moves.`,
              ],
        );
      }
      if (op === "digital-dates") {
        const on = params?.on === true || params?.on === "true" || params?.on === "1";
        if ((await this.digital.isOn(service.id)) === on)
          throw new Error(`Recently Released by home release is already ${on ? "on" : "off"}.`);
        const p = await this.digital.preview(service, on);
        return out(
          on
            ? `Sort Recently Released by home release in ${service.name}`
            : `Sort Recently Released by release date again in ${service.name}`,
          { on: on ? "1" : "0" },
          [
            {
              name: "Recently Released goes by",
              before: on ? "each film's first release (theaters count)" : "home release",
              after: on ? "home release (digital, else disc)" : "each film's first release",
            },
            {
              name: on ? "Films given their home release date" : "Films given their date back",
              before: "",
              after: String(p.changes),
            },
            ...p.examples.map((e) => ({ name: e.title, before: e.from, after: e.to })),
          ],
          on
            ? [
                "Plex has no setting for this, so each film's release date in Plex becomes the day it came out at home (Radarr's digital release, else its disc release), locked so a Plex refresh keeps it. Films Radarr has no home date for keep theirs. Plex shows that date on the film's page too.",
                "New films get theirs as they arrive, checked every few hours. Turning it off puts every date back as it was.",
              ]
            : ["Every release date Hearth changed goes back as it was, unlocked."],
        );
      }
      if (op === "merge-dates") {
        // A merge made before 11-13 left every film it brought in dated the day of the merge
        // (the owner's Movies: 81 films "added 11-10 20:17", so Recently Added was out of order).
        const into = await this.library(url, t, String(params?.intoId ?? ""));
        const fromIds = String(params?.fromIds ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter((x) => /^\d+$/.test(x) && x !== into?.id);
        if (!into || !fromIds.length)
          throw new Error(
            "Say which library shows the merged rows (intoId) and the others (fromIds).",
          );
        const froms = [];
        for (const id of fromIds) {
          const l = await this.library(url, t, id);
          if (!l) throw new Error(`Plex has no library ${id}.`);
          froms.push(l);
        }
        const count = await this.carry.lateCount(service, into.id, fromIds);
        if (!count) throw new Error(`Every film in ${into.title} already has its own added date.`);
        const what = into.type === "show" ? "shows" : "films";
        return out(
          `Put back the added dates of ${count} ${what} in ${into.title} in ${service.name}`,
          {
            intoId: into.id,
            name: into.title,
            fromIds: fromIds.join(","),
            type: into.type === "show" ? "2" : "1",
          },
          [
            {
              name: `Added date of ${count} ${what} in ${into.title}`,
              before: "the day they were merged in",
              after: `the day they were added to ${names(froms.map((l) => l.title))}`,
            },
          ],
          [
            `Recently Added in ${into.title} then lists them in the order you really added them. Only the dates change; nothing else in Plex.`,
          ],
        );
      }
      if (op === "move-released") {
        // Which library a merge shows under, changed in one step (11-11, the owner: "fix it so it
        // can toggle back and forth"). Separating then combining again is two folder changes to
        // one library, and Plex scans after each, so the second was refused. Here each library's
        // folders change once: the new one reads every merged library's folders, the old one only
        // its own.
        const libs = await this.libraries(url, t);
        const into = libs.find((l) => l.id === String(params?.intoId ?? ""));
        const from = libs.find((l) => l.id === String(params?.fromId ?? ""));
        if (!into || !from) throw new Error("Say which two libraries (intoId, fromId).");
        if (into.id === from.id) throw new Error("Choose two different libraries.");
        if (into.type !== from.type || (into.type !== "movie" && into.type !== "show"))
          throw new Error("Both libraries must be movies, or both shows.");
        const kind = libs.filter((l) => l.type === into.type);
        const vis = new Map<string, string>();
        for (const l of kind) vis.set(l.id, await this.visibility(url, t, l.id));
        // Merged into the old one now: sidebar only, and every folder already in it.
        const members = kind.filter(
          (l) =>
            l.id !== from.id &&
            vis.get(l.id) === "2" &&
            l.folders.length > 0 &&
            l.folders.every((f) => from.folders.includes(f)),
        );
        // The new one may be merged in already (switching back and forth) or newly picked.
        if (!members.length) throw new Error(`${from.title} has no merged libraries to move.`);
        const withIds = [
          ...new Set(
            String(params?.withIds ?? "")
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ];
        const joined = withIds.map((id) => kind.find((l) => l.id === id));
        if (!joined.length || joined.some((l) => !l || l.id === into.id))
          throw new Error(`Say which libraries share ${poss(into.title)} rows (withIds).`);
        const shared = new Set(members.flatMap((m) => m.folders));
        const ownFrom = from.folders.filter((f) => !shared.has(f));
        if (!ownFrom.length) throw new Error(`${from.title} would have no folders left.`);
        const own = (l: { id: string; folders: string[] }) =>
          l.id === from.id ? ownFrom : l.folders;
        const intoAfter = [...new Set([...into.folders, ...joined.flatMap((l) => own(l!))])];
        const joinIds = new Set(withIds);
        const affected = [
          ...new Map(
            [into, from, ...members, ...joined.map((l) => l!)].map((l) => [l.id, l]),
          ).values(),
        ];
        // Where each library shows afterwards: the new one on Home, the merged ones sidebar only,
        // a library that leaves the merge back on Home.
        const visAfter = new Map<string, string>();
        for (const l of affected) {
          const now = vis.get(l.id) ?? "0";
          const want = l.id === into.id ? "0" : joinIds.has(l.id) ? "2" : now === "2" ? "0" : now;
          if (want !== now) visAfter.set(l.id, want);
        }
        // Their Recently Added and Recently Released rows: on Home for the libraries that show
        // rows, off for the merged ones (sidebar only, Plex may report them off when they are on).
        const rows: { lib: string; id: string; title: string; home: boolean; was: string }[] = [];
        for (const l of affected) {
          const home = !joinIds.has(l.id);
          for (const h of PlexOperations.newRows(await this.hubs(url, t, l.id)))
            if (!home || !h.home)
              rows.push({
                lib: l.id,
                id: h.id,
                title: `${l.title}: ${h.title}`,
                home,
                was: PlexOperations.code(h),
              });
        }
        // The owner's own rows in the libraries leaving Home come along (11-13).
        const carry: CarryRow[] = [];
        for (const l of joined)
          if (l && l.id !== into.id && (vis.get(l.id) ?? "0") !== "2")
            carry.push(...rowsToCarry(l.id, await this.hubs(url, t, l.id)));
        const shown = (v: string) =>
          v === "2"
            ? "Sidebar only (not on Home or in search)"
            : v === "1"
              ? "Sidebar and search (not on Home)"
              : "Sidebar, Home and search";
        const titles = joined.map((l) => l!.title);
        const what = into.type === "show" ? "shows" : "films";
        return out(
          `Show the merged ${into.type === "show" ? "shows" : "films"} under ${into.title} instead of ${from.title} in ${service.name}`,
          {
            intoId: into.id,
            fromId: from.id,
            name: into.title,
            fromName: from.title,
            withIds: withIds.join(","),
            folders: JSON.stringify(intoAfter),
            before: JSON.stringify(into.folders),
            fromFolders: JSON.stringify(ownFrom),
            fromBefore: JSON.stringify(from.folders),
            vis: JSON.stringify(Object.fromEntries(visAfter)),
            visFrom: JSON.stringify(
              Object.fromEntries(affected.map((l) => [l.id, vis.get(l.id) ?? "0"])),
            ),
            rows: JSON.stringify(rows.map((r) => ({ lib: r.lib, id: r.id, home: r.home }))),
            rowsFrom: JSON.stringify(rows.map((r) => `${r.lib}|${r.id}:${r.was}`)),
            carry: JSON.stringify(carry),
            sources: joined.map((l) => l!.id).join(","),
            type: into.type === "show" ? "2" : "1",
          },
          [
            {
              name: `Folders ${into.title} reads`,
              before: into.folders.join(", "),
              after: intoAfter.join(", "),
            },
            {
              name: `Folders ${from.title} reads`,
              before: from.folders.join(", "),
              after: ownFrom.join(", "),
            },
            ...[...visAfter].map(([id, v]) => ({
              name: `Where ${affected.find((l) => l.id === id)!.title} shows`,
              before: shown(vis.get(id) ?? "0"),
              after: shown(v),
            })),
            ...rows.map((r) => ({
              name: r.title,
              before: r.home ? "off Home" : "on Home",
              after: r.home ? "on Home" : "off Home",
            })),
            ...PlexOperations.carryLines(
              carry,
              (id) => kind.find((l) => l.id === id)?.title ?? id,
              into.title,
            ),
          ],
          [
            `${poss(into.title)} Recently Added and Recently Released rows will show ${names([into.title, ...titles])} together, each title once.`,
            `${names(titles)} ${titles.length === 1 ? "stays" : "stay"} in your sidebar and ${titles.length === 1 ? "opens" : "open"} as now, off Home and out of search. No file moves.`,
            ...PlexOperations.carryNote(into.title, carry, what),
          ],
        );
      }
      if (op === "set-settings") {
        const changes = PlexOperations.wanted(params, await this.settings(url, t)).filter(
          (c) => show(c.setting.value) !== show(c.value),
        );
        if (!changes.length) throw new Error("Those settings already have those values.");
        const label =
          changes.length === 1
            ? `Set ${changes[0]!.setting.label} in ${service.name}`
            : `Change ${changes.length} settings in ${service.name}`;
        return out(
          label,
          {
            preferences: JSON.stringify(
              Object.fromEntries(changes.map((c) => [c.setting.id, c.value])),
            ),
            from: JSON.stringify(
              Object.fromEntries(changes.map((c) => [c.setting.id, show(c.setting.value)])),
            ),
          },
          changes.map((c) => ({
            name: c.setting.label!,
            before: show(c.setting.value),
            after: show(c.value),
          })),
        );
      }
      if (op === "collection-rename") {
        const key = String(params?.collectionKey ?? "");
        const title = String(params?.collection ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
        if (!title) throw new Error("Say the new name (params.collection).");
        let found: { key: string; title: string; lib: string } | undefined;
        for (const l of await this.sections(url, t)) {
          const c = (await this.collections(url, t, l.key)).find((x) => x.key === key);
          if (c) found = { key: c.key, title: c.title, lib: l.title };
        }
        if (!found) throw new Error("Plex has no collection with that key.");
        if (found.title === title) throw new Error("That is its name already.");
        return out(
          `Rename “${found.title}” to “${title}” in ${found.lib} in ${service.name}`,
          { collectionKey: key, name: found.title, title, from: found.title },
          [{ name: "Name", before: found.title, after: title }],
        );
      }
      if (op === "collection-delete") {
        const key = String(params?.collectionKey ?? "");
        const libs = await this.sections(url, t);
        let found: { key: string; title: string; count: number; lib: string } | undefined;
        for (const l of libs) {
          const c = (await this.collections(url, t, l.key)).find((x) => x.key === key);
          if (c) found = { ...c, lib: l.title };
        }
        if (!found) throw new Error("Plex has no collection with that key.");
        return out(
          `Delete the collection “${found.title}” in ${found.lib} in ${service.name}`,
          { collectionKey: key, name: found.title, count: String(found.count) },
          [
            {
              name: `“${found.title}”`,
              before: `${found.count} ${found.count === 1 ? "title" : "titles"}`,
              after: "deleted",
            },
          ],
          ["The titles stay in the library; only the collection goes."],
        );
      }
      if (op === "collection-add" || op === "collection-remove") {
        const id = String(params?.ratingKey ?? "");
        if (!/^\d+$/.test(id)) throw new Error("Say which title (its ratingKey).");
        const m = await this.item(url, t, id);
        if (!m) throw new Error("Plex does not have that title any more.");
        const name = PlexOperations.nameOf(m);
        const section = String(
          (m as { librarySectionID?: number | string }).librarySectionID ?? "",
        );
        const libs = await this.sections(url, t);
        const lib = libs.find((l) => l.key === section);
        if (!lib) throw new Error(`Plex does not say which library ${name} is in.`);
        const title = String(params?.collection ?? "")
          .trim()
          .slice(0, 120);
        if (!title) throw new Error("Say which collection (params.collection, its name).");
        const coll = (await this.collections(url, t, section)).find(
          (c) => c.title.toLowerCase() === title.toLowerCase(),
        );
        const inIt = coll ? (await this.members(url, t, coll.key)).includes(id) : false;
        if (op === "collection-remove") {
          if (!coll) throw new Error(`${lib.title} has no collection “${title}”.`);
          if (!inIt) throw new Error(`${name} is not in “${coll.title}”.`);
          return out(
            `Take ${name} out of “${coll.title}” in ${service.name}`,
            {
              ratingKey: id,
              name,
              collection: coll.title,
              collectionKey: coll.key,
              libraryId: section,
            },
            [{ name, before: `in “${coll.title}”`, after: "not in it (still in the library)" }],
          );
        }
        if (inIt) throw new Error(`${name} is already in “${coll!.title}”.`);
        return out(
          `Add ${name} to “${coll?.title ?? title}” in ${service.name}`,
          {
            ratingKey: id,
            name,
            collection: coll?.title ?? title,
            libraryId: section,
            ...(coll ? { collectionKey: coll.key } : {}),
          },
          [{ name, before: "not in it", after: `in “${coll?.title ?? title}”` }],
          coll
            ? undefined
            : [`${lib.title} has no collection “${title}” yet: the first title added creates it.`],
        );
      }
      // One title.
      const id = String(params?.ratingKey ?? "");
      if (!/^\d+$/.test(id)) throw new Error("Say which title (its ratingKey).");
      const m = await this.item(url, t, id);
      if (!m) throw new Error("Plex does not have that title any more.");
      const name = PlexOperations.nameOf(m);
      if (op === "watched" || op === "unwatched") {
        const now = watchedOf(m);
        if (now === (op === "watched"))
          throw new Error(`${name} is already ${now ? "watched" : "unwatched"}.`);
        return out(
          `Mark ${name} ${op} in ${service.name}`,
          { ratingKey: id, name, from: now ? "watched" : "unwatched" },
          [
            {
              name,
              before: now ? "watched" : "unwatched",
              after: op,
            },
          ],
          m.type === "show" || m.type === "season"
            ? [`Every episode of ${name} is marked ${op}.`]
            : undefined,
        );
      }
      if (op === "rate") {
        const stars = Number(params?.stars);
        if (!Number.isInteger(stars) || stars < 1 || stars > 5)
          throw new Error("A rating is 1 to 5 stars (params.stars).");
        const now = m.userRating;
        const was = now ? `${now / 2} of 5 stars` : "not rated";
        return out(
          `Rate ${name} ${stars} of 5 stars in ${service.name}`,
          { ratingKey: id, name, stars: String(stars), from: now === undefined ? "" : String(now) },
          [{ name, before: was, after: `${stars} of 5 stars` }],
        );
      }
      if (op === "refresh-item")
        return out(`Refresh ${name}'s details in ${service.name}`, { ratingKey: id, name }, [
          { name, before: "as it is", after: "details and artwork read again" },
        ]);
      // edit-item
      let asked: Partial<Record<Editable, unknown>>;
      try {
        asked = JSON.parse(String(params?.body ?? "{}")) as Partial<Record<Editable, unknown>>;
      } catch {
        throw new Error("body must be JSON of the fields to change.");
      }
      if (!TYPE_NUMBER[m.type ?? ""]) throw new Error("Plex cannot edit that kind of item here.");
      const before = PlexOperations.current(m);
      const changes: Partial<Record<Editable, string>> = {};
      for (const f of EDITABLE) {
        if (asked[f] === undefined) continue;
        const v = String(asked[f])
          .slice(0, f === "summary" ? 5000 : 300)
          .trim();
        if (f === "year" && v && !/^\d{4}$/.test(v)) throw new Error("A year is four digits.");
        if (f === "title" && !v) throw new Error("A title cannot be empty.");
        // An empty sort title means sorting by the title, which is how Plex reads it back.
        if (f === "sortTitle" && !v) {
          const t = changes.title ?? before.title;
          if (t !== before.sortTitle) changes.sortTitle = t;
          continue;
        }
        if (v !== before[f]) changes[f] = v;
      }
      const fields = Object.keys(changes) as Editable[];
      if (!fields.length) throw new Error("Nothing would change.");
      const label = `Edit ${name} in ${service.name}`;
      return out(
        label,
        {
          ratingKey: id,
          name,
          type: m.type!,
          body: JSON.stringify(changes),
          from: JSON.stringify(Object.fromEntries(fields.map((f) => [f, before[f]]))),
        },
        fields.map((f) => ({
          name: { title: "Title", sortTitle: "Sort title", summary: "Summary", year: "Year" }[f],
          before: before[f] || "(empty)",
          after: changes[f] || "(empty)",
        })),
        ["Plex keeps these as you set them: a refresh does not change them back."],
      );
    });
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    if (op === "home-row-apply" || op === "home-row-undo") return this.rows.run(step, service);
    if (op === "home-layout-apply" || op === "home-layout-undo")
      return this.rows.runLayout(step, service);
    if (op === "home-collection-row") return this.rows.runCollection(step, service);
    const outcome = await this.use(
      service,
      `${op} in Plex`,
      "change",
      async (token): Promise<StepOutcome> => {
        const base = service.localUrl;
        const name = String(p.name || "that title");
        const send = async (path: string, method: string) => {
          const r = await this.req(base, token, path, method);
          return r.ok ? undefined : r.status;
        };
        if (op === "scan-all" || op === "scan-library") {
          const libs =
            op === "scan-all"
              ? await this.sections(base, token)
              : [{ key: String(p.libraryId), title: String(p.name || "the library") }];
          const failed: string[] = [];
          for (const l of libs) {
            const s = await send(`/library/sections/${encodeURIComponent(l.key)}/refresh`, "GET");
            if (s) failed.push(`${l.title} (${s})`);
          }
          const started = libs.length - failed.length;
          if (!started)
            return { ok: false, result: `Plex refused the scan: ${failed.join(", ")}.` };
          const names = libs
            .filter((l) => !failed.some((f) => f.startsWith(`${l.title} (`)))
            .map((l) => l.title)
            .join(", ");
          return {
            ok: !failed.length,
            result: `Plex is scanning ${names}; new files show up as it finds them.${failed.length ? ` It refused ${failed.join(", ")}.` : ""}`,
          };
        }
        if (op === "empty-trash") {
          const s = await send(
            `/library/sections/${encodeURIComponent(String(p.libraryId))}/emptyTrash`,
            "PUT",
          );
          return s
            ? { ok: false, result: `Plex refused to empty the trash (${s}).` }
            : { ok: true, result: `Plex emptied the ${name} library's trash.` };
        }
        if (op === "clean-bundles" || op === "optimize-db") {
          const s = await send(
            op === "clean-bundles" ? "/library/clean/bundles" : "/library/optimize",
            "PUT",
          );
          const what = op === "clean-bundles" ? "cleaning bundles" : "optimizing its database";
          return s
            ? { ok: false, result: `Plex refused ${what} (${s}).` }
            : { ok: true, result: `Plex started ${what}; it shows under Tasks while it works.` };
        }
        if (op === "run-task" || op === "stop-task") {
          const task = String(p.taskId);
          if (!(await this.tasks(base, token)).some((x) => x.name === task))
            return { ok: false, stale: true, result: `Plex no longer has ${name}. Nothing ran.` };
          const s = await send(
            `/butler/${encodeURIComponent(task)}`,
            op === "run-task" ? "POST" : "DELETE",
          );
          return s
            ? { ok: false, result: `Plex refused (${s}).` }
            : {
                ok: true,
                result:
                  op === "run-task"
                    ? `Plex started ${name}; it shows under Tasks while it works.`
                    : `Plex stopped ${name}.`,
              };
        }
        if (op === "set-rows") {
          const lib = encodeURIComponent(String(p.libraryId));
          const from = JSON.parse(String(p.from ?? "[]")) as string[];
          let now = await this.hubs(base, token, String(p.libraryId));
          if (now.map((h) => `${h.id}:${PlexOperations.code(h)}`).join("|") !== from.join("|"))
            return {
              ok: false,
              stale: true,
              result: `The ${name} library's rows changed since this was planned. Nothing was changed; plan it again.`,
            };
          const rows = JSON.parse(String(p.rows ?? "{}")) as Record<string, Flags>;
          const flag = (v: boolean) => (v ? "1" : "0");
          for (const [id, to] of Object.entries(rows)) {
            const q = new URLSearchParams({
              promotedToRecommended: flag(to.recommended),
              promotedToOwnHome: flag(to.home),
              promotedToSharedHome: flag(to.shared),
            });
            const s = await send(
              `/hubs/sections/${lib}/manage/${encodeURIComponent(id)}?${q.toString()}`,
              "PUT",
            );
            if (s) return { ok: false, result: `Plex refused the change to ${id} (${s}).` };
          }
          const order = p.order ? (JSON.parse(String(p.order)) as string[]) : undefined;
          if (order) {
            // Each row goes after the one before it in the new order; only those out of place move.
            const cur = now.map((h) => h.id);
            for (let i = 0; i < order.length; i++) {
              const id = order[i]!;
              const after = i ? order[i - 1]! : "";
              const at = cur.indexOf(id);
              if ((i === 0 && at === 0) || (i > 0 && cur[at - 1] === after)) continue;
              const s = await send(plexMovePath(lib, id, after), "PUT");
              if (s) return { ok: false, result: `Plex refused moving ${id} (${s}).` };
              cur.splice(at, 1);
              cur.splice(i ? cur.indexOf(after) + 1 : 0, 0, id);
            }
          }
          now = await this.hubs(base, token, String(p.libraryId));
          const off = Object.entries(rows).filter(
            ([id, to]) =>
              PlexOperations.code(now.find((h) => h.id === id) ?? to) !== PlexOperations.code(to) ||
              !now.some((h) => h.id === id),
          );
          const orderOff = order && now.map((h) => h.id).join("|") !== order.join("|");
          if (off.length || orderOff)
            return {
              ok: false,
              result: `Plex accepted, but ${off.length ? `${off.map(([id]) => now.find((h) => h.id === id)?.title ?? id).join(", ")} ${off.length === 1 ? "does" : "do"} not read back as asked` : ""}${off.length && orderOff ? " and " : ""}${orderOff ? "the order does not read back as asked" : ""}.`,
            };
          const n = Object.keys(rows).length;
          return {
            ok: true,
            result: `${name}'s rows are set in Plex${n ? `: ${n} ${n === 1 ? "row" : "rows"} changed` : ""}${order ? `${n ? "," : ":"} new order` : ""} (read back).`,
          };
        }
        if (op === "merge-recent") {
          const was = await this.merged(base, token);
          if (was === undefined || (was ? "1" : "0") !== p.from)
            return {
              ok: false,
              stale: true,
              result:
                "Merge Recently Added Items changed since this was planned. Nothing was changed.",
            };
          const s = await send(`/:/prefs?MergedRecentlyAdded=${p.on === "1" ? "1" : "0"}`, "PUT");
          if (s) return { ok: false, result: `Plex refused (${s}).` };
          const now = await this.merged(base, token);
          return now === (p.on === "1")
            ? {
                ok: true,
                result: `Merge Recently Added Items is ${now ? "on" : "off"} (read back).`,
              }
            : { ok: false, result: "Plex accepted, but the setting does not read back as asked." };
        }
        if (op === "merge-released") {
          const on = p.on === "1";
          const into = await this.library(base, token, String(p.intoId));
          const before = JSON.parse(String(p.before ?? "[]")) as string[];
          const want = JSON.parse(String(p.folders ?? "[]")) as string[];
          const rowIds = JSON.parse(String(p.rows ?? "[]")) as string[];
          const rowsFrom = JSON.parse(String(p.rowsFrom ?? "[]")) as string[];
          const fromLib = String(p.fromId);
          const hidden = String(p.hidden ?? "");
          const intoRowIds = JSON.parse(String(p.intoRows ?? "[]")) as string[];
          const intoRowsFrom = JSON.parse(String(p.intoRowsFrom ?? "[]")) as string[];
          const intoNow = async () =>
            (await this.hubs(base, token, String(p.intoId))).filter((h) =>
              intoRowIds.includes(h.id),
            );
          const hiddenFrom = String(p.hiddenFrom ?? "");
          const hubsNow = async () =>
            (await this.hubs(base, token, fromLib)).filter((h) => rowIds.includes(h.id));
          const rowsNow = (await hubsNow()).map((h) => `${h.id}:${PlexOperations.code(h)}`);
          if (
            !into ||
            into.folders.join("|") !== before.join("|") ||
            rowsNow.sort().join("|") !== [...rowsFrom].sort().join("|") ||
            (await intoNow())
              .map((h) => `${h.id}:${PlexOperations.code(h)}`)
              .sort()
              .join("|") !== [...intoRowsFrom].sort().join("|") ||
            (hidden !== "" && (await this.visibility(base, token, fromLib)) !== hiddenFrom)
          )
            return {
              ok: false,
              stale: true,
              result: `${poss(String(p.name))} folders, rows or Visibility changed since this was planned. Nothing was changed; plan it again.`,
            };
          const moved = want.join("|") !== before.join("|");
          // Plex still scanning from the last change: wait for it, change nothing (11-10).
          const busy = moved
            ? await this.scanning(base, token, [
                { id: into.id, title: into.title },
                { id: fromLib, title: String(p.fromName ?? "") },
              ])
            : undefined;
          if (busy)
            return {
              ok: false,
              result: `Plex is still scanning ${busy.lib}${busy.progress !== undefined ? ` (${Math.round(busy.progress)}%)` : ""} from the last change. Nothing was changed: try again once it finishes, usually a few minutes.`,
            };
          // No answer in time may still mean Plex did it: the read-back below decides.
          const s = moved
            ? await this.setFolders(base, token, into, want).catch((e: unknown) => {
                if (e instanceof AppUnreachableError) return undefined;
                throw e;
              })
            : undefined;
          // Plex answers before the change shows in its library list (seen on the owner's Plex 11-07:
          // a read 2 ms later still had the old folders), so read back for a few seconds.
          const same = (a: string[], b: string[]) =>
            [...a].sort().join("|") === [...b].sort().join("|");
          let back = s ? undefined : await this.library(base, token, into.id);
          for (let i = 0; !s && back && !same(back.folders, want) && i < 20; i++) {
            await new Promise((r) => setTimeout(r, this.settleMs));
            back = await this.library(base, token, into.id);
          }
          if (s || !back || !same(back.folders, want)) {
            if (!s) await this.setFolders(base, token, into, before).catch(() => undefined);
            return {
              ok: false,
              result: s
                ? `Plex refused changing ${poss(into.title)} folders (${s}). Nothing was changed.`
                : `Plex accepted, but ${poss(into.title)} folders do not read back as asked; Hearth put them back.`,
            };
          }
          const fromName = String(p.fromName);
          if (hidden !== "" && hidden !== hiddenFrom) {
            const v = await this.setVisibility(base, token, fromLib, hidden);
            if (v || (await this.visibility(base, token, fromLib)) !== hidden) {
              if (moved) await this.setFolders(base, token, into, before).catch(() => undefined);
              return {
                ok: false,
                result: `Plex ${v ? `refused (${v})` : "did not keep"} the change to where ${fromName} shows${moved ? `, so Hearth put ${poss(into.title)} folders back` : ""}. Nothing else was changed.`,
              };
            }
          }
          const lib = encodeURIComponent(fromLib);
          const failed: string[] = [];
          for (const id of rowIds) {
            const q = new URLSearchParams({
              promotedToOwnHome: on ? "0" : "1",
              ...(on ? { promotedToSharedHome: "0" } : {}),
            });
            const r = await send(
              `/hubs/sections/${lib}/manage/${encodeURIComponent(id)}?${q.toString()}`,
              "PUT",
            );
            if (r) failed.push(id);
          }
          for (const id of intoRowIds) {
            const r = await send(
              `/hubs/sections/${encodeURIComponent(String(p.intoId))}/manage/${encodeURIComponent(id)}?promotedToOwnHome=1`,
              "PUT",
            );
            if (r) failed.push(id);
          }
          const wrong = [
            ...(await hubsNow()).filter((h) => h.home === on).map((h) => h.title),
            ...(await intoNow()).filter((h) => !h.home).map((h) => h.title),
          ];
          if (moved) await send(`/library/sections/${encodeURIComponent(into.id)}/refresh`, "GET");
          if (failed.length || wrong.length)
            return {
              ok: false,
              result: `${poss(into.title)} folders are set (read back), but ${wrong.join(", ") || failed.join(", ")} did not change on Home as planned: change it in Home rows.`,
            };
          const carried = on ? await this.carryAfter(p, service, into, moved) : "";
          return {
            ok: true,
            result: on
              ? `${fromName} and ${into.title} are combined on Home: ${poss(into.title)} rows show both, each title once, and ${fromName} is in the sidebar only (read back).${moved ? ` Plex is scanning ${into.title}.` : ""}${carried}`
              : `${fromName} and ${into.title} are separate again: ${fromName} is back on Home and in search with its own rows (read back).`,
          };
        }
        if (op === "digital-dates") {
          if (p.on === "1") {
            const n = await this.digital.apply(service);
            return {
              ok: true,
              result: `Recently Released now goes by home release: ${n} films given their home release date (read back by Plex). New films get theirs as they arrive.`,
            };
          }
          const r = await this.digital.restore(service);
          return r.left
            ? {
                ok: false,
                result: `${r.done} release dates put back; ${r.left} could not be. Try it again.`,
              }
            : {
                ok: true,
                result: `${r.done} release dates put back; Recently Released goes by release date again.`,
              };
        }
        if (op === "merge-dates") {
          const into = await this.library(base, token, String(p.intoId));
          if (!into) return { ok: false, result: "That library is gone from Plex." };
          const sources = String(p.fromIds ?? "")
            .split(",")
            .filter((x) => /^\d+$/.test(x));
          const pass = await this.carry.start({
            serviceId: service.id,
            url: service.localUrl,
            into: into.id,
            intoTitle: into.title,
            type: Number(p.type) === 2 ? 2 : 1,
            sources,
            rows: [],
          });
          const left = await this.carry.lateCount(service, into.id, sources);
          if (left && pass.done)
            return {
              ok: false,
              result: `${pass.dated} added dates put back, but Plex still lists ${left} with the merge's date.`,
            };
          return {
            ok: true,
            result: `${pass.dated} added dates put back in ${into.title} (read back).${pass.done ? "" : ` Plex is scanning ${into.title}: Hearth finishes the rest when it is done.`}`,
          };
        }
        if (op === "move-released") {
          const into = await this.library(base, token, String(p.intoId));
          const from = await this.library(base, token, String(p.fromId));
          const want = JSON.parse(String(p.folders ?? "[]")) as string[];
          const before = JSON.parse(String(p.before ?? "[]")) as string[];
          const fromWant = JSON.parse(String(p.fromFolders ?? "[]")) as string[];
          const fromBefore = JSON.parse(String(p.fromBefore ?? "[]")) as string[];
          const visAfter = JSON.parse(String(p.vis ?? "{}")) as Record<string, string>;
          const visFrom = JSON.parse(String(p.visFrom ?? "{}")) as Record<string, string>;
          const rows = JSON.parse(String(p.rows ?? "[]")) as {
            lib: string;
            id: string;
            home: boolean;
          }[];
          const rowsFrom = JSON.parse(String(p.rowsFrom ?? "[]")) as string[];
          const libIds = [...new Set(rows.map((r) => r.lib))];
          const rowsNow: string[] = [];
          for (const lib of libIds) {
            const ids = rows.filter((r) => r.lib === lib).map((r) => r.id);
            for (const h of await this.hubs(base, token, lib))
              if (ids.includes(h.id)) rowsNow.push(`${lib}|${h.id}:${PlexOperations.code(h)}`);
          }
          let visStale = false;
          for (const [id, v] of Object.entries(visFrom))
            if ((await this.visibility(base, token, id)) !== v) visStale = true;
          if (
            !into ||
            !from ||
            into.folders.join("|") !== before.join("|") ||
            from.folders.join("|") !== fromBefore.join("|") ||
            visStale ||
            rowsNow.sort().join("|") !== [...rowsFrom].sort().join("|")
          )
            return {
              ok: false,
              stale: true,
              result: `${poss(String(p.name))} or ${poss(String(p.fromName))} folders, rows or Visibility changed since this was planned. Nothing was changed; plan it again.`,
            };
          // Plex still scanning from the last change: change nothing (11-10).
          const busy = await this.scanning(base, token, [
            { id: into.id, title: into.title },
            { id: from.id, title: from.title },
          ]);
          if (busy)
            return {
              ok: false,
              result: `Plex is still scanning ${busy.lib}${busy.progress !== undefined ? ` (${Math.round(busy.progress)}%)` : ""} from the last change. Nothing was changed: try again once it finishes, usually a few minutes.`,
            };
          const same = (a: string[], b: string[]) =>
            [...a].sort().join("|") === [...b].sort().join("|");
          // Sets a library's folders and reads them back (Plex lists the change a moment late).
          const folders = async (lib: NonNullable<typeof into>, to: string[]) => {
            const s = await this.setFolders(base, token, lib, to).catch((e: unknown) => {
              if (e instanceof AppUnreachableError) return undefined;
              throw e;
            });
            if (s) return `Plex refused changing ${poss(lib.title)} folders (${s})`;
            let back = await this.library(base, token, lib.id);
            for (let i = 0; back && !same(back.folders, to) && i < 20; i++) {
              await new Promise((r) => setTimeout(r, this.settleMs));
              back = await this.library(base, token, lib.id);
            }
            return back && same(back.folders, to)
              ? undefined
              : `${poss(lib.title)} folders do not read back as asked`;
          };
          // Puts the folders back when a later part fails, so nothing is left half done.
          const undo = async (both: boolean) => {
            await this.setFolders(base, token, into, before).catch(() => undefined);
            if (both) await this.setFolders(base, token, from, fromBefore).catch(() => undefined);
          };
          // The new library first: for a moment both read the merged folders, never neither.
          const a = await folders(into, want);
          if (a) {
            await undo(false);
            return { ok: false, result: `${a}. Nothing was changed.` };
          }
          const b = await folders(from, fromWant);
          if (b) {
            await undo(true);
            return { ok: false, result: `${b}, so Hearth put both libraries' folders back.` };
          }
          for (const [id, v] of Object.entries(visAfter)) {
            const s = await this.setVisibility(base, token, id, v);
            if (s || (await this.visibility(base, token, id)) !== v) {
              await undo(true);
              for (const [k, old] of Object.entries(visFrom))
                await this.setVisibility(base, token, k, old).catch(() => undefined);
              return {
                ok: false,
                result: `Plex ${s ? `refused (${s})` : "did not keep"} the change to where a library shows, so Hearth put the folders and Visibility back. Nothing else was changed.`,
              };
            }
          }
          const failed: string[] = [];
          for (const r of rows) {
            const q = new URLSearchParams({
              promotedToOwnHome: r.home ? "1" : "0",
              ...(r.home ? {} : { promotedToSharedHome: "0" }),
            });
            const s = await send(
              `/hubs/sections/${encodeURIComponent(r.lib)}/manage/${encodeURIComponent(r.id)}?${q.toString()}`,
              "PUT",
            );
            if (s) failed.push(r.id);
          }
          // Only a library on Home reports its rows reliably: check the one whose rows show.
          const wrong = (await this.hubs(base, token, into.id))
            .filter((h) => rows.some((r) => r.lib === into.id && r.id === h.id) && !h.home)
            .map((h) => h.title);
          await send(`/library/sections/${encodeURIComponent(into.id)}/refresh`, "GET");
          await send(`/library/sections/${encodeURIComponent(from.id)}/refresh`, "GET");
          if (failed.length || wrong.length)
            return {
              ok: false,
              result: `The folders and Visibility are set (read back), but ${wrong.join(", ") || failed.join(", ")} did not change on Home as planned: change it in Home rows.`,
            };
          const carried = await this.carryAfter(p, service, into, true);
          return {
            ok: true,
            result: `The merged rows show under ${into.title} now, each title once, and ${from.title} reads only its own folders (read back). Plex is scanning both.${carried}`,
          };
        }
        if (op === "set-settings") {
          const asked = JSON.parse(String(p.preferences ?? "{}")) as Record<
            string,
            string | number | boolean
          >;
          const from = JSON.parse(String(p.from ?? "{}")) as Record<string, string>;
          let list = await this.settings(base, token);
          for (const [id, was] of Object.entries(from)) {
            const s = list.find((x) => x.id === id);
            if (!s || show(s.value) !== was)
              return {
                ok: false,
                stale: true,
                result: `${s?.label ?? id} changed since this was planned. Nothing was changed; plan it again.`,
              };
          }
          // Re-checked here too: a plan is never trusted to name a locked setting.
          PlexOperations.wanted({ preferences: JSON.stringify(asked) }, list);
          const q = new URLSearchParams(
            Object.entries(asked).map(([k, v]) => [
              k,
              typeof v === "boolean" ? (v ? "1" : "0") : String(v),
            ]),
          );
          const s = await send(`/:/prefs?${q.toString()}`, "PUT");
          if (s) return { ok: false, result: `Plex refused the settings (${s}).` };
          list = await this.settings(base, token);
          const off = Object.entries(asked).filter(
            ([id, v]) => show(list.find((x) => x.id === id)?.value) !== show(v),
          );
          return off.length
            ? {
                ok: false,
                result: `Plex accepted but reads back differently for ${off.map(([id]) => id).join(", ")}.`,
              }
            : {
                ok: true,
                result: `Plex now has ${Object.entries(asked)
                  .map(([id, v]) => `${list.find((x) => x.id === id)?.label ?? id}: ${show(v)}`)
                  .join("; ")} (read back).`,
              };
        }
        if (op === "collection-rename") {
          const key = String(p.collectionKey);
          const read = async () =>
            (
              await this.json<{ MediaContainer?: { Metadata?: { title?: string }[] } }>(
                base,
                token,
                `/library/metadata/${encodeURIComponent(key)}`,
              ).catch(() => undefined)
            )?.MediaContainer?.Metadata?.[0]?.title;
          const now = await read();
          if (now === undefined)
            return { ok: false, stale: true, result: `“${name}” is gone from Plex.` };
          if (now !== p.from)
            return {
              ok: false,
              stale: true,
              result: `“${name}” was renamed since this was planned. Nothing was changed.`,
            };
          const q = new URLSearchParams({
            type: "18",
            id: key,
            "title.value": String(p.title),
            "title.locked": "1",
          });
          const s = await send(
            `/library/metadata/${encodeURIComponent(key)}?${q.toString()}`,
            "PUT",
          );
          if (s) return { ok: false, result: `Plex refused the new name (${s}).` };
          if ((await read()) !== p.title)
            return {
              ok: false,
              result: `Plex accepted, but “${name}” does not read back renamed.`,
            };
          await this.rows.renamed(key, String(p.title));
          return {
            ok: true,
            verified: true,
            result: `“${name}” is now “${p.title}” (read back).`,
          };
        }
        if (op === "collection-delete") {
          const key = String(p.collectionKey);
          const s = await send(`/library/metadata/${encodeURIComponent(key)}`, "DELETE");
          if (s === 404)
            return {
              ok: false,
              stale: true,
              result: `“${name}” is already gone. Nothing was changed.`,
            };
          if (s) return { ok: false, result: `Plex refused to delete “${name}” (${s}).` };
          const gone =
            (await this.req(base, token, `/library/metadata/${encodeURIComponent(key)}`)).status ===
            404;
          return gone
            ? {
                ok: true,
                verified: true,
                result: `The collection “${name}” is deleted; its titles stay in the library (read back).`,
              }
            : { ok: false, result: `Plex accepted, but “${name}” still reads back.` };
        }
        if (op === "collection-add" || op === "collection-remove") {
          const id = String(p.ratingKey);
          const m = await this.item(base, token, id);
          if (!m)
            return {
              ok: false,
              stale: true,
              result: `Plex no longer has ${name}. Nothing was changed.`,
            };
          const section = String(p.libraryId);
          const title = String(p.collection);
          let coll = (await this.collections(base, token, section)).find(
            (c) => c.title.toLowerCase() === title.toLowerCase(),
          );
          if (op === "collection-remove") {
            if (!coll || !(await this.members(base, token, coll.key)).includes(id))
              return {
                ok: false,
                stale: true,
                result: `${name} is not in “${title}” any more. Nothing was changed.`,
              };
            const s = await send(
              `/library/collections/${encodeURIComponent(coll.key)}/children/${encodeURIComponent(id)}`,
              "DELETE",
            );
            if (s) return { ok: false, result: `Plex refused (${s}).` };
            return (await this.members(base, token, coll.key)).includes(id)
              ? { ok: false, result: `Plex accepted, but ${name} still reads back in “${title}”.` }
              : { ok: true, verified: true, result: `${name} is out of “${title}” (read back).` };
          }
          if (coll && (await this.members(base, token, coll.key)).includes(id))
            return {
              ok: false,
              stale: true,
              result: `${name} is already in “${coll.title}”. Nothing was changed.`,
            };
          const uri = `server://${await this.machine(base, token)}/com.plexapp.plugins.library/library/metadata/${id}`;
          let created = false;
          if (coll) {
            const s = await send(
              `/library/collections/${encodeURIComponent(coll.key)}/items?${new URLSearchParams({ uri }).toString()}`,
              "PUT",
            );
            if (s) return { ok: false, result: `Plex refused adding ${name} (${s}).` };
          } else {
            const q = new URLSearchParams({
              type: String(TYPE_NUMBER[m.type ?? "movie"] ?? 1),
              title,
              smart: "0",
              sectionId: section,
              uri,
            });
            const s = await send(`/library/collections?${q.toString()}`, "POST");
            if (s) return { ok: false, result: `Plex refused creating “${title}” (${s}).` };
            created = true;
            coll = (await this.collections(base, token, section)).find(
              (c) => c.title.toLowerCase() === title.toLowerCase(),
            );
            if (!coll)
              return { ok: false, result: `Plex accepted, but “${title}” does not read back.` };
          }
          const now = await this.members(base, token, coll.key);
          return now.includes(id)
            ? {
                ok: true,
                verified: true,
                result: `${name} is in “${coll.title}”${created ? " (collection created)" : ""}: ${now.length} ${now.length === 1 ? "title" : "titles"} now (read back).`,
              }
            : {
                ok: false,
                result: `Plex accepted, but ${name} does not read back in “${coll.title}”.`,
              };
        }
        // One title.
        const id = String(p.ratingKey);
        const m = await this.item(base, token, id);
        if (!m) return { ok: false, stale: true, result: `Plex no longer has ${name}.` };
        if (op === "watched" || op === "unwatched") {
          const now = watchedOf(m) ? "watched" : "unwatched";
          if (now !== p.from)
            return {
              ok: false,
              stale: true,
              result: `${name} is already ${now}. Nothing was changed.`,
            };
          const s = await send(
            `/:/${op === "watched" ? "scrobble" : "unscrobble"}?key=${encodeURIComponent(id)}&identifier=com.plexapp.plugins.library`,
            "PUT",
          );
          if (s) return { ok: false, result: `Plex refused (${s}).` };
          const after = await this.item(base, token, id);
          const ok = after !== undefined && watchedOf(after) === (op === "watched");
          return ok
            ? { ok: true, result: `${name} is now ${op} (read back).` }
            : { ok: false, result: `Plex accepted, but ${name} does not read back as ${op}.` };
        }
        if (op === "rate") {
          const rating = Number(p.stars) * 2;
          const s = await send(
            `/:/rate?key=${encodeURIComponent(id)}&identifier=com.plexapp.plugins.library&rating=${rating}`,
            "PUT",
          );
          if (s) return { ok: false, result: `Plex refused the rating (${s}).` };
          const after = await this.item(base, token, id);
          return after?.userRating === rating
            ? { ok: true, verified: true, result: `${name} is rated ${p.stars} of 5 (read back).` }
            : { ok: false, result: `Plex accepted, but ${name}'s rating does not read back.` };
        }
        if (op === "refresh-item") {
          const s = await send(`/library/metadata/${encodeURIComponent(id)}/refresh`, "PUT");
          return s
            ? { ok: false, result: `Plex refused the refresh (${s}).` }
            : { ok: true, result: `Plex is reading ${name}'s details again.` };
        }
        // edit-item
        const changes = JSON.parse(String(p.body ?? "{}")) as Partial<Record<Editable, string>>;
        const from = JSON.parse(String(p.from ?? "{}")) as Partial<Record<Editable, string>>;
        const now = PlexOperations.current(m);
        const moved = (Object.keys(from) as Editable[]).filter((f) => now[f] !== from[f]);
        if (moved.length)
          return {
            ok: false,
            stale: true,
            result: `${name} changed since this was planned. Nothing was changed; plan it again.`,
          };
        const q = new URLSearchParams({ type: String(TYPE_NUMBER[m.type ?? ""] ?? ""), id });
        for (const [f, v] of Object.entries(changes) as [Editable, string][]) {
          q.set(`${FIELD[f]}.value`, v);
          q.set(`${FIELD[f]}.locked`, "1");
        }
        const s = await send(`/library/metadata/${encodeURIComponent(id)}?${q.toString()}`, "PUT");
        if (s) return { ok: false, result: `Plex refused the edit (${s}).` };
        const after = await this.item(base, token, id);
        const got = after ? PlexOperations.current(after) : undefined;
        const off = (Object.keys(changes) as Editable[]).filter((f) => got?.[f] !== changes[f]);
        return off.length
          ? { ok: false, result: `Plex accepted, but ${off.join(", ")} did not read back.` }
          : { ok: true, result: `${name} is edited in Plex (read back).` };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
