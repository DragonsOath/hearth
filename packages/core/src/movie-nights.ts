import {
  announceTitle,
  runtimeText,
  type AnnounceImages,
  type AnnounceItem,
  type AnnounceTemplate,
  type DiscordAnnouncement,
  type DiscordEmbed,
  type MediaAnnounceSettings,
} from "./media";

/**
 * Movie nights (docs/design MOVIE_NIGHTS_BRIEF.md, FEATURE_CHECKLIST 40): a title from the library,
 * a time, an invitation posted to the owner's friends-and-family destinations and edited in place
 * when anything changes, a guest list, and reminders. The message is built here so the page's
 * preview and the destination get exactly the same thing.
 */

export type MovieNightStatus = "scheduled" | "cancelled" | "done";

/**
 * How the invitation looks: the three announcement styles, plus Banner, a wide picture Hearth
 * makes (title, time and poster over the movie's backdrop) that leads the post.
 */
export type MovieNightLook = AnnounceTemplate;
export const MOVIE_NIGHT_LOOKS: MovieNightLook[] = ["cinematic", "streaming", "compact", "banner"];
export type ReminderKind = "day" | "hour" | "start";

export const REMINDER_KINDS: { id: ReminderKind; label: string; beforeMs: number }[] = [
  { id: "day", label: "A day before", beforeMs: 24 * 60 * 60_000 },
  { id: "hour", label: "An hour before", beforeMs: 60 * 60_000 },
  { id: "start", label: "When it starts", beforeMs: 0 },
];

/** Where friends can open the title: only public addresses, never an internal one. */
export interface JoinLink {
  server: "plex" | "jellyfin";
  name: string;
  url: string;
}

export interface MovieNight {
  id: string;
  key: string;
  title: string;
  /** When it starts, UTC (ISO). */
  startsAt: string;
  /** The host's time zone (for the page; Discord shows each friend their own time). */
  timeZone: string;
  /** How many can come; none for no limit. */
  spots: number | null;
  note: string;
  /** The host's own "Where to watch" (Discord markdown allowed); empty uses Hearth's links. */
  watch?: string;
  /** A watch-party room code (Plezy Watch Together and the like), shown under Where to watch. */
  code?: string;
  /** How the invitation looks on Discord: the announcement styles, or Banner. */
  look?: MovieNightLook;
  status: MovieNightStatus;
  reminders: ReminderKind[];
  channels: string[];
  guests: string[];
  /** Destinations it was posted to, and when it was last updated there. */
  posts: { channelId: string; channel: string; postedAt: string; error?: string }[];
  remindersSent: ReminderKind[];
  createdAt: string;
}

/** A saved "Where to watch": the host's own words, picked with one click when planning. */
export interface WatchPlace {
  name: string;
  text: string;
}

/** Offered while the host has saved none of their own (they become theirs when saved). */
export const SUGGESTED_PLACES: WatchPlace[] = [
  {
    name: "Watch on Plex",
    text: "{plex} and press play at the start time.",
  },
  {
    name: "Plezy Watch Together",
    text: "In Plezy, open Watch Together, choose Join Room and enter the room code.",
  },
  {
    name: "Jellyfin SyncPlay",
    text: "In Jellyfin, open the movie, then SyncPlay and join the group named after it.",
  },
  { name: "Come over", text: "Come over to the house. Doors open 30 minutes before." },
];

/**
 * "{plex}" (or "{jellyfin}") in the host's Where to watch becomes the link Hearth found to the
 * movie on that server (11-13: a Watch on Plex choice that keeps the real link). No link found:
 * the server's name, so the sentence still reads.
 */
export function joinTokens(text: string, join: JoinLink[] = [], plain = false): string {
  return text.replace(/\{(plex|jellyfin)\}/gi, (_m, server: string) => {
    const kind = server.toLowerCase();
    const j = join.find((x) => x.server === kind);
    const label = kind === "plex" ? "Plex" : "Jellyfin";
    if (!j) return `Open it in ${label}`;
    return plain ? `Open it in ${j.name}: ${j.url}` : `[Open it in ${j.name}](${j.url})`;
  });
}

/** A Discord channel the host saved once, so "#name" in their text becomes a real link. */
export interface ChannelLink {
  name: string;
  id: string;
}

/**
 * The channel id from what Discord gives people: a channel link (right-click, Copy Link), a
 * mention (<#id>), or the bare id (Developer Mode's Copy Channel ID).
 */
export function channelIdFrom(input: string): string | undefined {
  const s = input.trim();
  const m =
    /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d{5,25})/i.exec(s) ??
    /^<#(\d{5,25})>$/.exec(s) ??
    /^(\d{5,25})$/.exec(s);
  return m?.[1];
}

/** "#movie-chat" (or "movie chat") as Discord names it: lower case, dashes, no "#". */
export function channelName(input: string): string {
  return input.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").slice(0, 100);
}

/** "#movie-chat" in the host's text becomes Discord's <#id>, a link to that channel. */
export function linkChannels(text: string, links: ChannelLink[] = []): string {
  let out = text;
  for (const l of links) {
    const name = l.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^\\w<])#${name}(?![\\w-])`, "gi"), `$1<#${l.id}>`);
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Discord's own timestamp: every friend sees it in their own time zone. */
const when = (iso: string, style: "F" | "R") =>
  `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`;

/** "4 going · 8 spots left", "4 going", "Nobody yet". */
export function guestLine(n: MovieNight): string {
  const going = n.guests.length;
  const base = going ? `${going} going` : "Nobody has said they're coming yet";
  if (n.spots === null) return base;
  const left = Math.max(0, n.spots - going);
  return `${base} · ${left ? `${left} spot${left === 1 ? "" : "s"} left` : "full"}`;
}

const REMINDER_TEXT: Record<ReminderKind, string> = {
  day: "Tomorrow",
  hour: "Starting in an hour",
  start: "Starting now",
};

/** The invitation's heading: Movie night, a reminder's ("Tomorrow"), or that it is cancelled. */
export function invitationHeading(n: MovieNight, reminder?: ReminderKind): string {
  if (n.status === "cancelled") return "Movie night cancelled";
  return reminder ? REMINDER_TEXT[reminder] : "Movie night";
}

/**
 * The invitation (or a reminder, which repeats its key facts). Cancelled nights say so in the same
 * message, so nobody turns up to a movie night that is off.
 */
export function movieNightInvitation(
  n: MovieNight,
  item: AnnounceItem,
  s: MediaAnnounceSettings,
  images: AnnounceImages = {},
  opts: { reminder?: ReminderKind; join?: JoinLink[]; channels?: ChannelLink[] } = {},
): DiscordAnnouncement {
  const cancelled = n.status === "cancelled";
  const look = n.look ?? "cinematic";
  // Banner: the picture above the card already has the title, details and poster.
  const banner = look === "banner" && Boolean(images.banner);
  const meta = [
    item.genres?.length ? item.genres.slice(0, 3).join(", ") : undefined,
    runtimeText(item.runtimeMin),
    item.contentRating,
  ].filter(Boolean) as string[];
  const lines = cancelled
    ? ["**This movie night is cancelled.**"]
    : [
        `**${when(n.startsAt, "F")}** (${when(n.startsAt, "R")})`,
        // The host's note stands out: bold, in a quote (Discord has no text colors in a post).
        n.note.trim() ? quoted(clip(linkChannels(n.note.trim(), opts.channels), 1000)) : undefined,
        meta.length && !banner ? `*${meta.join(" · ")}*` : undefined,
        item.overview && !banner ? clip(item.overview, look === "compact" ? 140 : 300) : undefined,
        item.trailer ? `▶ [Watch trailer](${item.trailer})` : undefined,
      ];
  // The host's own words, or the links Hearth found; then the night's room code, when there is one.
  const where = [
    n.watch?.trim()
      ? linkChannels(joinTokens(n.watch.trim(), opts.join), opts.channels)
      : (opts.join ?? [])
          .map((j) =>
            j.server === "jellyfin"
              ? `[Open in ${j.name}](${j.url}), then SyncPlay: join **${syncPlayName(n, item)}**`
              : `[Open in ${j.name}](${j.url})`,
          )
          .join(NL),
    n.code?.trim() ? `Room code: **${n.code.trim()}**` : "",
  ]
    .filter(Boolean)
    .join(NL);
  const fields: DiscordEmbed["fields"] = cancelled
    ? []
    : [
        { name: "Who's coming", value: clip(guestLine(n), 1024), inline: true },
        ...(where ? [{ name: "Where to watch", value: clip(where, 1024), inline: false }] : []),
      ];
  const embed: DiscordEmbed = {
    ...(banner
      ? {}
      : {
          author: { name: clip(invitationHeading(n, opts.reminder), 256) },
          title: clip(announceTitle(item), 256),
        }),
    description: clip(lines.filter(Boolean).join("\n\n"), 4000),
    color: cancelled ? 0x6b7280 : Number.parseInt(s.accent.replace(/^#/, ""), 16) || 0xff7a1a,
    ...(fields.length ? { fields } : {}),
    ...(s.branding ? { footer: { text: clip(s.branding, 2048) } } : {}),
  };
  // Streaming (and a Banner that could not be made): a wide picture under the invitation.
  // Cinematic and Compact: the poster beside it. A banner is not in the card at all: Discord shows
  // an attachment the card does not use above it.
  if (!banner) {
    if (look === "streaming" || look === "banner") {
      const wide = images.backdrop ?? images.poster;
      if (wide) embed.image = { url: `attachment://${wide}` };
    } else if (images.poster) embed.thumbnail = { url: `attachment://${images.poster}` };
  }
  return {
    username: clip(s.botName || "Hearth", 80),
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
}

const NL = String.fromCharCode(10);

/** Bold, in a Discord quote: each line of the note gets the quote mark. */
function quoted(text: string): string {
  return text
    .split(NL)
    .map((l) => (l.trim() ? `> **${l.trim()}**` : ">"))
    .join(NL);
}

/** The SyncPlay group name friends look for in Jellyfin. */
export function syncPlayName(n: MovieNight, item: AnnounceItem): string {
  return clip(`Movie night: ${item.title}`, 60);
}

/** The same invitation as plain text, for destinations that are not Discord. */
export function movieNightText(
  n: MovieNight,
  item: AnnounceItem,
  opts: { reminder?: ReminderKind; join?: JoinLink[]; timeText: string },
): { title: string; lines: string[] } {
  if (n.status === "cancelled")
    return { title: `Movie night cancelled: ${announceTitle(item)}`, lines: [] };
  return {
    title: `${opts.reminder ? REMINDER_TEXT[opts.reminder] : "Movie night"}: ${announceTitle(item)}`,
    lines: [
      opts.timeText,
      guestLine(n),
      ...(n.note ? [n.note] : []),
      ...(item.trailer ? [`Trailer: ${item.trailer}`] : []),
      ...(n.watch?.trim()
        ? [joinTokens(n.watch.trim(), opts.join, true)]
        : (opts.join ?? []).map((j) => `Watch in ${j.name}: ${j.url}`)),
      ...(n.code?.trim() ? [`Room code: ${n.code.trim()}`] : []),
    ],
  };
}
