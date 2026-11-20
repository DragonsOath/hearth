import { eq } from "drizzle-orm";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import { hubOf, type RawHub } from "./plex-panel";

/**
 * What comes along when a library leaves Home for a merge (11-13, the owner: "recently added and
 * recently released shouldn't affect my custom Thanksgiving and Christmas rows").
 *
 * A merge leaves the other library sidebar only, so every row of its own left Home with it, and
 * the library that now reads its folders lists each film as added today (seen on the owner's Plex:
 * 81 films folded in on 11-11 all said "added 11-11"). Once Plex has scanned them in, each film
 * gets its own added date back and each of the owner's rows is made again in the library that
 * shows them, with the same name, films, places and position.
 */

/** One of the owner's own rows to bring along: a collection's row in a library leaving Home. */
export interface CarryRow {
  lib: string;
  key: string;
  title: string;
  /** Where it shows: r (Library Recommended), h (Home), s (Friends' Home), as rh-. */
  code: string;
}

export interface CarryJob {
  serviceId: string;
  url: string;
  into: string;
  intoTitle: string;
  /** 1 for films, 2 for shows (Plex's type number). */
  type: number;
  sources: string[];
  rows: CarryRow[];
  startedAt: number;
  /** Rows made already (by title). */
  made: string[];
  /** Passes after Plex finished scanning with films still missing. */
  waits: number;
}

export interface CarryPass {
  done: boolean;
  dated: number;
  made: string[];
  waiting?: string;
}

const CUSTOM = /^custom\.collection\.\d+\.(\d+)$/;
const KEY = "plex-carry:pending";
/** How long a carry keeps waiting for Plex to scan the films in. */
const GIVE_UP_MS = 12 * 3_600_000;

/** A library's own rows that show somewhere, to bring along when it leaves Home. */
export function rowsToCarry(lib: string, hubs: ReturnType<typeof hubOf>[]): CarryRow[] {
  const out: CarryRow[] = [];
  for (const h of hubs) {
    const m = CUSTOM.exec(h.id);
    // Library Recommended stays where it is (the library is still in the sidebar): Home ones go.
    if (!m || !(h.home || h.shared)) continue;
    out.push({
      lib,
      key: m[1]!,
      title: h.title,
      code: `${h.recommended ? "r" : "-"}${h.home ? "h" : "-"}${h.shared ? "s" : "-"}`,
    });
  }
  return out;
}

/** Where a row shows, in words, for the approval. */
export const placesOf = (code: string) =>
  [code[1] === "h" && "Home", code[2] === "s" && "Friends' Home", code[0] === "r" && "Recommended"]
    .filter(Boolean)
    .join(", ") || "nowhere";

interface Entry {
  rk: string;
  addedAt: number;
  keys: string[];
}

export class PlexCarry {
  private pending: CarryJob[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  private running = false;
  /** Between passes while Plex scans (tests run passes by hand). */
  everyMs = 60_000;

  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  /** Carries left from before a restart pick up again a little after start. */
  resume(delayMs = 30_000) {
    const t0 = setTimeout(() => void this.tick().catch(() => undefined), delayMs);
    t0.unref?.();
  }

  /** Brings the rows along now as far as Plex has scanned, and keeps at it until it is done. */
  async start(job: Omit<CarryJob, "startedAt" | "made" | "waits">): Promise<CarryPass> {
    await this.load();
    const full: CarryJob = { ...job, startedAt: Date.now(), made: [], waits: 0 };
    this.pending = this.pending.filter(
      (j) => !(j.serviceId === job.serviceId && j.into === job.into),
    );
    this.pending.push(full);
    const pass = await this.pass(full).catch((e: unknown): CarryPass => ({
      done: false,
      dated: 0,
      made: [],
      waiting: e instanceof Error ? e.message : "Plex did not answer",
    }));
    if (pass.done) this.pending = this.pending.filter((j) => j !== full);
    await this.save();
    this.schedule();
    return pass;
  }

  /** The carries still waiting for Plex (the panel says so). */
  async waiting(serviceId: string) {
    await this.load();
    return this.pending
      .filter((j) => j.serviceId === serviceId)
      .map((j) => ({
        into: j.intoTitle,
        rows: j.rows.filter((r) => !j.made.includes(r.title)).map((r) => r.title),
      }));
  }

  /** One pass over every carry still waiting. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.load();
      for (const j of [...this.pending]) {
        const pass = await this.pass(j).catch(() => undefined);
        const old = Date.now() - j.startedAt > GIVE_UP_MS;
        if (pass?.done || old) this.pending = this.pending.filter((x) => x !== j);
      }
      await this.save();
    } finally {
      this.running = false;
    }
    this.schedule();
  }

  private schedule() {
    if (this.timer || !this.pending.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch(() => undefined);
    }, this.everyMs);
    this.timer.unref?.();
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const r = await this.handle.db.select().from(t.settings).where(eq(t.settings.key, KEY)).get();
      const list = (r?.value ?? []) as CarryJob[];
      for (const j of Array.isArray(list) ? list : [])
        if (!this.pending.some((x) => x.serviceId === j.serviceId && x.into === j.into))
          this.pending.push(j);
    } catch {
      // No store (a test): kept in memory only.
    }
  }

  private async save() {
    try {
      const at = new Date().toISOString();
      if (!this.pending.length) {
        await this.handle.db.delete(t.settings).where(eq(t.settings.key, KEY));
        return;
      }
      await this.handle.db
        .insert(t.settings)
        .values({ key: KEY, value: this.pending as never, updatedAt: at })
        .onConflictDoUpdate({
          target: t.settings.key,
          set: { value: this.pending as never, updatedAt: at },
        });
    } catch {
      // No store (a test): kept in memory only.
    }
  }

  /** As far as Plex has scanned: dates first (so Recently Added is right soonest), then rows. */
  async pass(j: CarryJob): Promise<CarryPass> {
    return this.broker.use(
      {
        serviceId: j.serviceId,
        purpose: "bring rows and added dates along after a Plex merge",
        access: "change",
        destination: j.url,
      },
      async ({ value: token }) => {
        const call = (path: string, method = "GET") => this.req(j.url, token, path, method);
        const scanning = await this.scanning(call, j.into, j.intoTitle);
        const { twin, late } = await this.match(call, j.into, j.sources);
        let dated = 0;
        for (const [at, rks] of late)
          for (let i = 0; i < rks.length; i += 50) {
            const ids = rks.slice(i, i + 50);
            const q = new URLSearchParams({
              type: String(j.type),
              id: ids.join(","),
              "addedAt.value": String(at),
              "addedAt.locked": "1",
            });
            const r = await call(`/library/sections/${j.into}/all?${q.toString()}`, "PUT");
            if (r.ok) dated += ids.length;
          }
        if (scanning)
          return {
            done: false,
            dated,
            made: [],
            waiting: `Plex is still scanning ${j.intoTitle}`,
          };
        const made: string[] = [];
        let missing = false;
        for (const row of j.rows) {
          if (j.made.includes(row.title)) continue;
          const r = await this.makeRow(call, j, row, twin).catch(() => undefined);
          if (r === "made") {
            j.made.push(row.title);
            made.push(row.title);
          } else missing = true;
        }
        // Plex finished but some films never showed up: after a few passes, make what it can.
        if (missing) j.waits += 1;
        const done = !missing || j.waits > 3;
        if (missing && done)
          for (const row of j.rows)
            if (
              !j.made.includes(row.title) &&
              (await this.makeRow(call, j, row, twin, true).catch(() => undefined))
            ) {
              j.made.push(row.title);
              made.push(row.title);
            }
        return {
          done,
          dated,
          made,
          ...(done ? {} : { waiting: `Some films are not in ${j.intoTitle} yet` }),
        };
      },
    );
  }

  /**
   * Each film in the library showing the merged rows, matched to the one it came from, and the
   * ones Plex dated later than that one (grouped by the date they should have).
   */
  private async match(call: (path: string) => Promise<Res>, into: string, sources: string[]) {
    const list = await this.entries(call, into);
    const from = new Map<string, Entry>();
    for (const s of sources)
      for (const e of await this.entries(call, s)) for (const k of e.keys) from.set(k, e);
    const twin = new Map<string, string>();
    const late = new Map<number, string[]>();
    for (const e of list) {
      const src = e.keys.map((k) => from.get(k)).find(Boolean);
      if (!src) continue;
      twin.set(src.rk, e.rk);
      if (src.addedAt && src.addedAt < e.addedAt) {
        const l = late.get(src.addedAt) ?? [];
        l.push(e.rk);
        late.set(src.addedAt, l);
      }
    }
    return { twin, late };
  }

  /** How many films in `into` Plex dated later than in the library they came from (a read). */
  async lateCount(service: { id: string; localUrl: string }, into: string, sources: string[]) {
    return this.broker.use(
      {
        serviceId: service.id,
        purpose: "read Plex added dates after a merge",
        access: "read",
        destination: service.localUrl,
      },
      async ({ value: token }) => {
        const call = (path: string) => this.req(service.localUrl, token, path);
        const { late } = await this.match(call, into, sources);
        return [...late.values()].reduce((n, l) => n + l.length, 0);
      },
    );
  }

  /** One row made again in the library showing the rows: its collection, places and position. */
  private async makeRow(
    call: (path: string, method?: string) => Promise<Res>,
    j: CarryJob,
    row: CarryRow,
    twin: Map<string, string>,
    partial = false,
  ): Promise<"made" | undefined> {
    const meta = await this.body<{
      MediaContainer?: { Metadata?: { smart?: boolean | string; content?: string }[] };
    }>(call, `/library/metadata/${row.key}`);
    const m = meta.MediaContainer?.Metadata?.[0];
    if (!m) return undefined;
    const content = m.content ?? "";
    const smart = Boolean(content) || m.smart === true || m.smart === "1";
    const machine =
      (await this.body<{ MediaContainer?: { machineIdentifier?: string } }>(call, "/identity"))
        .MediaContainer?.machineIdentifier ?? "";
    let uri: string;
    if (smart) {
      // The same filter, reading the library that shows the rows.
      const q = /\/library\/sections\/\d+\/all\?(.*)$/.exec(content)?.[1];
      if (!q) return undefined;
      uri = `server://${machine}/com.plexapp.plugins.library/library/sections/${j.into}/all?${q}`;
    } else {
      const kids = await this.body<{ MediaContainer?: { Metadata?: { ratingKey?: string }[] } }>(
        call,
        `/library/collections/${row.key}/children`,
      );
      const want = (kids.MediaContainer?.Metadata ?? []).map((k) => String(k.ratingKey));
      const members = want.map((k) => twin.get(k)).filter((k): k is string => Boolean(k));
      if (!members.length || (members.length < want.length && !partial)) return undefined;
      uri = `server://${machine}/com.plexapp.plugins.library/library/metadata/${members.join(",")}`;
    }
    // A carry before (switching back and forth): the same collection, brought up to date.
    const own = await this.body<{
      MediaContainer?: { Metadata?: { ratingKey?: string; title?: string }[] };
    }>(call, `/library/sections/${j.into}/collections`);
    let key = own.MediaContainer?.Metadata?.find((c) => c.title === row.title)?.ratingKey;
    if (key) {
      const r = await call(
        `/library/collections/${key}/items?${new URLSearchParams({ uri }).toString()}`,
        "PUT",
      );
      if (!r.ok) return undefined;
    } else {
      const q = new URLSearchParams({
        type: String(j.type),
        title: row.title,
        smart: smart ? "1" : "0",
        sectionId: j.into,
        uri,
      });
      const r = await call(`/library/collections?${q.toString()}`, "POST");
      if (!r.ok) return undefined;
      const body = (await r.json().catch(() => ({}))) as {
        MediaContainer?: { Metadata?: { ratingKey?: string }[] };
      };
      key = body.MediaContainer?.Metadata?.[0]?.ratingKey;
      if (!key) return undefined;
    }
    const flags = {
      promotedToRecommended: row.code[0] === "r" ? "1" : "0",
      promotedToOwnHome: row.code[1] === "h" ? "1" : "0",
      promotedToSharedHome: row.code[2] === "s" ? "1" : "0",
    };
    const id = `custom.collection.${j.into}.${key}`;
    const hubs = await this.hubs(call, j.into);
    const r = hubs.some((h) => h.id === id)
      ? await call(
          `/hubs/sections/${j.into}/manage/${encodeURIComponent(id)}?${new URLSearchParams(flags).toString()}`,
          "PUT",
        )
      : await call(
          `/hubs/sections/${j.into}/manage?${new URLSearchParams({ metadataItemId: key, ...flags }).toString()}`,
          "POST",
        );
    if (!r.ok) return undefined;
    // In the order they had: after the rows brought along before it, else after the new-title rows.
    const now = await this.hubs(call, j.into);
    const before = j.rows
      .slice(0, j.rows.indexOf(row))
      .map((x) => now.find((h) => h.title === x.title && CUSTOM.test(h.id))?.id)
      .filter((x): x is string => Boolean(x));
    const after =
      before.at(-1) ??
      now.filter((h) => /\.(recentlyreleased|recentlyadded)(\.\d+)?$/.test(h.id)).at(-1)?.id ??
      "";
    if (after && after !== id)
      await call(
        `/hubs/sections/${j.into}/manage/${encodeURIComponent(id)}/move?${new URLSearchParams({ after }).toString()}`,
        "PUT",
      );
    return "made";
  }

  private async hubs(call: (path: string) => Promise<Res>, lib: string) {
    const r = await this.body<{ MediaContainer?: { Hub?: RawHub[] } }>(
      call,
      `/hubs/sections/${lib}/manage`,
    );
    return (r.MediaContainer?.Hub ?? []).filter((h) => h.identifier).map(hubOf);
  }

  /** Every title in a library: its added date and what identifies it (files, then Plex's id). */
  private async entries(call: (path: string) => Promise<Res>, lib: string): Promise<Entry[]> {
    const out: Entry[] = [];
    for (let start = 0; start < 200_000; start += 2000) {
      const r = await this.body<{
        MediaContainer?: {
          totalSize?: number;
          Metadata?: {
            ratingKey?: string;
            addedAt?: number;
            guid?: string;
            Media?: { Part?: { file?: string }[] }[];
          }[];
        };
      }>(
        call,
        `/library/sections/${lib}/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=2000`,
      );
      const list = r.MediaContainer?.Metadata ?? [];
      for (const m of list) {
        const files = (m.Media ?? []).flatMap((x) => x.Part ?? []).map((p) => `f:${p.file}`);
        const keys = files.filter((f) => f !== "f:undefined");
        // Plex's own id only without files (shows): a film can be in two folders as two files.
        if (!keys.length && m.guid && !m.guid.startsWith("local://")) keys.push(`g:${m.guid}`);
        if (m.ratingKey)
          out.push({ rk: String(m.ratingKey), addedAt: Number(m.addedAt ?? 0), keys });
      }
      const total = r.MediaContainer?.totalSize ?? list.length;
      if (list.length < 2000 || start + list.length >= total) break;
    }
    return out;
  }

  /** Plex scanning that library now (by its id, or "Scanning <name>" as Plex titles it). */
  private async scanning(call: (path: string) => Promise<Res>, lib: string, title: string) {
    const r = await this.body<{
      MediaContainer?: {
        Activity?: {
          type?: string;
          title?: string;
          Context?: { librarySectionID?: string | number };
        }[];
      };
    }>(call, "/activities").catch(() => ({}) as { MediaContainer?: undefined });
    return (r.MediaContainer?.Activity ?? []).some(
      (a) =>
        /library|scan|refresh/i.test(`${a.type ?? ""} ${a.title ?? ""}`) &&
        (String(a.Context?.librarySectionID ?? "") === lib ||
          (a.title ?? "").toLowerCase().endsWith(title.toLowerCase())),
    );
  }

  private async body<T>(call: (path: string) => Promise<Res>, path: string): Promise<T> {
    const r = await call(path);
    if (!r.ok)
      throw new AppUnreachableError(`Plex answered ${r.status} for ${path.split("?")[0]}.`);
    return (await r.json().catch(() => ({}))) as T;
  }

  private async req(base: string, token: string, path: string, method = "GET"): Promise<Res> {
    try {
      return await this.fetchImpl(joinUrl(base, path), {
        method,
        headers: { Accept: "application/json", "X-Plex-Token": token },
        signal: AbortSignal.timeout(TIMEOUT_MS * 4),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : "no answer";
      throw new AppUnreachableError(`Plex did not answer: ${why.replaceAll(token, "[hidden]")}`);
    }
  }
}

type Res = Awaited<ReturnType<Fetch>>;
