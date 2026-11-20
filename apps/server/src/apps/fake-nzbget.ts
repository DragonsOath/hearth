import type { Fetch } from "./http";

/**
 * A stand-in NZBGet (port 6789) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering its JSON-RPC as a throwaway linuxserver/nzbget 26.3 did: Basic auth with an
 * e2e- password, a queue (downloading, waiting, paused), a history with a completed, a failed and
 * a deleted download, categories, a health warning, and the queue and history edits. Its settings
 * hold a news server password (e2e-SECRET) that must never reach the panel.
 */

export interface FakeNzbget {
  fetch: Fetch;
  reset(): void;
}

const SECRET = "e2e-SECRET";
const MB = 1048576;

interface Group {
  NZBID: number;
  NZBName: string;
  Status: string;
  Category: string;
  size: number;
  left: number;
  paused: boolean;
  MaxPriority: number;
}

interface Done {
  NZBID: number;
  Name: string;
  Status: string;
  Category: string;
  HistoryTime: number;
  size: number;
}

export function fakeNzbget(): FakeNzbget {
  let queue: Group[] = [];
  let history: Done[] = [];
  let paused = false;
  let limit = 0;
  let resumeAt = 0;
  let next = 10;
  const now = () => Math.floor(Date.now() / 1000);
  const reset = () => {
    queue = [
      {
        NZBID: 1,
        NZBName: "Lantern.S01E03.1080p",
        Status: "DOWNLOADING",
        Category: "Series",
        size: 2400 * MB,
        left: 900 * MB,
        paused: false,
        MaxPriority: 0,
      },
      {
        NZBID: 2,
        NZBName: "Quiet.Harbor.2024.2160p",
        Status: "QUEUED",
        Category: "Movies",
        size: 18000 * MB,
        left: 18000 * MB,
        paused: false,
        MaxPriority: 100,
      },
      {
        NZBID: 3,
        NZBName: "Open.Source.Album.FLAC",
        Status: "QUEUED",
        Category: "Music",
        size: 600 * MB,
        left: 600 * MB,
        paused: true,
        MaxPriority: 0,
      },
    ];
    history = [
      {
        NZBID: 4,
        Name: "Old.Documentary.720p",
        Status: "SUCCESS/ALL",
        Category: "Movies",
        HistoryTime: now() - 3600,
        size: 1200 * MB,
      },
      {
        NZBID: 5,
        Name: "Broken.Release.1080p",
        Status: "FAILURE/HEALTH",
        Category: "Movies",
        HistoryTime: now() - 1800,
        size: 4000 * MB,
      },
      {
        NZBID: 6,
        Name: "Duplicate.Upload",
        Status: "DELETED/DUPE",
        Category: "Series",
        HistoryTime: now() - 7200,
        size: 800 * MB,
      },
    ];
    paused = false;
    limit = 0;
    resumeAt = 0;
    next = 10;
  };
  reset();

  const lohi = (n: number, key: string) => ({
    [`${key}Lo`]: n % 4294967296,
    [`${key}Hi`]: Math.floor(n / 4294967296),
  });
  const group = (g: Group) => ({
    NZBID: g.NZBID,
    NZBName: g.NZBName,
    Status: g.Status,
    Category: g.Category,
    MaxPriority: g.MaxPriority,
    ...lohi(g.size, "FileSize"),
    ...lohi(g.left, "RemainingSize"),
    ...lohi(g.paused ? g.left : 0, "PausedSize"),
  });
  const ids = (p: unknown[]) => (p[2] as number[] | undefined) ?? [];

  const handle = (method: string, p: unknown[]): unknown => {
    switch (method) {
      case "version":
        return "26.3";
      case "status": {
        const rate = paused
          ? 0
          : queue.some((g) => g.Status === "DOWNLOADING" && !g.paused)
            ? 8 * MB
            : 0;
        const left = queue.reduce((n, g) => n + g.left, 0);
        if (resumeAt && now() >= resumeAt) {
          paused = false;
          resumeAt = 0;
        }
        return {
          DownloadRate: limit && rate ? Math.min(rate, limit * 1024) : rate,
          DownloadLimit: limit * 1024,
          DownloadPaused: paused,
          ResumeTime: resumeAt,
          ...lohi(left, "RemainingSize"),
          FreeDiskSpaceMB: 512000,
          TotalDiskSpaceMB: 2048000,
        };
      }
      case "listgroups":
        return queue.map(group);
      case "history":
        return history.map((h) => ({
          ...h,
          NZBID: h.NZBID,
          Kind: "NZB",
          ...lohi(h.size, "FileSize"),
        }));
      case "listfiles": {
        const g = queue.find((x) => x.NZBID === p[2]);
        if (!g) return [];
        const half = g.size / 2;
        const lefts = [Math.max(0, g.left - half), Math.min(g.left, half)];
        const active = lefts.findIndex((l) => l > 0);
        return lefts.map((left, i) => ({
          Filename: `${g.NZBName}.part0${i + 1}.rar`,
          ...lohi(half, "FileSize"),
          ...lohi(left, "RemainingSize"),
          ActiveDownloads: g.Status === "DOWNLOADING" && !g.paused && i === active ? 1 : 0,
        }));
      }
      case "config":
        return [
          { Name: "Category1.Name", Value: "Movies" },
          { Name: "Category2.Name", Value: "Series" },
          { Name: "Category3.Name", Value: "Music" },
          { Name: "Server1.Host", Value: "news.example" },
          { Name: "Server1.Password", Value: SECRET },
          { Name: "ControlPassword", Value: SECRET },
        ];
      case "systemhealth":
        return {
          Alerts: [],
          Sections: [
            {
              Name: "Security",
              Issues: [{ Severity: "Warning", Message: "The control password is easy to guess" }],
              Options: [],
            },
          ],
        };
      case "log":
        return [
          { ID: 1, Kind: "INFO", Time: now() - 60, Text: "Collection added to queue" },
          {
            ID: 2,
            Kind: "WARNING",
            Time: now() - 30,
            Text: "Broken.Release.1080p: too many articles missing",
          },
        ];
      case "pausedownload":
        paused = true;
        return true;
      case "resumedownload":
        paused = false;
        resumeAt = 0;
        return true;
      case "scheduleresume":
        resumeAt = now() + Number(p[0]);
        return true;
      case "rate":
        limit = Number(p[0]);
        return true;
      case "append": {
        const id = next++;
        const name = String(p[0]).replace(/\.nzb$/i, "") || `Job ${id}`;
        queue.push({
          NZBID: id,
          NZBName: name,
          Status: "QUEUED",
          Category: String(p[2] ?? ""),
          size: 500 * MB,
          left: 500 * MB,
          paused: p[5] === true,
          MaxPriority: Number(p[3] ?? 0),
        });
        return id;
      }
      case "editqueue": {
        const [cmd, param] = [String(p[0]), String(p[1] ?? "")];
        const targets = ids(p);
        const gs = queue.filter((g) => targets.includes(g.NZBID));
        switch (cmd) {
          case "GroupPause":
            for (const g of gs) g.paused = true;
            break;
          case "GroupResume":
            for (const g of gs) g.paused = false;
            break;
          case "GroupDelete":
            for (const g of gs)
              history.unshift({
                NZBID: g.NZBID,
                Name: g.NZBName,
                Status: "DELETED/MANUAL",
                Category: g.Category,
                HistoryTime: now(),
                size: g.size,
              });
            queue = queue.filter((g) => !targets.includes(g.NZBID));
            break;
          case "GroupSetPriority":
            for (const g of gs) g.MaxPriority = Number(param);
            break;
          case "GroupApplyCategory":
            for (const g of gs) g.Category = param;
            break;
          case "GroupMoveTop":
          case "GroupMoveBottom":
          case "GroupMoveOffset": {
            for (const g of gs) {
              const at = queue.indexOf(g);
              queue.splice(at, 1);
              const to =
                cmd === "GroupMoveTop"
                  ? 0
                  : cmd === "GroupMoveBottom"
                    ? queue.length
                    : Math.max(0, Math.min(queue.length, at + Number(param)));
              queue.splice(to, 0, g);
            }
            break;
          }
          case "HistoryRedownload":
            for (const h of history.filter((x) => targets.includes(x.NZBID)))
              queue.push({
                NZBID: h.NZBID,
                NZBName: h.Name,
                Status: "QUEUED",
                Category: h.Category,
                size: h.size,
                left: h.size,
                paused: false,
                MaxPriority: 0,
              });
            history = history.filter((h) => !targets.includes(h.NZBID));
            break;
          case "HistoryDelete":
            history = history.filter((h) => !targets.includes(h.NZBID));
            break;
          default:
            throw new Error(`Unknown command ${cmd}`);
        }
        return true;
      }
      default:
        throw new Error("Invalid procedure");
    }
  };

  const reply = (status: number, body: string) => ({
    ok: status < 400,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
  });

  const fetchImpl: Fetch = async (url, init) => {
    if (new URL(url).pathname !== "/jsonrpc") return reply(404, "Not Found");
    const auth = init.headers.Authorization ?? "";
    const pw =
      Buffer.from(auth.replace(/^Basic /, ""), "base64")
        .toString()
        .split(":")[1] ?? "";
    if (!pw.startsWith("e2e-")) return reply(401, "Unauthorized");
    const { method, params } = JSON.parse(init.body ?? "{}") as {
      method: string;
      params?: unknown[];
    };
    try {
      return reply(200, JSON.stringify({ version: "1.1", result: handle(method, params ?? []) }));
    } catch (error) {
      return reply(
        200,
        JSON.stringify({
          version: "1.1",
          error: {
            name: "JSONRPCError",
            code: 1,
            message: error instanceof Error ? error.message : "error",
          },
        }),
      );
    }
  };

  return { fetch: fetchImpl, reset };
}
