import {
  appKindOf,
  canRecover,
  assess,
  DEFAULT_HEALTH_SETTINGS,
  type AppDashboard,
  type ArrDashboard,
  type DownloadHealthItem,
  type DownloadHealthOverview,
  type DownloadObservation,
  type LibraryDashboard,
  type QbittorrentDashboard,
  type SabnzbdDashboard,
  type Strike,
  type StepParams,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { getSetting, setSetting } from "../store/settings";

/**
 * Download Health, monitoring (design "Download Health: design for DC", phase 2). Every few
 * minutes it reads the download clients and the apps that grab (the same reads their panels use),
 * turns what it sees into observations, and keeps strikes between checks. It changes nothing.
 *
 * Only downloads an app tracks are judged (Sonarr, Radarr, Lidarr, Chaptarr); anything else in a
 * shared client (manual downloads, seeding, paused on purpose) is left alone. A client that does
 * not answer is reported once as the cause, and none of its downloads gets a strike meanwhile.
 */

interface ServiceRow {
  id: string;
  name: string;
  image?: string | null;
  lifecycle?: string;
  localUrl?: string | null;
}

export interface HealthRecord {
  at: string;
  key: string;
  title: string;
  /**
   * What happened: it started needing attention, it recovered (progress, imported, gone), or
   * Automatic Recovery fixed it (removed, blocklisted that release, searched again).
   */
  event: "attention" | "cleared" | "fixed";
  text: string;
}

const LOG_MAX = 200;
const CLIENTS = new Set(["qbittorrent", "sabnzbd"]);
const GRABBERS = new Set(["sonarr", "radarr", "lidarr", "chaptarr"]);
/** Less free space than this where a client downloads is a storage problem. */
const LOW_SPACE = 2 * 1024 ** 3;

export class DownloadHealth {
  private running?: Promise<DownloadHealthOverview>;
  constructor(
    private readonly handle: DbHandle,
    /** The same live reads the panels use (AppWatcher.dashboard). */
    private readonly dashboard: (serviceId: string) => Promise<AppDashboard>,
    private readonly clock: () => number = Date.now,
  ) {}

  async overview(): Promise<
    DownloadHealthOverview & { history: HealthRecord[]; sample?: boolean }
  > {
    const saved = await getSetting(this.handle.db, "download_health");
    const history = (await getSetting(this.handle.db, "download_health_log")) ?? [];
    return {
      ...(saved?.overview ?? {
        downloading: 0,
        watching: 0,
        attention: 0,
        clients: [],
        causes: [],
        items: [],
        settings: DEFAULT_HEALTH_SETTINGS,
      }),
      ...(saved?.sample ? { sample: true } : {}),
      history,
    };
  }

  /** One check now (a second caller waits for the one already running). */
  check(): Promise<DownloadHealthOverview> {
    this.running ??= this.run().finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<DownloadHealthOverview> {
    const now = new Date(this.clock()).toISOString();
    const rows = ((await this.handle.db.select().from(t.services).all()) as ServiceRow[]).filter(
      (s) => s.lifecycle === "active" && s.localUrl,
    );
    const kindOf = (s: ServiceRow) => appKindOf({ name: s.name, image: s.image ?? undefined });
    const clients = rows.filter((s) => CLIENTS.has(kindOf(s) ?? ""));
    const grabbers = rows.filter((s) => GRABBERS.has(kindOf(s) ?? ""));
    const read = async (s: ServiceRow) => ({
      s,
      d: await this.dashboard(s.id).catch(() => undefined),
    });
    const [clientReads, grabReads] = await Promise.all([
      Promise.all(clients.map(read)),
      Promise.all(grabbers.map(read)),
    ]);
    const sample = [...clientReads, ...grabReads].some((r) => r.d?.sample);

    // What each app tracks, by the download client's id for it.
    interface Tracked {
      app: string;
      appServiceId: string;
      title: string;
      queueId: number;
      stuck: boolean;
      failed: boolean;
      problem?: string;
      /** Sonarr and Radarr: where Fix it acts. */
      fix?: { serviceId: string; queueId: number };
    }
    const tracked = new Map<string, Tracked>();
    const appItems: Tracked[] = [];
    for (const { s, d } of grabReads) {
      const data = d?.data;
      if (!data) continue;
      if (data.app === "sonarr" || data.app === "radarr")
        for (const q of (data as ArrDashboard).queue) {
          const t: Tracked = {
            app: s.name,
            appServiceId: s.id,
            title: q.title,
            queueId: q.queueId,
            stuck: q.stuckImport,
            failed: Boolean(q.failed),
            ...(q.problem ? { problem: q.problem } : {}),
            fix: { serviceId: s.id, queueId: q.queueId },
          };
          appItems.push(t);
          if (q.downloadId) tracked.set(q.downloadId.toLowerCase(), t);
        }
      if (data.app === "lidarr" || data.app === "chaptarr")
        for (const q of (data as LibraryDashboard).queue) {
          const t: Tracked = {
            app: s.name,
            appServiceId: s.id,
            title: q.title,
            queueId: q.id,
            stuck: q.stuck,
            failed: /fail/i.test(q.status),
            ...(q.problem ? { problem: q.problem } : {}),
          };
          appItems.push(t);
          if (q.downloadId) tracked.set(q.downloadId.toLowerCase(), t);
        }
    }

    const observed: DownloadObservation[] = [];
    const unreachable: { serviceId: string; name: string; detail?: string }[] = [];
    const status: DownloadHealthOverview["clients"] = [];
    const extraCauses: DownloadHealthOverview["causes"] = [];
    const seen = new Set<string>();
    let downloading = 0;
    for (const { s, d } of clientReads) {
      if (!d || d.error?.kind === "unreachable" || d.error?.kind === "blocked") {
        unreachable.push({
          serviceId: s.id,
          name: s.name,
          ...(d?.error ? { detail: d.error.message } : {}),
        });
        status.push({
          serviceId: s.id,
          name: s.name,
          reachable: false,
          ...(d?.error ? { detail: d.error.message } : {}),
        });
        continue;
      }
      if (!d.data) {
        status.push({
          serviceId: s.id,
          name: s.name,
          reachable: false,
          detail: d.error?.message ?? "not readable",
        });
        continue;
      }
      status.push({ serviceId: s.id, name: s.name, reachable: true });
      if (d.data.app === "qbittorrent") {
        const qb = d.data as QbittorrentDashboard;
        if (qb.vpn && qb.vpn.health === "offline")
          extraCauses.push({
            clientServiceId: s.id,
            client: s.name,
            count: 0,
            text: `${qb.vpn.name}, the VPN ${s.name} downloads through, is down: nothing can find peers until it is back.`,
          });
        if (qb.freeSpaceBytes !== undefined && qb.freeSpaceBytes < LOW_SPACE)
          extraCauses.push({
            clientServiceId: s.id,
            client: s.name,
            count: 0,
            text: `${s.name} has less than 2 GB free where it downloads: downloads will stop or fail until space is freed.`,
          });
        for (const tor of qb.torrents) {
          if (tor.status === "downloading" || tor.status === "stalled" || tor.status === "metadata")
            downloading += 1;
          const app = tracked.get(tor.hash.toLowerCase());
          if (!app) continue;
          seen.add(tor.hash.toLowerCase());
          const problem =
            tor.status === "stalled"
              ? "stalled"
              : tor.status === "metadata"
                ? "metadata"
                : tor.status === "error"
                  ? "download-failed"
                  : undefined;
          observed.push({
            key: `${s.id}:${tor.hash}`,
            title: app.title,
            app: app.app,
            appServiceId: app.appServiceId,
            client: s.name,
            clientServiceId: s.id,
            downloadedBytes: tor.downloadedBytes,
            progressPct: tor.progressPct,
            ...(app.fix ? { fix: app.fix } : {}),
            ...(problem ? { problem } : {}),
            ...(tor.problem ? { detail: tor.problem } : {}),
            ...(problem === "download-failed" ? { final: true } : {}),
          });
        }
      }
      if (d.data.app === "sabnzbd") {
        const sab = d.data as SabnzbdDashboard;
        downloading += sab.queue.length;
        if (sab.diskFreeGb !== undefined && sab.diskFreeGb < 2)
          extraCauses.push({
            clientServiceId: s.id,
            client: s.name,
            count: 0,
            text: `${s.name} has less than 2 GB free: downloads will fail until space is freed.`,
          });
        for (const h of sab.history) {
          const app = tracked.get(h.id.toLowerCase());
          if (!h.failed || !app) continue;
          seen.add(h.id.toLowerCase());
          observed.push({
            key: `${s.id}:${h.id}`,
            title: app.title,
            app: app.app,
            appServiceId: app.appServiceId,
            client: s.name,
            clientServiceId: s.id,
            problem: "usenet-failed",
            final: true,
            ...(h.why ? { detail: h.why } : {}),
            ...(app.fix ? { fix: app.fix } : {}),
          });
        }
      }
    }
    // What only the app knows: finished but not imported, or failed in its queue.
    for (const a of appItems) {
      const id = [...tracked.entries()].find(([, v]) => v === a)?.[0];
      if (id && seen.has(id) && !a.stuck) continue;
      if (!a.stuck && !a.failed) continue;
      observed.push({
        key: `${a.appServiceId}:${id ?? `q${a.queueId}`}`,
        title: a.title,
        app: a.app,
        appServiceId: a.appServiceId,
        client: a.app,
        clientServiceId: a.appServiceId,
        problem: a.stuck ? "import-failed" : "download-failed",
        final: true,
        ...(a.problem ? { detail: a.problem } : {}),
        ...(a.fix ? { fix: a.fix } : {}),
      });
    }

    const saved = await getSetting(this.handle.db, "download_health");
    const before: Record<string, Strike> = saved?.strikes ?? {};
    const settings = saved?.overview?.settings ?? DEFAULT_HEALTH_SETTINGS;
    const r = assess(observed, before, now, settings, unreachable);
    const overview: DownloadHealthOverview = {
      checkedAt: now,
      downloading,
      watching: r.items.filter((i) => i.state === "watching").length,
      attention: r.items.filter((i) => i.state === "attention").length,
      clients: status,
      causes: [...r.causes, ...extraCauses],
      items: r.items,
      settings,
    };
    await this.record(saved?.overview?.items ?? [], r.items, now);
    await setSetting(this.handle.db, "download_health", {
      strikes: r.strikes,
      overview,
      ...(sample ? { sample } : {}),
    });
    // Automatic Recovery, when the owner turned it on (wired in app.ts).
    if (this.onChecked && !sample) await this.onChecked(overview).catch(() => undefined);
    return overview;
  }

  /** A line in the history (Automatic Recovery's fixes). */
  async log(rec: HealthRecord) {
    const log = (await getSetting(this.handle.db, "download_health_log")) ?? [];
    await setSetting(this.handle.db, "download_health_log", [rec, ...log].slice(0, LOG_MAX));
  }

  /** After each check (Automatic Recovery). */
  onChecked?: (o: DownloadHealthOverview) => Promise<void>;

  /** The owner's Download Health settings (Automatic Recovery on or off). */
  async setSettings(patch: Partial<DownloadHealthOverview["settings"]>) {
    const saved = await getSetting(this.handle.db, "download_health");
    const overview = await this.overview();
    const settings = { ...overview.settings, ...patch };
    const { history: _h, sample: _s, ...rest } = overview;
    await setSetting(this.handle.db, "download_health", {
      strikes: saved?.strikes ?? {},
      overview: { ...rest, settings },
      ...(saved?.sample ? { sample: true } : {}),
    });
    return settings;
  }

  /** The history: when something started needing attention, and when it stopped. */
  private async record(before: DownloadHealthItem[], after: DownloadHealthItem[], at: string) {
    const log = (await getSetting(this.handle.db, "download_health_log")) ?? [];
    const was = new Map(before.filter((i) => i.state === "attention").map((i) => [i.key, i]));
    const is = new Map(after.filter((i) => i.state === "attention").map((i) => [i.key, i]));
    const add: HealthRecord[] = [];
    for (const [k, i] of is)
      if (!was.has(k))
        add.push({ at, key: k, title: i.title, event: "attention", text: i.explain });
    for (const [k, i] of was)
      if (!is.has(k))
        add.push({
          at,
          key: k,
          title: i.title,
          event: "cleared",
          text: "No longer a problem: it made progress, was imported or was removed.",
        });
    if (!add.length) return;
    await setSetting(this.handle.db, "download_health_log", [...add, ...log].slice(0, LOG_MAX));
  }
}

/**
 * Automatic Recovery (11-13, the owner's choice; off unless turned on): with the switch as the
 * standing approval, a download that needs attention and can be recovered gets the same plan Fix
 * it makes, approved by that switch, and the history (and so the bell) says what was done. Once
 * per download; the step itself refuses a third replacement for the same movie or episode.
 */
export async function autoRecover(
  o: DownloadHealthOverview,
  deps: {
    tried: Set<string>;
    create: (job: {
      title: string;
      reason: string;
      steps: { kind: "app-arr-queue-remove"; serviceId: string; params: StepParams }[];
      requestedBy: "dragon-control";
    }) => Promise<{
      id: string;
      status: string;
      summary?: string;
      approval?: { fingerprint: string };
    }>;
    approve: (id: string, fingerprint: string) => Promise<{ status: string; summary?: string }>;
    log: (rec: HealthRecord) => Promise<void>;
  },
): Promise<number> {
  if (!o.settings.auto) return 0;
  let n = 0;
  for (const i of o.items) {
    if (!canRecover(i) || deps.tried.has(i.key)) continue;
    deps.tried.add(i.key);
    const at = new Date().toISOString();
    try {
      const job = await deps.create({
        title: `Fix the stuck download of ${i.title}`,
        reason: `Automatic Recovery (on in Download Health): ${i.explain}`,
        steps: [
          {
            kind: "app-arr-queue-remove",
            serviceId: i.fix!.serviceId,
            params: { queueId: i.fix!.queueId, recover: true },
          },
        ],
        requestedBy: "dragon-control",
      });
      const ran =
        job.status === "awaiting-approval" && job.approval
          ? await deps.approve(job.id, job.approval.fingerprint)
          : job;
      const refused = ran.status === "refused";
      if (!refused) n += 1;
      await deps.log({
        at,
        key: i.key,
        title: i.title,
        event: "fixed",
        text: refused
          ? `Automatic Recovery couldn't fix it: ${ran.summary ?? "not allowed"}. Look at it yourself.`
          : "Automatic Recovery removed it, blocklisted that release and searched for another.",
      });
    } catch (e) {
      await deps.log({
        at,
        key: i.key,
        title: i.title,
        event: "fixed",
        text: `Automatic Recovery didn't fix it: ${e instanceof Error ? e.message : "it failed"}. Look at it yourself.`,
      });
    }
  }
  return n;
}
