import type { Database } from "../db/client";
import * as t from "../db/schema";

/**
 * Tables that describe an environment (sample or real), children first so
 * foreign keys are satisfied. Settings, notification channels and routes,
 * the audit log, the owner, and install identity are never part of an
 * environment and are never cleared.
 */
const environmentTables = [
  // Findings describe this environment's systems, so they go with it.
  t.findingEvents,
  t.findings,
  t.findingAcceptances,
  t.analyzerRuns,
  t.volumeUsageDaily,
  t.checkState,
  t.appHealth,
  t.availabilityHourly,
  t.storageLocations,
  t.disks,
  t.incidentTimeline,
  t.events,
  t.actions,
  t.jobSteps,
  t.jobs,
  t.agentSessions,
  t.incidents,
  t.serviceDependencies,
  t.services,
  t.volumes,
  t.hosts,
  t.integrations,
];

export async function clearEnvironment(
  db: Database,
  opts: { includeAutonomyRules: boolean },
): Promise<void> {
  for (const table of environmentTables) await db.delete(table);
  if (opts.includeAutonomyRules) await db.delete(t.autonomyRules);
}
