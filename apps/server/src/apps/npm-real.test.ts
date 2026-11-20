import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import { forgetNpmTokens, NpmClient, npmDashboard, npmSites, readNpm } from "./npm";
import { NpmOperations } from "./npm-control";

/**
 * The same reads and changes as npm.test.ts, against a real Nginx Proxy Manager: only a throwaway
 * one made for this (docker run jc21/nginx-proxy-manager), never the proxy in front of your sites.
 * It runs only with all of:
 *
 *   HEARTH_NPM_TEST_URL=http://127.0.0.1:8181
 *   HEARTH_NPM_TEST_USER=admin@example.com
 *   HEARTH_NPM_TEST_PASSWORD_FILE=/path/to/file   (the password, read from a file, never logged)
 *   HEARTH_NPM_TEST_THROWAWAY=yes                  (you confirm it is a throwaway)
 *
 * It adds a test site, changes and removes it, and leaves the NPM as it found it.
 */

const url = process.env.HEARTH_NPM_TEST_URL;
const file = process.env.HEARTH_NPM_TEST_PASSWORD_FILE;
const run = Boolean(url && file && process.env.HEARTH_NPM_TEST_THROWAWAY === "yes");

const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)("a real, throwaway Nginx Proxy Manager", () => {
  const login = {
    username: process.env.HEARTH_NPM_TEST_USER ?? "admin@example.com",
    password: run ? readFileSync(file!, "utf8").trim() : "",
  };
  const service = { id: "real", name: "NPM", localUrl: url! };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: login.password, username: login.username }),
  } as unknown as CredentialBroker;
  const ops = new NpmOperations(handle, broker, realFetch);
  const client = new NpmClient(url!, login, realFetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-npm-control" as const,
    serviceId: "real",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };

  it("reads the health and the panel, never a key, and refuses a wrong password", async () => {
    forgetNpmTokens();
    await expect(readNpm(url!, { ...login, password: "not-it" }, realFetch)).rejects.toThrow(
      /refused/,
    );
    const r = await readNpm(url!, login, realFetch);
    expect(r.version).toMatch(/^2\./);
    const d = await npmDashboard(client);
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE KEY|certificate_key/);
    expect(JSON.stringify(d)).not.toContain(login.password);
  });

  it("adds a site, switches it off and on, changes where it forwards, and removes it", async () => {
    const domain = "hearth-test.home.example";
    const add = await go({
      op: "host-add",
      domain,
      forwardHost: "192.168.77.10",
      forwardPort: 8080,
      certificateId: 0,
    });
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    expect(await npmSites(client)).toContainEqual({ site: domain, upstream: "192.168.77.10:8080" });
    const id = (await npmDashboard(client)).hosts.find((h) => h.domains[0] === domain)!.id;
    const off = await go({ op: "host-disable", hostId: id });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(off.planned.params), service)).toMatchObject({ ok: true });
    const f = await go({
      op: "host-forward",
      hostId: id,
      forwardScheme: "https",
      forwardHost: "app",
      forwardPort: 8443,
    });
    expect(f.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(f.planned.params), service)).toMatchObject({ ok: true });
    expect((await npmDashboard(client)).hosts.find((h) => h.id === id)!.forward).toBe(
      "http://192.168.77.10:8080",
    );
    const rm = await go({ op: "host-remove", hostId: id });
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(rm.planned.params), service)).toMatchObject({ ok: true });
    const back = (await npmDashboard(client)).hosts.find((h) => h.domains[0] === domain)!;
    expect(back).toMatchObject({ forward: "http://192.168.77.10:8080", online: true });
    expect((await go({ op: "host-remove", hostId: back.id })).outcome).toMatchObject({ ok: true });
  });
});
