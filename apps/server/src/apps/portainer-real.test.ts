import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { PortainerClient, portainerDashboard, readPortainer } from "./portainer";
import { PortainerOperations } from "./portainer-control";

/**
 * The same reads and changes as portainer.test.ts against a real Portainer: only a throwaway one
 * made for this, with a throwaway stack "webtest" (an nginx and a busybox). It runs only with all of
 * HEARTH_PORTAINER_TEST_URL, HEARTH_PORTAINER_TEST_KEY_FILE (an access token, read from a file) and
 * HEARTH_PORTAINER_TEST_THROWAWAY=yes. It leaves the stack running, as it found it.
 */

const url = process.env.HEARTH_PORTAINER_TEST_URL;
const file = process.env.HEARTH_PORTAINER_TEST_KEY_FILE;
const run = Boolean(url && file && process.env.HEARTH_PORTAINER_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)("a real, throwaway Portainer", () => {
  const key = run ? readFileSync(file!, "utf8").trim() : "";
  const service = { id: "real", name: "Portainer", localUrl: url! };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: key }),
  } as unknown as CredentialBroker;
  const ops = new PortainerOperations(handle, broker, realFetch);
  const client = new PortainerClient(url!, key, realFetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-portainer-control" as const,
    serviceId: "real",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };

  it("reads environments, stacks and containers, and refuses a wrong token", async () => {
    await expect(readPortainer(url!, "ptr_wrong", realFetch)).rejects.toThrow(/refused/);
    const d = await portainerDashboard(client);
    expect(d.version).toMatch(/^2\./);
    expect(d.stacks.find((s) => s.name === "webtest")).toMatchObject({ containers: 2 });
  });

  it("stops, starts and updates the stack, and restarts a container, read back", async () => {
    const d = await portainerDashboard(client);
    const s = d.stacks.find((x) => x.name === "webtest")!;
    const stop = await go({ op: "stack-stop", environmentId: s.environmentId, stackId: s.id });
    expect(stop.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(stop.planned.params), service)).toMatchObject({ ok: true });
    expect(
      (await go({ op: "stack-update", environmentId: s.environmentId, stackId: s.id })).outcome,
    ).toMatchObject({ ok: true, verified: true });
    expect(
      (
        await go({
          op: "container-restart",
          environmentId: s.environmentId,
          container: "webtest-web-1",
        })
      ).outcome,
    ).toMatchObject({ ok: true, verified: true });
    const off = await go({
      op: "container-stop",
      environmentId: s.environmentId,
      container: "webtest-sleeper-1",
    });
    expect(off.outcome, off.outcome.result).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(off.planned.params), service)).toMatchObject({ ok: true });
  }, 600_000);
});
