import { eq } from "drizzle-orm";
import { ACTIONS } from "@dragon-control/core";
import type { ContainerTools } from "../actions/tools";
import type { AppWatcher } from "../apps/service";
import type { Vault } from "../auth/vault";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { CredentialSources } from "./sources";

/**
 * "credential-import" as a plan step, so Ember can get an app's key itself instead of telling
 * the owner to: Hearth reads the key from the app's own settings file on this machine and
 * stores it straight in the vault. The owner approves the plan after confirming it is them
 * (the step is marked protected), the value is never returned, shown, logged, or given to the
 * AI, and the result says only where it was stored.
 */
export interface KeyImports {
  plan(serviceId: string): Promise<PlannedStep>;
  run(step: StepRun): Promise<StepOutcome>;
}

export function keyImportOperations(
  handle: DbHandle,
  vault: Vault,
  containers: ContainerTools,
  /** Hearth's app watcher: after a key is stored, the app is read with it to test the connection. */
  watcher?: AppWatcher,
): KeyImports {
  const sources = new CredentialSources(handle, vault, containers);
  const service = (id: string) =>
    handle.db.select().from(t.services).where(eq(t.services.id, id)).get();
  const stored = async (serviceId: string) =>
    (await vault.list()).find((s) => s.serviceId === serviceId && s.kind === "api-key");

  return {
    async plan(serviceId) {
      const s = await service(serviceId);
      const name = s?.name ?? serviceId;
      const base = {
        label: ACTIONS["credential-import"].describe(name),
        serviceName: name,
        changes: true,
      };
      if (!s) return { ...base, policy: "refuse", policyReason: "No such service." };
      const existing = await stored(serviceId);
      if (existing)
        return {
          ...base,
          policy: "refuse",
          policyReason: `${name} already has a key in Secure Vault ("${existing.name}").`,
        };
      const found = await sources.detect(s);
      if (!found.length)
        return {
          ...base,
          policy: "refuse",
          policyReason: `Hearth cannot find a key in ${name}'s settings on this machine (it may run on another machine, or keep only a hashed password, like qBittorrent). Its login has to be added in Secure Vault.`,
        };
      return {
        ...base,
        policy: "approve-first",
        policyReason: `${found[0]!.description} Hearth reads it and stores it in Secure Vault; Ember never sees it. Approving needs you to confirm it's you.`,
        params: { protected: "yes" },
      };
    },

    async run(step) {
      const s = await service(step.serviceId);
      if (!s) return { ok: false, stale: true, result: "The service is gone; nothing was done." };
      const existing = await stored(step.serviceId);
      if (existing)
        return {
          ok: true,
          result: `${s.name} already had a key in Secure Vault ("${existing.name}"); nothing was changed.`,
        };
      try {
        const done = await sources.import(step.serviceId, "app-settings-file");
        // Verified, not assumed: the vault must now hold it, linked to the service.
        if (!(await vault.exists(done.secretId)))
          return { ok: false, result: "The key was read but is not in the vault afterwards." };
        const stored = `Stored as "${done.name}" in Secure Vault; the key itself was never shown or given to Ember.`;
        if (!watcher) return { ok: true, result: stored };
        // Connected means Hearth actually read the app with it, not that the key was saved.
        await watcher.check([step.serviceId]).catch(() => undefined);
        const now = (await watcher.broker.status()).find((c) => c.serviceId === step.serviceId);
        if (now?.state === "working")
          return { ok: true, result: `${stored} Connected: Hearth read ${s.name} with it.` };
        return {
          ok: false,
          result: `${stored} But ${s.name} did not accept it yet${now?.secret?.lastFailure ? `: ${now.secret.lastFailure}` : " (Hearth could not read the app with it)"}.`,
        };
      } catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
