import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import {
  AdguardClient,
  adguardCheck,
  adguardDashboard,
  adguardQueries,
  readAdguard,
} from "./adguard";
import { AdguardOperations } from "./adguard-control";
import type { Fetch } from "./http";

/**
 * The same reads and changes as adguard.test.ts, against a real AdGuard Home: only a throwaway one
 * made for this (docker run adguard/adguardhome), never a network's DNS. It runs only with all of:
 *
 *   HEARTH_ADGUARD_TEST_URL=http://127.0.0.1:8091
 *   HEARTH_ADGUARD_TEST_USER=admin
 *   HEARTH_ADGUARD_TEST_PASSWORD_FILE=/path/to/file  (the password, read from a file, never logged)
 *   HEARTH_ADGUARD_TEST_THROWAWAY=yes                 (you confirm it is a throwaway)
 *   HEARTH_ADGUARD_TEST_LIST_URL=http://…/list.txt    (a filter list that AdGuard can download)
 *
 * It leaves the AdGuard Home as it found it.
 */

const url = process.env.HEARTH_ADGUARD_TEST_URL;
const file = process.env.HEARTH_ADGUARD_TEST_PASSWORD_FILE;
const list = process.env.HEARTH_ADGUARD_TEST_LIST_URL;
const run = Boolean(url && file && list && process.env.HEARTH_ADGUARD_TEST_THROWAWAY === "yes");

const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};
const realFetch: Fetch = (u, init) => fetch(u, init) as unknown as ReturnType<Fetch>;

describe.skipIf(!run)("a real, throwaway AdGuard Home", () => {
  const login = {
    username: process.env.HEARTH_ADGUARD_TEST_USER ?? "admin",
    password: run ? readFileSync(file!, "utf8").trim() : "",
  };
  const service = { id: "real", name: "AdGuard Home", localUrl: url! };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: login.password, username: login.username }),
  } as unknown as CredentialBroker;
  const ops = new AdguardOperations(handle, broker, realFetch);
  const client = new AdguardClient(url!, login, realFetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-adguard-control" as const,
    serviceId: "real",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };

  it("reads the health, the panel and the query log, and refuses a wrong password", async () => {
    await expect(
      readAdguard(url!, { username: login.username, password: "not-it" }, realFetch),
    ).rejects.toThrow(/refused/);
    const r = await readAdguard(url!, login, realFetch);
    expect(r.version).toMatch(/^0\.107\./);
    const d = await adguardDashboard(client);
    expect(d.history).toHaveLength(24);
    expect(d.blockedServices.all.length).toBeGreaterThan(20);
    expect(JSON.stringify(d)).not.toContain(login.password);
    const log = await adguardQueries(client, {});
    expect(log.queries.every((q) => q.why.length > 0)).toBe(true);
  });

  it("pauses and turns protection back on, read back", async () => {
    expect((await go({ op: "pause", seconds: 300 })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((await go({ op: "resume" })).outcome).toMatchObject({ ok: true, verified: true });
  });

  it("blocks and allows with custom rules, and says why", async () => {
    const b = await go({ op: "block", domain: "hearth-test-block.example" });
    expect(b.outcome).toMatchObject({ ok: true, verified: true });
    expect((await adguardCheck(client, "ads.hearth-test-block.example")).verdict).toBe("blocked");
    expect(await ops.undo(step(b.planned.params), service)).toMatchObject({ ok: true });
    const a = await go({ op: "allow", domain: "hearth-test-allow.example" });
    expect(a.outcome).toMatchObject({ ok: true, verified: true });
    const off = await go({ op: "rule-remove", rule: "@@||hearth-test-allow.example^" });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
  });

  it("adds, switches, updates and removes a filter list, and masks a key in errors", async () => {
    const add = await go({ op: "filter-add", body: list!, name: "Hearth test list" });
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    const id = (await adguardDashboard(client)).filters.find(
      (f) => f.name === "Hearth test list",
    )!.id;
    expect((await adguardCheck(client, "list-blocked.example.com")).verdict).toBe("blocked");
    expect((await go({ op: "filter-disable", filterId: id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((await go({ op: "filter-enable", filterId: id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect((await go({ op: "refresh" })).outcome).toMatchObject({ ok: true });
    expect((await go({ op: "filter-remove", filterId: id })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    const bad = await go({
      op: "filter-add",
      body: "https://unreachable.invalid/l.txt?key=hearth-secret",
      name: "Bad",
    });
    expect(bad.outcome.ok).toBe(false);
    expect(bad.outcome.result).not.toContain("hearth-secret");
  });

  it("adds and removes a DNS rewrite, blocks a service, and flips the safety switches", async () => {
    const rw = await go({ op: "rewrite-add", domain: "hearth-test.home", answer: "192.168.77.10" });
    expect(rw.outcome).toMatchObject({ ok: true, verified: true });
    expect(
      (await go({ op: "rewrite-remove", domain: "hearth-test.home", answer: "192.168.77.10" }))
        .outcome,
    ).toMatchObject({ ok: true, verified: true });
    const board = await adguardDashboard(client);
    const before = board.blockedServices.ids;
    // A service this AdGuard does not block yet (TikTok when it is free).
    const pick = ["tiktok", "roblox", "pinterest"].find((x) => !before.includes(x))!;
    const s = await go({ op: "services", body: JSON.stringify([...before, pick]) });
    expect(s.outcome).toMatchObject({ ok: true, verified: true });
    expect((await adguardCheck(client, `www.${pick}.com`)).verdict).toBe("blocked");
    expect(await ops.undo(step(s.planned.params), service)).toMatchObject({ ok: true });
    // Each switch flipped from how it is now, then back.
    const now = (await adguardDashboard(client)).safety;
    const was = {
      safebrowsing: now.safeBrowsing,
      parental: now.parental,
      safesearch: now.safeSearch,
    } as const;
    for (const setting of ["safebrowsing", "parental", "safesearch"] as const) {
      expect((await go({ op: "safety", setting, on: !was[setting] })).outcome).toMatchObject({
        ok: true,
        verified: true,
      });
      expect((await go({ op: "safety", setting, on: was[setting] })).outcome).toMatchObject({
        ok: true,
        verified: true,
      });
    }
  });
});
