import { eq } from "drizzle-orm";
import type { ActionKind, StepChange, StepParams } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { CredentialBroker } from "../credentials/broker";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import type { Memory } from "../memory/service";
import { addTimeline } from "../monitor/engine";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import {
  MediaLibrary,
  NAMING_SETTINGS,
  gb,
  qualityName,
  type RadarrFile,
  type RadarrMovie,
  type SonarrEpisode,
} from "./media-library";

/**
 * Library repairs on one title (feature request 18), as approved plan steps:
 *
 * - app-radarr-set-monitored: monitor or stop monitoring one movie (stops re-grabs).
 * - app-radarr-set-upgrades: allow or stop upgrades in one quality profile
 *   (the plan says how many movies use it).
 * - app-radarr-delete-file: delete one movie file Radarr tracks. The plan says
 *   where it goes (Radarr's recycle bin, or gone for good) and what Radarr will
 *   do afterwards (search again if the movie is monitored).
 * - app-plex-delete-media: delete one version of a title in Plex, only when at
 *   least one other version stays, and only if Plex itself allows deleting media.
 *
 * Same pattern as every operation: plan reads the target and states before and
 * after; run reads it again and refuses if anything differs (gone, renamed,
 * another file, another size, changed state); one call for that target only;
 * read back to verify; audit, incident timeline, and journal.
 */

class PlanError extends Error {}

type Service = { id: string; name: string; localUrl: string; hostId: string };

const yes = (b: boolean) => (b ? "Yes" : "No");
const movieName = (m: RadarrMovie) => `${m.title}${m.year ? ` (${m.year})` : ""}`;
const fileWords = (f: RadarrFile) =>
  `${f.path ?? f.relativePath ?? `file #${f.id}`} (${qualityName(f.quality)}, ${gb(f.size) ?? "?"} GB)`;
const num = (v: unknown) =>
  typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;

/** A naming value as the plan shows it: on/off settings as Yes or No, formats as written. */
const shown = (v: unknown) => (typeof v === "boolean" ? yes(v) : String(v ?? ""));
/** The value an approved naming step may set, or undefined if it is not one. */
function namingValue(type: "boolean" | "format", raw: unknown): string | boolean | undefined {
  if (type === "boolean")
    return raw === true || raw === "true"
      ? true
      : raw === false || raw === "false"
        ? false
        : undefined;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v && v.length <= 300 && !/[\r\n]/.test(v) ? v : undefined;
}

export class MediaOperations {
  private readonly lib: MediaLibrary;

  constructor(
    private readonly handle: DbHandle,
    broker: CredentialBroker,
    fetchImpl: Fetch,
    private readonly memory?: Memory,
  ) {
    this.lib = new MediaLibrary(broker, fetchImpl);
  }

  async plan(
    kind: ActionKind,
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

    if (kind === "app-radarr-set-monitored") {
      const movieId = num(params?.movieId);
      const monitored = params?.monitored;
      if (movieId === undefined)
        throw new PlanError("Say which movie (params.movieId, from the radarr tool).");
      if (typeof monitored !== "boolean")
        throw new PlanError("Say whether to monitor it (params.monitored: true or false).");
      const m = await this.lib.movie(service, movieId);
      if (!m) throw new PlanError(`${service.name} has no movie #${movieId}.`);
      if (m.monitored === monitored)
        throw new PlanError(
          `${movieName(m)} is already ${monitored ? "monitored" : "not monitored"} in ${service.name}.`,
        );
      return done(
        {
          summary: `${monitored ? "Monitor" : "Stop monitoring"} ${movieName(m)} in ${service.name}`,
          settings: [
            { name: `${movieName(m)}: monitored`, before: yes(m.monitored), after: yes(monitored) },
          ],
        },
        { movieId, title: movieName(m), monitored },
      );
    }

    if (kind === "app-sonarr-set-monitored" && num(params?.seriesId) !== undefined) {
      // A whole series (Seerr's Stop tracking for a show): Sonarr stops searching for all of it.
      const seriesId = num(params?.seriesId)!;
      const monitored = params?.monitored;
      if (typeof monitored !== "boolean")
        throw new PlanError("Say whether to monitor it (params.monitored: true or false).");
      const sr = await this.lib.oneSeries(service, seriesId);
      if (!sr) throw new PlanError(`${service.name} has no series #${seriesId}.`);
      if (sr.monitored === monitored)
        throw new PlanError(
          `${sr.title} is already ${monitored ? "monitored" : "not monitored"} in ${service.name}.`,
        );
      return done(
        {
          summary: `${monitored ? "Monitor" : "Stop monitoring"} ${sr.title} in ${service.name}`,
          settings: [
            { name: `${sr.title}: monitored`, before: yes(sr.monitored), after: yes(monitored) },
          ],
        },
        { seriesId, title: sr.title, monitored },
      );
    }

    if (kind === "app-sonarr-set-monitored") {
      const episodeId = num(params?.episodeId);
      const monitored = params?.monitored;
      if (episodeId === undefined)
        throw new PlanError("Say which episode (params.episodeId, from the sonarr tool).");
      if (typeof monitored !== "boolean")
        throw new PlanError("Say whether to monitor it (params.monitored: true or false).");
      const e = await this.lib.episode(service, episodeId);
      if (!e) throw new PlanError(`${service.name} has no episode #${episodeId}.`);
      const name = await this.episodeName(service, e);
      if (e.monitored === monitored)
        throw new PlanError(`${name} is already ${monitored ? "monitored" : "not monitored"}.`);
      return done(
        {
          summary: `${monitored ? "Monitor" : "Stop monitoring"} ${name} in ${service.name}`,
          settings: [
            { name: `${name}: monitored`, before: yes(e.monitored), after: yes(monitored) },
          ],
        },
        { episodeId, title: name, monitored },
      );
    }

    if (kind === "app-sonarr-delete-file") {
      const fileId = num(params?.episodeFileId);
      if (fileId === undefined)
        throw new PlanError("Say which file (params.episodeFileId, from the sonarr tool).");
      const f = await this.lib.episodeFile(service, fileId);
      if (!f) throw new PlanError(`${service.name} has no episode file #${fileId}.`);
      const s =
        f.seriesId !== undefined ? await this.lib.oneSeries(service, f.seriesId) : undefined;
      const title = `${s?.title ?? "a series"}: ${f.relativePath ?? f.path ?? `file #${fileId}`}`;
      const episodes = s
        ? (
            await this.lib.arr<{ episodeFileId?: number; monitored: boolean }[]>(
              service,
              "GET",
              `/api/v3/episode?seriesId=${s.id}`,
              "read a series' episodes",
            )
          ).data.filter((x) => x.episodeFileId === fileId)
        : [];
      const bin = await this.lib.recycleBin(service);
      return done(
        {
          summary: `Delete the ${qualityName(f.quality)} episode file (${gb(f.size)} GB) ${title} in ${service.name}`,
          settings: [
            { name: `${s?.title ?? "Series"}: file`, before: fileWords(f), after: "Deleted" },
            { name: "Where it goes", before: "On disk", after: bin.replace("Radarr", "Sonarr") },
            {
              name: "Afterwards",
              before: "Has this file",
              after: episodes.some((x) => x.monitored)
                ? "No file, and Sonarr is monitoring the episode, so it will search for it again"
                : "No file (not monitored, so Sonarr will not search for it)",
            },
          ],
        },
        { episodeFileId: fileId, title, path: f.path ?? f.relativePath ?? "", size: f.size ?? 0 },
      );
    }

    if (kind === "app-arr-unmonitor-owned") {
      const owned = await this.ownedMonitored(service);
      if (!owned.ids.length)
        throw new PlanError(`Everything you have in ${service.name} is already not monitored.`);
      return done(
        {
          summary: `Stop monitoring the ${owned.ids.length} ${owned.what} you already have in ${service.name}`,
          settings: [
            {
              name: `${owned.what[0]!.toUpperCase()}${owned.what.slice(1)} with a file`,
              before: `${owned.ids.length} monitored (for example ${owned.examples.join(", ")})`,
              after: `Not monitored: ${service.name} stops searching for them, including better quality. Missing ones stay monitored.`,
            },
          ],
        },
        { ids: owned.ids.join(","), what: owned.what },
      );
    }

    if (kind === "app-arr-set-naming") {
      const setting = typeof params?.setting === "string" ? params.setting : "";
      const spec = NAMING_SETTINGS[setting];
      if (!spec)
        throw new PlanError(
          `Say which naming setting (params.setting): ${Object.keys(NAMING_SETTINGS).join(", ")}.`,
        );
      const cfg = await this.lib.naming(service);
      if (!cfg) throw new PlanError(`Could not read ${service.name}'s naming settings.`);
      if (!(setting in cfg))
        throw new PlanError(
          `${service.name} has no "${spec.label}" setting (it is a ${spec.apps.join(" or ")} setting).`,
        );
      const value = namingValue(spec.type, params?.value);
      if (value === undefined)
        throw new PlanError(
          spec.type === "boolean"
            ? `Say true or false (params.value) for "${spec.label}".`
            : `Say the new format (params.value: one line, up to 300 characters) for "${spec.label}".`,
        );
      const current = cfg[setting];
      if (current === value)
        throw new PlanError(`"${spec.label}" is already ${shown(value)} in ${service.name}.`);
      return done(
        {
          summary: `Change "${spec.label}" in ${service.name}'s naming settings`,
          settings: [{ name: spec.label, before: shown(current), after: shown(value) }],
        },
        {
          setting,
          value,
          ...(typeof current === "string" || typeof current === "boolean"
            ? { before: current }
            : {}),
        },
      );
    }

    if (kind === "app-arr-set-cutoff-score") {
      const profileId = num(params?.profileId);
      const score =
        num(params?.score) ?? (typeof params?.score === "number" ? params.score : undefined);
      if (profileId === undefined)
        throw new PlanError("Say which quality profile (params.profileId).");
      if (score === undefined || score < 0 || score > 100000)
        throw new PlanError(
          "Say the custom format score to stop upgrading at (params.score, 0 to 100000).",
        );
      const p = await this.lib.profile(service, profileId);
      if (!p) throw new PlanError(`${service.name} has no quality profile #${profileId}.`);
      const current = p.cutoffFormatScore ?? 0;
      if (current === score)
        throw new PlanError(`The "${p.name}" profile already stops at ${score}.`);
      const titles = await this.lib.movies(service).catch(() => undefined);
      const list = titles ?? (await this.lib.series(service));
      const using = list.filter((m) => m.qualityProfileId === p.id).length;
      const what = titles ? "movies" : "series";
      return done(
        {
          summary: `Make the "${p.name}" quality profile stop upgrading at custom format score ${score} in ${service.name} (used by ${using} ${what})`,
          settings: [
            {
              name: `${p.name}: upgrade until custom format score`,
              before: String(current),
              after: String(score),
            },
          ],
        },
        { profileId, profile: p.name, score },
      );
    }

    if (kind === "app-radarr-set-upgrades" || kind === "app-sonarr-set-upgrades") {
      const profileId = num(params?.profileId);
      const allow = params?.upgradeAllowed;
      if (profileId === undefined)
        throw new PlanError(
          "Say which quality profile (params.profileId, from the radarr or sonarr tool).",
        );
      if (typeof allow !== "boolean")
        throw new PlanError("Say whether upgrades are allowed (params.upgradeAllowed).");
      const p = await this.lib.profile(service, profileId);
      if (!p) throw new PlanError(`${service.name} has no quality profile #${profileId}.`);
      if (p.upgradeAllowed === allow)
        throw new PlanError(
          `Upgrades are already ${allow ? "allowed" : "off"} in the "${p.name}" profile.`,
        );
      const sonarr = kind === "app-sonarr-set-upgrades";
      const using = (
        sonarr ? await this.lib.series(service) : await this.lib.movies(service)
      ).filter((m) => m.qualityProfileId === p.id).length;
      return done(
        {
          summary: `${allow ? "Allow" : "Stop"} upgrades in the "${p.name}" quality profile in ${service.name} (used by ${using} ${sonarr ? "series" : "movies"})`,
          settings: [
            {
              name: `${p.name}: upgrades allowed`,
              before: yes(p.upgradeAllowed),
              after: yes(allow),
            },
          ],
        },
        { profileId, profile: p.name, upgradeAllowed: allow },
      );
    }

    if (kind === "app-radarr-delete-file") {
      const movieId = num(params?.movieId);
      const fileId = num(params?.movieFileId);
      if (movieId === undefined || fileId === undefined)
        throw new PlanError(
          "Say which movie and file (params.movieId and params.movieFileId, from the radarr tool).",
        );
      const m = await this.lib.movie(service, movieId);
      if (!m) throw new PlanError(`${service.name} has no movie #${movieId}.`);
      const files = await this.lib.movieFiles(service, movieId);
      const f = files.find((x) => x.id === fileId);
      if (!f) throw new PlanError(`${movieName(m)} has no file #${fileId} in ${service.name}.`);
      const bin = await this.lib.recycleBin(service);
      const left = files.length - 1;
      return done(
        {
          summary: `Delete the ${qualityName(f.quality)} file (${gb(f.size)} GB) of ${movieName(m)} in ${service.name}`,
          settings: [
            { name: `${movieName(m)}: file`, before: fileWords(f), after: "Deleted" },
            { name: "Where it goes", before: "On disk", after: bin },
            {
              name: `${movieName(m)} afterwards`,
              before: `${files.length} file${files.length === 1 ? "" : "s"} tracked`,
              after: left
                ? `${left} file${left === 1 ? "" : "s"} still tracked`
                : m.monitored
                  ? "No file, and Radarr is monitoring it, so it will search for it again"
                  : "No file (not monitored, so Radarr will not search for it)",
            },
          ],
        },
        {
          movieId,
          movieFileId: fileId,
          title: movieName(m),
          path: f.path ?? f.relativePath ?? "",
          size: f.size ?? 0,
        },
      );
    }

    // app-plex-delete-media
    const ratingKey =
      typeof params?.ratingKey === "string" || typeof params?.ratingKey === "number"
        ? String(params.ratingKey)
        : "";
    const mediaId = num(params?.mediaId);
    if (!/^\d+$/.test(ratingKey) || mediaId === undefined)
      throw new PlanError(
        "Say which version (params.ratingKey and params.mediaId, from the plex tool's find).",
      );
    const allowed = await this.lib.plexAllowsDeletion(service);
    if (allowed !== true)
      throw new PlanError(
        `${service.name} does not allow deleting media${allowed === undefined ? " (or its settings could not be read)" : ""}. That is Plex's own switch: Settings > Library > "Allow media deletion". Turning it on is your decision; with it on, Hearth still deletes only a version you approve, never the last copy.`,
      );
    const meta = await this.lib.plexMeta(service, ratingKey);
    if (!meta) throw new PlanError(`${service.name} has no item ${ratingKey}.`);
    const versions = meta.Media ?? [];
    const v = versions.find((x) => x.id === mediaId);
    if (!v) throw new PlanError(`"${meta.title}" has no version ${mediaId} in ${service.name}.`);
    if (versions.length < 2)
      throw new PlanError(
        `That is the only copy of "${meta.title}" in ${service.name}; deleting it would delete the movie, not a duplicate.`,
      );
    const file = v.Part?.[0]?.file ?? "";
    const size = (v.Part ?? []).reduce((s, p) => s + (p.size ?? 0), 0);
    const others = versions
      .filter((x) => x.id !== mediaId)
      .map(
        (x) =>
          `${x.Part?.[0]?.file ?? `version ${x.id}`} (${x.videoResolution ?? "?"}, ${gb((x.Part ?? []).reduce((s, p) => s + (p.size ?? 0), 0))} GB)`,
      );
    const title = `${meta.title}${meta.year ? ` (${meta.year})` : ""}`;
    return done(
      {
        summary:
          `Delete the ${v.videoResolution ?? ""} version (${gb(size)} GB) of ${title} in ${service.name}`.replace(
            "  ",
            " ",
          ),
        settings: [
          {
            name: `${title}: version`,
            before: `${file} (${v.videoResolution ?? "?"}, ${gb(size)} GB)`,
            after: "Deleted from disk by Plex (not recoverable by Hearth)",
          },
          {
            name: `${title}: kept`,
            before: `${versions.length} versions`,
            after: others.join("; "),
          },
        ],
      },
      { ratingKey, mediaId, title, file, size },
    );
  }

  async run(step: StepRun, service: Service, opts: { undo?: boolean } = {}): Promise<StepOutcome> {
    const p = step.params ?? {};
    const change = step.change;
    if (!change) return { ok: false, result: "This step has no approved change." };
    let result: string;
    let verified: boolean;
    let detail: Record<string, unknown>;
    // Space a delete frees: the size read when the plan was made, counted only once verified.
    let freed = 0;

    if (step.kind === "app-radarr-set-monitored") {
      const movieId = num(p.movieId)!;
      const want = p.monitored === true;
      const m = await this.lib.movie(service, movieId);
      if (!m)
        return {
          ok: false,
          stale: true,
          result: `${p.title} is no longer in ${service.name}. Nothing was changed.`,
        };
      if (movieName(m) !== p.title)
        return {
          ok: false,
          stale: true,
          result: `Movie #${movieId} is now ${movieName(m)}, not ${p.title} as approved. Nothing was changed; plan it again.`,
        };
      if (yes(m.monitored) !== change.settings[0]!.before)
        return {
          ok: false,
          stale: true,
          result: `${p.title} is now ${m.monitored ? "monitored" : "not monitored"}, not as when this plan was approved. Nothing was changed; plan it again.`,
        };
      const put = await this.lib.arr(
        service,
        "PUT",
        `/api/v3/movie/${movieId}?moveFiles=false`,
        `change whether ${p.title} is monitored (approved plan)`,
        {
          body: { ...m, monitored: want },
        },
      );
      if (!put.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}). Nothing else was changed.`,
        };
      const after = await this.lib.movie(service, movieId);
      verified = after?.monitored === want;
      result = verified
        ? `${want ? "Monitoring" : "Stopped monitoring"} ${p.title}, verified: ${service.name} now reports it ${want ? "monitored" : "not monitored"}${want ? "" : ", so it will not grab it again"}.`
        : `${service.name} accepted the change but still reports ${p.title} ${after?.monitored ? "monitored" : "not monitored"}.`;
      detail = {
        movie: p.title,
        before: change.settings[0]!.before,
        after: yes(after?.monitored ?? !want),
      };
    } else if (step.kind === "app-sonarr-set-monitored" && num(p.seriesId) !== undefined) {
      const seriesId = num(p.seriesId)!;
      const want = p.monitored === true;
      const sr = await this.lib.oneSeries(service, seriesId);
      if (!sr)
        return {
          ok: false,
          stale: true,
          result: `${p.title} is no longer in ${service.name}. Nothing was changed.`,
        };
      if (sr.title !== p.title || yes(sr.monitored) !== change.settings[0]!.before)
        return {
          ok: false,
          stale: true,
          result: `${p.title} changed since this plan was approved. Nothing was changed; plan it again.`,
        };
      const put = await this.lib.arr(
        service,
        "PUT",
        `/api/v3/series/${seriesId}?moveFiles=false`,
        `change whether ${p.title} is monitored (approved plan)`,
        { body: { ...sr, monitored: want } },
      );
      if (!put.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}). Nothing else was changed.`,
        };
      const after = await this.lib.oneSeries(service, seriesId);
      verified = after?.monitored === want;
      result = verified
        ? `${want ? "Monitoring" : "Stopped monitoring"} ${p.title}, verified: ${service.name} now reports it ${want ? "monitored" : "not monitored"}${want ? "" : ", so it will not search for more of it"}.`
        : `${service.name} accepted the change but still reports ${p.title} ${after?.monitored ? "monitored" : "not monitored"}.`;
      detail = {
        series: p.title,
        before: change.settings[0]!.before,
        after: yes(after?.monitored ?? !want),
      };
    } else if (step.kind === "app-sonarr-set-monitored") {
      const episodeId = num(p.episodeId)!;
      const want = p.monitored === true;
      const e = await this.lib.episode(service, episodeId);
      if (!e)
        return {
          ok: false,
          stale: true,
          result: `${p.title} is no longer in ${service.name}. Nothing was changed.`,
        };
      const name = await this.episodeName(service, e);
      if (name !== p.title)
        return {
          ok: false,
          stale: true,
          result: `Episode #${episodeId} is now ${name}, not ${p.title} as approved. Nothing was changed; plan it again.`,
        };
      if (yes(e.monitored) !== change.settings[0]!.before)
        return {
          ok: false,
          stale: true,
          result: `${p.title} changed since this plan was approved. Nothing was changed; plan it again.`,
        };
      const put = await this.lib.arr(
        service,
        "PUT",
        "/api/v3/episode/monitor",
        `change whether ${p.title} is monitored (approved plan)`,
        {
          body: { episodeIds: [episodeId], monitored: want },
        },
      );
      if (!put.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}). Nothing else was changed.`,
        };
      const after = await this.lib.episode(service, episodeId);
      verified = after?.monitored === want;
      result = verified
        ? `${want ? "Monitoring" : "Stopped monitoring"} ${p.title}, verified: ${service.name} now reports it ${want ? "monitored" : "not monitored"}${want ? "" : ", so it will not grab it again"}.`
        : `${service.name} accepted the change but still reports ${p.title} ${after?.monitored ? "monitored" : "not monitored"}.`;
      detail = {
        episode: p.title,
        before: change.settings[0]!.before,
        after: yes(after?.monitored ?? !want),
      };
    } else if (step.kind === "app-sonarr-delete-file") {
      const fileId = num(p.episodeFileId)!;
      const f = await this.lib.episodeFile(service, fileId);
      if (!f)
        return {
          ok: false,
          stale: true,
          result: `That episode file is no longer in ${service.name}. Nothing was deleted.`,
        };
      if ((f.path ?? f.relativePath ?? "") !== p.path || (f.size ?? 0) !== p.size)
        return {
          ok: false,
          stale: true,
          result: `Episode file #${fileId} is now ${fileWords(f)}, not the one approved. Nothing was deleted; plan it again.`,
        };
      const del = await this.lib.arr(
        service,
        "DELETE",
        `/api/v3/episodefile/${fileId}`,
        `delete one episode file (approved plan)`,
      );
      if (!del.ok)
        return {
          ok: false,
          result: `${service.name} refused to delete it (${del.status}). Nothing was deleted.`,
        };
      verified = !(await this.lib.episodeFile(service, fileId));
      result = verified
        ? `Deleted ${p.path} (${gb(Number(p.size))} GB), verified: ${service.name} no longer has it. ${change.settings[2]?.after ?? ""} Where it went: ${change.settings[1]?.after ?? "unknown"}.`
        : `${service.name} accepted the delete but still has that file.`;
      detail = { file: p.path, sizeGB: gb(Number(p.size)) };
      freed = Number(p.size) || 0;
    } else if (step.kind === "app-arr-unmonitor-owned") {
      const planned = String(p.ids ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      const want = opts.undo ? true : false;
      const now = await this.ownedMonitored(service, opts.undo ? planned : undefined);
      // Only the approved ones that still match (owned and monitored now; on undo, the ones it unmonitored).
      const target = opts.undo ? planned : planned.filter((id) => now.ids.includes(id));
      if (!target.length)
        return {
          ok: false,
          result: `Nothing in the approved list still needs changing in ${service.name}.`,
        };
      const sonarr = now.what === "episodes";
      for (let i = 0; i < target.length; i += 200) {
        const chunk = target.slice(i, i + 200);
        const res = sonarr
          ? await this.lib.arr(
              service,
              "PUT",
              "/api/v3/episode/monitor",
              "change monitoring (approved plan)",
              { body: { episodeIds: chunk, monitored: want } },
            )
          : await this.lib.arr(
              service,
              "PUT",
              "/api/v3/movie/editor",
              "change monitoring (approved plan)",
              { body: { movieIds: chunk, monitored: want } },
            );
        if (!res.ok)
          return {
            ok: false,
            result: `${service.name} refused the change (${res.status}) after ${i} of ${target.length}.`,
          };
      }
      const after = await this.ownedMonitored(service);
      const still = target.filter((id) => after.ids.includes(id));
      verified = want ? true : still.length === 0;
      result = opts.undo
        ? `Monitoring ${target.length} ${now.what} again in ${service.name}, as before.`
        : verified
          ? `Stopped monitoring ${target.length} ${now.what} you already have in ${service.name}, verified by reading it back${planned.length > target.length ? ` (${planned.length - target.length} were already changed or lost their file meanwhile)` : ""}. They will not be searched for or upgraded.`
          : `${service.name} accepted it, but ${still.length} still read back as monitored.`;
      detail = { changed: target.length, stillMonitored: still.length };
    } else if (step.kind === "app-arr-set-naming") {
      const setting = String(p.setting);
      const spec = NAMING_SETTINGS[setting];
      const want = p.value;
      const was = change.settings[0]!;
      const cfg = await this.lib.naming(service);
      if (!spec || !cfg || !(setting in cfg))
        return {
          ok: false,
          stale: true,
          result: `${service.name}'s naming settings could not be read as approved. Nothing was changed; plan it again.`,
        };
      if (shown(cfg[setting]) !== was.before)
        return {
          ok: false,
          stale: true,
          result: `"${spec.label}" is now ${shown(cfg[setting])}, not ${was.before} as approved. Nothing was changed; plan it again.`,
        };
      const put = await this.lib.arr<{ errorMessage?: string }[]>(
        service,
        "PUT",
        `/api/v3/config/naming/${cfg.id ?? 1}`,
        `change "${spec.label}" (approved plan)`,
        { body: { ...cfg, [setting]: want } },
      );
      if (!put.ok) {
        const why = Array.isArray(put.data) ? put.data[0]?.errorMessage : undefined;
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}${why ? `: ${why}` : ""}). Nothing else was changed.`,
        };
      }
      const after = await this.lib.naming(service);
      verified = after?.[setting] === want;
      result = opts.undo
        ? `"${spec.label}" is back to ${shown(want)} in ${service.name}.`
        : verified
          ? `"${spec.label}" is now ${shown(want)} (was ${was.before}), verified by reading ${service.name} back. It applies to files imported from now on; files already in your library keep their names.`
          : `${service.name} accepted the change, but "${spec.label}" still reads ${shown(after?.[setting])}.`;
      detail = { setting, before: was.before, after: after?.[setting] };
    } else if (step.kind === "app-arr-set-cutoff-score") {
      const profileId = num(p.profileId)!;
      const want = Number(p.score);
      const prof = await this.lib.profile(service, profileId);
      if (!prof || prof.name !== p.profile)
        return {
          ok: false,
          stale: true,
          result: `The "${p.profile}" profile is no longer as approved in ${service.name}. Nothing was changed; plan it again.`,
        };
      if (String(prof.cutoffFormatScore ?? 0) !== change.settings[0]!.before)
        return {
          ok: false,
          stale: true,
          result: `"${prof.name}" now stops at ${prof.cutoffFormatScore ?? 0}, not ${change.settings[0]!.before} as approved. Nothing was changed; plan it again.`,
        };
      const put = await this.lib.arr(
        service,
        "PUT",
        `/api/v3/qualityprofile/${profileId}`,
        `change where "${prof.name}" stops upgrading (approved plan)`,
        {
          body: { ...prof, cutoffFormatScore: want },
        },
      );
      if (!put.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}). Nothing else was changed.`,
        };
      const after = await this.lib.profile(service, profileId);
      verified = after?.cutoffFormatScore === want;
      result = verified
        ? `"${prof.name}" now stops upgrading at custom format score ${want} (was ${change.settings[0]!.before}), verified by reading ${service.name} back. Titles at or above it are no longer upgraded.`
        : `${service.name} accepted the change but the profile still reports ${after?.cutoffFormatScore ?? "?"}.`;
      detail = {
        profile: prof.name,
        before: change.settings[0]!.before,
        after: after?.cutoffFormatScore,
      };
    } else if (step.kind === "app-radarr-set-upgrades" || step.kind === "app-sonarr-set-upgrades") {
      const profileId = num(p.profileId)!;
      const want = p.upgradeAllowed === true;
      const prof = await this.lib.profile(service, profileId);
      if (!prof)
        return {
          ok: false,
          stale: true,
          result: `The "${p.profile}" profile is no longer in ${service.name}. Nothing was changed.`,
        };
      if (prof.name !== p.profile)
        return {
          ok: false,
          stale: true,
          result: `Profile #${profileId} is now "${prof.name}", not "${p.profile}" as approved. Nothing was changed; plan it again.`,
        };
      if (yes(prof.upgradeAllowed) !== change.settings[0]!.before)
        return {
          ok: false,
          stale: true,
          result: `Upgrades in "${prof.name}" changed since this plan was approved. Nothing was changed; plan it again.`,
        };
      const put = await this.lib.arr(
        service,
        "PUT",
        `/api/v3/qualityprofile/${profileId}`,
        `change upgrades in the "${prof.name}" profile (approved plan)`,
        {
          body: { ...prof, upgradeAllowed: want },
        },
      );
      if (!put.ok)
        return {
          ok: false,
          result: `${service.name} refused the change (${put.status}). Nothing else was changed.`,
        };
      const after = await this.lib.profile(service, profileId);
      verified = after?.upgradeAllowed === want;
      result = verified
        ? `Upgrades ${want ? "allowed" : "stopped"} in "${prof.name}", verified by reading ${service.name} back.`
        : `${service.name} accepted the change but the profile still reports upgrades ${after?.upgradeAllowed ? "allowed" : "off"}.`;
      detail = {
        profile: prof.name,
        before: change.settings[0]!.before,
        after: yes(after?.upgradeAllowed ?? !want),
      };
    } else if (step.kind === "app-radarr-delete-file") {
      const movieId = num(p.movieId)!;
      const fileId = num(p.movieFileId)!;
      const m = await this.lib.movie(service, movieId);
      if (!m || movieName(m) !== p.title)
        return {
          ok: false,
          stale: true,
          result: `Movie #${movieId} is no longer ${p.title} in ${service.name}. Nothing was deleted.`,
        };
      const files = await this.lib.movieFiles(service, movieId);
      const f = files.find((x) => x.id === fileId);
      if (!f)
        return {
          ok: false,
          stale: true,
          result: `That file of ${p.title} is no longer in ${service.name}. Nothing was deleted.`,
        };
      if ((f.path ?? f.relativePath ?? "") !== p.path || (f.size ?? 0) !== p.size)
        return {
          ok: false,
          stale: true,
          result: `File #${fileId} of ${p.title} is now ${fileWords(f)}, not the one approved. Nothing was deleted; plan it again.`,
        };
      const del = await this.lib.arr(
        service,
        "DELETE",
        `/api/v3/moviefile/${fileId}`,
        `delete one file of ${p.title} (approved plan)`,
      );
      if (!del.ok)
        return {
          ok: false,
          result: `${service.name} refused to delete it (${del.status}). Nothing was deleted.`,
        };
      const left = await this.lib.movieFiles(service, movieId);
      verified = !left.some((x) => x.id === fileId);
      result = verified
        ? `Deleted ${p.path} (${gb(Number(p.size))} GB) of ${p.title}, verified: ${service.name} no longer lists it. ${left.length ? `Still tracked: ${left.map(fileWords).join("; ")}.` : `${p.title} now has no file in ${service.name}${m.monitored ? ", and it is monitored, so Radarr will search for it again" : ""}.`} ${change.settings[1]?.after ? `Where it went: ${change.settings[1].after}.` : ""}`.trim()
        : `${service.name} accepted the delete but still lists that file.`;
      detail = { movie: p.title, file: p.path, sizeGB: gb(Number(p.size)), filesLeft: left.length };
      freed = Number(p.size) || 0;
    } else {
      const ratingKey = String(p.ratingKey);
      const mediaId = num(p.mediaId)!;
      if ((await this.lib.plexAllowsDeletion(service)) !== true)
        return {
          ok: false,
          stale: true,
          result: `${service.name} no longer allows deleting media. Nothing was deleted.`,
        };
      const meta = await this.lib.plexMeta(service, ratingKey);
      const versions = meta?.Media ?? [];
      const v = versions.find((x) => x.id === mediaId);
      const size = (v?.Part ?? []).reduce((s, x) => s + (x.size ?? 0), 0);
      if (!meta || !v)
        return {
          ok: false,
          stale: true,
          result: `That version of ${p.title} is no longer in ${service.name}. Nothing was deleted.`,
        };
      if ((v.Part?.[0]?.file ?? "") !== p.file || size !== p.size)
        return {
          ok: false,
          stale: true,
          result: `Version ${mediaId} of ${p.title} is now a different file. Nothing was deleted; plan it again.`,
        };
      if (versions.length < 2)
        return {
          ok: false,
          stale: true,
          result: `${p.title} has only this copy left in ${service.name}. Nothing was deleted.`,
        };
      const del = await this.lib.plex(
        service,
        "DELETE",
        `/library/metadata/${encodeURIComponent(ratingKey)}/media/${mediaId}`,
        `delete one version of ${p.title} (approved plan)`,
      );
      if (!del.ok)
        return {
          ok: false,
          result: `${service.name} refused to delete it (${del.status}). Nothing was deleted.`,
        };
      const after = await this.lib.plexMeta(service, ratingKey);
      const kept = after?.Media ?? [];
      verified = !kept.some((x) => x.id === mediaId) && kept.length === versions.length - 1;
      result = verified
        ? `Deleted ${p.file} (${gb(Number(p.size))} GB) of ${p.title}, verified: ${service.name} now lists ${kept.length} version${kept.length === 1 ? "" : "s"}: ${kept.map((x) => `${x.Part?.[0]?.file ?? x.id} (${x.videoResolution ?? "?"})`).join("; ")}.`
        : `${service.name} accepted the delete, but reading it back shows ${kept.length} versions${kept.some((x) => x.id === mediaId) ? ", still including that one" : ""}.`;
      detail = {
        title: p.title,
        file: p.file,
        sizeGB: gb(Number(p.size)),
        versionsLeft: kept.length,
      };
      freed = Number(p.size) || 0;
    }

    const action = `${opts.undo ? "Put back: " : ""}${change.summary}`;
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action,
      target: `service:${service.id}`,
      detail: { ...detail, verified },
    });
    if (step.incidentId) {
      await addTimeline(
        this.handle.db,
        step.incidentId,
        new Date().toISOString(),
        verified ? "action" : "escalated",
        result,
      );
    }
    if (verified && this.memory) {
      const host = await this.handle.db
        .select()
        .from(t.hosts)
        .where(eq(t.hosts.id, service.hostId))
        .get();
      await this.memory
        .recordSystem(this.handle.db, {
          title: action,
          body: `${result} Approved as a step of a plan, then verified by reading ${service.name} back.`,
          happenedAt: new Date().toISOString(),
          machine: host?.name,
          links: [{ label: service.name, ref: `service:${service.id}` }],
        })
        .catch(() => undefined);
    }
    return { ok: verified, result, ...(verified && freed ? { freedBytes: freed } : {}) };
  }

  /**
   * Movies (Radarr) or episodes (Sonarr) that have a file and are monitored. Episodes are read per
   * series, so this is one request per series.
   */
  private async ownedMonitored(service: Service, _limitTo?: number[]) {
    const movies = await this.lib.movies(service).catch(() => undefined);
    if (movies) {
      const owned = movies.filter((m) => m.hasFile && m.monitored);
      return {
        what: "movies" as const,
        ids: owned.map((m) => m.id),
        examples: owned.slice(0, 3).map((m) => `${m.title}${m.year ? ` (${m.year})` : ""}`),
      };
    }
    const series = await this.lib.series(service);
    const ids: number[] = [];
    const examples: string[] = [];
    for (const s of series) {
      const eps = await this.lib.arr<SonarrEpisode[]>(
        service,
        "GET",
        `/api/v3/episode?seriesId=${s.id}`,
        "read a series' episodes",
      );
      for (const e of Array.isArray(eps.data) ? eps.data : []) {
        if ((e.hasFile || e.episodeFileId) && e.monitored) {
          ids.push(e.id);
          if (examples.length < 3 && !examples.includes(s.title)) examples.push(s.title);
        }
      }
    }
    return { what: "episodes" as const, ids, examples };
  }

  private async episodeName(service: Service, e: SonarrEpisode): Promise<string> {
    const title =
      e.series?.title ?? (await this.lib.oneSeries(service, e.seriesId))?.title ?? "a series";
    return `${title} S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`;
  }

  /** Settings changes are put back if a later step fails; deletions cannot be. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    if (step.kind === "app-arr-unmonitor-owned") return this.run(step, service, { undo: true });
    const s = step.change?.settings[0];
    if (!s) return undefined;
    if (step.kind === "app-arr-set-naming") {
      if (step.params?.before === undefined) return undefined;
      return this.run(
        {
          ...step,
          params: { ...step.params, value: step.params.before },
          change: {
            summary: step.change!.summary,
            settings: [{ ...s, before: s.after, after: s.before }],
          },
        },
        service,
        { undo: true },
      );
    }
    if (
      step.kind === "app-radarr-set-monitored" ||
      step.kind === "app-radarr-set-upgrades" ||
      step.kind === "app-sonarr-set-monitored" ||
      step.kind === "app-sonarr-set-upgrades" ||
      step.kind === "app-arr-set-cutoff-score"
    ) {
      const key = step.kind.endsWith("-set-monitored")
        ? "monitored"
        : step.kind === "app-arr-set-cutoff-score"
          ? "score"
          : "upgradeAllowed";
      return this.run(
        {
          ...step,
          params: {
            ...step.params,
            [key]: key === "score" ? Number(s.before) : s.before === "Yes",
          },
          change: {
            summary: step.change!.summary,
            settings: [{ ...s, before: s.after, after: s.before }],
          },
        },
        service,
        { undo: true },
      );
    }
    return undefined;
  }
}

export { PlanError as MediaPlanError };
