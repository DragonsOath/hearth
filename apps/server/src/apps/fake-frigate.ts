import type { Fetch } from "./http";

/**
 * A stand-in Frigate (port 8971) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as a throwaway ghcr.io/blakeblackshear/frigate 0.18.2 did: sign-in with any
 * password starting "e2e-" (a session cookie), live stats for two cameras (one with no picture), a
 * detector, recent events, today's alerts and storage. Its /api/config carries a camera stream
 * address with a password in it, as real configs do, so tests can show Hearth never asks for it.
 * Switching detection, keeping and deleting events and restarting change what it answers next.
 */

export interface FakeFrigate {
  fetch: Fetch;
  reset(): void;
}

export function fakeFrigate(): FakeFrigate {
  const now = () => Date.now() / 1000;
  let detecting: Record<string, boolean> = {};
  let events: {
    id: string;
    camera: string;
    label: string;
    start_time: number;
    has_snapshot: boolean;
    retain_indefinitely: boolean;
  }[] = [];
  const reset = () => {
    detecting = { front_door: true, garage: true };
    events = [
      {
        id: "1794184751.37-a1",
        camera: "front_door",
        label: "person",
        start_time: now() - 600,
        has_snapshot: true,
        retain_indefinitely: false,
      },
      {
        id: "1794184001.12-b2",
        camera: "front_door",
        label: "car",
        start_time: now() - 3600,
        has_snapshot: true,
        retain_indefinitely: true,
      },
    ];
  };
  reset();

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
    return {
      ok: status < 400,
      status,
      json: async () => JSON.parse(text || "null") as unknown,
      text: async () => text,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    };
  };

  const fetchImpl: Fetch = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    if (path === "/login" && method === "POST") {
      const { password } = JSON.parse(init.body ?? "{}") as { password?: string };
      if (!password?.startsWith("e2e-")) return reply(401, { message: "Login failed" });
      return reply(
        200,
        {},
        { "set-cookie": "frigate_token=e2e-session; Path=/; HttpOnly; Secure" },
      );
    }
    if (!(init.headers.Cookie ?? "").includes("frigate_token=e2e-session"))
      return reply(401, { message: "Unauthorized" });
    if (path === "/config")
      return reply(200, {
        cameras: {
          front_door: {
            ffmpeg: { inputs: [{ path: "rtsp://admin:e2e-SECRET-cam@10.0.0.40/stream1" }] },
          },
        },
      });
    if (path === "/version") return reply(200, "0.18.2-cfa08c5");
    if (path === "/stats")
      return reply(200, {
        cameras: {
          front_door: {
            camera_fps: 5.0,
            expected_fps: 5,
            detection_enabled: detecting.front_door,
            connection_quality: "good",
            reconnects_last_hour: 0,
          },
          garage: {
            camera_fps: 0,
            expected_fps: 5,
            detection_enabled: detecting.garage,
            connection_quality: "unusable",
            reconnects_last_hour: 4,
          },
        },
        detectors: { coral: { inference_speed: 8.4 } },
        service: {
          uptime: 3 * 86_400,
          version: "0.18.2-cfa08c5",
          latest_version: "0.18.2",
          storage: {
            "/media/frigate/recordings": { total: 1_024_000, used: 980_000, free: 44_000 },
          },
        },
      });
    if (path === "/events") return reply(200, events);
    if (path === "/review/summary")
      return reply(200, {
        last24Hours: {
          total_alert: 3,
          reviewed_alert: 1,
          total_detection: 7,
          reviewed_detection: 7,
        },
      });
    if (path === "/recordings/storage")
      return reply(200, {
        front_door: { usage: 812_000.4, bandwidth: 12 },
        garage: { usage: 168_000, bandwidth: 0 },
      });
    const cam = /^\/camera\/([^/]+)\/set\/(detect|recordings)$/.exec(path);
    if (cam && method === "PUT") {
      const value = (JSON.parse(init.body ?? "{}") as { value?: string }).value;
      if (cam[2] === "detect") detecting[cam[1]!] = value === "ON";
      return reply(200, { success: true });
    }
    const ev = /^\/events\/([^/]+?)(\/retain)?$/.exec(path);
    if (ev) {
      const e = events.find((x) => x.id === decodeURIComponent(ev[1]!));
      if (!e) return reply(404, { success: false, message: "Event not found" });
      if (ev[2]) {
        e.retain_indefinitely = method === "POST";
        return reply(200, { success: true });
      }
      if (method === "DELETE") {
        events = events.filter((x) => x !== e);
        return reply(200, { success: true });
      }
      return reply(200, e);
    }
    if (path === "/restart" && method === "POST")
      return reply(200, { success: true, message: "Restarting (just a few seconds)..." });
    return reply(404, { detail: "Not Found" });
  };

  return { fetch: fetchImpl, reset };
}
