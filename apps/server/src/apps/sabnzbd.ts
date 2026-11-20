import type { AppActivity, AppIssue, AppQueueItem, AppReport } from "@dragon-control/core";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * SABnzbd, read only: version, whether the queue is downloading or paused,
 * speed, the queue, recent history (with failures), and SABnzbd's own
 * warnings. SABnzbd takes its API key in the query string; the address is
 * therefore never put in an error, a log line, or a report.
 */

interface QueueSlot {
  filename?: string;
  status?: string;
  percentage?: string | number;
  mb?: string | number;
  mbleft?: string | number;
  timeleft?: string;
  cat?: string;
}
interface HistorySlot {
  name?: string;
  status?: string;
  fail_message?: string;
  completed?: number;
}

async function api<T>(fetchImpl: Fetch, base: string, mode: string, key: string): Promise<T> {
  const url = joinUrl(base, `/api?mode=${mode}&output=json&apikey=${encodeURIComponent(key)}`);
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // The URL holds the key: report the base address only.
    const why = error instanceof Error ? error.message.replaceAll(key, "[hidden]") : "no answer";
    throw new AppUnreachableError(`SABnzbd did not answer at ${base}: ${why}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new AppKeyError("SABnzbd refused the API key. Check the key in the vault.");
  }
  if (!res.ok)
    throw new AppUnreachableError(`SABnzbd answered ${res.status} for ${mode.split("&")[0]}.`);
  const body = (await res.json()) as T & { status?: boolean; error?: string };
  if (body && body.status === false) {
    if (/api key/i.test(body.error ?? "")) {
      throw new AppKeyError("SABnzbd refused the API key. Check the key in the vault.");
    }
    throw new AppUnreachableError(`SABnzbd said: ${body.error ?? "an error"}.`);
  }
  return body;
}

const num = (v: string | number | undefined) => (v === undefined ? undefined : Number(v));

export async function readSabnzbd(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const [version, queueBody, historyBody, warningsBody] = await Promise.all([
    api<{ version?: string }>(fetchImpl, base, "version", key),
    api<{
      queue?: {
        status?: string;
        paused?: boolean;
        speed?: string;
        sizeleft?: string;
        timeleft?: string;
        noofslots?: number;
        noofslots_total?: number;
        slots?: QueueSlot[];
      };
    }>(fetchImpl, base, "queue&limit=25", key),
    api<{ history?: { slots?: HistorySlot[] } }>(fetchImpl, base, "history&limit=12", key),
    api<{ warnings?: (string | { text?: string; type?: string })[] }>(
      fetchImpl,
      base,
      "warnings",
      key,
    ),
  ]);
  const q = queueBody.queue ?? {};
  const slots = q.slots ?? [];
  const issues: AppIssue[] = [];
  if (q.paused) {
    issues.push({
      level: "warning",
      key: "queue:paused",
      text: "Downloads are paused in SABnzbd.",
    });
  }
  const history = historyBody.history?.slots ?? [];
  const failed = history.filter((h) => /fail/i.test(h.status ?? ""));
  if (failed.length) {
    issues.push({
      level: "warning",
      key: "history:failed",
      text: `${failed.length} of the last ${history.length} downloads failed.`,
    });
  }
  for (const [i, w] of (warningsBody.warnings ?? []).slice(-5).entries()) {
    const text = typeof w === "string" ? w : (w.text ?? "");
    if (!text) continue;
    issues.push({ level: "warning", key: `warning:${i}`, text: text.slice(0, 300) });
  }

  const queue: AppQueueItem[] = slots.map((s) => {
    const total = num(s.mb);
    const left = num(s.mbleft);
    return {
      title: s.filename ?? "Unknown item",
      status: s.status ?? "Queued",
      ...(num(s.percentage) !== undefined ? { progressPct: num(s.percentage) } : {}),
      ...(total !== undefined ? { sizeMb: Math.round(total) } : {}),
      ...(s.timeleft && left ? { timeLeft: s.timeleft } : {}),
      ...(s.cat && s.cat !== "*" ? { via: s.cat } : {}),
    };
  });
  const activity: AppActivity[] = history.map((h) => {
    const bad = /fail/i.test(h.status ?? "");
    return {
      ...(h.completed ? { at: new Date(h.completed * 1000).toISOString() } : {}),
      text: `${h.status ?? "Done"}: ${h.name ?? ""}${bad && h.fail_message ? ` (${h.fail_message})` : ""}`,
      tone: bad ? "error" : /complete/i.test(h.status ?? "") ? "good" : undefined,
    };
  });

  return {
    app: "sabnzbd",
    version: version.version,
    status: worst(issues),
    issues,
    facts: [
      { label: "Queue", value: q.paused ? "Paused" : (q.status ?? "Idle") },
      { label: "Speed", value: q.speed ? `${q.speed}B/s` : "0" },
      {
        label: "Left",
        value: q.sizeleft ? `${q.sizeleft}${q.timeleft ? `, ${q.timeleft}` : ""}` : "Nothing",
      },
    ],
    queue,
    queueTotal: q.noofslots_total ?? q.noofslots ?? slots.length,
    activity,
    connections: [],
  };
}
