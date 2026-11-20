import type { Fetch } from "./http";

/**
 * A stand-in Audiobookshelf (port 13378) for tests and safe previews (DC_FAKE_APPS=1, never in a
 * real install): a books and a podcasts library, one person listening, an old backup, and the
 * scan and backup calls the panel's controls make.
 */

export interface FakeAudiobookshelf {
  fetch: Fetch;
  reset(): void;
  /** Library scans asked for, in order (audiobook intake). */
  scans(): string[];
  /** A new audiobook arrives (New in your library), added now. */
  arrive(title: string): void;
}

/** A 1x1 gold PNG: the sample cover. */
const COVER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==",
  "base64",
);

const OLD = () => [{ id: "b1", createdAt: Date.now() - 12 * 86_400_000, fileSize: 1_200_000 }];

interface FakeList {
  id: string;
  libraryId: string;
  name: string;
  ids: string[];
}
const LISTS = () => ({
  collections: [
    { id: "col-tbr", libraryId: "lib-books", name: "TBR", ids: ["li-dune"] },
  ] as FakeList[],
  playlists: [
    { id: "pl-road", libraryId: "lib-books", name: "Road trip", ids: ["li-hail"] },
  ] as FakeList[],
});

export function fakeAudiobookshelf(): FakeAudiobookshelf {
  let backups = OLD();
  let lists = LISTS();
  let hobbitHidden = false;
  const scans: string[] = [];
  let arrivals: { id: string; title: string; at: number }[] = [];
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    if (p === "/status")
      return reply(200, { app: "audiobookshelf", serverVersion: "2.35.1", isInit: true });
    const auth = ((init.headers ?? {}) as Record<string, string>).Authorization ?? "";
    if (!auth.startsWith("Bearer e2e-")) return reply(401, {});
    if (p === "/api/items/li-hail/cover" || p === "/api/items/li-hobbit/cover")
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        json: async () => null,
        arrayBuffer: async () =>
          COVER.buffer.slice(COVER.byteOffset, COVER.byteOffset + COVER.byteLength),
      } as unknown as Awaited<ReturnType<Fetch>>;
    if (p === "/api/libraries")
      return reply(200, {
        libraries: [
          {
            id: "lib-books",
            name: "Audiobooks",
            mediaType: "book",
            folders: [{ id: "fol-books", fullPath: "/audiobooks" }],
          },
          { id: "lib-pods", name: "Podcasts", mediaType: "podcast", folders: [{}] },
        ],
      });
    if (p === "/api/libraries/lib-books/stats")
      return reply(200, {
        totalItems: 312,
        totalAuthors: 140,
        totalDuration: 3_600 * 4210,
        totalSize: 180 * 1024 ** 3,
      });
    if (p === "/api/libraries/lib-pods/stats")
      return reply(200, {
        totalItems: 18,
        totalAuthors: 0,
        totalDuration: 3_600 * 600,
        totalSize: 30 * 1024 ** 3,
      });
    if (/^\/api\/libraries\/[\w-]+\/items$/.test(p))
      return reply(200, {
        results: p.includes("books")
          ? [
              ...arrivals.map((a) => ({
                id: a.id,
                addedAt: a.at,
                media: {
                  numTracks: 24,
                  duration: 3_600 * 9.5,
                  metadata: {
                    title: a.title,
                    authorName: "Sample Author",
                    narratorName: "Sample Narrator",
                    genres: ["Fantasy"],
                  },
                },
              })),
              {
                id: "li-hail",
                addedAt: Date.now() - 3_600_000,
                media: {
                  numTracks: 32,
                  coverPath: "/audiobooks/Andy Weir/Project Hail Mary/cover.jpg",
                  duration: 3_600 * 16.2,
                  metadata: {
                    title: "Project Hail Mary",
                    authorName: "Andy Weir",
                    narratorName: "Ray Porter",
                    publishedYear: "2021",
                    genres: ["Science Fiction"],
                    description:
                      "<p>Ryland Grace is the sole survivor on a desperate, last-chance mission.</p>",
                  },
                },
              },
            ]
          : [],
      });
    const hobbit = {
      id: "li-hobbit",
      media: {
        coverPath: "/audiobooks/Tolkien/The Hobbit/cover.jpg",
        duration: 3_600 * 10,
        chapters: [
          { start: 0, end: 3_600 * 1.2, title: "An Unexpected Party" },
          { start: 3_600 * 1.2, end: 3_600 * 2.5, title: "Roast Mutton" },
          { start: 3_600 * 2.5, end: 3_600 * 3.5, title: "Over Hill and Under Hill" },
          { start: 3_600 * 3.5, end: 3_600 * 10, title: "Riddles in the Dark" },
        ],
        metadata: {
          title: "The Hobbit",
          authorName: "J.R.R. Tolkien",
          narratorName: "Andy Serkis",
        },
      },
    };
    const hail = {
      id: "li-hail",
      media: {
        coverPath: "/audiobooks/Andy Weir/Project Hail Mary/cover.jpg",
        duration: 3_600 * 16.2,
        metadata: {
          title: "Project Hail Mary",
          authorName: "Andy Weir",
          narratorName: "Ray Porter",
        },
      },
    };
    const dune = {
      id: "li-dune",
      media: { duration: 3_600 * 21, metadata: { title: "Dune", authorName: "Frank Herbert" } },
    };
    if (p === "/api/me")
      return reply(200, {
        username: "alex",
        mediaProgress: [
          {
            id: "mp-hobbit",
            libraryItemId: "li-hobbit",
            hideFromContinueListening: hobbitHidden,
            progress: 0.3,
            currentTime: 3_600 * 3,
            duration: 3_600 * 10,
            lastUpdate: Date.now() - 600_000,
          },
        ],
      });
    if (p === "/api/me/items-in-progress")
      return reply(200, { libraryItems: hobbitHidden ? [] : [hobbit] });
    if (p === "/api/me/progress/mp-hobbit/remove-from-continue-listening") {
      hobbitHidden = true;
      return reply(200, {});
    }
    if (p === "/api/items/li-hobbit") return reply(200, hobbit);
    // Your lists: collections (shared in a library) and the key's account's playlists.
    const items: Record<string, unknown> = {
      "li-hobbit": hobbit,
      "li-dune": dune,
      "li-hail": hail,
    };
    const asCollection = (c: FakeList) => ({
      id: c.id,
      libraryId: c.libraryId,
      name: c.name,
      books: c.ids.map((id) => items[id] ?? { id }),
    });
    const asPlaylist = (l: FakeList) => ({
      id: l.id,
      libraryId: l.libraryId,
      name: l.name,
      items: l.ids.map((id) => ({
        libraryItemId: id,
        episodeId: null,
        libraryItem: items[id] ?? { id },
      })),
    });
    const body = () =>
      init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (p === "/api/collections" && method === "GET")
      return reply(200, { collections: lists.collections.map(asCollection) });
    if (p === "/api/playlists" && method === "GET")
      return reply(200, { playlists: lists.playlists.map(asPlaylist) });
    if (p === "/api/playlists" && method === "POST") {
      const b = body() as {
        libraryId?: string;
        name?: string;
        items?: { libraryItemId?: string }[];
      };
      const ids = (b.items ?? []).map((i) => i.libraryItemId!).filter(Boolean);
      if (!b.name || !b.libraryId || !ids.length) return reply(400, {});
      const l = {
        id: `pl-${lists.playlists.length + 1}x`,
        libraryId: b.libraryId,
        name: b.name,
        ids,
      };
      lists.playlists.push(l);
      return reply(200, asPlaylist(l));
    }
    const one = /^\/api\/(playlists|collections)\/([\w-]+)(?:\/(item|book)(?:\/([\w-]+))?)?$/.exec(
      p,
    );
    if (one) {
      const [, kind, id, sub, itemId] = one;
      const pool = kind === "playlists" ? lists.playlists : lists.collections;
      const l = pool.find((x) => x.id === id);
      if (!l) return reply(404, {});
      const show = () => reply(200, kind === "playlists" ? asPlaylist(l) : asCollection(l));
      if (!sub && method === "GET") return show();
      if (!sub && method === "PATCH") {
        const b = body() as { items?: { libraryItemId?: string }[]; books?: string[] };
        const order =
          kind === "playlists" ? (b.items ?? []).map((i) => i.libraryItemId!) : (b.books ?? []);
        if (order.length !== l.ids.length || order.some((x) => !l.ids.includes(x)))
          return reply(400, {});
        l.ids = order;
        return show();
      }
      if (sub && !itemId && method === "POST") {
        const b = body() as { libraryItemId?: string; id?: string };
        const add = kind === "playlists" ? b.libraryItemId : b.id;
        if (!add || l.ids.includes(add)) return reply(400, {});
        l.ids.push(add);
        return show();
      }
      if (sub && itemId && method === "DELETE") {
        if (!l.ids.includes(itemId)) return reply(404, {});
        l.ids = l.ids.filter((x) => x !== itemId);
        // Audiobookshelf deletes a playlist once its last item is taken out.
        if (kind === "playlists" && !l.ids.length) {
          lists.playlists = lists.playlists.filter((x) => x !== l);
          return reply(200, {});
        }
        return show();
      }
    }
    if (p === "/api/libraries/lib-books/personalized")
      return reply(200, [
        { id: "continue-listening", type: "book", entities: [hobbit] },
        { id: "continue-series", type: "book", entities: [dune] },
      ]);
    if (p === "/api/users/online")
      return reply(200, {
        usersOnline: [{ username: "alex" }],
        openSessions: [
          {
            id: "ls1",
            libraryItemId: "li-hobbit",
            user: { username: "alex" },
            displayTitle: "The Hobbit",
            displayAuthor: "J.R.R. Tolkien",
            deviceInfo: { clientName: "Abs Android", deviceName: "Pixel" },
            currentTime: 3_600 * 3,
            duration: 3_600 * 10,
          },
        ],
      });
    if (p === "/api/backups" && method === "GET") return reply(200, { backups });
    if (p === "/api/backups" && method === "POST") {
      backups = [
        ...backups,
        { id: `b${backups.length + 1}`, createdAt: Date.now(), fileSize: 1_300_000 },
      ];
      return reply(200, { backups });
    }
    const scan = /^\/api\/libraries\/([\w-]+)\/scan$/.exec(p);
    if (scan && method === "POST") {
      scans.push(scan[1]!);
      return reply(200, {});
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      backups = OLD();
      lists = LISTS();
      hobbitHidden = false;
      arrivals = [];
    },
    arrive: (title) => {
      arrivals = [{ id: `li-new${arrivals.length + 1}`, title, at: Date.now() }, ...arrivals];
    },
    scans: () => [...scans],
  };
}
