import { beforeEach, describe, expect, it } from "vitest";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep } from "../jobs/operations";
import { FAKE_PIHOLE_KEYED_LIST, fakePihole } from "./fake-pihole";
import {
  forgetPiholeSessions,
  hourly,
  maskAddress,
  PiholeSession,
  piholeCheck,
  piholeDashboard,
  piholeQueries,
  readPihole,
  versionOf,
} from "./pihole";
import { PiholeOperations } from "./pihole-control";

/**
 * Pi-hole against the stand-in (answering as a throwaway Pi-hole 6 did; pihole-real.test.ts runs
 * the same calls against a real one): the panel's reads, and every change as a protected plan,
 * read back.
 */

const BASE = "http://10.0.0.9:8053";
const PW = "e2e-pihole";
const service = { id: "ph", name: "Pi-hole", localUrl: BASE };
const handle = { db: { insert: () => ({ values: async () => undefined }) } } as unknown as DbHandle;
const base: PlannedStep = {
  label: "",
  serviceName: "",
  changes: true,
  policy: "approve-first",
  policyReason: "",
};

function setup() {
  const ph = fakePihole();
  let logins = 0;
  const fetch: typeof ph.fetch = (url, init) => {
    if (url.endsWith("/api/auth")) logins++;
    return ph.fetch(url, init);
  };
  const broker = {
    use: (_s: unknown, fn: (c: { value: string }) => unknown) => fn({ value: PW }),
  } as unknown as CredentialBroker;
  const ops = new PiholeOperations(handle, broker, fetch);
  const step = (params: PlannedStep["params"]) => ({
    kind: "app-pihole-control" as const,
    serviceId: "ph",
    requestedBy: "you" as const,
    params: params!,
  });
  const go = async (params: PlannedStep["params"]) => {
    const planned = await ops.plan(service, params, base);
    return { planned, outcome: await ops.run(step(planned.params), service) };
  };
  const board = async () => piholeDashboard(await PiholeSession.open(BASE, PW, fetch));
  return { ph, ops, go, step, board, fetch, logins: () => logins };
}

beforeEach(() => forgetPiholeSessions());

describe("reading Pi-hole", () => {
  it("reads the version, a newer one, and hourly history", () => {
    expect(
      versionOf({
        version: {
          core: { local: { version: "v6.5" }, remote: { version: "v6.5" } },
          ftl: { local: { version: "v6.8" }, remote: { version: "v6.9" } },
          docker: { local: "2026.10.1", remote: "null" },
        },
      }),
    ).toEqual({ version: "6.5 (FTL 6.8)", update: "FTL 6.9 is out." });
    expect(
      hourly([
        { timestamp: 7200, total: 5, blocked: 1 },
        { timestamp: 7800, total: 5, blocked: 2 },
        { timestamp: 10800, total: 1, blocked: 0 },
      ]),
    ).toEqual([
      { at: new Date(7200_000).toISOString(), total: 10, blocked: 3 },
      { at: new Date(10800_000).toISOString(), total: 1, blocked: 0 },
    ]);
  });

  it("masks a key in a list address, and in Pi-hole's own warnings", async () => {
    expect(maskAddress("https://u:p@lists.example.org/a.txt?key=1")).toBe(
      "https://…@lists.example.org/a.txt?…",
    );
    const { board } = setup();
    const d = await board();
    expect(JSON.stringify(d)).not.toContain("e2e-LISTKEY");
    expect(d.lists[1]).toMatchObject({
      id: 2,
      address: "https://lists.example.org/private.txt?…",
      status: "unreachable",
    });
    expect(d.messages[0]!.text).toContain("private.txt?…");
  });

  it("signs in once and reuses the session, and signs in again when Pi-hole ended it", async () => {
    const { board, ph, logins } = setup();
    const d = await board();
    expect(d).toMatchObject({
      app: "pihole",
      version: "6.5 (FTL 6.8)",
      blocking: "enabled",
      queries: { total: 41230, blocked: 6112, percentBlocked: 14.8 },
      clients: { active: 14 },
    });
    expect(d.topBlocked[0]).toEqual({ domain: "ads.example.com", count: 1420 });
    expect(d.topClients[1]).toMatchObject({ name: "192.168.1.52" });
    expect(d.history).toHaveLength(24);
    await board();
    expect(logins()).toBe(1);
    ph.endSessions();
    await board();
    expect(logins()).toBe(2);
  });

  it("says a wrong password plainly, and reports paused blocking and a failing list", async () => {
    const { fetch, ph } = setup();
    await expect(readPihole(BASE, "wrong", fetch)).rejects.toThrow(/refused the password/);
    ph.state().blocking.enabled = false;
    const r = await readPihole(BASE, PW, fetch);
    expect(r.facts[0]).toEqual({ label: "Ad blocking", value: "paused" });
    expect(r.issues.map((i) => i.key)).toEqual(["blocking-off", "lists-unreachable"]);
    expect(r.status).toBe("attention");
  });
});

describe("the query log and why a domain is blocked", () => {
  it("reads the log in plain words, filtered to blocked, a domain, or one device", async () => {
    const { fetch } = setup();
    const s = await PiholeSession.open(BASE, PW, fetch);
    const all = await piholeQueries(s, {});
    expect(all.matching).toBe(5);
    expect(all.queries[0]).toMatchObject({
      domain: "ads.example.com",
      verdict: "blocked",
      why: "blocked by a blocklist",
      client: { ip: "192.168.1.40", name: "living-room-tv" },
      ms: 1.2,
    });
    expect(all.queries.find((q) => q.domain === "cdn.example.org")).toMatchObject({
      verdict: "allowed",
      why: "allowed, answered from cache",
    });
    expect((await piholeQueries(s, { show: "blocked" })).queries.map((q) => q.verdict)).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect((await piholeQueries(s, { domain: "example.org" })).matching).toBe(2);
    expect((await piholeQueries(s, { client: "192.168.1.40" })).matching).toBe(2);
    expect(all.clients[0]).toEqual({ ip: "192.168.1.40", name: "living-room-tv" });
  });

  it("says why a domain is blocked or allowed, your own rules first", async () => {
    const { fetch, go } = setup();
    const s = await PiholeSession.open(BASE, PW, fetch);
    const ads = await piholeCheck(s, "ads.example.com");
    expect(ads.verdict).toBe("Blocked by a blocklist.");
    expect(ads.lists[0]).toMatchObject({ id: 1, type: "block" });
    expect((await piholeCheck(s, "fine.example.org")).verdict).toMatch(/^Not blocked/);
    await go({ op: "allow", domain: "ads.example.com" });
    const now = await piholeCheck(s, "ads.example.com");
    expect(now.verdict).toMatch(/^Allowed: you allowed it/);
    expect(now.rules[0]).toMatchObject({
      domain: "ads.example.com",
      list: "allow",
      match: "exact",
    });
  });
});

describe("changing Pi-hole, each a protected plan read back", () => {
  it("every plan is marked protected, whatever was asked", async () => {
    const { ops } = setup();
    const p = await ops.plan(service, { op: "pause", seconds: 300, protected: "no" }, base);
    expect(p.params).toMatchObject({ op: "pause", seconds: 300, protected: "yes" });
    expect(p.label).toBe("Pause ad blocking in Pi-hole for 5 minutes");
  });

  it("pauses for a time and turns back on, refusing what would change nothing", async () => {
    const { go, ops, ph, step } = setup();
    const p = await go({ op: "pause", seconds: 300 });
    expect(p.outcome).toMatchObject({ ok: true, verified: true });
    expect(ph.state().blocking).toEqual({ enabled: false, timer: 300 });
    await expect(ops.plan(service, { op: "pause" }, base)).rejects.toThrow(/already paused/);
    await expect(ops.plan(service, { op: "pause", seconds: 99 }, base)).rejects.toThrow();
    const r = await go({ op: "resume" });
    expect(r.planned.change?.settings[0]).toMatchObject({ before: "paused for 5 more minutes" });
    expect(r.outcome).toMatchObject({ ok: true, verified: true });
    // Run again (a second submission): nothing changes.
    expect(await ops.run(step(r.planned.params), service)).toMatchObject({
      ok: false,
      stale: true,
    });
    // Undo of a pause turns blocking back on.
    const until = await go({ op: "pause", seconds: 0 });
    expect(ph.state().blocking).toEqual({ enabled: false, timer: null });
    expect(await ops.undo(step(until.planned.params), service)).toMatchObject({ ok: true });
    expect(ph.state().blocking.enabled).toBe(true);
  });

  it("updates the blocklists and says which list could not be downloaded", async () => {
    const { go } = setup();
    const g = await go({ op: "gravity" });
    expect(g.planned.label).toBe("Update Pi-hole's blocklists (download every list again)");
    expect(g.outcome).toMatchObject({
      ok: true,
      verified: true,
      result: "Blocklists updated: 168420 domains. 1 list could not be downloaded.",
    });
  });

  it("allows and blocks a domain by name, refuses one on the other list, and takes it off again", async () => {
    const { go, ops, ph, step } = setup();
    const a = await go({ op: "allow", domain: "Tracker.Example.org." });
    expect(a.planned.label).toBe("Allow tracker.example.org in Pi-hole");
    expect(a.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "allow", domain: "tracker.example.org" }, base),
    ).rejects.toThrow(/already allowed/);
    await expect(
      ops.plan(service, { op: "deny", domain: "tracker.example.org" }, base),
    ).rejects.toThrow(/allowed list: take it off/);
    await expect(ops.plan(service, { op: "deny", domain: "not a domain" }, base)).rejects.toThrow(
      /one domain name/,
    );
    expect(await ops.undo(step(a.planned.params), service)).toMatchObject({ ok: true });
    expect(ph.state().allow.map((d) => d.domain)).toEqual(["s.youtube.com"]);
    const off = await go({ op: "domain-remove", domain: "s.youtube.com", list: "allow" });
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(off.planned.params), service)).toMatchObject({ ok: true });
    expect(ph.state().allow[0]).toMatchObject({
      domain: "s.youtube.com",
      comment: "Watch history",
    });
    expect((await go({ op: "deny", domain: "ads.example.net" })).outcome).toMatchObject({
      ok: true,
    });
  });

  it("adds, switches and removes a list by id, never showing a list's key", async () => {
    const { go, ops, ph, step } = setup();
    const add = await go({ op: "list-add", body: "https://lists.example.org/new.txt?token=abc" });
    expect(add.planned.label).toBe(
      "Add the blocklist https://lists.example.org/new.txt?… to Pi-hole (used from the next blocklist update)",
    );
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    expect(JSON.stringify(add.outcome)).not.toContain("abc");
    expect(await ops.undo(step(add.planned.params), service)).toMatchObject({ ok: true });
    expect(ph.state().lists).toHaveLength(2);
    await expect(
      ops.plan(service, { op: "list-add", body: "file:///etc/passwd" }, base),
    ).rejects.toThrow(/http or https/);

    const off = await go({ op: "list-disable", listId: 2 });
    expect(off.planned.label).toBe(
      "Switch off the list Private list (https://lists.example.org/private.txt?…) in Pi-hole",
    );
    expect(off.outcome).toMatchObject({ ok: true, verified: true });
    expect(ph.state().lists[1]!.enabled).toBe(false);
    await expect(ops.plan(service, { op: "list-disable", listId: 2 }, base)).rejects.toThrow(
      /already off/,
    );

    const rm = await go({ op: "list-remove", listId: 2 });
    expect(rm.planned.label).not.toContain("e2e-LISTKEY");
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(rm.planned.params), service)).toMatchObject({ ok: true });
    expect(ph.state().lists.find((l) => l.address === FAKE_PIHOLE_KEYED_LIST)).toMatchObject({
      enabled: false,
      comment: "Private list",
    });
    await expect(ops.plan(service, { op: "list-enable", listId: 99 }, base)).rejects.toThrow(
      /no such list/,
    );
  });

  it("blocks by a pattern (regex), refuses a broken one, and takes it off again", async () => {
    const { go, ops, ph, step, board } = setup();
    const re = "(\\.|^)doubleclick\\.net$";
    const b = await go({ op: "deny", domain: re, match: "regex" });
    expect(b.planned.label).toBe(`Block names matching ${re} in Pi-hole`);
    expect(b.outcome).toMatchObject({ ok: true, verified: true });
    expect((await board()).denied).toEqual([
      { domain: re, match: "regex", comment: "Added from Hearth", enabled: true },
    ]);
    await expect(
      ops.plan(service, { op: "deny", domain: re, match: "regex" }, base),
    ).rejects.toThrow(/already blocked/);
    const bad = await go({ op: "deny", domain: "(bad[", match: "regex" });
    expect(bad.outcome).toMatchObject({ ok: false, result: /Regex validation failed/ });
    expect(await ops.undo(step(b.planned.params), service)).toMatchObject({ ok: true });
    expect(ph.state().deny).toEqual([]);
  });

  it("adds and removes local DNS names and aliases, and puts them back", async () => {
    const { go, ops, ph, step, board } = setup();
    const add = await go({ op: "dns-add", domain: "NAS.home", ip: "192.168.1.20" });
    expect(add.planned.label).toBe(
      "Point nas.home to 192.168.1.20 in Pi-hole (Pi-hole restarts its DNS for a second to use it)",
    );
    expect(add.outcome).toMatchObject({ ok: true, verified: true });
    await expect(
      ops.plan(service, { op: "dns-add", domain: "x.home", ip: "not-an-ip" }, base),
    ).rejects.toThrow(/address it points to/);
    await expect(
      ops.plan(service, { op: "dns-add", domain: "nas.home", ip: "192.168.1.20" }, base),
    ).rejects.toThrow(/already points/);
    const alias = await go({ op: "alias-add", domain: "movies.home", target: "plex.home" });
    expect(alias.outcome).toMatchObject({ ok: true, verified: true });
    expect((await board()).localDns).toEqual({
      records: [
        { name: "plex.home", ip: "192.168.1.10" },
        { name: "nas.home", ip: "192.168.1.20" },
      ],
      aliases: [{ name: "movies.home", target: "plex.home" }],
    });
    const rm = await go({ op: "dns-remove", domain: "plex.home", ip: "192.168.1.10" });
    expect(rm.outcome).toMatchObject({ ok: true, verified: true });
    expect(await ops.undo(step(rm.planned.params), service)).toMatchObject({ ok: true });
    expect(await ops.undo(step(alias.planned.params), service)).toMatchObject({ ok: true });
    expect(ph.state().dns).toEqual({
      hosts: ["192.168.1.20 nas.home", "192.168.1.10 plex.home"],
      cnameRecords: [],
    });
  });
});
