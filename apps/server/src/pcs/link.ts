import { randomBytes } from "node:crypto";

/**
 * The link between your Hearth and a PC that joined it (docs/design/ONE_ACCOUNT.md). The PC
 * dials out and keeps one WebSocket open; your Hearth sends requests down it and the PC answers.
 * Every frame is JSON text.
 */

/**
 * Requests that arrive over this PC's link are run inside the process with this header set to
 * a secret that never leaves the process, so nothing on the network can pretend to be the link.
 */
export const LINK_SECRET = randomBytes(32).toString("base64url");
export const LINK_HEADER = "x-hearth-link";
/** When your Hearth's owner last proved it was them, for sensitive steps on the PC. */
export const LINK_VERIFIED_HEADER = "x-hearth-verified-at";

/** Your Hearth to the PC. */
export type ToPc =
  | {
      t: "req";
      id: number;
      method: string;
      url: string;
      headers: Record<string, string>;
      /** base64 */
      body?: string;
    }
  | { t: "ws-open"; sid: number; url: string; headers: Record<string, string> }
  | { t: "ws-data"; sid: number; d: string; bin?: boolean }
  | { t: "ws-close"; sid: number }
  | { t: "removed" }
  | { t: "uninstall"; deleteData: boolean }
  /** Every Premium licence your Hearth counts (its own and its other PCs'): one purchase covers all. */
  | { t: "licences"; tokens: string[] }
  | { t: "ping" };

/** The PC to your Hearth. */
export type FromPc =
  | {
      t: "hello";
      name: string;
      os: string;
      version: string;
      install: InstallInfo | null;
      /** This PC's own Premium licences (older PCs send none). */
      licences?: string[];
    }
  /** This PC's own licences changed (one was redeemed here). */
  | { t: "licences"; tokens: string[] }
  | {
      t: "res";
      id: number;
      status: number;
      headers: Record<string, string>;
      /** base64 */
      body: string;
    }
  | { t: "ws-data"; sid: number; d: string; bin?: boolean }
  | { t: "ws-close"; sid: number; code?: number }
  | { t: "uninstalling"; ok: boolean; message: string }
  | { t: "pong" };

/** How an installation was made (its install.json), and so whether it can remove itself. */
export interface InstallInfo {
  kind: "linux-user-service" | "windows-sign-in-task" | "manual";
  home?: string;
  service?: string;
  /** The release channel the installer was run with (HEARTH_CHANNEL; stable when not given). */
  channel?: "stable" | "fast";
}

/** Response headers worth passing through (others are the transport's business). */
export const PASS_HEADERS = [
  "content-type",
  "content-disposition",
  "cache-control",
  "content-security-policy",
  "x-content-type-options",
  "location",
];

/** Biggest request or response sent over the link (a file download, an upload). */
export const MAX_BODY = 64 * 1024 * 1024;
