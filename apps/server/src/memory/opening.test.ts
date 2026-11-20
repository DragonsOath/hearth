import { describe, expect, it } from "vitest";
import type { Host, Incident, MemoryEntry, Service } from "@dragon-control/core";
import { buildOpening, type OpeningInput } from "./opening";

const now = new Date("2026-10-08T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

const host = (over: Partial<Host> = {}): Host => ({
  id: "atlas",
  name: "Atlas",
  role: "Server",
  os: "Ubuntu",
  address: "10.0.0.5",
  cpu: { model: "x", cores: 8, usagePct: 10 },
  memory: { totalGb: 32, usedGb: 10 },
  uptimeHours: 100,
  connection: "this-machine",
  docker: true,
  health: "healthy",
  lastSeenAt: daysAgo(0),
  volumes: [],
  ...over,
});
const service = (name: string, health: Service["health"] = "healthy"): Service => ({
  id: name.toLowerCase(),
  name,
  category: "Media",
  hostId: "atlas",
  kind: "container",
  health,
  dependsOn: [],
  autonomyArea: "media",
  autonomy: "ask",
});
let n = 0;
const memory = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: `m${++n}`,
  kind: "journal",
  title: "Something",
  body: "",
  happenedAt: daysAgo(1),
  basis: "observed",
  source: "ai",
  links: [],
  createdAt: daysAgo(1),
  updatedAt: daysAgo(1),
  ...over,
});
const incident = (over: Partial<Incident>): Incident => ({
  id: `i${++n}`,
  title: "Plex stopped responding",
  severity: "warning",
  status: "resolved",
  openedAt: daysAgo(10),
  summary: "",
  handledBy: "runbook",
  timeline: [],
  ...over,
});

const input = (over: Partial<OpeningInput> = {}): OpeningInput => ({
  ws: {
    environment: "real",
    hosts: [host()],
    services: [service("Plex"), service("Sonarr")],
    incidents: [incident({})],
  },
  entries: [],
  backups: {
    recent: [{ at: daysAgo(0), ok: true } as never],
    lastOk: undefined,
    offsite: undefined,
  },
  since: daysAgo(2),
  now,
  ...over,
});

describe("what a companion opens with", () => {
  it("puts what needs you first, then news, wins, work in progress, and one idea", () => {
    const points = buildOpening(
      input({
        ws: {
          environment: "real",
          hosts: [
            host({
              volumes: [
                {
                  id: "v",
                  hostId: "atlas",
                  label: "Media",
                  mount: "/media",
                  kind: "hdd",
                  totalTb: 10,
                  usedTb: 9.2,
                  smart: "ok",
                },
              ],
            }),
          ],
          services: [service("Plex"), service("Sonarr", "attention")],
          incidents: [
            incident({
              status: "awaiting-approval",
              title: "Sonarr is stuck",
              serviceId: "sonarr",
              openedAt: daysAgo(0),
            }),
          ],
        },
        entries: [
          memory({ source: "dragon-control", title: "Restarted Sonarr", createdAt: daysAgo(1) }),
          memory({ kind: "win", title: "Every app moved to Atlas", happenedAt: daysAgo(3) }),
          memory({
            kind: "thread",
            status: "open",
            title: "Move the proxy",
            updatedAt: daysAgo(1),
          }),
        ],
      }),
    );
    expect(points.map((p) => p.kind)).toEqual([
      "needs-you",
      "since",
      "since",
      "win",
      "in-progress",
      "idea",
    ]);
    expect(points[0]!.text).toMatch(/Sonarr is stuck.*1 repair is waiting for your OK/);
    expect(points[1]!.text).toBe("Hearth: Restarted Sonarr.");
    expect(points[3]!.text).toBe("Every app moved to Atlas (3 days ago).");
    expect(points[5]!.text).toMatch(/Media on Atlas is 92% full \(about 800 GB free\)/);
  });

  it("celebrates only what is real: a quiet stretch on your own systems, never on sample data", () => {
    const quiet = buildOpening(input());
    expect(quiet).toEqual([
      { kind: "win", text: "All 2 services healthy, with no problems for 10 days." },
    ]);
    expect(buildOpening(input({ ws: { ...input().ws, environment: "demo" } }))).toEqual([]);
    const recent = buildOpening(
      input({ ws: { ...input().ws, incidents: [incident({ openedAt: daysAgo(1) })] } }),
    );
    expect(recent.some((p) => p.kind === "win")).toBe(false);
  });

  it("raises backups that stopped reaching the other machine, and imported notes waiting", () => {
    const points = buildOpening(
      input({
        backups: {
          recent: [{ at: daysAgo(0), ok: true } as never],
          lastOk: undefined,
          offsite: {
            name: "the old server",
            stale: true,
            lastVerified: { receivedAt: daysAgo(4) } as never,
          } as never,
        },
        imports: { pending: 278, ready: 136 },
      }),
    );
    expect(points[0]!.text).toMatch(
      /No backup copy has reached the old server recently \(last confirmed 4 days ago\)/,
    );
    expect(points.at(-1)!.text).toMatch(
      /278 imported notes are waiting for your review; 136 of them look ready/,
    );
  });

  it("notices open threads that have gone quiet", () => {
    const points = buildOpening(
      input({
        entries: [
          memory({ kind: "thread", status: "open", title: "A", updatedAt: daysAgo(40) }),
          memory({ kind: "thread", status: "open", title: "B", updatedAt: daysAgo(45) }),
        ],
      }),
    );
    expect(points.filter((p) => p.kind === "in-progress").map((p) => p.text)).toEqual([
      "2 open threads. Most recently active: A; B.",
      "2 open threads have not moved in a month; some may be done already.",
    ]);
  });
});
