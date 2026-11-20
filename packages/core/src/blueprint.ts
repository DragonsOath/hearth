/**
 * Lab Blueprint (the owner, 2026-11-11, replacing Hearth Transfer): a written, verified description
 * of the lab that a fresh Ember on a new machine can rebuild from, kept with the vault entries it
 * needs, encrypted to a recovery key only the owner holds. It copies no app data: it says where each
 * app keeps its data and where that app's own backups are. Design: the "Lab Blueprint" doc.
 */

/** One stated fact and where it came from. */
export interface BlueprintFact {
  label: string;
  value: string;
  /** Where Hearth read it ("Docker", "the compose file", "Hearth's service list"). */
  source: string;
  /** Read from the source just now; false = could not be confirmed (see why). */
  verified: boolean;
  why?: string;
}

export interface BlueprintMount {
  /** On this machine. */
  source: string;
  /** Inside the container. */
  destination: string;
  /** What it holds, in plain words. */
  holds: "settings and data" | "media or downloads" | "a file or folder from the machine";
  readOnly: boolean;
}

export interface BlueprintApp {
  name: string;
  image: string;
  /** The image's version label when it has one. */
  version?: string;
  state: string;
  composeProject?: string;
  composeService?: string;
  /** Its compose files on this machine (read, values hidden). */
  composeFiles: string[];
  ports: string[];
  mounts: BlueprintMount[];
  networks: string[];
  networkMode?: string;
  restartPolicy: string;
  /** Other apps it needs up first (compose's depends_on, or another container's network). */
  dependsOn: string[];
  /** Settings whose values the blueprint leaves out (they may be secrets). */
  hiddenSettings: string[];
  /** Vault entries linked to it, by name. */
  vault: string[];
  /** The app's own backups, when Hearth knows where it keeps them. */
  ownBackup?: BlueprintFact;
  /** Hearth's name for it, when Hearth knows it. */
  hearthName?: string;
}

export interface BlueprintVaultEntry {
  name: string;
  kind: string;
  tier: "automation" | "protected";
  service?: string;
}

/** Everything the blueprint states, as data (the Markdown is written from it). */
export interface BlueprintFacts {
  format: "hearth-blueprint/1";
  writtenAt: string;
  host: BlueprintFact[];
  apps: BlueprintApp[];
  networks: { name: string; driver: string; subnet?: string; apps: string[] }[];
  /** Hearth's own connections: each app it watches and how it reaches it. */
  connections: { name: string; app?: string; address?: string }[];
  vault: BlueprintVaultEntry[];
  /** What must come up first, derived from the above (marked as derived). */
  installOrder: string[][];
  /** The owner's and Ember's notes, carried into every version. */
  notes: string;
  /** Each compose file, by its path on the machine, with every value that could be secret hidden. */
  compose: Record<string, string>;
  /** Anything Hearth could not read, with why. */
  gaps: string[];
}

/**
 * Cloud storage reached directly. S3: any S3-compatible service (Backblaze B2, Cloudflare R2,
 * Wasabi, Amazon S3, MinIO). WebDAV: Nextcloud and most NAS. Its login is a Secure Vault entry.
 */
export type BlueprintCloud =
  | { kind: "s3"; endpoint: string; bucket: string; prefix?: string; region?: string }
  | { kind: "webdav"; url: string };

/** What the owner set up (no secret: the recovery key is never kept). */
export interface BlueprintConfig {
  /** The folder's path, or for cloud storage where it is in words ("Backblaze B2: bucket/hearth"). */
  destination: string;
  /** Set when versions go to cloud storage instead of a folder. */
  cloud?: BlueprintCloud & {
    /** The Secure Vault entry holding its login (Hearth added it at setup). */
    secretId: string;
  };
  /** The age public key versions are encrypted to. */
  recipient: string;
  /** A short id for that key, shown to the owner ("A1B2-C3D4"). */
  keyId: string;
  setupAt: string;
  /** Dated versions kept in the destination. */
  keep: number;
}

export interface BlueprintVersion {
  file: string;
  at: string;
  bytes: number;
  keyId: string;
  /** Protected vault entries are in it (the owner ran Update now and confirmed it's them). */
  protectedIncluded: boolean;
}

export interface BlueprintStatus {
  config?: Omit<BlueprintConfig, "recipient">;
  versions: BlueprintVersion[];
  lastCheck?: string;
  lastError?: { at: string; text: string };
  /** No good version for more than two days while set up. */
  stale: boolean;
  /** The destination looks like the same disk as the operating system. */
  sameDrive?: boolean;
  notes: string;
  imported?: { at: string; from: string; hearthVersion?: string; entries: number };
}

/** What an opened package holds, before anything is imported (no values). */
export interface BlueprintImportPreview {
  id: string;
  writtenAt: string;
  hearthVersion?: string;
  host: string;
  apps: number;
  entries: { name: string; kind: string; tier: "automation" | "protected"; service?: string }[];
  protectedLeftOut: string[];
}

export const BLUEPRINT_KEEP = 7;
export const BLUEPRINT_FILE = /^hearth-blueprint-\d{8}-\d{6}\.age$/;
