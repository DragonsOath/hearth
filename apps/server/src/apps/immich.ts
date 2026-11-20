import type {
  AppIssue,
  AppReport,
  ImmichDashboard,
  ImmichPhoto,
  ImmichPhotoPage,
  StepParams,
} from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";
import {
  ALBUM_OPS,
  EDIT_OPS,
  planAlbum,
  planEdit,
  runAlbum,
  runEdit,
  undoOrganize,
} from "./immich-organize";
import {
  FILE_OPS,
  planMigrate,
  planStorage,
  runMigrate,
  runStorage,
  undoStorage,
} from "./immich-files";

/**
 * Immich (v3 API), with an API key an administrator creates in Immich and pastes once: Immich
 * stores its keys in its database. The health read, the panel (photos and videos, storage, use
 * per person, job queues with failures), and the controls: pause or resume a queue, process what
 * is missing in a queue, clear a queue's failed jobs (the photos stay), and back up the database.
 * Immich's integrity "delete all" jobs remove files and are left out on purpose. The Overview also
 * shows the newest photos on the timeline; their thumbnails come through Hearth (immichThumbnail),
 * so the key never reaches the browser.
 */

type Method = "GET" | "PUT" | "POST" | "DELETE";

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
    res = await fetchImpl(joinUrl(base, `/api${path}`), {
      method,
      headers: {
        "x-api-key": key,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(`Immich did not answer at ${base}: ${why}`);
  }
  if (res.status === 401)
    throw new AppKeyError(
      "Immich refused the API key. Create one in Immich and paste it in its panel.",
    );
  if (res.status === 403)
    throw new AppKeyError(
      "Immich's key is missing a permission, or its user is not an administrator. Create a key with all permissions as an administrator.",
    );
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

/** One call to Immich's API with its key (organizing and edits use it too). */
export const immichCall = call;

async function get<T>(fetchImpl: Fetch, base: string, key: string, path: string): Promise<T> {
  const r = await call<T>(fetchImpl, base, key, "GET", path);
  if (!r.ok) throw new AppUnreachableError(`Immich answered ${r.status} for ${path}.`);
  return r.data;
}

/** An Immich asset id (a UUID), the only thing a thumbnail request may name. */
export const IMMICH_ASSET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How many recent photos the Overview shows. */
export const RECENT_PHOTOS = 20;

interface RawAsset {
  id?: string;
  originalFileName?: string;
  fileCreatedAt?: string;
  isFavorite?: boolean;
  visibility?: string;
  isTrashed?: boolean;
  updatedAt?: string;
}

const photoOf = (a: RawAsset): ImmichPhoto => ({
  id: a.id!,
  name: a.originalFileName ?? "Photo",
  ...(a.fileCreatedAt ? { takenAt: a.fileCreatedAt } : {}),
  ...(a.isFavorite ? { favorite: true } : {}),
  ...(a.updatedAt ? { version: String(Date.parse(a.updatedAt) || "").slice(0, 16) } : {}),
});
/** Only the main timeline: archived, hidden, locked (private folder) and deleted photos never show. */
const onTimeline = (a: RawAsset) =>
  Boolean(a.id && IMMICH_ASSET.test(a.id)) &&
  !a.isTrashed &&
  (a.visibility === undefined || a.visibility === "timeline");

/** A page of photos on the timeline, newest taken first (the Photos tab, and Recent photos). */
export async function immichPhotos(
  fetchImpl: Fetch,
  base: string,
  key: string,
  page = 1,
  size = 60,
  /** Only this album's photos (an album tab). */
  albumId?: string,
): Promise<ImmichPhotoPage> {
  const r = await call<{ assets?: { items?: RawAsset[]; nextPage?: string | null } }>(
    fetchImpl,
    base,
    key,
    "POST",
    "/search/metadata",
    {
      type: "IMAGE",
      visibility: "timeline",
      order: "desc",
      size,
      page,
      withDeleted: false,
      ...(albumId && IMMICH_ASSET.test(albumId) ? { albumIds: [albumId] } : {}),
    },
  );
  if (!r.ok) throw new AppUnreachableError(`Immich answered ${r.status} for its photos.`);
  const next = Number(r.data?.assets?.nextPage);
  return {
    items: (r.data?.assets?.items ?? []).filter(onTimeline).slice(0, size).map(photoOf),
    ...(Number.isInteger(next) && next > page ? { next } : {}),
  };
}

/** The newest photos on the timeline, newest taken first, for the Overview. */
export async function immichRecent(
  fetchImpl: Fetch,
  base: string,
  key: string,
  size = RECENT_PHOTOS,
): Promise<ImmichPhoto[]> {
  return (await immichPhotos(fetchImpl, base, key, 1, size)).items;
}

/** Image types a thumbnail may be: never SVG or HTML, which could run in Hearth's page. */
const PICTURE = /^image\/(jpeg|webp|png|avif)$/;

/**
 * One photo's picture from Immich with its key: the small thumbnail, or the larger preview the
 * full view shows (Immich's own resized copy, never the original file).
 */
export async function immichThumbnail(
  fetchImpl: Fetch,
  base: string,
  key: string,
  assetId: string,
  size: "thumbnail" | "preview" = "thumbnail",
  /** As edited in Immich (2.5 and later); false shows it as taken (the editor's starting point). */
  edited = true,
): Promise<{ bytes: Buffer; type: string } | undefined> {
  if (!IMMICH_ASSET.test(assetId)) return undefined;
  const get = (withEdits: boolean) =>
    fetchImpl(
      joinUrl(
        base,
        `/api/assets/${assetId}/thumbnail?size=${size}${withEdits ? "&edited=true" : ""}`,
      ),
      {
        method: "GET",
        headers: { "x-api-key": key, Accept: "image/webp,image/jpeg,image/*" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    ).catch(() => undefined);
  let res = await get(edited);
  // An Immich older than 2.5 does not know "edited": ask again without it.
  if (edited && res?.status === 400) res = await get(false);
  const type = (res?.headers?.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!res?.ok || !res.arrayBuffer || !PICTURE.test(type)) return undefined;
  const bytes = Buffer.from(await res.arrayBuffer());
  return bytes.length <= (size === "preview" ? 12 : 2) * 1024 * 1024 ? { bytes, type } : undefined;
}

/** Immich's queue names in plain words. */
export const QUEUE_WORDS: Record<string, string> = {
  thumbnailGeneration: "Thumbnails",
  metadataExtraction: "Reading photo details",
  videoConversion: "Video conversion",
  faceDetection: "Finding faces",
  facialRecognition: "Recognising people",
  smartSearch: "Smart search",
  duplicateDetection: "Finding duplicates",
  backgroundTask: "Background tasks",
  storageTemplateMigration: "Storage layout",
  migration: "Migration",
  search: "Search index",
  sidecar: "Sidecar files",
  library: "External libraries",
  notifications: "Notifications",
  backupDatabase: "Database backup",
  ocr: "Text in photos",
  workflow: "Workflows",
  integrityCheck: "Integrity checks",
  editor: "Editing",
};
/** Queues where "process what is missing" means something (the legacy start command). */
const RUNNABLE = new Set([
  "thumbnailGeneration",
  "metadataExtraction",
  "videoConversion",
  "faceDetection",
  "facialRecognition",
  "smartSearch",
  "duplicateDetection",
  "sidecar",
  "ocr",
]);

interface Queue {
  name: string;
  isPaused?: boolean;
  statistics?: {
    active?: number;
    completed?: number;
    failed?: number;
    delayed?: number;
    waiting?: number;
    paused?: number;
  };
}

export async function immichDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<ImmichDashboard> {
  const g = <T>(path: string) => get<T>(fetchImpl, base, key, path);
  const [about, stats, storage, queues, recent] = await Promise.all([
    g<{ version?: string }>("/server/about").catch(() => ({}) as { version?: string }),
    g<{
      photos?: number;
      videos?: number;
      usage?: number;
      usageByUser?: {
        userName?: string;
        photos?: number;
        videos?: number;
        usage?: number;
        quotaSizeInBytes?: number | null;
      }[];
    }>("/server/statistics"),
    g<{
      diskSize?: string;
      diskUse?: string;
      diskAvailable?: string;
      diskUsagePercentage?: number;
    }>("/server/storage"),
    g<Queue[]>("/queues"),
    // The panel still works without them (an older Immich, or a key that cannot see photos).
    immichRecent(fetchImpl, base, key).catch(() => undefined),
  ]);
  const gb = (b?: number) => Math.round(((b ?? 0) / 1024 ** 3) * 10) / 10;
  return {
    app: "immich",
    ...(about.version ? { version: about.version.replace(/^v/, "") } : {}),
    photos: stats.photos ?? 0,
    videos: stats.videos ?? 0,
    usageGb: gb(stats.usage),
    disk: {
      used: storage.diskUse ?? "?",
      size: storage.diskSize ?? "?",
      free: storage.diskAvailable ?? "?",
      pct: Math.round(storage.diskUsagePercentage ?? 0),
    },
    people: (stats.usageByUser ?? [])
      .map((u) => ({
        name: u.userName ?? "Someone",
        photos: u.photos ?? 0,
        videos: u.videos ?? 0,
        usageGb: gb(u.usage),
        ...(u.quotaSizeInBytes ? { quotaGb: gb(u.quotaSizeInBytes) } : {}),
      }))
      .sort((a, b) => b.usageGb - a.usageGb),
    queues: queues
      .map((q) => {
        const s = q.statistics ?? {};
        return {
          name: q.name,
          label: QUEUE_WORDS[q.name] ?? q.name,
          paused: Boolean(q.isPaused),
          active: s.active ?? 0,
          waiting: (s.waiting ?? 0) + (s.delayed ?? 0) + (s.paused ?? 0),
          failed: s.failed ?? 0,
          runnable: RUNNABLE.has(q.name),
        };
      })
      .sort(
        (a, b) =>
          b.failed - a.failed ||
          b.active + b.waiting - (a.active + a.waiting) ||
          a.label.localeCompare(b.label),
      ),
    ...(recent ? { recent } : {}),
  };
}

/** The background health read. */
export async function readImmich(
  base: string,
  key: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await immichDashboard(fetchImpl, base, key);
  const issues: AppIssue[] = [
    ...d.queues
      .filter((q) => q.failed > 0)
      .map((q) => ({
        level: "warning" as const,
        key: `queue:${q.name}`,
        text: `Immich's ${q.label.toLowerCase()} queue has ${q.failed} failed jobs.`,
      })),
    ...(d.disk.pct >= 90
      ? [
          {
            level: "error" as const,
            key: "disk",
            text: `Immich's storage is ${d.disk.pct}% full (${d.disk.free} free).`,
          },
        ]
      : []),
  ];
  return {
    app: "immich",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Photos, videos", value: `${d.photos}, ${d.videos}` },
      { label: "Storage", value: `${d.disk.used} of ${d.disk.size} (${d.disk.pct}%)` },
      {
        label: "Working on",
        value: String(d.queues.reduce((n, q) => n + q.active + q.waiting, 0)),
      },
    ],
  };
}

export const IMMICH_OPS = [
  "pause-queue",
  "resume-queue",
  "run-missing",
  "clear-failed",
  "backup-database",
  "share-link",
  ...ALBUM_OPS,
  ...EDIT_OPS,
  ...FILE_OPS,
] as const;
/** How long a shared link works, in days; 0 = until it is removed in Immich. */
export const SHARE_DAYS = [1, 7, 30, 0];
type Op = (typeof IMMICH_OPS)[number];

export class ImmichOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
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
    if (!IMMICH_OPS.includes(op)) throw new Error(`Say what to do: ${IMMICH_OPS.join(", ")}.`);
    if (op === "share-link") return this.planShare(service, params, base);
    if ((FILE_OPS as readonly string[]).includes(op))
      return this.use(service, "plan Immich's files and folders", "read", (key) => {
        const c = { fetchImpl: this.fetchImpl, base: service.localUrl, key, service };
        return op === "storage-template"
          ? planStorage(c, params, base)
          : Promise.resolve(planMigrate(c, base));
      });
    if (
      (ALBUM_OPS as readonly string[]).includes(op) ||
      (EDIT_OPS as readonly string[]).includes(op)
    )
      return this.use(service, "plan organizing photos in Immich", "read", (key) => {
        const c = { fetchImpl: this.fetchImpl, base: service.localUrl, key, service };
        return (ALBUM_OPS as readonly string[]).includes(op)
          ? planAlbum(c, op as (typeof ALBUM_OPS)[number], params, base)
          : planEdit(c, op as (typeof EDIT_OPS)[number], params, base);
      });
    const d = await this.use(service, "read Immich", "read", (k) =>
      immichDashboard(this.fetchImpl, service.localUrl, k),
    );
    let label: string;
    let q: ImmichDashboard["queues"][number] | undefined;
    if (op === "backup-database") label = `Back up ${service.name}'s database now`;
    else {
      q = d.queues.find((x) => x.name === params?.queue);
      if (!q) throw new Error("Immich does not have that queue.");
      if (op === "pause-queue" && q.paused) throw new Error(`${q.label} is already paused.`);
      if (op === "resume-queue" && !q.paused) throw new Error(`${q.label} is not paused.`);
      if (op === "run-missing" && !q.runnable)
        throw new Error(`${q.label} has nothing to start by hand.`);
      if (op === "clear-failed" && !q.failed) throw new Error(`${q.label} has no failed jobs.`);
      const words: Record<string, string> = {
        "pause-queue": `Pause ${q.label} in ${service.name} (waiting work stays queued)`,
        "resume-queue": `Resume ${q.label} in ${service.name}`,
        "run-missing": `Run ${q.label} in ${service.name} for photos and videos it has not processed yet`,
        "clear-failed": `Clear ${q.failed} failed ${q.label.toLowerCase()} jobs in ${service.name} (the photos stay)`,
      };
      label = words[op] ?? op;
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, ...(q ? { queue: q.name, name: q.label } : { name: "the database" }) },
      change: {
        summary: label,
        settings: [
          {
            name: q?.label ?? "Database",
            before: q ? (q.paused ? "paused" : "running") : "as it is",
            after: op,
          },
        ],
      },
    };
  }

  /** A link anyone can open to one photo: planned from the photo as Immich has it now. */
  private async planShare(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const id = String(params?.assetId ?? "");
    if (!IMMICH_ASSET.test(id)) throw new Error("Say which photo to share (its Immich id).");
    const days = params?.expiresDays === undefined ? 7 : Number(params.expiresDays);
    if (!SHARE_DAYS.includes(days))
      throw new Error("A shared link works for 1, 7 or 30 days, or until removed (0).");
    const a = await this.use(service, "read a photo to share", "read", async (k) => {
      const r = await call<RawAsset>(this.fetchImpl, service.localUrl, k, "GET", `/assets/${id}`);
      return r.ok ? r.data : undefined;
    });
    // Private photos are never shared from Hearth, even by id.
    if (!a || !onTimeline({ ...a, id }))
      throw new Error("Immich has no such photo on its timeline.");
    const name = a.originalFileName ?? "the photo";
    const lasts = days
      ? `for ${days} day${days === 1 ? "" : "s"}`
      : "until you remove it in Immich";
    const label = `Make a link anyone can open to ${name} in ${service.name} (it works ${lasts})`;
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op: "share-link", assetId: id, expiresDays: days, name },
      change: {
        summary: label,
        settings: [
          {
            name: `Who can see ${name}`,
            before: "people with an Immich account",
            after: "anyone with the link",
          },
          { name: "The link works", before: "no link", after: lasts },
        ],
      },
    };
  }

  /** Makes the shared link, reads it back, and reports it (at Immich's public address). */
  private async runShare(
    step: StepRun,
    service: { id: string; name: string; localUrl: string; publicUrl?: string | null },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const id = String(p.assetId);
    const days = Number(p.expiresDays ?? 7);
    const name = String(p.name ?? "the photo");
    const outcome = await this.use(service, "share a photo from Immich", "change", async (key) => {
      const base = service.localUrl;
      const c = <T>(method: Method, path: string, body?: unknown) =>
        call<T>(this.fetchImpl, base, key, method, path, body);
      const made = await c<{ id?: string; key?: string }>("POST", "/shared-links", {
        type: "INDIVIDUAL",
        assetIds: [id],
        allowDownload: true,
        allowUpload: false,
        showMetadata: false,
        ...(days ? { expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() } : {}),
      });
      if (!made.ok || !made.data?.id || !made.data.key)
        return { ok: false, result: `Immich did not make the link (${made.status}).` };
      const back = await c<{ key?: string; assets?: { id?: string }[] }>(
        "GET",
        `/shared-links/${made.data.id}`,
      );
      const verified =
        back.ok &&
        back.data?.key === made.data.key &&
        (back.data.assets ?? []).some((x) => x.id === id);
      // The address people outside can open: Immich's own setting, else the one Hearth knows.
      const config = await c<{ externalDomain?: string }>("GET", "/server/config");
      const at = (config.data?.externalDomain || service.publicUrl || base).replace(/\/+$/, "");
      const url = `${at}/share/${made.data.key}`;
      const local = !config.data?.externalDomain && !service.publicUrl;
      return verified
        ? {
            ok: true,
            verified: true,
            result: `Made a link to ${name}. Send this link: ${url}${local ? " (Immich's local address: friends outside your network cannot open it until Immich or Hearth knows its public address)" : ""}`,
          }
        : { ok: false, result: "Immich answered, but the new link does not read back." };
    });
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `Shared ${name} from ${service.name} with a link`,
      target: `service:${service.id}`,
      detail: { op: "share-link", days, ok: outcome.ok },
    });
    return outcome;
  }

  /** Puts an album or edit step back when a later step of the same plan failed. */
  async undo(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op);
    if (op === "storage-template")
      return this.use(service, "put Immich's storage template back", "change", (key) =>
        undoStorage({ fetchImpl: this.fetchImpl, base: service.localUrl, key, service }, p),
      );
    if (!["album-add", "album-create", "edit", "edit-reset"].includes(op)) return undefined;
    return this.use(service, "undo organizing photos in Immich", "change", (key) =>
      undoOrganize({ fetchImpl: this.fetchImpl, base: service.localUrl, key, service }, p),
    );
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string; publicUrl?: string | null },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    if (op === "share-link") return this.runShare(step, service);
    if ((FILE_OPS as readonly string[]).includes(op)) {
      const out = await this.use(service, "change Immich's files and folders", "change", (key) => {
        const c = { fetchImpl: this.fetchImpl, base: service.localUrl, key, service };
        return op === "storage-template" ? runStorage(c, p) : runMigrate(c);
      });
      await recordAudit(this.handle.db, {
        actor: step.requestedBy,
        action: `${step.change?.summary ?? op} in ${service.name}`,
        target: `service:${service.id}`,
        // The pattern before and after, so it can be put back by hand too.
        detail: { op, ok: out.ok, change: p.body ?? null },
      });
      return out;
    }
    if (
      (ALBUM_OPS as readonly string[]).includes(op) ||
      (EDIT_OPS as readonly string[]).includes(op)
    ) {
      const out = await this.use(service, "organize photos in Immich", "change", (key) => {
        const c = { fetchImpl: this.fetchImpl, base: service.localUrl, key, service };
        return (ALBUM_OPS as readonly string[]).includes(op) ? runAlbum(c, p) : runEdit(c, p);
      });
      await recordAudit(this.handle.db, {
        actor: step.requestedBy,
        action: `${step.change?.summary ?? op} in ${service.name}`,
        target: `service:${service.id}`,
        // Which photos, for recovery: the album step's ids, or the photo's edits before.
        detail: {
          op,
          ok: out.ok,
          photos: String(p.body ?? p.assetId ?? "").split(",").length,
          before: p.before ?? null,
        },
      });
      return out;
    }

    const name = String(p.name || "it");
    const queue = encodeURIComponent(String(p.queue ?? ""));
    const outcome = await this.use(
      service,
      `${op} in Immich`,
      "change",
      async (key): Promise<StepOutcome> => {
        const base = service.localUrl;
        const c = (method: Method, path: string, body?: unknown) =>
          call<unknown>(this.fetchImpl, base, key, method, path, body);
        if (op === "backup-database") {
          const r = await c("POST", "/jobs", { name: "backup-database" });
          return r.ok
            ? {
                ok: true,
                result: "Immich started a database backup; it lands in its backups folder.",
              }
            : { ok: false, result: `Immich did not start the backup (${r.status}).` };
        }
        if (op === "pause-queue" || op === "resume-queue") {
          const r = await c("PUT", `/queues/${queue}`, { isPaused: op === "pause-queue" });
          if (!r.ok) return { ok: false, result: `Immich refused it (${r.status}).` };
          const d = await immichDashboard(this.fetchImpl, base, key);
          const now = d.queues.find((x) => x.name === p.queue)?.paused;
          return now === (op === "pause-queue")
            ? {
                ok: true,
                result: `${name} is ${now ? "paused" : "running again"}. Immich confirms it.`,
              }
            : { ok: false, result: `Immich answered, but ${name} does not show it yet.` };
        }
        // The legacy command endpoint is still how Immich v3 starts a queue or clears its failures.
        const r = await c("PUT", `/jobs/${queue}`, {
          command: op === "run-missing" ? "start" : "clear-failed",
          force: false,
        });
        if (!r.ok) return { ok: false, result: `Immich refused it (${r.status}).` };
        if (op === "run-missing")
          return { ok: true, result: `Immich queued ${name} for everything not processed yet.` };
        const d = await immichDashboard(this.fetchImpl, base, key);
        const left = d.queues.find((x) => x.name === p.queue)?.failed ?? 0;
        return left === 0
          ? { ok: true, result: `${name}'s failed jobs are cleared. Immich confirms it.` }
          : { ok: false, result: `Immich answered, but ${name} still shows ${left} failed jobs.` };
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
}
