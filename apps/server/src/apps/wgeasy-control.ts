import type { StepParams, WgEasyDashboard } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { listPeers, wg, WgEasyError, wgEasyDashboard, type WgLogin } from "./wgeasy";

/**
 * Changes in wg-easy, each a plan the owner approves (app-wgeasy-control, params.op): turn a client
 * on or off, add one, rename it, set or clear its end date, remove it, and restart the WireGuard
 * interface. wg-easy carries remote access, so every plan is marked protected: approving asks the
 * owner to confirm it is them. Each is read back and, except removing and restarting, undone. A new
 * client's configuration (its private key) is collected in wg-easy itself, from its QR code.
 */

export const WGEASY_OPS = [
  "enable",
  "disable",
  "add",
  "rename",
  "expiry",
  "remove",
  "restart",
] as const;
export type WgEasyOp = (typeof WGEASY_OPS)[number];

type Service = { id: string; name: string; localUrl: string };
const NAME = /^[\p{L}\p{N} ._'-]{1,64}$/u;

export class WgEasyOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (login: WgLogin) => Promise<T>,
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
    const op = String(params?.op ?? "") as WgEasyOp;
    if (!WGEASY_OPS.includes(op)) throw new Error(`Say what to do: ${WGEASY_OPS.join(", ")}.`);
    return this.use(service, "plan a change in wg-easy", "read", async (login) =>
      planWgEasy(
        await wgEasyDashboard(this.fetchImpl, service.localUrl, login),
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
      out = await this.use(service, "change wg-easy", "change", (login) =>
        runWgEasy(this.fetchImpl, service.localUrl, login, p),
      );
    } catch (error) {
      if (!(error instanceof WgEasyError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, clientId: p.clientId ?? null },
    });
    return out;
  }

  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op) as WgEasyOp;
    return this.use(service, "undo a change in wg-easy", "change", async (login) => {
      if (op === "enable" || op === "disable")
        return runWgEasy(this.fetchImpl, service.localUrl, login, {
          ...p,
          op: op === "enable" ? "disable" : "enable",
        });
      if (op === "rename" || op === "expiry")
        return runWgEasy(this.fetchImpl, service.localUrl, login, {
          ...p,
          value: String(p.before ?? ""),
          before: String(p.value ?? ""),
        });
      if (op !== "add") return undefined;
      const made = (await listPeers(this.fetchImpl, service.localUrl, login)).find(
        (x) => x.name === p.name,
      );
      if (!made) return undefined;
      return runWgEasy(this.fetchImpl, service.localUrl, login, {
        op: "remove",
        clientId: made.id,
        name: made.name,
      });
    });
  }
}

/** A date the owner gives ("2026-12-31"), as wg-easy stores it, or "" for none. */
export function parseDate(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s || /^(none|never)$/i.test(s)) return "";
  const d = new Date(/^\d{4}-\d\d-\d\d$/.test(s) ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error('Give the end date as YYYY-MM-DD, or "none".');
  return d.toISOString();
}

export function planWgEasy(
  d: WgEasyDashboard,
  name: string,
  op: WgEasyOp,
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams = {},
  ) => ({
    ...base,
    label,
    serviceName: name,
    // wg-easy carries remote access: approving asks the owner to confirm it is them.
    params: { op, ...extra, protected: "yes" },
    change: { summary: label, settings: [setting] },
  });

  if (op === "restart")
    return step(
      `Restart ${name}'s WireGuard interface (every connected client drops for a few seconds, including you if you are connected through it)`,
      { name: "WireGuard", before: "running", after: "restarted" },
    );
  if (op === "add") {
    const client = String(p.name ?? "").trim();
    if (!NAME.test(client))
      throw new Error("Give the client a name (letters, digits, spaces, dots, dashes).");
    if (d.peers.some((x) => x.name.toLowerCase() === client.toLowerCase()))
      throw new Error(`${name} already has a client called ${client}.`);
    const until = parseDate(p.value);
    return step(
      `Add a WireGuard client ${client} to ${name}${until ? ` until ${until.slice(0, 10)}` : ""} (then scan its QR code in wg-easy on the device)`,
      { name: client, before: "none", after: "added" },
      { name: client, value: until },
    );
  }
  const c = d.peers.find((x) => x.id === Number(p.clientId));
  if (!c) throw new Error(`${name} has no such client: read the panel again.`);
  const extra = { clientId: c.id, name: c.name };
  switch (op) {
    case "enable":
    case "disable": {
      const on = op === "enable";
      if (c.enabled === on) throw new Error(`${c.name} is already ${on ? "on" : "off"}.`);
      return step(
        on
          ? `Turn ${c.name} back on in ${name}`
          : `Turn off ${c.name} in ${name} (it cannot connect until turned on; nothing is deleted)${c.connected ? ": it is connected now and drops" : ""}`,
        { name: c.name, before: c.enabled ? "on" : "off", after: on ? "on" : "off" },
        extra,
      );
    }
    case "rename": {
      const to = String(p.value ?? "").trim();
      if (!NAME.test(to)) throw new Error("Give a name (letters, digits, spaces, dots, dashes).");
      if (to === c.name) throw new Error(`${c.name} already has that name.`);
      if (d.peers.some((x) => x.id !== c.id && x.name.toLowerCase() === to.toLowerCase()))
        throw new Error(`Another client is already called ${to}.`);
      return step(
        `Rename ${c.name} to ${to} in ${name}`,
        { name: c.name, before: c.name, after: to },
        {
          ...extra,
          value: to,
          before: c.name,
        },
      );
    }
    case "expiry": {
      const until = parseDate(p.value);
      const was = c.expiresAt ?? "";
      if (until === was) throw new Error(`${c.name} already has that end date.`);
      return step(
        until
          ? `Turn ${c.name} off on ${until.slice(0, 10)} in ${name}`
          : `Take away ${c.name}'s end date in ${name}`,
        {
          name: `${c.name}'s end date`,
          before: was ? was.slice(0, 10) : "none",
          after: until ? until.slice(0, 10) : "none",
        },
        { ...extra, value: until, before: was },
      );
    }
    default:
      return step(
        `Remove ${c.name} from ${name} (its configuration stops working for good; to come back it needs a new one)`,
        { name: c.name, before: c.enabled ? "on" : "off", after: "removed" },
        extra,
      );
  }
}

export async function runWgEasy(
  fetchImpl: Fetch,
  base: string,
  login: WgLogin,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as WgEasyOp;
  const read = () => listPeers(fetchImpl, base, login);
  const done = (ok: boolean, yes: string, no: string): StepOutcome => ({
    ok,
    verified: ok,
    result: ok ? yes : no,
  });

  if (op === "restart") {
    await wg(fetchImpl, base, login, "POST", "/api/admin/interface/restart");
    // It answers once it is back; reading the clients shows the interface works again.
    await read();
    return { ok: true, result: "WireGuard restarted and wg-easy answers again." };
  }
  if (op === "add") {
    const client = String(p.name);
    if ((await read()).some((x) => x.name === client))
      return { ok: false, stale: true, result: `A client called ${client} exists already.` };
    await wg(fetchImpl, base, login, "POST", "/api/client", {
      name: client,
      expiresAt: String(p.value ?? "") || null,
    });
    const made = (await read()).find((x) => x.name === client);
    return done(
      Boolean(made),
      `${client} is added (${made?.address ?? ""}). Scan its QR code in wg-easy on the device.`,
      "The new client does not read back.",
    );
  }
  const id = Number(p.clientId);
  const before = (await read()).find((x) => x.id === id);
  const label = String(p.name ?? id);
  if (!before) return { ok: false, stale: true, result: `${label} is no longer in wg-easy.` };
  const after = async () => (await read()).find((x) => x.id === id);

  if (op === "enable" || op === "disable") {
    const on = op === "enable";
    if (before.enabled === on)
      return { ok: false, stale: true, result: `${label} was already ${on ? "on" : "off"}.` };
    await wg(fetchImpl, base, login, "POST", `/api/client/${id}/${op}`);
    const a = await after();
    return done(
      a?.enabled === on,
      on ? `${label} can connect again.` : `${label} is off.`,
      `${label} reads ${a?.enabled ? "on" : "off"} afterwards.`,
    );
  }
  if (op === "remove") {
    await wg(fetchImpl, base, login, "DELETE", `/api/client/${id}`);
    const gone = !(await after());
    return done(gone, `${label} is removed.`, `${label} is still listed.`);
  }
  // rename or expiry: wg-easy's update takes the whole client, so read it and change one field.
  const full = await wg<Record<string, unknown>>(
    fetchImpl,
    base,
    login,
    "GET",
    `/api/client/${id}`,
  );
  if (op === "rename" && String(full.name) !== String(p.before ?? full.name))
    return { ok: false, stale: true, result: `${label} was renamed since the plan.` };
  const value = String(p.value ?? "");
  const update = { ...full, ...(op === "rename" ? { name: value } : { expiresAt: value || null }) };
  for (const k of [
    "id",
    "userId",
    "interfaceId",
    "publicKey",
    "createdAt",
    "updatedAt",
    "privateKey",
    "preSharedKey",
    "oneTimeLink",
    "latestHandshakeAt",
    "endpoint",
    "transferRx",
    "transferTx",
  ])
    delete (update as Record<string, unknown>)[k];
  await wg(fetchImpl, base, login, "POST", `/api/client/${id}`, update);
  const a = await after();
  if (op === "rename")
    return done(
      a?.name === value,
      `${label} is now ${value}.`,
      `It reads ${a?.name ?? "missing"} afterwards.`,
    );
  const ok = (a?.expiresAt ? Date.parse(a.expiresAt) : 0) === (value ? Date.parse(value) : 0);
  return done(
    ok,
    value ? `${label} turns off on ${value.slice(0, 10)}.` : `${label} has no end date.`,
    "The end date does not read back as planned.",
  );
}
