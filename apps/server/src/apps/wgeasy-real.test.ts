import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { readWgEasy, wg, wgEasyDashboard } from "./wgeasy";
import { WgEasyOperations } from "./wgeasy-control";

/**
 * The same reads and changes as wgeasy.test.ts against a real wg-easy 15: only a throwaway one made
 * for this, with its first user "admin" and at least one client. It runs only with
 * HEARTH_WGEASY_TEST_URL, HEARTH_WGEASY_TEST_PASSWORD_FILE and HEARTH_WGEASY_TEST_THROWAWAY=yes,
 * and puts back what it changes.
 */

const url = process.env.HEARTH_WGEASY_TEST_URL ?? "";
const file = process.env.HEARTH_WGEASY_TEST_PASSWORD_FILE;
const run = Boolean(url && file && process.env.HEARTH_WGEASY_TEST_THROWAWAY === "yes");
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)(
  `a real, throwaway wg-easy at ${url || "(none)"}`,
  { timeout: 60_000 },
  () => {
    const login = { username: "admin", password: run ? readFileSync(file!, "utf8").trim() : "" };
    const service = { id: "real", name: "wg-easy", localUrl: url };
    const broker = {
      use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
        fn({ value: login.password, username: login.username }),
    } as unknown as CredentialBroker;
    const ops = new WgEasyOperations(handle, broker, realFetch);
    const step = (params: PlannedStep["params"]) => ({
      kind: "app-wgeasy-control" as const,
      serviceId: "real",
      requestedBy: "you" as const,
      params: params!,
    });
    const go = async (params: PlannedStep["params"]) => {
      const planned = await ops.plan(service, params, base);
      const outcome = await ops.run(step(planned.params), service);
      return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
    };
    const peers = async () => (await wgEasyDashboard(realFetch, url, login)).peers;

    it("reads clients, handshakes, traffic and where clients connect, and no keys", async () => {
      const d = await wgEasyDashboard(realFetch, url, login);
      expect(d.peers.length).toBeGreaterThan(0);
      expect(d.host).toBeTruthy();
      expect(d.port).toBeGreaterThan(0);
      expect(d.subnet).toMatch(/\/\d+$/);
      expect(d.allowedIps.length).toBeGreaterThan(0);
      const json = JSON.stringify(d);
      for (const word of [
        "publicKey",
        "privateKey",
        "preSharedKey",
        "PrivateKey",
        "oneTimeLink",
        login.password,
      ])
        expect(json).not.toContain(word);
      const r = await readWgEasy(url, login, realFetch);
      expect(r.facts[0]!.label).toBe("Connected now");
    });

    it("adds a client, turns it off and on, renames it, sets an end date, and removes it", async () => {
      const name = `hearth${Date.now() % 100000}`;
      const add = await go({ op: "add", name });
      expect(add.planned.params?.protected).toBe("yes");
      expect(add.outcome).toMatchObject({ ok: true, verified: true });
      const id = (await peers()).find((p) => p.name === name)!.id;
      const off = await go({ op: "disable", clientId: id });
      expect(off.outcome).toMatchObject({ ok: true, verified: true });
      expect((await off.undo())?.ok).toBe(true);
      const ren = await go({ op: "rename", clientId: id, value: `${name}-x` });
      expect(ren.outcome).toMatchObject({ ok: true, verified: true });
      await ren.undo();
      expect((await peers()).find((p) => p.id === id)!.name).toBe(name);
      const exp = await go({ op: "expiry", clientId: id, value: "2099-12-31" });
      expect(exp.outcome).toMatchObject({ ok: true, verified: true });
      await exp.undo();
      expect((await peers()).find((p) => p.id === id)!.expiresAt).toBeUndefined();
      expect((await add.undo())?.ok).toBe(true);
      expect((await peers()).some((p) => p.id === id)).toBe(false);
    });

    it("restarts the interface, and refuses a wrong password plainly", async () => {
      expect((await go({ op: "restart" })).outcome.ok).toBe(true);
      await expect(
        wg(realFetch, url, { username: "admin", password: "wrong" }, "GET", "/api/client"),
      ).rejects.toThrow(/refused the username or password/);
    });
  },
);
