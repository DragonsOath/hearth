import type { Fetch } from "./http";

/**
 * A stand-in Tautulli 2.18 (port 8181) for tests and safe previews (DC_FAKE_APPS=1, never in a
 * real install): two people watching (one direct, one converted for a phone away from home), this
 * week's tops, play records, people and libraries that can be edited, plays per day, a log with a
 * key in it (Hearth hides it), and streams that can be stopped.
 */

export interface FakeTautulli {
  fetch: Fetch;
  reset(): void;
}

const SESSIONS = () => [
  {
    session_id: "lr-1",
    friendly_name: "Alex",
    full_title: "Severance - Hello, Ms. Cobel",
    media_type: "episode",
    grandparent_thumb: "/library/metadata/77/thumb/1700000000",
    progress_percent: "42",
    state: "playing",
    player: "Living Room",
    product: "Plex for LG",
    video_full_resolution: "4k",
    stream_video_full_resolution: "4k",
    transcode_decision: "direct play",
    video_decision: "direct play",
    audio_decision: "direct play",
    bandwidth: "20300",
    location: "lan",
  },
  {
    session_id: "ph-2",
    friendly_name: "sam",
    full_title: "Dune: Part Two",
    year: "2024",
    media_type: "movie",
    thumb: "/library/metadata/88/thumb/1700000001",
    progress_percent: "71",
    state: "playing",
    player: "iPhone",
    product: "Plex for iOS",
    video_full_resolution: "4k",
    stream_video_full_resolution: "720p",
    video_codec: "hevc",
    stream_video_codec: "h264",
    transcode_decision: "transcode",
    video_decision: "transcode",
    audio_decision: "copy",
    transcode_hw_encoding: 1,
    bandwidth: "8200",
    location: "wan",
  },
];

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

const USERS = () => [
  {
    user_id: 1,
    username: "alex",
    friendly_name: "Alex",
    keep_history: 1,
    allow_guest: 0,
    is_admin: 1,
  },
  { user_id: 2, username: "sam", friendly_name: "sam", keep_history: 1, allow_guest: 0 },
  { user_id: 3, username: "kim", friendly_name: "kim", keep_history: 0, allow_guest: 1 },
];

const LIBRARIES = () => [
  {
    section_id: 1,
    section_name: "Movies",
    section_type: "movie",
    count: 812,
    // As the real Tautulli: a movie library has null season and episode counts.
    parent_count: null as number | null,
    child_count: null as number | null,
    keep_history: 1,
  },
  {
    section_id: 2,
    section_name: "TV Shows",
    section_type: "show",
    count: 140,
    parent_count: 512,
    child_count: 6123,
    keep_history: 1,
  },
];

interface Row {
  row_id: number;
  user_id: number;
  friendly_name: string;
  full_title: string;
  media_type: string;
  date: number;
  percent_complete: number;
  play_duration: number;
  player: string;
  product: string;
  location: string;
  transcode_decision: string;
}

const HISTORY = (): Row[] => {
  const t = now();
  const row = (
    row_id: number,
    user_id: number,
    friendly_name: string,
    full_title: string,
    media_type: string,
    ago: number,
    extra: Partial<Row> = {},
  ): Row => ({
    row_id,
    user_id,
    friendly_name,
    full_title,
    media_type,
    date: t - ago,
    percent_complete: 100,
    play_duration: 2700,
    player: "Living Room",
    product: "Plex for LG",
    location: "lan",
    transcode_decision: "direct play",
    ...extra,
  });
  return [
    row(5, 1, "Alex", "Severance - Woe's Hollow", "episode", 72_000),
    row(4, 2, "sam", "Dune: Part Two", "movie", DAY * 2, {
      player: "iPhone",
      product: "Plex for iOS",
      location: "wan",
      transcode_decision: "transcode",
      percent_complete: 64,
    }),
    row(3, 1, "Alex", "Severance - Hello, Ms. Cobel", "episode", DAY * 3),
    row(2, 3, "kim", "Quiet Harbor", "movie", DAY * 6),
    row(1, 2, "sam", "Signal Hill - Pilot", "episode", DAY * 9),
  ];
};

// A 1x1 PNG, for the poster route.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export function fakeTautulli(): FakeTautulli {
  let sessions = SESSIONS();
  let users = USERS();
  let libraries = LIBRARIES();
  let history = HISTORY();
  const ok = (data: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ response: { result: "success", message: null, data } }),
  });
  const fetchImpl: Fetch = async (url) => {
    const u = new URL(url);
    const p = u.searchParams;
    if (!p.get("apikey")?.startsWith("e2e-"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: { result: "error", message: "Invalid apikey" } }),
      };
    switch (p.get("cmd")) {
      case "get_tautulli_info":
        return ok({ tautulli_version: "v2.18.2" });
      case "get_activity": {
        const bw = (loc?: string) =>
          sessions
            .filter((s) => !loc || s.location === loc)
            .reduce((n, s) => n + Number(s.bandwidth), 0);
        return ok({
          stream_count: sessions.length,
          total_bandwidth: bw(),
          wan_bandwidth: bw("wan"),
          sessions,
        });
      }
      case "terminate_session":
        sessions = sessions.filter((s) => s.session_id !== p.get("session_id"));
        return ok(null);
      case "get_home_stats":
        return ok([
          {
            stat_id: "top_users",
            rows: [
              { friendly_name: "Alex", total_plays: 14 },
              { friendly_name: "sam", total_plays: 9 },
            ],
          },
          { stat_id: "top_movies", rows: [{ title: "Dune: Part Two", total_plays: 3 }] },
          { stat_id: "top_tv", rows: [{ title: "Severance", total_plays: 8 }] },
        ]);
      case "get_history": {
        const search = (p.get("search") ?? "").toLowerCase();
        const rows = history.filter(
          (h) =>
            (!p.get("user_id") || String(h.user_id) === p.get("user_id")) &&
            (!p.get("media_type") || h.media_type === p.get("media_type")) &&
            (!search || h.full_title.toLowerCase().includes(search)),
        );
        const start = Number(p.get("start") ?? 0);
        const length = Number(p.get("length") ?? 25);
        return ok({
          recordsFiltered: rows.length,
          recordsTotal: history.length,
          data: rows.slice(start, start + length),
        });
      }
      case "delete_history": {
        const ids = (p.get("row_ids") ?? "").split(",").map(Number);
        history = history.filter((h) => !ids.includes(h.row_id));
        return ok("Deleted history.");
      }
      case "get_user_names":
        return ok(users.map((x) => ({ user_id: x.user_id, friendly_name: x.friendly_name })));
      case "get_users_table":
        return ok({
          recordsFiltered: users.length,
          recordsTotal: users.length,
          data: users.map((x) => {
            const mine = history.filter((h) => h.user_id === x.user_id);
            return {
              ...x,
              plays: mine.length,
              duration: mine.reduce((n, h) => n + h.play_duration, 0),
              last_seen: mine[0]?.date ?? null,
              last_played: mine[0]?.full_title ?? null,
              player: mine[0]?.player ?? null,
              platform: mine[0]?.product ?? null,
            };
          }),
        });
      case "get_user":
        return ok(users.find((y) => String(y.user_id) === p.get("user_id")) ?? {});
      case "edit_user": {
        const x = users.find((y) => String(y.user_id) === p.get("user_id"));
        if (!x) return ok(null);
        // As in Tautulli 2.17 and older: a value it is not sent goes back to its default.
        // As the real Tautulli: a name equal to the username is ignored, an empty one resets to it.
        const name = p.get("friendly_name");
        if (name === null || name === "") x.friendly_name = x.username;
        else if (name !== x.username) x.friendly_name = name;
        x.keep_history = Number(p.get("keep_history") ?? 1);
        x.allow_guest = Number(p.get("allow_guest") ?? 0);
        return ok("Successfully updated user.");
      }
      case "get_user_watch_time_stats":
        return ok(
          [1, 7, 30, 0].map((d) => ({
            query_days: d,
            total_plays: d === 1 ? 0 : 2,
            total_time: d === 1 ? 0 : 5400,
          })),
        );
      case "get_user_player_stats":
        return ok([{ platform_name: "Plex for LG", player_name: "Living Room", total_plays: 2 }]);
      case "get_libraries_table":
        return ok({
          recordsFiltered: libraries.length,
          recordsTotal: libraries.length,
          data: libraries.map((l) => ({
            ...l,
            plays: l.section_id === 1 ? 2 : 3,
            duration: 9000,
            last_accessed: now() - 72_000,
            last_played: l.section_id === 1 ? "Dune: Part Two" : "Severance",
          })),
        });
      case "get_library":
        return ok(libraries.find((y) => String(y.section_id) === p.get("section_id")) ?? {});
      case "edit_library": {
        const l = libraries.find((y) => String(y.section_id) === p.get("section_id"));
        if (l) l.keep_history = Number(p.get("keep_history") ?? 1);
        return ok(null);
      }
      case "get_plays_by_date": {
        const days = Number(p.get("time_range") ?? 30);
        const dates = Array.from({ length: days }, (_, i) =>
          new Date((now() - (days - 1 - i) * DAY) * 1000).toISOString().slice(0, 10),
        );
        const tv = dates.map((_, i) => (i % 3) + (i % 5 === 0 ? 2 : 0));
        const movies = dates.map((_, i) => (i % 4 === 0 ? 1 : 0));
        return ok({
          categories: dates,
          series: [
            { name: "TV", data: tv },
            { name: "Movies", data: movies },
            { name: "Total", data: tv.map((n, i) => n + movies[i]!) },
          ],
        });
      }
      case "get_logs":
        return ok([
          {
            time: "2026-11-01 21:56:46 ",
            loglevel: "WARNING",
            msg: "Tautulli Users :: Unable to refresh users list.",
          },
          {
            time: "2026-11-01 21:56:40 ",
            loglevel: "DEBUG",
            msg: "Tautulli API :: get_activity apikey=0123456789abcdef0123456789abcdef",
          },
        ]);
      case "backup_db":
      case "refresh_users_list":
      case "refresh_libraries_list":
        return ok(true);
      case "pms_image_proxy":
        return {
          ok: true,
          status: 200,
          headers: {
            get: (n: string) => (n.toLowerCase() === "content-type" ? "image/png" : null),
          },
          json: async () => ({}),
          arrayBuffer: async () =>
            PIXEL.buffer.slice(PIXEL.byteOffset, PIXEL.byteOffset + PIXEL.length),
        } as unknown as Awaited<ReturnType<Fetch>>;
      default:
        return {
          ok: true,
          status: 200,
          json: async () => ({ response: { result: "error", message: "Unknown command" } }),
        };
    }
  };
  return {
    fetch: fetchImpl,
    reset: () => {
      sessions = SESSIONS();
      users = USERS();
      libraries = LIBRARIES();
      history = HISTORY();
    },
  };
}
