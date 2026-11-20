import type { FastifyBaseLogger } from "fastify";
import type { DbHandle } from "../db/client";
import { getSetting } from "../store/settings";
import { refreshDiskHealth, runChecks } from "./engine";
import type { MonitorProbes } from "./probes";
import type { ActionRunner } from "../actions/service";
import type { Notifier } from "../notify/notifier";
import { expireApprovals } from "../actions/approval";
import type { AppWatcher } from "../apps/service";
import type { ResourceHistory } from "./history";
import type { RestartLog } from "./restarts";
import type { FindingsEngine } from "../findings";

export const DEFAULT_INTERVAL = { demo: 15, real: 60 } as const;
const DISK_INTERVAL_MS = 30 * 60_000;

export async function intervalSeconds(handle: DbHandle): Promise<number> {
  const configured = await getSetting(handle.db, "monitor_interval_sec");
  if (configured) return configured;
  return (await getSetting(handle.db, "environment")) === "real"
    ? DEFAULT_INTERVAL.real
    : DEFAULT_INTERVAL.demo;
}

/**
 * Runs monitoring on a self-adjusting timer: one pass at a time (a slow
 * pass never overlaps the next), re-reading the interval each round so a
 * change in Settings takes effect without a restart.
 */
export function startMonitor(
  handle: DbHandle,
  probes: MonitorProbes,
  log: FastifyBaseLogger,
  runner?: ActionRunner,
  notifier?: Notifier,
  apps?: AppWatcher,
  history?: ResourceHistory,
  restarts?: RestartLog,
  findings?: FindingsEngine,
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastDisks = 0;
  let running: Promise<unknown> | undefined;

  const pass = async () => {
    try {
      // Proposals nobody approved in time lapse first, so they cannot be approved late.
      if (await expireApprovals(handle)) notifier?.kick();
      const summary = await runChecks(handle, probes);
      // New incidents get the response your autonomy settings allow, in the background.
      runner?.respond(summary.openedIncidents);
      // Also releases anything held for quiet hours once they end.
      notifier?.kick();
      if (summary.opened || summary.resolved) log.info(summary, "monitoring changed incidents");
      // Inside the apps (read only). Their problems are never answered with a restart.
      const appIncidents = (await apps?.tick()) ?? [];
      if (appIncidents.length) runner?.onChange?.();
      // Resource history samples every few minutes when switched on; pruning runs daily
      // (uptime history too, at 90 days) whether or not it is on.
      await history
        ?.tick()
        .catch((error: unknown) => log.warn({ err: error }, "resource sample failed"));
      await history
        ?.prune()
        .catch((error: unknown) => log.warn({ err: error }, "history prune failed"));
      // Restart history: a quick inspect of each watched container every few minutes.
      await restarts
        ?.tick()
        .catch((error: unknown) => log.warn({ err: error }, "restart history failed"));
      // Findings last, so they see this pass's incidents, app reads, and restarts.
      await findings
        ?.tick()
        .catch((error: unknown) => log.warn({ err: error }, "findings pass failed"));
      if (Date.now() - lastDisks > DISK_INTERVAL_MS) {
        lastDisks = Date.now();
        await refreshDiskHealth(handle, probes);
      }
    } catch (error) {
      log.error({ err: error }, "monitoring pass failed");
    }
  };

  const loop = async () => {
    if (stopped) return;
    running = pass();
    await running;
    running = undefined;
    if (!stopped) timer = setTimeout(() => void loop(), (await intervalSeconds(handle)) * 1000);
  };

  timer = setTimeout(() => void loop(), 2000); // let the server finish starting first

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
      await runner?.idle();
    },
  };
}
