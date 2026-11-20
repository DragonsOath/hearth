import type { NzbgetDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { nzbgetDashboard, NzbgetError, PRIORITY, rpc, type NzbgetLogin } from "./nzbget";

/**
 * Changes to NZBGet, each a plan the owner approves (app-nzbget-control, params.op), with the same
 * operations and words as SABnzbd's panel: pause or resume everything or one download, pause for a
 * while (it resumes by itself), the speed limit, a download's priority, place and category, remove
 * one from the queue or the history, retry a failed one, and add NZBs (links or files). Each is read
 * back from NZBGet. Its settings (news servers and their passwords, folders, scripts) stay in
 * NZBGet.
 */

export const NZBGET_OPS = [
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
] as const;
type Op = (typeof NZBGET_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

const NZB_MAX_BYTES = 4 * 1024 * 1024;
const NZB_NAME = /\.(nzb|nzb\.gz|gz|zip)$/i;
const jobNameOf = (filename: string) => filename.replace(NZB_NAME, "");

/** Uploaded .nzb files in a plan's params: name and base64 bytes, at most 5, 4 MB each. */
function nzbUploads(params?: StepParams): { filename: string; data: string }[] {
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
    const bytes = Buffer.from(f.data, "base64");
    if (bytes.byteLength > NZB_MAX_BYTES) throw new Error(`${filename} is larger than 4 MB.`);
    if (/\.nzb$/i.test(filename) && !/<nzb[\s>]/i.test(bytes.subarray(0, 8192).toString("utf8")))
      throw new Error(`${filename} does not look like an NZB file.`);
    return { filename, data: f.data };
  });
}

/** An NZB link as shown in a plan: never its query (indexer links carry their API key there). */
function linkShown(link: string) {
  const u = new URL(link);
  return `${u.host}${u.pathname}${u.search ? "?…" : ""}`;
}

function nzbLinks(params?: StepParams): string[] {
  const text = typeof params?.urls === "string" ? params.urls : "";
  const links = text
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const l of links)
    if (!URL.canParse(l) || !/^https?:$/.test(new URL(l).protocol))
      throw new Error("Each NZB link must be an http or https address.");
  return links;
}

const speedWords = (kbps: number) =>
  kbps <= 0
    ? "no limit"
    : kbps >= 1024
      ? `${Math.round((kbps / 1024) * 10) / 10} MB/s`
      : `${kbps} KB/s`;

export class NzbgetOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (login: NzbgetLogin) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) => fn({ username: username ?? "", password: value }),
    );
  }

  private read(service: Service) {
    return this.use(service, "read NZBGet's queue and history", "read", (l) =>
      nzbgetDashboard(this.fetchImpl, service.localUrl, l),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!NZBGET_OPS.includes(op)) throw new Error(`Say what to do: ${NZBGET_OPS.join(", ")}.`);
    const d = await this.read(service);
    if (op === "add") return planAdd(service, params, base, d);
    const id = typeof params?.nzoId === "string" ? params.nzoId : "";
    const job = d.queue.find((j) => j.id === id);
    const done = d.history.find((j) => j.id === id);
    let label: string;
    let extra: Record<string, string> = {};
    if (op === "pause-all") {
      if (d.paused) throw new Error("NZBGet is already paused.");
      label = `Pause all downloads in ${service.name}`;
    } else if (op === "resume-all") {
      if (!d.paused) throw new Error("NZBGet is not paused.");
      label = `Resume all downloads in ${service.name}`;
    } else if (op === "pause" || op === "resume" || op === "remove") {
      if (!job) throw new Error("That download is no longer in the queue.");
      if (op === "pause" && /paused/i.test(job.status))
        throw new Error(`${job.name} is already paused.`);
      if (op === "resume" && !/paused/i.test(job.status))
        throw new Error(`${job.name} is not paused.`);
      label =
        op === "remove"
          ? `Remove ${job.name} from the queue in ${service.name} (it moves to the history as deleted)`
          : `${op === "pause" ? "Pause" : "Resume"} ${job.name} in ${service.name}`;
    } else if (op === "speed-limit") {
      const kbps = Number(params?.value);
      if (!Number.isInteger(kbps) || kbps < 0 || kbps > 10_000_000)
        throw new Error("The speed limit is in KB/s, a whole number (0 = no limit).");
      const now = d.speedLimitKbps ?? 0;
      if (now === kbps) throw new Error(`NZBGet's speed limit is already ${speedWords(kbps)}.`);
      label = `${kbps ? `Limit downloads to ${speedWords(kbps)}` : "Remove the speed limit"} in ${service.name}`;
      extra = { value: String(kbps), before: speedWords(now) };
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
        if (PRIORITY[want] === undefined)
          throw new Error("Priority is force, high, normal or low.");
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
        extra = { category: cat, before: job.category ?? "none" };
      }
    } else {
      if (!done) throw new Error("That download is no longer in the history.");
      if (op === "retry" && !done.failed) throw new Error(`${done.name} did not fail.`);
      label =
        op === "retry"
          ? `Retry ${done.name} in ${service.name} (it failed: ${done.why ?? "no reason given"}); NZBGet downloads it again`
          : `Remove ${done.name} from the history in ${service.name} (its files stay)`;
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...(id ? { nzoId: id, name: (job ?? done)?.name ?? "" } : {}), ...extra },
      change: {
        summary: label,
        settings: [
          {
            name: (job ?? done)?.name ?? "Downloads",
            before:
              extra.before ?? (d.paused ? "paused" : (job?.status ?? done?.status ?? "running")),
            after:
              op === "speed-limit"
                ? speedWords(Number(extra.value))
                : op === "pause-for"
                  ? `paused for ${extra.value} min, then downloading again`
                  : op === "priority"
                    ? `${extra.value} priority`
                    : op === "move"
                      ? `place ${Number(extra.value) + 1}`
                      : op === "category"
                        ? extra.category || "no category"
                        : op,
          },
        ],
      },
    };
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    let out: StepOutcome;
    try {
      out =
        op === "add"
          ? await this.runAdd(p, service)
          : await this.use(service, `${op} in NZBGet`, "change", (l) =>
              runOne(this.fetchImpl, service, l, p),
            );
    } catch (error) {
      if (!(error instanceof NzbgetError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? op} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: out.ok, nzoId: p.nzoId ?? null },
    });
    return out;
  }

  /** Puts back a pause, resume, priority or category when a later step of the plan failed. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const back: Partial<Record<Op, Op>> = {
      "pause-all": "resume-all",
      "resume-all": "pause-all",
      pause: "resume",
      resume: "pause",
    };
    const op = back[String(p.op) as Op];
    if (op)
      return this.use(service, "undo a change in NZBGet", "change", (l) =>
        runOne(this.fetchImpl, service, l, { ...p, op }),
      );
    const before = typeof p.before === "string" ? p.before : undefined;
    if ((p.op === "priority" || p.op === "category") && before !== undefined) {
      // Back to the value before; no staleness check: it was just changed by this plan.
      const { before: _was, ...rest } = p;
      void _was;
      return this.use(service, "undo a change in NZBGet", "change", (l) =>
        runOne(this.fetchImpl, service, l, {
          ...rest,
          ...(p.op === "priority"
            ? { value: before.toLowerCase() }
            : { category: before === "none" ? "" : before }),
        }),
      );
    }
    return undefined;
  }

  /** Adds the NZBs, then reads each new job back by the id NZBGet gave it. */
  private async runAdd(p: StepParams, service: Service): Promise<StepOutcome> {
    const links = nzbLinks(p);
    const files = nzbUploads(p);
    const before = await this.read(service);
    const nzbName = typeof p.nzbName === "string" ? p.nzbName : "";
    // A retried plan must not add a file a second time.
    const queued = new Set(before.queue.map((j) => j.name.toLowerCase()));
    const fresh = files.filter(
      (f) => !queued.has((nzbName || jobNameOf(f.filename)).toLowerCase()),
    );
    const category = typeof p.category === "string" ? p.category : "";
    const priority = typeof p.value === "string" ? (PRIORITY[p.value] ?? 0) : 0;
    const paused = p.paused === true;
    const ids = await this.use(service, "add NZBs to NZBGet", "change", async (l) => {
      const got: number[] = [];
      const add = async (name: string, content: string) =>
        got.push(
          await rpc<number>(this.fetchImpl, service.localUrl, l, "append", [
            name,
            content,
            category,
            priority,
            false,
            paused,
            "",
            0,
            "SCORE",
            [],
          ]),
        );
      for (const link of links) await add(nzbName || "", link);
      for (const f of fresh) await add(nzbName ? `${nzbName}.nzb` : f.filename, f.data);
      return got;
    });
    const after = await this.read(service);
    const there = ids.filter(
      (id) =>
        id > 0 &&
        (after.queue.some((j) => j.id === String(id)) ||
          after.history.some((h) => h.id === String(id))),
    );
    const skipped = files.length - fresh.length;
    const total = links.length + fresh.length;
    const skippedText = skipped
      ? ` ${skipped} file${skipped === 1 ? " was" : "s were"} already in the queue and not added again.`
      : "";
    if (!total) return { ok: true, result: `Nothing new to add.${skippedText}` };
    return there.length === total
      ? {
          ok: true,
          verified: true,
          result: `${total === 1 ? "The NZB is" : `${total} NZBs are`} in ${service.name}. NZBGet confirms it.${skippedText}`,
        }
      : {
          ok: false,
          result: `NZBGet took the request, but shows ${there.length} of ${total} added. Check its queue and warnings.${skippedText}`,
        };
  }
}

function planAdd(
  service: Service,
  params: StepParams | undefined,
  base: PlannedStep,
  d: NzbgetDashboard,
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
  if (priority && PRIORITY[priority] === undefined)
    throw new Error("Priority is force, high, normal or low.");
  const paused = params?.paused === true;
  const nzbName =
    typeof params?.nzbName === "string" ? params.nzbName.trim().replace(/[\\/]/g, "_") : "";
  if (nzbName && count > 1) throw new Error("A name can only be given when adding one NZB.");
  if (nzbName.length > 200) throw new Error("The name is longer than 200 characters.");
  const queued = new Set(d.queue.map((j) => j.name.toLowerCase()));
  const names = files.map((f) => jobNameOf(f.filename).toLowerCase());
  const twice = names.find((x, i) => names.indexOf(x) !== i);
  if (twice) throw new Error(`${twice} is chosen twice.`);
  const already = files.find((f) => queued.has((nzbName || jobNameOf(f.filename)).toLowerCase()));
  if (already)
    throw new Error(`${nzbName || jobNameOf(already.filename)} is already in the queue.`);
  const where = category ? `the ${category} category` : "no category";
  const how = paused ? "paused" : priority ? `${priority} priority` : "normal priority";
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
      summary: `${label}: ${where}, ${how}. NZBGet's own duplicate check still applies.`,
      settings: [
        ...links.map((l) => ({
          name: nzbName || linkShown(l),
          before: "not in NZBGet",
          after: `added from the link, ${where}, ${how}`,
        })),
        ...files.map((f) => ({
          name: nzbName || jobNameOf(f.filename),
          before: "not in NZBGet",
          after: `added from your file ${f.filename}, ${where}, ${how}`,
        })),
      ],
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One change, then read back. */
async function runOne(
  fetchImpl: Fetch,
  service: Service,
  l: NzbgetLogin,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as Op;
  const base = service.localUrl;
  const id = Number(p.nzoId);
  const name = String(p.name || "the downloads");
  const call = <T>(method: string, params: unknown[] = []) =>
    rpc<T>(fetchImpl, base, l, method, params);
  const edit = (command: string, param = "") => call<boolean>("editqueue", [command, param, [id]]);
  const now = await nzbgetDashboard(fetchImpl, base, l);
  const job = now.queue.find((j) => j.id === String(id));
  // A retried plan must not act on a job or setting that changed since it was approved.
  if (op === "priority" || op === "move" || op === "category") {
    const was =
      op === "priority"
        ? (job?.priority ?? "Normal")
        : op === "move"
          ? `place ${now.queue.findIndex((x) => x.id === String(id)) + 1}`
          : (job?.category ?? "none");
    if (!job || (p.before !== undefined && String(p.before) !== was))
      return {
        ok: false,
        stale: true,
        result: job
          ? `${name} changed since this was planned (now ${was}); nothing was changed.`
          : `${name} is no longer in the queue.`,
      };
  }
  switch (op) {
    case "pause-all":
      await call("pausedownload");
      break;
    case "resume-all":
      await call("resumedownload");
      break;
    case "pause-for":
      await call("pausedownload");
      await call("scheduleresume", [Number(p.value) * 60]);
      break;
    case "speed-limit":
      await call("rate", [Number(p.value)]);
      break;
    case "pause":
      await edit("GroupPause");
      break;
    case "resume":
      await edit("GroupResume");
      break;
    case "remove":
      await edit("GroupDelete");
      break;
    case "retry":
      await edit("HistoryRedownload");
      break;
    case "remove-history":
      await edit("HistoryDelete");
      break;
    case "priority":
      await edit("GroupSetPriority", String(PRIORITY[String(p.value)] ?? 0));
      break;
    case "move": {
      const at = now.queue.findIndex((x) => x.id === String(id));
      const to = Number(p.value);
      if (to === 0) await edit("GroupMoveTop");
      else if (to === now.queue.length - 1) await edit("GroupMoveBottom");
      else await edit("GroupMoveOffset", String(to - at));
      break;
    }
    case "category":
      await edit("GroupApplyCategory", String(p.category ?? ""));
      break;
  }
  // NZBGet applies some of these a moment later: read back for up to 3 seconds.
  const check = (d: NzbgetDashboard) => {
    const j = d.queue.find((x) => x.id === String(id));
    switch (op) {
      case "pause-all":
      case "pause-for":
        return d.paused;
      case "resume-all":
        return !d.paused;
      case "speed-limit":
        return (d.speedLimitKbps ?? 0) === Number(p.value);
      case "pause":
        return Boolean(j && /paused/i.test(j.status));
      case "resume":
        return Boolean(j && !/paused/i.test(j.status));
      case "remove":
        return !j;
      case "retry":
        return !d.history.some((h) => h.id === String(id) && h.failed);
      case "remove-history":
        return !d.history.some((h) => h.id === String(id));
      case "priority":
        return (j?.priority ?? "").toLowerCase() === String(p.value);
      case "move":
        return d.queue.findIndex((x) => x.id === String(id)) === Number(p.value);
      case "category":
        return (j?.category ?? "") === String(p.category ?? "");
      default:
        return false;
    }
  };
  let after = await nzbgetDashboard(fetchImpl, base, l);
  for (let i = 0; i < 6 && !check(after); i++) {
    await wait(500);
    after = await nzbgetDashboard(fetchImpl, base, l);
  }
  const said: Record<Exclude<Op, "add">, string> = {
    "pause-all": "All downloads are paused.",
    "resume-all": "Downloads are running again.",
    pause: `${name} is paused.`,
    resume: `${name} is downloading again.`,
    remove: `${name} is out of the queue.`,
    retry: `${name} is being tried again.`,
    "remove-history": `${name} is out of the history.`,
    "speed-limit":
      Number(p.value) === 0
        ? "Downloads run at full speed."
        : `Downloads are limited to ${speedWords(Number(p.value))}.`,
    "pause-for": `Downloads are paused for ${String(p.value)} minutes, then resume by themselves.`,
    priority: `${name} has ${String(p.value)} priority.`,
    move: `${name} is at place ${Number(p.value) + 1} in the queue.`,
    category: `${name} is in ${p.category ? `the ${String(p.category)} category` : "no category"}.`,
  };
  return check(after)
    ? { ok: true, verified: true, result: `${said[op as keyof typeof said]} NZBGet confirms it.` }
    : { ok: false, result: `NZBGet answered, but it does not show that yet (${op}).` };
}
