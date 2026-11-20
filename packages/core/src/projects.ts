import type { Health, IsoTime, Service } from "./domain";
import type { Job, JobStatus } from "./jobs";

/**
 * Projects (the command center): long-running work such as "Improve ErsatzTV",
 * built on the memory projects. A project can hold tasks, jobs, conversations,
 * notes (memory entries), and history; it is never just one job.
 */

export const PROJECT_PHASES = [
  "planned",
  "queued",
  "investigating",
  "in-progress",
  "awaiting-approval",
  "blocked",
  "completed",
  "failed",
  "paused",
] as const;
export type ProjectPhase = (typeof PROJECT_PHASES)[number];

export const PROJECT_PHASE_LABEL: Record<ProjectPhase, string> = {
  planned: "Planned",
  queued: "Queued",
  investigating: "Investigating",
  "in-progress": "In progress",
  "awaiting-approval": "Awaiting approval",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  paused: "Paused",
};

/** Icons a project can carry (names resolved by the web app). */
export const PROJECT_ICONS = [
  "folder",
  "film",
  "tv",
  "shield",
  "server",
  "network",
  "database",
  "box",
  "wrench",
  "home",
  "sparkles",
  "music",
  "book",
  "camera",
] as const;
export type ProjectIcon = (typeof PROJECT_ICONS)[number];

/**
 * A project's color, the main colors of the rainbow: its card on Home glows in it (a bright rim, a
 * translucent halo and a soft wash). A project without one keeps the plain card.
 */
export const PROJECT_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export function isProjectColor(c: unknown): c is ProjectColor {
  return typeof c === "string" && (PROJECT_COLORS as readonly string[]).includes(c);
}

export interface ProjectLinkInput {
  kind: "service" | "host";
  id: string;
}

export interface ProjectLink extends ProjectLinkInput {
  name: string;
  /** Current health when it is a watched service or machine. */
  health?: Health;
  lifecycle?: Service["lifecycle"];
  /** Its container was stopped on request: off on purpose, not down. */
  stopped?: boolean;
  /** The linked thing no longer exists (kept so history still reads). */
  missing?: boolean;
}

export const PROJECT_TASK_STATUSES = ["todo", "doing", "done", "blocked"] as const;
export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

export interface ProjectTask {
  id: string;
  title: string;
  status: ProjectTaskStatus;
  seq: number;
  createdAt: IsoTime;
  doneAt?: IsoTime;
}

export interface ProjectSummary {
  id: string;
  name: string;
  summary: string;
  /** The memory project's own state: active, paused, or done. */
  status: "active" | "paused" | "done";
  /** What it shows: your chosen phase, overridden by facts (a job waiting, paused, done). */
  phase: ProjectPhase;
  icon: ProjectIcon;
  /** Its color on Home; absent keeps the plain card. */
  color?: ProjectColor;
  systems: ProjectLink[];
  /** Task progress, when the project has tasks. */
  progress?: { done: number; total: number };
  /** Jobs in this project waiting for your approval. */
  awaitingApproval: number;
  runningJobs: number;
  openThreads: number;
  updatedAt: IsoTime;
}

export interface ProjectActivity {
  at: IsoTime;
  actor: "you" | "dragon-control" | "agent" | "ai" | "import";
  text: string;
  ref?: string;
}

export interface ProjectDetail extends ProjectSummary {
  createdAt: IsoTime;
  tasks: ProjectTask[];
  jobs: Pick<Job, "id" | "title" | "status" | "createdAt" | "summary" | "steps">[];
  notes: { id: string; kind: string; title: string; body: string; at: IsoTime; status?: string }[];
  conversations: { id: string; title: string; updatedAt: IsoTime }[];
  /** Events from the project and its systems: incidents, jobs, checks. Newest first. */
  logs: { at: IsoTime; tone: "good" | "neutral" | "attention"; text: string; ref?: string }[];
  /** Captured output only: job step results and what Hearth read. Never a live shell. */
  terminal: { at: IsoTime; source: string; lines: string[] }[];
  history: ProjectActivity[];
}

export const ACTIVE_JOB: readonly JobStatus[] = ["awaiting-approval", "running"];
