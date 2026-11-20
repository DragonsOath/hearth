import { describe, expect, it } from "vitest";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { ersatzDashboard, ErsatzOperations, guideFrom, readErsatz } from "./ersatztv";
import { fakeErsatz } from "./fake-ersatztv";

/** ErsatzTV's panel and controls, against a stand-in answering like 26.3 (no key). */

const BASE = "http://10.0.0.9:8409";
const service = { id: "etv", name: "ErsatzTV", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const step = (params: PlannedStep["params"]) => ({
  kind: "app-ersatztv-control" as const,
  serviceId: "etv",
  requestedBy: "you" as const,
  params,
});

describe("the ErsatzTV panel", () => {
  it("shows each channel with what is on now and next, and which are streaming", async () => {
    const d = await ersatzDashboard(fakeErsatz().fetch, BASE);
    expect(d.version).toBe("26.3.0");
    expect(d.channels.map((c) => c.number)).toEqual(["1", "101", "102"]);
    expect(d.channels[0]).toMatchObject({
      name: "Home Network TV",
      streaming: true,
      now: { title: "The Expanse: Dulcinea" },
      next: { title: "Arcane" },
    });
    expect(d.channels[1]?.now?.title).toBe("The Fellowship of the Ring");
    expect(d.channels[2]?.now).toBeUndefined();
  });

  it("reads the guide's own time zones", () => {
    const xml =
      '<channel id="C5.x"><display-name>Five</display-name><display-name>5</display-name></channel>' +
      '<programme start="20261020100000 -0700" stop="20261020120000 -0700" channel="C5.x"><title lang="en">Show &amp; Tell</title></programme>';
    const g = guideFrom(xml, Date.parse("2026-10-20T18:00:00Z"));
    expect(g.get("5")?.now).toEqual({ title: "Show & Tell", until: "2026-10-20T19:00:00.000Z" });
  });

  it("warns about channels with nothing on", async () => {
    const r = await readErsatz(BASE, fakeErsatz().fetch);
    expect(r.issues[0]?.text).toBe("1 ErsatzTV channels have nothing scheduled right now: Sci-Fi.");
  });
});

describe("ErsatzTV controls", () => {
  it("stops a channel's stream and checks it is gone; rebuilds a schedule", async () => {
    const o = new ErsatzOperations(handle, fakeErsatz().fetch);
    const stop = await o.plan(service, { op: "stop-stream", channel: "1" }, base);
    expect(stop.label).toContain("Stop the stream of channel 1 (Home Network TV)");
    expect(await o.run(step(stop.params), service)).toEqual({
      ok: true,
      result: "Home Network TV's stream is stopped. ErsatzTV confirms it.",
    });
    await expect(o.plan(service, { op: "stop-stream", channel: "1" }, base)).rejects.toThrow(
      /Nobody is streaming/,
    );
    const reset = await o.plan(service, { op: "reset-playout", channel: "102" }, base);
    expect(await o.run(step(reset.params), service)).toEqual({
      ok: true,
      result: "ErsatzTV is rebuilding Sci-Fi's schedule.",
    });
  });
});
