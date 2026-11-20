import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeTailscale } from "./fake-tailscale";
import { readTailscale, tailscaleDashboard, toDevice } from "./tailscale";
import { TailscaleOperations } from "./tailscale-control";

/**
 * Tailscale against the stand-in, which follows Tailscale's official API client (no real tailnet
 * was available to test against): what the panel reads, no device keys, the token sent only to
 * api.tailscale.com, and every change as a protected plan read back and undone.
 */

const KEY = "tskey-api-e2e-123";
const service = { id: "ts", name: "Tailscale", localUrl: "" };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const fake = fakeTailscale();
  const asked: string[] = [];
  const broker = {
    use: (s: { destination: string }, fn: (c: { value: string }) => unknown) => {
      asked.push(s.destination);
      return fn({ value: KEY });
    },
  } as unknown as CredentialBroker;
  const ops = new TailscaleOperations(handle, broker, fake.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-tailscale-control" as const,
    serviceId: "ts",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    const outcome = await ops.run(step(planned.params), service);
    return { planned, outcome, undo: () => ops.undo(step(planned.params), service) };
  };
  const dev = async (name: string) =>
    (await tailscaleDashboard(fake.fetch, KEY)).devices.find((d) => d.name === name)!;
  return { fake, go, dev, asked };
}

describe("reading Tailscale", () => {
  it("reads devices, approval, keys, exit nodes, routes and DNS, and no keys", async () => {
    const { fake } = setup();
    const d = await tailscaleDashboard(fake.fetch, KEY);
    expect(d.domain).toBe("tail1234.ts.net");
    expect(d.dns).toEqual({ magicDns: true, nameservers: ["1.1.1.1", "9.9.9.9"] });
    // Waiting for approval first, then by name.
    expect(d.devices.map((x) => [x.name, x.online, x.authorized])).toEqual([
      ["new-pi", true, false],
      ["friends-server", true, true],
      ["laptop", true, true],
      ["nas", true, true],
      ["phone", false, true],
    ]);
    const nas = d.devices.find((x) => x.name === "nas")!;
    expect(nas).toMatchObject({
      keyExpiryDisabled: true,
      exitNode: { offered: true, approved: false },
      routes: { offered: ["192.168.1.0/24"], approved: [] },
      addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
      clientVersion: "1.90.4",
    });
    expect(nas.keyExpires).toBeUndefined();
    expect(d.devices.find((x) => x.name === "phone")!.lastSeen).toBeDefined();
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });

  it("warns about devices waiting and keys running out, and refuses a wrong token plainly", async () => {
    const { fake } = setup();
    const r = await readTailscale(KEY, fake.fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["waiting", "keys-expiring"]);
    expect(r.issues[1]!.text).toMatch(/laptop \(\d days\)/);
    expect(r.facts).toEqual(
      expect.arrayContaining([
        { label: "Devices online", value: "3 of 4" },
        { label: "Exit nodes to approve", value: "1" },
        { label: "Updates", value: "1" },
      ]),
    );
    await expect(tailscaleDashboard(fake.fetch, "tskey-api-wrong")).rejects.toThrow(
      /refused the access token/,
    );
  });

  it("treats Tailscale's empty times as none", () => {
    expect(
      toDevice({ nodeId: "x", name: "a.b.ts.net", expires: "0001-01-01T00:00:00Z" }).keyExpires,
    ).toBeUndefined();
  });
});

describe("changing Tailscale", () => {
  it("approves a waiting device as a protected plan, read back, and undoes it", async () => {
    const { go, dev, asked } = setup();
    const r = await go({ op: "authorize", deviceId: (await dev("new-pi")).id });
    expect(r.planned.params?.protected).toBe("yes");
    expect(r.planned.label).toBe("Approve new-pi (linux, sam@example.com) to join the tailnet");
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect((await dev("new-pi")).authorized).toBe(true);
    await r.undo();
    expect((await dev("new-pi")).authorized).toBe(false);
    // The token only ever goes to Tailscale's API.
    expect(new Set(asked)).toEqual(new Set(["https://api.tailscale.com"]));
  });

  it("approves and withdraws an exit node and subnet routes", async () => {
    const { go, dev } = setup();
    const id = (await dev("nas")).id;
    const exit = await go({ op: "exit-approve", deviceId: id });
    expect(exit.planned.label).toContain("send all their internet traffic through it");
    expect(exit.outcome).toMatchObject({ ok: true, verified: true });
    const routes = await go({ op: "routes-approve", deviceId: id });
    expect(routes.planned.label).toContain("192.168.1.0/24");
    expect(routes.outcome.ok).toBe(true);
    expect((await dev("nas")).exitNode.approved).toBe(true);
    expect((await dev("nas")).routes.approved).toEqual(["192.168.1.0/24"]);
    // Withdrawing the exit node leaves the subnet route approved.
    await exit.undo();
    expect((await dev("nas")).exitNode.approved).toBe(false);
    expect((await dev("nas")).routes.approved).toEqual(["192.168.1.0/24"]);
    await expect(go({ op: "exit-approve", deviceId: (await dev("laptop")).id })).rejects.toThrow(
      /does not offer/,
    );
  });

  it("turns key expiry off and on, renames with undo, and removes", async () => {
    const { go, dev } = setup();
    const laptop = (await dev("laptop")).id;
    const k = await go({ op: "expiry-off", deviceId: laptop });
    expect(k.outcome).toMatchObject({ ok: true, verified: true });
    await k.undo();
    expect((await dev("laptop")).keyExpiryDisabled).toBe(false);
    const r = await go({ op: "rename", deviceId: laptop, value: "Work-Laptop" });
    expect(r.planned.label).toBe(
      "Rename laptop to work-laptop (its tailnet address changes to work-laptop.tail1234.ts.net)",
    );
    expect(r.outcome.ok).toBe(true);
    await r.undo();
    expect((await dev("laptop")).name).toBe("laptop");
    await expect(go({ op: "rename", deviceId: laptop, value: "nas" })).rejects.toThrow(
      /already called/,
    );
    await expect(go({ op: "rename", deviceId: laptop, value: "no spaces" })).rejects.toThrow(
      /letters, digits/,
    );
    const phone = (await dev("phone")).id;
    const rm = await go({ op: "remove", deviceId: phone });
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await rm.undo()).toBeUndefined();
  });

  it("leaves devices shared in from another tailnet alone", async () => {
    const { go, dev } = setup();
    await expect(go({ op: "remove", deviceId: (await dev("friends-server")).id })).rejects.toThrow(
      /another tailnet/,
    );
  });
});
