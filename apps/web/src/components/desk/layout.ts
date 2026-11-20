/**
 * The desktop desk: which panels are open, in what order, which are pinned,
 * and which tab each shows. Kept in the address (`?panels=`), so refresh,
 * back, links, and saved layouts all restore the same arrangement.
 *
 * Format: comma-separated `[!]kind:id[@tab]`, each part URI-encoded;
 * `!` marks a pinned panel. `?focus=kind:id` is the panel last opened.
 */

/**
 * A workspace is a temporary panel Ember opened (feature request 20). A tool is one of Hearth's own
 * panels that is about the whole homelab rather than one service (Storage & Files: tool:storage).
 */
export type PanelKind = "service" | "project" | "workspace" | "tool";

/** The tool panels there are (ids after "tool:"). */
export const TOOL_PANELS = {
  storage: "Storage & Files",
  todo: "To-do",
  browser: "Ember's Browser",
  "home-rows": "Home rows",
  downloads: "Download Health",
  curator: "Curator",
  "movie-nights": "Movie nights",
  crucible: "The Crucible",
} as const;

export interface Panel {
  kind: PanelKind;
  id: string;
  tab?: string;
  pinned?: boolean;
}

export const keyOf = (p: Pick<Panel, "kind" | "id">) => `${p.kind}:${p.id}`;

export function parsePanels(value: string | null): Panel[] {
  if (!value) return [];
  const out: Panel[] = [];
  for (const raw of value.split(",")) {
    const pinned = raw.startsWith("!");
    const body = pinned ? raw.slice(1) : raw;
    const [head, tab] = body.split("@");
    const colon = head?.indexOf(":") ?? -1;
    if (!head || colon < 1) continue;
    const kind = decodeURIComponent(head.slice(0, colon));
    const id = decodeURIComponent(head.slice(colon + 1));
    if (
      (kind !== "service" && kind !== "project" && kind !== "workspace" && kind !== "tool") ||
      !id
    )
      continue;
    if (kind === "tool" && !(id in TOOL_PANELS)) continue;
    if (out.some((p) => p.kind === kind && p.id === id)) continue;
    out.push({
      kind,
      id,
      ...(tab ? { tab: decodeURIComponent(tab) } : {}),
      ...(pinned ? { pinned: true } : {}),
    });
  }
  return out.slice(0, MAX_PANELS);
}

export function serializePanels(panels: Panel[]): string {
  return panels
    .map(
      (p) =>
        `${p.pinned ? "!" : ""}${encodeURIComponent(p.kind)}:${encodeURIComponent(p.id)}${
          p.tab ? `@${encodeURIComponent(p.tab)}` : ""
        }`,
    )
    .join(",");
}

/** No more than this many panels open at once (the strip stays readable). */
export const MAX_PANELS = 12;

/** The panels in the address, including the older single-panel links (?service= / ?project=). */
export function panelsFrom(params: URLSearchParams): Panel[] {
  const list = parsePanels(params.get("panels"));
  const legacyProject = params.get("project");
  const legacyService = params.get("service");
  const legacy: Panel | undefined = legacyProject
    ? {
        kind: "project",
        id: legacyProject,
        ...(params.get("tab") ? { tab: params.get("tab")! } : {}),
      }
    : legacyService
      ? {
          kind: "service",
          id: legacyService,
          ...(params.get("tab") ? { tab: params.get("tab")! } : {}),
        }
      : undefined;
  if (legacy && !list.some((p) => keyOf(p) === keyOf(legacy))) list.push(legacy);
  return list;
}

/** The panel last opened or focused, if it is still open. */
export function focusFrom(params: URLSearchParams, panels: Panel[]): string | undefined {
  const f = params.get("focus");
  if (f && panels.some((p) => keyOf(p) === f)) return f;
  const legacyProject = params.get("project");
  const legacyService = params.get("service");
  if (legacyProject) return `project:${legacyProject}`;
  if (legacyService) return `service:${legacyService}`;
  return panels.at(-1) ? keyOf(panels.at(-1)!) : undefined;
}

/** Adds a panel (or keeps it where it is) and makes it the focus. */
export function withPanel(panels: Panel[], add: Panel): Panel[] {
  if (panels.some((p) => keyOf(p) === keyOf(add))) {
    return add.tab
      ? panels.map((p) => (keyOf(p) === keyOf(add) ? { ...p, tab: add.tab } : p))
      : panels;
  }
  const next = [...panels, add];
  // Over the limit: the oldest unpinned panel closes (never a pinned one).
  if (next.length > MAX_PANELS) {
    const i = next.findIndex((p) => !p.pinned && keyOf(p) !== keyOf(add));
    if (i >= 0) next.splice(i, 1);
  }
  return next;
}

/** The address for the desk with these panels, keeping everything else (q, etc.). */
export function deskSearch(base: URLSearchParams, panels: Panel[], focus?: string): string {
  const next = new URLSearchParams(base);
  for (const k of ["service", "project", "tab"]) next.delete(k);
  if (panels.length) next.set("panels", serializePanels(panels));
  else {
    next.delete("panels");
    // No panels left: no workspace group either.
    next.delete("g");
  }
  if (focus && panels.length) next.set("focus", focus);
  else next.delete("focus");
  const s = next.toString();
  return s ? `?${s}` : "";
}

/** Width one panel needs to be useful. */
export const PANEL_MIN_WIDTH = 340;

/**
 * The Lair's standard (11-16, the owner): Ember's chat and at most three panels beside it, never
 * squeezed smaller for a fourth. More wait in the queue, reached with the slide arrows.
 */
export const LAIR_PANELS = 3;

/** How many panels fit beside the dock in this width (never more than LAIR_PANELS). */
export function slotsFor(width: number, dock: number, gap = 16): number {
  const room = width - dock - gap;
  return Math.min(LAIR_PANELS, Math.max(1, Math.floor((room + gap) / (PANEL_MIN_WIDTH + gap))));
}

/**
 * The panels in the Lair's row, in the order they were opened (pinned ones first): the queue the
 * slide arrows move along.
 */
export function panelRow(panels: Panel[]): Panel[] {
  return [...panels.filter((p) => p.pinned), ...panels.filter((p) => !p.pinned)];
}

/** The first shown position, kept inside the row. */
export function clampStart(start: number, count: number, slots: number): number {
  return Math.max(0, Math.min(start, count - Math.max(slots, 1)));
}

/** The start that brings `index` into a window of `slots`, moving as little as possible. */
export function startShowing(index: number, start: number, slots: number): number {
  if (index < start) return index;
  if (index >= start + slots) return index - slots + 1;
  return start;
}

/**
 * Which open panels are shown, in their own order: pinned first, then the
 * most recently used, up to the number that fit. The rest wait in the strip.
 */
export function visiblePanels(panels: Panel[], recent: string[], slots: number): Panel[] {
  const rank = (p: Panel) => {
    const r = recent.indexOf(keyOf(p));
    return r < 0 ? recent.length + panels.indexOf(p) : r;
  };
  const pinned = panels.filter((p) => p.pinned);
  const rest = panels.filter((p) => !p.pinned).sort((a, b) => rank(a) - rank(b));
  const chosen = new Set([...pinned, ...rest].slice(0, Math.max(slots, 1)).map(keyOf));
  return panels.filter((p) => chosen.has(keyOf(p)));
}

/** Whether two arrangements have the same panels open (order, tabs, and pins aside). */
export function samePanels(a: Panel[], b: Panel[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(keyOf));
  return b.every((p) => keys.has(keyOf(p)));
}

/**
 * The saved workspace group that already has exactly these panels open, the most recently used
 * if there are several. Opening the same panel link again reuses it instead of starting a copy.
 */
export function groupWithPanels<G extends { search: string; updatedAt: string }>(
  groups: readonly G[],
  panels: Panel[],
): G | undefined {
  if (!panels.length) return undefined;
  return groups
    .filter((g) => samePanels(panelsFrom(new URLSearchParams(g.search)), panels))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
