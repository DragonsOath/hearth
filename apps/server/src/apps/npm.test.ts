import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { fakeNpm } from "./fake-npm";
import { forgetNpmTokens, NpmClient, npmDashboard, npmSites, npmTime, readNpm } from "./npm";
import { NpmOperations } from "./npm-control";

/**
 * Nginx Proxy Manager against the stand-in (answering as a throwaway NPM 2.16.0 did;
 * npm-real.test.ts runs the same calls against a real one): the panel's reads, the sites it gives
 * "Open web UI", and every change as a protected plan, read back.
 */

const BASE = "http://10.0.0.9:81";
const LOGIN = { username: "alex@example.com", password: "e2e-npm" };
const service = { id: "np", name: "NPM", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const npm = fakeNpm();
  let signIns = 0;
  const fetch: typeof npm.fetch = (url, init) => {
    if (url.endsWith("/api/tokens")) signIns++;
    return npm.fetch(url, init);
  };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: LOGIN.password, username: LOGIN.username }),
  } as unknown as CredentialBroker;
  const ops = new NpmOperations(handle, broker, fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-npm-control" as const,
    serviceId: "np",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  const client = new NpmClient(BASE, LOGIN, fetch);
  return { npm, ops, go, step, client, fetch, signIns: () => signIns };
}

beforeEach(() => forgetNpmTokens());

describe("reading Nginx Proxy Manager", () => {
  it("reads hosts, certificates and activity, and never NPM's secrets", async () => {
    const { client, signIns } = setup();
    const d = await npmDashboard(client);
    expect(d.version).toBe("2.16.0");
    expect(d.hosts[0]).toMatchObject({
      domains: ["broken.example.com"],
      online: false,
      error: 'unknown directive "this"',
    });
    expect(d.hosts[1]).toMatchObject({
      domains: ["radarr.example.com"],
      forward: "http://192.168.1.10:7878",
      certificate: { id: 1, name: "example.com" },
      accessList: "Family only",
      sslForced: true,
    });
    expect(d.certificates[0]).toMatchObject({
      provider: "letsencrypt",
      usedBy: ["radarr.example.com"],
    });
    expect(d.redirections[0]).toEqual({
      id: 1,
      domains: ["old.example.com"],
      to: "https://new.example.com",
      enabled: true,
    });
    expect(d.activity[0]).toMatchObject({
      who: "Alex",
      action: "updated",
      what: "proxy host radarr.example.com",
    });
    expect(JSON.stringify(d)).not.toContain("e2e-SECRET");
    await npmDashboard(client);
    expect(signIns()).toBe(1);
    expect(npmTime("2026-11-28 01:39:05")).toBe("2026-11-28T01:39:05.000Z");
  });

  it("reports a site nginx could not load and a certificate expiring soon; a wrong password plainly", async () => {
    const { fetch } = setup();
    const r = await readNpm(BASE, LOGIN, fetch);
    expect(r.issues.map((i) => i.key)).toEqual(["hosts-offline", "certificates-expiring"]);
    expect(r.status).toBe("failing");
    await expect(readNpm(BASE, { ...LOGIN, password: "wrong" }, fetch)).rejects.toThrow(
      /refused the email or password/,
    );
  });

  it("gives its sites and where they forward to Hearth's Open web UI addresses", async () => {
    const { client } = setup();
    expect(await npmSites(client)).toEqual([
      { site: "radarr.example.com", upstream: "192.168.1.10:7878" },
      { site: "broken.example.com", upstream: "192.168.1.11:80" },
    ]);
  });
});

describe("changing Nginx Proxy Manager, each a protected plan read back", () => {
  it("switches a site off and on, marked protected, refusing what would change nothing", async () => {
    const { go, ops, npm, step } = setup();
    const off = await go({ op: "host-disable", hostId: 1, protected: "no" });
    expect(off.planned.params).toMatchObject({ protected: "yes" });
    expect(off.planned.label).toBe(
      "Switch off radarr.example.com in NPM (visitors get no site until it is on again)",
    );
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    await expect(ops.plan(service, { op: "host-disable", hostId: 1 }, base)).rejects.toThrow(
      /already off/,
    );
    expect(await ops.undo(step(off.planned.params), service)).toMatchObject({ ok: true });
    expect(npm.hosts().find((h) => h.id === 1)!.enabled).toBe(true);
  });

  it("changes where a site forwards, refusing a stale plan, and puts it back", async () => {
    const { go, ops, step, npm } = setup();
    const planned = await ops.plan(
      service,
      { op: "host-forward", hostId: 1, forwardHost: "192.168.1.20", forwardPort: 7878 },
      base,
    );
    expect(planned.change?.settings[0]).toEqual({
      name: "radarr.example.com",
      before: "http://192.168.1.10:7878",
      after: "http://192.168.1.20:7878",
    });
    const f = await go({ op: "host-forward", hostId: 1, forwardHost: "radarr", forwardPort: 7878 });
    expect(f.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.run(step(planned.params), service)).toMatchObject({ ok: false, stale: true });
    expect(await ops.undo(step(f.planned.params), service)).toMatchObject({ ok: true });
    expect(npm.hosts().find((h) => h.id === 1)!.forward_host).toBe("192.168.1.10");
    await expect(
      ops.plan(
        service,
        { op: "host-forward", hostId: 1, forwardHost: "bad host", forwardPort: 1 },
        base,
      ),
    ).rejects.toThrow(/address or name/);
  });

  it("adds a site with a certificate, removes one and puts it back, and renews a Let's Encrypt certificate", async () => {
    const { go, ops, step, npm } = setup();
    const add = await go({
      op: "host-add",
      domain: "sonarr.example.com",
      forwardHost: "192.168.1.10",
      forwardPort: 8989,
      certificateId: 1,
    });
    expect(add.planned.label).toBe(
      "Add the site sonarr.example.com to NPM, forwarding to http://192.168.1.10:8989 with the certificate example.com",
    );
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(
        service,
        { op: "host-add", domain: "sonarr.example.com", forwardHost: "x", forwardPort: 1 },
        base,
      ),
    ).rejects.toThrow(/already has a proxy host/);
    expect(await ops.undo(step(add.planned.params), service)).toMatchObject({ ok: true });
    const rm = await go({ op: "host-remove", hostId: 1 });
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(rm.planned.params), service)).toMatchObject({ ok: true });
    expect(npm.hosts().find((h) => h.domain_names[0] === "radarr.example.com")).toMatchObject({
      forward_port: 7878,
      certificate_id: 1,
    });
    const renew = await go({ op: "cert-renew", certificateId: 1 });
    expect(renew.outcome).toMatchObject({ ok: true, verified: true });
    await expect(ops.plan(service, { op: "cert-renew", certificateId: 2 }, base)).rejects.toThrow(
      /uploaded, not from Let's Encrypt/,
    );
  });
});
