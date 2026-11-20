import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import {
  DELUGE_PREFS,
  DelugeError,
  DelugeSession,
  fieldsFor,
  showPref,
  toTorrent,
  type RawTorrent,
} from "./deluge";
import type { Fetch } from "./http";
import { magnetHash } from "./qbittorrent-control";

/**
 * Changes to Deluge, each a plan the owner approves (app-deluge-control, params.op), carried out
 * through Deluge's Web UI API and read back before they count as done. The same everyday controls
 * as qBittorrent's panel: pause, resume, recheck, ask the trackers again, queue order, remove
 * (keeping or deleting files), add torrents, labels (Deluge's categories, from its Label plugin),
 * which files download, and the global speed, queue and seeding settings. Never the Web UI
 * password, ports, the proxy, or download folders (Sonarr and Radarr import from them).
 */

export const DELUGE_OPS = [
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
  "label-create",
  "label-delete",
  "labels-on",
  "file-priority",
  "settings",
] as const;
export type DelugeOp = (typeof DELUGE_OPS)[number];

const HASH = /^[a-f0-9]{40}$/;

type Service = { id: string; name: string; localUrl: string };

class Refused extends Error {}

export class DelugeOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (s: DelugeSession) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      async ({ value }) => fn(await DelugeSession.open(service.localUrl, value, this.fetchImpl)),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as DelugeOp;
    if (!DELUGE_OPS.includes(op)) throw new Error(`Say what to do: ${DELUGE_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Deluge", "read", (s) =>
      planDeluge(s, service.name, op, params ?? {}, base),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Deluge", "change", (s) =>
        runDeluge(s, service.name, p),
      );
    } catch (error) {
      if (!(error instanceof DelugeError) && !(error instanceof Refused)) throw error;
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

  /** Puts a label or a setting back when a later step of the same plan failed. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    if (p.op === "label" && typeof p.before === "string")
      return this.use(service, "put a Deluge label back", "change", async (s) => {
        await s.call("label.set_torrent", [String(p.hash), p.before]);
        return { ok: true, result: `The label is back to ${p.before || "none"}.` };
      });
    if (p.op === "settings" && typeof p.body === "string")
      return this.use(service, "put Deluge's settings back", "change", async (s) => {
        await s.call("core.set_config", [
          (JSON.parse(p.body as string) as { before: object }).before,
        ]);
        return { ok: true, result: "Deluge's settings are back as they were." };
      });
    if (["pause", "resume"].includes(String(p.op)))
      return this.use(service, "undo a pause or resume in Deluge", "change", async (s) => {
        await s.call(p.op === "pause" ? "core.resume_torrent" : "core.pause_torrent", [
          [String(p.hash)],
        ]);
        return { ok: true, result: `Undone: ${p.op === "pause" ? "resumed" : "paused"} again.` };
      });
    return undefined;
  }
}

/** One torrent as Deluge has it now (undefined: it is not there). */
async function torrent(s: DelugeSession, hash: string, labels: boolean) {
  const r = await s.call<RawTorrent>("core.get_torrent_status", [hash, fieldsFor(labels)]);
  return r && Object.keys(r).length ? toTorrent(hash, r) : undefined;
}

const labelsOn = async (s: DelugeSession) =>
  (await s.call<string[]>("core.get_enabled_plugins").catch(() => [] as string[])).includes(
    "Label",
  );

const LABEL = /^[a-z0-9_-]{1,60}$/;

export async function planDeluge(
  s: DelugeSession,
  name: string,
  op: DelugeOp,
  p: StepParams,
  base: PlannedStep,
): Promise<PlannedStep> {
  const labels = await labelsOn(s);
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
    const file = files.length > 0;
    if (!urls.length && !file)
      throw new Error("Give a magnet link, a .torrent address, or a .torrent file.");
    if (urls.length > 10) throw new Error("At most 10 links at once.");
    for (const u of urls)
      if (!/^magnet:\?/i.test(u) && !/^https?:\/\//i.test(u))
        throw new Error("Only magnet links and http or https .torrent addresses can be added.");
    const label = String(p.category ?? "");
    if (label && !labels)
      throw new Error("Deluge's Label plugin is off: turn it on first to add with a label.");
    if (label && !LABEL.test(label))
      throw new Error("A Deluge label is lower-case letters, digits, - and _.");
    const count = urls.length + files.length;
    const what =
      files.length === 1 && !urls.length
        ? `the file ${files[0]!.name.slice(0, 80)}`
        : `${count} ${count === 1 ? (urls.length ? "link" : "file") : "torrents"}`;
    return step(
      `Add ${what} to ${name}${label ? ` with the label ${label}` : ""}${p.paused === true ? ", paused" : ""}`,
      {
        name: "Torrents",
        before: "not in Deluge",
        after: `added${p.paused === true ? " (paused)" : ""}`,
      },
      {
        ...(urls.length ? { urls: urls.join("\n") } : {}),
        ...(file
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

  if (op === "labels-on") {
    if (labels) throw new Error("Deluge's Label plugin is already on.");
    return step(
      `Turn on ${name}'s Label plugin (labels sort torrents, as categories do in qBittorrent)`,
      {
        name: "Label plugin",
        before: "off",
        after: "on",
      },
    );
  }

  if (op === "label-create" || op === "label-delete") {
    if (!labels) throw new Error("Deluge's Label plugin is off: turn it on first.");
    const label = String(p.category ?? "")
      .trim()
      .toLowerCase();
    if (!LABEL.test(label))
      throw new Error("A Deluge label is lower-case letters, digits, - and _.");
    const all = await s.call<string[]>("label.get_labels");
    if (op === "label-create") {
      if (all.includes(label)) throw new Error(`${name} already has the label ${label}.`);
      return step(
        `Make the label ${label} in ${name}`,
        { name: "Labels", before: "not there", after: label },
        { category: label },
      );
    }
    if (!all.includes(label)) throw new Error(`${name} has no label ${label}.`);
    const ui = await s.call<{ torrents?: Record<string, RawTorrent> }>("web.update_ui", [
      ["label"],
      {},
    ]);
    const using = Object.values(ui.torrents ?? {}).filter((t) => t.label === label).length;
    if (using)
      throw new Error(
        `${using} ${using === 1 ? "torrent has" : "torrents have"} the label ${label}: change them first, so nothing loses its label by surprise.`,
      );
    return step(
      `Remove the label ${label} from ${name}`,
      { name: "Labels", before: label, after: "removed" },
      { category: label },
    );
  }

  if (op === "settings") {
    let want: Record<string, unknown>;
    try {
      want = JSON.parse(String(p.body ?? "{}")) as Record<string, unknown>;
    } catch {
      throw new Error("Give the settings as JSON.");
    }
    const config = await s.call<Record<string, unknown>>("core.get_config");
    const changes: { key: string; value: boolean | number }[] = [];
    for (const [key, value] of Object.entries(want)) {
      const pref = DELUGE_PREFS[key];
      if (!pref)
        throw new Error(
          `Hearth does not change ${key} in Deluge (only speed, queue and seeding settings).`,
        );
      const v = pref.type === "bool" ? value === true || value === "true" : Number(value);
      if (pref.type !== "bool" && !Number.isFinite(v as number))
        throw new Error(`${pref.label} needs a number.`);
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
        // The values before ride in the same JSON: a long list would not fit a short parameter.
        body: JSON.stringify({
          set: Object.fromEntries(changes.map((c) => [c.key, c.value])),
          before,
        }),
      },
      change: {
        summary: `${name}'s settings`,
        settings: changes.map((c) => ({
          name: DELUGE_PREFS[c.key]!.label,
          before: showPref(c.key, config[c.key]),
          after: showPref(c.key, c.value),
        })),
      },
    };
  }

  // Everything else is about one torrent.
  const hash = String(p.hash ?? "").toLowerCase();
  if (!HASH.test(hash)) throw new Error("Say which torrent (its hash).");
  const t = await torrent(s, hash, labels);
  if (!t) throw new Error(`${name} has no such torrent.`);
  const extra = { hash, name: t.name.slice(0, 120) };
  switch (op) {
    case "pause":
      if (t.state === "Paused") throw new Error(`${t.name} is already paused.`);
      return step(
        `Pause ${t.name} in ${name}`,
        { name: t.name, before: t.state, after: "Paused" },
        extra,
      );
    case "resume":
      if (t.state !== "Paused") throw new Error(`${t.name} is not paused.`);
      return step(
        `Resume ${t.name} in ${name}`,
        { name: t.name, before: "Paused", after: "running" },
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
        throw new Error(`${t.name} is not in Deluge's queue (finished torrents are not queued).`);
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
          before: "in Deluge",
          after: op === "remove" ? "removed, files kept" : "removed, files deleted",
        },
        extra,
      );
    case "label": {
      if (!labels) throw new Error("Deluge's Label plugin is off: turn it on first.");
      const label = String(p.category ?? "")
        .trim()
        .toLowerCase();
      if (label) {
        const all = await s.call<string[]>("label.get_labels");
        if (!all.includes(label)) throw new Error(`${name} has no label ${label}: make it first.`);
      }
      if ((t.category ?? "") === label)
        throw new Error(`${t.name} already has ${label ? `the label ${label}` : "no label"}.`);
      return step(
        label ? `Label ${t.name} ${label} in ${name}` : `Take ${t.name}'s label off in ${name}`,
        { name: t.name, before: t.category || "no label", after: label || "no label" },
        { ...extra, category: label, before: t.category ?? "" },
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
      const words = { 0: "do not download", 1: "normal", 6: "high", 7: "highest" }[
        priority as 0 | 1 | 6 | 7
      ];
      return step(
        `Set ${files.length} ${files.length === 1 ? "file" : "files"} of ${t.name} to ${words} in ${name}`,
        { name: t.name, before: "as they are", after: words },
        { ...extra, fileIndexes: files.join(","), filePriority: priority },
      );
    }
    default:
      throw new Error(`Say what to do: ${DELUGE_OPS.join(", ")}.`);
  }
}

/** Deluge's priorities for the panel's 0, 1, 6, 7 (Deluge's normal is 4). */
const DELUGE_PRIORITY: Record<number, number> = { 0: 0, 1: 4, 6: 6, 7: 7 };

export async function runDeluge(
  s: DelugeSession,
  name: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as DelugeOp;
  const hash = String(p.hash ?? "");
  const labels = await labelsOn(s);
  const done = (result: string): StepOutcome => ({ ok: true, verified: true, result });
  const now = () => torrent(s, hash, labels);

  if (op === "add") {
    const opts = { ...(p.paused === true ? { add_paused: true } : {}) };
    const added: string[] = [];
    const files = p.files ? (JSON.parse(String(p.files)) as { name: string; data: string }[]) : [];
    for (const f of files) {
      try {
        added.push(await s.call<string>("core.add_torrent_file", [f.name, f.data, opts]));
      } catch (error) {
        // Already in Deluge (a plan run twice): counted, not added twice.
        if (!(error instanceof DelugeError && /already in session/i.test(error.message)))
          throw error;
      }
    }
    for (const u of String(p.urls ?? "")
      .split("\n")
      .filter(Boolean)) {
      if (/^magnet:/i.test(u)) {
        const known = magnetHash(u);
        // Already in Deluge (a plan run twice): counted, not added again.
        if (known && (await torrent(s, known, labels))) {
          added.push(known);
          continue;
        }
        added.push(await s.call<string>("core.add_torrent_magnet", [u, opts]));
      } else added.push(await s.call<string>("core.add_torrent_url", [u, opts]));
    }
    const hashes = added.filter((h): h is string => typeof h === "string" && HASH.test(h));
    if (!hashes.length)
      return {
        ok: false,
        result: `${name} did not add it (it may be in Deluge already, or the link was not a torrent).`,
      };
    if (p.category)
      for (const h of hashes) await s.call("label.set_torrent", [h, String(p.category)]);
    const there = await Promise.all(hashes.map((h) => torrent(s, h, labels)));
    const missing = there.filter((t) => !t).length;
    return missing
      ? { ok: false, result: `${name} answered, but ${missing} of the torrents do not show in it.` }
      : done(
          `Added ${hashes.length} ${hashes.length === 1 ? "torrent" : "torrents"} to ${name} (read back).`,
        );
  }

  if (op === "labels-on") {
    await s.call("core.enable_plugin", ["Label"]);
    return (await labelsOn(s))
      ? done(`${name}'s Label plugin is on (read back).`)
      : { ok: false, result: `${name} answered, but its Label plugin is still off.` };
  }

  if (op === "label-create" || op === "label-delete") {
    const label = String(p.category);
    await s.call(op === "label-create" ? "label.add" : "label.remove", [label]);
    const all = await s.call<string[]>("label.get_labels");
    const there = all.includes(label);
    return there === (op === "label-create")
      ? done(
          op === "label-create"
            ? `Made the label ${label} (read back).`
            : `Removed the label ${label} (read back).`,
        )
      : {
          ok: false,
          result: `${name} answered, but the label ${label} is ${there ? "still there" : "not there"}.`,
        };
  }

  if (op === "settings") {
    const { set: want, before } = JSON.parse(String(p.body)) as {
      set: Record<string, unknown>;
      before: Record<string, unknown>;
    };
    const config = await s.call<Record<string, unknown>>("core.get_config");
    // Someone changed one of these in Deluge since: nothing is changed.
    if (Object.entries(before).some(([k, v]) => config[k] !== v))
      return {
        ok: false,
        stale: true,
        result: `${name}'s settings changed since this was planned; nothing was changed.`,
      };
    await s.call("core.set_config", [want]);
    const after = await s.call<Record<string, unknown>>("core.get_config");
    const off = Object.entries(want).filter(([k, v]) => after[k] !== v);
    return off.length
      ? {
          ok: false,
          result: `${name} answered, but ${off.length} of the settings do not read back as approved.`,
        }
      : done(`${name}'s settings are changed (read back).`);
  }

  // One torrent: it must still be the one that was planned.
  const t = await now();
  if (!t) {
    if (op === "remove" || op === "remove-with-data")
      return done(`${p.name ?? "It"} is not in ${name} any more.`);
    return {
      ok: false,
      stale: true,
      result: `${name} no longer has ${p.name ?? "that torrent"}; nothing was changed.`,
    };
  }
  switch (op) {
    case "pause":
    case "resume": {
      await s.call(op === "pause" ? "core.pause_torrent" : "core.resume_torrent", [[hash]]);
      const after = await now();
      const paused = after?.state === "Paused";
      return paused === (op === "pause")
        ? done(
            op === "pause"
              ? `Paused ${t.name} (read back).`
              : `${t.name} is running again (read back: ${after?.state}).`,
          )
        : { ok: false, result: `${name} answered, but ${t.name} is ${after?.state ?? "gone"}.` };
    }
    case "recheck":
      await s.call("core.force_recheck", [[hash]]);
      return done(`${name} is checking ${t.name}'s files against the disk.`);
    case "reannounce":
      await s.call("core.force_reannounce", [[hash]]);
      return done(`${name} asked ${t.name}'s trackers again.`);
    case "queue-top":
    case "queue-up":
    case "queue-down":
    case "queue-bottom": {
      await s.call(`core.${op.replace("-", "_")}`, [[hash]]);
      const after = await now();
      return done(
        `${t.name} is at place ${after?.queuePosition ?? "?"} in ${name}'s queue (read back).`,
      );
    }
    case "remove":
    case "remove-with-data": {
      await s.call("core.remove_torrent", [hash, op === "remove-with-data"]);
      return (await now())
        ? { ok: false, result: `${name} answered, but ${t.name} is still there.` }
        : done(
            op === "remove"
              ? `Removed ${t.name} from ${name}; its files stay on disk (read back).`
              : `Removed ${t.name} from ${name} and deleted its files (read back).`,
          );
    }
    case "label": {
      const label = String(p.category ?? "");
      if (typeof p.before === "string" && (t.category ?? "") !== p.before)
        return {
          ok: false,
          stale: true,
          result: `${t.name}'s label changed since this was planned; nothing was changed.`,
        };
      await s.call("label.set_torrent", [hash, label]);
      const after = await now();
      return (after?.category ?? "") === label
        ? done(
            label
              ? `${t.name} has the label ${label} (read back).`
              : `${t.name} has no label now (read back).`,
          )
        : {
            ok: false,
            result: `${name} answered, but ${t.name}'s label reads ${after?.category || "none"}.`,
          };
    }
    case "file-priority": {
      const files = String(p.fileIndexes).split(",").map(Number);
      const current =
        (
          await s.call<{ file_priorities?: number[] }>("core.get_torrent_status", [
            hash,
            ["file_priorities"],
          ])
        ).file_priorities ?? [];
      const want = current.map((v, i) =>
        files.includes(i) ? DELUGE_PRIORITY[Number(p.filePriority)]! : v,
      );
      if (files.some((i) => i >= current.length))
        return {
          ok: false,
          stale: true,
          result: `${t.name} has fewer files than planned; nothing was changed.`,
        };
      await s.call("core.set_torrent_options", [[hash], { file_priorities: want }]);
      const after =
        (
          await s.call<{ file_priorities?: number[] }>("core.get_torrent_status", [
            hash,
            ["file_priorities"],
          ])
        ).file_priorities ?? [];
      return files.every((i) => after.at(i) === want.at(i))
        ? done(
            `Set ${files.length} ${files.length === 1 ? "file" : "files"} of ${t.name} (read back).`,
          )
        : {
            ok: false,
            result: `${name} answered, but the files' priorities do not read back as approved.`,
          };
    }
    default:
      throw new Refused(`Unknown Deluge change: ${op}.`);
  }
}
