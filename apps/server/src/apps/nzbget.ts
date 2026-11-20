import type {
  AppIssue,
  AppQueueItem,
  AppReport,
  NzbgetDashboard,
  SabHistoryPage,
  SabJobFile,
} from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * NZBGet, through its JSON-RPC API (POST /jsonrpc), signed in with its control username and
 * password from the vault (Settings > Security: ControlUsername and ControlPassword). Checked
 * against a throwaway linuxserver/nzbget (26.3). Its queue, history and files come back in the
 * same shapes as SABnzbd's, so both panels share one Overview and Downloads tab.
 *
 * NZBGet's settings hold its news servers' passwords and its own: Hearth reads only the category
 * names from them. Reads here never change anything; changes are plans (nzbget-control.ts).
 */

export class NzbgetError extends Error {}

export interface NzbgetLogin {
  username: string;
  password: string;
}

export async function rpc<T>(
  fetchImpl: Fetch,
  base: string,
  login: NzbgetLogin,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, "/jsonrpc"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(login.username || login.password
          ? {
              Authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`,
            }
          : {}),
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `NZBGet did not answer at ${base}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError("NZBGet refused the username or password. Check the login in the vault.");
  if (!res.ok) throw new NzbgetError(`NZBGet answered ${res.status} to ${method}.`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } | string | null };
  if (body.error)
    throw new NzbgetError(
      `NZBGet refused ${method}: ${redactLine(typeof body.error === "string" ? body.error : (body.error.message ?? "no reason")).slice(0, 200)}`,
    );
  return body.result as T;
}

/** A 64-bit size NZBGet sends as two 32-bit halves. */
const big = (lo?: number, hi?: number) => (hi ?? 0) * 4294967296 + (lo ?? 0);
const mbOf = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;

export interface RawGroup {
  NZBID: number;
  NZBName: string;
  Status: string;
  Category?: string;
  FileSizeLo?: number;
  FileSizeHi?: number;
  RemainingSizeLo?: number;
  RemainingSizeHi?: number;
  PausedSizeLo?: number;
  PausedSizeHi?: number;
  MaxPriority?: number;
  Health?: number;
  CriticalHealth?: number;
}

export interface RawHistory {
  NZBID: number;
  Name?: string;
  NZBName?: string;
  Status: string;
  Category?: string;
  HistoryTime?: number;
  FileSizeLo?: number;
  FileSizeHi?: number;
  Kind?: string;
}

interface RawStatus {
  DownloadRate?: number;
  DownloadLimit?: number;
  DownloadPaused?: boolean;
  RemainingSizeLo?: number;
  RemainingSizeHi?: number;
  FreeDiskSpaceMB?: number;
  TotalDiskSpaceMB?: number;
  ResumeTime?: number;
  QuotaReached?: boolean;
}

/** NZBGet's priority numbers in SABnzbd's words (the shared screens use them). */
export const PRIORITY: Record<string, number> = { force: 900, high: 100, normal: 0, low: -100 };
export const priorityWord = (n?: number) =>
  (n ?? 0) >= 900 ? "Force" : (n ?? 0) >= 50 ? "High" : (n ?? 0) <= -50 ? "Low" : "Normal";

const STATUS: Record<string, string> = {
  QUEUED: "Queued",
  PAUSED: "Paused",
  DOWNLOADING: "Downloading",
  FETCHING: "Fetching",
  PP_QUEUED: "Waiting to unpack",
  LOADING_PARS: "Loading repair files",
  VERIFYING_SOURCES: "Verifying",
  REPAIRING: "Repairing",
  VERIFYING_REPAIRED: "Verifying",
  RENAMING: "Renaming",
  UNPACKING: "Unpacking",
  MOVING: "Moving",
  EXECUTING_SCRIPT: "Running a script",
  PP_FINISHED: "Finished",
};

/** NZBGet's reasons for a failed or deleted download, in plain words. */
const WHY: Record<string, string> = {
  "FAILURE/PAR": "repair failed",
  "FAILURE/UNPACK": "unpacking failed",
  "FAILURE/MOVE": "moving the files failed",
  "FAILURE/SCRIPT": "a script reported a failure",
  "FAILURE/DISKSPACE": "the disk was full",
  "FAILURE/HEALTH": "too many missing articles",
  "FAILURE/BAD": "marked bad",
  "FAILURE/FETCH": "the NZB could not be fetched",
  "DELETED/MANUAL": "deleted by hand",
  "DELETED/DUPE": "deleted as a duplicate",
  "DELETED/COPY": "deleted as a copy",
  "DELETED/HEALTH": "deleted: too many missing articles",
  "DELETED/GOOD": "deleted after a good copy finished",
  "DELETED/BAD": "deleted as bad",
  "DELETED/SCAN": "deleted: not an NZB",
};

/** One queue entry as the shared screens show it. */
export function toJob(g: RawGroup, rate: number) {
  const size = big(g.FileSizeLo, g.FileSizeHi);
  const left = big(g.RemainingSizeLo, g.RemainingSizeHi);
  const paused = big(g.PausedSizeLo, g.PausedSizeHi);
  // A group whose remaining files are all paused reads as paused, as NZBGet's own page shows it.
  // A group whose remaining files are all paused is paused, whatever its status word says
  // (NZBGet keeps "DOWNLOADING" for a paused group it had started).
  const status =
    ["QUEUED", "DOWNLOADING", "PAUSED"].includes(g.Status) && left > 0 && paused >= left
      ? "Paused"
      : (STATUS[g.Status] ?? g.Status);
  const secs = rate > 0 && status === "Downloading" ? Math.round(left / rate) : undefined;
  return {
    id: String(g.NZBID),
    name: g.NZBName,
    status,
    progressPct: size ? Math.round(((size - left) / size) * 1000) / 10 : 0,
    ...(size ? { sizeMb: mbOf(size) } : {}),
    ...(secs !== undefined ? { timeLeft: clock(secs) } : {}),
    ...(g.Category ? { category: g.Category } : {}),
    priority: priorityWord(g.MaxPriority),
  };
}

const clock = (s: number) =>
  `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function toHistory(h: RawHistory) {
  const failed = h.Status.startsWith("FAILURE");
  const deleted = h.Status.startsWith("DELETED");
  const size = big(h.FileSizeLo, h.FileSizeHi);
  const why = WHY[h.Status];
  return {
    id: String(h.NZBID),
    name: h.Name ?? h.NZBName ?? `Job ${h.NZBID}`,
    failed,
    status: failed ? "Failed" : deleted ? "Deleted" : "Completed",
    ...(why && (failed || deleted) ? { why } : {}),
    ...(h.HistoryTime ? { at: new Date(h.HistoryTime * 1000).toISOString() } : {}),
    ...(size ? { sizeMb: mbOf(size) } : {}),
    ...(h.Category ? { category: h.Category } : {}),
  };
}

/** The category names from NZBGet's settings; nothing else from them (they hold passwords). */
async function categories(fetchImpl: Fetch, base: string, login: NzbgetLogin) {
  const config = await rpc<{ Name: string; Value: string }[]>(fetchImpl, base, login, "config");
  return config.filter((o) => /^Category\d+\.Name$/i.test(o.Name) && o.Value).map((o) => o.Value);
}

/** NZBGet's own warnings: its health check (v23 and later) and recent warnings in its log. */
async function warnings(fetchImpl: Fetch, base: string, login: NzbgetLogin) {
  const out: string[] = [];
  const health = await rpc<{
    Alerts?: { Severity?: string; Message?: string }[];
    Sections?: {
      Name?: string;
      Issues?: { Severity?: string; Message?: string }[];
      Options?: { Name?: string; Severity?: string; Message?: string }[];
    }[];
  }>(fetchImpl, base, login, "systemhealth").catch(() => undefined);
  const serious = (s?: string) => s === "Error" || s === "Warning";
  for (const a of health?.Alerts ?? []) if (serious(a.Severity) && a.Message) out.push(a.Message);
  for (const s of health?.Sections ?? []) {
    for (const i of s.Issues ?? []) if (serious(i.Severity) && i.Message) out.push(i.Message);
    for (const o of s.Options ?? [])
      if (serious(o.Severity) && o.Message) out.push(`${o.Name}: ${o.Message}`);
  }
  const log = await rpc<{ Kind: string; Text: string; Time: number }[]>(
    fetchImpl,
    base,
    login,
    "log",
    [0, 200],
  ).catch(() => []);
  const day = Date.now() / 1000 - 86400;
  for (const l of log
    .filter((x) => (x.Kind === "WARNING" || x.Kind === "ERROR") && x.Time > day)
    .slice(-10))
    out.push(l.Text);
  return [...new Set(out.map((w) => redactLine(w).slice(0, 300)))];
}

/** The panel's live read, in SABnzbd's shapes. */
export async function nzbgetDashboard(
  fetchImpl: Fetch,
  base: string,
  login: NzbgetLogin,
): Promise<NzbgetDashboard> {
  const [version, status, groups, history, cats, warns] = await Promise.all([
    rpc<string>(fetchImpl, base, login, "version"),
    rpc<RawStatus>(fetchImpl, base, login, "status"),
    rpc<RawGroup[]>(fetchImpl, base, login, "listgroups", [0]),
    rpc<RawHistory[]>(fetchImpl, base, login, "history", [false]),
    categories(fetchImpl, base, login).catch(() => [] as string[]),
    warnings(fetchImpl, base, login),
  ]);
  const rate = status.DownloadRate ?? 0;
  const queue = groups.map((g) => toJob(g, rate));
  const leftBytes = big(status.RemainingSizeLo, status.RemainingSizeHi);
  const paused = Boolean(status.DownloadPaused);
  const resumeIn =
    paused && status.ResumeTime && status.ResumeTime > 0
      ? Math.max(1, Math.round((status.ResumeTime - Date.now() / 1000) / 60))
      : undefined;
  const limit = status.DownloadLimit ?? 0;
  return {
    app: "nzbget",
    version,
    paused,
    ...(resumeIn ? { pausedMinutes: resumeIn } : {}),
    ...(limit > 0
      ? { speedLimitKbps: Math.round(limit / 1024), speedLimit: speedText(limit) }
      : {}),
    categories: cats,
    status: paused ? "Paused" : rate > 0 ? "Downloading" : queue.length ? "Queued" : "Idle",
    speedKbps: Math.round(rate / 1024),
    ...(leftBytes ? { sizeLeft: speedText(leftBytes).replace("/s", "") } : {}),
    ...(rate > 0 && leftBytes ? { timeLeft: clock(Math.round(leftBytes / rate)) } : {}),
    ...(status.FreeDiskSpaceMB !== undefined && status.FreeDiskSpaceMB > 0
      ? { diskFreeGb: Math.round((status.FreeDiskSpaceMB / 1024) * 10) / 10 }
      : {}),
    ...(status.TotalDiskSpaceMB
      ? { diskTotalGb: Math.round((status.TotalDiskSpaceMB / 1024) * 10) / 10 }
      : {}),
    queue,
    history: history.slice(0, 30).map(toHistory),
    warnings: warns,
  };
}

const speedText = (bytes: number) =>
  bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(1)} GB/s`
    : bytes >= 1048576
      ? `${(bytes / 1048576).toFixed(1)} MB/s`
      : `${Math.round(bytes / 1024)} KB/s`;

/** The history, searched or filtered, a page of 30 at a time. */
export async function nzbgetHistory(
  fetchImpl: Fetch,
  base: string,
  login: NzbgetLogin,
  want: { search?: string; failedOnly?: boolean; category?: string; start?: number },
): Promise<SabHistoryPage> {
  const needle = want.search?.trim().toLowerCase() ?? "";
  const all = (await rpc<RawHistory[]>(fetchImpl, base, login, "history", [false]))
    .map(toHistory)
    .filter((h) => !needle || h.name.toLowerCase().includes(needle))
    .filter((h) => !want.failedOnly || h.failed)
    .filter((h) => !want.category || h.category === want.category);
  const start = Math.max(0, want.start ?? 0);
  return { total: all.length, items: all.slice(start, start + 30) };
}

/** A queued download's files. */
export async function nzbgetJobFiles(
  fetchImpl: Fetch,
  base: string,
  login: NzbgetLogin,
  id: string,
): Promise<SabJobFile[]> {
  const files = await rpc<
    {
      Filename: string;
      FileSizeLo?: number;
      FileSizeHi?: number;
      RemainingSizeLo?: number;
      RemainingSizeHi?: number;
      ActiveDownloads?: number;
      Paused?: boolean;
    }[]
  >(fetchImpl, base, login, "listfiles", [0, 0, Number(id)]);
  return files.slice(0, 500).map((f) => {
    const size = big(f.FileSizeLo, f.FileSizeHi);
    const left = big(f.RemainingSizeLo, f.RemainingSizeHi);
    return {
      name: f.Filename,
      sizeMb: mbOf(size),
      leftMb: mbOf(left),
      status: left === 0 ? "finished" : f.ActiveDownloads ? "active" : "queued",
    };
  });
}

/** The health read every app gets: version, its own warnings, what is downloading. */
export async function readNzbget(
  base: string,
  login: NzbgetLogin,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await nzbgetDashboard(fetchImpl, base, login);
  const issues: AppIssue[] = d.warnings.slice(0, 5).map((w, i) => ({
    level: "warning",
    key: `nzbget-warning:${i}`,
    text: w,
  }));
  const failed = d.history.filter((h) => h.failed);
  if (failed.length)
    issues.push({
      level: "warning",
      key: "history:failed",
      text: `${failed.length} recent ${failed.length === 1 ? "download" : "downloads"} failed in NZBGet.`,
    });
  const queue: AppQueueItem[] = d.queue.slice(0, 25).map((j) => ({
    title: j.name,
    status: j.status,
    progressPct: Math.round(j.progressPct),
    ...(j.sizeMb !== undefined ? { sizeMb: Math.round(j.sizeMb) } : {}),
    ...(j.timeLeft ? { timeLeft: j.timeLeft } : {}),
    ...(j.category ? { via: j.category } : {}),
  }));
  return {
    app: "nzbget",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Status", value: d.status },
      {
        label: "Speed",
        value: `${d.speedKbps >= 1024 ? `${(d.speedKbps / 1024).toFixed(1)} MB/s` : `${d.speedKbps} KB/s`}`,
      },
      { label: "In the queue", value: String(d.queue.length) },
    ],
    queue,
    queueTotal: d.queue.length,
    activity: d.history.slice(0, 6).map((h) => ({
      text: `${h.name}: ${h.status.toLowerCase()}${h.why ? ` (${h.why})` : ""}`,
      ...(h.failed
        ? { tone: "error" as const }
        : h.status === "Completed"
          ? { tone: "good" as const }
          : {}),
      ...(h.at ? { at: h.at } : {}),
    })),
  };
}
