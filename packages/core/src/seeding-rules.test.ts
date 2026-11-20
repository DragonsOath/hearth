import { describe, expect, it } from "vitest";
import type { Torrent } from "./dashboards";
import { checkRule, ruleStateOf, type SeedingRule } from "./seeding-rules";

const t = (o: Partial<Torrent>): Torrent =>
  ({ hash: "h", name: "x", status: "seeding", progressPct: 100, ratio: 1, ...o }) as Torrent;
const rule = (o: Partial<SeedingRule>): SeedingRule => ({
  id: "r",
  indexers: ["TrackerOne"],
  trackers: [],
  days: 3,
  action: "remove",
  mode: "preview",
  enabled: true,
  ...o,
});

describe("seeding rules", () => {
  it("covers a torrent by its indexer, and counts qBittorrent's seeding time", () => {
    const s = ruleStateOf(
      t({ source: { indexer: "trackerone", via: "Sonarr" }, seedingSec: 86400 }),
      [rule({})],
      0,
    );
    expect(s?.met).toBe(false);
    expect(s?.note).toMatch(/2 d of seeding left.*would remove the torrent \(files kept\)/);
    expect(s?.dueAt).toBe(new Date(2 * 86400 * 1000).toISOString());
  });
  it("is met only when the time and the ratio both are", () => {
    const r = [rule({ minRatio: 1.5 })];
    const base = { source: { indexer: "TrackerOne", via: "Radarr" }, seedingSec: 4 * 86400 };
    expect(ruleStateOf(t({ ...base, ratio: 1 }), r)?.met).toBe(false);
    expect(ruleStateOf(t({ ...base, ratio: 2 }), r)?.met).toBe(true);
  });
  it("leaves unknown, unfinished and unreported torrents alone", () => {
    expect(ruleStateOf(t({ seedingSec: 9e6 }), [rule({})])).toBeUndefined();
    const src = { source: { indexer: "TrackerOne", via: "Sonarr" } };
    expect(ruleStateOf(t({ ...src, progressPct: 50 }), [rule({})])?.met).toBe(false);
    expect(ruleStateOf(t({ ...src }), [rule({})])?.met).toBe(false);
  });
  it("matches a tracker host and its subdomains, never a lookalike", () => {
    const r = [rule({ indexers: [], trackers: ["trackerone.example"] })];
    expect(
      ruleStateOf(t({ tracker: "tracker.trackerone.example", seedingSec: 1 }), r),
    ).toBeDefined();
    expect(ruleStateOf(t({ tracker: "nottrackerone.example", seedingSec: 1 }), r)).toBeUndefined();
  });
  it("with two rules, takes the most time and the least destructive action", () => {
    const s = ruleStateOf(t({ source: { indexer: "TrackerOne", via: "x" }, seedingSec: 1 }), [
      rule({ id: "a", days: 3, action: "delete" }),
      rule({ id: "b", days: 7, action: "pause" }),
    ]);
    expect(s?.needSec).toBe(7 * 86400);
    expect(s?.action).toBe("pause");
  });
  it("saves only previews, and needs an indexer or tracker", () => {
    expect(
      checkRule({ indexers: ["A"], days: 3, action: "delete", mode: "live" } as never).mode,
    ).toBe("preview");
    expect(() => checkRule({ indexers: [], trackers: [], days: 3 })).toThrow(/at least one/);
  });
});
