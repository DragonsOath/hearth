/**
 * Long work: anything that runs for more than a minute outside a plan (voice training, a big
 * download, a migration script). It reports progress and a heartbeat to Hearth; when
 * the heartbeat stops, or it runs past its stop time, the owner is told instead of finding out
 * an hour later.
 */

export const WORK_STATUSES = ["running", "done", "failed", "stalled", "stopped"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** The statuses a reporter may set. "stalled" is only ever decided by Hearth. */
export const REPORTED_WORK_STATUSES = ["running", "done", "failed", "stopped"] as const;
export type ReportedWorkStatus = (typeof REPORTED_WORK_STATUSES)[number];

export interface TrackedWork {
  id: string;
  title: string;
  /** Where it runs ("Gaming-PC"). */
  machine: string;
  status: WorkStatus;
  /** 0 to 100, when the work can tell. */
  progress?: number;
  /** The latest line it reported ("operator: 520 of 1012 lines"). */
  detail?: string;
  startedAt: string;
  heartbeatAt: string;
  /** It must be finished (or stop itself) by then, for example before a GPU reservation. */
  stopBy?: string;
  /** No report for this long means stalled. */
  stallMinutes: number;
  finishedAt?: string;
  /** Who started tracking it: an access key's name, or "you". */
  reportedBy: string;
  /** Set when it ran past stopBy while still running. */
  overdue?: boolean;
}

export const DEFAULT_STALL_MINUTES = 10;

export const WORK_STATUS_TEXT: Record<WorkStatus, string> = {
  running: "Running",
  done: "Finished",
  failed: "Failed",
  stalled: "Stalled",
  stopped: "Stopped",
};
