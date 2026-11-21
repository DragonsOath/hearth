import type { VpnProvider } from "./build-plan";

/**
 * "Build my plan": the saved homelab plan, built one approved step at a time (docs/design/BUILDER.md).
 * What the plan page's progress list and Ember both read.
 */

export type HomelabStepId =
  | "docker"
  | "jellyfin"
  | "seerr"
  | "radarr"
  | "sonarr"
  | "prowlarr"
  | "qbittorrent"
  | "connect"
  | "tailscale";

export type HomelabStepStatus =
  /** Not yet: an earlier step comes first, or the plan is missing something. */
  | "waiting"
  /** Can be proposed now. */
  | "ready"
  /** The owner has something to do first (set up the helper, add the VPN login, sign in). */
  | "needs-you"
  | "awaiting-approval"
  | "running"
  | "done"
  | "failed";

export type HomelabNeed =
  | { kind: "helper"; command: string }
  | { kind: "vpn-login"; provider?: VpnProvider }
  | { kind: "tailscale-login"; url?: string };

export interface HomelabStep {
  id: HomelabStepId;
  name: string;
  what: string;
  status: HomelabStepStatus;
  detail?: string;
  jobId?: string;
  need?: HomelabNeed;
}

export interface HomelabBuild {
  steps: HomelabStep[];
  /** The step to propose next. */
  next?: HomelabStepId;
  /** Apps in the plan that Hearth doesn't build yet, and why. */
  notBuilt: { id: string; name: string; why: string }[];
  /** Where the apps' own folders go. */
  appsFolder: string;
  /** The drive with their movies and shows. */
  drive?: string;
  /** Why nothing can start yet, in plain words. */
  blocker?: string;
  /** The conversation the build is talked through in. */
  conversationId?: string;
  done: boolean;
}

export const HOMELAB_STEP_IDS: readonly HomelabStepId[] = [
  "docker",
  "jellyfin",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "qbittorrent",
  "connect",
  "tailscale",
];
