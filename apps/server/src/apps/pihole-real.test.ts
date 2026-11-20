import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import type { Fetch } from "./http";
import {
  forgetPiholeSessions,
  PiholeSession,
  piholeCheck,
  piholeDashboard,
  piholeQueries,
  readPihole,
} from "./pihole";
import { PiholeOperations } from "./pihole-control";

/**
 * The same reads and changes as pihole.test.ts, against a real Pi-hole: only a throwaway one made
 * for this (docker run pihole/pihole), never a network's DNS. It runs only with all of:
 *
 *   HEARTH_PIHOLE_TEST_URL=http://127.0.0.1:8089
 *   HEARTH_PIHOLE_TEST_PASSWORD_FILE=/path/to/file   (the password, read from a file, never logged)
 *   HEARTH_PIHOLE_TEST_THROWAWAY=yes                  (you confirm it is a throwaway)
 *
 * It pauses and resumes blocking, updates the blocklists, allows and blocks test domains, and
 * adds, switches and removes a test list, reading each back, and leaves the Pi-hole as it found it.
 */

const url = process.env.HEARTH_PIHOLE_TEST_URL;
const file = process.env.HEARTH_PIHOLE_TEST_PASSWORD_FILE;
const run = Boolean(url && file && process.env.HEARTH_PIHOLE_TEST_THROWAWAY === "yes");

const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)("a real, throwaway Pi-hole", () => {
  const password = run ? readFileSync(file!, "utf8").trim() : "";
  const service = { id: "real", name: "Pi-hole", localUrl: url! };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: password }),
  } as unknown as CredentialBroker;
  const ops = new PiholeOperations(handle, broker, realFetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-pihole-control" as const,
    serviceId: "real",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };

  it("reads the health and the panel, and refuses a wrong password", async () => {
    forgetPiholeSessions();
    await expect(readPihole(url!, "not-the-password", realFetch)).rejects.toThrow(
      /refused the password/,
    );
    const r = await readPihole(url!, password, realFetch);
    expect(r.version).toMatch(/^6\./);
    expect(r.facts[0]!.label).toBe("Ad blocking");
    const d = await piholeDashboard(await PiholeSession.open(url!, password, realFetch));
    expect(d.app).toBe("pihole");
    expect(d.history.length).toBeGreaterThan(0);
    expect(d.lists.length).toBeGreaterThan(0);
    expect(JSON.stringify(d)).not.toContain(password);
  });

  it("pauses and turns blocking back on, read back", async () => {
    const p = await go({ op: "pause", seconds: 300 });
    expect(p.outcome).toMatchObject({ ok: true, verified: true });
    const r = await go({ op: "resume" });
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
  });

  it("updates the blocklists, read back", async () => {
    const g = await go({ op: "gravity" });
    expect(g.outcome).toMatchObject({ ok: true, verified: true });
  }, 600_000);

  it("allows and blocks domains, and puts them back", async () => {
    const a = await go({ op: "allow", domain: "hearth-allow-test.example.com" });
    expect(a.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "deny", domain: "hearth-allow-test.example.com" }, base),
    ).rejects.toThrow(/allowed list/);
    const off = await go({
      op: "domain-remove",
      domain: "hearth-allow-test.example.com",
      list: "allow",
    });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    const d = await go({ op: "deny", domain: "hearth-deny-test.example.com" });
    expect(d.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(d.planned.params), service)).toMatchObject({ ok: true });
  });

  it("adds, switches off and on, removes, and puts back a list", async () => {
    const address = "https://hearth-test.example.org/list.txt?key=throwaway";
    const add = await go({ op: "list-add", body: address });
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    const d = await piholeDashboard(await PiholeSession.open(url!, password, realFetch));
    expect(JSON.stringify(d)).not.toContain("throwaway");
    const id = d.lists.find((l) => l.address === "https://hearth-test.example.org/list.txt?…")!.id;
    expect((await go({ op: "list-disable", listId: id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((await go({ op: "list-enable", listId: id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    const rm = await go({ op: "list-remove", listId: id });
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(rm.planned.params), service)).toMatchObject({ ok: true });
    expect(await ops.undo(step(add.planned.params), service)).toMatchObject({ ok: true });
  });

  it("reads the query log and says why a domain is blocked", async () => {
    const s = await PiholeSession.open(url!, password, realFetch);
    const log = await piholeQueries(s, {});
    expect(log.queries.every((q) => q.why.length > 0)).toBe(true);
    const blocked = await piholeQueries(s, { show: "blocked" });
    expect(blocked.queries.every((q) => q.verdict === "blocked")).toBe(true);
    if (blocked.queries[0]) {
      const c = await piholeCheck(s, blocked.queries[0].domain);
      expect(c.verdict).toMatch(/^Blocked/);
    }
    expect((await piholeCheck(s, "hearth-not-listed.example.com")).verdict).toMatch(/^Not blocked/);
  });

  it("blocks by a pattern and takes it off, and adds and removes local DNS names", async () => {
    const re = "(\\.|^)hearth-test-pattern\\.example$";
    const d = await go({ op: "deny", domain: re, match: "regex" });
    expect(d.outcome).toMatchObject({ ok: true, verified: true });
    const s = await PiholeSession.open(url!, password, realFetch);
    expect((await piholeCheck(s, "ads.hearth-test-pattern.example")).verdict).toMatch(
      /^Blocked: you/,
    );
    expect(await ops.undo(step(d.planned.params), service)).toMatchObject({ ok: true });
    const bad = await go({ op: "deny", domain: "(bad[", match: "regex" });
    expect(bad.outcome).toMatchObject({ ok: false });
    const add = await go({ op: "dns-add", domain: "hearth-test.home", ip: "192.168.77.10" });
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    const alias = await go({
      op: "alias-add",
      domain: "hearth-alias.home",
      target: "hearth-test.home",
    });
    expect(alias.outcome).toMatchObject({ ok: true, verified: true });
    const board = await piholeDashboard(s);
    expect(board.localDns.records).toContainEqual({
      name: "hearth-test.home",
      ip: "192.168.77.10",
    });
    expect(board.localDns.aliases).toContainEqual({
      name: "hearth-alias.home",
      target: "hearth-test.home",
    });
    expect(
      (await go({ op: "alias-remove", domain: "hearth-alias.home", target: "hearth-test.home" }))
        .outcome,
    ).toMatchObject({ ok: true, verified: true });
    expect(
      (await go({ op: "dns-remove", domain: "hearth-test.home", ip: "192.168.77.10" })).outcome,
    ).toMatchObject({ ok: true, verified: true });
  });
});
