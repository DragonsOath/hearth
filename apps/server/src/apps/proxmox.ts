import type {
  AppReport,
  ProxmoxBackupFile,
  ProxmoxDashboard,
  ProxmoxGuest,
  ProxmoxTask,
} from "@dragon-control/core";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * Proxmox VE, through its REST API (/api2/json), with an API token from the vault
 * (user@realm!tokenid=secret, sent as "Authorization: PVEAPIToken=…"). Routes and answers follow
 * Proxmox's own API code (pve-manager, qemu-server, pve-container, pve-storage on GitHub); no
 * real Proxmox could be run here, so the panel is marked as not yet checked against a real one.
 *
 * Proxmox answers on HTTPS with its own self-signed certificate: the server reaches it through
 * localTlsFetch, which pins that certificate. The token never leaves this file.
 */

export class ProxmoxError extends Error {}

/** A Proxmox API token, as Proxmox shows it: user@realm!tokenid=secret. */
export const TOKEN = /^[^\s@!=]+@[^\s@!=]+![^\s@!=]+=[^\s]+$/;

type Method = "GET" | "POST" | "DELETE";

export class ProxmoxClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch,
  ) {
    if (!TOKEN.test(token))
      throw new AppKeyError(
        "That is not a Proxmox API token: it looks like user@realm!tokenid=secret.",
      );
  }

  async call<T>(
    method: Method,
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = TIMEOUT_MS,
  ): Promise<T> {
    let res: Awaited<ReturnType<Fetch>>;
    // Proxmox takes form fields for changes.
    const form = body
      ? new URLSearchParams(
          Object.entries(body)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : undefined;
    try {
      res = await this.fetchImpl(joinUrl(this.base, `/api2/json${path}`), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `PVEAPIToken=${this.token}`,
          ...(form !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(form !== undefined ? { body: form } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new AppUnreachableError(
        `Proxmox did not answer at ${this.base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (res.status === 401)
      throw new AppKeyError("Proxmox refused the API token. Check it in the vault.");
    const text = (await res.text?.()) ?? "";
    let json: { data?: T; errors?: Record<string, string>; message?: string } = {};
    try {
      json = text ? (JSON.parse(text) as typeof json) : {};
    } catch {
      /* Proxmox answers errors as text at times. */
    }
    if (res.status === 403)
      throw new ProxmoxError(
        `The API token may not do that (${path.split("?")[0]}): give it the role it needs in Proxmox.`,
      );
    if (!res.ok) {
      const why = json.errors
        ? Object.entries(json.errors)
            .map(([k, v]) => `${k}: ${String(v).trim()}`)
            .join("; ")
        : (json.message ?? text).trim();
      throw new ProxmoxError(`Proxmox said: ${why.slice(0, 300) || res.status}`);
    }
    return json.data as T;
  }
}

interface RawResource {
  id: string;
  type: "node" | "qemu" | "lxc" | "storage" | "sdn" | "pool";
  node?: string;
  status?: string;
  name?: string;
  vmid?: number;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
  template?: number;
  tags?: string;
  lock?: string;
  storage?: string;
  plugintype?: string;
  shared?: number;
  content?: string;
}

interface RawTask {
  upid: string;
  node: string;
  type: string;
  id?: string;
  user: string;
  starttime: number;
  endtime?: number;
  status?: string;
}

const iso = (sec?: number) => (sec ? new Date(sec * 1000).toISOString() : undefined);
const pct = (x?: number) => Math.round((x ?? 0) * 1000) / 10;

const STATUS: Record<string, ProxmoxGuest["status"]> = {
  running: "running",
  stopped: "stopped",
  paused: "paused",
  suspended: "paused",
};

export const toGuest = (r: RawResource): ProxmoxGuest => ({
  id: r.id,
  kind: r.type === "lxc" ? "container" : "vm",
  vmid: r.vmid ?? Number(r.id.split("/")[1]),
  name: r.name ?? `${r.type === "lxc" ? "CT" : "VM"} ${r.vmid}`,
  node: r.node ?? "",
  status: STATUS[r.status ?? ""] ?? "unknown",
  cpuPct: pct(r.cpu),
  cpus: r.maxcpu ?? 0,
  memUsed: r.mem ?? 0,
  memTotal: r.maxmem ?? 0,
  diskTotal: r.maxdisk ?? 0,
  uptimeSec: r.uptime ?? 0,
  template: r.template === 1,
  tags: (r.tags ?? "").split(/[;,\s]+/).filter(Boolean),
  ...(r.lock ? { lock: r.lock } : {}),
});

/** Proxmox's task types, in plain words. */
const TASK: Record<string, string> = {
  vzdump: "Backup",
  qmstart: "Start",
  qmstop: "Stop (forced)",
  qmshutdown: "Shut down",
  qmreboot: "Restart",
  qmsuspend: "Pause",
  qmresume: "Resume",
  qmsnapshot: "Snapshot",
  qmdelsnapshot: "Delete snapshot",
  qmrollback: "Roll back to a snapshot",
  qmclone: "Clone",
  qmcreate: "Create VM",
  qmdestroy: "Delete VM",
  qmigrate: "Migrate",
  vzstart: "Start",
  vzstop: "Stop (forced)",
  vzshutdown: "Shut down",
  vzreboot: "Restart",
  vzsnapshot: "Snapshot",
  vzcreate: "Create container",
  vzdestroy: "Delete container",
  vzmigrate: "Migrate",
  aptupdate: "Check for updates",
  imgcopy: "Copy disk",
  download: "Download",
  startall: "Start everything",
  stopall: "Stop everything",
};

export const toTask = (t: RawTask): ProxmoxTask => {
  const vmid = t.id && /^\d+$/.test(t.id) ? Number(t.id) : undefined;
  const done = t.endtime !== undefined && t.status !== undefined && t.status !== "running";
  return {
    upid: t.upid,
    node: t.node,
    what: TASK[t.type] ?? t.type,
    ...(vmid !== undefined ? { vmid } : {}),
    user: t.user,
    started: iso(t.starttime)!,
    ...(done ? { ended: iso(t.endtime)!, ok: t.status === "OK" } : {}),
    ...(done && t.status !== "OK" ? { error: String(t.status).slice(0, 300) } : {}),
  };
};

interface RawJob {
  id: string;
  schedule?: string;
  starttime?: string;
  dow?: string;
  enabled?: number;
  storage?: string;
  all?: number;
  vmid?: string;
  mode?: string;
}

interface RawContent {
  volid: string;
  vmid?: number;
  ctime?: number;
  size?: number;
  notes?: string;
  protected?: number;
  content: string;
}

/** Every backup file on the storages that hold backups (each shared storage read once). */
async function backupFiles(
  c: ProxmoxClient,
  storage: ProxmoxDashboard["storage"],
): Promise<ProxmoxBackupFile[]> {
  const seen = new Set<string>();
  const places = storage.filter((s) => {
    if (!s.active || !s.content.includes("backup")) return false;
    const key = s.shared ? s.id : `${s.node}/${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lists = await Promise.all(
    places.map((s) =>
      c
        .call<RawContent[]>(
          "GET",
          `/nodes/${encodeURIComponent(s.node)}/storage/${encodeURIComponent(s.id)}/content?content=backup`,
        )
        .then((files) =>
          files.map((f) => ({
            volid: f.volid,
            vmid: f.vmid ?? 0,
            node: s.node,
            storage: s.id,
            at: iso(f.ctime) ?? new Date(0).toISOString(),
            sizeBytes: f.size ?? 0,
            ...(f.notes ? { notes: f.notes.slice(0, 200) } : {}),
            protected: f.protected === 1,
          })),
        )
        .catch(() => [] as ProxmoxBackupFile[]),
    ),
  );
  return lists.flat().sort((a, b) => b.at.localeCompare(a.at));
}

/** The panel's live read: nodes, guests, storage, backups and tasks, in one pass. */
export async function proxmoxDashboard(c: ProxmoxClient): Promise<ProxmoxDashboard> {
  const [version, resources, jobs, tasks] = await Promise.all([
    c.call<{ version: string; release?: string }>("GET", "/version"),
    c.call<RawResource[]>("GET", "/cluster/resources"),
    c.call<RawJob[]>("GET", "/cluster/backup").catch(() => [] as RawJob[]),
    c.call<RawTask[]>("GET", "/cluster/tasks").catch(() => [] as RawTask[]),
  ]);
  const nodes = resources.filter((r) => r.type === "node");
  const updates = await Promise.all(
    nodes.map((n) =>
      n.status === "online"
        ? c
            .call<unknown[]>("GET", `/nodes/${encodeURIComponent(n.node!)}/apt/update`)
            .then((l) => l.length)
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ),
  );
  const storage = resources
    .filter((r) => r.type === "storage")
    .map((r) => ({
      id: r.storage ?? r.id.split("/").pop()!,
      node: r.node ?? "",
      type: r.plugintype ?? "",
      shared: r.shared === 1,
      active: r.status === "available",
      usedBytes: r.disk ?? 0,
      totalBytes: r.maxdisk ?? 0,
      content: (r.content ?? "").split(",").filter(Boolean),
    }));
  const backups = await backupFiles(c, storage);
  const last = new Map<number, string>();
  for (const b of backups) if (!last.has(b.vmid)) last.set(b.vmid, b.at);
  return {
    app: "proxmox",
    ...(version.version ? { version: version.version } : {}),
    nodes: nodes.map((n, i) => ({
      name: n.node ?? n.id,
      online: n.status === "online",
      cpuPct: pct(n.cpu),
      cpus: n.maxcpu ?? 0,
      memUsed: n.mem ?? 0,
      memTotal: n.maxmem ?? 0,
      diskUsed: n.disk ?? 0,
      diskTotal: n.maxdisk ?? 0,
      uptimeSec: n.uptime ?? 0,
      ...(updates[i] !== undefined ? { updates: updates[i]! } : {}),
    })),
    guests: resources
      .filter((r) => r.type === "qemu" || r.type === "lxc")
      .map((r) => {
        const g = toGuest(r);
        const at = last.get(g.vmid);
        return at ? { ...g, lastBackup: at } : g;
      })
      .sort((a, b) => a.vmid - b.vmid),
    storage,
    backupJobs: jobs.map((j) => ({
      id: j.id,
      schedule: j.schedule ?? [j.dow, j.starttime].filter(Boolean).join(" "),
      enabled: j.enabled !== 0,
      storage: j.storage ?? "",
      guests:
        j.all === 1
          ? "all"
          : (j.vmid ?? "")
              .split(",")
              .map(Number)
              .filter((x) => x > 0),
      mode: j.mode ?? "snapshot",
    })),
    backups: backups.slice(0, 300),
    tasks: tasks
      .slice()
      .sort((a, b) => b.starttime - a.starttime)
      .slice(0, 30)
      .map(toTask),
  };
}

const DAY = 86_400_000;

/** The health check: nodes online, guests running, failed tasks, full storage. */
export async function readProxmox(
  base: string,
  token: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await proxmoxDashboard(new ProxmoxClient(base, token, fetchImpl));
  const issues: AppReport["issues"] = [];
  const down = d.nodes.filter((n) => !n.online);
  if (down.length)
    issues.push({
      level: "error",
      key: "node-offline",
      text: `${down.map((n) => n.name).join(", ")} ${down.length === 1 ? "is" : "are"} offline.`,
    });
  const failed = d.tasks.filter((t) => t.ok === false && Date.now() - Date.parse(t.started) < DAY);
  const failedBackups = failed.filter((t) => t.what === "Backup");
  if (failedBackups.length)
    issues.push({
      level: "warning",
      key: "backup-failed",
      text: `${failedBackups.length} ${failedBackups.length === 1 ? "backup" : "backups"} failed in the last day.`,
    });
  const full = d.storage.filter(
    (s) => s.active && s.totalBytes && s.usedBytes / s.totalBytes > 0.9,
  );
  if (full.length)
    issues.push({
      level: "warning",
      key: "storage-full",
      text: `${full.map((s) => s.id).join(", ")} ${full.length === 1 ? "is" : "are"} over 90% full.`,
    });
  const guests = d.guests.filter((g) => !g.template);
  return {
    app: "proxmox",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Nodes", value: `${d.nodes.length - down.length} of ${d.nodes.length} online` },
      {
        label: "Running",
        value: `${guests.filter((g) => g.status === "running").length} of ${guests.length} VMs and containers`,
      },
      { label: "Failed tasks, 24 hours", value: String(failed.length) },
    ],
  };
}

/** Which guest an id names, read fresh (null: it is not there). */
export async function guestNow(c: ProxmoxClient, id: string): Promise<ProxmoxGuest | null> {
  const all = await c.call<RawResource[]>("GET", "/cluster/resources?type=vm");
  const r = all.find((x) => x.id === id);
  return r ? toGuest(r) : null;
}

/** Waits for a task to finish (or the time to run out): its exit status, or undefined if still running. */
export async function waitTask(
  c: ProxmoxClient,
  node: string,
  upid: string,
  ms: number,
  wait = (t: number) => new Promise((r) => setTimeout(r, t)),
): Promise<string | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await c.call<{ status: string; exitstatus?: string }>(
      "GET",
      `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
    );
    if (s.status === "stopped") return s.exitstatus ?? "unknown";
    if (Date.now() >= end) return undefined;
    await wait(1000);
  }
}
