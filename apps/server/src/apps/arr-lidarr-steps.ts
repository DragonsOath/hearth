import type { StepChange, StepParams } from "@dragon-control/core";
import type { StepOutcome, StepRun } from "../jobs/operations";
import type { StepHost } from "./arr-sonarr-steps";

/**
 * The parts of the shared Servarr plan steps (arr-resource-operations.ts) that only Lidarr has
 * (native panels Phase 3): its commands (by artist or album), adding an artist found through
 * Lidarr's own search, excluding an artist from import lists by its MusicBrainz id, and importing
 * files into an album's tracks. Same contract as every step: the plan reads and states before and
 * after, the run reads again and stops if things changed, one call, read back, audit and journal.
 */

type Json = Record<string, unknown>;
type Service = { id: string; name: string; localUrl: string; hostId: string };

export class LidarrPlanError extends Error {}

const V1 = "/api/v1";
const COMMANDS: Record<string, { label: string; needs?: "artist" | "albums" }> = {
  RefreshArtist: { label: "Refresh (update details and rescan)", needs: "artist" },
  RescanArtist: { label: "Rescan the folder", needs: "artist" },
  RenameArtist: { label: "Rename files to the naming settings", needs: "artist" },
  ArtistSearch: { label: "Search for every missing album", needs: "artist" },
  AlbumSearch: { label: "Search for the album", needs: "albums" },
  Backup: { label: "Make a backup now" },
  MissingAlbumSearch: { label: "Search for every missing album" },
  CutoffUnmetAlbumSearch: { label: "Search for upgrades of every album below its cutoff" },
};
const NEVER = new Set(["ApplicationUpdate", "ApplicationUpdateCheck", "InstallUpdate"]);

/** Ways to monitor a new artist, in Lidarr's own words. */
const MONITOR: Record<string, string> = {
  all: "Every album",
  future: "Future albums",
  missing: "Missing albums",
  existing: "Albums with files",
  first: "The first album",
  latest: "The latest album",
  none: "Nothing",
};
const NEW_ITEMS: Record<string, string> = {
  all: "Every new album",
  new: "New albums only",
  none: "No new albums",
};

const named = (o: Json | undefined, id: number | string) =>
  o?.artistName ? String(o.artistName) : o?.title ? String(o.title) : `#${id}`;

export class LidarrSteps {
  constructor(private readonly h: StepHost) {}

  private async list(service: Service, path: string, what: string): Promise<Json[]> {
    const r = await this.h.lib.arr<Json[]>(service, "GET", path, what);
    if (!r.ok) throw new LidarrPlanError(`${service.name} did not give ${what} (${r.status}).`);
    return r.data ?? [];
  }

  async planCommand(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const name = typeof params?.command === "string" ? params.command : "";
    if (name === "ManualImport") return this.planImport(service, params);
    if (NEVER.has(name))
      throw new LidarrPlanError("Application updates stay in the app itself for now.");
    const tasks = await this.list(service, `${V1}/system/task`, "its scheduled tasks (plan)");
    const task = tasks.find((t) => t.taskName === name);
    const known = COMMANDS[name];
    if (!known && !task)
      throw new LidarrPlanError(
        `Say which command (params.command): ${[
          ...Object.keys(COMMANDS),
          "ManualImport",
          ...tasks.map((t) => String(t.taskName)),
        ]
          .filter((n, i, a) => a.indexOf(n) === i && !NEVER.has(n))
          .join(", ")}.`,
      );
    const what = known?.label ?? `Run "${String(task?.name ?? name)}" now`;
    const body: Json = {};
    let scope = service.name;
    if (known?.needs === "artist") {
      const id = Number(params?.artistId);
      const a =
        Number.isInteger(id) && id > 0
          ? await this.h.get(service, `${V1}/artist/${id}`, "the artist")
          : undefined;
      if (!a) throw new LidarrPlanError("Say which artist (params.artistId).");
      scope = named(a, id);
      if (name === "RenameArtist") body.artistIds = [id];
      else body.artistId = id;
    }
    if (known?.needs === "albums") {
      const ids = String(params?.albumIds ?? "")
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length === 0) throw new LidarrPlanError("Say which albums (params.albumIds).");
      const names: string[] = [];
      for (const id of ids.slice(0, 5)) {
        const al = await this.h.get(service, `${V1}/album/${id}`, "the album");
        if (!al) throw new LidarrPlanError(`${service.name} has no album #${id}.`);
        names.push(named(al, id));
      }
      body.albumIds = ids;
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
      `${V1}/command`,
      `${String(p.what)} (approved plan)`,
      { body: { name: p.command, ...extra } },
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
      i < tries && !["completed", "failed"].includes(status) && id !== undefined;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      const now = await this.h.lib.arr<Json>(
        service,
        "GET",
        `${V1}/command/${String(id)}`,
        "check the command",
      );
      status = String(now.data?.status ?? status);
    }
    return status;
  }

  /**
   * Adding an artist: Lidarr's own search gives the artist (by MusicBrainz id); the owner picks
   * the root folder, quality and metadata profiles, what to monitor, new albums, tags and whether
   * to search now. Refused when the artist is already in Lidarr, so a retry never adds it twice.
   */
  async planArtist(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    let want: Json;
    try {
      want = JSON.parse(String(params?.body ?? "")) as Json;
    } catch {
      throw new LidarrPlanError("Say the artist to add as JSON (params.body).");
    }
    const mbid = String(want.foreignArtistId ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(mbid))
      throw new LidarrPlanError("Say which artist (body.foreignArtistId, a MusicBrainz id).");
    const found = (
      await this.list(
        service,
        `${V1}/artist/lookup?term=lidarr:${mbid}`,
        "look the artist up (plan)",
      )
    )[0];
    if (!found?.artistName) throw new LidarrPlanError(`Lidarr found no artist with id ${mbid}.`);
    const name = named(found, mbid);
    const have = await this.list(service, `${V1}/artist`, "check the library (plan)");
    if (have.some((a) => a.foreignArtistId === mbid))
      throw new LidarrPlanError(`${name} is already in ${service.name}.`);
    const profile = await this.h.get(
      service,
      `${V1}/qualityprofile/${Number(want.qualityProfileId)}`,
      "the quality profile",
    );
    if (!profile)
      throw new LidarrPlanError(
        `${service.name} has no quality profile #${String(want.qualityProfileId)}.`,
      );
    const metadata = await this.h.get(
      service,
      `${V1}/metadataprofile/${Number(want.metadataProfileId)}`,
      "the metadata profile",
    );
    if (!metadata)
      throw new LidarrPlanError(
        `${service.name} has no metadata profile #${String(want.metadataProfileId)}.`,
      );
    const roots = await this.list(service, `${V1}/rootfolder`, "read root folders (plan)");
    const root = String(want.rootFolderPath ?? "");
    const rootOk = roots.find((r) => String(r.path).replace(/\/$/, "") === root.replace(/\/$/, ""));
    if (!rootOk)
      throw new LidarrPlanError(
        `Say a root folder ${service.name} has (body.rootFolderPath): ${roots.map((r) => String(r.path)).join(", ")}.`,
      );
    const monitor = String(want.monitor ?? "all");
    if (!MONITOR[monitor])
      throw new LidarrPlanError(`Say what to monitor: ${Object.keys(MONITOR).join(", ")}.`);
    const newItems = String(want.monitorNewItems ?? "all");
    if (!NEW_ITEMS[newItems])
      throw new LidarrPlanError(
        `Say what to do with new albums: ${Object.keys(NEW_ITEMS).join(", ")}.`,
      );
    const tags = Array.isArray(want.tags) ? want.tags.map(Number).filter(Number.isInteger) : [];
    const monitored = monitor !== "none";
    const search = want.searchForMissingAlbums === true && monitored;
    const body: Json = {
      ...found,
      rootFolderPath: String(rootOk.path),
      qualityProfileId: profile.id,
      metadataProfileId: metadata.id,
      monitored,
      monitorNewItems: newItems,
      tags,
      addOptions: { monitor, searchForMissingAlbums: search },
    };
    return [
      {
        summary: `Add ${name} to ${service.name}`,
        settings: [
          { name: "Artist", before: "Not in Lidarr", after: name },
          { name: "Root folder", before: "(new)", after: String(rootOk.path) },
          { name: "Quality profile", before: "(new)", after: String(profile.name) },
          { name: "Metadata profile", before: "(new)", after: String(metadata.name) },
          { name: "Monitor", before: "(new)", after: MONITOR[monitor]! },
          { name: "New albums", before: "(new)", after: NEW_ITEMS[newItems]! },
          { name: "Search now", before: "(new)", after: search ? "Yes" : "No" },
        ],
      },
      { resource: "artist", body: JSON.stringify(body), name },
    ];
  }

  async runCreateArtist(step: StepRun, service: Service, what: string, p: StepParams) {
    const body = JSON.parse(String(p.body)) as Json;
    const mbid = String(body.foreignArtistId);
    const have = async () =>
      (await this.list(service, `${V1}/artist`, "check the library")).filter(
        (a) => a.foreignArtistId === mbid,
      );
    if ((await have()).length)
      return {
        ok: false,
        stale: true,
        result: `${String(p.name)} is already in ${service.name} (perhaps from an earlier try). Nothing was added.`,
      };
    const made = await this.h.lib.arr<Json>(
      service,
      "POST",
      `${V1}/artist`,
      `add ${String(p.name)} (approved plan)`,
      { body },
    );
    if (!made.ok)
      return {
        ok: false,
        result: `${service.name} refused to add ${String(p.name)} (${made.status}${this.h.why(made.data)}).`,
      };
    const verified = (await have()).length === 1;
    const searching = Boolean((body.addOptions as Json | undefined)?.searchForMissingAlbums);
    const result = verified
      ? `Added ${String(p.name)} to ${service.name}, verified by reading it back${searching ? "; Lidarr is searching for missing albums now" : ""}.`
      : `${service.name} accepted it, but ${String(p.name)} could not be read back.`;
    return this.h.finish(step, service, what, verified, verified, result, {
      resource: "artist",
      foreignArtistId: mbid,
    });
  }

  /** Excluding an artist from import lists, by its MusicBrainz id. */
  async planExclusion(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    let want: Json;
    try {
      want = JSON.parse(String(params?.body ?? "")) as Json;
    } catch {
      throw new LidarrPlanError("Say the artist to exclude as JSON (params.body).");
    }
    const mbid = String(want.foreignId ?? want.foreignArtistId ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(mbid))
      throw new LidarrPlanError("Say which artist (body.foreignId, a MusicBrainz id).");
    const found = (
      await this.list(
        service,
        `${V1}/artist/lookup?term=lidarr:${mbid}`,
        "look the artist up (plan)",
      )
    )[0];
    if (!found?.artistName) throw new LidarrPlanError(`Lidarr found no artist with id ${mbid}.`);
    const name = named(found, mbid);
    const all = await this.list(
      service,
      `${V1}/importlistexclusion`,
      "read import list exclusions (plan)",
    );
    if (all.some((o) => o.foreignId === mbid))
      throw new LidarrPlanError(`${name} is already excluded.`);
    return [
      {
        summary: `Stop import lists adding ${name} to ${service.name}`,
        settings: [{ name: `${name}: import lists`, before: "May add it", after: "Excluded" }],
      },
      { resource: "exclusion", body: JSON.stringify({ foreignId: mbid, artistName: name }), name },
    ];
  }

  /**
   * Manual import: files Lidarr found in a folder, each matched to tracks of one album in the
   * library, moved or copied in by Lidarr itself. Only files Lidarr lists can be named, and each
   * track at most once.
   */
  private async planImport(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const folder = String(params?.folder ?? "").trim();
    if (!folder) throw new LidarrPlanError("Say which folder the files are in (params.folder).");
    const mode = params?.importMode === "copy" ? "copy" : "move";
    let files: Json[];
    try {
      const raw: unknown = JSON.parse(String(params?.files ?? "[]"));
      files = Array.isArray(raw) ? (raw as Json[]) : [];
    } catch {
      throw new LidarrPlanError(
        'Files go in params.files as JSON: [{"path": ..., "albumId": ..., "trackIds": [...]}].',
      );
    }
    if (files.length === 0 || files.length > 100)
      throw new LidarrPlanError("Choose from 1 to 100 files to import.");
    const found = await this.candidates(service, folder);
    const settings: StepChange["settings"] = [];
    const seen = new Set<number>();
    const chosen: {
      path: string;
      artistId: number;
      albumId: number;
      releaseId?: number;
      trackIds: number[];
    }[] = [];
    for (const f of files) {
      const path = String(f.path ?? "");
      const c = found.find((x) => x.path === path);
      if (!c) throw new LidarrPlanError(`${service.name} does not list "${path}" in ${folder}.`);
      const albumId = Number(f.albumId ?? (c.album as Json | undefined)?.id);
      const album =
        Number.isInteger(albumId) && albumId > 0
          ? await this.h.get(service, `${V1}/album/${albumId}`, "the album")
          : undefined;
      if (!album)
        throw new LidarrPlanError(`Say which album "${String(c.name ?? path)}" is (albumId).`);
      const tracks = await this.list(
        service,
        `${V1}/track?albumId=${albumId}`,
        "read the tracks (plan)",
      );
      const ids = (
        Array.isArray(f.trackIds) && f.trackIds.length
          ? f.trackIds
          : ((c.tracks as Json[] | undefined) ?? []).map((t) => t.id)
      ).map(Number);
      if (ids.length === 0)
        throw new LidarrPlanError(`Say which tracks "${String(c.name ?? path)}" is (trackIds).`);
      const picked = ids.map((id) => tracks.find((t) => t.id === id));
      if (picked.some((t) => !t))
        throw new LidarrPlanError(`Those tracks are not on ${named(album, albumId)}.`);
      for (const id of ids) {
        if (seen.has(id)) throw new LidarrPlanError("Choose one file per track.");
        seen.add(id);
      }
      const quality = String(
        ((c.quality as Json | undefined)?.quality as Json | undefined)?.name ?? "unknown quality",
      );
      settings.push({
        name: String(c.name ?? path),
        before: `In ${folder}`,
        after: `${mode === "copy" ? "Copied" : "Moved"} into ${named(album, albumId)}: ${picked
          .map((t) => `${String(t!.trackNumber)}. ${String(t!.title)}`)
          .join(
            ", ",
          )} as ${quality}${picked.some((t) => t!.hasFile) ? ", replacing its current file" : ""}`,
      });
      chosen.push({
        path,
        artistId: Number(album.artistId),
        albumId,
        releaseId: Number(c.albumReleaseId) || undefined,
        trackIds: ids,
      });
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
      `${V1}/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`,
      "read the files in the folder",
    );
    if (!r.ok) throw new LidarrPlanError(`${service.name} could not read ${folder} (${r.status}).`);
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
      artistId: number;
      albumId: number;
      releaseId?: number;
      trackIds: number[];
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
        artistId: f.artistId,
        albumId: f.albumId,
        albumReleaseId: f.releaseId ?? c.albumReleaseId,
        trackIds: f.trackIds,
        quality: c.quality,
        indexerFlags: c.indexerFlags ?? 0,
        downloadId: c.downloadId ?? "",
        disableReleaseSwitching: false,
      });
    }
    const sent = await this.h.lib.arr<Json>(
      service,
      "POST",
      `${V1}/command`,
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
      const tracks = await this.list(
        service,
        `${V1}/track?albumId=${f.albumId}`,
        "check the tracks",
      );
      for (const id of f.trackIds) {
        const t = tracks.find((x) => x.id === id);
        if (!t?.hasFile) missing.push(t ? String(t.title) : `track #${id}`);
      }
    }
    const verified = status === "completed" && missing.length === 0;
    const result = verified
      ? `Imported ${chosen.length === 1 ? "the file" : `${chosen.length} files`} into ${service.name}, verified: each track has its file.`
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
