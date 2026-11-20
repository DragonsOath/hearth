import type { StepParams } from "@dragon-control/core";
import type { PlannedStep, StepOutcome } from "../jobs/operations";
import { planHome, readHomeView, runHome } from "./jellyfin-home";

/**
 * Jellyfin's panel as Plex's (11-04): its Library (a title's details, watched, edits, a
 * refresh), Manage (libraries and their folders), Plugins (installed, updates, the catalog, enable,
 * disable, remove, restart) and Settings (everyday server and playback settings). Every change is
 * a plan step the owner approves, read back from Jellyfin afterwards where Jellyfin can say.
 * Networking, users' passwords and API keys stay in Jellyfin.
 */

export const JELLYFIN_MANAGE_OPS = [
  "watched",
  "unwatched",
  "like",
  "edit-item",
  "refresh-item",
  "plugin-enable",
  "plugin-disable",
  "plugin-uninstall",
  "plugin-install",
  "restart",
  "add-library",
  "add-folder",
  "remove-folder",
  "remove-library",
  "set-settings",
  "home-screen",
] as const;
export type JellyfinManageOp = (typeof JELLYFIN_MANAGE_OPS)[number];
export const isManageOp = (op: string): op is JellyfinManageOp =>
  (JELLYFIN_MANAGE_OPS as readonly string[]).includes(op);

/** The kinds of library Jellyfin offers, in its own words. */
export const LIBRARY_TYPES: { id: string; label: string }[] = [
  { id: "movies", label: "Movies" },
  { id: "tvshows", label: "Shows" },
  { id: "music", label: "Music" },
  { id: "musicvideos", label: "Music videos" },
  { id: "homevideos", label: "Home videos and photos" },
  { id: "books", label: "Books" },
  { id: "mixed", label: "Mixed movies and shows" },
];

/**
 * The settings Hearth shows and changes: everyday server and playback ones. Networking (ports,
 * remote access, HTTPS) is protected and stays in Jellyfin; so does anything with a path or a
 * password.
 */
export interface JellyfinSettingDef {
  id: string;
  /** Which of Jellyfin's configuration files it lives in. */
  file: "server" | "encoding";
  key: string;
  label: string;
  summary?: string;
  group: string;
  type: "bool" | "text" | "int";
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  advanced?: boolean;
}

export const JELLYFIN_SETTINGS: JellyfinSettingDef[] = [
  {
    id: "ServerName",
    file: "server",
    key: "ServerName",
    label: "Server name",
    summary: "What apps show for this server.",
    group: "General",
    type: "text",
  },
  {
    id: "PreferredMetadataLanguage",
    file: "server",
    key: "PreferredMetadataLanguage",
    label: "Metadata language",
    summary: "Two letters, like en or de: the language titles and summaries are fetched in.",
    group: "Library",
    type: "text",
  },
  {
    id: "MetadataCountryCode",
    file: "server",
    key: "MetadataCountryCode",
    label: "Metadata country",
    summary: "Two letters, like US or GB: used for ratings and release dates.",
    group: "Library",
    type: "text",
  },
  {
    id: "EnableGroupingMoviesIntoCollections",
    file: "server",
    key: "EnableGroupingMoviesIntoCollections",
    label: "Group movies into collections",
    summary: "Movies in a collection show as one entry in the library.",
    group: "Library",
    type: "bool",
  },
  {
    id: "DisplaySpecialsWithinSeasons",
    file: "server",
    key: "DisplaySpecialsWithinSeasons",
    label: "Show specials within their seasons",
    group: "Library",
    type: "bool",
  },
  {
    id: "MinResumePct",
    file: "server",
    key: "MinResumePct",
    label: "Resume after watching at least (%)",
    summary: "Stopping earlier than this starts from the beginning next time.",
    group: "Playback",
    type: "int",
    min: 0,
    max: 100,
    advanced: true,
  },
  {
    id: "MaxResumePct",
    file: "server",
    key: "MaxResumePct",
    label: "Counts as watched after (%)",
    group: "Playback",
    type: "int",
    min: 1,
    max: 100,
    advanced: true,
  },
  {
    id: "RemoteClientBitrateLimit",
    file: "server",
    key: "RemoteClientBitrateLimit",
    label: "Streaming limit away from home (bits per second, 0 for none)",
    summary: "Above it, the server converts the video so it fits.",
    group: "Playback",
    type: "int",
    min: 0,
    max: 1_000_000_000,
  },
  {
    id: "HardwareAccelerationType",
    file: "encoding",
    key: "HardwareAccelerationType",
    label: "Hardware acceleration",
    summary: "Use the graphics chip to convert video. Pick the one this machine has.",
    group: "Converting video",
    type: "text",
    options: [
      { value: "none", label: "None (the processor)" },
      { value: "qsv", label: "Intel Quick Sync (QSV)" },
      { value: "vaapi", label: "Video Acceleration API (VAAPI)" },
      { value: "nvenc", label: "NVIDIA NVENC" },
      { value: "amf", label: "AMD AMF" },
      { value: "videotoolbox", label: "Apple VideoToolbox" },
      { value: "rkmpp", label: "Rockchip MPP" },
    ],
  },
  {
    id: "EnableHardwareEncoding",
    file: "encoding",
    key: "EnableHardwareEncoding",
    label: "Hardware encoding",
    summary: "Encode on the graphics chip too, not only decode.",
    group: "Converting video",
    type: "bool",
  },
  {
    id: "AllowHevcEncoding",
    file: "encoding",
    key: "AllowHevcEncoding",
    label: "Allow converting to HEVC",
    group: "Converting video",
    type: "bool",
    advanced: true,
  },
  // Emby's names for the same two switches (each shows only where the server has it).
  {
    id: "EnableHevcEncoding",
    file: "encoding",
    key: "EnableHevcEncoding",
    label: "Allow converting to HEVC",
    group: "Converting video",
    type: "bool",
    advanced: true,
  },
  {
    id: "EnableHardwareToneMapping",
    file: "encoding",
    key: "EnableHardwareToneMapping",
    label: "Tone mapping",
    summary: "HDR video looks right on screens that cannot show HDR.",
    group: "Converting video",
    type: "bool",
  },
  {
    id: "EnableTonemapping",
    file: "encoding",
    key: "EnableTonemapping",
    label: "Tone mapping",
    summary: "HDR video looks right on screens that cannot show HDR.",
    group: "Converting video",
    type: "bool",
  },
  {
    id: "EncoderPreset",
    file: "encoding",
    key: "EncoderPreset",
    label: "Encoding speed",
    group: "Converting video",
    type: "text",
    options: [
      { value: "auto", label: "Automatic" },
      { value: "veryfast", label: "Very fast (lower quality)" },
      { value: "fast", label: "Fast" },
      { value: "medium", label: "Medium" },
      { value: "slow", label: "Slow (better quality)" },
    ],
    advanced: true,
  },
  {
    id: "EnableThrottling",
    file: "encoding",
    key: "EnableThrottling",
    label: "Throttle conversions",
    summary: "Convert only a little ahead of the viewer, to save processor time.",
    group: "Converting video",
    type: "bool",
    advanced: true,
  },
  {
    id: "ActivityLogRetentionDays",
    file: "server",
    key: "ActivityLogRetentionDays",
    label: "Keep the activity log for (days)",
    group: "Housekeeping",
    type: "int",
    min: 1,
    max: 3650,
    advanced: true,
  },
  {
    id: "LogFileRetentionDays",
    file: "server",
    key: "LogFileRetentionDays",
    label: "Keep log files for (days)",
    group: "Housekeeping",
    type: "int",
    min: 1,
    max: 3650,
    advanced: true,
  },
];

/** One call to Jellyfin with its key (jellyfin.ts makes it: this file never imports that one). */
export type JellyfinCallFn = <T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<{ ok: boolean; status: number; data: T }>;

const enc = encodeURIComponent;

/** A Jellyfin item id, as its API writes them (32 hex characters, or the stand-in's names). */
const JELLYFIN_ITEM = /^[\w-]{1,64}$/;

/** Version numbers compared part by part ("10.10.7.0" < "10.11.0.0"). */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** Jellyfin writes plugin ids with or without dashes, in either case. */
export const sameGuid = (a?: string, b?: string) =>
  Boolean(a && b && a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase());

export interface RawPackage {
  name?: string;
  guid?: string;
  overview?: string;
  description?: string;
  category?: string;
  owner?: string;
  versions?: {
    version?: string;
    targetAbi?: string;
    repositoryName?: string;
    repositoryUrl?: string;
  }[];
}

/** The newest version of a package this server can run (its target no newer than the server). */
export function latestFor(pkg: RawPackage, server: string) {
  return (pkg.versions ?? [])
    .filter((v) => v.version && (!v.targetAbi || !newerVersion(v.targetAbi, server)))
    .sort((x, y) => (newerVersion(x.version!, y.version!) ? -1 : 1))[0];
}

/** The account Jellyfin's watched marks belong to: its first administrator still allowed in. */
export async function ownerUser(call: JellyfinCallFn) {
  const r = await call<
    { Id: string; Name?: string; Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean } }[]
  >("GET", "/Users");
  const users = r.ok && Array.isArray(r.data) ? r.data : [];
  const u =
    users.find((x) => x.Policy?.IsAdministrator && !x.Policy.IsDisabled) ??
    users.find((x) => !x.Policy?.IsDisabled);
  return u ? { id: u.Id, name: u.Name ?? "you" } : undefined;
}

interface RawItem {
  Id: string;
  Name?: string;
  Type?: string;
  SortName?: string;
  ForcedSortName?: string;
  ProductionYear?: number;
  Overview?: string;
  LockedFields?: string[];
  UserData?: { Played?: boolean; Likes?: boolean | null; IsFavorite?: boolean };
  [k: string]: unknown;
}

/** One title with what is needed to change it, as the owner's account sees it. */
async function readItem(
  call: JellyfinCallFn,
  id: string,
  userId?: string,
): Promise<RawItem | undefined> {
  const q = `Ids=${enc(id)}${userId ? `&UserId=${enc(userId)}` : ""}&Fields=Overview,SortName,ProductionYear,LockedFields,Path`;
  const r = await call<{ Items?: RawItem[] }>("GET", `/Items?${q}`);
  return r.ok ? r.data?.Items?.[0] : undefined;
}

const words = (o: Record<string, unknown>) =>
  Object.entries(o)
    .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
    .join(", ");

/** Plans one of the new controls: reads Jellyfin now so the label says exactly what happens. */
export async function planManage(
  call: JellyfinCallFn,
  service: { name: string },
  op: JellyfinManageOp,
  params: StepParams | undefined,
  base: PlannedStep,
): Promise<PlannedStep> {
  const p = params ?? {};
  if (op === "home-screen") return planHome(call, service, p, base);
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
  const done = (
    label: string,
    extra: StepParams,
    settings?: { name: string; before: string; after: string }[],
  ) => ({
    ...base,
    label,
    serviceName: service.name,
    params: { op, ...extra },
    change: {
      summary: label,
      settings: settings ?? [{ name: label, before: "as it is", after: op }],
    },
  });

  // Jellyfin has no star ratings of your own: a thumbs up or down, and Favorite.
  if (op === "like") {
    const id = str("itemId");
    if (!JELLYFIN_ITEM.test(id)) throw new Error("Say which title (params.itemId).");
    const user = await ownerUser(call);
    if (!user) throw new Error(`${service.name} has no account to rate it for.`);
    const item = await readItem(call, id, user.id);
    if (!item) throw new Error("Jellyfin does not have that title.");
    const title = item.Name ?? "the title";
    const liked = str("liked") === "true";
    const favorite = str("favorite") === "true";
    const words = `${liked ? "Liked" : "Disliked"}${favorite ? " and a Favorite" : ""}`;
    return done(
      `${words}: ${title}, for ${user.name} in ${service.name}`,
      {
        itemId: id,
        userId: user.id,
        name: title,
        liked: String(liked),
        favorite: String(favorite),
      },
      [
        {
          name: title,
          before: item.UserData?.IsFavorite
            ? "a Favorite"
            : item.UserData?.Likes === true
              ? "liked"
              : item.UserData?.Likes === false
                ? "disliked"
                : "not rated",
          after: words.toLowerCase(),
        },
      ],
    );
  }

  if (op === "watched" || op === "unwatched" || op === "edit-item" || op === "refresh-item") {
    const id = str("itemId");
    if (!JELLYFIN_ITEM.test(id)) throw new Error("Say which title (params.itemId).");
    const user = await ownerUser(call);
    const item = await readItem(call, id, user?.id);
    if (!item) throw new Error(`${service.name} does not have that title.`);
    const title = item.Name ?? "the title";
    if (op === "refresh-item")
      return done(`Refresh ${title}'s details and pictures from the internet in ${service.name}`, {
        itemId: id,
        name: title,
      });
    if (op !== "edit-item") {
      if (!user) throw new Error(`${service.name} has no account to mark it for.`);
      return done(
        `Mark ${title} ${op === "watched" ? "watched" : "unwatched"} for ${user.name} in ${service.name}`,
        { itemId: id, userId: user.id, name: title },
      );
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(str("body") || "{}") as Record<string, unknown>;
    } catch {
      throw new Error("The changes are not readable.");
    }
    const next: Record<string, string | number> = {};
    if (typeof body.title === "string" && body.title.trim())
      next.Name = body.title.trim().slice(0, 300);
    if (typeof body.sortTitle === "string")
      next.ForcedSortName = body.sortTitle.trim().slice(0, 300);
    if (body.year !== undefined && body.year !== "") {
      const y = Number(body.year);
      if (!Number.isInteger(y) || y < 1850 || y > 2200) throw new Error("A year like 1994.");
      next.ProductionYear = y;
    }
    if (typeof body.summary === "string") next.Overview = body.summary.slice(0, 5000);
    if (!Object.keys(next).length) throw new Error("Nothing to change.");
    const before: Record<string, unknown> = {
      Name: item.Name,
      ForcedSortName: item.ForcedSortName ?? item.SortName ?? "",
      ProductionYear: item.ProductionYear ?? "",
      Overview: item.Overview ?? "",
    };
    const NAMES: Record<string, string> = {
      Name: "Title",
      ForcedSortName: "Sort title",
      ProductionYear: "Year",
      Overview: "Summary",
    };
    return done(
      `Edit ${title}'s details in ${service.name} (kept when ${service.name} refreshes it)`,
      { itemId: id, name: title, body: JSON.stringify(next) },
      Object.keys(next).map((k) => ({
        name: NAMES[k] ?? k,
        before: String(before[k] ?? "").slice(0, 200) || "(empty)",
        after: String(next[k]).slice(0, 200) || "(empty)",
      })),
    );
  }

  if (op === "plugin-enable" || op === "plugin-disable" || op === "plugin-uninstall") {
    const r = await call<
      { Id?: string; Name?: string; Version?: string; CanUninstall?: boolean; Status?: string }[]
    >("GET", "/Plugins");
    const pl = (r.ok ? r.data : []).find((x) => sameGuid(x.Id, str("pluginId")));
    if (!pl?.Id || !pl.Version) throw new Error(`${service.name} does not have that plugin.`);
    if (op === "plugin-uninstall" && pl.CanUninstall === false)
      throw new Error(
        `${pl.Name} comes with ${service.name} and cannot be removed; disable it instead.`,
      );
    // Emby lists no status: it has no switch to turn a plugin off, only removing it.
    if (op !== "plugin-uninstall" && pl.Status === undefined)
      throw new Error(`${service.name} cannot turn a plugin off or on; remove it instead.`);
    const verb = op === "plugin-enable" ? "Enable" : op === "plugin-disable" ? "Disable" : "Remove";
    return done(
      `${verb} the ${pl.Name} plugin in ${service.name}. It takes effect when ${service.name} restarts.`,
      { pluginId: pl.Id, version: pl.Version, name: pl.Name ?? "the plugin" },
      [
        {
          name: pl.Name ?? "Plugin",
          before: pl.Status ?? "installed",
          after: verb === "Remove" ? "removed" : `${verb.toLowerCase()}d`,
        },
      ],
    );
  }

  if (op === "plugin-install") {
    const [pk, info, inst] = await Promise.all([
      call<RawPackage[]>("GET", "/Packages"),
      call<{ Version?: string }>("GET", "/System/Info"),
      call<{ Id?: string; Version?: string }[]>("GET", "/Plugins"),
    ]);
    const pkg = (pk.ok ? pk.data : []).find((x) => sameGuid(x.guid, str("guid")));
    if (!pkg?.name || !pkg.guid)
      throw new Error(`${service.name}'s catalog does not have that plugin.`);
    const v = latestFor(pkg, info.data?.Version ?? "0");
    if (!v?.version) throw new Error(`${pkg.name} has no version for this ${service.name}.`);
    const have = (inst.ok ? inst.data : []).find((x) => sameGuid(x.Id, pkg.guid));
    if (have?.Version && !newerVersion(v.version, have.Version))
      throw new Error(`${pkg.name} ${have.Version} is already installed and up to date.`);
    const what = have
      ? `Update the ${pkg.name} plugin to ${v.version}`
      : `Install the ${pkg.name} plugin ${v.version}`;
    return done(
      `${what} from ${v.repositoryName ?? `${service.name}'s catalog`} in ${service.name}. It takes effect when ${service.name} restarts.`,
      {
        guid: pkg.guid,
        name: pkg.name,
        version: v.version,
        ...(v.repositoryUrl ? { repositoryUrl: v.repositoryUrl } : {}),
      },
      [{ name: pkg.name, before: have?.Version ?? "not installed", after: v.version }],
    );
  }

  if (op === "restart")
    return done(
      `Restart ${service.name}. Anyone watching is cut off for about a minute while it starts again.`,
      { name: service.name },
    );

  if (op === "set-settings") return planSettings(call, service, str("settings"), done);

  const folders = await call<{ Name?: string; CollectionType?: string; Locations?: string[] }[]>(
    "GET",
    "/Library/VirtualFolders",
  );
  const libs = folders.ok && Array.isArray(folders.data) ? folders.data : [];
  const path = str("path");
  const checkPath = async () => {
    if (!path || path.length > 1000 || !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path))
      throw new Error(`A folder path as ${service.name} sees it, like /media/movies.`);
    const v = await call<unknown>("POST", "/Environment/ValidatePath", {
      ValidateWritable: false,
      Path: path,
      IsFile: false,
    });
    if (!v.ok) throw new Error(`${service.name} cannot see the folder ${path} (${v.status}).`);
  };

  if (op === "add-library") {
    const name = str("name");
    const type = str("type") || str("libraryType");
    if (!name || name.length > 100) throw new Error("A name for the library.");
    if (libs.some((l) => l.Name?.toLowerCase() === name.toLowerCase()))
      throw new Error(`${service.name} already has a library called ${name}.`);
    if (!LIBRARY_TYPES.some((t) => t.id === type)) throw new Error("Say what kind of library.");
    await checkPath();
    const kind = LIBRARY_TYPES.find((t) => t.id === type)!.label;
    return done(
      `Add a ${kind} library called ${name} in ${service.name}, reading ${path}, and scan it`,
      { name, type, path },
      [
        {
          name: "Libraries",
          before: libs.map((l) => l.Name).join(", ") || "none",
          after: `also ${name}`,
        },
      ],
    );
  }
  const lib = libs.find((l) => l.Name === str("library"));
  if (!lib?.Name) throw new Error(`${service.name} does not have that library.`);
  if (op === "add-folder") {
    await checkPath();
    if (lib.Locations?.includes(path)) throw new Error(`${lib.Name} already reads ${path}.`);
    return done(
      `Add the folder ${path} to the ${lib.Name} library in ${service.name}, and scan it`,
      { library: lib.Name, path },
      [
        {
          name: `${lib.Name} folders`,
          before: (lib.Locations ?? []).join(", "),
          after: [...(lib.Locations ?? []), path].join(", "),
        },
      ],
    );
  }
  if (op === "remove-folder") {
    if (!lib.Locations?.includes(path)) throw new Error(`${lib.Name} does not read ${path}.`);
    if (lib.Locations.length < 2)
      throw new Error(`${path} is ${lib.Name}'s only folder: remove the library instead.`);
    return done(
      `Stop the ${lib.Name} library reading ${path} in ${service.name}. The files stay on disk; ${service.name} forgets the titles in that folder.`,
      { library: lib.Name, path },
      [
        {
          name: `${lib.Name} folders`,
          before: lib.Locations.join(", "),
          after: lib.Locations.filter((x) => x !== path).join(", "),
        },
      ],
    );
  }
  if (op === "remove-library")
    return done(
      `Remove the ${lib.Name} library from ${service.name}. Its files stay on disk; ${service.name} forgets its titles and their watched marks.`,
      { library: lib.Name },
      [
        {
          name: "Libraries",
          before: libs.map((l) => l.Name).join(", "),
          after:
            libs
              .filter((l) => l !== lib)
              .map((l) => l.Name)
              .join(", ") || "none",
        },
      ],
    );
  throw new Error(`Hearth has no ${op} for ${service.name}.`);
}

/** The settings change, each one checked against Hearth's list and Jellyfin's current value. */
async function planSettings(
  call: JellyfinCallFn,
  service: { name: string },
  raw: string,
  done: (
    label: string,
    extra: StepParams,
    settings?: { name: string; before: string; after: string }[],
  ) => PlannedStep,
): Promise<PlannedStep> {
  let edits: Record<string, unknown>;
  try {
    edits = JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    throw new Error("The settings are not readable.");
  }
  const [server, encoding] = await Promise.all([
    call<Record<string, unknown>>("GET", "/System/Configuration"),
    call<Record<string, unknown>>("GET", "/System/Configuration/encoding"),
  ]);
  const rows: { name: string; before: string; after: string }[] = [];
  const clean: Record<string, string | number | boolean> = {};
  for (const [id, raw] of Object.entries(edits)) {
    const def = JELLYFIN_SETTINGS.find((d) => d.id === id);
    if (!def) throw new Error(`Hearth does not change ${id}; it stays in ${service.name}.`);
    const value = coerce(def, raw);
    const now = (def.file === "server" ? server.data : encoding.data)?.[def.key];
    if (String(now) === String(value)) continue;
    clean[id] = value;
    rows.push({ name: def.label, before: show(def, now), after: show(def, value) });
  }
  if (!rows.length) throw new Error("Nothing to change.");
  return done(
    rows.length === 1
      ? `Change ${rows[0]!.name} in ${service.name}`
      : `Change ${rows.length} settings in ${service.name}`,
    { settings: JSON.stringify(clean) },
    rows,
  );
}

function coerce(def: JellyfinSettingDef, raw: unknown): string | number | boolean {
  if (def.type === "bool") return raw === true || raw === "true";
  if (def.type === "int") {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < (def.min ?? 0) || n > (def.max ?? 1e12))
      throw new Error(
        `${def.label}: a whole number${def.max !== undefined ? ` from ${def.min ?? 0} to ${def.max}` : ""}.`,
      );
    return n;
  }
  const s = String(raw ?? "").trim();
  if (def.options && !def.options.some((o) => o.value === s))
    throw new Error(`${def.label}: one of ${def.options.map((o) => o.label).join(", ")}.`);
  if (s.length > 200) throw new Error(`${def.label} is too long.`);
  if (
    (def.id === "PreferredMetadataLanguage" || def.id === "MetadataCountryCode") &&
    s &&
    !/^[A-Za-z]{2}(-[A-Za-z]{2})?$/.test(s)
  )
    throw new Error(`${def.label}: two letters.`);
  return s;
}

const show = (def: JellyfinSettingDef, v: unknown) =>
  v === undefined || v === null || v === ""
    ? "(empty)"
    : def.type === "bool"
      ? v
        ? "On"
        : "Off"
      : (def.options?.find((o) => o.value === String(v))?.label ?? String(v));

/** Runs one of the new controls, then reads Jellyfin back where it can say. */
export async function runManage(
  call: JellyfinCallFn,
  service: { name: string },
  op: JellyfinManageOp,
  p: StepParams,
  wait: (ms: number) => Promise<void>,
): Promise<StepOutcome> {
  const str = (k: string) => String(p[k] ?? "");
  const name = str("name") || str("library") || "it";
  const refused = (r: { status: number }) => `${service.name} refused it (${r.status}).`;
  if (op === "home-screen") return runHome(call, service, p);

  if (op === "like") {
    const id = str("itemId");
    const user = str("userId");
    const liked = str("liked") === "true";
    // Jellyfin 10.9 moved these; older servers answer the old addresses.
    let r = await call<unknown>(
      "POST",
      `/UserItems/${enc(id)}/Rating?userId=${enc(user)}&likes=${liked}`,
    );
    if (r.status === 404)
      r = await call<unknown>("POST", `/Users/${enc(user)}/Items/${enc(id)}/Rating?likes=${liked}`);
    if (!r.ok) return { ok: false, result: refused(r) };
    if (str("favorite") === "true") {
      let f = await call<unknown>("POST", `/UserFavoriteItems/${enc(id)}?userId=${enc(user)}`);
      if (f.status === 404)
        f = await call<unknown>("POST", `/Users/${enc(user)}/FavoriteItems/${enc(id)}`);
      if (!f.ok) return { ok: false, result: refused(f) };
    }
    const back = await readItem(call, id, user);
    const ok =
      back?.UserData?.Likes === liked &&
      (str("favorite") !== "true" || back.UserData.IsFavorite === true);
    return ok
      ? {
          ok: true,
          verified: true,
          result: `${name}: ${liked ? "liked" : "disliked"} (read back).`,
        }
      : { ok: false, result: `${service.name} took it, but ${name} does not read back that way.` };
  }

  if (op === "watched" || op === "unwatched") {
    const id = str("itemId");
    const user = str("userId");
    const method = op === "watched" ? "POST" : "DELETE";
    // Jellyfin 10.9 moved this; older servers answer the old address.
    let r = await call<unknown>(method, `/UserPlayedItems/${enc(id)}?userId=${enc(user)}`);
    if (r.status === 404)
      r = await call<unknown>(method, `/Users/${enc(user)}/PlayedItems/${enc(id)}`);
    if (!r.ok) return { ok: false, result: refused(r) };
    const back = await readItem(call, id, user);
    const played = Boolean(back?.UserData?.Played);
    return played === (op === "watched")
      ? { ok: true, verified: true, result: `${name} is marked ${op} (read back).` }
      : { ok: false, result: `${service.name} took it, but ${name} does not read back as ${op}.` };
  }
  if (op === "refresh-item") {
    const r = await call<unknown>(
      "POST",
      `/Items/${enc(str("itemId"))}/Refresh?MetadataRefreshMode=FullRefresh&ImageRefreshMode=FullRefresh&ReplaceAllMetadata=false&ReplaceAllImages=false`,
    );
    return r.ok
      ? { ok: true, result: `${service.name} is refreshing ${name}'s details and pictures.` }
      : { ok: false, result: refused(r) };
  }
  if (op === "edit-item") {
    const id = str("itemId");
    const next = JSON.parse(str("body") || "{}") as Record<string, string | number>;
    // Jellyfin takes the whole title back: read it as it is, change only what was approved.
    let full = await call<RawItem>("GET", `/Items/${enc(id)}`);
    // Emby reads a title only through a user (GET /Items/{id} is Jellyfin's).
    const emby = !full.ok;
    if (!full.ok) {
      const user = await ownerUser(call);
      if (user) full = await call<RawItem>("GET", `/Users/${enc(user.id)}/Items/${enc(id)}`);
    }
    if (!full.ok || !full.data)
      return { ok: false, stale: true, result: `${service.name} no longer has ${name}.` };
    const locks = new Set(full.data.LockedFields ?? []);
    if (next.Name !== undefined) locks.add("Name");
    if (next.Overview !== undefined) locks.add("Overview");
    // Emby takes a sort title as SortName and locks it by that name; Jellyfin reads ForcedSortName.
    if (emby && next.ForcedSortName !== undefined) locks.add("SortName");
    const r = await call<unknown>("POST", `/Items/${enc(id)}`, {
      ...full.data,
      ...next,
      ...(next.ForcedSortName !== undefined ? { SortName: next.ForcedSortName } : {}),
      LockedFields: [...locks],
    });
    if (!r.ok) return { ok: false, result: refused(r) };
    // Read back the whole title the same way (the list read lower-cases sort titles).
    let back: RawItem | undefined = (await call<RawItem>("GET", `/Items/${enc(id)}`)).data;
    if (!back?.Id) back = await readItem(call, id);
    const sameAs = (k: string) =>
      k === "ForcedSortName"
        ? String(back?.ForcedSortName ?? back?.SortName ?? "").toLowerCase() ===
          String(next[k]).toLowerCase()
        : String(back?.[k] ?? "") === String(next[k]);

    const off = Object.keys(next).filter((k) => !sameAs(k));
    return off.length
      ? {
          ok: false,
          result: `${service.name} took it, but ${off.join(", ")} does not read back as approved.`,
        }
      : {
          ok: true,
          verified: true,
          result: `${name}'s details are changed (read back) and kept when ${service.name} refreshes it.`,
        };
  }
  if (op === "plugin-enable" || op === "plugin-disable" || op === "plugin-uninstall") {
    const id = enc(str("pluginId"));
    const v = enc(str("version"));
    const r =
      op === "plugin-uninstall"
        ? await call<unknown>("DELETE", `/Plugins/${id}/${v}`).then(async (x) =>
            // Emby removes a plugin by its id alone.
            x.ok ? x : await call<unknown>("POST", `/Plugins/${id}/Delete`),
          )
        : await call<unknown>(
            "POST",
            `/Plugins/${id}/${v}/${op === "plugin-enable" ? "Enable" : "Disable"}`,
          );
    // Jellyfin can answer 404 here even when it did it: what it lists afterwards decides.
    const list = await call<{ Id?: string; Status?: string }[]>("GET", "/Plugins");
    const now = (list.ok ? list.data : []).find((x) => sameGuid(x.Id, str("pluginId")));
    const status = (now?.Status ?? "").toLowerCase();
    const worked =
      op === "plugin-disable"
        ? status === "disabled"
        : op === "plugin-enable"
          ? status !== "disabled" && Boolean(now)
          : !now || status === "deleted";
    if (!worked)
      return {
        ok: false,
        result: r.ok
          ? `${service.name} took it, but ${name} does not show the change.`
          : refused(r),
      };
    const verb =
      op === "plugin-enable" ? "enabled" : op === "plugin-disable" ? "disabled" : "removed";
    return {
      ok: true,
      verified: true,
      result: `${name} is ${verb} (read back). Restart ${service.name} from the Plugins tab to finish.`,
    };
  }
  if (op === "plugin-install") {
    const q = `assemblyGuid=${enc(str("guid"))}&version=${enc(str("version"))}${p.repositoryUrl ? `&repositoryUrl=${enc(str("repositoryUrl"))}` : ""}`;
    const r = await call<unknown>("POST", `/Packages/Installed/${enc(name)}?${q}`);
    if (!r.ok) return { ok: false, result: refused(r) };
    return {
      ok: true,
      result: `${service.name} is installing ${name} ${str("version")}. Restart it from the Plugins tab to finish.`,
    };
  }
  if (op === "restart") {
    const r = await call<unknown>("POST", "/System/Restart");
    if (!r.ok) return { ok: false, result: refused(r) };
    // Back when it answers again (and no longer waits for a restart).
    for (let i = 0; i < 45; i++) {
      await wait(2000);
      const info = await call<{ HasPendingRestart?: boolean }>("GET", "/System/Info").catch(
        () => undefined,
      );
      if (info?.ok && i > 1)
        return { ok: true, verified: true, result: `${service.name} restarted and answers again.` };
    }
    return {
      ok: false,
      result: `${service.name} took the restart but has not answered for 90 seconds.`,
    };
  }
  // Emby's libraries carry an Id (it removes and changes them by it); Jellyfin's are named.
  const libs = async () =>
    (
      await call<{ Name?: string; Id?: string; Locations?: string[] }[]>(
        "GET",
        "/Library/VirtualFolders",
      )
    ).data ?? [];
  if (op === "add-library") {
    const q = `name=${enc(str("name"))}&collectionType=${enc(str("type"))}&paths=${enc(str("path"))}&refreshLibrary=true`;
    const r = await call<unknown>("POST", `/Library/VirtualFolders?${q}`, { LibraryOptions: {} });
    if (!r.ok) return { ok: false, result: refused(r) };
    const back = (await libs()).find((l) => l.Name === str("name"));
    return back
      ? {
          ok: true,
          verified: true,
          result: `Added the ${str("name")} library (read back); ${service.name} is scanning it.`,
        }
      : { ok: false, result: `${service.name} took it, but the library is not in its list.` };
  }
  if (op === "add-folder") {
    const lib = (await libs()).find((l) => l.Name === str("library"));
    // Jellyfin finds the library by Name, Emby by Id: both are sent, each reads its own.
    const r = await call<unknown>("POST", "/Library/VirtualFolders/Paths?refreshLibrary=true", {
      Name: str("library"),
      ...(lib?.Id ? { Id: lib.Id, Path: str("path"), RefreshLibrary: true } : {}),
      PathInfo: { Path: str("path") },
    });
    if (!r.ok) return { ok: false, result: refused(r) };
    const back = (await libs()).find((l) => l.Name === str("library"));
    return back?.Locations?.includes(str("path"))
      ? {
          ok: true,
          verified: true,
          result: `${str("library")} now reads ${str("path")} (read back).`,
        }
      : {
          ok: false,
          result: `${service.name} took it, but ${str("library")} does not list the folder.`,
        };
  }
  if (op === "remove-folder") {
    const lib = (await libs()).find((l) => l.Name === str("library"));
    const r = lib?.Id
      ? await call<unknown>("POST", "/Library/VirtualFolders/Paths/Delete", {
          Id: lib.Id,
          Path: str("path"),
          RefreshLibrary: true,
        })
      : await call<unknown>(
          "DELETE",
          `/Library/VirtualFolders/Paths?name=${enc(str("library"))}&path=${enc(str("path"))}&refreshLibrary=true`,
        );
    if (!r.ok) return { ok: false, result: refused(r) };
    const back = (await libs()).find((l) => l.Name === str("library"));
    return back && !back.Locations?.includes(str("path"))
      ? {
          ok: true,
          verified: true,
          result: `${str("library")} no longer reads ${str("path")} (read back).`,
        }
      : { ok: false, result: `${service.name} took it, but the folder is still listed.` };
  }
  if (op === "remove-library") {
    const lib = (await libs()).find((l) => l.Name === str("library"));
    const r = lib?.Id
      ? await call<unknown>("POST", "/Library/VirtualFolders/Delete", { Id: lib.Id })
      : await call<unknown>(
          "DELETE",
          `/Library/VirtualFolders?name=${enc(str("library"))}&refreshLibrary=true`,
        );
    if (!r.ok) return { ok: false, result: refused(r) };
    return (await libs()).some((l) => l.Name === str("library"))
      ? { ok: false, result: `${service.name} took it, but the library is still listed.` }
      : {
          ok: true,
          verified: true,
          result: `Removed the ${str("library")} library (read back). Its files are untouched.`,
        };
  }
  // set-settings: each file read as it is, only the approved values changed, then read back.
  const want = JSON.parse(str("settings") || "{}") as Record<string, string | number | boolean>;
  for (const file of ["server", "encoding"] as const) {
    const defs = JELLYFIN_SETTINGS.filter((d) => d.file === file && d.id in want);
    if (!defs.length) continue;
    const path = file === "server" ? "/System/Configuration" : "/System/Configuration/encoding";
    const now = await call<Record<string, unknown>>("GET", path);
    if (!now.ok || !now.data) return { ok: false, result: refused(now) };
    const next = { ...now.data };
    for (const d of defs) next[d.key] = want[d.id];
    const r = await call<unknown>("POST", path, next);
    if (!r.ok) return { ok: false, result: refused(r) };
    const back = await call<Record<string, unknown>>("GET", path);
    const off = defs.filter((d) => String(back.data?.[d.key]) !== String(want[d.id]));
    if (off.length)
      return {
        ok: false,
        result: `${service.name} took it, but ${off.map((d) => d.label).join(", ")} does not read back as approved.`,
      };
  }
  return {
    ok: true,
    verified: true,
    result: `${service.name}'s settings are changed (read back): ${words(want)}.`,
  };
}

/** The panel's reads for the new tabs (Library, a title, Manage, Plugins, Settings). */
export async function readManageView(
  call: JellyfinCallFn,
  view: "library" | "item" | "libraries" | "plugins" | "settings" | "home",
  q: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (view === "home") return readHomeView(call, q);
  if (view === "settings") {
    const [server, encoding] = await Promise.all([
      call<Record<string, unknown>>("GET", "/System/Configuration"),
      call<Record<string, unknown>>("GET", "/System/Configuration/encoding"),
    ]);
    if (!server.ok) throw new Error(`The server answered ${server.status} for its settings.`);
    return {
      // Only what this server has: Emby names some settings its own way and lacks others.
      settings: JELLYFIN_SETTINGS.filter(
        (d) =>
          (d.file === "server" || encoding.ok) &&
          (d.file === "server" ? server.data : encoding.data)?.[d.key] !== undefined,
      ).map((d) => ({
        id: d.id,
        label: d.label,
        ...(d.summary ? { summary: d.summary } : {}),
        group: d.group,
        type: d.type,
        ...(d.options ? { options: d.options } : {}),
        ...(d.advanced ? { advanced: true } : {}),
        value: (d.file === "server" ? server.data : encoding.data)?.[d.key],
      })),
    };
  }
  if (view === "plugins") {
    const [inst, pk, info, repos] = await Promise.all([
      call<
        {
          Id?: string;
          Name?: string;
          Version?: string;
          Status?: string;
          Description?: string;
          CanUninstall?: boolean;
        }[]
      >("GET", "/Plugins"),
      call<RawPackage[]>("GET", "/Packages").catch(() => ({
        ok: false,
        status: 0,
        data: [] as RawPackage[],
      })),
      call<{ Version?: string; HasPendingRestart?: boolean }>("GET", "/System/Info"),
      call<{ Name?: string; Url?: string; Enabled?: boolean }[]>("GET", "/Repositories").catch(
        () => ({ ok: false, status: 0, data: [] }),
      ),
    ]);
    if (!inst.ok) throw new Error(`The server answered ${inst.status} for its plugins.`);
    const server = info.data?.Version ?? "0";
    const packages = pk.ok && Array.isArray(pk.data) ? pk.data : [];
    const installed = (inst.data ?? []).map((x) => {
      const pkg = packages.find((k) => sameGuid(k.guid, x.Id));
      const latest = pkg ? latestFor(pkg, server) : undefined;
      return {
        id: x.Id,
        name: x.Name ?? "A plugin",
        version: x.Version,
        status: x.Status,
        description: (x.Description ?? "").slice(0, 240),
        canRemove: x.CanUninstall !== false,
        ...(latest?.version && x.Version && newerVersion(latest.version, x.Version)
          ? { update: latest.version, guid: pkg!.guid }
          : {}),
      };
    });
    const find = (q.q ?? "").toLowerCase();
    const catalog = packages
      .map((k) => {
        const v = latestFor(k, server);
        const have = installed.find((i) => sameGuid(i.id, k.guid));
        return {
          guid: k.guid,
          name: k.name ?? "A plugin",
          overview: (k.overview ?? k.description ?? "").slice(0, 240),
          category: k.category,
          owner: k.owner,
          version: v?.version,
          repository: v?.repositoryName,
          ...(have ? { installed: have.version } : {}),
        };
      })
      .filter(
        (k) =>
          k.version &&
          (!find || `${k.name} ${k.overview} ${k.category}`.toLowerCase().includes(find)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      restartNeeded: Boolean(info.data?.HasPendingRestart),
      installed,
      catalog,
      catalogError: pk.ok
        ? undefined
        : "The server could not read its plugin catalog right now (it is online, at the maker's site).",
      repositories: (repos.ok ? repos.data : []).map((r) => ({
        name: r.Name,
        url: r.Url,
        enabled: r.Enabled !== false,
      })),
    };
  }
  if (view === "libraries") {
    const r = await call<
      {
        Name?: string;
        CollectionType?: string;
        ItemId?: string;
        Locations?: string[];
        RefreshStatus?: string;
      }[]
    >("GET", "/Library/VirtualFolders");
    if (!r.ok) throw new Error(`The server answered ${r.status} for its libraries.`);
    return {
      types: LIBRARY_TYPES,
      libraries: (r.data ?? []).map((l) => ({
        id: l.ItemId,
        name: l.Name ?? "A library",
        type: l.CollectionType ?? "mixed",
        folders: l.Locations ?? [],
        scanning: l.RefreshStatus === "Active",
      })),
    };
  }
  const user = await ownerUser(call);
  const uid = user ? `&UserId=${enc(user.id)}` : "";
  if (view === "item") {
    const id = q.id ?? "";
    if (!JELLYFIN_ITEM.test(id)) throw new Error("Not a title.");
    const r = await call<{ Items?: (RawItem & Record<string, unknown>)[] }>(
      "GET",
      `/Items?Ids=${enc(id)}${uid}&Fields=Overview,Genres,SortName,ProductionYear,Path,MediaSources,DateCreated,OfficialRating,CommunityRating,ChildCount`,
    );
    const it = r.ok ? r.data?.Items?.[0] : undefined;
    if (!it) throw new Error("The server does not have that title.");
    const folder = Boolean(it.IsFolder);
    const kids = folder
      ? await call<{ Items?: (RawItem & Record<string, unknown>)[] }>(
          "GET",
          `/Items?ParentId=${enc(id)}${uid}&SortBy=ParentIndexNumber,IndexNumber,SortName&Limit=300&Fields=ChildCount`,
        )
      : undefined;
    const ud = (x: Record<string, unknown>) =>
      (x.UserData ?? {}) as {
        Played?: boolean;
        UnplayedItemCount?: number;
        LastPlayedDate?: string;
      };
    const sources = (it.MediaSources ?? []) as {
      Path?: string;
      Size?: number;
      Container?: string;
      MediaStreams?: {
        Type?: string;
        Width?: number;
        Height?: number;
        Codec?: string;
        DisplayTitle?: string;
      }[];
    }[];
    return {
      id: it.Id,
      title: it.Name ?? "Untitled",
      type: (it.Type ?? "").toLowerCase(),
      year: it.ProductionYear,
      sortTitle: (it.ForcedSortName as string | undefined) ?? it.SortName ?? "",
      summary: it.Overview ?? "",
      genres: (it.Genres as string[] | undefined) ?? [],
      rating: it.OfficialRating,
      watched: Boolean(ud(it).Played),
      lastWatched: ud(it).LastPlayedDate,
      added: it.DateCreated,
      parent:
        it.Type === "Season"
          ? { id: it.SeriesId, title: it.SeriesName }
          : it.Type === "Episode"
            ? { id: it.SeasonId, title: it.SeasonName ?? it.SeriesName }
            : undefined,
      children: (kids?.data?.Items ?? []).map((c) => {
        const count = typeof c.ChildCount === "number" ? (c.ChildCount as number) : undefined;
        return {
          id: c.Id,
          title: c.Name ?? "Untitled",
          type: (c.Type ?? "").toLowerCase(),
          index: c.IndexNumber as number | undefined,
          watched: Boolean(ud(c).Played),
          ...(count !== undefined && c.IsFolder
            ? {
                episodes: count,
                episodesWatched: Math.max(0, count - (ud(c).UnplayedItemCount ?? 0)),
              }
            : {}),
        };
      }),
      files: sources.map((s) => {
        const video = s.MediaStreams?.find((m) => m.Type === "Video");
        const audio = s.MediaStreams?.find((m) => m.Type === "Audio");
        return {
          file: s.Path ?? "",
          size: s.Size ?? 0,
          resolution: video?.Height ? `${video.Height}p` : undefined,
          video: video?.Codec,
          audio: audio?.DisplayTitle,
        };
      }),
    };
  }
  // library
  const folders = await call<{ Name?: string; CollectionType?: string; ItemId?: string }[]>(
    "GET",
    "/Library/VirtualFolders",
  );
  if (!folders.ok) throw new Error(`The server answered ${folders.status} for its libraries.`);
  const sections = (folders.data ?? [])
    .filter((f) => f.ItemId)
    .map((f) => ({
      id: f.ItemId!,
      title: f.Name ?? "A library",
      type: f.CollectionType ?? "mixed",
    }));
  const section = sections.find((s) => s.id === q.section) ?? sections[0];
  if (!section) return { sections, items: [], total: 0, page: 1 };
  const TYPES: Record<string, string> = {
    movies: "Movie",
    tvshows: "Series",
    music: "MusicAlbum",
    musicvideos: "MusicVideo",
    homevideos: "Video,Photo",
    books: "Book,AudioBook",
    boxsets: "BoxSet",
  };
  const SORT: Record<string, string> = {
    added: "SortBy=DateCreated&SortOrder=Descending",
    title: "SortBy=SortName&SortOrder=Ascending",
    year: "SortBy=ProductionYear,SortName&SortOrder=Descending",
    watched: "SortBy=DatePlayed&SortOrder=Descending",
  };
  const page = Math.max(1, Math.min(1000, Number(q.page) || 1));
  const types = TYPES[section.type];
  const search = (q.q ?? "").trim().slice(0, 100);
  const parts = [
    `ParentId=${enc(section.id)}`,
    types ? `Recursive=true&IncludeItemTypes=${types}` : "Recursive=false",
    SORT[q.sort ?? "added"] ?? SORT.added,
    q.filter === "unwatched" ? "Filters=IsUnplayed" : "",
    search ? `SearchTerm=${enc(search)}` : "",
    `StartIndex=${(page - 1) * 60}&Limit=60&Fields=DateCreated&EnableImageTypes=Primary&ImageTypeLimit=1`,
  ].filter(Boolean);
  const r = await call<{
    Items?: (RawItem & Record<string, unknown>)[];
    TotalRecordCount?: number;
  }>("GET", `/Items?${parts.join("&")}${uid}`);
  if (!r.ok) throw new Error(`The server answered ${r.status} for ${section.title}.`);
  return {
    sections,
    section: section.id,
    total: r.data?.TotalRecordCount ?? 0,
    page,
    items: (r.data?.Items ?? []).map((x) => {
      const u = (x.UserData ?? {}) as { Played?: boolean; UnplayedItemCount?: number };
      return {
        id: x.Id,
        title: x.Name ?? "Untitled",
        year: x.ProductionYear,
        type: (x.Type ?? "").toLowerCase(),
        watched: Boolean(u.Played),
        ...(typeof u.UnplayedItemCount === "number" ? { unwatched: u.UnplayedItemCount } : {}),
        poster: Boolean((x.ImageTags as Record<string, string> | undefined)?.Primary),
      };
    }),
  };
}
