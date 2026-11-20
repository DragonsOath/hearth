import type { AppActivity, AppIssue, AppQueueItem, AppReport } from "@dragon-control/core";
import {
  AppKeyError,
  AppUnreachableError,
  getJson,
  joinUrl,
  mb,
  TIMEOUT_MS,
  worst,
  type Fetch,
} from "./http";

/**
 * Readers for more apps (10-12, application-aware panels batch 1), read only, in the same
 * report shape as the others: version, the app's own health, a few facts that say what it is
 * doing, its queue or current work, recent activity, and its connections. Each needs its own key
 * from the Secure Vault (Find my keys imports the ones in the apps' settings files). Keys never
 * appear in errors or reports; Tautulli takes its key in the query string, like SABnzbd.
 */

type Report = Omit<AppReport, "serviceId" | "checkedAt">;

const when = (v?: string | number) => {
  if (v === undefined || v === null || v === "") return undefined;
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- Lidarr and Chaptarr (the *arr v1 API) ---------- */

interface V1Queue {
  id?: number;
  bookId?: number;
  albumId?: number;
  outputPath?: string;
  title?: string;
  status?: string;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  downloadClient?: string;
  errorMessage?: string;
  statusMessages?: { messages?: string[] }[];
  artist?: { artistName?: string };
  album?: { title?: string };
  author?: { authorName?: string };
  book?: { title?: string };
}

export async function readArrV1(
  app: "lidarr" | "chaptarr",
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Report> {
  const name = app === "lidarr" ? "Lidarr" : "Chaptarr";
  const include =
    app === "lidarr"
      ? "includeArtist=true&includeAlbum=true"
      : "includeAuthor=true&includeBook=true";
  const get = <T>(path: string) => getJson<T>(fetchImpl, name, base, path, key);
  const [status, health, queue, missing, history, clients] = await Promise.all([
    get<{ version?: string }>("/api/v1/system/status"),
    get<{ type?: string; message?: string; source?: string; wikiUrl?: string }[]>("/api/v1/health"),
    get<{ totalRecords?: number; records?: V1Queue[] }>(
      `/api/v1/queue?page=1&pageSize=25&${include}`,
    ),
    get<{ totalRecords?: number }>("/api/v1/wanted/missing?page=1&pageSize=1&monitored=true").catch(
      () => ({ totalRecords: undefined }),
    ),
    get<{ records?: { date?: string; eventType?: string; sourceTitle?: string }[] }>(
      "/api/v1/history?page=1&pageSize=10&sortKey=date&sortDirection=descending",
    ).catch(() => ({ records: [] })),
    get<{ name?: string; enable?: boolean }[]>("/api/v1/downloadclient").catch(() => []),
  ]);
  const issues: AppIssue[] = (health ?? []).map((h, i) => ({
    level: h.type === "error" ? "error" : "warning",
    key: `health:${h.source ?? i}`,
    text: h.message ?? "A health warning",
    ...(h.wikiUrl ? { link: h.wikiUrl } : {}),
  }));
  const records = queue.records ?? [];
  const stuck = records.filter((r) => r.trackedDownloadStatus && r.trackedDownloadStatus !== "ok");
  const items: AppQueueItem[] = records.map((r) => {
    const what =
      app === "lidarr"
        ? [r.artist?.artistName, r.album?.title].filter(Boolean).join(" - ")
        : [r.author?.authorName, r.book?.title].filter(Boolean).join(" - ");
    const problem =
      r.errorMessage ||
      [...new Set((r.statusMessages ?? []).flatMap((m) => m.messages ?? []))].join("; ") ||
      undefined;
    return {
      title: what || r.title || "Unknown",
      status: r.trackedDownloadState ?? r.status ?? "In the queue",
      ...(r.size ? { progressPct: Math.round(((r.size - (r.sizeleft ?? 0)) / r.size) * 100) } : {}),
      ...(mb(r.size) !== undefined ? { sizeMb: mb(r.size) } : {}),
      ...(r.timeleft ? { timeLeft: r.timeleft } : {}),
      ...(problem && r.trackedDownloadStatus !== "ok" ? { problem } : {}),
      ...(r.downloadClient ? { via: r.downloadClient } : {}),
      // What a plan step on it needs (Ember could not act on a stuck import without these).
      ...(r.id !== undefined ? { queueId: r.id } : {}),
      ...(r.title ? { release: r.title } : {}),
      ...((app === "lidarr" ? r.albumId : r.bookId) !== undefined
        ? { itemId: (app === "lidarr" ? r.albumId : r.bookId)! }
        : {}),
      ...(r.outputPath ? { path: r.outputPath } : {}),
    };
  });
  const activity: AppActivity[] = (history.records ?? []).map((h) => ({
    at: when(h.date),
    text: `${(h.eventType ?? "event").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}: ${h.sourceTitle ?? ""}`.trim(),
    tone: /fail/i.test(h.eventType ?? "")
      ? "error"
      : /import/i.test(h.eventType ?? "")
        ? "good"
        : undefined,
  }));
  return {
    app,
    version: status.version,
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Missing (monitored)",
        value: missing.totalRecords === undefined ? "Not reported" : String(missing.totalRecords),
      },
      {
        label: "Queue",
        value: `${queue.totalRecords ?? records.length}${stuck.length ? ` (${stuck.length} need attention)` : ""}`,
      },
      {
        label: "Download clients",
        value: clients.length
          ? clients.map((c) => `${c.name}${c.enable === false ? " (off)" : ""}`).join(", ")
          : "None",
      },
    ],
    queue: items,
    queueTotal: queue.totalRecords ?? records.length,
    activity,
    connections: clients.map((c) => ({
      name: c.name ?? "Download client",
      ok: c.enable !== false,
      detail: c.enable === false ? "Turned off" : "On",
    })),
  };
}

/* ---------- Bazarr ---------- */

export async function readBazarr(base: string, key: string, fetchImpl: Fetch): Promise<Report> {
  const get = async <T>(path: string): Promise<T> => {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await fetchImpl(joinUrl(base, path), {
        headers: { "X-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `Bazarr did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new AppKeyError("Bazarr refused the API key. Check the key in the vault.");
    if (!res.ok)
      throw new AppUnreachableError(`Bazarr answered ${res.status} for ${path.split("?")[0]}.`);
    return (await res.json()) as T;
  };
  const [status, health, badges, providers, tasks, episodes, movies] = await Promise.all([
    get<{ data?: { bazarr_version?: string } }>("/api/system/status"),
    get<{ data?: { object?: string; issue?: string }[] }>("/api/system/health").catch(() => ({
      data: [],
    })),
    get<{
      episodes?: number;
      movies?: number;
      providers?: number;
      sonarr_signalr?: string;
      radarr_signalr?: string;
    }>("/api/badges"),
    get<{ data?: { name?: string; status?: string; retry?: string }[] }>("/api/providers").catch(
      () => ({ data: [] }),
    ),
    get<{ data?: { name?: string; job_running?: boolean; next_run_in?: string }[] }>(
      "/api/system/tasks",
    ).catch(() => ({ data: [] })),
    get<{
      data?: {
        seriesTitle?: string;
        episode_number?: string;
        description?: string;
        timestamp?: string;
        parsed_timestamp?: string;
      }[];
    }>("/api/episodes/history?start=0&length=6").catch(() => ({ data: [] })),
    get<{
      data?: {
        title?: string;
        description?: string;
        timestamp?: string;
        parsed_timestamp?: string;
      }[];
    }>("/api/movies/history?start=0&length=6").catch(() => ({ data: [] })),
  ]);
  const issues: AppIssue[] = (health.data ?? []).map((h, i) => ({
    level: "warning",
    key: `health:${h.object ?? i}`,
    text: `${h.object ? `${h.object}: ` : ""}${h.issue ?? "a problem"}`,
  }));
  const throttled = (providers.data ?? []).filter((p) => p.status && !/^good$/i.test(p.status));
  if (throttled.length)
    issues.push({
      level: "warning",
      key: "providers:throttled",
      text: `${plural(throttled.length, "subtitle provider")} paused: ${throttled.map((p) => `${p.name} (${p.status}${p.retry ? `, retry ${p.retry}` : ""})`).join(", ")}.`,
    });
  const running = (tasks.data ?? []).filter((t) => t.job_running);
  return {
    app: "bazarr",
    version: status.data?.bazarr_version,
    status: worst(issues),
    issues,
    facts: [
      { label: "Episodes missing subtitles", value: String(badges.episodes ?? 0) },
      { label: "Movies missing subtitles", value: String(badges.movies ?? 0) },
      { label: "Providers paused", value: String(badges.providers ?? throttled.length) },
      ...(running.length
        ? [{ label: "Working on", value: running.map((t) => t.name).join(", ") }]
        : []),
    ],
    queue: running.map((t) => ({ title: t.name ?? "Task", status: "Running" })),
    activity: [
      ...(episodes.data ?? []).map((h) => ({
        at: when(h.parsed_timestamp ?? h.timestamp),
        text: `${h.seriesTitle ?? ""} ${h.episode_number ?? ""}: ${h.description ?? ""}`.trim(),
      })),
      ...(movies.data ?? []).map((h) => ({
        at: when(h.parsed_timestamp ?? h.timestamp),
        text: `${h.title ?? ""}: ${h.description ?? ""}`.trim(),
      })),
    ]
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .slice(0, 10),
    connections: [
      ...(["sonarr", "radarr"] as const).map((a) => {
        const live = a === "sonarr" ? badges.sonarr_signalr : badges.radarr_signalr;
        return {
          name: a === "sonarr" ? "Sonarr" : "Radarr",
          ok: live === undefined || live === "LIVE",
          detail:
            live === undefined
              ? "Not reported"
              : live === "LIVE"
                ? "Connected, live updates"
                : `Live updates ${live.toLowerCase()}`,
        };
      }),
    ],
  };
}

/* ---------- Tautulli ---------- */

export async function readTautulli(base: string, key: string, fetchImpl: Fetch): Promise<Report> {
  const cmd = async <T>(c: string): Promise<T> => {
    const url = joinUrl(base, `/api/v2?apikey=${encodeURIComponent(key)}&cmd=${c}`);
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message.replaceAll(key, "[hidden]") : "no answer";
      throw new AppUnreachableError(`Tautulli did not answer at ${base}: ${why}`);
    }
    if (res.status === 401 || res.status === 403)
      throw new AppKeyError("Tautulli refused the API key. Check the key in the vault.");
    if (!res.ok)
      throw new AppUnreachableError(`Tautulli answered ${res.status} for ${c.split("&")[0]}.`);
    const body = (await res.json()) as {
      response?: { result?: string; message?: string; data?: T };
    };
    if (body.response?.result !== "success") {
      if (/api ?key/i.test(body.response?.message ?? ""))
        throw new AppKeyError("Tautulli refused the API key. Check the key in the vault.");
      throw new AppUnreachableError(`Tautulli said: ${body.response?.message ?? "an error"}.`);
    }
    return body.response.data as T;
  };
  type Session = {
    friendly_name?: string;
    full_title?: string;
    player?: string;
    transcode_decision?: string;
    progress_percent?: string;
    state?: string;
    stream_video_full_resolution?: string;
    quality_profile?: string;
  };
  const [info, activity, server, history, stats] = await Promise.all([
    cmd<{ tautulli_version?: string }>("get_tautulli_info"),
    cmd<{
      stream_count?: string | number;
      stream_count_transcode?: number;
      stream_count_direct_play?: number;
      stream_count_direct_stream?: number;
      total_bandwidth?: number;
      sessions?: Session[];
    }>("get_activity"),
    cmd<{ connected?: boolean }>("server_status").catch(() => ({ connected: undefined })),
    cmd<{
      data?: {
        date?: number;
        friendly_name?: string;
        full_title?: string;
        watched_status?: number;
      }[];
    }>("get_history&length=10").catch(() => ({ data: [] })),
    cmd<
      {
        stat_id?: string;
        rows?: { title?: string; friendly_name?: string; total_plays?: number }[];
      }[]
    >("get_home_stats&time_range=7&stats_count=3").catch(() => []),
  ]);
  const issues: AppIssue[] = [];
  if (server.connected === false)
    issues.push({
      level: "error",
      key: "plex",
      text: "Tautulli has lost its connection to Plex, so it is not recording plays.",
    });
  const sessions = activity.sessions ?? [];
  const top = (id: string) =>
    (stats.find((s) => s.stat_id === id)?.rows ?? [])
      .slice(0, 3)
      .map((r) => `${r.title ?? r.friendly_name} (${r.total_plays ?? 0})`)
      .join(", ");
  return {
    app: "tautulli",
    version: info.tautulli_version?.replace(/^v/, ""),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Streams now",
        value: `${Number(activity.stream_count ?? 0)}${activity.stream_count_transcode ? ` (${activity.stream_count_transcode} transcoding)` : ""}`,
      },
      { label: "Bandwidth", value: `${((activity.total_bandwidth ?? 0) / 1000).toFixed(1)} Mbps` },
      ...(top("top_users") ? [{ label: "Most active, 7 days", value: top("top_users") }] : []),
      ...(top("top_movies") ? [{ label: "Top movies, 7 days", value: top("top_movies") }] : []),
      ...(top("top_tv") ? [{ label: "Top shows, 7 days", value: top("top_tv") }] : []),
    ],
    queue: sessions.map((s) => ({
      title: `${s.friendly_name ?? "Someone"}: ${s.full_title ?? "something"}`,
      status: `${s.state ?? "playing"}, ${s.transcode_decision === "transcode" ? "transcoding" : (s.transcode_decision ?? "direct play").replace("copy", "direct stream")}${s.stream_video_full_resolution ? `, ${s.stream_video_full_resolution}` : ""}`,
      ...(s.progress_percent ? { progressPct: Number(s.progress_percent) } : {}),
      ...(s.player ? { via: s.player } : {}),
    })),
    queueTotal: sessions.length,
    activity: (history.data ?? []).map((h) => ({
      at: when(h.date),
      text: `${h.friendly_name ?? "Someone"} ${h.watched_status === 1 ? "watched" : "played some of"} ${h.full_title ?? "something"}`,
    })),
    connections: [
      {
        name: "Plex",
        ok: server.connected !== false,
        detail:
          server.connected === undefined
            ? "Not reported"
            : server.connected
              ? "Connected"
              : "Not connected",
      },
    ],
  };
}

/* ---------- Overseerr, Jellyseerr, Seerr ---------- */

export async function readSeerr(
  base: string,
  key: string,
  fetchImpl: Fetch,
  name = "Seerr",
): Promise<Report> {
  const get = <T>(path: string) => getJson<T>(fetchImpl, name, base, path, key);
  type Req = {
    id: number;
    status?: number;
    type?: string;
    createdAt?: string;
    requestedBy?: { displayName?: string };
    media?: { tmdbId?: number; status?: number };
  };
  const [status, counts, issues, pending, recent] = await Promise.all([
    get<{ version?: string; updateAvailable?: boolean; restartRequired?: boolean }>(
      "/api/v1/status",
    ),
    get<{
      total?: number;
      pending?: number;
      approved?: number;
      processing?: number;
      available?: number;
      declined?: number;
    }>("/api/v1/request/count"),
    get<{ open?: number; total?: number }>("/api/v1/issue/count").catch(() => ({
      open: undefined,
    })),
    get<{ results?: Req[]; pageInfo?: { results?: number } }>(
      "/api/v1/request?take=8&sort=added&filter=pending",
    ),
    get<{ results?: Req[] }>("/api/v1/request?take=8&sort=modified&filter=all").catch(() => ({
      results: [],
    })),
  ]);
  const titles = new Map<string, string>();
  await Promise.all(
    [...(pending.results ?? []), ...(recent.results ?? [])].slice(0, 12).map(async (r) => {
      const id = r.media?.tmdbId;
      if (!id) return;
      const k = `${r.type}:${id}`;
      if (titles.has(k)) return;
      const m = await get<{
        title?: string;
        name?: string;
        releaseDate?: string;
        firstAirDate?: string;
      }>(`/api/v1/${r.type === "tv" ? "tv" : "movie"}/${id}`).catch(() => undefined);
      if (m)
        titles.set(
          k,
          `${m.title ?? m.name}${(m.releaseDate ?? m.firstAirDate) ? ` (${(m.releaseDate ?? m.firstAirDate)!.slice(0, 4)})` : ""}`,
        );
    }),
  );
  const titleOf = (r: Req) =>
    titles.get(`${r.type}:${r.media?.tmdbId}`) ??
    `${r.type === "tv" ? "A show" : "A movie"} (TMDB ${r.media?.tmdbId ?? "?"})`;
  const STATE = ["", "Waiting for approval", "Approved", "Declined", "Failed", "Completed"];
  const MEDIA = [
    "",
    "Unknown",
    "Waiting for approval",
    "Being downloaded",
    "Partly available",
    "Available",
    "Deleted",
  ];
  const problems: AppIssue[] = [];
  if (status.restartRequired)
    problems.push({
      level: "warning",
      key: "restart",
      text: `${name} asks to be restarted to apply a setting.`,
    });
  return {
    app: "seerr",
    version: status.version,
    status: worst(problems),
    issues: problems,
    facts: [
      { label: "Waiting for approval", value: String(counts.pending ?? 0) },
      { label: "Being downloaded", value: String(counts.processing ?? 0) },
      { label: "Available", value: String(counts.available ?? 0) },
      ...(issues.open !== undefined ? [{ label: "Open issues", value: String(issues.open) }] : []),
      ...(status.updateAvailable ? [{ label: "Update", value: "Available" }] : []),
    ],
    queue: (pending.results ?? []).map((r) => ({
      title: titleOf(r),
      status: STATE[r.status ?? 1] ?? "Waiting for approval",
      ...(r.requestedBy?.displayName ? { via: `requested by ${r.requestedBy.displayName}` } : {}),
    })),
    queueTotal: counts.pending ?? pending.results?.length ?? 0,
    activity: (recent.results ?? []).map((r) => ({
      at: when(r.createdAt),
      text: `${titleOf(r)}: ${STATE[r.status ?? 0] ?? "requested"}${r.media?.status ? `, ${MEDIA[r.media.status]?.toLowerCase()}` : ""}${r.requestedBy?.displayName ? ` (${r.requestedBy.displayName})` : ""}`,
      ...(r.status === 4
        ? { tone: "error" as const }
        : r.media?.status === 5
          ? { tone: "good" as const }
          : {}),
    })),
    connections: [],
  };
}

/* ---------- Syncthing ---------- */

export async function readSyncthing(base: string, key: string, fetchImpl: Fetch): Promise<Report> {
  const get = async <T>(path: string): Promise<T> => {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await fetchImpl(joinUrl(base, path), {
        headers: { "X-API-Key": key, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `Syncthing did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (res.status === 401 || res.status === 403)
      throw new AppKeyError("Syncthing refused the API key. Check the key in the vault.");
    if (!res.ok)
      throw new AppUnreachableError(`Syncthing answered ${res.status} for ${path.split("?")[0]}.`);
    return (await res.json()) as T;
  };
  const [version, folders, devices, conns, errors] = await Promise.all([
    get<{ version?: string }>("/rest/system/version"),
    get<{ id: string; label?: string; paused?: boolean }[]>("/rest/config/folders"),
    get<{ deviceID: string; name?: string; paused?: boolean }[]>("/rest/config/devices"),
    get<{ connections?: Record<string, { connected?: boolean; paused?: boolean }> }>(
      "/rest/system/connections",
    ),
    get<{ errors?: { when?: string; message?: string }[] | null }>("/rest/system/error").catch(
      () => ({ errors: [] }),
    ),
  ]);
  const states = await Promise.all(
    folders.slice(0, 20).map(async (f) => ({
      f,
      s: await get<{
        state?: string;
        needBytes?: number;
        needFiles?: number;
        errors?: number;
        pullErrors?: number;
        globalBytes?: number;
      }>(`/rest/db/status?folder=${encodeURIComponent(f.id)}`).catch(() => undefined),
    })),
  );
  const issues: AppIssue[] = [];
  for (const { f, s } of states) {
    const errs = (s?.errors ?? 0) + (s?.pullErrors ?? 0);
    if (s?.state === "error" || errs)
      issues.push({
        level: "warning",
        key: `folder:${f.id}`,
        text: `Folder "${f.label || f.id}" has ${errs ? plural(errs, "file error") : "an error"}${s?.state === "error" ? " and stopped" : ""}.`,
      });
  }
  for (const e of errors.errors ?? [])
    issues.push({
      level: "warning",
      key: `error:${e.message?.slice(0, 40)}`,
      text: e.message ?? "An error",
      ...(when(e.when) ? { since: when(e.when) } : {}),
    });
  // This machine's own entry is in the device list but not in the connections.
  const others = devices.filter((d) => conns.connections?.[d.deviceID] !== undefined);
  const online = others.filter((d) => conns.connections?.[d.deviceID]?.connected);
  const syncing = states.filter(({ s }) => s?.state && /sync/.test(s.state));
  const need = states.reduce((n, { s }) => n + (s?.needBytes ?? 0), 0);
  return {
    app: "syncthing",
    version: version.version?.replace(/^v/, ""),
    status: worst(issues),
    issues,
    facts: [
      {
        label: "Folders",
        value: `${folders.length}${folders.some((f) => f.paused) ? ` (${folders.filter((f) => f.paused).length} paused)` : ""}`,
      },
      { label: "Devices online", value: `${online.length} of ${others.length}` },
      {
        label: "Syncing now",
        value: syncing.length
          ? `${plural(syncing.length, "folder")}, ${(need / 1024 ** 3).toFixed(2)} GB to go`
          : "Up to date",
      },
    ],
    queue: states
      .filter(({ s }) => s && (s.needBytes ?? 0) > 0)
      .map(({ f, s }) => ({
        title: f.label || f.id,
        status: s?.state ?? "unknown",
        ...(s?.globalBytes
          ? {
              progressPct: Math.round(((s.globalBytes - (s.needBytes ?? 0)) / s.globalBytes) * 100),
            }
          : {}),
        sizeMb: mb(s?.needBytes),
      })),
    activity: [],
    connections: others.map((d) => {
      const c = conns.connections?.[d.deviceID];
      return {
        name: d.name || d.deviceID.slice(0, 7),
        ok: Boolean(c?.connected) || Boolean(d.paused),
        detail: d.paused ? "Paused" : c?.connected ? "Connected" : "Not connected",
      };
    }),
  };
}
