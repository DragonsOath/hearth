import type { Fetch } from "./http";

/**
 * A stand-in Lidarr (port 8686) and Chaptarr (port 8789) for tests and safe previews
 * (DC_FAKE_APPS=1, never in a real install): a queue with one stuck download, missing albums or
 * books, one coming out, and the search and remove calls the panel makes; Chaptarr also has a
 * small collection (one book in both formats, one wanted and missing, one coming) and the want
 * call.
 */

export interface FakeArrV1 {
  fetch: Fetch;
  reset(): void;
  /** Search commands started, with their book or album ids. */
  searches(): { name: string; ids: number[] }[];
}

export function fakeArrV1(app: "lidarr" | "chaptarr"): FakeArrV1 {
  let searches: { name: string; ids: number[] }[] = [];
  const L = app === "lidarr";
  const person = (n: string) => (L ? { artistName: n } : { authorName: n });
  const work = (id: number, title: string, who: string, releaseDate: string) =>
    L
      ? { id, title, releaseDate, artist: person(who) }
      : { id, title, releaseDate, author: person(who) };
  const QUEUE = () => [
    {
      id: 501,
      status: "completed",
      trackedDownloadStatus: "warning",
      trackedDownloadState: "importPending",
      statusMessages: [
        { messages: [L ? "No files found are eligible for import" : "Book not found in folder"] },
      ],
      title: L ? "Radiohead-OK_Computer-1997-FLAC" : "Andy.Weir.Project.Hail.Mary.2021.EPUB",
      size: 100,
      sizeleft: 0,
      downloadId: "fake-dl-501",
      downloadClient: "SABnzbd",
      indexer: "UsenetOne",
      ...(L
        ? { artist: person("Radiohead"), album: { title: "OK Computer" } }
        : { author: person("Andy Weir"), book: { title: "Project Hail Mary" } }),
    },
    {
      id: 502,
      status: "downloading",
      trackedDownloadStatus: "ok",
      title: L ? "Bjork-Homogenic-1997-FLAC" : "Ursula.K.Le.Guin.The.Dispossessed.EPUB",
      size: 200,
      sizeleft: 50,
      timeleft: "00:04:10",
      downloadClient: "qBittorrent",
      indexer: "Prowlarr",
      ...(L
        ? { artist: person("Bjork"), album: { title: "Homogenic" } }
        : { author: person("Ursula K. Le Guin"), book: { title: "The Dispossessed" } }),
    },
  ];
  let queue = QUEUE();
  let missing = [work(31, L ? "Kid A" : "Artemis", L ? "Radiohead" : "Andy Weir", "2000-10-02")];
  const BOOKS = () => [
    {
      id: 61,
      title: "The Martian",
      authorId: 1,
      mediaType: "audiobook",
      monitored: true,
      hasFiles: true,
      releaseDate: "2014-02-11T00:00:00Z",
      narrator: "R. C. Bray",
      durationMinutes: 653,
      statistics: { bookFileCount: 1, sizeOnDisk: 312_000_000 },
    },
    {
      id: 62,
      title: "The Martian",
      authorId: 1,
      mediaType: "ebook",
      monitored: true,
      hasFiles: true,
      releaseDate: "2014-02-11T00:00:00Z",
      pageCount: 387,
      statistics: { bookFileCount: 1, sizeOnDisk: 4_100_000 },
    },
    {
      id: 63,
      title: "Artemis",
      authorId: 1,
      mediaType: "ebook",
      monitored: true,
      hasFiles: false,
      releaseDate: "2017-11-14T00:00:00Z",
      statistics: { bookFileCount: 0, sizeOnDisk: 0 },
    },
    {
      id: 64,
      title: "The Dispossessed",
      authorId: 2,
      mediaType: "audiobook",
      monitored: false,
      hasFiles: false,
      releaseDate: "1974-05-01T00:00:00Z",
      statistics: { bookFileCount: 0, sizeOnDisk: 0 },
    },
    {
      id: 65,
      title: "The Next One",
      seriesTitle: "Hail Mary #2",
      authorId: 1,
      mediaType: "audiobook",
      monitored: false,
      hasFiles: false,
      releaseDate: new Date(Date.now() + 40 * 86_400_000).toISOString(),
      statistics: { bookFileCount: 0, sizeOnDisk: 0 },
    },
    {
      id: 66,
      title: "火星の人",
      authorId: 1,
      mediaType: "ebook",
      monitored: false,
      hasFiles: false,
      releaseDate: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      statistics: { bookFileCount: 0, sizeOnDisk: 0 },
    },
  ];
  let books = BOOKS();
  const commands = new Map<number, string>();
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (!headers["X-Api-Key"]?.startsWith("e2e-")) return reply(401, {});
    if (p === "/api/v1/system/status") return reply(200, { version: L ? "2.9.6" : "0.9.1" });
    if (p === "/api/v1/health") return reply(200, []);
    if (p === "/api/v1/queue" && method === "GET")
      return reply(200, { totalRecords: queue.length, records: queue });
    const del = /^\/api\/v1\/queue\/(\d+)$/.exec(p);
    if (del && method === "DELETE") {
      queue = queue.filter((q) => q.id !== Number(del[1]));
      return reply(200, {});
    }
    if (p === "/api/v1/wanted/missing")
      return reply(200, { totalRecords: missing.length, records: missing });
    if (p === "/api/v1/calendar")
      return reply(200, [
        work(
          40,
          L ? "New Album" : "New Book",
          L ? "Bjork" : "Andy Weir",
          new Date(Date.now() + 5 * 86_400_000).toISOString(),
        ),
      ]);
    if (p === "/api/v1/history")
      return reply(200, {
        records: [
          {
            date: new Date().toISOString(),
            eventType: "downloadImported",
            sourceTitle: L ? "Bjork - Post" : "Andy Weir - The Martian",
            quality: { quality: { name: L ? "FLAC" : "EPUB" } },
          },
        ],
      });
    if (p === "/api/v1/artist" || p === "/api/v1/author")
      return reply(200, [
        {
          id: 1,
          monitored: true,
          ...(L ? { artistName: "Radiohead" } : { authorName: "Andy Weir" }),
          ...(L ? {} : { nextBook: { title: "The Next One", releaseDate: books[4]!.releaseDate } }),
        },
        {
          id: 2,
          monitored: true,
          ...(L ? { artistName: "Bjork" } : { authorName: "Ursula K. Le Guin" }),
        },
        {
          id: 3,
          monitored: false,
          ...(L ? { artistName: "Low" } : { authorName: "Iain M. Banks" }),
        },
      ]);
    if (!L && p === "/api/v1/book" && method === "GET") return reply(200, books);
    if (!L && p === "/api/v1/rootfolder")
      return reply(200, [
        { name: "Audio Books", path: "/audiobooks", freeSpace: 4e12, totalSpace: 8e12 },
        { name: "Books", path: "/ebooks", freeSpace: 4e12, totalSpace: 8e12 },
      ]);
    const one = /^\/api\/v1\/book\/(\d+)$/.exec(p);
    if (!L && one && method === "GET") {
      const b = books.find((x) => x.id === Number(one[1]));
      return b ? reply(200, b) : reply(404, {});
    }
    // Adding a book (Chaptarr 0.9, seen on the owner's 11-17): with a new author whose addOptions
    // say monitor "none", the book ends up not wanted whatever it was sent with, and no search runs.
    if (!L && p === "/api/v1/book" && method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown> & {
        author?: { addOptions?: { monitor?: string } };
      };
      const id = 9000 + books.length;
      const none = body.author?.addOptions?.monitor === "none";
      const made = {
        ...body,
        id,
        monitored: none ? false : body.monitored !== false,
      } as (typeof books)[number];
      books = [...books, made];
      return reply(201, made);
    }
    if (!L && p === "/api/v1/book/monitor" && method === "PUT") {
      const body = JSON.parse(String(init.body)) as { bookIds: number[]; monitored: boolean };
      books = books.map((b) =>
        body.bookIds.includes(b.id) ? { ...b, monitored: body.monitored } : b,
      );
      return reply(202, {});
    }
    // Interactive search: Lidarr's albums; what the indexers offer for one item; downloading one.
    if (L && p === "/api/v1/album" && method === "GET")
      return reply(200, [
        { id: 31, title: "Kid A", releaseDate: "2000-10-02", artist: person("Radiohead") },
        { id: 32, title: "OK Computer", releaseDate: "1997-05-21", artist: person("Radiohead") },
      ]);
    if (p === "/api/v1/release" && method === "GET") {
      const item = u.searchParams.get(L ? "albumId" : "bookId");
      if (!item) return reply(400, {});
      const found = [
        {
          guid: `fake-${item}-1`,
          indexerId: 1,
          title: L ? `Album-${item}-FLAC-WEB` : `Book.${item}.Unabridged.m4b`,
          indexer: "UsenetOne (Prowlarr)",
          size: 450_000_000,
          protocol: "usenet",
          ageHours: 12,
          quality: { quality: { name: L ? "FLAC" : "M4B" } },
          approved: true,
          rejections: [],
        },
        {
          guid: `fake-${item}-2`,
          indexerId: 2,
          title: L ? `Album-${item}-MP3-128` : `Book.${item}.Abridged.mp3`,
          indexer: "TrackerTwo (Prowlarr)",
          size: 90_000_000,
          protocol: "torrent",
          seeders: 4,
          leechers: 1,
          ageHours: 400,
          quality: { quality: { name: L ? "MP3-128" : "MP3" } },
          approved: false,
          rejections: [{ reason: "Not wanted in profile" }],
        },
      ];
      // Chaptarr answers in two lists: the ones it hides on its page come separately.
      return reply(200, L ? found : { releases: [found[0]], hiddenReleases: [found[1]] });
    }
    if (p === "/api/v1/release" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { guid: string; indexerId: number };
      const m = /^fake-(\d+)-(\d)$/.exec(body.guid);
      if (!m) return reply(404, {});
      const title =
        m[2] === "1"
          ? L
            ? `Album-${m[1]}-FLAC-WEB`
            : `Book.${m[1]}.Unabridged.m4b`
          : L
            ? `Album-${m[1]}-MP3-128`
            : `Book.${m[1]}.Abridged.mp3`;
      queue = [
        ...queue,
        {
          id: 600 + queue.length,
          status: "downloading",
          trackedDownloadStatus: "ok",
          title,
          size: 100,
          sizeleft: 100,
          timeleft: "00:10:00",
          downloadClient: "SABnzbd",
          indexer: "UsenetOne",
          ...(L
            ? { artist: person("Radiohead"), album: { title: "Kid A" } }
            : { author: person("Andy Weir"), book: { title: "Artemis" } }),
        } as (typeof queue)[number],
      ];
      return reply(200, { title });
    }
    // Manual import: the stuck download's files and what the app would match them to.
    if (p === "/api/v1/manualimport" && method === "GET") {
      const dl = u.searchParams.get("downloadId");
      if (!queue.some((q) => (q as { downloadId?: string }).downloadId === dl))
        return reply(200, []);
      return reply(200, [
        {
          path: L ? "/downloads/OK_Computer/01.flac" : "/downloads/Project.Hail.Mary/book.epub",
          downloadId: dl,
          quality: { quality: { name: L ? "FLAC" : "EPUB" } },
          rejections: [{ reason: L ? "Album match is not close enough" : "Book not found" }],
        },
      ]);
    }
    if (p === "/api/v1/command" && method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        albumIds?: number[];
        bookIds?: number[];
        files?: { downloadId?: string }[];
      };
      if (body.name === "ManualImport") {
        const dls = new Set((body.files ?? []).map((f) => f.downloadId));
        queue = queue.filter((q) => !dls.has((q as { downloadId?: string }).downloadId));
      }
      const ids = body.albumIds ?? body.bookIds ?? [];
      if (/^Album|^Book/.test(body.name)) missing = missing.filter((m) => !ids.includes(m.id));
      if (/^Missing/.test(body.name)) missing = [];
      const id = 900 + commands.size;
      commands.set(id, body.name);
      if (/Search$/.test(body.name)) searches.push({ name: body.name, ids });
      return reply(201, { id, status: "queued" });
    }
    const cmd = /^\/api\/v1\/command\/(\d+)$/.exec(p);
    if (cmd) return reply(200, { id: Number(cmd[1]), status: "completed" });
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    searches: () => searches,
    reset: () => {
      searches = [];
      queue = QUEUE();
      missing = [work(31, L ? "Kid A" : "Artemis", L ? "Radiohead" : "Andy Weir", "2000-10-02")];
      books = BOOKS();
    },
  };
}
