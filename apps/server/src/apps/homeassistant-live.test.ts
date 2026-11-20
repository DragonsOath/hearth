import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeHomeAssistant } from "./fake-homeassistant";
import { routineDetail } from "./homeassistant";
import { homeAssistantDashboard, HomeAssistantOperations } from "./homeassistant-live";
import { routineWords, runsOf } from "./homeassistant-routines";

/** Home Assistant's panel and controls, against a stand-in that answers like 2026.10. */

const BASE = "http://10.0.0.9:8123";
const KEY = "e2e-ha-token";
const service = { id: "ha", name: "Home Assistant", localUrl: BASE };
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
  kind: "app-homeassistant-control" as const,
  serviceId: "ha",
  requestedBy: "you" as const,
  params,
});
const ops = () =>
  new HomeAssistantOperations(handle, broker, fakeHomeAssistant().fetch, async () => undefined);

describe("the Home Assistant panel", () => {
  it("lists automations, switches, scenes, what is down, and failing integrations; never locks", async () => {
    const d = await homeAssistantDashboard(fakeHomeAssistant().fetch, BASE, KEY);
    expect(d.totals).toEqual({
      entities: 35,
      unavailable: 1,
      automations: 2,
      automationsOn: 1,
      integrationsFailing: 1,
    });
    expect(d.automations[0]).toMatchObject({ name: "Porch lights at sunset", on: true });
    expect(d.switches.map((s) => s.entityId)).toEqual([
      "input_boolean.guest_mode",
      "light.kitchen",
      "light.living_room",
      "switch.server_fan",
    ]);
    expect(d.integrations[0]?.problem).toBe(
      "keeps retrying setup: Could not reach the coordinator",
    );
    expect(JSON.stringify(d)).not.toContain("lock.front_door");
  });
});

describe("Home Assistant controls", () => {
  it("toggles a light and reads the new state back", async () => {
    const o = ops();
    const planned = await o.plan(service, { op: "toggle", entityId: "light.living_room" }, base);
    expect(planned.label).toBe("Turn on Living room in Home Assistant");
    expect(await o.run(step(planned.params), service)).toEqual({
      ok: true,
      result: "Living room is on. Home Assistant confirms it.",
    });
  });

  it("switches an automation off and runs a scene", async () => {
    const o = ops();
    const off = await o.plan(
      service,
      { op: "automation-off", entityId: "automation.porch_lights_at_sunset" },
      base,
    );
    expect(await o.run(step(off.params), service)).toMatchObject({ ok: true });
    await expect(
      o.plan(
        service,
        { op: "automation-off", entityId: "automation.porch_lights_at_sunset" },
        base,
      ),
    ).rejects.toThrow(/already off/);
    const scene = await o.plan(service, { op: "run-scene", entityId: "scene.good_morning" }, base);
    expect(await o.run(step(scene.params), service)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/^Home Assistant ran Good morning at .+\. It confirms it\.$/),
    });
  });

  it("reloads a failing integration and confirms it loaded", async () => {
    const o = ops();
    const planned = await o.plan(service, { op: "reload-integration", entryId: "abc123" }, base);
    expect(planned.label).toContain("Reload Zigbee (zha)");
    expect(await o.run(step(planned.params), service)).toMatchObject({ ok: true });
  });

  it("refuses locks and anything outside its list", async () => {
    const o = ops();
    await expect(
      o.plan(service, { op: "toggle", entityId: "lock.front_door" }, base),
    ).rejects.toThrow(/cannot be used/);
    await expect(
      o.plan(service, { op: "run-script", entityId: "automation.vacation_mode" }, base),
    ).rejects.toThrow(/cannot be used/);
  });
});

describe("routines and automations", () => {
  it("runs an everyday routine on its own and reads back that Home Assistant ran it", async () => {
    const o = ops();
    const p = await o.plan(service, { op: "run-script", entityId: "script.goodnight" }, base);
    expect(p.label).toBe("Run the routine Goodnight in Home Assistant (a Home Assistant script)");
    expect(p.params?.careful).toBeUndefined();
    expect(await o.run(step(p.params), service)).toMatchObject({
      ok: true,
      result: expect.stringMatching(/^Home Assistant ran Goodnight at .+\. It confirms it\.$/),
    });
  });

  it("marks a routine that locks a door, and refuses one that needs a question", async () => {
    const o = ops();
    const p = await o.plan(service, { op: "run-script", entityId: "script.leaving_home" }, base);
    expect(p.params?.careful).toBe("locks or unlocks doors");
    expect(p.label).toContain("Look first: it locks or unlocks doors");
    await expect(
      o.plan(service, { op: "run-script", entityId: "script.ask_assistant" }, base),
    ).rejects.toThrow("needs question each time it runs");
    // An automation's run says it skips its triggers and checks.
    const a = await o.plan(
      service,
      { op: "run-automation", entityId: "automation.porch_lights_at_sunset" },
      base,
    );
    expect(a.label).toContain("without waiting for its triggers and skipping its checks");
    expect(a.params?.careful).toBeUndefined();
  });

  it("describes a routine in plain words, with its last runs", async () => {
    const ha = fakeHomeAssistant();
    const auto = await routineDetail(
      BASE,
      KEY,
      ha.fetch,
      "automation.porch_lights_at_sunset",
      ha.socket,
    );
    expect(auto).toMatchObject({
      name: "Porch lights at sunset",
      triggers: ["At sunset"],
      conditions: ["Only if Server fan is on"],
      steps: ["Turn on Living room"],
      careful: [],
    });
    const night = await routineDetail(BASE, KEY, ha.fetch, "script.goodnight", ha.socket);
    expect(night.steps).toEqual(["Turn off Living room", "Turn on Kitchen (50%, red)"]);
    expect(night.runs).toHaveLength(1);
    expect(night.runs?.[0]).toMatchObject({ result: "Finished", ok: true });
    const vacation = await routineDetail(
      BASE,
      KEY,
      ha.fetch,
      "automation.vacation_mode",
      ha.socket,
    );
    expect(vacation).toMatchObject({
      triggers: ["At 20:00:00"],
      steps: ["Lock Front door"],
      careful: ["locks or unlocks doors"],
    });
  });
});

describe("routine words", () => {
  it("reads nested steps, unknown actions, and failed runs", () => {
    const w = routineWords(
      {
        sequence: [
          { delay: { minutes: 5 } },
          { if: [], then: [{ action: "cover.open_cover", target: { entity_id: "cover.garage" } }] },
          {
            action: "media_player.select_source",
            target: { entity_id: "media_player.tv" },
            data: { source: "com.edde746.plezy" },
          },
        ],
      },
      (id) => (id === "media_player.tv" ? "TV" : id),
    );
    expect(w.steps).toEqual([
      "Wait 5 minutes",
      "Do something only if a check passes",
      "TV: open Plezy",
    ]);
    expect(w.careful).toEqual(["opens or closes doors, blinds, or the garage"]);
    expect(
      runsOf([
        {
          timestamp: { start: "2026-10-26T06:00:00Z" },
          script_execution: "error",
          error: "Light not found",
        },
        { timestamp: { start: "2026-10-26T07:00:00Z" }, script_execution: "failed_conditions" },
      ]),
    ).toEqual([
      {
        at: "2026-10-26T07:00:00Z",
        result: "Did not run its steps: a check did not pass",
        ok: true,
      },
      { at: "2026-10-26T06:00:00Z", result: "Failed", ok: false, error: "Light not found" },
    ]);
  });
});
