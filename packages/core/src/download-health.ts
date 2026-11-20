/**
 * Download Health, monitoring (the owner's design "Download Health: design for DC", 2026-11-07,
 * phase 2): downloads that are stuck or failing across qBittorrent, SABnzbd and the apps that grab
 * them (Sonarr, Radarr, Lidarr, Chaptarr), explained in plain words. Nothing is changed here.
 *
 * Strikes, not snap judgements: each check where a download looks broken gives it a strike; any
 * progress clears them. It needs the owner's attention only at the strike limit, over at least
 * the minimum time, which tells broken from slow. An outage of the client is never a strike.
 * When many downloads break at once, the cause is shared (a VPN, a disk, the client): it is
 * reported once instead of as many separate problems. The idea is borrowed from Cleanuparr's
 * design; no code.
 */

export type DownloadProblem =
  | "stalled"
  | "metadata"
  | "usenet-failed"
  | "import-failed"
  | "download-failed"
  | "storage"
  | "unreachable";

export const PROBLEM_LABEL: Record<DownloadProblem, string> = {
  stalled: "Stalled",
  metadata: "Never started",
  "usenet-failed": "Usenet download failed",
  "import-failed": "Didn't import",
  "download-failed": "Download failed",
  storage: "Storage",
  unreachable: "Can't reach",
};

/** One download Hearth is watching, as read on one check. */
export interface DownloadObservation {
  /** Stable identity: "qbt:<hash>", "sab:<nzo id>", "<app service id>:<queue id>". */
  key: string;
  title: string;
  /** The app that grabbed it (Sonarr, Radarr...), when one tracks it. */
  app?: string;
  appServiceId?: string;
  /** The download client and its service. */
  client: string;
  clientServiceId: string;
  /** What looks wrong this check, if anything. */
  problem?: DownloadProblem;
  /** The app's or client's own words, kept for the detail. */
  detail?: string;
  /** Bytes downloaded so far: an increase is progress and clears strikes. */
  downloadedBytes?: number;
  /** Failures and failed imports are final: they do not wait for strikes. */
  final?: boolean;
  progressPct?: number;
  /** Sonarr or Radarr tracks it: Fix it removes this queue item and searches for another. */
  fix?: DownloadFix;
}

/** Where a stuck download can be fixed (phase 3, 11-13): its Sonarr or Radarr queue item. */
export interface DownloadFix {
  serviceId: string;
  queueId: number;
}

/**
 * What Fix it can recover (the owner, 11-13): a download that stalled, never started or failed.
 * A finished download that didn't import is not one: its reasons vary (already have it, wrong
 * episode), so it stays with the app's own Import or Remove.
 */
export const RECOVERABLE: readonly DownloadProblem[] = [
  "stalled",
  "metadata",
  "usenet-failed",
  "download-failed",
];

/** Whether Fix it (or Automatic Recovery) applies to this item now. */
export function canRecover(i: DownloadHealthItem): boolean {
  return (
    i.state === "attention" && Boolean(i.fix) && RECOVERABLE.includes(i.problem) && !i.sharedCause
  );
}

export interface Strike {
  count: number;
  firstAt: string;
  lastAt: string;
  downloadedBytes?: number;
}

export interface DownloadHealthSettings {
  /** Checks in a row that look broken before it needs attention. */
  strikes: number;
  /** And at least this long between the first and the last of them. */
  minMinutes: number;
  /** This many stalled at once in one client points to a shared cause. */
  shared: number;
  /**
   * Automatic Recovery (11-13, off unless the owner turns it on): a download that needs attention
   * and can be recovered is fixed without asking, and the bell says what was done.
   */
  auto?: boolean;
}

export const DEFAULT_HEALTH_SETTINGS: DownloadHealthSettings = {
  strikes: 3,
  minMinutes: 60,
  shared: 5,
};

/** At most this many replacements per movie or episode; then Hearth asks the owner (11-13). */
export const MAX_REPLACEMENTS = 2;

export interface DownloadHealthItem {
  key: string;
  title: string;
  app?: string;
  appServiceId?: string;
  client: string;
  clientServiceId: string;
  problem: DownloadProblem;
  /** Watching (strikes so far) or needs attention (at the limit, or final). */
  state: "watching" | "attention";
  strikes: number;
  /** Plain words: what is wrong and what it means. */
  explain: string;
  detail?: string;
  since: string;
  /** Held back because the cause is shared (see the overview's causes). */
  sharedCause?: string;
  fix?: DownloadFix;
}

export interface DownloadHealthCause {
  clientServiceId: string;
  client: string;
  text: string;
  count: number;
}

export interface DownloadHealthOverview {
  checkedAt?: string;
  downloading: number;
  watching: number;
  attention: number;
  clients: { serviceId: string; name: string; reachable: boolean; detail?: string }[];
  causes: DownloadHealthCause[];
  items: DownloadHealthItem[];
  settings: DownloadHealthSettings;
}

/** Plain words for SABnzbd's failure messages. */
export function explainUsenet(why = ""): string {
  const w = why.toLowerCase();
  if (/aborted|missing articles|not enough repair|repair failed|par2|incomplete/.test(w))
    return "Parts of it are no longer on your Usenet provider, so it couldn't be completed. Another release of the same thing usually works.";
  if (/password|encrypted/.test(w))
    return "It is password protected, so it couldn't be unpacked. Such releases are usually fake: another release is the fix.";
  if (/unpack|unrar|7z|crc/.test(w))
    return "It downloaded but couldn't be unpacked: the archive is damaged.";
  if (/disk|space|write|permission/.test(w))
    return "It couldn't be written to disk: check free space and the download folder.";
  if (/duplicate/.test(w)) return "SABnzbd skipped it as a duplicate of something it already has.";
  if (/no ?(usable|valid)|empty|bad nzb|nzb/.test(w))
    return "The NZB itself was bad or empty: the indexer served a broken file.";
  return "SABnzbd couldn't complete it.";
}

/** Plain words for an app's reason a finished download wasn't imported. */
export function explainImport(detail = ""): string {
  const d = detail.toLowerCase();
  if (/sample/.test(d)) return "Only a sample was found, not the real file.";
  if (/not (a )?(valid|supported)|no video|no files found|no eligible|unable to find/.test(d))
    return "It finished, but there's no usable video in it (wrong files or a fake release).";
  if (/not (an )?upgrade|already|exists/.test(d))
    return "It finished, but your library already has this at the same or better quality.";
  if (
    /episode .* was not found|not found in the grabbed release|unknown (series|movie|episode)|matched to|invalid season or episode/.test(
      d,
    )
  )
    return "It finished, but the app couldn't tell which episode or movie it is: it needs a manual import.";
  if (/permission|access (is )?denied|read-?only/.test(d))
    return "It finished, but the app isn't allowed to read or move the files.";
  if (/path|does not exist|not found/.test(d))
    return "It finished, but the app can't find the files where the download client says they are.";
  return "It finished downloading but couldn't be added to your library.";
}

const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

/**
 * One check: strikes updated from what was observed, items that need attention, and shared causes.
 * `unreachable` lists clients that did not answer: nothing of theirs gets a strike.
 */
export function assess(
  observed: DownloadObservation[],
  previous: Record<string, Strike>,
  now: string,
  settings: DownloadHealthSettings = DEFAULT_HEALTH_SETTINGS,
  unreachable: { serviceId: string; name: string; detail?: string }[] = [],
): { strikes: Record<string, Strike>; items: DownloadHealthItem[]; causes: DownloadHealthCause[] } {
  const strikes: Record<string, Strike> = {};
  const down = new Set(unreachable.map((u) => u.serviceId));
  // Keep the strikes of an unreachable client's downloads as they were: an outage is no evidence.
  for (const [k, s] of Object.entries(previous))
    if (observed.every((o) => o.key !== k) && [...down].some((id) => k.includes(id)))
      strikes[k] = s;

  const items: DownloadHealthItem[] = [];
  for (const o of observed) {
    if (down.has(o.clientServiceId)) {
      if (previous[o.key]) strikes[o.key] = previous[o.key]!;
      continue;
    }
    const prev = previous[o.key];
    const progressed =
      prev?.downloadedBytes !== undefined &&
      o.downloadedBytes !== undefined &&
      o.downloadedBytes > prev.downloadedBytes;
    if (!o.problem || progressed) continue;
    const s: Strike = prev
      ? { ...prev, count: prev.count + 1, lastAt: now, downloadedBytes: o.downloadedBytes }
      : { count: 1, firstAt: now, lastAt: now, downloadedBytes: o.downloadedBytes };
    strikes[o.key] = s;
    const reached =
      o.final || (s.count >= settings.strikes && minutes(s.firstAt, now) >= settings.minMinutes);
    items.push({
      key: o.key,
      title: o.title,
      ...(o.app ? { app: o.app } : {}),
      ...(o.appServiceId ? { appServiceId: o.appServiceId } : {}),
      client: o.client,
      clientServiceId: o.clientServiceId,
      problem: o.problem,
      state: reached ? "attention" : "watching",
      strikes: s.count,
      explain: explainOf(o),
      ...(o.detail ? { detail: o.detail } : {}),
      ...(o.fix ? { fix: o.fix } : {}),
      since: s.firstAt,
    });
  }

  // Many stalled at once in one client: one shared cause, not many separate problems.
  const causes: DownloadHealthCause[] = unreachable.map((u) => ({
    clientServiceId: u.serviceId,
    client: u.name,
    count: observed.filter((o) => o.clientServiceId === u.serviceId).length,
    text: `Hearth can't reach ${u.name}${u.detail ? ` (${u.detail})` : ""}, so it isn't judging its downloads right now. Nothing counts against them meanwhile.`,
  }));
  const byClient = new Map<string, DownloadHealthItem[]>();
  for (const i of items)
    if (i.problem === "stalled" || i.problem === "metadata")
      byClient.set(i.clientServiceId, [...(byClient.get(i.clientServiceId) ?? []), i]);
  for (const [id, list] of byClient) {
    if (list.length < settings.shared) continue;
    const text = `${list.length} downloads in ${list[0]!.client} stopped at the same time. That is rarely ${list.length} bad downloads: check its VPN, its network and its disk first.`;
    causes.push({ clientServiceId: id, client: list[0]!.client, count: list.length, text });
    for (const i of list) {
      i.sharedCause = text;
      i.state = "watching";
    }
  }
  items.sort((a, b) =>
    a.state === b.state ? a.since.localeCompare(b.since) : a.state === "attention" ? -1 : 1,
  );
  return { strikes, items, causes };
}

function explainOf(o: DownloadObservation): string {
  switch (o.problem) {
    case "stalled":
      return "This download isn't making progress. No peers have been found recently.";
    case "metadata":
      return "This download never started. Hearth couldn't get its details from other peers.";
    case "usenet-failed":
      return explainUsenet(o.detail);
    case "import-failed":
      return explainImport(o.detail);
    case "download-failed":
      // A Usenet failure the app reports in its own words reads the same as SABnzbd's.
      return /repair|article|par2|unpack|password|nzb/i.test(o.detail ?? "")
        ? explainUsenet(o.detail)
        : "The download client gave up on it, so nothing usable was downloaded.";
    case "storage":
      return "Downloads are failing because of where they go, not what they are.";
    case "unreachable":
      return "Hearth can't reach the download client.";
    default:
      return "";
  }
}
