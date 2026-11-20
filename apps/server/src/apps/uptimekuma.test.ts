import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeUptimeKuma } from "./fake-uptimekuma";
import {
  cleanUrl,
  forgetKumaTokens,
  kumaDashboard,
  kumaTime,
  readUptimeKuma,
  targetOf,
} from "./uptimekuma";
import { KumaOperations, newMonitor } from "./uptimekuma-control";

/**
 * Uptime Kuma against the stand-in (answering its socket as a throwaway 2.5.9 did;
 * uptimekuma-real.test.ts runs the same calls against real 1.23.17 and 2.5.9): the panel's reads
 * without a single secret, the token kept so the password is sent once, and every change as a
 * plan read back.
 */

const BASE = "http://10.0.0.9:3001";
const LOGIN = { username: "admin", password: "e2e-kuma" };
const service = { id: "uk", name: "Uptime Kuma", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const kuma = fakeUptimeKuma();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: LOGIN.password, username: LOGIN.username }),
  } as unknown as CredentialBroker;
  const ops = new KumaOperations(handle, broker, kuma.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-uptimekuma-control" as const,
    serviceId: "uk",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  return { kuma, ops, go, step };
}

beforeEach(() => forgetKumaTokens());

describe("reading Uptime Kuma", () => {
  it("reads every monitor, its state, response time, uptime and certificate, and no secret", async () => {
    const { kuma } = setup();
    const d = await kumaDashboard(kuma.fetch, BASE, LOGIN);
    expect(d.version).toBe("2.5.9");
    expect(d.latestVersion).toBe("2.6.0");
    expect(d.monitors.map((m) => [m.name, m.status, m.group ?? ""])).toEqual([
      ["Home Assistant", "up", ""],
      ["Media", "pending", ""],
      ["Nightly backup", "up", ""],
      ["Old NAS", "paused", ""],
      ["Radarr", "up", "Media"],
      ["Sonarr", "down", "Media"],
    ]);
    const sonarr = d.monitors.find((m) => m.name === "Sonarr")!;
    expect(sonarr).toMatchObject({
      target: "http://sonarr.lan:8989",
      message: "connect ECONNREFUSED 10.0.0.9:8989",
      uptime24h: 0.87,
      uptime30d: 0.981,
      avgPingMs: 54.3,
      alerts: 1,
      parentId: 1,
    });
    expect(sonarr.beats).toHaveLength(30);
    expect(sonarr.beats.at(-1)!.status).toBe("down");
    expect(sonarr.since).toBe(sonarr.beats[26]!.at);
    expect(d.monitors.find((m) => m.name === "Home Assistant")).toMatchObject({
      certDaysLeft: 9,
      certValid: true,
    });
    expect(d.monitors.find((m) => m.name === "Old NAS")).toMatchObject({
      target: "192.168.1.20",
      alerts: 0,
    });
    expect(d.monitors.find((m) => m.name === "Nightly backup")!.target).toBeUndefined();
    // Recent state changes, newest first.
    expect(d.events[0]).toMatchObject({ monitor: "Sonarr", status: "down" });
    expect(d.maintenance).toEqual([
      { id: 1, title: "NAS disk swap", status: "scheduled", active: true },
    ]);
    expect(d.statusPages).toEqual([{ slug: "home", title: "Home services", published: true }]);
    expect(d.notifications).toEqual(["Discord"]);
    // Passwords in addresses, push tokens, headers and webhook addresses never come through.
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(d.monitors.find((m) => m.name === "Radarr")!.target).toBe("http://radarr.lan:7878");
  });

  it("signs in with the password once, then with Uptime Kuma's token", async () => {
    const { kuma } = setup();
    await kumaDashboard(kuma.fetch, BASE, LOGIN);
    await kumaDashboard(kuma.fetch, BASE, LOGIN);
    await kumaDashboard(kuma.fetch, BASE, LOGIN);
    expect(kuma.passwordLogins()).toBe(1);
  });

  it("names a wrong password as the vault's problem", async () => {
    const { kuma } = setup();
    await expect(
      kumaDashboard(kuma.fetch, BASE, { username: "admin", password: "wrong" }),
    ).rejects.toThrow(/refused the username or password/);
  });

  it("reports monitors down and certificates running out", async () => {
    const { kuma } = setup();
    const r = await readUptimeKuma(BASE, LOGIN, kuma.fetch);
    expect(r.status).toBe("attention");
    expect(r.issues.map((i) => i.key)).toEqual(["monitors-down", "certificates-expiring"]);
    expect(r.issues[0]!.text).toContain("Sonarr");
    expect(r.facts[0]).toEqual({ label: "Monitors up", value: "3 of 5" });
  });

  it("shows what a monitor checks without passwords or query strings", () => {
    expect(cleanUrl("https://u:p@x.lan:8443/health?token=1#a")).toBe("https://x.lan:8443/health");
    expect(cleanUrl("not a url")).toBeUndefined();
    expect(targetOf({ id: 1, name: "", type: "port", hostname: "nas", port: 22 })).toBe("nas:22");
    expect(targetOf({ id: 1, name: "", type: "docker", docker_container: "plex" })).toBe("plex");
    expect(kumaTime("2026-11-08 02:43:51.727")).toBe("2026-11-08T02:43:51.727Z");
  });

  it("fills in 2.x's extra monitor fields only for 2.x", () => {
    expect(newMonitor({ name: "A", url: "http://a" }, 2)).toHaveProperty("conditions");
    expect(newMonitor({ name: "A", url: "http://a" }, 1)).not.toHaveProperty("conditions");
  });
});

describe("changing Uptime Kuma", () => {
  it("pauses and resumes a monitor, read back", async () => {
    const { go } = setup();
    const paused = await go({ op: "pause", monitorId: 3 });
    expect(paused.planned.label).toBe(
      "Pause the monitor Sonarr (it stops checking and sends no alerts)",
    );
    expect(paused.outcome).toMatchObject({ ok: true, verified: true, result: "Sonarr is paused." });
    const resumed = await go({ op: "resume", monitorId: 3 });
    expect(resumed.outcome).toMatchObject({ ok: true, result: "Sonarr is checking again." });
    await expect(go({ op: "resume", monitorId: 3 })).rejects.toThrow(/already running/);
  });

  it("adds a website monitor, refuses a duplicate or a password in the address, and undoes it", async () => {
    const { go, ops, step } = setup();
    const added = await go({ op: "add", name: "Bazarr", url: "http://bazarr.lan:6767" });
    expect(added.planned.label).toBe(
      "Add a monitor Bazarr that checks http://bazarr.lan:6767 every 60 seconds",
    );
    expect(added.outcome).toMatchObject({ ok: true, verified: true });
    await expect(go({ op: "add", name: "Again", url: "http://bazarr.lan:6767/" })).rejects.toThrow(
      /Bazarr already checks/,
    );
    await expect(go({ op: "add", name: "X", url: "http://a:b@x.lan" })).rejects.toThrow(
      /password out/,
    );
    await expect(go({ op: "add", name: "X", url: "http://x.lan", interval: 5 })).rejects.toThrow(
      /20 to 86400/,
    );
    const undone = await ops.undo(step(added.planned.params), service);
    expect(undone).toMatchObject({ ok: true, result: "Bazarr is removed." });
  });

  it("removes a group, keeping its monitors", async () => {
    const { go, kuma } = setup();
    const r = await go({ op: "remove", monitorId: 1 });
    expect(r.planned.label).toBe(
      "Remove the monitor Media and its history (its 2 monitors stay, out of the group)",
    );
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    const d = await kumaDashboard(kuma.fetch, BASE, LOGIN);
    expect(d.monitors.find((m) => m.name === "Sonarr")!.group).toBeUndefined();
  });

  it("pauses a maintenance window and resumes it", async () => {
    const { go } = setup();
    const p = await go({ op: "maintenance-pause", maintenanceId: 1 });
    expect(p.outcome).toMatchObject({ ok: true, result: "NAS disk swap is paused." });
    const r = await go({ op: "maintenance-resume", maintenanceId: 1 });
    expect(r.outcome).toMatchObject({ ok: true, result: "NAS disk swap is on (scheduled)." });
  });

  it("refuses a monitor or window that is not there", async () => {
    const { go } = setup();
    await expect(go({ op: "pause", monitorId: 99 })).rejects.toThrow(/no such monitor/);
    await expect(go({ op: "maintenance-pause", maintenanceId: 9 })).rejects.toThrow(
      /no such maintenance/,
    );
    await expect(go({ op: "explode" })).rejects.toThrow(/Say what to do/);
  });
});
