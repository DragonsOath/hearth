import { describe, expect, it } from "vitest";
import type { Fetch } from "./http";
import { QbittorrentLive, toTorrent, torrentStatus } from "./qbittorrent-live";
import { sampleQbittorrent } from "./samples";

const BASE = "http://192.168.1.10:8080";
const LOGIN = { username: "admin", password: "qb-secret-pw" };
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);

/** A stand-in qBittorrent: sign-in, version, maindata by rid, trackers, properties. */
function fakeQb() {
  const calls: { path: string; cookie?: string; body?: string }[] = [];
  let session = "QBT_SID_8080=s1";
  let expireNext = false;
  const maindata: Record<number, unknown> = {
    0: {
      rid: 1,
      full_update: true,
      torrents: {
        [H1]: {
          name: "Ghost.S05E02",
          state: "downloading",
          progress: 0.67,
          size: 1000,
          amount_left: 330,
          dlspeed: 500,
          num_seeds: 4,
          num_complete: 40,
          tracker: "https://t.example.org/passkey123abc/announce",
        },
        [H2]: {
          name: "The.Orville.S02E04",
          state: "stalledDL",
          progress: 0.34,
          size: 2000,
          amount_left: 1320,
          num_seeds: 0,
          num_complete: 0,
          priority: 2,
        },
      },
      server_state: {
        connection_status: "connected",
        dl_info_speed: 500,
        up_info_speed: 20,
        free_space_on_disk: 99,
      },
    },
    1: {
      rid: 2,
      torrents: { [H1]: { progress: 0.71, amount_left: 290 } },
      server_state: { dl_info_speed: 640 },
    },
    2: { rid: 3, torrents_removed: [H2] },
  };
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, cookie: init.headers.Cookie, body: init.body });
    const ok = (body: unknown, extra: Partial<Awaited<ReturnType<Fetch>>> = {}) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      ...extra,
    });
    if (u.pathname === "/api/v2/auth/login") {
      session = `QBT_SID_8080=s${calls.filter((c) => c.path === "/api/v2/auth/login").length}`;
      return ok("Ok.", { headers: { get: () => `${session}; HttpOnly; path=/` } });
    }
    if (init.headers.Cookie !== session || expireNext) {
      expireNext = false;
      return { ok: false, status: 403, json: async () => ({}) };
    }
    if (u.pathname === "/api/v2/app/version") return ok("v5.2.4");
    if (u.pathname === "/api/v2/sync/maindata")
      return ok(maindata[Number(u.searchParams.get("rid"))] ?? { rid: 3 });
    if (u.pathname === "/api/v2/torrents/trackers")
      return ok([
        { url: "** [DHT] **", status: 2, num_seeds: 0, num_leeches: 1 },
        {
          url: "https://t.example.org/passkey123abc/announce",
          status: 4,
          msg: "Timed out token=abcdefabcdefabcdefabcdefabcdefab",
        },
      ]);
    if (u.pathname === "/api/v2/torrents/properties")
      return ok({
        save_path: "/downloads",
        seeds: 0,
        peers: 1,
        pieces_have: 340,
        pieces_num: 1000,
      });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls, expire: () => (expireNext = true) };
}

describe("qBittorrent live dashboard", () => {
  it("signs in once, then fetches only what changed", async () => {
    const qb = fakeQb();
    const live = new QbittorrentLive(qb.fetchImpl);
    const first = await live.dashboard("qb", BASE, LOGIN);
    expect(first).toMatchObject({
      version: "5.2.4",
      connection: "connected",
      downSpeed: 500,
      freeSpaceBytes: 99,
    });
    expect(first.torrents.map((t) => [t.name, t.status, t.progressPct])).toEqual([
      ["Ghost.S05E02", "downloading", 67],
      ["The.Orville.S02E04", "stalled", 34],
    ]);
    const second = await live.dashboard("qb", BASE, LOGIN);
    expect(second.torrents.find((t) => t.hash === H1)).toMatchObject({
      progressPct: 71,
      leftBytes: 290,
      name: "Ghost.S05E02",
    });
    expect(second.downSpeed).toBe(640);
    const third = await live.dashboard("qb", BASE, LOGIN);
    expect(third.torrents.map((t) => t.hash)).toEqual([H1]);
    expect(qb.calls.filter((c) => c.path === "/api/v2/auth/login")).toHaveLength(1);
    expect(
      qb.calls.filter((c) => c.path.startsWith("/api/v2/sync/maindata")).map((c) => c.path),
    ).toEqual([
      "/api/v2/sync/maindata?rid=0",
      "/api/v2/sync/maindata?rid=1",
      "/api/v2/sync/maindata?rid=2",
    ]);
  });

  it("signs in again once when qBittorrent ends the session", async () => {
    const qb = fakeQb();
    const live = new QbittorrentLive(qb.fetchImpl);
    await live.dashboard("qb", BASE, LOGIN);
    qb.expire();
    await live.dashboard("qb", BASE, LOGIN);
    expect(qb.calls.filter((c) => c.path === "/api/v2/auth/login")).toHaveLength(2);
  });

  it("never passes on a tracker's personal key, and explains a stall with no seeders", async () => {
    const qb = fakeQb();
    const live = new QbittorrentLive(qb.fetchImpl);
    const d = await live.dashboard("qb", BASE, LOGIN);
    const json = JSON.stringify(d);
    expect(json).not.toContain("passkey123abc");
    expect(json).not.toContain("qb-secret-pw");
    expect(d.torrents[0]!.tracker).toBe("t.example.org");
    expect(d.torrents[1]).toMatchObject({
      problem: "Stalled: no seeders in the swarm.",
      queuePosition: 2,
    });
    const detail = await live.detail("qb", BASE, LOGIN, H2);
    expect(detail.trackers).toEqual([
      { host: "DHT", status: "working", seeds: 0, leechers: 1 },
      {
        host: "t.example.org",
        status: "not working",
        message: expect.stringMatching(/^Timed out token=/),
      },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/passkey123abc|abcdefabcdefabcdefabcdefabcdefab/);
    expect(detail.peers).toEqual({ connected: 1, seeds: 0, leechers: 1 });
    await expect(live.detail("qb", BASE, LOGIN, "../../etc")).rejects.toThrow(/Not a torrent hash/);
  });

  it("maps every qBittorrent state, version 4 and 5 alike", () => {
    expect(torrentStatus("pausedDL", 0.2)).toBe("paused");
    expect(torrentStatus("stoppedDL", 0.2)).toBe("paused");
    expect(torrentStatus("pausedUP", 1)).toBe("completed");
    expect(torrentStatus("stalledUP", 1)).toBe("seeding");
    expect(torrentStatus("forcedMetaDL", 0)).toBe("metadata");
    expect(torrentStatus("missingFiles", 0.9)).toBe("error");
    expect(toTorrent(H1, { state: "downloading", eta: 8640000 }).etaSec).toBeUndefined();
  });

  it("sample data moves and covers every group", () => {
    const a = sampleQbittorrent(0).torrents[0]!.progressPct;
    const b = sampleQbittorrent(120_000).torrents[0]!.progressPct;
    expect(b).toBeGreaterThan(a);
    const statuses = new Set(sampleQbittorrent().torrents.map((t) => t.status));
    for (const s of [
      "downloading",
      "stalled",
      "seeding",
      "queued",
      "paused",
      "completed",
      "error",
      "metadata",
    ]) {
      expect(statuses.has(s as never), s).toBe(true);
    }
  });
});
