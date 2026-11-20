import type { AppActivity, AppIssue, AppQueueItem, AppReport } from "@dragon-control/core";
import { getJson, mb, worst, type Fetch } from "./http";

/**
 * Radarr and Sonarr (API v3), read only: version, their own health messages,
 * the download queue with anything stuck or failing, recent history, and the
 * download clients they use. Only GET requests, with the API key from the vault.
 */

interface HealthItem {
  source?: string;
  type?: string;
  message?: string;
  wikiUrl?: string;
}
interface QueueRecord {
  id: number;
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  errorMessage?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  downloadClient?: string;
  indexer?: string;
  movie?: { title?: string; year?: number };
  series?: { title?: string };
  episode?: { seasonNumber?: number; episodeNumber?: number; title?: string };
}
interface HistoryRecord {
  date?: string;
  eventType?: string;
  sourceTitle?: string;
  movie?: { title?: string };
  series?: { title?: string };
}
/** A history record with the ids the loop check groups by. */
interface SinceRecord extends HistoryRecord {
  movieId?: number;
  episodeId?: number;
  seriesId?: number;
  data?: { reason?: string };
  movie?: { title?: string; year?: number };
  episode?: { seasonNumber?: number; episodeNumber?: number; title?: string };
}

/** Days of history the re-grab check looks at. */
/**
 * "Notifications unavailable due to failures: X" in plain words (11-13: a Discord webhook deleted
 * in Discord left Radarr and Sonarr warning): which connection, the likely cause, and the fix.
 */
export function notificationsDown(app: string, message: string | undefined): string {
  const names = (message ?? "").split(/failures?:\s*/i)[1]?.trim();
  const which = names ? `"${names}"` : "a notification connection";
  return `${app} can't send through ${which} (Settings, Connect), so its own messages stop there. A Discord webhook that was deleted in Discord causes this. Hearth already announces new arrivals through your destinations, so you can remove that connection, or point it at a new webhook. Ask Ember to plan either.`;
}

export const LOOP_DAYS = 7;

/**
 * Re-grab loops (feature request 18: caught without being asked): the same movie or episode
 * grabbed again and again. A loop is 3 or more grabs within LOOP_DAYS, or 2 or more grabs of
 * something already imported in that time (each replacing a file on disk). Normal one-off
 * upgrades do not count.
 */
export function regrabLoops(
  app: "radarr" | "sonarr",
  records: SinceRecord[],
): {
  key: string;
  title: string;
  grabs: number;
  regrabs: number;
  upgrades: number;
  itemId: number;
}[] {
  const byItem = new Map<number, SinceRecord[]>();
  for (const r of records) {
    const id = app === "radarr" ? r.movieId : r.episodeId;
    if (id === undefined) continue;
    byItem.set(id, [...(byItem.get(id) ?? []), r]);
  }
  const loops = [];
  for (const [id, list] of byItem) {
    const sorted = [...list].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let imported = false;
    let grabs = 0;
    let regrabs = 0;
    let upgrades = 0;
    // A grab whose download then failed is a retry of a missing item (backfilling), not a
    // re-grab: only grabs that went through count.
    const failed = (i: number) => {
      for (let j = i + 1; j < sorted.length; j++) {
        const ev = sorted[j]!.eventType ?? "";
        if (ev === "downloadFailed") return true;
        if (ev === "grabbed" || /Imported$/.test(ev)) return false;
      }
      return false;
    };
    sorted.forEach((r, i) => {
      if (r.eventType === "grabbed") {
        if (failed(i)) return;
        grabs++;
        if (imported) regrabs++;
      } else if (/Imported$/.test(r.eventType ?? "")) imported = true;
      else if (/FileDeleted$/.test(r.eventType ?? "") && r.data?.reason === "Upgrade") upgrades++;
    });
    if (grabs < 3 && regrabs < 2) continue;
    const any = sorted.find((r) => r.movie?.title || r.series?.title) ?? sorted[0]!;
    const e = any.episode;
    const title =
      app === "radarr"
        ? `${any.movie?.title ?? any.sourceTitle ?? `movie #${id}`}${any.movie?.year ? ` (${any.movie.year})` : ""}`
        : `${any.series?.title ?? "a series"}${e?.seasonNumber !== undefined && e.episodeNumber !== undefined ? ` S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}` : ""}`;
    loops.push({ key: `regrab:${id}`, title, grabs, regrabs, upgrades, itemId: id });
  }
  return loops;
}

interface DownloadClient {
  name: string;
  enable?: boolean;
  protocol?: string;
}

const STATE: Record<string, string> = {
  downloading: "Downloading",
  importPending: "Import pending",
  importBlocked: "Import blocked",
  importing: "Importing",
  imported: "Imported",
  failedPending: "Failed, waiting",
  failed: "Failed",
  ignored: "Ignored",
};

const EVENT: Record<string, { text: string; tone?: AppActivity["tone"] }> = {
  grabbed: { text: "Grabbed" },
  downloadFolderImported: { text: "Imported", tone: "good" },
  episodeFileImported: { text: "Imported", tone: "good" },
  movieFileImported: { text: "Imported", tone: "good" },
  downloadFailed: { text: "Download failed", tone: "error" },
  importFailed: { text: "Import failed", tone: "error" },
  downloadIgnored: { text: "Ignored", tone: "warning" },
  movieFileDeleted: { text: "File deleted" },
  episodeFileDeleted: { text: "File deleted" },
  movieFileRenamed: { text: "Renamed" },
  episodeFileRenamed: { text: "Renamed" },
};

function titleOf(r: QueueRecord, app: "radarr" | "sonarr"): string {
  if (app === "radarr" && r.movie?.title) {
    return `${r.movie.title}${r.movie.year ? ` (${r.movie.year})` : ""}`;
  }
  if (app === "sonarr" && r.series?.title) {
    const e = r.episode;
    const se =
      e?.seasonNumber !== undefined && e.episodeNumber !== undefined
        ? ` S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`
        : "";
    return `${r.series.title}${se}`;
  }
  return r.title ?? "Unknown item";
}

export async function readArr(
  app: "radarr" | "sonarr",
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const name = app === "radarr" ? "Radarr" : "Sonarr";
  const include = app === "radarr" ? "includeMovie=true" : "includeSeries=true&includeEpisode=true";
  const [status, health, queue, history, clients] = await Promise.all([
    getJson<{ version?: string }>(fetchImpl, name, base, "/api/v3/system/status", key),
    getJson<HealthItem[]>(fetchImpl, name, base, "/api/v3/health", key),
    getJson<{ totalRecords?: number; records?: QueueRecord[] }>(
      fetchImpl,
      name,
      base,
      `/api/v3/queue?page=1&pageSize=25&${include}`,
      key,
    ),
    getJson<{ records?: HistoryRecord[] }>(
      fetchImpl,
      name,
      base,
      `/api/v3/history?page=1&pageSize=12&sortKey=date&sortDirection=descending&${app === "radarr" ? "includeMovie=true" : "includeSeries=true"}`,
      key,
    ),
    getJson<DownloadClient[]>(fetchImpl, name, base, "/api/v3/downloadclient", key),
  ]);
  // The last LOOP_DAYS of history, for re-grab loops (older versions without it: skipped).
  const since = new Date(Date.now() - LOOP_DAYS * 86_400_000).toISOString();
  const recent = await getJson<SinceRecord[]>(
    fetchImpl,
    name,
    base,
    `/api/v3/history/since?date=${encodeURIComponent(since)}&${include}`,
    key,
  ).catch(() => undefined);

  const issues: AppIssue[] = [];
  for (const h of health) {
    if (h.type !== "warning" && h.type !== "error") continue;
    issues.push({
      level: h.type === "error" ? "error" : "warning",
      key: `health:${h.source ?? "general"}`,
      text:
        h.source === "NotificationStatusCheck"
          ? notificationsDown(name, h.message)
          : (h.message ?? `${name} reports a problem.`),
      link: h.wikiUrl,
    });
  }

  // One problem per app, naming the titles, so the incident reads as what it is.
  const loops = Array.isArray(recent) ? regrabLoops(app, recent) : [];
  if (loops.length) {
    const words = (l: (typeof loops)[number]) =>
      `${l.title} (${l.grabs} grabs${l.regrabs ? `, ${l.regrabs} after it was already imported` : ""}${l.upgrades ? `, ${l.upgrades} ${l.upgrades === 1 ? "upgrade" : "upgrades"}` : ""})`;
    issues.push({
      level: "error",
      key: "regrab",
      text:
        loops.length === 1
          ? `${name} keeps grabbing ${words(loops[0]!)} in ${LOOP_DAYS} days. Each grab downloads it again and notifies you.`
          : `${name} keeps grabbing ${loops.length} titles again and again in ${LOOP_DAYS} days: ${loops
              .slice(0, 5)
              .map(words)
              .join(
                "; ",
              )}${loops.length > 5 ? "; ..." : ""}. Each grab downloads again and notifies you.`,
    });
  }

  const records = queue.records ?? [];
  const items: AppQueueItem[] = records.map((r) => {
    const problem =
      r.trackedDownloadStatus === "warning" || r.trackedDownloadStatus === "error"
        ? [r.errorMessage, ...(r.statusMessages ?? []).flatMap((m) => m.messages ?? [])]
            .filter(Boolean)
            .join(" ") || "Needs attention."
        : undefined;
    const state = r.trackedDownloadState ? STATE[r.trackedDownloadState] : undefined;
    const progressPct =
      r.size && r.sizeleft !== undefined
        ? Math.max(0, Math.min(100, Math.round(((r.size - r.sizeleft) / r.size) * 100)))
        : undefined;
    return {
      title: titleOf(r, app),
      status: state ?? (r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : "Queued"),
      ...(progressPct !== undefined ? { progressPct } : {}),
      ...(mb(r.size) !== undefined ? { sizeMb: mb(r.size) } : {}),
      ...(r.timeleft ? { timeLeft: r.timeleft } : {}),
      ...(problem ? { problem } : {}),
      ...(r.downloadClient ? { via: r.downloadClient } : {}),
    };
  });
  // Stuck items are worth knowing about, never an alarm on their own.
  const stuck = records.filter(
    (r) => r.trackedDownloadStatus === "warning" || r.trackedDownloadStatus === "error",
  );
  if (stuck.length) {
    issues.push({
      level: "warning",
      key: "queue:stuck",
      text: `${stuck.length} ${stuck.length === 1 ? "item" : "items"} in the queue ${stuck.length === 1 ? "needs" : "need"} attention.`,
    });
  }

  const activity: AppActivity[] = (history.records ?? []).map((h) => {
    const e = EVENT[h.eventType ?? ""] ?? { text: h.eventType ?? "Event" };
    const what = h.movie?.title ?? h.series?.title ?? h.sourceTitle ?? "";
    return {
      ...(h.date ? { at: h.date } : {}),
      text: what ? `${e.text}: ${what}` : e.text,
      ...(e.tone ? { tone: e.tone } : {}),
    };
  });

  // Download clients: configured and enabled; a health message about one marks it not ok.
  const clientTrouble = health
    .filter((h) => /downloadclient/i.test(h.source ?? ""))
    .map((h) => h.message ?? "");
  const connections = clients.map((c) => {
    const trouble = clientTrouble.find((m) => m.includes(c.name));
    return {
      name: `${c.name}${c.protocol ? ` (${c.protocol})` : ""}`,
      ok: c.enable !== false && !trouble,
      ...(c.enable === false
        ? { detail: "Switched off in " + name }
        : trouble
          ? { detail: trouble }
          : {}),
    };
  });

  return {
    app,
    version: status.version,
    status: worst(issues),
    issues,
    facts: [
      { label: "In the queue", value: String(queue.totalRecords ?? records.length) },
      { label: "Needing attention", value: String(stuck.length) },
      {
        label: "Download clients",
        value: String(clients.filter((c) => c.enable !== false).length),
      },
    ],
    queue: items,
    queueTotal: queue.totalRecords ?? records.length,
    activity,
    connections,
  };
}
