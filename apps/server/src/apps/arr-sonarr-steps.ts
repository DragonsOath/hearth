import type { StepChange, StepParams } from "@dragon-control/core";
import type { StepOutcome, StepRun } from "../jobs/operations";
import type { MediaLibrary } from "./media-library";

/**
 * The parts of the shared Servarr plan steps (arr-resource-operations.ts) that only Sonarr has
 * (native panels Phase 3): its commands (by series, season or episode), adding a series found
 * through Sonarr's own search, excluding a show from import lists by its TVDB id, and importing
 * files into episodes. Same contract as every step: the plan reads and states before and after,
 * the run reads again and stops if things changed, one call, read back, audit and journal.
 */

type Json = Record<string, unknown>;
type Service = { id: string; name: string; localUrl: string; hostId: string };

export class SonarrPlanError extends Error {}

/** What the shared operations lend these steps. */
export interface StepHost {
  lib: MediaLibrary;
  get(service: Service, path: string, what: string): Promise<Json | undefined>;
  finish(
    step: StepRun,
    service: Service,
    what: string,
    ok: boolean,
    verified: boolean,
    result: string,
    detail: Json,
  ): Promise<StepOutcome>;
  why(data: unknown): string;
}

const yes = (b: boolean) => (b ? "Yes" : "No");
const code = (season: unknown, episode: unknown) =>
  `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
const seriesName = (o: Json | undefined, id: number) =>
  o?.title
    ? `${String(o.title)}${typeof o.year === "number" && o.year ? ` (${o.year})` : ""}`
    : `series #${id}`;

/** Commands the panel and Ember may run in Sonarr, and what each needs. */
const COMMANDS: Record<string, { label: string; needs?: "series" | "season" | "episodes" }> = {
  RefreshSeries: { label: "Refresh (update details and rescan)", needs: "series" },
  RescanSeries: { label: "Rescan the folder", needs: "series" },
  RenameSeries: { label: "Rename files to the naming settings", needs: "series" },
  SeriesSearch: { label: "Search for every missing episode", needs: "series" },
  SeasonSearch: { label: "Search for the season", needs: "season" },
  EpisodeSearch: { label: "Search for the episode", needs: "episodes" },
  Backup: { label: "Make a backup now" },
  MissingEpisodeSearch: { label: "Search for every missing episode" },
  CutoffUnmetEpisodeSearch: {
    label: "Search for upgrades of every episode below its cutoff",
  },
};
const NEVER = new Set(["ApplicationUpdate", "ApplicationUpdateCheck", "InstallUpdate"]);

/** Ways to monitor a new series, in Sonarr's own words. */
const MONITOR: Record<string, string> = {
  all: "Every episode",
  future: "Future episodes",
  missing: "Missing episodes",
  existing: "Episodes with files",
  firstSeason: "The first season",
  lastSeason: "The latest season",
  pilot: "The first episode",
  none: "Nothing",
};

export class SonarrSteps {
  constructor(private readonly h: StepHost) {}

  private async list(service: Service, path: string, what: string): Promise<Json[]> {
    const r = await this.h.lib.arr<Json[]>(service, "GET", path, what);
    return r.data ?? [];
  }

  /** Sonarr's own commands, a scheduled task now, or a manual import. */
  async planCommand(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const name = typeof params?.command === "string" ? params.command : "";
    if (name === "ManualImport") return this.planImport(service, params);
    if (NEVER.has(name))
      throw new SonarrPlanError("Application updates stay in the app itself for now.");
    const tasks = await this.list(service, "/api/v3/system/task", "read tasks (plan)");
    const task = tasks.find((t) => t.taskName === name);
    const known = COMMANDS[name];
    if (!known && !task)
      throw new SonarrPlanError(
        `Say which command (params.command): ${[
          ...Object.keys(COMMANDS),
          ...tasks.map((t) => String(t.taskName)),
        ]
          .filter((n, i, a) => a.indexOf(n) === i && !NEVER.has(n))
          .join(", ")}.`,
      );
    const what = known?.label ?? `Run "${String(task?.name ?? name)}" now`;
    const body: Json = {};
    let scope = service.name;
    if (known?.needs === "series" || known?.needs === "season") {
      const id = Number(params?.seriesId);
      const show =
        Number.isInteger(id) && id > 0
          ? await this.h.get(service, `/api/v3/series/${id}`, "the series")
          : undefined;
      if (!show) throw new SonarrPlanError("Say which series (params.seriesId).");
      scope = seriesName(show, id);
      if (name === "RenameSeries") body.seriesIds = [id];
      else body.seriesId = id;
      if (known.needs === "season") {
        const season = Number(params?.seasonNumber);
        if (!((show.seasons as Json[]) ?? []).some((s) => s.seasonNumber === season))
          throw new SonarrPlanError(`${scope} has no season ${String(params?.seasonNumber)}.`);
        body.seasonNumber = season;
        scope = `${scope}, season ${season}`;
      }
    }
    if (known?.needs === "episodes") {
      const ids = String(params?.episodeIds ?? "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) throw new SonarrPlanError("Say which episodes (params.episodeIds).");
      const names: string[] = [];
      for (const id of ids.slice(0, 5)) {
        const e = await this.h.get(service, `/api/v3/episode/${id}`, "the episode");
        if (!e) throw new SonarrPlanError(`${service.name} has no episode #${id}.`);
        names.push(code(e.seasonNumber, e.episodeNumber));
      }
      body.episodeIds = ids;
      scope = `${names.join(", ")}${ids.length > names.length ? ` and ${ids.length - names.length} more` : ""}`;
    }
    return [
      {
        summary: `${what} in ${service.name}${scope !== service.name ? `: ${scope}` : ""}`,
        settings: [{ name: what, before: "Not running", after: `Runs once for ${scope}` }],
      },
      { command: name, commandBody: JSON.stringify(body), what },
    ];
  }

  async runCommand(step: StepRun, service: Service, what: string, p: StepParams) {
    if (p.command === "ManualImport") return this.runImport(step, service, what, p);
    const extra = typeof p.commandBody === "string" ? (JSON.parse(p.commandBody) as Json) : {};
    const sent = await this.h.lib.arr<Json>(
      service,
      "POST",
      "/api/v3/command",
      `${String(p.what)} (approved plan)`,
      {
        body: { name: p.command, ...extra },
      },
    );
    if (!sent.ok)
      return { ok: false, result: `${service.name} refused the command (${sent.status}).` };
    const status = await this.follow(
      service,
      sent.data?.id,
      String(sent.data?.status ?? "queued"),
      30,
    );
    const verified = status === "completed";
    const result = verified
      ? `${String(p.what)} finished in ${service.name} (it reported the command completed).`
      : status === "failed"
        ? `${service.name} ran ${String(p.what)}, but it failed. See its log in System.`
        : `${service.name} started ${String(p.what)}; it was still running after a minute (${status}).`;
    return this.h.finish(step, service, what, verified || status !== "failed", verified, result, {
      command: p.command,
      status,
    });
  }

  private async follow(service: Service, id: unknown, status: string, tries: number) {
    for (
      let i = 0;
      i < tries && status !== "completed" && status !== "failed" && id !== undefined;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      const now = await this.h.lib.arr<Json>(
        service,
        "GET",
        `/api/v3/command/${String(id)}`,
        "check the command",
      );
      status = String(now.data?.status ?? status);
    }
    return status;
  }

  /**
   * Adding a series: Sonarr's own search gives the show (by TVDB id); the owner picks the root
   * folder, quality profile, series type, season folders, what to monitor, tags and whether to
   * search now. Refused when the show is already in Sonarr, so a retried plan never adds it twice.
   */
  async planSeries(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    let want: Json;
    try {
      want = JSON.parse(String(params?.body ?? "")) as Json;
    } catch {
      throw new SonarrPlanError("Say the series to add as JSON (params.body).");
    }
    const tvdbId = Number(want.tvdbId);
    if (!Number.isInteger(tvdbId) || tvdbId <= 0)
      throw new SonarrPlanError("Say which series (body.tvdbId).");
    const found = (
      await this.list(
        service,
        `/api/v3/series/lookup?term=tvdb:${tvdbId}`,
        "look the series up (plan)",
      )
    )[0];
    if (!found?.title) throw new SonarrPlanError(`Sonarr found no series with TVDB id ${tvdbId}.`);
    const name = seriesName(found, tvdbId);
    if (
      (await this.list(service, `/api/v3/series?tvdbId=${tvdbId}`, "check the library (plan)"))
        .length
    )
      throw new SonarrPlanError(`${name} is already in ${service.name}.`);
    const profileId = Number(want.qualityProfileId);
    const profile = await this.h.get(
      service,
      `/api/v3/qualityprofile/${profileId}`,
      "the quality profile",
    );
    if (!profile)
      throw new SonarrPlanError(
        `${service.name} has no quality profile #${String(want.qualityProfileId)}.`,
      );
    const roots = await this.list(service, "/api/v3/rootfolder", "read root folders (plan)");
    const root = String(want.rootFolderPath ?? "");
    if (!roots.some((r) => r.path === root))
      throw new SonarrPlanError(
        `Say a root folder ${service.name} has (body.rootFolderPath): ${roots.map((r) => String(r.path)).join(", ")}.`,
      );
    const monitor = String(want.monitor ?? "all");
    if (!MONITOR[monitor])
      throw new SonarrPlanError(`Say what to monitor: ${Object.keys(MONITOR).join(", ")}.`);
    const type = ["standard", "daily", "anime"].includes(String(want.seriesType))
      ? String(want.seriesType)
      : "standard";
    const seasonFolder = want.seasonFolder !== false;
    const tags = Array.isArray(want.tags) ? want.tags.map(Number).filter(Number.isInteger) : [];
    const monitored = monitor !== "none";
    const search = want.searchForMissingEpisodes === true && monitored;
    const body: Json = {
      ...found,
      qualityProfileId: profileId,
      rootFolderPath: root,
      seriesType: type,
      seasonFolder,
      monitored,
      tags,
      addOptions: {
        monitor,
        searchForMissingEpisodes: search,
        searchForCutoffUnmetEpisodes: false,
      },
    };
    delete body.id;
    return [
      {
        summary: `Add ${name} to ${service.name}${search ? " and search for missing episodes" : ""}`,
        settings: [
          { name: "Series", before: "Not in Sonarr", after: name },
          { name: "Folder", before: "(new)", after: `${root}/${String(found.folder ?? name)}` },
          { name: "Quality profile", before: "(new)", after: String(profile.name) },
          { name: "Series type", before: "(new)", after: type },
          { name: "Season folders", before: "(new)", after: yes(seasonFolder) },
          { name: "Monitor", before: "(new)", after: MONITOR[monitor]! },
          { name: "Search now", before: "(new)", after: yes(search) },
        ],
      },
      { resource: "series", body: JSON.stringify(body), name },
    ];
  }

  async runCreateSeries(step: StepRun, service: Service, what: string, p: StepParams) {
    const body = JSON.parse(String(p.body)) as Json;
    const tvdbId = Number(body.tvdbId);
    const have = () => this.list(service, `/api/v3/series?tvdbId=${tvdbId}`, "check the library");
    if ((await have()).length)
      return {
        ok: false,
        stale: true,
        result: `${String(p.name)} is already in ${service.name} (perhaps from an earlier try). Nothing was added.`,
      };
    const made = await this.h.lib.arr<Json>(
      service,
      "POST",
      "/api/v3/series",
      `add ${String(p.name)} (approved plan)`,
      { body },
    );
    if (!made.ok)
      return {
        ok: false,
        result: `${service.name} refused to add ${String(p.name)} (${made.status}${this.h.why(made.data)}).`,
      };
    const verified = (await have()).length === 1;
    const searching = Boolean((body.addOptions as Json | undefined)?.searchForMissingEpisodes);
    const result = verified
      ? `Added ${String(p.name)} to ${service.name}, verified by reading it back${searching ? "; Sonarr is searching for missing episodes now" : ""}.`
      : `${service.name} accepted it, but ${String(p.name)} could not be read back.`;
    return this.h.finish(step, service, what, verified, verified, result, {
      resource: "series",
      tvdbId,
    });
  }

  /** Excluding a show from import lists, by its TVDB id; refused when it is already excluded. */
  async planExclusion(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    let want: Json;
    try {
      want = JSON.parse(String(params?.body ?? "")) as Json;
    } catch {
      throw new SonarrPlanError("Say the show to exclude as JSON (params.body).");
    }
    const tvdbId = Number(want.tvdbId);
    if (!Number.isInteger(tvdbId) || tvdbId <= 0)
      throw new SonarrPlanError("Say which series (body.tvdbId).");
    const found = (
      await this.list(
        service,
        `/api/v3/series/lookup?term=tvdb:${tvdbId}`,
        "look the series up (plan)",
      )
    )[0];
    if (!found?.title) throw new SonarrPlanError(`Sonarr found no series with TVDB id ${tvdbId}.`);
    const name = seriesName(found, tvdbId);
    const all = await this.list(
      service,
      "/api/v3/importlistexclusion",
      "read import list exclusions (plan)",
    );
    if (all.some((o) => o.tvdbId === tvdbId))
      throw new SonarrPlanError(`${name} is already excluded.`);
    return [
      {
        summary: `Stop import lists adding ${name} to ${service.name}`,
        settings: [{ name: `${name}: import lists`, before: "May add it", after: "Excluded" }],
      },
      { resource: "exclusion", body: JSON.stringify({ tvdbId, title: found.title }), name },
    ];
  }

  /**
   * Manual import: files Sonarr found in a folder, each matched to episodes of one series in the
   * library, moved or copied in by Sonarr itself. Only files Sonarr lists for that folder can be
   * named, and each episode at most once.
   */
  private async planImport(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const folder = String(params?.folder ?? "").trim();
    if (!folder) throw new SonarrPlanError("Say which folder the files are in (params.folder).");
    const mode = params?.importMode === "copy" ? "copy" : "move";
    let files: Json[];
    try {
      const raw: unknown = JSON.parse(String(params?.files ?? "[]"));
      files = Array.isArray(raw) ? (raw as Json[]) : [];
    } catch {
      throw new SonarrPlanError(
        'Files go in params.files as JSON: [{"path": ..., "seriesId": ..., "episodeIds": [...]}].',
      );
    }
    if (files.length === 0 || files.length > 50)
      throw new SonarrPlanError("Choose from 1 to 50 files to import.");
    const found = await this.candidates(service, folder);
    const settings: StepChange["settings"] = [];
    const seen = new Set<number>();
    const chosen: { path: string; seriesId: number; episodeIds: number[] }[] = [];
    for (const f of files) {
      const path = String(f.path ?? "");
      const c = found.find((x) => x.path === path);
      if (!c) throw new SonarrPlanError(`${service.name} does not list "${path}" in ${folder}.`);
      const seriesId = Number(f.seriesId);
      const show =
        Number.isInteger(seriesId) && seriesId > 0
          ? await this.h.get(service, `/api/v3/series/${seriesId}`, "the series")
          : undefined;
      if (!show)
        throw new SonarrPlanError(`Say which series "${String(c.relativePath)}" is (seriesId).`);
      const ids = (Array.isArray(f.episodeIds) ? f.episodeIds : []).map(Number);
      if (ids.length === 0)
        throw new SonarrPlanError(
          `Say which episodes "${String(c.relativePath)}" is (episodeIds).`,
        );
      const eps = await this.list(
        service,
        `/api/v3/episode?seriesId=${seriesId}`,
        "read the episodes (plan)",
      );
      const picked = ids.map((id) => eps.find((e) => e.id === id));
      if (picked.some((e) => !e))
        throw new SonarrPlanError(`Those episodes are not in ${seriesName(show, seriesId)}.`);
      for (const id of ids) {
        if (seen.has(id)) throw new SonarrPlanError("Choose one file per episode.");
        seen.add(id);
      }
      const quality = String(
        ((c.quality as Json | undefined)?.quality as Json | undefined)?.name ?? "unknown quality",
      );
      const why = ((c.rejections as Json[]) ?? []).map((r) => String(r.reason)).filter(Boolean);
      const replacing = picked.some((e) => e!.hasFile);
      settings.push({
        name: String(c.relativePath ?? path),
        before: `In ${folder}`,
        after: `${mode === "copy" ? "Copied" : "Moved"} into ${seriesName(show, seriesId)} ${picked
          .map((e) => code(e!.seasonNumber, e!.episodeNumber))
          .join(", ")} as ${quality}${replacing ? ", replacing its current file" : ""}${
          why.length ? ` (Sonarr noted: ${why.join("; ")})` : ""
        }`,
      });
      chosen.push({ path, seriesId, episodeIds: ids });
    }
    return [
      {
        summary: `Import ${chosen.length === 1 ? "1 file" : `${chosen.length} files`} into ${service.name} (${mode === "copy" ? "copy, the originals stay" : "move"})`,
        settings,
      },
      {
        command: "ManualImport",
        folder,
        importMode: mode,
        files: JSON.stringify(chosen),
        what: "Import files",
      },
    ];
  }

  private async candidates(service: Service, folder: string): Promise<Json[]> {
    const r = await this.h.lib.arr<Json[]>(
      service,
      "GET",
      `/api/v3/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`,
      "read the files in the folder",
    );
    if (!r.ok) throw new SonarrPlanError(`${service.name} could not read ${folder} (${r.status}).`);
    return r.data ?? [];
  }

  private async runImport(
    step: StepRun,
    service: Service,
    what: string,
    p: StepParams,
  ): Promise<StepOutcome> {
    const folder = String(p.folder);
    const chosen = JSON.parse(String(p.files)) as {
      path: string;
      seriesId: number;
      episodeIds: number[];
    }[];
    const found = await this.candidates(service, folder);
    const files: Json[] = [];
    for (const f of chosen) {
      const c = found.find((x) => x.path === f.path);
      if (!c)
        return {
          ok: false,
          stale: true,
          result: `"${f.path}" is no longer waiting in ${folder} (perhaps already imported). Nothing was imported.`,
        };
      files.push({
        path: c.path,
        seriesId: f.seriesId,
        episodeIds: f.episodeIds,
        quality: c.quality,
        languages: c.languages ?? [],
        releaseGroup: c.releaseGroup ?? "",
        downloadId: c.downloadId ?? "",
        indexerFlags: c.indexerFlags ?? 0,
      });
    }
    const sent = await this.h.lib.arr<Json>(
      service,
      "POST",
      "/api/v3/command",
      "import files (approved plan)",
      {
        body: {
          name: "ManualImport",
          files,
          importMode: p.importMode === "copy" ? "copy" : "move",
        },
      },
    );
    if (!sent.ok)
      return {
        ok: false,
        result: `${service.name} refused the import (${sent.status}${this.h.why(sent.data)}).`,
      };
    const status = await this.follow(
      service,
      sent.data?.id,
      String(sent.data?.status ?? "queued"),
      60,
    );
    const missing: string[] = [];
    for (const f of chosen) {
      const eps = await this.list(
        service,
        `/api/v3/episode?seriesId=${f.seriesId}`,
        "check the episodes",
      );
      for (const id of f.episodeIds) {
        const e = eps.find((x) => x.id === id);
        if (!e?.hasFile) missing.push(e ? code(e.seasonNumber, e.episodeNumber) : `episode #${id}`);
      }
    }
    const verified = status === "completed" && missing.length === 0;
    const result = verified
      ? `Imported ${chosen.length === 1 ? "the file" : `${chosen.length} files`} into ${service.name}, verified: each episode has its file.`
      : status === "failed"
        ? `${service.name} could not import the files. See its log in System.`
        : missing.length
          ? `${service.name} ran the import, but ${missing.join(", ")} still ${missing.length === 1 ? "has" : "have"} no file.`
          : `${service.name} started the import; it was still running after two minutes (${status}).`;
    return this.h.finish(step, service, what, verified || status !== "failed", verified, result, {
      command: "ManualImport",
      status,
      files: chosen.length,
      mode: String(p.importMode),
    });
  }
}
