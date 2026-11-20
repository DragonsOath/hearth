import type { FrigateDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { fr, frigateDashboard, FrigateError, type FrigateLogin } from "./frigate";
import type { Fetch } from "./http";

/**
 * Changes in Frigate, each a plan the owner approves (app-frigate-control, params.op): turn a
 * camera's detection or recording on or off, keep an event forever or stop keeping it, delete an
 * event, and restart Frigate. Detection is read back from Frigate's live stats, events from its
 * event list, a restart by Frigate answering again. Recording reports Frigate's answer: Frigate does
 * not list that live state. Cameras, zones and masks stay in Frigate's config.
 */

export const FRIGATE_OPS = [
  "detect-on",
  "detect-off",
  "record-on",
  "record-off",
  "event-keep",
  "event-unkeep",
  "event-delete",
  "restart",
] as const;
export type FrigateOp = (typeof FRIGATE_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

const OPPOSITE: Partial<Record<FrigateOp, FrigateOp>> = {
  "detect-on": "detect-off",
  "detect-off": "detect-on",
  "record-on": "record-off",
  "record-off": "record-on",
  "event-keep": "event-unkeep",
  "event-unkeep": "event-keep",
};

export class FrigateOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (login: FrigateLogin) => Promise<T>,
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
    const op = String(params?.op ?? "") as FrigateOp;
    if (!FRIGATE_OPS.includes(op)) throw new Error(`Say what to do: ${FRIGATE_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Frigate", "read", async (login) =>
      planFrigate(
        await frigateDashboard(this.fetchImpl, service.localUrl, login),
        service.name,
        op,
        params ?? {},
        base,
      ),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    return this.record(step, service, (login) =>
      runFrigate(this.fetchImpl, service.localUrl, login, step.params ?? {}, this.wait),
    );
  }

  /** Switches and keeping are put back the other way; deleting and restarting are not undone. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const back = OPPOSITE[String(p.op) as FrigateOp];
    if (!back) return undefined;
    const params = { ...p, op: back };
    return this.record({ ...step, params }, service, (login) =>
      runFrigate(this.fetchImpl, service.localUrl, login, params, this.wait),
    );
  }

  private async record(
    step: StepRun,
    service: Service,
    fn: (login: FrigateLogin) => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Frigate", "change", fn);
    } catch (error) {
      if (!(error instanceof FrigateError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, camera: p.camera ?? null, eventId: p.eventId ?? null },
    });
    return out;
  }
}

const WORDS: Record<FrigateOp, (what: string) => string> = {
  "detect-on": (c) => `Turn on object detection for ${c}`,
  "detect-off": (c) => `Turn off object detection for ${c} (no new events until it is back on)`,
  "record-on": (c) => `Turn on recording for ${c}`,
  "record-off": (c) => `Turn off recording for ${c} (nothing is recorded until it is back on)`,
  "event-keep": (e) => `Keep the event ${e} forever`,
  "event-unkeep": (e) => `Stop keeping the event ${e} forever (it is cleaned up with the rest)`,
  "event-delete": (e) => `Delete the event ${e} and its snapshot and clip`,
  restart: () => "Restart Frigate (cameras stop for about a minute)",
};

export function planFrigate(
  d: FrigateDashboard,
  name: string,
  op: FrigateOp,
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams,
  ): PlannedStep => ({
    ...base,
    label: `${label} in ${name}`,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: `${label} in ${name}`, settings: [setting] },
  });
  if (op === "restart")
    return step(WORDS.restart(""), { name: "Frigate", before: "running", after: "restarted" }, {});
  if (op.startsWith("event-")) {
    const e = d.events.find((x) => x.id === String(p.eventId ?? ""));
    if (!e) throw new Error(`${name} has no recent event with that id: read the panel again.`);
    const what = `${e.label} on ${e.camera}`;
    return step(
      WORDS[op](what),
      {
        name: what,
        before: e.kept ? "kept forever" : "kept as usual",
        after:
          op === "event-delete"
            ? "deleted"
            : op === "event-keep"
              ? "kept forever"
              : "kept as usual",
      },
      {
        eventId: e.id,
        name: what,
      },
    );
  }
  const cam = d.cameras.find((x) => x.name === String(p.camera ?? ""));
  if (!cam) throw new Error(`${name} has no camera called that: read the panel again.`);
  const on = op.endsWith("-on");
  const kind = op.startsWith("detect") ? "detection" : "recording";
  return step(
    WORDS[op](cam.name),
    {
      name: `${cam.name} ${kind}`,
      before: kind === "detection" ? (cam.detecting ? "on" : "off") : "as set",
      after: on ? "on" : "off",
    },
    { camera: cam.name },
  );
}

export async function runFrigate(
  fetchImpl: Fetch,
  base: string,
  login: FrigateLogin,
  p: StepParams,
  wait: (ms: number) => Promise<void>,
): Promise<StepOutcome> {
  const op = String(p.op) as FrigateOp;
  const call = <T>(method: string, path: string, body?: unknown) =>
    fr<T>(fetchImpl, base, login, method, path, body);
  if (op === "restart") {
    await call("POST", "/restart");
    // Frigate stops answering while it restarts, then answers again.
    for (let i = 0; i < 30; i++) {
      await wait(4000);
      const v = await call<string>("GET", "/version").catch(() => undefined);
      if (v)
        return { ok: true, verified: true, result: "Frigate restarted and is answering again." };
    }
    return {
      ok: false,
      result: "Frigate has not answered again after restarting: look at its container.",
    };
  }
  if (op.startsWith("event-")) {
    const id = encodeURIComponent(String(p.eventId));
    if (op === "event-delete") {
      await call("DELETE", `/events/${id}`);
      const left = await call<unknown>("GET", `/events/${id}`)
        .then(() => true)
        .catch(() => false);
      return left
        ? { ok: false, result: `${String(p.name)} is still in Frigate.` }
        : { ok: true, verified: true, result: `Frigate deleted ${String(p.name)}.` };
    }
    const keep = op === "event-keep";
    await call(keep ? "POST" : "DELETE", `/events/${id}/retain`);
    // Frigate answers before its event store shows the change: read it back for a few seconds.
    for (let i = 0; i < 6; i++) {
      const now = await call<{ retain_indefinitely?: boolean }>("GET", `/events/${id}`);
      if (Boolean(now?.retain_indefinitely) === keep)
        return {
          ok: true,
          verified: true,
          result: `Frigate ${keep ? "keeps" : "no longer keeps"} ${String(p.name)} forever.`,
        };
      await wait(2000);
    }
    return { ok: false, result: `Frigate did not change how it keeps ${String(p.name)}.` };
  }
  const camera = String(p.camera);
  const on = op.endsWith("-on");
  const feature = op.startsWith("detect") ? "detect" : "recordings";
  await call("PUT", `/camera/${encodeURIComponent(camera)}/set/${feature}`, {
    value: on ? "ON" : "OFF",
  });
  if (feature === "recordings")
    return { ok: true, result: `Frigate turned recording ${on ? "on" : "off"} for ${camera}.` };
  // Frigate refreshes its stats every few seconds.
  for (let i = 0; i < 8; i++) {
    const stats = await call<{ cameras?: Record<string, { detection_enabled?: boolean }> }>(
      "GET",
      "/stats",
    );
    if (Boolean(stats?.cameras?.[camera]?.detection_enabled) === on)
      return {
        ok: true,
        verified: true,
        result: `Detection is ${on ? "on" : "off"} for ${camera} in Frigate.`,
      };
    await wait(4000);
  }
  return {
    ok: false,
    result: `Frigate accepted it, but its stats still show detection ${on ? "off" : "on"} for ${camera}.`,
  };
}
