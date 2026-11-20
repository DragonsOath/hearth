import type { StepParams, TailscaleDashboard } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { listDevices, TAILSCALE_API, TailscaleError, tailscaleDashboard, ts } from "./tailscale";

/**
 * Changes on the tailnet, each a plan the owner approves (app-tailscale-control, params.op):
 * approve a device waiting to join or take its access away, turn its key expiry off or on,
 * approve or withdraw it as an exit node or its subnet routes, rename it, and remove it.
 * Tailscale carries remote access, so every plan here is marked protected: approving asks the
 * owner to confirm it is them. Each is read back from Tailscale and, except removing, undone by
 * putting the old value back. Access rules, DNS and keys stay in Tailscale's admin console.
 */

export const TAILSCALE_OPS = [
  "authorize",
  "deauthorize",
  "expiry-off",
  "expiry-on",
  "exit-approve",
  "exit-withdraw",
  "routes-approve",
  "routes-withdraw",
  "rename",
  "remove",
] as const;
export type TailscaleOp = (typeof TAILSCALE_OPS)[number];

const EXIT = ["0.0.0.0/0", "::/0"];
const BACK: Partial<Record<TailscaleOp, TailscaleOp>> = {
  authorize: "deauthorize",
  deauthorize: "authorize",
  "expiry-off": "expiry-on",
  "expiry-on": "expiry-off",
  "exit-approve": "exit-withdraw",
  "exit-withdraw": "exit-approve",
  "routes-approve": "routes-withdraw",
  "routes-withdraw": "routes-approve",
};

type Service = { id: string; name: string; localUrl: string };

export class TailscaleOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: TAILSCALE_API },
      ({ value }) => fn(value),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as TailscaleOp;
    if (!TAILSCALE_OPS.includes(op))
      throw new Error(`Say what to do: ${TAILSCALE_OPS.join(", ")}.`);
    return this.use(service, "plan a change on the tailnet", "read", async (key) =>
      planTailscale(
        await tailscaleDashboard(this.fetchImpl, key),
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
      out = await this.use(service, "change the tailnet", "change", (key) =>
        runTailscale(this.fetchImpl, key, p),
      );
    } catch (error) {
      if (!(error instanceof TailscaleError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, deviceId: p.deviceId ?? null },
    });
    return out;
  }

  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op) as TailscaleOp;
    const back = BACK[op];
    if (!back && op !== "rename") return undefined;
    return this.use(service, "undo a change on the tailnet", "change", (key) =>
      runTailscale(
        this.fetchImpl,
        key,
        back
          ? { ...p, op: back }
          : { ...p, value: String(p.before ?? ""), before: String(p.value ?? "") },
      ),
    );
  }
}

export function planTailscale(
  d: TailscaleDashboard,
  name: string,
  op: TailscaleOp,
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const dev = d.devices.find((x) => x.id === String(p.deviceId ?? ""));
  if (!dev) throw new Error(`${name} has no such device on the tailnet: read the panel again.`);
  if (dev.external)
    throw new Error(`${dev.name} is shared in from another tailnet: change it there.`);
  const step = (
    label: string,
    setting: { before: string; after: string },
    extra: StepParams = {},
  ) => ({
    ...base,
    label,
    serviceName: name,
    // Tailscale carries remote access: approving asks the owner to confirm it is them.
    params: { op, deviceId: dev.id, device: dev.name, ...extra, protected: "yes" },
    change: { summary: label, settings: [{ name: dev.name, ...setting }] },
  });
  switch (op) {
    case "authorize":
      if (dev.authorized) throw new Error(`${dev.name} is already approved.`);
      return step(`Approve ${dev.name} (${dev.os}, ${dev.user}) to join the tailnet`, {
        before: "waiting for approval",
        after: "on the tailnet",
      });
    case "deauthorize":
      if (!dev.authorized) throw new Error(`${dev.name} is not approved now.`);
      return step(
        `Take ${dev.name}'s access to the tailnet away (it stays listed until approved again or removed)`,
        { before: "approved", after: "not approved" },
      );
    case "expiry-off":
      if (dev.keyExpiryDisabled) throw new Error(`${dev.name}'s key already never expires.`);
      return step(`Turn off key expiry for ${dev.name} (it never has to sign in again)`, {
        before: dev.keyExpires ? `expires ${dev.keyExpires.slice(0, 10)}` : "expires",
        after: "never expires",
      });
    case "expiry-on":
      if (!dev.keyExpiryDisabled) throw new Error(`${dev.name}'s key already expires.`);
      return step(`Turn key expiry back on for ${dev.name}`, {
        before: "never expires",
        after: "expires as the tailnet sets",
      });
    case "exit-approve":
    case "exit-withdraw": {
      const on = op === "exit-approve";
      if (!dev.exitNode.offered) throw new Error(`${dev.name} does not offer to be an exit node.`);
      if (dev.exitNode.approved === on)
        throw new Error(
          `${dev.name} is already ${on ? "an approved" : "not an approved"} exit node.`,
        );
      return step(
        on
          ? `Approve ${dev.name} as an exit node (devices can send all their internet traffic through it)`
          : `Stop ${dev.name} being an exit node (devices using it go back to their own internet)`,
        { before: on ? "offered" : "exit node", after: on ? "exit node" : "offered, not approved" },
      );
    }
    case "routes-approve":
    case "routes-withdraw": {
      const on = op === "routes-approve";
      const routes = on
        ? dev.routes.offered.filter((r) => !dev.routes.approved.includes(r))
        : dev.routes.approved;
      if (!routes.length)
        throw new Error(
          on
            ? `${dev.name} has no subnet routes waiting.`
            : `${dev.name} has no approved subnet routes.`,
        );
      return step(
        on
          ? `Approve ${dev.name}'s subnet routes ${routes.join(", ")} (devices on the tailnet can reach those networks through it)`
          : `Withdraw ${dev.name}'s subnet routes ${routes.join(", ")}`,
        {
          before: on ? "offered" : routes.join(", "),
          after: on ? routes.join(", ") : "not approved",
        },
        { routes: routes.join(",") },
      );
    }
    case "rename": {
      const to = String(p.value ?? "")
        .trim()
        .toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(to))
        throw new Error(
          "Give a name of letters, digits and dashes (it becomes its address on the tailnet).",
        );
      if (to === dev.name) throw new Error(`${dev.name} already has that name.`);
      if (d.devices.some((x) => x.name === to))
        throw new Error(`Another device is already called ${to}.`);
      return step(
        `Rename ${dev.name} to ${to} (its tailnet address changes to ${to}${d.domain ? `.${d.domain}` : ""})`,
        { before: dev.name, after: to },
        { value: to, before: dev.name },
      );
    }
    default:
      return step(
        `Remove ${dev.name} from the tailnet (to come back it must sign in and be approved again)`,
        { before: dev.online ? "online" : "offline", after: "removed" },
      );
  }
}

/** The device's routes as Tailscale has them now. */
const routesOf = (fetchImpl: Fetch, key: string, id: string) =>
  ts<{ advertisedRoutes?: string[]; enabledRoutes?: string[] }>(
    fetchImpl,
    key,
    "GET",
    `/device/${encodeURIComponent(id)}/routes`,
  ).then((r) => ({ offered: r?.advertisedRoutes ?? [], enabled: r?.enabledRoutes ?? [] }));

export async function runTailscale(
  fetchImpl: Fetch,
  key: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as TailscaleOp;
  const id = String(p.deviceId);
  const label = String(p.device ?? id);
  const path = `/device/${encodeURIComponent(id)}`;
  const read = async () => (await listDevices(fetchImpl, key)).find((x) => x.id === id);
  const done = (ok: boolean, yes: string, no: string): StepOutcome => ({
    ok,
    verified: ok,
    result: ok ? yes : no,
  });
  const before = await read();
  if (!before) return { ok: false, stale: true, result: `${label} is no longer on the tailnet.` };

  if (op === "authorize" || op === "deauthorize") {
    const on = op === "authorize";
    if (before.authorized === on)
      return {
        ok: false,
        stale: true,
        result: `${label} was already ${on ? "approved" : "not approved"}.`,
      };
    await ts(fetchImpl, key, "POST", `${path}/authorized`, { authorized: on });
    const after = await read();
    return done(
      after?.authorized === on,
      on ? `${label} is on the tailnet.` : `${label}'s access is taken away.`,
      `${label} reads ${after?.authorized ? "approved" : "not approved"} afterwards.`,
    );
  }
  if (op === "expiry-off" || op === "expiry-on") {
    const off = op === "expiry-off";
    if (before.keyExpiryDisabled === off)
      return {
        ok: false,
        stale: true,
        result: `${label}'s key expiry was already ${off ? "off" : "on"}.`,
      };
    await ts(fetchImpl, key, "POST", `${path}/key`, { keyExpiryDisabled: off });
    const after = await read();
    return done(
      after?.keyExpiryDisabled === off,
      off ? `${label}'s key never expires now.` : `${label}'s key expires again.`,
      "Key expiry does not read back as planned.",
    );
  }
  if (
    op === "exit-approve" ||
    op === "exit-withdraw" ||
    op === "routes-approve" ||
    op === "routes-withdraw"
  ) {
    const now = await routesOf(fetchImpl, key, id);
    const change = op.startsWith("exit")
      ? EXIT
      : String(p.routes ?? "")
          .split(",")
          .filter(Boolean);
    const add = op.endsWith("approve");
    // Only routes the device still offers can be approved.
    const wanted = add
      ? [...new Set([...now.enabled, ...change.filter((r) => now.offered.includes(r))])]
      : now.enabled.filter((r) => !change.includes(r));
    if (add && !change.some((r) => now.offered.includes(r)))
      return { ok: false, stale: true, result: `${label} no longer offers those routes.` };
    await ts(fetchImpl, key, "POST", `${path}/routes`, { routes: wanted });
    const after = await routesOf(fetchImpl, key, id);
    const ok = change
      .filter((r) => !add || now.offered.includes(r))
      .every((r) => after.enabled.includes(r) === add);
    const what = op.startsWith("exit") ? "exit node" : "subnet routes";
    return done(
      ok,
      add
        ? `${label}'s ${what} ${op.startsWith("exit") ? "is" : "are"} approved.`
        : `${label}'s ${what} ${op.startsWith("exit") ? "is" : "are"} withdrawn.`,
      `${label}'s routes do not read back as planned.`,
    );
  }
  if (op === "rename") {
    const to = String(p.value);
    if (before.name !== String(p.before ?? before.name))
      return {
        ok: false,
        stale: true,
        result: `${label} was renamed since the plan (now ${before.name}).`,
      };
    await ts(fetchImpl, key, "POST", `${path}/name`, { name: to });
    const after = await read();
    return done(
      after?.name === to,
      `${label} is now ${to}.`,
      `The device reads ${after?.name ?? "missing"} afterwards.`,
    );
  }
  // remove
  await ts(fetchImpl, key, "DELETE", path);
  const gone = !(await read());
  return done(gone, `${label} is removed from the tailnet.`, `${label} is still listed.`);
}
