import type { ApprovalTicket, IsoTime } from "./domain";
import type { ActionKind, Requester } from "./policy";

/**
 * Jobs: a plan of steps, approved once as a whole, carried out in order with
 * progress, each step verified, and stopped (with rollback of anything that
 * declares one) at the first failure. Every step is an operation
 * Hearth already knows; a job never runs anything else.
 */

export type JobStatus =
  | "awaiting-approval"
  | "refused"
  | "running"
  | "succeeded"
  /** Finished, but only some items were done: the rest were skipped or failed (per-item plans). */
  | "partial"
  | "failed"
  | "rolled-back"
  | "cancelled"
  | "expired"
  | "interrupted";

export type JobStepStatus =
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "rolled-back" | "interrupted";

/** Values an operation inside an app needs (which indexer, on or off). Never secrets. */
export type StepParams = Record<string, string | number | boolean>;

/** A setting as it is now and as the step would leave it. */
export interface SettingChange {
  name: string;
  before: string;
  after: string;
}

/**
 * Exactly what a configuration step changes, read from the app when the plan
 * was made. Approval covers these values; if the app no longer matches
 * "before" when the step runs, the step stops instead of changing anything.
 */
export interface StepChange {
  summary: string;
  settings: SettingChange[];
}

/** What a plan is made of: one operation on one service. */
export interface JobStepInput {
  kind: ActionKind;
  serviceId: string;
  params?: StepParams;
}

export interface JobStep extends JobStepInput {
  seq: number;
  /** Plain words: "Restart the Jellyfin container". */
  label: string;
  serviceName: string;
  /** True when the step changes something. */
  changes: boolean;
  /** What the policy said when the plan was made: "allow", "approve-first", or "refuse". */
  policy: "allow" | "approve-first" | "refuse";
  policyReason: string;
  /** How Hearth checks the step worked. */
  verify: string;
  /** How the step is undone if a later step fails, or why it needs no undoing. */
  rollback: string;
  /** Configuration steps: the exact change, before and after. */
  change?: StepChange;
  status: JobStepStatus;
  startedAt?: IsoTime;
  finishedAt?: IsoTime;
  result?: string;
  /** The action record that carried it out (Recent actions, audit). */
  actionId?: string;
  /** Per-item plans: the workspace item this step acts on. */
  itemId?: string;
  /** Space a verified delete freed (never estimated). */
  freedBytes?: number;
  /**
   * Hearth read the result back from the app and it matched what was approved (set only by
   * operations that read back; absent means the step did not say).
   */
  verified?: boolean;
}

export interface Job {
  id: string;
  title: string;
  /** Why: your words, the AI's reason, or the incident it serves. */
  reason?: string;
  /** What changes for the owner if it is approved, in the AI's words (shown on the card). */
  impact?: string;
  requestedBy: Requester;
  incidentId?: string;
  /** The project this job serves, if any. */
  projectId?: string;
  /**
   * The conversation it was proposed in: that chat shows its card, whichever turn made it
   * (11-22: a plan made in an automatic follow-up never showed in the owner's chat).
   */
  conversationId?: string;
  status: JobStatus;
  createdAt: IsoTime;
  startedAt?: IsoTime;
  finishedAt?: IsoTime;
  /** What happened, in plain words, once it has finished. */
  summary?: string;
  /** Present while it awaits approval: approving must send the fingerprint back. */
  approval?: ApprovalTicket;
  /** Who approved it, and when. */
  approvedAt?: IsoTime;
  /** Made from a workspace submission: its frozen snapshot, and items run independently. */
  workspace?: { id: string; snapshotId: string };
  steps: JobStep[];
}

export const JOB_DONE: readonly JobStatus[] = [
  "refused",
  "succeeded",
  "partial",
  "failed",
  "rolled-back",
  "cancelled",
  "expired",
  "interrupted",
];

export const MAX_JOB_STEPS = 12;

/** A plan made from a workspace has one step per item, each independent. */
export const MAX_WORKSPACE_PLAN_STEPS = 200;
