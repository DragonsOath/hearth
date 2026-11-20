import type { StepParams, SyncthingDashboard } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";

/**
 * Syncthing's panel and controls: each folder (up to date, syncing and how much is left, or
 * stopped by errors, with the files that failed and why), each device (connected, from where,
 * last seen), and rescanning a folder or pausing and resuming a folder or a device. Overriding or
 * reverting a folder (which overwrites other machines' copies) is left out on purpose.
 */

type Method = "GET" | "POST" | "PATCH";

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
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        "X-API-Key": key,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(`Syncthing did not answer at ${base}: ${why}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError("Syncthing refused the API key.");
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

async function get<T>(fetchImpl: Fetch, base: string, key: string, path: string): Promise<T> {
  const r = await call<T>(fetchImpl, base, key, "GET", path);
  if (!r.ok)
    throw new AppUnreachableError(`Syncthing answered ${r.status} for ${path.split("?")[0]}.`);
  return r.data;
}

interface FolderCfg {
  id: string;
  label?: string;
  path?: string;
  type?: string;
  paused?: boolean;
  devices?: { deviceID: string }[];
}
interface DeviceCfg {
  deviceID: string;
  name?: string;
  paused?: boolean;
}
interface DbStatus {
  state?: string;
  globalBytes?: number;
  needBytes?: number;
  needFiles?: number;
  errors?: number;
  pullErrors?: number;
}

const TYPES: Record<string, string> = {
  sendreceive: "send and receive",
  sendonly: "send only",
  receiveonly: "receive only",
  receiveencrypted: "receive encrypted",
};

export async function syncthingDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<SyncthingDashboard> {
  const g = <T>(path: string) => get<T>(fetchImpl, base, key, path);
  const [version, me, folders, devices, conns, stats] = await Promise.all([
    g<{ version?: string }>("/rest/system/version"),
    g<{ myID?: string }>("/rest/system/status"),
    g<FolderCfg[]>("/rest/config/folders"),
    g<DeviceCfg[]>("/rest/config/devices"),
    g<{
      connections?: Record<
        string,
        { connected?: boolean; address?: string; inBytesTotal?: number; outBytesTotal?: number }
      >;
    }>("/rest/system/connections"),
    g<Record<string, { lastSeen?: string }>>("/rest/stats/device").catch(
      () => ({}) as Record<string, { lastSeen?: string }>,
    ),
  ]);
  const names = new Map(devices.map((d) => [d.deviceID, d.name || d.deviceID.slice(0, 7)]));
  const rows = await Promise.all(
    folders.slice(0, 30).map(async (f) => {
      const s = await g<DbStatus>(`/rest/db/status?folder=${encodeURIComponent(f.id)}`).catch(
        () => undefined,
      );
      const errs = (s?.errors ?? 0) + (s?.pullErrors ?? 0);
      const failed = errs
        ? await g<{ errors?: { path?: string; error?: string }[] }>(
            `/rest/folder/errors?folder=${encodeURIComponent(f.id)}&page=1&perpage=5`,
          ).catch(() => ({ errors: [] }))
        : { errors: [] };
      const pct =
        s?.globalBytes && s.globalBytes > 0
          ? Math.round(((s.globalBytes - (s.needBytes ?? 0)) / s.globalBytes) * 100)
          : 100;
      return {
        id: f.id,
        name: f.label || f.id,
        ...(f.path ? { path: f.path } : {}),
        kind: TYPES[f.type ?? ""] ?? f.type ?? "send and receive",
        paused: Boolean(f.paused),
        state: f.paused ? "paused" : (s?.state ?? "unknown"),
        syncedPct: pct,
        needFiles: s?.needFiles ?? 0,
        needMb: Math.round((s?.needBytes ?? 0) / 1024 / 1024),
        sizeGb: Math.round(((s?.globalBytes ?? 0) / 1024 ** 3) * 10) / 10,
        errors: errs,
        failed: (failed.errors ?? []).slice(0, 5).map((e) => ({
          path: String(e.path ?? "").slice(0, 200),
          why: String(e.error ?? "").slice(0, 200),
        })),
        sharedWith: (f.devices ?? [])
          .map((d) => d.deviceID)
          .filter((id) => id !== me.myID)
          .map((id) => names.get(id) ?? id.slice(0, 7)),
      };
    }),
  );
  const others = devices.filter((d) => d.deviceID !== me.myID);
  return {
    app: "syncthing",
    ...(version.version ? { version: version.version.replace(/^v/, "") } : {}),
    folders: rows.sort(
      (a, b) => b.errors - a.errors || b.needMb - a.needMb || a.name.localeCompare(b.name),
    ),
    devices: others.map((d) => {
      const c = conns.connections?.[d.deviceID];
      const seen = stats[d.deviceID]?.lastSeen;
      return {
        id: d.deviceID,
        name: d.name || d.deviceID.slice(0, 7),
        paused: Boolean(d.paused),
        connected: Boolean(c?.connected),
        ...(c?.connected && c.address ? { address: c.address.replace(/^\w+:\/\//, "") } : {}),
        ...(seen && !seen.startsWith("1970") ? { lastSeen: seen } : {}),
      };
    }),
  };
}

export const SYNC_OPS = [
  "rescan",
  "pause-folder",
  "resume-folder",
  "pause-device",
  "resume-device",
] as const;
type Op = (typeof SYNC_OPS)[number];

export class SyncthingOperations {
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
    if (!SYNC_OPS.includes(op)) throw new Error(`Say what to do: ${SYNC_OPS.join(", ")}.`);
    const d = await this.use(service, "read Syncthing", "read", (k) =>
      syncthingDashboard(this.fetchImpl, service.localUrl, k),
    );
    let label: string;
    let target: { id: string; name: string; before: string };
    if (op.endsWith("device")) {
      const dev = d.devices.find((x) => x.id === params?.deviceId);
      if (!dev) throw new Error("Syncthing does not know that device.");
      if (op === "pause-device" && dev.paused) throw new Error(`${dev.name} is already paused.`);
      if (op === "resume-device" && !dev.paused) throw new Error(`${dev.name} is not paused.`);
      label =
        op === "pause-device"
          ? `Pause syncing with ${dev.name} in ${service.name} (nothing is deleted; it catches up when resumed)`
          : `Resume syncing with ${dev.name} in ${service.name}`;
      target = { id: dev.id, name: dev.name, before: dev.paused ? "paused" : "syncing" };
    } else {
      const f = d.folders.find((x) => x.id === params?.folderId);
      if (!f) throw new Error("Syncthing does not have that folder.");
      if (op === "pause-folder" && f.paused) throw new Error(`${f.name} is already paused.`);
      if (op === "resume-folder" && !f.paused) throw new Error(`${f.name} is not paused.`);
      if (op === "rescan" && f.paused) throw new Error(`${f.name} is paused; resume it to rescan.`);
      label = {
        rescan: `Rescan ${f.name} in ${service.name} so Syncthing notices changed files now`,
        "pause-folder": `Pause the folder ${f.name} in ${service.name} (nothing is deleted)`,
        "resume-folder": `Resume the folder ${f.name} in ${service.name}`,
      }[op as "rescan" | "pause-folder" | "resume-folder"];
      target = { id: f.id, name: f.name, before: f.state };
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: {
        op,
        name: target.name,
        ...(op.endsWith("device") ? { deviceId: target.id } : { folderId: target.id }),
      },
      change: {
        summary: label,
        settings: [{ name: target.name, before: target.before, after: op }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const name = String(p.name || "it");
    const folder = encodeURIComponent(String(p.folderId ?? ""));
    const device = encodeURIComponent(String(p.deviceId ?? ""));
    const outcome = await this.use(
      service,
      `${op} in Syncthing`,
      "change",
      async (key): Promise<StepOutcome> => {
        const base = service.localUrl;
        const c = (method: Method, path: string, body?: unknown) =>
          call<unknown>(this.fetchImpl, base, key, method, path, body);
        const r =
          op === "rescan"
            ? await c("POST", `/rest/db/scan?folder=${folder}`)
            : op.endsWith("folder")
              ? await c("PATCH", `/rest/config/folders/${folder}`, {
                  paused: op === "pause-folder",
                })
              : await c("PATCH", `/rest/config/devices/${device}`, {
                  paused: op === "pause-device",
                });
        if (!r.ok) return { ok: false, result: `Syncthing refused it (${r.status}).` };
        if (op === "rescan") return { ok: true, result: `Syncthing is rescanning ${name}.` };
        const d = await syncthingDashboard(this.fetchImpl, base, key);
        const now = op.endsWith("folder")
          ? d.folders.find((f) => f.id === p.folderId)?.paused
          : d.devices.find((x) => x.id === p.deviceId)?.paused;
        const want = op.startsWith("pause");
        return now === want
          ? {
              ok: true,
              result: `${name} is ${want ? "paused" : "syncing again"}. Syncthing confirms it.`,
            }
          : { ok: false, result: `Syncthing answered, but ${name} does not show it yet.` };
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
