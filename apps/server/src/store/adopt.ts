import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { AdoptSelection, DiscoveryReport } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { baseCatalog } from "../demo/fixtures";
import { slug } from "../discovery/scan";
import { recordAudit } from "./audit";
import { saveDisks } from "./disks";
import { ensureNotificationCatalog } from "../notify/catalog";
import { ensureAgentCatalog } from "../agent/catalog";
import { clearEnvironment } from "./environment";
import { InvalidRequestError } from "./errors";
import { deleteSetting, getSetting, setSetting } from "./settings";

/**
 * Turns a discovery report into your environment. The report comes from
 * the server's own scan (never from the browser), and selections can only
 * choose and rename findings in it, not invent new ones.
 *
 * The first adoption replaces sample data. Later scans merge: services you
 * keep keep their incidents and availability history, new ones are added,
 * ones you untick are removed (except paused, retired, or removed ones and
 * ones you added yourself: a stopped container is never ticked by default,
 * and your decision about it stays on record), and your agent and notification setup is left alone. Settings, autonomy, and audit history are always kept.
 */
export async function adoptDiscovery(
  handle: DbHandle,
  report: DiscoveryReport,
  chosen: AdoptSelection[],
): Promise<{ services: number }> {
  const { db } = handle;
  // Systems already in Hearth. Sample data does not count: adopting replaces it.
  const known =
    (await getSetting(db, "environment")) === "real"
      ? await db
          .select({
            id: t.services.id,
            hostId: t.services.hostId,
            checkTarget: t.services.checkTarget,
            lifecycle: t.services.lifecycle,
          })
          .from(t.services)
      : [];
  // A system you removed stays removed, even if it is ticked: only Settings brings it back.
  const removedKeys = new Set(
    known
      .filter((s) => s.hostId === report.host.id && s.lifecycle === "removed")
      .map((s) => s.checkTarget),
  );
  const selections = chosen.filter((s) => !removedKeys.has(s.key));
  const byKey = new Map(report.findings.map((f) => [f.key, f]));
  const unknown = chosen.filter((s) => !byKey.has(s.key)).map((s) => s.key);
  if (unknown.length) {
    throw new InvalidRequestError(`These were not in the scan: ${unknown.join(", ")}`);
  }
  // Nothing ticked is allowed: Hearth then watches the machine itself (its processor, memory and
  // drives) with no services, instead of leaving someone with no way to see their own PC.

  // Stable, readable ids: "container:immich_server" -> "immich-server". The
  // same container always gets the same id, which is what lets a re-scan merge.
  // One already in Hearth (say, one you added by hand before a scan found
  // it) keeps its id, and a new one never takes over another system's id.
  const sameSystem = new Map(
    known.filter((s) => s.hostId === report.host.id).map((s) => [s.checkTarget, s.id]),
  );
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const sel of selections) {
    const own = sameSystem.get(sel.key);
    if (own && !used.has(own)) {
      used.add(own);
      ids.set(sel.key, own);
      continue;
    }
    const base = slug(sel.key.replace(/^[a-z]+:/, ""));
    const takenByAnother = (id: string) =>
      known.some((s) => s.id === id && !(s.hostId === report.host.id && s.checkTarget === sel.key));
    let id = base;
    for (let n = 2; used.has(id) || takenByAnother(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(sel.key, id);
  }

  const now = new Date().toISOString();
  const catalog = baseCatalog();
  const host = report.host;

  await withTransaction(handle, async () => {
    const merging = (await getSetting(db, "environment")) === "real";
    const hasRules = (await db.select().from(t.autonomyRules)).length > 0;

    if (!merging) {
      await clearEnvironment(db, { includeAutonomyRules: false });
    }

    const hostRow = {
      id: host.id,
      name: host.name,
      role: host.role,
      os: host.os,
      address: host.address,
      cpuModel: host.cpu.model,
      cpuCores: host.cpu.cores,
      cpuUsagePct: host.cpu.usagePct,
      memTotalGb: host.memory.totalGb,
      memUsedGb: host.memory.usedGb,
      uptimeHours: host.uptimeHours,
      connection: host.connection,
      docker: host.docker,
      health: "healthy" as const,
      lastSeenAt: report.scannedAt,
    };
    await db
      .insert(t.hosts)
      .values(hostRow)
      .onConflictDoUpdate({ target: t.hosts.id, set: hostRow });

    await db.delete(t.volumes).where(eq(t.volumes.hostId, host.id));
    if (host.volumes.length) {
      await db
        .insert(t.volumes)
        .values(host.volumes.map((v, i) => ({ ...v, hostId: host.id, sort: i })));
    }
    await saveDisks(db, host.id, report.disks);

    if (!hasRules) {
      await db
        .insert(t.autonomyRules)
        .values(catalog.autonomyRules.map((r, i) => ({ ...r, sort: i })));
    }

    // Services: remove the ones you no longer want, then add or update the rest.
    // Paused, retired, and removed services stay, and so do ones you added
    // yourself: you decided those, a scan did not.
    const keepIds = [...ids.values()];
    const unticked = merging
      ? (
          await db
            .select({
              id: t.services.id,
              lifecycle: t.services.lifecycle,
              origin: t.services.origin,
            })
            .from(t.services)
            .where(eq(t.services.hostId, host.id))
        ).filter((r) => !keepIds.includes(r.id))
      : [];
    const held = unticked
      .filter((r) => r.lifecycle !== "active" || r.origin === "manual")
      .map((r) => r.id);
    const removed = unticked.length - held.length;
    // Only this machine's services: adopting one machine never removes another's.
    await db
      .delete(t.services)
      .where(and(eq(t.services.hostId, host.id), notInArray(t.services.id, [...keepIds, ...held])));
    const existing = new Map(
      (await db.select().from(t.services).where(inArray(t.services.id, keepIds))).map((s) => [
        s.id,
        s,
      ]),
    );

    for (const [i, sel] of selections.entries()) {
      const f = byKey.get(sel.key)!;
      const id = ids.get(sel.key)!;
      const prior = existing.get(id);
      const row = {
        id,
        name: sel.name.trim() || f.name,
        category: f.category,
        hostId: host.id,
        kind: f.source === "process" ? ("process" as const) : ("container" as const),
        image: f.image ?? null,
        version: prior?.version ?? null,
        localUrl: f.localUrl ?? null,
        publicUrl: prior?.publicUrl ?? null,
        proxyServiceId: prior?.proxyServiceId ?? null,
        // Monitoring owns health once a service exists; a new one starts from what the scan saw.
        health: prior?.health ?? f.health,
        responseMs: prior?.responseMs ?? null,
        uptimePct: null,
        autonomyArea: prior?.autonomyArea ?? f.autonomyArea,
        checkTarget: f.key,
        note: prior?.note ?? null,
        // Paused, retired, or removed stays that way when the machine is scanned again:
        // a system you removed is never brought back by a scan.
        lifecycle: prior?.lifecycle ?? ("active" as const),
        lifecycleNote: prior?.lifecycleNote ?? null,
        lifecycleAt: prior?.lifecycleAt ?? null,
        sort: i,
      };
      await db
        .insert(t.services)
        .values(row)
        .onConflictDoUpdate({ target: t.services.id, set: row });
    }

    // Relationships only between services you kept, rebuilt from this scan.
    await db.delete(t.serviceDependencies).where(inArray(t.serviceDependencies.serviceId, keepIds));
    const deps = selections.flatMap((sel) =>
      byKey
        .get(sel.key)!
        .dependsOn.filter((d) => ids.has(d))
        .map((d) => ({ serviceId: ids.get(sel.key)!, dependsOnId: ids.get(d)! })),
    );
    if (deps.length) await db.insert(t.serviceDependencies).values(deps);

    const containerCount = selections.filter((s) => s.key.startsWith("container:")).length;
    if (!merging) {
      // A real installation starts with nothing pretending to be configured.
      await db.insert(t.integrations).values(
        catalog.integrations.map((x, i) => ({
          ...x,
          status: x.status,
          instances: null,
          sort: i,
        })),
      );
    }
    await ensureNotificationCatalog(db);
    await ensureAgentCatalog(db);
    if (!merging) await setSetting(db, "notify_since", now);
    // Integration counts always reflect the latest scan.
    // Web checks count every machine's services, not just this scan's.
    const allWeb = (
      await db.select({ id: t.services.id }).from(t.services).where(isNotNull(t.services.localUrl))
    ).length;
    const counts: Record<string, number | null> =
      host.connection === "this-machine"
        ? {
            docker: report.docker.available && containerCount > 0 ? 1 : null,
            windows: /windows/i.test(host.os) ? 1 : null,
            linux: /windows/i.test(host.os) ? null : 1,
            http: allWeb || null,
          }
        : { http: allWeb || null };
    for (const [id, instances] of Object.entries(counts)) {
      await db
        .update(t.integrations)
        .set({ status: instances ? "connected" : "available", instances })
        .where(eq(t.integrations.id, id));
    }

    await db.insert(t.events).values({
      id: randomUUID(),
      at: now,
      tone: "good",
      message: merging
        ? `Rescanned ${host.name}: ${selections.length} services`
        : `Discovered ${selections.length} services on ${host.name}`,
      hostId: host.id,
    });

    await setSetting(db, "environment", "real");
    await setSetting(db, "discovered_at", report.scannedAt);
    await deleteSetting(db, "demo_scenario");
    await recordAudit(db, {
      actor: "you",
      action: merging
        ? "Updated your systems from a new scan"
        : "Replaced sample data with your systems",
      target: `host:${host.id}`,
      detail: {
        services: selections.length,
        skipped: report.findings.length - selections.length,
        ...(merging ? { removed } : {}),
        renamed: selections.filter((s) => s.name.trim() && s.name.trim() !== byKey.get(s.key)!.name)
          .length,
      },
    });
  });

  return { services: selections.length };
}
