import type { HostOperation } from "./admin";

/**
 * A known, actionable reason something cannot be shown or done yet, carried with the error or
 * panel data so the panel can offer the fix right where the owner is (docs/design/BLOCKERS.md),
 * instead of sending them to another page. A blocker only describes the gap: resolving it always
 * goes through the same owner controls and approvals as anywhere else, never around them.
 */
export type BlockerKind =
  /** Host administration is off (or allows less than this needs). Host-wide, not per app. */
  | "host-admin"
  /** The app's key is not in Secure Vault yet. */
  | "app-key"
  /** Hearth's own account cannot read or write a file this needs. */
  | "file-access"
  /** The configuration this needs is not where Hearth can find it. */
  | "missing-config"
  /** A Hearth capability this needs is not set up (the elevated executor, say). */
  | "capability"
  /** The service itself is not running or not answering. */
  | "service-down";

export interface Blocker {
  kind: BlockerKind;
  /** One plain sentence: what is missing. */
  title: string;
  /** What fixing it allows, and how wide it reaches (this app, or the whole machine). */
  detail: string;
  /** host-admin: the machine, and the operations this needs (investigate, or investigate and propose). */
  host?: { id: string; name: string };
  operations?: HostOperation[];
  /** app-key: the service that needs the key, and where in the app it is made. */
  serviceId?: string;
  where?: string;
  /** file-access: the file and the account that cannot reach it. */
  path?: string;
  account?: string;
  access?: "read" | "write";
}
