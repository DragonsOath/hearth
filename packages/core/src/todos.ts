import type { IsoTime } from "./domain";
import type { JobStatus } from "./jobs";

/**
 * Issues & ideas: the owner's to-do list, kept with Ember. Problems
 * to solve, work to do, and things worth building some day, tied to the
 * systems, projects, conversations, and plans they concern.
 *
 * Ember can notice things while it works, but what it notices is
 * only a suggestion until the owner asks for it to be saved. Saving an item
 * never authorizes doing anything about it.
 */

export const TODO_CATEGORIES = ["issue", "task", "idea"] as const;
export type TodoCategory = (typeof TODO_CATEGORIES)[number];
export const TODO_CATEGORY_LABEL: Record<TodoCategory, string> = {
  issue: "Issue",
  task: "Task",
  idea: "Idea",
};

export const TODO_PRIORITIES = ["high", "medium", "low"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];
export const TODO_PRIORITY_LABEL: Record<TodoPriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** "suggested": noticed by Ember, not on the list until the owner says so. */
export const TODO_STATUSES = [
  "suggested",
  "open",
  "investigating",
  "waiting-approval",
  "deferred",
  "resolved",
  "dismissed",
] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  suggested: "Suggested",
  open: "Open",
  investigating: "Investigating",
  "waiting-approval": "Waiting for approval",
  deferred: "Deferred",
  resolved: "Resolved",
  dismissed: "Dismissed",
};
/** Still to deal with. */
export const TODO_ACTIVE: readonly TodoStatus[] = ["open", "investigating", "waiting-approval"];

export interface TodoEvidence {
  label: string;
  /** "service:<id>", "incident:<id>", "job:<id>", "memory:<id>", ... */
  ref?: string;
  kind: "live" | "record" | "memory" | "unreviewed";
  at?: IsoTime;
}

/**
 * Whether an issue still seems to be happening, from what Hearth can
 * see now. Never used to resolve anything by itself.
 */
export interface TodoCheck {
  state: "active" | "looks-resolved" | "unverified";
  detail: string;
  at?: IsoTime;
}

export interface TodoEvent {
  at: IsoTime;
  actor: "you" | "agent" | "dragon-control";
  kind: "created" | "saved" | "status" | "edited" | "linked" | "note";
  text: string;
  from?: TodoStatus;
  to?: TodoStatus;
  conversationId?: string;
}

export interface TodoItem {
  id: string;
  /** Short, stable number for conversation and the list: #12. */
  number: number;
  category: TodoCategory;
  title: string;
  description: string;
  priority: TodoPriority;
  status: TodoStatus;
  /** Affected services (ids). */
  services: string[];
  projectId?: string;
  evidence: TodoEvidence[];
  nextAction?: string;
  /** Where it came up. */
  conversationId?: string;
  /** Plans made for it, with their current status. */
  jobs: { id: string; title: string; status: JobStatus }[];
  source: "you" | "agent";
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** When it went onto the list (absent while only suggested). */
  savedAt?: IsoTime;
  resolvedAt?: IsoTime;
  /** Issues only: what Hearth sees now. */
  check?: TodoCheck;
}

export interface TodoDetail extends TodoItem {
  history: TodoEvent[];
}
