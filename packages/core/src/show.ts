/**
 * Ember Show & Tell (checklist 45; private/docs/EMBER_SHOW_AND_TELL_MASTER_SPEC.md): while Ember
 * works, Hearth opens what it is really looking at, points at it, and says why, then tidies up.
 *
 * It changes what the owner sees, never what Ember may do: approvals, the vault and Full access
 * decide exactly as before, and the same work runs with Show & Tell off.
 *
 * Nothing here is tied to one app or page. Ember names a place (an app's panel, a Hearth tool, a
 * page, or a feature from the feature list) and, inside it, a target: any element marked with
 * `data-hearth-target`, or any control by its on-screen name ("control:Save"). The screen
 * answers with what is actually there, so a new feature or a redesign works without a list to
 * keep up to date (a test checks every control can be named).
 */

/**
 * off: Ember works as usual, nothing moves on screen (the default).
 * show: Ember opens and points at what it is examining, with a short caption.
 * teach: the same, and Ember also explains why each thing matters (more words, same rules).
 */
export type ShowMode = "off" | "show" | "teach";

export interface ShowSettings {
  mode: ShowMode;
  /** Read captions aloud (on a device that has a voice). Captions are always written too. */
  speak: boolean;
  /**
   * When Ember is done, offer to close what it opened (11-04: ask, don't just do it). Nothing
   * closes until you press Close them.
   */
  tidy: boolean;
}

export const SHOW_DEFAULTS: ShowSettings = { mode: "off", speak: false, tidy: true };

/** Where Ember wants to show something, after Hearth resolved it to one of its own places. */
export interface ShowPlace {
  /** A desk panel ("service:<id>", "tool:storage", "project:<id>", "workspace:<id>"). */
  panel?: string;
  /** A page of Hearth ("/systems"), when it is not a panel. */
  page?: string;
  /** The panel's tab, or the page's #section. */
  tab?: string;
  /** What the place is called, for the caption ("Radarr", "Machines"). */
  title: string;
}

/** One request to the screen. */
export interface ShowRequest {
  id: string;
  conversationId: string;
  place: ShowPlace;
  /** Inside the place: a data-hearth-target name (spaces nest), or "control:<on-screen name>". */
  target?: string;
  /** What Ember wants the owner to notice (its own words). */
  caption: string;
  /** What Ember's cursor does there: point (the default), click it, or type into it. */
  action?: ShowAction;
  /** For type: the words, typed into a search or filter box. */
  text?: string;
  /** Read the caption aloud. */
  speak: boolean;
  at: string;
}

/** A place inside the panel or page the screen can point at. */
export interface ShowTargetInfo {
  /** The name to pass as `target`. */
  name: string;
  /** What it says on screen (shortened). */
  label?: string;
}

/** What the screen answered. Only `onScreen: true` lets Ember say "as you can see". */
export interface ShowAck {
  onScreen: boolean;
  /** Why not, in plain words. */
  reason?: string;
  /** What can be pointed at in that place right now (so Ember never guesses names). */
  targets?: ShowTargetInfo[];
  /** What the cursor did: clicked or typed (absent when it only pointed, or was refused). */
  did?: "clicked" | "typed";
  /** Why the cursor would not click or type there. */
  refused?: string;
}

/**
 * A plan waiting for the owner's approval, tied to the setting it changes as it was on screen:
 * the screen keeps that place open with the approval card beside it (instead of tidying up),
 * follows the run, and highlights the setting again once Hearth has read it back.
 */
export interface ShowHold {
  jobId: string;
  title: string;
  place: ShowPlace;
  target?: string;
}

/** Messages the screen receives while it presents. */
export type ShowEvent =
  /** Ember started working on an answer: its cursor appears, busy, so you know it is on. */
  | { type: "start"; conversationId: string }
  | { type: "show"; request: ShowRequest }
  /** Ember finished answering in this conversation: time to offer a tidy-up, except what is held. */
  | { type: "end"; conversationId: string; hold?: ShowHold[] }
  /** Ember asks (tidy_screen) to close what it opened in this conversation: the screen asks you. */
  | { type: "offer"; conversationId: string }
  /**
   * What Ember is doing right now that has nothing to show (reading an app's API, checking
   * logs), as the conversation lists it: narrated on screen while the cursor works. Never a
   * click or a fake move.
   */
  | { type: "step"; conversationId: string; label: string; state: "running" | "done" | "failed" };

/**
 * The cursor only does what a person does to look around: open a tab, expand or collapse a
 * section, follow a link inside Hearth, type into a search or filter box. Anything that changes
 * something (save, approve, delete, a setting) it refuses: that is a plan the owner approves.
 */
export type ShowAction = "point" | "click" | "type";

/** "control:Save changes": a control named by what it says on screen. */
export const CONTROL_PREFIX = "control:";

/** Hearth's own tool panels on the desk (web desk/layout.ts TOOL_PANELS names them). */
export const TOOL_PANEL_IDS = ["storage", "todo", "browser"] as const;

/** Each page's name, as the top bar shows it (and Show & Tell's captions say it). */
const PAGE_TITLES: [RegExp, string][] = [
  [/^\/$/, "Home"],
  [/^\/projects/, "Projects"],
  [/^\/jobs/, "Jobs"],
  [/^\/agent/, "Agents"],
  [/^\/services/, "Systems"],
  [/^\/systems/, "Machines"],
  [/^\/vault/, "Secure Vault"],
  [/^\/docker/, "Docker"],
  [/^\/backups/, "Backups"],
  [/^\/network/, "Network"],
  [/^\/incidents/, "Monitoring"],
  [/^\/logs/, "Logs"],
  [/^\/ask/, "Ember"],
  [/^\/memory/, "Memory"],
  [/^\/(forge|saved)/, "The Forge"],
  [/^\/settings/, "Settings"],
];

export function pageTitle(pathname: string): string {
  return PAGE_TITLES.find(([re]) => re.test(pathname))?.[1] ?? "Hearth";
}
