/**
 * Swiping between panels on a phone (the Lair's carousel): which way a finger is going, whether
 * the place it started owns horizontal moves itself, and which panel comes next, wrapping round.
 * Pure helpers, so the rules are tested without a touchscreen.
 */

/** Pixels a finger moves before Hearth decides which way it is going. */
export const LOCK_DISTANCE = 10;
/** Pixels sideways that switch panels when the finger lifts. */
export const SWITCH_DISTANCE = 56;

/**
 * Which way a move is going, once it has gone far enough to tell: "x" only when it is clearly
 * sideways (half as much again sideways as up or down), so a scroll that drifts never switches.
 */
export function lockDirection(dx: number, dy: number): "x" | "y" | undefined {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < LOCK_DISTANCE && ay < LOCK_DISTANCE) return undefined;
  return ax > ay * 1.5 ? "x" : "y";
}

/** Whether a sideways move, when the finger lifts, switches panels, and which way. */
export function swipeStep(dx: number): -1 | 0 | 1 {
  if (dx <= -SWITCH_DISTANCE) return 1;
  if (dx >= SWITCH_DISTANCE) return -1;
  return 0;
}

/** The next index going `step` from `index` in a ring of `count` (it wraps both ways). */
export function wrapIndex(index: number, step: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}

/** Fields where a finger moves the caret or selects text: they keep every move. */
const FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Controls that are dragged sideways: sliders, media, charts, and anything marked as such. */
const OWNS_X =
  '[data-swipe-ignore], [role="slider"], input[type="range"], audio, video, canvas, [role="img"][data-chart], .recharts-wrapper';

/** Whether an element scrolls sideways itself (a tab bar, a wide table). */
function scrollsSideways(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.scrollWidth <= el.clientWidth + 1) return false;
  const overflow = getComputedStyle(el).overflowX;
  return overflow === "auto" || overflow === "scroll";
}

/**
 * Whether a move starting at `target` belongs to that element rather than to panel switching:
 * fields, sliders, media, charts, anything marked data-swipe-ignore, and anything between it and
 * the carousel that scrolls sideways. Stops looking at `boundary` (the carousel).
 */
export function ownsHorizontal(target: EventTarget | null, boundary: Element | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(FIELD) || target.closest(OWNS_X)) return true;
  for (let el: Element | null = target; el && el !== boundary; el = el.parentElement)
    if (scrollsSideways(el)) return true;
  return false;
}

/** Never switch while typing: a focused field, or text being selected. */
export function busyWithText(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (active instanceof Element && active.matches(FIELD)) return true;
  const selection = doc.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}
