import type { ServarrGet } from "./servarr-panel";
import { readManageView } from "./jellyfin-manage";

/**
 * The native Jellyfin panel's tabs beyond its Overview: People (users, what they can reach,
 * whether they may download), Devices (signed-in apps), Activity (Jellyfin's own log of sign-ins,
 * playback and changes), and System (server logs with keys hidden, and plugins). Reads only;
 * changes are plan steps (jellyfin.ts). Passwords, API keys and server settings stay in Jellyfin.
 */

export const JELLYFIN_VIEWS = [
  "users",
  "devices",
  "activity",
  "logs",
  "log",
  "plugins",
  "library",
  "item",
  "libraries",
  "settings",
  "home",
] as const;
export type JellyfinView = (typeof JELLYFIN_VIEWS)[number];

export class JellyfinReadError extends Error {}

async function get<T>(read: ServarrGet, path: string): Promise<T> {
  const r = await read(path);
  if (!r.ok)
    throw new JellyfinReadError(`Jellyfin answered ${r.status} for ${path.split("?")[0]}.`);
  return r.data as T;
}

/** Keys, tokens and passwords out of a log line before it leaves Hearth. */
export function scrubLog(line: string): string {
  return line
    .replace(
      /((?:api_?key|token|password|pw|X-Emby-Token|access_token)["'=:\s]+)[^\s"'&,;]+/gi,
      "$1[hidden]",
    )
    .replace(/Token="[^"]*"/g, 'Token="[hidden]"')
    .replace(/\b[a-f0-9]{32}\b/gi, "[hidden]");
}

interface RawUser {
  Id: string;
  Name?: string;
  LastActivityDate?: string;
  LastLoginDate?: string;
  HasPassword?: boolean;
  Policy?: {
    IsAdministrator?: boolean;
    IsDisabled?: boolean;
    EnableAllFolders?: boolean;
    EnabledFolders?: string[];
    EnableContentDownloading?: boolean;
  };
}

export async function readJellyfinView(
  read: ServarrGet,
  view: JellyfinView,
  q: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (view === "users") {
    const [users, folders] = await Promise.all([
      get<RawUser[]>(read, "/Users"),
      get<{ ItemId?: string; Name?: string }[]>(read, "/Library/VirtualFolders"),
    ]);
    const libs = folders
      .filter((f) => f.ItemId)
      .map((f) => ({ id: f.ItemId!, name: f.Name ?? f.ItemId! }));
    return {
      libraries: libs,
      users: users.map((u) => ({
        id: u.Id,
        name: u.Name ?? "A user",
        admin: Boolean(u.Policy?.IsAdministrator),
        disabled: Boolean(u.Policy?.IsDisabled),
        allLibraries: u.Policy?.EnableAllFolders !== false,
        libraries: u.Policy?.EnableAllFolders === false ? (u.Policy.EnabledFolders ?? []) : [],
        downloads: Boolean(u.Policy?.EnableContentDownloading),
        lastSeen: u.LastActivityDate ?? u.LastLoginDate,
      })),
    };
  }
  if (view === "devices") {
    const r = await get<{
      Items?: {
        Id: string;
        /** Emby's: the id the app reported (Jellyfin's Id is that id already). */
        ReportedDeviceId?: string;
        Name?: string;
        AppName?: string;
        AppVersion?: string;
        LastUserName?: string;
        DateLastActivity?: string;
      }[];
    }>(read, "/Devices");
    return {
      devices: (r.Items ?? [])
        // Hearth itself is not a signed-in device anyone manages.
        .filter((d) => (d.ReportedDeviceId ?? d.Id) !== "hearth")
        .map((d) => ({
          id: d.Id,
          name: d.Name ?? "A device",
          app: [d.AppName, d.AppVersion].filter(Boolean).join(" "),
          user: d.LastUserName,
          lastSeen: d.DateLastActivity,
        }))
        .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "")),
    };
  }
  if (view === "activity") {
    const page = Math.max(1, Math.min(100, Number(q.page) || 1));
    const r = await get<{
      Items?: {
        Id: number;
        Name?: string;
        ShortOverview?: string;
        Type?: string;
        Date?: string;
        Severity?: string;
        UserId?: string;
      }[];
      TotalRecordCount?: number;
    }>(read, `/System/ActivityLog/Entries?startIndex=${(page - 1) * 50}&limit=50`);
    return {
      page,
      total: r.TotalRecordCount ?? 0,
      entries: (r.Items ?? []).map((e) => ({
        id: e.Id,
        text: scrubLog(e.Name ?? ""),
        detail: e.ShortOverview ? scrubLog(e.ShortOverview) : undefined,
        type: e.Type,
        at: e.Date,
        level: e.Severity,
      })),
    };
  }
  if (view === "logs") {
    const files = await get<{ Name: string; Size?: number; DateModified?: string }[]>(
      read,
      "/System/Logs",
    );
    return {
      files: files
        .map((f) => ({ name: f.Name, size: f.Size ?? 0, modified: f.DateModified }))
        .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? "")),
    };
  }
  if (view === "log") {
    const name = q.name ?? "";
    // Only a plain log file name Jellyfin listed, never a path.
    if (!/^[\w.-]+\.(log|txt)$/i.test(name)) throw new JellyfinReadError("Not a log file name.");
    const r = await read(`/System/Logs/Log?name=${encodeURIComponent(name)}`);
    if (!r.ok) throw new JellyfinReadError(`Jellyfin answered ${r.status} for that log.`);
    const text = typeof r.data === "string" ? r.data : "";
    const lines = text.split(/\r?\n/).filter(Boolean);
    return { name, total: lines.length, lines: lines.slice(-400).map(scrubLog) };
  }
  // The tabs that match Plex's (jellyfin-manage.ts): reads only, through the same read.
  if (
    view === "library" ||
    view === "item" ||
    view === "libraries" ||
    view === "settings" ||
    view === "plugins" ||
    view === "home"
  )
    return readManageView(
      async <T>(_method: string, path: string) => {
        const r = await read(path);
        return { ok: r.ok, status: r.status, data: r.data as T };
      },
      view,
      q,
    ).catch((e: unknown) => {
      // Its plain answers ("Jellyfin does not have that title") are the panel's to show.
      if (e instanceof Error && e.constructor === Error) throw new JellyfinReadError(e.message);
      throw e;
    });
  throw new JellyfinReadError("Not a panel view.");
}
