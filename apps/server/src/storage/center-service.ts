import { gte } from "drizzle-orm";
import type {
  ArrDashboard,
  Blocker,
  PhysicalDisk,
  PlexDashboard,
  QbittorrentDashboard,
  RaidReport,
  SabnzbdDashboard,
  SmartReport,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { appOf, type AppWatcher } from "../apps/service";
import type { Findings } from "../findings/store";
import type { ContainerTools } from "../actions/tools";
import { containerOf } from "../admin/scope";
import { hostPathOf, type FileManager, type FileRoot } from "./files";
import type { Place } from "./file-index";
import type { VolumeNames } from "./names";
import type { SmartReader } from "./smart";
import { buildJourneys, markMedia, type Journey, type PathRef } from "./journeys";
import {
  readArrays,
  readLayout,
  recentFiles,
  smartAccess,
  type ArraysReport,
  type LayoutNode,
  type RecentFile,
} from "./center";

/**
 * Storage & Files: the read-only panel's data, assembled from Hearth's own records (hosts, drives,
 * volumes and their daily history, findings, incidents), what this machine shows (layout, arrays),
 * and what the apps report (queues, downloads, imports). Recent files are separate and only on
 * request (they touch the disks). Every capability says whether it is available, needs something,
 * or is not built yet, from the same list the panel shows (STORAGE_CENTER.md).
 */

export type CapabilityState =
  "available" | "partial" | "needs-approval" | "not-applicable" | "not-built";

export interface Capability {
  area: string;
  state: CapabilityState;
  note: string;
}

export interface StorageCenter {
  checkedAt: string;
  hosts: {
    id: string;
    name: string;
    os: string;
    connection: string;
    health: string;
    lastSeenAt: string;
    /** Drives and volumes for it come from this machine itself (others: over the network only). */
    local: boolean;
  }[];
  drives: PhysicalDisk[];
  smart?: Blocker;
  volumes: {
    id: string;
    hostId: string;
    label: string;
    mount: string;
    kind: string;
    totalTb: number;
    usedTb: number;
    /** Daily highest use, oldest first (up to 60 days). */
    history: { day: string; usedTb: number }[];
  }[];
  layout: { available: true; disks: LayoutNode[] } | { available: false; why: string };
  arrays: ArraysReport;
  locations: { id: string; hostId: string; label: string; path: string; source: string }[];
  /** Where the file manager starts: this machine's drives, and folders you chose to watch. */
  roots: FileRoot[];
  /** Your names for drives, by mount ("/mnt/f" -> "Film"). */
  names: Record<string, string>;
  journeys: Journey[];
  /** Apps Hearth could not read for journeys, and why (stale or disconnected is never hidden). */
  journeyGaps: { name: string; why: string }[];
  findings: {
    id: string;
    title: string;
    severity: string;
    summary: string;
    at: string;
    analyzer: string;
  }[];
  incidents: { id: string; title: string; severity: string; status: string; openedAt: string }[];
  capabilities: Capability[];
}

const JOURNEY_APPS = new Set(["radarr", "sonarr", "qbittorrent", "sabnzbd", "plex"]);

export class StorageCenterService {
  private recentCache:
    { key: string; at: number; value: Awaited<ReturnType<typeof recentFiles>> } | undefined;

  constructor(
    private readonly handle: DbHandle,
    private readonly apps: AppWatcher,
    private readonly findings: Findings,
    private readonly containers: ContainerTools,
    private readonly files: FileManager,
    private readonly names?: VolumeNames,
    private readonly smartReader?: SmartReader,
    /** The RAID / Arrays tab's report: every technology, on Linux and Windows. */
    private readonly raid?: () => Promise<RaidReport>,
  ) {}

  /** Each drive's SMART report through the elevated executor, or what would allow it. */
  async smart(refresh = false): Promise<{ reports: SmartReport[]; blocker?: Blocker }> {
    const layout = await readLayout();
    const disks = layout.available ? layout.disks : [];
    if (process.platform === "win32" || !this.smartReader) {
      const rows = await this.handle.db.select().from(t.disks);
      const blocker = await smartAccess(
        rows.map((d) => ({
          ...d,
          temperatureC: d.temperatureC ?? undefined,
          powerOnHours: d.powerOnHours ?? undefined,
        })) as unknown as PhysicalDisk[],
        disks,
      );
      return { reports: [], ...(blocker ? { blocker } : {}) };
    }
    const blocker = await this.smartReader.blocker();
    if (blocker) return { reports: [], blocker };
    return { reports: await this.smartReader.read(disks, refresh) };
  }

  /** A service's container mounts, for turning its paths into this machine's paths. */
  private async mountsOf(service: { checkTarget: string | null } | undefined) {
    const c = service ? containerOf(service as { checkTarget: string }) : undefined;
    return c ? await this.containers.mounts(c).catch(() => []) : [];
  }

  async read(): Promise<StorageCenter> {
    const { db } = this.handle;
    const [hosts, disks, volumes, locations, services, incidents] = await Promise.all([
      db.select().from(t.hosts),
      db.select().from(t.disks),
      db.select().from(t.volumes),
      db.select().from(t.storageLocations),
      db.select().from(t.services),
      db.select().from(t.incidents),
    ]);
    const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const daily = await db
      .select()
      .from(t.volumeUsageDaily)
      .where(gte(t.volumeUsageDaily.day, since));
    const drives: PhysicalDisk[] = disks.map((d) => ({
      id: d.id,
      hostId: d.hostId,
      model: d.model,
      type: d.type,
      bus: d.bus,
      sizeTb: d.sizeTb,
      health: d.health,
      ...(d.temperatureC != null ? { temperatureC: d.temperatureC } : {}),
      ...(d.powerOnHours != null ? { powerOnHours: d.powerOnHours } : {}),
      ...(d.wearPct != null ? { wearPct: d.wearPct } : {}),
      ...(d.readErrors != null ? { readErrors: d.readErrors } : {}),
      ...(d.writeErrors != null ? { writeErrors: d.writeErrors } : {}),
      volumes: d.volumes,
      checkedAt: d.checkedAt,
      ...(d.limitation ? { limitation: d.limitation } : {}),
    }));
    const layout = await readLayout();
    // The RAID tab's own report when there is one (every technology, both platforms), so the
    // overview and the tab always agree; the older reader otherwise.
    const raid = this.raid ? await this.raid().catch(() => undefined) : undefined;
    const arrays: ArraysReport = raid
      ? {
          found: raid.arrays.map((a) => ({
            kind: a.tech === "hardware" ? "hardware" : a.tech,
            name: a.name,
            state: a.health,
            detail: `${a.levelText ?? a.level ?? ""}${a.mount ? ` at ${a.mount}` : ""}`,
          })),
          checked: raid.tech.map((t) => ({
            kind: t.tech,
            seen: t.seen,
            support: t.support === "manage" || t.support === "read" ? "read" : "detect",
            verified: t.verified === "loopback" ? "fixtures" : t.verified,
          })),
        }
      : await readArrays(layout.available ? layout.disks : []);
    const smart =
      process.platform !== "win32" && this.smartReader
        ? await this.smartReader.blocker()
        : await smartAccess(drives, layout.available ? layout.disks : []);

    // Journeys: what the download and media apps report right now.
    const managers: { serviceId: string; name: string; data: ArrDashboard }[] = [];
    const qbittorrent: { serviceId: string; name: string; data: QbittorrentDashboard }[] = [];
    const sabnzbd: { serviceId: string; name: string; data: SabnzbdDashboard }[] = [];
    const journeyGaps: StorageCenter["journeyGaps"] = [];
    const plexes: { serviceId: string; name: string; data?: PlexDashboard }[] = [];
    const relevant = services.filter(
      (s) => s.lifecycle === "active" && JOURNEY_APPS.has(appOf(s) ?? ""),
    );
    await Promise.all(
      relevant.map(async (s) => {
        try {
          const d = await this.apps.dashboard(s.id);
          if (d.error || !d.data) {
            journeyGaps.push({ name: s.name, why: d.error?.message ?? "It did not answer." });
            if (appOf(s) === "plex") plexes.push({ serviceId: s.id, name: s.name });
            return;
          }
          if (d.data.app === "plex") plexes.push({ serviceId: s.id, name: s.name, data: d.data });
          if (d.data.app === "radarr" || d.data.app === "sonarr")
            managers.push({ serviceId: s.id, name: s.name, data: d.data });
          else if (d.data.app === "qbittorrent")
            qbittorrent.push({ serviceId: s.id, name: s.name, data: d.data });
          else if (d.data.app === "sabnzbd")
            sabnzbd.push({ serviceId: s.id, name: s.name, data: d.data });
        } catch (error) {
          journeyGaps.push({
            name: s.name,
            why: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    const journeys = buildJourneys({ managers, qbittorrent, sabnzbd });
    // Each app reports paths inside its own container; find them on this machine and in the
    // file manager. Only the reporting app's own mounts are used, so nothing is guessed.
    const mountCache = new Map<string, Awaited<ReturnType<StorageCenterService["mountsOf"]>>>();
    const hostOf = async (serviceId: string, p: string) => {
      if (!mountCache.has(serviceId))
        mountCache.set(serviceId, await this.mountsOf(services.find((x) => x.id === serviceId)));
      return hostPathOf(p, mountCache.get(serviceId)!);
    };
    const place = async (ref: PathRef | undefined) => {
      if (!ref?.serviceId) return;
      const host = await hostOf(ref.serviceId, ref.path);
      if (!host) return;
      ref.hostPath = host;
      const open = await this.files.locate(host);
      if (open) ref.open = open;
    };
    for (const j of journeys) {
      await place(j.source);
      await place(j.destination);
      j.paths = [
        ...(j.source ? [{ ...j.source, where: "Download" }] : []),
        ...(j.destination ? [{ ...j.destination, where: "Library" }] : []),
      ];
    }
    // The last step: Plex lists the same file (its paths mapped through its own mounts).
    const plex = plexes[0];
    if (plex) {
      const files = new Map<string, string | undefined>();
      for (const item of plex.data?.recentlyAdded ?? [])
        for (const f of item.files ?? []) {
          const host = await hostOf(plex.serviceId, f);
          files.set(host ?? f, item.addedAt);
        }
      markMedia(journeys, { name: plex.name, connected: Boolean(plex.data), files });
    } else markMedia(journeys, undefined);

    const storageFindings = (await this.findings.list({ status: "active", limit: 200 })).filter(
      (f) =>
        f.analyzer.startsWith("storage") || /disk|drive|volume|storage|space|mount/i.test(f.title),
    );
    const storageIncidents = incidents.filter(
      (i) =>
        i.status !== "resolved" &&
        /disk|drive|volume|storage|space|mount|full/i.test(`${i.title} ${i.summary}`),
    );

    const linux = process.platform === "linux";
    const capabilities: Capability[] = [
      {
        area: "Drive inventory and health verdict",
        state: drives.length ? "available" : "partial",
        note: drives.length
          ? "Model, type, connection, size, the drive's own health verdict, and temperature where the system shares it."
          : "No drives read yet. Refresh drives to read them.",
      },
      {
        area: "SMART detail and self-tests",
        state: smart ? "needs-approval" : "available",
        note: smart
          ? smart.title
          : "Read from the drives themselves through the elevated executor (smart.read, read only).",
      },
      {
        area: "Partitions, filesystems, mounts",
        state: layout.available ? "available" : "not-built",
        note: layout.available ? "From lsblk, read without root." : layout.why,
      },
      {
        area: "Capacity and growth",
        state: volumes.length ? "available" : "partial",
        note: "Used and free per volume, with a daily history Hearth keeps (needs a few days for a trend).",
      },
      {
        area: "RAID, pools, parity",
        state: arrays.found.length ? "available" : "not-applicable",
        note: arrays.found.length
          ? `${arrays.found.length} array${arrays.found.length === 1 ? "" : "s"} or pool${arrays.found.length === 1 ? "" : "s"} read: ${arrays.found.map((a) => a.name).join(", ")}.`
          : "No RAID or pools on this machine. Hearth reads Linux software RAID, ZFS, Btrfs, SnapRAID, and Windows Storage Spaces wherever a machine has them.",
      },
      {
        area: "File browser",
        state: locations.length ? "available" : "partial",
        note: locations.length
          ? "Browse, sort, search, and properties, inside the folders you chose. Read only."
          : "Choose a folder to watch to browse it here. Read only.",
      },
      {
        area: "Recent files",
        state: "available",
        note: "Recently Added: every drive indexed every ten minutes. Arrivals are dated by the window Hearth saw them arrive in; files already there are labelled by their file date. Moves, finished downloads, hardlinks, and deletions are kept. Not a live watcher: an arrival is known within ten minutes.",
      },
      {
        area: "File journeys",
        state: relevant.length ? "partial" : "not-applicable",
        note: relevant.length
          ? "From Radarr and Sonarr history and queues, qBittorrent, SABnzbd, and Plex (by exact file path). Jellyfin recognition and history older than the last 100 events are not built yet."
          : "No download or media manager apps connected.",
      },
      {
        area: "File changes (new folder, rename, move, copy)",
        state: "partial",
        note: "From the file manager, each a plan you confirm, done as Hearth's own account and checked afterwards. Never deletes or replaces; folders Radarr, Sonarr, or a download client manage are left to those apps; a move to another drive is offered as a copy. Delete is not offered. Ember cannot propose these yet.",
      },
      {
        area: "Repairs and recovery (replace, rebuild, scrub)",
        state: "partial",
        note: "In the RAID / Arrays tab, for Linux software RAID, ZFS, Btrfs, SnapRAID (Linux and Windows), and Windows Storage Spaces: replace or rebuild a drive, spares, checks and scrubs (pause, resume, schedule), SnapRAID syncs with a safety stop, growing, converting Btrfs, and creating arrays and pools, each a plan you confirm, carried out by the elevated executor and read back. Unraid, StableBit DrivePool, LVM RAID, and hardware RAID are detected only: they are managed in their own apps. Never a single repair button.",
      },
      {
        area: "Backups",
        state: "partial",
        note: "Hearth's own backups are tracked; RAID is not a backup. Other backup tools are not read yet.",
      },
      {
        area: "Other machines",
        state: "partial",
        note: linux
          ? "Drives and layout are read on the machine Hearth runs on. Other machines show as hosts until a collector runs there."
          : "Drives are read on the machine Hearth runs on; others show as hosts only.",
      },
    ];

    return {
      checkedAt: new Date().toISOString(),
      hosts: hosts.map((h) => ({
        id: h.id,
        name: h.name,
        os: h.os,
        connection: h.connection,
        health: h.health,
        lastSeenAt: h.lastSeenAt,
        local: h.connection === "this-machine",
      })),
      drives,
      ...(smart ? { smart } : {}),
      volumes: volumes.map((v) => ({
        id: v.id,
        hostId: v.hostId,
        label: v.label,
        mount: v.mount,
        kind: v.kind,
        totalTb: v.totalTb,
        usedTb: v.usedTb,
        history: daily
          .filter((d) => d.volumeId === v.id)
          .sort((a, b) => a.day.localeCompare(b.day))
          .map((d) => ({ day: d.day, usedTb: d.usedTb })),
      })),
      layout,
      arrays,
      locations: locations.map((l) => ({
        id: l.id,
        hostId: l.hostId,
        label: l.label,
        path: l.path,
        source: l.source,
      })),
      roots: await this.files.roots(),
      names: Object.fromEntries((await this.names?.all()) ?? []),
      journeys,
      journeyGaps,
      findings: storageFindings.map((f) => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        summary: f.summary,
        at: f.lastSeenAt ?? f.firstSeenAt,
        analyzer: f.analyzer,
      })),
      incidents: storageIncidents.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        status: i.status,
        openedAt: i.openedAt,
      })),
      capabilities,
    };
  }

  /**
   * Files changed lately where downloads land: the download clients' own download folders (from
   * their container mounts) plus any folder you chose to watch. Cached five minutes: it touches
   * the disks.
   */
  async recent(
    hours: number,
  ): Promise<
    Awaited<ReturnType<typeof recentFiles>> & { at: string; hours: number; scopes: string[] }
  > {
    const h = Math.min(24 * 14, Math.max(1, Math.round(hours)));
    const scopes = await this.recentScopes();
    const key = `${h}:${scopes.map((x) => x.path).join("|")}`;
    if (
      !this.recentCache ||
      this.recentCache.key !== key ||
      Date.now() - this.recentCache.at > 5 * 60_000
    ) {
      const value = await recentFiles(scopes, { sinceMs: h * 3_600_000 });
      for (const f of value.files) {
        const open = await this.files.locate(f.abs);
        if (open) f.open = open;
      }
      this.recentCache = { key, at: Date.now(), value };
    }
    return {
      ...this.recentCache.value,
      at: new Date(this.recentCache.at).toISOString(),
      hours: h,
      scopes: scopes.map((x) => x.path),
    };
  }

  /**
   * The folders your apps use on this machine, from their own container mounts: library folders
   * (Radarr, Sonarr, Lidarr, Readarr, Plex, Jellyfin) and download folders (qBittorrent,
   * SABnzbd). Settings folders (/config) are left out. Used to say where a new file landed.
   */
  async places(): Promise<Place[]> {
    const services = await this.handle.db.select().from(t.services);
    const byPath = new Map<string, Place>();
    for (const s of services.filter((x) => x.lifecycle === "active")) {
      const app = appOf(s) ?? "";
      const role = ["qbittorrent", "sabnzbd", "deluge", "transmission", "nzbget"].includes(app)
        ? "downloads"
        : ["radarr", "sonarr", "lidarr", "readarr", "plex", "jellyfin", "emby"].includes(app)
          ? "library"
          : undefined;
      if (!role) continue;
      for (const m of await this.mountsOf(s)) {
        if (/^\/(config|app|data\/config|transcode|cache|tmp)(\/|$)/i.test(m.destination)) continue;
        if (!m.source.startsWith("/mnt/") && !/^[A-Z]:/i.test(m.source)) continue;
        if (this.files.hidden(m.source)) continue;
        const r: "library" | "downloads" =
          role === "library" && /download|incomplete|torrent|usenet/i.test(m.destination)
            ? "downloads"
            : role;
        const k = byPath.get(m.source);
        if (k) {
          if (!k.apps.includes(s.name)) k.apps.push(s.name);
          if (r === "library") k.role = "library";
        } else
          byPath.set(m.source, {
            path: m.source,
            label: m.source.split(/[\\/]/).filter(Boolean).pop() ?? m.source,
            role: r,
            apps: [s.name],
          });
      }
    }
    return [...byPath.values()];
  }

  /** App internals on this machine (settings, caches, transcodes, Docker storage): not new files. */
  async noisePaths(): Promise<string[]> {
    const services = await this.handle.db.select().from(t.services);
    const out = new Set<string>();
    for (const s of services) {
      for (const m of await this.mountsOf(s)) {
        if (
          /^\/(config|cache|transcode|tmp|data\/config|metadata|database|db|logs?)(\/|$)/i.test(
            m.destination,
          )
        )
          out.add(m.source);
        const engine = /^(.*\/docker\/data\/engine)(\/|$)/.exec(m.source);
        if (engine) out.add(engine[1]!);
      }
    }
    // Never hide a folder that is also a library or download folder.
    const places = (await this.places()).map((p) => p.path);
    return [...out].filter((n) => !places.some((p) => p === n || p.startsWith(`${n}/`)));
  }

  private async recentScopes(): Promise<{ id: string; label: string; path: string }[]> {
    const { db } = this.handle;
    const [locations, services] = await Promise.all([
      db.select().from(t.storageLocations),
      db.select().from(t.services),
    ]);
    const out = locations
      .filter((l) => l.source === "fs")
      .map((l) => ({ id: l.id, label: l.label, path: l.path }));
    for (const s of services.filter(
      (x) => x.lifecycle === "active" && ["qbittorrent", "sabnzbd"].includes(appOf(x) ?? ""),
    )) {
      for (const m of await this.mountsOf(s)) {
        if (!/download|incomplete|complete|torrent|usenet/i.test(m.destination)) continue;
        if (this.files.hidden(m.source) || out.some((o) => o.path === m.source)) continue;
        out.push({ id: `dl-${s.id}-${out.length}`, label: `${s.name} downloads`, path: m.source });
      }
    }
    return out;
  }
}

export type { RecentFile };
