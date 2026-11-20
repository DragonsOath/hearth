import type { BackupStatus } from "@dragon-control/core";
import { releasesAnalyzer } from "./analyzers/releases";
import type { ContainerTools } from "../actions/tools";
import type { DbHandle } from "../db/client";
import type { MonitorProbes } from "../monitor/probes";
import { appsAnalyzer } from "./analyzers/apps";
import { downloadsAnalyzer } from "./analyzers/downloads";
import { nearMissAnalyzer } from "./analyzers/near-misses";
import { seedingAnalyzer } from "./analyzers/seeding";
import { blueprintAnalyzer } from "./analyzers/blueprint";
import { dockerAnalyzer } from "./analyzers/docker";
import { backupAnalyzer, hostAnalyzer } from "./analyzers/host";
import { incidentsAnalyzer } from "./analyzers/incidents";
import { securityAnalyzer } from "./analyzers/security";
import { storageAnalyzer } from "./analyzers/storage";
import { raidAnalyzer } from "./analyzers/raid";
import { FindingsEngine } from "./engine";
import { Findings } from "./store";

export { FindingsEngine } from "./engine";
export { Findings } from "./store";

/** Hearth's analyzers, in the order they run (cheap database reads first). */
export function createFindingsEngine(
  handle: DbHandle,
  deps: {
    probes: MonitorProbes;
    containers: ContainerTools;
    backups?: { status(): Promise<BackupStatus> };
    /** RAID arrays (Storage > RAID / Arrays). */
    raid?: () => Promise<import("@dragon-control/core").RaidReport>;
    /** What live seeding rules did that the owner hasn't seen (apps/service.ts). */
    seeding?: Parameters<typeof seedingAnalyzer>[0];
    /** The Lab Blueprint failing or going stale (blueprint/service.ts). */
    blueprint?: Parameters<typeof blueprintAnalyzer>[0];
  },
): FindingsEngine {
  return new FindingsEngine(handle, new Findings(handle), [
    incidentsAnalyzer(),
    appsAnalyzer(),
    downloadsAnalyzer(),
    nearMissAnalyzer(),
    ...(deps.seeding ? [seedingAnalyzer(deps.seeding)] : []),
    releasesAnalyzer(),
    hostAnalyzer(),
    dockerAnalyzer(deps.probes),
    storageAnalyzer(deps.probes),
    ...(deps.raid ? [raidAnalyzer(deps.raid)] : []),
    ...(deps.backups ? [backupAnalyzer(deps.backups)] : []),
    ...(deps.blueprint ? [blueprintAnalyzer(deps.blueprint)] : []),
    securityAnalyzer(deps.containers),
  ]);
}
