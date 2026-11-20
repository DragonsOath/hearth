import type { MealieDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { mealieDashboard, MealieError, ml } from "./mealie";

/**
 * Changes in Mealie, each a plan the owner approves (app-mealie-control, params.op): make a backup,
 * clean its temporary files, delete images no recipe uses, remove empty recipe folders, and unlock
 * every locked account. A backup is read back from Mealie's backup list; the rest report Mealie's
 * answer. Recipes, people and settings stay in Mealie.
 */

export const MEALIE_OPS = [
  "backup",
  "clean-temp",
  "clean-images",
  "clean-folders",
  "unlock",
] as const;
export type MealieOp = (typeof MEALIE_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

export class MealieOperations {
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
    const op = String(params?.op ?? "") as MealieOp;
    if (!MEALIE_OPS.includes(op)) throw new Error(`Say what to do: ${MEALIE_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Mealie", "read", async (token) =>
      planMealie(
        await mealieDashboard(this.fetchImpl, service.localUrl, token),
        service.name,
        op,
        base,
      ),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Mealie", "change", (token) =>
        runMealie(this.fetchImpl, service.localUrl, token, p),
      );
    } catch (error) {
      if (!(error instanceof MealieError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok },
    });
    return out;
  }

  /** Nothing here changes a setting: a backup can be deleted in Mealie, clean-ups are not undone. */
  undo(): Promise<StepOutcome | undefined> {
    return Promise.resolve(undefined);
  }
}

export function planMealie(
  d: MealieDashboard,
  name: string,
  op: MealieOp,
  base: PlannedStep,
): PlannedStep {
  const words: Record<MealieOp, [string, string, string]> = {
    backup: [`Make a backup of ${name} now`, `${d.backups.length} backups`, "one more"],
    "clean-temp": [`Clean ${name}'s temporary files`, d.storage.temp || "unknown", "empty"],
    "clean-images": [
      `Delete the ${d.storage.cleanableImages} images no recipe uses in ${name}`,
      `${d.storage.cleanableImages} unused`,
      "deleted",
    ],
    "clean-folders": [
      `Remove the ${d.storage.cleanableDirs} empty recipe folders in ${name}`,
      `${d.storage.cleanableDirs} empty`,
      "removed",
    ],
    unlock: [`Unlock every account locked by failed sign-ins in ${name}`, "locked", "unlocked"],
  };
  const [label, before, after] = words[op];
  return {
    ...base,
    label,
    serviceName: name,
    params: { op, backups: d.backups.map((b) => b.name).join("\n") },
    change: {
      summary: label,
      settings: [{ name: op === "backup" ? "Backups" : label, before, after }],
    },
  };
}

const PATHS: Record<Exclude<MealieOp, "backup" | "unlock">, string> = {
  "clean-temp": "/admin/maintenance/clean/temp",
  "clean-images": "/admin/maintenance/clean/images",
  "clean-folders": "/admin/maintenance/clean/recipe-folders",
};

export async function runMealie(
  fetchImpl: Fetch,
  base: string,
  token: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as MealieOp;
  const call = <T>(method: string, path: string) => ml<T>(fetchImpl, base, token, method, path);
  if (op === "backup") {
    const had = new Set(
      String(p.backups ?? "")
        .split("\n")
        .filter(Boolean),
    );
    await call("POST", "/admin/backups");
    const now =
      (await call<{ imports?: { name: string; size?: string }[] }>("GET", "/admin/backups"))
        .imports ?? [];
    const made = now.find((b) => !had.has(b.name));
    return made
      ? {
          ok: true,
          verified: true,
          result: `Mealie made the backup ${made.name}${made.size ? ` (${made.size})` : ""}.`,
        }
      : { ok: false, result: "Mealie answered, but no new backup is in its list." };
  }
  if (op === "unlock") {
    const r = await call<{ unlocked?: number }>("POST", "/admin/users/unlock?force=true");
    const n = r?.unlocked ?? 0;
    return {
      ok: true,
      verified: true,
      result: n
        ? `Mealie unlocked ${n === 1 ? "1 account" : `${n} accounts`}.`
        : "No account was locked.",
    };
  }
  const r = await call<{ message?: string }>("POST", PATHS[op]);
  return { ok: true, result: r?.message ? `Mealie: ${r.message}.` : "Mealie did it." };
}
