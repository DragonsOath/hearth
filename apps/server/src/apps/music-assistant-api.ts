import type { MusicItem, MusicKind } from "./homeassistant-home";

/**
 * Hearth reading Music Assistant itself (11-05: "set up like Overseerr or a Plex library,
 * with poster art", "you don't have my quick picks", "I can't go into the playlist"). Home
 * Assistant's Music Assistant actions have no home rows and no playlist contents, so Hearth
 * keeps its own Music Assistant key (made when the owner linked it) and reads these directly:
 * the home rows (YouTube Music's own rows such as Listen again and Mixed for you, then the
 * library's), and what is inside a playlist, an album or an artist. Playing still goes through
 * Home Assistant (play_media), so a speaker is always one Home Assistant knows.
 */

export type MaCall = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const KINDS = new Set<MusicKind>(["track", "album", "artist", "playlist", "radio"]);

interface RawImage {
  type?: string;
  path?: string;
  remotely_accessible?: boolean;
  proxy_id?: string | null;
}
interface RawItem {
  uri?: string;
  media_type?: string;
  name?: string;
  image?: RawImage | null;
  metadata?: { images?: RawImage[] | null } | null;
  artists?: { name?: string }[] | null;
  album?: { name?: string } | null;
  owner?: string | null;
}

/** Where a poster comes from: a public address as is, else through Hearth (Music Assistant's proxy). */
export function artOf(raw: RawItem): string | undefined {
  const images = [raw.image, ...(raw.metadata?.images ?? [])].filter((i): i is RawImage =>
    Boolean(i && (i.path || i.proxy_id)),
  );
  const img = images.find((i) => (i.type ?? "thumb") === "thumb") ?? images[0];
  if (!img) return undefined;
  if (img.remotely_accessible && img.path && /^https:\/\//.test(img.path)) return img.path;
  if (img.proxy_id && /^[A-Za-z0-9_-]{4,200}$/.test(img.proxy_id))
    return `/api/home/music/art?id=${encodeURIComponent(img.proxy_id)}`;
  return undefined;
}

export function maItem(raw: RawItem): MusicItem | undefined {
  const kind = String(raw.media_type ?? "") as MusicKind;
  if (!raw.uri || !KINDS.has(kind)) return undefined;
  const by = (raw.artists ?? [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(", ");
  const image = artOf(raw);
  return {
    uri: raw.uri.slice(0, 500),
    kind,
    name: String(raw.name ?? raw.uri).slice(0, 200),
    ...(by ? { by: by.slice(0, 200) } : raw.owner ? { by: String(raw.owner).slice(0, 200) } : {}),
    ...(raw.album?.name ? { album: String(raw.album.name).slice(0, 200) } : {}),
    ...(image ? { image } : {}),
  };
}

const items = (list: unknown): MusicItem[] =>
  (Array.isArray(list) ? (list as RawItem[]) : [])
    .map(maItem)
    .filter((x): x is MusicItem => Boolean(x));

export interface MusicRow {
  id: string;
  title: string;
  items: MusicItem[];
  /** The music service the row is from (its own rows); none for the library's rows. */
  service?: string;
}

/** Each added music service's name, by its Music Assistant instance and its kind. */
export async function serviceNames(call: MaCall): Promise<Map<string, string>> {
  const [configs, manifests] = await Promise.all([
    call<{ instance_id?: string; domain?: string; name?: string | null }[]>(
      "config/providers",
    ).catch(() => []),
    call<{ domain?: string; name?: string }[]>("providers/manifests").catch(() => []),
  ]);
  const byDomain = new Map(
    (Array.isArray(manifests) ? manifests : []).map((m) => [
      String(m.domain),
      String(m.name ?? m.domain),
    ]),
  );
  const out = new Map<string, string>();
  for (const [d, n] of byDomain) out.set(d, n.replace(/ Media Server Library$/, ""));
  for (const c of Array.isArray(configs) ? configs : [])
    if (c.instance_id)
      out.set(
        c.instance_id,
        (c.name || byDomain.get(String(c.domain)) || String(c.domain)).replace(
          / Media Server Library$/,
          "",
        ),
      );
  return out;
}

/** Library rows worth showing after the music service's own rows, in this order. */
const LIBRARY_ROWS = [
  "recently_played",
  "favorite_playlists",
  "recent_artists",
  "recently_added_albums",
  "most_played_tracks",
  "forgotten_tracks",
];

/** The home rows: the music service's own (Listen again, Mixed for you, ...), then the library's. */
export async function musicHomeRows(
  call: MaCall,
  max = 9,
  /** YouTube Music's own home rows read by Hearth (youtube-music.ts), used in place of Music Assistant's few. */
  own?: MusicRow[],
): Promise<MusicRow[]> {
  const rows =
    await call<{ provider?: string; item_id?: string; name?: string }[]>("music/recommendations");
  const all = (Array.isArray(rows) ? rows : []).filter((r) => r.provider && r.item_id && r.name);
  const service = own?.length ? [] : all.filter((r) => r.provider !== "recommendations");
  const library = LIBRARY_ROWS.map((id) =>
    all.find((r) => r.provider === "recommendations" && r.item_id === id),
  ).filter((r): r is NonNullable<typeof r> => Boolean(r));
  const pick = [...service, ...library].slice(0, Math.max(0, max - (own?.length ?? 0)));
  const names = await serviceNames(call).catch(() => new Map<string, string>());
  const filled = await Promise.all(
    pick.map(async (r) => ({
      id: `${r.provider}:${r.item_id}`,
      title: String(r.name).slice(0, 80),
      ...(r.provider !== "recommendations" && names.get(String(r.provider))
        ? { service: names.get(String(r.provider))! }
        : {}),
      items: items(
        await call("music/recommendations/items", {
          provider: r.provider,
          item_id: r.item_id,
        }).catch(() => []),
      ).slice(0, 30),
    })),
  );
  return [...(own ?? []), ...filled.filter((r) => r.items.length)];
}

/** `provider://kind/id` (Music Assistant's item address), or nothing. */
export function parseMusicUri(uri: string) {
  const m = /^([A-Za-z0-9_-]+):\/\/(track|album|artist|playlist|radio)\/(.+)$/.exec(uri);
  return m
    ? { provider: m[1]!, kind: m[2] as MusicKind, id: decodeURIComponent(m[3]!) }
    : undefined;
}

/** What is inside a playlist, an album or an artist (its songs, and an artist's albums). */
export async function musicOpen(
  call: MaCall,
  uri: string,
): Promise<{ item?: MusicItem; tracks: MusicItem[]; albums: MusicItem[] }> {
  const u = parseMusicUri(uri);
  if (!u || !["playlist", "album", "artist"].includes(u.kind)) return { tracks: [], albums: [] };
  const base = { item_id: u.id, provider_instance_id_or_domain: u.provider };
  const head = await call<RawItem>("music/item_by_uri", { uri }).catch(() => undefined);
  const item = head ? maItem(head) : undefined;
  if (u.kind === "playlist")
    return {
      ...(item ? { item } : {}),
      tracks: items(await call("music/playlists/playlist_tracks", base)).slice(0, 500),
      albums: [],
    };
  if (u.kind === "album")
    return {
      ...(item ? { item } : {}),
      tracks: items(await call("music/albums/album_tracks", base)).slice(0, 300),
      albums: [],
    };
  const [tracks, albums] = await Promise.all([
    call("music/artists/artist_tracks", base).catch(() => []),
    call("music/artists/artist_albums", base).catch(() => []),
  ]);
  return {
    ...(item ? { item } : {}),
    tracks: items(tracks).slice(0, 100),
    albums: items(albums).slice(0, 60),
  };
}

/* ---------- Up Next and likes (11-11, the owner: "I want to see the queue and a like dislike") ---------- */

interface RawQueueItem {
  queue_item_id?: string;
  name?: string;
  duration?: number | null;
  image?: RawImage | null;
  media_item?:
    (RawItem & { item_id?: string | number; provider?: string; favorite?: boolean }) | null;
}
interface RawQueue {
  queue_id?: string;
  display_name?: string;
  current_index?: number | null;
  current_item?: RawQueueItem | null;
}

export interface QueueTrack {
  /** Music Assistant's queue item id (play it with this). */
  id: string;
  index: number;
  name: string;
  artist?: string;
  duration?: number;
  art?: string;
}

export interface MusicQueue {
  queueId: string;
  /** The song playing now: liked means saved (YouTube Music's like, through Music Assistant). */
  current?: { index: number; name: string; uri?: string; liked: boolean };
  next: QueueTrack[];
  /** The music service the song comes from, in words ("YouTube Music"), when known. */
  service?: string;
}

const trackOf = (q: RawQueueItem, index: number): QueueTrack | undefined => {
  if (!q.queue_item_id) return undefined;
  const m = q.media_item ?? undefined;
  const art = (q.image && artOf({ image: q.image })) || (m ? artOf(m) : undefined);
  const artist = m?.artists
    ?.map((a) => a.name)
    .filter(Boolean)
    .join(", ");
  return {
    id: q.queue_item_id,
    index,
    name: m?.name ?? q.name ?? "Unknown",
    ...(artist ? { artist } : {}),
    ...(q.duration ? { duration: q.duration } : {}),
    ...(art ? { art } : {}),
  };
};

/** The queue a speaker plays from: by its Home Assistant queue id, else by its name. */
export async function findQueue(
  call: MaCall,
  speaker: { queue?: string; name: string },
): Promise<RawQueue | undefined> {
  const all = await call<RawQueue[]>("player_queues/all");
  const name = speaker.name.trim().toLowerCase();
  return (
    all.find((q) => speaker.queue && q.queue_id === speaker.queue) ??
    all.find((q) => (q.display_name ?? "").trim().toLowerCase() === name)
  );
}

/** Up Next: the song now and the next ones (25 at most), with whether the song is liked. */
export async function musicQueue(
  call: MaCall,
  speaker: { queue?: string; name: string },
): Promise<MusicQueue | undefined> {
  const q = await findQueue(call, speaker);
  if (!q?.queue_id) return undefined;
  const at = q.current_index ?? 0;
  const items = await call<RawQueueItem[]>("player_queues/items", {
    queue_id: q.queue_id,
    limit: 26,
    offset: at,
  });
  const cur = q.current_item ?? items[0];
  const m = cur?.media_item ?? undefined;
  const services = m?.uri
    ? await serviceNames(call).catch(() => new Map<string, string>())
    : undefined;
  const service = m?.uri ? services?.get(m.uri.split("://")[0] ?? "") : undefined;
  return {
    queueId: q.queue_id,
    ...(cur
      ? {
          current: {
            index: at,
            name: m?.name ?? cur.name ?? "",
            ...(m?.uri ? { uri: m.uri } : {}),
            liked: Boolean(m?.favorite),
          },
        }
      : {}),
    next: items
      .slice(1)
      .map((x, i) => trackOf(x, at + 1 + i))
      .filter((x): x is QueueTrack => Boolean(x)),
    ...(service ? { service } : {}),
  };
}
