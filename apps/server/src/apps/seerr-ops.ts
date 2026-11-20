import {
  HEARTH_PREFIX,
  HOLD_PROFILE,
  ladderWords,
  requestProfile,
  type CrucibleSetup,
} from "@dragon-control/core";
import { getSetting, setSetting } from "../store/settings";
import { SEERR_REQUEST, type StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import type { SeerrLibrary } from "./seerr-library";

/**
 * Approving or declining a request in Seerr (Overseerr, Jellyseerr): a plan step you confirm,
 * planned from the request as Seerr has it now (title and who asked), made through Seerr's own
 * API (POST /api/v1/request/{id}/approve or /decline), and read back. Only a request still waiting
 * for approval is touched; one that changed since you confirmed is left alone.
 */

type Kind =
  | "app-seerr-approve"
  | "app-seerr-decline"
  | "app-seerr-remove"
  | "app-seerr-request"
  | "app-seerr-retry"
  | "app-seerr-mark-available"
  | "app-seerr-issue"
  | "app-seerr-search-on-add";

const APP = { radarr: "Radarr", sonarr: "Sonarr" } as const;
/** The Crucible's record of a Seerr it took over: by Seerr, and by app for shows. */
export const recordKey = (seerrId: string, app: "radarr" | "sonarr") =>
  app === "sonarr" ? `${seerrId}:sonarr` : seerrId;

/** Seerr's media status: what it already has of a title. */
const MEDIA_WORDS: Record<number, string> = {
  2: "already requested",
  3: "already requested and on its way",
  4: "partly in the library",
  5: "already in the library",
  6: "blocklisted in Seerr",
};
/** Seerr's issue status. */
const ISSUE = { open: 1, resolved: 2 };
const ISSUE_TYPES: Record<number, string> = { 1: "video", 2: "audio", 3: "subtitles", 4: "other" };

interface TitleInfo {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  genres?: { name?: string }[];
  popularity?: number;
  seasons?: { seasonNumber: number; name?: string }[];
  mediaInfo?: {
    id?: number;
    status?: number;
    seasons?: { seasonNumber: number; status?: number }[];
    requests?: { id: number; status?: number; seasons?: { seasonNumber: number }[] }[];
  };
}
interface SeerrIssue {
  id: number;
  status?: number;
  issueType?: number;
  problemSeason?: number;
  problemEpisode?: number;
  createdBy?: { displayName?: string };
  comments?: { id: number; message?: string; user?: { displayName?: string } }[];
  media?: { tmdbId?: number; mediaType?: string };
}

const STATUS_WORDS: Record<number, string> = {
  1: "Waiting for approval",
  2: "Approved",
  3: "Declined",
  4: "Failed",
  5: "Done",
};

interface SeerrRequest {
  id: number;
  status?: number;
  type?: string;
  requestedBy?: { displayName?: string };
  media?: { id?: number; tmdbId?: number; status?: number };
}

/** Seerr's media status: in the library, fully or partly (kept when a request is removed). */
const IN_LIBRARY = new Set([4, 5]);

export class SeerrOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    /** What Radarr and Sonarr have on disk (seerr-library.ts); none in tests that do not need it. */
    private readonly library?: SeerrLibrary,
  ) {}

  private call<T>(
    service: { id: string; name: string; localUrl: string },
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    purpose: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    const url = joinUrl(service.localUrl, path);
    return this.broker.use(
      {
        serviceId: service.id,
        purpose,
        access: method === "GET" ? "read" : "change",
        destination: url,
      },
      async ({ value }) => {
        let res: Awaited<ReturnType<Fetch>>;
        try {
          res = await this.fetchImpl(url, {
            method,
            headers: {
              "X-Api-Key": value,
              Accept: "application/json",
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(TIMEOUT_MS * 2),
          });
        } catch (error) {
          throw new AppUnreachableError(
            `${service.name} did not answer: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (res.status === 401 || res.status === 403)
          throw new AppKeyError(`${service.name} refused the API key.`);
        return {
          ok: res.ok,
          status: res.status,
          data: (await res.json().catch(() => undefined)) as T,
        };
      },
    );
  }

  /** The request and its title, as Seerr has them now. */
  private async read(service: { id: string; name: string; localUrl: string }, id: number) {
    const r = await this.call<SeerrRequest>(
      service,
      "GET",
      `/api/v1/request/${id}`,
      "read a request",
    );
    if (!r.ok || !r.data) throw new Error(`${service.name} has no request #${id}.`);
    const tmdb = r.data.media?.tmdbId;
    const kind = r.data.type === "tv" ? "tv" : "movie";
    const m = tmdb
      ? await this.call<{
          title?: string;
          name?: string;
          releaseDate?: string;
          firstAirDate?: string;
        }>(service, "GET", `/api/v1/${kind}/${tmdb}`, "read a requested title").catch(
          () => undefined,
        )
      : undefined;
    const t = m?.data;
    const year = (t?.releaseDate ?? t?.firstAirDate)?.slice(0, 4);
    const title = `${t?.title ?? t?.name ?? `TMDB ${tmdb ?? "?"}`}${year ? ` (${year})` : ""}`;
    return { request: r.data, title, by: r.data.requestedBy?.displayName ?? "someone" };
  }

  async plan(
    kind: Kind,
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    if (kind === "app-seerr-request") return this.planRequest(service, params, base);
    if (kind === "app-seerr-issue") return this.planIssue(service, params, base);
    if (kind === "app-seerr-search-on-add") return this.planSearchOnAdd(service, params, base);
    if (kind === "app-seerr-mark-available") return this.planMarkAvailable(service, params, base);
    const id = Number(params?.requestId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Say which request (requestId).");
    if (kind === "app-seerr-retry") {
      const { request, title, by } = await this.read(service, id);
      if (request.status !== SEERR_REQUEST.failed)
        throw new Error(`The request for ${title} has not failed; there is nothing to retry.`);
      return {
        ...base,
        label: `Retry ${by}'s request for ${title} in ${service.name}`,
        serviceName: service.name,
        params: { requestId: id, title },
        change: {
          summary: `Retry the request for ${title}`,
          settings: [
            {
              name: `Request for ${title}`,
              before: "Failed",
              after: "Sent to Radarr or Sonarr again",
            },
          ],
        },
      };
    }
    const { request, title, by } = await this.read(service, id);
    // Stop tracking: the request leaves Seerr's list; the movie and its files are not touched.
    if (kind === "app-seerr-remove") {
      // Seerr resets a title to "not requested" when its last request goes before Seerr marked it
      // available (its Plex scan had not caught up), so it could be requested and downloaded
      // again (11-19). When Radarr or Sonarr has it on disk, Seerr is told first.
      const media = request.media;
      const hit =
        media?.id && media.tmdbId && !IN_LIBRARY.has(media.status ?? 1)
          ? await this.library
              ?.find(request.type === "tv" ? "tv" : "movie", media.tmdbId)
              .catch(() => undefined)
          : undefined;
      return {
        ...base,
        label: `Remove ${by}'s request for ${title} from ${service.name}`,
        serviceName: service.name,
        params: { requestId: id, title, ...(hit ? { markAvailable: media!.id! } : {}) },
        change: {
          summary: `Remove the request for ${title} from ${service.name}`,
          settings: [
            ...(hit
              ? [
                  {
                    name: `${title} in ${service.name}`,
                    before: "Not marked as in your library yet",
                    after: `Marked as in your library first (${hit.service} has it), so ${service.name} keeps showing you have it`,
                  },
                ]
              : []),
            {
              name: `Request for ${title}`,
              before: STATUS_WORDS[request.status ?? 0] ?? "Requested",
              after: `Removed from ${service.name}'s requests. The movie and its files stay.`,
            },
          ],
        },
      };
    }
    if (request.status !== SEERR_REQUEST.pending)
      throw new Error(`The request for ${title} is not waiting for approval any more.`);
    const verb = kind === "app-seerr-approve" ? "Approve" : "Decline";
    return {
      ...base,
      label: `${verb} ${by}'s request for ${title} in ${service.name}`,
      serviceName: service.name,
      params: { requestId: id, title },
      change: {
        summary: `${verb} the request for ${title}`,
        settings: [
          {
            name: `Request for ${title}`,
            before: "Waiting for approval",
            after:
              kind === "app-seerr-approve"
                ? "Approved (Seerr sends it to Radarr or Sonarr)"
                : "Declined",
          },
        ],
      },
    };
  }

  /** A title as Seerr has it now: its name, seasons, and what Seerr already has or was asked for. */
  private async title(
    service: { id: string; name: string; localUrl: string },
    type: "movie" | "tv",
    tmdbId: number,
  ) {
    const r = await this.call<TitleInfo>(
      service,
      "GET",
      `/api/v1/${type}/${tmdbId}`,
      "read a title to request",
    );
    if (!r.ok || !r.data)
      throw new Error(
        `${service.name} found no ${type === "tv" ? "show" : "movie"} with TMDB id ${tmdbId}.`,
      );
    const t = r.data;
    const year = (t.releaseDate ?? t.firstAirDate)?.slice(0, 4);
    return { info: t, name: `${t.title ?? t.name ?? `TMDB ${tmdbId}`}${year ? ` (${year})` : ""}` };
  }

  /** Seasons a show request would ask for: "all" or a list, never season 0 (specials) unless named. */
  private static seasonsOf(info: TitleInfo, raw: unknown): number[] {
    const all = (info.seasons ?? []).map((x) => x.seasonNumber).filter((n) => n > 0);
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text || text === "all") return all;
    const wanted = text
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0);
    const known = new Set((info.seasons ?? []).map((x) => x.seasonNumber));
    const missing = wanted.filter((n) => !known.has(n));
    if (!wanted.length || missing.length)
      throw new Error(
        `That show has no season ${missing.join(", ") || text}. It has: ${[...known].join(", ")}.`,
      );
    return [...new Set(wanted)].sort((a, b) => a - b);
  }

  /** Seasons Seerr already has or was already asked for (any request not declined). */
  private static seasonsTaken(info: TitleInfo): Set<number> {
    const taken = new Set<number>();
    for (const x of info.mediaInfo?.seasons ?? [])
      if ((x.status ?? 1) >= 2) taken.add(x.seasonNumber);
    for (const r of info.mediaInfo?.requests ?? [])
      if (r.status !== SEERR_REQUEST.declined)
        for (const x of r.seasons ?? []) taken.add(x.seasonNumber);
    return taken;
  }

  private async planRequest(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const type =
      params?.mediaType === "tv" ? "tv" : params?.mediaType === "movie" ? "movie" : undefined;
    const tmdbId = Number(params?.tmdbId);
    if (!type || !Number.isInteger(tmdbId) || tmdbId <= 0)
      throw new Error("Say what to request: mediaType (movie or tv) and its tmdbId.");
    const { info, name } = await this.title(service, type, tmdbId);
    const status = info.mediaInfo?.status ?? 1;
    const where = await this.saveTo(service, type, params, info);
    if (type === "movie") {
      if (status >= 2 && status !== 7)
        throw new Error(
          `${name} is ${MEDIA_WORDS[status] ?? "already known to Seerr"}; nothing to request.`,
        );
      const hit = await this.library?.find("movie", tmdbId).catch(() => undefined);
      return {
        ...base,
        label: `Request ${name} in ${service.name}${hit ? ` (already in ${hit.service})` : ""}`,
        serviceName: service.name,
        params: { mediaType: type, tmdbId, title: name, ...where.params },
        change: {
          summary: hit
            ? `Request ${name} again: ${hit.service} already has it downloaded`
            : `Request ${name}`,
          settings: [
            ...(hit
              ? [
                  {
                    name: "Already in your library",
                    before: `${hit.service} has ${name} downloaded`,
                    after: `Requesting it again can download it again. To just show it in ${service.name}, use Tell ${service.name} you have it instead.`,
                  },
                ]
              : []),
            {
              name,
              before: "Not requested",
              after: "Requested by you (as Seerr's owner it is approved and sent to Radarr)",
            },
            ...where.settings,
          ],
        },
      };
    }
    if (status === 6) throw new Error(`${name} is blocklisted in ${service.name}.`);
    const wanted = SeerrOperations.seasonsOf(info, params?.seasons);
    const taken = SeerrOperations.seasonsTaken(info);
    const seasons = wanted.filter((n) => !taken.has(n));
    if (!seasons.length)
      throw new Error(`Every season asked for of ${name} is already in the library or requested.`);
    const which =
      seasons.length === wanted.length && !params?.seasons
        ? "all seasons"
        : `season${seasons.length === 1 ? "" : "s"} ${seasons.join(", ")}`;
    return {
      ...base,
      label: `Request ${name} (${which}) in ${service.name}`,
      serviceName: service.name,
      params: { mediaType: type, tmdbId, title: name, seasons: seasons.join(","), ...where.params },
      change: {
        summary: `Request ${name}, ${which}`,
        settings: [
          {
            name,
            before: taken.size
              ? `Seasons ${[...taken].sort((a, b) => a - b).join(", ")} already in or requested`
              : "Not requested",
            after: `Requested: ${which} (approved and sent to Sonarr)`,
          },
          ...where.settings,
        ],
      },
    };
  }

  /**
   * Where a request is saved, when the owner chose it: one of Seerr's Radarr or Sonarr servers,
   * one of that server's root folders, and a quality profile, each checked against Seerr when
   * planning (as Seerr's own request box offers them). Nothing chosen: Seerr's defaults.
   */
  private async saveTo(
    service: { id: string; name: string; localUrl: string },
    type: "movie" | "tv",
    params: StepParams | undefined,
    info?: TitleInfo,
  ): Promise<{ params: StepParams; settings: { name: string; before: string; after: string }[] }> {
    const folder = typeof params?.rootFolder === "string" ? params.rootFolder.trim() : "";
    const profile = params?.profileId !== undefined ? Number(params.profileId) : undefined;
    // The Crucible as checkpoint (11-17): a movie or show requested from Hearth goes to Radarr or
    // Sonarr already on its row's profile, so the first search uses it.
    const setups =
      profile === undefined && info
        ? await getSetting(this.handle.db, "crucible")
            .then((x) => Object.values(x ?? {}))
            .catch(() => [] as CrucibleSetup[])
        : [];
    if (!folder && profile === undefined && !setups.length) return { params: {}, settings: [] };
    const kind = type === "tv" ? "sonarr" : "radarr";
    const list = await this.call<
      { id: number; name?: string; is4k?: boolean; isDefault?: boolean; activeDirectory?: string }[]
    >(service, "GET", `/api/v1/service/${kind}`, `read ${service.name}'s ${kind} servers`);
    const servers = (list.ok ? (list.data ?? []) : []).filter((s) => !s.is4k);
    const wanted = params?.serverId !== undefined ? Number(params.serverId) : undefined;
    const server =
      servers.find((s) => s.id === wanted) ?? servers.find((s) => s.isDefault) ?? servers[0];
    if (!server)
      throw new Error(
        `${service.name} has no ${kind === "radarr" ? "Radarr" : "Sonarr"} to send it to.`,
      );
    const detail = await this.call<{
      rootFolders?: { path?: string }[];
      profiles?: { id: number; name?: string }[];
    }>(
      service,
      "GET",
      `/api/v1/service/${kind}/${server.id}`,
      `read ${server.name ?? kind}'s folders`,
    );
    const folders = new Set(
      [
        ...(detail.data?.rootFolders ?? []).map((f) => f.path ?? ""),
        server.activeDirectory ?? "",
      ].filter(Boolean),
    );
    if (folder && !folders.has(folder))
      throw new Error(`"${folder}" is not one of ${server.name ?? kind}'s root folders.`);
    let prof = detail.data?.profiles?.find((p) => p.id === profile);
    if (profile !== undefined && !prof)
      throw new Error(`That quality profile is not one of ${server.name ?? kind}'s.`);
    let crucibleRow: string | undefined;
    if (!prof && setups.length && info) {
      const year = Number((info.releaseDate ?? info.firstAirDate ?? "").slice(0, 4)) || undefined;
      const pick = requestProfile(
        {
          ...(year ? { year } : {}),
          genres: (info.genres ?? []).map((g) => g.name ?? "").filter(Boolean),
          ...(info.popularity !== undefined ? { popularity: info.popularity } : {}),
        },
        setups,
        detail.data?.profiles ?? [],
        new Date().getFullYear(),
        type,
      );
      if (pick) {
        prof = { id: pick.id, name: pick.name };
        crucibleRow = `${pick.name} (chosen by the Crucible: ${ladderWords(pick.row, type === "tv" ? "episode" : "movie")})`;
      }
    }
    return {
      params: {
        serverId: server.id,
        ...(folder ? { rootFolder: folder } : {}),
        ...(prof ? { profileId: prof.id } : {}),
      },
      settings: [
        ...(folder ? [{ name: "Saved to", before: "", after: folder }] : []),
        ...(prof
          ? [
              {
                name: "Quality profile",
                before: "",
                after: crucibleRow ?? prof.name ?? `Profile ${prof.id}`,
              },
            ]
          : []),
      ],
    };
  }

  /** Requests a title once: if Seerr already has a request for it (a retry), nothing is sent. */
  private async runRequest(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const type = p.mediaType === "tv" ? "tv" : "movie";
    const tmdbId = Number(p.tmdbId);
    const name = String(p.title ?? `TMDB ${tmdbId}`);
    const seasons = String(p.seasons ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    const before = await this.title(service, type, tmdbId);
    if (type === "movie" && (before.info.mediaInfo?.status ?? 1) >= 2)
      return {
        ok: false,
        stale: true,
        result: `${name} is ${MEDIA_WORDS[before.info.mediaInfo!.status!] ?? "already known to Seerr"} now; nothing was sent.`,
      };
    if (type === "tv") {
      const taken = SeerrOperations.seasonsTaken(before.info);
      if (seasons.some((n) => taken.has(n)))
        return {
          ok: false,
          stale: true,
          result: `Some of those seasons of ${name} were requested or added meanwhile; nothing was sent. Plan it again.`,
        };
    }
    const made = await this.call<{ id?: number; message?: string }>(
      service,
      "POST",
      "/api/v1/request",
      `request ${name}`,
      {
        mediaType: type,
        mediaId: tmdbId,
        is4k: false,
        ...(type === "tv" ? { seasons } : {}),
        // Where it goes, as the owner approved it (Seerr's defaults otherwise).
        ...(p.serverId !== undefined ? { serverId: Number(p.serverId) } : {}),
        ...(typeof p.rootFolder === "string" && p.rootFolder ? { rootFolder: p.rootFolder } : {}),
        ...(p.profileId !== undefined ? { profileId: Number(p.profileId) } : {}),
      },
    );
    if (!made.ok || !made.data?.id)
      return {
        ok: false,
        result: `${service.name} refused (${made.status}${made.data?.message ? `: ${made.data.message}` : ""}). Nothing was requested.`,
      };
    const back = await this.call<{ id?: number; status?: number; media?: { tmdbId?: number } }>(
      service,
      "GET",
      `/api/v1/request/${made.data.id}`,
      "read the new request",
    );
    const verified = back.ok && back.data?.media?.tmdbId === tmdbId;
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `Requested ${name} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { tmdbId, mediaType: type, requestId: made.data.id, verified },
    });
    const state = STATUS_WORDS[back.data?.status ?? 0]?.toLowerCase() ?? "requested";
    return verified
      ? { ok: true, result: `Requested ${name}; ${service.name} lists the request (${state}).` }
      : {
          ok: false,
          result: `${service.name} answered, but the new request for ${name} is not readable.`,
        };
  }

  private async retry(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
    id: number,
  ): Promise<StepOutcome> {
    const { request, title } = await this.read(service, id);
    if (request.status !== SEERR_REQUEST.failed)
      return {
        ok: false,
        stale: true,
        result: `The request for ${title} is no longer failed; nothing was sent.`,
      };
    const done = await this.call(service, "POST", `/api/v1/request/${id}/retry`, "retry a request");
    if (!done.ok)
      return {
        ok: false,
        result: `${service.name} refused (${done.status}). Nothing was changed.`,
      };
    const after = await this.read(service, id);
    const verified = after.request.status !== SEERR_REQUEST.failed;
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `Retried the request for ${title} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { requestId: id, verified },
    });
    return verified
      ? {
          ok: true,
          result: `Retried the request for ${title}; ${service.name} reads it as ${(STATUS_WORDS[after.request.status ?? 0] ?? "sent").toLowerCase()}.`,
        }
      : {
          ok: false,
          result: `${service.name} accepted it, but the request still reads as failed.`,
        };
  }

  private async issue(service: { id: string; name: string; localUrl: string }, id: number) {
    const r = await this.call<SeerrIssue>(service, "GET", `/api/v1/issue/${id}`, "read an issue");
    // Seerr 3.5 answers a deleted issue with 500 "Issue not found." rather than 404.
    const gone = (r.data as { message?: string } | undefined)?.message;
    if (r.status === 404 || (typeof gone === "string" && /not found/i.test(gone))) return undefined;
    if (!r.ok || !r.data)
      throw new Error(`${service.name} could not read issue #${id} (${r.status}).`);
    const tmdb = r.data.media?.tmdbId;
    const type = r.data.media?.mediaType === "tv" ? "tv" : "movie";
    const t = tmdb ? await this.title(service, type, tmdb).catch(() => undefined) : undefined;
    const what = ISSUE_TYPES[r.data.issueType ?? 4] ?? "other";
    return { issue: r.data, name: `${t?.name ?? `issue #${id}`} (${what})` };
  }

  private async planIssue(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const id = Number(params?.issueId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Say which issue (issueId).");
    const op = String(params?.op ?? "");
    if (!["comment", "resolve", "reopen", "delete"].includes(op))
      throw new Error("Say what to do with the issue: comment, resolve, reopen or delete.");
    const found = await this.issue(service, id);
    if (!found) throw new Error(`${service.name} has no issue #${id}.`);
    const { issue, name } = found;
    const open = issue.status !== ISSUE.resolved;
    let summary: string;
    let after: string;
    const out: StepParams = { issueId: id, op, title: name };
    if (op === "comment") {
      const message = typeof params?.message === "string" ? params.message.trim() : "";
      if (!message) throw new Error("Say what the comment is (message).");
      out.message = message;
      out.comments = issue.comments?.length ?? 0;
      summary = `Comment on the issue with ${name}`;
      after = `New comment from you: "${message}"`;
    } else if (op === "resolve") {
      if (!open) throw new Error(`The issue with ${name} is already resolved.`);
      summary = `Resolve the issue with ${name}`;
      after = "Resolved (whoever reported it is told)";
    } else if (op === "reopen") {
      if (open) throw new Error(`The issue with ${name} is already open.`);
      summary = `Reopen the issue with ${name}`;
      after = "Open again";
    } else {
      summary = `Delete the issue with ${name}`;
      after = `Deleted from ${service.name}, with its ${issue.comments?.length ?? 0} comment(s)`;
    }
    return {
      ...base,
      label: `${summary} in ${service.name}`,
      serviceName: service.name,
      params: out,
      change: {
        summary,
        settings: [{ name: `Issue #${id}`, before: open ? "Open" : "Resolved", after }],
      },
    };
  }

  private async runIssue(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const id = Number(p.issueId);
    const op = String(p.op);
    const name = String(p.title ?? `issue #${id}`);
    const found = await this.issue(service, id);
    if (!found)
      return op === "delete"
        ? { ok: true, stale: true, result: `The issue with ${name} is already gone.` }
        : {
            ok: false,
            stale: true,
            result: `${service.name} no longer has the issue with ${name}.`,
          };
    const open = found.issue.status !== ISSUE.resolved;
    const count = found.issue.comments?.length ?? 0;
    // A retry must not post the same comment twice, or flip an issue someone else changed.
    if (op === "comment" && count !== Number(p.comments ?? count))
      return {
        ok: false,
        stale: true,
        result: `The issue with ${name} has new comments since this was planned; nothing was posted. Read them and plan again.`,
      };
    if ((op === "resolve" && !open) || (op === "reopen" && open))
      return {
        ok: false,
        stale: true,
        result: `The issue with ${name} is already ${open ? "open" : "resolved"}; nothing was changed.`,
      };
    const done =
      op === "comment"
        ? await this.call(service, "POST", `/api/v1/issue/${id}/comment`, "comment on an issue", {
            message: String(p.message),
          })
        : op === "delete"
          ? await this.call(service, "DELETE", `/api/v1/issue/${id}`, "delete an issue")
          : await this.call(
              service,
              "POST",
              `/api/v1/issue/${id}/${op === "resolve" ? "resolved" : "open"}`,
              `${op} an issue`,
            );
    if (!done.ok)
      return {
        ok: false,
        result: `${service.name} refused (${done.status}). Nothing was changed.`,
      };
    const after = await this.issue(service, id);
    const verified =
      op === "delete"
        ? !after
        : op === "comment"
          ? (after?.issue.comments?.length ?? 0) > count
          : (after?.issue.status === ISSUE.resolved) === (op === "resolve");
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? `Changed issue #${id}`} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { issueId: id, op, verified },
    });
    const words =
      { comment: "Commented on", resolve: "Resolved", reopen: "Reopened", delete: "Deleted" }[
        op as "comment"
      ] ?? "Changed";
    return verified
      ? { ok: true, result: `${words} the issue with ${name}; ${service.name} confirms it.` }
      : { ok: false, result: `${service.name} answered, but the issue does not read that way.` };
  }

  /**
   * Tell Seerr you have it: a title Radarr or Sonarr has on disk that Seerr shows as not requested
   * (its record was reset when a request was removed early), marked available through Seerr's own
   * API (POST /api/v1/media/{id}/available, as its Mark as Available button). Only when Radarr or
   * Sonarr really has it.
   */
  private async planMarkAvailable(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const type = params?.mediaType === "tv" ? "tv" : "movie";
    const tmdbId = Number(params?.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0)
      throw new Error("Say which title: mediaType (movie or tv) and its tmdbId.");
    const { info, name } = await this.title(service, type, tmdbId);
    const status = info.mediaInfo?.status ?? 1;
    if (IN_LIBRARY.has(status))
      throw new Error(`${service.name} already shows ${name} as in your library.`);
    const mediaId = info.mediaInfo?.id;
    if (!mediaId)
      throw new Error(
        `${service.name} has no record of ${name} yet. Its next library scan adds it; nothing to mark.`,
      );
    const hit = await this.library?.find(type, tmdbId).catch(() => undefined);
    if (!hit)
      throw new Error(
        `Neither Radarr nor Sonarr has ${name} on disk, so Hearth won't tell ${service.name} it's in your library.`,
      );
    return {
      ...base,
      label: `Tell ${service.name} ${name} is in your library`,
      serviceName: service.name,
      params: { mediaType: type, tmdbId, mediaId, title: name },
      change: {
        summary: `Mark ${name} as in your library in ${service.name}`,
        settings: [
          {
            name,
            before: `${service.name}: ${MEDIA_WORDS[status] ?? "not requested"}`,
            after: `In your library (${hit.service} has it), so it can't be requested again by mistake`,
          },
        ],
      },
    };
  }

  private async runMarkAvailable(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const type = p.mediaType === "tv" ? "tv" : "movie";
    const tmdbId = Number(p.tmdbId);
    const mediaId = Number(p.mediaId);
    const title = String(p.title ?? `TMDB ${tmdbId}`);
    const done = await this.call(
      service,
      "POST",
      `/api/v1/media/${mediaId}/available`,
      "mark a title as in the library",
      { is4k: false },
    );
    if (!done.ok)
      return {
        ok: false,
        result: `${service.name} refused (${done.status}). Nothing was changed.`,
      };
    const after = await this.title(service, type, tmdbId).catch(() => undefined);
    const verified = IN_LIBRARY.has(after?.info.mediaInfo?.status ?? 1);
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `Marked ${title} as in the library in ${service.name}`,
      target: `service:${service.id}`,
      detail: { tmdbId, mediaId, verified },
    });
    return verified
      ? { ok: true, result: `${service.name} now shows ${title} as in your library.` }
      : {
          ok: false,
          result: `${service.name} accepted it, but still doesn't show ${title} as available.`,
        };
  }

  /** Removes one request (DELETE /api/v1/request/{id}) and checks Seerr no longer has it. */
  private async remove(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
    id: number,
  ): Promise<StepOutcome> {
    const title = String(step.params?.title ?? `request #${id}`);
    const before = await this.call(service, "GET", `/api/v1/request/${id}`, "read a request");
    if (before.status === 404)
      return {
        ok: true,
        result: `The request for ${title} was already gone from ${service.name}.`,
      };
    const mediaId = Number(step.params?.markAvailable);
    if (Number.isInteger(mediaId) && mediaId > 0) {
      const marked = await this.call(
        service,
        "POST",
        `/api/v1/media/${mediaId}/available`,
        "mark a title as in the library",
        { is4k: false },
      );
      if (!marked.ok)
        return {
          ok: false,
          result: `${service.name} would not mark ${title} as in your library (${marked.status}), so the request was left in place (removing it would make ${title} look not requested).`,
        };
    }
    const done = await this.call(service, "DELETE", `/api/v1/request/${id}`, "remove a request");
    if (!done.ok)
      return {
        ok: false,
        result: `${service.name} refused (${done.status}). Nothing was changed.`,
      };
    const after = await this.call(service, "GET", `/api/v1/request/${id}`, "read a request");
    const verified = after.status === 404;
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `Removed the request for ${title} from ${service.name}`,
      target: `service:${service.id}`,
      detail: { requestId: id, verified },
    });
    return verified
      ? {
          ok: true,
          result: `Removed the request for ${title}; ${service.name} no longer lists it.`,
        }
      : { ok: false, result: `${service.name} accepted it, but still lists the request.` };
  }

  /** Seerr's Radarr servers, as its settings list them (preventSearch: "Enable Automatic Search" off). */
  private async radarrServers(
    service: { id: string; name: string; localUrl: string },
    app: "radarr" | "sonarr" = "radarr",
  ) {
    const r = await this.call<
      {
        id: number;
        name?: string;
        is4k?: boolean;
        preventSearch?: boolean;
        activeProfileId?: number;
        activeProfileName?: string;
      }[]
    >(service, "GET", `/api/v1/settings/${app}`, `read ${service.name}'s ${APP[app]} settings`);
    if (!r.ok || !Array.isArray(r.data))
      throw new Error(`${service.name} did not list its ${APP[app]} settings (${r.status}).`);
    return r.data;
  }

  /**
   * The Crucible (11-17): Seerr's "Enable Automatic Search" for one Radarr, off (or back on).
   * Off, Seerr adds a requested movie without searching; Hearth gives it its row's profile and
   * then starts the search, so the first search always uses the right profile.
   */
  private async planSearchOnAdd(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    // Movies (Radarr) or shows (Sonarr, the Crucible's step 9).
    const app = params?.app === "sonarr" ? "sonarr" : "radarr";
    const servers = await this.radarrServers(service, app);
    const id = Number(params?.serverId);
    const server = servers.find((x) => x.id === id) ?? servers.find((x) => !x.is4k);
    if (!server) throw new Error(`${service.name} has no ${APP[app]} server.`);
    const search = params?.search === true || params?.search === "true";
    const now = !server.preventSearch;
    const where = server.name ?? APP[app];
    const what = app === "sonarr" ? "show" : "movie";
    if (now === search)
      throw new Error(
        `${service.name} already ${search ? "searches" : "leaves the search to Hearth"} for ${where}.`,
      );
    // Turning search back on: the default profile goes back from the holding profile to the one it
    // had (Undo knows it), or, planned fresh, Radarr's first profile not made by Hearth.
    let back: { id: number; name?: string } | undefined;
    if (search && server.activeProfileName === HOLD_PROFILE) {
      const kept = (await getSetting(this.handle.db, "crucible_seerr").catch(() => undefined))?.[
        recordKey(service.id, app)
      ];
      if (params?.profileBefore !== undefined)
        back = { id: Number(params.profileBefore), name: String(params.profileBeforeName ?? "") };
      else if (kept?.profileBefore !== undefined)
        back = { id: kept.profileBefore, name: kept.profileBeforeName ?? "" };
      else {
        const detail = await this.call<{ profiles?: { id: number; name?: string }[] }>(
          service,
          "GET",
          `/api/v1/service/${app}/${server.id}`,
          `read ${APP[app]}'s profiles`,
        );
        back = detail.data?.profiles?.find((x) => !(x.name ?? "").startsWith(HEARTH_PREFIX));
      }
    }
    const words = (on: boolean) =>
      on ? "Yes (Seerr searches)" : "No (Hearth searches after sorting)";
    const summary = `${search ? "Turn on" : "Turn off"} ${service.name}'s automatic search for ${where}`;
    return {
      ...base,
      label: summary,
      serviceName: service.name,
      params: {
        ...(app === "sonarr" ? { app } : {}),
        serverId: server.id,
        search,
        before: now,
        // Turning search off also makes requests wait on the Crucible's holding profile; turning it
        // back on restores the default profile it had (kept from when it was turned off).
        ...(search
          ? back
            ? { profileBefore: back.id, profileBeforeName: back.name ?? `Profile ${back.id}` }
            : {}
          : {
              ...(server.activeProfileId !== undefined
                ? { profileBefore: server.activeProfileId }
                : {}),
              ...(server.activeProfileName ? { profileBeforeName: server.activeProfileName } : {}),
            }),
      },
      change: {
        summary,
        settings: [
          {
            name: `${where}: search as soon as a ${what} is requested`,
            before: words(now),
            after: words(search),
          },
          {
            name: `${where}: quality profile for new requests`,
            before: server.activeProfileName ?? `Profile ${String(server.activeProfileId ?? "?")}`,
            after: search
              ? (back?.name ?? server.activeProfileName ?? "unchanged")
              : `${HOLD_PROFILE} (nothing can be grabbed until the Crucible sorts it)`,
          },
        ],
      },
    };
  }

  private async runSearchOnAdd(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const app = p.app === "sonarr" ? "sonarr" : "radarr";
    const what = app === "sonarr" ? "show" : "movie";
    const servers = await this.radarrServers(service, app);
    const server = servers.find((x) => x.id === Number(p.serverId));
    if (!server)
      return {
        ok: false,
        stale: true,
        result: `${service.name} no longer has that ${APP[app]} server. Nothing was changed.`,
      };
    const before = p.before === true || p.before === "true";
    if (!server.preventSearch !== before)
      return {
        ok: false,
        stale: true,
        result: `${service.name}'s search setting changed since this plan was made. Nothing was changed.`,
      };
    const search = p.search === true || p.search === "true";
    // The default profile for new requests: the Crucible's holding profile while the Crucible
    // starts the searches (found by name in Seerr's view of Radarr), else the one it had before.
    let profile: { id: number; name: string } | undefined;
    if (!search) {
      const detail = await this.call<{ profiles?: { id: number; name?: string }[] }>(
        service,
        "GET",
        `/api/v1/service/${app}/${server.id}`,
        `read ${APP[app]}'s profiles`,
      );
      const hold = detail.data?.profiles?.find((x) => x.name === HOLD_PROFILE);
      if (!hold)
        return {
          ok: false,
          result: `${APP[app]} has no "${HOLD_PROFILE}" profile yet (the Crucible's Save makes it). Nothing was changed.`,
        };
      profile = { id: hold.id, name: HOLD_PROFILE };
    } else if (p.profileBefore !== undefined)
      profile = { id: Number(p.profileBefore), name: String(p.profileBeforeName ?? "") };
    const put = await this.call(
      service,
      "PUT",
      `/api/v1/settings/${app}/${server.id}`,
      `${search ? "turn on" : "turn off"} automatic search (approved plan)`,
      {
        ...server,
        preventSearch: !search,
        ...(profile ? { activeProfileId: profile.id, activeProfileName: profile.name } : {}),
      },
    );
    if (!put.ok)
      return {
        ok: false,
        result: `${service.name} refused the change (${put.status}). Nothing else was changed.`,
      };
    const back = (await this.radarrServers(service, app)).find((x) => x.id === server.id);
    const verified =
      Boolean(back) &&
      !back!.preventSearch === search &&
      (!profile || back!.activeProfileId === profile.id);
    // Remembered while the Crucible holds Seerr's requests (the clean exit puts the default back).
    if (verified) {
      const all = (await getSetting(this.handle.db, "crucible_seerr")) ?? {};
      if (search) delete all[recordKey(service.id, app)];
      else
        all[recordKey(service.id, app)] = {
          app,
          serverId: server.id,
          ...(server.activeProfileId !== undefined
            ? { profileBefore: server.activeProfileId }
            : {}),
          ...(server.activeProfileName ? { profileBeforeName: server.activeProfileName } : {}),
        };
      await setSetting(this.handle.db, "crucible_seerr", all);
    }
    return {
      ok: verified,
      verified,
      result: verified
        ? `${service.name} ${search ? `searches again as soon as a ${what} is requested` : `now adds requested ${what}s without searching; Hearth sorts each and then searches`}, verified by reading it back.`
        : `${service.name} accepted the change, but doesn't read back as approved.`,
    };
  }

  /** Puts Seerr's search setting back as it was. */
  async undo(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome | undefined> {
    if (step.kind !== "app-seerr-search-on-add") return undefined;
    const p = step.params ?? {};
    return this.runSearchOnAdd(
      { ...step, params: { ...p, search: p.before ?? false, before: p.search ?? false } },
      service,
    );
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    if (step.kind === "app-seerr-request") return this.runRequest(step, service);
    if (step.kind === "app-seerr-issue") return this.runIssue(step, service);
    if (step.kind === "app-seerr-search-on-add") return this.runSearchOnAdd(step, service);
    if (step.kind === "app-seerr-mark-available") return this.runMarkAvailable(step, service);
    const id = Number(step.params?.requestId);
    if (step.kind === "app-seerr-remove") return this.remove(step, service, id);
    if (step.kind === "app-seerr-retry") return this.retry(step, service, id);
    const approve = step.kind === "app-seerr-approve";
    const { request, title } = await this.read(service, id);
    if (request.status !== SEERR_REQUEST.pending)
      return {
        ok: false,
        stale: true,
        result: `The request for ${title} was already handled; nothing was changed.`,
      };
    const done = await this.call(
      service,
      "POST",
      `/api/v1/request/${id}/${approve ? "approve" : "decline"}`,
      `${approve ? "approve" : "decline"} a request`,
    );
    if (!done.ok)
      return {
        ok: false,
        result: `${service.name} refused (${done.status}). Nothing was changed.`,
      };
    const after = await this.read(service, id);
    const want = approve ? SEERR_REQUEST.approved : SEERR_REQUEST.declined;
    // An approved request may already be marked done when the media server has it.
    const verified =
      after.request.status === want ||
      (approve && after.request.status === SEERR_REQUEST.completed);
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${approve ? "Approved" : "Declined"} the request for ${title} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { requestId: id, verified },
    });
    return verified
      ? {
          ok: true,
          result: `${approve ? "Approved" : "Declined"} the request for ${title}; ${service.name} confirms it.`,
        }
      : {
          ok: false,
          result: `${service.name} accepted it, but the request still reads as status ${after.request.status}.`,
        };
  }
}
