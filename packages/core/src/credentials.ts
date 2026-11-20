import type { IsoTime } from "./domain";

/**
 * The credential broker's view of the vault, per service. Never values:
 * whether a credential exists, whether it works, when it last worked, and
 * what may be done with it.
 */

/** What Hearth may do with a credential. Having one never skips an approval. */
export type CredentialScope = "read" | "approved-changes";

/**
 * Diagnostics only is enforced by Hearth, not by the app: the underlying key or login
 * may still be able to change things inside the app, so it is protected like any password.
 */
export const CREDENTIAL_SCOPE_NOTE =
  "Diagnostics only is a limit Hearth enforces on itself. The key or login itself may still allow changes inside the app, so it stays protected in the vault like any password.";

/** New credentials start here: Hearth may read, and make the changes you approve one by one. */
export const DEFAULT_CREDENTIAL_SCOPE: CredentialScope = "approved-changes";

export const CREDENTIAL_SCOPE_LABEL: Record<CredentialScope, string> = {
  read: "Diagnostics only (read)",
  "approved-changes": "Diagnostics, and changes you approve",
};

export type CredentialFailureKind =
  "rejected" | "unreachable" | "blocked" | "incompatible" | "internal";

export const CREDENTIAL_FAILURE_LABEL: Record<CredentialFailureKind, string> = {
  rejected: "The app rejected this credential",
  unreachable: "Could not reach the app",
  blocked: "The app is temporarily blocking Hearth",
  incompatible: "Hearth could not complete the sign-in (not the credential)",
  internal: "Hearth hit an internal error (not the credential)",
};

export type CredentialState =
  /** Nothing in the vault for this service. */
  | "missing"
  /** Present, but protected: it needs you to unlock it each time, so Hearth cannot use it on its own. */
  | "protected"
  /** Present, not used yet. */
  | "unused"
  /** Last use worked. */
  | "working"
  /** Last use failed (refused, unreachable). */
  | "failing";

export interface CredentialNeed {
  kind: "api-key" | "login";
  /** "API key", "Web UI login". */
  label: string;
  /** Where to find it in the app. */
  where: string;
  /** The page inside the app where the key is made or shown ("/settings/general"), if it has one. */
  keyPage?: string;
  /** A login app that also takes an API token (RomM): read only, when no login is saved. */
  tokenToo?: boolean;
}

export interface CredentialStatus {
  serviceId: string;
  serviceName: string;
  need: CredentialNeed;
  state: CredentialState;
  secret?: {
    id: string;
    name: string;
    scope: CredentialScope;
    source?: string;
    lastUsedAt?: IsoTime;
    lastOkAt?: IsoTime;
    lastFailureAt?: IsoTime;
    lastFailure?: string;
    /** Only "rejected" means the credential itself is wrong. */
    lastFailureKind?: CredentialFailureKind;
  };
  /** Places the credential already exists outside the vault, offered for an explicit import. */
  importSources: { id: string; description: string }[];
}
