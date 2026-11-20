import type { ArrHistoryEvent, DownloadTrail, DownloadTrailStep } from "@dragon-control/core";

/**
 * Download trails for Radarr, Sonarr, Chaptarr, and Lidarr panels (10-26: "what folder it
 * was in, then it gets renamed, then it moves to the new folder"). Built only from what the app
 * itself reports: its history (grabbed, imported with the path it took the file from and the
 * path it put it at, renamed with the path before and after, failed) and its queue (what is
 * downloading now and where the download client is putting it). Events are tied together by the
 * download client's id, the same way the apps tie them.
 */

/** The queue fields a trail uses (Sonarr and Radarr, and Chaptarr and Lidarr, both map here). */
export interface TrailQueueItem {
  downloadId?: string;
  title: string;
  release?: string;
  /** downloading, importPending, importBlocked, importing, failedPending... */
  state?: string;
  progressPct?: number;
  timeLeft?: string;
  client?: string;
  outputPath?: string;
  problem?: string;
  failed?: boolean;
  stuck?: boolean;
}

const MAX = 20;
/** A grab this old that is in no queue and imported nothing has left. */
const GONE_MS = 15 * 60_000;

const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "") || p;

/** Several imported files from one download (an album, a season pack): one step for all. */
function importStep(events: ArrHistoryEvent[], app: string): DownloadTrailStep {
  const first = events[events.length - 1]!;
  const many = events.length > 1;
  return {
    kind: "imported",
    ...(events[0]!.at ? { at: events[0]!.at } : {}),
    text: many
      ? `${app} imported ${events.length} files, renamed into the library`
      : `${app} imported it, renamed into the library`,
    ...(first.droppedPath ? { from: many ? folderOf(first.droppedPath) : first.droppedPath } : {}),
    ...(first.importedPath ? { to: many ? folderOf(first.importedPath) : first.importedPath } : {}),
  };
}

export function downloadTrails(
  app: string,
  history: ArrHistoryEvent[],
  queue: TrailQueueItem[],
  now = Date.now(),
): DownloadTrail[] {
  const groups = new Map<string, ArrHistoryEvent[]>();
  const trails: DownloadTrail[] = [];
  for (const h of history) {
    if (h.event === "renamed") {
      trails.push({
        key: `renamed:${h.title}:${h.at ?? ""}:${h.renamedTo ?? ""}`,
        title: h.title,
        status: "renamed",
        ...(h.at ? { updatedAt: h.at } : {}),
        steps: [
          {
            kind: "renamed",
            ...(h.at ? { at: h.at } : {}),
            text: `${app} renamed the file`,
            ...(h.renamedFrom ? { from: h.renamedFrom } : {}),
            ...(h.renamedTo ? { to: h.renamedTo } : {}),
          },
        ],
      });
      continue;
    }
    if (!h.downloadId || !["grabbed", "imported", "failed", "ignored"].includes(h.event)) continue;
    const id = h.downloadId.toLowerCase();
    groups.set(id, [...(groups.get(id) ?? []), h]);
  }
  const queued = new Map(
    queue.filter((q) => q.downloadId).map((q) => [q.downloadId!.toLowerCase(), q] as const),
  );
  for (const id of new Set([...groups.keys(), ...queued.keys()])) {
    // History comes newest first; steps read oldest first.
    const events = [...(groups.get(id) ?? [])].sort((a, b) =>
      (a.at ?? "").localeCompare(b.at ?? ""),
    );
    const q = queued.get(id);
    const grab = events.find((e) => e.event === "grabbed");
    const imports = events.filter((e) => e.event === "imported").reverse();
    const fail = events.filter((e) => e.event === "failed" || e.event === "ignored").pop();
    const steps: DownloadTrailStep[] = [];
    if (grab)
      steps.push({
        kind: "grabbed",
        ...(grab.at ? { at: grab.at } : {}),
        text: [
          `${app} grabbed it`,
          grab.indexer ? `from ${grab.indexer}` : "",
          grab.client ? `and sent it to ${grab.client}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
    if (q && !imports.length) {
      const state = q.state ?? "";
      const where = q.outputPath ? { to: q.outputPath } : {};
      if (q.failed || /failed/i.test(state))
        steps.push({
          kind: "failed",
          text: `The download failed${q.problem ? `: ${q.problem}` : ""}`,
          ...where,
        });
      else if (q.stuck || /blocked/i.test(state))
        steps.push({
          kind: "stuck",
          text: `Downloaded, but ${app} has not imported it${q.problem ? `: ${q.problem}` : ""}`,
          ...where,
        });
      else if (/importPending|importing/i.test(state))
        steps.push({
          kind: "importing",
          text: `Downloaded. ${app} is importing it from the download folder`,
          ...where,
        });
      else
        steps.push({
          kind: "downloading",
          text: [
            `Downloading${q.client ? ` in ${q.client}` : ""}`,
            q.progressPct !== undefined ? `${q.progressPct}%` : "",
            q.timeLeft ? `${q.timeLeft} left` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          ...(q.progressPct !== undefined ? { progressPct: q.progressPct } : {}),
          ...where,
        });
    }
    if (imports.length) steps.push(importStep(imports, app));
    else if (fail && !q)
      steps.push({
        kind: "failed",
        ...(fail.at ? { at: fail.at } : {}),
        text: `${fail.event === "ignored" ? "Ignored" : "Failed"}${fail.message ? `: ${fail.message}` : ""}`,
      });
    else if (grab && !q && now - Date.parse(grab.at ?? "") > GONE_MS)
      // Grabbed, then gone from the queue with nothing imported (removed, or replaced by
      // another grab), so it does not read as still on its way.
      steps.push({
        kind: "failed",
        text: `Left the queue without anything being imported (removed, or replaced by another grab)`,
      });
    if (!steps.length) continue;
    const last = steps[steps.length - 1]!;
    const status: DownloadTrail["status"] = last.kind;
    const newest = [...events].reverse().find((e) => e.at)?.at;
    trails.push({
      key: id,
      title: grab?.title ?? events[0]?.title ?? q?.title ?? "A download",
      ...((grab?.release ?? q?.release) ? { release: grab?.release ?? q?.release } : {}),
      status,
      // What is in the queue now is the newest thing there is.
      ...(q ? { updatedAt: new Date(now).toISOString() } : newest ? { updatedAt: newest } : {}),
      steps,
    });
  }
  return trails.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, MAX);
}
