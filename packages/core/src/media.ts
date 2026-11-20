/**
 * Media announcements: the settings the owner designs in Notifications, and the one function that
 * turns an arrival into a Discord message. The server sends exactly what the designer previews,
 * because both use discordAnnouncement. Discord rules shape it: rich embeds (no free layout), a
 * small image at the side (thumbnail) or a large one below (image), links in text, no buttons
 * from a plain webhook.
 */

export type VideoKind = "movie" | "series" | "season" | "episode";
/**
 * Everything else a home server adds: music (an album), audiobooks, ebooks, comics, games and
 * podcast episodes. Announced only from library apps (Plex, Jellyfin, Emby, Navidrome,
 * Audiobookshelf, Kavita, RomM), never from downloaders, and never personal media (photos, home
 * videos). Each is off until the owner turns it on.
 */
export type LibraryKind = "album" | "audiobook" | "book" | "comic" | "game" | "podcast";
export type AnnounceKind = VideoKind | LibraryKind;

export const VIDEO_KINDS: VideoKind[] = ["movie", "series", "season", "episode"];
export const LIBRARY_KINDS: LibraryKind[] = [
  "album",
  "audiobook",
  "book",
  "comic",
  "game",
  "podcast",
];

/**
 * The kinds that arrive in bursts (a discography, a comic run, a podcast backlog): several of one
 * kind at once go out as one message ("6 new albums") instead of one each.
 */
export const BATCHED_KINDS: AnnounceKind[] = ["album", "book", "comic", "podcast", "episode"];

/** One kind's name for people, singular and plural: "album", "albums". */
export const KIND_NAMES: Record<AnnounceKind, [string, string]> = {
  movie: ["movie", "movies"],
  series: ["new series", "new series"],
  season: ["new season", "new seasons"],
  episode: ["episode", "episodes"],
  album: ["album", "albums"],
  audiobook: ["audiobook", "audiobooks"],
  book: ["book", "books"],
  comic: ["comic", "comics"],
  game: ["game", "games"],
  podcast: ["podcast episode", "podcast episodes"],
};
/** Banner: one wide picture Hearth makes (title, details and poster on the backdrop). */
export type AnnounceTemplate = "cinematic" | "streaming" | "compact" | "banner";

/** What one announcement is about: the media event, with nothing about the servers' insides. */
export interface AnnounceItem {
  kind: AnnounceKind;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  overview?: string;
  genres?: string[];
  runtimeMin?: number;
  rating?: number;
  contentRating?: string;
  trailer?: string;
  /** Where to watch it: the server names the owner chose to show (Plex, Jellyfin). */
  availableIn?: string[];
  /** Artist (album), author (book, audiobook, comic) or host (podcast). */
  creators?: string[];
  /** Who reads an audiobook. */
  narrators?: string[];
  /** A book's or comic's series, and its place in it ("The Expanse", 3). */
  seriesName?: string;
  seriesIndex?: number;
  /** Album: how many tracks. */
  tracks?: number;
  /** Book or comic: how many pages. */
  pages?: number;
  /** Game: the system it plays on ("SNES"). */
  platform?: string;
  /** Podcast: the show an episode belongs to (`title` is then the episode's). */
  show?: string;
}

export interface AnnounceShow {
  art: boolean;
  synopsis: boolean;
  genre: boolean;
  rating: boolean;
  runtime: boolean;
  trailer: boolean;
  availability: boolean;
}

export interface AnnounceLook {
  template: AnnounceTemplate;
  heading: string;
}

export interface MediaAnnounceSettings {
  /** Look per kind: movies, new series, new seasons, new episodes. */
  looks: Record<AnnounceKind, AnnounceLook>;
  /** Accent color, #rrggbb. */
  accent: string;
  /** The sender's name in Discord. */
  botName: string;
  /** Optional line under every announcement (your server's name, say). */
  branding: string;
  show: AnnounceShow;
  /** Which arrivals are announced. Episodes are off unless turned on. */
  types: Record<AnnounceKind, boolean>;
  /** "serviceId/libraryId" of the libraries to announce from; empty means all. */
  libraries: string[];
  /** Words in a title that mean "don't announce this one". */
  exclude: string[];
  /** One message per arrival, or a daily roundup. */
  mode: "immediate" | "digest";
  /** Local hour the daily roundup goes out (0 to 23). */
  digestHour: number;
  /** Hold announcements overnight (22:00 to 07:00) and send them in the morning. */
  quietHours: boolean;
  /** One announcement per title whatever server has it, or one per library. */
  dedupe: "across" | "per-library";
  /** Ember's one-liner on each card: Playful, Gentle or Off (ember-lines.ts). */
  tone: LineTone;
  /**
   * "Let Ember write it": she writes each line herself (checked by checkLine) instead of picking
   * from the written set, up to `emberWritesPerDay` a day; past that, or if hers fails the check,
   * the written set is used. Off by default: it uses the AI.
   */
  emberWrites: boolean;
  emberWritesPerDay: number;
  /**
   * Per destination (its id): which kinds it gets and its tone, when they differ from the
   * settings above. A family channel can get movies and audiobooks; a friends' one music only.
   */
  destinations: Record<string, DestinationAnnounce>;
}

export type LineTone = "playful" | "gentle" | "off";

/** "Let Ember write it" never writes more than this many lines a day, whatever is saved. */
export const EMBER_LINES_MAX_PER_DAY = 50;

export interface DestinationAnnounce {
  types?: Partial<Record<AnnounceKind, boolean>>;
  tone?: LineTone;
}

/** The kinds one destination gets: its own choices, else the settings for every destination. */
export function kindsFor(
  s: MediaAnnounceSettings,
  channelId?: string,
): Record<AnnounceKind, boolean> {
  return { ...s.types, ...((channelId && s.destinations[channelId]?.types) || {}) };
}

/** The tone of Ember's line for one destination. */
export function toneFor(s: MediaAnnounceSettings, channelId?: string): LineTone {
  return (channelId && s.destinations[channelId]?.tone) || s.tone;
}

/** Whether any destination gets any kind of this list (the library apps are read only then). */
export function anyKindOn(s: MediaAnnounceSettings, kinds: readonly AnnounceKind[]): boolean {
  return [undefined, ...Object.keys(s.destinations)].some((id) => {
    const on = kindsFor(s, id);
    return kinds.some((k) => on[k]);
  });
}

export const DEFAULT_MEDIA_ANNOUNCE: MediaAnnounceSettings = {
  looks: {
    movie: { template: "cinematic", heading: "Just added to the library" },
    series: { template: "cinematic", heading: "New series" },
    season: { template: "streaming", heading: "New season" },
    episode: { template: "compact", heading: "New episode" },
    album: { template: "compact", heading: "New music" },
    audiobook: { template: "compact", heading: "New audiobook" },
    book: { template: "compact", heading: "New on the bookshelf" },
    comic: { template: "compact", heading: "New comic" },
    game: { template: "compact", heading: "New game" },
    podcast: { template: "compact", heading: "New podcast episode" },
  },
  accent: "#ff7a1a",
  botName: "Hearth",
  branding: "",
  show: {
    art: true,
    synopsis: true,
    genre: true,
    rating: true,
    runtime: true,
    trailer: true,
    availability: true,
  },
  types: {
    movie: true,
    series: true,
    season: true,
    episode: false,
    album: false,
    audiobook: false,
    book: false,
    comic: false,
    game: false,
    podcast: false,
  },
  libraries: [],
  exclude: [],
  mode: "immediate",
  digestHour: 18,
  quietHours: false,
  dedupe: "across",
  tone: "playful",
  emberWrites: false,
  emberWritesPerDay: 10,
  destinations: {},
};

/** Saved settings filled in with today's defaults (new options added since they were saved). */
export function mediaAnnounceSettings(
  saved?: Partial<MediaAnnounceSettings> | null,
): MediaAnnounceSettings {
  const d = DEFAULT_MEDIA_ANNOUNCE;
  return {
    ...d,
    // Settings saved before Ember's line existed keep their cards as they were.
    ...(saved ? { tone: "off" as const } : {}),
    ...(saved ?? {}),
    destinations: { ...(saved?.destinations ?? {}) },
    emberWritesPerDay: Math.min(
      EMBER_LINES_MAX_PER_DAY,
      Math.max(0, Math.floor(saved?.emberWritesPerDay ?? d.emberWritesPerDay)),
    ),
    looks: { ...d.looks, ...(saved?.looks ?? {}) },
    show: { ...d.show, ...(saved?.show ?? {}) },
    types: { ...d.types, ...(saved?.types ?? {}) },
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const names = (l?: string[]) => (l?.length ? l.slice(0, 2).join(" and ") : undefined);

/**
 * The title line: "Title (2026)", "Title, Season 2", "Title S3E5: Episode", "Album by Artist
 * (1977)", "Book by Author", "Series #12", "Game (SNES)", "Show: Episode".
 */
export function announceTitle(i: AnnounceItem): string {
  const by = names(i.creators);
  switch (i.kind) {
    case "album":
      return `${i.title}${by ? ` by ${by}` : ""}${i.year ? ` (${i.year})` : ""}`;
    case "audiobook":
    case "book":
      return `${i.title}${by ? ` by ${by}` : ""}`;
    case "comic":
      return i.seriesName && i.seriesIndex !== undefined && !i.title.includes(`#${i.seriesIndex}`)
        ? `${i.seriesName} #${i.seriesIndex}`
        : i.title;
    case "game":
      return `${i.title}${i.platform ? ` (${i.platform})` : i.year ? ` (${i.year})` : ""}`;
    case "podcast":
      return i.show ? `${i.show}: ${i.title}` : i.title;
  }
  if (i.kind === "season") return `${i.title}, Season ${i.season ?? "?"}`;
  if (i.kind === "episode") {
    const s = String(i.season ?? 0).padStart(2, "0");
    const e = String(i.episode ?? 0).padStart(2, "0");
    return `${i.title} S${s}E${e}${i.episodeTitle ? `: ${i.episodeTitle}` : ""}`;
  }
  return `${i.title}${i.year ? ` (${i.year})` : ""}`;
}

/** Runtime as "1h 34m". */
export function runtimeText(min?: number): string | undefined {
  if (!min) return undefined;
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}

/** The pictures a message attaches (Hearth fetches them from the media server and uploads them). */
export interface AnnounceImages {
  /** File name of the attached poster ("poster.jpg"), when there is one. */
  poster?: string;
  backdrop?: string;
  /** The Banner style's picture (movie nights and announcements), shown above the card. */
  banner?: string;
}

export interface DiscordEmbed {
  author?: { name: string };
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
}

export interface DiscordAnnouncement {
  username: string;
  content?: string;
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: never[] };
}

/** Ember's one-liner on a card, with the name she goes by on this Hearth. */
export interface AnnounceLine {
  text: string;
  aiName: string;
}

const lineText = (l?: AnnounceLine) =>
  l?.text ? `**${clip(l.aiName || "Ember", 40)}:** ${clip(l.text, 200)}` : undefined;

const colorOf = (hex: string) => {
  const n = Number.parseInt(hex.replace(/^#/, ""), 16);
  return Number.isFinite(n) ? n : 0xff7a1a;
};

/**
 * The Discord message for one arrival. `test` marks it clearly as a test, so friends never take it
 * for a real new release.
 */
export function discordAnnouncement(
  item: AnnounceItem,
  s: MediaAnnounceSettings,
  images: AnnounceImages = {},
  opts: {
    test?: boolean;
    /** Ember's one-liner (ember-lines.ts) and the name she goes by on this Hearth. */
    line?: AnnounceLine;
  } = {},
): DiscordAnnouncement {
  const look = s.looks[item.kind];
  const show = s.show;
  const meta = [
    show.genre && item.genres?.length ? item.genres.slice(0, 3).join(", ") : undefined,
    show.runtime && (item.kind === "movie" || item.kind === "audiobook" || item.kind === "album")
      ? runtimeText(item.runtimeMin)
      : undefined,
    item.kind === "audiobook" && item.narrators?.length
      ? `Read by ${names(item.narrators)}`
      : undefined,
    (item.kind === "book" || item.kind === "audiobook") && item.seriesName
      ? `${item.seriesName}${item.seriesIndex !== undefined ? ` #${item.seriesIndex}` : ""}`
      : undefined,
    item.kind === "album" && item.tracks ? `${item.tracks} tracks` : undefined,
    (item.kind === "book" || item.kind === "comic") && item.pages
      ? `${item.pages} pages`
      : undefined,
    item.kind === "game" && item.platform && item.year ? String(item.year) : undefined,
    show.rating && item.contentRating ? item.contentRating : undefined,
    show.rating && item.rating ? `★ ${item.rating.toFixed(1)}/10` : undefined,
  ].filter(Boolean) as string[];
  const synopsis =
    show.synopsis && item.overview
      ? clip(
          item.overview,
          look.template === "compact"
            ? 140
            : look.template === "streaming" || look.template === "banner"
              ? 240
              : 400,
        )
      : undefined;
  const trailer = show.trailer && item.trailer ? `▶ [Watch trailer](${item.trailer})` : undefined;
  const where =
    show.availability && item.availableIn?.length
      ? `Available in ${item.availableIn.join(" and ")}`
      : undefined;
  // Banner: the picture above the card already has the heading, title and details.
  const banner = look.template === "banner" && show.art && Boolean(images.banner);
  const description = [
    lineText(opts.line),
    meta.length && !banner ? `*${meta.join(" · ")}*` : undefined,
    synopsis,
    trailer,
  ]
    .filter(Boolean)
    .join("\n\n");
  const footer = [
    opts.test ? "TEST: not a real new arrival" : undefined,
    where,
    s.branding || undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const art = show.art;
  const embed: DiscordEmbed = {
    ...(banner
      ? {}
      : {
          author: { name: clip(look.heading || "Just added", 256) },
          title: clip(announceTitle(item), 256),
        }),
    ...(description ? { description: clip(description, 4000) } : {}),
    color: colorOf(s.accent),
    ...(footer ? { footer: { text: clip(footer, 2048) } } : {}),
  };
  // A banner is not in the card at all: Discord shows an attachment the card does not use above
  // it. A Banner that could not be made falls back to the Streaming look.
  if (art && !banner) {
    if (look.template === "streaming" || look.template === "banner") {
      const wide = images.backdrop ?? images.poster;
      if (wide) embed.image = { url: `attachment://${wide}` };
    } else if (images.poster) {
      // Cinematic and Compact: the poster beside the text (Discord's thumbnail spot).
      embed.thumbnail = { url: `attachment://${images.poster}` };
    }
  }
  return {
    username: clip(s.botName || "Hearth", 80),
    ...(opts.test ? { content: "🧪 Test announcement (not a real new arrival)" } : {}),
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
}

/** A daily roundup: one message listing what arrived, newest first (Discord allows 10 embeds). */
export function discordDigest(
  items: AnnounceItem[],
  s: MediaAnnounceSettings,
  opts: {
    test?: boolean;
    /** A batch of one kind ("6 new albums") instead of the whole day's roundup. */
    batch?: AnnounceKind;
    line?: AnnounceLine;
  } = {},
): DiscordAnnouncement {
  const lines = items
    .slice(0, 40)
    .map((i) => {
      const trailer = s.show.trailer && i.trailer ? ` · [trailer](${i.trailer})` : "";
      return `• **${announceTitle(i)}**${trailer}`;
    })
    .join("\n");
  const more = items.length > 40 ? `\n…and ${items.length - 40} more` : "";
  return {
    username: clip(s.botName || "Hearth", 80),
    ...(opts.test ? { content: "🧪 Test roundup (not real new arrivals)" } : {}),
    embeds: [
      {
        author: {
          name: clip(
            opts.batch ? s.looks[opts.batch].heading || "New" : "Today in the library",
            256,
          ),
        },
        title: opts.batch
          ? batchTitle(opts.batch, items.length)
          : `${items.length} new ${items.length === 1 ? "arrival" : "arrivals"}`,
        description: clip([lineText(opts.line), lines + more].filter(Boolean).join("\n\n"), 4000),
        color: colorOf(s.accent),
        ...(s.branding ? { footer: { text: s.branding } } : {}),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/** "6 new albums", "1 new audiobook", "3 new podcast episodes", "2 new series". */
export function batchTitle(kind: AnnounceKind, n: number): string {
  const [one, many] = KIND_NAMES[kind];
  const word = n === 1 ? one : many;
  return `${n} ${word.startsWith("new ") ? word : `new ${word}`}`;
}

export type AnnounceMessage =
  { batch: AnnounceKind; items: AnnounceItem[] } | { item: AnnounceItem };

/**
 * Splits what arrived into messages: a kind that comes in bursts and has several items becomes
 * one batch; everything else goes one per item. Messages keep the order of their first item.
 */
export function groupForBatch(
  items: AnnounceItem[],
  batched: readonly AnnounceKind[] = BATCHED_KINDS,
): AnnounceMessage[] {
  const counts = new Map<AnnounceKind, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  const out: AnnounceMessage[] = [];
  const batches = new Map<AnnounceKind, AnnounceItem[]>();
  for (const i of items) {
    if (batched.includes(i.kind) && (counts.get(i.kind) ?? 0) > 1) {
      let b = batches.get(i.kind);
      if (!b) {
        b = [];
        batches.set(i.kind, b);
        out.push({ batch: i.kind, items: b });
      }
      b.push(i);
    } else out.push({ item: i });
  }
  return out;
}
