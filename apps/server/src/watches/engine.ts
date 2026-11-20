import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull, lte } from "drizzle-orm";
import {
  MOVIE_STATE_LABEL,
  RELEASE_WATCH_DEFAULTS,
  assessMovie,
  movieEvents,
  viewOf,
  type MovieAssessment,
  type MovieFacts,
  type MovieWatchState,
  type ReleaseWatchSettings,
  type Watch,
  type WatchEventDraft,
  type WatchHistoryEntry,
  type WatchView,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting, setSetting } from "../store/settings";
import type { MovieReleases } from "./movie-release";

/**
 * The watch engine (docs/design/RELEASE_WATCH.md). Watches live in the database with their next
 * check time, so a restart picks up where it left off; a one-minute tick checks only what is due.
 * Routine checks are plain code: the AI is never asked to look on a timer. Each piece of news is
 * recorded once (by key) and sent once, held through quiet hours and snoozes.
 *
 * Only one kind exists today (movie releases). A new kind adds its own discovery and rules; the
 * scheduling, history, snooze, dismissal, and notifications here stay the same.
 */

type Row = typeof t.watches.$inferSelect;

/** How often Seerr is asked for new requests. */
const DISCOVER_EVERY_MS = 30 * 60_000;
/** After a failed check (Seerr did not answer), try again in this long. */
const RETRY_MINUTES = 30;
/** Checks at most this many watches per tick, so one tick stays short. */
const PER_TICK = 25;

export interface Announcer {
  quietHours(): Promise<boolean>;
  announceRelease(
    watchId: string,
    news: { title: string; text: string; problem: boolean },
  ): Promise<"sent" | "none">;
}

export class Watches {
  private lastDiscover = 0;
  private running?: Promise<void>;

  constructor(
    private readonly handle: DbHandle,
    private readonly movies: MovieReleases,
    private readonly announcer: Announcer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get db() {
    return this.handle.db;
  }

  async settings(): Promise<ReleaseWatchSettings> {
    const saved = await getSetting(this.db, "release_watch");
    return {
      ...RELEASE_WATCH_DEFAULTS,
      ...saved,
      notify: { ...RELEASE_WATCH_DEFAULTS.notify, ...saved?.notify },
    };
  }

  async updateSettings(change: Partial<ReleaseWatchSettings>): Promise<ReleaseWatchSettings> {
    const current = await this.settings();
    if (change.region !== undefined && change.region !== "" && !/^[A-Za-z]{2}$/.test(change.region))
      throw new InvalidRequestError("A country is two letters, like US or GB.");
    const next: ReleaseWatchSettings = {
      enabled: change.enabled ?? current.enabled,
      region: (change.region ?? current.region).toUpperCase(),
      notify: { ...current.notify, ...change.notify },
      overdueAfterDays: change.overdueAfterDays ?? current.overdueAfterDays,
    };
    if (
      !Number.isInteger(next.overdueAfterDays) ||
      next.overdueAfterDays < 0 ||
      next.overdueAfterDays > 60
    )
      throw new InvalidRequestError("Overdue after is a whole number of days, 0 to 60.");
    await setSetting(this.db, "release_watch", next);
    return next;
  }

  /** How many Seerr and Radarr services there are to read (the page explains what is missing). */
  async sources(): Promise<{ seerr: number; radarr: number }> {
    return {
      seerr: (await this.movies.services("seerr")).length,
      radarr: (await this.movies.services("radarr")).length,
    };
  }

  /** The owner's local date (YYYY-MM-DD), for "out today". */
  private today(): string {
    const d = this.now();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }

  /** On the one-minute timer. Ticks never overlap. */
  tick(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Waits for a tick in progress (tests). */
  async idle() {
    while (this.running) await this.running;
  }

  private async run() {
    const settings = await this.settings();
    if (!settings.enabled) return;
    const now = this.now();
    if (now.getTime() - this.lastDiscover >= DISCOVER_EVERY_MS) {
      this.lastDiscover = now.getTime();
      await this.discover();
    }
    const due = await this.db
      .select()
      .from(t.watches)
      .where(and(isNotNull(t.watches.nextCheckAt), lte(t.watches.nextCheckAt, now.toISOString())))
      .orderBy(asc(t.watches.nextCheckAt))
      .limit(PER_TICK);
    for (const row of due) await this.checkOne(row, settings);
    await this.sendHeld(settings);
  }

  /** Finds new movie requests and starts a watch for each; existing ones are left as they are. */
  async discover(): Promise<{ added: number; errors: string[] }> {
    if (!(await this.settings()).enabled)
      return { added: 0, errors: ["Watching is switched off, so nothing was checked."] };
    const found = await this.movies.discover();
    const imported = new Set((await getSetting(this.db, "release_watch_imported")) ?? []);
    const existing = new Set(
      (
        await this.db
          .select({ key: t.watches.key })
          .from(t.watches)
          .where(eq(t.watches.kind, "movie-release"))
      ).map((r) => r.key),
    );
    const at = this.now().toISOString();
    let added = 0;
    for (const req of found.requests) {
      if (existing.has(req.key)) continue;
      // The unique index on (kind, key) stops a duplicate even if two passes overlap.
      const inserted = await this.db
        .insert(t.watches)
        .values({
          id: randomUUID(),
          kind: "movie-release",
          key: req.key,
          title: `A movie (TMDB ${req.tmdbId})`,
          state: "unannounced",
          facts: {
            tmdbId: req.tmdbId,
            requestId: req.requestId,
            seerrServiceId: req.seerrServiceId,
            // Found on the first pass over this Seerr: its first look is quiet.
            quiet: !imported.has(req.seerrServiceId),
          },
          createdAt: at,
          updatedAt: at,
          nextCheckAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: t.watches.id });
      if (inserted.length) added += 1;
    }
    // Watches of a Seerr Hearth no longer watches (removed, or retired) close quietly.
    const seerrs = new Set(found.seerrs);
    const open = await this.db
      .select()
      .from(t.watches)
      .where(and(eq(t.watches.kind, "movie-release"), isNotNull(t.watches.nextCheckAt)));
    for (const w of open) {
      const f = w.facts as {
        seerrServiceId?: string;
        request?: { seerrServiceId?: string };
      } | null;
      const seerr = f?.request?.seerrServiceId ?? f?.seerrServiceId;
      if (!seerr || seerrs.has(seerr)) continue;
      await this.db
        .update(t.watches)
        .set({ state: "gone", nextCheckAt: null, updatedAt: at })
        .where(eq(t.watches.id, w.id));
      await this.note(
        w.id,
        "gone",
        `Stopped watching ${w.title}`,
        "The Seerr it was requested in is no longer watched by Hearth.",
      );
    }
    // A Seerr read without errors counts as imported: requests made after this are news.
    if (!found.errors.length) {
      const next = [...new Set([...imported, ...found.seerrs])];
      if (next.length !== imported.size) await setSetting(this.db, "release_watch_imported", next);
    }
    return { added, errors: found.errors };
  }

  private async checkOne(row: Row, settings: ReleaseWatchSettings) {
    const now = this.now();
    const stored = row.facts as
      | (Partial<MovieFacts> & { requestId?: number; seerrServiceId?: string; quiet?: boolean })
      | null;
    const prev = (row.assessment as MovieAssessment | null) ?? undefined;
    const requestId = stored?.request?.requestId ?? stored?.requestId;
    const seerrServiceId = stored?.request?.seerrServiceId ?? stored?.seerrServiceId;
    if (!requestId || !seerrServiceId || !stored?.tmdbId) {
      await this.db
        .update(t.watches)
        .set({ nextCheckAt: null, checkError: "This watch is missing its request." })
        .where(eq(t.watches.id, row.id));
      return;
    }
    let facts: MovieFacts;
    try {
      facts = await this.movies.facts(
        { seerrServiceId, requestId, tmdbId: stored.tmdbId },
        settings.region,
      );
    } catch (error) {
      // Seerr did not answer: keep what was known, say so on the watch, and try again later.
      await this.db
        .update(t.watches)
        .set({
          lastCheckedAt: now.toISOString(),
          checkError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          nextCheckAt: new Date(now.getTime() + RETRY_MINUTES * 60_000).toISOString(),
        })
        .where(eq(t.watches.id, row.id));
      return;
    }
    const today = this.today();
    const next = assessMovie(facts, now, today, prev, settings.overdueAfterDays * 24);
    const quiet = Boolean(stored.quiet) && !prev;
    const drafts = movieEvents(facts.title, prev, next, today, { quiet });
    await this.db
      .update(t.watches)
      .set({
        title: facts.title,
        state: next.state,
        facts,
        assessment: next,
        updatedAt: now.toISOString(),
        lastCheckedAt: now.toISOString(),
        checkError: null,
        nextCheckAt:
          next.nextCheckMinutes === null || row.dismissedAt
            ? null
            : new Date(now.getTime() + next.nextCheckMinutes * 60_000).toISOString(),
      })
      .where(eq(t.watches.id, row.id));
    await this.record(row.id, drafts, settings);
  }

  /** Adds news to the history once each, and sends what the owner wants now (or holds it). */
  private async record(watchId: string, drafts: WatchEventDraft[], settings: ReleaseWatchSettings) {
    if (!drafts.length) return;
    const row = await this.db.select().from(t.watches).where(eq(t.watches.id, watchId)).get();
    if (!row) return;
    const told = new Set(row.told);
    const fresh = drafts.filter((d) => !told.has(d.key));
    if (!fresh.length) return;
    const at = this.now().toISOString();
    const snoozed = Boolean(row.snoozedUntil && row.snoozedUntil > at);
    const quiet = await this.announcer.quietHours();
    for (const d of fresh) {
      let sent: WatchHistoryEntry["sent"] = "none";
      if (d.notify) {
        if (!settings.notify[d.notify] || row.dismissedAt) sent = "off";
        else if (snoozed || quiet) sent = "held";
        else
          sent =
            (await this.announcer.announceRelease(watchId, {
              title: d.title,
              text: d.text,
              problem: d.type === "problem",
            })) === "sent"
              ? "sent"
              : "off";
      }
      await this.db.insert(t.watchEvents).values({
        id: randomUUID(),
        watchId,
        at,
        type: d.type,
        title: d.title,
        text: d.text,
        notify: d.notify ?? null,
        sent,
      });
      told.add(d.key);
    }
    await this.db
      .update(t.watches)
      .set({ told: [...told] })
      .where(eq(t.watches.id, watchId));
  }

  /** News held by quiet hours or a snooze goes out once both are over, if still wanted. */
  private async sendHeld(settings: ReleaseWatchSettings) {
    if (await this.announcer.quietHours()) return;
    const at = this.now().toISOString();
    const held = await this.db
      .select()
      .from(t.watchEvents)
      .where(eq(t.watchEvents.sent, "held"))
      .orderBy(asc(t.watchEvents.at));
    for (const e of held) {
      const w = await this.db.select().from(t.watches).where(eq(t.watches.id, e.watchId)).get();
      if (!w) continue;
      if (w.snoozedUntil && w.snoozedUntil > at) continue;
      const wanted =
        !w.dismissedAt &&
        e.notify &&
        settings.notify[e.notify as keyof ReleaseWatchSettings["notify"]];
      const sent = wanted
        ? (await this.announcer.announceRelease(w.id, {
            title: e.title,
            text: e.text,
            problem: e.type === "problem",
          })) === "sent"
          ? "sent"
          : "off"
        : "off";
      await this.db.update(t.watchEvents).set({ sent }).where(eq(t.watchEvents.id, e.id));
    }
  }

  /* ---------- What the page and the AI see ---------- */

  private async toWatch(row: Row, services?: (typeof t.services.$inferSelect)[]): Promise<Watch> {
    const a = (row.assessment as MovieAssessment | null) ?? {
      dateStatus: "not-announced" as const,
      doing: "Not checked yet.",
      nextCheckMinutes: 0,
    };
    const f = row.facts as Partial<MovieFacts> | null;
    const latest = await this.db
      .select()
      .from(t.watchEvents)
      .where(eq(t.watchEvents.watchId, row.id))
      .orderBy(desc(t.watchEvents.at))
      .limit(1)
      .get();
    const known = Boolean(row.assessment) || row.state === "gone";
    const state = (known ? row.state : "unannounced") as MovieWatchState;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      ...(f?.year ? { year: f.year } : {}),
      state,
      stateLabel: known ? MOVIE_STATE_LABEL[state] : "Checking",
      view: viewOf(state, Boolean(row.dismissedAt)),
      ...(f?.request?.requestedAt ? { requestedAt: f.request.requestedAt } : {}),
      ...(f?.request?.requestedBy ? { requestedBy: f.request.requestedBy } : {}),
      assessment: { state, ...a } as MovieAssessment,
      links: f?.request && f.radarr ? await this.movies.links(f as MovieFacts, services) : {},
      ...(row.lastCheckedAt ? { lastCheckedAt: row.lastCheckedAt } : {}),
      ...(row.nextCheckAt ? { nextCheckAt: row.nextCheckAt } : {}),
      ...(row.checkError ? { checkError: row.checkError } : {}),
      ...(row.snoozedUntil && row.snoozedUntil > this.now().toISOString()
        ? { snoozedUntil: row.snoozedUntil }
        : {}),
      ...(row.dismissedAt ? { dismissedAt: row.dismissedAt } : {}),
      ...(latest ? { latest: { at: latest.at, title: latest.title, text: latest.text } } : {}),
    };
  }

  async list(view?: WatchView): Promise<Watch[]> {
    const rows = await this.db.select().from(t.watches).orderBy(desc(t.watches.createdAt));
    const services = await this.db.select().from(t.services);
    const all = await Promise.all(rows.map((r) => this.toWatch(r, services)));
    const order = (w: Watch) => w.assessment.homeDate ?? "9999";
    // Soonest release first; not announced yet last.
    return all
      .filter((w) => !view || w.view === view)
      .sort((a, b) => order(a).localeCompare(order(b)) || a.title.localeCompare(b.title));
  }

  async get(id: string): Promise<Watch & { history: WatchHistoryEntry[] }> {
    const row = await this.row(id);
    const history = await this.db
      .select()
      .from(t.watchEvents)
      .where(eq(t.watchEvents.watchId, id))
      .orderBy(desc(t.watchEvents.at));
    return {
      ...(await this.toWatch(row)),
      history: history.map((e) => ({
        at: e.at,
        type: e.type,
        title: e.title,
        text: e.text,
        sent: e.sent,
      })),
    };
  }

  private async row(id: string): Promise<Row> {
    const row = await this.db.select().from(t.watches).where(eq(t.watches.id, id)).get();
    if (!row) throw new NotFoundError("That release watch does not exist.");
    return row;
  }

  /** Nothing is sent about this watch until then; checks go on. */
  async snooze(id: string, days: number) {
    if (!Number.isInteger(days) || days < 1 || days > 90)
      throw new InvalidRequestError("Snooze for 1 to 90 days.");
    await this.row(id);
    const until = new Date(this.now().getTime() + days * 86_400_000).toISOString();
    await this.db
      .update(t.watches)
      .set({ snoozedUntil: until, updatedAt: this.now().toISOString() })
      .where(eq(t.watches.id, id));
    await this.note(
      id,
      "snoozed",
      "Snoozed",
      `Nothing is sent about it for ${days} day${days === 1 ? "" : "s"}.`,
    );
  }

  async unsnooze(id: string) {
    await this.row(id);
    await this.db.update(t.watches).set({ snoozedUntil: null }).where(eq(t.watches.id, id));
  }

  /** Stops checking and sending; the watch stays under Dismissed and can be brought back. */
  async dismiss(id: string) {
    await this.row(id);
    const at = this.now().toISOString();
    await this.db
      .update(t.watches)
      .set({ dismissedAt: at, nextCheckAt: null, updatedAt: at })
      .where(eq(t.watches.id, id));
    await this.note(id, "dismissed", "Dismissed", "Hearth stopped watching it.");
  }

  async restore(id: string) {
    const row = await this.row(id);
    const at = this.now().toISOString();
    const finished = row.state === "arrived" || row.state === "gone";
    await this.db
      .update(t.watches)
      .set({ dismissedAt: null, nextCheckAt: finished ? null : at, updatedAt: at })
      .where(eq(t.watches.id, id));
    await this.note(id, "restored", "Brought back", "Hearth is watching it again.");
  }

  /** Checks one watch now (the owner pressed Check now). */
  async checkNow(id: string) {
    const row = await this.row(id);
    if (row.dismissedAt) throw new InvalidRequestError("Bring it back first.");
    await this.checkOne(row, await this.settings());
    return this.get(id);
  }

  private async note(id: string, type: string, title: string, text: string) {
    await this.db.insert(t.watchEvents).values({
      id: randomUUID(),
      watchId: id,
      at: this.now().toISOString(),
      type,
      title,
      text,
      notify: null,
      sent: "none",
    });
  }
}
