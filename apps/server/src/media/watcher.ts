import { and, desc, eq, lte } from "drizzle-orm";
import {
  anyKindOn,
  announceTitle,
  BATCHED_KINDS,
  checkLine,
  discordAnnouncement,
  discordDigest,
  groupForBatch,
  isSensitive,
  KIND_NAMES,
  kindsFor,
  LIBRARY_KINDS,
  mediaAnnounceSettings,
  pickLine,
  runtimeText,
  toneFor,
  type AnnounceItem,
  type AnnounceKind,
  type AnnounceLine,
  type MediaAnnounceSettings,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { getSetting, setSetting } from "../store/settings";
import type { Attachment, Message } from "../notify/providers";
import {
  baselineKey,
  MEDIA_APP_NAMES,
  MediaArrivals,
  type Arrival,
  type MediaApp,
  type ReadPart,
  type ServerRead,
} from "./arrivals";
import { BASELINE_LIMIT } from "./sources";
import { makeBanner } from "./banner";

/**
 * Media announcements, from arrival to Discord: every few minutes each Plex and Jellyfin server is
 * read (its newest items), new arrivals are found (media/arrivals.ts), the owner's rules pick what
 * is announced, and each one is queued once per destination (media_deliveries). Sending is
 * separate from finding: a Discord outage never touches the media servers, a retry never posts
 * twice (one row per title and destination), and the queue survives restarts.
 */

export interface WatchedServer {
  serviceId: string;
  server: MediaApp;
  name: string;
  /** What it is read for: movies and shows, the other library kinds, or both (Plex, Jellyfin). */
  parts: ReadPart[];
}

export interface MediaWatcherDeps {
  servers(): Promise<WatchedServer[]>;
  read(serviceId: string, limit?: number, part?: ReadPart): Promise<ServerRead>;
  art(
    serviceId: string,
    path: string,
    shape: "poster" | "backdrop",
  ): Promise<{ bytes: Buffer; type: string }>;
  trailer(tmdbId: string): Promise<string | undefined>;
  channels(): Promise<{ id: string; name: string }[]>;
  send(
    channelId: string,
    rich: { payload: Record<string, unknown>; files: Attachment[] },
    plain: Message,
    opts?: { test?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string; retryAfterMs?: number }>;
  /** The name Ember goes by on this Hearth (her line is signed with it). */
  aiName?: () => Promise<string | undefined>;
  /** "Let Ember write it": one short answer from Ember, no tools (within today's AI budget). */
  write?: (system: string, prompt: string) => Promise<string>;
  now?: () => Date;
  /** Local time for quiet hours and the roundup hour (tests set it). */
  localTime?: () => Date;
  /** For tests: the dice Ember's line is picked with. */
  rand?: () => number;
}

const MAX_ATTEMPTS = 5;
/** Waits between tries: 1 min, 5 min, 15 min, 1 h. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const QUIET_FROM = 22;
const QUIET_UNTIL = 7;
/**
 * Music, books, comics and podcasts arrive in bursts (a discography, a comic run, a backlog):
 * they wait this long after arriving, so a burst goes out as one message ("6 new albums").
 */
export const GATHER_MS = 15 * 60_000;
/**
 * A library item added longer ago than this is not news: an app read again after a long time
 * (or a kind turned on after months off) never announces old additions.
 */
export const STALE_MS = 2 * 24 * 3600_000;
const isLibrary = (k: AnnounceKind) => (LIBRARY_KINDS as AnnounceKind[]).includes(k);
/** How long Ember gets to write a line before the written set is used. */
const WRITE_TIMEOUT_MS = 45_000;

/** Ember's brief for writing one line herself. Her persona comes with her own instructions. */
export const WRITE_SYSTEM = [
  "You write one short line that sits at the top of a post announcing something new in a home media library, read by the owner's friends and family.",
  "Reply with the line only: one sentence, under 100 characters, no quotes, no emoji, no hashtags, no links, no long dashes.",
  "Be warm and fitting to the title. Never mention who asked for it or any person in the household. Never mock the title, its genre or anyone who likes it.",
  "Never joke about health, religion, sexuality, self-help or children's content.",
].join(" ");

export interface DeliveryRow {
  key: string;
  title: string;
  kind: string;
  channelId: string;
  channel: string;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  error?: string;
  dueAt: string;
  sentAt?: string;
}

export class MediaWatcher {
  readonly arrivals: MediaArrivals;
  private running: Promise<void> | null = null;

  constructor(
    private readonly handle: DbHandle,
    private readonly deps: MediaWatcherDeps,
  ) {
    this.arrivals = new MediaArrivals(handle, () => this.now());
  }

  private get db() {
    return this.handle.db;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private local() {
    return this.deps.localTime?.() ?? new Date();
  }

  async settings(): Promise<MediaAnnounceSettings> {
    return mediaAnnounceSettings(await getSetting(this.db, "media_announce"));
  }

  async saveSettings(s: MediaAnnounceSettings) {
    await setSetting(this.db, "media_announce", mediaAnnounceSettings(s));
  }

  /** One check: read each server, find arrivals, queue them, send what is due. Never overlaps. */
  tick(): Promise<void> {
    this.running ??= (async () => {
      try {
        await this.detect();
        await this.flush();
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async detect() {
    const s = await this.settings();
    const done = await this.arrivals.baselined();
    // Once per server: read the whole library again only to learn each movie's file name, so a
    // movie one server recognized and the other did not becomes one title (nothing is announced).
    const linked = (await getSetting(this.db, "media_files_linked")) ?? {};
    const servers = await this.deps.servers();
    for (const server of servers) {
      if (!server.parts.includes("video")) continue;
      if (!done[server.serviceId] || linked[server.serviceId]) continue;
      try {
        const all = await this.deps.read(server.serviceId, BASELINE_LIMIT);
        await this.arrivals.take(all, s.dedupe, { linkOnly: true });
        linked[server.serviceId] = this.now().toISOString();
        await setSetting(this.db, "media_files_linked", linked);
      } catch {
        // Tried again next time.
      }
    }
    // Music, books, comics, games and podcasts are read only while some destination wants one.
    const library = anyKindOn(s, LIBRARY_KINDS);
    for (const server of servers) {
      if (server.parts.includes("library") && library) {
        const first = !done[baselineKey(server.serviceId, "library")];
        try {
          const read = await this.deps.read(
            server.serviceId,
            first ? BASELINE_LIMIT : undefined,
            "library",
          );
          await this.queue(await this.arrivals.take({ ...read, part: "library" }, s.dedupe), s);
        } catch {
          // Read next time.
        }
      }
      if (!server.parts.includes("video")) continue;
      let read: ServerRead;
      try {
        read = await this.deps.read(
          server.serviceId,
          done[server.serviceId] ? undefined : BASELINE_LIMIT,
        );
      } catch {
        continue; // A server that is down is read next time; nothing is lost.
      }
      const arrived = await this.arrivals.take(read, s.dedupe);
      if (!done[server.serviceId]) {
        // A baseline read already knows every file's name.
        linked[server.serviceId] = this.now().toISOString();
        await setSetting(this.db, "media_files_linked", linked);
      }
      await this.queue(arrived, s);
    }
  }

  /** Whether the owner's rules announce this arrival (to one destination, when given). */
  wanted(a: Arrival, s: MediaAnnounceSettings, channelId?: string): boolean {
    if (!kindsFor(s, channelId)[a.kind]) return false;
    if (
      isLibrary(a.kind) &&
      a.addedAt &&
      this.now().getTime() - new Date(a.addedAt).getTime() > STALE_MS
    )
      return false;
    if (
      s.libraries.length &&
      !a.where.some((w) => s.libraries.includes(`${w.serviceId}/${w.libraryId}`))
    )
      return false;
    const title = [a.title, a.show, a.seriesName, ...(a.creators ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (s.exclude.some((x) => x.trim() && title.includes(x.trim().toLowerCase()))) return false;
    return true;
  }

  /** When an announcement may go out: now, the next roundup, or the end of quiet hours. */
  private dueAt(s: MediaAnnounceSettings): Date {
    const now = this.now();
    const local = this.local();
    const offset = now.getTime() - local.getTime();
    const at = (d: Date) => new Date(d.getTime() + offset);
    if (s.mode === "digest") {
      const next = new Date(local);
      next.setHours(s.digestHour, 0, 0, 0);
      if (next <= local) next.setDate(next.getDate() + 1);
      return at(next);
    }
    const h = local.getHours();
    if (s.quietHours && (h >= QUIET_FROM || h < QUIET_UNTIL)) {
      const morning = new Date(local);
      if (h >= QUIET_FROM) morning.setDate(morning.getDate() + 1);
      morning.setHours(QUIET_UNTIL, 0, 0, 0);
      return at(morning);
    }
    return now;
  }

  private async queue(arrived: Arrival[], s: MediaAnnounceSettings) {
    if (!arrived.length) return;
    const channels = await this.deps.channels();
    const due = this.dueAt(s);
    // A burst-prone library kind waits a little, so the rest of its burst joins it.
    const gathered = new Date(Math.max(due.getTime(), this.now().getTime() + GATHER_MS));
    const created = this.now().toISOString();
    for (const a of arrived)
      for (const c of channels) {
        if (!this.wanted(a, s, c.id)) continue;
        const at = isLibrary(a.kind) && BATCHED_KINDS.includes(a.kind) ? gathered : due;
        // One row per title and destination: a second sighting changes nothing.
        await this.db
          .insert(t.mediaDeliveries)
          .values({
            key: a.key,
            channelId: c.id,
            status: "pending",
            attempts: 0,
            dueAt: at.toISOString(),
            createdAt: created,
          })
          .onConflictDoNothing();
      }
  }

  /**
   * Ember's one-liner for a message to one destination, in its tone, never the line it got last
   * time. Undefined when the tone is Off.
   */
  async line(
    subject: { item: AnnounceItem } | { batch: AnnounceKind; items: AnnounceItem[] },
    s: MediaAnnounceSettings,
    channelId?: string,
    /** remember: a real send (her last line); write: she may write it herself (sends, tests). */
    opts: { remember?: boolean; write?: boolean } = {},
  ): Promise<AnnounceLine | undefined> {
    const tone = toneFor(s, channelId);
    if (tone === "off") return undefined;
    const aiName = (await this.deps.aiName?.().catch(() => undefined)) || "Ember";
    if (opts.write && s.emberWrites) {
      const own = await this.written(subject, tone, s);
      if (own) return { text: own, aiName };
    }
    const lastLines: Record<string, string> = (await getSetting(this.db, "media_last_line")) ?? {};
    const slot = channelId ?? "-";
    const picked = pickLine(subject, tone, {
      ...(lastLines[slot] ? { last: lastLines[slot] } : {}),
      ...(this.deps.rand ? { rand: this.deps.rand } : {}),
    });
    if (!picked) return undefined;
    if (opts.remember)
      await setSetting(this.db, "media_last_line", { ...lastLines, [slot]: picked.id });
    return { text: picked.text, aiName };
  }

  /**
   * A line Ember writes herself, within the day's allowance, or undefined (then the written set
   * is used). Sensitive titles never go to her: they get a plain written line. What she writes
   * is checked like any line (length, no names, nothing mocking, no links, no long dashes).
   */
  private async written(
    subject: { item: AnnounceItem } | { batch: AnnounceKind; items: AnnounceItem[] },
    tone: "playful" | "gentle",
    s: MediaAnnounceSettings,
  ): Promise<string | undefined> {
    if (!this.deps.write) return undefined;
    const items = "item" in subject ? [subject.item] : subject.items;
    if (items.some((i) => isSensitive(i))) return undefined;
    const l = this.local();
    const day = `${l.getFullYear()}-${l.getMonth() + 1}-${l.getDate()}`;
    const used = (await getSetting(this.db, "media_ember_lines")) ?? { day, n: 0 };
    const n = used.day === day ? used.n : 0;
    if (n >= Math.max(0, s.emberWritesPerDay)) return undefined;
    // Every try counts, written or not, so a bad day never costs more than the allowance.
    await setSetting(this.db, "media_ember_lines", { day, n: n + 1 });
    const about =
      "item" in subject
        ? [
            `A new ${KIND_NAMES[subject.item.kind][0]}: ${announceTitle(subject.item)}.`,
            subject.item.genres?.length
              ? `Genres: ${subject.item.genres.slice(0, 3).join(", ")}.`
              : "",
          ]
        : [
            `${subject.items.length} new ${KIND_NAMES[subject.batch][1]} at once, among them: ${subject.items
              .slice(0, 5)
              .map((i) => announceTitle(i))
              .join("; ")}.`,
          ];
    const prompt = [
      ...about,
      tone === "gentle" ? "Tone: gentle, warm and plain." : "Tone: playful and friendly.",
      "Write the line.",
    ]
      .filter(Boolean)
      .join("\n");
    const text = await Promise.race([
      this.deps.write(WRITE_SYSTEM, prompt).catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), WRITE_TIMEOUT_MS).unref?.()),
    ]);
    return text ? checkLine(text) : undefined;
  }

  /** Everything an announcement shows, with a verified trailer when one exists. */
  async item(a: Arrival): Promise<AnnounceItem> {
    let trailer = a.trailers?.[0];
    if (!trailer && a.kind === "movie" && a.ids.tmdb)
      trailer = await this.deps.trailer(a.ids.tmdb).catch(() => undefined);
    return {
      kind: a.kind,
      title: a.title,
      ...(a.creators?.length ? { creators: a.creators } : {}),
      ...(a.narrators?.length ? { narrators: a.narrators } : {}),
      ...(a.seriesName ? { seriesName: a.seriesName } : {}),
      ...(a.seriesIndex !== undefined ? { seriesIndex: a.seriesIndex } : {}),
      ...(a.tracks ? { tracks: a.tracks } : {}),
      ...(a.pages ? { pages: a.pages } : {}),
      ...(a.platform ? { platform: a.platform } : {}),
      ...(a.show ? { show: a.show } : {}),
      ...(a.year ? { year: a.year } : {}),
      ...(a.season !== undefined ? { season: a.season } : {}),
      ...(a.episode !== undefined ? { episode: a.episode } : {}),
      ...(a.episodeTitle ? { episodeTitle: a.episodeTitle } : {}),
      ...(a.overview ? { overview: a.overview } : {}),
      ...(a.genres ? { genres: a.genres } : {}),
      ...(a.runtimeMin ? { runtimeMin: a.runtimeMin } : {}),
      ...(a.rating ? { rating: a.rating } : {}),
      ...(a.contentRating ? { contentRating: a.contentRating } : {}),
      ...(trailer ? { trailer } : {}),
      availableIn: [...new Set(a.where.map((w) => MEDIA_APP_NAMES[w.server] ?? w.serverName))],
    };
  }

  /** The pictures to attach: fetched through Hearth from the media server, never linked. */
  async files(
    a: Arrival,
    s: MediaAnnounceSettings,
  ): Promise<{ files: Attachment[]; poster?: string; backdrop?: string; banner?: string }> {
    if (!s.show.art) return { files: [] };
    const files: Attachment[] = [];
    const out: { poster?: string; backdrop?: string } = {};
    const template = s.looks[a.kind].template;
    const bytes: { poster?: Buffer; backdrop?: Buffer } = {};
    for (const shape of template === "streaming" || template === "banner"
      ? (["backdrop", "poster"] as const)
      : (["poster"] as const)) {
      // Each server that has this picture, in turn: one that is down or gone does not lose it.
      let img: Awaited<ReturnType<MediaWatcherDeps["art"]>> | undefined;
      for (const w of a.where) {
        const path = shape === "poster" ? w.poster : w.backdrop;
        if (!path) continue;
        img = await this.deps.art(w.serviceId, path, shape).catch(() => undefined);
        if (img) break;
      }
      if (!img) continue;
      const name = `${shape}.${img.type.includes("png") ? "png" : img.type.includes("webp") ? "webp" : "jpg"}`;
      files.push({ name, type: img.type, bytes: img.bytes });
      out[shape] = name;
      bytes[shape] = img.bytes;
      if (shape === "backdrop" && template !== "banner") break; // One wide picture is enough.
    }
    // Banner: one picture with the heading, title, details and poster on the backdrop. When it
    // cannot be drawn on this machine, the backdrop goes as it is (the Streaming look).
    if (template === "banner" && (bytes.poster || bytes.backdrop)) {
      const item = await this.item(a);
      const where =
        s.show.availability && item.availableIn?.length
          ? `Now in ${item.availableIn.join(" and ")}`
          : "Now in your library";
      const png = await makeBanner({
        title: announceTitle({ ...item, year: undefined }),
        ...(item.year ? { year: item.year } : {}),
        meta: [
          s.show.genre && item.genres?.length ? item.genres.slice(0, 3).join(", ") : undefined,
          s.show.runtime && item.kind === "movie" ? runtimeText(item.runtimeMin) : undefined,
          s.show.rating && item.contentRating ? item.contentRating : undefined,
          s.show.rating && item.rating ? `★ ${item.rating.toFixed(1)}/10` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        when: where,
        foot: [s.branding],
        eyebrow: s.looks[a.kind].heading || "Just added",
        ...(bytes.poster ? { poster: bytes.poster } : {}),
        ...(bytes.backdrop ? { backdrop: bytes.backdrop } : {}),
      }).catch(() => undefined);
      if (png)
        return {
          files: [{ name: "banner.png", type: "image/png", bytes: png }],
          banner: "banner.png",
        };
    }
    return { files, ...out };
  }

  private plain(
    item: AnnounceItem,
    s: MediaAnnounceSettings,
    test = false,
    line?: AnnounceLine,
  ): Message {
    return {
      title: `${test ? "[Test] " : ""}${s.looks[item.kind].heading}: ${announceTitle(item)}`,
      lines: [
        ...(line ? [`${line.aiName}: ${line.text}`] : []),
        ...(s.show.synopsis && item.overview ? [item.overview] : []),
        ...(s.show.trailer && item.trailer ? [`Trailer: ${item.trailer}`] : []),
        ...(test ? ["TEST: not a real new arrival"] : []),
      ],
      severity: "info",
    };
  }

  /**
   * The message for one title, as the designer previews it and the destination receives it, with
   * Ember's line in that destination's tone. A preview or test does not count as her last line.
   */
  async compose(
    key: string,
    s: MediaAnnounceSettings,
    test = false,
    channelId?: string,
    /** Only a real send counts as the destination's last line (a preview or test never does). */
    remember = false,
  ) {
    const a = await this.arrivals.get(key);
    if (!a) throw new Error("That title is not in Hearth's list any more.");
    const item = await this.item(a);
    const pics = await this.files(a, s);
    const line = await this.line({ item }, s, channelId, { remember, write: remember || test });
    return {
      item,
      line,
      payload: discordAnnouncement(item, s, pics, {
        test,
        ...(line ? { line } : {}),
      }) as unknown as Record<string, unknown>,
      files: pics.files,
      plain: this.plain(item, s, test, line),
    };
  }

  /** One message for a burst of one kind ("6 new albums"), with Ember's line for it. */
  private async composeBatch(
    kind: AnnounceKind,
    items: AnnounceItem[],
    s: MediaAnnounceSettings,
    channelId: string,
  ) {
    const line = await this.line({ batch: kind, items }, s, channelId, {
      remember: true,
      write: true,
    });
    const post = discordDigest(items, s, { batch: kind, ...(line ? { line } : {}) });
    return {
      payload: post as unknown as Record<string, unknown>,
      plain: {
        title: post.embeds[0]?.title ?? `${items.length} new`,
        lines: [
          ...(line ? [`${line.aiName}: ${line.text}`] : []),
          ...items.map((i) => announceTitle(i)),
        ],
        severity: "info" as const,
      },
    };
  }

  /** Sends what is due: one message each, or one roundup per destination in roundup mode. */
  async flush() {
    const s = await this.settings();
    const now = this.now();
    const due = await this.db
      .select()
      .from(t.mediaDeliveries)
      .where(
        and(
          eq(t.mediaDeliveries.status, "pending"),
          lte(t.mediaDeliveries.dueAt, now.toISOString()),
        ),
      );
    if (!due.length) return;
    const byChannel = new Map<string, typeof due>();
    for (const d of due) byChannel.set(d.channelId, [...(byChannel.get(d.channelId) ?? []), d]);
    for (const [channelId, rows] of byChannel) {
      if (s.mode === "digest" && rows.length > 1) {
        const items: AnnounceItem[] = [];
        for (const r of rows) {
          const a = await this.arrivals.get(r.key);
          if (a) items.push(await this.item(a));
        }
        const result = await this.deps.send(
          channelId,
          { payload: discordDigest(items, s) as unknown as Record<string, unknown>, files: [] },
          {
            title: `${items.length} new in the library`,
            lines: items.map((i) => announceTitle(i)),
            severity: "info",
          },
        );
        for (const r of rows) await this.settle(r, result);
        if (!result.ok && result.retryAfterMs) break;
        continue;
      }
      // Several of a burst-prone library kind due together go as one message; the rest one each.
      const known: { row: (typeof rows)[number]; item: AnnounceItem }[] = [];
      const lone: typeof rows = [];
      for (const r of rows) {
        const a = await this.arrivals.get(r.key);
        if (a && isLibrary(a.kind)) known.push({ row: r, item: await this.item(a) });
        else lone.push(r);
      }
      const rowOf = new Map(known.map((k) => [k.item, k.row]));
      const messages = groupForBatch(known.map((k) => k.item));
      const batches = messages.filter(
        (m): m is { batch: AnnounceKind; items: AnnounceItem[] } => "batch" in m,
      );
      for (const m of messages) if ("item" in m) lone.push(rowOf.get(m.item)!);
      let slowDown = false;
      for (const b of batches) {
        let result: { ok: true } | { ok: false; error: string; retryAfterMs?: number };
        try {
          const m = await this.composeBatch(b.batch, b.items, s, channelId);
          result = await this.deps.send(channelId, { payload: m.payload, files: [] }, m.plain);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        for (const i of b.items) await this.settle(rowOf.get(i)!, result);
        if (!result.ok && result.retryAfterMs) {
          slowDown = true;
          break;
        }
      }
      if (slowDown) continue;
      for (const r of lone) {
        let result: { ok: true } | { ok: false; error: string; retryAfterMs?: number };
        try {
          const m = await this.compose(r.key, s, false, channelId, true);
          result = await this.deps.send(channelId, { payload: m.payload, files: m.files }, m.plain);
        } catch (e) {
          result = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        await this.settle(r, result);
        // Discord asked to slow down: leave the rest for its next turn.
        if (!result.ok && result.retryAfterMs) break;
      }
    }
  }

  private async settle(
    r: typeof t.mediaDeliveries.$inferSelect,
    result: { ok: true } | { ok: false; error: string; retryAfterMs?: number },
  ) {
    const now = this.now();
    const where = and(
      eq(t.mediaDeliveries.key, r.key),
      eq(t.mediaDeliveries.channelId, r.channelId),
    );
    if (result.ok) {
      await this.db
        .update(t.mediaDeliveries)
        .set({ status: "sent", attempts: r.attempts + 1, sentAt: now.toISOString(), error: null })
        .where(where);
      return;
    }
    // A rate limit is not a failed attempt; anything else counts, and stops after a few.
    const attempts = result.retryAfterMs ? r.attempts : r.attempts + 1;
    const wait = result.retryAfterMs ?? BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
    await this.db
      .update(t.mediaDeliveries)
      .set({
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        error: result.error,
        dueAt: new Date(now.getTime() + wait).toISOString(),
      })
      .where(where);
  }

  /** Try a failed announcement again, now. */
  async retry(key: string, channelId: string) {
    await this.db
      .update(t.mediaDeliveries)
      .set({ status: "pending", attempts: 0, error: null, dueAt: this.now().toISOString() })
      .where(and(eq(t.mediaDeliveries.key, key), eq(t.mediaDeliveries.channelId, channelId)));
    await this.flush();
  }

  /** A test to one destination, clearly marked; nothing is recorded as announced. */
  async test(channelId: string, key: string, s?: MediaAnnounceSettings) {
    const m = await this.compose(key, s ?? (await this.settings()), true, channelId);
    return this.deps.send(channelId, { payload: m.payload, files: m.files }, m.plain, {
      test: true,
    });
  }

  /** The newest deliveries, for the history in Notifications. */
  async history(limit = 30): Promise<DeliveryRow[]> {
    const rows = await this.db
      .select()
      .from(t.mediaDeliveries)
      .orderBy(desc(t.mediaDeliveries.createdAt))
      .limit(limit);
    const names = new Map((await this.deps.channels()).map((c) => [c.id, c.name]));
    const out: DeliveryRow[] = [];
    for (const r of rows) {
      const title = await this.db
        .select()
        .from(t.mediaTitles)
        .where(eq(t.mediaTitles.key, r.key))
        .get();
      out.push({
        key: r.key,
        title: title
          ? announceTitle({
              ...(title.data as unknown as AnnounceItem),
              kind: title.kind,
            } as AnnounceItem)
          : r.key,
        kind: title?.kind ?? "movie",
        channelId: r.channelId,
        channel: names.get(r.channelId) ?? r.channelId,
        status: r.status,
        attempts: r.attempts,
        ...(r.error ? { error: r.error } : {}),
        dueAt: r.dueAt,
        ...(r.sentAt ? { sentAt: r.sentAt } : {}),
      });
    }
    return out;
  }
}

/** The watcher on Hearth's own apps (Plex, Jellyfin, Radarr) and notification destinations. */
export function mediaWatcherFor(
  handle: DbHandle,
  apps: import("../apps/service").AppWatcher,
  notifier: import("../notify/notifier").Notifier,
  write?: MediaWatcherDeps["write"],
): MediaWatcher {
  return new MediaWatcher(handle, {
    servers: () => apps.mediaServers(),
    read: (id, limit, part) => apps.mediaRead(id, limit, part),
    aiName: async () => (await getSetting(handle.db, "ai_name")) || undefined,
    ...(write ? { write } : {}),
    art: (id, p, shape) => apps.mediaArt(id, p, shape),
    trailer: (tmdb) => apps.radarrTrailer(tmdb),
    channels: async () => (await notifier.mediaChannels()).map((c) => ({ id: c.id, name: c.name })),
    send: (channelId, rich, plain, opts) => notifier.sendMedia(channelId, rich, plain, opts),
  });
}
