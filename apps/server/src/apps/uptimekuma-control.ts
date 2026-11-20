import type { KumaDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { cleanUrl, KumaError, kumaDashboard, withKuma, type KumaLogin } from "./uptimekuma";

/**
 * Changes in Uptime Kuma, each a plan the owner approves (app-uptimekuma-control, params.op): pause
 * or resume a monitor, add a website monitor (an http address, checked every so many seconds),
 * remove a monitor, and pause or resume a maintenance window. Each is read back from Uptime Kuma.
 * Hearth never edits a monitor's other settings, notifications, status pages or users: those stay
 * in Uptime Kuma, and their settings can hold passwords.
 */

export const KUMA_OPS = [
  "pause",
  "resume",
  "add",
  "remove",
  "maintenance-pause",
  "maintenance-resume",
] as const;
export type KumaOp = (typeof KUMA_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

type Ack = { ok?: boolean; msg?: string; monitorID?: number };

export class KumaOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (login: KumaLogin) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) => fn({ username: username ?? "", password: value }),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as KumaOp;
    if (!KUMA_OPS.includes(op)) throw new Error(`Say what to do: ${KUMA_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Uptime Kuma", "read", async (login) =>
      planKuma(
        await kumaDashboard(this.fetchImpl, service.localUrl, login),
        service.name,
        op,
        params ?? {},
        base,
      ),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Uptime Kuma", "change", (login) =>
        runKuma(this.fetchImpl, service.localUrl, login, p),
      );
    } catch (error) {
      if (!(error instanceof KumaError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: {
        op: p.op,
        ok: out.ok,
        monitorId: p.monitorId ?? null,
        maintenanceId: p.maintenanceId ?? null,
      },
    });
    return out;
  }

  /** Undoes a pause or resume, and removes a monitor a failed later step added. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const back: Partial<Record<KumaOp, KumaOp>> = {
      pause: "resume",
      resume: "pause",
      "maintenance-pause": "maintenance-resume",
      "maintenance-resume": "maintenance-pause",
    };
    const op = back[String(p.op) as KumaOp];
    return this.use(service, "undo a change in Uptime Kuma", "change", async (login) => {
      if (op) return runKuma(this.fetchImpl, service.localUrl, login, { ...p, op });
      if (p.op !== "add") return undefined;
      // The monitor this plan added, found by its name and address.
      const d = await kumaDashboard(this.fetchImpl, service.localUrl, login);
      const m = d.monitors.find((x) => x.name === p.name && x.target === cleanUrl(String(p.url)));
      if (!m) return undefined;
      return runKuma(this.fetchImpl, service.localUrl, login, {
        op: "remove",
        monitorId: m.id,
        name: m.name,
      });
    });
  }
}

const INTERVAL_MIN = 20;
const INTERVAL_MAX = 86_400;

export function planKuma(
  d: KumaDashboard,
  name: string,
  op: KumaOp,
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams,
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: label, settings: [setting] },
  });

  if (op === "maintenance-pause" || op === "maintenance-resume") {
    const id = Number(p.maintenanceId);
    const w = d.maintenance.find((x) => x.id === id);
    if (!w) throw new Error(`${name} has no such maintenance window: read the panel again.`);
    const on = op === "maintenance-resume";
    if (w.active === on) throw new Error(`${w.title} is already ${on ? "on" : "paused"}.`);
    return step(
      `${on ? "Resume" : "Pause"} the maintenance window ${w.title}`,
      { name: w.title, before: w.status, after: on ? "on (as scheduled)" : "paused" },
      { maintenanceId: id, name: w.title },
    );
  }

  if (op === "add") {
    const label = String(p.name ?? "").trim();
    const url = String(p.url ?? "").trim();
    if (!label || label.length > 120) throw new Error("Give the monitor a name.");
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("Give an address to check, starting http:// or https://.");
    }
    if (!/^https?:$/.test(u.protocol))
      throw new Error("Give an address to check, starting http:// or https://.");
    if (u.username || u.password)
      throw new Error("Leave the password out of the address: add a login in Uptime Kuma itself.");
    const interval = p.interval === undefined || p.interval === "" ? 60 : Number(p.interval);
    if (!Number.isInteger(interval) || interval < INTERVAL_MIN || interval > INTERVAL_MAX)
      throw new Error(`Check every ${INTERVAL_MIN} to ${INTERVAL_MAX} seconds.`);
    const clean = cleanUrl(url)!;
    const same = d.monitors.find((m) => m.target === clean);
    if (same) throw new Error(`${same.name} already checks ${clean}.`);
    return step(
      `Add a monitor ${label} that checks ${clean} every ${interval} seconds`,
      { name: label, before: "not watched", after: `checked every ${interval} s` },
      { name: label, url, interval },
    );
  }

  const id = Number(p.monitorId);
  const m = d.monitors.find((x) => x.id === id);
  if (!m) throw new Error(`${name} has no such monitor: read the panel again.`);
  if (op === "remove") {
    const kids = d.monitors.filter((x) => x.parentId === m.id).length;
    return step(
      `Remove the monitor ${m.name} and its history${kids ? ` (its ${kids} monitors stay, out of the group)` : ""}`,
      { name: m.name, before: m.status, after: "removed" },
      { monitorId: id, name: m.name },
    );
  }
  const on = op === "resume";
  if ((m.status === "paused") !== on)
    throw new Error(`${m.name} is already ${on ? "running" : "paused"}.`);
  return step(
    `${on ? "Resume" : "Pause"} the monitor ${m.name}${on ? "" : " (it stops checking and sends no alerts)"}`,
    { name: m.name, before: m.status, after: on ? "checking" : "paused" },
    { monitorId: id, name: m.name },
  );
}

/** The new monitor's settings: a plain http check, as Uptime Kuma's own form fills it in. */
export function newMonitor(p: StepParams, major: number) {
  return {
    type: "http",
    name: String(p.name),
    url: String(p.url),
    method: "GET",
    interval: Number(p.interval ?? 60),
    retryInterval: Number(p.interval ?? 60),
    resendInterval: 0,
    maxretries: 1,
    timeout: Math.min(48, Math.round(Number(p.interval ?? 60) * 0.8)),
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    expiryNotification: false,
    ignoreTls: false,
    upsideDown: false,
    notificationIDList: {},
    active: true,
    // 2.x stores these as JSON and needs them present; 1.x has no such columns.
    ...(major >= 2
      ? {
          conditions: [],
          kafkaProducerBrokers: [],
          kafkaProducerSaslOptions: {},
          rabbitmqNodes: [],
        }
      : {}),
  };
}

export async function runKuma(
  fetchImpl: Fetch,
  base: string,
  login: KumaLogin,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as KumaOp;
  const before = await kumaDashboard(fetchImpl, base, login);
  const label = String(p.name ?? "");

  if (op === "maintenance-pause" || op === "maintenance-resume") {
    const id = Number(p.maintenanceId);
    const w = before.maintenance.find((x) => x.id === id);
    if (!w) return { ok: false, stale: true, result: `${label} is no longer in Uptime Kuma.` };
    const on = op === "maintenance-resume";
    if (w.active === on)
      return { ok: false, stale: true, result: `${w.title} was already ${on ? "on" : "paused"}.` };
    await withKuma(fetchImpl, base, login, async (s) => {
      const r = await s.ask<Ack>(on ? "resumeMaintenance" : "pauseMaintenance", [id]);
      if (!r?.ok) throw new KumaError(`Uptime Kuma did not do it: ${r?.msg ?? "no reason given"}.`);
    });
    const after = (await kumaDashboard(fetchImpl, base, login)).maintenance.find(
      (x) => x.id === id,
    );
    const ok = after?.active === on;
    return {
      ok,
      verified: ok,
      result: ok
        ? `${w.title} is ${on ? `on (${after!.status})` : "paused"}.`
        : `${w.title} reads ${after?.status ?? "missing"} afterwards.`,
    };
  }

  if (op === "add") {
    const clean = cleanUrl(String(p.url));
    const same = before.monitors.find((m) => m.target === clean);
    if (same)
      return { ok: false, stale: true, result: `${same.name} already checks ${clean ?? ""}.` };
    const id = await withKuma(fetchImpl, base, login, async (s, major) => {
      const r = await s.ask<Ack>("add", [newMonitor(p, major)]);
      if (!r?.ok || !r.monitorID)
        throw new KumaError(`Uptime Kuma did not add it: ${r?.msg ?? "no reason given"}.`);
      return r.monitorID;
    });
    const m = (await kumaDashboard(fetchImpl, base, login)).monitors.find((x) => x.id === id);
    const ok = Boolean(m && m.target === clean && m.status !== "paused");
    return {
      ok,
      verified: ok,
      result: ok
        ? `${m!.name} is added and checks ${clean ?? ""} every ${m!.intervalSeconds} seconds.`
        : `Uptime Kuma answered, but the new monitor does not read back as planned.`,
    };
  }

  const id = Number(p.monitorId);
  const m = before.monitors.find((x) => x.id === id);
  if (!m) return { ok: false, stale: true, result: `${label} is no longer in Uptime Kuma.` };

  if (op === "remove") {
    await withKuma(fetchImpl, base, login, async (s, major) => {
      // 2.x asks whether to remove a group's monitors too: never, they stay.
      const r = await s.ask<Ack>("deleteMonitor", major >= 2 ? [id, false] : [id]);
      if (!r?.ok)
        throw new KumaError(`Uptime Kuma did not remove it: ${r?.msg ?? "no reason given"}.`);
    });
    const gone = !(await kumaDashboard(fetchImpl, base, login)).monitors.some((x) => x.id === id);
    return {
      ok: gone,
      verified: gone,
      result: gone ? `${m.name} is removed.` : `${m.name} is still listed afterwards.`,
    };
  }

  const on = op === "resume";
  if ((m.status === "paused") !== on)
    return {
      ok: false,
      stale: true,
      result: `${m.name} was already ${on ? "running" : "paused"}; nothing changed.`,
    };
  await withKuma(fetchImpl, base, login, async (s) => {
    const r = await s.ask<Ack>(on ? "resumeMonitor" : "pauseMonitor", [id]);
    if (!r?.ok) throw new KumaError(`Uptime Kuma did not do it: ${r?.msg ?? "no reason given"}.`);
  });
  const after = (await kumaDashboard(fetchImpl, base, login)).monitors.find((x) => x.id === id);
  const ok = on ? Boolean(after && after.status !== "paused") : after?.status === "paused";
  return {
    ok,
    verified: ok,
    result: ok
      ? on
        ? `${m.name} is checking again.`
        : `${m.name} is paused.`
      : `${m.name} reads ${after?.status ?? "missing"} afterwards.`,
  };
}
