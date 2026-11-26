import type { ServarrGet } from "./servarr-panel";

/**
 * The native Plex panel's tabs beyond its Overview: Library (browse each library, open a title with
 * its files, seasons and episodes), History (what was watched, by whom), Tasks (Plex's own
 * maintenance tasks and what it is doing now) and Settings (Plex's server settings as Plex lists
 * them). Reads only; changes are plan steps (plex-control.ts). Sharing, users and remote access
 * need a plex.tv account or are networking: those stay in Plex, linked from the panel.
 */

export const PLEX_VIEWS = [
  "library",
  "item",
  "history",
  "tasks",
  "settings",
  "manage",
  "access",
] as const;
export type PlexView = (typeof PLEX_VIEWS)[number];

export class PlexReadError extends Error {}

interface MC<T> {
  MediaContainer?: T;
}

async function get<T>(read: ServarrGet, path: string): Promise<T> {
  const r = await read(path);
  if (!r.ok) throw new PlexReadError(`Plex answered ${r.status} for ${path.split("?")[0]}.`);
  return r.data as T;
}

/**
 * Settings Hearth never offers to change: networking and remote access (protected), and anything
 * that looks like a credential. They are shown read only, with a link to Plex.
 */
export const PLEX_LOCKED_GROUPS = new Set(["network", "dlna"]);
const SECRET = /token|password|secret|key$|cert/i;
export const plexSettingLocked = (s: { id: string; group?: string }) =>
  PLEX_LOCKED_GROUPS.has(s.group ?? "") || SECRET.test(s.id);

interface RawPart {
  id?: number;
  file?: string;
  size?: number;
  container?: string;
}
interface RawMedia {
  id?: number;
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
  container?: string;
  Part?: RawPart[];
}
export interface RawItem {
  ratingKey: string;
  type?: string;
  title?: string;
  titleSort?: string;
  year?: number;
  summary?: string;
  thumb?: string;
  addedAt?: number;
  lastViewedAt?: number;
  viewCount?: number;
  /** Your own rating, out of 10. */
  userRating?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
  index?: number;
  parentIndex?: number;
  grandparentTitle?: string;
  parentTitle?: string;
  librarySectionID?: number;
  Media?: RawMedia[];
}

/** A library's rows (Plex's hubs) as Plex's Manage Libraries page lists them. */
export interface RawHub {
  identifier: string;
  title?: string;
  promotedToRecommended?: boolean;
  promotedToOwnHome?: boolean;
  promotedToSharedHome?: boolean;
}

export const hubOf = (h: RawHub) => ({
  id: h.identifier,
  title: h.title ?? h.identifier,
  recommended: Boolean(h.promotedToRecommended),
  home: Boolean(h.promotedToOwnHome),
  shared: Boolean(h.promotedToSharedHome),
});

export async function readHubs(read: ServarrGet, section: string) {
  const r = await get<MC<{ Hub?: RawHub[] }>>(
    read,
    `/hubs/sections/${encodeURIComponent(section)}/manage`,
  );
  return (r.MediaContainer?.Hub ?? []).filter((h) => h.identifier).map(hubOf);
}

const at = (s?: number) => (s ? new Date(s * 1000).toISOString() : undefined);

/** Watched for a film or an episode, or every episode watched for a show or season. */
export function watchedOf(m: RawItem): boolean {
  if (m.leafCount !== undefined) return m.leafCount > 0 && (m.viewedLeafCount ?? 0) >= m.leafCount;
  return (m.viewCount ?? 0) > 0;
}

const card = (m: RawItem) => ({
  id: m.ratingKey,
  type: m.type,
  title: m.title ?? "Untitled",
  year: m.year,
  thumb: m.thumb,
  added: at(m.addedAt),
  watched: watchedOf(m),
  episodes: m.leafCount,
  episodesWatched: m.viewedLeafCount,
  index: m.index,
});

const SORTS: Record<string, string> = {
  added: "addedAt:desc",
  title: "titleSort",
  year: "year:desc",
  watched: "lastViewedAt:desc",
};

export async function readPlexView(
  read: ServarrGet,
  view: PlexView,
  q: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  if (view === "library") {
    const s = await get<MC<{ Directory?: { key: string; title?: string; type?: string }[] }>>(
      read,
      "/library/sections",
    );
    const sections = (s.MediaContainer?.Directory ?? []).map((d) => ({
      id: String(d.key),
      title: d.title ?? `Library ${d.key}`,
      type: d.type,
    }));
    const section = sections.find((x) => x.id === q.section) ?? sections[0];
    if (!section) return { sections, items: [], total: 0, page: 1 };
    const page = Math.max(1, Math.min(500, Number(q.page) || 1));
    const size = 60;
    const params = new URLSearchParams({
      sort: SORTS[q.sort ?? "added"] ?? SORTS.added!,
      "X-Plex-Container-Start": String((page - 1) * size),
      "X-Plex-Container-Size": String(size),
    });
    // Plex reads a comma in a filter as "or": "Love, Simon" finds every Love and every Simon,
    // and the one wanted can fall off the page (the owner, 11-25: Curator offered only Jellyfin
    // for Love, Simon). So it is searched by its longest part and narrowed to the whole title here.
    const typed = q.q?.slice(0, 100);
    const parts = (typed ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (typed)
      params.set(
        "title",
        parts.length > 1 ? parts.reduce((a, b) => (b.length > a.length ? b : a)) : typed,
      );
    if (q.filter === "unwatched") params.set("unwatched", "1");
    const r = await get<MC<{ totalSize?: number; size?: number; Metadata?: RawItem[] }>>(
      read,
      `/library/sections/${encodeURIComponent(section.id)}/all?${params.toString()}`,
    );
    const loose = (x: string) =>
      x
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const all = r.MediaContainer?.Metadata ?? [];
    const narrowed = parts.length > 1;
    const items = narrowed
      ? all.filter((m) => loose(m.title ?? "").includes(loose(typed ?? "")))
      : all;
    return {
      sections,
      section: section.id,
      page,
      total: narrowed
        ? items.length
        : (r.MediaContainer?.totalSize ?? r.MediaContainer?.size ?? items.length),
      items: items.map(card),
    };
  }
  if (view === "item") {
    const id = q.id ?? "";
    if (!/^\d+$/.test(id)) throw new PlexReadError("Not a Plex item.");
    const r = await get<MC<{ Metadata?: RawItem[] }>>(read, `/library/metadata/${id}`);
    const m = r.MediaContainer?.Metadata?.[0];
    if (!m) throw new PlexReadError("Plex does not have that item any more.");
    // A show has seasons, a season has episodes.
    const children =
      m.type === "show" || m.type === "season"
        ? ((await get<MC<{ Metadata?: RawItem[] }>>(read, `/library/metadata/${id}/children`))
            .MediaContainer?.Metadata ?? [])
        : [];
    return {
      id: m.ratingKey,
      type: m.type,
      title: m.title ?? "Untitled",
      // Plex sorts by the title when no sort title is set.
      sortTitle: m.titleSort ?? m.title ?? "",
      year: m.year,
      summary: m.summary ?? "",
      thumb: m.thumb,
      show: m.grandparentTitle ?? m.parentTitle,
      added: at(m.addedAt),
      lastWatched: at(m.lastViewedAt),
      watched: watchedOf(m),
      viewCount: m.viewCount ?? 0,
      section: m.librarySectionID !== undefined ? String(m.librarySectionID) : undefined,
      versions: (m.Media ?? []).map((v) => ({
        id: v.id,
        resolution: v.videoResolution,
        video: v.videoCodec,
        audio: v.audioCodec,
        bitrate: v.bitrate,
        container: v.container,
        files: (v.Part ?? []).map((p) => ({ file: p.file, size: p.size })),
      })),
      children: children.map(card),
    };
  }
  if (view === "history") {
    const page = Math.max(1, Math.min(100, Number(q.page) || 1));
    const size = 50;
    const [h, accounts] = await Promise.all([
      get<
        MC<{
          totalSize?: number;
          Metadata?: {
            historyKey?: string;
            ratingKey?: string;
            title?: string;
            grandparentTitle?: string;
            parentIndex?: number;
            index?: number;
            type?: string;
            viewedAt?: number;
            accountID?: number;
            deviceID?: number;
          }[];
        }>
      >(
        read,
        `/status/sessions/history/all?sort=viewedAt:desc&X-Plex-Container-Start=${(page - 1) * size}&X-Plex-Container-Size=${size}`,
      ),
      get<MC<{ Account?: { id: number; name?: string }[] }>>(read, "/accounts").catch(() => ({
        MediaContainer: { Account: [] },
      })),
    ]);
    const who = new Map(
      (accounts.MediaContainer?.Account ?? []).map((a) => [a.id, a.name || `Account ${a.id}`]),
    );
    const entries = h.MediaContainer?.Metadata ?? [];
    return {
      page,
      total: h.MediaContainer?.totalSize ?? entries.length,
      entries: entries.map((e) => ({
        id: e.historyKey ?? `${e.ratingKey}-${e.viewedAt}`,
        item: e.ratingKey,
        title:
          e.type === "episode" && e.grandparentTitle
            ? `${e.grandparentTitle} S${String(e.parentIndex ?? 0).padStart(2, "0")}E${String(e.index ?? 0).padStart(2, "0")} ${e.title ?? ""}`.trim()
            : (e.title ?? "Something"),
        who:
          e.accountID !== undefined
            ? (who.get(e.accountID) ?? `Account ${e.accountID}`)
            : undefined,
        at: at(e.viewedAt),
      })),
    };
  }
  if (view === "tasks") {
    const [b, a] = await Promise.all([
      get<{
        ButlerTasks?: {
          ButlerTask?: {
            name: string;
            title?: string;
            description?: string;
            interval?: number;
            enabled?: boolean;
          }[];
        };
      }>(read, "/butler"),
      get<
        MC<{
          Activity?: {
            uuid?: string;
            type?: string;
            title?: string;
            subtitle?: string;
            progress?: number;
            cancellable?: boolean;
          }[];
        }>
      >(read, "/activities"),
    ]);
    return {
      tasks: (b.ButlerTasks?.ButlerTask ?? [])
        // Plex lists a few internal tasks without a title; they are shown by name.
        .map((t) => ({
          name: t.name,
          title: t.title ?? t.name.replace(/^ButlerTask/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
          description: t.description,
          everyDays: t.interval,
          enabled: Boolean(t.enabled),
        })),
      activities: (a.MediaContainer?.Activity ?? []).map((x) => ({
        id: x.uuid,
        type: x.type,
        title: x.title ?? x.type ?? "Working",
        detail: x.subtitle,
        progress: x.progress,
      })),
    };
  }
  if (view === "manage") {
    // Manage (the owner, 2026-11-02): the libraries, and each one's rows with where they show,
    // as Plex's own Manage Libraries page: Library Recommended, Home, Friends' Home, in order.
    const [s, prefs] = await Promise.all([
      get<MC<{ Directory?: { key: string; title?: string; type?: string }[] }>>(
        read,
        "/library/sections",
      ),
      get<MC<{ Setting?: { id: string; value?: unknown }[] }>>(read, "/:/prefs").catch(
        () => undefined,
      ),
    ]);
    const sections = (s.MediaContainer?.Directory ?? []).map((d) => ({
      id: String(d.key),
      title: d.title ?? `Library ${d.key}`,
      type: d.type,
    }));
    const merge = prefs?.MediaContainer?.Setting?.find((x) => x.id === "MergedRecentlyAdded");
    const section = sections.find((x) => x.id === q.section) ?? sections[0];
    let rows: ReturnType<typeof hubOf>[] = [];
    let rowsError: string | undefined;
    if (section)
      rows = await readHubs(read, section.id).catch((e: unknown) => {
        // Plex manages rows only for its owner: a server not signed in to a Plex account has none.
        rowsError =
          e instanceof PlexReadError && / 40[134] /.test(e.message)
            ? "Plex did not list this library's rows: managing them needs the Plex account that owns this server."
            : e instanceof Error
              ? e.message
              : String(e);
        return [];
      });
    return {
      sections,
      section: section?.id,
      rows,
      ...(rowsError ? { rowsError } : {}),
      merge: merge ? merge.value === true || merge.value === "1" || merge.value === 1 : null,
    };
  }
  // settings
  const r = await get<
    MC<{
      Setting?: {
        id: string;
        label?: string;
        summary?: string;
        type?: string;
        default?: unknown;
        value?: unknown;
        hidden?: boolean;
        advanced?: boolean;
        group?: string;
        enumValues?: string;
      }[];
    }>
  >(read, "/:/prefs");
  return {
    settings: (r.MediaContainer?.Setting ?? [])
      .filter((s) => !s.hidden && s.label && s.group)
      .map((s) => {
        const locked = plexSettingLocked(s);
        return {
          id: s.id,
          label: s.label!,
          summary: s.summary || undefined,
          type: s.type,
          group: s.group!,
          advanced: Boolean(s.advanced),
          // A credential-like value never leaves Hearth; a locked setting shows only its state.
          value: SECRET.test(s.id) ? undefined : s.value,
          default: SECRET.test(s.id) ? undefined : s.default,
          options: s.enumValues
            ? s.enumValues.split("|").map((o) => {
                const [v, ...l] = o.split(":");
                return { value: v!, label: l.join(":") || v! };
              })
            : undefined,
          locked,
        };
      }),
  };
}
