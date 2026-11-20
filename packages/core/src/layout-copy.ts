/**
 * Copying another Hearth's layout (11-08): two separate Hearths look the same with one copy,
 * or stay different. Server: apps/server/src/layout/copy.ts.
 */

/** What a layout is made of, as chosen when copying. */
export type LayoutPart =
  /** The Lair's saved layouts, its app strip's order and its conversation dock. */
  | "lair"
  /** The home dashboard: widgets, Home Assistant devices, clock, start page. */
  | "home"
  /** The theme and the AI's look style. */
  | "look"
  /** The sidebar: open or narrow. */
  | "sidebar";

export const LAYOUT_PARTS: readonly LayoutPart[] = ["lair", "home", "look", "sidebar"];

/** The browser keys a layout includes (kept by each browser, copied through its Hearth). */
export const LAYOUT_BROWSER_KEYS = [
  "hearth.home-dashboard",
  "hearth-lair-order",
  "dc-desk-dock",
  "dc-sidebar-rail",
] as const;

/** A Hearth's layout, as it shares it with another Hearth that has its key. */
export interface LayoutShare {
  name: string;
  /** When its browser layout was last kept. */
  browserAt?: string;
  theme: unknown;
  lookStyle: unknown;
  deskLayouts: { name: string; panels: string; dock: unknown }[];
  browser: Record<string, string>;
  /** Its apps and projects by id, to match them by name. */
  services: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

export interface LayoutPreview {
  from: string;
  browserAt?: string;
  parts: LayoutPart[];
  /** The Lair layouts that would be copied. */
  deskLayouts: string[];
  /** Apps or projects in its layout that this Hearth doesn't have (left out). */
  missing: string[];
  /** It has a browser layout kept (else only the server parts copy). */
  hasBrowser: boolean;
}

export interface LayoutCopyResult {
  from: string;
  parts: LayoutPart[];
  /** Browser keys to put in place (null removes one). */
  browser: Record<string, string | null>;
  missing: string[];
  canUndo: boolean;
}
