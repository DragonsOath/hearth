/**
 * Ember's Browser (checklist 45.12): a real browser Hearth runs for Ember, watched live in its
 * panel. These are what the panel and the tools see; never cookies, credentials or page secrets.
 */

/** A page in one of the browser's tabs. */
export interface BrowserPage {
  tab: string;
  url: string;
  title: string;
  /** The page's own answer when it was opened (403: the site refuses the browser). */
  status?: number;
}

/**
 * Ember asks to open a site in a visible browser window on this machine (checklist 45.19): the
 * site refuses Hearth's background browser. A real, visible window, never a disguised one.
 */
export interface BrowserVisibleAsk {
  host: string;
  url: string;
  reason: string;
  at: string;
  conversationId?: string;
}

/** Something on a page Ember can click or type into, by its ref from the last read. */
export interface BrowserControl {
  ref: string;
  /** link, button, select, or an input's type (text, search, checkbox, password...). */
  role: string;
  name: string;
  href?: string;
  /** For a dropdown list (select): its choices, and the one chosen now. */
  options?: string[];
  value?: string;
  /** A checkbox, switch, radio, tab or option that is on or chosen now. */
  checked?: boolean;
}

/** Who has the page while the owner has it, and why. */
export interface BrowserHandover {
  reason: string;
  by: "ember" | "owner";
  at: string;
  /** The conversation Ember carries on when it is given back. */
  conversationId?: string;
}

/** What the owner does on the page while they have it: never recorded or shown to the AI. */
export type BrowserOwnerInput =
  /** Where on the picture, as a share of its width and height (0 to 1). */
  | { kind: "click"; fx: number; fy: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dy: number };

export interface BrowserState {
  /** live: running; off: not started (starts when used); unavailable: no browser installed. */
  status: "off" | "starting" | "live" | "unavailable";
  reason?: string;
  tabs: { id: string; url: string; title: string; ember: boolean }[];
  /** background: a hidden browser (the usual); visible: a normal window on this machine's screen. */
  window: "background" | "visible";
  /** This machine has a screen a visible window can open on. */
  screen: boolean;
  /** Ember asked to open a site in a visible window and waits for the owner's answer. */
  visibleAsk?: BrowserVisibleAsk;
  /** Sites the owner allowed to always open in a visible window when they refuse the background one. */
  visibleSites: string[];
  /** The page size the picture and the pointer use. */
  viewport: { width: number; height: number };
  /** Where Hearth itself last sent a click or typing (drawn as the marker; never guessed). */
  pointer?: { tab: string; x: number; y: number; kind: "click" | "type"; at: string };
  /** Show & Tell: what Ember says to notice at this step (shown under the page, read aloud when on). */
  caption?: { text: string; at: string };
  /** The last thing done in it, and by whom. */
  last?: { label: string; by: "ember" | "owner"; at: string };
  /** The last page refused (an address on your network, a form submission), and why. */
  blocked?: { url: string; why: string; at: string };
  /**
   * The owner has the page (checklist 45.18): Ember was stuck on something only a person should do
   * (a CAPTCHA or bot check, a password, a sign-in), or the owner took over. Ember does nothing in
   * the browser until it is given back.
   */
  handover?: BrowserHandover;
  /** When it closes itself if nothing more happens. */
  idleClosesAt?: string;
  /** The owner's apps opened in it: signed in through Secure Vault, or why not (no values). */
  signedIn?: {
    origin: string;
    service: string;
    state: "signed-in" | "not-signed-in";
    how: string;
  }[];
  /** Changes to the owner's apps held for approval, not sent (summaries only). */
  held?: {
    id: string;
    serviceId: string;
    serviceName: string;
    method: string;
    path: string;
    changes: { name: string; before: string; after: string }[];
    summary: string;
    at: string;
    expiresAt: string;
  }[];
  /** Files it downloaded into Hearth's downloads folder. */
  downloads?: {
    name: string;
    url: string;
    state: "downloading" | "done" | "failed";
    bytes: number;
    path?: string;
    at: string;
  }[];
}
