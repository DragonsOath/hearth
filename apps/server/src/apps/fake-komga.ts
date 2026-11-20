import type { Fetch } from "./http";

/**
 * A stand-in Komga (port 25600) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as a throwaway gotson/komga 1.30.0 did: an API key starting "e2e-", two
 * libraries, a book it could not read, recently added books, two users, sign-in activity with
 * failed attempts, its history, and the library tasks (a scan adds a book).
 */

export interface FakeKomga {
  fetch: Fetch;
  reset(): void;
}

export function fakeKomga(): FakeKomga {
  let books = { comics: 412, manga: 230 };
  let unreadable = [
    {
      id: "b-bad",
      name: "Harbor Lights v03",
      seriesTitle: "Harbor Lights",
      media: { status: "ERROR", comment: "ERR_1002" },
    },
  ];
  const ago = (min: number) =>
    new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
  const reset = () => {
    books = { comics: 412, manga: 230 };
    unreadable = [
      {
        id: "b-bad",
        name: "Harbor Lights v03",
        seriesTitle: "Harbor Lights",
        media: { status: "ERROR", comment: "ERR_1002" },
      },
    ];
  };
  reset();

  const reply = (status: number, body: unknown) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text || "null") as unknown,
      text: async () => text,
    };
  };
  const page = (content: unknown[], total = content.length) =>
    reply(200, { content, totalElements: total });

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname;
    const method = init.method ?? "GET";
    if (path === "/actuator/info") return reply(200, { build: { version: "1.30.0" } });
    if (!(init.headers["X-API-Key"] ?? "").startsWith("e2e-"))
      return reply(401, { message: "Unauthorized" });
    const lib = u.searchParams.get("library_id");
    if (path === "/api/v1/libraries")
      return reply(200, [
        { id: "lib-comics", name: "Comics", root: "/data/comics", scanInterval: "EVERY_6H" },
        { id: "lib-manga", name: "Manga", root: "/data/manga", scanInterval: "DISABLED" },
      ]);
    if (path === "/api/v1/series")
      return page([], lib === "lib-comics" ? 38 : lib === "lib-manga" ? 21 : 59);
    if (path === "/api/v1/books") {
      if (u.searchParams.getAll("media_status").length) return page(unreadable);
      return page(
        [],
        lib === "lib-comics"
          ? books.comics
          : lib === "lib-manga"
            ? books.manga
            : books.comics + books.manga,
      );
    }
    if (path === "/api/v1/books/latest")
      return page([
        { id: "b1", name: "Lantern Tales v04", seriesTitle: "Lantern Tales", created: ago(30) },
        {
          id: "b2",
          name: "Lantern Tales v03",
          seriesTitle: "Lantern Tales",
          created: ago(60 * 24 * 2),
        },
      ]);
    if (path === "/api/v2/users")
      return reply(200, [
        { id: "u1", email: "alex@example.com", roles: ["ADMIN", "USER"] },
        { id: "u2", email: "kid@example.com", roles: ["USER"] },
      ]);
    if (path === "/api/v2/users/authentication-activity")
      return page([
        { email: "alex@example.com", ip: "10.0.0.5", success: true, dateTime: ago(3) },
        { email: "kid@example.com", ip: "10.0.0.8", success: true, dateTime: ago(60 * 3) },
        ...Array.from({ length: 6 }, (_, i) => ({
          email: "kid@example.com",
          ip: "203.0.113.9",
          success: false,
          dateTime: ago(60 + i),
        })),
      ]);
    if (path === "/api/v1/history")
      return page([
        { type: "BookImported", timestamp: ago(30), properties: { name: "Lantern Tales v04" } },
      ]);
    if (path === "/api/v1/readlists") return page([], 3);
    if (path === "/api/v1/collections") return page([], 5);
    const m = /^\/api\/v1\/libraries\/([^/]+)\/(scan|analyze|metadata\/refresh|empty-trash)$/.exec(
      path,
    );
    if (m && method === "POST") {
      if (m[2] === "scan" && m[1] === "lib-comics") books.comics += 1;
      if (m[2] === "scan" && m[1] === "lib-manga") books.manga += 1;
      return reply(202, undefined);
    }
    const b = /^\/api\/v1\/books\/([^/]+)\/analyze$/.exec(path);
    if (b && method === "POST") {
      unreadable = unreadable.filter((x) => x.id !== b[1]);
      return reply(202, undefined);
    }
    return reply(404, { message: `No endpoint ${method} ${path}.` });
  };

  return { fetch: fetchImpl, reset };
}
