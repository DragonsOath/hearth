import { isCoreNetworking, type StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { containersOf, PortainerClient, PortainerError } from "./portainer";

/**
 * Changes through Portainer, each a plan the owner approves (app-portainer-control, params.op):
 * start or stop a stack, update a stack (pull its images and deploy it again, from its file or its
 * Git repository), and start, stop or restart a container. Each is read back from Docker through
 * Portainer. A container or stack that runs networking (a proxy, VPN, DNS) is protected: approving
 * asks the owner to confirm it is them. Hearth never stops itself, and never deletes a stack or
 * container, edits a Compose file or environment variables, or touches registries and users:
 * those stay in Portainer.
 */

export const PORTAINER_OPS = [
  "stack-start",
  "stack-stop",
  "stack-update",
  "container-start",
  "container-stop",
  "container-restart",
] as const;
export type PortainerOp = (typeof PORTAINER_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

/** Hearth itself: never stopped from its own panel. */
const SELF = /^(hearth|dragon-?control)([-_]|$)/i;

interface RawStack {
  Id: number;
  Name: string;
  EndpointId: number;
  Status: number;
  GitConfig?: { ReferenceName?: string } | null;
  Env?: { name: string; value: string }[] | null;
}

export class PortainerOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (c: PortainerClient) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(new PortainerClient(service.localUrl, value, this.fetchImpl)),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as PortainerOp;
    if (!PORTAINER_OPS.includes(op))
      throw new Error(`Say what to do: ${PORTAINER_OPS.join(", ")}.`);
    return this.use(service, "plan a change through Portainer", "read", (c) =>
      planPortainer(c, service.name, op, params ?? {}, base),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change through Portainer", "change", (c) =>
        runPortainer(c, service.name, p),
      );
    } catch (error) {
      if (!(error instanceof PortainerError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, stackId: p.stackId ?? null, container: p.container ?? null },
    });
    return out;
  }

  /** Starts what a failed later step left stopped, and the other way round. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const back: Partial<Record<PortainerOp, PortainerOp>> = {
      "stack-start": "stack-stop",
      "stack-stop": "stack-start",
      "container-start": "container-stop",
      "container-stop": "container-start",
    };
    const op = back[String(p.op) as PortainerOp];
    if (!op) return undefined;
    return this.use(service, "undo a change through Portainer", "change", (c) =>
      runPortainer(c, service.name, { ...p, op }),
    );
  }
}

const stackOf = async (c: PortainerClient, id: number) => {
  try {
    return await c.call<RawStack>("GET", `/stacks/${id}`);
  } catch {
    return undefined;
  }
};

/** A container by name or id in an environment, read live. */
async function containerNow(c: PortainerClient, env: number, nameOrId: string) {
  const all = await containersOf(c, env);
  return all.find((x) => x.name === nameOrId || x.id === nameOrId.slice(0, 12));
}

export async function planPortainer(
  c: PortainerClient,
  name: string,
  op: PortainerOp,
  p: StepParams,
  base: PlannedStep,
): Promise<PlannedStep> {
  const env = Number(p.environmentId);
  if (!Number.isInteger(env) || env < 1)
    throw new Error("Say which environment, by its id from the panel.");
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams,
    protect: boolean,
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, environmentId: env, ...extra, ...(protect ? { protected: "yes" } : {}) },
    change: { summary: label, settings: [setting] },
  });

  if (op.startsWith("stack-")) {
    const id = Number(p.stackId);
    const s = Number.isInteger(id) ? await stackOf(c, id) : undefined;
    if (!s || s.EndpointId !== env)
      throw new Error(`${name} has no such stack there: read the panel again.`);
    const parts = (await containersOf(c, env)).filter((x) => x.stack === s.Name);
    if (parts.some((x) => SELF.test(x.name)) && op === "stack-stop")
      throw new Error(`${s.Name} runs Hearth itself: stop it from Portainer, not from Hearth.`);
    const protect =
      parts.some((x) => isCoreNetworking(x.name, x.image)) || isCoreNetworking(s.Name);
    const why = protect ? " (it runs networking: approving asks you to confirm it is you)" : "";
    const running = s.Status === 1;
    if (op === "stack-start" || op === "stack-stop") {
      const on = op === "stack-start";
      if (running === on) throw new Error(`${s.Name} is already ${on ? "running" : "stopped"}.`);
      return step(
        `${on ? "Start" : "Stop"} the stack ${s.Name} (${parts.length} ${parts.length === 1 ? "container" : "containers"})${why}`,
        {
          name: s.Name,
          before: running ? "running" : "stopped",
          after: on ? "running" : "stopped",
        },
        { stackId: id, stack: s.Name },
        protect,
      );
    }
    if (!running) throw new Error(`${s.Name} is stopped: start it first, then update it.`);
    return step(
      `Update the stack ${s.Name}: pull its images and deploy it again${s.GitConfig ? " from its Git repository" : ""} (its containers restart)${why}`,
      { name: s.Name, before: "as deployed", after: "newest images, redeployed" },
      { stackId: id, stack: s.Name },
      protect,
    );
  }

  const nameOrId = String(p.container ?? "");
  const x = nameOrId ? await containerNow(c, env, nameOrId) : undefined;
  if (!x) throw new Error(`${name} has no container ${nameOrId} there.`);
  if (SELF.test(x.name) && op !== "container-restart")
    throw new Error(`${x.name} is Hearth itself: it is not stopped from Hearth.`);
  const protect = isCoreNetworking(x.name, x.image);
  const why = protect ? " (it runs networking: approving asks you to confirm it is you)" : "";
  if (op === "container-start" && x.state === "running")
    throw new Error(`${x.name} is already running.`);
  if ((op === "container-stop" || op === "container-restart") && x.state !== "running")
    throw new Error(`${x.name} is not running.`);
  const verb = op === "container-start" ? "Start" : op === "container-stop" ? "Stop" : "Restart";
  return step(
    `${verb} the container ${x.name}${why}`,
    { name: x.name, before: x.state, after: op === "container-stop" ? "stopped" : "running" },
    { container: x.name },
    protect,
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runPortainer(
  c: PortainerClient,
  name: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as PortainerOp;
  const env = Number(p.environmentId);

  if (op.startsWith("stack-")) {
    const id = Number(p.stackId);
    const s = await stackOf(c, id);
    if (!s)
      return { ok: false, stale: true, result: `${String(p.stack)} is no longer in ${name}.` };
    if (op === "stack-start" || op === "stack-stop") {
      const on = op === "stack-start";
      if ((s.Status === 1) === on)
        return {
          ok: false,
          stale: true,
          result: `${s.Name} was already ${on ? "running" : "stopped"}; nothing changed.`,
        };
      await c.call(
        "POST",
        `/stacks/${id}/${on ? "start" : "stop"}?endpointId=${env}`,
        undefined,
        120_000,
      );
    } else if (s.GitConfig) {
      await c.call(
        "PUT",
        `/stacks/${id}/git/redeploy?endpointId=${env}`,
        {
          pullImage: true,
          prune: false,
          env: s.Env ?? [],
          repositoryReferenceName: s.GitConfig.ReferenceName ?? "",
        },
        300_000,
      );
    } else {
      // Its own file and environment variables, as they are: only the images are pulled again.
      const file = await c.call<{ StackFileContent: string }>("GET", `/stacks/${id}/file`);
      await c.call(
        "PUT",
        `/stacks/${id}?endpointId=${env}`,
        {
          stackFileContent: file.StackFileContent,
          env: s.Env ?? [],
          prune: false,
          pullImage: true,
        },
        300_000,
      );
    }
    const after = await stackOf(c, id);
    const parts = (await containersOf(c, env)).filter((x) => x.stack === s.Name);
    const up = parts.filter((x) => x.state === "running").length;
    // An update redeploys the containers without touching the stack's own running flag: its
    // containers are what count.
    const ok =
      op === "stack-stop"
        ? after?.Status === 2 && up === 0
        : parts.length > 0 && up === parts.length && (op === "stack-update" || after?.Status === 1);
    return {
      ok,
      verified: ok,
      result: ok
        ? op === "stack-stop"
          ? `${s.Name} is stopped.`
          : `${s.Name} is running (${up} ${up === 1 ? "container" : "containers"})${op === "stack-update" ? " on its newest images" : ""}.`
        : `${s.Name} reads ${after?.Status === 1 ? "running" : "stopped"}, with ${up} of ${parts.length} containers running.`,
    };
  }

  const x = await containerNow(c, env, String(p.container));
  if (!x) return { ok: false, stale: true, result: `${String(p.container)} is no longer there.` };
  if (op === "container-start" && x.state === "running")
    return { ok: false, stale: true, result: `${x.name} was already running; nothing changed.` };
  if ((op === "container-stop" || op === "container-restart") && x.state !== "running")
    return { ok: false, stale: true, result: `${x.name} was not running; nothing changed.` };
  const verb = op.replace("container-", "");
  await c.call("POST", `/endpoints/${env}/docker/containers/${x.id}/${verb}`, undefined, 60_000);
  let after = await containerNow(c, env, x.name);
  for (let i = 0; i < 10 && after && op !== "container-stop" && after.state !== "running"; i++) {
    await wait(500);
    after = await containerNow(c, env, x.name);
  }
  // Stopped is any state that is not running: Docker marks a container killed while stopping
  // "dead" at times.
  const ok =
    op === "container-stop"
      ? Boolean(after) && !["running", "restarting", "paused"].includes(after!.state)
      : after?.state === "running";
  return {
    ok,
    verified: ok,
    result: ok
      ? op === "container-stop"
        ? `${x.name} is stopped${after!.state === "exited" ? "" : ` (Docker reads it ${after!.state})`}.`
        : `${x.name} is running.`
      : `${x.name} reads ${after?.state ?? "missing"} afterwards.`,
  };
}
