import { describe, expect, it } from "vitest";
import {
  READ_COMMANDS,
  haCommands,
  readHomeAssistant,
  readHomeAssistantSection,
  type SocketFactory,
  type SocketLike,
} from "./homeassistant";
import { AppKeyError, type Fetch } from "./http";

const TOKEN = "ha-token-secret-123";
const BASE = "http://192.168.1.10:8123";

const STATES = [
  {
    entity_id: "light.porch",
    state: "off",
    attributes: { friendly_name: "Porch light" },
    last_changed: "2026-10-09T18:00:00Z",
  },
  {
    entity_id: "sensor.garage_temp",
    state: "unavailable",
    attributes: { friendly_name: "Garage temp", unit_of_measurement: "°C" },
  },
  {
    entity_id: "camera.door",
    state: "idle",
    attributes: {
      friendly_name: "Door",
      entity_picture: "/api/camera_proxy/camera.door?token=camtoken999",
      access_token: "camtoken999",
    },
  },
  {
    entity_id: "input_text.alarm_code",
    state: "4321",
    attributes: { friendly_name: "Alarm code", mode: "password" },
  },
  {
    entity_id: "automation.porch_at_sunset",
    state: "on",
    attributes: {
      friendly_name: "Porch light at sunset",
      last_triggered: "2026-10-09T18:31:00Z",
      id: "1",
    },
  },
];

function fakeHa(opts: { status?: Record<string, number>; log?: string } = {}) {
  const calls: { method: string; url: string; auth?: string }[] = [];
  const routes: Record<string, unknown> = {
    "/api/config": {
      version: "2026.10.1",
      state: "RUNNING",
      latitude: 33.4,
      longitude: -112.0,
      elevation: 340,
      components: ["zha", "met"],
    },
    "/api/states": STATES,
    "/api/config/config_entries/entry": [
      {
        entry_id: "e1",
        domain: "zha",
        title: "Zigbee",
        state: "setup_retry",
        reason: "Failed to connect apikey=0123456789abcdef0123456789abcdef",
      },
      { entry_id: "e2", domain: "met", title: "Home", state: "loaded" },
    ],
  };
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ method: init.method ?? "GET", url, auth: init.headers.Authorization });
    const path = new URL(url).pathname;
    const status =
      opts.status?.[path] ?? (init.headers.Authorization === `Bearer ${TOKEN}` ? 200 : 401);
    return {
      ok: status < 400,
      status,
      json: async () => routes[path] ?? [],
      text: async () => opts.log ?? "",
    };
  };
  return { fetchImpl, calls };
}

/** A stand-in for Home Assistant's WebSocket: auth, then answers list commands. */
function fakeSocket(results: Record<string, unknown>, opts: { badToken?: boolean } = {}) {
  const sent: string[] = [];
  const factory: SocketFactory = () => {
    const handlers: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    const emit = (type: string, data?: unknown) =>
      queueMicrotask(() => handlers[type]?.forEach((h) => h({ data: JSON.stringify(data) })));
    const ws: SocketLike = {
      addEventListener: (type, fn) => ((handlers[type] ??= []).push(fn), undefined),
      close: () => undefined,
      send: (data) => {
        sent.push(data);
        const msg = JSON.parse(data) as { type: string; id?: number; access_token?: string };
        if (msg.type === "auth") {
          emit("message", {
            type: opts.badToken || msg.access_token !== TOKEN ? "auth_invalid" : "auth_ok",
          });
        } else {
          emit("message", {
            type: "result",
            id: msg.id,
            success: msg.type in results,
            result: results[msg.type],
          });
        }
      },
    };
    emit("message", { type: "auth_required" });
    return ws;
  };
  return { factory, sent };
}

describe("reading Home Assistant", () => {
  it("reports health, failing integrations, and repairs, read only and without the home's location", async () => {
    const { fetchImpl, calls } = fakeHa();
    const { factory, sent } = fakeSocket({
      "repairs/list_issues": {
        issues: [
          {
            domain: "homeassistant",
            issue_id: "deprecated_yaml",
            severity: "warning",
            translation_key: "deprecated_yaml",
          },
        ],
      },
    });
    const r = await readHomeAssistant(BASE, TOKEN, fetchImpl, factory);
    expect(r).toMatchObject({ app: "homeassistant", version: "2026.10.1", status: "attention" });
    expect(r.issues.map((i) => i.text)).toEqual([
      expect.stringMatching(/^Zigbee \(zha\) keeps retrying setup: Failed to connect apikey=/),
      "Repair needed (homeassistant): deprecated yaml.",
    ]);
    expect(r.facts).toContainEqual({ label: "Unavailable", value: "1" });
    expect(r.facts).toContainEqual({ label: "Automations", value: "1 (1 on)" });
    expect(r.activity?.[0]?.text).toBe("Automation ran: Porch light at sunset");
    const json = JSON.stringify(r);
    expect(json).not.toContain("33.4");
    expect(json).not.toContain("0123456789abcdef0123456789abcdef");
    expect(json).not.toContain(TOKEN);
    // Only GETs, only to Home Assistant's address, token in the header; only list commands.
    expect(
      calls.every(
        (c) => c.method === "GET" && c.url.startsWith(BASE) && c.auth === `Bearer ${TOKEN}`,
      ),
    ).toBe(true);
    const commands = sent
      .map((s) => (JSON.parse(s) as { type: string }).type)
      .filter((t) => t !== "auth");
    expect(commands.every((c) => (READ_COMMANDS as readonly string[]).includes(c))).toBe(true);
  });

  it("works with a non-administrator's token, saying what it cannot list", async () => {
    const { fetchImpl } = fakeHa({ status: { "/api/config/config_entries/entry": 403 } });
    const r = await readHomeAssistant(BASE, TOKEN, fetchImpl, fakeSocket({}).factory);
    expect(r.facts).toContainEqual({
      label: "Integrations",
      value: "Needs an administrator's token to list",
    });
    const devices = await readHomeAssistantSection(
      BASE,
      TOKEN,
      fetchImpl,
      { section: "devices" },
      fakeSocket({}).factory,
    );
    expect(devices).toEqual({
      note: expect.stringMatching(/only shows the device list to an administrator/),
    });
  });

  it("calls a refused token rejected, over HTTP and the live connection", async () => {
    const { fetchImpl } = fakeHa();
    await expect(
      readHomeAssistant(BASE, "wrong", fetchImpl, fakeSocket({}).factory),
    ).rejects.toBeInstanceOf(AppKeyError);
    await expect(
      haCommands(BASE, TOKEN, ["repairs/list_issues"], fakeSocket({}, { badToken: true }).factory),
    ).rejects.toBeInstanceOf(AppKeyError);
  });

  it("never passes on attributes that carry tokens, or a password helper's value", async () => {
    const { fetchImpl } = fakeHa();
    const out = JSON.stringify(
      await readHomeAssistantSection(BASE, TOKEN, fetchImpl, { section: "entities" }),
    );
    expect(out).not.toContain("camtoken999");
    expect(out).not.toContain("4321");
    expect(out).toContain('"state":"[hidden]"');
    expect(out).toContain("Porch light");
    const lights = (await readHomeAssistantSection(BASE, TOKEN, fetchImpl, {
      section: "entities",
      domain: "light",
    })) as {
      total: number;
    };
    expect(lights.total).toBe(1);
  });

  it("reads the error log with secrets hidden, and devices with their areas", async () => {
    const { fetchImpl } = fakeHa({
      log: "2026-10-09 ERROR (MainThread) [zha] Cannot connect\n2026-10-09 WARNING token=abcdefabcdefabcdefabcdefabcdefab here\n",
    });
    const log = (await readHomeAssistantSection(BASE, TOKEN, fetchImpl, {
      section: "error_log",
      search: "token",
    })) as {
      lines: string[];
    };
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).not.toContain("abcdefabcdefabcdefabcdefabcdefab");
    const devices = await readHomeAssistantSection(
      BASE,
      TOKEN,
      fetchImpl,
      { section: "devices" },
      fakeSocket({
        "config/device_registry/list": [
          {
            id: "d1",
            name: "Sonoff ZBDongle",
            manufacturer: "ITead",
            model: "ZBDongle-E",
            area_id: "office",
          },
        ],
        "config/area_registry/list": [{ area_id: "office", name: "Office" }],
      }).factory,
    );
    expect(devices).toEqual({
      total: 1,
      devices: [
        { name: "Sonoff ZBDongle", manufacturer: "ITead", model: "ZBDongle-E", area: "Office" },
      ],
    });
  });

  it("only reads the logbook for one well-formed entity", async () => {
    const { fetchImpl, calls } = fakeHa();
    const bad = await readHomeAssistantSection(BASE, TOKEN, fetchImpl, {
      section: "logbook",
      entityId: "light.x/../../api/services",
    });
    expect(bad).toEqual({ note: expect.stringMatching(/needs one entity id/) });
    expect(calls).toHaveLength(0);
  });
});
