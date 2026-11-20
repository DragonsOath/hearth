import type {
  AppIssue,
  AppReport,
  PlexDashboard,
  PlexItem,
  PlexLibrary,
  PlexDuplicate,
  PlexSession,
} from "@dragon-control/core";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Plex Media Server, read only, with a Plex token from Secure Vault (sent as the
 * X-Plex-Token header to the server's own address, never put in a URL that leaves
 * Hearth). Library counts change slowly, so they are cached for a minute;
 * playback sessions and scans are read every time. Nothing here starts, stops,
 * scans, or changes anything.
 */

/** The only picture paths Hearth fetches for the browser (artwork proxy). */
export const PLEX_ART =
  /^\/library\/metadata\/\d+\/(thumb|art|grandparentThumb|parentThumb)(\/\d+)?$/;

interface MC<T> {
  MediaContainer?: T & { size?: number; totalSize?: number };
}

interface RawItem {
  ratingKey?: string;
  title?: string;
  type?: string;
  year?: number;
  grandparentTitle?: string;
  parentTitle?: string;
  parentIndex?: number;
  index?: number;
  addedAt?: number;
  thumb?: string;
  grandparentThumb?: string;
  parentThumb?: string;
  Media?: { Part?: { file?: string }[]; videoResolution?: string; bitrate?: number }[];
}

interface RawSession extends RawItem {
  sessionKey?: string;
  viewOffset?: number;
  duration?: number;
  User?: { title?: string };
  Player?: {
    title?: string;
    device?: string;
    platform?: string;
    product?: string;
    state?: string;
    local?: boolean;
  };
  Session?: { id?: string; bandwidth?: number; location?: string };
  Media?: { videoResolution?: string; bitrate?: number }[];
  TranscodeSession?: {
    videoDecision?: string;
    audioDecision?: string;
    throttled?: boolean;
    speed?: number;
    transcodeHwRequested?: boolean;
    transcodeHwFullPipeline?: boolean;
  };
}

const itemType = (t?: string): PlexItem["type"] =>
  t === "movie" || t === "episode" || t === "season" || t === "show" || t === "track" ? t : "other";

function toItem(r: RawItem): PlexItem {
  const type = itemType(r.type);
  const thumb =
    type === "episode"
      ? (r.grandparentThumb ?? r.parentThumb ?? r.thumb)
      : (r.thumb ?? r.parentThumb);
  return {
    id: String(r.ratingKey ?? ""),
    title: r.title ?? "Untitled",
    type,
    ...(r.year ? { year: r.year } : {}),
    ...(type === "episode" && r.grandparentTitle ? { show: r.grandparentTitle } : {}),
    ...(type === "season" && r.parentTitle ? { show: r.parentTitle } : {}),
    ...(type === "episode" && r.parentIndex !== undefined ? { season: r.parentIndex } : {}),
    ...(type === "episode" && r.index !== undefined ? { episode: r.index } : {}),
    ...(r.addedAt ? { addedAt: new Date(r.addedAt * 1000).toISOString() } : {}),
    ...(thumb && PLEX_ART.test(thumb) ? { thumb } : {}),
    ...(files(r).length ? { files: files(r) } : {}),
  };
}

const files = (r: RawItem) =>
  (r.Media ?? []).flatMap((m) => (m.Part ?? []).map((p) => p.file ?? "")).filter(Boolean);

export function toSession(r: RawSession): PlexSession {
  const t = r.TranscodeSession;
  const decision: PlexSession["decision"] = !t
    ? "direct play"
    : t.videoDecision === "transcode" || t.audioDecision === "transcode"
      ? "transcode"
      : "direct stream";
  const stateRaw = r.Player?.state;
  const state: PlexSession["state"] =
    stateRaw === "playing" || stateRaw === "paused" || stateRaw === "buffering"
      ? stateRaw
      : "other";
  const progressPct = r.duration ? Math.round(((r.viewOffset ?? 0) / r.duration) * 1000) / 10 : 0;
  const slow = decision === "transcode" && t?.speed !== undefined && t.speed < 1 && !t.throttled;
  const problem =
    state === "buffering"
      ? slow
        ? `Buffering: the transcoder runs at ${t!.speed!.toFixed(1)}x, slower than real time.`
        : "Buffering."
      : slow
        ? `The transcoder runs at ${t!.speed!.toFixed(1)}x, slower than real time: buffering is likely.`
        : undefined;
  return {
    ...toItem(r),
    sessionId: String(r.Session?.id ?? r.sessionKey ?? ""),
    user: r.User?.title ?? "Someone",
    player: r.Player?.title ?? r.Player?.product ?? "A player",
    ...(r.Player?.device ? { device: r.Player.device } : {}),
    ...(r.Player?.platform ? { platform: r.Player.platform } : {}),
    state,
    ...(r.Player?.local !== undefined ? { local: r.Player.local } : {}),
    progressPct,
    ...(r.duration ? { durationMs: r.duration } : {}),
    ...(r.viewOffset !== undefined ? { offsetMs: r.viewOffset } : {}),
    decision,
    ...(t?.videoDecision ? { videoDecision: t.videoDecision } : {}),
    ...(t?.audioDecision ? { audioDecision: t.audioDecision } : {}),
    ...(r.Media?.[0]?.videoResolution ? { resolution: r.Media[0].videoResolution } : {}),
    ...(r.Media?.[0]?.bitrate ? { bitrateKbps: r.Media[0].bitrate } : {}),
    ...(r.Session?.bandwidth ? { bandwidthKbps: r.Session.bandwidth } : {}),
    ...(t?.speed !== undefined ? { transcodeSpeed: Math.round(t.speed * 10) / 10 } : {}),
    ...(t
      ? { hardwareTranscode: Boolean(t.transcodeHwRequested || t.transcodeHwFullPipeline) }
      : {}),
    ...(problem ? { problem } : {}),
  };
}

async function plexGet<T>(fetchImpl: Fetch, base: string, path: string, token: string): Promise<T> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      headers: { Accept: "application/json", "X-Plex-Token": token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(
      `Plex did not answer at ${base}: ${why.replaceAll(token, "[hidden]")}`,
    );
  }
  if (res.status === 401)
    throw new AppKeyError(
      "Plex refused the token. Link Plex again or replace the token in the vault.",
    );
  if (!res.ok)
    throw new AppUnreachableError(`Plex answered ${res.status} for ${path.split("?")[0]}.`);
  return (await res.json()) as T;
}

interface Slow {
  at: number;
  version?: string;
  serverName?: string;
  libraries: PlexLibrary[];
  recentlyAdded: PlexItem[];
}

/** How often the whole library is checked for titles with more than one copy. */
export const DUPLICATE_SCAN_MS = 6 * 3_600_000;

export class PlexLive {
  private slow = new Map<string, Slow>();
  private dupes = new Map<string, { at: number; list: PlexDuplicate[] }>();

  /**
   * Titles with more than one version (Plex's own "duplicate" filter, checked again here by
   * counting versions, so a Plex that ignores the filter cannot flag everything).
   */
  private async duplicates(
    serviceId: string,
    base: string,
    token: string,
    libraries: PlexLibrary[],
  ) {
    const cached = this.dupes.get(serviceId);
    if (cached && Date.now() - cached.at < DUPLICATE_SCAN_MS) return cached.list;
    const list: PlexDuplicate[] = [];
    for (const lib of libraries) {
      if (lib.type !== "movie" && lib.type !== "show") continue;
      const type = lib.type === "movie" ? 1 : 4;
      const r = await plexGet<
        MC<{
          Metadata?: (RawItem & {
            ratingKey?: string;
            Media?: unknown[];
            grandparentTitle?: string;
            parentIndex?: number;
            index?: number;
          })[];
        }>
      >(
        this.fetchImpl,
        base,
        `/library/sections/${encodeURIComponent(lib.key)}/all?type=${type}&duplicate=1`,
        token,
      ).catch(() => undefined);
      for (const m of r?.MediaContainer?.Metadata ?? []) {
        const versions = Array.isArray(m.Media) ? m.Media.length : 0;
        if (versions < 2 || !m.ratingKey) continue;
        list.push({
          ratingKey: m.ratingKey,
          title:
            type === 1
              ? `${m.title ?? "Untitled"}${m.year ? ` (${m.year})` : ""}`
              : `${m.grandparentTitle ?? "A show"} S${String(m.parentIndex ?? 0).padStart(2, "0")}E${String(m.index ?? 0).padStart(2, "0")}`,
          kind: type === 1 ? "movie" : "episode",
          versions,
        });
      }
    }
    this.dupes.set(serviceId, { at: Date.now(), list });
    return list;
  }

  constructor(private readonly fetchImpl: Fetch) {}

  private async readSlow(base: string, token: string): Promise<Slow> {
    const get = <T>(path: string) => plexGet<T>(this.fetchImpl, base, path, token);
    const [root, sections, recent] = await Promise.all([
      get<MC<{ version?: string; friendlyName?: string }>>("/"),
      get<MC<{ Directory?: { key?: string; title?: string; type?: string }[] }>>(
        "/library/sections",
      ),
      get<MC<{ Metadata?: RawItem[] }>>(
        "/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=50",
      ),
    ]);
    const count = async (key: string, type?: number) =>
      (
        await get<MC<object>>(
          `/library/sections/${encodeURIComponent(key)}/all?${type ? `type=${type}&` : ""}X-Plex-Container-Start=0&X-Plex-Container-Size=0`,
        )
      ).MediaContainer?.totalSize ?? 0;
    const libraries = await Promise.all(
      (sections.MediaContainer?.Directory ?? [])
        .filter((d) => d.key)
        .map(async (d): Promise<PlexLibrary> => {
          const type =
            d.type === "movie" || d.type === "show" || d.type === "artist" || d.type === "photo"
              ? d.type
              : "other";
          if (type === "show") {
            const [shows, seasons, episodes] = await Promise.all([
              count(d.key!, 2),
              count(d.key!, 3),
              count(d.key!, 4),
            ]);
            return {
              key: d.key!,
              title: d.title ?? "Library",
              type,
              count: shows,
              seasons,
              episodes,
            };
          }
          return { key: d.key!, title: d.title ?? "Library", type, count: await count(d.key!) };
        }),
    );
    return {
      at: Date.now(),
      version: root.MediaContainer?.version,
      serverName: root.MediaContainer?.friendlyName,
      libraries,
      recentlyAdded: (recent.MediaContainer?.Metadata ?? []).map(toItem),
    };
  }

  async dashboard(serviceId: string, base: string, token: string): Promise<PlexDashboard> {
    let slow = this.slow.get(serviceId);
    if (!slow || Date.now() - slow.at > 60_000) {
      slow = await this.readSlow(base, token);
      this.slow.set(serviceId, slow);
    }
    const [sessions, activities] = await Promise.all([
      plexGet<MC<{ Metadata?: RawSession[] }>>(this.fetchImpl, base, "/status/sessions", token),
      plexGet<MC<{ Activity?: { title?: string; subtitle?: string; progress?: number }[] }>>(
        this.fetchImpl,
        base,
        "/activities",
        token,
      ).catch(
        () => ({}) as MC<{ Activity?: { title?: string; subtitle?: string; progress?: number }[] }>,
      ),
    ]);
    const sum = (f: (l: PlexLibrary) => number) => slow!.libraries.reduce((n, l) => n + f(l), 0);
    const duplicates = await this.duplicates(serviceId, base, token, slow.libraries).catch(
      () => undefined,
    );
    return {
      app: "plex",
      ...(slow.version ? { version: slow.version } : {}),
      ...(slow.serverName ? { serverName: slow.serverName } : {}),
      totals: {
        movies: sum((l) => (l.type === "movie" ? l.count : 0)),
        shows: sum((l) => (l.type === "show" ? l.count : 0)),
        seasons: sum((l) => l.seasons ?? 0),
        episodes: sum((l) => l.episodes ?? 0),
      },
      libraries: slow.libraries,
      recentlyAdded: slow.recentlyAdded,
      sessions: (sessions.MediaContainer?.Metadata ?? []).map(toSession),
      activities: (activities.MediaContainer?.Activity ?? []).map((a) => ({
        title: a.title ?? "Working",
        ...(a.subtitle ? { subtitle: a.subtitle } : {}),
        ...(a.progress !== undefined ? { progressPct: a.progress } : {}),
      })),
      ...(duplicates ? { duplicates } : {}),
    };
  }
}

/** The background health read, from the same dashboard. */
export function plexReport(d: PlexDashboard): Omit<AppReport, "serviceId" | "checkedAt"> {
  const issues: AppIssue[] = d.sessions
    .filter((s) => s.problem)
    .map((s) => ({
      level: "warning" as const,
      key: `session:${s.sessionId}`,
      text: `${s.user} on ${s.player}: ${s.problem}`,
    }));
  // Extra copies: worth knowing (space, and a sign of re-grabs), not an alarm; keeping two
  // qualities on purpose is common.
  if (d.duplicates?.length) {
    const names = d.duplicates.slice(0, 6).map((x) => x.title);
    issues.push({
      level: "warning",
      key: "duplicates",
      text: `${d.duplicates.length} ${d.duplicates.length === 1 ? "title has" : "titles have"} more than one copy in Plex (${names.join(", ")}${d.duplicates.length > names.length ? ", ..." : ""}). If they are not on purpose, Ember can remove the extra copies with your approval.`,
    });
  }
  return {
    app: "plex",
    version: d.version,
    status: worst(issues),
    issues,
    facts: [
      { label: "Movies", value: d.totals.movies.toLocaleString() },
      {
        label: "Shows",
        value: `${d.totals.shows.toLocaleString()} (${d.totals.episodes.toLocaleString()} episodes)`,
      },
      { label: "Watching now", value: String(d.sessions.length) },
      {
        label: "Transcoding",
        value: String(d.sessions.filter((s) => s.decision === "transcode").length),
      },
    ],
    activity: d.recentlyAdded.slice(0, 8).map((i) => ({
      ...(i.addedAt ? { at: i.addedAt } : {}),
      text: `Added: ${i.show ? `${i.show} S${i.season ?? "?"}E${i.episode ?? "?"} ${i.title}` : i.title}`,
      tone: "good" as const,
    })),
  };
}
