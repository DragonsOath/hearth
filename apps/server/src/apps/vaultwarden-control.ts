import type { StepParams, VaultwardenDashboard } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { admin, invite, userAction, VaultwardenError, vaultwardenDashboard } from "./vaultwarden";

/**
 * Changes in Vaultwarden, each a plan the owner approves (app-vaultwarden-control, params.op): turn
 * an account off or on, sign it out of every device, turn off its two-step sign-in (for someone
 * who lost their phone), invite someone by email or send the invitation again, delete an
 * account, and back up its database (a copy beside it in its data folder). Vaultwarden holds everyone's passwords, so every plan here is marked protected:
 * approving it asks the owner to confirm it is them. Each is read back. Hearth never reads or
 * changes what is inside a vault, and never changes Vaultwarden's settings (they hold secrets).
 */

export const VAULTWARDEN_OPS = [
  "disable",
  "enable",
  "deauth",
  "remove-2fa",
  "invite",
  "resend",
  "delete",
  "backup",
] as const;
export type VaultwardenOp = (typeof VAULTWARDEN_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export class VaultwardenOperations {
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
    const op = String(params?.op ?? "") as VaultwardenOp;
    if (!VAULTWARDEN_OPS.includes(op))
      throw new Error(`Say what to do: ${VAULTWARDEN_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Vaultwarden", "read", async (token) =>
      planVaultwarden(
        await vaultwardenDashboard(this.fetchImpl, service.localUrl, token),
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
      out = await this.use(service, "change Vaultwarden", "change", (token) =>
        runVaultwarden(this.fetchImpl, service.localUrl, token, p),
      );
    } catch (error) {
      if (!(error instanceof VaultwardenError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, userId: p.userId ?? null },
    });
    return out;
  }

  /** Turning off is undone by turning on and back; an invitation by deleting the invited account. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op) as VaultwardenOp;
    return this.use(service, "undo a change in Vaultwarden", "change", async (token) => {
      if (op === "disable" || op === "enable")
        return runVaultwarden(this.fetchImpl, service.localUrl, token, {
          ...p,
          op: op === "disable" ? "enable" : "disable",
        });
      if (op !== "invite") return undefined;
      const d = await vaultwardenDashboard(this.fetchImpl, service.localUrl, token);
      const u = d.users.find((x) => x.email === String(p.email).toLowerCase());
      if (!u || u.status !== "invited") return undefined;
      return runVaultwarden(this.fetchImpl, service.localUrl, token, {
        op: "delete",
        userId: u.id,
        email: u.email,
      });
    });
  }
}

export function planVaultwarden(
  d: VaultwardenDashboard,
  name: string,
  op: VaultwardenOp,
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
    // Vaultwarden holds everyone's passwords: approving asks the owner to confirm it is them.
    params: { op, ...extra, protected: "yes" },
    change: { summary: label, settings: [setting] },
  });

  if (op === "backup")
    return step(
      `Back up ${name}'s database now (a copy in its data folder, beside the database)`,
      { name: "Database", before: "as is", after: "copied" },
      {},
    );

  if (op === "invite") {
    const email = String(p.email ?? "")
      .trim()
      .toLowerCase();
    if (!EMAIL.test(email)) throw new Error("Give the email address to invite.");
    if (d.users.some((u) => u.email === email))
      throw new Error(`${email} already has an account or an invitation in ${name}.`);
    return step(
      `Invite ${email} to ${name}${d.settings.emailConfigured ? " (Vaultwarden emails them a link)" : " (Vaultwarden has no email set up, so tell them to sign up at its address)"}`,
      { name: email, before: "no account", after: "invited" },
      { email },
    );
  }

  const u = d.users.find((x) => x.id === String(p.userId ?? ""));
  if (!u) throw new Error(`${name} has no such account: read the panel again.`);
  const who = u.email;
  const extra = { userId: u.id, email: u.email };
  switch (op) {
    case "disable":
      if (u.status === "disabled") throw new Error(`${who} is already turned off.`);
      return step(
        `Turn off ${who} in ${name} (they cannot sign in or sync; their vault stays)`,
        { name: who, before: u.status, after: "turned off" },
        extra,
      );
    case "enable":
      if (u.status !== "disabled") throw new Error(`${who} is not turned off.`);
      return step(
        `Turn ${who} back on in ${name}`,
        { name: who, before: "turned off", after: "on" },
        extra,
      );
    case "deauth":
      if (u.status === "invited") throw new Error(`${who} has not made an account yet.`);
      return step(
        `Sign ${who} out of every device in ${name} (they sign in again with their master password)`,
        { name: who, before: "signed in", after: "signed out everywhere" },
        extra,
      );
    case "remove-2fa":
      if (!u.twoFactor) throw new Error(`${who} has no two-step sign-in to turn off.`);
      return step(
        `Turn off two-step sign-in for ${who} in ${name} (for a lost phone or key: until they set it up again, their master password alone opens the vault)`,
        { name: `${who}'s two-step sign-in`, before: "on", after: "off" },
        extra,
      );
    case "resend":
      if (u.status !== "invited") throw new Error(`${who} is not waiting on an invitation.`);
      return step(
        `Send ${who}'s invitation to ${name} again`,
        { name: who, before: "invited", after: "invited (sent again)" },
        extra,
      );
    default:
      // delete
      return step(
        u.status === "invited"
          ? `Withdraw ${who}'s invitation to ${name}`
          : `Delete ${who}'s account and everything in their vault from ${name} (this cannot be undone; turning it off keeps the vault)`,
        { name: who, before: u.status, after: "deleted" },
        extra,
      );
  }
}

export async function runVaultwarden(
  fetchImpl: Fetch,
  base: string,
  token: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as VaultwardenOp;
  const read = async () => (await vaultwardenDashboard(fetchImpl, base, token)).users;
  const done = (ok: boolean, yes: string, no: string): StepOutcome => ({
    ok,
    verified: ok,
    result: ok ? yes : no,
  });

  if (op === "backup") {
    const said = await admin<unknown>(fetchImpl, base, token, "POST", "/admin/config/backup_db");
    const where = typeof said === "string" ? /Backup to (\S+)/.exec(said)?.[1] : undefined;
    return {
      ok: true,
      result: where
        ? `Vaultwarden made a copy of its database: ${where.replace(/[.]$/, "")}.`
        : "Vaultwarden made a copy of its database in its data folder.",
    };
  }

  if (op === "invite") {
    const email = String(p.email);
    if ((await read()).some((u) => u.email === email))
      return { ok: false, stale: true, result: `${email} already has an account or invitation.` };
    await invite(fetchImpl, base, token, email);
    const u = (await read()).find((x) => x.email === email);
    return done(Boolean(u), `${email} is invited.`, `${email} does not read back as invited.`);
  }

  const id = String(p.userId);
  const before = (await read()).find((x) => x.id === id);
  const who = String(p.email ?? id);
  if (!before) return { ok: false, stale: true, result: `${who} is no longer in Vaultwarden.` };

  if (op === "disable" || op === "enable") {
    const off = op === "disable";
    if ((before.status === "disabled") === off)
      return { ok: false, stale: true, result: `${who} was already ${off ? "off" : "on"}.` };
    await userAction(fetchImpl, base, token, id, op);
    const after = (await read()).find((x) => x.id === id);
    return done(
      (after?.status === "disabled") === off,
      off ? `${who} is turned off.` : `${who} can sign in again.`,
      `${who} reads ${after?.status ?? "missing"} afterwards.`,
    );
  }
  if (op === "remove-2fa") {
    if (!before.twoFactor)
      return { ok: false, stale: true, result: `${who} has no two-step sign-in now.` };
    await userAction(fetchImpl, base, token, id, "remove-2fa");
    const after = (await read()).find((x) => x.id === id);
    return done(
      after?.twoFactor === false,
      `Two-step sign-in is off for ${who}. Ask them to set it up again.`,
      "Two-step sign-in still reads as on.",
    );
  }
  if (op === "delete") {
    await userAction(fetchImpl, base, token, id, "delete");
    const gone = !(await read()).some((x) => x.id === id);
    return done(gone, `${who} is deleted.`, `${who} is still listed.`);
  }
  // deauth and resend: Vaultwarden answers, and there is nothing else to read back.
  await userAction(fetchImpl, base, token, id, op === "deauth" ? "deauth" : "invite/resend");
  return {
    ok: true,
    result:
      op === "deauth"
        ? `${who} is signed out of every device.`
        : `Vaultwarden sent ${who}'s invitation again.`,
  };
}
