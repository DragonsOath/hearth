import type { Fetch } from "./http";

/**
 * A stand-in Bazarr (port 6767) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install): two movies and one episode missing subtitles, one throttled provider, and the calls
 * the panel's controls make. Searching Arrival finds a subtitle; searching Amelie finds nothing.
 */

export interface FakeBazarr {
  fetch: Fetch;
  reset(): void;
}

const en = { name: "English", code2: "en", forced: false, hi: false };
const MOVIES = () => [
  { title: "Arrival", radarrId: 11, missing_subtitles: [en] },
  {
    title: "Amelie",
    radarrId: 12,
    missing_subtitles: [en, { name: "French", code2: "fr", forced: true, hi: false }],
  },
];
const EPISODES = () => [
  {
    seriesTitle: "Severance",
    episode_number: "2x05",
    episodeTitle: "Trojan's Horse",
    sonarrSeriesId: 4,
    sonarrEpisodeId: 41,
    missing_subtitles: [en],
  },
];
const PROVIDERS = () => [
  { name: "opensubtitlescom", status: "TooManyRequests", retry: "in 2 hours" },
  { name: "podnapisi", status: "Good", retry: "-" },
];

export function fakeBazarr(): FakeBazarr {
  let movies = MOVIES();
  let episodes = EPISODES();
  let providers = PROVIDERS();
  const tasks: string[] = [];
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const q = u.searchParams;
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (!headers["X-API-KEY"]?.startsWith("e2e-")) return reply(401, {});
    switch (`${method} ${u.pathname}`) {
      case "GET /api/system/status":
        return reply(200, { data: { bazarr_version: "1.5.1" } });
      case "GET /api/movies/wanted":
        return reply(200, { data: movies, total: movies.length });
      case "GET /api/episodes/wanted":
        return reply(200, { data: episodes, total: episodes.length });
      case "GET /api/providers":
        return reply(200, { data: providers });
      case "POST /api/providers":
        if (q.get("action") === "reset")
          providers = providers.map((p) => ({ ...p, status: "Good", retry: "-" }));
        return reply(204, null);
      case "GET /api/movies/history":
        return reply(200, {
          data: [
            {
              title: "Dune: Part Two",
              description: "English subtitles downloaded from subdl",
              timestamp: Math.floor(Date.now() / 1000) - 10_800,
            },
          ],
        });
      case "GET /api/episodes/history":
        return reply(200, { data: [] });
      case "PATCH /api/movies":
        if (q.get("action") === "search-missing" && q.get("radarrid") === "11")
          movies = movies.filter((m) => m.radarrId !== 11);
        return reply(204, null);
      case "PATCH /api/series":
        if (q.get("action") === "search-missing")
          episodes = episodes.filter((e) => String(e.sonarrSeriesId) !== q.get("seriesid"));
        return reply(204, null);
      case "POST /api/system/tasks":
        tasks.push(q.get("taskid") ?? "");
        return reply(204, null);
      default:
        return reply(404, {});
    }
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      movies = MOVIES();
      episodes = EPISODES();
      providers = PROVIDERS();
    },
  };
}
