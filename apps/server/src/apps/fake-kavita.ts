import type { Fetch } from "./http";

/**
 * A stand-in Kavita (port 5000) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): trades an e2e- key for a token like Kavita's plugin login, then answers the panel's
 * reads (stats, libraries, jobs, files it could not read) and its scan and backup calls.
 */

export interface FakeKavita {
  fetch: Fetch;
  reset(): void;
}

export function fakeKavita(): FakeKavita {
  const calls: string[] = [];
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    if (p === "/api/Plugin/authenticate" && method === "POST")
      return u.searchParams.get("apiKey")?.startsWith("e2e-")
        ? reply(200, { username: "admin", token: "jwt-e2e" })
        : reply(401, {});
    if (((init.headers ?? {}) as Record<string, string>).Authorization !== "Bearer jwt-e2e")
      return reply(401, {});
    if (p === "/api/Server/server-info-slim") return reply(200, { kavitaVersion: "0.8.8.3" });
    if (p === "/api/Stats/server/stats")
      return reply(200, {
        seriesCount: 420,
        volumeCount: 1310,
        chapterCount: 9800,
        totalFiles: 11020,
        totalSize: 210 * 1024 ** 3,
        totalReadingTime: 312,
      });
    if (p === "/api/Library/libraries")
      return reply(200, [
        {
          id: 1,
          name: "Manga",
          type: 0,
          lastScanned: new Date(Date.now() - 3_600_000).toISOString(),
          folders: ["/manga"],
        },
        {
          id: 2,
          name: "Books",
          type: 2,
          lastScanned: "0001-01-01T00:00:00",
          folders: ["/books", "/ebooks"],
        },
      ]);
    if (p === "/api/Server/jobs")
      return reply(200, [
        {
          id: "cleanup",
          title: "Cleanup",
          lastExecutionUtc: new Date(Date.now() - 86_400_000).toISOString(),
          cron: "0 0 * * *",
        },
      ]);
    if (p === "/api/Server/media-errors")
      return reply(200, [
        {
          filePath: "/books/Broken/broken.epub",
          details: "The file is not a valid EPUB",
          seriesName: "Broken",
          libraryName: "Books",
          isDismissed: false,
        },
        { filePath: "/manga/old.cbz", details: "Old", isDismissed: true },
      ]);
    if (method === "POST" && /^\/api\/(Library\/(scan|scan-all)|Server\/backup-db)$/.test(p)) {
      calls.push(p);
      return reply(200, null);
    }
    return reply(404, {});
  };
  return { fetch: fetchImpl, reset: () => (calls.length = 0) };
}
