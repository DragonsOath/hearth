import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeProwlarr } from "./fake-prowlarr";
import { prowlarrDashboard, ProwlarrOperations } from "./prowlarr-live";

/** Prowlarr's panel and controls, against a stand-in that answers like Prowlarr 1.24. */

const BASE = "http://10.0.0.9:9696";
const KEY = "e2e-prowlarr-key";
const service = { id: "prowlarr", name: "Prowlarr", localUrl: BASE };
const broker = {
  use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: KEY }),
} as unknown as CredentialBroker;
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-prowlarr-indexer" as const,
  serviceId: "prowlarr",
  requestedBy: "you" as const,
  params,
});
const ops = () =>
  new ProwlarrOperations(handle, broker, fakeProwlarr().fetch, async () => undefined);

describe("the Prowlarr panel", () => {
  it("puts failing indexers first, with the week's numbers and proxies, and never their settings", async () => {
    const d = await prowlarrDashboard(fakeProwlarr().fetch, BASE, KEY);
    expect(d.totals).toEqual({ indexers: 3, enabled: 2, failing: 1, queries: 412, grabs: 37 });
    expect(d.indexers.map((i) => i.name)).toEqual(["Torrent Alpha", "Usenet Prime", "Old Tracker"]);
    expect(d.indexers[0]).toMatchObject({
      failing: true,
      failedQueries: 31,
      proxies: ["FlareSolverr"],
    });
    expect(d.indexers[0]?.pausedUntil).toBeTruthy();
    expect(d.apps).toEqual([
      { name: "Radarr", kind: "Radarr", sync: "full" },
      { name: "Sonarr", kind: "Sonarr", sync: "full" },
    ]);
    expect(JSON.stringify(d)).not.toContain("secret-indexer-key");
  });
});

describe("Prowlarr controls", () => {
  it("tests one indexer and reports Prowlarr's reason when it fails", async () => {
    const o = ops();
    const good = await o.plan(service, { op: "test", indexerId: 1 }, base);
    expect(await o.run(step(good.params), service)).toMatchObject({ ok: true });
    const bad = await o.plan(service, { op: "test", indexerId: 2 }, base);
    expect(await o.run(step(bad.params), service)).toEqual({
      ok: false,
      result: "Torrent Alpha failed its test: Blocked by CloudFlare Protection",
    });
  });

  it("tests all and names the failures", async () => {
    const o = ops();
    const planned = await o.plan(service, { op: "test-all" }, base);
    expect(planned.label).toBe("Test all 2 indexers in Prowlarr");
    expect(await o.run(step(planned.params), service)).toMatchObject({
      ok: true,
      result: "1 of 2 indexers work. Failing: Torrent Alpha (Blocked by CloudFlare Protection)",
    });
  });

  it("switches an indexer off keeping its settings, and reads it back", async () => {
    const o = ops();
    const planned = await o.plan(service, { op: "disable", indexerId: 2 }, base);
    expect(planned.label).toContain("Turn Torrent Alpha off");
    expect(await o.run(step(planned.params), service)).toMatchObject({
      ok: true,
      result: "Torrent Alpha is off. Prowlarr confirms it.",
    });
    await expect(o.plan(service, { op: "disable", indexerId: 2 }, base)).rejects.toThrow(
      /already off/,
    );
    const on = await o.plan(service, { op: "enable", indexerId: 3 }, base);
    expect(await o.run(step(on.params), service)).toMatchObject({ ok: true });
  });

  it("sends the indexers to the apps and waits for Prowlarr to finish", async () => {
    const o = ops();
    const planned = await o.plan(service, { op: "sync-apps" }, base);
    expect(planned.label).toBe("Send Prowlarr's indexers to Radarr, Sonarr");
    expect(await o.run(step(planned.params), service)).toEqual({
      ok: true,
      result: "Prowlarr sent its indexers to your apps.",
    });
  });
});
