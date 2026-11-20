import { describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import {
  AdguardClient,
  adguardCheck,
  adguardDashboard,
  adguardQueries,
  hourly,
  maskAddress,
  readAdguard,
  toRule,
} from "./adguard";
import { AdguardOperations } from "./adguard-control";
import { FAKE_ADGUARD_KEYED_LIST, fakeAdguard } from "./fake-adguard";

/**
 * AdGuard Home against the stand-in (answering as a throwaway AdGuard Home v0.107.80 did;
 * adguard-real.test.ts runs the same calls against a real one): the panel's reads, and every
 * change as a protected plan, read back.
 */

const BASE = "http://10.0.0.9:3000";
const LOGIN = { username: "admin", password: "e2e-adguard" };
const service = { id: "ag", name: "AdGuard Home", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const ag = fakeAdguard();
  const broker = {
    use: (_s: unknown, fn: (c: { value: string; username: string }) => unknown) =>
      fn({ value: LOGIN.password, username: LOGIN.username }),
  } as unknown as CredentialBroker;
  const ops = new AdguardOperations(handle, broker, ag.fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-adguard-control" as const,
    serviceId: "ag",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  const client = new AdguardClient(BASE, LOGIN, ag.fetch);
  return { ag, ops, go, step, client, board: () => adguardDashboard(client) };
}

describe("reading AdGuard Home", () => {
  it("reads custom rules in plain words, masks keys, and turns hourly counts into times", () => {
    expect(toRule("||ads.example.com^")).toEqual({
      text: "||ads.example.com^",
      kind: "block",
      domain: "ads.example.com",
    });
    expect(toRule("@@||ok.example.com^")).toMatchObject({
      kind: "allow",
      domain: "ok.example.com",
    });
    expect(toRule("! a note")).toMatchObject({ kind: "comment" });
    expect(toRule("/ads[0-9]+/")).toMatchObject({ kind: "other" });
    expect(maskAddress('Couldn\'t fetch filter from URL "https://u:p@x.org/l.txt?key=1": no')).toBe(
      'Couldn\'t fetch filter from URL "https://…@x.org/l.txt?…": no',
    );
    const h = hourly(
      { time_units: "hours", dns_queries: [1, 2], blocked_filtering: [0, 1] },
      Date.parse("2026-11-07T10:30:00Z"),
    );
    expect(h).toEqual([
      { at: "2026-11-07T09:00:00.000Z", total: 1, blocked: 0 },
      { at: "2026-11-07T10:00:00.000Z", total: 2, blocked: 1 },
    ]);
  });

  it("reads the dashboard, never the key in a list address", async () => {
    const { board } = setup();
    const d = await board();
    expect(d).toMatchObject({
      app: "adguard",
      version: "0.107.80",
      protection: { enabled: true },
      queries: { total: 38220, blocked: 5410, percentBlocked: 14.2, avgMs: 7.4 },
      updateEveryHours: 24,
      rewrites: [{ domain: "plex.home", answer: "192.168.1.10", enabled: true }],
      safety: { safeBrowsing: false, parental: false, safeSearch: false },
    });
    expect(d.topBlocked[0]).toEqual({ domain: "ads.example.com", count: 1210 });
    expect(d.history).toHaveLength(24);
    expect(d.filters[1]).toMatchObject({
      name: "Private list",
      url: "https://lists.example.org/private.txt?…",
    });
    expect(d.filters[1]!.updatedAt).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("e2e-LISTKEY");
  });

  it("says a wrong password plainly, and reports a list that never downloaded", async () => {
    const { ag } = setup();
    await expect(
      readAdguard(BASE, { username: "admin", password: "wrong" }, ag.fetch),
    ).rejects.toThrow(/refused the username or password/);
    const r = await readAdguard(BASE, LOGIN, ag.fetch);
    expect(r.facts[0]).toEqual({ label: "Protection", value: "on" });
    expect(r.issues.map((i) => i.key)).toEqual(["filters-not-downloaded"]);
  });

  it("reads the query log in plain words, filtered, and says why a domain is blocked", async () => {
    const { client, go } = setup();
    const all = await adguardQueries(client, {});
    expect(all.queries[0]).toMatchObject({
      domain: "ads.example.com",
      verdict: "blocked",
      why: "blocked by a filter",
      list: "AdGuard DNS filter",
      clientName: "living-room-tv",
      ms: 1.3,
    });
    expect((await adguardQueries(client, { show: "blocked" })).queries).toHaveLength(2);
    expect((await adguardQueries(client, { search: "192.168.1.52" })).queries).toHaveLength(2);
    expect((await adguardCheck(client, "telemetry.example.net")).why).toBe(
      "Blocked by AdGuard DNS filter.",
    );
    expect((await adguardCheck(client, "fine.example.org")).verdict).toBe("allowed");
    await go({ op: "services", body: JSON.stringify(["tiktok"]) });
    const tiktok = await adguardCheck(client, "www.tiktok.com");
    expect(tiktok).toMatchObject({ verdict: "blocked", service: "tiktok" });
    expect(tiktok.why).toMatch(/belongs to tiktok, which you block/);
  });
});

describe("changing AdGuard Home, each a protected plan read back", () => {
  it("every plan is marked protected, whatever was asked", async () => {
    const { ops } = setup();
    const p = await ops.plan(service, { op: "pause", seconds: 300, protected: "no" }, base);
    expect(p.params).toMatchObject({ op: "pause", seconds: 300, protected: "yes" });
    expect(p.label).toBe("Pause protection in AdGuard Home for 5 minutes");
  });

  it("pauses for a time and turns back on, refusing what would change nothing", async () => {
    const { go, ops, ag, step } = setup();
    expect((await go({ op: "pause", seconds: 300 })).outcome).toMatchObject({
      ok: true,
      verified: true,
    });
    expect(ag.state().protection).toEqual({ enabled: false, duration: 300000 });
    await expect(ops.plan(service, { op: "pause" }, base)).rejects.toThrow(/already paused/);
    const r = await go({ op: "resume" });
    expect(r.planned.change?.settings[0]).toMatchObject({ before: "paused for 5 more minutes" });
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.run(step(r.planned.params), service)).toMatchObject({
      ok: false,
      stale: true,
    });
  });

  it("allows and blocks a domain with a custom rule, refuses a clash, and undoes it", async () => {
    const { go, ops, ag, step } = setup();
    const b = await go({ op: "block", domain: "Ads.Example.net." });
    expect(b.planned.label).toBe("Block ads.example.net and its subdomains in AdGuard Home");
    expect(b.outcome).toMatchObject({ ok: true, verified: true });
    expect(ag.state().rules).toContain("||ads.example.net^");
    await expect(
      ops.plan(service, { op: "allow", domain: "ads.example.net" }, base),
    ).rejects.toThrow(/has a rule that blocks/);
    expect(await ops.undo(step(b.planned.params), service)).toMatchObject({ ok: true });
    expect(ag.state().rules).toEqual(["@@||s.youtube.com^"]);
    const off = await go({ op: "rule-remove", rule: "@@||s.youtube.com^" });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(off.planned.params), service)).toMatchObject({ ok: true });
    expect(ag.state().rules).toEqual(["@@||s.youtube.com^"]);
  });

  it("adds, switches and removes filter lists, masking a key, and refuses a file path", async () => {
    const { go, ops, ag, step } = setup();
    await expect(
      ops.plan(service, { op: "filter-add", body: "/opt/adguardhome/work/data/x.txt" }, base),
    ).rejects.toThrow(/http or https/);
    const add = await go({
      op: "filter-add",
      body: "https://lists.example.org/more.txt?token=abc",
      name: "More",
    });
    expect(add.planned.label).toBe(
      "Add the blocklist More (https://lists.example.org/more.txt?…) to AdGuard Home",
    );
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    expect(JSON.stringify([add.planned.label, add.outcome])).not.toContain("token=abc");
    const bad = await go({
      op: "filter-add",
      body: "https://unreachable.example/l.txt?key=zzz",
      name: "Bad",
    });
    expect(bad.outcome.ok).toBe(false);
    expect(bad.outcome.result).not.toContain("zzz");
    const off = await go({ op: "filter-disable", filterId: 2 });
    expect(off.planned.label).toBe("Switch off the list Private list in AdGuard Home");
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(off.planned.params), service)).toMatchObject({ ok: true });
    const rm = await go({ op: "filter-remove", filterId: 2 });
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(rm.planned.params), service)).toMatchObject({ ok: true });
    expect(ag.state().filters.find((f) => f.url === FAKE_ADGUARD_KEYED_LIST)).toBeTruthy();
    expect((await go({ op: "refresh" })).outcome).toMatchObject({ ok: true });
  });

  it("adds and removes DNS rewrites, chooses blocked services, and flips the safety switches", async () => {
    const { go, ops, ag, step } = setup();
    const rw = await go({ op: "rewrite-add", domain: "*.home", answer: "192.168.1.10" });
    expect(rw.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "rewrite-add", domain: "x.home", answer: "not an ip!" }, base),
    ).rejects.toThrow(/address/);
    expect(await ops.undo(step(rw.planned.params), service)).toMatchObject({ ok: true });
    expect(ag.state().rewrites).toHaveLength(1);
    const s = await go({ op: "services", body: JSON.stringify(["tiktok", "roblox"]) });
    expect(s.planned.label).toBe("In AdGuard Home, block Roblox, TikTok");
    expect(s.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "services", body: JSON.stringify(["nope"]) }, base),
    ).rejects.toThrow(/no service nope/);
    expect(await ops.undo(step(s.planned.params), service)).toMatchObject({ ok: true });
    expect(ag.state().services).toEqual([]);
    const sb = await go({ op: "safety", setting: "safesearch", on: true });
    expect(sb.planned.label).toBe("Switch on safe search in AdGuard Home");
    expect(sb.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "safety", setting: "safesearch", on: true }, base),
    ).rejects.toThrow(/already on/);
    expect((await go({ op: "safety", setting: "parental", on: true })).outcome).toMatchObject({
      ok: true,
    });
  });
});
