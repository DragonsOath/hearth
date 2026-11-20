import type { Fetch } from "./http";

/**
 * A stand-in Syncthing (port 8384) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): this machine and two others (one offline), a folder up to date, one syncing, and one
 * with a failed file, answering the calls the panel and its controls make.
 */

export interface FakeSyncthing {
  fetch: Fetch;
  reset(): void;
}

const ME = "AAAAAAA-MEMEMEM";
const PHONE = "BBBBBBB-PHONEPH";
const LAPTOP = "CCCCCCC-LAPTOPL";
const FOLDERS = () => [
  {
    id: "photos",
    label: "Phone photos",
    path: "/data/photos",
    type: "receiveonly",
    paused: false,
    devices: [{ deviceID: ME }, { deviceID: PHONE }],
  },
  {
    id: "docs",
    label: "Documents",
    path: "/data/docs",
    type: "sendreceive",
    paused: false,
    devices: [{ deviceID: ME }, { deviceID: LAPTOP }],
  },
  {
    id: "music",
    label: "Music",
    path: "/data/music",
    type: "sendonly",
    paused: false,
    devices: [{ deviceID: ME }, { deviceID: LAPTOP }],
  },
];
const DEVICES = () => [
  { deviceID: ME, name: "homeserver", paused: false },
  { deviceID: PHONE, name: "Pixel", paused: false },
  { deviceID: LAPTOP, name: "Laptop", paused: false },
];

export function fakeSyncthing(): FakeSyncthing {
  let folders = FOLDERS();
  let devices = DEVICES();
  const scanned: string[] = [];
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const q = u.searchParams;
    const p = u.pathname;
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (!headers["X-API-Key"]?.startsWith("e2e-")) return reply(403, {});
    const body = init.body ? (JSON.parse(String(init.body)) as { paused?: boolean }) : {};
    if (p === "/rest/system/version") return reply(200, { version: "v1.29.2" });
    if (p === "/rest/system/status") return reply(200, { myID: ME });
    if (p === "/rest/config/folders" && method === "GET") return reply(200, folders);
    if (p === "/rest/config/devices" && method === "GET") return reply(200, devices);
    if (p === "/rest/system/connections")
      return reply(200, {
        connections: {
          [PHONE]: { connected: true, address: "tcp://192.168.1.50:22000" },
          [LAPTOP]: { connected: false, address: "" },
        },
      });
    if (p === "/rest/stats/device")
      return reply(200, {
        [PHONE]: { lastSeen: new Date().toISOString() },
        [LAPTOP]: { lastSeen: new Date(Date.now() - 3 * 86_400_000).toISOString() },
      });
    if (p === "/rest/db/status") {
      const f = q.get("folder");
      if (f === "photos")
        return reply(200, {
          state: "syncing",
          globalBytes: 10 * 1024 ** 3,
          needBytes: 2 * 1024 ** 3,
          needFiles: 140,
        });
      if (f === "docs")
        return reply(200, {
          state: "idle",
          globalBytes: 1024 ** 3,
          needBytes: 0,
          needFiles: 0,
          pullErrors: 1,
        });
      return reply(200, { state: "idle", globalBytes: 40 * 1024 ** 3, needBytes: 0, needFiles: 0 });
    }
    if (p === "/rest/folder/errors")
      return reply(200, {
        errors:
          q.get("folder") === "docs"
            ? [{ path: "taxes/2025.pdf", error: "permission denied" }]
            : [],
      });
    if (p === "/rest/db/scan" && method === "POST") {
      scanned.push(q.get("folder") ?? "");
      return reply(200, null);
    }
    const folder = /^\/rest\/config\/folders\/(.+)$/.exec(p);
    if (folder && method === "PATCH") {
      folders = folders.map((f) =>
        f.id === decodeURIComponent(folder[1]!) ? { ...f, paused: Boolean(body.paused) } : f,
      );
      return reply(200, null);
    }
    const dev = /^\/rest\/config\/devices\/(.+)$/.exec(p);
    if (dev && method === "PATCH") {
      devices = devices.map((d) =>
        d.deviceID === decodeURIComponent(dev[1]!) ? { ...d, paused: Boolean(body.paused) } : d,
      );
      return reply(200, null);
    }
    return reply(404, {});
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      folders = FOLDERS();
      devices = DEVICES();
    },
  };
}
