import type { AppIssue, AppReport, JellyfinDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { getSetting, setSetting } from "../store/settings";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";
import {
  isManageOp,
  JELLYFIN_MANAGE_OPS,
  planManage,
  runManage,
  type JellyfinCallFn,
} from "./jellyfin-manage";

/**
 * Jellyfin, with an API key the owner creates in Jellyfin (Dashboard > API Keys) and pastes once:
 * Jellyfin stores its keys in its database, so Hearth cannot take one from its files. The health
 * read, the panel (who is watching and how, libraries, users, scheduled tasks that failed, what
 * was added), and the everyday controls (scan libraries, stop a stream with a message, run a
 * scheduled task). Each control is a plan confirmed in the panel.
 */

type Method = "GET" | "POST" | "DELETE";

/** A Jellyfin user's policy: the parts Hearth reads and changes (the rest is sent back as it was). */
interface Policy {
  IsAdministrator?: boolean;
  IsDisabled?: boolean;
  EnableAllFolders?: boolean;
  EnabledFolders?: string[];
  EnableContentDownloading?: boolean;
  [k: string]: unknown;
}
interface RawUser {
  Id: string;
  Name?: string;
  Policy?: Policy;
}

/** One call to Jellyfin's API with its key (also used by the panel's tabs, jellyfin-panel.ts). */
export async function jellyfinCall<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  method: Method,
  path: string,
  body?: unknown,
) {
  return call<T>(fetchImpl, base, key, method, path, body);
}

/** A call bound to one Jellyfin and its key (for jellyfin-manage.ts). */
export const callFor =
  (fetchImpl: Fetch, base: string, key: string): JellyfinCallFn =>
  (method, path, body) =>
    call(fetchImpl, base, key, method, path, body);

async function call<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        Authorization: `MediaBrowser Client="Hearth", Device="Hearth", DeviceId="hearth", Version="1", Token="${key}"`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.replaceAll(key, "[hidden]") : "no answer";
    throw new AppUnreachableError(`The media server did not answer at ${base}: ${why}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError(
      "The media server refused the API key. Create one in it and paste it in its panel.",
    );
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

async function get<T>(fetchImpl: Fetch, base: string, key: string, path: string): Promise<T> {
  const r = await call<T>(fetchImpl, base, key, "GET", path);
  if (!r.ok)
    throw new AppUnreachableError(
      `The media server answered ${r.status} for ${path.split("?")[0]}.`,
    );
  return r.data;
}

interface Session {
  Id: string;
  UserName?: string;
  Client?: string;
  DeviceName?: string;
  RemoteEndPoint?: string;
  NowPlayingItem?: {
    Name?: string;
    SeriesName?: string;
    Type?: string;
    RunTimeTicks?: number;
    ProductionYear?: number;
  };
  PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string };
  TranscodingInfo?: {
    TranscodeReasons?: string[];
    IsVideoDirect?: boolean;
    VideoCodec?: string;
    Width?: number;
  };
}
interface Task {
  Id: string;
  Name?: string;
  State?: string;
  Category?: string;
  IsHidden?: boolean;
  Triggers?: unknown[];
  LastExecutionResult?: { Status?: string; EndTimeUtc?: string; ErrorMessage?: string };
}

/** Jellyfin's transcode reasons in plain words. */
const REASONS: Record<string, string> = {
  ContainerNotSupported: "the player cannot open the file type",
  VideoCodecNotSupported: "the player cannot play the video format",
  AudioCodecNotSupported: "the player cannot play the audio format",
  SubtitleCodecNotSupported: "subtitles have to be burned in",
  VideoResolutionNotSupported: "the resolution is too high for the player",
  VideoBitrateNotSupported: "the video bitrate is above the player's limit",
  ContainerBitrateExceedsLimit: "the file's bitrate is above the streaming limit",
  AudioChannelsNotSupported: "the player cannot play that many audio channels",
  VideoLevelNotSupported: "the video's profile level is too high for the player",
  VideoRangeTypeNotSupported: "the player cannot show HDR",
};
export const whyTranscode = (reasons?: string[]) =>
  reasons?.length ? `Converting: ${reasons.map((r) => REASONS[r] ?? r).join("; ")}.` : undefined;

/** What to count in each kind of library, and what to call it. */
const SIZE_KINDS: Record<string, [string, string][]> = {
  movies: [["Movie", "movies"]],
  tvshows: [
    ["Series", "shows"],
    ["Episode", "episodes"],
  ],
  music: [["MusicAlbum", "albums"]],
  books: [["Book", "books"]],
  boxsets: [["BoxSet", "collections"]],
  homevideos: [["Video", "videos"]],
  musicvideos: [["MusicVideo", "music videos"]],
};

/** A Jellyfin item id, as its API writes them (32 hex characters, or the stand-in's names). */
export const JELLYFIN_ITEM = /^[\w-]{1,64}$/;

/**
 * An item's poster for the panel, fetched with the key server side (the browser never sees it).
 * Only an image answer is passed on, at most 2 MB.
 */
export async function jellyfinPoster(
  fetchImpl: Fetch,
  base: string,
  key: string,
  itemId: string,
): Promise<{ bytes: Buffer; type: string } | undefined> {
  if (!JELLYFIN_ITEM.test(itemId)) return undefined;
  const res = await fetchImpl(
    joinUrl(base, `/Items/${encodeURIComponent(itemId)}/Images/Primary?fillHeight=180&quality=85`),
    {
      method: "GET",
      headers: { Authorization: `MediaBrowser Token="${key}"` },
      signal: AbortSignal.timeout(8000),
    },
  ).catch(() => undefined);
  const type = res?.headers?.get("content-type") ?? "";
  if (!res?.ok || !res.arrayBuffer || !/^image\//.test(type)) return undefined;
  const bytes = Buffer.from(await res.arrayBuffer());
  return bytes.length <= 2 * 1024 * 1024 ? { bytes, type } : undefined;
}

const isLan = (addr?: string) =>
  !addr ||
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fe80)/.test(addr.replace(/^::ffff:/, ""));

export async function jellyfinDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<JellyfinDashboard> {
  const g = <T>(path: string) => get<T>(fetchImpl, base, key, path);
  const [info, sessions, folders, counts, users, tasks, latest] = await Promise.all([
    g<{
      Version?: string;
      ServerName?: string;
      HasPendingRestart?: boolean;
      HasUpdateAvailable?: boolean;
    }>("/System/Info"),
    g<Session[]>("/Sessions?activeWithinSeconds=960"),
    g<
      {
        Name?: string;
        CollectionType?: string;
        ItemId?: string;
        Locations?: string[];
        RefreshStatus?: string;
      }[]
    >("/Library/VirtualFolders"),
    g<Record<string, number>>("/Items/Counts").catch(() => ({}) as Record<string, number>),
    g<
      {
        Id: string;
        Name?: string;
        LastActivityDate?: string;
        Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
      }[]
    >("/Users").catch(() => []),
    g<Task[]>("/ScheduledTasks?isHidden=false").catch(() => [] as Task[]),
    g<{
      Items?: {
        Id?: string;
        Name?: string;
        SeriesName?: string;
        SeriesId?: string;
        SeriesPrimaryImageTag?: string;
        ImageTags?: { Primary?: string };
        Type?: string;
        DateCreated?: string;
        ProductionYear?: number;
      }[];
    }>(
      "/Items?Recursive=true&SortBy=DateCreated&SortOrder=Descending&Limit=12&IncludeItemTypes=Movie,Episode,MusicAlbum,Book&Fields=DateCreated",
    ).catch(() => ({ Items: [] })),
  ]);
  // What each library holds, like Plex shows: one small count read per kind (Limit=0).
  const sizes = await Promise.all(
    folders.map(async (f) => {
      const kinds = SIZE_KINDS[f.CollectionType ?? ""];
      if (!kinds || !f.ItemId) return undefined;
      const read = await Promise.all(
        kinds.map(([type, label]) =>
          g<{ TotalRecordCount?: number }>(
            `/Items?ParentId=${encodeURIComponent(f.ItemId!)}&Recursive=true&IncludeItemTypes=${type}&Limit=0`,
          )
            .then((r) => ({ n: r.TotalRecordCount ?? 0, label }))
            .catch(() => undefined),
        ),
      );
      return read.every(Boolean) ? (read as { n: number; label: string }[]) : undefined;
    }),
  );
  const playing = sessions.filter((s) => s.NowPlayingItem);
  const title = (n?: { Name?: string; SeriesName?: string; ProductionYear?: number }) =>
    n?.SeriesName
      ? `${n.SeriesName}: ${n.Name ?? ""}`
      : `${n?.Name ?? "Something"}${n?.ProductionYear ? ` (${n.ProductionYear})` : ""}`;
  return {
    app: "jellyfin",
    ...(info.Version ? { version: info.Version } : {}),
    ...(info.ServerName ? { server: info.ServerName } : {}),
    needsRestart: Boolean(info.HasPendingRestart),
    updateAvailable: Boolean(info.HasUpdateAvailable),
    streams: playing.map((s) => {
      const n = s.NowPlayingItem!;
      const pct = n.RunTimeTicks
        ? Math.round(((s.PlayState?.PositionTicks ?? 0) / n.RunTimeTicks) * 100)
        : 0;
      const method = s.PlayState?.PlayMethod ?? "DirectPlay";
      return {
        sessionId: s.Id,
        user: s.UserName ?? "Someone",
        title: title(n),
        device: [s.DeviceName, s.Client].filter(Boolean).join(" · "),
        progressPct: pct,
        paused: Boolean(s.PlayState?.IsPaused),
        converting: method === "Transcode",
        ...(method === "Transcode"
          ? { why: whyTranscode(s.TranscodingInfo?.TranscodeReasons) ?? "Converting." }
          : {}),
        away: !isLan(s.RemoteEndPoint),
      };
    }),
    libraries: folders.map((f, i) => ({
      id: f.ItemId ?? f.Name ?? "",
      name: f.Name ?? "A library",
      kind: f.CollectionType ?? "mixed",
      folders: (f.Locations ?? []).length,
      scanning: /running|active/i.test(f.RefreshStatus ?? ""),
      ...(sizes[i] ? { size: sizes[i] } : {}),
    })),
    counts: {
      movies: counts.MovieCount ?? 0,
      shows: counts.SeriesCount ?? 0,
      episodes: counts.EpisodeCount ?? 0,
      albums: counts.AlbumCount ?? 0,
      books: counts.BookCount ?? 0,
    },
    users: users.map((u) => ({
      name: u.Name ?? "A user",
      admin: Boolean(u.Policy?.IsAdministrator),
      disabled: Boolean(u.Policy?.IsDisabled),
      ...(u.LastActivityDate ? { lastActive: u.LastActivityDate } : {}),
    })),
    tasks: tasks
      .filter((t) => !t.IsHidden)
      .map((t) => ({
        id: t.Id,
        name: t.Name ?? "A task",
        running: t.State === "Running",
        scheduled: (t.Triggers?.length ?? 0) > 0,
        failed: Boolean(
          t.LastExecutionResult?.Status && !/completed/i.test(t.LastExecutionResult.Status),
        ),
        ...(t.LastExecutionResult?.EndTimeUtc ? { lastRan: t.LastExecutionResult.EndTimeUtc } : {}),
        ...(t.LastExecutionResult?.ErrorMessage
          ? { error: t.LastExecutionResult.ErrorMessage.slice(0, 300) }
          : {}),
      }))
      .sort((a, b) => Number(b.failed) - Number(a.failed) || a.name.localeCompare(b.name)),
    recent: (latest.Items ?? []).map((i) => {
      // An episode shows its show's poster, as Plex does.
      const poster =
        i.Type === "Episode" && i.SeriesId && i.SeriesPrimaryImageTag
          ? i.SeriesId
          : i.Id && i.ImageTags?.Primary
            ? i.Id
            : undefined;
      return {
        ...(i.Id ? { id: i.Id } : {}),
        title: title(i),
        kind: i.Type ?? "",
        ...(i.DateCreated ? { at: i.DateCreated } : {}),
        ...(poster ? { poster } : {}),
      };
    }),
  };
}

/** The background health read. */
export async function readJellyfin(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await jellyfinDashboard(fetchImpl, base, key);
  const issues: AppIssue[] = [
    ...d.tasks
      .filter((t) => t.failed)
      .map((t) => ({
        level: "warning" as const,
        key: `task:${t.id}`,
        text: `The task "${t.name}" failed${t.error ? `: ${t.error}` : ""}.`,
      })),
    ...(d.needsRestart
      ? [
          {
            level: "warning" as const,
            key: "restart",
            text: "The server is waiting for a restart to finish an update or a setting.",
          },
        ]
      : []),
  ];
  return {
    app: "jellyfin",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Watching now", value: String(d.streams.length) },
      { label: "Libraries", value: String(d.libraries.length) },
      { label: "Movies, shows", value: `${d.counts.movies}, ${d.counts.shows}` },
      { label: "Users", value: String(d.users.length) },
    ],
  };
}

export const JELLYFIN_OPS = [
  "scan-all",
  "scan-library",
  "stop-stream",
  "run-task",
  "stop-task",
  "turn-off-task",
  "turn-on-task",
  "disable-user",
  "enable-user",
  "user-access",
  "remove-user",
  "sign-out-device",
  ...JELLYFIN_MANAGE_OPS,
] as const;
const USER_OPS: readonly string[] = ["disable-user", "enable-user", "user-access", "remove-user"];
/** What a user's access says, in words. */
const accessWords = (p: Policy, folders: Map<string, string>) =>
  `${p.EnableAllFolders ? "all libraries" : (p.EnabledFolders ?? []).map((id) => folders.get(id) ?? id).join(", ") || "no libraries"}; downloads ${p.EnableContentDownloading ? "on" : "off"}`;
type Op = (typeof JELLYFIN_OPS)[number];

/** Where a task's schedule is kept while it is turned off, so it can be put back exactly. */
export interface TaskSchedules {
  get(key: string): Promise<unknown[] | undefined>;
  set(key: string, triggers: unknown[] | undefined): Promise<void>;
}

/** Kept in Hearth's settings (one small record per Hearth). */
export function settingsSchedules(handle: DbHandle): TaskSchedules {
  return {
    get: async (key) => (await getSetting(handle.db, "jellyfin_task_triggers"))?.[key],
    set: async (key, triggers) => {
      const all = { ...((await getSetting(handle.db, "jellyfin_task_triggers")) ?? {}) };
      if (triggers) all[key] = triggers;
      else delete all[key];
      await setSetting(handle.db, "jellyfin_task_triggers", all);
    },
  };
}

export class JellyfinOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly schedules: TaskSchedules = settingsSchedules(handle),
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

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!JELLYFIN_OPS.includes(op)) throw new Error(`Say what to do: ${JELLYFIN_OPS.join(", ")}.`);
    if (USER_OPS.includes(op) || op === "sign-out-device")
      return this.planPeople(op, service, params, base);
    if (isManageOp(op))
      return this.use(service, `read ${service.name} to plan a change`, "read", (k) =>
        planManage(callFor(this.fetchImpl, service.localUrl, k), service, op, params, base),
      );
    const d = await this.use(service, `read ${service.name}`, "read", (k) =>
      jellyfinDashboard(this.fetchImpl, service.localUrl, k),
    );
    let label: string;
    let extra: Record<string, string> = {};
    if (op === "scan-all")
      label = `Scan all ${d.libraries.length} libraries in ${service.name} for new and changed files`;
    else if (op === "scan-library") {
      const l = d.libraries.find((x) => x.id === params?.libraryId);
      if (!l) throw new Error(`${service.name} does not have that library.`);
      label = `Scan the ${l.name} library in ${service.name}`;
      extra = { libraryId: l.id, name: l.name };
    } else if (op === "stop-stream") {
      const s = d.streams.find((x) => x.sessionId === params?.sessionId);
      if (!s) throw new Error("That stream has already ended.");
      const message =
        typeof params?.message === "string" ? params.message.trim().slice(0, 200) : "";
      label = `Stop ${s.user}'s stream of ${s.title} on ${s.device}${message ? ` with the message "${message}"` : ""}`;
      extra = {
        sessionId: s.sessionId,
        name: `${s.user}'s stream`,
        ...(message ? { message } : {}),
      };
    } else {
      const t = d.tasks.find((x) => x.id === params?.taskId);
      if (!t) throw new Error(`${service.name} does not have that task.`);
      extra = { taskId: t.id, name: t.name };
      if (op === "run-task") {
        if (t.running) throw new Error(`${t.name} is already running.`);
        label = `Run ${service.name}'s task "${t.name}" now`;
      } else if (op === "stop-task") {
        if (!t.running) throw new Error(`${t.name} is not running.`);
        label = `Stop ${service.name}'s task "${t.name}" now (it runs again at its next scheduled time)`;
      } else if (op === "turn-off-task") {
        if (!t.scheduled) throw new Error(`${t.name} is already off: it has no schedule.`);
        label = `Turn off ${service.name}'s task "${t.name}"${t.running ? " and stop it now" : ""}: it stops running on its schedule. Hearth keeps the schedule to put back.`;
      } else {
        if (t.scheduled) throw new Error(`${t.name} is already on.`);
        if (!(await this.schedules.get(`${service.id}:${t.id}`)))
          throw new Error(
            `Hearth has no saved schedule for ${t.name} (it was not turned off from Hearth). Add one in ${service.name}: Dashboard, Scheduled Tasks, ${t.name}.`,
          );
        label = `Turn ${service.name}'s task "${t.name}" back on, with the schedule it had`;
      }
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...extra },
      change: {
        summary: label,
        settings: [{ name: extra.name ?? "Libraries", before: "as it is", after: op }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    if (USER_OPS.includes(op) || op === "sign-out-device") return this.runPeople(step, service);
    if (isManageOp(op)) {
      const outcome = await this.use(service, `${op} in ${service.name}`, "change", (k) =>
        runManage(callFor(this.fetchImpl, service.localUrl, k), service, op, p, this.wait),
      );
      await recordAudit(this.handle.db, {
        actor: step.requestedBy,
        action: `${op} (${String(p.name || p.library || p.itemId || "")}) in ${service.name}`,
        target: `service:${service.id}`,
        detail: { op, ok: outcome.ok },
      });
      return outcome;
    }
    const name = String(p.name || "the libraries");
    const outcome = await this.use(
      service,
      `${op} in ${service.name}`,
      "change",
      async (key): Promise<StepOutcome> => {
        const base = service.localUrl;
        const c = (path: string, body?: unknown) =>
          call<unknown>(this.fetchImpl, base, key, "POST", path, body);
        if (op === "scan-all") {
          const r = await c("/Library/Refresh");
          return r.ok
            ? { ok: true, result: `${service.name} is scanning all libraries.` }
            : { ok: false, result: `${service.name} refused the scan (${r.status}).` };
        }
        if (op === "scan-library") {
          const r = await c(
            `/Items/${encodeURIComponent(String(p.libraryId))}/Refresh?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default`,
          );
          return r.ok
            ? { ok: true, result: `${service.name} is scanning ${name}.` }
            : { ok: false, result: `${service.name} refused the scan (${r.status}).` };
        }
        if (op === "run-task") {
          const r = await c(`/ScheduledTasks/Running/${encodeURIComponent(String(p.taskId))}`);
          return r.ok
            ? { ok: true, result: `${service.name} started ${name}.` }
            : { ok: false, result: `${service.name} did not start it (${r.status}).` };
        }
        if (op === "stop-task" || op === "turn-off-task" || op === "turn-on-task") {
          const id = String(p.taskId);
          const memo = `${service.id}:${id}`;
          const read = async () =>
            (await get<Task[]>(this.fetchImpl, base, key, "/ScheduledTasks")).find(
              (t) => t.Id === id,
            );
          const task = await read();
          if (!task)
            return { ok: false, stale: true, result: `${service.name} no longer has ${name}.` };
          const wasRunning = task.State === "Running";
          const stop = async () => {
            if (!wasRunning) return true;
            const r = await call<unknown>(
              this.fetchImpl,
              base,
              key,
              "DELETE",
              `/ScheduledTasks/Running/${encodeURIComponent(id)}`,
            );
            return r.ok;
          };
          if (op === "stop-task") {
            if (!(await stop()))
              return { ok: false, result: `${service.name} did not stop ${name}.` };
            const after = await read();
            return after?.State === "Running"
              ? {
                  ok: false,
                  result: `${service.name} took the stop, but ${name} still shows as running.`,
                }
              : { ok: true, result: `Stopped ${name}. It runs again at its next scheduled time.` };
          }
          const setTriggers = (triggers: unknown[]) =>
            c(`/ScheduledTasks/${encodeURIComponent(id)}/Triggers`, triggers);
          if (op === "turn-off-task") {
            const triggers = task.Triggers ?? [];
            // Kept first, so the schedule is never lost even if Jellyfin then fails.
            if (triggers.length) await this.schedules.set(memo, triggers);
            const r = await setTriggers([]);
            if (!r.ok)
              return { ok: false, result: `${service.name} did not turn it off (${r.status}).` };
            const stopped = await stop();
            const after = await read();
            if ((after?.Triggers?.length ?? 0) > 0)
              return { ok: false, result: `${service.name} still shows a schedule for ${name}.` };
            return {
              ok: stopped,
              result: stopped
                ? `Turned off ${name}: it no longer runs on its own${wasRunning ? ", and the run in progress was stopped" : ""}. Turn it back on from the panel any time.`
                : `Turned off ${name}'s schedule, but ${service.name} did not stop the run in progress.`,
            };
          }
          const saved = await this.schedules.get(memo);
          if (!saved)
            return { ok: false, stale: true, result: `Hearth has no saved schedule for ${name}.` };
          const r = await setTriggers(saved);
          if (!r.ok)
            return { ok: false, result: `${service.name} did not turn it back on (${r.status}).` };
          const after = await read();
          if ((after?.Triggers?.length ?? 0) === 0)
            return { ok: false, result: `${service.name} still shows no schedule for ${name}.` };
          await this.schedules.set(memo, undefined);
          return { ok: true, result: `Turned ${name} back on, with the schedule it had.` };
        }
        const id = encodeURIComponent(String(p.sessionId));
        if (typeof p.message === "string" && p.message)
          await c(`/Sessions/${id}/Message`, {
            Header: "From the server",
            Text: p.message,
            TimeoutMs: 10_000,
          });
        const r = await c(`/Sessions/${id}/Playing/Stop`);
        if (!r.ok)
          return { ok: false, result: `${service.name} refused to stop it (${r.status}).` };
        for (let i = 0; i < 8; i++) {
          await this.wait(2000);
          const d = await jellyfinDashboard(this.fetchImpl, base, key);
          if (!d.streams.some((s) => s.sessionId === p.sessionId))
            return { ok: true, result: `Stopped ${name}; it is no longer playing.` };
        }
        return {
          ok: false,
          result: `${service.name} took the stop, but ${name} still shows as playing.`,
        };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }

  /** Users, libraries and devices as Jellyfin has them now. */
  private async people(service: { id: string; localUrl: string }, key: string) {
    const base = service.localUrl;
    const [users, folders, devices] = await Promise.all([
      get<RawUser[]>(this.fetchImpl, base, key, "/Users"),
      get<{ ItemId?: string; Name?: string }[]>(
        this.fetchImpl,
        base,
        key,
        "/Library/VirtualFolders",
      ),
      get<{
        Items?: {
          Id: string;
          ReportedDeviceId?: string;
          Name?: string;
          AppName?: string;
          LastUserName?: string;
        }[];
      }>(this.fetchImpl, base, key, "/Devices").catch(() => ({ Items: [] })),
    ]);
    return {
      users,
      folders: new Map(
        folders.filter((x) => x.ItemId).map((x) => [x.ItemId!, x.Name ?? x.ItemId!]),
      ),
      devices: devices.Items ?? [],
    };
  }

  private async planPeople(
    op: Op,
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const { users, folders, devices } = await this.use(
      service,
      `read ${service.name}'s users`,
      "read",
      (k) => this.people(service, k),
    );
    const done = (
      label: string,
      extra: StepParams,
      before: string,
      after: string,
      warn?: string,
    ) => ({
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...extra },
      change: {
        summary: label,
        settings: [
          { name: String(extra.name ?? `${service.name}`), before, after },
          ...(warn ? [{ name: "Note", before: "", after: warn }] : []),
        ],
      },
    });
    if (op === "sign-out-device") {
      const dv = devices.find((x) => x.Id === params?.deviceId);
      if (!dv) throw new Error(`${service.name} does not have that device any more.`);
      if ((dv.ReportedDeviceId ?? dv.Id) === "hearth")
        throw new Error("That is Hearth itself; it does not sign in as a device.");
      const what = `${dv.Name ?? "a device"}${dv.AppName ? ` (${dv.AppName})` : ""}${dv.LastUserName ? ` used by ${dv.LastUserName}` : ""}`;
      return done(
        `Sign out ${what} from ${service.name}`,
        { deviceId: dv.Id, name: what },
        "signed in",
        "signed out (it has to sign in again)",
      );
    }
    const u = users.find((x) => x.Id === params?.userId);
    if (!u) throw new Error(`${service.name} does not have that user.`);
    const p = u.Policy ?? {};
    const name = u.Name ?? "that user";
    // Never lock out an administrator: Jellyfin needs one to be managed at all.
    if ((op === "disable-user" || op === "remove-user") && p.IsAdministrator)
      throw new Error(
        `${name} is an administrator of ${service.name}. Hearth does not disable or remove an administrator; change that in ${service.name} if you mean it.`,
      );
    const before = `${p.IsDisabled ? "disabled" : "enabled"}; ${accessWords(p, folders)}`;
    if (op === "disable-user" || op === "enable-user") {
      const off = op === "disable-user";
      if (Boolean(p.IsDisabled) === off)
        throw new Error(`${name} is already ${off ? "disabled" : "enabled"}.`);
      return done(
        `${off ? "Disable" : "Enable"} ${name} in ${service.name}`,
        { userId: u.Id, name },
        p.IsDisabled ? "disabled" : "enabled",
        off ? "disabled: cannot sign in or play" : "enabled",
      );
    }
    if (op === "remove-user")
      return done(
        `Remove ${name} from ${service.name}`,
        { userId: u.Id, name },
        before,
        "removed, with their watch history and settings",
        `This cannot be undone: their watch history, favourites and settings in ${service.name} go with the account.`,
      );
    // user-access: libraries (all, or ids) and downloads.
    const raw = typeof params?.libraryIds === "string" ? params.libraryIds.trim() : "";
    const all = raw === "" || raw === "all";
    const ids = all
      ? []
      : raw
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
    const unknown = ids.filter((id) => !folders.has(id));
    if (unknown.length) throw new Error(`${service.name} has no library ${unknown.join(", ")}.`);
    if (!all && !ids.length) throw new Error("Choose at least one library, or all.");
    const downloads =
      typeof params?.allowDownloads === "boolean"
        ? params.allowDownloads
        : Boolean(p.EnableContentDownloading);
    const next: Policy = {
      ...p,
      EnableAllFolders: all,
      EnabledFolders: all ? [] : ids,
      EnableContentDownloading: downloads,
    };
    const after = accessWords(next, folders);
    if (after === accessWords(p, folders))
      throw new Error(`${name} already has exactly that access.`);
    return done(
      `Change ${name}'s access in ${service.name}`,
      {
        userId: u.Id,
        name,
        libraryIds: all ? "all" : ids.join(","),
        allowDownloads: downloads,
        from: accessWords(p, folders),
      },
      accessWords(p, folders),
      after,
    );
  }

  private async runPeople(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const name = String(p.name ?? "that user");
    const outcome = await this.use(
      service,
      `${op} in ${service.name}`,
      "change",
      async (key): Promise<StepOutcome & { verified?: boolean }> => {
        const base = service.localUrl;
        const now = await this.people(service, key);
        if (op === "sign-out-device") {
          if (!now.devices.some((d) => d.Id === p.deviceId))
            return { ok: true, stale: true, result: `${name} is already signed out.` };
          const r = await call(
            this.fetchImpl,
            base,
            key,
            "DELETE",
            `/Devices?id=${encodeURIComponent(String(p.deviceId))}`,
          );
          if (!r.ok) return { ok: false, result: `${service.name} refused (${r.status}).` };
          const gone = !(await this.people(service, key)).devices.some((d) => d.Id === p.deviceId);
          return gone
            ? {
                ok: true,
                verified: true,
                result: `Signed out ${name}; ${service.name} no longer lists the device.`,
              }
            : { ok: false, result: `${service.name} still lists ${name}.` };
        }
        const u = now.users.find((x) => x.Id === p.userId);
        if (!u)
          return op === "remove-user"
            ? { ok: true, stale: true, result: `${name} is already gone.` }
            : { ok: false, stale: true, result: `${service.name} no longer has ${name}.` };
        const policy = u.Policy ?? {};
        if ((op === "disable-user" || op === "remove-user") && policy.IsAdministrator)
          return {
            ok: false,
            stale: true,
            result: `${name} is an administrator now; nothing was changed.`,
          };
        if (op === "remove-user") {
          const r = await call(
            this.fetchImpl,
            base,
            key,
            "DELETE",
            `/Users/${encodeURIComponent(u.Id)}`,
          );
          if (!r.ok) return { ok: false, result: `${service.name} refused (${r.status}).` };
          const gone = !(await this.people(service, key)).users.some((x) => x.Id === u.Id);
          return gone
            ? {
                ok: true,
                verified: true,
                result: `Removed ${name}; ${service.name} no longer lists them.`,
              }
            : { ok: false, result: `${service.name} still lists ${name}.` };
        }
        let next: Policy;
        if (op === "user-access") {
          // A retry, or a change made meanwhile, must not overwrite someone else's edit.
          if (accessWords(policy, now.folders) !== String(p.from ?? ""))
            return {
              ok: false,
              stale: true,
              result: `${name}'s access changed since this was planned; nothing was changed.`,
            };
          const all = String(p.libraryIds) === "all";
          next = {
            ...policy,
            EnableAllFolders: all,
            EnabledFolders: all ? [] : String(p.libraryIds).split(",").filter(Boolean),
            EnableContentDownloading: p.allowDownloads === true,
          };
        } else {
          const off = op === "disable-user";
          if (Boolean(policy.IsDisabled) === off)
            return {
              ok: true,
              stale: true,
              result: `${name} is already ${off ? "disabled" : "enabled"}.`,
            };
          next = { ...policy, IsDisabled: off };
        }
        const r = await call(
          this.fetchImpl,
          base,
          key,
          "POST",
          `/Users/${encodeURIComponent(u.Id)}/Policy`,
          next,
        );
        if (!r.ok) return { ok: false, result: `${service.name} refused (${r.status}).` };
        const after =
          (await this.people(service, key)).users.find((x) => x.Id === u.Id)?.Policy ?? {};
        const verified =
          op === "user-access"
            ? accessWords(after, now.folders) === accessWords(next, now.folders)
            : Boolean(after.IsDisabled) === (op === "disable-user");
        return verified
          ? {
              ok: true,
              verified: true,
              result:
                op === "user-access"
                  ? `${name} now has ${accessWords(after, now.folders)} (read back).`
                  : `${name} is ${op === "disable-user" ? "disabled" : "enabled"} (read back).`,
            }
          : {
              ok: false,
              result: `${service.name} answered, but ${name}'s account does not read that way.`,
            };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? `${op} (${name})`} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
