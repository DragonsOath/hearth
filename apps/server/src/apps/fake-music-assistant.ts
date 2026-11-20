/**
 * A stand-in Music Assistant API (port 8099) for tests and safe previews (DC_FAKE_APPS=1, never in
 * a real install): the commands the music card's Up Next and likes use, in Music Assistant 2.10's
 * shapes (checked against the owner's Music Assistant command list, 11-11). One queue, the
 * Kitchen speaker's, with the song now and five after it; likes are kept in memory.
 */

interface Track {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
}

const TRACKS: Track[] = [
  {
    id: "t1",
    name: "Vacation",
    artist: "Simple Plan",
    album: "No Pads, No Helmets",
    duration: 151,
  },
  {
    id: "t2",
    name: "The Middle",
    artist: "Jimmy Eat World",
    album: "Bleed American",
    duration: 166,
  },
  { id: "t3", name: "Fat Lip", artist: "Sum 41", album: "All Killer No Filler", duration: 178 },
  {
    id: "t4",
    name: "My Friends Over You",
    artist: "New Found Glory",
    album: "Sticks and Stones",
    duration: 220,
  },
  { id: "t5", name: "Ocean Avenue", artist: "Yellowcard", album: "Ocean Avenue", duration: 198 },
  { id: "t6", name: "In Too Deep", artist: "Sum 41", album: "All Killer No Filler", duration: 207 },
];

export interface FakeMusicAssistant {
  fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;
  reset(): void;
}

export function fakeMusicAssistant(): FakeMusicAssistant {
  let at = 0;
  let liked = new Set<string>();
  const uri = (t: Track) => `ytmusic://track/${t.id}`;
  const item = (t: Track, i: number) => ({
    queue_item_id: `q-${t.id}`,
    name: `${t.artist} - ${t.name}`,
    duration: t.duration,
    sort_index: i,
    image: null,
    media_item: {
      item_id: liked.has(t.id) ? `lib-${t.id}` : t.id,
      provider: liked.has(t.id) ? "library" : "ytmusic",
      media_type: "track",
      name: t.name,
      uri: uri(t),
      artists: [{ name: t.artist }],
      album: { name: t.album },
      favorite: liked.has(t.id),
    },
  });
  const queue = () => ({
    queue_id: "kitchen_ma",
    display_name: "Kitchen speaker",
    current_index: at,
    current_item: item(TRACKS[at]!, at),
    items: TRACKS.length,
  });
  const answer = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(data),
    json: async () => data,
  });

  return {
    async fetch(url, init) {
      if (new URL(url).pathname !== "/api" || init.method !== "POST")
        return answer(404, { error: "not found" });
      if (!/^Bearer e2e-/.test(init.headers?.authorization ?? ""))
        return answer(401, { error: "unauthorized" });
      const { command, args = {} } = JSON.parse(init.body ?? "{}") as {
        command: string;
        args?: Record<string, unknown>;
      };
      const byUri = (u: unknown) => TRACKS.find((t) => uri(t) === u);
      switch (command) {
        case "player_queues/all":
          return answer(200, [queue()]);
        case "player_queues/items": {
          const off = Number(args.offset ?? 0);
          const lim = Number(args.limit ?? 500);
          return answer(
            200,
            TRACKS.slice(off, off + lim).map((t, i) => item(t, off + i)),
          );
        }
        case "player_queues/play_index": {
          const i = TRACKS.findIndex((t) => `q-${t.id}` === args.index);
          if (i >= 0) at = i;
          return answer(200, null);
        }
        case "music/library/add_item": {
          const t = byUri(args.item);
          if (!t) return answer(400, { error: "unknown item" });
          return answer(200, { item_id: `lib-${t.id}`, media_type: "track", name: t.name });
        }
        case "music/favorites/add_item": {
          const t = byUri(args.item);
          if (t) liked.add(t.id);
          return answer(200, null);
        }
        case "music/favorites/remove_item":
        case "music/library/remove_item": {
          const id = String(args.library_item_id ?? "").replace(/^lib-/, "");
          liked.delete(id);
          return answer(200, null);
        }
        case "config/providers":
          return answer(200, [
            { instance_id: "ytmusic", domain: "ytmusic", name: "YouTube Music" },
          ]);
        case "providers/manifests":
          return answer(200, [{ domain: "ytmusic", name: "YouTube Music" }]);
        default:
          return answer(200, []);
      }
    },
    reset() {
      at = 0;
      liked = new Set();
    },
  };
}
