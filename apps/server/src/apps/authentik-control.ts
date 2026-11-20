import type { AuthentikDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { ak, authentikDashboard, AuthentikError } from "./authentik";
import type { Fetch } from "./http";

/**
 * Changes in Authentik, each a protected plan the owner approves (app-authentik-control,
 * params.op): turn a person's account off (they cannot sign in anywhere Authentik guards) or on,
 * and retry a background task that failed. Each is read back from Authentik. Hearth never turns off
 * the account its own token belongs to, or the last active administrator. Passwords, sign-in
 * methods, applications and flows are changed in Authentik.
 */

export const AUTHENTIK_OPS = ["user-off", "user-on", "retry-task"] as const;
export type AuthentikOp = (typeof AUTHENTIK_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

export class AuthentikOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as AuthentikOp;
    if (!AUTHENTIK_OPS.includes(op))
      throw new Error(`Say what to do: ${AUTHENTIK_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Authentik", "read", async (token) => {
      const d = await authentikDashboard(this.fetchImpl, service.localUrl, token);
      const me = await ak<{ user?: { pk?: number } }>(
        this.fetchImpl,
        service.localUrl,
        token,
        "GET",
        "/core/users/me/",
      );
      return planAuthentik(d, me.user?.pk, service.name, op, params ?? {}, base);
    });
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    return this.record(step, service, (token) =>
      runAuthentik(this.fetchImpl, service.localUrl, token, step.params ?? {}),
    );
  }

  /** An account turned off is turned on again, and the other way; a retry is not undone. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    if (p.op !== "user-off" && p.op !== "user-on") return undefined;
    const back = { ...p, op: p.op === "user-off" ? "user-on" : "user-off" };
    return this.record({ ...step, params: back }, service, (token) =>
      runAuthentik(this.fetchImpl, service.localUrl, token, back),
    );
  }

  private async record(
    step: StepRun,
    service: Service,
    fn: (token: string) => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Authentik", "change", fn);
    } catch (error) {
      if (!(error instanceof AuthentikError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, userId: p.userId ?? null, taskId: p.taskId ?? null },
    });
    return out;
  }
}

export function planAuthentik(
  d: AuthentikDashboard,
  me: number | undefined,
  name: string,
  op: AuthentikOp,
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
    // Authentik decides who may sign in to everything behind it: approving asks the owner to confirm.
    params: { op, protected: "yes", ...extra },
    change: { summary: label, settings: [setting] },
  });
  if (op === "retry-task") {
    const t = d.failedTasks.find((x) => x.id === String(p.taskId ?? ""));
    if (!t) throw new Error(`${name} has no failed task with that id: read the panel again.`);
    return step(
      `Retry the failed task "${t.name}" in ${name}`,
      { name: t.name, before: "failed", after: "tried again" },
      { taskId: t.id, name: t.name },
    );
  }
  const u = d.users.find((x) => x.id === Number(p.userId));
  if (!u) throw new Error(`${name} has no such account: read the panel again.`);
  const off = op === "user-off";
  if (off && u.id === me)
    throw new Error(
      `That is the account Hearth's token belongs to: turning it off would lock Hearth out of ${name}.`,
    );
  if (off && u.admin && d.users.filter((x) => x.admin && x.active).length <= 1)
    throw new Error(
      `${u.username} is ${name}'s last active administrator: make another one first.`,
    );
  return step(
    off
      ? `Turn off ${u.username}'s account in ${name} (they cannot sign in anywhere it guards)`
      : `Turn on ${u.username}'s account in ${name}`,
    { name: u.username, before: u.active ? "on" : "off", after: off ? "off" : "on" },
    { userId: u.id, name: u.username },
  );
}

export async function runAuthentik(
  fetchImpl: Fetch,
  base: string,
  token: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as AuthentikOp;
  const call = <T>(method: string, path: string, body?: unknown) =>
    ak<T>(fetchImpl, base, token, method, path, body);
  if (op === "retry-task") {
    await call("POST", `/tasks/tasks/${encodeURIComponent(String(p.taskId))}/retry/`);
    return { ok: true, result: `Authentik is running "${String(p.name)}" again.` };
  }
  const id = encodeURIComponent(String(p.userId));
  const want = op === "user-on";
  await call("PATCH", `/core/users/${id}/`, { is_active: want });
  const now = await call<{ is_active?: boolean }>("GET", `/core/users/${id}/`);
  return now.is_active === want
    ? {
        ok: true,
        verified: true,
        result: `${String(p.name)}'s account is ${want ? "on" : "off"} in Authentik.`,
      }
    : {
        ok: false,
        result: `Authentik still shows ${String(p.name)}'s account ${want ? "off" : "on"}.`,
      };
}
