import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  REMINDER_KINDS,
  movieNightInvitation,
  movieNightText,
  type AnnounceItem,
  type MovieNightLook,
  SUGGESTED_PLACES,
  invitationHeading,
  runtimeText,
  type JoinLink,
  type MovieNight,
  type ReminderKind,
  type WatchPlace,
  type ChannelLink,
  channelIdFrom,
  channelName,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { Attachment, Message } from "../notify/providers";
import { InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting, setSetting } from "../store/settings";
import type { Arrival } from "./arrivals";
import { makeBanner } from "./banner";
import type { MediaWatcher } from "./watcher";

/**
 * Movie nights (FEATURE_CHECKLIST 40, MOVIE_NIGHTS_FEASIBILITY.md): a library title at a time,
 * posted to the destinations the owner picks among those that get "New in your library" (so only
 * friends-and-family style channels, never alert channels). On Discord the invitation is one
 * message, edited in place when the time, guests or plans change; reminders are new messages, each
 * sent once. Nothing here starts playback: friends get a link to the title on the server's public
 * address (and the SyncPlay group name for Jellyfin).
 */

export interface MovieNightsDeps {
  watcher: Pick<MediaWatcher, "item" | "files" | "settings"> & {
    arrivals: { get(key: string): Promise<Arrival | undefined> };
  };
  channels(): Promise<{ id: string; name: string }[]>;
  send(
    channelId: string,
    rich: { payload: Record<string, unknown>; files: Attachment[]; components?: unknown[] },
    plain: Message,
    opts: { event: string; keep?: boolean; edit?: string },
  ): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  /** Links to the title on each server's public address; none for a server without one. */
  join(where: Arrival["where"]): Promise<JoinLink[]>;
  now?: () => Date;
}

export interface NightInput {
  key: string;
  startsAt: string;
  timeZone: string;
  spots: number | null;
  note: string;
  /** The host's own "Where to watch"; empty or missing uses the links Hearth finds. */
  watch?: string;
  /** A watch-party room code (Plezy Watch Together and the like); often added later. */
  code?: string;
  /** How the invitation looks on Discord; Cinematic when not said. */
  look?: MovieNightLook;
  reminders: ReminderKind[];
  channels: string[];
}

type Row = typeof t.movieNights.$inferSelect;

/** How long after the start a night counts as over (a long movie, a late start). */
const OVER_AFTER_MS = 4 * 60 * 60_000;

export class MovieNights {
  constructor(
    private readonly handle: DbHandle,
    private readonly deps: MovieNightsDeps,
  ) {}

  private get db() {
    return this.handle.db;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async row(id: string): Promise<Row> {
    const r = await this.db.select().from(t.movieNights).where(eq(t.movieNights.id, id)).get();
    if (!r) throw new NotFoundError("That movie night is not there any more.");
    return r;
  }

  private view(r: Row, names: Map<string, string>): MovieNight {
    return {
      id: r.id,
      key: r.key,
      title: r.title,
      startsAt: r.startsAt,
      timeZone: r.timeZone,
      spots: r.spots ?? null,
      note: r.note,
      watch: r.watch,
      code: r.code,
      look: r.look,
      status: r.status,
      reminders: r.reminders as ReminderKind[],
      channels: r.channels,
      guests: r.guests,
      posts: r.posts.map((p) => ({
        channelId: p.channelId,
        channel: names.get(p.channelId) ?? "A removed destination",
        postedAt: p.postedAt,
        ...(p.error ? { error: p.error } : {}),
      })),
      remindersSent: r.remindersSent as ReminderKind[],
      createdAt: r.createdAt,
    };
  }

  /** Upcoming first (soonest first), then past and cancelled ones, newest first. */
  async list(): Promise<MovieNight[]> {
    const rows = await this.db.select().from(t.movieNights).orderBy(desc(t.movieNights.startsAt));
    const names = new Map((await this.deps.channels()).map((c) => [c.id, c.name]));
    const upcoming = rows.filter((r) => r.status === "scheduled").reverse();
    const rest = rows.filter((r) => r.status !== "scheduled").slice(0, 10);
    return [...upcoming, ...rest].map((r) => this.view(r, names));
  }

  private async check(input: NightInput) {
    const a = await this.deps.watcher.arrivals.get(input.key);
    if (!a) throw new InvalidRequestError("That title is not in your libraries.");
    const at = new Date(input.startsAt);
    if (Number.isNaN(at.getTime())) throw new InvalidRequestError("Choose a date and time.");
    if (at.getTime() < this.now().getTime() - 60_000)
      throw new InvalidRequestError("Choose a time that has not passed.");
    const allowed = new Set((await this.deps.channels()).map((c) => c.id));
    if (!input.channels.length)
      throw new InvalidRequestError("Choose at least one destination to invite.");
    if (input.channels.some((c) => !allowed.has(c)))
      throw new InvalidRequestError(
        "Movie nights go only to your bot or the destinations chosen for New in your library.",
      );
    return a;
  }

  /**
   * Reminders whose moment has already gone by when a night is planned: never sent (the invitation
   * just went out; "tomorrow" an hour after it would only be noise).
   */
  private passed(startsAt: string): string[] {
    const start = new Date(startsAt).getTime();
    return REMINDER_KINDS.filter((k) => this.now().getTime() >= start - k.beforeMs).map(
      (k) => k.id,
    );
  }

  async create(input: NightInput): Promise<MovieNight> {
    const a = await this.check(input);
    const id = randomUUID();
    await this.db.insert(t.movieNights).values({
      id,
      key: input.key,
      title: a.title,
      startsAt: new Date(input.startsAt).toISOString(),
      timeZone: input.timeZone,
      spots: input.spots,
      note: input.note,
      watch: input.watch?.trim() ?? "",
      code: input.code?.trim() ?? "",
      look: input.look ?? "cinematic",
      status: "scheduled",
      reminders: input.reminders,
      channels: input.channels,
      guests: [],
      posts: [],
      remindersSent: this.passed(input.startsAt),
      createdAt: this.now().toISOString(),
    });
    await this.publish(id);
    return this.get(id);
  }

  async get(id: string): Promise<MovieNight> {
    const names = new Map((await this.deps.channels()).map((c) => [c.id, c.name]));
    return this.view(await this.row(id), names);
  }

  /** A new time, spots, note or reminders: the invitation is updated where it was posted. */
  async update(
    id: string,
    patch: Partial<
      Pick<NightInput, "startsAt" | "spots" | "note" | "watch" | "code" | "look" | "reminders">
    >,
  ): Promise<MovieNight> {
    const r = await this.row(id);
    if (r.status !== "scheduled") throw new InvalidRequestError("This movie night is over.");
    const next = { ...r };
    if (patch.startsAt !== undefined) {
      const at = new Date(patch.startsAt);
      if (Number.isNaN(at.getTime()) || at.getTime() < this.now().getTime() - 60_000)
        throw new InvalidRequestError("Choose a time that has not passed.");
      next.startsAt = at.toISOString();
      // A new time: the reminders that are still ahead go out again for it.
      next.remindersSent = this.passed(next.startsAt);
    }
    if (patch.spots !== undefined) next.spots = patch.spots;
    if (patch.note !== undefined) next.note = patch.note;
    if (patch.watch !== undefined) next.watch = patch.watch.trim();
    if (patch.code !== undefined) next.code = patch.code.trim();
    if (patch.look !== undefined) next.look = patch.look;
    if (patch.reminders !== undefined) next.reminders = patch.reminders;
    await this.db
      .update(t.movieNights)
      .set({
        startsAt: next.startsAt,
        spots: next.spots,
        note: next.note,
        watch: next.watch,
        code: next.code,
        look: next.look,
        reminders: next.reminders,
        remindersSent: next.remindersSent,
      })
      .where(eq(t.movieNights.id, id));
    // Plain-text destinations only hear about a new time or a new room code, not every small edit.
    const newCode = Boolean(next.code) && next.code !== r.code;
    await this.publish(id, { plainToo: patch.startsAt !== undefined || newCode });
    return this.get(id);
  }

  async cancel(id: string): Promise<MovieNight> {
    const r = await this.row(id);
    if (r.status !== "scheduled") throw new InvalidRequestError("This movie night is over.");
    await this.db
      .update(t.movieNights)
      .set({ status: "cancelled" })
      .where(eq(t.movieNights.id, id));
    await this.publish(id, { plainToo: true });
    return this.get(id);
  }

  /** The guest list, changed by the host (friends answer themselves on your bot's posts). */
  async guests(id: string, change: { add?: string; remove?: string }): Promise<MovieNight> {
    const r = await this.row(id);
    if (r.status !== "scheduled") throw new InvalidRequestError("This movie night is over.");
    let guests = [...r.guests];
    const add = change.add?.trim();
    if (add) {
      if (guests.some((g) => g.toLowerCase() === add.toLowerCase()))
        throw new InvalidRequestError(`${add} is already on the list.`);
      if (r.spots !== null && guests.length >= r.spots)
        throw new InvalidRequestError("It is full. Add a spot first.");
      guests.push(add.slice(0, 60));
    }
    if (change.remove) guests = guests.filter((g) => g !== change.remove);
    await this.db.update(t.movieNights).set({ guests }).where(eq(t.movieNights.id, id));
    await this.publish(id);
    return this.get(id);
  }

  /**
   * A friend pressed I'm in or Can't make it under the invitation (your bot's post): the guest
   * list changes and the invitation is edited everywhere. The answer is shown only to them.
   */
  async rsvp(customId: string, name: string): Promise<{ text: string }> {
    const m = /^mn:(in|out):([\w-]+)$/.exec(customId);
    if (!m) return { text: "That button is not Hearth's." };
    const [, answer, id] = m as unknown as [string, "in" | "out", string];
    const r = await this.db.select().from(t.movieNights).where(eq(t.movieNights.id, id)).get();
    if (!r) return { text: "That movie night is not there any more." };
    if (r.status === "cancelled") return { text: "This movie night was cancelled." };
    if (r.status !== "scheduled") return { text: "This movie night is over." };
    const here = r.guests.find((g) => g.toLowerCase() === name.toLowerCase());
    if (answer === "in") {
      if (here) return { text: `You're already on the list for ${r.title}.` };
      if (r.spots !== null && r.guests.length >= r.spots)
        return { text: `Sorry, ${r.title} is full.` };
      await this.db
        .update(t.movieNights)
        .set({ guests: [...r.guests, name.slice(0, 60)] })
        .where(eq(t.movieNights.id, id));
      await this.publish(id);
      return { text: `You're in for ${r.title}. See you there!` };
    }
    if (!here) return { text: "Got it. You're not on the list." };
    await this.db
      .update(t.movieNights)
      .set({ guests: r.guests.filter((g) => g !== here) })
      .where(eq(t.movieNights.id, id));
    await this.publish(id);
    return { text: `Got it, you're off the list for ${r.title}.` };
  }

  /** The invitation, as Discord shows it (the page's preview) and as text for other kinds. */
  async compose(r: Row, opts: { reminder?: ReminderKind } = {}) {
    const a = await this.deps.watcher.arrivals.get(r.key);
    if (!a) throw new InvalidRequestError("That title is not in your libraries any more.");
    const s = await this.deps.watcher.settings();
    const item: AnnounceItem = await this.deps.watcher.item(a);
    // The invitation always has a picture: the wide one for Streaming, else the poster; Banner
    // makes one picture from both (and is Streaming if it cannot be made on this machine).
    const art = (template: "cinematic" | "streaming") =>
      this.deps.watcher.files(a, {
        ...s,
        show: { ...s.show, art: true },
        looks: { ...s.looks, [a.kind]: { ...s.looks[a.kind], template } },
      });
    let pics: Awaited<ReturnType<typeof art>> & { banner?: string } = await art(
      r.look === "streaming" || r.look === "banner" ? "streaming" : "cinematic",
    );
    if (r.look === "banner") {
      const poster = await art("cinematic");
      const bytes = (p: typeof pics, name?: string) => p.files.find((f) => f.name === name)?.bytes;
      const png = await makeBanner({
        title: item.title,
        ...(item.year ? { year: item.year } : {}),
        meta: [
          item.genres?.slice(0, 2).join(", "),
          runtimeText(item.runtimeMin),
          item.contentRating,
        ]
          .filter(Boolean)
          .join("  ·  "),
        when: timeIn(r.startsAt, r.timeZone),
        eyebrow: invitationHeading(this.view(r, new Map()), opts.reminder),
        cancelled: r.status === "cancelled",
        foot: [r.note.trim(), spotsText(r), await this.placeName(r.watch)],
        ...(bytes(poster, poster.poster) ? { poster: bytes(poster, poster.poster)! } : {}),
        ...(bytes(pics, pics.backdrop) ? { backdrop: bytes(pics, pics.backdrop)! } : {}),
      }).catch(() => undefined);
      if (png)
        pics = {
          files: [{ name: "banner.png", type: "image/png", bytes: png }],
          banner: "banner.png",
        };
    }
    const join = await this.deps.join(a.where);
    const channels = await this.channelLinks();
    const night = this.view(r, new Map());
    const payload = movieNightInvitation(night, item, s, pics, {
      ...(opts.reminder ? { reminder: opts.reminder } : {}),
      join,
      channels,
    }) as unknown as Record<string, unknown>;
    const text = movieNightText(night, item, {
      ...(opts.reminder ? { reminder: opts.reminder } : {}),
      join,
      timeText: timeIn(r.startsAt, r.timeZone),
    });
    const plain: Message = { title: text.title, lines: text.lines, severity: "info" };
    // RSVP buttons (only your own bot's posts can carry them); gone once it is cancelled or over.
    const components =
      r.status === "scheduled" && !opts.reminder
        ? rsvpButtons(r.id)
        : r.status === "scheduled"
          ? undefined
          : [];
    return { payload, files: pics.files, plain, channels, ...(components ? { components } : {}) };
  }

  /** Posts the invitation where it is not yet, and edits it where it is (Discord). */
  private async publish(id: string, opts: { plainToo?: boolean } = {}) {
    const r = await this.row(id);
    const m = await this.compose(r);
    const posts = [...r.posts];
    for (const channelId of r.channels) {
      const i = posts.findIndex((p) => p.channelId === channelId);
      const before = i >= 0 ? posts[i] : undefined;
      // A text destination already told about this night only hears about real changes.
      if (before && !before.messageId && !opts.plainToo && !before.error) continue;
      const res = await this.deps.send(
        channelId,
        {
          payload: m.payload,
          files: m.files,
          ...(m.components ? { components: m.components } : {}),
        },
        m.plain,
        {
          event: "movie-night",
          keep: true,
          ...(before?.messageId ? { edit: before.messageId } : {}),
        },
      );
      const post = {
        channelId,
        postedAt: this.now().toISOString(),
        ...(res.ok
          ? res.messageId
            ? { messageId: res.messageId }
            : {}
          : {
              error: res.error,
              ...(before?.messageId ? { messageId: before.messageId } : {}),
            }),
      };
      if (i >= 0) posts[i] = post;
      else posts.push(post);
    }
    await this.db.update(t.movieNights).set({ posts }).where(eq(t.movieNights.id, id));
  }

  /** The name of a saved or suggested place whose words the host used, for the banner. */
  private async placeName(watch: string): Promise<string> {
    const text = watch.trim();
    if (!text) return "";
    const place = [...(await this.places()), ...SUGGESTED_PLACES].find((p) => p.text === text);
    return place?.name ?? "";
  }

  /** The host's saved "Where to watch" texts (none saved: the page offers suggestions). */
  async places(): Promise<WatchPlace[]> {
    return (await getSetting(this.db, "movie_night_places")) ?? [];
  }

  /** Saves the list as given: names are unique (ignoring case), empty ones are dropped. */
  async savePlaces(list: WatchPlace[]): Promise<WatchPlace[]> {
    const out: WatchPlace[] = [];
    for (const p of list) {
      const name = p.name.trim();
      const text = p.text.trim();
      if (!name || !text) continue;
      if (out.some((o) => o.name.toLowerCase() === name.toLowerCase()))
        throw new InvalidRequestError(`There is already a place called ${name}.`);
      out.push({ name, text });
    }
    await setSetting(this.db, "movie_night_places", out);
    return out;
  }

  /** Discord channels saved once, so "#name" in a note or Where to watch links to the channel. */
  async channelLinks(): Promise<ChannelLink[]> {
    return (await getSetting(this.db, "discord_channel_links")) ?? [];
  }

  /** Saves the list; each entry's link may be a channel link, a <#id> mention or the bare id. */
  async saveChannelLinks(list: { name: string; link: string }[]): Promise<ChannelLink[]> {
    const out: ChannelLink[] = [];
    for (const c of list) {
      const name = channelName(c.name);
      const id = channelIdFrom(c.link);
      if (!name) throw new InvalidRequestError("Give the channel its name, like movie-chat.");
      if (!id)
        throw new InvalidRequestError(
          "That is not a Discord channel link. In Discord, right-click the channel and choose Copy Link.",
        );
      if (out.some((o) => o.name === name))
        throw new InvalidRequestError(`#${name} is already saved.`);
      out.push({ name, id });
    }
    await setSetting(this.db, "discord_channel_links", out);
    return out;
  }

  /** Tries again where posting failed (the page's Try again). */
  async retry(id: string): Promise<MovieNight> {
    await this.publish(id, { plainToo: true });
    return this.get(id);
  }

  /**
   * On the media timer: reminders that are due go out once each (a new message, so people get a
   * ping), and nights that are over are marked done. A title that left the library is not
   * reminded about: the night shows the problem to the host instead.
   */
  async tick() {
    const now = this.now().getTime();
    const rows = await this.db
      .select()
      .from(t.movieNights)
      .where(eq(t.movieNights.status, "scheduled"));
    for (const r of rows) {
      const start = new Date(r.startsAt).getTime();
      if (now > start + OVER_AFTER_MS) {
        await this.db
          .update(t.movieNights)
          .set({ status: "done" })
          .where(eq(t.movieNights.id, r.id));
        continue;
      }
      const sent = new Set(r.remindersSent);
      // Only the latest due reminder goes out (a night planned for in an hour skips "a day before").
      const due = REMINDER_KINDS.filter(
        (k) =>
          r.reminders.includes(k.id) &&
          !sent.has(k.id) &&
          now >= start - k.beforeMs &&
          now < start + 30 * 60_000,
      );
      if (!due.length) continue;
      const kind = due[due.length - 1]!.id;
      const skipped = due.map((d) => d.id);
      const m = await this.compose(r, { reminder: kind }).catch(() => undefined);
      if (m)
        for (const channelId of r.channels)
          await this.deps.send(channelId, { payload: m.payload, files: m.files }, m.plain, {
            event: "movie-night-reminder",
          });
      await this.db
        .update(t.movieNights)
        .set({ remindersSent: [...r.remindersSent, ...skipped] })
        .where(eq(t.movieNights.id, r.id));
    }
  }

  /** The preview on the page: what the invitation will look like, before anything is posted. */
  async preview(input: Omit<NightInput, "channels">) {
    const a = await this.deps.watcher.arrivals.get(input.key);
    if (!a) throw new InvalidRequestError("That title is not in your libraries.");
    const at = new Date(input.startsAt);
    const r: Row = {
      id: "preview",
      key: input.key,
      title: a.title,
      startsAt: Number.isNaN(at.getTime()) ? this.now().toISOString() : at.toISOString(),
      timeZone: input.timeZone,
      spots: input.spots,
      note: input.note,
      watch: input.watch?.trim() ?? "",
      code: input.code?.trim() ?? "",
      look: input.look ?? "cinematic",
      status: "scheduled",
      reminders: input.reminders,
      channels: [],
      guests: [],
      posts: [],
      remindersSent: [],
      createdAt: this.now().toISOString(),
    };
    return this.compose(r);
  }
}

/** "Friday, Oct 31, 8:00 PM PDT" in the host's time zone (text destinations). */
/** "5 spots left", "3 going", or nothing: the banner's short version of the guest line. */
function spotsText(r: Row): string {
  const going = r.guests.length;
  if (r.spots === null) return going ? `${going} going` : "";
  const left = Math.max(0, r.spots - going);
  return left ? `${left} spot${left === 1 ? "" : "s"} left` : "Full";
}

/** I'm in and Can't make it, under the invitation. */
function rsvpButtons(id: string): unknown[] {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 3, label: "I'm in", custom_id: `mn:in:${id}` },
        { type: 2, style: 2, label: "Can't make it", custom_id: `mn:out:${id}` },
      ],
    },
  ];
}

export function timeIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toUTCString();
  }
}

/**
 * Links to a title for friends: Jellyfin at its public https address (never a local one), and Plex
 * through app.plex.tv, which is how people a library is shared with open it.
 */
export async function joinLinksFor(handle: DbHandle, where: Arrival["where"]): Promise<JoinLink[]> {
  const out: JoinLink[] = [];
  for (const w of where) {
    if (out.some((j) => j.server === w.server)) continue;
    if (w.server === "plex") {
      out.push({
        server: "plex",
        name: "Plex",
        url: "https://app.plex.tv/desktop/",
      });
      continue;
    }
    const s = await handle.db
      .select({ publicUrl: t.services.publicUrl })
      .from(t.services)
      .where(eq(t.services.id, w.serviceId))
      .get();
    const base = s?.publicUrl?.replace(/\/+$/, "");
    if (base && /^https:\/\//i.test(base))
      out.push({
        server: "jellyfin",
        name: "Jellyfin",
        url: `${base}/web/#/details?id=${encodeURIComponent(w.itemId)}`,
      });
  }
  return out;
}

/** Movie nights on Hearth's media watcher and notification destinations. */
export function movieNightsFor(
  handle: DbHandle,
  media: MediaWatcher,
  notifier: import("../notify/notifier").Notifier,
): MovieNights {
  return new MovieNights(handle, {
    watcher: media,
    channels: async () =>
      (await notifier.movieNightChannels()).map((c) => ({ id: c.id, name: c.name })),
    send: (channelId, rich, plain, opts) => notifier.sendMedia(channelId, rich, plain, opts),
    join: (where) => joinLinksFor(handle, where),
  });
}
