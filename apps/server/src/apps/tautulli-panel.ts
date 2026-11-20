/**
 * The native Tautulli panel's tabs beyond its Overview: History (every play, by person, kind and
 * title), People (who watches, how much, when last, on what), Libraries (plays per library),
 * Graphs (plays per day) and System (Tautulli's own log, keys hidden). Reads only; changes are plan
 * steps (tautulli-control.ts). Notifications, newsletters and Tautulli's settings stay in Tautulli.
 */

export const TAUTULLI_VIEWS = ["history", "users", "user", "libraries", "graphs", "logs"] as const;
export type TautulliView = (typeof TAUTULLI_VIEWS)[number];

export class TautulliReadError extends Error {}

/** One Tautulli command; the caller holds the key. Throws on an error answer. */
export type TautulliRead = <T>(cmd: string, params?: Record<string, string | number>) => Promise<T>;

/** Keys, tokens and passwords out of a log line before it leaves Hearth. */
export function scrubTautulli(line: string): string {
  return line
    .replace(
      /((?:api_?key|apikey|token|password|X-Plex-Token)["'=:\s]+)[^\s"'&,;]+/gi,
      "$1[hidden]",
    )
    .replace(/\b[a-f0-9]{32}\b/gi, "[hidden]")
    .replace(/\b[A-Za-z0-9_-]{20}\b(?=[^A-Za-z0-9_-]|$)/g, (m) =>
      // Plex tokens are 20 characters of letters, digits, _ and -; plain words are left alone.
      /\d/.test(m) && /[A-Za-z]/.test(m) ? "[hidden]" : m,
    );
}

const at = (s?: number | string | null) =>
  s !== undefined && s !== null && s !== "" && Number(s) > 0
    ? new Date(Number(s) * 1000).toISOString()
    : undefined;

interface Table<T> {
  recordsFiltered?: number;
  recordsTotal?: number;
  data?: T[];
}

export interface RawHistory {
  row_id?: number;
  id?: number;
  date?: number;
  friendly_name?: string;
  user_id?: number;
  full_title?: string;
  media_type?: string;
  player?: string;
  platform?: string;
  product?: string;
  location?: string;
  percent_complete?: number;
  play_duration?: number;
  transcode_decision?: string;
  watched_status?: number;
  rating_key?: number | string;
}

export const historyRow = (h: RawHistory) => ({
  id: Number(h.row_id ?? h.id ?? 0),
  at: at(h.date),
  who: h.friendly_name ?? "Someone",
  userId: h.user_id,
  title: h.full_title ?? "Something",
  type: h.media_type,
  player: [h.product, h.player].filter(Boolean).join(" on ") || undefined,
  away: h.location === "wan",
  watchedPct: h.percent_complete,
  minutes: h.play_duration !== undefined ? Math.round(h.play_duration / 60) : undefined,
  how: h.transcode_decision,
});

export async function readTautulliView(
  read: TautulliRead,
  view: TautulliView,
  q: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (view === "history") {
    const page = Math.max(1, Math.min(200, Number(q.page) || 1));
    const size = 50;
    const params: Record<string, string | number> = {
      start: (page - 1) * size,
      length: size,
      order_column: "date",
      order_dir: "desc",
    };
    if (q.userId && /^\d+$/.test(q.userId)) params.user_id = q.userId;
    if (q.type && /^(movie|episode|track|live)$/.test(q.type)) params.media_type = q.type;
    if (q.q) params.search = q.q.slice(0, 100);
    const [h, users] = await Promise.all([
      read<Table<RawHistory>>("get_history", params),
      read<{ user_id: number; friendly_name?: string }[]>("get_user_names"),
    ]);
    return {
      page,
      total: h.recordsFiltered ?? 0,
      people: users.map((u) => ({ id: u.user_id, name: u.friendly_name ?? `User ${u.user_id}` })),
      entries: (h.data ?? []).map(historyRow),
    };
  }
  if (view === "users") {
    const t = await read<
      Table<{
        user_id: number;
        friendly_name?: string;
        username?: string;
        plays?: number;
        duration?: number;
        last_seen?: number | null;
        last_played?: string | null;
        player?: string | null;
        platform?: string | null;
      }>
    >("get_users_table", { length: 200, order_column: "last_seen", order_dir: "desc" });
    return {
      users: (t.data ?? []).map((u) => ({
        id: u.user_id,
        name: u.friendly_name || u.username || `User ${u.user_id}`,
        username: u.username,
        plays: u.plays ?? 0,
        hours: Math.round(((u.duration ?? 0) / 3600) * 10) / 10,
        lastSeen: at(u.last_seen),
        lastPlayed: u.last_played ?? undefined,
        player: [u.platform, u.player].filter(Boolean).join(" · ") || undefined,
      })),
    };
  }
  if (view === "user") {
    const id = q.id ?? "";
    if (!/^\d+$/.test(id)) throw new TautulliReadError("Not a Tautulli user.");
    const [u, times, players] = await Promise.all([
      read<{
        user_id?: number;
        friendly_name?: string;
        username?: string;
        keep_history?: number;
        allow_guest?: number;
        is_active?: number;
      }>("get_user", { user_id: id }),
      read<{ query_days?: number; total_plays?: number; total_time?: number }[]>(
        "get_user_watch_time_stats",
        { user_id: id, query_days: "1,7,30,0" },
      ),
      read<{ platform_name?: string; player_name?: string; total_plays?: number }[]>(
        "get_user_player_stats",
        { user_id: id },
      ),
    ]);
    if (u.user_id === undefined) throw new TautulliReadError("Tautulli does not know that user.");
    return {
      id: u.user_id,
      name: u.friendly_name || u.username || `User ${u.user_id}`,
      username: u.username,
      keepHistory: u.keep_history !== 0,
      allowGuest: u.allow_guest === 1,
      watchTime: times.map((t) => ({
        days: t.query_days ?? 0,
        plays: t.total_plays ?? 0,
        hours: Math.round(((t.total_time ?? 0) / 3600) * 10) / 10,
      })),
      players: players.slice(0, 5).map((p) => ({
        name: [p.platform_name, p.player_name].filter(Boolean).join(" · ") || "A player",
        plays: p.total_plays ?? 0,
      })),
    };
  }
  if (view === "libraries") {
    const t = await read<
      Table<{
        section_id: number;
        section_name?: string;
        section_type?: string;
        count?: number | string;
        parent_count?: number | string | null;
        child_count?: number | string | null;
        plays?: number;
        duration?: number;
        last_accessed?: number | null;
        last_played?: string | null;
        keep_history?: number;
      }>
    >("get_libraries_table", { length: 100, order_column: "section_name", order_dir: "asc" });
    return {
      libraries: (t.data ?? []).map((l) => ({
        id: l.section_id,
        name: l.section_name ?? `Library ${l.section_id}`,
        type: l.section_type,
        items: Number(l.count ?? 0),
        seasonsOrAlbums:
          l.parent_count != null && l.section_type !== "movie" ? Number(l.parent_count) : undefined,
        episodesOrTracks:
          l.child_count != null && l.section_type !== "movie" ? Number(l.child_count) : undefined,
        plays: l.plays ?? 0,
        hours: Math.round(((l.duration ?? 0) / 3600) * 10) / 10,
        lastPlayed: l.last_played ?? undefined,
        lastAt: at(l.last_accessed),
        keepHistory: l.keep_history !== 0,
      })),
    };
  }
  if (view === "graphs") {
    const days = [7, 30, 90].includes(Number(q.days)) ? Number(q.days) : 30;
    const d = await read<{ categories?: string[]; series?: { name: string; data: number[] }[] }>(
      "get_plays_by_date",
      { time_range: days },
    );
    return { days, dates: d.categories ?? [], series: d.series ?? [] };
  }
  // logs: newest first.
  const lines = await read<{ time?: string; loglevel?: string; msg?: string }[]>("get_logs", {
    start: 0,
    end: 300,
  });
  return {
    lines: lines.map((l) => ({
      at: l.time?.trim(),
      level: l.loglevel,
      text: scrubTautulli(l.msg ?? ""),
    })),
  };
}
