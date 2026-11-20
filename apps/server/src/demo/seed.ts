import type { DemoScenario } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { ensureNotificationCatalog } from "../notify/catalog";
import { ensureAgentCatalog } from "../agent/catalog";
import { withTransaction } from "../db/tx";
import { approvalExpiry } from "../actions/approval";
import { saveDisks } from "../store/disks";
import { clearEnvironment } from "../store/environment";
import { clearSimulations } from "../monitor/simulation";
import { deleteSetting, getSetting, setSetting } from "../store/settings";
import { buildWorkspace } from "./fixtures";

/**
 * Replace the environment with a demo scenario. Your own preferences
 * (name, quiet hours) are kept; everything describing the environment,
 * including autonomy rules, is reset to the scenario's version.
 */
export async function seedDemo(
  handle: DbHandle,
  scenario: DemoScenario,
  now: number = Date.now(),
): Promise<void> {
  const ws = buildWorkspace(scenario);
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const { db } = handle;

  clearSimulations();
  await withTransaction(handle, async () => {
    await clearEnvironment(db, { includeAutonomyRules: true });

    if (ws.hosts.length) {
      await db.insert(t.hosts).values(
        ws.hosts.map((h, i) => ({
          id: h.id,
          name: h.name,
          role: h.role,
          os: h.os,
          address: h.address,
          cpuModel: h.cpu.model,
          cpuCores: h.cpu.cores,
          cpuUsagePct: h.cpu.usagePct,
          memTotalGb: h.memory.totalGb,
          memUsedGb: h.memory.usedGb,
          uptimeHours: h.uptimeHours,
          connection: h.connection,
          docker: h.docker,
          health: h.health,
          lastSeenAt: at(h.lastSeen),
          sort: i,
        })),
      );
      const volumes = ws.hosts.flatMap((h) =>
        h.volumes.map((v, i) => ({ ...v, hostId: h.id, sort: i })),
      );
      if (volumes.length) await db.insert(t.volumes).values(volumes);
    }

    await db.insert(t.autonomyRules).values(ws.autonomyRules.map((r, i) => ({ ...r, sort: i })));

    if (ws.services.length) {
      await db.insert(t.services).values(
        ws.services.map((s, i) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          hostId: s.hostId,
          kind: s.kind,
          image: s.image ?? null,
          version: s.version ?? null,
          localUrl: s.localUrl ?? null,
          publicUrl: s.publicUrl ?? null,
          proxyServiceId: s.proxyServiceId ?? null,
          health: s.health,
          responseMs: s.responseMs ?? null,
          uptimePct: s.uptimePct,
          autonomyArea: s.autonomyArea,
          checkTarget: `demo:${s.id}`,
          note: s.note ?? null,
          sort: i,
        })),
      );
      const deps = ws.services.flatMap((s) =>
        s.dependsOn.map((d) => ({ serviceId: s.id, dependsOnId: d })),
      );
      if (deps.length) await db.insert(t.serviceDependencies).values(deps);
    }

    for (const inc of ws.incidents) {
      await db.insert(t.incidents).values({
        id: inc.id,
        title: inc.title,
        severity: inc.severity,
        status: inc.status,
        openedAt: at(inc.openedAt),
        resolvedAt: inc.resolvedAt === undefined ? null : at(inc.resolvedAt),
        summary: inc.summary,
        resolution: inc.resolution ?? null,
        handledBy: inc.handledBy,
        proposedAction: inc.proposedAction ?? null,
        proposalExpiresAt:
          inc.status === "awaiting-approval" ? approvalExpiry(new Date(now)) : null,
        hostId: inc.hostId ?? null,
        serviceId: inc.serviceId ?? null,
        monitorKey: inc.monitorKey ?? null,
      });
      if (inc.timeline.length) {
        await db.insert(t.incidentTimeline).values(
          inc.timeline.map((e) => ({
            incidentId: inc.id,
            at: at(e.at),
            kind: e.kind,
            text: e.text,
          })),
        );
      }
    }

    if (ws.activity.length) {
      await db.insert(t.events).values(
        ws.activity.map((a) => ({
          id: a.id,
          at: at(a.at),
          tone: a.tone,
          message: a.text,
          incidentId: a.incidentId ?? null,
        })),
      );
    }

    // Which agent is connected is your setting, not sample data.
    await ensureAgentCatalog(db);
    if (ws.agentSessions.length) {
      await db
        .insert(t.agentSessions)
        .values(ws.agentSessions.map((s) => ({ ...s, at: at(s.at) })));
    }
    // Channels and routes are your settings, not sample data: only filled in if missing.
    await ensureNotificationCatalog(db);
    // Sample history is not news: only what happens from now on is notified.
    await setSetting(db, "notify_since", new Date().toISOString());
    await db
      .insert(t.integrations)
      .values(ws.integrations.map((x, i) => ({ ...x, instances: x.instances ?? null, sort: i })));

    await setSetting(db, "autonomy_default", ws.autonomyDefault);
    const checkedAt = at(12);
    const demoDisk = (
      hostId: string,
      n: number,
      model: string,
      type: "ssd" | "hdd",
      bus: string,
      sizeTb: number,
      volumes: string[],
      temperatureC: number,
      powerOnHours: number,
      wearPct?: number,
    ) => ({
      id: `${hostId}-disk-${n}`,
      hostId,
      model,
      type,
      bus,
      sizeTb,
      health: "healthy" as const,
      temperatureC,
      powerOnHours,
      wearPct,
      readErrors: 0,
      writeErrors: 0,
      volumes,
      checkedAt,
    });
    if (ws.hosts.some((h) => h.id === "obsidian")) {
      await saveDisks(db, "obsidian", [
        demoDisk("obsidian", 0, "Samsung 990 PRO 1TB", "ssd", "NVMe", 1, ["C:"], 41, 9_412, 3),
        demoDisk("obsidian", 1, "Crucial T500 2TB", "ssd", "NVMe", 2, ["D:"], 44, 6_103, 2),
      ]);
    }
    if (ws.hosts.some((h) => h.id === "atlas")) {
      await saveDisks(db, "atlas", [
        demoDisk(
          "atlas",
          0,
          "WDC WD221KFGX (mirror)",
          "hdd",
          "SATA",
          22,
          ["/mnt/tank/movies"],
          scenario === "attention" ? 49 : 38,
          21_884,
        ),
        demoDisk(
          "atlas",
          1,
          "Seagate IronWolf Pro 22TB",
          "hdd",
          "SATA",
          22,
          ["/mnt/tank/shows"],
          37,
          21_880,
        ),
        demoDisk(
          "atlas",
          2,
          "Seagate IronWolf 8TB",
          "hdd",
          "SATA",
          8,
          ["/mnt/tank/photos"],
          35,
          30_412,
        ),
        demoDisk("atlas", 3, "WDC WD140EFGX", "hdd", "SATA", 14, ["/mnt/tank/books"], 36, 17_045),
      ]);
    }
    if (ws.hosts.some((h) => h.id === "studio")) {
      await saveDisks(db, "studio", [
        demoDisk("studio", 0, "Samsung 990 PRO 2TB", "ssd", "NVMe", 2, ["C:"], 39, 3_120, 1),
        demoDisk("studio", 1, "WD Black SN850X 8TB", "ssd", "NVMe", 8, ["G:"], 46, 2_877, 4),
      ]);
    }

    // Sample watched folders on the storage host, browsable with made-up contents.
    if (scenario !== "fresh") {
      await db.insert(t.storageLocations).values(
        [
          ["movies", "Movies", "/mnt/tank/movies"],
          ["shows", "Shows", "/mnt/tank/shows"],
          ["photos", "Photos", "/mnt/tank/photos"],
          ["books", "Books & Audio", "/mnt/tank/books"],
        ].map(([key, label, p], i) => ({
          id: `demo-${key}`,
          hostId: "atlas",
          label: label!,
          path: p!,
          source: "demo" as const,
          addedAt: at(60 * 24 * 30),
          sort: i,
        })),
      );
    }

    await setSetting(db, "demo_scenario", scenario);
    await setSetting(db, "environment", "demo");
    await deleteSetting(db, "discovered_at");
  });
}

/**
 * First start in demo mode gives the UI something to show. Never seeds over
 * an environment that already exists, sample or real.
 */
export async function ensureInitialEnvironment(
  handle: DbHandle,
  config: { demo: boolean },
): Promise<void> {
  const environment = await getSetting(handle.db, "environment");
  const legacyDemo = await getSetting(handle.db, "demo_scenario"); // pre-M3 databases
  if (config.demo && !environment && !legacyDemo) await seedDemo(handle, "calm");
}
