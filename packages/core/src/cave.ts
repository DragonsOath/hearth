import type { IsoTime } from "./domain";

/**
 * Ember: the AI companion inside Hearth. It answers from
 * Hearth's records and live state, inside a jurisdiction the owner
 * defines, within a budget the owner sets.
 */

/** What a jurisdiction entry names. */
export const JURISDICTION_KINDS = [
  "machine",
  "service",
  "repository",
  "path",
  "domain",
  "topic",
] as const;
export type JurisdictionKind = (typeof JURISDICTION_KINDS)[number];

export const JURISDICTION_KIND_LABELS: Record<JurisdictionKind, string> = {
  machine: "Machine",
  service: "Service",
  repository: "Repository",
  path: "Folder",
  domain: "Domain",
  topic: "Project or topic",
};

/**
 * One line of the jurisdiction: something Ember looks after ("in"),
 * or something it must not take on even if it sits on a homelab machine
 * ("out"). Everything Hearth watches is in scope without an entry.
 */
export interface JurisdictionEntry {
  id: string;
  kind: JurisdictionKind;
  /** How it is referred to: "ai-box", "Gig Tracker". */
  name: string;
  /** Optional precise value: an address, a path, a repository location, a domain. */
  value?: string;
  access: "in" | "out";
  /** Limits or reasons in plain words: "only Sunshine and the transcode folder". */
  note?: string;
  createdAt: IsoTime;
}

/** Where a claim in an answer comes from. */
/** What the owner has open in the command center, sent with a message so "this" is unambiguous. */
export interface CaveFocus {
  kind: "service" | "project" | "todo";
  id: string;
  /**
   * Something selected inside the service (a torrent...). Only its identity
   * travels from the browser: the server checks it belongs to the service and
   * reads it fresh before the AI sees it; nothing shown on screen is trusted.
   */
  item?: CaveItem;
}

export interface CaveItem {
  kind: "torrent" | "plex-session";
  id: string;
}

export interface CaveEvidenceCard {
  kind: "web" | "app";
  /** The web address, or "Radarr (test) API /api/v3/qualityprofile". */
  source: string;
  title?: string;
  /** A short excerpt of what was read (web pages only; never an app's raw answer). */
  excerpt?: string;
  at: IsoTime;
}

export interface CaveEvidence {
  /** Cited in the answer as [E1], [E2]... */
  id: string;
  label: string;
  /** "service:<id>", "incident:<id>", "memory:<id>", "host:<id>", "backups", "audit". */
  ref?: string;
  /** live: checked just now or by monitoring's latest pass; record: Hearth's log; memory: remembered. */
  /** live: checked just now; record: Hearth's records; memory: approved memory;
   * unreviewed: a note waiting in Memory > Review, never approved (a lead, not a fact). */
  kind: "live" | "record" | "memory" | "unreviewed";
  at?: IsoTime;
}

/** How an answer was produced, so the app can say so plainly. */
/** The AI administrator system's own name (the platform is Hearth). */
export const AI_PLATFORM_NAME = "Ember";

/**
 * What the AI administrator is called until you type a name, whichever voice or look is in use.
 * The system itself keeps its own name, Ember (AI_PLATFORM_NAME).
 */
export const DEFAULT_AI_NAME = "Ember";

/** What the AI administrator is called: the name you gave it, or Ember. */
export function aiDisplayName(name?: string | null): string {
  const n = name?.trim();
  return n ? n : DEFAULT_AI_NAME;
}

/** Letters (any language), digits, spaces, and ' . - only; up to 40 characters. */
export const AI_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} '’.-]{0,39}$/u;

export interface CaveAnswerMeta {
  /**
   * ai: the AI answered from the gathered context and its tools. records:
   * Hearth answered from its records alone (no AI connected, budget
   * reached). refusal: outside the jurisdiction. status: the AI could not finish (or a plan
   * ended), so Hearth states where things stand from its own records (jobs) instead. remote:
   * said in a Remote Control session (/rc), live with the Claude app.
   */
  mode: "ai" | "records" | "refusal" | "status" | "remote";
  /** Hearth's instruction to the AI, never shown in the chat (an automatic follow-up). */
  instruction?: boolean;
  /** A page the answer points to, shown as a button (Anthropic's sign-in for /login). */
  link?: { label: string; url: string };
  /** Why records were used instead of the AI, or why it was declined. */
  reason?: string;
  /** The AI's failure, when there was one. */
  error?: string;
  costUsd?: number;
  tokens?: number;
  model?: string;
  /** Why the AI run ended without an answer: kept so the reason is known, not guessed. */
  failure?: {
    stopReason?: string;
    error?: string;
    exitCode?: number | null;
    signal?: string | null;
    costUsd?: number;
    tokens?: number;
    turns?: number;
    durationMs?: number;
    attempts: number;
  };
}

/**
 * One real step taken while answering a message: gathering facts, asking the
 * AI, a tool the AI used, or a plan it proposed (ref "job:<id>").
 */
export interface CaveActivity {
  id: number;
  /** show: Ember pointed at something on screen (Show & Tell); the label is its caption. */
  kind: "gather" | "ai" | "tool" | "job" | "records" | "show";
  /**
   * Evidence card (checklist 45.12, phase B): where what Ember read came from, taken from the
   * tool's own result on the server (never written by the AI): a web page's address and a short
   * excerpt, or the app and API path it read.
   */
  evidence?: CaveEvidenceCard;
  label: string;
  status: "running" | "done" | "failed" | "waiting" | "stopped";
  detail?: string;
  ref?: string;
  at: IsoTime;
  finishedAt?: IsoTime;
  /** For a show step: where, and whether the screen confirmed it (so it can be shown again). */
  show?: {
    place: import("./show").ShowPlace;
    target?: string;
    onScreen?: boolean;
    action?: import("./show").ShowAction;
  };
}

/**
 * What a capture shows, recorded when it was taken (feature request 19.7): which panel, item, or
 * region, the metric names visible in it, and how many sensitive elements were blanked.
 */
export interface CaptureContext {
  /** upload: a photo you attached with the paperclip. */
  /** screen: the whole Hearth screen as it looked (the camera in the top bar, 11-17). */
  mode: "panel" | "item" | "region" | "upload" | "screen";
  /** For an upload: the file's name. */
  fileName?: string;
  serviceId?: string;
  serviceName?: string;
  /** The panel's title (a service, project, or workspace). */
  panel?: string;
  tab?: string;
  item?: string;
  metrics?: string[];
  capturedAt: IsoTime;
  /** Sensitive elements (passwords, keys, tokens) left out of the image. */
  redacted: number;
  region?: { x: number; y: number; width: number; height: number };
}

/** An image you attached to a message: kept on your Hearth; the AI sees it only with that message. */
export interface CaveAttachment {
  id: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  context: CaptureContext;
  createdAt: IsoTime;
}

/** Limits for attached images (explicit storage limits, feature request 19). */
export const ATTACHMENT_LIMITS = {
  /** Largest single image. */
  maxBytes: 5 * 1024 * 1024,
  /** Images per message. */
  perMessage: 4,
  /** All stored images together; new ones are refused beyond this. */
  totalBytes: 500 * 1024 * 1024,
  /** Captures never sent are cleared after this many hours. */
  unsentHours: 24,
} as const;

export interface CaveMessage {
  role: "you" | "agent" | "note";
  text: string;
  at: IsoTime;
  /** Images you attached to this message. */
  attachments?: CaveAttachment[];
  evidence?: CaveEvidence[];
  meta?: CaveAnswerMeta;
  /** On your messages: what was done to answer it, as it happened. */
  activity?: CaveActivity[];
  /**
   * Hearth's own instruction to the AI (an automatic follow-up after a plan ends, say): kept for
   * the AI's history and to carry the turn's progress and plans, but its words are never shown.
   */
  hidden?: boolean;
}

/** One AI run, for usage reporting. */
export interface AiRunRecord {
  at: IsoTime;
  kind: "question" | "incident";
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  /** Input re-read from the prompt cache (much cheaper than fresh input). */
  cachedTokens: number;
  costUsd?: number;
  turns?: number;
  durationMs: number;
  outcome: "answered" | "failed" | "stopped-at-limit";
}

/**
 * The Claude models Hearth offers, as Claude Code's own short names: each always means the newest
 * version of that model, so the list doesn't go stale. "default" leaves it to Claude Code.
 */
export const CLAUDE_MODELS = [
  { value: "default", short: "Default", label: "Your Claude Code's own model (recommended)" },
  { value: "fable", short: "Fable", label: "Fable (newest and most capable)" },
  { value: "opus", short: "Opus", label: "Opus (very capable, high cost)" },
  { value: "sonnet", short: "Sonnet", label: "Sonnet (balanced, lower cost)" },
  { value: "haiku", short: "Haiku", label: "Haiku (fastest, lowest cost)" },
] as const;

export interface AiBudget {
  /**
   * Daily limits; unset means no limit. Days follow the server's local time. The one shown is
   * dailyRuns (Flint, 2026-11-13: no money in Hearth, it never charges for AI); dailyUsd and
   * dailyTokens are older ones, still honoured if set, cleared when a run limit is saved.
   */
  dailyRuns?: number;
  /**
   * Show an estimated cost, for an AI signed in to a per-use account only (Claude Code with an
   * Anthropic Console account). Off by default, labelled "billed by Anthropic, not Hearth".
   */
  showEstimate?: boolean;
  dailyUsd?: number;
  dailyTokens?: number;
  /** Most one run may spend. */
  perRunUsd: number;
  /** Warn when this share of a daily limit is used. */
  warnAt: number;
  /** Models: "default" leaves it to the agent. */
  questionModel: string;
  incidentModel: string;
}

export interface AiUsageReport {
  budget: AiBudget;
  today: { costUsd: number; tokens: number; runs: number; questions: number; incidents: number };
  /** Share of the tightest daily limit used today, 0..1 (absent without limits). */
  usedShare?: number;
  /** "ok", "warning" (past warnAt), or "reached" (no AI until tomorrow). */
  state: "ok" | "warning" | "reached";
  days: { day: string; costUsd: number; tokens: number; runs: number }[];
  recent: AiRunRecord[];
  /** The last 7 days (today included). */
  week: { runs: number; questions: number };
  /** Each AI that ran in the last 7 days: what it did today and this week. */
  providers: { id: string; today: number; week: number }[];
  /** A plain read of today's use, by runs: up to 15 light, up to 60 normal, then heavy. */
  level: "light" | "normal" | "heavy";
}

/** Today's use as a level (runs today). */
export function aiUseLevel(runsToday: number): "light" | "normal" | "heavy" {
  return runsToday <= 15 ? "light" : runsToday <= 60 ? "normal" : "heavy";
}

/** How Ember talks. Safety rules do not depend on it. */
export interface CavePersonality {
  enthusiasm: "calm" | "warm" | "lively";
  humor: "none" | "light" | "playful";
  detail: "simple" | "balanced" | "deep";
}

export const DEFAULT_PERSONALITY: CavePersonality = {
  enthusiasm: "warm",
  humor: "light",
  detail: "balanced",
};

/** What a message is: read on the server, it shapes the answer and which tools may plan or act. */
/**
 * What a message is, read on the server from the owner's words. "look": the owner said to look
 * only ("don't change anything"); nothing is planned or changed for that task (enforced).
 */
export type CaveIntent = "chat" | "brainstorm" | "build" | "fix" | "question" | "affirm" | "look";
