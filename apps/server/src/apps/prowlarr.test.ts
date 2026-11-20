import { describe, expect, it } from "vitest";
import { AppKeyError, AppUnreachableError, readProwlarr, type Fetch } from "./prowlarr";

const NOW = new Date("2026-10-08T12:00:00Z");

function api(
  data: Record<string, unknown>,
  opts: { status?: number; down?: boolean } = {},
): { fetch: Fetch; seen: { url: string; headers: Record<string, string> }[] } {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    if (opts.down) throw new Error("connect ECONNREFUSED");
    const path = new URL(url).pathname;
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => data[path],
    };
  };
  return { fetch, seen };
}

const healthy = {
  "/api/v1/system/status": { version: "1.24.3" },
  "/api/v1/health": [],
  "/api/v1/indexer": [
    { id: 1, name: "Alpha", enable: true },
    { id: 2, name: "Beta", enable: true },
    { id: 3, name: "Gamma", enable: false },
  ],
  "/api/v1/indexerstatus": [],
};

describe("reading Prowlarr", () => {
  it("reports version and indexers, read only, with the key in a header", async () => {
    const { fetch, seen } = api(healthy);
    const r = await readProwlarr("http://prowlarr:9696/", "secret-key", fetch, NOW);
    expect(r).toMatchObject({ app: "prowlarr", version: "1.24.3", status: "ok", issues: [] });
    expect(r.facts).toEqual([
      { label: "Indexers", value: "2 enabled of 3" },
      { label: "Failing", value: "0" },
    ]);
    expect(seen.map((s) => s.url)).toEqual([
      "http://prowlarr:9696/api/v1/system/status",
      "http://prowlarr:9696/api/v1/health",
      "http://prowlarr:9696/api/v1/indexer",
      "http://prowlarr:9696/api/v1/indexerstatus",
      "http://prowlarr:9696/api/v1/history?page=1&pageSize=12&sortKey=date&sortDirection=descending",
      "http://prowlarr:9696/api/v1/indexerProxy",
      "http://prowlarr:9696/api/v1/tag",
    ]);
    expect(seen.every((s) => s.headers["X-Api-Key"] === "secret-key")).toBe(true);
  });

  it("shows which indexers go through a proxy such as FlareSolverr, and their address; never other fields", async () => {
    const { fetch } = api({
      ...healthy,
      "/api/v1/indexer": [
        {
          id: 1,
          name: "Alpha",
          enable: true,
          tags: [7],
          fields: [
            { name: "baseUrl", value: "https://alpha.example/" },
            { name: "apiKey", value: "indexer-secret" },
          ],
        },
        { id: 2, name: "Beta", enable: true, tags: [] },
      ],
      "/api/v1/indexerProxy": [
        { id: 3, name: "FlareSolverr", implementation: "FlareSolverr", tags: [7] },
      ],
      "/api/v1/tag": [{ id: 7, label: "flaresolverr" }],
    });
    const r = await readProwlarr("http://prowlarr:9696", "k", fetch, NOW);
    expect(r.connections).toEqual([
      { name: "Alpha", ok: true, detail: "through FlareSolverr; address https://alpha.example/" },
      { name: "Beta", ok: true, detail: "no proxy" },
      { name: "FlareSolverr (FlareSolverr)", ok: true, detail: "tag flaresolverr; used by Alpha" },
    ]);
    expect(JSON.stringify(r)).not.toContain("indexer-secret");
  });

  it("names failing indexers, ignores ones you switched off, and does not repeat Prowlarr's summary", async () => {
    const { fetch } = api({
      ...healthy,
      "/api/v1/health": [
        {
          source: "IndexerStatusCheck",
          type: "warning",
          message: "Indexers unavailable due to failures: Alpha",
        },
        {
          source: "UpdateCheck",
          type: "warning",
          message: "New update is available",
          wikiUrl: "https://wiki/x",
        },
      ],
      "/api/v1/indexerstatus": [
        {
          indexerId: 1,
          disabledTill: "2026-10-08T13:00:00Z",
          mostRecentFailure: "2026-10-08T11:50:00Z",
          initialFailure: "2026-10-08T09:00:00Z",
        },
        { indexerId: 2, mostRecentFailure: "2026-10-08T11:40:00Z" },
        { indexerId: 3, disabledTill: "2026-10-09T00:00:00Z" },
      ],
    });
    const r = await readProwlarr("http://p", "k", fetch, NOW);
    expect(r.status).toBe("failing");
    expect(r.issues.map((i) => [i.level, i.key])).toEqual([
      ["error", "indexer:1"],
      ["warning", "indexer:2"],
      ["warning", "health:UpdateCheck"],
    ]);
    expect(r.issues[0]!.text).toMatch(/^Alpha is failing; Prowlarr paused it until/);
    expect(r.issues[2]!.link).toBe("https://wiki/x");
    expect(r.facts[1]).toEqual({ label: "Failing", value: "2" });
  });

  it("an indexer whose pause has passed and has no failure is fine", async () => {
    const { fetch } = api({
      ...healthy,
      "/api/v1/indexerstatus": [{ indexerId: 1, disabledTill: "2026-10-08T11:00:00Z" }],
    });
    expect((await readProwlarr("http://p", "k", fetch, NOW)).status).toBe("ok");
  });

  it("tells a refused key from an app that is not answering", async () => {
    await expect(
      readProwlarr("http://p", "k", api(healthy, { status: 401 }).fetch),
    ).rejects.toThrow(AppKeyError);
    await expect(readProwlarr("http://p", "k", api(healthy, { down: true }).fetch)).rejects.toThrow(
      AppUnreachableError,
    );
    await expect(
      readProwlarr("http://p", "k", api(healthy, { status: 500 }).fetch),
    ).rejects.toThrow(/answered 500/);
  });
});
