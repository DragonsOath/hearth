import type { IsoTime } from "./domain";

/**
 * The homelab memory (decision D10): what the companion knows beyond the
 * live system. Kept in Hearth's own database, shared by Claude
 * Code, the app, and Belle. Secrets never enter it.
 */

export const MEMORY_KINDS = ["journal", "thread", "win", "preference", "hardware", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  journal: "Journal",
  thread: "Thread",
  win: "Win",
  preference: "How you work",
  hardware: "Hardware",
  note: "Note",
};

/**
 * How a fact is known. A note and the live system can disagree, so every
 * entry says which it is, and neither silently overwrites the other.
 */
export const MEMORY_BASES = ["observed", "documented", "stated", "unknown"] as const;
export type MemoryBasis = (typeof MEMORY_BASES)[number];

export const MEMORY_BASIS_LABELS: Record<MemoryBasis, string> = {
  observed: "Observed",
  documented: "Documented",
  stated: "You said",
  unknown: "Unverified",
};

/** Who wrote it. */
export const MEMORY_SOURCES = ["you", "ai", "dragon-control", "import"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** A pointer to evidence: "incident:<id>", "service:<id>", "file:<path>", "commit:<sha>", "url:https://...", "transcript:<id>#<seq>". */
export interface MemoryLink {
  label: string;
  ref: string;
}

/** A verified write-back: what was checked, what came back, and when. */
export interface MemoryVerification {
  at: IsoTime;
  check: string;
  result: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  projectId?: string;
  title: string;
  body: string;
  /** Threads only. */
  status?: "open" | "done";
  /** When it happened or became true (a date or a full time). */
  happenedAt: IsoTime;
  basis: MemoryBasis;
  /** The machine the fact is about, or where it was observed. */
  machine?: string;
  verification?: MemoryVerification;
  /**
   * Set when this is no longer how things are: kept as history, never shown
   * as current setup. `reason` says what replaced it.
   */
  superseded?: MemorySuperseded;
  source: MemorySource;
  /** More detail on the writer, e.g. "Claude Code on a laptop". */
  author?: string;
  links: MemoryLink[];
  createdAt: IsoTime;
  updatedAt: IsoTime;
  deletedAt?: IsoTime;
}

export interface MemorySuperseded {
  at: IsoTime;
  reason: string;
}

export interface MemoryRevision {
  id: number;
  at: IsoTime;
  action: "created" | "edited" | "deleted" | "restored";
  by: MemorySource;
  author?: string;
  /** The entry as it was before this change (as created, for "created"). */
  snapshot: Omit<MemoryEntry, "id">;
}

export interface MemoryProject {
  id: string;
  name: string;
  summary: string;
  status: "active" | "paused" | "done";
  createdAt: IsoTime;
  updatedAt: IsoTime;
  entries: number;
  openThreads: number;
}

export const TRANSCRIPT_ROLES = ["you", "ai", "tool", "note"] as const;
export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

/** A whole conversation, kept word for word so the reasoning behind decisions survives. */
export interface Transcript {
  id: string;
  /** Where it happened: "claude-code", "app", "voice", ... */
  client: string;
  title: string;
  machine?: string;
  /** The client's own id for the session, so saving it twice never duplicates it. */
  sessionRef?: string;
  projectId?: string;
  startedAt: IsoTime;
  endedAt?: IsoTime;
  messageCount: number;
}

export interface TranscriptMessage {
  seq: number;
  role: TranscriptRole;
  text: string;
  at: IsoTime;
}

export interface MemorySearchHit {
  /** entry: a memory; transcript: a saved session; conversation: a chat in the app or with Belle. */
  type: "entry" | "transcript" | "conversation";
  id: string;
  /** Message number inside a transcript or conversation. */
  seq?: number;
  title: string;
  /** Matching text with matches wrapped in [[ and ]]. */
  snippet: string;
  at: IsoTime;
  kind?: MemoryKind;
}

export interface BackupRecord {
  id: number;
  at: IsoTime;
  reason: "scheduled" | "manual" | "startup";
  ok: boolean;
  file?: string;
  bytes?: number;
  durationMs: number;
  detail: string;
  /** Whether the second copy succeeded (absent when no second location is set). */
  copied?: boolean;
}

/** Encrypted copies another machine fetches (Home Vault pulls them; the home server never pushes). */
export interface OffsiteStatus {
  /** The machine that fetches them, e.g. "Home Vault". */
  name: string;
  /** Encrypted backups waiting to be fetched, oldest first. */
  pending: { name: string; bytes: number; at: IsoTime }[];
  /** The newest copy the other machine confirmed, checked against this machine's fingerprint. */
  lastVerified?: { file: string; receivedAt: IsoTime; destination: string; checkedAt: IsoTime };
  lastError?: { at: IsoTime; detail: string };
  /** No verified off-machine copy for longer than the warning threshold. */
  stale: boolean;
}

export interface BackupStatus {
  dir: string;
  copyDir?: string;
  exportDir: string;
  keep: number;
  /** Backups currently on disk, newest first. */
  files: { name: string; bytes: number; at: IsoTime }[];
  lastOk?: BackupRecord;
  recent: BackupRecord[];
  /** The key that opens background secrets is kept apart on purpose and is not in these files. */
  keyDir: string;
  offsite?: OffsiteStatus;
}

/**
 * One point of the "what's up" a companion opens with, built from facts
 * Hearth holds. In order: needs you, since you were last here,
 * wins, in progress, and at most one idea.
 */
export interface OpeningPoint {
  kind: "needs-you" | "since" | "win" | "in-progress" | "idea";
  text: string;
  /** What it is about: "incident:<id>" or "memory:<id>". */
  ref?: string;
}

/** Everything the companion reads before it answers. Live as of `asOf`. */
export interface CompanionBriefing {
  asOf: IsoTime;
  installation: string;
  /** How to refer to the owner; absent means "you". */
  ownerName?: string;
  /** True while Hearth shows sample data instead of your systems. */
  sampleData: boolean;
  needsYou: { id: string; title: string; status: string; severity: string; openedAt: IsoTime }[];
  system: {
    servicesTotal: number;
    notHealthy: { name: string; health: string; host: string }[];
    hosts: { name: string; os: string; connection: string; health: string }[];
    openIncidents: number;
  };
  /** Names worth recognising in prompts: machines, projects, and services. */
  vocabulary: string[];
  /** What to open with, in order; empty when there is nothing worth saying. */
  opening: OpeningPoint[];
  backups: {
    lastOkAt?: IsoTime;
    lastFailed?: { at: IsoTime; detail: string };
    offsite?: { name: string; lastVerifiedAt?: IsoTime; waiting: number; stale: boolean };
  };
  /** When this client last looked; entries created after it are new to it. */
  since: IsoTime;
  /** Journal entries and wins from the last week at least (or since `since`, if earlier). */
  recent: MemoryEntry[];
  openThreads: MemoryEntry[];
  projects: MemoryProject[];
  howYouWork: MemoryEntry[];
  hardware: MemoryEntry[];
  recentSessions: Pick<
    Transcript,
    "id" | "title" | "client" | "machine" | "startedAt" | "messageCount"
  >[];
  counts: { memories: number; transcripts: number };
}

/** What an importer proposes for one piece of a source (a section, a list item, a session). */
export type ImportPayload =
  | {
      kind: "entry";
      entry: {
        kind: MemoryKind;
        title: string;
        body?: string;
        projectName?: string;
        status?: "open" | "done";
        happenedAt?: IsoTime;
        basis?: MemoryBasis;
        machine?: string;
        /** Who originally wrote it, e.g. "Codex" or "Claude Code". */
        author?: string;
        /** Extra links kept on the entry, e.g. marking a conversation-style preference. */
        links?: MemoryLink[];
      };
    }
  | {
      kind: "project";
      project: { name: string; summary?: string; status?: MemoryProject["status"] };
    }
  | {
      kind: "session";
      session: {
        client: string;
        title: string;
        machine?: string;
        sessionRef: string;
        startedAt?: IsoTime;
        messages: { seq: number; role: TranscriptRole; text: string; at?: IsoTime }[];
      };
    };

export interface ImportDraftInput {
  sourceRef: string;
  /** The file or session it came from. */
  origin: string;
  /** Where in it: a heading, a list, "whole file", "session". */
  anchor: string;
  payload: ImportPayload;
  note?: string;
}

export interface ImportDraft {
  id: string;
  sourceRef: string;
  batch: string;
  origin: string;
  anchor: string;
  /** For sessions, messages are left out of lists; `messageCount` and `preview` stand in. */
  payload: ImportPayload;
  note: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: IsoTime;
  updatedAt: IsoTime;
  decidedAt?: IsoTime;
  resultId?: string;
  messageCount?: number;
  /** Waiting drafts only: how sure Hearth is, and why. */
  triage?: ImportTriage;
}

/**
 * Sorting for review. "confident": dated history, or records that agree with
 * what Hearth sees. "review": worth a look (current-sounding claims,
 * conflicts, undated or unverifiable items). "skip": probably not wanted
 * (duplicates, not about the homelab).
 */
export type ImportTier = "confident" | "review" | "skip";

export interface ImportReason {
  kind: "history" | "verified" | "conflict" | "unverified" | "duplicate" | "unrelated" | "check";
  text: string;
}

export interface ImportTriage {
  tier: ImportTier;
  reasons: ImportReason[];
  /** Another draft (or existing memory) with the same content. */
  duplicateOf?: { type: "draft" | "entry" | "transcript"; id: string; title: string };
  /**
   * Accepting saves it as history, not current setup, unless you say
   * otherwise: older notes that conflict with what Hearth sees now.
   */
  supersede?: string;
}

export interface ImportSummary {
  pending: number;
  accepted: number;
  rejected: number;
  batches: { batch: string; pending: number; total: number }[];
}

/**
 * How long a remembered fact about the setup stays trustworthy without being checked again.
 * Journal entries and wins are history (they say what happened, which stays true); threads are
 * open work. Setup facts drift: a microphone gets moved, a container gets replaced.
 */
export const STALE_AFTER_DAYS: Partial<Record<MemoryKind, number>> = {
  note: 30,
  hardware: 60,
  preference: 180,
};

export interface MemoryFreshness {
  /** When it was last known to be true: the later of when it happened and its last check. */
  checkedAt: IsoTime;
  ageDays: number;
  /** Past its kind's limit: verify before relying on it. */
  stale: boolean;
  /** History and open work never go stale. */
  ages: boolean;
}

export function memoryFreshness(
  e: Pick<MemoryEntry, "kind" | "happenedAt" | "verification">,
  now: Date,
): MemoryFreshness {
  const happened = Date.parse(e.happenedAt);
  const checked = e.verification ? Date.parse(e.verification.at) : NaN;
  const at = Number.isNaN(checked) || checked < happened ? happened : checked;
  const ageDays = Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
  const limit = STALE_AFTER_DAYS[e.kind];
  return {
    checkedAt: new Date(at).toISOString(),
    ageDays,
    stale: limit !== undefined && ageDays > limit,
    ages: limit !== undefined,
  };
}

/** "checked today", "checked 3 days ago", "checked 40 days ago, may be out of date". */
export function freshnessText(f: MemoryFreshness): string {
  const age = f.ageDays === 0 ? "today" : f.ageDays === 1 ? "yesterday" : `${f.ageDays} days ago`;
  return f.stale ? `last checked ${age}, may be out of date` : `last checked ${age}`;
}
