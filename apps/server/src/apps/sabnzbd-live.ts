import type {
  SabHistoryPage,
  SabJobFile,
  SabnzbdDashboard,
  StepParams,
} from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import {
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  multipart,
  TIMEOUT_MS,
  type Fetch,
  type UploadFetch,
} from "./http";

/**
 * SABnzbd's panel and its everyday controls, through its API (key in the query, kept out of every
 * message): the queue with speed and time left, history with why a download failed, free disk
 * space, and pausing or resuming everything or one job, retrying a failed job, and removing a job
 * (its files stay unless the plan says otherwise). Each control is a plan confirmed in the panel
 * and read back.
 */

async function call<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  params: Record<string, string>,
): Promise<T> {
  const q = new URLSearchParams({ ...params, output: "json", apikey: key });
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, `/api?${q.toString()}`), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.replaceAll(key, "[hidden]") : "no answer";
    throw new AppUnreachableError(`SABnzbd did not answer at ${base}: ${why}`);
  }
  return answer<T>(res, params.mode ?? "");
}

async function answer<T>(res: Awaited<ReturnType<Fetch>>, mode: string): Promise<T> {
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError("SABnzbd refused the API key.");
  if (!res.ok) throw new AppUnreachableError(`SABnzbd answered ${res.status} for ${mode}.`);
  const body = (await res.json()) as T & { status?: boolean; error?: string };
  if (body && body.status === false && body.error) {
    if (/api key/i.test(body.error)) throw new AppKeyError("SABnzbd refused the API key.");
    throw new AppUnreachableError(`SABnzbd said: ${body.error}.`);
  }
  return body;
}

/** An .nzb file sent to SABnzbd (mode addfile), the key in the query as for every call. */
async function uploadNzb(
  fetchImpl: Fetch,
  base: string,
  key: string,
  params: Record<string, string>,
  file: { filename: string; data: Uint8Array },
): Promise<{ nzo_ids?: string[] }> {
  const q = new URLSearchParams({ ...params, mode: "addfile", output: "json", apikey: key });
  const form = multipart({}, [
    { field: "name", filename: file.filename, type: "application/x-nzb", data: file.data },
  ]);
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await (fetchImpl as unknown as UploadFetch)(joinUrl(base, `/api?${q.toString()}`), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": form.contentType },
      body: form.body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.replaceAll(key, "[hidden]") : "no answer";
    throw new AppUnreachableError(`SABnzbd did not take ${file.filename}: ${why}`);
  }
  return answer(res, "addfile");
}

interface Q {
  queue?: {
    status?: string;
    paused?: boolean;
    speed?: string;
    kbpersec?: string;
    sizeleft?: string;
    timeleft?: string;
    diskspace1?: string;
    diskspacetotal1?: string;
    speedlimit?: string;
    speedlimit_abs?: string;
    pause_int?: string;
    slots?: {
      nzo_id?: string;
      filename?: string;
      status?: string;
      percentage?: string;
      mb?: string;
      mbleft?: string;
      timeleft?: string;
      cat?: string;
      priority?: string;
      index?: number;
    }[];
  };
}
interface HistorySlot {
  nzo_id?: string;
  name?: string;
  status?: string;
  fail_message?: string;
  completed?: number;
  bytes?: number;
  category?: string;
}
interface H {
  history?: { noofslots?: number; slots?: HistorySlot[] };
}

const historyItem = (s: HistorySlot): SabnzbdDashboard["history"][number] => ({
  id: s.nzo_id ?? "",
  name: s.name ?? "A download",
  failed: /fail/i.test(s.status ?? ""),
  status: s.status ?? "",
  ...(s.fail_message ? { why: s.fail_message.slice(0, 300) } : {}),
  ...(s.completed ? { at: new Date(s.completed * 1000).toISOString() } : {}),
  ...(s.bytes ? { sizeMb: Math.round(s.bytes / 1024 / 1024) } : {}),
  ...(s.category && s.category !== "*" ? { category: s.category } : {}),
});

/** SABnzbd's history, searched by name, failed only, or one category, a page at a time. */
export async function sabHistory(
  fetchImpl: Fetch,
  base: string,
  key: string,
  want: { search?: string; failedOnly?: boolean; category?: string; start?: number } = {},
): Promise<SabHistoryPage> {
  const h = await call<H>(fetchImpl, base, key, {
    mode: "history",
    start: String(Math.max(0, Math.floor(want.start ?? 0))),
    limit: "50",
    ...(want.search?.trim() ? { search: want.search.trim().slice(0, 200) } : {}),
    ...(want.failedOnly ? { failed_only: "1" } : {}),
    ...(want.category ? { category: want.category.slice(0, 100) } : {}),
  });
  const items = (h.history?.slots ?? []).map(historyItem);
  return { total: Number(h.history?.noofslots ?? items.length), items };
}

/** The files of one queued job (what it is made of, and how much of each is left). */
export async function sabJobFiles(
  fetchImpl: Fetch,
  base: string,
  key: string,
  nzoId: string,
): Promise<SabJobFile[]> {
  const r = await call<{
    files?: { filename?: string; mb?: string; mbleft?: string; status?: string }[];
  }>(fetchImpl, base, key, { mode: "get_files", value: nzoId });
  return (r.files ?? []).slice(0, 500).map((f) => ({
    name: f.filename ?? "A file",
    ...(n(f.mb) !== undefined ? { sizeMb: Math.round(n(f.mb)! * 10) / 10 } : {}),
    ...(n(f.mbleft) !== undefined ? { leftMb: Math.round(n(f.mbleft)! * 10) / 10 } : {}),
    ...(f.status ? { status: f.status } : {}),
  }));
}

const n = (v?: string | number) => (v === undefined || v === "" ? undefined : Number(v));
const queue_ = (q: Q) => q.queue ?? {};
/** Bytes per second as SABnzbd says it ("2.5 M"). */
const bytesWords = (b: number) =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(b / 1024)} KB/s`;
/** SABnzbd's priorities, in its own words, and their numbers. */
const PRIORITY: Record<string, string> = { force: "2", high: "1", normal: "0", low: "-1" };

export async function sabnzbdDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<SabnzbdDashboard> {
  const [v, q, h, w, c] = await Promise.all([
    call<{ version?: string }>(fetchImpl, base, key, { mode: "version" }).catch(() => ({
      version: undefined,
    })),
    call<Q>(fetchImpl, base, key, { mode: "queue", limit: "50" }),
    call<H>(fetchImpl, base, key, { mode: "history", limit: "25" }),
    call<{ warnings?: (string | { text?: string })[] }>(fetchImpl, base, key, {
      mode: "warnings",
    }).catch(() => ({ warnings: [] })),
    call<{ categories?: string[] }>(fetchImpl, base, key, { mode: "get_cats" }).catch(() => ({
      categories: [],
    })),
  ]);
  const limit = n(queue_(q).speedlimit);
  const pauseFor = String(queue_(q).pause_int ?? "0");
  const queue = q.queue ?? {};
  const slots = queue.slots ?? [];
  const history = h.history?.slots ?? [];
  return {
    app: "sabnzbd",
    ...(v.version ? { version: v.version } : {}),
    paused: Boolean(queue.paused),
    ...(pauseFor !== "0" && /^\d+:\d+/.test(pauseFor)
      ? {
          pausedMinutes: Math.max(
            1,
            Math.round(Number(pauseFor.split(":")[0]) + Number(pauseFor.split(":")[1]) / 60),
          ),
        }
      : {}),
    ...(limit && limit > 0 && limit < 100
      ? {
          speedLimitPct: limit,
          ...(queue.speedlimit_abs && queue.speedlimit_abs !== "0"
            ? { speedLimit: bytesWords(Number(queue.speedlimit_abs)) }
            : {}),
        }
      : {}),
    categories: (c.categories ?? []).filter((x) => x && x !== "*"),
    status: queue.paused
      ? "Paused"
      : slots.some((s) => /download/i.test(s.status ?? ""))
        ? "Downloading"
        : slots.length
          ? (queue.status ?? "Queued")
          : "Idle",
    speedKbps: n(queue.kbpersec) ?? 0,
    ...(queue.sizeleft ? { sizeLeft: queue.sizeleft } : {}),
    ...(queue.timeleft && slots.length ? { timeLeft: queue.timeleft } : {}),
    ...(n(queue.diskspace1) !== undefined ? { diskFreeGb: n(queue.diskspace1) } : {}),
    ...(n(queue.diskspacetotal1) !== undefined ? { diskTotalGb: n(queue.diskspacetotal1) } : {}),
    queue: slots.map((s) => ({
      id: s.nzo_id ?? "",
      name: s.filename ?? "A download",
      status: s.status ?? "Queued",
      progressPct: Math.round(n(s.percentage) ?? 0),
      ...(n(s.mb) !== undefined ? { sizeMb: Math.round(n(s.mb)!) } : {}),
      ...(s.timeleft ? { timeLeft: s.timeleft } : {}),
      ...(s.cat && s.cat !== "*" ? { category: s.cat } : {}),
      ...(s.priority ? { priority: s.priority } : {}),
    })),
    history: history.map(historyItem),
    warnings: (w.warnings ?? [])
      .map((x) => (typeof x === "string" ? x : (x.text ?? "")))
      .filter(Boolean)
      .slice(-5)
      .map((t) => t.slice(0, 300)),
  };
}

export const SAB_OPS = [
  "pause-all",
  "resume-all",
  "pause",
  "resume",
  "retry",
  "remove",
  "remove-history",
  "speed-limit",
  "pause-for",
  "priority",
  "move",
  "category",
  "add",
  "clear-warnings",
] as const;
type Op = (typeof SAB_OPS)[number];

const NZB_MAX_BYTES = 4 * 1024 * 1024;
const NZB_NAME = /\.(nzb|nzb\.gz|gz|zip)$/i;
/** A job's name as SABnzbd gives it to an uploaded file: the file name without .nzb. */
const jobNameOf = (filename: string) => filename.replace(NZB_NAME, "");

/** Uploaded .nzb files in a plan's params: name and base64 bytes, at most 5, 4 MB each. */
function nzbUploads(params?: StepParams): { filename: string; data: Uint8Array }[] {
  if (typeof params?.files !== "string" || !params.files) return [];
  let list: unknown;
  try {
    list = JSON.parse(params.files);
  } catch {
    throw new Error("The uploaded files could not be read.");
  }
  if (!Array.isArray(list)) throw new Error("The uploaded files could not be read.");
  if (list.length > 5) throw new Error("At most 5 .nzb files at once.");
  return list.map((f: { name?: unknown; data?: unknown }) => {
    if (typeof f?.data !== "string" || !f.data) throw new Error("An uploaded file is empty.");
    const filename =
      typeof f.name === "string" && f.name
        ? f.name.replace(/[\\/]/g, "_").slice(0, 200)
        : "upload.nzb";
    if (!NZB_NAME.test(filename)) throw new Error(`${filename} is not an .nzb file.`);
    const data = new Uint8Array(Buffer.from(f.data, "base64"));
    if (data.byteLength > NZB_MAX_BYTES) throw new Error(`${filename} is larger than 4 MB.`);
    if (
      /\.nzb$/i.test(filename) &&
      !/<nzb[\s>]/i.test(Buffer.from(data.subarray(0, 8192)).toString("utf8"))
    )
      throw new Error(`${filename} does not look like an NZB file.`);
    return { filename, data };
  });
}

/** An NZB link as shown in a plan: never its query (indexer links carry their API key there). */
function linkShown(link: string) {
  const u = new URL(link);
  return `${u.host}${u.pathname}${u.search ? "?…" : ""}`;
}

/** NZB links in a plan's params: http(s) only, one per line. */
function nzbLinks(params?: StepParams): string[] {
  const text = typeof params?.urls === "string" ? params.urls : "";
  const links = text
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const l of links) {
    if (!URL.canParse(l) || !/^https?:$/.test(new URL(l).protocol))
      throw new Error("Each NZB link must be an http or https address.");
  }
  return links;
}

export class SabnzbdOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  private read(service: { id: string; localUrl: string }) {
    return this.use(service, "read SABnzbd's queue and history", "read", (key) =>
      sabnzbdDashboard(this.fetchImpl, service.localUrl, key),
    );
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!SAB_OPS.includes(op)) throw new Error(`Say what to do: ${SAB_OPS.join(", ")}.`);
    const d = await this.read(service);
    const id = typeof params?.nzoId === "string" ? params.nzoId : "";
    const job = d.queue.find((j) => j.id === id);
    const done = d.history.find((j) => j.id === id);
    const deleteFiles = params?.deleteFiles === true;
    let label: string;
    // What a setting change needs to run and read back.
    let extra: Record<string, string> = {};
    if (op === "add") return this.planAdd(service, params, base, d);
    if (op === "clear-warnings") {
      if (!d.warnings.length) throw new Error(`${service.name} has no warnings to clear.`);
      const label = `Clear ${d.warnings.length === 1 ? "the warning" : `${d.warnings.length} warnings`} in ${service.name}`;
      return {
        ...base,
        label,
        serviceName: service.name,
        params: { op },
        change: {
          summary: label,
          settings: [
            {
              name: "Warnings",
              before: d.warnings.length === 1 ? "1 warning" : `${d.warnings.length} warnings`,
              after: "none (they are only cleared from the list; nothing else changes)",
            },
          ],
        },
      };
    }
    if (op === "pause-all") {
      if (d.paused) throw new Error("SABnzbd is already paused.");
      label = `Pause all downloads in ${service.name}`;
    } else if (op === "resume-all") {
      if (!d.paused) throw new Error("SABnzbd is not paused.");
      label = `Resume all downloads in ${service.name}`;
    } else if (op === "pause" || op === "resume" || op === "remove") {
      if (!job) throw new Error("That download is no longer in the queue.");
      if (op === "pause" && /paused/i.test(job.status))
        throw new Error(`${job.name} is already paused.`);
      if (op === "resume" && !/paused/i.test(job.status))
        throw new Error(`${job.name} is not paused.`);
      label =
        op === "remove"
          ? `Remove ${job.name} from the queue in ${service.name}${deleteFiles ? " and delete what it downloaded" : " (what it downloaded stays)"}`
          : `${op === "pause" ? "Pause" : "Resume"} ${job.name} in ${service.name}`;
    } else if (op === "speed-limit") {
      const pct = Number(params?.value);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100)
        throw new Error(
          "The speed limit is a percentage of the line speed, 0 to 100 (100 or 0 = no limit).",
        );
      const now = d.speedLimitPct ?? 100;
      const want = pct === 0 ? 100 : pct;
      if (now === want)
        throw new Error(`SABnzbd's speed limit is already ${want === 100 ? "off" : `${want}%`}.`);
      label = `${want === 100 ? "Remove the speed limit" : `Limit downloads to ${want}% of the line speed`} in ${service.name}`;
      extra = { value: String(want), before: now === 100 ? "no limit" : `${now}%` };
    } else if (op === "pause-for") {
      const minutes = Number(params?.value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
        throw new Error("Pause for a whole number of minutes, 1 to 1440.");
      label = `Pause all downloads in ${service.name} for ${minutes} minute${minutes === 1 ? "" : "s"}`;
      extra = { value: String(minutes) };
    } else if (op === "priority" || op === "move" || op === "category") {
      if (!job) throw new Error("That download is no longer in the queue.");
      if (op === "priority") {
        const want = String(params?.value ?? "").toLowerCase();
        if (!PRIORITY[want]) throw new Error("Priority is force, high, normal or low.");
        if ((job.priority ?? "").toLowerCase() === want)
          throw new Error(`${job.name} already has ${want} priority.`);
        label = `Give ${job.name} ${want} priority in ${service.name}`;
        extra = { value: want, before: job.priority ?? "Normal" };
      } else if (op === "move") {
        const to = Number(params?.value);
        const at = d.queue.findIndex((j) => j.id === id);
        if (!Number.isInteger(to) || to < 0 || to >= d.queue.length)
          throw new Error(`Say where in the queue: 0 (first) to ${d.queue.length - 1}.`);
        if (to === at) throw new Error(`${job.name} is already there.`);
        label = `Move ${job.name} to place ${to + 1} of ${d.queue.length} in ${service.name}`;
        extra = { value: String(to), before: `place ${at + 1}` };
      } else {
        const cat = typeof params?.category === "string" ? params.category.trim() : "";
        const cats = d.categories ?? [];
        if (cat && !cats.includes(cat))
          throw new Error(
            `${service.name} has no category "${cat}". It has: ${cats.join(", ") || "none"}.`,
          );
        if ((job.category ?? "") === cat)
          throw new Error(`${job.name} is already in that category.`);
        label = `Put ${job.name} in ${cat ? `the ${cat} category` : "no category"} in ${service.name}`;
        extra = { category: cat || "*", before: job.category ?? "none" };
      }
    } else {
      if (!done) throw new Error("That download is no longer in the history.");
      if (op === "retry" && !done.failed) throw new Error(`${done.name} did not fail.`);
      label =
        op === "retry"
          ? `Retry ${done.name} in ${service.name} (it failed: ${done.why ?? "no reason given"})`
          : `Remove ${done.name} from the history in ${service.name}${deleteFiles ? " and delete its files" : " (its files stay)"}`;
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: {
        op,
        ...(id ? { nzoId: id, name: (job ?? done)?.name ?? "" } : {}),
        ...(deleteFiles ? { deleteFiles } : {}),
        ...extra,
      },
      change: {
        summary: label,
        settings: [
          {
            name: (job ?? done)?.name ?? "Downloads",
            before:
              extra.before ?? (d.paused ? "paused" : (job?.status ?? done?.status ?? "running")),
            after:
              op === "speed-limit"
                ? extra.value === "100"
                  ? "no limit"
                  : `${extra.value}% of the line speed`
                : op === "pause-for"
                  ? `paused for ${extra.value} min, then downloading again`
                  : op === "priority"
                    ? `${extra.value} priority`
                    : op === "move"
                      ? `place ${Number(extra.value) + 1}`
                      : op === "category"
                        ? extra.category === "*"
                          ? "no category"
                          : String(extra.category)
                        : op,
          },
        ],
      },
    };
  }

  /** Adding NZBs: links and uploaded files, with a category, a priority (or paused) and a name. */
  private planAdd(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
    d: SabnzbdDashboard,
  ): PlannedStep {
    const links = nzbLinks(params);
    const files = nzbUploads(params);
    const count = links.length + files.length;
    if (!count) throw new Error("Give NZB links (params.urls) or upload .nzb files.");
    if (count > 10) throw new Error("At most 10 NZBs in one step.");
    const category = typeof params?.category === "string" ? params.category.trim() : "";
    const cats = d.categories ?? [];
    if (category && !cats.includes(category))
      throw new Error(
        `${service.name} has no category "${category}". It has: ${cats.join(", ") || "none"}.`,
      );
    const priority = typeof params?.value === "string" ? params.value.toLowerCase() : "";
    if (priority && !PRIORITY[priority]) throw new Error("Priority is force, high, normal or low.");
    const paused = params?.paused === true;
    const nzbName =
      typeof params?.nzbName === "string" ? params.nzbName.trim().replace(/[\\/]/g, "_") : "";
    if (nzbName && count > 1) throw new Error("A name can only be given when adding one NZB.");
    if (nzbName.length > 200) throw new Error("The name is longer than 200 characters.");
    // The same file twice, or one already in the queue: refused here, not added again.
    const queued = new Set(d.queue.map((j) => j.name.toLowerCase()));
    const names = files.map((f) => jobNameOf(f.filename).toLowerCase());
    const twice = names.find((x, i) => names.indexOf(x) !== i);
    if (twice) throw new Error(`${twice} is chosen twice.`);
    const already = files.find((f) => queued.has((nzbName || jobNameOf(f.filename)).toLowerCase()));
    if (already)
      throw new Error(`${nzbName || jobNameOf(already.filename)} is already in the queue.`);
    const where = category ? `the ${category} category` : "no category (SABnzbd's default)";
    const how = paused ? "paused" : priority ? `${priority} priority` : "its category's priority";
    const label =
      count === 1
        ? `Add ${nzbName || (files[0] ? jobNameOf(files[0].filename) : linkShown(links[0]!))} to ${service.name}`
        : `Add ${count} NZBs to ${service.name}`;
    return {
      ...base,
      label,
      serviceName: service.name,
      params: {
        op: "add",
        ...(links.length ? { urls: links.join("\n") } : {}),
        ...(files.length ? { files: String(params?.files) } : {}),
        ...(category ? { category } : {}),
        ...(priority ? { value: priority } : {}),
        ...(paused ? { paused: true } : {}),
        ...(nzbName ? { nzbName } : {}),
      },
      change: {
        summary: `${label}: ${where}, ${how}. SABnzbd's own duplicate check still applies.`,
        settings: [
          ...links.map((l) => ({
            name: nzbName || linkShown(l),
            before: "not in SABnzbd",
            after: `added from the link, ${where}, ${how}`,
          })),
          ...files.map((f) => ({
            name: nzbName || jobNameOf(f.filename),
            before: "not in SABnzbd",
            after: `added from your file ${f.filename}, ${where}, ${how}`,
          })),
        ],
      },
    };
  }

  /** Adds the NZBs, then reads each new job back by the id SABnzbd gave it. */
  private async runAdd(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const links = nzbLinks(p);
    const files = nzbUploads(p);
    const nzbName = typeof p.nzbName === "string" ? p.nzbName : "";
    const fields: Record<string, string> = {
      ...(typeof p.category === "string" && p.category ? { cat: p.category } : {}),
      ...(p.paused === true
        ? { priority: "-2" }
        : typeof p.value === "string" && PRIORITY[p.value]
          ? { priority: PRIORITY[p.value]! }
          : {}),
      ...(nzbName ? { nzbname: nzbName } : {}),
    };
    // A retried plan must not add a file a second time.
    const before = await this.read(service);
    const queued = new Set(before.queue.map((j) => j.name.toLowerCase()));
    const fresh = files.filter(
      (f) => !queued.has((nzbName || jobNameOf(f.filename)).toLowerCase()),
    );
    const ids: string[] = [];
    let noId = 0;
    await this.use(service, "add NZBs to SABnzbd", "change", async (key) => {
      for (const link of links) {
        const r = await call<{ nzo_ids?: string[] }>(this.fetchImpl, service.localUrl, key, {
          mode: "addurl",
          name: link,
          ...fields,
        });
        if (r.nzo_ids?.length) ids.push(...r.nzo_ids);
        else noId += 1;
      }
      for (const f of fresh) {
        const r = await uploadNzb(this.fetchImpl, service.localUrl, key, fields, f);
        if (r.nzo_ids?.length) ids.push(...r.nzo_ids);
        else noId += 1;
      }
    });
    // Read back by id: in the queue (or already finished, in the history).
    const found = await this.use(service, "read back the added NZBs", "read", async (key) => {
      if (!ids.length) return 0;
      const [q, h] = await Promise.all([
        call<Q>(this.fetchImpl, service.localUrl, key, {
          mode: "queue",
          nzo_ids: ids.join(","),
        }),
        call<H>(this.fetchImpl, service.localUrl, key, {
          mode: "history",
          nzo_ids: ids.join(","),
        }),
      ]);
      const seen = new Set([
        ...(q.queue?.slots ?? []).map((s) => s.nzo_id),
        ...(h.history?.slots ?? []).map((s) => s.nzo_id),
      ]);
      return ids.filter((id) => seen.has(id)).length;
    });
    const skipped = files.length - fresh.length;
    const total = links.length + fresh.length;
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `add ${total} NZB${total === 1 ? "" : "s"} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: "add", links: links.length, files: fresh.length, found, skipped },
    });
    const skippedText = skipped
      ? ` ${skipped} file${skipped === 1 ? " was" : "s were"} already in the queue and not added again.`
      : "";
    if (!total) return { ok: true, result: `Nothing new to add.${skippedText}` };
    if (found === ids.length && !noId)
      return {
        ok: true,
        result: `${found === 1 ? "The NZB is" : `${found} NZBs are`} in ${service.name}. SABnzbd confirms it.${skippedText}`,
      };
    return {
      ok: false,
      result: `SABnzbd took the request, but shows ${found} of ${total} added job${total === 1 ? "" : "s"}${noId ? ` (${noId} came back without a job id)` : ""}. Check its queue and warnings.${skippedText}`,
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    if (op === "add") return this.runAdd(step, service);
    if (op === "clear-warnings") {
      await this.use(service, "clear SABnzbd's warnings", "change", (key) =>
        call(this.fetchImpl, service.localUrl, key, { mode: "warnings", name: "clear" }),
      );
      const left = (await this.read(service)).warnings.length;
      await recordAudit(this.handle.db, {
        actor: step.requestedBy,
        action: `clear the warnings in ${service.name}`,
        target: `service:${service.id}`,
        detail: { op, verified: left === 0 },
      });
      return left === 0
        ? { ok: true, result: "The warnings are cleared. SABnzbd confirms it." }
        : { ok: false, result: `SABnzbd still lists ${left} warning${left === 1 ? "" : "s"}.` };
    }
    const id = String(p.nzoId ?? "");
    const name = String(p.name || "the downloads");
    const del = p.deleteFiles === true ? "1" : "0";
    const params: Record<Exclude<Op, "add" | "clear-warnings">, Record<string, string>> = {
      "pause-all": { mode: "pause" },
      "resume-all": { mode: "resume" },
      pause: { mode: "queue", name: "pause", value: id },
      resume: { mode: "queue", name: "resume", value: id },
      remove: { mode: "queue", name: "delete", value: id, del_files: del },
      retry: { mode: "retry", value: id },
      "remove-history": { mode: "history", name: "delete", value: id, del_files: del },
      "speed-limit": { mode: "config", name: "speedlimit", value: String(p.value ?? "100") },
      "pause-for": { mode: "config", name: "set_pause", value: String(p.value ?? "0") },
      priority: {
        mode: "queue",
        name: "priority",
        value: id,
        value2: PRIORITY[String(p.value)] ?? "0",
      },
      move: { mode: "switch", value: id, value2: String(p.value ?? "0") },
      category: { mode: "change_cat", value: id, value2: String(p.category ?? "*") },
    };
    // A retried plan must not act on a job or setting that changed since it was approved.
    if (op === "priority" || op === "move" || op === "category") {
      const now = await this.read(service);
      const j = now.queue.find((x) => x.id === id);
      const was =
        op === "priority"
          ? (j?.priority ?? "Normal")
          : op === "move"
            ? `place ${now.queue.findIndex((x) => x.id === id) + 1}`
            : (j?.category ?? "none");
      if (!j || (p.before !== undefined && String(p.before) !== was))
        return {
          ok: false,
          stale: true,
          result: j
            ? `${name} changed since this was planned (now ${was}); nothing was changed.`
            : `${name} is no longer in the queue.`,
        };
    }
    await this.use(service, `${op} in SABnzbd`, "change", (key) =>
      call(this.fetchImpl, service.localUrl, key, params[op as keyof typeof params]),
    );
    const d = await this.read(service);
    const job = d.queue.find((j) => j.id === id);
    const verified =
      op === "speed-limit"
        ? (d.speedLimitPct ?? 100) === Number(p.value)
        : op === "pause-for"
          ? d.paused
          : op === "priority"
            ? (job?.priority ?? "").toLowerCase() === String(p.value)
            : op === "move"
              ? d.queue.findIndex((j) => j.id === id) === Number(p.value)
              : op === "category"
                ? (job?.category ?? "*") === String(p.category)
                : op === "pause-all"
                  ? d.paused
                  : op === "resume-all"
                    ? !d.paused
                    : op === "pause"
                      ? Boolean(job && /paused/i.test(job.status))
                      : op === "resume"
                        ? Boolean(job && !/paused/i.test(job.status))
                        : op === "remove"
                          ? !job
                          : op === "retry"
                            ? !d.history.some((j) => j.id === id && j.failed)
                            : !d.history.some((j) => j.id === id);
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, verified, ...(op.startsWith("remove") ? { deleteFiles: del === "1" } : {}) },
    });
    const said: Record<Exclude<Op, "add" | "clear-warnings">, string> = {
      "pause-all": "All downloads are paused.",
      "resume-all": "Downloads are running again.",
      pause: `${name} is paused.`,
      resume: `${name} is downloading again.`,
      remove: `${name} is out of the queue.`,
      retry: `${name} is being tried again.`,
      "remove-history": `${name} is out of the history.`,
      "speed-limit":
        String(p.value) === "100"
          ? "Downloads run at full speed."
          : `Downloads are limited to ${String(p.value)}%.`,
      "pause-for": `Downloads are paused for ${String(p.value)} minutes, then resume by themselves.`,
      priority: `${name} has ${String(p.value)} priority.`,
      move: `${name} is at place ${Number(p.value) + 1} in the queue.`,
      category: `${name} is in ${String(p.category) === "*" ? "no category" : `the ${String(p.category)} category`}.`,
    };
    return verified
      ? { ok: true, result: `${said[op as keyof typeof said]} SABnzbd confirms it.` }
      : { ok: false, result: `SABnzbd answered, but it does not show that yet (${op}).` };
  }
}
