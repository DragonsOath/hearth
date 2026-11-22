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
  /** The app's own address, once it runs (its Open button). */
  url?: string;
  /**
   * Failed, but the app runs and answers on its address: Hearth's own check may be what failed,
   * so the owner can say it works (action confirm, approved like any step) and the build goes on.
   */
  answering?: boolean;
  /** Done because the owner checked it and said it works (Hearth's own check had not passed). */
  confirmedByOwner?: boolean;
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
  /** One password the owner chose for every app, or a strong new one each (in Secure Vault). */
  passwords?: "own" | "generate";
  /** The owner's user name in every app. */
  username?: string;
  /** Whether downloading is set up, and why not, from the saved plan (the VPN rule). */
  downloads?: {
    setUp: boolean;
    wanted: boolean;
    why?: string;
    vpn: string;
    keepItFree: boolean;
  };
  done: boolean;
  /** When the last step finished (11-22: Hearth congratulates them, once). */
  finishedAt?: string;
  /** The owner closed the "everything is built" card. */
  celebrated?: boolean;
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

/**
 * Ember's congratulations when every step is done (11-22, the owner: "have Ember say
 * congratulations everything is built, I got nothing"): what was built, and the first thing to try.
 */
export function buildDoneText(b: Pick<HomelabBuild, "steps">): string {
  const apps = b.steps
    .filter((s) => !["docker", "connect", "tailscale"].includes(s.id))
    .map((s) => s.name);
  const list =
    apps.length > 1 ? `${apps.slice(0, -1).join(", ")} and ${apps[apps.length - 1]}` : apps[0];
  const media = b.steps.find((s) => s.id === "jellyfin" || s.id === "plex");
  const seerr = b.steps.some((s) => s.id === "seerr");
  const remote = b.steps.some((s) => s.id === "tailscale");
  return [
    "Congratulations, everything is built! Your homelab is up and running.",
    list ? `${list}: each one set up, signed in and connected to the others.` : "",
    media
      ? `Try this first: open ${media.name} and play something.${seerr ? " Then ask for a movie in Seerr and watch it arrive on its own." : ""}`
      : "",
    remote ? "It works away from home too, through Tailscale." : "",
    "I'm right here whenever you want to add more.",
  ]
    .filter(Boolean)
    .join(" ");
}
