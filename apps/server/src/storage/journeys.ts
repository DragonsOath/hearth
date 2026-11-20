import type {
  ArrDashboard,
  ArrHistoryEvent,
  ArrQueueItem,
  QbittorrentDashboard,
  SabnzbdDashboard,
  Torrent,
} from "@dragon-control/core";

/**
 * File journeys (spec section 8): download client, then Radarr or Sonarr, then the library
 * folder, then Plex. Built only from what each app reports: Radarr's and Sonarr's own history
 * (grabs; imports with the path they took the file from and the path they put it at; failures),
 * their queue (what is waiting and why), qBittorrent and SABnzbd (matched by the download id the
 * managers record), and later Plex (matched by the real file path, in center-service). Each step
 * says whether an app confirmed it or Hearth inferred it, and the journey says where it stopped.
 * A download still in /downloads after its import is seeding or a copy, never a failure.
 */

export type StepState = "done" | "now" | "waiting" | "failed" | "unknown" | "skipped";
export type StepKey = "grabbed" | "download" | "import" | "library" | "media";

export interface JourneyStep {
  key: StepKey;
  label: string;
  state: StepState;
  at?: string;
  evidence: "confirmed" | "inferred" | "none";
  source?: string;
  detail?: string;
}

export interface PathRef {
  /** As the app reports it (a path inside its container). */
  path: string;
  source: string;
  serviceId?: string;
  /** The same place on this machine, from that app's own mounts. */
  hostPath?: string;
  /** Where it is in the file manager. */
  open?: { rootId: string; folder: string; name: string };
}

export interface JourneyEvent {
  at?: string;
  text: string;
  evidence: "confirmed" | "inferred";
  source: string;
}

export type JourneyOutcome =
  | "in plex"
  | "imported"
  | "importing"
  | "waiting"
  | "blocked"
  | "failed"
  | "downloading"
  | "downloaded"
  | "queued";

export interface Journey {
  key: string;
  title: string;
  release?: string;
  /** Where it got to (the last step done, or the one it stopped at). */
  outcome: JourneyOutcome;
  /** Kept for the filters and the overview's chips. */
  stage: string;
  attention: boolean;
  problem?: string;
  /** The step it stopped at, when it did not finish. */
  stoppedAt?: string;
  steps: JourneyStep[];
  manager?: { app: string; serviceId: string };
  client?: { app: string; serviceId?: string; name?: string };
  /** The download, where the client put it. */
  source?: PathRef;
  /** Where the manager put it, renamed. */
  destination?: PathRef;
  paths: (PathRef & { where: string })[];
  progressPct?: number;
  sizeBytes?: number;
  timeLeft?: string;
  seeding?: boolean;
  startedAt?: string;
  updatedAt?: string;
  /** For repair actions on a stuck import (the manager's own queue item). */
  queueId?: number;
  downloadId?: string;
  /** A failed one that a later download of the same title got past (its journey key). */
  replacedBy?: { key: string; at?: string };
  events: JourneyEvent[];
}

const WINDOW_MS = 14 * 86_400_000;

const latest = (xs: ArrHistoryEvent[]) =>
  [...xs].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0];

export function buildJourneys(input: {
  managers: { serviceId: string; name: string; data: ArrDashboard }[];
  qbittorrent: { serviceId: string; name: string; data: QbittorrentDashboard }[];
  sabnzbd: { serviceId: string; name: string; data: SabnzbdDashboard }[];
  now?: number;
}): Journey[] {
  const now = input.now ?? Date.now();
  const torrents = new Map<string, { t: Torrent; serviceId: string; name: string }>(
    input.qbittorrent.flatMap((q) =>
      q.data.torrents.map(
        (t) => [t.hash.toLowerCase(), { t, serviceId: q.serviceId, name: q.name }] as const,
      ),
    ),
  );
  const sabHistory = new Map(
    input.sabnzbd.flatMap((s) =>
      s.data.history.map(
        (h) => [h.id.toLowerCase(), { h, serviceId: s.serviceId, name: s.name }] as const,
      ),
    ),
  );
  const sabQueue = new Map(
    input.sabnzbd.flatMap((s) =>
      s.data.queue.map(
        (q) => [q.id.toLowerCase(), { q, serviceId: s.serviceId, name: s.name }] as const,
      ),
    ),
  );
  const out: Journey[] = [];
  const tracked = new Set<string>();

  for (const m of input.managers) {
    const appName = m.data.app === "radarr" ? "Radarr" : "Sonarr";
    const byId = new Map<string, { history: ArrHistoryEvent[]; queue?: ArrQueueItem }>();
    for (const h of m.data.history ?? []) {
      if (!h.downloadId) continue;
      if (h.at && now - Date.parse(h.at) > WINDOW_MS) continue;
      if (!["grabbed", "imported", "failed", "ignored"].includes(h.event)) continue;
      const k = h.downloadId.toLowerCase();
      const g = byId.get(k) ?? { history: [] };
      g.history.push(h);
      byId.set(k, g);
    }
    for (const q of m.data.queue) {
      const k = (q.downloadId ?? `queue-${q.queueId}`).toLowerCase();
      const g = byId.get(k) ?? { history: [] };
      g.queue = q;
      byId.set(k, g);
    }
    for (const [id, g] of byId) {
      tracked.add(id);
      const grab = latest(g.history.filter((h) => h.event === "grabbed"));
      const imp = latest(g.history.filter((h) => h.event === "imported"));
      const fail = latest(g.history.filter((h) => h.event === "failed" || h.event === "ignored"));
      const q = g.queue;
      const tor = torrents.get(id);
      const sab = sabHistory.get(id) ?? undefined;
      const sabQ = sabQueue.get(id);
      const title = q?.title ?? imp?.title ?? grab?.title ?? fail?.title ?? "A download";
      const release = q?.release ?? grab?.release ?? imp?.release;
      const clientName = tor?.name ?? sab?.name ?? sabQ?.name ?? grab?.client ?? q?.client;
      const steps: JourneyStep[] = [];

      // 1. Grabbed
      steps.push(
        grab
          ? {
              key: "grabbed",
              label: "Grabbed",
              state: "done",
              ...(grab.at ? { at: grab.at } : {}),
              evidence: "confirmed",
              source: m.name,
              detail: [grab.release, grab.indexer ? `from ${grab.indexer}` : ""]
                .filter(Boolean)
                .join(" "),
            }
          : {
              key: "grabbed",
              label: "Grabbed",
              state: "done",
              evidence: "inferred",
              source: m.name,
              detail: `${appName} has it, so it was grabbed (the grab is older than its history shows).`,
            },
      );

      // 2. Download
      const downloadFailed = fail && !imp && /download/i.test(fail.message ?? "download");
      let download: JourneyStep;
      if (tor) {
        const done = tor.t.leftBytes === 0 || tor.t.progressPct >= 100;
        download = {
          key: "download",
          label: done ? "Downloaded" : "Downloading",
          state: done ? "done" : "now",
          ...(done && tor.t.completedAt ? { at: tor.t.completedAt } : {}),
          evidence: "confirmed",
          source: tor.name,
          detail: done
            ? tor.t.status === "seeding"
              ? `Finished; still seeding (ratio ${tor.t.ratio.toFixed(2)}).`
              : "Finished."
            : `${tor.t.progressPct}%${tor.t.etaSec ? `, about ${Math.round(tor.t.etaSec / 60)} min left` : ""}.`,
        };
      } else if (sabQ) {
        download = {
          key: "download",
          label: "Downloading",
          state: "now",
          evidence: "confirmed",
          source: sabQ.name,
          detail: `${sabQ.q.progressPct}%${sabQ.q.timeLeft ? `, ${sabQ.q.timeLeft} left` : ""}.`,
        };
      } else if (sab) {
        download = {
          key: "download",
          label: sab.h.failed ? "Download failed" : "Downloaded",
          state: sab.h.failed ? "failed" : "done",
          ...(sab.h.at ? { at: sab.h.at } : {}),
          evidence: "confirmed",
          source: sab.name,
          detail: sab.h.failed ? (sab.h.why ?? sab.h.status) : sab.h.status,
        };
      } else if (q && q.status !== "completed" && (q.progressPct ?? 0) < 100) {
        download = {
          key: "download",
          label: "Downloading",
          state: "now",
          evidence: "confirmed",
          source: m.name,
          detail: `${q.progressPct ?? 0}% as ${appName} reports it.`,
        };
      } else if (imp || q || (fail && !downloadFailed)) {
        download = {
          key: "download",
          label: "Downloaded",
          state: "done",
          evidence: "inferred",
          source: m.name,
          detail: imp
            ? `${appName} imported it, so the download finished (${clientName ?? "the client"} no longer lists it).`
            : q
              ? `${appName} reports it complete.`
              : `${appName} tried to import it, so the download finished.`,
        };
      } else if (downloadFailed) {
        download = {
          key: "download",
          label: "Download failed",
          state: "failed",
          ...(fail.at ? { at: fail.at } : {}),
          evidence: "confirmed",
          source: m.name,
          detail: fail.message ?? "The download failed.",
        };
      } else {
        download = {
          key: "download",
          label: "Download",
          state: "unknown",
          evidence: "none",
          detail: "No download client reports it now.",
        };
      }
      steps.push(download);

      // 3. Import
      let importStep: JourneyStep;
      const state = q?.state ?? "";
      if (imp) {
        importStep = {
          key: "import",
          label: "Imported",
          state: "done",
          ...(imp.at ? { at: imp.at } : {}),
          evidence: "confirmed",
          source: m.name,
          detail: "Renamed and put in the library folder.",
        };
      } else if (fail && !downloadFailed) {
        importStep = {
          key: "import",
          label: "Import failed",
          state: "failed",
          ...(fail.at ? { at: fail.at } : {}),
          evidence: "confirmed",
          source: m.name,
          detail: fail.message ?? "The import failed.",
        };
      } else if (
        state === "importBlocked" ||
        state === "importFailed" ||
        state === "failedPending"
      ) {
        importStep = {
          key: "import",
          label: "Import blocked",
          state: "failed",
          evidence: "confirmed",
          source: m.name,
          detail: q?.problem ?? `${appName} cannot import it.`,
        };
      } else if (state === "importing") {
        importStep = {
          key: "import",
          label: "Importing",
          state: "now",
          evidence: "confirmed",
          source: m.name,
        };
      } else if (state === "importPending" || (q && download.state === "done")) {
        importStep = {
          key: "import",
          label: "Awaiting import",
          state: "waiting",
          evidence: "confirmed",
          source: m.name,
          detail: q?.problem ?? `Downloaded; ${appName} has not imported it yet.`,
        };
      } else {
        importStep = {
          key: "import",
          label: "Import",
          state: download.state === "failed" ? "skipped" : "unknown",
          evidence: "none",
        };
      }
      steps.push(importStep);

      // 4. Library folder
      steps.push(
        imp?.importedPath
          ? {
              key: "library",
              label: "In the library folder",
              state: "done",
              ...(imp.at ? { at: imp.at } : {}),
              evidence: "confirmed",
              source: m.name,
            }
          : { key: "library", label: "In the library folder", state: "unknown", evidence: "none" },
      );
      // 5. Plex or Jellyfin: decided once the real paths are known (center-service).
      steps.push({
        key: "media",
        label: "In Plex",
        state: imp ? "unknown" : "skipped",
        evidence: "none",
        ...(imp ? { detail: "Checked against Plex once the path is known." } : {}),
      });

      const src = imp?.droppedPath ?? q?.outputPath ?? tor?.t.contentPath;
      const srcSource = imp?.droppedPath || q?.outputPath ? m.name : (tor?.name ?? m.name);
      const srcService = imp?.droppedPath || q?.outputPath ? m.serviceId : tor?.serviceId;
      const source: PathRef | undefined = src
        ? { path: src, source: srcSource, ...(srcService ? { serviceId: srcService } : {}) }
        : undefined;
      const destination: PathRef | undefined = imp?.importedPath
        ? { path: imp.importedPath, source: m.name, serviceId: m.serviceId }
        : undefined;
      const stop = steps.find((s) => s.state !== "done");
      const failed = steps.some((s) => s.state === "failed");
      const outcome: JourneyOutcome = failed
        ? importStep.label === "Import blocked"
          ? "blocked"
          : "failed"
        : imp
          ? "imported"
          : importStep.state === "now"
            ? "importing"
            : importStep.state === "waiting"
              ? "waiting"
              : download.state === "now"
                ? "downloading"
                : download.state === "done"
                  ? "downloaded"
                  : "queued";
      const times = [grab?.at, imp?.at, fail?.at, tor?.t.addedAt, tor?.t.completedAt]
        .filter((x): x is string => Boolean(x))
        .sort();
      out.push({
        key: `${m.serviceId}:${id}`,
        title,
        ...(release ? { release } : {}),
        outcome,
        stage: STAGE_WORD[outcome],
        attention: failed || Boolean(q?.stuckImport),
        ...((importStep.state === "failed" || download.state === "failed") &&
        (importStep.detail ?? download.detail)
          ? { problem: importStep.state === "failed" ? importStep.detail : download.detail }
          : q?.problem
            ? { problem: q.problem }
            : {}),
        ...(stop ? { stoppedAt: stop.label } : {}),
        steps,
        manager: { app: appName, serviceId: m.serviceId },
        ...(clientName || tor
          ? {
              client: {
                app: tor
                  ? "qBittorrent"
                  : sab || sabQ
                    ? "SABnzbd"
                    : (clientName ?? "a download client"),
                ...(tor ? { serviceId: tor.serviceId } : sab ? { serviceId: sab.serviceId } : {}),
                ...(clientName ? { name: clientName } : {}),
              },
            }
          : {}),
        ...(source ? { source } : {}),
        ...(destination ? { destination } : {}),
        paths: [
          ...(source ? [{ ...source, where: "Download" }] : []),
          ...(destination ? [{ ...destination, where: "Library" }] : []),
        ],
        ...(q?.progressPct !== undefined
          ? { progressPct: q.progressPct }
          : tor && tor.t.progressPct < 100
            ? { progressPct: tor.t.progressPct }
            : {}),
        ...(q?.sizeBytes !== undefined
          ? { sizeBytes: q.sizeBytes }
          : tor
            ? { sizeBytes: tor.t.sizeBytes }
            : {}),
        ...(q?.timeLeft ? { timeLeft: q.timeLeft } : {}),
        ...(tor ? { seeding: tor.t.status === "seeding" } : {}),
        ...(times[0] ? { startedAt: times[0] } : {}),
        ...(times.at(-1) ? { updatedAt: times.at(-1) } : {}),
        ...(q ? { queueId: q.queueId } : {}),
        ...(id.startsWith("queue-") ? {} : { downloadId: id }),
        events: steps
          .filter((s) => s.evidence !== "none")
          .map((s) => ({
            ...(s.at ? { at: s.at } : {}),
            text: `${s.label}${s.detail ? `: ${s.detail}` : ""}`,
            evidence: s.evidence === "confirmed" ? "confirmed" : "inferred",
            source: s.source ?? "Hearth",
          })),
      });
    }
  }

  // Finished downloads no manager tracks: imported earlier or not for them. Never "failed":
  // a download left in /downloads after its import is usually seeding or a copy.
  for (const [hash, { t, serviceId, name }] of torrents) {
    if (tracked.has(hash) || !t.completedAt || t.leftBytes > 0) continue;
    if (now - Date.parse(t.completedAt) > 3 * 86_400_000) continue;
    const steps: JourneyStep[] = [
      {
        key: "download",
        label: "Downloaded",
        state: "done",
        at: t.completedAt,
        evidence: "confirmed",
        source: name,
        detail: t.status === "seeding" ? "Finished; still seeding." : "Finished.",
      },
      {
        key: "import",
        label: "Import",
        state: "unknown",
        evidence: "inferred",
        source: "Hearth",
        detail:
          "Neither Radarr nor Sonarr has it in the last two weeks of history or its queue: it was not for them, or it is older.",
      },
    ];
    const source = t.contentPath ? { path: t.contentPath, source: name, serviceId } : undefined;
    out.push({
      key: `${serviceId}:${hash}`,
      title: t.name,
      outcome: "downloaded",
      stage: STAGE_WORD.downloaded,
      attention: false,
      steps,
      client: { app: "qBittorrent", serviceId, name },
      ...(source ? { source } : {}),
      paths: source ? [{ ...source, where: "Download" }] : [],
      sizeBytes: t.sizeBytes,
      seeding: t.status === "seeding",
      startedAt: t.addedAt ?? t.completedAt,
      updatedAt: t.completedAt,
      downloadId: hash,
      events: steps.map((s) => ({
        ...(s.at ? { at: s.at } : {}),
        text: `${s.label}${s.detail ? `: ${s.detail}` : ""}`,
        evidence: s.evidence === "confirmed" ? "confirmed" : "inferred",
        source: s.source ?? "Hearth",
      })),
    });
  }
  // SABnzbd failures no manager tracks.
  for (const [id, { h, serviceId, name }] of sabHistory) {
    if (tracked.has(id) || !h.failed) continue;
    const step: JourneyStep = {
      key: "download",
      label: "Download failed",
      state: "failed",
      ...(h.at ? { at: h.at } : {}),
      evidence: "confirmed",
      source: name,
      detail: h.why ?? h.status,
    };
    out.push({
      key: `${serviceId}:${id}`,
      title: h.name,
      outcome: "failed",
      stage: STAGE_WORD.failed,
      attention: true,
      ...(h.why ? { problem: h.why } : {}),
      stoppedAt: "Download",
      steps: [step],
      client: { app: "SABnzbd", serviceId, name },
      paths: [],
      ...(h.at ? { startedAt: h.at, updatedAt: h.at } : {}),
      events: [
        {
          ...(h.at ? { at: h.at } : {}),
          text: `${step.label}: ${step.detail}`,
          evidence: "confirmed",
          source: name,
        },
      ],
    });
  }

  // A failure that a later download of the same title got past is history, not a problem now:
  // it stays listed with what happened, but no longer asks for a look.
  for (const j of out) {
    if (!j.manager || (j.outcome !== "failed" && j.outcome !== "blocked")) continue;
    const later = out.find(
      (o) =>
        o !== j &&
        o.manager?.serviceId === j.manager!.serviceId &&
        o.title === j.title &&
        o.outcome === "imported" &&
        (o.updatedAt ?? "") > (j.updatedAt ?? ""),
    );
    if (!later) continue;
    j.attention = false;
    j.replacedBy = { key: later.key, ...(later.updatedAt ? { at: later.updatedAt } : {}) };
    j.stoppedAt = `${j.stoppedAt ?? "Failed"}; a later download was imported`;
  }

  const order: JourneyOutcome[] = [
    "blocked",
    "failed",
    "waiting",
    "importing",
    "downloading",
    "queued",
    "downloaded",
    "imported",
    "in plex",
  ];
  return out.sort(
    (a, b) =>
      Number(b.attention) - Number(a.attention) ||
      order.indexOf(a.outcome) - order.indexOf(b.outcome) ||
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
}

/** The words the panel's filters and chips use. */
export const STAGE_WORD: Record<JourneyOutcome, string> = {
  "in plex": "in plex",
  imported: "imported",
  importing: "importing",
  waiting: "awaiting import",
  blocked: "import blocked",
  failed: "failed",
  downloading: "downloading",
  downloaded: "downloaded",
  queued: "queued",
};

/** Plex's recently added files on this machine, to confirm the last step. */
export function markMedia(
  journeys: Journey[],
  plex: { name: string; connected: boolean; files: Map<string, string | undefined> } | undefined,
  now = Date.now(),
) {
  for (const j of journeys) {
    const step = j.steps.find((s) => s.key === "media");
    if (!step || step.state === "skipped") continue;
    const dest = j.destination?.hostPath;
    if (!plex) {
      Object.assign(step, { state: "skipped", detail: "No Plex or Jellyfin connected to Hearth." });
      continue;
    }
    if (!plex.connected) {
      Object.assign(step, { state: "unknown", detail: `${plex.name} could not be read just now.` });
      continue;
    }
    if (dest && plex.files.has(dest)) {
      const at = plex.files.get(dest);
      Object.assign(step, {
        label: `In ${plex.name}`,
        state: "done",
        evidence: "confirmed",
        source: plex.name,
        ...(at ? { at } : {}),
        detail: "Plex lists this exact file.",
      });
      j.outcome = "in plex";
      j.stage = STAGE_WORD["in plex"];
      j.events.push({
        ...(at ? { at } : {}),
        text: `In ${plex.name}`,
        evidence: "confirmed",
        source: plex.name,
      });
      continue;
    }
    const imported = j.steps.find((s) => s.key === "import")?.at;
    const fresh = imported && now - Date.parse(imported) < 30 * 60_000;
    Object.assign(step, {
      label: `In ${plex.name}`,
      state: fresh ? "waiting" : "unknown",
      evidence: "none",
      detail: dest
        ? fresh
          ? `Not in ${plex.name} yet; it usually scans new files within minutes.`
          : `Not among ${plex.name}'s 50 most recently added files. It may be older than that list, or ${plex.name} has not picked it up (check its library folders).`
        : "Hearth could not find this file on this machine to compare.",
    });
    if (!j.stoppedAt && step.state !== "done") j.stoppedAt = step.label;
  }
}
