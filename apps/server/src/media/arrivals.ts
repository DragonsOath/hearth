import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { getSetting, setSetting } from "../store/settings";
import type { AnnounceKind } from "@dragon-control/core";
import type { LibraryItem, ProviderIds } from "./sources";

/**
 * Which movies and shows have really arrived: confirmed in a Plex or Jellyfin library, not just
 * downloaded. Each title is known once, by its own identity (its TMDB, IMDb or TVDB id, else its
 * name and year), so Plex and Jellyfin reporting the same movie make one arrival, and rescans,
 * restarts and metadata refreshes make none. The first read of a server is its baseline: what is
 * already there is remembered and never announced.
 *
 * TV: the first episode of a series Hearth has never seen announces the series; the first episode
 * of a new season announces the season; any other new episode is an episode arrival (announced
 * only if the owner turns episodes on).
 */

export type ArrivalKind = AnnounceKind;

/** The apps Hearth reads arrivals from: media servers and the library apps (library-sources.ts). */
export type MediaApp = "plex" | "jellyfin" | "navidrome" | "audiobookshelf" | "kavita" | "romm";

/** Product names for "Available in". Emby is read as Jellyfin is. */
export const MEDIA_APP_NAMES: Record<MediaApp, string> = {
  plex: "Plex",
  jellyfin: "Jellyfin",
  navidrome: "Navidrome",
  audiobookshelf: "Audiobookshelf",
  kavita: "Kavita",
  romm: "RomM",
};

/**
 * What a read covers. "video": movies and shows (Plex, Jellyfin). "library": music, books,
 * comics, games and podcasts. Each has its own baseline, so turning music on for a server read
 * for years announces only albums added from then on.
 */
export type ReadPart = "video" | "library";

/** The baseline's name for one server's part. */
export const baselineKey = (serviceId: string, part: ReadPart = "video") =>
  part === "library" ? `${serviceId}#library` : serviceId;

export interface Arrival {
  key: string;
  kind: ArrivalKind;
  /** Movie or series title. */
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** The episode's own title. */
  episodeTitle?: string;
  overview?: string;
  genres?: string[];
  runtimeMin?: number;
  rating?: number;
  contentRating?: string;
  ids: ProviderIds;
  /** Library kinds: artist or author, narrator, series, tracks, pages, system, podcast show. */
  creators?: string[];
  narrators?: string[];
  seriesName?: string;
  seriesIndex?: number;
  tracks?: number;
  pages?: number;
  platform?: string;
  show?: string;
  /** Where it is: server, library, and the server's item (for its pictures). */
  where: {
    serviceId: string;
    server: MediaApp;
    serverName: string;
    libraryId: string;
    library: string;
    itemId: string;
    poster?: string;
    backdrop?: string;
  }[];
  trailers?: string[];
  addedAt?: string;
}

export interface ServerRead {
  serviceId: string;
  server: MediaApp;
  /** Video unless said (the part's baseline is its own). */
  part?: ReadPart;
  serverName: string;
  items: LibraryItem[];
}

/** "across": one announcement per title whatever server has it; "per-library": each library its own. */
export type DedupeMode = "across" | "per-library";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Every name a title goes by, most reliable first. */
function aliasesOf(ids: ProviderIds | undefined, title: string, year?: number): string[] {
  const out: string[] = [];
  if (ids?.tmdb) out.push(`tmdb:${ids.tmdb}`);
  if (ids?.imdb) out.push(`imdb:${ids.imdb}`);
  if (ids?.tvdb) out.push(`tvdb:${ids.tvdb}`);
  out.push(`name:${norm(title)}${year ? `:${year}` : ""}`);
  return out;
}

interface Candidate {
  key: string;
  kind: ArrivalKind;
  aliases: string[];
  arrival: Arrival;
}

/** The movie, series, season and episode identities one library item stands for. */
function candidates(read: ServerRead, item: LibraryItem, mode: DedupeMode): Candidate[] {
  const scope = mode === "per-library" ? `${read.serviceId}/${item.libraryId}|` : "";
  const where = {
    serviceId: read.serviceId,
    server: read.server,
    serverName: read.serverName,
    libraryId: item.libraryId,
    library: item.library,
    itemId: item.itemId,
    ...(item.poster ? { poster: item.poster } : {}),
    ...(item.backdrop ? { backdrop: item.backdrop } : {}),
  };
  const meta = {
    ...(item.genres ? { genres: item.genres } : {}),
    ...(item.rating ? { rating: item.rating } : {}),
    ...(item.contentRating ? { contentRating: item.contentRating } : {}),
    ...(item.trailers ? { trailers: item.trailers } : {}),
    ...(item.addedAt ? { addedAt: item.addedAt } : {}),
  };
  if (item.kind !== "episode" && item.kind !== "movie") {
    // Music, books, comics, games and podcasts: one title each, known by its outside id (an
    // album's MusicBrainz id) or else by who made it and what it is called.
    const by = norm((item.creators ?? []).join(" "));
    const named =
      item.kind === "comic"
        ? `${norm(item.seriesName ?? item.title)}|${item.seriesIndex ?? norm(item.title)}`
        : item.kind === "podcast"
          ? `${norm(item.podcastShow ?? "")}|${norm(item.title)}`
          : item.kind === "game"
            ? `${norm(item.title)}|${norm(item.platform ?? "")}`
            : `${by}|${norm(item.title)}`;
    const aliases = [
      ...(item.ids?.mbid ? [`mbid:${item.ids.mbid}`] : []),
      `name:${named}`,
      // The same item on the same server, whatever its name becomes after a metadata fix.
      `item:${read.serviceId}:${item.itemId}`,
    ].map((a) => `${scope}${item.kind}:${a}`);
    return [
      {
        key: aliases[0]!,
        kind: item.kind,
        aliases,
        arrival: {
          key: aliases[0]!,
          kind: item.kind,
          title: item.title,
          ...(item.year ? { year: item.year } : {}),
          ...(item.overview ? { overview: item.overview } : {}),
          ...(item.runtimeMin ? { runtimeMin: item.runtimeMin } : {}),
          ...(item.creators?.length ? { creators: item.creators } : {}),
          ...(item.narrators?.length ? { narrators: item.narrators } : {}),
          ...(item.seriesName ? { seriesName: item.seriesName } : {}),
          ...(item.seriesIndex !== undefined ? { seriesIndex: item.seriesIndex } : {}),
          ...(item.tracks ? { tracks: item.tracks } : {}),
          ...(item.pages ? { pages: item.pages } : {}),
          ...(item.platform ? { platform: item.platform } : {}),
          ...(item.podcastShow ? { show: item.podcastShow } : {}),
          ids: item.ids,
          where: [where],
          ...meta,
        },
      },
    ];
  }
  if (item.kind === "movie") {
    // The file's name comes last: it joins Plex's and Jellyfin's copies of one file, but never
    // becomes the title's key.
    const aliases = [
      ...aliasesOf(item.ids, item.title, item.year),
      ...(item.file ? [`file:${item.file}`] : []),
    ].map((a) => scope + "movie:" + a);
    return [
      {
        key: aliases[0]!,
        kind: "movie",
        aliases,
        arrival: {
          key: aliases[0]!,
          kind: "movie",
          title: item.title,
          ...(item.year ? { year: item.year } : {}),
          ...(item.overview ? { overview: item.overview } : {}),
          ...(item.runtimeMin ? { runtimeMin: item.runtimeMin } : {}),
          ids: item.ids,
          where: [where],
          ...meta,
        },
      },
    ];
  }
  const show = item.show ?? "A series";
  const series = aliasesOf(item.showIds, show, item.showYear).map((a) => scope + "series:" + a);
  const s = item.season ?? 0;
  const e = item.episode ?? 0;
  const base = {
    title: show,
    ...(item.showYear ? { year: item.showYear } : {}),
    ids: item.showIds ?? {},
    where: [where],
    ...meta,
  };
  return [
    {
      key: series[0]!,
      kind: "series",
      aliases: series,
      arrival: {
        ...base,
        key: series[0]!,
        kind: "series",
        ...(item.showOverview ? { overview: item.showOverview } : {}),
      },
    },
    {
      key: `${series[0]}|s${s}`,
      kind: "season",
      aliases: series.map((a) => `${a}|s${s}`),
      arrival: {
        ...base,
        key: `${series[0]}|s${s}`,
        kind: "season",
        season: s,
        ...(item.showOverview ? { overview: item.showOverview } : {}),
      },
    },
    {
      key: `${series[0]}|s${s}e${e}`,
      kind: "episode",
      aliases: series.map((a) => `${a}|s${s}e${e}`),
      arrival: {
        ...base,
        key: `${series[0]}|s${s}e${e}`,
        kind: "episode",
        season: s,
        episode: e,
        episodeTitle: item.title,
        ...(item.overview ? { overview: item.overview } : {}),
        ...(item.runtimeMin ? { runtimeMin: item.runtimeMin } : {}),
      },
    },
  ];
}

const recognizedBy = (a: Arrival) => Object.keys(a.ids ?? {}).length > 0;

/**
 * One title known from two places. When only the newcomer was recognized by its server (it has
 * outside ids), its details lead: the real title, synopsis and poster instead of a file name and
 * a frame from the video. Its place comes first, so pictures are taken from it.
 */
function joined(have: Arrival, other: Arrival): Arrival {
  const lead = !recognizedBy(have) && recognizedBy(other) ? other : have;
  const rest = lead === have ? other : have;
  const where = [...lead.where];
  for (const w of rest.where)
    if (!where.some((x) => x.serviceId === w.serviceId && x.itemId === w.itemId)) where.push(w);
  return {
    ...rest,
    ...lead,
    key: have.key,
    where,
    trailers: lead.trailers ?? rest.trailers,
  } as Arrival;
}

export class MediaArrivals {
  constructor(
    private readonly handle: DbHandle,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get db() {
    return this.handle.db;
  }

  /** Servers already read once (their baseline is in). */
  async baselined(): Promise<Record<string, string>> {
    return (await getSetting(this.db, "media_baseline")) ?? {};
  }

  /**
   * Takes one server's read. On its first read everything is baseline (never announced); after
   * that, anything with an identity Hearth has not seen is an arrival. Returns the new arrivals,
   * series before seasons before episodes.
   */
  async take(
    read: ServerRead,
    mode: DedupeMode = "across",
    /** linkOnly: only join what is already known (new names, where); nothing new is added. */
    opts: { linkOnly?: boolean } = {},
  ): Promise<Arrival[]> {
    const done = await this.baselined();
    const part = baselineKey(read.serviceId, read.part);
    const baseline = !done[part] && !opts.linkOnly;
    const at = this.now().toISOString();
    const out: Arrival[] = [];
    // Oldest first, so a series is met (and announced) before its later episodes.
    const items = [...read.items].sort((a, b) => (a.addedAt ?? "").localeCompare(b.addedAt ?? ""));
    // Series and seasons that arrived in this read: their other episodes here are part of them.
    const fresh = new Set<string>();
    for (const item of items) {
      const cands = candidates(read, item, mode);
      // Which of these identities exist already (by any of their names)?
      const all = cands.flatMap((c) => c.aliases);
      const known = new Map(
        (all.length
          ? await this.db.select().from(t.mediaAliases).where(inArray(t.mediaAliases.alias, all))
          : []
        ).map((r) => [r.alias, r.key]),
      );
      let coveredBy: ArrivalKind | null = null;
      for (const c of cands) {
        // One file known as two titles (one server recognized the movie, the other did not):
        // they become one title, so it is available in both and uses the recognized details.
        const keys = [...new Set(c.aliases.map((a) => known.get(a)).filter(Boolean))] as string[];
        if (keys.length > 1) {
          const into = await this.merge(keys);
          for (const a of c.aliases) if (known.has(a)) known.set(a, into);
        }
        const existing = c.aliases.map((a) => known.get(a)).find(Boolean);
        if (opts.linkOnly && !existing) continue;
        if (existing && fresh.has(existing) && (c.kind === "series" || c.kind === "season")) {
          coveredBy = c.kind;
        }
        if (existing) {
          // Known already: remember any new name it goes by, and where else it is.
          await this.addAliases(existing, c.aliases);
          await this.addWhere(existing, c.arrival);
          continue;
        }
        const status = baseline ? "baseline" : coveredBy ? "covered" : "new";
        await this.db.insert(t.mediaTitles).values({
          key: c.key,
          kind: c.kind,
          title: c.arrival.title,
          status,
          firstSeenAt: at,
          data: c.arrival as unknown as Record<string, unknown>,
        });
        await this.addAliases(c.key, c.aliases);
        if (status !== "baseline" && (c.kind === "series" || c.kind === "season")) fresh.add(c.key);
        if (status === "new") {
          out.push(c.arrival);
          // A new series covers its season and episode; a new season covers its episode.
          if (c.kind === "series" || c.kind === "season") coveredBy = c.kind;
        }
      }
    }
    if (baseline) await setSetting(this.db, "media_baseline", { ...done, [part]: at });
    return out;
  }

  private async addAliases(key: string, aliases: string[]) {
    for (const alias of aliases)
      await this.db.insert(t.mediaAliases).values({ alias, key }).onConflictDoNothing();
  }

  /** A title found on another server or library too: its "Available in" grows. */
  private async addWhere(key: string, arrival: Arrival) {
    const row = await this.db.select().from(t.mediaTitles).where(eq(t.mediaTitles.key, key)).get();
    if (!row) return;
    const data = row.data as unknown as Arrival;
    const where = data.where ?? [];
    const w = arrival.where[0]!;
    if (where.some((x) => x.serviceId === w.serviceId && x.itemId === w.itemId)) return;
    await this.save(key, joined(data, arrival));
  }

  private async save(key: string, data: Arrival) {
    await this.db
      .update(t.mediaTitles)
      .set({ title: data.title, data: data as unknown as Record<string, unknown> })
      .where(eq(t.mediaTitles.key, key));
  }

  /**
   * Makes several titles one: the one a server recognized (it has outside ids) keeps its key, and
   * takes the others' names, places, announcements and movie nights. Nothing is announced again.
   */
  private async merge(keys: string[]): Promise<string> {
    const rows = await this.db.select().from(t.mediaTitles).where(inArray(t.mediaTitles.key, keys));
    if (rows.length < 2) return rows[0]?.key ?? keys[0]!;
    const target = rows.find((r) => recognizedBy(r.data as unknown as Arrival)) ?? rows[0]!;
    let data = target.data as unknown as Arrival;
    for (const other of rows.filter((r) => r.key !== target.key)) {
      data = joined(data, other.data as unknown as Arrival);
      await this.db
        .update(t.mediaAliases)
        .set({ key: target.key })
        .where(eq(t.mediaAliases.key, other.key));
      // Announcements: one per destination; the target's own stands where both have one.
      const mine = new Set(
        (
          await this.db
            .select({ c: t.mediaDeliveries.channelId })
            .from(t.mediaDeliveries)
            .where(eq(t.mediaDeliveries.key, target.key))
        ).map((r) => r.c),
      );
      for (const d of await this.db
        .select()
        .from(t.mediaDeliveries)
        .where(eq(t.mediaDeliveries.key, other.key))) {
        const at = and(
          eq(t.mediaDeliveries.key, other.key),
          eq(t.mediaDeliveries.channelId, d.channelId),
        );
        if (mine.has(d.channelId)) await this.db.delete(t.mediaDeliveries).where(at);
        else await this.db.update(t.mediaDeliveries).set({ key: target.key }).where(at);
      }
      await this.db
        .update(t.movieNights)
        .set({ key: target.key })
        .where(eq(t.movieNights.key, other.key));
      await this.db.delete(t.mediaTitles).where(eq(t.mediaTitles.key, other.key));
    }
    await this.save(target.key, data);
    return target.key;
  }

  async get(key: string): Promise<Arrival | undefined> {
    const row = await this.db.select().from(t.mediaTitles).where(eq(t.mediaTitles.key, key)).get();
    return row ? (row.data as unknown as Arrival) : undefined;
  }

  /** Titles whose name contains the words typed (a movie night's picker), newest first. */
  async search(
    kind: ArrivalKind,
    q: string,
    limit = 20,
  ): Promise<{ key: string; title: string }[]> {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!words.length) return this.samples(kind, limit);
    const rows = await this.db
      .select({ key: t.mediaTitles.key, title: t.mediaTitles.title, at: t.mediaTitles.firstSeenAt })
      .from(t.mediaTitles)
      .where(
        and(
          eq(t.mediaTitles.kind, kind),
          ...words.map((w) =>
            like(sql`lower(${t.mediaTitles.title})`, `%${w.replace(/[%_]/g, "")}%`),
          ),
        ),
      )
      .limit(200);
    return rows
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((r) => ({ key: r.key, title: r.title }));
  }

  /** Titles to pick from for a preview: the newest of a kind, any status. */
  async samples(kind: ArrivalKind, limit = 20): Promise<{ key: string; title: string }[]> {
    const rows = await this.db.select().from(t.mediaTitles).where(eq(t.mediaTitles.kind, kind));
    return rows
      .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))
      .slice(0, limit)
      .map((r) => ({ key: r.key, title: r.title }));
  }
}
