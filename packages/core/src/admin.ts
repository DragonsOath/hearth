/**
 * Administering a host (feature request 21, checklist 22; docs/design/HOST_ADMINISTRATION.md).
 *
 * You switch "Administer this host" on per machine. Inside that scope Ember investigates
 * on its own (read only, secrets masked, limited, audited) and proposes consequential changes as
 * plans you approve. Protected systems can be read for diagnosis but not changed through the
 * ordinary path; secret content is never returned to the AI at all.
 */

/** investigate: read only, automatic. propose: plans for consequential changes (still approved by you). */
export type HostOperation = "investigate" | "propose";

export interface HostScope {
  id: string;
  hostId: string;
  hostName?: string;
  operations: HostOperation[];
  note?: string;
  createdAt: string;
  revokedAt?: string;
}

/**
 * ordinary: read and change through plans. protected: read for diagnosis; a change needs its own
 * separate approval. secret: metadata only, the content is never returned to the AI.
 */
export type PathClass = "ordinary" | "protected" | "secret";

/** The five tiers (design section 4). */
export type OperationTier = "investigate" | "routine" | "consequential" | "protected" | "never";

export interface HostEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "link" | "other";
  sizeBytes: number;
  modifiedAt: string;
  owner: string;
  group: string;
  mode: string;
  class: PathClass;
  /** Why it is protected or secret, in plain words. */
  why?: string;
}

export const HOST_LIMITS = {
  /** Largest page of a file returned in one read. */
  readBytes: 256 * 1024,
  /** Most entries in one folder listing. */
  listEntries: 500,
  /** Most results of one name search. */
  searchResults: 200,
  /** Longest a search, disk-usage, or diagnostic command may run. */
  timeoutMs: 20_000,
} as const;

export const CONFIG_LIMITS = {
  /** Largest file Hearth edits. */
  maxBytes: 256 * 1024,
  /** Most find/replace edits in one plan step. */
  maxEdits: 20,
} as const;

/** One exact edit: `find` must appear exactly once in the file as it is now. */
export interface ConfigEdit {
  find: string;
  replace: string;
}

/**
 * Why Ember is blocked, precisely, so it can say so and ask for the right thing:
 * a tool that does not exist yet, a permission you have not given (or the operating system
 * refuses), a credential that is missing, something not supported, a protected system that
 * needs your separate approval, secret content, or a failure that may pass.
 */
export type GapKind =
  | "missing-capability"
  | "missing-permission"
  | "missing-credential"
  | "unsupported"
  | "protected"
  | "secret"
  | "out-of-scope"
  | "temporary";

export const GAP_LABEL: Record<GapKind, string> = {
  "missing-capability": "Missing capability",
  "missing-permission": "Needs permission",
  "missing-credential": "Needs a credential",
  unsupported: "Not supported",
  protected: "Protected system",
  secret: "Secret content",
  "out-of-scope": "Outside the authorized scope",
  temporary: "Temporary failure",
};

/** Tools and capabilities (checklist 22.14 to 22.18): one registry for every kind. */
export type CapabilityKind =
  "builtin" | "utility" | "package" | "container-tool" | "skill" | "integration" | "script";

export type CapabilityStatus =
  "available" | "missing" | "requested" | "installed" | "disabled" | "removed";

export interface Capability {
  id: string;
  hostId?: string;
  hostName?: string;
  kind: CapabilityKind;
  name: string;
  status: CapabilityStatus;
  version?: string;
  /** Where it comes from (distribution package, upstream release, built in). */
  source?: string;
  /** Where it is (a path on the host, or "container:<name>:<path>"). */
  location?: string;
  purpose?: string;
  /** For something missing: why the Ember could not go on. */
  gap?: GapKind;
  /** What it was trying to do when it found the gap (the task to resume). */
  task?: string;
  conversationId?: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
}
