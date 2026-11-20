import type { Fetch } from "./http";

/**
 * A stand-in Transmission (port 9091) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering its RPC as a throwaway linuxserver/transmission 4.1.4 did: the 409 session
 * handshake, Basic auth with an e2e- password, and torrents downloading, stalled, seeding, stopped
 * and in error, with labels. Every tracker address carries a passkey (e2e-SECRET) that must never
 * reach the panel.
 */

export interface FakeTransmission {
  fetch: Fetch;
  reset(): void;
  /** A torrent's raw state, for tests. */
  torrent(hash: string): Raw | undefined;
}

const SECRET = "e2e-SECRET";
const SID = "fake-transmission-session";
const hashOf = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

interface Raw {
  id: number;
  hashString: string;
  name: string;
  status: number;
  percentDone: number;
  rateDownload: number;
  rateUpload: number;
  eta: number;
  sizeWhenDone: number;
  leftUntilDone: number;
  uploadRatio: number;
  labels: string[];
  error: number;
  errorString: string;
  addedDate: number;
  doneDate: number;
  queuePosition: number;
  peersSendingToUs: number;
  peersGettingFromUs: number;
  isStalled: boolean;
  isFinished: boolean;
  downloadDir: string;
  metadataPercentComplete: number;
  files: { name: string; length: number; bytesCompleted: number }[];
  fileStats: { wanted: boolean; priority: number; bytesCompleted: number }[];
}

export function fakeTransmission(): FakeTransmission {
  let torrents: Raw[] = [];
  let session: Record<string, unknown> = {};
  let nextId = 1;
  const now = Math.floor(Date.now() / 1000);
  const make = (n: number, name: string, extra: Partial<Raw>): Raw => {
    const size = 1_500_000_000 + n * 100_000_000;
    const done = extra.percentDone ?? 0.5;
    return {
      id: n,
      hashString: hashOf(n),
      name,
      status: 4,
      percentDone: done,
      rateDownload: 0,
      rateUpload: 0,
      eta: -1,
      sizeWhenDone: size,
      leftUntilDone: Math.round(size * (1 - done)),
      uploadRatio: 0,
      labels: [],
      error: 0,
      errorString: "",
      addedDate: now - n * 3600,
      doneDate: done >= 1 ? now - 1800 : 0,
      queuePosition: n - 1,
      peersSendingToUs: 0,
      peersGettingFromUs: 0,
      isStalled: false,
      isFinished: false,
      downloadDir: "/downloads/complete",
      metadataPercentComplete: 1,
      files: [
        {
          name: `${name}/${name}.mkv`,
          length: size - 1000,
          bytesCompleted: Math.round((size - 1000) * done),
        },
        { name: `${name}/${name}.nfo`, length: 1000, bytesCompleted: done >= 1 ? 1000 : 0 },
      ],
      fileStats: [
        { wanted: true, priority: 0, bytesCompleted: 0 },
        { wanted: true, priority: 0, bytesCompleted: 0 },
      ],
      ...extra,
    };
  };
  const reset = () => {
    torrents = [
      make(1, "Lantern Season 1", {
        rateDownload: 4_200_000,
        peersSendingToUs: 12,
        eta: 180,
        labels: ["tv"],
      }),
      make(2, "Quiet Harbor 2024", { isStalled: true, labels: ["movies"] }),
      make(3, "Open Source Album", {
        status: 6,
        percentDone: 1,
        rateUpload: 120_000,
        uploadRatio: 1.42,
        peersGettingFromUs: 3,
        labels: ["music", "flac"],
      }),
      make(4, "Old Documentary", { status: 0, percentDone: 0.2 }),
      make(5, "Broken Download", {
        status: 0,
        error: 3,
        errorString: "No data found! Ensure your drives are connected",
        labels: ["movies"],
      }),
    ];
    nextId = 6;
    session = {
      version: "4.1.4 (a6d907d9ea)",
      "rpc-version": 19,
      "download-dir": "/downloads/complete",
      "incomplete-dir": "/downloads/incomplete",
      "incomplete-dir-enabled": true,
      "speed-limit-down-enabled": false,
      "speed-limit-down": 100,
      "speed-limit-up-enabled": true,
      "speed-limit-up": 500,
      "alt-speed-enabled": false,
      "alt-speed-down": 50,
      "alt-speed-up": 50,
      seedRatioLimited: true,
      seedRatioLimit: 2,
      "idle-seeding-limit-enabled": false,
      "idle-seeding-limit": 30,
      "download-queue-enabled": true,
      "download-queue-size": 5,
      "seed-queue-enabled": false,
      "seed-queue-size": 10,
      "queue-stalled-enabled": true,
      "queue-stalled-minutes": 30,
      "start-added-torrents": true,
      "peer-limit-global": 200,
      "peer-limit-per-torrent": 50,
      "rename-partial-files": true,
      // Settings Hearth never reads.
      "rpc-password": SECRET,
      "proxy-url": `http://user:${SECRET}@proxy.lan`,
    };
  };
  reset();

  const view = (t: Raw, fields: string[]) => {
    const all: Record<string, unknown> = {
      ...t,
      trackerStats: [
        {
          announce: `http://tracker.example:6969/announce?passkey=${SECRET}`,
          host: "tracker.example:6969",
          seederCount: t.id === 2 ? 0 : 25,
          leecherCount: 4,
          hasAnnounced: true,
          lastAnnounceSucceeded: t.id !== 2,
          lastAnnounceResult: t.id === 2 ? "Could not connect to tracker" : "Success",
          announceState: 1,
        },
      ],
      trackers: [{ announce: `http://tracker.example:6969/announce?passkey=${SECRET}` }],
      magnetLink: `magnet:?xt=urn:btih:${t.hashString}&tr=passkey%3D${SECRET}`,
      pieceCount: 100,
      pieceSize: Math.ceil(t.sizeWhenDone / 100),
      haveValid: Math.round(t.sizeWhenDone * t.percentDone),
      secondsDownloading: 3600,
      secondsSeeding: t.status === 6 ? 1800 : 0,
      downloadedEver: Math.round(t.sizeWhenDone * t.percentDone),
      uploadedEver: Math.round(t.sizeWhenDone * t.uploadRatio),
      downloadLimit: 100,
      downloadLimited: false,
      uploadLimit: 100,
      uploadLimited: false,
      creator: "mktorrent 1.1",
      peersConnected: t.peersSendingToUs + t.peersGettingFromUs,
      peers:
        t.peersSendingToUs > 0
          ? [
              {
                address: "203.0.113.9",
                clientName: "qBittorrent 5.0",
                progress: 1,
                rateToClient: 350_000,
                rateToPeer: 0,
                flagStr: "DE",
              },
            ]
          : [],
    };
    return Object.fromEntries(fields.filter((f) => f in all).map((f) => [f, all[f]]));
  };
  const pick = (ids: unknown) =>
    Array.isArray(ids)
      ? torrents.filter((t) =>
          ids.some((i) => i === t.id || String(i).toLowerCase() === t.hashString),
        )
      : torrents;
  const requeue = () =>
    torrents
      .slice()
      .sort((a, b) => a.queuePosition - b.queuePosition)
      .forEach((t, i) => (t.queuePosition = i));

  const handle = (method: string, args: Record<string, unknown>): unknown => {
    switch (method) {
      case "session-get": {
        const fields = (args.fields as string[] | undefined) ?? Object.keys(session);
        return Object.fromEntries(fields.filter((f) => f in session).map((f) => [f, session[f]]));
      }
      case "session-set":
        for (const [k, v] of Object.entries(args)) if (k in session) session[k] = v;
        return {};
      case "session-stats":
        return {
          downloadSpeed: torrents.reduce((n, t) => n + (t.status === 4 ? t.rateDownload : 0), 0),
          uploadSpeed: torrents.reduce((n, t) => n + t.rateUpload, 0),
          torrentCount: torrents.length,
        };
      case "free-space":
        return { path: args.path, "size-bytes": 812_000_000_000 };
      case "port-test":
        return { "port-is-open": true };
      case "torrent-get":
        return { torrents: pick(args.ids).map((t) => view(t, args.fields as string[])) };
      case "torrent-start":
        for (const t of pick(args.ids)) t.status = t.percentDone >= 1 ? 6 : 4;
        return {};
      case "torrent-stop":
        for (const t of pick(args.ids)) t.status = 0;
        return {};
      case "torrent-verify":
      case "torrent-reannounce":
        return {};
      case "torrent-remove":
        torrents = torrents.filter((t) => !pick(args.ids).includes(t));
        return {};
      case "queue-move-top":
      case "queue-move-bottom":
      case "queue-move-up":
      case "queue-move-down":
        for (const t of pick(args.ids))
          t.queuePosition =
            method === "queue-move-top"
              ? -1
              : method === "queue-move-bottom"
                ? 999
                : t.queuePosition + (method === "queue-move-up" ? -1.5 : 1.5);
        requeue();
        return {};
      case "torrent-set":
        for (const t of pick(args.ids)) {
          if (Array.isArray(args.labels)) t.labels = args.labels as string[];
          for (const i of (args["files-unwanted"] as number[] | undefined) ?? [])
            if (t.fileStats[i]) t.fileStats[i]!.wanted = false;
          for (const i of (args["files-wanted"] as number[] | undefined) ?? [])
            if (t.fileStats[i]) t.fileStats[i]!.wanted = true;
          for (const i of (args["priority-high"] as number[] | undefined) ?? [])
            if (t.fileStats[i]) t.fileStats[i]!.priority = 1;
          for (const i of (args["priority-normal"] as number[] | undefined) ?? [])
            if (t.fileStats[i]) t.fileStats[i]!.priority = 0;
        }
        return {};
      case "torrent-add": {
        const link = String(args.filename ?? "");
        const h = /btih:([a-f0-9]{40})/i.exec(link)?.[1]?.toLowerCase() ?? hashOf(nextId + 100);
        const there = torrents.find((t) => t.hashString === h);
        if (there)
          return {
            "torrent-duplicate": { hashString: there.hashString, id: there.id, name: there.name },
          };
        if (!link && !args.metainfo) throw new Error("no filename or metainfo");
        const id = nextId++;
        const t = make(id, /dn=([^&]+)/.exec(link)?.[1]?.replace(/\+/g, " ") ?? `Added ${id}`, {
          hashString: h,
          status: args.paused === true ? 0 : 4,
          percentDone: 0,
          labels: (args.labels as string[] | undefined) ?? [],
          queuePosition: torrents.length,
        });
        torrents.push(t);
        return { "torrent-added": { hashString: t.hashString, id: t.id, name: t.name } };
      }
      default:
        throw new Error("method name not recognized");
    }
  };

  const reply = (status: number, body: string, headers: Record<string, string> = {}) => ({
    ok: status < 400,
    status,
    json: async () => JSON.parse(body) as unknown,
    text: async () => body,
    headers: { get: (n: string) => headers[n] ?? headers[n.toLowerCase()] ?? null },
  });

  const fetchImpl: Fetch = async (url, init) => {
    if (new URL(url).pathname !== "/transmission/rpc") return reply(404, "Not Found");
    const auth = init.headers.Authorization ?? "";
    const pw =
      Buffer.from(auth.replace(/^Basic /, ""), "base64")
        .toString()
        .split(":")[1] ?? "";
    if (!pw.startsWith("e2e-")) return reply(401, "<h1>401: Unauthorized</h1>");
    if (init.headers["X-Transmission-Session-Id"] !== SID)
      return reply(409, "<h1>409: Conflict</h1>", { "X-Transmission-Session-Id": SID });
    const { method, arguments: args } = JSON.parse(init.body ?? "{}") as {
      method: string;
      arguments?: Record<string, unknown>;
    };
    try {
      return reply(
        200,
        JSON.stringify({ result: "success", arguments: handle(method, args ?? {}) }),
      );
    } catch (error) {
      return reply(
        200,
        JSON.stringify({ result: error instanceof Error ? error.message : "error" }),
      );
    }
  };

  return {
    fetch: fetchImpl,
    reset,
    torrent: (hash) => torrents.find((t) => t.hashString === hash),
  };
}
