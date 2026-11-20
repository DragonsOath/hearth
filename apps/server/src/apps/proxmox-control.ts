import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { guestNow, ProxmoxClient, ProxmoxError, waitTask } from "./proxmox";

/**
 * Changes to Proxmox VE, each a plan the owner approves (app-proxmox-control, params.op), carried
 * out through its API and read back: start, shut down, restart or force-stop a VM or container,
 * back one up now, and take a snapshot. Each waits for Proxmox's own task to finish and reads the
 * guest's state afterwards. Never deleting a guest, its disks or a backup, rolling back to a
 * snapshot, migrating, or changing hardware or network settings: those stay in Proxmox.
 */

export const PROXMOX_OPS = ["start", "shutdown", "reboot", "stop", "backup", "snapshot"] as const;
export type ProxmoxOp = (typeof PROXMOX_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

/** "qemu/100" or "lxc/200". */
const GUEST = /^(qemu|lxc)\/(\d{2,9})$/;
/** Proxmox's snapshot names: a letter first, then letters, digits, - and _. */
const SNAP = /^[a-zA-Z][a-zA-Z0-9_-]{1,39}$/;

/** How long each kind of task may take before Hearth stops waiting and says so. */
const WAIT: Record<ProxmoxOp, number> = {
  start: 60_000,
  shutdown: 180_000,
  reboot: 180_000,
  stop: 60_000,
  backup: 10 * 60_000,
  snapshot: 120_000,
};

export class ProxmoxOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    /** Waiting between task checks (tests pass a no-op). */
    private readonly wait?: (ms: number) => Promise<void>,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (c: ProxmoxClient) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(new ProxmoxClient(service.localUrl, value, this.fetchImpl)),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as ProxmoxOp;
    if (!PROXMOX_OPS.includes(op)) throw new Error(`Say what to do: ${PROXMOX_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Proxmox", "read", (c) =>
      planProxmox(c, service.name, op, params ?? {}, base),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Proxmox", "change", (c) =>
        runProxmox(c, service.name, p, this.wait),
      );
    } catch (error) {
      if (!(error instanceof ProxmoxError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, guest: p.guest ?? null },
    });
    return out;
  }

  /** Starts a guest that a later step's failure should not leave stopped, and the other way round. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const back: Partial<Record<ProxmoxOp, ProxmoxOp>> = {
      start: "shutdown",
      shutdown: "start",
      stop: "start",
    };
    const op = back[String(p.op) as ProxmoxOp];
    if (!op) return undefined;
    return this.use(service, "undo a change in Proxmox", "change", (c) =>
      runProxmox(c, service.name, { ...p, op }, this.wait),
    );
  }
}

const KIND_WORD = (id: string) => (id.startsWith("lxc/") ? "container" : "VM");

export async function planProxmox(
  c: ProxmoxClient,
  name: string,
  op: ProxmoxOp,
  p: StepParams,
  base: PlannedStep,
): Promise<PlannedStep> {
  const id = String(p.guest ?? "");
  if (!GUEST.test(id)) throw new Error("Say which VM or container, as qemu/100 or lxc/200.");
  const g = await guestNow(c, id);
  if (!g) throw new Error(`${name} has no ${id}.`);
  const who = `${KIND_WORD(id)} ${g.vmid} (${g.name})`;
  if (g.template) throw new Error(`${who} is a template: it does not run.`);
  if (g.lock && op !== "backup")
    throw new Error(`${who} is locked by Proxmox (${g.lock}): wait for that task to finish.`);
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams = {},
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, guest: id, node: g.node, ...extra },
    change: { summary: label, settings: [setting] },
  });

  if (op === "start") {
    if (g.status === "running") throw new Error(`${who} is already running.`);
    return step(`Start ${who} on ${g.node}`, { name: who, before: g.status, after: "running" });
  }
  if (op === "shutdown" || op === "reboot" || op === "stop") {
    if (g.status !== "running") throw new Error(`${who} is not running.`);
    const label =
      op === "shutdown"
        ? `Shut down ${who} (asks it to shut down cleanly)`
        : op === "reboot"
          ? `Restart ${who}`
          : `Force-stop ${who} (like pulling the plug: unsaved work inside is lost)`;
    return step(label, {
      name: who,
      before: "running",
      after: op === "reboot" ? "running again" : "stopped",
    });
  }
  if (op === "backup") {
    const storage = String(p.storage ?? "");
    const all = await c.call<
      { storage: string; content: string; active?: number; enabled?: number }[]
    >("GET", `/nodes/${encodeURIComponent(g.node)}/storage?content=backup`);
    const usable = all.filter((s) => s.active !== 0 && s.enabled !== 0).map((s) => s.storage);
    if (!usable.length) throw new Error(`${g.node} has no storage that holds backups.`);
    if (storage && !usable.includes(storage))
      throw new Error(`${storage} does not hold backups on ${g.node}: use ${usable.join(", ")}.`);
    const to = storage || usable[0]!;
    return step(
      `Back up ${who} to ${to} now`,
      {
        name: `${who} backup`,
        before: g.lastBackup ? `last ${g.lastBackup.slice(0, 10)}` : "none",
        after: `a new one on ${to}`,
      },
      { storage: to },
    );
  }
  // snapshot
  const snap =
    String(p.name ?? "").trim() ||
    `hearth-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  if (!SNAP.test(snap))
    throw new Error(
      "A snapshot name starts with a letter, then letters, digits, - and _ (at most 40).",
    );
  const kind = id.startsWith("lxc/") ? "lxc" : "qemu";
  const snaps = await c.call<{ name: string }[]>(
    "GET",
    `/nodes/${encodeURIComponent(g.node)}/${kind}/${g.vmid}/snapshot`,
  );
  if (snaps.some((s) => s.name === snap)) throw new Error(`${who} already has a snapshot ${snap}.`);
  return step(
    `Take a snapshot ${snap} of ${who}`,
    {
      name: `${who} snapshots`,
      before: `${snaps.filter((s) => s.name !== "current").length}`,
      after: `plus ${snap}`,
    },
    { name: snap },
  );
}

export async function runProxmox(
  c: ProxmoxClient,
  name: string,
  p: StepParams,
  wait?: (ms: number) => Promise<void>,
): Promise<StepOutcome> {
  const op = String(p.op) as ProxmoxOp;
  const id = String(p.guest);
  const [kind, vmid] = id.split("/") as ["qemu" | "lxc", string];
  const g = await guestNow(c, id);
  if (!g) return { ok: false, stale: true, result: `${id} is no longer in ${name}.` };
  const who = `${KIND_WORD(id)} ${g.vmid} (${g.name})`;
  const node = g.node;
  const path = `/nodes/${encodeURIComponent(node)}/${kind}/${vmid}`;

  if (op === "start" && g.status === "running")
    return { ok: false, stale: true, result: `${who} was already running; nothing changed.` };
  if ((op === "shutdown" || op === "reboot" || op === "stop") && g.status !== "running")
    return { ok: false, stale: true, result: `${who} was not running; nothing changed.` };

  let upid: string;
  if (op === "backup")
    upid = await c.call<string>("POST", `/nodes/${encodeURIComponent(node)}/vzdump`, {
      vmid,
      storage: String(p.storage),
      mode: "snapshot",
      compress: "zstd",
    });
  else if (op === "snapshot")
    upid = await c.call<string>("POST", `${path}/snapshot`, {
      snapname: String(p.name),
      description: "Taken from Hearth",
    });
  else upid = await c.call<string>("POST", `${path}/status/${op}`, {});

  const exit = await waitTask(c, node, upid, WAIT[op], wait);
  if (exit === undefined)
    return {
      ok: true,
      result: `Proxmox is still working on it (${op === "backup" ? "backups can take a while" : "it is taking longer than usual"}); its tasks list shows when it ends.`,
    };
  if (exit !== "OK") return { ok: false, result: `Proxmox's task ended: ${exit.slice(0, 300)}` };

  const after = await guestNow(c, id);
  if (op === "backup" || op === "snapshot") {
    if (op === "snapshot") {
      const snaps = await c.call<{ name: string }[]>("GET", `${path}/snapshot`);
      const ok = snaps.some((s) => s.name === String(p.name));
      return {
        ok,
        verified: ok,
        result: ok
          ? `${who} has the snapshot ${String(p.name)}.`
          : "The snapshot is not listed afterwards.",
      };
    }
    const files = await c.call<{ vmid?: number; ctime?: number }[]>(
      "GET",
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(String(p.storage))}/content?content=backup`,
    );
    const newest = Math.max(0, ...files.filter((f) => f.vmid === g.vmid).map((f) => f.ctime ?? 0));
    const ok = Date.now() / 1000 - newest < 24 * 3600;
    return {
      ok,
      verified: ok,
      result: ok
        ? `${who} is backed up to ${String(p.storage)}.`
        : "Proxmox finished, but no new backup file is listed.",
    };
  }
  const want = op === "shutdown" || op === "stop" ? "stopped" : "running";
  const ok = after?.status === want;
  return {
    ok,
    verified: ok,
    result: ok
      ? `${who} is ${op === "reboot" ? "running again" : want}.`
      : `${who} reads ${after?.status ?? "missing"} afterwards.`,
  };
}
