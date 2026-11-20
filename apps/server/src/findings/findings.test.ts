import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations, type DbHandle } from "../db/client";
import * as t from "../db/schema";
import { setSetting } from "../store/settings";
import type { ContainerInventoryItem, MonitorProbes } from "../monitor/probes";
import { Findings, type AnalyzerResult, type FindingDraft } from "./store";
import { FindingsEngine } from "./engine";
import { buildBriefing } from "./briefing";
import { classify, appsAnalyzer } from "./analyzers/apps";
import { dockerAnalyzer, exitedAgo, STALE_MS } from "./analyzers/docker";
import { growthPerDay, storageAnalyzer } from "./analyzers/storage";
import { incidentsAnalyzer } from "./analyzers/incidents";
import { DAY } from "./analyzers/types";

const handles: DbHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

async function setup() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  handles.push(handle);
  await handle.db.insert(t.hosts).values({
    id: "h1",
    name: "Homeserver",
    role: "server",
    os: "Linux",
    address: "127.0.0.1",
    cpuModel: "x",
    cpuCores: 8,
    cpuUsagePct: 0,
    memTotalGb: 32,
    memUsedGb: 8,
    uptimeHours: 1,
    connection: "this-machine",
    docker: true,
    health: "healthy",
    lastSeenAt: new Date().toISOString(),
  });
  const svc = (id: string, image: string) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    category: "media",
    hostId: "h1",
    kind: "container" as const,
    health: "healthy" as const,
    autonomyArea: "media",
    checkTarget: `container:${id}`,
    image,
    lifecycle: "active" as const,
  });
  await handle.db
    .insert(t.services)
    .values([
      svc("sonarr", "lscr.io/linuxserver/sonarr:latest"),
      svc("radarr", "lscr.io/linuxserver/radarr:latest"),
    ]);
  return handle;
}

const draft = (key: string, over: Partial<FindingDraft> = {}): FindingDraft => ({
  key,
  kind: "problem",
  severity: "medium",
  title: `Problem ${key}`,
  summary: `Saw ${key}`,
  why: "It matters.",
  nextSteps: ["Look at it."],
  evidence: [{ label: "seen", value: "yes" }],
  resources: [],
  ...over,
});

const result = (drafts: FindingDraft[], over: Partial<AnalyzerResult> = {}): AnalyzerResult => ({
  status: "ok",
  drafts,
  covered: () => true,
  ...over,
});

const A = { id: "test.a", source: "docker" as const };
const at = (min: number) => new Date(Date.UTC(2026, 9, 19, 10, 0) + min * 60_000).toISOString();

describe("Findings.reconcile", () => {
  it("opens once, updates with new evidence, and resolves only when it looked and it was gone", async () => {
    const f = new Findings(await setup());
    const first = await f.reconcile(A, result([draft("x")]), at(0));
    expect(first.opened).toHaveLength(1);
    const again = await f.reconcile(A, result([draft("x", { summary: "Saw it worse" })]), at(5));
    expect(again.opened).toHaveLength(0);
    const list = await f.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.summary).toBe("Saw it worse");

    // Could not look: nothing changes.
    await f.reconcile(A, result([], { status: "unavailable", covered: () => false }), at(10));
    expect((await f.list())[0]!.status).toBe("open");

    // Looked, and it is gone: resolved, and kept as history.
    const done = await f.reconcile(A, result([]), at(15));
    expect(done.resolved).toBe(1);
    expect(await f.list()).toHaveLength(0);
    const detail = await f.get(String(list[0]!.number));
    expect(detail.status).toBe("resolved");
    expect(detail.events.map((e) => e.kind)).toEqual(["opened", "evidence", "resolved"]);
  });

  it("waits for repeated sightings when asked, and drops a candidate that never showed", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("blip", { confirmAfter: 3 })]), at(0));
    expect(await f.list()).toHaveLength(0);
    await f.reconcile(A, result([]), at(5));
    await f.reconcile(A, result([draft("blip", { confirmAfter: 3 })]), at(10));
    await f.reconcile(A, result([draft("blip", { confirmAfter: 3 })]), at(15));
    expect(await f.list()).toHaveLength(0);
    const r = await f.reconcile(A, result([draft("blip", { confirmAfter: 3 })]), at(20));
    expect(r.opened).toHaveLength(1);
  });

  it("reopens the same finding when it comes back within a day, and a new one after", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("flap")]), at(0));
    await f.reconcile(A, result([]), at(5));
    await f.reconcile(A, result([draft("flap")]), at(30));
    const open = await f.list();
    expect(open).toHaveLength(1);
    expect(open[0]!.occurrences).toBe(2);
    await f.reconcile(A, result([]), at(40));
    await f.reconcile(A, result([draft("flap")]), at(40 + 25 * 60));
    const all = await f.list({ status: "all" });
    expect(all).toHaveLength(2);
  });

  it("records escalation and confirmation in the history", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("e", { kind: "suspected" })]), at(0));
    await f.reconcile(A, result([draft("e", { kind: "problem" })]), at(5));
    await f.reconcile(A, result([draft("e", { kind: "problem", severity: "high" })]), at(10));
    const d = await f.get((await f.list())[0]!.id);
    expect(d.events.map((e) => e.kind)).toEqual(["opened", "confirmed", "escalated"]);
  });

  it("keeps a dismissed finding quiet while it lasts, and closes it when the condition is gone", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("d")]), at(0));
    const id = (await f.list())[0]!.id;
    await f.act(id, { type: "dismiss", reason: "known" }, "you");
    await f.reconcile(A, result([draft("d")]), at(5));
    expect(await f.list()).toHaveLength(0);
    expect((await f.get(id)).status).toBe("dismissed");
    await f.reconcile(A, result([]), at(10));
    expect((await f.get(id)).status).toBe("resolved");
  });
});

describe("who may do what", () => {
  it("leaves the owner's decisions to the owner and resolving to the recheck", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("p")]), at(0));
    const id = (await f.list())[0]!.id;
    await expect(f.act(id, { type: "dismiss" }, "ember")).rejects.toThrow(/Only the owner/);
    await expect(f.act(id, { type: "snooze", until: at(600) }, "ember")).rejects.toThrow();
    await expect(
      f.act(id, { type: "resolve", verification: "I checked and it is fine now." }, "ember"),
    ).rejects.toThrow(/recheck/);
    const inv = await f.act(id, { type: "investigating" }, "ember");
    expect(inv.status).toBe("investigating");
    const before = (await f.list())[0]!.priority;
    await f.act(id, { type: "acknowledge" }, "you");
    // Investigating stays investigating; seen is recorded either way.
    expect((await f.get(id)).events.at(-1)!.kind).toBe("acknowledged");
    expect((await f.list())[0]!.priority).toBe(before);
  });

  it("lets Ember record, update, and resolve its own findings with how it verified them", async () => {
    const handle = await setup();
    const f = new Findings(handle);
    const input = {
      key: "sonarr-disk",
      kind: "suspected" as const,
      severity: "medium" as const,
      title: "Sonarr's import folder is on the system drive",
      summary: "Imports land on / instead of /mnt/media.",
      why: "The system drive can fill up.",
      nextSteps: ["Change the root folder."],
      evidence: [{ label: "Root folder", value: "/tv" }],
      resources: [{ kind: "service" as const, id: "sonarr", name: "Sonarr" }],
      serviceId: "sonarr",
    };
    const a = await f.record(input);
    const b = await f.record({ ...input, summary: "Confirmed with df." });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.finding.id).toBe(a.finding.id);
    await expect(
      f.act(a.finding.id, { type: "resolve", verification: "ok" }, "ember"),
    ).rejects.toThrow(/verified/);
    const done = await f.act(
      a.finding.id,
      { type: "resolve", verification: "Root folder now /mnt/media/tv; checked at 10:00." },
      "ember",
    );
    expect(done.status).toBe("resolved");
  });

  it("links plans only to problems, and follows the plan's result", async () => {
    const handle = await setup();
    const f = new Findings(handle);
    await f.reconcile(A, result([draft("obs", { kind: "observation" })]), at(0));
    const obs = (await f.list())[0]!;
    await handle.db.insert(t.jobs).values({
      id: "job1",
      title: "Restart Sonarr",
      requestedBy: "agent",
      status: "awaiting-approval",
      createdAt: at(1),
    });
    await expect(f.linkJob(obs.id, "job1", "Restart Sonarr", "ember")).rejects.toThrow(/problems/);

    const { finding } = await f.record({
      kind: "problem",
      severity: "high",
      title: "Sonarr is stuck",
      summary: "Stuck.",
      why: "Nothing imports.",
      nextSteps: [],
      evidence: [],
      resources: [],
    });
    await f.linkJob(finding.id, "job1", "Restart Sonarr", "ember");
    const planned = (await f.list()).find((x) => x.id === finding.id)!;
    expect(planned.status).toBe("planned");
    // Waiting for the owner puts it first among equals.
    expect(planned.priority).toBeGreaterThan(70);

    await handle.db.update(t.jobs).set({ status: "failed" });
    await f.onJobFinished("job1");
    expect((await f.get(finding.id)).status).toBe("open");
    // A second plan that works resolves Ember's own finding (an analyzer's waits for its recheck).
    await handle.db.insert(t.jobs).values({
      id: "job2",
      title: "Recreate Sonarr",
      requestedBy: "agent",
      status: "succeeded",
      createdAt: at(2),
    });
    await f.linkJob(finding.id, "job2", "Recreate Sonarr", "ember");
    await f.onJobFinished("job2");
    const done = await f.get(finding.id);
    expect(done.status).toBe("resolved");
    expect(done.events.map((e) => e.kind)).toContain("plan-result");
  });
});

describe("analyzers", () => {
  it("reads Docker's exit times", () => {
    expect(exitedAgo("Exited (137) 2 weeks ago")).toBe(14 * DAY);
    expect(exitedAgo("Exited (0) About an hour ago")).toBe(3_600_000);
    expect(exitedAgo("Up 3 days")).toBeUndefined();
  });

  it("words a failed app task as a task, not a download (11-11)", () => {
    const r = classify({
      level: "warning",
      key: "task:abc123",
      text: 'The task "Generate Trickplay Images" failed.',
    });
    expect(r).toMatchObject({ nature: "maintenance", severity: "low" });
    expect(r.why("Jellyfin")).toMatch(/scheduled jobs/);
    expect(r.why("Jellyfin")).not.toMatch(/Failed downloads/);
  });

  it("classifies what apps report", () => {
    expect(
      classify({
        level: "warning",
        key: "health:IndexerStatusCheck",
        text: "Indexers unavailable due to failures: X",
      }),
    ).toMatchObject({ kind: "problem", severity: "medium" });
    expect(
      classify({ level: "warning", key: "health:UpdateCheck", text: "New update is available" })
        .kind,
    ).toBe("recommendation");
    expect(
      classify({
        level: "error",
        key: "health:DownloadClientCheck",
        text: "Unable to communicate with qBittorrent",
      }),
    ).toMatchObject({ kind: "problem", severity: "high" });
    expect(
      classify({ level: "warning", key: "health:ImportListStatusCheck", text: "Lists unavailable" })
        .severity,
    ).toBe("medium");
  });

  it("finds containers nobody watches that crashed or were left behind, and what changed", async () => {
    const handle = await setup();
    let inv: ContainerInventoryItem[] | { error: string } = [
      {
        name: "sonarr",
        image: "sonarr",
        state: "stopped",
        exitCode: 1,
        statusText: "Exited (1) 1 minute ago",
      },
      {
        name: "tdarr",
        image: "tdarr",
        state: "stopped",
        exitCode: 137,
        statusText: "Exited (137) 3 hours ago",
      },
      {
        name: "old1",
        image: "a",
        state: "stopped",
        exitCode: 0,
        statusText: "Exited (0) 3 weeks ago",
      },
      {
        name: "old2",
        image: "b",
        state: "stopped",
        exitCode: 1,
        statusText: "Exited (1) 2 months ago",
      },
      {
        name: "fine",
        image: "c",
        state: "stopped",
        exitCode: 0,
        statusText: "Exited (0) 2 hours ago",
      },
      {
        name: "sick",
        image: "d",
        state: "running",
        health: "unhealthy",
        statusText: "Up 1 hour (unhealthy)",
      },
    ];
    const probes = { inventory: async () => inv } as unknown as MonitorProbes;
    await setSetting(handle.db, "environment", "real");
    const engine = new FindingsEngine(handle, new Findings(handle), [dockerAnalyzer(probes)]);
    await engine.tick({ now: new Date(at(0)) });
    await engine.tick({ only: ["docker.containers"], now: new Date(at(5)) });
    const keys = (await engine.findings.list()).map((f) => f.key).sort();
    // Watched sonarr is the monitor's job; a clean recent stop is left alone.
    expect(keys).toEqual(["docker:exited:tdarr", "docker:stale", "docker:unhealthy:sick"]);
    const tdarr = (await engine.findings.list()).find((f) => f.key === "docker:exited:tdarr")!;
    expect(tdarr.kind).toBe("suspected");
    expect(tdarr.summary).toMatch(/killed/);
    expect(STALE_MS).toBe(7 * DAY);

    inv = (inv as ContainerInventoryItem[]).filter((c) => c.name !== "tdarr");
    inv.push({ name: "new", image: "e", state: "running", statusText: "Up 1 minute" });
    await engine.tick({ only: ["docker.containers"], now: new Date(at(10)) });
    expect((await engine.findings.list()).map((f) => f.key)).not.toContain("docker:exited:tdarr");
    const events = (await handle.db.select().from(t.events)).map((e) => e.message);
    expect(events).toContain("New container: new (e)");
    expect(events).toContain("Container removed: tdarr");

    // Docker unreadable: honest gap, findings kept.
    inv = { error: "permission denied" };
    await engine.tick({ only: ["docker.containers"], now: new Date(at(15)) });
    expect((await engine.findings.list()).length).toBeGreaterThan(0);
    expect((await engine.coverage())[0]).toMatchObject({ status: "unavailable" });
  });

  it("turns app reports into findings, suspected until an error repeats, and is honest about apps it cannot read", async () => {
    const handle = await setup();
    const now = new Date();
    await handle.db.insert(t.appHealth).values([
      {
        serviceId: "sonarr",
        app: "sonarr",
        status: "failing",
        version: "4.0.11",
        issues: [
          {
            level: "error",
            key: "health:DownloadClientCheck",
            text: "Unable to communicate with qBittorrent.",
          },
          { level: "warning", key: "health:UpdateCheck", text: "New update is available." },
        ],
        facts: [],
        checkedAt: now.toISOString(),
        failingChecks: 1,
      },
      {
        serviceId: "radarr",
        app: "radarr",
        status: "needs-key",
        issues: [],
        facts: [],
        detail: "Add Radarr's API key.",
        checkedAt: now.toISOString(),
      },
    ]);
    const engine = new FindingsEngine(handle, new Findings(handle), [appsAnalyzer()]);
    await engine.tick({ now });
    const list = await engine.findings.list();
    const byKey = new Map(list.map((f) => [f.key, f]));
    expect(byKey.get("app:sonarr:health:DownloadClientCheck")).toMatchObject({
      kind: "suspected",
      severity: "high",
    });
    expect(byKey.get("app:sonarr:health:UpdateCheck")?.kind).toBe("recommendation");
    expect(byKey.get("app:access")?.summary).toMatch(/Missing keys: Radarr/);
    expect((await engine.coverage())[0]).toMatchObject({ status: "partial" });

    await handle.db.update(t.appHealth).set({ failingChecks: 2 }).where(eqId("sonarr"));
    await engine.tick({ now: new Date(now.getTime() + 1000) });
    expect(
      (await engine.findings.list()).find((f) => f.key.endsWith("DownloadClientCheck"))?.kind,
    ).toBe("problem");
  });

  it("reads real reports from a homelab: one shared cause is one finding", async () => {
    // As Sonarr, Radarr, and Lidarr reported on the home server, 2026-10-19 (read only).
    const handle = await setup();
    await handle.db.insert(t.services).values({
      id: "lidarr",
      name: "Lidarr",
      category: "media",
      hostId: "h1",
      kind: "container",
      health: "healthy",
      autonomyArea: "media",
      checkTarget: "container:lidarr",
      image: "lscr.io/linuxserver/lidarr:latest",
      lifecycle: "active",
    });
    const removes = (app: string) => ({
      level: "warning" as const,
      key: "health:DownloadClientRemovesCompletedDownloadsCheck",
      text: `Download client qBittorrent is set to remove completed downloads. This can result in downloads being removed from your client before ${app} can import them.`,
    });
    const now = new Date();
    const row = (id: string, app: string, issues: object[]) => ({
      serviceId: id,
      app: id,
      status: "attention" as const,
      issues,
      facts: [],
      checkedAt: now.toISOString(),
    });
    await handle.db.insert(t.appHealth).values([
      row("sonarr", "Sonarr", [removes("Sonarr")]),
      row("radarr", "Radarr", [removes("Radarr")]),
      row("lidarr", "Lidarr", [
        removes("Lidarr"),
        {
          level: "warning",
          key: "health:IndexerLongTermStatusCheck",
          text: "Indexers unavailable due to failures for more than 6 hours: Torznab",
        },
      ]),
    ]);
    const engine = new FindingsEngine(handle, new Findings(handle), [appsAnalyzer()]);
    await engine.tick({ now });
    const list = await engine.findings.list();
    expect(list.map((f) => f.key).sort()).toEqual([
      "app:lidarr:health:IndexerLongTermStatusCheck",
      "app:shared:health:DownloadClientRemovesCompletedDownloadsCheck",
    ]);
    const shared = list.find((f) => f.key.startsWith("app:shared:"))!;
    expect(shared.title).toBe(
      "Sonarr, Radarr and Lidarr: Download client qBittorrent is set to remove completed downloads",
    );
    expect(shared).toMatchObject({ kind: "problem", severity: "medium" });
    expect(shared.why).toMatch(/before Sonarr, Radarr and Lidarr imports it/);
    // The three apps, and the download client the setting belongs to.
    expect(shared.resources.map((r) => r.name)).toEqual([
      "Sonarr",
      "Radarr",
      "Lidarr",
      "qBittorrent",
    ]);
    expect(shared.evidence.filter((e) => e.label === "Reported by")).toHaveLength(3);
    const indexer = list.find((f) => f.key.endsWith("IndexerLongTermStatusCheck"))!;
    expect(indexer.title).toBe(
      "Lidarr: Indexers unavailable due to failures for more than 6 hours: Torznab",
    );
    expect(indexer.resources.map((r) => r.name)).toContain("Indexer Torznab");
    expect(indexer.nextSteps[0]).toMatch(/test Torznab with Prowlarr's own test/);

    // Fixed in the download client: every app stops reporting it, and the finding resolves.
    await handle.db.update(t.appHealth).set({ issues: [] }).where(eqId("sonarr"));
    await handle.db.update(t.appHealth).set({ issues: [] }).where(eqId("radarr"));
    await handle.db.update(t.appHealth).set({ issues: [] }).where(eqId("lidarr"));
    await engine.tick({ now: new Date(now.getTime() + 1000) });
    expect(await engine.findings.list()).toHaveLength(0);
  });

  it("names stuck downloads with the app's own reason instead of counting them", async () => {
    const handle = await setup();
    const now = new Date();
    await handle.db.insert(t.appHealth).values({
      serviceId: "sonarr",
      app: "sonarr",
      status: "attention",
      issues: [
        { level: "warning", key: "queue:stuck", text: "2 items in the queue need attention." },
      ],
      facts: [],
      checkedAt: now.toISOString(),
      details: {
        queue: [
          { title: "Show A S01E02", status: "Downloading" },
          {
            title: "Show B S03E04",
            status: "Import blocked",
            problem: "No files found are eligible for import.",
            via: "SABnzbd",
          },
          {
            title: "Show C S01E01",
            status: "Failed",
            problem: "Download failed: not enough parts.",
          },
        ],
      },
    });
    const engine = new FindingsEngine(handle, new Findings(handle), [appsAnalyzer()]);
    await engine.tick({ now });
    const [f] = await engine.findings.list();
    expect(f!.title).toBe("Sonarr: 2 downloads need you (1 didn't import, 1 failed)");
    expect(f!.summary).toContain(
      "Show B S03E04: Import blocked. Sonarr says: No files found are eligible for import.",
    );
    expect(f!.evidence.map((e) => e.label)).toEqual([
      "Reported by",
      "Show B S03E04",
      "Show C S01E01",
    ]);
    expect(f!.resources.map((r) => r.name)).toEqual(["Sonarr", "Show B S03E04", "Show C S01E01"]);
    expect(f!.nextSteps[0]).toMatch(/import "Show B S03E04"/);
  });

  it("mirrors monitoring incidents and resolves them with the incident's own resolution", async () => {
    const handle = await setup();
    await handle.db.insert(t.incidents).values({
      id: "inc-1",
      title: "Sonarr stopped responding",
      severity: "warning",
      status: "open",
      openedAt: at(0),
      summary: "Sonarr stopped responding (connection refused).",
      handledBy: "pending",
      serviceId: "sonarr",
      monitorKey: "service:sonarr",
      problem: "not-responding",
    });
    const engine = new FindingsEngine(handle, new Findings(handle), [incidentsAnalyzer()]);
    await engine.tick({ now: new Date(at(1)) });
    const [f] = await engine.findings.list();
    expect(f).toMatchObject({ kind: "problem", severity: "high", incidentId: "inc-1" });
    await handle.db
      .update(t.incidents)
      .set({ status: "resolved", resolvedAt: at(2), resolution: "Sonarr recovered on its own." });
    await engine.tick({ now: new Date(at(3)) });
    expect((await engine.findings.get(f!.id)).resolution).toBe("Sonarr recovered on its own.");
  });

  it("forecasts when a volume fills only from real history", async () => {
    expect(
      growthPerDay([
        { day: "2026-10-01", usedTb: 1 },
        { day: "2026-10-01", usedTb: 1 },
      ]),
    ).toBeUndefined();
    expect(
      growthPerDay([
        { day: "2026-10-01", usedTb: 1 },
        { day: "2026-10-02", usedTb: 1.1 },
        { day: "2026-10-03", usedTb: 1.2 },
      ]),
    ).toBeCloseTo(0.1);

    const handle = await setup();
    await setSetting(handle.db, "environment", "demo");
    await handle.db.insert(t.volumes).values({
      id: "v1",
      hostId: "h1",
      label: "Media",
      mount: "/mnt/media",
      kind: "hdd",
      totalTb: 10,
      usedTb: 8.6,
      smart: "ok",
    });
    const today = new Date("2026-10-19T12:00:00Z");
    for (let d = 5; d >= 1; d--)
      await handle.db.insert(t.volumeUsageDaily).values({
        volumeId: "v1",
        day: new Date(today.getTime() - d * DAY).toISOString().slice(0, 10),
        usedTb: 8.6 - d * 0.05,
        totalTb: 10,
      });
    const engine = new FindingsEngine(handle, new Findings(handle), [
      storageAnalyzer({ host: async () => undefined } as unknown as MonitorProbes),
    ]);
    await engine.tick({ now: today });
    const list = await engine.findings.list();
    expect(list.map((f) => f.key).sort()).toEqual(["storage:filling:v1", "storage:forecast:v1"]);
    expect(list.find((f) => f.key === "storage:forecast:v1")!.title).toMatch(/in about 18 days/);
  });

  it("builds a briefing: what needs you, what is worth knowing, and what changed", async () => {
    const handle = await setup();
    const f = new Findings(handle);
    await f.reconcile(
      A,
      result([
        draft("big", { severity: "high" }),
        draft("tip", { kind: "recommendation", severity: "low" }),
      ]),
      at(0),
    );
    await f.reconcile(
      A,
      result([
        draft("big", { severity: "high" }),
        draft("tip", { kind: "recommendation", severity: "low" }),
        draft("gone"),
      ]),
      at(1),
    );
    await f.reconcile(
      A,
      result([
        draft("big", { severity: "high" }),
        draft("tip", { kind: "recommendation", severity: "low" }),
      ]),
      at(2),
    );
    const engine = new FindingsEngine(handle, f, []);
    const b = await buildBriefing(handle, engine, { since: at(-10), now: new Date(at(3)) });
    expect(b.attention.map((x) => x.key)).toEqual(["big"]);
    expect(b.worthKnowing.map((x) => x.key)).toEqual(["tip"]);
    expect(b.changes.some((c) => c.text.startsWith("Resolved: Problem gone"))).toBe(true);
  });
});

import { eq } from "drizzle-orm";
const eqId = (id: string) => eq(t.appHealth.serviceId, id);

describe("context", () => {
  it("an acceptance holds while the condition is the same, and is raised again when it changes", async () => {
    const f = new Findings(await setup());
    const stale = (names: string[], severity: "low" | "medium" = "low") =>
      draft("docker:stale", {
        kind: "recommendation",
        nature: "maintenance",
        severity,
        title: `${names.length} containers stopped`,
        signature: names.join("|"),
      });
    await f.reconcile(A, result([stale(["jellyseerr", "kometa"])]), at(0));
    const id = (await f.list())[0]!.id;
    await f.act(id, { type: "accept", note: "Kept for later" }, "you");
    expect(await f.list()).toHaveLength(0);
    expect((await f.list({ status: "accepted" }))[0]!.acceptedNote).toBe("Kept for later");

    // Same condition: stays accepted, quietly.
    await f.reconcile(A, result([stale(["jellyseerr", "kometa"])]), at(5));
    expect(await f.list()).toHaveLength(0);
    // Gone, then back the same after days: a new finding, accepted from the start.
    await f.reconcile(A, result([]), at(10));
    await f.reconcile(A, result([stale(["jellyseerr", "kometa"])]), at(10 + 3 * 24 * 60));
    expect(await f.list()).toHaveLength(0);
    expect(await f.list({ status: "accepted" })).toHaveLength(1);

    // One more container left behind: not what was accepted, so it is raised.
    await f.reconcile(
      A,
      result([stale(["jellyseerr", "kometa", "plex-test"])]),
      at(10 + 3 * 24 * 60 + 5),
    );
    const raised = await f.list();
    expect(raised).toHaveLength(1);
    const d = await f.get(raised[0]!.id);
    expect(d.events.at(-1)).toMatchObject({ kind: "changed" });
    expect(d.events.at(-1)!.text).toMatch(/changed since you accepted it/);

    // Worse than accepted is raised too, even with the same signature.
    await f.act(raised[0]!.id, { type: "accept" }, "you");
    await f.reconcile(
      A,
      result([stale(["jellyseerr", "kometa", "plex-test"], "medium")]),
      at(10 + 3 * 24 * 60 + 10),
    );
    expect(await f.list()).toHaveLength(1);
  });

  it("Ember cannot accept for the owner", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("x")]), at(0));
    await expect(f.act((await f.list())[0]!.id, { type: "accept" }, "ember")).rejects.toThrow(
      /Only the owner/,
    );
  });

  it("says when a problem came back after a repair, and ranks it higher", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("r", { severity: "high" })]), at(0));
    const before = (await f.list())[0]!;
    expect(before.pattern).toBe("new");
    // Fixed by a repair, confirmed by the recheck.
    const fixed = await f.reconcile(A, result([], { repaired: () => true }), at(5));
    expect(fixed.repairedFindings).toHaveLength(1);
    // Back three days later (past the usual one-day window, inside the week a repair must hold).
    await f.reconcile(A, result([draft("r", { severity: "high" })]), at(5 + 3 * 24 * 60));
    const back = (await f.list())[0]!;
    expect(back.id).toBe(before.id);
    expect(back.pattern).toBe("returned-after-repair");
    expect(back.priority).toBeGreaterThan(before.priority);
    expect(back.nextSteps[0]).toMatch(/earlier fix did not hold/);
    expect((await f.get(back.id)).events.at(-1)!.text).toMatch(/the fix did not hold/);
  });

  it("tells ongoing from new, and recovering on its own from being repaired", async () => {
    const f = new Findings(await setup());
    await f.reconcile(A, result([draft("o")]), at(0));
    await f.reconcile(A, result([draft("o")]), at(90));
    expect((await f.list())[0]!.pattern).toBe("ongoing");
    const gone = await f.reconcile(A, result([]), at(95));
    expect(gone.repairedFindings).toHaveLength(0);
    await f.reconcile(A, result([draft("o")]), at(100));
    expect((await f.list())[0]!.pattern).toBe("recurring");
  });

  it("follows a service whose incidents keep coming back as one finding, and knows a fix that did not hold", async () => {
    const handle = await setup();
    const engine = new FindingsEngine(handle, new Findings(handle), [incidentsAnalyzer()]);
    const incident = (id: string, openedAt: string) => ({
      id,
      title: "Sonarr stopped responding",
      severity: "warning" as const,
      status: "open" as const,
      openedAt,
      summary: "Sonarr stopped responding (connection refused).",
      handledBy: "pending" as const,
      serviceId: "sonarr",
      monitorKey: "service:sonarr",
      problem: "not-responding",
    });
    await handle.db.insert(t.incidents).values(incident("inc-1", at(0)));
    await engine.tick({ now: new Date(at(1)) });
    // Hearth's restart fixed it.
    await handle.db.update(t.incidents).set({
      status: "resolved",
      resolvedAt: at(3),
      handledBy: "runbook",
      resolution: "Restarted Sonarr; it answers again.",
    });
    await engine.tick({ now: new Date(at(4)) });
    // Down again two days later: the same finding, and the restart did not hold.
    await handle.db.insert(t.incidents).values(incident("inc-2", at(4 + 2 * 24 * 60)));
    await engine.tick({ now: new Date(at(5 + 2 * 24 * 60)) });
    const list = await engine.findings.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pattern: "returned-after-repair", incidentId: "inc-2" });
  });

  it("remembers a repair that a recheck confirmed", async () => {
    const handle = await setup();
    const fixed: string[] = [];
    let present = true;
    const analyzer = {
      id: "test.a",
      source: "docker" as const,
      label: "Test",
      intervalMs: 0,
      run: async () => result(present ? [draft("m")] : [], { repaired: () => true }),
    };
    const engine = new FindingsEngine(handle, new Findings(handle), [analyzer]);
    engine.remember = async (f) => {
      fixed.push(f.title);
    };
    await engine.tick({ now: new Date(at(0)) });
    present = false;
    await engine.tick({ now: new Date(at(5)) });
    expect(fixed).toEqual(["Problem m"]);
  });
});
