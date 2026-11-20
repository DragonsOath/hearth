import { eq } from "drizzle-orm";
import type { ActionKind, StepChange, StepParams } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import type { Memory } from "../memory/service";
import { addTimeline } from "../monitor/engine";
import { recordAudit } from "../store/audit";
import { getSetting, setSetting } from "../store/settings";
import { MAX_REPLACEMENTS } from "@dragon-control/core";
import { episodeTitle, isFailedDownload } from "./arr-live";
import { gb, type MediaLibrary } from "./media-library";
import { grabChange, grabParams, grabRelease, type Call as SearchCall } from "./release-search";

/**
 * Sonarr and Radarr operations on one item (feature request 7 and 18), as approved plan steps:
 *
 * - app-arr-import: import one stuck download (a queue item whose files are downloaded but were
 *   not imported). The plan names the queue item, the release, each file, the episode or movie
 *   it goes to, and the app's own reasons it stopped; you approve importing despite them. Files
 *   the app cannot place, and samples, are never imported. The download itself is left as is
 *   (torrents keep seeding).
 * - app-arr-search: search the indexers for one episode or movie now (the app grabs the best
 *   release its profile accepts, if any).
 * - app-arr-queue-remove: remove one item from the queue by its queueId. The plan
 *   shows the release and why the app is stuck on it. The download stays in the client unless
 *   the owner chose removeFromClient, which also deletes its downloaded data (said in the plan).
 *   A failed download (a failed usenet repair, an aborted job) is removed the same way; the panel
 *   asks to remove it from the client too, which clears it from the client's history for good.
 *
 * - app-arr-add-collection (Radarr): add the movies a collection is missing (params.collectionId), monitored,
 *   with the quality profile and root folder of a movie you already have from it, and search for
 *   them. The plan lists every movie; the run refuses if the collection changed.
 *
 *   With params.recover (Download Health's Fix it, 11-13, the owner's decision): the download is
 *   removed from the client too, that one release is blocklisted so the app never grabs it again,
 *   and the app searches for another right away. At most MAX_REPLACEMENTS per movie or episode;
 *   after that the plan is refused and the owner decides.
 *
 * Never: blocklisting anything but the one release a recovery removes, deleting library files,
 * or changing paths.
 * Every run re-reads its target and refuses if it changed, then reports what actually happened.
 */

class PlanError extends Error {}

type Service = { id: string; name: string; localUrl: string; hostId: string };
type App = "sonarr" | "radarr";

interface Candidate {
  path: string;
  folderName?: string;
  size?: number;
  series?: { id: number; title?: string };
  seasonNumber?: number;
  episodes?: { id: number; seasonNumber?: number; episodeNumber?: number }[];
  movie?: { id: number; title?: string; year?: number };
  quality?: { quality?: { name?: string } };
  languages?: unknown[];
  releaseGroup?: string;
  downloadId?: string;
  indexerFlags?: number;
  releaseType?: string;
  rejections?: { reason?: string; type?: string }[];
}

interface RawQueue {
  id: number;
  downloadId?: string;
  title?: string;
  episodeId?: number;
  movieId?: number;
  trackedDownloadState?: string;
  trackedDownloadStatus?: string;
  sizeleft?: number;
  status?: string;
  errorMessage?: string;
  downloadClient?: string;
  /** "torrent" or "usenet". */
  protocol?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  series?: { id: number; title?: string };
  episode?: { seasonNumber?: number; episodeNumber?: number };
  movie?: { title?: string; year?: number };
}

/** One movie or episode, across recoveries (its download changes each time). */
function recoveryKey(serviceId: string, q: { movieId?: number; episodeId?: number; id: number }) {
  return `${serviceId}:${q.movieId ? `m${q.movieId}` : q.episodeId ? `e${q.episodeId}` : `q${q.id}`}`;
}

const num = (v: unknown) =>
  typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const IMPORTABLE_STATES = new Set(["importPending", "importBlocked", "importFailed"]);
/** What the app says about a queue item: its error, or its status messages, or its state. */
const queueReason = (q: RawQueue) =>
  q.errorMessage?.trim() ||
  [...new Set((q.statusMessages ?? []).flatMap((m) => m.messages ?? []).filter(Boolean))].join(
    "; ",
  ) ||
  `${q.trackedDownloadState ?? q.status ?? "in the queue"}${q.trackedDownloadStatus && q.trackedDownloadStatus !== "ok" ? ` (${q.trackedDownloadStatus})` : ""}`;
/** The queue item as it was when planned: anything different refuses the run. */
const queueState = (q: RawQueue) =>
  [q.downloadId ?? "", q.title ?? "", q.trackedDownloadState ?? q.status ?? ""].join("|");
const LABEL: Partial<Record<ActionKind, string>> = {
  "app-arr-import": "Imported a stuck download",
  "app-arr-search": "Searched",
  "app-arr-grab": "Downloaded a picked release",
  "app-arr-queue-remove": "Removed from the queue",
  "app-arr-add-collection": "Added a collection's missing movies",
};

const MAX_COLLECTION_ADD = 25;

interface RawCollection {
  id: number;
  title?: string;
  qualityProfileId?: number;
  rootFolderPath?: string;
  minimumAvailability?: string;
  movies?: {
    tmdbId: number;
    title?: string;
    year?: number;
    status?: string;
    isExisting?: boolean;
    isExcluded?: boolean;
  }[];
}

const collectionMissing = (c: RawCollection) =>
  (c.movies ?? []).filter((m) => !m.isExisting && !m.isExcluded);

export class ArrOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly lib: MediaLibrary,
    private readonly memory?: Memory,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private async queueItem(service: Service, app: App, queueId: number) {
    const include =
      app === "sonarr" ? "includeSeries=true&includeEpisode=true" : "includeMovie=true";
    const r = await this.lib.arr<{ records?: (RawQueue & Record<string, unknown>)[] }>(
      service,
      "GET",
      `/api/v3/queue?page=1&pageSize=200&${include}`,
      "read the download queue",
    );
    return r.data?.records?.find((q) => q.id === queueId);
  }

  /** What a queue item is for: the episode or movie, in words. */
  private async queueTitle(service: Service, app: App, q: RawQueue): Promise<string> {
    if (app === "radarr") {
      const m =
        q.movie ?? (q.movieId !== undefined ? await this.lib.movie(service, q.movieId) : undefined);
      return m?.title ? `${m.title}${m.year ? ` (${m.year})` : ""}` : "an unknown movie";
    }
    if (q.series && q.episode) return episodeTitle(q.series, q.episode);
    if (q.episodeId !== undefined) {
      const e = await this.lib.episode(service, q.episodeId);
      if (e) return episodeTitle(await this.lib.oneSeries(service, e.seriesId), e);
    }
    return "an unknown episode";
  }

  private async candidates(service: Service, downloadId: string): Promise<Candidate[]> {
    const r = await this.lib.arr<Candidate[]>(
      service,
      "GET",
      `/api/v3/manualimport?downloadId=${encodeURIComponent(downloadId)}&filterExistingFiles=false`,
      "read a stuck download's files",
    );
    return Array.isArray(r.data) ? r.data : [];
  }

  /** Where a file would go, or undefined when the app cannot place it. */
  private targetOf(app: App, c: Candidate): string | undefined {
    if (c.rejections?.some((x) => /sample/i.test(x.reason ?? ""))) return undefined;
    if (app === "sonarr") {
      if (!c.series || !c.episodes?.length) return undefined;
      return c.episodes
        .map((e) =>
          episodeTitle(c.series, {
            seasonNumber: e.seasonNumber ?? c.seasonNumber,
            episodeNumber: e.episodeNumber,
          }),
        )
        .join(", ");
    }
    if (!c.movie) return undefined;
    return `${c.movie.title ?? "the movie"}${c.movie.year ? ` (${c.movie.year})` : ""}`;
  }

  private signature(files: Candidate[]) {
    return files
      .map((f) => `${f.path}|${f.size ?? 0}`)
      .sort()
      .join("\n");
  }

  async plan(
    kind: ActionKind,
    app: App,
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const done = (change: StepChange, p: StepParams): PlannedStep => ({
      ...base,
      label: change.summary,
      serviceName: service.name,
      params: p,
      change,
    });

    if (kind === "app-arr-import") {
      const queueId = num(params?.queueId);
      if (queueId === undefined)
        throw new PlanError("Say which queue item (params.queueId, from the arr tool's queue).");
      const q = await this.queueItem(service, app, queueId);
      if (!q) throw new PlanError(`${service.name}'s queue has no item #${queueId} any more.`);
      if (!q.downloadId)
        throw new PlanError(`${service.name} does not know which download item #${queueId} is.`);
      if (!IMPORTABLE_STATES.has(q.trackedDownloadState ?? ""))
        throw new PlanError(
          `That item is ${q.trackedDownloadState ?? q.status ?? "not waiting"}, not waiting to be imported.`,
        );
      const all = await this.candidates(service, q.downloadId);
      const placed = all.filter((c) => this.targetOf(app, c));
      const unplaced = all.filter((c) => !this.targetOf(app, c));
      if (!placed.length) {
        const why = [
          ...new Set(all.flatMap((c) => (c.rejections ?? []).map((r) => r.reason)).filter(Boolean)),
        ].join("; ");
        throw new PlanError(
          `${service.name} cannot tell where any file of "${q.title}" belongs${why ? ` (${why})` : ""}. Importing files to an episode or movie you choose by hand is not an operation yet; ask for it to be added if you need it.`,
        );
      }
      const settings = placed.map((c) => ({
        name: fileName(c.path),
        before: `Downloaded, not imported${c.rejections?.length ? `: ${c.rejections.map((r) => r.reason).join("; ")}` : ""}`,
        after: `Import as ${this.targetOf(app, c)} (${c.quality?.quality?.name ?? "quality as detected"}, ${gb(c.size) ?? "?"} GB)`,
      }));
      if (unplaced.length)
        settings.push({
          name: `${unplaced.length} other file${unplaced.length === 1 ? "" : "s"}`,
          before: unplaced
            .map((c) => fileName(c.path))
            .join(", ")
            .slice(0, 300),
          after: "Left alone (samples, or files the app cannot place)",
        });
      settings.push({
        name: "The download",
        before: `${q.title ?? "the release"} in the download client`,
        after: "Left as is (a torrent keeps seeding); nothing is removed or blocklisted",
      });
      const title = placed.map((c) => this.targetOf(app, c)).join(", ");
      return done(
        { summary: `Import the stuck download of ${title} in ${service.name}`, settings },
        {
          queueId,
          downloadId: q.downloadId,
          release: q.title ?? "",
          title,
          files: this.signature(placed),
        },
      );
    }

    if (kind === "app-arr-queue-remove") {
      const queueId = num(params?.queueId);
      if (queueId === undefined)
        throw new PlanError("Say which queue item (params.queueId, from the arr tool's queue).");
      const recover = params?.recover === true;
      const removeFromClient = recover || params?.removeFromClient === true;
      const q = await this.queueItem(service, app, queueId);
      if (!q) throw new PlanError(`${service.name}'s queue has no item #${queueId} any more.`);
      const title = await this.queueTitle(service, app, q);
      const item = recoveryKey(service.id, q);
      if (recover) {
        const tries = ((await getSetting(this.handle.db, "download_recoveries")) ?? {})[item] ?? [];
        if (tries.length >= MAX_REPLACEMENTS)
          throw new PlanError(
            `Hearth has already replaced the download for ${title} ${tries.length} times, and this one is stuck too. Look at it in ${service.name} yourself: the release you want may not exist yet, or every one out there is bad.`,
          );
      }
      const release = q.title ?? "the release";
      const client = q.downloadClient
        ? `the download client (${q.downloadClient})`
        : "the download client";
      const failed = isFailedDownload(q);
      return done(
        {
          summary: `Remove ${release} (${title}) from ${service.name}'s queue${removeFromClient ? " and from the download client" : ""}`,
          settings: [
            {
              name: `Queue item #${queueId}`,
              before: `${release}, for ${title}. ${failed ? "Why it failed" : "Why it is stuck"}: ${queueReason(q)}`,
              after: `Removed from ${service.name}'s queue`,
            },
            {
              name: "The download",
              before: `In ${client}`,
              after: removeFromClient
                ? failed
                  ? `Removed from ${q.downloadClient ?? "the download client"}'s history too, with any partial data (it failed, so nothing usable is lost)`
                  : "Removed from the download client too, which DELETES its downloaded data"
                : `Left in the download client as is${q.protocol === "torrent" ? " (a torrent keeps seeding)" : ""}`,
            },
            recover
              ? {
                  name: "Blocklist",
                  before: "Not blocklisted",
                  after: `This one release is blocklisted, so ${service.name} never grabs it again. Nothing else is, and no library files are touched`,
                }
              : {
                  name: "Blocklist and library",
                  before: "Not changed",
                  after:
                    "Nothing is blocklisted (the app may grab this release again) and no library files are touched",
                },
            ...(recover
              ? [
                  {
                    name: "Another release",
                    before: "None",
                    after: `${service.name} searches for another release of ${title} right away`,
                  },
                ]
              : []),
          ],
        },
        {
          queueId,
          downloadId: q.downloadId ?? "",
          release: q.title ?? "",
          title,
          state: queueState(q),
          removeFromClient,
          ...(failed ? { failed: true } : {}),
          ...(recover ? { recover: true, item } : {}),
        },
      );
    }

    if (kind === "app-arr-add-collection") {
      if (app !== "radarr") throw new PlanError("Collections are a Radarr feature.");
      const collectionId = num(params?.collectionId);
      if (collectionId === undefined)
        throw new PlanError("Say which collection (params.collectionId, from Radarr's panel).");
      const c = await this.collection(service, collectionId);
      if (!c) throw new PlanError(`${service.name} has no collection #${collectionId}.`);
      const missing = collectionMissing(c);
      if (!missing.length)
        throw new PlanError(`${c.title ?? "That collection"} is not missing any movies.`);
      if (missing.length > MAX_COLLECTION_ADD)
        throw new PlanError(
          `${c.title} is missing ${missing.length} movies; Hearth adds at most ${MAX_COLLECTION_ADD} at a time. Add them in Radarr, or ask Ember to add the ones you want.`,
        );
      const like = await this.collectionSettings(service, c);
      const settings = missing.map((m) => ({
        name: `${m.title ?? "A movie"}${m.year ? ` (${m.year})` : ""}`,
        before: "Not in Radarr",
        after:
          m.status === "released"
            ? "Added and monitored; Radarr searches for it now"
            : "Added and monitored; Radarr grabs it once it is released",
      }));
      settings.push({
        name: "Quality and folder",
        before: like.from
          ? `As ${like.from}, which you already have`
          : "The collection's own settings",
        after: `Quality profile ${like.profileName}, folder ${like.root}`,
      });
      return done(
        {
          summary: `Add ${missing.length} missing movie${missing.length === 1 ? "" : "s"} from ${c.title ?? "a collection"} to ${service.name}`,
          settings,
        },
        {
          collectionId,
          title: c.title ?? "a collection",
          tmdbIds: missing.map((m) => m.tmdbId).join(","),
          qualityProfileId: like.profileId,
          rootFolderPath: like.root,
          minimumAvailability: like.minimumAvailability,
        },
      );
    }

    if (kind === "app-arr-grab") {
      const g = grabParams(params as Record<string, unknown> | undefined);
      if (typeof g === "string") throw new PlanError(g);
      return done(grabChange(service.name, g), { ...g });
    }

    // app-arr-search
    if (app === "sonarr") {
      const episodeId = num(params?.episodeId);
      if (episodeId === undefined) throw new PlanError("Say which episode (params.episodeId).");
      const e = await this.lib.episode(service, episodeId);
      if (!e) throw new PlanError(`${service.name} has no episode #${episodeId}.`);
      const s = await this.lib.oneSeries(service, e.seriesId);
      const title = episodeTitle(s, e);
      return done(
        {
          summary: `Search for ${title} now in ${service.name}`,
          settings: [
            {
              name: title,
              before: e.hasFile
                ? "Has a file (the search looks for an upgrade)"
                : `Missing${e.monitored ? "" : " (not monitored)"}`,
              after:
                "Search every indexer now; Sonarr grabs the best release its quality profile accepts, if there is one",
            },
          ],
        },
        { episodeId, title },
      );
    }
    const movieId = num(params?.movieId);
    if (movieId === undefined) throw new PlanError("Say which movie (params.movieId).");
    const m = await this.lib.movie(service, movieId);
    if (!m) throw new PlanError(`${service.name} has no movie #${movieId}.`);
    const title = `${m.title}${m.year ? ` (${m.year})` : ""}`;
    return done(
      {
        summary: `Search for ${title} now in ${service.name}`,
        settings: [
          {
            name: title,
            before: m.hasFile
              ? "Has a file (the search looks for an upgrade)"
              : `Missing${m.monitored ? "" : " (not monitored)"}`,
            after:
              "Search every indexer now; Radarr grabs the best release its quality profile accepts, if there is one",
          },
        ],
      },
      { movieId, title },
    );
  }

  private async collection(service: Service, id: number) {
    const r = await this.lib.arr<RawCollection>(
      service,
      "GET",
      `/api/v3/collection/${id}`,
      "read one collection",
    );
    return r.ok ? r.data : undefined;
  }

  /** The quality profile and folder of a movie you already have from the collection. */
  private async collectionSettings(service: Service, c: RawCollection) {
    let profileId = c.qualityProfileId;
    let root = c.rootFolderPath;
    let minimumAvailability = c.minimumAvailability ?? "released";
    let from: string | undefined;
    for (const owned of (c.movies ?? []).filter((m) => m.isExisting)) {
      const r = await this.lib.arr<
        {
          title?: string;
          year?: number;
          qualityProfileId?: number;
          rootFolderPath?: string;
          path?: string;
          minimumAvailability?: string;
        }[]
      >(service, "GET", `/api/v3/movie?tmdbId=${owned.tmdbId}`, "read a movie you have");
      const m = r.data?.[0];
      if (m?.qualityProfileId) {
        profileId = m.qualityProfileId;
        root = m.rootFolderPath ?? m.path?.replace(/[\\/][^\\/]+[\\/]?$/, "") ?? root;
        minimumAvailability = m.minimumAvailability ?? minimumAvailability;
        from = `${m.title ?? owned.title}${m.year ? ` (${m.year})` : ""}`;
        break;
      }
    }
    if (!profileId || !root)
      throw new PlanError(
        `${service.name} does not say which quality profile and folder to use for ${c.title ?? "this collection"}.`,
      );
    const prof = await this.lib.arr<{ name?: string }>(
      service,
      "GET",
      `/api/v3/qualityprofile/${profileId}`,
      "read a quality profile",
    );
    return {
      profileId,
      profileName: prof.data?.name ?? `#${profileId}`,
      root,
      minimumAvailability,
      from,
    };
  }

  /** Waits for an app command to finish; its final status, or "running" if it did not in time. */
  private async command(
    service: Service,
    body: Record<string, unknown>,
    purpose: string,
    maxMs: number,
  ) {
    const started = await this.lib.arr<{ id?: number; status?: string; message?: string }>(
      service,
      "POST",
      "/api/v3/command",
      purpose,
      { body },
    );
    if (!started.ok || started.data?.id === undefined)
      return { status: "refused", message: `${service.name} refused (${started.status}).` };
    for (let waited = 0; waited < maxMs; waited += 2000) {
      await this.wait(2000);
      const r = await this.lib.arr<{ status?: string; message?: string; result?: string }>(
        service,
        "GET",
        `/api/v3/command/${started.data.id}`,
        "check a command",
      );
      const st = r.data?.status;
      if (st === "completed" || st === "failed" || st === "aborted" || st === "cancelled")
        return { status: st, message: r.data?.message ?? r.data?.result };
    }
    return { status: "running", message: undefined };
  }

  async run(step: StepRun, app: App, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let result: string;
    let ok: boolean;
    let detail: Record<string, unknown>;

    if (step.kind === "app-arr-grab") {
      const g = grabParams(p as Record<string, unknown>);
      if (typeof g === "string") return { ok: false, result: g };
      const call: SearchCall = (method, path, body) =>
        this.lib.arr(service, method, path, `download one release you picked (approved plan)`, {
          ...(body !== undefined ? { body } : {}),
        });
      const out = await grabRelease(app, call, g, this.wait);
      ok = out.ok;
      result = out.result;
      detail = { title: g.title, release: g.release, indexer: g.indexer ?? null };
      if (out.stale) return { ok: false, stale: true, result };
      // The title for the audit and the journal.
      (p as Record<string, unknown>).title = `${g.release} (for ${g.title})`;
    } else if (step.kind === "app-arr-import") {
      const queueId = num(p.queueId)!;
      const q = await this.queueItem(service, app, queueId);
      if (!q) {
        return {
          ok: false,
          stale: true,
          result: `"${p.release}" is no longer in ${service.name}'s queue (imported or removed meanwhile). Nothing was done.`,
        };
      }
      if (q.downloadId !== p.downloadId || (q.title ?? "") !== p.release)
        return {
          ok: false,
          stale: true,
          result: `Queue item #${queueId} is now a different download. Nothing was done; plan it again.`,
        };
      if (!IMPORTABLE_STATES.has(q.trackedDownloadState ?? ""))
        return {
          ok: false,
          stale: true,
          result: `"${p.release}" is now ${q.trackedDownloadState ?? q.status}, not waiting to be imported. Nothing was done.`,
        };
      const placed = (await this.candidates(service, String(p.downloadId))).filter((c) =>
        this.targetOf(app, c),
      );
      if (this.signature(placed) !== p.files)
        return {
          ok: false,
          stale: true,
          result: `The files of "${p.release}" changed since this plan was approved. Nothing was imported; plan it again.`,
        };
      const files = placed.map((c) =>
        app === "sonarr"
          ? {
              path: c.path,
              folderName: c.folderName,
              seriesId: c.series!.id,
              episodeIds: c.episodes!.map((e) => e.id),
              quality: c.quality,
              languages: c.languages,
              releaseGroup: c.releaseGroup,
              downloadId: c.downloadId ?? p.downloadId,
              indexerFlags: c.indexerFlags ?? 0,
              ...(c.releaseType ? { releaseType: c.releaseType } : {}),
            }
          : {
              path: c.path,
              folderName: c.folderName,
              movieId: c.movie!.id,
              quality: c.quality,
              languages: c.languages,
              releaseGroup: c.releaseGroup,
              downloadId: c.downloadId ?? p.downloadId,
              indexerFlags: c.indexerFlags ?? 0,
            },
      );
      const cmd = await this.command(
        service,
        { name: "ManualImport", files, importMode: "auto" },
        `import the stuck download of ${p.title} (approved plan)`,
        60_000,
      );
      // What actually happened: does each target now have its file?
      const missing: string[] = [];
      for (const c of placed) {
        if (app === "sonarr") {
          for (const e of c.episodes!) {
            const now = await this.lib.episode(service, e.id);
            if (!now?.hasFile)
              missing.push(
                episodeTitle(c.series, {
                  seasonNumber: e.seasonNumber ?? c.seasonNumber,
                  episodeNumber: e.episodeNumber,
                }),
              );
          }
        } else {
          const now = await this.lib.movie(service, c.movie!.id);
          if (!now?.hasFile) missing.push(this.targetOf(app, c)!);
        }
      }
      const still = await this.queueItem(service, app, queueId);
      ok = cmd.status === "completed" && missing.length === 0;
      result = ok
        ? `Imported and verified: ${p.title} now ${placed.length === 1 ? "has its file" : "have their files"} in ${service.name}${still ? "" : ", and the item left the queue"}. The download was left as is.`
        : cmd.status === "running"
          ? `${service.name} is still importing after a minute; not verified yet. ${missing.length ? `Not imported so far: ${missing.join(", ")}.` : ""}`.trim()
          : `${service.name} ran the import (${cmd.status}${cmd.message ? `: ${cmd.message}` : ""}), but ${missing.length ? `${missing.join(", ")} still ${missing.length === 1 ? "has" : "have"} no file` : "it could not be confirmed"}. Not fixed.`;
      detail = { release: p.release, title: p.title, command: cmd.status, notImported: missing };
    } else if (step.kind === "app-arr-queue-remove") {
      const queueId = num(p.queueId)!;
      const removeFromClient = p.removeFromClient === true;
      const q = await this.queueItem(service, app, queueId);
      if (!q)
        return {
          ok: false,
          stale: true,
          result: `"${p.release}" is no longer in ${service.name}'s queue (finished or removed meanwhile). Nothing was done.`,
        };
      if (queueState(q) !== p.state)
        return {
          ok: false,
          stale: true,
          result: `Queue item #${queueId} changed since this plan was approved (now ${q.title ?? "a different download"}, ${q.trackedDownloadState ?? q.status ?? "unknown state"}). Nothing was removed; plan it again.`,
        };
      const extra =
        app === "sonarr" ? "&skipRedownload=false&changeCategory=false" : "&skipRedownload=false";
      const recover = p.recover === true;
      const del = await this.lib.arr<unknown>(
        service,
        "DELETE",
        `/api/v3/queue/${queueId}?removeFromClient=${removeFromClient}&blocklist=${recover}${extra}`,
        recover
          ? `remove "${p.release}", blocklist it and search again (approved plan)`
          : `remove "${p.release}" from the queue (approved plan)`,
      );
      const still = await this.queueItem(service, app, queueId);
      ok = del.ok && !still;
      if (ok && recover) {
        const all = (await getSetting(this.handle.db, "download_recoveries")) ?? {};
        const key = String(p.item ?? "");
        all[key] = [...(all[key] ?? []), new Date().toISOString()].slice(-10);
        await setSetting(this.handle.db, "download_recoveries", all);
      }
      result =
        ok && recover
          ? `Fixed: "${p.release}" (${p.title}) is out of ${service.name}'s queue and the download client, that release is blocklisted, and ${service.name} is searching for another.`
          : ok
            ? `Removed and verified: "${p.release}" (${p.title}) is no longer in ${service.name}'s queue. ${removeFromClient ? (p.failed === true ? "The download client was told to remove the failed download and its partial data." : "The download client was told to remove it and delete its downloaded data.") : "The download was left in the download client."} Nothing was blocklisted.`
            : !del.ok
              ? `${service.name} refused to remove "${p.release}" (${del.status}). Nothing changed.`
              : `${service.name} accepted the removal, but "${p.release}" is still in its queue. Not removed.`;
      detail = {
        release: p.release,
        title: p.title,
        removeFromClient,
        status: del.status,
        ...(recover ? { recovered: true } : {}),
      };
    } else if (step.kind === "app-arr-add-collection") {
      const c = await this.collection(service, num(p.collectionId)!);
      const missing = c ? collectionMissing(c) : [];
      if (!c || missing.map((m) => m.tmdbId).join(",") !== p.tmdbIds)
        return {
          ok: false,
          stale: true,
          result: `${p.title} changed in ${service.name} since this plan was approved. Nothing was added; plan it again.`,
        };
      const added: string[] = [];
      const failed: string[] = [];
      for (const m of missing) {
        const name = `${m.title ?? "A movie"}${m.year ? ` (${m.year})` : ""}`;
        const post = await this.lib.arr<unknown>(
          service,
          "POST",
          "/api/v3/movie",
          `add ${name} (approved plan)`,
          {
            body: {
              title: m.title,
              year: m.year,
              tmdbId: m.tmdbId,
              qualityProfileId: num(p.qualityProfileId),
              rootFolderPath: p.rootFolderPath,
              minimumAvailability: p.minimumAvailability,
              monitored: true,
              addOptions: { searchForMovie: true, monitor: "movieOnly" },
            },
          },
        );
        const back = await this.lib.arr<unknown[]>(
          service,
          "GET",
          `/api/v3/movie?tmdbId=${m.tmdbId}`,
          "check the movie was added",
        );
        if (post.ok && Array.isArray(back.data) && back.data.length) added.push(name);
        else failed.push(`${name} (${post.status})`);
      }
      ok = failed.length === 0;
      result = ok
        ? `Added and verified: ${added.join(", ")} ${added.length === 1 ? "is" : "are"} in ${service.name}, monitored, and being searched for.`
        : `${added.length ? `Added ${added.join(", ")}. ` : ""}Not added: ${failed.join(", ")}.`;
      detail = { collection: p.title, added, failed };
    } else {
      const started = new Date().toISOString();
      const sonarr = app === "sonarr";
      const id = num(sonarr ? p.episodeId : p.movieId)!;
      const now = sonarr ? await this.lib.episode(service, id) : await this.lib.movie(service, id);
      if (!now)
        return {
          ok: false,
          stale: true,
          result: `${p.title} is no longer in ${service.name}. Nothing was searched.`,
        };
      if (sonarr) {
        const e = now as Awaited<ReturnType<MediaLibrary["episode"]>> & object;
        const s = await this.lib.oneSeries(service, e.seriesId);
        if (episodeTitle(s, e) !== p.title)
          return {
            ok: false,
            stale: true,
            result: `Episode #${id} is now ${episodeTitle(s, e)}, not ${p.title}. Nothing was searched; plan it again.`,
          };
      }
      const cmd = await this.command(
        service,
        sonarr
          ? { name: "EpisodeSearch", episodeIds: [id] }
          : { name: "MoviesSearch", movieIds: [id] },
        `search for ${p.title} (approved plan)`,
        120_000,
      );
      const hist = await this.lib
        .arr<
          | {
              records?: {
                date?: string;
                eventType?: string;
                sourceTitle?: string;
                quality?: { quality?: { name?: string } };
                data?: { indexer?: string };
              }[];
            }
          | {
              date?: string;
              eventType?: string;
              sourceTitle?: string;
              quality?: { quality?: { name?: string } };
              data?: { indexer?: string };
            }[]
        >(
          service,
          "GET",
          sonarr
            ? `/api/v3/history?page=1&pageSize=20&sortKey=date&sortDirection=descending&episodeId=${id}`
            : `/api/v3/history/movie?movieId=${id}`,
          "check whether the search grabbed something",
        )
        .catch(() => undefined);
      const list = Array.isArray(hist?.data) ? hist.data : (hist?.data?.records ?? []);
      const grab = list.find((h) => h.eventType === "grabbed" && String(h.date) >= started);
      ok = cmd.status === "completed";
      result = grab
        ? `Searched, and ${service.name} grabbed ${grab.sourceTitle} (${grab.quality?.quality?.name ?? "quality unknown"}${grab.data?.indexer ? `, from ${grab.data.indexer}` : ""}). It is downloading; it is not on disk yet.`
        : ok
          ? `Searched every indexer for ${p.title}; ${service.name} found no release its quality profile accepts, so nothing was grabbed. Not fixed: it is still missing.`
          : `${service.name}'s search ${cmd.status}${cmd.message ? `: ${cmd.message}` : ""}. Nothing was grabbed.`;
      detail = { title: p.title, command: cmd.status, grabbed: grab?.sourceTitle ?? null };
    }

    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${LABEL[step.kind] ?? "Changed"}: ${p.title} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { ...detail, ok },
    });
    if (step.incidentId) {
      await addTimeline(
        this.handle.db,
        step.incidentId,
        new Date().toISOString(),
        ok ? "action" : "escalated",
        result,
      );
    }
    if (ok && this.memory) {
      const host = await this.handle.db
        .select()
        .from(t.hosts)
        .where(eq(t.hosts.id, service.hostId))
        .get();
      await this.memory
        .recordSystem(this.handle.db, {
          title: `${LABEL[step.kind] ?? "Changed"}: ${p.title} in ${service.name}`,
          body: `${result} Approved as a step of a plan, then checked by reading ${service.name} back.`,
          happenedAt: new Date().toISOString(),
          machine: host?.name,
          links: [{ label: service.name, ref: `service:${service.id}` }],
        })
        .catch(() => undefined);
    }
    return { ok, result };
  }
}

export { PlanError as ArrPlanError };
