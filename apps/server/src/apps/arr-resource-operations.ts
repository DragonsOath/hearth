import * as t from "../db/schema";
import { randomBytes } from "node:crypto";
import type { ActionKind, StepChange, StepParams } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import type { CredentialBroker } from "../credentials/broker";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import type { Memory } from "../memory/service";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { MediaLibrary } from "./media-library";
import { LidarrPlanError, LidarrSteps } from "./arr-lidarr-steps";
import { ProwlarrPlanError, ProwlarrSteps } from "./arr-prowlarr-steps";
import { SonarrPlanError, SonarrSteps } from "./arr-sonarr-steps";
import {
  CruciblePlanError,
  hookBaseOf,
  parseSetup,
  shapeOf,
  planCrucible,
  runCrucible,
  undoCrucible,
  type Arr,
} from "./crucible-apply";
import { getSetting, setSetting } from "../store/settings";

/**
 * Changes to a Servarr app's own objects (native Radarr panel, checklist 46.9), as approved plan
 * steps that the panel and Ember share:
 *
 * - app-arr-edit: change named fields of one object (a movie's monitoring, profile, availability
 *   or tags; a quality profile; a custom format; a tag; a delay or release profile; a connection's
 *   ordinary settings; naming; media management).
 * - app-arr-create: add one object (a quality profile, custom format, tag, delay or release
 *   profile, root folder). Refused when one with that name already exists, so a retried plan
 *   never makes two.
 * - app-arr-delete: remove one object (a movie, optionally with its files; a profile, format,
 *   tag, connection, blocklist entry, root folder). Cannot be undone by Hearth.
 * - app-arr-command: run one of the app's own commands (refresh, rescan, rename, backup, or a
 *   scheduled task now). Never an application update (D6).
 *
 * Same contract as every operation: the plan reads the object and states before and after; the run
 * reads it again and stops if it changed since; one call; read back to verify; audit and journal.
 * Logins, API keys and update settings are not objects here (D6). Secret fields (passwords, keys)
 * of connections are never shown or sent from a plan: they stay as they are in the app.
 */

export class ResourcePlanError extends Error {}

type Json = Record<string, unknown>;
type Service = { id: string; name: string; localUrl: string; hostId: string };
type App = "radarr" | "sonarr" | "prowlarr" | "lidarr";
/** Prowlarr and Lidarr are on the v1 API; Radarr and Sonarr on v3. */
const V1_APPS: readonly App[] = ["prowlarr", "lidarr"];

interface ResourceSpec {
  /** API path of the collection, or of the object itself for a singleton. */
  path: string;
  /** What one is called, in plain words. */
  label: string;
  apps: App[];
  singleton?: boolean;
  create?: boolean;
  remove?: boolean;
  /** Only these fields may change (when set). */
  editable?: string[];
  /** These fields never change through this step, and why. */
  locked?: Record<string, string>;
  /** The query sent with a change. */
  putQuery?: string;
  /** Has a "fields" list of settings (connections). */
  fields?: boolean;
  /** Where the collection is for an app that keeps it elsewhere. */
  paths?: Partial<Record<App, string>>;
}

const CONNECTION_LOCK = {
  implementation: "The kind of connection cannot change; add a new one instead.",
  configContract: "The kind of connection cannot change; add a new one instead.",
};

export const RESOURCES: Record<string, ResourceSpec> = {
  movie: {
    path: "/api/v3/movie",
    label: "movie",
    apps: ["radarr"],
    create: true,
    remove: true,
    editable: ["monitored", "qualityProfileId", "minimumAvailability", "tags"],
    putQuery: "?moveFiles=false",
  },
  series: {
    path: "/api/v3/series",
    label: "series",
    apps: ["sonarr"],
    create: true,
    remove: true,
    editable: [
      "monitored",
      "qualityProfileId",
      "seriesType",
      "seasonFolder",
      "tags",
      "monitorNewItems",
      "monitoredSeasons",
    ],
    putQuery: "?moveFiles=false",
  },
  episode: {
    path: "/api/v3/episode",
    label: "episode",
    apps: ["sonarr"],
    editable: ["monitored"],
  },
  qualityprofile: {
    path: "/api/v3/qualityprofile",
    label: "quality profile",
    apps: ["radarr", "sonarr", "lidarr"],
    create: true,
    remove: true,
  },
  customformat: {
    path: "/api/v3/customformat",
    label: "custom format",
    apps: ["radarr", "sonarr", "lidarr"],
    create: true,
    remove: true,
  },
  tag: {
    path: "/api/v3/tag",
    paths: { prowlarr: "/api/v1/tag" },
    label: "tag",
    apps: ["radarr", "sonarr", "prowlarr", "lidarr"],
    create: true,
    remove: true,
  },
  delayprofile: {
    path: "/api/v3/delayprofile",
    label: "delay profile",
    apps: ["radarr", "sonarr", "lidarr"],
    create: true,
    remove: true,
  },
  releaseprofile: {
    path: "/api/v3/releaseprofile",
    label: "release profile",
    apps: ["radarr", "sonarr", "lidarr"],
    create: true,
    remove: true,
  },
  downloadclient: {
    path: "/api/v3/downloadclient",
    paths: { prowlarr: "/api/v1/downloadclient" },
    label: "download client",
    apps: ["radarr", "sonarr", "prowlarr", "lidarr"],
    remove: true,
    fields: true,
    locked: CONNECTION_LOCK,
  },
  indexer: {
    path: "/api/v3/indexer",
    paths: { prowlarr: "/api/v1/indexer" },
    label: "indexer",
    apps: ["radarr", "sonarr", "prowlarr", "lidarr"],
    remove: true,
    fields: true,
    locked: CONNECTION_LOCK,
  },
  notification: {
    path: "/api/v3/notification",
    paths: { prowlarr: "/api/v1/notification" },
    label: "connection",
    apps: ["radarr", "sonarr", "prowlarr", "lidarr"],
    remove: true,
    fields: true,
    locked: CONNECTION_LOCK,
  },
  importlist: {
    path: "/api/v3/importlist",
    label: "import list",
    apps: ["radarr", "sonarr", "lidarr"],
    remove: true,
    fields: true,
    locked: CONNECTION_LOCK,
  },
  naming: {
    path: "/api/v3/config/naming",
    label: "naming settings",
    apps: ["radarr", "sonarr", "lidarr"],
    singleton: true,
  },
  mediamanagement: {
    path: "/api/v3/config/mediamanagement",
    label: "media management settings",
    apps: ["radarr", "sonarr", "lidarr"],
    singleton: true,
  },
  rootfolder: {
    path: "/api/v3/rootfolder",
    label: "root folder",
    apps: ["radarr", "sonarr", "lidarr"],
    create: true,
    remove: true,
    editable: [],
  },
  qualitydefinition: {
    path: "/api/v3/qualitydefinition",
    label: "quality size",
    apps: ["radarr", "sonarr", "lidarr"],
    editable: ["minSize", "maxSize", "preferredSize"],
  },
  exclusion: {
    path: "/api/v3/exclusions",
    paths: { sonarr: "/api/v3/importlistexclusion", lidarr: "/api/v1/importlistexclusion" },
    label: "import list exclusion",
    apps: ["radarr", "sonarr", "lidarr"],
    create: true,
    remove: true,
    editable: [],
  },
  // Lidarr only: artists, albums and metadata profiles.
  artist: {
    path: "/api/v1/artist",
    label: "artist",
    apps: ["lidarr"],
    remove: true,
    editable: ["monitored", "qualityProfileId", "metadataProfileId", "monitorNewItems", "tags"],
    locked: {
      path: "Moving an artist's folder moves its files; do that in Lidarr itself for now.",
      rootFolderPath:
        "Moving an artist's folder moves its files; do that in Lidarr itself for now.",
    },
    putQuery: "?moveFiles=false",
  },
  album: {
    path: "/api/v1/album",
    label: "album",
    apps: ["lidarr"],
    editable: ["monitored", "anyReleaseOk"],
  },
  metadataprofile: {
    path: "/api/v1/metadataprofile",
    label: "metadata profile",
    apps: ["lidarr"],
    create: true,
    remove: true,
  },
  // Prowlarr only: the apps it feeds, their sync profiles, and indexer proxies.
  application: {
    path: "/api/v1/applications",
    label: "app",
    apps: ["prowlarr"],
    remove: true,
    fields: true,
    locked: CONNECTION_LOCK,
  },
  appprofile: {
    path: "/api/v1/appprofile",
    label: "sync profile",
    apps: ["prowlarr"],
    create: true,
    remove: true,
    editable: [
      "name",
      "enableRss",
      "enableAutomaticSearch",
      "enableInteractiveSearch",
      "minimumSeeders",
    ],
  },
  indexerproxy: {
    path: "/api/v1/indexerproxy",
    label: "indexer proxy",
    apps: ["prowlarr"],
    create: true,
    remove: true,
    fields: true,
    locked: CONNECTION_LOCK,
  },
  blocklist: {
    path: "/api/v3/blocklist",
    label: "blocklist entry",
    apps: ["radarr", "sonarr", "lidarr"],
    remove: true,
    editable: [],
  },
};

/** Commands the panel and Ember may run. Scheduled tasks are checked against the app's own list. */
const COMMANDS: Record<string, { label: string; movies?: boolean }> = {
  RefreshMovie: { label: "Refresh (update details and rescan)", movies: true },
  RescanMovie: { label: "Rescan the folder", movies: true },
  RenameMovie: { label: "Rename files to the naming settings", movies: true },
  Backup: { label: "Make a backup now" },
  ManualImport: { label: "Import files" },
  MissingMoviesSearch: { label: "Search for every missing movie" },
  CutoffUnmetMoviesSearch: { label: "Search for upgrades of every movie below its cutoff" },
};
/** Application updates stay out (D6). */
const NEVER_COMMANDS = new Set(["ApplicationUpdate", "ApplicationUpdateCheck", "InstallUpdate"]);

const LOCKED_ALWAYS: Record<string, string> = {
  id: "An object's id never changes.",
  apiKey: "Keys change in the app itself (out of scope, D6).",
  password: "Passwords change in the app itself.",
};

const MOVIE_LOCKED: Record<string, string> = {
  path: 'Move a movie with "Change root folder" (app-radarr-set-root-folder).',
  rootFolderPath: 'Move a movie with "Change root folder" (app-radarr-set-root-folder).',
};

const SERIES_LOCKED: Record<string, string> = {
  path: "Move a series to another folder in Sonarr itself for now.",
  rootFolderPath: "Move a series to another folder in Sonarr itself for now.",
};

const yes = (b: boolean) => (b ? "Yes" : "No");

function parseJson(raw: unknown, what: string): Json {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Json;
  if (typeof raw !== "string") throw new ResourcePlanError(`Say ${what} as JSON.`);
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Json;
  } catch {
    throw new ResourcePlanError(`${what[0]!.toUpperCase()}${what.slice(1)} must be a JSON object.`);
  }
}

/** A connection field is secret when the app marks it private or it is a password. */
function isSecretField(f: Json) {
  return (typeof f.privacy === "string" && f.privacy !== "normal") || f.type === "password";
}

/**
 * Quality profile settings in plain terms, so neither the panel nor Ember has to send the app's
 * whole internal structure: which qualities are allowed (ids, groups by their id), and each custom
 * format's score ({ formatId: score }). Read from and written into "items" and "formatItems".
 */
const itemId = (i: Json) => Number((i.quality as Json | undefined)?.id ?? i.id);
const VIRTUAL: Record<
  string,
  { has: (o: Json) => boolean; read: (o: Json) => unknown; write: (o: Json, v: unknown) => Json }
> = {
  allowedQualities: {
    has: (o) => Array.isArray(o.items),
    read: (o) => (o.items as Json[]).filter((i) => i.allowed).map(itemId),
    write: (o, v) => {
      const ids = Array.isArray(v) ? v.map(Number) : [];
      return {
        items: (o.items as Json[]).map((i) => ({ ...i, allowed: ids.includes(itemId(i)) })),
      };
    },
  },
  monitoredSeasons: {
    has: (o) => Array.isArray(o.seasons),
    read: (o) =>
      (o.seasons as Json[])
        .filter((x) => x.monitored === true)
        .map((x) => Number(x.seasonNumber))
        .sort((a, b) => a - b),
    write: (o, v) => {
      const on = Array.isArray(v) ? v.map(Number) : [];
      return {
        seasons: (o.seasons as Json[]).map((x) => ({
          ...x,
          monitored: on.includes(Number(x.seasonNumber)),
        })),
      };
    },
  },
  formatScores: {
    has: (o) => Array.isArray(o.formatItems),
    read: (o) =>
      Object.fromEntries(
        (o.formatItems as Json[]).map((f) => [String(f.format), Number(f.score ?? 0)]),
      ),
    write: (o, v) => {
      const scores = v && typeof v === "object" ? (v as Json) : {};
      return {
        formatItems: (o.formatItems as Json[]).map((f) =>
          Object.hasOwn(scores, String(f.format))
            ? { ...f, score: Number(scores[String(f.format)]) }
            : f,
        ),
      };
    },
  },
};

/** A setting's value as the plan talks about it (a plain-terms one, or the field itself). */
function valueOf(o: Json, k: string): unknown {
  const v = VIRTUAL[k];
  return v?.has(o) ? v.read(o) : o[k];
}

/** The object after the changes: top-level fields replaced, connection "fields" merged by name. */
function applyChanges(current: Json, changes: Json): Json {
  let next: Json = { ...current };
  for (const [k, v] of Object.entries(changes)) {
    if (VIRTUAL[k]?.has(next)) {
      next = { ...next, ...VIRTUAL[k].write(next, v) };
      continue;
    }
    if (k === "fields" && v && typeof v === "object" && !Array.isArray(v)) {
      next.fields = ((current.fields as Json[]) ?? []).map((f) =>
        Object.hasOwn(v, String(f.name)) ? { ...f, value: (v as Json)[String(f.name)] } : f,
      );
    } else next[k] = v;
  }
  return next;
}

/** The part of an object the changes touch, as it is now (to compare at run time and to undo). */
function beforeOf(current: Json, changes: Json): Json {
  const out: Json = {};
  for (const k of Object.keys(changes)) {
    if (k === "fields" && changes.fields && typeof changes.fields === "object") {
      const names = Object.keys(changes.fields as Json);
      out.fields = Object.fromEntries(
        ((current.fields as Json[]) ?? [])
          .filter((f) => names.includes(String(f.name)))
          .map((f) => [String(f.name), f.value]),
      );
    } else if (
      k === "formatScores" &&
      changes.formatScores &&
      typeof changes.formatScores === "object"
    ) {
      // Only the formats being changed, so the plan and the check talk about just those.
      const all = (valueOf(current, k) ?? {}) as Json;
      out[k] = Object.fromEntries(
        Object.keys(changes.formatScores as Json)
          .filter((id) => Object.hasOwn(all, id))
          .map((id) => [id, all[id]]),
      );
    } else out[k] = valueOf(current, k);
  }
  return out;
}

/** Whether every value in `want` is in `have` (extra properties the app adds are fine). */
export function contains(have: unknown, want: unknown): boolean {
  if (want === null || typeof want !== "object")
    return have === want || (want === undefined && have == null);
  if (Array.isArray(want))
    return (
      Array.isArray(have) &&
      have.length === want.length &&
      want.every((w, i) => contains(have[i], w))
    );
  if (!have || typeof have !== "object") return false;
  return Object.entries(want as Json).every(([k, v]) => contains((have as Json)[k], v));
}

/** The same check as `beforeOf` on the object read now, against what the plan saw. */
function unchanged(now: Json, before: Json): boolean {
  return contains(beforeOf(now, before), before) && contains(before, beforeOf(now, before));
}

/** Radarr leaves a size with no limit out of its answer; Hearth reads that as null (no limit). */
function fillSizes(resource: string, o: Json) {
  if (resource !== "qualitydefinition") return;
  for (const k of ["maxSize", "preferredSize"]) if (o[k] === undefined) o[k] = null;
}

export class ArrResourceOperations {
  private readonly lib: MediaLibrary;

  private readonly sonarr: SonarrSteps;

  private readonly prowlarr: ProwlarrSteps;

  private readonly lidarr: LidarrSteps;

  /** Which app each service is (set on every plan and run), for the API base of lookups. */
  private readonly appOf = new Map<string, App>();

  private base(service: Service) {
    return V1_APPS.includes(this.appOf.get(service.id) ?? "radarr") ? "/api/v1" : "/api/v3";
  }

  constructor(
    private readonly handle: DbHandle,
    broker: CredentialBroker,
    fetchImpl: Fetch,
    private readonly memory?: Memory,
  ) {
    this.lib = new MediaLibrary(broker, fetchImpl);
    this.sonarr = new SonarrSteps({
      lib: this.lib,
      get: (service, path, what) => this.get(service, path, what),
      finish: (step, service, what, ok, verified, result, detail) =>
        this.finish(step, service, what, ok, verified, result, detail),
      why: (data) => this.why(data),
    });
    this.lidarr = new LidarrSteps({
      lib: this.lib,
      get: (service, path, what) => this.get(service, path, what),
      finish: (step, service, what, ok, verified, result, detail) =>
        this.finish(step, service, what, ok, verified, result, detail),
      why: (data) => this.why(data),
    });
    this.prowlarr = new ProwlarrSteps({
      lib: this.lib,
      get: (service, path, what) => this.get(service, path, what),
      finish: (step, service, what, ok, verified, result, detail) =>
        this.finish(step, service, what, ok, verified, result, detail),
      why: (data) => this.why(data),
    });
  }

  /** Sonarr's planning errors are plan errors here too (the owner sees the reason). */
  private async sonarrPlan<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof SonarrPlanError ||
        e instanceof ProwlarrPlanError ||
        e instanceof LidarrPlanError
      )
        throw new ResourcePlanError(e.message);
      throw e;
    }
  }

  private spec(app: App, raw: unknown): [string, ResourceSpec] {
    const key = typeof raw === "string" ? raw.toLowerCase() : "";
    const spec = RESOURCES[key];
    if (!spec || !spec.apps.includes(app))
      throw new ResourcePlanError(
        `Say which kind of object (params.resource): ${Object.entries(RESOURCES)
          .filter(([, s]) => s.apps.includes(app))
          .map(([k]) => k)
          .join(", ")}.`,
      );
    // A v1 app uses the same collection on /api/v1 unless the resource names its own path.
    const path =
      spec.paths?.[app] ??
      (V1_APPS.includes(app) ? spec.path.replace(/^\/api\/v3\//, "/api/v1/") : undefined);
    return [key, path ? { ...spec, path } : spec];
  }

  private async get(service: Service, path: string, what: string): Promise<Json | undefined> {
    const r = await this.lib.arr<Json>(service, "GET", path, `read ${what} (plan)`);
    if (r.status === 404) return undefined;
    if (!r.ok) throw new ResourcePlanError(`${service.name} did not give ${what} (${r.status}).`);
    return r.data;
  }

  /**
   * Whether an object is gone after a removal. Some objects answer a missing id with an error
   * instead of "not found" (Radarr 6.4's custom formats give 500), so an error falls back to
   * looking for the id in the whole list.
   */
  private async gone(service: Service, spec: ResourceSpec, id: number): Promise<boolean> {
    const one = await this.lib.arr<Json>(
      service,
      "GET",
      this.objectPath(spec, id),
      `check the ${spec.label} is gone`,
    );
    if (one.status === 404) return true;
    if (one.ok) return false;
    const all = await this.lib.arr<Json[]>(
      service,
      "GET",
      spec.path,
      `check the ${spec.label} is gone`,
    );
    return all.ok && Array.isArray(all.data) && !all.data.some((x) => x.id === id);
  }

  private objectPath(spec: ResourceSpec, id: number | undefined, current?: Json) {
    if (spec.singleton) return `${spec.path}/${String(current?.id ?? 1)}`;
    return `${spec.path}/${id}`;
  }

  /** A short name for the object, as the owner knows it. */
  private nameOf(spec: ResourceSpec, o: Json | undefined, id?: number) {
    if (!o) return `${spec.label} #${id}`;
    if (spec.singleton) return spec.label;
    if (typeof o.seasonNumber === "number" && typeof o.episodeNumber === "number")
      return `S${String(o.seasonNumber).padStart(2, "0")}E${String(o.episodeNumber).padStart(2, "0")}${
        typeof o.title === "string" && o.title ? ` "${o.title}"` : ""
      }`;
    const n =
      o.title ?? o.artistName ?? o.movieTitle ?? o.name ?? o.label ?? o.path ?? o.sourceTitle;
    const y = o.year ?? o.movieYear;
    const year = typeof y === "number" && y ? ` (${y})` : "";
    return typeof n === "string" && n ? `${n}${year}` : `${spec.label} #${id}`;
  }

  /** Words for a value in a plan: names for profile ids and tag ids, lists shortened. */
  private async words(service: Service, key: string, v: unknown, current?: Json): Promise<string> {
    if (typeof v === "boolean") return yes(v);
    if (key === "monitoredSeasons" && Array.isArray(v))
      return v.length
        ? v.map((n) => (Number(n) === 0 ? "Specials" : `Season ${String(n)}`)).join(", ")
        : "No seasons";
    if ((key === "maxSize" || key === "preferredSize") && v == null) return "No limit";
    if (key === "allowedQualities" && Array.isArray(v) && current) {
      const names = ((current.items as Json[]) ?? [])
        .filter((i) => v.map(Number).includes(itemId(i)))
        .map((i) => String((i.quality as Json | undefined)?.name ?? i.name ?? "?"));
      return names.join(", ") || "Nothing allowed";
    }
    if (key === "formatScores" && v && typeof v === "object" && current)
      return (
        Object.entries(v as Json)
          .map(([id, score]) => {
            const f = ((current.formatItems as Json[]) ?? []).find((x) => String(x.format) === id);
            return `${String(f?.name ?? `#${id}`)}: ${String(score)}`;
          })
          .join("; ") || "None"
      );
    if (key === "metadataProfileId" && typeof v === "number") {
      const p = await this.get(service, `/api/v1/metadataprofile/${v}`, "the metadata profile");
      return p ? `${String(p.name)} (#${v})` : `#${v}`;
    }
    if (key === "qualityProfileId" && typeof v === "number") {
      const p = await this.get(
        service,
        `${this.base(service)}/qualityprofile/${v}`,
        "the quality profile",
      );
      return p ? `${String(p.name)} (#${v})` : `#${v}`;
    }
    // A profile's cutoff is a quality (or group) id: named as the profile lists it.
    if (key === "cutoff" && typeof v === "number" && Array.isArray(current?.items)) {
      const item = (current!.items as Json[]).find((i) => itemId(i) === v);
      const name = item ? ((item.quality as Json | undefined)?.name ?? item.name) : undefined;
      return typeof name === "string" && name ? name : `#${v}`;
    }
    if (key === "tags" && Array.isArray(v)) {
      if (v.length === 0) return "No tags";
      const all =
        (
          await this.lib.arr<Json[]>(
            service,
            "GET",
            `${this.base(service)}/tag`,
            "read tags (plan)",
          )
        ).data ?? [];
      return v
        .map((id) => String(all.find((t) => t.id === id)?.label ?? `#${String(id)}`))
        .join(", ");
    }
    if (key === "items" && Array.isArray(v))
      return (
        (v as Json[])
          .filter((i) => i.allowed)
          .map((i) => String((i.quality as Json | undefined)?.name ?? i.name ?? "?"))
          .join(", ") || "Nothing allowed"
      );
    if (key === "formatItems" && Array.isArray(v))
      return (
        (v as Json[]).map((f) => `${String(f.name ?? f.format)}: ${String(f.score)}`).join("; ") ||
        "None"
      );
    if (key === "specifications" && Array.isArray(v))
      return (
        (v as Json[])
          .map(
            (s) =>
              `${s.negate ? "not " : ""}${String(s.implementationName ?? s.implementation)} "${String(
                ((s.fields as Json[] | undefined)?.find((f) => f.name === "value")?.value ??
                  "") as unknown,
              )}"${s.required ? " (required)" : ""}`,
          )
          .join("; ") || "No conditions"
      );
    if (v === undefined || v === null || v === "") return "(empty)";
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
  }

  private label(key: string) {
    const words: Record<string, string> = {
      monitored: "Monitored",
      qualityProfileId: "Quality profile",
      minimumAvailability: "Minimum availability",
      tags: "Tags",
      items: "Allowed qualities",
      cutoff: "Upgrade until (quality)",
      upgradeAllowed: "Upgrades allowed",
      allowedQualities: "Allowed qualities",
      formatScores: "Custom format scores",
      formatItems: "Custom format scores",
      minFormatScore: "Minimum custom format score",
      cutoffFormatScore: "Upgrade until custom format score",
      minSize: "Minimum size (MB per minute)",
      maxSize: "Maximum size (MB per minute)",
      preferredSize: "Preferred size (MB per minute)",
      minUpgradeFormatScore: "Minimum score increment",
      specifications: "Conditions",
      includeCustomFormatWhenRenaming: "Include in renaming",
      seriesType: "Series type",
      seasonFolder: "Season folders",
      monitorNewItems: "Monitor new seasons",
      monitoredSeasons: "Monitored seasons",
    };
    return words[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
  }

  async plan(
    kind: ActionKind,
    app: App,
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    this.appOf.set(service.id, app);
    const done = (change: StepChange, p: StepParams): PlannedStep => ({
      ...base,
      label: change.summary,
      serviceName: service.name,
      params: p,
      change,
    });
    const id = typeof params?.id === "number" ? params.id : Number(params?.id);

    // The Crucible's Save (crucible-apply.ts): movie rows to Radarr, show rows to Sonarr.
    if (kind === "app-crucible-apply") {
      if (app !== "radarr" && app !== "sonarr")
        throw new ResourcePlanError(
          "The Crucible saves movie rows to Radarr and show rows to Sonarr.",
        );
      // Sonarr's size limits are app-wide: left alone when Recyclarr or Profilarr manages them.
      const sizesManaged =
        app === "sonarr" &&
        (await this.handle.db.select().from(t.services).all()).some((s) =>
          /recyclarr|profilarr/i.test(`${s.name} ${s.image ?? ""}`),
        );
      try {
        return done(
          ...(await planCrucible(this.crucibleArr(service), service.name, {
            ...(params ?? {}),
            app,
            ...(sizesManaged ? { sizesManaged: true } : {}),
          })),
        );
      } catch (e) {
        if (e instanceof CruciblePlanError) throw new ResourcePlanError(e.message);
        throw e;
      }
    }

    if (kind === "app-arr-command" && app === "sonarr")
      return done(...(await this.sonarrPlan(() => this.sonarr.planCommand(service, params))));
    if (kind === "app-arr-command" && app === "prowlarr")
      return done(...(await this.sonarrPlan(() => this.prowlarr.planCommand(service, params))));
    if (kind === "app-arr-command" && app === "lidarr")
      return done(...(await this.sonarrPlan(() => this.lidarr.planCommand(service, params))));
    if (kind === "app-arr-command" && params?.command === "ManualImport")
      return done(...(await this.planImport(service, params)));
    if (kind === "app-arr-command") {
      const name = typeof params?.command === "string" ? params.command : "";
      if (NEVER_COMMANDS.has(name))
        throw new ResourcePlanError("Application updates stay in the app itself for now.");
      const tasks =
        (await this.lib.arr<Json[]>(service, "GET", "/api/v3/system/task", "read tasks (plan)"))
          .data ?? [];
      const task = tasks.find((t) => t.taskName === name);
      const known = COMMANDS[name];
      if (!known && !task)
        throw new ResourcePlanError(
          `Say which command (params.command): ${[
            ...Object.keys(COMMANDS),
            ...tasks.map((t) => String(t.taskName)),
          ]
            .filter((n, i, a) => a.indexOf(n) === i && !NEVER_COMMANDS.has(n))
            .join(", ")}.`,
        );
      const ids =
        typeof params?.movieIds === "string" && params.movieIds
          ? params.movieIds
              .split(",")
              .map(Number)
              .filter((n) => Number.isInteger(n) && n > 0)
          : [];
      if (known?.movies && name === "RenameMovie" && ids.length === 0)
        throw new ResourcePlanError("Say which movies to rename (params.movieIds).");
      const what = known?.label ?? `Run "${String(task?.name ?? name)}" now`;
      const movies: string[] = [];
      for (const m of ids.slice(0, 5)) {
        const o = await this.get(service, `/api/v3/movie/${m}`, "the movie");
        if (!o) throw new ResourcePlanError(`${service.name} has no movie #${m}.`);
        movies.push(this.nameOf(RESOURCES.movie!, o, m));
      }
      const scope = ids.length
        ? `${movies.join(", ")}${ids.length > movies.length ? ` and ${ids.length - movies.length} more` : ""}`
        : known?.movies
          ? "every movie"
          : service.name;
      return done(
        {
          summary: `${what} in ${service.name}${ids.length ? `: ${scope}` : ""}`,
          settings: [{ name: what, before: "Not running", after: `Runs once for ${scope}` }],
        },
        { command: name, ...(ids.length ? { movieIds: ids.join(",") } : {}), what },
      );
    }

    const [resource, spec] = this.spec(app, params?.resource);

    if (kind === "app-arr-create" && resource === "movie")
      return done(...(await this.planMovie(service, params)));
    if (kind === "app-arr-create" && resource === "indexer" && app === "prowlarr")
      return done(...(await this.sonarrPlan(() => this.prowlarr.planIndexer(service, params))));
    if (kind === "app-arr-create" && resource === "artist")
      return done(...(await this.sonarrPlan(() => this.lidarr.planArtist(service, params))));
    if (kind === "app-arr-create" && resource === "series")
      return done(...(await this.sonarrPlan(() => this.sonarr.planSeries(service, params))));
    if (kind === "app-arr-create" && resource === "exclusion")
      return done(
        ...(app === "sonarr"
          ? await this.sonarrPlan(() => this.sonarr.planExclusion(service, params))
          : app === "lidarr"
            ? await this.sonarrPlan(() => this.lidarr.planExclusion(service, params))
            : await this.planExclusion(service, params)),
      );
    if (kind === "app-arr-create") {
      if (!spec.create)
        throw new ResourcePlanError(`Adding a ${spec.label} is not supported here.`);
      const cloneFrom = Number(params?.cloneFrom);
      let body: Json;
      if (Number.isInteger(cloneFrom) && cloneFrom > 0) {
        const source = await this.get(
          service,
          `${spec.path}/${cloneFrom}`,
          `the ${spec.label} to copy`,
        );
        if (!source)
          throw new ResourcePlanError(
            `${service.name} has no ${spec.label} #${cloneFrom} to copy.`,
          );
        const extra =
          params?.body !== undefined ? parseJson(params.body, "the new object (params.body)") : {};
        body = { ...source, ...extra };
      } else body = parseJson(params?.body, "the new object (params.body)");
      delete body.id;
      // A plan never carries a secret: a new connection with a password or key is added in the
      // app itself until the owner approves how Hearth handles those (checklist 46.9j).
      for (const f of Array.isArray(body.fields) ? (body.fields as Json[]) : [])
        if (isSecretField(f) && f.value !== undefined && f.value !== null && f.value !== "")
          throw new ResourcePlanError(
            `"${String(f.label ?? f.name)}" is a secret. Hearth does not send secrets from a plan; add this in ${service.name} itself for now.`,
          );
      const name = String(body.name ?? body.label ?? body.path ?? "");
      if (!name && resource !== "delayprofile")
        throw new ResourcePlanError(`Give the new ${spec.label} a name.`);
      const all =
        (await this.lib.arr<Json[]>(service, "GET", spec.path, `read ${spec.label}s (plan)`))
          .data ?? [];
      if (
        name &&
        all.some(
          (o) => String(o.name ?? o.label ?? o.path ?? "").toLowerCase() === name.toLowerCase(),
        )
      )
        throw new ResourcePlanError(
          `${service.name} already has a ${spec.label} called "${name}".`,
        );
      const settings = await Promise.all(
        Object.entries(body)
          .filter(([k]) => !["id"].includes(k))
          .slice(0, 12)
          .map(async ([k, v]) => ({
            name: this.label(k),
            before: "(new)",
            after: await this.words(service, k, v),
          })),
      );
      return done(
        { summary: `Add the ${spec.label} "${name || "new"}" to ${service.name}`, settings },
        { resource, body: JSON.stringify(body), name },
      );
    }

    if (kind === "app-arr-delete") {
      if (!spec.remove)
        throw new ResourcePlanError(`Removing a ${spec.label} is not supported here.`);
      if (!Number.isInteger(id) || id <= 0)
        throw new ResourcePlanError(`Say which ${spec.label} (params.id).`);
      const current = await this.get(service, this.objectPath(spec, id), `the ${spec.label}`);
      if (resource === "blocklist" && !current) {
        // Radarr has no GET for one blocklist entry: find it in the list.
        const page = await this.lib.arr<{ records?: Json[] }>(
          service,
          "GET",
          `${this.base(service)}/blocklist?page=1&pageSize=1000`,
          "read the blocklist (plan)",
        );
        const entry = page.data?.records?.find((r) => r.id === id);
        if (!entry) throw new ResourcePlanError(`${service.name} has no blocklist entry #${id}.`);
        return done(
          {
            summary: `Remove "${String(entry.sourceTitle)}" from ${service.name}'s blocklist`,
            settings: [
              {
                name: "Blocklist",
                before: String(entry.sourceTitle),
                after: "Removed: it may be downloaded again",
              },
            ],
          },
          { resource, id, name: String(entry.sourceTitle) },
        );
      }
      if (!current) throw new ResourcePlanError(`${service.name} has no ${spec.label} #${id}.`);
      const name = this.nameOf(spec, current, id);
      const deleteFiles = params?.deleteFiles === true;
      const exclude = params?.addImportExclusion === true;
      if (resource === "series" || resource === "artist") {
        const st = (current.statistics as Json | undefined) ?? {};
        const size = typeof st.sizeOnDisk === "number" ? st.sizeOnDisk : 0;
        const files =
          typeof st.episodeFileCount === "number"
            ? st.episodeFileCount
            : typeof st.trackFileCount === "number"
              ? st.trackFileCount
              : 0;
        return done(
          {
            summary: `Remove ${name} from ${service.name}${deleteFiles ? " and delete its files" : ""}`,
            settings: [
              { name: `${name}: in ${service.name}`, before: "Yes", after: "Removed" },
              {
                name: `${name}: files on disk`,
                before: files ? `${files} files, ${(size / 1024 ** 3).toFixed(1)} GB` : "None",
                after: deleteFiles
                  ? files
                    ? `Deleted (${service.name}'s recycle bin if one is set, otherwise gone for good)`
                    : "None"
                  : files
                    ? "Kept on disk"
                    : "None",
              },
              ...(exclude
                ? [{ name: `${name}: import lists`, before: "May add it again", after: "Excluded" }]
                : []),
            ],
          },
          { resource, id, name, deleteFiles, addImportExclusion: exclude },
        );
      }
      if (resource === "movie") {
        const size = typeof current.sizeOnDisk === "number" ? current.sizeOnDisk : 0;
        return done(
          {
            summary: `Remove ${name} from ${service.name}${deleteFiles ? " and delete its files" : ""}`,
            settings: [
              { name: `${name}: in ${service.name}`, before: "Yes", after: "Removed" },
              {
                name: `${name}: files on disk`,
                before: current.hasFile ? `${(size / 1024 ** 3).toFixed(1)} GB` : "None",
                after: deleteFiles
                  ? current.hasFile
                    ? "Deleted (Radarr's recycle bin if one is set, otherwise gone for good)"
                    : "None"
                  : current.hasFile
                    ? "Kept on disk"
                    : "None",
              },
              ...(exclude
                ? [{ name: `${name}: import lists`, before: "May add it again", after: "Excluded" }]
                : []),
            ],
          },
          { resource, id, name, deleteFiles, addImportExclusion: exclude },
        );
      }
      return done(
        {
          summary: `Remove the ${spec.label} "${name}" from ${service.name}`,
          settings: [
            {
              name: `${spec.label[0]!.toUpperCase()}${spec.label.slice(1)}`,
              before: name,
              after: "Removed",
            },
          ],
        },
        { resource, id, name },
      );
    }

    // app-arr-edit
    const changes = parseJson(params?.changes, "the changes (params.changes)");
    if (Object.keys(changes).length === 0) throw new ResourcePlanError("Say what to change.");
    if (!spec.singleton && (!Number.isInteger(id) || id <= 0))
      throw new ResourcePlanError(`Say which ${spec.label} (params.id).`);
    const current = await this.get(
      service,
      spec.singleton ? spec.path : this.objectPath(spec, id),
      `the ${spec.label}`,
    );
    if (!current) throw new ResourcePlanError(`${service.name} has no ${spec.label} #${id}.`);
    fillSizes(resource, current);
    const locked = {
      ...LOCKED_ALWAYS,
      ...(resource === "movie" ? MOVIE_LOCKED : {}),
      ...(resource === "series" ? SERIES_LOCKED : {}),
      ...(spec.locked ?? {}),
    };
    for (const k of Object.keys(changes)) {
      if (locked[k]) throw new ResourcePlanError(`"${k}" cannot change here. ${locked[k]}`);
      if (spec.editable && !spec.editable.includes(k))
        throw new ResourcePlanError(
          `Only these can change on a ${spec.label} here: ${spec.editable.join(", ") || "nothing"}.`,
        );
      if (!(k in current) && k !== "fields" && !VIRTUAL[k]?.has(current))
        throw new ResourcePlanError(`${service.name}'s ${spec.label} has no setting "${k}".`);
    }
    if (changes.fields !== undefined) {
      if (
        !spec.fields ||
        !changes.fields ||
        typeof changes.fields !== "object" ||
        Array.isArray(changes.fields)
      )
        throw new ResourcePlanError('Connection settings go in "fields" as { "name": value }.');
      const have = (current.fields as Json[]) ?? [];
      for (const n of Object.keys(changes.fields as Json)) {
        const f = have.find((x) => x.name === n);
        if (!f)
          throw new ResourcePlanError(`${this.nameOf(spec, current, id)} has no setting "${n}".`);
        if (isSecretField(f))
          throw new ResourcePlanError(
            `"${String(f.label ?? n)}" is a secret. Hearth does not send secrets from a plan; change it in ${service.name} itself for now.`,
          );
      }
    }
    // Allowed qualities in the profile's own order, so reading back compares like with like.
    if (Array.isArray(changes.allowedQualities) && Array.isArray(current.items)) {
      const want = changes.allowedQualities.map(Number);
      changes.allowedQualities = (current.items as Json[])
        .map(itemId)
        .filter((i) => want.includes(i));
      const unknown = want.filter((i) => !(current.items as Json[]).some((x) => itemId(x) === i));
      if (unknown.length)
        throw new ResourcePlanError(`This profile has no quality with id ${unknown.join(", ")}.`);
    }
    // Monitored seasons as sorted season numbers the series has.
    if (changes.monitoredSeasons !== undefined) {
      if (!Array.isArray(changes.monitoredSeasons) || !Array.isArray(current.seasons))
        throw new ResourcePlanError("Monitored seasons are a list of season numbers.");
      const have = (current.seasons as Json[]).map((x) => Number(x.seasonNumber));
      const want = [...new Set(changes.monitoredSeasons.map(Number))].sort((a, b) => a - b);
      const bad = want.filter((n) => !have.includes(n));
      if (bad.length) throw new ResourcePlanError(`This series has no season ${bad.join(", ")}.`);
      changes.monitoredSeasons = want;
    }
    if (
      changes.formatScores &&
      typeof changes.formatScores === "object" &&
      Array.isArray(current.formatItems)
    ) {
      const known = (current.formatItems as Json[]).map((f) => String(f.format));
      const bad = Object.keys(changes.formatScores as Json).filter((id) => !known.includes(id));
      if (bad.length)
        throw new ResourcePlanError(`This profile has no custom format with id ${bad.join(", ")}.`);
      for (const v of Object.values(changes.formatScores as Json))
        if (typeof v !== "number" || !Number.isInteger(v) || Math.abs(v) > 1_000_000)
          throw new ResourcePlanError("A custom format score is a whole number.");
    }
    if (resource === "qualitydefinition") await this.checkSizes(service, current, changes);
    const before = beforeOf(current, changes);
    if (contains(before, changes) && contains(changes, before))
      throw new ResourcePlanError("Nothing would change: it is already like that.");
    const name = this.nameOf(spec, current, id);
    const settings: StepChange["settings"] = [];
    for (const [k, v] of Object.entries(changes)) {
      if (k === "fields") {
        for (const [n, val] of Object.entries(v as Json)) {
          const f = ((current.fields as Json[]) ?? []).find((x) => x.name === n)!;
          settings.push({
            name: `${name}: ${String(f.label ?? n)}`,
            before: await this.words(service, n, f.value),
            after: await this.words(service, n, val),
          });
        }
        continue;
      }
      const now = before[k];
      if (contains(now, v) && contains(v, now)) continue;
      settings.push({
        name: spec.singleton ? this.label(k) : `${name}: ${this.label(k)}`,
        before: await this.words(service, k, now, current),
        after: await this.words(service, k, v, current),
      });
    }
    return done(
      {
        summary: `Change ${spec.singleton ? `${service.name}'s ${spec.label}` : `the ${spec.label} "${name}" in ${service.name}`}`,
        settings,
      },
      {
        resource,
        ...(spec.singleton ? { id: Number(current.id ?? 1) } : { id }),
        name,
        changes: JSON.stringify(changes),
        before: JSON.stringify(before),
      },
    );
  }

  async run(
    step: StepRun,
    app: App,
    service: Service,
    opts: { undo?: boolean } = {},
  ): Promise<StepOutcome> {
    this.appOf.set(service.id, app);
    const p = step.params ?? {};
    if (!step.change) return { ok: false, result: "This step has no approved change." };
    let result: string;
    let verified: boolean;
    let detail: Json;
    const what = step.change.summary;

    if (step.kind === "app-crucible-apply") {
      // The webhook's private key: made once per Radarr, kept in Hearth, never in a plan.
      let hookUrl: string | undefined;
      const base = hookBaseOf(p.hookBase);
      if (base && !opts.undo) {
        const keys = (await getSetting(this.handle.db, "crucible_hooks")) ?? {};
        keys[service.id] ??= randomBytes(24).toString("base64url");
        await setSetting(this.handle.db, "crucible_hooks", keys);
        hookUrl = `${base}/api/crucible/hook/${encodeURIComponent(service.id)}?key=${keys[service.id]}`;
      }
      // Undo while Seerr still sends requests to the holding profile would strand them: the
      // checkpoint is turned off first (its own plan), so nothing is left waiting.
      const checkpoint = (await getSetting(this.handle.db, "crucible_seerr")) ?? {};
      const thisApp = shapeOf(p.app).app;
      if (opts.undo && Object.values(checkpoint).some((c) => (c.app ?? "radarr") === thisApp))
        return {
          ok: false,
          stale: true,
          result: `Seerr still sends new requests to "Waiting for the Crucible". Turn off "Let the Crucible start Seerr's searches" in the Crucible first, then undo this. Nothing was changed.`,
        };
      const r = opts.undo
        ? await undoCrucible(this.crucibleArr(service), service.name, p)
        : await runCrucible(this.crucibleArr(service), service.name, p, hookUrl ? { hookUrl } : {});
      if (r.stale) return { ok: false, stale: true, result: r.result };
      // Saved: the Crucible remembers these rows for this Radarr (and forgets them on Undo).
      if (r.ok) {
        const all = (await getSetting(this.handle.db, "crucible")) ?? {};
        if (opts.undo) delete all[service.id];
        else all[service.id] = parseSetup(p.setup, shapeOf(p.app));
        await setSetting(this.handle.db, "crucible", all);
        // From now on the keeper gives movies added after this their row (crucible-keeper.ts).
        const seen = (await getSetting(this.handle.db, "crucible_seen")) ?? {};
        const movies = await this.crucibleArr(service)<{ id: number }[]>(
          "GET",
          shapeOf(p.app).items,
          "read the library (the Crucible)",
        );
        if (opts.undo) delete seen[service.id];
        else if (movies.ok && Array.isArray(movies.data))
          seen[service.id] = Math.max(0, ...movies.data.map((m) => Number(m.id)));
        await setSetting(this.handle.db, "crucible_seen", seen);
      }
      return this.finish(step, service, what, r.ok, r.verified, r.result, {
        crucible: opts.undo ? "undo" : "save",
      });
    }

    if (step.kind === "app-arr-command" && app === "sonarr")
      return this.sonarr.runCommand(step, service, what, p);
    if (step.kind === "app-arr-command" && app === "prowlarr")
      return this.prowlarr.runCommand(step, service, what, p);
    if (step.kind === "app-arr-command" && app === "lidarr")
      return this.lidarr.runCommand(step, service, what, p);
    if (step.kind === "app-arr-command" && p.command === "ManualImport")
      return this.runImport(step, service, what, p);
    if (step.kind === "app-arr-command") {
      const ids =
        typeof p.movieIds === "string" && p.movieIds ? p.movieIds.split(",").map(Number) : [];
      const sent = await this.lib.arr<Json>(
        service,
        "POST",
        "/api/v3/command",
        `${String(p.what)} (approved plan)`,
        {
          body: { name: p.command, ...(ids.length ? { movieIds: ids } : {}) },
        },
      );
      if (!sent.ok)
        return { ok: false, result: `${service.name} refused the command (${sent.status}).` };
      const cid = sent.data?.id;
      let status = String(sent.data?.status ?? "queued");
      for (
        let i = 0;
        i < 30 && status !== "completed" && status !== "failed" && cid !== undefined;
        i++
      ) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = await this.lib.arr<Json>(
          service,
          "GET",
          `/api/v3/command/${String(cid)}`,
          "check the command",
        );
        status = String(now.data?.status ?? status);
      }
      verified = status === "completed";
      result = verified
        ? `${String(p.what)} finished in ${service.name} (it reported the command completed).`
        : status === "failed"
          ? `${service.name} ran ${String(p.what)}, but it failed. See its log in System.`
          : `${service.name} started ${String(p.what)}; it was still running after a minute (${status}).`;
      detail = { command: p.command, status, movies: ids.length };
      return this.finish(
        step,
        service,
        what,
        verified || status !== "failed",
        verified,
        result,
        detail,
      );
    }

    const [resource, spec] = this.spec(app, p.resource);
    const id = Number(p.id);

    if (step.kind === "app-arr-create" && resource === "movie") {
      const body = parseJson(p.body, "the new movie");
      const tmdbId = Number(body.tmdbId);
      const have = async () =>
        (
          await this.lib.arr<Json[]>(
            service,
            "GET",
            `/api/v3/movie?tmdbId=${tmdbId}`,
            "check the library",
          )
        ).data ?? [];
      if ((await have()).length)
        return {
          ok: false,
          stale: true,
          result: `${String(p.name)} is already in ${service.name} (perhaps from an earlier try). Nothing was added.`,
        };
      const made = await this.lib.arr<Json>(
        service,
        "POST",
        "/api/v3/movie",
        `add ${String(p.name)} (approved plan)`,
        { body },
      );
      if (!made.ok)
        return {
          ok: false,
          result: `${service.name} refused to add ${String(p.name)} (${made.status}${this.why(made.data)}).`,
        };
      verified = (await have()).length === 1;
      result = verified
        ? `Added ${String(p.name)} to ${service.name}, verified by reading it back${body.addOptions && (body.addOptions as Json).searchForMovie ? "; Radarr is searching for it now" : ""}.`
        : `${service.name} accepted it, but ${String(p.name)} could not be read back.`;
      return this.finish(step, service, what, verified, verified, result, { resource, tmdbId });
    }
    if (step.kind === "app-arr-create" && resource === "series")
      return this.sonarr.runCreateSeries(step, service, what, p);
    if (step.kind === "app-arr-create" && resource === "artist")
      return this.lidarr.runCreateArtist(step, service, what, p);
    if (step.kind === "app-arr-create" && resource === "exclusion") {
      const body = parseJson(p.body, "the new exclusion");
      // Radarr excludes by TMDB id, Sonarr by TVDB id, Lidarr by MusicBrainz id.
      const idKey =
        body.tvdbId !== undefined
          ? "tvdbId"
          : body.foreignId !== undefined
            ? "foreignId"
            : "tmdbId";
      const all =
        (await this.lib.arr<Json[]>(service, "GET", spec.path, "read import list exclusions"))
          .data ?? [];
      if (all.some((o) => o[idKey] === body[idKey]))
        return {
          ok: false,
          stale: true,
          result: `${String(p.name)} is already excluded in ${service.name} (perhaps from an earlier try). Nothing was added.`,
        };
      const made = await this.lib.arr<Json>(
        service,
        "POST",
        spec.path,
        `exclude ${String(p.name)} (approved plan)`,
        { body },
      );
      if (!made.ok)
        return {
          ok: false,
          result: `${service.name} refused the exclusion (${made.status}${this.why(made.data)}).`,
        };
      const after =
        (await this.lib.arr<Json[]>(service, "GET", spec.path, "check the exclusion")).data ?? [];
      verified = after.filter((o) => o[idKey] === body[idKey]).length === 1;
      result = verified
        ? `Import lists will no longer add ${String(p.name)} to ${service.name}, verified by reading it back.`
        : `${service.name} accepted it, but the exclusion could not be read back.`;
      return this.finish(step, service, what, verified, verified, result, {
        resource,
        [idKey]: idKey === "foreignId" ? String(body[idKey]) : Number(body[idKey]),
      });
    }
    if (step.kind === "app-arr-create") {
      const body = parseJson(p.body, "the new object");
      const name = String(p.name ?? "");
      const all =
        (await this.lib.arr<Json[]>(service, "GET", spec.path, `read ${spec.label}s`)).data ?? [];
      if (
        name &&
        all.some(
          (o) => String(o.name ?? o.label ?? o.path ?? "").toLowerCase() === name.toLowerCase(),
        )
      )
        return {
          ok: false,
          stale: true,
          result: `${service.name} already has a ${spec.label} called "${name}" (perhaps from an earlier try). Nothing was added.`,
        };
      const made = await this.lib.arr<Json | Json[]>(
        service,
        "POST",
        spec.path,
        `add a ${spec.label} (approved plan)`,
        { body },
      );
      if (!made.ok)
        return {
          ok: false,
          result: `${service.name} refused the new ${spec.label} (${made.status}${this.why(made.data)}).`,
        };
      const newId = (made.data as Json | undefined)?.id;
      const back =
        newId !== undefined
          ? await this.get(service, `${spec.path}/${String(newId)}`, `the new ${spec.label}`)
          : undefined;
      verified =
        Boolean(back) && (!name || String(back?.name ?? back?.label ?? back?.path ?? "") === name);
      result = verified
        ? `Added the ${spec.label} "${name}" to ${service.name} (#${String(newId)}), verified by reading it back.`
        : `${service.name} accepted it, but the new ${spec.label} could not be read back.`;
      detail = { resource, id: newId, name };
      return this.finish(step, service, what, verified, verified, result, detail);
    }

    if (step.kind === "app-arr-delete") {
      const name = String(p.name ?? "");
      if (resource === "blocklist") {
        const del = await this.lib.arr(
          service,
          "DELETE",
          `${spec.path}/${id}`,
          "remove a blocklist entry (approved plan)",
        );
        if (!del.ok && del.status !== 404)
          return { ok: false, result: `${service.name} refused (${del.status}).` };
        const page = await this.lib.arr<{ records?: Json[] }>(
          service,
          "GET",
          `${this.base(service)}/blocklist?page=1&pageSize=1000`,
          "check the blocklist",
        );
        verified = !page.data?.records?.some((r) => r.id === id);
        result = verified
          ? `"${name}" is off ${service.name}'s blocklist, verified.`
          : `${service.name} still lists "${name}".`;
        return this.finish(step, service, what, verified, verified, result, { resource, id });
      }
      const current = await this.get(service, this.objectPath(spec, id), `the ${spec.label}`);
      if (!current)
        return {
          ok: false,
          stale: true,
          result: `${name} is no longer in ${service.name}. Nothing was removed.`,
        };
      if (this.nameOf(spec, current, id) !== name)
        return {
          ok: false,
          stale: true,
          result: `${spec.label} #${id} is now "${this.nameOf(spec, current, id)}", not "${name}" as approved. Nothing was removed; plan it again.`,
        };
      const query =
        resource === "movie"
          ? `?deleteFiles=${p.deleteFiles === true}&addImportExclusion=${p.addImportExclusion === true}`
          : resource === "series" || resource === "artist"
            ? `?deleteFiles=${p.deleteFiles === true}&addImportListExclusion=${p.addImportExclusion === true}`
            : "";
      const del = await this.lib.arr(
        service,
        "DELETE",
        `${this.objectPath(spec, id)}${query}`,
        `remove ${name} (approved plan)`,
      );
      if (!del.ok)
        return {
          ok: false,
          result: `${service.name} refused to remove ${name} (${del.status}${this.why(del.data)}).`,
        };
      verified = await this.gone(service, spec, id);
      result = verified
        ? `Removed ${name} from ${service.name}${p.deleteFiles === true ? " with its files" : ""}, verified: it is gone.`
        : `${service.name} accepted the removal, but ${name} is still there.`;
      return this.finish(step, service, what, verified, verified, result, {
        resource,
        id,
        deleteFiles: p.deleteFiles === true,
      });
    }

    // app-arr-edit
    const changes = parseJson(p.changes, "the changes");
    const before = parseJson(p.before, "the values before");
    const path = this.objectPath(spec, id);
    const current = await this.get(service, spec.singleton ? spec.path : path, `the ${spec.label}`);
    if (current) fillSizes(resource, current);
    if (!current)
      return {
        ok: false,
        stale: true,
        result: `${String(p.name)} is no longer in ${service.name}. Nothing was changed.`,
      };
    if (!spec.singleton && this.nameOf(spec, current, id) !== p.name)
      return {
        ok: false,
        stale: true,
        result: `${spec.label} #${id} is now "${this.nameOf(spec, current, id)}", not "${String(p.name)}" as approved. Nothing was changed; plan it again.`,
      };
    if (!unchanged(current, before))
      return {
        ok: false,
        stale: true,
        result: `${String(p.name)} changed in ${service.name} since this plan was made. Nothing was changed; plan it again.`,
      };
    const put = await this.lib.arr<Json>(
      service,
      "PUT",
      `${this.objectPath(spec, id, current)}${spec.putQuery ?? ""}`,
      `${opts.undo ? "put back" : "change"} ${String(p.name)} (approved plan)`,
      { body: applyChanges(current, changes) },
    );
    if (!put.ok)
      return {
        ok: false,
        result: `${service.name} refused the change (${put.status}${this.why(put.data)}). Nothing else was changed.`,
      };
    const after = await this.get(service, spec.singleton ? spec.path : path, `the ${spec.label}`);
    if (after) fillSizes(resource, after);
    verified = Boolean(after) && contains(beforeOf(after!, changes), changes);
    result = opts.undo
      ? `${String(p.name)} is back as it was in ${service.name}.`
      : verified
        ? `Changed ${step.change.settings.map((s) => s.name.replace(`${String(p.name)}: `, "")).join(", ")} on ${String(p.name)} in ${service.name}, verified by reading it back.`
        : `${service.name} accepted the change, but ${String(p.name)} does not read back as approved.`;
    detail = { resource, id, keys: Object.keys(changes) };
    return this.finish(step, service, what, verified, verified, result, detail);
  }

  /**
   * Adding a movie: Radarr's own lookup (TMDB through Radarr) gives the movie; the owner picks
   * the root folder, quality profile, monitoring, minimum availability, tags, and whether to search
   * now. Refused when the movie is already in Radarr, so a retried plan never adds it twice.
   */
  private async planMovie(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const want = parseJson(params?.body, "the movie to add (params.body)");
    const tmdbId = Number(want.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0)
      throw new ResourcePlanError("Say which movie (body.tmdbId).");
    const found = await this.get(
      service,
      `/api/v3/movie/lookup/tmdb?tmdbId=${tmdbId}`,
      "the movie",
    );
    if (!found?.title) throw new ResourcePlanError(`Radarr found no movie with TMDB id ${tmdbId}.`);
    const name = `${String(found.title)}${typeof found.year === "number" && found.year ? ` (${found.year})` : ""}`;
    const have =
      (
        await this.lib.arr<Json[]>(
          service,
          "GET",
          `/api/v3/movie?tmdbId=${tmdbId}`,
          "check the library (plan)",
        )
      ).data ?? [];
    if (have.length) throw new ResourcePlanError(`${name} is already in ${service.name}.`);
    const profileId = Number(want.qualityProfileId);
    const profile = await this.get(
      service,
      `/api/v3/qualityprofile/${profileId}`,
      "the quality profile",
    );
    if (!profile)
      throw new ResourcePlanError(
        `${service.name} has no quality profile #${String(want.qualityProfileId)}.`,
      );
    const roots =
      (await this.lib.arr<Json[]>(service, "GET", "/api/v3/rootfolder", "read root folders (plan)"))
        .data ?? [];
    const root = String(want.rootFolderPath ?? "");
    if (!roots.some((r) => r.path === root))
      throw new ResourcePlanError(
        `Say a root folder ${service.name} has (body.rootFolderPath): ${roots.map((r) => String(r.path)).join(", ")}.`,
      );
    const monitored = want.monitored !== false;
    const availability = ["announced", "inCinemas", "released"].includes(
      String(want.minimumAvailability),
    )
      ? String(want.minimumAvailability)
      : "released";
    const tags = Array.isArray(want.tags) ? want.tags.map(Number).filter(Number.isInteger) : [];
    const search = want.searchForMovie === true && monitored;
    const body: Json = {
      ...found,
      id: undefined,
      qualityProfileId: profileId,
      rootFolderPath: root,
      monitored,
      minimumAvailability: availability,
      tags,
      addOptions: { searchForMovie: search, monitor: monitored ? "movieOnly" : "none" },
    };
    delete body.id;
    const change: StepChange = {
      summary: `Add ${name} to ${service.name}${search ? " and search for it" : ""}`,
      settings: [
        { name: "Movie", before: "Not in Radarr", after: name },
        { name: "Folder", before: "(new)", after: `${root}/${String(found.folder ?? name)}` },
        { name: "Quality profile", before: "(new)", after: String(profile.name) },
        { name: "Monitored", before: "(new)", after: yes(monitored) },
        { name: "Minimum availability", before: "(new)", after: availability },
        { name: "Search now", before: "(new)", after: yes(search) },
      ],
    };
    return [change, { resource: "movie", body: JSON.stringify(body), name }];
  }

  /**
   * Quality sizes (MB per minute): whole or decimal numbers inside Radarr's own limits, minimum
   * not above preferred, preferred not above maximum. An empty maximum or preferred is no limit.
   */
  private async checkSizes(service: Service, current: Json, changes: Json) {
    const limits =
      (
        await this.lib.arr<Json>(
          service,
          "GET",
          `${this.base(service)}/qualitydefinition/limits`,
          "read size limits (plan)",
        )
      ).data ?? {};
    const lo = typeof limits.min === "number" ? limits.min : 0;
    const hi = typeof limits.max === "number" ? limits.max : 2000;
    for (const k of ["minSize", "maxSize", "preferredSize"]) {
      if (!(k in changes)) continue;
      const v = changes[k];
      if (v === null && k !== "minSize") continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi)
        throw new ResourcePlanError(
          `${this.label(k)} is a number from ${lo} to ${hi}${k === "minSize" ? "" : ", or empty for no limit"}.`,
        );
    }
    const next = { ...current, ...changes };
    const min = Number(next.minSize ?? 0);
    const max = next.maxSize == null ? Infinity : Number(next.maxSize);
    const pref = next.preferredSize == null ? max : Number(next.preferredSize);
    if (min > pref || pref > max)
      throw new ResourcePlanError(
        "The minimum must not be above the preferred size, nor the preferred above the maximum.",
      );
  }

  /** Excluding a movie from import lists, by its TMDB id; refused when it is already excluded. */
  private async planExclusion(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const want = parseJson(params?.body, "the movie to exclude (params.body)");
    const tmdbId = Number(want.tmdbId);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0)
      throw new ResourcePlanError("Say which movie (body.tmdbId).");
    const found = await this.get(
      service,
      `/api/v3/movie/lookup/tmdb?tmdbId=${tmdbId}`,
      "the movie",
    );
    if (!found?.title) throw new ResourcePlanError(`Radarr found no movie with TMDB id ${tmdbId}.`);
    const year = typeof found.year === "number" ? found.year : 0;
    const name = `${String(found.title)}${year ? ` (${year})` : ""}`;
    const all =
      (
        await this.lib.arr<Json[]>(
          service,
          "GET",
          "/api/v3/exclusions",
          "read import list exclusions (plan)",
        )
      ).data ?? [];
    if (all.some((o) => o.tmdbId === tmdbId))
      throw new ResourcePlanError(`${name} is already excluded.`);
    return [
      {
        summary: `Stop import lists adding ${name} to ${service.name}`,
        settings: [{ name: `${name}: import lists`, before: "May add it", after: "Excluded" }],
      },
      {
        resource: "exclusion",
        body: JSON.stringify({ tmdbId, movieTitle: found.title, movieYear: year }),
        name,
      },
    ];
  }

  /**
   * Manual import: files Radarr found in a folder, each matched to a movie in the library, moved or
   * copied in by Radarr itself. Only files Radarr lists for that folder can be named, and each
   * movie at most once, so a plan cannot reach anything else on disk.
   */
  private async planImport(
    service: Service,
    params: StepParams | undefined,
  ): Promise<[StepChange, StepParams]> {
    const folder = String(params?.folder ?? "").trim();
    if (!folder) throw new ResourcePlanError("Say which folder the files are in (params.folder).");
    const mode = params?.importMode === "copy" ? "copy" : "move";
    let files: Json[];
    try {
      const raw: unknown = JSON.parse(String(params?.files ?? "[]"));
      files = Array.isArray(raw) ? (raw as Json[]) : [];
    } catch {
      throw new ResourcePlanError(
        'Files go in params.files as JSON: [{"path": ..., "movieId": ...}].',
      );
    }
    if (files.length === 0 || files.length > 50)
      throw new ResourcePlanError("Choose from 1 to 50 files to import.");
    const found = await this.importCandidates(service, folder);
    const settings: StepChange["settings"] = [];
    const seen = new Set<number>();
    const chosen: { path: string; movieId: number }[] = [];
    for (const f of files) {
      const path = String(f.path ?? "");
      const movieId = Number(f.movieId);
      const c = found.find((x) => x.path === path);
      if (!c) throw new ResourcePlanError(`${service.name} does not list "${path}" in ${folder}.`);
      if (!Number.isInteger(movieId) || movieId <= 0)
        throw new ResourcePlanError(`Say which movie "${String(c.relativePath)}" is.`);
      if (seen.has(movieId)) throw new ResourcePlanError("Choose one file per movie.");
      seen.add(movieId);
      const m = await this.get(service, `/api/v3/movie/${movieId}`, "the movie");
      if (!m) throw new ResourcePlanError(`${service.name} has no movie #${movieId}.`);
      const name = this.nameOf(RESOURCES.movie!, m, movieId);
      const quality = String(
        ((c.quality as Json | undefined)?.quality as Json | undefined)?.name ?? "unknown quality",
      );
      const why = ((c.rejections as Json[]) ?? []).map((r) => String(r.reason)).filter(Boolean);
      settings.push({
        name: String(c.relativePath ?? path),
        before: `In ${folder}`,
        after: `${mode === "copy" ? "Copied" : "Moved"} into ${name} as ${quality}${
          m.hasFile ? ", replacing its current file" : ""
        }${why.length ? ` (Radarr noted: ${why.join("; ")})` : ""}`,
      });
      chosen.push({ path, movieId });
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

  private async importCandidates(service: Service, folder: string): Promise<Json[]> {
    const r = await this.lib.arr<Json[]>(
      service,
      "GET",
      `/api/v3/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=true`,
      "read the files in the folder",
    );
    if (!r.ok)
      throw new ResourcePlanError(`${service.name} could not read ${folder} (${r.status}).`);
    return r.data ?? [];
  }

  private async runImport(
    step: StepRun,
    service: Service,
    what: string,
    p: StepParams,
  ): Promise<StepOutcome> {
    const folder = String(p.folder);
    const chosen = JSON.parse(String(p.files)) as { path: string; movieId: number }[];
    const found = await this.importCandidates(service, folder);
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
        movieId: f.movieId,
        quality: c.quality,
        languages: c.languages ?? [],
        releaseGroup: c.releaseGroup ?? "",
        downloadId: c.downloadId ?? "",
        indexerFlags: c.indexerFlags ?? 0,
      });
    }
    const sent = await this.lib.arr<Json>(
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
        result: `${service.name} refused the import (${sent.status}${this.why(sent.data)}).`,
      };
    const cid = sent.data?.id;
    let status = String(sent.data?.status ?? "queued");
    for (
      let i = 0;
      i < 60 && status !== "completed" && status !== "failed" && cid !== undefined;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      const now = await this.lib.arr<Json>(
        service,
        "GET",
        `/api/v3/command/${String(cid)}`,
        "check the import",
      );
      status = String(now.data?.status ?? status);
    }
    const missing: string[] = [];
    for (const f of chosen) {
      const m = await this.get(service, `/api/v3/movie/${f.movieId}`, "the movie");
      const name = f.path.split("/").pop() ?? f.path;
      const file = m?.movieFile as Json | undefined;
      // Imported means the movie now has a file that came from this one (Radarr may rename it).
      const fromIt =
        Boolean(m?.hasFile) &&
        (!file?.originalFilePath || String(file.originalFilePath).endsWith(name));
      if (!fromIt) missing.push(this.nameOf(RESOURCES.movie!, m, f.movieId));
    }
    const verified = status === "completed" && missing.length === 0;
    const result = verified
      ? `Imported ${chosen.length === 1 ? "the file" : `${chosen.length} files`} into ${service.name}, verified: each movie has its file.`
      : status === "failed"
        ? `${service.name} could not import the files. See its log in System.`
        : missing.length
          ? `${service.name} ran the import, but ${missing.join(", ")} still ${missing.length === 1 ? "has" : "have"} no file from it.`
          : `${service.name} started the import; it was still running after two minutes (${status}).`;
    return this.finish(step, service, what, verified || status !== "failed", verified, result, {
      command: "ManualImport",
      status,
      files: chosen.length,
      mode: String(p.importMode),
    });
  }

  /** Puts an edit back to the values before it; added, removed and run things cannot be. */
  async undo(step: StepRun, app: App, service: Service): Promise<StepOutcome | undefined> {
    if (step.kind === "app-crucible-apply" && step.params?.before)
      return this.run(step, app, service, { undo: true });
    if (step.kind !== "app-arr-edit" || !step.params?.before || !step.params.changes)
      return undefined;
    return this.run(
      {
        ...step,
        params: { ...step.params, changes: step.params.before, before: step.params.changes },
      },
      app,
      service,
      { undo: true },
    );
  }

  /** Radarr calls for the Crucible's Save, through the broker like every other step. */
  private crucibleArr(service: Service): Arr {
    return (method, path, purpose, body) =>
      this.lib.arr(service, method, path, purpose, body !== undefined ? { body } : {});
  }

  private why(data: unknown) {
    const first = Array.isArray(data) ? (data[0] as Json | undefined) : (data as Json | undefined);
    const msg = first?.errorMessage ?? first?.message;
    return typeof msg === "string" && msg ? `: ${msg.slice(0, 200)}` : "";
  }

  private async finish(
    step: StepRun,
    service: Service,
    what: string,
    ok: boolean,
    verified: boolean,
    result: string,
    detail: Json,
  ): Promise<StepOutcome> {
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${what} (approved plan)`,
      target: `service:${service.id}`,
      detail: { ...detail, verified },
    });
    if (ok && this.memory)
      await this.memory
        .recordSystem(this.handle.db, {
          title: what,
          body: `${result.slice(0, 400)} Approved as a step of a plan.`,
          happenedAt: new Date().toISOString(),
          links: [{ label: service.name, ref: `service:${service.id}` }],
        })
        .catch(() => undefined);
    return { ok, result, verified };
  }
}
