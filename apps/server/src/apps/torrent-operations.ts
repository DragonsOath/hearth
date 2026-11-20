import { eq } from "drizzle-orm";
import {
  appKindOf,
  TORRENT_STATUS_LABEL,
  type ActionKind,
  type StepChange,
  type StepParams,
  type Torrent,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { CredentialBroker } from "../credentials/broker";
import { addTimeline } from "../monitor/engine";
import type { Memory } from "../memory/service";
import { recordAudit } from "../store/audit";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import {
  AppUnreachableError,
  getJson,
  joinUrl,
  multipart,
  type Fetch,
  type UploadFetch,
} from "./http";
import { qbCall, qbSignIn } from "./qbittorrent";
import { toTorrent, torrentStatus, trackerHost } from "./qbittorrent-live";
import {
  CONTROL_ACTIONS,
  PlanRefused,
  planControl,
  type ArrCategories,
  readSettings,
  runControl,
  type Session,
} from "./qbittorrent-control";
import { ManualSorter, PlanRefusedError } from "./manual-sort";

/**
 * Repairs on one torrent in qBittorrent (resume, pause, reannounce, recheck),
 * approved by the owner as plan steps. Same pattern as the other operations
 * inside apps (operations.ts):
 *
 * - plan: read the torrent now (hash, name, state) and describe exactly what
 *   changes. Approval covers those values.
 * - run: read it again; if it is gone, has another name, or is in another
 *   state than when the plan was approved, nothing is changed. Otherwise one
 *   call for that hash only, then read back until the effect is seen.
 * - The outcome says what qBittorrent reports afterwards. "Accepted" is never
 *   reported as "fixed": a resumed torrent with no seeders is still stalled.
 *
 * Only `/api/v2/torrents/*` calls for the one approved hash are made here:
 * never qBittorrent's preferences, save paths, categories, other torrents,
 * the VPN, or Gluetun. The login comes from the Secure Vault through the
 * broker; a change needs its scope set to "changes you approve".
 */

const HASH = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const STOPPED = /^(paused|stopped)(DL|UP)$/;

const VERIFY_MS: Partial<Record<ActionKind, number>> = {
  "app-qbt-resume": 10_000,
  "app-qbt-pause": 10_000,
  "app-qbt-reannounce": 15_000,
  "app-qbt-recheck": 10_000,
};

interface RawTracker {
  url?: string;
  status?: number;
  num_seeds?: number;
  msg?: string;
}

const TRACKER_STATUS = ["disabled", "not contacted", "working", "updating", "not working"];

/** Real trackers only (qBittorrent lists DHT, PeX, and LSD as "** [DHT] **" rows). */
const realTrackers = (list: RawTracker[]) => list.filter((x) => x.url && !x.url.startsWith("** ["));

const trackerSummary = (list: RawTracker[]) =>
  realTrackers(list)
    .map((x) => `${trackerHost(x.url) ?? "tracker"} ${TRACKER_STATUS[x.status ?? 1] ?? "unknown"}`)
    .join(", ") || "no trackers";

const stateText = (tor: Torrent) => `${TORRENT_STATUS_LABEL[tor.status]} (${tor.state})`;

/** Where the torrent stands now, in plain words: what qBittorrent reports, not a guess. */
function standing(tor: Torrent): { fixed: boolean; text: string } {
  if (tor.problem) return { fixed: false, text: `it is not fixed: ${tor.problem}` };
  if (tor.status === "downloading")
    return {
      fixed: tor.downSpeed > 0,
      text:
        tor.downSpeed > 0
          ? `qBittorrent reports it downloading (${Math.round(tor.downSpeed / 1024)} KiB/s from ${tor.seedsConnected} seeders)`
          : "qBittorrent reports it downloading, but no data is arriving yet",
    };
  return {
    fixed: tor.status === "seeding" || tor.status === "completed",
    text: `qBittorrent reports it ${stateText(tor)}`,
  };
}

class PlanError extends Error {}

interface Q {
  get<T>(path: string): Promise<T>;
  post(path: string, body: string): Promise<{ ok: boolean; status: number; text?: string }>;
  postForm(
    path: string,
    fields: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; text?: string }>;
  upload(
    path: string,
    fields: Record<string, string>,
    files: { field: string; filename: string; type: string; data: Uint8Array }[],
  ): Promise<{ ok: boolean; status: number; text?: string }>;
}

export class TorrentOperations {
  /** Sorting manual downloads (no category) by type: its setup, Undo, and the minute's pass. */
  readonly sorter: ManualSorter;
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly memory?: Memory,
    /** How long to wait between read-backs (tests pass a no-op). */
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.sorter = new ManualSorter(handle, broker, fetchImpl, (service) =>
      this.sessionFor(service),
    );
  }

  /** One signed-in session through the broker, for this service's own address only; signed out after. */
  private session<T>(
    service: { id: string; name: string; localUrl: string },
    access: "read" | "change",
    purpose: string,
    fn: (q: Q) => Promise<T>,
  ): Promise<T> {
    const base = service.localUrl;
    const fetchImpl = this.fetchImpl;
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: base },
      async ({ value, username }) => {
        const call = qbCall(base, this.fetchImpl);
        const cookie = await qbSignIn(
          base,
          { username: username ?? "", password: value },
          this.fetchImpl,
        );
        const q: Q = {
          async get<R>(path: string) {
            const res = await call(path, { cookie });
            if (!res.ok)
              throw new AppUnreachableError(
                `qBittorrent answered ${res.status} for ${path.split("?")[0]}.`,
              );
            return (await res.json()) as R;
          },
          async post(path: string, body: string) {
            const res = await call(path, { method: "POST", body, cookie });
            const text = res.text ? await res.text().catch(() => "") : "";
            return { ok: res.ok, status: res.status, text };
          },
          async postForm(path: string, fields: Record<string, string>) {
            // multipart/form-data, which qBittorrent's add call expects.
            const boundary = `----dc${Date.now().toString(16)}`;
            const body =
              Object.entries(fields)
                .map(
                  ([k, v]) =>
                    `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
                )
                .join("") + `--${boundary}--\r\n`;
            const res = await call(path, {
              method: "POST",
              body,
              cookie,
              contentType: `multipart/form-data; boundary=${boundary}`,
            });
            const text = res.text ? await res.text().catch(() => "") : "";
            return { ok: res.ok, status: res.status, text };
          },
          // A .torrent upload: the same signed-in session, with the file's bytes as they are.
          async upload(path, fields, files) {
            const form = multipart(fields, files);
            let res: Awaited<ReturnType<Fetch>>;
            try {
              res = await (fetchImpl as unknown as UploadFetch)(joinUrl(base, path), {
                method: "POST",
                headers: { "Content-Type": form.contentType, Cookie: cookie },
                body: form.body,
                signal: AbortSignal.timeout(60_000),
              });
            } catch (error) {
              throw new AppUnreachableError(
                `qBittorrent did not take the upload: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            const text = res.text ? await res.text().catch(() => "") : "";
            return { ok: res.ok, status: res.status, text };
          },
        };
        try {
          return await fn(q);
        } finally {
          await call("/api/v2/auth/logout", { method: "POST", body: "x=1", cookie }).catch(
            () => undefined,
          );
        }
      },
    );
  }

  /** The session for one service, in the shape the wider controls use. */
  sessionFor(service: { id: string; name: string; localUrl: string }): Session {
    return (access, purpose, fn) => this.session(service, access, purpose, fn);
  }

  /**
   * The qBittorrent categories Sonarr, Radarr and Lidarr send downloads to, read from each one's
   * own download client settings with its key in the vault. Apps that cannot be read are named,
   * so a category is never removed on a guess.
   */
  private async arrCategories(): Promise<ArrCategories> {
    const services = await this.handle.db.select().from(t.services).all();
    const arrs = services.filter(
      (sv) =>
        sv.lifecycle === "active" &&
        sv.localUrl &&
        // Sample data stands for no real app: nothing of it sends downloads anywhere.
        !sv.checkTarget?.startsWith("demo:") &&
        ["radarr", "sonarr", "lidarr"].includes(appKindOf(sv) ?? ""),
    );
    const used: ArrCategories["used"] = [];
    const unchecked: string[] = [];
    for (const sv of arrs) {
      const api = appKindOf(sv) === "lidarr" ? "/api/v1/downloadclient" : "/api/v3/downloadclient";
      try {
        const clients = await this.broker.use(
          {
            serviceId: sv.id,
            purpose: "check which qBittorrent category it sends downloads to",
            access: "read",
            destination: sv.localUrl!,
          },
          ({ value }) =>
            getJson<{ implementation?: string; fields?: { name?: string; value?: unknown }[] }[]>(
              this.fetchImpl,
              sv.name,
              sv.localUrl!,
              api,
              value,
            ),
        );
        for (const c of clients)
          if (/qbittorrent/i.test(c.implementation ?? ""))
            for (const f of c.fields ?? [])
              if (/category$/i.test(f.name ?? "") && typeof f.value === "string" && f.value)
                used.push({ app: sv.name, category: f.value });
      } catch {
        unchecked.push(sv.name);
      }
    }
    return { used, unchecked };
  }

  /** qBittorrent's settings, categories, tags, and transfer state (read only). */
  settings(service: { id: string; name: string; localUrl: string }) {
    return readSettings(this.sessionFor(service));
  }

  private async torrent(q: Q, hash: string): Promise<Torrent | undefined> {
    const list = await q.get<({ hash?: string } & Record<string, unknown>)[]>(
      `/api/v2/torrents/info?hashes=${hash}`,
    );
    const raw = Array.isArray(list) ? list.find((x) => x.hash?.toLowerCase() === hash) : undefined;
    return raw ? toTorrent(hash, raw as Parameters<typeof toTorrent>[1]) : undefined;
  }

  private trackers(q: Q, hash: string) {
    return q.get<RawTracker[]>(`/api/v2/torrents/trackers?hash=${hash}`);
  }

  /** Why this action does not make sense for the torrent as it is now, if it does not. */
  private precondition(
    kind: ActionKind,
    tor: Torrent,
    trackers?: RawTracker[],
  ): string | undefined {
    const stopped = STOPPED.test(tor.state);
    if (tor.state === "moving")
      return `"${tor.name}" is being moved right now; wait until that finishes.`;
    if (kind === "app-qbt-resume" && !stopped)
      return `"${tor.name}" is not paused (qBittorrent reports it ${stateText(tor)}); nothing to resume.`;
    if (kind === "app-qbt-pause" && stopped) return `"${tor.name}" is already paused.`;
    if (kind === "app-qbt-recheck" && tor.status === "checking")
      return `"${tor.name}" is already being checked.`;
    if (kind === "app-qbt-reannounce") {
      if (stopped)
        return `"${tor.name}" is paused, and a paused torrent does not talk to trackers. Resume it instead.`;
      if (trackers && realTrackers(trackers).length === 0)
        return `"${tor.name}" has no trackers (it finds peers through DHT only), so there is nothing to ask again.`;
    }
    return undefined;
  }

  private describe(
    kind: ActionKind,
    tor: Torrent,
    serviceName: string,
    trackers?: RawTracker[],
  ): StepChange {
    const name = `"${tor.name}"`;
    switch (kind) {
      case "app-qbt-resume":
        return {
          summary: `Resume the torrent ${name} in ${serviceName}`,
          settings: [{ name: `${tor.name}: state`, before: stateText(tor), after: "Running" }],
        };
      case "app-qbt-pause":
        return {
          summary: `Pause the torrent ${name} in ${serviceName}`,
          settings: [{ name: `${tor.name}: state`, before: stateText(tor), after: "Paused" }],
        };
      case "app-qbt-reannounce":
        return {
          summary: `Ask the trackers again for the torrent ${name} in ${serviceName}`,
          settings: [
            {
              name: `${tor.name}: trackers`,
              before: trackerSummary(trackers ?? []),
              after: "Asked again now",
            },
          ],
        };
      default:
        return {
          summary: `Recheck the files of the torrent ${name} in ${serviceName}`,
          settings: [
            {
              name: `${tor.name}: pieces`,
              before: `${tor.progressPct}% downloaded`,
              after: "Re-verified from disk (it stops transferring while it checks)",
            },
          ],
        };
    }
  }

  async plan(
    kind: ActionKind,
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    if (kind === "app-qbt-manual-sort") {
      try {
        return await this.sorter.plan(service, params, base);
      } catch (error) {
        if (error instanceof PlanRefusedError) throw new PlanError(error.message);
        throw error;
      }
    }
    if (CONTROL_ACTIONS.includes(kind)) {
      try {
        return await planControl(kind, service, params, base, this.sessionFor(service), {
          arrCategories: () => this.arrCategories(),
        });
      } catch (error) {
        if (error instanceof PlanRefused) throw new PlanError(error.message);
        throw error;
      }
    }
    const hash = typeof params?.hash === "string" ? params.hash.trim().toLowerCase() : "";
    if (!HASH.test(hash)) throw new PlanError("Say which torrent by its hash (params.hash).");
    const { tor, trackers } = await this.session(
      service,
      "read",
      "read a torrent for a plan",
      async (q) => {
        const tor = await this.torrent(q, hash);
        const trackers =
          tor && kind === "app-qbt-reannounce" ? await this.trackers(q, hash) : undefined;
        return { tor, trackers };
      },
    );
    if (!tor) throw new PlanError(`${service.name} has no torrent with the hash ${hash}.`);
    if (kind === "app-qbt-remove" || kind === "app-qbt-remove-with-data") {
      const withData = kind === "app-qbt-remove-with-data";
      const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
      const change: StepChange = withData
        ? {
            summary: `Remove the torrent "${tor.name}" from ${service.name} AND DELETE its downloaded data (${gb(tor.downloadedBytes)} downloaded of ${gb(tor.sizeBytes)})`,
            settings: [
              {
                name: `${tor.name}: in ${service.name}`,
                before: `${stateText(tor)}, ${tor.progressPct}%`,
                after: "Removed",
              },
              {
                name: `${tor.name}: downloaded data`,
                before: `${gb(tor.downloadedBytes)} on disk${tor.category ? ` (category ${tor.category})` : ""}`,
                after:
                  "Deleted by qBittorrent. Permanent: not in any recycle bin, and Hearth cannot undo it.",
              },
              {
                name: "Afterwards",
                before: "Radarr or Sonarr may be tracking this download",
                after: "They will see it gone; if the title is monitored they may search again.",
              },
            ],
          }
        : {
            summary: `Remove the torrent "${tor.name}" from ${service.name}, keeping its downloaded data on disk`,
            settings: [
              {
                name: `${tor.name}: in ${service.name}`,
                before: `${stateText(tor)}, ${tor.progressPct}%`,
                after: "Removed",
              },
              {
                name: `${tor.name}: downloaded data`,
                before: `${gb(tor.downloadedBytes)} on disk`,
                after: "Kept as it is",
              },
              {
                name: "Afterwards",
                before: "Radarr or Sonarr may be tracking this download",
                after: "They will see it gone; if the title is monitored they may search again.",
              },
            ],
          };
      return {
        ...base,
        label: change.summary,
        serviceName: service.name,
        params: { hash, torrent: tor.name, state: tor.state, sizeBytes: tor.sizeBytes },
        change,
      };
    }
    const why = this.precondition(kind, tor, trackers);
    if (why) throw new PlanError(why);
    const change = this.describe(kind, tor, service.name, trackers);
    return {
      ...base,
      label: change.summary,
      serviceName: service.name,
      params: { hash, torrent: tor.name, state: tor.state },
      change,
    };
  }

  /** Removes exactly one torrent, re-checked first; with its data only for the destructive kind. */
  private async remove(
    step: StepRun,
    service: { id: string; name: string; localUrl: string; hostId: string },
    hash: string,
    plannedName: string,
    withData: boolean,
  ): Promise<StepOutcome> {
    const outcome = await this.session(
      service,
      "change",
      `remove the torrent "${plannedName}"${withData ? " and its data" : ""} (approved plan)`,
      async (q): Promise<StepOutcome & { verified?: boolean }> => {
        const before = await this.torrent(q, hash);
        if (!before)
          return {
            ok: false,
            stale: true,
            result: `"${plannedName}" is no longer in ${service.name}. Nothing was removed.`,
          };
        if (before.name !== plannedName)
          return {
            ok: false,
            stale: true,
            result: `The torrent with that hash is now named "${before.name}", not "${plannedName}" as approved. Nothing was removed.`,
          };
        const res = await q.post(
          "/api/v2/torrents/delete",
          `hashes=${hash}&deleteFiles=${withData ? "true" : "false"}`,
        );
        if (!res.ok)
          return {
            ok: false,
            result: `${service.name} refused to remove "${plannedName}" (${res.status}). Nothing was removed.`,
          };
        let gone = false;
        for (let i = 0; i < 10 && !gone; i++) {
          await this.wait(500);
          gone = !(await this.torrent(q, hash));
        }
        return {
          ok: gone,
          verified: gone,
          result: gone
            ? withData
              ? `Removed "${plannedName}" from ${service.name} and asked it to delete the downloaded data (${(before.downloadedBytes / 1024 ** 3).toFixed(2)} GB). Verified: ${service.name} no longer lists it. Hearth cannot check the disk itself, so no freed space is claimed.`
              : `Removed "${plannedName}" from ${service.name}; its downloaded data was left on disk. Verified: ${service.name} no longer lists it.`
            : `${service.name} accepted the removal, but still lists "${plannedName}".`,
        };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: step.change?.summary ?? `Remove the torrent "${plannedName}"`,
      target: `service:${service.id}`,
      detail: { hash, torrent: plannedName, deleteData: withData, verified: outcome.ok },
    });
    if (step.incidentId)
      await addTimeline(
        this.handle.db,
        step.incidentId,
        new Date().toISOString(),
        outcome.ok ? "action" : "escalated",
        outcome.result,
      );
    return { ok: outcome.ok, result: outcome.result, ...(outcome.stale ? { stale: true } : {}) };
  }

  /** The wider controls: run, then the audit, the incident, and the journal like the repairs. */
  private async control(
    step: StepRun,
    service: { id: string; name: string; localUrl: string; hostId: string },
    opts: { undo?: boolean },
  ): Promise<StepOutcome> {
    const outcome = await runControl(step, service, this.sessionFor(service), this.wait, opts);
    const summary = step.change?.summary ?? step.kind;
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${opts.undo ? "Put back: " : ""}${summary}`,
      target: `service:${service.id}`,
      detail: { kind: step.kind, verified: outcome.ok, result: outcome.result.slice(0, 500) },
    });
    if (step.incidentId)
      await addTimeline(
        this.handle.db,
        step.incidentId,
        new Date().toISOString(),
        outcome.ok ? "action" : "escalated",
        outcome.result,
      );
    if (outcome.ok && !opts.undo && this.memory) {
      const host = await this.handle.db
        .select()
        .from(t.hosts)
        .where(eq(t.hosts.id, service.hostId))
        .get();
      await this.memory
        .recordSystem(this.handle.db, {
          title: summary,
          body: `${outcome.result} Approved as a step of a plan, then verified by reading ${service.name} back.`,
          happenedAt: new Date().toISOString(),
          machine: host?.name,
          links: [{ label: service.name, ref: `service:${service.id}` }],
        })
        .catch(() => undefined);
    }
    return { ok: outcome.ok, result: outcome.result, ...(outcome.stale ? { stale: true } : {}) };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string; hostId: string },
    opts: { undo?: boolean } = {},
  ): Promise<StepOutcome> {
    if (step.kind === "app-qbt-manual-sort") {
      if (opts.undo)
        return {
          ok: false,
          result: "Not put back automatically: use Undo on each sort, or switch sorting off.",
        };
      return this.sorter.run(step, service);
    }
    if (CONTROL_ACTIONS.includes(step.kind)) return this.control(step, service, opts);
    const hash = String(step.params?.hash ?? "").toLowerCase();
    const plannedName = String(step.params?.torrent ?? "");
    const plannedState = String(step.params?.state ?? "");
    if (!HASH.test(hash) || !plannedName || !step.change)
      return { ok: false, result: "This step has no approved torrent." };
    if (step.kind === "app-qbt-remove" || step.kind === "app-qbt-remove-with-data") {
      if (opts.undo)
        return { ok: false, result: "A removed torrent cannot be put back by Hearth." };
      return this.remove(
        step,
        service,
        hash,
        plannedName,
        step.kind === "app-qbt-remove-with-data",
      );
    }
    const verb = VERB[step.kind];
    if (!verb) return { ok: false, result: "Not a torrent repair." };

    const outcome = await this.session(
      service,
      "change",
      `${verb.present.toLowerCase()} the torrent "${plannedName}" (approved plan)`,
      async (q) => {
        // The target, read again right before anything changes.
        const before = await this.torrent(q, hash);
        if (!before)
          return {
            ok: false,
            stale: true,
            result: `"${plannedName}" is no longer in ${service.name}. Nothing was changed.`,
          };
        if (before.name !== plannedName)
          return {
            ok: false,
            stale: true,
            result: `The torrent with that hash is now named "${before.name}", not "${plannedName}" as approved. Nothing was changed; plan it again.`,
          };
        if (!opts.undo && torrentStatus(before.state, 0) !== torrentStatus(plannedState, 0))
          return {
            ok: false,
            stale: true,
            result: `"${plannedName}" is now ${stateText(before)}, not ${plannedState} as when this plan was approved. Nothing was changed; plan it again.`,
          };
        const trackersBefore =
          step.kind === "app-qbt-reannounce" ? await this.trackers(q, hash) : undefined;
        const why = this.precondition(step.kind, before, trackersBefore);
        if (why) return { ok: false, result: `${why} Nothing was changed.` };
        const propsBefore =
          step.kind === "app-qbt-reannounce"
            ? await q.get<{ reannounce?: number }>(`/api/v2/torrents/properties?hash=${hash}`)
            : undefined;

        // One call, for this hash only. qBittorrent 5 renamed pause/resume to stop/start.
        const body = `hashes=${hash}`;
        let res = await q.post(`/api/v2/torrents/${verb.api[0]}`, body);
        if (res.status === 404 && verb.api[1])
          res = await q.post(`/api/v2/torrents/${verb.api[1]}`, body);
        if (!res.ok)
          return {
            ok: false,
            result: `${service.name} refused to ${verb.present.toLowerCase()} "${plannedName}" (${res.status}). Nothing was changed.`,
          };
        const sentAt = Date.now();

        // Read back until the effect is seen (or the time runs out).
        let after: Torrent | undefined = before;
        let seen = false;
        let trackersAfter: RawTracker[] | undefined;
        const every = step.kind === "app-qbt-recheck" ? 500 : 1000;
        let sawChecking = false;
        for (let i = 0; i < (VERIFY_MS[step.kind] ?? 10_000) / every; i++) {
          await this.wait(every);
          after = await this.torrent(q, hash);
          if (!after) break;
          if (step.kind === "app-qbt-resume") seen = !STOPPED.test(after.state);
          else if (step.kind === "app-qbt-pause") seen = STOPPED.test(after.state);
          else if (step.kind === "app-qbt-recheck") {
            if (after.status === "checking") sawChecking = true;
            seen = sawChecking;
            if (sawChecking && after.status !== "checking") break;
            continue;
          } else {
            trackersAfter = await this.trackers(q, hash);
            const props = await q.get<{ reannounce?: number }>(
              `/api/v2/torrents/properties?hash=${hash}`,
            );
            const elapsed = (Date.now() - sentAt) / 1000;
            const timerReset =
              typeof props.reannounce === "number" &&
              typeof propsBefore?.reannounce === "number" &&
              props.reannounce > propsBefore.reannounce - elapsed + 5;
            const answered = realTrackers(trackersAfter).some((x, i) => {
              const was = realTrackers(trackersBefore ?? [])[i];
              return x.status === 3 || (was && (was.status !== x.status || was.msg !== x.msg));
            });
            seen = timerReset || answered;
          }
          if (seen) break;
        }
        return { before, after, seen, trackersAfter, sawChecking };
      },
    );
    if (typeof outcome.result === "string") return { ok: false, result: outcome.result };

    const { before, after, seen, trackersAfter } = outcome;
    const now = after ? standing(after) : { fixed: false, text: "it disappeared from qBittorrent" };
    let result: string;
    if (!seen) {
      result = `${service.name} accepted the request, but reading it back did not show the effect: ${now.text}. Not verified.`;
    } else if (step.kind === "app-qbt-pause") {
      result = `Paused and verified: ${service.name} reports "${before.name}" ${after ? stateText(after) : "stopped"}.`;
    } else if (step.kind === "app-qbt-recheck") {
      result =
        after?.status === "checking"
          ? `Recheck started and verified: ${service.name} is checking "${before.name}" (${after.progressPct}% so far). It keeps going in qBittorrent; the result is not known yet.`
          : `Recheck finished: "${before.name}" is ${after?.progressPct ?? "?"}% complete on disk (was ${before.progressPct}%); ${now.text}.`;
    } else if (step.kind === "app-qbt-reannounce") {
      result =
        `Trackers asked again and verified they answered: ${trackerSummary(trackersAfter ?? [])}; ${after?.seedsInSwarm ?? 0} seeders reported in the swarm. ${now.fixed ? "" : `As of now, ${now.text}.`}`.trim();
    } else {
      result = `${opts.undo ? "Resumed again" : "Resumed"} and verified it is running; ${now.fixed ? now.text : `but ${now.text}`}.`;
    }

    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${opts.undo ? "Put back: " : ""}${verb.past} the torrent "${before.name}" in ${service.name}`,
      target: `service:${service.id}`,
      detail: {
        torrent: before.name,
        hash,
        before: stateText(before),
        after: after ? stateText(after) : "gone",
        verified: seen,
        fixed: seen && now.fixed,
      },
    });
    if (step.incidentId) {
      await addTimeline(
        this.handle.db,
        step.incidentId,
        new Date().toISOString(),
        seen ? "action" : "escalated",
        result,
      );
    }
    if (seen && this.memory) {
      const host = await this.handle.db
        .select()
        .from(t.hosts)
        .where(eq(t.hosts.id, service.hostId))
        .get();
      await this.memory
        .recordSystem(this.handle.db, {
          title: `${verb.past} the torrent "${before.name}" in ${service.name}`,
          body: `${result} Approved as a step of a plan, then verified by reading ${service.name} back. Before: ${stateText(before)}.`,
          happenedAt: new Date().toISOString(),
          machine: host?.name,
          links: [{ label: service.name, ref: `service:${service.id}` }],
        })
        .catch(() => undefined);
    }
    return { ok: seen, result };
  }
}

const VERB: Record<string, { present: string; past: string; api: [string, string?] }> = {
  "app-qbt-resume": { present: "Resume", past: "Resumed", api: ["start", "resume"] },
  "app-qbt-pause": { present: "Pause", past: "Paused", api: ["stop", "pause"] },
  "app-qbt-reannounce": {
    present: "Reannounce",
    past: "Asked the trackers again for",
    api: ["reannounce"],
  },
  "app-qbt-recheck": { present: "Recheck", past: "Rechecked", api: ["recheck"] },
};
