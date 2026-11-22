import type { VpnProvider } from "./build-plan";

/**
 * "Build my plan": the saved homelab plan, built one approved step at a time (docs/design/BUILDER.md).
 * What the plan page's progress list and Ember both read.
 */

export type HomelabStepId =
  | "docker"
  | "jellyfin"
  | "plex"
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
  /**
   * Docker or Tailscale needs root to install, and the admin helper is not set up. Asked here, the
   * first time a plan needs it, with the reason; two ways: set up the helper (its one command), or
   * install it yourself with the vendor's own command (then Hearth sees it and moves on).
   */
  | {
      kind: "helper";
      command: string;
      /** Why this step needs it, in plain words. */
      reason: string;
      /** What the helper can do here (its fixed list), and where its source is. */
      helper: { can: string[]; source: string };
      /** The vendor's own install commands, for the person to run once instead. */
      yourself: { commands: string[]; after: string; docs: string };
    }
  | { kind: "vpn-login"; provider?: VpnProvider }
  | { kind: "tailscale-login"; url?: string }
  /** Sign in on the app's own page (Plex, Seerr with Plex): the owner's account, never Hearth's. */
  | { kind: "open-app"; url: string; label: string };

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
  /** Whether downloading is set up, and why not, from the saved plan (the VPN rule). */
  downloads?: {
    setUp: boolean;
    wanted: boolean;
    why?: string;
    vpn: string;
    keepItFree: boolean;
  };
  done: boolean;
}

export const HOMELAB_STEP_IDS: readonly HomelabStepId[] = [
  "docker",
  "jellyfin",
  "plex",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "qbittorrent",
  "connect",
  "tailscale",
];
