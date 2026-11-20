import {
  choicesOf,
  FOLDER_CHOICES,
  NAME_CHOICES,
  pathMatches,
  previewPath,
  zonesThatFit,
  templateProblem,
  type StepParams,
  type TemplateSample,
} from "@dragon-control/core";
import type { PlannedStep, StepOutcome } from "../jobs/operations";
import { AppUnreachableError, type Fetch } from "./http";
import { IMMICH_ASSET, immichCall } from "./immich";

/**
 * Files and folders: Immich's storage template, the only supported way to choose how Immich names
 * and files photos on disk. Hearth reads it, previews it on a few real photos, and changes it only
 * through an approved plan (the pattern before and after); a second step starts Immich's own
 * storage template job, which moves and renames the files to match. Hearth never moves a file
 * itself, and photos in an external library are never moved (Immich leaves them where they are).
 */

export const FILE_OPS = ["storage-template", "storage-migrate"] as const;
export const MIGRATION_QUEUE = "storageTemplateMigration";

type C = { fetchImpl: Fetch; base: string; key: string; service: { name: string } };
const call = <T>(c: C, method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown) =>
  immichCall<T>(c.fetchImpl, c.base, c.key, method, path, body);

type Config = { storageTemplate?: { enabled?: boolean; template?: string } } & Record<
  string,
  unknown
>;

export interface StorageSetting {
  /** False when this key cannot read Immich's settings. */
  known: boolean;
  enabled?: boolean;
  template?: string;
  /** This key may change Immich's settings (an administrator's key with that permission). */
  canChange: boolean;
  /** Why it cannot, in plain words. */
  why?: string;
}

/** Reads the storage template, and whether this key may change it. */
export async function readStorage(c: C): Promise<StorageSetting> {
  const cfg = await call<Config>(c, "GET", "/system-config").catch(() => undefined);
  const st = cfg?.ok ? cfg.data?.storageTemplate : undefined;
  const me = await call<{ isAdmin?: boolean }>(c, "GET", "/users/me").catch(() => undefined);
  const keyInfo = await call<{ permissions?: string[] }>(c, "GET", "/api-keys/me").catch(
    () => undefined,
  );
  const perms = keyInfo?.ok ? (keyInfo.data?.permissions ?? []) : [];
  const allowed = perms.includes("all") || perms.includes("systemConfig.update");
  const admin = Boolean(me?.ok && me.data?.isAdmin);
  const why = !admin
    ? `This key's user is not an administrator in ${c.service.name}, and only an administrator can change how files are named.`
    : !keyInfo?.ok
      ? undefined
      : !allowed
        ? `This key does not have the "systemConfig.update" permission. Make a key in ${c.service.name} with it (or with all permissions) and paste it in this panel.`
        : undefined;
  if (!st)
    return {
      known: false,
      canChange: false,
      why: why ?? `${c.service.name} would not share its storage settings with this key.`,
    };
  return {
    known: true,
    enabled: Boolean(st.enabled),
    template: st.template ?? "",
    canChange: admin && (allowed || !keyInfo?.ok),
    ...(why ? { why } : {}),
  };
}

/** A few recent photos with what the preview needs, and where each file is now. */
export async function storageSamples(c: C, count = 4) {
  const r = await call<{
    assets?: {
      items?: {
        id?: string;
        originalFileName?: string;
        fileCreatedAt?: string;
        ownerId?: string;
        originalPath?: string;
        isExternal?: boolean;
        libraryId?: string | null;
        type?: string;
      }[];
    };
  }>(c, "POST", "/search/metadata", {
    visibility: "timeline",
    order: "desc",
    size: count,
    page: 1,
    withDeleted: false,
  });
  if (!r.ok)
    throw new AppUnreachableError(`${c.service.name} answered ${r.status} for its photos.`);
  const me = await call<{ id?: string; storageLabel?: string | null }>(c, "GET", "/users/me");
  const items = (r.data?.assets?.items ?? []).filter((a) => a.id && IMMICH_ASSET.test(a.id));
  return Promise.all(
    items.slice(0, count).map(async (a) => {
      const albums = await call<{ albumName?: string }[]>(
        c,
        "GET",
        `/albums?assetId=${encodeURIComponent(a.id!)}`,
      ).catch(() => undefined);
      const owner =
        a.ownerId && a.ownerId === me.data?.id
          ? me.data?.storageLabel || a.ownerId
          : (a.ownerId ?? "");
      const album =
        albums?.ok && Array.isArray(albums.data) ? albums.data[0]?.albumName : undefined;
      return {
        id: a.id!,
        name: a.originalFileName ?? "photo",
        takenAt: a.fileCreatedAt ?? new Date(0).toISOString(),
        owner,
        ...(album ? { album } : {}),
        ...(a.type === "VIDEO" ? { video: true } : {}),
        // Where the file is now, from Immich's media folder ("library/...", "upload/...").
        path: (a.originalPath ?? "").replace(/^.*?\/(library|upload|external)\//, "$1/"),
        external: Boolean(a.isExternal || a.libraryId),
      };
    }),
  );
}

/** Immich's storage template job: running, waiting, failed. */
export async function migrationState(c: C) {
  const r = await call<
    { name?: string; statistics?: Record<string, number>; isPaused?: boolean }[]
  >(c, "GET", "/queues").catch(() => undefined);
  const q =
    r?.ok && Array.isArray(r.data) ? r.data.find((x) => x.name === MIGRATION_QUEUE) : undefined;
  const s = q?.statistics ?? {};
  return {
    known: Boolean(q),
    active: s.active ?? 0,
    waiting: (s.waiting ?? 0) + (s.delayed ?? 0),
    failed: s.failed ?? 0,
    paused: Boolean(q?.isPaused),
  };
}

/**
 * Everything the Files and folders tab shows: the setting, a few photos with where they are and
 * where the pattern puts them (and, when the job is idle and the pattern is on, whether Immich put
 * them there), and the job's progress.
 */
export async function filesStatus(c: C) {
  const [storage, samples, migration] = await Promise.all([
    readStorage(c),
    storageSamples(c),
    migrationState(c),
  ]);
  const idle = migration.active === 0 && migration.waiting === 0;
  const usable = Boolean(storage.known && storage.template && !templateProblem(storage.template));
  // Immich's time zone, learnt from where it already filed these photos by its dated pattern
  // (its API does not say). Undefined: nothing tells yet, so the preview uses UTC, its default.
  const zones =
    usable && storage.enabled
      ? zonesThatFit(
          storage.template!,
          samples.filter((x) => !x.external),
        )
      : undefined;
  return {
    storage,
    migration,
    // The zones that fit (UTC first when it does); unknown: UTC, Immich's default.
    zone: zones ? { known: true, zones } : { known: false, zones: ["UTC"] },
    samples: samples.map((s) => {
      const expected = usable
        ? previewPath(storage.template!, s as TemplateSample, zones?.[0] ?? "UTC")
        : undefined;
      return {
        ...s,
        ...(expected ? { expected } : {}),
        // The spot check, once the job has run with the pattern on: the photo is where the pattern
        // puts it, in the time zone the other filed photos show (UTC when none tells yet).
        ...(storage.enabled && idle && expected && !s.external
          ? { inPlace: pathMatches(s.path, expected) }
          : {}),
      };
    }),
  };
}

/** A pattern in plain words, when it is one Hearth builds ("By album; date, then the original name"). */
const inWords = (s: { enabled?: boolean; template?: string }) => {
  if (!s.enabled) return "off";
  const ch = choicesOf(s.template ?? "");
  if (!ch) return "a pattern of its own";
  const f = FOLDER_CHOICES.find((x) => x.value === ch.folder)!.label;
  const n = NAME_CHOICES.find((x) => x.value === ch.name)!.label.toLowerCase();
  return `${f}; ${n}`;
};

const describe = (s: { enabled?: boolean; template?: string }) =>
  s.enabled
    ? (s.template ?? "")
    : `off (Immich keeps its own layout${s.template ? `; saved pattern ${s.template}` : ""})`;

/** Plans a new storage template (or turning it on or off). */
export async function planStorage(
  c: C,
  params: StepParams | undefined,
  base: PlannedStep,
): Promise<PlannedStep> {
  let want: { enabled?: unknown; template?: unknown };
  try {
    want = JSON.parse(String(params?.body ?? "{}")) as typeof want;
  } catch {
    throw new Error("Say the pattern as JSON: {enabled, template}.");
  }
  const enabled = want.enabled === true;
  const now = await readStorage(c);
  if (!now.known)
    throw new Error(now.why ?? `${c.service.name} would not share its storage settings.`);
  if (!now.canChange) throw new Error(now.why ?? "This key cannot change Immich's settings.");
  const template = typeof want.template === "string" ? want.template.trim() : (now.template ?? "");
  const problem = templateProblem(template);
  if (problem) throw new Error(problem);
  if (now.enabled === enabled && now.template === template)
    throw new Error("Nothing would change: Immich already uses this.");
  const before = { enabled: Boolean(now.enabled), template: now.template ?? "" };
  return {
    ...base,
    label: enabled
      ? `Name and file every photo in ${c.service.name} by a new pattern (the whole library; external libraries stay where they are)`
      : `Turn off ${c.service.name}'s storage template (files stay where they are now)`,
    serviceName: c.service.name,
    params: {
      op: "storage-template",
      body: JSON.stringify({ enabled, template, before }),
    },
    change: {
      summary: `${c.service.name}'s files and folders`,
      settings: [
        { name: "In words", before: inWords(before), after: inWords({ enabled, template }) },
        {
          name: "Storage template",
          before: describe(before),
          after: describe({ enabled, template }),
        },
      ],
    },
  };
}

const parseBody = (p: StepParams) =>
  JSON.parse(String(p.body ?? "{}")) as {
    enabled: boolean;
    template: string;
    before: { enabled: boolean; template: string };
  };

/** Saves the pattern into Immich's settings, leaving every other setting as it is. */
async function writeStorage(c: C, to: { enabled: boolean; template: string }) {
  const cfg = await call<Config>(c, "GET", "/system-config");
  if (!cfg.ok || !cfg.data?.storageTemplate)
    return {
      ok: false as const,
      why: `${c.service.name} would not share its settings (${cfg.status}).`,
    };
  const next = { ...cfg.data, storageTemplate: { ...cfg.data.storageTemplate, ...to } };
  const put = await call<unknown>(c, "PUT", "/system-config", next);
  if (!put.ok)
    return {
      ok: false as const,
      why: `${c.service.name} refused the pattern (${put.status}${put.data && typeof put.data === "object" && "message" in put.data ? `: ${String((put.data as { message: unknown }).message)}` : ""}).`,
    };
  const back = await readStorage(c);
  return back.enabled === to.enabled && back.template === to.template
    ? { ok: true as const }
    : {
        ok: false as const,
        why: `${c.service.name} answered, but its setting does not read back as approved.`,
      };
}

export async function runStorage(c: C, p: StepParams): Promise<StepOutcome> {
  const want = parseBody(p);
  const now = await readStorage(c);
  // Someone changed it in Immich since this was planned: nothing is changed.
  if (now.enabled !== want.before.enabled || (now.template ?? "") !== want.before.template)
    return {
      ok: false,
      stale: true,
      result: `${c.service.name}'s storage template was changed since this was planned; nothing was changed.`,
    };
  const w = await writeStorage(c, { enabled: want.enabled, template: want.template });
  if (!w.ok) return { ok: false, result: w.why };
  return {
    ok: true,
    verified: true,
    result: want.enabled
      ? `${c.service.name} now names and files photos by ${want.template} (read back). Files move when its storage template job runs.`
      : `${c.service.name}'s storage template is off (read back). Files stay where they are.`,
  };
}

/** Puts the pattern back as it was, when a later step of the same plan failed. */
export async function undoStorage(c: C, p: StepParams): Promise<StepOutcome> {
  const want = parseBody(p);
  const w = await writeStorage(c, want.before);
  return w.ok
    ? { ok: true, result: `${c.service.name}'s storage template is back as it was.` }
    : { ok: false, result: w.why };
}

export function planMigrate(c: C, base: PlannedStep): PlannedStep {
  return {
    ...base,
    label: `Run ${c.service.name}'s storage template job: it moves and renames the files to match (Immich keeps track of every file)`,
    serviceName: c.service.name,
    params: { op: "storage-migrate" },
    change: {
      summary: `Move files to match`,
      settings: [
        {
          name: "Files on disk",
          before: "where they are now",
          after: "moved and renamed by Immich; external libraries stay",
        },
      ],
    },
  };
}

export async function runMigrate(c: C): Promise<StepOutcome> {
  const st = await readStorage(c);
  if (!st.enabled)
    return {
      ok: false,
      result: `${c.service.name}'s storage template is off, so there is nothing to move.`,
    };
  const r = await call<unknown>(c, "PUT", `/jobs/${MIGRATION_QUEUE}`, {
    command: "start",
    force: false,
  });
  if (!r.ok)
    return { ok: false, result: `${c.service.name} would not start the job (${r.status}).` };
  return {
    ok: true,
    result: `${c.service.name} started moving and renaming files. Files and folders shows its progress, then checks a few photos are where the pattern says.`,
  };
}
