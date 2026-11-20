import type { ActionKind, StepChange, StepParams } from "@dragon-control/core";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { readTorrentFile } from "./torrent-file";

/**
 * Warden's wider control of qBittorrent: its global seeding, speed, and queue
 * settings; one or more torrents' share limits, category, tags, queue priority, and force start;
 * and adding torrents. Each is a plan step the owner approves, through the same broker session
 * as the torrent repairs (the Web UI login never leaves the server). Same pattern:
 *
 * - plan: read the current values now; the plan shows each before and after.
 * - run: read again; anything different from the approved "before" refuses the run. Then one
 *   call, and read back until the new values are seen. "Accepted" is never reported as done.
 * - undo (a later step failed): put the approved "before" values back, where that makes sense.
 *
 * Never through here: the Web UI login and its security, listening ports, proxies, network
 * interfaces, DHT/PeX/encryption, IP filters, save and temp paths, "run a program" settings,
 * and e-mail. Those are refused by name, with the reason, so the owner can decide separately.
 */

export const CONTROL_ACTIONS: readonly ActionKind[] = [
  "app-qbt-set-preferences",
  "app-qbt-set-share-limits",
  "app-qbt-set-category",
  "app-qbt-set-tags",
  "app-qbt-set-priority",
  "app-qbt-force-start",
  "app-qbt-add",
  "app-qbt-file-priority",
  "app-qbt-category",
];

export interface Q {
  get<T>(path: string): Promise<T>;
  post(path: string, body: string): Promise<{ ok: boolean; status: number; text?: string }>;
  postForm(
    path: string,
    fields: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; text?: string }>;
  /** A multipart form with files (a .torrent upload); only where changes are allowed. */
  upload?(
    path: string,
    fields: Record<string, string>,
    files: { field: string; filename: string; type: string; data: Uint8Array }[],
  ): Promise<{ ok: boolean; status: number; text?: string }>;
}

/** Where Sonarr, Radarr and Lidarr send their downloads, read from their own settings. */
export interface ArrCategories {
  used: { app: string; category: string }[];
  /** Apps that could not be read (no key, not answering): their categories are unknown. */
  unchecked: string[];
}

/** What a plan may look up beyond qBittorrent itself. */
export interface ControlDeps {
  arrCategories?: () => Promise<ArrCategories>;
}

export type Session = <T>(
  access: "read" | "change",
  purpose: string,
  fn: (q: Q) => Promise<T>,
) => Promise<T>;

export class PlanRefused extends Error {}

/* ---------- Settings that may change, in plain words ---------- */

type Pref = { label: string; type: "bool" | "number" | "int"; unit?: string; note?: string };

/** The global settings Warden may change. Anything else is refused (see REFUSED). */
export const PREFS: Record<string, Pref> = {
  max_ratio_enabled: { label: "Stop seeding at a share ratio", type: "bool" },
  max_ratio: { label: "Share ratio limit", type: "number" },
  max_seeding_time_enabled: { label: "Stop seeding after a time", type: "bool" },
  max_seeding_time: { label: "Seeding time limit", type: "int", unit: "minutes" },
  max_inactive_seeding_time_enabled: {
    label: "Stop seeding when inactive for a time",
    type: "bool",
  },
  max_inactive_seeding_time: { label: "Inactive seeding limit", type: "int", unit: "minutes" },
  max_ratio_act: {
    label: "When a seeding limit is reached",
    type: "int",
    note: "0 stop, 1 remove the torrent, 2 super seeding, 3 remove the torrent AND delete its files",
  },
  dl_limit: { label: "Download speed limit", type: "int", unit: "bytes/s, 0 = none" },
  up_limit: { label: "Upload speed limit", type: "int", unit: "bytes/s, 0 = none" },
  alt_dl_limit: { label: "Alternative download limit", type: "int", unit: "bytes/s" },
  alt_up_limit: { label: "Alternative upload limit", type: "int", unit: "bytes/s" },
  scheduler_enabled: { label: "Use the alternative limits on a schedule", type: "bool" },
  schedule_from_hour: { label: "Schedule starts (hour)", type: "int" },
  schedule_from_min: { label: "Schedule starts (minute)", type: "int" },
  schedule_to_hour: { label: "Schedule ends (hour)", type: "int" },
  schedule_to_min: { label: "Schedule ends (minute)", type: "int" },
  scheduler_days: {
    label: "Schedule days",
    type: "int",
    note: "0 every day, 1 weekdays, 2 weekends, 3-9 Monday-Sunday",
  },
  queueing_enabled: { label: "Torrent queueing", type: "bool" },
  max_active_downloads: { label: "Most active downloads", type: "int" },
  max_active_uploads: { label: "Most active uploads", type: "int" },
  max_active_torrents: { label: "Most active torrents", type: "int" },
  dont_count_slow_torrents: { label: "Do not count slow torrents in these limits", type: "bool" },
  slow_torrent_dl_rate_threshold: { label: "Slow download threshold", type: "int", unit: "KiB/s" },
  slow_torrent_ul_rate_threshold: { label: "Slow upload threshold", type: "int", unit: "KiB/s" },
  slow_torrent_inactive_timer: { label: "Slow torrent timer", type: "int", unit: "seconds" },
  max_connec: { label: "Most connections overall", type: "int" },
  max_connec_per_torrent: { label: "Most connections per torrent", type: "int" },
  max_uploads: { label: "Most upload slots overall", type: "int" },
  max_uploads_per_torrent: { label: "Most upload slots per torrent", type: "int" },
  preallocate_all: { label: "Pre-allocate disk space", type: "bool" },
  incomplete_files_ext: { label: "Add .!qB to unfinished files", type: "bool" },
};

/** Refused groups, matched by name, with the reason the owner hears. */
const REFUSED: [RegExp, string][] = [
  [/^(web_ui_|bypass_|use_https|ssl_|alternative_webui)/, "the Web UI login and its security"],
  [
    /(proxy|listen_port|random_port|upnp|interface|announce_ip|i2p|outgoing_port|embedded_tracker)/,
    "networking (ports, proxies, interfaces)",
  ],
  [
    /^(dht|pex|lsd|encryption|anonymous_mode|ip_filter|banned_ips|ipfilter)/,
    "privacy and network protocol settings",
  ],
  [
    /(save_path|temp_path|export_dir|scan_dirs|auto_tmm|torrent_changed_tmm|category_changed_tmm|save_path_changed_tmm)/,
    "save paths (Sonarr and Radarr import from them)",
  ],
  [/^autorun/, "running a program when a torrent is added or finishes"],
  [/^mail_/, "e-mail notifications (they hold a password)"],
];

export function refusedReason(key: string): string | undefined {
  return REFUSED.find(([re]) => re.test(key))?.[1];
}

const ACT = [
  "stop",
  "remove the torrent",
  "super seeding",
  "remove the torrent AND delete its files",
];

export function showPref(key: string, value: unknown): string {
  if (value === undefined || value === null) return "not reported";
  const p = PREFS[key];
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (key === "max_ratio_act") return ACT[Number(value)] ?? String(value);
  if (key === "max_ratio" && Number(value) < 0) return "no limit";
  if (/seeding_time$/.test(key) && Number(value) < 0) return "no limit";
  if (/seeding_time$/.test(key)) return minutes(Number(value));
  if (/_limit$/.test(key))
    return Number(value) <= 0 ? "no limit" : `${Math.round(Number(value) / 1024)} KiB/s`;
  return `${value}${p?.unit && !/bytes/.test(p.unit) ? ` ${p.unit}` : ""}`;
}

export function minutes(n: number): string {
  if (n < 0) return "no limit";
  if (n >= 1440 && n % 1440 === 0) return `${n / 1440} day${n === 1440 ? "" : "s"}`;
  if (n >= 60 && n % 60 === 0) return `${n / 60} hour${n === 60 ? "" : "s"}`;
  return `${n} minutes`;
}

/** A share limit as qBittorrent stores it on a torrent: -2 the global setting, -1 none. */
function showLimit(n: number | undefined, kind: "ratio" | "time"): string {
  if (n === undefined) return "not reported";
  if (n === -2) return "the global setting";
  if (n === -1) return "no limit";
  return kind === "ratio" ? `ratio ${n}` : minutes(n);
}

/** The new values the step asks for, checked and typed. */
export function parsePrefs(raw: unknown): Record<string, boolean | number> {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new PlanRefused('params.preferences must be JSON, e.g. {"max_ratio": 2}.');
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new PlanRefused('params.preferences must be an object, e.g. {"max_ratio": 2}.');
  const out: Record<string, boolean | number> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const why = refusedReason(key);
    if (why)
      throw new PlanRefused(
        `"${key}" is one of ${why}. Hearth does not change those through a plan; the owner can change it in qBittorrent, or authorize it separately.`,
      );
    const p = PREFS[key];
    if (!p)
      throw new PlanRefused(
        `"${key}" is not a setting Hearth changes. It can change: ${Object.keys(PREFS).join(", ")}.`,
      );
    if (p.type === "bool") {
      if (typeof value !== "boolean") throw new PlanRefused(`"${key}" must be true or false.`);
      out[key] = value;
    } else {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n))
        throw new PlanRefused(`"${key}" must be a number.`);
      if (p.type === "int" && !Number.isInteger(n))
        throw new PlanRefused(`"${key}" must be a whole number.`);
      if (key === "max_ratio_act" && ![0, 1, 2, 3].includes(n))
        throw new PlanRefused(`"max_ratio_act" is 0, 1, 2, or 3 (${p.note}).`);
      if (n < -1) throw new PlanRefused(`"${key}" cannot be below -1.`);
      out[key] = n;
    }
  }
  if (!Object.keys(out).length) throw new PlanRefused("No settings to change were given.");
  return out;
}

/* ---------- Torrents ---------- */

const HASH = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;

interface Raw {
  hash: string;
  name?: string;
  state?: string;
  category?: string;
  tags?: string;
  priority?: number;
  force_start?: boolean;
  ratio_limit?: number;
  seeding_time_limit?: number;
  inactive_seeding_time_limit?: number;
  added_on?: number;
  save_path?: string;
  auto_tmm?: boolean;
}

/** One hash (params.hash) or several (params.hashes, comma separated, at most 100). */
function hashesOf(params?: StepParams): string[] {
  const list = [
    ...(typeof params?.hash === "string" ? [params.hash] : []),
    ...(typeof params?.hashes === "string" ? params.hashes.split(/[\s,|]+/) : []),
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length)
    throw new PlanRefused(
      "Say which torrents by hash (params.hash, or params.hashes for several).",
    );
  const bad = unique.find((h) => !HASH.test(h));
  if (bad) throw new PlanRefused(`"${bad}" is not a torrent hash.`);
  if (unique.length > 100) throw new PlanRefused("At most 100 torrents in one step.");
  return unique;
}

const tagsOf = (r: Raw) =>
  (r.tags ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
const csv = (v: unknown) =>
  typeof v === "string"
    ? [
        ...new Set(
          v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ]
    : [];

async function read(q: Q, hashes: string[]): Promise<Map<string, Raw>> {
  const list = await q.get<Raw[]>(`/api/v2/torrents/info?hashes=${hashes.join("|")}`);
  return new Map((Array.isArray(list) ? list : []).map((r) => [r.hash.toLowerCase(), r]));
}

/** Text that identifies the approved state of each torrent for this kind. */
function stateOf(kind: ActionKind, r: Raw): string {
  switch (kind) {
    case "app-qbt-set-share-limits":
      return `${r.ratio_limit}|${r.seeding_time_limit}|${r.inactive_seeding_time_limit ?? ""}`;
    case "app-qbt-set-category":
      return r.category ?? "";
    case "app-qbt-set-tags":
      return tagsOf(r).join(",");
    case "app-qbt-force-start":
      return String(Boolean(r.force_start));
    default:
      return String(r.priority ?? 0);
  }
}

const shortList = (names: string[]) =>
  names.length <= 3
    ? names.map((n) => `"${n}"`).join(", ")
    : `${names
        .slice(0, 2)
        .map((n) => `"${n}"`)
        .join(", ")} and ${names.length - 2} more`;

/** Magnet info-hash (hex, or base32 turned into hex), if the link has one. */
export function magnetHash(link: string): string | undefined {
  const m = link.match(/xt=urn:btih:([a-z0-9]+)/i)?.[1];
  if (!m) return undefined;
  if (/^[a-f0-9]{40}$/i.test(m)) return m.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(m)) {
    const A = "abcdefghijklmnopqrstuvwxyz234567";
    let bits = "";
    for (const c of m.toLowerCase()) bits += A.indexOf(c).toString(2).padStart(5, "0");
    return bits
      .match(/.{4}/g)!
      .map((b) => parseInt(b, 2).toString(16))
      .join("");
  }
  return undefined;
}

const magnetName = (link: string) => {
  const dn = link.match(/[?&]dn=([^&]+)/)?.[1];
  try {
    return dn ? decodeURIComponent(dn.replace(/\+/g, " ")) : undefined;
  } catch {
    return dn;
  }
};

/** A link to show in a plan: a magnet by its name, a URL by its host (it can carry a personal key). */
function showLink(link: string): string {
  if (link.startsWith("magnet:"))
    return `magnet ${magnetName(link) ?? magnetHash(link) ?? ""}`.trim();
  try {
    return `a .torrent from ${new URL(link).hostname}`;
  } catch {
    return "a link";
  }
}

/** The folder torrents in this category save into (qBittorrent's default + name when unset). */
function categoryFolder(
  category: string,
  categories: Record<string, { savePath?: string }>,
  defaultPath: string,
): string {
  if (!category) return defaultPath;
  const own = categories[category]?.savePath;
  const root = defaultPath.replace(/[\\/]+$/, "");
  if (own) return /^([a-z]:)?[\\/]/i.test(own) ? own : `${root}/${own}`;
  return `${root}/${category}`;
}

const samePath = (a?: string, b?: string) =>
  (a ?? "").replace(/[\\/]+$/, "") === (b ?? "").replace(/[\\/]+$/, "");

/** Uploaded .torrent files in a plan's params: name and base64 bytes, at most 5. */
function uploadsOf(params?: StepParams): { filename: string; data: Uint8Array }[] {
  if (typeof params?.files !== "string" || !params.files) return [];
  let list: unknown;
  try {
    list = JSON.parse(params.files);
  } catch {
    throw new PlanRefused("The uploaded files could not be read.");
  }
  if (!Array.isArray(list)) throw new PlanRefused("The uploaded files could not be read.");
  if (list.length > 5) throw new PlanRefused("At most 5 .torrent files at once.");
  return list.map((f: { name?: unknown; data?: unknown }) => {
    if (typeof f?.data !== "string") throw new PlanRefused("An uploaded file is empty.");
    return {
      filename: typeof f.name === "string" && f.name ? f.name.slice(0, 200) : "upload.torrent",
      data: new Uint8Array(Buffer.from(f.data, "base64")),
    };
  });
}

const PRIORITY_WORDS: Record<number, string> = {
  0: "Do not download",
  1: "Normal",
  6: "High",
  7: "Maximum",
};

/* ---------- Plan ---------- */

export async function planControl(
  kind: ActionKind,
  service: { name: string },
  params: StepParams | undefined,
  base: PlannedStep,
  session: Session,
  deps: ControlDeps = {},
): Promise<PlannedStep> {
  const done = (change: StepChange, p: StepParams): PlannedStep => ({
    ...base,
    label: change.summary,
    serviceName: service.name,
    params: p,
    change,
  });

  if (kind === "app-qbt-set-preferences") {
    const wanted = parsePrefs(params?.preferences);
    const now = await session("read", "read qBittorrent's settings for a plan", (q) =>
      q.get<Record<string, unknown>>("/api/v2/app/preferences"),
    );
    const missing = Object.keys(wanted).filter((k) => !(k in now));
    if (missing.length)
      throw new PlanRefused(
        `This qBittorrent has no setting ${missing.join(", ")} (it may be an older version).`,
      );
    const changed = Object.keys(wanted).filter((k) => now[k] !== wanted[k]);
    if (!changed.length)
      throw new PlanRefused("qBittorrent already has exactly those settings. Nothing to change.");
    const before = Object.fromEntries(changed.map((k) => [k, now[k]]));
    const after = Object.fromEntries(changed.map((k) => [k, wanted[k]]));
    const settings = changed.map((k) => ({
      name: PREFS[k]!.label,
      before: showPref(k, now[k]),
      after: showPref(k, wanted[k]),
    }));
    const act = after.max_ratio_act;
    if (act === 1 || act === 3)
      settings.push({
        name: "Warning",
        before: "",
        after:
          act === 3
            ? "Every torrent that reaches a limit will be removed AND its downloaded files deleted, automatically and permanently."
            : "Every torrent that reaches a limit will be removed from qBittorrent automatically (its files stay).",
      });
    return done(
      {
        summary: `Change ${changed.length === 1 ? PREFS[changed[0]!]!.label.toLowerCase() : `${changed.length} settings`} in ${service.name}`,
        settings,
      },
      { before: JSON.stringify(before), after: JSON.stringify(after) },
    );
  }

  if (kind === "app-qbt-add") {
    const links = (typeof params?.urls === "string" ? params.urls : "")
      .split(/[\n\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const uploads = uploadsOf(params);
    const files = uploads.map((u) => ({ ...u, info: readTorrentFile(u.data) }));
    const broken = files.find((f) => "error" in f.info);
    if (broken)
      throw new PlanRefused(`${broken.filename}: ${(broken.info as { error: string }).error}`);
    if (!links.length && !files.length)
      throw new PlanRefused(
        "Give magnet links or .torrent URLs (params.urls), or upload .torrent files.",
      );
    if (links.length + files.length > 10) throw new PlanRefused("At most 10 torrents in one step.");
    for (const l of links)
      if (!/^magnet:\?/i.test(l) && !/^https?:\/\//i.test(l))
        throw new PlanRefused("Only magnet links and http(s) .torrent URLs can be added.");
    const category = typeof params?.category === "string" ? params.category.trim() : "";
    const tags = csv(params?.tags);
    const paused = params?.paused === true;
    const { existing, categories, prefs } = await session(
      "read",
      "read qBittorrent for a plan to add torrents",
      async (q) => ({
        existing: await q.get<Raw[]>("/api/v2/torrents/info"),
        categories: await q.get<Record<string, { savePath?: string }>>(
          "/api/v2/torrents/categories",
        ),
        prefs: await q.get<{ save_path?: string }>("/api/v2/app/preferences"),
      }),
    );
    if (category && !categories[category])
      throw new PlanRefused(
        `${service.name} has no category "${category}". It has: ${Object.keys(categories).join(", ") || "none"}.`,
      );
    const have = new Map(existing.map((r) => [r.hash.toLowerCase(), r.name ?? r.hash]));
    const dup = links.map(magnetHash).find((h) => h && have.has(h));
    if (dup) throw new PlanRefused(`${service.name} already has the torrent ${dup}.`);
    const dupFile = files.find((f) => have.has((f.info as { hash: string }).hash));
    if (dupFile)
      throw new PlanRefused(
        `${service.name} already has "${have.get((dupFile.info as { hash: string }).hash)}" (${dupFile.filename}).`,
      );
    // A save folder only from the ones qBittorrent already uses: its default and its categories'.
    // Default folders themselves never change here.
    const defaultPath = prefs.save_path ?? "";
    const savepath = typeof params?.savepath === "string" ? params.savepath.trim() : "";
    const known = new Set(
      [
        defaultPath,
        ...Object.keys(categories).map((c) => categoryFolder(c, categories, defaultPath)),
      ]
        .filter(Boolean)
        .map((x) => x.replace(/[\\/]+$/, "")),
    );
    if (savepath && !known.has(savepath.replace(/[\\/]+$/, "")))
      throw new PlanRefused(
        `"${savepath}" is not one of ${service.name}'s folders. It saves into: ${[...known].join(", ")}.`,
      );
    const where = savepath
      ? savepath
      : category
        ? categoryFolder(category, categories, defaultPath) || "the category's folder"
        : defaultPath || "qBittorrent's default folder";
    return done(
      {
        summary: `Add ${
          links.length + files.length === 1
            ? links.length
              ? showLink(links[0]!)
              : `"${(files[0]!.info as { name: string }).name}"`
            : `${links.length + files.length} torrents`
        } to ${service.name}`,
        settings: [
          ...links.map((l, i) => ({
            name: `Torrent ${i + 1}`,
            before: "Not in qBittorrent",
            after: `${showLink(l)}, ${paused ? "added stopped" : "starts downloading"}`,
          })),
          ...files.map((f, i) => {
            const info = f.info as { name: string; sizeBytes?: number };
            return {
              name: `Torrent ${links.length + i + 1}`,
              before: "Not in qBittorrent",
              after: `"${info.name}"${info.sizeBytes ? ` (${(info.sizeBytes / 1024 ** 3).toFixed(2)} GB)` : ""} from your file ${f.filename}, ${paused ? "added stopped" : "starts downloading"}`,
            };
          }),
          {
            name: "Category and folder",
            before: "",
            after: `${category || "no category"}; saved to ${where}`,
          },
          ...(tags.length ? [{ name: "Tags", before: "", after: tags.join(", ") }] : []),
        ],
      },
      {
        urls: links.join("\n"),
        category,
        tags: tags.join(","),
        paused,
        existing: existing.length,
        ...(files.length
          ? {
              files: JSON.stringify(
                files.map((f) => ({
                  name: f.filename,
                  data: Buffer.from(f.data).toString("base64"),
                  hash: (f.info as { hash: string }).hash,
                })),
              ),
            }
          : {}),
        ...(savepath ? { savepath } : {}),
      },
    );
  }

  if (kind === "app-qbt-category") {
    const action =
      params?.categoryAction === "remove"
        ? "remove"
        : params?.categoryAction === "create"
          ? "create"
          : "";
    const name = typeof params?.category === "string" ? params.category.trim() : "";
    if (!action) throw new PlanRefused('params.categoryAction is "create" or "remove".');
    if (!name || name.length > 100 || /\\|^\/|\/$|\/\//.test(name))
      throw new PlanRefused(
        "Give the category's name (params.category), without slashes at the ends.",
      );
    if (params?.savePath !== undefined && params.savePath !== "")
      throw new PlanRefused(
        "A new category saves where qBittorrent puts categories by default. Choosing a different folder, or changing an existing category's folder, is not done from here: Sonarr and Radarr import from those folders.",
      );
    const { categories, torrents, prefs } = await session(
      "read",
      "read qBittorrent's categories for a plan",
      async (q) => ({
        categories: await q.get<Record<string, { savePath?: string }>>(
          "/api/v2/torrents/categories",
        ),
        torrents: await q.get<Raw[]>("/api/v2/torrents/info"),
        prefs: await q.get<{ save_path?: string }>("/api/v2/app/preferences"),
      }),
    );
    const folder = categoryFolder(name, { [name]: categories[name] ?? {} }, prefs.save_path ?? "");
    if (action === "create") {
      if (categories[name])
        throw new PlanRefused(`${service.name} already has the category "${name}".`);
      return done(
        {
          summary: `Create the category "${name}" in ${service.name}`,
          settings: [
            { name: "Category", before: "Does not exist", after: name },
            {
              name: "Its folder",
              before: "",
              after: `${folder} (qBittorrent's default for a category)`,
            },
          ],
        },
        { categoryAction: action, category: name },
      );
    }
    if (!categories[name]) throw new PlanRefused(`${service.name} has no category "${name}".`);
    const using = torrents.filter((r) => r.category === name || r.category?.startsWith(`${name}/`));
    if (using.length)
      throw new PlanRefused(
        `${using.length === 1 ? `"${using[0]!.name}" is` : `${using.length} torrents are`} in "${name}". Move them to another category first, so nothing loses its category by surprise.`,
      );
    const arr = deps.arrCategories ? await deps.arrCategories() : { used: [], unchecked: [] };
    const users = arr.used.filter((u) => u.category === name);
    if (users.length)
      throw new PlanRefused(
        `${users.map((u) => u.app).join(" and ")} ${users.length === 1 ? "sends its" : "send their"} downloads to "${name}". Removing it would break ${users.length === 1 ? "that app's" : "their"} downloads, so Hearth does not remove it.`,
      );
    if (arr.unchecked.length)
      throw new PlanRefused(
        `Hearth could not read ${arr.unchecked.join(", ")} to check whether ${arr.unchecked.length === 1 ? "it uses" : "they use"} "${name}", so it does not remove it. Connect ${arr.unchecked.length === 1 ? "it" : "them"} (its key in the vault) and try again.`,
      );
    return done(
      {
        summary: `Remove the category "${name}" from ${service.name}`,
        settings: [
          { name: "Category", before: name, after: "Removed" },
          {
            name: "Note",
            before: "",
            after: `No torrent is in it, and no connected Sonarr, Radarr or Lidarr sends downloads to it. Its folder (${folder}) and anything in it stay on disk.`,
          },
        ],
      },
      { categoryAction: action, category: name, savePath: categories[name]?.savePath ?? "" },
    );
  }

  if (kind === "app-qbt-file-priority") {
    const hash = typeof params?.hash === "string" ? params.hash.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(hash))
      throw new PlanRefused("Say which torrent by its hash (params.hash).");
    const priority = Number(params?.filePriority ?? params?.priority);
    if (![0, 1, 6, 7].includes(priority))
      throw new PlanRefused(
        "params.filePriority is 0 (do not download), 1 (normal), 6 (high) or 7 (maximum).",
      );
    const wanted = String(params?.fileIndexes ?? "")
      .split(/[\s,|]+/)
      .filter(Boolean)
      .map(Number);
    if (!wanted.length || wanted.some((n) => !Number.isInteger(n) || n < 0))
      throw new PlanRefused(
        "Say which files by their numbers (params.fileIndexes, comma separated).",
      );
    const { tor, files } = await session(
      "read",
      "read a torrent's files for a plan",
      async (q) => ({
        tor: (await read(q, [hash])).get(hash),
        files: await q.get<{ index?: number; name?: string; priority?: number }[]>(
          `/api/v2/torrents/files?hash=${hash}`,
        ),
      }),
    );
    if (!tor) throw new PlanRefused(`${service.name} has no torrent ${hash}.`);
    const byIndex = new Map(files.map((f, i) => [f.index ?? i, f]));
    const missing = wanted.filter((n) => !byIndex.has(n));
    if (missing.length) throw new PlanRefused(`"${tor.name}" has no file ${missing.join(", ")}.`);
    const changing = wanted.filter((n) => byIndex.get(n)!.priority !== priority);
    if (!changing.length)
      throw new PlanRefused(`Those files already have the priority "${PRIORITY_WORDS[priority]}".`);
    const skipAll =
      priority === 0 && files.every((f, i) => f.priority === 0 || changing.includes(f.index ?? i));
    return done(
      {
        summary: `Set ${changing.length === 1 ? `"${byIndex.get(changing[0]!)!.name}"` : `${changing.length} files`} of "${tor.name}" to ${PRIORITY_WORDS[priority]!.toLowerCase()} in ${service.name}`,
        settings: [
          ...changing.slice(0, 50).map((n) => ({
            name: byIndex.get(n)!.name ?? `File ${n}`,
            before:
              PRIORITY_WORDS[byIndex.get(n)!.priority ?? 1] ?? String(byIndex.get(n)!.priority),
            after: PRIORITY_WORDS[priority]!,
          })),
          ...(priority === 0
            ? [
                {
                  name: "Note",
                  before: "",
                  after: skipAll
                    ? "Nothing in this torrent would be downloaded any more."
                    : "Parts already downloaded stay on disk; qBittorrent just stops fetching the rest of those files.",
                },
              ]
            : []),
        ],
      },
      {
        hash,
        torrent: tor.name ?? hash,
        fileIndexes: changing.join(","),
        filePriority: priority,
        state: JSON.stringify(changing.map((n) => byIndex.get(n)!.priority ?? 1)),
      },
    );
  }

  const hashes = hashesOf(params);
  const { found, categories, defaultPath } = await session(
    "read",
    "read torrents for a plan",
    async (q) => ({
      found: await read(q, hashes),
      categories:
        kind === "app-qbt-set-category"
          ? await q.get<Record<string, { savePath?: string }>>("/api/v2/torrents/categories")
          : ({} as Record<string, { savePath?: string }>),
      defaultPath:
        kind === "app-qbt-set-category"
          ? ((await q.get<{ save_path?: string }>("/api/v2/app/preferences")).save_path ?? "")
          : "",
    }),
  );
  const missing = hashes.filter((h) => !found.has(h));
  if (missing.length)
    throw new PlanRefused(`${service.name} has no torrent ${missing.join(", ")}.`);
  const list = hashes.map((h) => found.get(h)!);
  const names = list.map((r) => r.name ?? r.hash);
  const who = list.length === 1 ? `"${names[0]}"` : `${list.length} torrents (${shortList(names)})`;
  const approved = {
    hashes: hashes.join(","),
    torrents: JSON.stringify(names),
    state: JSON.stringify(list.map((r) => stateOf(kind, r))),
  };

  if (kind === "app-qbt-set-share-limits") {
    const num = (v: unknown, name: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < -2)
        throw new PlanRefused(`${name}: a number, -2 for the global setting, -1 for no limit.`);
      return n;
    };
    const ratio = num(params?.ratioLimit, "ratioLimit");
    const time = num(params?.seedingTimeLimit, "seedingTimeLimit (minutes)");
    const inactive = num(params?.inactiveSeedingTimeLimit, "inactiveSeedingTimeLimit (minutes)");
    if (ratio === undefined && time === undefined && inactive === undefined)
      throw new PlanRefused(
        "Give ratioLimit, seedingTimeLimit, or inactiveSeedingTimeLimit (-2 = the global setting, -1 = no limit).",
      );
    const settings = list.flatMap((r) => [
      ...(ratio !== undefined
        ? [
            {
              name: `${r.name}: share ratio`,
              before: showLimit(r.ratio_limit, "ratio"),
              after: showLimit(ratio, "ratio"),
            },
          ]
        : []),
      ...(time !== undefined
        ? [
            {
              name: `${r.name}: seeding time`,
              before: showLimit(r.seeding_time_limit, "time"),
              after: showLimit(time, "time"),
            },
          ]
        : []),
      ...(inactive !== undefined
        ? [
            {
              name: `${r.name}: inactive seeding`,
              before: showLimit(r.inactive_seeding_time_limit, "time"),
              after: showLimit(inactive, "time"),
            },
          ]
        : []),
    ]);
    return done(
      {
        summary: `Set the seeding limits of ${who} in ${service.name}`,
        settings: settings.slice(0, 60),
      },
      {
        ...approved,
        ...(ratio !== undefined ? { ratioLimit: ratio } : {}),
        ...(time !== undefined ? { seedingTimeLimit: time } : {}),
        ...(inactive !== undefined ? { inactiveSeedingTimeLimit: inactive } : {}),
      },
    );
  }

  if (kind === "app-qbt-set-category") {
    const category = typeof params?.category === "string" ? params.category.trim() : "";
    if (category && !(category in categories))
      throw new PlanRefused(
        `${service.name} has no category "${category}". It has: ${Object.keys(categories).join(", ") || "none"}. Removing the category is category "".`,
      );
    return done(
      {
        summary: `${category ? `Put ${who} in the category "${category}"` : `Take ${who} out of its category`} in ${service.name}`,
        settings: list.slice(0, 50).flatMap((r) => {
          // Never a silent move: each torrent says whether its files move, from where to where.
          const to = categoryFolder(category, categories, defaultPath);
          const moves = r.auto_tmm === true && Boolean(r.save_path) && !samePath(r.save_path, to);
          return [
            {
              name: `${r.name}: category`,
              before: r.category || "none",
              after: category || "none",
            },
            moves
              ? {
                  name: `${r.name}: FILES MOVE`,
                  before: r.save_path!,
                  after: `${to} (automatic torrent management is on for it)`,
                }
              : {
                  name: `${r.name}: files`,
                  before: "",
                  after: `Stay where they are${r.save_path ? ` (${r.save_path})` : ""}`,
                },
          ];
        }),
      },
      { ...approved, category },
    );
  }

  if (kind === "app-qbt-set-tags") {
    const add = csv(params?.addTags);
    const remove = csv(params?.removeTags);
    if (!add.length && !remove.length)
      throw new PlanRefused("Give addTags or removeTags (comma separated).");
    return done(
      {
        summary: `Change the tags of ${who} in ${service.name}`,
        settings: list.slice(0, 50).map((r) => {
          const now = tagsOf(r);
          const next = [...new Set([...now.filter((x) => !remove.includes(x)), ...add])].sort();
          return {
            name: `${r.name}: tags`,
            before: now.join(", ") || "none",
            after: next.join(", ") || "none",
          };
        }),
      },
      { ...approved, addTags: add.join(","), removeTags: remove.join(",") },
    );
  }

  if (kind === "app-qbt-force-start") {
    const value = params?.value !== false && params?.value !== "false";
    return done(
      {
        summary: `${value ? "Force start" : "Stop forcing"} ${who} in ${service.name}`,
        settings: list.slice(0, 50).map((r) => ({
          name: `${r.name}: force start`,
          before: r.force_start ? "On (ignores the queue limits)" : "Off",
          after: value ? "On (ignores the queue limits)" : "Off",
        })),
      },
      { ...approved, value },
    );
  }

  // app-qbt-set-priority
  const move = typeof params?.priority === "string" ? params.priority : "";
  const API: Record<string, string> = {
    top: "topPrio",
    bottom: "bottomPrio",
    up: "increasePrio",
    down: "decreasePrio",
  };
  if (!API[move]) throw new PlanRefused('params.priority is "top", "bottom", "up", or "down".');
  if (list.every((r) => !r.priority || r.priority <= 0))
    throw new PlanRefused(
      `${list.length === 1 ? "That torrent is" : "Those torrents are"} not in the queue (finished, or queueing is off), so they have no queue position to move.`,
    );
  return done(
    {
      summary: `Move ${who} to the ${move === "top" || move === "bottom" ? `${move} of` : `${move} in`} the queue in ${service.name}`,
      settings: list.slice(0, 50).map((r) => ({
        name: `${r.name}: queue position`,
        before: r.priority && r.priority > 0 ? `#${r.priority}` : "not queued",
        after:
          move === "top"
            ? "#1"
            : move === "bottom"
              ? "last"
              : move === "up"
                ? "one higher"
                : "one lower",
      })),
    },
    { ...approved, priority: move },
  );
}

/* ---------- Run ---------- */

const WAIT_TRIES = 10;

export async function runControl(
  step: StepRun,
  service: { name: string },
  session: Session,
  wait: (ms: number) => Promise<void>,
  opts: { undo?: boolean } = {},
): Promise<StepOutcome & { verified?: boolean }> {
  const p = step.params ?? {};
  const kind = step.kind;

  if (kind === "app-qbt-set-preferences") {
    const before = JSON.parse(String(p.before ?? "{}")) as Record<string, unknown>;
    const after = JSON.parse(String(p.after ?? "{}")) as Record<string, unknown>;
    const [from, to] = opts.undo ? [after, before] : [before, after];
    return session("change", `change qBittorrent's settings (approved plan)`, async (q) => {
      const now = await q.get<Record<string, unknown>>("/api/v2/app/preferences");
      const drift = Object.keys(from).filter((k) => now[k] !== from[k]);
      if (drift.length && !opts.undo)
        return {
          ok: false,
          stale: true,
          result: `${service.name}'s ${drift.map((k) => PREFS[k]?.label ?? k).join(", ")} changed since this plan was approved (now ${drift.map((k) => showPref(k, now[k])).join(", ")}). Nothing was changed; plan it again.`,
        };
      const res = await q.post(
        "/api/v2/app/setPreferences",
        `json=${encodeURIComponent(JSON.stringify(to))}`,
      );
      if (!res.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${res.status}). Nothing was changed.`,
        };
      let read: Record<string, unknown> = now;
      for (let i = 0; i < WAIT_TRIES; i++) {
        read = await q.get<Record<string, unknown>>("/api/v2/app/preferences");
        if (Object.keys(to).every((k) => read[k] === to[k])) break;
        await wait(500);
      }
      const wrong = Object.keys(to).filter((k) => read[k] !== to[k]);
      const list = Object.keys(to)
        .map((k) => `${PREFS[k]?.label ?? k} ${showPref(k, read[k])}`)
        .join("; ");
      return wrong.length
        ? {
            ok: false,
            result: `${service.name} accepted the change, but reading it back shows ${wrong.map((k) => `${PREFS[k]?.label ?? k} ${showPref(k, read[k])}`).join("; ")}. Not verified.`,
          }
        : {
            ok: true,
            verified: true,
            result: `${opts.undo ? "Put back" : "Changed"} and verified by reading ${service.name}'s settings back: ${list}.`,
          };
    });
  }

  if (kind === "app-qbt-category") {
    const name = String(p.category ?? "");
    const create = (p.categoryAction === "create") !== Boolean(opts.undo);
    return session(
      "change",
      `${create ? "create" : "remove"} the category "${name}" (approved plan)`,
      async (q) => {
        const cats = () =>
          q.get<Record<string, { savePath?: string }>>("/api/v2/torrents/categories");
        const now = await cats();
        if (create && now[name])
          return opts.undo
            ? { ok: true, result: `"${name}" is there.` }
            : {
                ok: false,
                stale: true,
                result: `${service.name} already has "${name}". Nothing was changed.`,
              };
        if (!create) {
          if (!now[name]) return { ok: true, result: `"${name}" is already gone.` };
          const torrents = await q.get<Raw[]>("/api/v2/torrents/info");
          if (torrents.some((r) => r.category === name))
            return {
              ok: false,
              stale: true,
              result: `A torrent is in "${name}" now. Nothing was changed; plan it again.`,
            };
        }
        const res = create
          ? await q.post(
              "/api/v2/torrents/createCategory",
              `category=${encodeURIComponent(name)}&savePath=${encodeURIComponent(opts.undo ? String(p.savePath ?? "") : "")}`,
            )
          : await q.post(
              "/api/v2/torrents/removeCategories",
              `categories=${encodeURIComponent(name)}`,
            );
        if (!res.ok)
          return {
            ok: false,
            result: `${service.name} refused (${res.status}). Nothing was changed.`,
          };
        let after = now;
        for (let i = 0; i < WAIT_TRIES; i++) {
          after = await cats();
          if (Boolean(after[name]) === create) break;
          await wait(500);
        }
        return Boolean(after[name]) === create
          ? {
              ok: true,
              verified: true,
              result: `${opts.undo ? "Put back" : "Done"} and verified: ${service.name} ${create ? "now has" : "no longer has"} the category "${name}".`,
            }
          : {
              ok: false,
              result: `${service.name} accepted it, but reading back shows otherwise. Not verified.`,
            };
      },
    );
  }

  if (kind === "app-qbt-file-priority") {
    const hash = String(p.hash ?? "");
    const files = String(p.fileIndexes ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    const before = JSON.parse(String(p.state ?? "[]")) as number[];
    const want = Number(p.filePriority);
    const name = String(p.torrent ?? hash);
    return session("change", `set file priorities of "${name}" (approved plan)`, async (q) => {
      const readFiles = async () =>
        new Map(
          (
            await q.get<{ index?: number; priority?: number }[]>(
              `/api/v2/torrents/files?hash=${hash}`,
            )
          ).map((f, i) => [f.index ?? i, f.priority ?? 1]),
        );
      const now = await readFiles();
      if (!now.size)
        return {
          ok: false,
          stale: true,
          result: `"${name}" is no longer in ${service.name}.`,
        };
      if (!opts.undo && files.some((n, i) => now.get(n) !== before[i]))
        return {
          ok: false,
          stale: true,
          result:
            "Those files' priorities changed since this plan was approved. Nothing was changed; plan it again.",
        };
      // Undo puts each file back to its own approved priority (grouped by priority).
      const groups = new Map<number, number[]>();
      files.forEach((n, i) => {
        const to = opts.undo ? before[i]! : want;
        groups.set(to, [...(groups.get(to) ?? []), n]);
      });
      for (const [prio, ids] of groups) {
        const res = await q.post(
          "/api/v2/torrents/filePrio",
          `hash=${hash}&id=${ids.join("|")}&priority=${prio}`,
        );
        if (!res.ok)
          return { ok: false, result: `${service.name} refused the change (${res.status}).` };
      }
      let after = now;
      const right = (m: Map<number, number>) =>
        files.every((n, i) => m.get(n) === (opts.undo ? before[i] : want));
      for (let i = 0; i < WAIT_TRIES; i++) {
        after = await readFiles();
        if (right(after)) break;
        await wait(500);
      }
      return right(after)
        ? {
            ok: true,
            verified: true,
            result: `${opts.undo ? "Put back" : "Done"} and verified by reading the files back: ${files.length} file${files.length === 1 ? "" : "s"} of "${name}" ${opts.undo ? "back to their earlier priorities" : `now ${PRIORITY_WORDS[want]!.toLowerCase()}`}.`,
          }
        : {
            ok: false,
            result: `${service.name} accepted it, but the files read back with other priorities. Not verified.`,
          };
    });
  }

  if (kind === "app-qbt-add") {
    const links = String(p.urls ?? "")
      .split("\n")
      .filter(Boolean);
    if (opts.undo)
      return {
        ok: false,
        result:
          "Added torrents are not removed automatically; remove them with a separate plan if wanted.",
      };
    return session("change", `add ${links.length} torrent(s) (approved plan)`, async (q) => {
      const beforeList = await q.get<Raw[]>("/api/v2/torrents/info");
      const have = new Set(beforeList.map((r) => r.hash.toLowerCase()));
      const fields: Record<string, string> = links.length ? { urls: links.join("\n") } : {};
      if (p.category) fields.category = String(p.category);
      if (p.savepath) {
        fields.savepath = String(p.savepath);
        fields.autoTMM = "false";
      }
      const files = (
        typeof p.files === "string" && p.files
          ? (JSON.parse(p.files) as { name: string; data: string; hash: string }[])
          : []
      ).map((f) => ({ ...f, bytes: new Uint8Array(Buffer.from(f.data, "base64")) }));
      if (p.tags) fields.tags = String(p.tags);
      if (p.paused === true) {
        fields.paused = "true";
        fields.stopped = "true";
      }
      if (files.length && !q.upload)
        return { ok: false, result: "This connection cannot upload files. Nothing was added." };
      const res = files.length
        ? await q.upload!(
            "/api/v2/torrents/add",
            fields,
            files.map((f) => ({
              field: "torrents",
              filename: f.name,
              type: "application/x-bittorrent",
              data: f.bytes,
            })),
          )
        : await q.postForm("/api/v2/torrents/add", fields);
      if (!res.ok || /fails/i.test(res.text ?? ""))
        return {
          ok: false,
          result: `${service.name} refused to add ${links.length === 1 ? "the torrent" : "the torrents"} (${res.status}${res.text ? `, "${res.text.trim().slice(0, 60)}"` : ""}).`,
        };
      const expected = [...links.map(magnetHash), ...files.map((f) => f.hash)];
      const total = links.length + files.length;
      let added: Raw[] = [];
      for (let i = 0; i < WAIT_TRIES * 2; i++) {
        await wait(1000);
        const list = await q.get<Raw[]>("/api/v2/torrents/info");
        added = list.filter((r) => !have.has(r.hash.toLowerCase()));
        const magnetsIn = expected.every(
          (h) => !h || added.some((r) => r.hash.toLowerCase() === h),
        );
        if (magnetsIn && added.length >= total) break;
      }
      const ok = added.length >= total;
      const names = added.map((r) => `"${r.name ?? r.hash}"`).join(", ");
      return ok
        ? {
            ok: true,
            verified: true,
            result: `Added and verified: ${service.name} now lists ${names}${p.category ? ` in the category "${p.category}"` : ""}.`,
          }
        : {
            ok: false,
            result: `${service.name} accepted the request, but ${added.length ? `only ${names} appeared` : "no new torrent appeared"} when read back. Not verified (a .torrent URL that needs a login, or a magnet with no peers yet, can do this).`,
          };
    });
  }

  const hashes = String(p.hashes ?? "")
    .split(",")
    .filter(Boolean);
  const names = JSON.parse(String(p.torrents ?? "[]")) as string[];
  const approvedState = JSON.parse(String(p.state ?? "[]")) as string[];
  if (!hashes.length || !step.change)
    return { ok: false, result: "This step has no approved torrents." };
  const who = hashes.length === 1 ? `"${names[0]}"` : `${hashes.length} torrents`;

  return session(
    "change",
    `${kind.replace("app-qbt-", "").replace(/-/g, " ")} for ${who} (approved plan)`,
    async (q) => {
      const now = await read(q, hashes);
      const gone = hashes.filter((h) => !now.has(h));
      if (gone.length)
        return {
          ok: false,
          stale: true,
          result: `${gone.length === hashes.length ? who : `${gone.length} of them`} ${gone.length === 1 ? "is" : "are"} no longer in ${service.name}. Nothing was changed; plan it again.`,
        };
      if (!opts.undo) {
        const changed = hashes.filter((h, i) => stateOf(kind, now.get(h)!) !== approvedState[i]);
        if (changed.length)
          return {
            ok: false,
            stale: true,
            result: `${changed.length === 1 ? `"${now.get(changed[0]!)!.name}"` : `${changed.length} of them`} changed since this plan was approved. Nothing was changed; plan it again.`,
          };
      }
      const body = (extra: string) => `hashes=${hashes.join("|")}${extra}`;
      let res: { ok: boolean; status: number };
      let check: (r: Raw, i: number) => boolean;
      const put = (i: number) => approvedState[i]!;

      if (kind === "app-qbt-set-share-limits") {
        const back = (i: number) =>
          put(i)
            .split("|")
            .map((v) => (v === "" ? undefined : Number(v)));
        if (opts.undo) {
          // Each torrent back to its own approved values, one call per torrent.
          for (let i = 0; i < hashes.length; i++) {
            const [r, s, ia] = back(i);
            await q.post(
              "/api/v2/torrents/setShareLimits",
              `hashes=${hashes[i]}&ratioLimit=${r}&seedingTimeLimit=${s}${ia !== undefined ? `&inactiveSeedingTimeLimit=${ia}` : ""}`,
            );
          }
          res = { ok: true, status: 200 };
          check = (r, i) => stateOf(kind, r) === put(i);
        } else {
          // Unchanged parts keep each torrent's current value (qBittorrent needs all of them).
          const groups = new Map<string, string[]>();
          for (const h of hashes) {
            const r = now.get(h)!;
            const ratio = p.ratioLimit ?? r.ratio_limit ?? -2;
            const time = p.seedingTimeLimit ?? r.seeding_time_limit ?? -2;
            const inactive = p.inactiveSeedingTimeLimit ?? r.inactive_seeding_time_limit ?? -2;
            const key = `ratioLimit=${ratio}&seedingTimeLimit=${time}&inactiveSeedingTimeLimit=${inactive}`;
            groups.set(key, [...(groups.get(key) ?? []), h]);
          }
          res = { ok: true, status: 200 };
          for (const [key, hs] of groups) {
            const r = await q.post(
              "/api/v2/torrents/setShareLimits",
              `hashes=${hs.join("|")}&${key}`,
            );
            if (!r.ok) res = r;
          }
          check = (r) =>
            (p.ratioLimit === undefined ||
              Math.abs((r.ratio_limit ?? -99) - Number(p.ratioLimit)) < 0.005) &&
            (p.seedingTimeLimit === undefined ||
              r.seeding_time_limit === Number(p.seedingTimeLimit)) &&
            (p.inactiveSeedingTimeLimit === undefined ||
              r.inactive_seeding_time_limit === Number(p.inactiveSeedingTimeLimit));
        }
      } else if (kind === "app-qbt-set-category") {
        if (opts.undo) {
          for (let i = 0; i < hashes.length; i++)
            await q.post(
              "/api/v2/torrents/setCategory",
              `hashes=${hashes[i]}&category=${encodeURIComponent(put(i))}`,
            );
          res = { ok: true, status: 200 };
          check = (r, i) => (r.category ?? "") === put(i);
        } else {
          res = await q.post(
            "/api/v2/torrents/setCategory",
            body(`&category=${encodeURIComponent(String(p.category ?? ""))}`),
          );
          check = (r) => (r.category ?? "") === String(p.category ?? "");
        }
      } else if (kind === "app-qbt-set-tags") {
        const add = csv(opts.undo ? p.removeTags : p.addTags);
        const remove = csv(opts.undo ? p.addTags : p.removeTags);
        res = { ok: true, status: 200 };
        if (remove.length)
          res = await q.post(
            "/api/v2/torrents/removeTags",
            body(`&tags=${encodeURIComponent(remove.join(","))}`),
          );
        if (res.ok && add.length)
          res = await q.post(
            "/api/v2/torrents/addTags",
            body(`&tags=${encodeURIComponent(add.join(","))}`),
          );
        check = opts.undo
          ? (r, i) => tagsOf(r).join(",") === put(i)
          : (r) =>
              add.every((x) => tagsOf(r).includes(x)) &&
              remove.every((x) => !tagsOf(r).includes(x));
      } else if (kind === "app-qbt-force-start") {
        const on = p.value !== false && p.value !== "false";
        const value = opts.undo ? !on : on;
        res = await q.post("/api/v2/torrents/setForceStart", body(`&value=${value}`));
        check = (r) => Boolean(r.force_start) === value;
      } else {
        if (opts.undo) return { ok: true, result: "Queue order is not put back automatically." };
        const API: Record<string, string> = {
          top: "topPrio",
          bottom: "bottomPrio",
          up: "increasePrio",
          down: "decreasePrio",
        };
        res = await q.post(`/api/v2/torrents/${API[String(p.priority)]}`, body(""));
        const was = new Map(hashes.map((h) => [h, now.get(h)!.priority ?? 0]));
        check = (r) => {
          const a = was.get(r.hash.toLowerCase()) ?? 0;
          const b = r.priority ?? 0;
          if (a <= 0) return true;
          return p.priority === "top" || p.priority === "up" ? b < a || b === 1 : b > a || b === a;
        };
      }
      if (!res.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${res.status}). Nothing was changed.`,
        };

      let after = now;
      for (let i = 0; i < WAIT_TRIES; i++) {
        await wait(500);
        after = await read(q, hashes);
        if (hashes.every((h, j) => after.get(h) && check(after.get(h)!, j))) break;
      }
      const wrong = hashes.filter((h, j) => !after.get(h) || !check(after.get(h)!, j));
      const describe = (r: Raw) =>
        kind === "app-qbt-set-share-limits"
          ? `${showLimit(r.ratio_limit, "ratio")}, seeding ${showLimit(r.seeding_time_limit, "time")}`
          : kind === "app-qbt-set-category"
            ? `category ${r.category || "none"}`
            : kind === "app-qbt-set-tags"
              ? `tags ${tagsOf(r).join(", ") || "none"}`
              : kind === "app-qbt-force-start"
                ? `force start ${r.force_start ? "on" : "off"}`
                : `queue position ${r.priority && r.priority > 0 ? `#${r.priority}` : "none"}`;
      if (wrong.length)
        return {
          ok: false,
          result: `${service.name} accepted the change, but ${wrong.length === hashes.length ? "reading back" : `for ${wrong.length} of ${hashes.length}`} shows ${wrong
            .slice(0, 3)
            .map(
              (h) =>
                `"${after.get(h)?.name ?? h}" ${after.get(h) ? describe(after.get(h)!) : "gone"}`,
            )
            .join("; ")}. Not verified.`,
        };
      const first = after.get(hashes[0]!)!;
      return {
        ok: true,
        verified: true,
        result: `${opts.undo ? "Put back" : "Done"} and verified by reading ${service.name} back: ${hashes.length === 1 ? `"${first.name}" now has ${describe(first)}` : `all ${hashes.length} torrents now have ${describe(first)}`}.`,
      };
    },
  );
}

/** The read view: global settings (the ones above), categories, tags, and the transfer state. */
export async function readSettings(session: Session) {
  return session("read", "read qBittorrent's settings", async (q) => {
    const [prefs, categories, tags, transfer, altMode] = await Promise.all([
      q.get<Record<string, unknown>>("/api/v2/app/preferences"),
      q.get<Record<string, { name?: string; savePath?: string }>>("/api/v2/torrents/categories"),
      q.get<string[]>("/api/v2/torrents/tags"),
      q.get<Record<string, number | string>>("/api/v2/transfer/info"),
      q.get<number>("/api/v2/transfer/speedLimitsMode").catch(() => undefined),
    ]);
    return {
      settings: Object.entries(PREFS)
        .filter(([k]) => k in prefs)
        .map(([key, p]) => ({
          key,
          label: p.label,
          value: prefs[key] as boolean | number,
          shown: showPref(key, prefs[key]),
          type: p.type,
          ...(p.unit ? { unit: p.unit } : {}),
          ...(p.note ? { note: p.note } : {}),
        })),
      categories: Object.entries(categories).map(([name, c]) => ({
        name,
        ...(c.savePath ? { savePath: c.savePath } : {}),
      })),
      tags: Array.isArray(tags) ? tags : [],
      // Where it saves by default (read only: it is never changed from Hearth).
      ...(typeof prefs.save_path === "string" ? { defaultSavePath: prefs.save_path } : {}),
      transfer: {
        connection: String(transfer.connection_status ?? "unknown"),
        downSpeed: Number(transfer.dl_info_speed ?? 0),
        upSpeed: Number(transfer.up_info_speed ?? 0),
        downloadedThisSession: Number(transfer.dl_info_data ?? 0),
        uploadedThisSession: Number(transfer.up_info_data ?? 0),
        downLimit: Number(transfer.dl_rate_limit ?? 0),
        upLimit: Number(transfer.up_rate_limit ?? 0),
        dhtNodes: Number(transfer.dht_nodes ?? 0),
        alternativeLimits: altMode === 1,
      },
    };
  });
}
