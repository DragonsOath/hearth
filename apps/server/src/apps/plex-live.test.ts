import { describe, expect, it } from "vitest";
import { AppKeyError, type Fetch } from "./http";
import { PLEX_ART, PlexLive, plexReport, toSession } from "./plex-live";
import { samplePlex } from "./samples";

const BASE = "http://192.168.1.10:32400";
const TOKEN = "plex-token-secret-xyz";

function fakePlex(sessions: unknown[] = []) {
  const calls: { path: string; token?: string }[] = [];
  const routes: Record<string, unknown> = {
    "/": { MediaContainer: { version: "1.43.4.10903", friendlyName: "Homeserver" } },
    "/library/sections": {
      MediaContainer: {
        Directory: [
          { key: "1", title: "Movies", type: "movie" },
          { key: "2", title: "TV Shows", type: "show" },
        ],
      },
    },
    "/library/recentlyAdded": {
      MediaContainer: {
        Metadata: [
          {
            ratingKey: "55",
            title: "Pilot",
            type: "episode",
            grandparentTitle: "Ghosts",
            parentIndex: 1,
            index: 1,
            addedAt: 1760000000,
            grandparentThumb: "/library/metadata/50/thumb/1759999999",
          },
        ],
      },
    },
    "/status/sessions": { MediaContainer: { Metadata: sessions } },
    "/activities": {
      MediaContainer: { Activity: [{ title: "Scanning", subtitle: "Movies", progress: 40 }] },
    },
  };
  const counts: Record<string, number> = { "1:": 1200, "2:2": 210, "2:3": 950, "2:4": 18000 };
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, token: init.headers["X-Plex-Token"] });
    if (init.headers["X-Plex-Token"] !== TOKEN)
      return { ok: false, status: 401, json: async () => ({}) };
    const m = /^\/library\/sections\/(\d+)\/all$/.exec(u.pathname);
    if (m) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          MediaContainer: {
            size: 0,
            totalSize: counts[`${m[1]}:${u.searchParams.get("type") ?? ""}`] ?? 0,
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => routes[u.pathname] ?? {} };
  };
  return { fetchImpl, calls };
}

describe("Plex live dashboard", () => {
  it("counts libraries, shows who is watching, and keeps the token in the header", async () => {
    const plex = fakePlex([
      {
        ratingKey: "77",
        title: "Dune",
        type: "movie",
        year: 2024,
        viewOffset: 3600000,
        duration: 9600000,
        thumb: "/library/metadata/77/thumb/1",
        User: { title: "Jeff" },
        Player: {
          title: "Living Room",
          device: "Google TV",
          platform: "Android",
          state: "playing",
          local: true,
        },
        Session: { id: "abc", bandwidth: 40000 },
        Media: [{ videoResolution: "4k", bitrate: 38000 }],
      },
    ]);
    const live = new PlexLive(plex.fetchImpl);
    const d = await live.dashboard("plex", BASE, TOKEN);
    expect(d.totals).toEqual({ movies: 1200, shows: 210, seasons: 950, episodes: 18000 });
    expect(d.libraries.map((l) => [l.title, l.count])).toEqual([
      ["Movies", 1200],
      ["TV Shows", 210],
    ]);
    expect(d.recentlyAdded[0]).toMatchObject({
      show: "Ghosts",
      season: 1,
      episode: 1,
      thumb: "/library/metadata/50/thumb/1759999999",
    });
    expect(d.sessions[0]).toMatchObject({
      user: "Jeff",
      player: "Living Room",
      decision: "direct play",
      resolution: "4k",
      progressPct: 37.5,
      state: "playing",
    });
    expect(d.activities[0]).toEqual({ title: "Scanning", subtitle: "Movies", progressPct: 40 });
    expect(plex.calls.every((c) => c.token === TOKEN && !c.path.includes(TOKEN))).toBe(true);
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    // Library counts are cached for a minute; sessions are read every time.
    const before = plex.calls.length;
    await live.dashboard("plex", BASE, TOKEN);
    expect(plex.calls.slice(before).map((c) => c.path.split("?")[0])).toEqual([
      "/status/sessions",
      "/activities",
    ]);
  });

  it("tells direct play, direct stream, and transcoding apart, and flags a slow transcoder", () => {
    const base = { Player: { state: "playing" }, duration: 100, viewOffset: 50 };
    expect(toSession(base).decision).toBe("direct play");
    expect(
      toSession({ ...base, TranscodeSession: { videoDecision: "copy", audioDecision: "copy" } })
        .decision,
    ).toBe("direct stream");
    const slow = toSession({
      ...base,
      Player: { state: "buffering" },
      TranscodeSession: { videoDecision: "transcode", speed: 0.6 },
    });
    expect(slow).toMatchObject({
      decision: "transcode",
      transcodeSpeed: 0.6,
      problem: "Buffering: the transcoder runs at 0.6x, slower than real time.",
    });
    // A throttled transcoder is ahead of playback on purpose: not a problem.
    expect(
      toSession({
        ...base,
        TranscodeSession: { videoDecision: "transcode", speed: 0.4, throttled: true },
      }).problem,
    ).toBeUndefined();
  });

  it("refuses a wrong token as a credential problem, and only Plex artwork paths are proxied", async () => {
    const live = new PlexLive(fakePlex().fetchImpl);
    await expect(live.dashboard("plex", BASE, "wrong")).rejects.toBeInstanceOf(AppKeyError);
    expect(PLEX_ART.test("/library/metadata/77/thumb/1700000000")).toBe(true);
    expect(PLEX_ART.test("/library/metadata/77/art")).toBe(true);
    expect(PLEX_ART.test("/:/prefs")).toBe(false);
    expect(PLEX_ART.test("/library/metadata/77/thumb/1?X-Plex-Token=x")).toBe(false);
    expect(PLEX_ART.test("http://evil.example/library/metadata/1/thumb")).toBe(false);
  });

  it("the health read counts what matters and warns about struggling streams", () => {
    const r = plexReport(samplePlex());
    expect(r.facts).toContainEqual({ label: "Watching now", value: "2" });
    expect(r.issues[0]!.text).toMatch(/^Sam on Chrome: Buffering/);
  });
});
