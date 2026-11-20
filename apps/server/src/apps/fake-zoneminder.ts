import type { Fetch } from "./http";

/**
 * A stand-in ZoneMinder (port 8484) for Panel Builder's tests (DC_FAKE_APPS=1, never in a real
 * install). Hearth has no ZoneMinder panel, so it gets the basic panel: the proof app for custom
 * panels. It answers ZoneMinder's own API shapes: monitors, recent events, disk use, and a
 * camera's snapshot picture. Auth is off, as on many home installs; a token, when sent, must start
 * "e2e-". Tests can make the events read fail, to see a block marked not possible.
 */
export interface FakeZoneMinder {
  fetch: Fetch;
  reset(): void;
  control(c: { eventsFail?: boolean }): void;
}

// A 2x2 PNG: enough for an <img> to load.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwHwyBNAMDA8N/AMxUC/tNSbeNAAAAAElFTkSuQmCC",
  "base64",
);

export function fakeZoneMinder(): FakeZoneMinder {
  let eventsFail = false;
  const reset = () => {
    eventsFail = false;
  };
  const reply = (status: number, body: unknown) => {
    const text = JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
      headers: {
        get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null),
      },
    };
  };
  const ago = (min: number) =>
    new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const monitors = [
    { Id: "1", Name: "Front door", Function: "Record", Enabled: "1" },
    { Id: "2", Name: "Driveway", Function: "Modect", Enabled: "1" },
    { Id: "3", Name: "Garage", Function: "None", Enabled: "0" },
  ];
  const fetchImpl: Fetch = async (url) => {
    const u = new URL(url);
    const token = u.searchParams.get("token");
    if (token !== null && !token.startsWith("e2e-")) return reply(401, { success: false });
    const p = u.pathname;
    if (p === "/zm/api/host/getVersion.json")
      return reply(200, { version: "1.36.35", apiversion: "2.0" });
    // Not ZoneMinder's: a stand-in list of titles with movie-database posters, for the custom
    // panel cover-art test (Tasterr and Seerr give lists like this).
    if (p === "/zm/api/posters.json")
      return reply(200, {
        results: [
          {
            title: "Runner",
            media_type: "movie",
            year: 2026,
            rating: 8.195,
            poster_path: "/runner1.jpg",
          },
          {
            title: "Superstore",
            media_type: "tv",
            year: 2015,
            rating: 7.526,
            poster_path: "/superstore.jpg",
          },
          { title: "No poster yet", media_type: "movie", year: 2026, rating: 0 },
        ],
      });
    // One monitor, as ZoneMinder answers it (a code panel's read on demand).
    const one = /^\/zm\/api\/monitors\/(\d+)\.json$/.exec(p);
    if (one) {
      const m = monitors.find((x) => x.Id === one[1]);
      return m ? reply(200, { monitor: { Monitor: m } }) : reply(404, { success: false });
    }
    if (p === "/zm/api/monitors.json")
      return reply(200, {
        monitors: monitors.map((m) => ({
          Monitor: m,
          Monitor_Status: { Status: m.Enabled === "1" ? "Connected" : "NotRunning" },
        })),
      });
    if (p === "/zm/api/events/index.json") {
      if (eventsFail) return reply(500, { success: false, data: { name: "Internal error" } });
      return reply(200, {
        events: [
          {
            Event: {
              Id: "905",
              MonitorId: "1",
              Name: "Event- 905",
              Cause: "Motion",
              StartTime: ago(12),
              Length: "18.40",
            },
          },
          {
            Event: {
              Id: "904",
              MonitorId: "2",
              Name: "Event- 904",
              Cause: "Motion",
              StartTime: ago(47),
              Length: "9.10",
            },
          },
          {
            Event: {
              Id: "903",
              MonitorId: "1",
              Name: "Event- 903",
              Cause: "Motion",
              StartTime: ago(130),
              Length: "31.00",
            },
          },
        ],
        pagination: { page: 1, current: 3, count: 3 },
      });
    }
    if (p === "/zm/api/host/getDiskPercent.json")
      return reply(200, { usage: { Total: { space: "41.2", color: "#ffffff" } } });
    if (p === "/zm/cgi-bin/nph-zms" && u.searchParams.get("mode") === "single") {
      if (!monitors.some((m) => m.Id === u.searchParams.get("monitor")))
        return reply(404, { success: false });
      return {
        ok: true,
        status: 200,
        json: async () => null,
        arrayBuffer: async () =>
          PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) as ArrayBuffer,
        headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "image/png" : null) },
      };
    }
    return reply(404, { success: false });
  };
  return {
    fetch: fetchImpl,
    reset,
    control: (c) => {
      if (c.eventsFail !== undefined) eventsFail = c.eventsFail;
    },
  };
}
