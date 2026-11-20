import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeWgEasy } from "./fake-wgeasy";
import { readWgEasy, toPeer, wgEasyDashboard } from "./wgeasy";
import { parseDate, WgEasyOperations } from "./wgeasy-control";

/**
 * wg-easy against the stand-in (answering as a throwaway 15 did; wgeasy-real.test.ts runs the same
 * calls against a real one): clients, handshakes and traffic with no keys, and every change as a
 * protected plan read back and undone. Nothing ever asks for a client's configuration.
 */

const BASE = "http://10.0.0.9:51821";
const LOGIN = { username: "admin", password: "e2e-wg" };
const service = { id: "wg", name: "wg-easy", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeWgEasy();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: LOGIN.password, username: LOGIN.username }),
  } as unknown as CredentialBroker;
  const ops = new WgEasyOperations(handle, broker, fake.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-wgeasy-control" as const,
    serviceId: "wg",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    const outcome = await ops.run(step(planned.params), service);
    return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
  };
  const peer = async (id: number) =>
    (await wgEasyDashboard(fake.fetch, BASE, LOGIN)).peers.find((p) => p.id === id);
  return { fake, go, peer };
}

describe("reading wg-easy", () => {
  it("reads clients, handshakes, traffic and settings, and no keys", async () => {
    const { fake } = setup();
    const d = await wgEasyDashboard(fake.fetch, BASE, LOGIN);
    expect(d).toMatchObject({
      version: "15.2.2",
      latest: "15.3.0",
      host: "vpn.example.com",
      port: 51820,
      subnet: "10.8.0.0/24",
      dns: ["1.1.1.1"],
      allowedIps: ["0.0.0.0/0", "::/0"],
    });
    expect(d.peers.map((p) => [p.name, p.enabled, p.connected])).toEqual([
      ["Alex's phone", true, true],
      ["guest tablet", false, false],
      ["laptop", true, false],
    ]);
    expect(d.peers.find((p) => p.id === 1)).toMatchObject({
      from: "203.0.113.24:51413",
      receivedBytes: 482_000_000,
      sentBytes: 3_100_000_000,
    });
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(fake.askedForSecrets()).toBe(false);
  });

  it("reports an update and refuses a wrong password plainly", async () => {
    const { fake } = setup();
    const r = await readWgEasy(BASE, LOGIN, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["update"]);
    expect(r.facts).toEqual(
      expect.arrayContaining([
        { label: "Connected now", value: "1 of 2" },
        { label: "Turned off", value: "1" },
      ]),
    );
    await expect(
      wgEasyDashboard(fake.fetch, BASE, { username: "admin", password: "wrong" }),
    ).rejects.toThrow(/refused the username or password/);
  });

  it("counts a peer as connected only after a recent handshake, and reads dates", () => {
    const now = Date.parse("2026-11-08T12:00:00Z");
    expect(
      toPeer({ id: 1, name: "a", latestHandshakeAt: "2026-11-08T11:58:30Z" }, now).connected,
    ).toBe(true);
    expect(
      toPeer({ id: 1, name: "a", latestHandshakeAt: "2026-11-08T11:50:00Z" }, now).connected,
    ).toBe(false);
    expect(parseDate("2026-12-31")).toBe("2026-12-31T00:00:00.000Z");
    expect(parseDate("none")).toBe("");
    expect(() => parseDate("soon")).toThrow(/YYYY-MM-DD/);
  });
});

describe("changing wg-easy", () => {
  it("turns a client off as a protected plan, read back, and on again", async () => {
    const { go, peer } = setup();
    const r = await go({ op: "disable", clientId: 1 });
    expect(r.planned.params?.protected).toBe("yes");
    expect(r.planned.label).toBe(
      "Turn off Alex's phone in wg-easy (it cannot connect until turned on; nothing is deleted): it is connected now and drops",
    );
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    await r.undo();
    expect((await peer(1))!.enabled).toBe(true);
  });

  it("adds a client with an end date and removes it on undo, without fetching its keys", async () => {
    const { go, fake } = setup();
    const r = await go({ op: "add", name: "Sam's phone", value: "2026-12-31" });
    expect(r.planned.label).toBe(
      "Add a WireGuard client Sam's phone to wg-easy until 2026-12-31 (then scan its QR code in wg-easy on the device)",
    );
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    await expect(go({ op: "add", name: "laptop" })).rejects.toThrow(/already has a client/);
    expect((await r.undo())?.ok).toBe(true);
    expect(fake.askedForSecrets()).toBe(false);
  });

  it("renames and sets an end date through the whole-client update, each undone", async () => {
    const { go, peer } = setup();
    const ren = await go({ op: "rename", clientId: 2, value: "work laptop" });
    expect(ren.outcome).toMatchObject({ ok: true, verified: true });
    await ren.undo();
    expect((await peer(2))!.name).toBe("laptop");
    const exp = await go({ op: "expiry", clientId: 2, value: "2027-01-31" });
    expect(exp.outcome).toMatchObject({ ok: true, result: "laptop turns off on 2027-01-31." });
    await exp.undo();
    expect((await peer(2))!.expiresAt).toBeUndefined();
  });

  it("removes a client for good and restarts WireGuard", async () => {
    const { go } = setup();
    const rm = await go({ op: "remove", clientId: 3 });
    expect(rm.planned.label).toContain("stops working for good");
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await rm.undo()).toBeUndefined();
    const rs = await go({ op: "restart" });
    expect(rs.planned.label).toContain("including you if you are connected through it");
    expect(rs.outcome.ok).toBe(true);
  });
});
