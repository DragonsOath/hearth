import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { forgetKumaTokens, kumaDashboard, readUptimeKuma } from "./uptimekuma";
import { KumaOperations } from "./uptimekuma-control";

/**
 * The same reads and changes as uptimekuma.test.ts against a real Uptime Kuma: only a throwaway
 * one made for this, with its first user "admin" and two monitors ("Kuma itself", up, and "Nothing
 * there", down) and a manual maintenance window "Disk swap". It runs only with HEARTH_KUMA_TEST_URLS (one or more addresses, comma separated,
 * so 1.x and 2.x run together), HEARTH_KUMA_TEST_PASSWORD_FILE and HEARTH_KUMA_TEST_THROWAWAY=yes.
 * It removes the monitor it adds and leaves the others as it found them.
 */

const urls = (process.env.HEARTH_KUMA_TEST_URLS ?? "").split(",").filter(Boolean);
const file = process.env.HEARTH_KUMA_TEST_PASSWORD_FILE;
const run = Boolean(urls.length && file && process.env.HEARTH_KUMA_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

for (const url of run ? urls : ["(none)"])
  describe.skipIf(!run)(`a real, throwaway Uptime Kuma at ${url}`, () => {
    const login = { username: "admin", password: run ? readFileSync(file!, "utf8").trim() : "" };
    const service = { id: "real", name: "Uptime Kuma", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
        fn({ value: login.password, username: login.username }),
    } as unknown as CredentialBroker;
    const ops = new KumaOperations(handle, broker, realFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-uptimekuma-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });
    const go = async (params: PlannedStep["params"]) => {
      const planned = await ops.plan(service, params, base);
      return { planned, outcome: await ops.run(step(planned.params), service) };
    };

    it("reads monitors, heartbeats, uptime and response times", async () => {
      forgetKumaTokens();
      const d = await kumaDashboard(realFetch, url, login);
      expect(d.version).toMatch(/^[12]\./);
      const up = d.monitors.find((m) => m.name === "Kuma itself")!;
      const down = d.monitors.find((m) => m.name === "Nothing there")!;
      expect(up).toMatchObject({ status: "up", target: "http://127.0.0.1:3001", uptime24h: 1 });
      expect(up.beats.length).toBeGreaterThan(0);
      expect(up.avgPingMs).toBeGreaterThan(0);
      expect(up.since).toBeDefined();
      expect(down.status).toBe("down");
      expect(down.message).toMatch(/ECONNREFUSED|timeout|EHOSTUNREACH|ENETUNREACH/i);
      expect(d.events.some((e) => e.monitor === "Nothing there" && e.status === "down")).toBe(true);
      const r = await readUptimeKuma(url, login, realFetch);
      expect(r.issues.map((i) => i.key)).toContain("monitors-down");
    }, 60_000);

    it("pauses and resumes a monitor, read back", async () => {
      const id = (await kumaDashboard(realFetch, url, login)).monitors.find(
        (m) => m.name === "Nothing there",
      )!.id;
      const p = await go({ op: "pause", monitorId: id });
      expect(p.outcome).toMatchObject({ ok: true, verified: true });
      const r = await go({ op: "resume", monitorId: id });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
    }, 60_000);

    it("pauses a maintenance window and resumes it", async () => {
      const w = (await kumaDashboard(realFetch, url, login)).maintenance.find(
        (x) => x.title === "Disk swap",
      )!;
      expect(w.active).toBe(true);
      const p = await go({ op: "maintenance-pause", maintenanceId: w.id });
      expect(p.outcome).toMatchObject({ ok: true, verified: true });
      const r = await go({ op: "maintenance-resume", maintenanceId: w.id });
      expect(r.outcome).toMatchObject({ ok: true, verified: true });
    }, 60_000);

    it("adds a website monitor and removes it", async () => {
      const added = await go({
        op: "add",
        name: "Hearth test",
        url: "http://127.0.0.1:3001/dashboard",
      });
      expect(added.outcome).toMatchObject({ ok: true, verified: true });
      const id = (await kumaDashboard(realFetch, url, login)).monitors.find(
        (m) => m.name === "Hearth test",
      )!.id;
      const removed = await go({ op: "remove", monitorId: id });
      expect(removed.outcome).toMatchObject({ ok: true, verified: true });
    }, 90_000);
  });
