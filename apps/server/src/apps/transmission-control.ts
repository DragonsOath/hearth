import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { magnetHash } from "./qbittorrent-control";
import {
  showPref,
  toTorrent,
  TORRENT_FIELDS,
  TRANSMISSION_PREFS,
  TransmissionError,
  TransmissionSession,
  type RawTorrent,
} from "./transmission";

/**
 * Changes to Transmission, each a plan the owner approves (app-transmission-control, params.op),
 * carried out through its RPC and read back before they count as done. The same everyday controls
 * as qBittorrent's and Deluge's panels: pause, resume, recheck, ask the trackers again, queue
 * order, remove (keeping or deleting files), add torrents, a label (its first label stands for
 * the category), which files download, and the global speed, queue and seeding settings (share
 * ratio and idle limits included). Never the RPC password, whitelist, ports, proxy, blocklist or
 * download folders (Sonarr and Radarr import from them).
 */

export const TRANSMISSION_OPS = [
  "pause",
  "resume",
  "recheck",
  "reannounce",
  "queue-top",
  "queue-up",
  "queue-down",
  "queue-bottom",
  "remove",
  "remove-with-data",
  "add",
  "label",
  "file-priority",
  "settings",
] as const;
export type TransmissionOp = (typeof TRANSMISSION_OPS)[number];

const HASH = /^[a-f0-9]{40}$/;
/** A label: Transmission refuses commas in one. */
const LABEL = /^[^,\n]{1,60}$/;

type Service = { id: string; name: string; localUrl: string };

export class TransmissionOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (s: TransmissionSession) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) =>
        fn(
          new TransmissionSession(
            service.localUrl,
            { username: username ?? "", password: value },
            this.fetchImpl,
          ),
        ),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as TransmissionOp;
    if (!TRANSMISSION_OPS.includes(op))
      throw new Error(`Say what to do: ${TRANSMISSION_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Transmission", "read", (s) =>
      planTransmission(s, service.name, op, params ?? {}, base),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Transmission", "change", (s) =>
        runTransmission(s, service.name, p),
      );
    } catch (error) {
      if (!(error instanceof TransmissionError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, hash: p.hash ?? null },
    });
    return out;
  }

  /** Puts a label, a setting, or a pause back when a later step of the same plan failed. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    if (p.op === "label" && typeof p.before === "string")
      return this.use(service, "put a Transmission label back", "change", async (s) => {
        await s.call("torrent-set", {
          ids: [String(p.hash)],
          labels: JSON.parse(p.before as string) as string[],
        });
        return { ok: true, result: "The labels are back as they were." };
      });
    if (p.op === "settings" && typeof p.body === "string")
      return this.use(service, "put Transmission's settings back", "change", async (s) => {
        await s.call(
          "session-set",
          (JSON.parse(p.body as string) as { before: Record<string, unknown> }).before,
        );
        return { ok: true, result: "Transmission's settings are back as they were." };
      });
    if (p.op === "pause" || p.op === "resume")
      return this.use(service, "undo a pause or resume in Transmission", "change", async (s) => {
        await s.call(p.op === "pause" ? "torrent-start" : "torrent-stop", {
          ids: [String(p.hash)],
        });
        return { ok: true, result: `Undone: ${p.op === "pause" ? "resumed" : "paused"} again.` };
      });
    return undefined;
  }
}

/** One torrent as Transmission has it now, with its raw labels (undefined: it is not there). */
async function torrent(s: TransmissionSession, hash: string) {
  const r = (
    await s.call<{ torrents?: RawTorrent[] }>("torrent-get", {
      ids: [hash],
      fields: TORRENT_FIELDS,
    })
  ).torrents?.[0];
  return r ? { t: toTorrent(r), labels: r.labels ?? [], status: r.status ?? 0 } : undefined;
}

/** The labels with the first one replaced (or taken off): the others stay. */
export const withLabel = (labels: string[], label: string) => [
  ...(label ? [label] : []),
  ...labels.slice(1).filter((l) => l !== label),
];

export async function planTransmission(
  s: TransmissionSession,
  name: string,
  op: TransmissionOp,
  p: StepParams,
  base: PlannedStep,
): Promise<PlannedStep> {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams = {},
  ) => ({
    ...base,
    label,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: label, settings: [setting] },
  });

  if (op === "add") {
    const urls = String(p.urls ?? "")
      .split(/\s*\n\s*/)
      .map((u) => u.trim())
      .filter(Boolean);
    // Uploaded .torrent files: params.files as JSON [{name, data (base64)}], as the add dialog
    // sends them (or one file as params.body and params.name).
    let files: { name: string; data: string }[] = [];
    try {
      files = p.files ? (JSON.parse(String(p.files)) as typeof files) : [];
    } catch {
      throw new Error("The .torrent files could not be read.");
    }
    if (typeof p.body === "string" && p.body)
      files.push({ name: String(p.name ?? "upload.torrent"), data: p.body });
    files = files.filter((f) => f && typeof f.data === "string" && f.data.length > 0);
    if (files.length > 5) throw new Error("At most 5 .torrent files at once.");
    if (!urls.length && !files.length)
      throw new Error("Give a magnet link, a .torrent address, or a .torrent file.");
    if (urls.length > 10) throw new Error("At most 10 links at once.");
    for (const u of urls)
      if (!/^magnet:\?/i.test(u) && !/^https?:\/\//i.test(u))
        throw new Error("Only magnet links and http or https .torrent addresses can be added.");
    const label = String(p.category ?? "").trim();
    if (label && !LABEL.test(label)) throw new Error("A label is up to 60 characters, no commas.");
    const count = urls.length + files.length;
    const what =
      files.length === 1 && !urls.length
        ? `the file ${files[0]!.name.slice(0, 80)}`
        : `${count} ${count === 1 ? (urls.length ? "link" : "file") : "torrents"}`;
    return step(
      `Add ${what} to ${name}${label ? ` with the label ${label}` : ""}${p.paused === true ? ", paused" : ""}`,
      {
        name: "Torrents",
        before: "not in Transmission",
        after: `added${p.paused === true ? " (paused)" : ""}`,
      },
      {
        ...(urls.length ? { urls: urls.join("\n") } : {}),
        ...(files.length
          ? {
              files: JSON.stringify(
                files.map((f) => ({ name: String(f.name).slice(0, 120), data: f.data })),
              ),
            }
          : {}),
        ...(label ? { category: label } : {}),
        ...(p.paused === true ? { paused: true } : {}),
      },
    );
  }

  if (op === "settings") {
    let want: Record<string, unknown>;
    try {
      want = JSON.parse(String(p.body ?? "{}")) as Record<string, unknown>;
    } catch {
      throw new Error("Give the settings as JSON.");
    }
    const config = await s.call<Record<string, unknown>>("session-get", {
      fields: Object.keys(TRANSMISSION_PREFS),
    });
    const changes: { key: string; value: boolean | number }[] = [];
    for (const [key, value] of Object.entries(want)) {
      const pref = TRANSMISSION_PREFS[key];
      if (!pref)
        throw new Error(
          `Hearth does not change ${key} in Transmission (only speed, queue, seeding and peer settings).`,
        );
      const v = pref.type === "bool" ? value === true || value === "true" : Number(value);
      if (pref.type !== "bool" && (!Number.isFinite(v as number) || (v as number) < 0))
        throw new Error(`${pref.label} needs a number, 0 or more.`);
      if (pref.type === "int" && !Number.isInteger(v))
        throw new Error(`${pref.label} needs a whole number.`);
      if (config[key] !== v) changes.push({ key, value: v as boolean | number });
    }
    if (!changes.length) throw new Error("Nothing would change.");
    const before = Object.fromEntries(changes.map((c) => [c.key, config[c.key]]));
    return {
      ...base,
      label: `Change ${changes.length} ${changes.length === 1 ? "setting" : "settings"} in ${name}`,
      serviceName: name,
      params: {
        op,
        body: JSON.stringify({
          set: Object.fromEntries(changes.map((c) => [c.key, c.value])),
          before,
        }),
      },
      change: {
        summary: `${name}'s settings`,
        settings: changes.map((c) => ({
          name: TRANSMISSION_PREFS[c.key]!.label,
          before: showPref(c.key, config[c.key]),
          after: showPref(c.key, c.value),
        })),
      },
    };
  }

  // Everything else is about one torrent.
  const hash = String(p.hash ?? "").toLowerCase();
  if (!HASH.test(hash)) throw new Error("Say which torrent (its hash).");
  const now = await torrent(s, hash);
  if (!now) throw new Error(`${name} has no such torrent.`);
  const { t, labels, status } = now;
  const extra = { hash, name: t.name.slice(0, 120) };
  switch (op) {
    case "pause":
      if (status === 0) throw new Error(`${t.name} is already paused.`);
      return step(
        `Pause ${t.name} in ${name}`,
        { name: t.name, before: t.state, after: "Stopped" },
        extra,
      );
    case "resume":
      if (status !== 0) throw new Error(`${t.name} is not paused.`);
      return step(
        `Resume ${t.name} in ${name}`,
        { name: t.name, before: "Stopped", after: "running" },
        extra,
      );
    case "recheck":
      return step(
        `Recheck ${t.name}'s files in ${name}`,
        { name: t.name, before: `${t.progressPct}% verified`, after: "checked again from disk" },
        extra,
      );
    case "reannounce":
      return step(
        `Ask ${t.name}'s trackers again in ${name}`,
        { name: t.name, before: t.tracker ?? "its trackers", after: "asked again now" },
        extra,
      );
    case "queue-top":
    case "queue-up":
    case "queue-down":
    case "queue-bottom": {
      if (t.queuePosition === undefined)
        throw new Error(`${t.name} is not waiting in ${name}'s queue.`);
      const where = {
        "queue-top": "first",
        "queue-up": "one place up",
        "queue-down": "one place down",
        "queue-bottom": "last",
      }[op];
      return step(
        `Move ${t.name} ${where} in ${name}'s queue`,
        { name: t.name, before: `place ${t.queuePosition}`, after: where },
        extra,
      );
    }
    case "remove":
    case "remove-with-data":
      return step(
        op === "remove"
          ? `Remove ${t.name} from ${name} (its files stay on disk)`
          : `Remove ${t.name} from ${name} AND delete its files`,
        {
          name: t.name,
          before: "in Transmission",
          after: op === "remove" ? "removed, files kept" : "removed, files deleted",
        },
        extra,
      );
    case "label": {
      const label = String(p.category ?? "").trim();
      if (label && !LABEL.test(label))
        throw new Error("A label is up to 60 characters, no commas.");
      if ((labels[0] ?? "") === label)
        throw new Error(`${t.name} already has ${label ? `the label ${label}` : "no label"}.`);
      return step(
        label ? `Label ${t.name} ${label} in ${name}` : `Take ${t.name}'s label off in ${name}`,
        { name: t.name, before: labels[0] || "no label", after: label || "no label" },
        { ...extra, category: label, before: JSON.stringify(labels) },
      );
    }
    case "file-priority": {
      const files = String(p.fileIndexes ?? p.files ?? "")
        .split(",")
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x >= 0);
      const priority = Number(p.filePriority ?? p.priority);
      if (!files.length) throw new Error("Say which files (their numbers).");
      if (![0, 1, 6, 7].includes(priority))
        throw new Error("A file is 0 (skip), 1 (normal), 6 (high) or 7 (highest).");
      const words = { 0: "do not download", 1: "normal", 6: "high", 7: "high" }[
        priority as 0 | 1 | 6 | 7
      ];
      return step(
        `Set ${files.length} ${files.length === 1 ? "file" : "files"} of ${t.name} to ${words} in ${name}`,
        { name: t.name, before: "as they are", after: words },
        { ...extra, fileIndexes: files.join(","), filePriority: priority },
      );
    }
    default:
      throw new Error(`Say what to do: ${TRANSMISSION_OPS.join(", ")}.`);
  }
}

export async function runTransmission(
  s: TransmissionSession,
  name: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as TransmissionOp;
  const hash = String(p.hash ?? "");
  const done = (result: string): StepOutcome => ({ ok: true, verified: true, result });

  if (op === "add") {
    const label = typeof p.category === "string" && p.category ? [p.category] : undefined;
    const common = {
      ...(p.paused === true ? { paused: true } : {}),
      ...(label ? { labels: label } : {}),
    };
    const hashes: string[] = [];
    const add = async (args: Record<string, unknown>) => {
      const r = await s.call<{
        "torrent-added"?: { hashString?: string };
        "torrent-duplicate"?: { hashString?: string };
      }>("torrent-add", { ...args, ...common });
      // Already in Transmission (a plan run twice): counted, not added twice.
      const h = (r["torrent-added"] ?? r["torrent-duplicate"])?.hashString;
      if (h) hashes.push(h.toLowerCase());
    };
    const files = p.files ? (JSON.parse(String(p.files)) as { name: string; data: string }[]) : [];
    for (const f of files) await add({ metainfo: f.data });
    for (const u of String(p.urls ?? "")
      .split("\n")
      .filter(Boolean)) {
      const known = /^magnet:/i.test(u) ? magnetHash(u) : undefined;
      if (known && (await torrent(s, known))) {
        hashes.push(known);
        continue;
      }
      await add({ filename: u });
    }
    if (!hashes.length)
      return { ok: false, result: `${name} did not add it (the link may not be a torrent).` };
    const there = await Promise.all(hashes.map((h) => torrent(s, h)));
    const missing = there.filter((x) => !x).length;
    return missing
      ? { ok: false, result: `${name} answered, but ${missing} of the torrents do not show in it.` }
      : done(
          `Added ${hashes.length} ${hashes.length === 1 ? "torrent" : "torrents"} to ${name} (read back).`,
        );
  }

  if (op === "settings") {
    const { set: want, before } = JSON.parse(String(p.body)) as {
      set: Record<string, unknown>;
      before: Record<string, unknown>;
    };
    const fields = Object.keys(TRANSMISSION_PREFS);
    const config = await s.call<Record<string, unknown>>("session-get", { fields });
    // Someone changed one of these in Transmission since: nothing is changed.
    if (Object.entries(before).some(([k, v]) => config[k] !== v))
      return {
        ok: false,
        stale: true,
        result: `${name}'s settings changed since this was planned; nothing was changed.`,
      };
    await s.call("session-set", want);
    const after = await s.call<Record<string, unknown>>("session-get", { fields });
    const off = Object.entries(want).filter(([k, v]) => after[k] !== v);
    return off.length
      ? {
          ok: false,
          result: `${name} answered, but ${off.length} of the settings do not read back as approved.`,
        }
      : done(`${name}'s settings are changed (read back).`);
  }

  // One torrent: it must still be the one that was planned.
  const now = await torrent(s, hash);
  if (!now) {
    if (op === "remove" || op === "remove-with-data")
      return done(`${p.name ?? "It"} is not in ${name} any more.`);
    return {
      ok: false,
      stale: true,
      result: `${name} no longer has ${p.name ?? "that torrent"}; nothing was changed.`,
    };
  }
  const { t } = now;
  const ids = [hash];
  switch (op) {
    case "pause":
    case "resume": {
      await s.call(op === "pause" ? "torrent-stop" : "torrent-start", { ids });
      // Transmission starts or stops it a moment later: read back for up to 5 seconds.
      let after = await torrent(s, hash);
      for (let i = 0; i < 10 && after && (after.status === 0) !== (op === "pause"); i++) {
        await new Promise((r) => setTimeout(r, 500));
        after = await torrent(s, hash);
      }
      const stopped = after?.status === 0;
      return stopped === (op === "pause")
        ? done(
            op === "pause"
              ? `Paused ${t.name} (read back).`
              : `${t.name} is running again (read back: ${after?.t.state}).`,
          )
        : { ok: false, result: `${name} answered, but ${t.name} is ${after?.t.state ?? "gone"}.` };
    }
    case "recheck":
      await s.call("torrent-verify", { ids });
      return done(`${name} is checking ${t.name}'s files against the disk.`);
    case "reannounce":
      await s.call("torrent-reannounce", { ids });
      return done(`${name} asked ${t.name}'s trackers again.`);
    case "queue-top":
    case "queue-up":
    case "queue-down":
    case "queue-bottom": {
      await s.call(`queue-move-${op.slice(6)}`, { ids });
      const after = await torrent(s, hash);
      return done(
        `${t.name} is at place ${after?.t.queuePosition ?? "?"} in ${name}'s queue (read back).`,
      );
    }
    case "remove":
    case "remove-with-data": {
      await s.call("torrent-remove", { ids, "delete-local-data": op === "remove-with-data" });
      return (await torrent(s, hash))
        ? { ok: false, result: `${name} answered, but ${t.name} is still there.` }
        : done(
            op === "remove"
              ? `Removed ${t.name} from ${name}; its files stay on disk (read back).`
              : `Removed ${t.name} from ${name} and deleted its files (read back).`,
          );
    }
    case "label": {
      const label = String(p.category ?? "");
      if (typeof p.before === "string" && JSON.stringify(now.labels) !== p.before)
        return {
          ok: false,
          stale: true,
          result: `${t.name}'s labels changed since this was planned; nothing was changed.`,
        };
      await s.call("torrent-set", { ids, labels: withLabel(now.labels, label) });
      const after = await torrent(s, hash);
      return (after?.labels[0] ?? "") === label
        ? done(
            label
              ? `${t.name} has the label ${label} (read back).`
              : `${t.name} has no label now (read back).`,
          )
        : {
            ok: false,
            result: `${name} answered, but ${t.name}'s label reads ${after?.labels[0] || "none"}.`,
          };
    }
    case "file-priority": {
      const files = String(p.fileIndexes).split(",").map(Number);
      const priority = Number(p.filePriority);
      await s.call(
        "torrent-set",
        priority === 0
          ? { ids, "files-unwanted": files }
          : {
              ids,
              "files-wanted": files,
              [priority >= 6 ? "priority-high" : "priority-normal"]: files,
            },
      );
      const after = (
        await s.call<{ torrents?: { fileStats?: { wanted?: boolean; priority?: number }[] }[] }>(
          "torrent-get",
          { ids, fields: ["fileStats"] },
        )
      ).torrents?.[0]?.fileStats;
      const ok = files.every((i) => {
        const f = after?.[i];
        if (!f) return false;
        if (priority === 0) return f.wanted === false;
        return (
          f.wanted !== false && (priority >= 6 ? (f.priority ?? 0) > 0 : (f.priority ?? 0) === 0)
        );
      });
      return ok
        ? done(`${t.name}'s files are set (read back).`)
        : { ok: false, result: `${name} answered, but the files do not read back as approved.` };
    }
    default:
      return { ok: false, result: `Say what to do: ${TRANSMISSION_OPS.join(", ")}.` };
  }
}
