import type { CredentialState } from "./credentials";

/**
 * Getting started: what is left to set up after the welcome, built by Hearth from the
 * installation's real state (never from what an AI thinks). Each item ticks itself when its
 * state is done, and the owner can dismiss any item, or the whole list.
 */

export type GettingStartedKind =
  "plan" | "adopt" | "key" | "notifications" | "backup-copy" | "voice" | "operator" | "meet";

export interface GettingStartedItem {
  /** Stable id: the kind, or "key:<service id>" for an app's key. */
  id: string;
  kind: GettingStartedKind;
  title: string;
  /** One line on what to do, or where an app shows its key. */
  detail: string;
  /** The page that does it. Meet uses an action instead of a page. */
  href: string;
  done: boolean;
  /** Nice to have: it does not keep the list from being finished. */
  optional?: boolean;
  dismissed: boolean;
}

export interface GettingStarted {
  items: GettingStartedItem[];
  /** The owner dismissed the whole list (Settings can bring it back). */
  hidden: boolean;
  /** Every item that is not optional is done or dismissed. */
  finished: boolean;
  /** Items still to do: not done, not dismissed, not optional. */
  remaining: number;
}

/** What the owner chose to dismiss, kept as a setting. */
export interface GettingStartedChoices {
  dismissed: string[];
  hidden: boolean;
}

/** An adopted app that needs a key (or login) before Hearth can read inside it. */
export interface KeyNeed {
  serviceId: string;
  name: string;
  kind: "api-key" | "login";
  /** Where the app shows it ("Radarr: Settings > General > Security > API Key"). */
  where: string;
  /**
   * The credential broker's own view of it (the same one Secure Vault shows): only one
   * Hearth can actually use, working or not yet tried, counts as done.
   */
  state: CredentialState;
}

/** The facts the list is built from. */
export interface GettingStartedState {
  /** Your own systems are adopted (not sample data, at least one watched). */
  adopted: boolean;
  /** A homelab plan was saved in "Help me build". */
  planned?: boolean;
  keys: KeyNeed[];
  /** At least one notification channel is set up. */
  notifications: boolean;
  /** Backups are copied to a second place (another drive, or another machine). */
  backupCopy: boolean;
  /** A speech machine is set up. */
  voice: boolean;
  /** An AI operator (Claude Code) is connected. */
  operator: boolean;
  /** The owner has met the AI (Meet Ember). */
  met: boolean;
}

/** The list, from the facts and the owner's choices. The AI's name is used in its wording. */
export function buildGettingStarted(
  state: GettingStartedState,
  choices: GettingStartedChoices,
  aiName: string,
): GettingStarted {
  const raw: Omit<GettingStartedItem, "dismissed">[] = [
    {
      id: "plan",
      kind: "plan",
      title: "Plan your homelab",
      detail: state.adopted
        ? "Want more? Answer a few questions and get recommended apps that suit this machine."
        : "New to this? Answer a few plain questions and get a recommended setup for this machine. Nothing is installed.",
      href: "/plan",
      done: Boolean(state.planned),
      // Someone who already runs things does not need a plan to be finished.
      optional: state.adopted,
    },
    {
      id: "adopt",
      kind: "adopt",
      title: "Adopt your systems",
      detail:
        "Already run apps? Discover this machine finds your containers and apps; you choose which to watch.",
      href: "/discover",
      done: state.adopted,
    },
    ...state.keys.map((k) => {
      const what = k.kind === "login" ? "login" : "key";
      const where = `How to get it: ${k.where.replace(/^[^:]+:\s*/, "")}`;
      return {
        id: `key:${k.serviceId}`,
        kind: "key" as const,
        title: `Add ${k.name}'s ${what} in Secure Vault`,
        detail:
          k.state === "failing"
            ? `${k.name} turned down the saved ${what}, so add the current one. ${where}`
            : k.state === "protected"
              ? `The saved ${what} is Protected, so Hearth cannot use it on its own: save it as Automation. ${where}`
              : where,
        href: "/vault",
        done: k.state === "working" || k.state === "unused",
      };
    }),
    {
      id: "notifications",
      kind: "notifications",
      title: "Set up notifications",
      detail: "Choose how you hear when something needs you: email, Discord, ntfy, or a webhook.",
      href: "/notifications",
      done: state.notifications,
    },
    {
      id: "backup-copy",
      kind: "backup-copy",
      title: "Keep a backup copy on another drive",
      detail:
        "A second copy of each daily backup, so one failed drive loses nothing. Your AI agent can set it when it installs or updates Hearth.",
      href: "/backups",
      done: state.backupCopy,
    },
    {
      id: "voice",
      kind: "voice",
      title: "Talk out loud (optional)",
      detail: `If you run Whisper and Piper speech servers, ${aiName} can hear you and answer aloud.`,
      href: "/settings#cave",
      done: state.voice,
      optional: true,
    },
    {
      id: "operator",
      kind: "operator",
      title: "Connect the AI operator",
      detail: `Connect Claude Code on this machine, so ${aiName} can look into problems and propose fixes.`,
      href: "/agent",
      done: state.operator,
    },
    {
      id: "meet",
      kind: "meet",
      title: `Meet ${aiName}`,
      detail: `${aiName} introduces itself and checks up on your server, without changing anything.`,
      href: "/ask",
      done: state.met,
    },
  ];
  const dismissed = new Set(choices.dismissed);
  const items = raw.map((i) => ({ ...i, dismissed: dismissed.has(i.id) }));
  const remaining = items.filter((i) => !i.done && !i.dismissed && !i.optional).length;
  return { items, hidden: choices.hidden, finished: remaining === 0, remaining };
}
