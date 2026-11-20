/**
 * Findings: everything Hearth (or Ember) has noticed about the homelab that is worth the
 * owner's attention, in one place. A finding is a condition, not an event: it is opened when
 * an analyzer (or Ember) sees it, updated as new evidence arrives, and resolved only when a
 * recheck shows the condition is gone. Resolved findings are kept as history.
 */

/**
 * How sure Hearth is, and what kind of thing it is:
 * - problem: confirmed (the app says so, or Hearth saw it repeatedly).
 * - suspected: evidence points to a problem but it is not certain (a projection, one sighting).
 * - observation: worth knowing, nothing is wrong.
 * - recommendation: an improvement or a gap the owner may want to close.
 */
export const FINDING_KINDS = ["problem", "suspected", "observation", "recommendation"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/**
 * What kind of trouble it is, separate from how sure Hearth is (kind) and how bad (severity):
 * - failure: something is not working.
 * - degraded: working, but not well (slow, intermittent, partly failing).
 * - risk: working now, but set up in a way that can fail or expose something (a setting, space).
 * - maintenance: upkeep (updates, leftovers, duplicates).
 * - visibility: Hearth cannot see something, so it cannot vouch for it.
 * - state: an unusual state that may well be intentional (stopped, paused).
 */
export const FINDING_NATURES = [
  "failure",
  "degraded",
  "risk",
  "maintenance",
  "visibility",
  "state",
] as const;
export type FindingNature = (typeof FINDING_NATURES)[number];

export const FINDING_NATURE_LABEL: Record<FindingNature, string> = {
  failure: "Not working",
  degraded: "Not working well",
  risk: "Configuration risk",
  maintenance: "Upkeep",
  visibility: "Hearth cannot see",
  state: "May be intentional",
};

/**
 * How it has behaved over time, from its history:
 * - new: first seen within the last hour.
 * - ongoing: has lasted longer than that.
 * - recurring: went away and came back.
 * - returned-after-repair: came back after a repair was done for it, so the fix did not hold.
 */
export type FindingPattern = "new" | "ongoing" | "recurring" | "returned-after-repair";

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * candidate: seen, but not yet as often as its analyzer requires before showing it (never shown).
 * open, acknowledged (the owner has seen it), investigating (Ember is on it), planned (a plan
 * is linked), resolved (a recheck shows it is gone), dismissed (the owner chose to ignore it
 * while it lasts), accepted (the owner accepted the condition as it is: it stays accepted while
 * it, or a return of it, looks the same, and is raised again when it changes).
 */
export const FINDING_STATUSES = [
  "candidate",
  "open",
  "acknowledged",
  "investigating",
  "planned",
  "resolved",
  "dismissed",
  "accepted",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const FINDING_ACTIVE: readonly FindingStatus[] = [
  "open",
  "acknowledged",
  "investigating",
  "planned",
];

export const FINDING_SOURCES = [
  "monitor",
  "app",
  "docker",
  "storage",
  "host",
  "backup",
  "logs",
  "security",
  "ember",
] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

export interface FindingEvidence {
  label: string;
  value: string;
  /** When this was observed. */
  at?: string;
}

export interface FindingResource {
  kind: "service" | "host" | "volume" | "container" | "disk" | "path" | "item";
  name: string;
  id?: string;
}

export interface Finding {
  id: string;
  /** Short number shown to people ("F-12"). */
  number: number;
  /** What it is about, so the same condition is one finding ("docker:exited:plex"). */
  key: string;
  source: FindingSource;
  /** The analyzer that rechecks it ("docker.exited"), or "ember". */
  analyzer: string;
  kind: FindingKind;
  severity: FindingSeverity;
  nature: FindingNature;
  status: FindingStatus;
  /** How it has behaved over time. */
  pattern: FindingPattern;
  title: string;
  /** What Hearth saw, in plain words. */
  summary: string;
  /** Why it matters to the owner. */
  why: string;
  nextSteps: string[];
  evidence: FindingEvidence[];
  resources: FindingResource[];
  serviceId?: string;
  hostId?: string;
  incidentId?: string;
  jobId?: string;
  todoId?: string;
  conversationId?: string;
  createdBy: "hearth" | "ember";
  firstSeenAt: string;
  lastSeenAt: string;
  /** When its analyzer last looked (it may not have seen it: then it would be resolved). */
  checkedAt: string;
  resolvedAt?: string;
  resolution?: string;
  /** Times it came back after being resolved. */
  occurrences: number;
  snoozedUntil?: string;
  /** Why the owner accepted it, when they did. */
  acceptedNote?: string;
  /** Higher first. See findingPriority. */
  priority: number;
  /** A plan makes sense: problems and suspected problems, never observations. */
  plannable: boolean;
}

export type FindingEventKind =
  | "opened"
  | "evidence"
  | "escalated"
  | "eased"
  | "confirmed"
  | "acknowledged"
  | "snoozed"
  | "investigating"
  | "planned"
  | "plan-result"
  | "resolved"
  | "reopened"
  | "dismissed"
  | "accepted"
  | "changed"
  | "note";

export interface FindingEvent {
  at: string;
  kind: FindingEventKind;
  actor: "hearth" | "ember" | "you";
  text: string;
}

export interface FindingDetail extends Finding {
  events: FindingEvent[];
}

/** What one analyzer could see the last time it ran: honest about gaps. */
export interface AnalyzerCoverage {
  id: string;
  label: string;
  status: "ok" | "partial" | "unavailable" | "off";
  note?: string;
  checkedAt?: string;
}

export const FINDING_KIND_LABEL: Record<FindingKind, string> = {
  problem: "Confirmed problem",
  suspected: "Suspected problem",
  observation: "Observation",
  recommendation: "Recommendation",
};

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  candidate: "Not confirmed yet",
  open: "Open",
  acknowledged: "Seen",
  investigating: "Ember is investigating",
  planned: "Plan proposed",
  resolved: "Resolved",
  dismissed: "Dismissed",
  accepted: "Accepted by you",
};

export const FINDING_PATTERN_LABEL: Record<FindingPattern, string> = {
  new: "New",
  ongoing: "Ongoing",
  recurring: "Keeps coming back",
  "returned-after-repair": "Came back after a repair",
};

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 100,
  high: 70,
  medium: 40,
  low: 20,
  info: 5,
};
const KIND_WEIGHT: Record<FindingKind, number> = {
  problem: 1,
  suspected: 0.8,
  recommendation: 0.5,
  observation: 0.3,
};

/**
 * Order of importance: how bad, how sure, and whether the owner already saw it. A plan waiting
 * for the owner's approval comes first among equals, since nothing moves until they decide.
 */
export function findingPriority(
  f: Pick<Finding, "severity" | "kind" | "status"> & {
    awaitingApproval?: boolean;
    pattern?: FindingPattern;
  },
): number {
  let p = SEVERITY_WEIGHT[f.severity] * KIND_WEIGHT[f.kind];
  if (f.status === "acknowledged") p *= 0.7;
  if (f.awaitingApproval) p += 15;
  // A fix that did not hold, or something that keeps coming back, matters more than its
  // severity alone says: the cause is still there.
  if (f.pattern === "returned-after-repair") p += 12;
  else if (f.pattern === "recurring") p += 5;
  return Math.round(p);
}

/** Needs the owner's attention (the top of the dashboard), rather than worth knowing. */
export function needsAttention(f: Pick<Finding, "kind" | "severity" | "status">): boolean {
  if (!FINDING_ACTIVE.includes(f.status)) return false;
  if (f.kind === "problem" || f.kind === "suspected")
    return f.severity !== "info" && f.severity !== "low";
  return f.severity === "critical" || f.severity === "high";
}

/** What changed since the owner last looked (dashboard "What's changed"). */
export interface ChangeItem {
  at: string;
  tone: "good" | "neutral" | "attention";
  text: string;
  /** Where it leads: "finding:<id>", "incident:<id>", "job:<id>", "service:<id>". */
  ref?: string;
}

/** Something working as it should, from real data only. */
export interface WorkingItem {
  text: string;
  ref?: string;
}

/** What Ember is investigating or handling right now. */
export interface EmberActivityItem {
  text: string;
  status: "investigating" | "awaiting-approval" | "running" | "verifying";
  ref: string;
}

/** Trends worth a glance, computed from history Hearth keeps. */
export interface TrendItem {
  label: string;
  text: string;
  tone: "good" | "neutral" | "attention";
}

/** Everything the dashboard needs to answer: what needs me, why, what changed, what works. */
export interface DashboardBriefing {
  generatedAt: string;
  attention: Finding[];
  attentionTotal: number;
  /** Recommendations and observations, most useful first. */
  worthKnowing: Finding[];
  worthKnowingTotal: number;
  changes: ChangeItem[];
  working: WorkingItem[];
  ember: EmberActivityItem[];
  trends: TrendItem[];
  coverage: AnalyzerCoverage[];
}
