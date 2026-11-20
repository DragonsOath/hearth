/**
 * Interactive workspaces (feature request 20): temporary side panels Ember creates for a
 * task, filled with validated structured data and shown with predefined components only (never
 * code the AI wrote). Your selections and submissions are kept on the server until you dismiss
 * the workspace, so a refresh or another device never loses them.
 */

export type WorkspaceColumnKind = "text" | "number" | "bytes" | "badge" | "path";

export interface WorkspaceColumn {
  key: string;
  label: string;
  kind?: WorkspaceColumnKind;
}

export interface WorkspaceChoice {
  value: string;
  label: string;
  tone?: "good" | "warn" | "neutral";
  /**
   * Items with this choice may become steps of an approval plan (Discard). Items with any other
   * choice (Keep) can never be targeted by a plan made from the workspace.
   */
  acts?: boolean;
}

export interface WorkspaceItem {
  /** Stable id: what your decisions are recorded against (a file path, a movie id). */
  id: string;
  /** Items in the same group are compared together (one movie's copies). */
  group?: string;
  values: Record<string, string | number | null>;
  /** Shown beside the item: a doubt about it, in plain words. */
  warning?: string;
  /** Its picture: a Plex poster path (/library/metadata/<key>/thumb/<n>), from spec.imageService. */
  image?: string;
}

/**
 * How the sheet is shown. "pick": choosing a set (the Forge collection editor, checklist 45.15):
 * Selected (items whose choice is `choice`) beside Alternatives (the rest, with `other` as their
 * choice), with search, add, remove and swap, and the count against `target`. It changes only
 * each item's choice, so submitting, snapshots and plans work exactly as in the table.
 */
export interface WorkspaceLayout {
  kind: "pick";
  choice: string;
  other: string;
  target?: number;
  /** Shown under each title (column keys): year, ratings, Ember's reason. */
  details?: string[];
}

export interface WorkspaceSpec {
  title: string;
  description?: string;
  columns: WorkspaceColumn[];
  /** One choice per item (Keep / Discard); none means a read-only list. */
  choices?: WorkspaceChoice[];
  items: WorkspaceItem[];
  /** Pre-selected choices Ember suggests; yours always win. */
  suggested?: Record<string, string>;
  submitLabel?: string;
  layout?: WorkspaceLayout;
  /** The Plex service the items' pictures come from (shown through Hearth; the token stays). */
  imageService?: string;
}

export const WORKSPACE_LIMITS = { items: 2000, columns: 12, choices: 6, text: 500 } as const;

export interface WorkspaceSubmission {
  /** The immutable snapshot this submission made (what a plan is built from). */
  snapshotId?: string;
  at: string;
  /** itemId -> choice, exactly as you left them. */
  decisions: Record<string, string>;
  counts: Record<string, number>;
  undecided: number;
}

/** open or minimized beside a conversation; closed: a saved working file not open anywhere. */
export type WorkspaceState = "open" | "minimized" | "closed";

/**
 * Exactly what you submitted, frozen: each decided item's id, your choice, and the item as it was
 * shown. A plan made from a submission points at its snapshot; later edits to the workspace never
 * change it.
 */
export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  at: string;
  title: string;
  choices: WorkspaceChoice[];
  decisions: Record<string, string>;
  items: WorkspaceItem[];
}

export type WorkspaceItemPlanStatus =
  "planned" | "running" | "done" | "skipped" | "failed" | "not-run";

/** A plan made from one of this workspace's submissions, with each item's result. */
export interface WorkspacePlanView {
  jobId: string;
  title: string;
  status: string;
  summary?: string;
  snapshotId: string;
  snapshotAt: string;
  createdAt: string;
  finishedAt?: string;
  /** Per item: what happened, in the plan's own words. */
  items: Record<string, { status: WorkspaceItemPlanStatus; result?: string; label: string }>;
  counts: Record<WorkspaceItemPlanStatus, number>;
  /** Only from steps that finished and were verified; absent when nothing was freed. */
  freedBytes?: number;
}

export interface WorkspaceView {
  id: string;
  conversationId?: string;
  kind: "temporary" | "saved";
  state: WorkspaceState;
  folder?: string;
  savedAt?: string;
  spec: WorkspaceSpec;
  selections: Record<string, string>;
  submission?: WorkspaceSubmission;
  /** Plans made from this workspace's submissions, newest first. */
  plans?: WorkspacePlanView[];
  /**
   * You changed choices after the newest plan still waiting or running was made: that plan
   * reflects the earlier snapshot, not these changes.
   */
  revised?: { jobId: string; snapshotAt: string; changed: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  id: string;
  title: string;
  conversationId?: string;
  kind: "temporary" | "saved";
  state: WorkspaceState;
  folder?: string;
  savedAt?: string;
  description?: string;
  items: number;
  decided: number;
  submittedAt?: string;
  createdAt: string;
  updatedAt: string;
}
