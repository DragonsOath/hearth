import { describe, expect, it } from "vitest";
import { readArr, regrabLoops } from "./arr";
import { plexReport } from "./plex-live";
import { readQbittorrent } from "./qbittorrent";
import { readSabnzbd } from "./sabnzbd";
import { AppKeyError, AppUnreachableError, type Fetch } from "./http";

/** A stand-in app: answers by path, records every request (method, url, headers). */
function fakeApp(
  routes: Record<string, unknown>,
  opts: { status?: number; text?: Record<string, string>; cookie?: string | null } = {},
) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] =
    [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ method: init.method ?? "GET", url, headers: init.headers, body: init.body });
    const path = new URL(url).pathname + new URL(url).search;
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const textKey = Object.keys(opts.text ?? {}).find((k) => path.startsWith(k));
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      json: async () => (key ? routes[key] : {}),
      text: async () => (textKey ? opts.text![textKey]! : ""),
      headers: {
        get: (n: string) =>
          n === "set-cookie" && path.startsWith("/api/v2/auth/login")
            ? opts.cookie === undefined
              ? "SID=abc123; HttpOnly; path=/"
              : opts.cookie
            : null,
      },
    };
  };
  return { fetchImpl, calls };
}

describe("reading Radarr and Sonarr", () => {
  it("reports health, the queue with what is stuck, history, and download clients, read only", async () => {
    const { fetchImpl, calls } = fakeApp({
      "/api/v3/system/status": { version: "5.14.0" },
      "/api/v3/health": [
        {
          source: "DownloadClientCheck",
          type: "error",
          message: "Unable to communicate with qBittorrent.",
        },
        { source: "UpdateCheck", type: "notice", message: "New update" },
      ],
      "/api/v3/queue": {
        totalRecords: 2,
        records: [
          {
            id: 1,
            movie: { title: "Example Movie", year: 2024 },
            size: 1000 * 1048576,
            sizeleft: 250 * 1048576,
            timeleft: "00:05:00",
            trackedDownloadStatus: "ok",
            trackedDownloadState: "downloading",
            downloadClient: "qBittorrent",
          },
          {
            id: 2,
            movie: { title: "Stuck Film", year: 2019 },
            trackedDownloadStatus: "warning",
            trackedDownloadState: "importBlocked",
            statusMessages: [{ title: "x", messages: ["No files found are eligible for import"] }],
            downloadClient: "SABnzbd",
          },
        ],
      },
      "/api/v3/history": {
        records: [
          {
            date: "2026-10-09T01:00:00Z",
            eventType: "downloadFolderImported",
            movie: { title: "Done Movie" },
          },
          { date: "2026-10-09T00:00:00Z", eventType: "downloadFailed", sourceTitle: "Bad.Release" },
        ],
      },
      "/api/v3/downloadclient": [
        { name: "qBittorrent", enable: true, protocol: "torrent" },
        { name: "SABnzbd", enable: true, protocol: "usenet" },
      ],
    });
    const r = await readArr("radarr", "http://radarr:7878", "secret-key", fetchImpl);
    expect(calls.every((c) => c.method === "GET" && c.headers["X-Api-Key"] === "secret-key")).toBe(
      true,
    );
    expect(calls.every((c) => !c.url.includes("secret-key"))).toBe(true);
    expect(r).toMatchObject({ app: "radarr", version: "5.14.0", status: "failing", queueTotal: 2 });
    expect(r.issues.map((i) => i.key)).toEqual(["health:DownloadClientCheck", "queue:stuck"]);
    expect(r.issues.find((i) => i.key === "queue:stuck")!.level).toBe("warning");
    expect(r.queue![0]).toMatchObject({
      title: "Example Movie (2024)",
      status: "Downloading",
      progressPct: 75,
      sizeMb: 1000,
    });
    expect(r.queue![1]).toMatchObject({
      title: "Stuck Film (2019)",
      status: "Import blocked",
      problem: "No files found are eligible for import",
    });
    expect(r.activity!.map((a) => [a.text, a.tone])).toEqual([
      ["Imported: Done Movie", "good"],
      ["Download failed: Bad.Release", "error"],
    ]);
    expect(r.connections).toEqual([
      {
        name: "qBittorrent (torrent)",
        ok: false,
        detail: "Unable to communicate with qBittorrent.",
      },
      { name: "SABnzbd (usenet)", ok: true },
    ]);
    expect(JSON.stringify(r)).not.toContain("secret-key");
  });

  it("names Sonarr episodes and says plainly when the key is refused", async () => {
    const { fetchImpl } = fakeApp({ "/api/v3/system/status": {} }, { status: 401 });
    await expect(readArr("sonarr", "http://sonarr:8989", "k", fetchImpl)).rejects.toBeInstanceOf(
      AppKeyError,
    );
    const ok = fakeApp({
      "/api/v3/system/status": { version: "4.0.11" },
      "/api/v3/health": [],
      "/api/v3/queue": {
        totalRecords: 1,
        records: [
          { id: 1, series: { title: "Show" }, episode: { seasonNumber: 2, episodeNumber: 5 } },
        ],
      },
      "/api/v3/history": { records: [] },
      "/api/v3/downloadclient": [],
    });
    const r = await readArr("sonarr", "http://sonarr:8989", "k", ok.fetchImpl);
    expect(r.queue![0]!.title).toBe("Show S02E05");
    expect(r.status).toBe("ok");
  });
});

describe("reading SABnzbd", () => {
  it("reads queue, history, and warnings; the key never appears in errors or the report", async () => {
    const { fetchImpl, calls } = fakeApp({
      "/api?mode=version": { version: "5.1.3" },
      "/api?mode=queue": {
        queue: {
          status: "Downloading",
          paused: false,
          speed: "12.3 M",
          sizeleft: "1.2 GB",
          timeleft: "0:01:40",
          noofslots_total: 1,
          slots: [
            {
              filename: "Some.Release",
              status: "Downloading",
              percentage: "40",
              mb: "3000",
              mbleft: "1800",
              timeleft: "0:01:40",
              cat: "movies",
            },
          ],
        },
      },
      "/api?mode=history": {
        history: {
          slots: [
            { name: "Good.One", status: "Completed", completed: 1791500000 },
            {
              name: "Bad.One",
              status: "Failed",
              fail_message: "Out of retention",
              completed: 1791400000,
            },
          ],
        },
      },
      "/api?mode=warnings": { warnings: [{ text: "Server x timed out" }] },
    });
    const r = await readSabnzbd("http://sab:8085", "sab-secret", fetchImpl);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(r).toMatchObject({
      app: "sabnzbd",
      version: "5.1.3",
      status: "attention",
      queueTotal: 1,
    });
    expect(r.queue![0]).toMatchObject({
      title: "Some.Release",
      progressPct: 40,
      sizeMb: 3000,
      via: "movies",
    });
    expect(r.issues.map((i) => i.key)).toEqual(["history:failed", "warning:0"]);
    expect(r.activity![1]).toMatchObject({
      text: "Failed: Bad.One (Out of retention)",
      tone: "error",
    });
    expect(JSON.stringify(r)).not.toContain("sab-secret");

    const refused = fakeApp({ "/api": { status: false, error: "API Key Incorrect" } });
    await expect(readSabnzbd("http://sab:8085", "x", refused.fetchImpl)).rejects.toBeInstanceOf(
      AppKeyError,
    );
    const down: Fetch = async () => {
      throw new Error("connect ECONNREFUSED to http://sab:8085/api?apikey=sab-secret");
    };
    const err = await readSabnzbd("http://sab:8085", "sab-secret", down).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppUnreachableError);
    expect((err as Error).message).not.toContain("sab-secret");
  });
});

describe("reading qBittorrent", () => {
  it("signs in, reads connection and torrents, signs out; never changes anything", async () => {
    const { fetchImpl, calls } = fakeApp(
      {
        "/api/v2/transfer/info": {
          connection_status: "firewalled",
          dl_info_speed: 2 * 1048576,
          up_info_speed: 51200,
          dht_nodes: 300,
        },
        "/api/v2/torrents/info": [
          {
            name: "Moving.Along",
            state: "downloading",
            progress: 0.5,
            size: 2048 * 1048576,
            eta: 600,
          },
          { name: "Stuck.One", state: "stalledDL", progress: 0.1, num_seeds: 0 },
          { name: "Broken.One", state: "missingFiles", progress: 0.9 },
          { name: "Finished.One", state: "uploading", progress: 1 },
        ],
      },
      { text: { "/api/v2/auth/login": "Ok.", "/api/v2/app/version": "v5.0.1" } },
    );
    const r = await readQbittorrent(
      "http://qb:8080",
      { username: "admin", password: "pw-secret" },
      fetchImpl,
    );
    const paths = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(paths[0]).toBe("POST /api/v2/auth/login");
    expect(paths.at(-1)).toBe("POST /api/v2/auth/logout");
    // Only reads between signing in and out.
    expect(paths.slice(1, -1).every((p) => p.startsWith("GET "))).toBe(true);
    expect(calls.slice(1).every((c) => c.headers.Cookie === "SID=abc123")).toBe(true);
    expect(r).toMatchObject({
      app: "qbittorrent",
      version: "5.0.1",
      status: "attention",
      queueTotal: 3,
    });
    expect(r.queue!.map((q) => q.status)).toEqual(["Missing files", "Stalled", "Downloading"]);
    expect(r.queue![2]).toMatchObject({ progressPct: 50, sizeMb: 2048, timeLeft: "10 min" });
    expect(r.connections![0]).toMatchObject({
      ok: false,
      detail: "Firewalled: incoming connections blocked",
    });
    expect(JSON.stringify(r)).not.toContain("pw-secret");
  });

  it("a refused login is a credential problem", async () => {
    const { fetchImpl } = fakeApp({}, { text: { "/api/v2/auth/login": "Fails." } });
    await expect(
      readQbittorrent("http://qb:8080", { username: "admin", password: "wrong" }, fetchImpl),
    ).rejects.toBeInstanceOf(AppKeyError);
  });

  it("qBittorrent 5 names its session cookie QBT_SID_<port>: signed in, and sent back as is", async () => {
    const { fetchImpl, calls } = fakeApp(
      { "/api/v2/transfer/info": { connection_status: "connected" }, "/api/v2/torrents/info": [] },
      {
        text: { "/api/v2/auth/login": "Ok.", "/api/v2/app/version": "v5.2.4" },
        cookie: "QBT_SID_8080=xyz789; HttpOnly; SameSite=Strict; path=/",
      },
    );
    const r = await readQbittorrent("http://qb:8080", { username: "u", password: "p" }, fetchImpl);
    expect(r).toMatchObject({ app: "qbittorrent", version: "5.2.4" });
    expect(calls.slice(1).every((c) => c.headers.Cookie === "QBT_SID_8080=xyz789")).toBe(true);
  });

  it("tells a wrong login from a block, a refused request, and a sign-in it cannot use", async () => {
    const login = { username: "u", password: "p" };
    // Too many failed attempts: blocked for a while, not the credential's fault.
    const blocked = fakeApp({}, { status: 403 });
    await expect(readQbittorrent("http://qb:8080", login, blocked.fetchImpl)).rejects.toMatchObject(
      {
        kind: "blocked",
      },
    );
    // Host or origin checks refuse the request before the password is looked at.
    const refused = fakeApp({}, { status: 401 });
    await expect(readQbittorrent("http://qb:8080", login, refused.fetchImpl)).rejects.toMatchObject(
      {
        kind: "incompatible",
      },
    );
    // Accepted, but no session cookie Hearth recognizes.
    const odd = fakeApp({}, { text: { "/api/v2/auth/login": "Ok." }, cookie: "OTHER=1; path=/" });
    const e = await readQbittorrent("http://qb:8080", login, odd.fetchImpl).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ kind: "incompatible" });
    expect(e).not.toBeInstanceOf(AppKeyError);
    // The wrong-login case is the only "rejected".
    const wrong = fakeApp({}, { text: { "/api/v2/auth/login": "Fails." } });
    await expect(readQbittorrent("http://qb:8080", login, wrong.fetchImpl)).rejects.toMatchObject({
      kind: "rejected",
    });
  });
});

describe("re-grab loops (caught without being asked)", () => {
  const h = (date: string, eventType: string, movieId: number, extra: object = {}) => ({
    date,
    eventType,
    movieId,
    movie: { title: movieId === 7 ? "Colony" : "Other", year: 2021 },
    ...extra,
  });

  it("flags a movie grabbed again and again, not a normal one-off upgrade", () => {
    const loops = regrabLoops("radarr", [
      h("2026-10-07T19:54:00Z", "downloadFolderImported", 7),
      h("2026-10-08T11:00:00Z", "grabbed", 7),
      h("2026-10-08T12:00:00Z", "movieFileDeleted", 7, { data: { reason: "Upgrade" } }),
      h("2026-10-08T12:05:00Z", "downloadFolderImported", 7),
      h("2026-10-10T11:35:00Z", "grabbed", 7),
      // One upgrade of another movie is normal.
      h("2026-10-08T10:00:00Z", "downloadFolderImported", 9),
      h("2026-10-09T10:00:00Z", "grabbed", 9),
    ]);
    expect(loops).toEqual([
      { key: "regrab:7", title: "Colony (2021)", grabs: 2, regrabs: 2, upgrades: 1, itemId: 7 },
    ]);
  });

  it("a backfill whose downloads keep failing is not a re-grab loop", () => {
    const tries = [1, 2, 3].flatMap((d) => [
      h(`2026-10-0${d + 6}T10:00:00Z`, "grabbed", 7),
      h(`2026-10-0${d + 6}T10:05:00Z`, "downloadFailed", 7),
    ]);
    expect(regrabLoops("radarr", tries)).toEqual([]);
  });

  it("Radarr's read raises it as a problem inside the app, so an incident opens and Ember investigates", async () => {
    const recent = [1, 2, 3].map((d) => h(`2026-10-0${d + 6}T10:00:00Z`, "grabbed", 7));
    const { fetchImpl, calls } = fakeApp({
      "/api/v3/system/status": { version: "5.14.0" },
      "/api/v3/health": [],
      "/api/v3/queue": { totalRecords: 0, records: [] },
      "/api/v3/history/since": recent,
      "/api/v3/history": { records: [] },
      "/api/v3/downloadclient": [],
    });
    const r = await readArr("radarr", "http://radarr:7878", "k", fetchImpl);
    expect(r.status).toBe("failing");
    expect(r.issues).toEqual([
      expect.objectContaining({
        level: "error",
        key: "regrab",
        text: expect.stringMatching(/^Radarr keeps grabbing Colony \(2021\) \(3 grabs\) in 7 days/),
      }),
    ]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("Plex: titles with more than one copy are listed as a warning, never an alarm", () => {
    const report = plexReport({
      app: "plex",
      totals: { movies: 1, shows: 0, seasons: 0, episodes: 0 },
      libraries: [],
      recentlyAdded: [],
      sessions: [],
      activities: [],
      duplicates: [{ ratingKey: "500", title: "Colony (2021)", kind: "movie", versions: 2 }],
    });
    expect(report.issues).toEqual([
      expect.objectContaining({
        level: "warning",
        key: "duplicates",
        text: expect.stringMatching(/^1 title has more than one copy in Plex \(Colony \(2021\)\)/),
      }),
    ]);
  });
});
