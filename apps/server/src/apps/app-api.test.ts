import { describe, expect, it } from "vitest";
import {
  appApi,
  authProblem,
  bodyProblem,
  followCommand,
  maskSecrets,
  pathProblem,
  shorten,
  type ApiAnswer,
} from "./app-api";
import { fakeArrV1 } from "./fake-arr-v1";
import type { Fetch } from "./http";

const KEY = { value: "e2e-chaptarr-key" };

describe("app API access: anything the app's own API allows", () => {
  it("reads Chaptarr's queue with each item's id, which the summary panel left out", async () => {
    const c = fakeArrV1("chaptarr");
    const r = await appApi(c.fetch, "chaptarr", "Chaptarr", "http://chaptarr:8789", KEY, {
      method: "GET",
      path: "/api/v1/queue?page=1&pageSize=50",
    });
    expect(r.ok).toBe(true);
    const records = (r.body as { records: { id: number; downloadId?: string }[] }).records;
    expect(records.map((q) => q.id)).toEqual([501, 502]);
    expect(records[0]!.downloadId).toBe("fake-dl-501");
  });

  it("imports a stuck download as the book Ember chooses, and the command is followed to the end", async () => {
    const c = fakeArrV1("chaptarr");
    const send = (method: "GET" | "POST" | "DELETE", path: string, body?: string) =>
      appApi(c.fetch, "chaptarr", "Chaptarr", "http://chaptarr:8789", KEY, {
        method,
        path,
        ...(body ? { body } : {}),
      });
    const files = (await send("GET", "/api/v1/manualimport?downloadId=fake-dl-501")).body as {
      path: string;
      downloadId: string;
    }[];
    expect(files).toHaveLength(1);
    const req = {
      method: "POST" as const,
      path: "/api/v1/command",
      body: JSON.stringify({
        name: "ManualImport",
        importMode: "auto",
        files: [{ ...files[0], authorId: 1, bookId: 61 }],
      }),
    };
    const done = await followCommand(
      req,
      await send("POST", req.path, req.body),
      (p) => send("GET", p),
      async () => undefined,
    );
    expect((done.body as { status: string }).status).toBe("completed");
    const left = (await send("GET", "/api/v1/queue")).body as { records: { id: number }[] };
    expect(left.records.map((q) => q.id)).toEqual([502]);
  });

  it("removes one queue item, keeping the download, by its exact id", async () => {
    const c = fakeArrV1("chaptarr");
    const del = await appApi(c.fetch, "chaptarr", "Chaptarr", "http://c:8789", KEY, {
      method: "DELETE",
      path: "/api/v1/queue/502?removeFromClient=false&blocklist=false",
    });
    expect(del.ok).toBe(true);
    const left = await appApi(c.fetch, "chaptarr", "Chaptarr", "http://c:8789", KEY, {
      method: "GET",
      path: "/api/v1/queue",
    });
    expect((left.body as { records: { id: number }[] }).records.map((q) => q.id)).toEqual([501]);
  });

  it("signs in the way each app expects, and only ever to the app's own address", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const rec: Fetch = async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const go = (app: Parameters<typeof appApi>[1]) =>
      appApi(
        rec,
        app,
        app,
        "http://app:1",
        { value: "secret-value-123" },
        {
          method: "GET",
          path: "/x?y=1",
        },
      );
    await go("sonarr");
    expect(seen.at(-1)!.headers["X-Api-Key"]).toBe("secret-value-123");
    await go("homeassistant");
    expect(seen.at(-1)!.headers.Authorization).toBe("Bearer secret-value-123");
    await go("plex");
    expect(seen.at(-1)!.headers["X-Plex-Token"]).toBe("secret-value-123");
    await go("jellyfin");
    expect(seen.at(-1)!.headers.Authorization).toContain('Token="secret-value-123"');
    await go("sabnzbd");
    expect(seen.at(-1)!.url).toBe("http://app:1/x?y=1&apikey=secret-value-123");
    expect(seen.every((s) => s.url.startsWith("http://app:1/"))).toBe(true);
  });

  it("masks secrets in answers: secret-named fields, *arr field lists, and the key itself", () => {
    const out = maskSecrets(
      {
        apiKey: "abc",
        name: "x",
        note: "key is secret-value-123 here",
        fields: [
          { name: "apiKey", value: "indexer-key" },
          { name: "baseUrl", value: "http://indexer" },
        ],
        nested: { password: "pw", Token: "t" },
      },
      "secret-value-123",
    );
    expect(JSON.stringify(out)).not.toMatch(/abc|indexer-key|secret-value-123|"pw"|"t"/);
    expect(JSON.stringify(out)).toContain("http://indexer");
  });

  it("refuses paths and bodies that are not plain requests to the app itself", () => {
    expect(pathProblem("/api/v1/queue?page=1")).toBeUndefined();
    expect(pathProblem("api/v1/queue")).toBeDefined();
    expect(pathProblem("//evil.example/x")).toBeDefined();
    expect(pathProblem("/x?u=http://evil.example")).toBeDefined();
    expect(pathProblem("/api/../../etc")).toBeDefined();
    expect(bodyProblem("chaptarr", "{not json")).toBeDefined();
    expect(bodyProblem("chaptarr", '{"a":1}')).toBeUndefined();
    expect(bodyProblem("qbittorrent", "hashes=a&deleteFiles=false")).toBeUndefined();
  });

  it("shortens very long answers so they fit a conversation, and says how", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: i, title: "x".repeat(40) }));
    const s = shorten({ totalRecords: 5000, records: big });
    expect(JSON.stringify(s.body).length).toBeLessThanOrEqual(60_000);
    expect(s.note).toMatch(/Shortened/);
  });

  it("leaves a non-command answer as it is", async () => {
    const a: ApiAnswer = { status: 200, ok: true, body: { id: 3 } };
    expect(await followCommand({ method: "PUT", path: "/api/v1/book/3" }, a, async () => a)).toBe(
      a,
    );
  });
});

describe("app API access to an app Hearth has no reader for (the generic panel)", () => {
  const SECRET = "e2e-gizmo-secret-key";
  function gizmo() {
    const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      seen.push({ url, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
      const text = JSON.stringify({ name: "Gizmo", token: SECRET, echo: `key was ${SECRET}` });
      return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
    };
    return { fetchImpl, seen };
  }

  it("sends the key the way it is told, and never shows it in the answer", async () => {
    const g = gizmo();
    const ask = (auth?: string) =>
      appApi(
        g.fetchImpl,
        "generic",
        "Gizmo",
        "http://gizmo:7777",
        { value: SECRET },
        {
          method: "GET",
          path: "/api/status?x=1",
          ...(auth ? { auth } : {}),
        },
      );
    const r = await ask();
    expect(g.seen[0]!.headers["X-Api-Key"]).toBe(SECRET);
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    await ask("bearer");
    expect(g.seen[1]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    await ask("header:X-Auth-Token");
    expect(g.seen[2]!.headers["X-Auth-Token"]).toBe(SECRET);
    await ask("query:apikey");
    expect(g.seen[3]!.url).toBe(`http://gizmo:7777/api/status?x=1&apikey=${SECRET}`);
    await ask("none");
    expect(JSON.stringify(g.seen[4]!)).not.toContain(SECRET);
  });

  it("signs in with a login as Basic auth, and sends a form body as a form", async () => {
    const g = gizmo();
    await appApi(
      g.fetchImpl,
      "generic",
      "Gizmo",
      "http://gizmo:7777",
      { value: "pw", username: "admin" },
      { method: "POST", path: "/api/run", body: "job=scan&now=1" },
    );
    expect(g.seen[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from("admin:pw").toString("base64")}`,
    );
    expect(g.seen[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("refuses an auth choice it does not know, and allows a form body", () => {
    expect(authProblem("cookie:sid")).toMatch(/Say how the key is sent/);
    expect(authProblem("header:X-Api-Key")).toBeUndefined();
    expect(bodyProblem("generic", "a=1&b=2")).toBeUndefined();
  });
});
