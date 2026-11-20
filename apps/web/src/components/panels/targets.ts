/**
 * Stable, meaningful names for places inside a panel (native panels Phase 1, D14): a tab, a
 * section, a control. Written on the element as `data-hearth-target`, relative to its panel, so
 * the same name works for every install: the panel itself is found by its desk key
 * (`data-panel="service:<id>"`). Used by tests, screenshots, Ember's "where do I click" answers,
 * and later by Show & Tell to open, point at and confirm what is on screen.
 *
 * Names: lowercase words joined by ":"; "tab:<tab id>" for tabs. A space nests: "indexer:5
 * indexer:test" is the Test button inside indexer 5's row. A capability in the registry
 * (packages/core capabilities.ts) names the tab and the target of the control that performs it.
 */
export const TARGET_ATTR = "data-hearth-target";

export const tabTarget = (tabId: string) => `tab:${tabId}`;

/** Props that mark an element as a target. */
export const targetProps = (name: string) => ({ [TARGET_ATTR]: name }) as Record<string, string>;

/** A panel's tab and, after a "/", where inside it ("library/movie/42"). */
export function splitTab(tab: string | null | undefined): {
  tab: string | null;
  sub: string | null;
} {
  if (!tab) return { tab: null, sub: null };
  const i = tab.indexOf("/");
  return i < 0
    ? { tab, sub: null }
    : { tab: tab.slice(0, i) || null, sub: tab.slice(i + 1) || null };
}

export const joinTab = (tab: string, sub?: string | null) => (sub ? `${tab}/${sub}` : tab);

const cssEscape = (v: string) =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");

/** The element for a target inside an open panel, if it is rendered. */
export function findTarget(
  panelKey: string,
  name: string,
  root: ParentNode = document,
): Element | null {
  const path = name
    .split(" ")
    .filter(Boolean)
    .map((n) => `[${TARGET_ATTR}="${cssEscape(n)}"]`)
    .join(" ");
  return root.querySelector(`[data-panel="${cssEscape(panelKey)}"] ${path}`);
}

/**
 * Waits until a target is rendered and visible in its panel (or the time runs out). The answer
 * is what Show & Tell may say: only "on screen" lets it say "as you can see".
 */
export function waitForTarget(
  panelKey: string,
  name: string,
  timeoutMs = 3000,
): Promise<{ onScreen: boolean; element: Element | null }> {
  const visible = (el: Element | null) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest("[inert]");
  };
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = findTarget(panelKey, name);
      if (visible(el)) return resolve({ onScreen: true, element: el });
      if (Date.now() - started >= timeoutMs) return resolve({ onScreen: false, element: el });
      requestAnimationFrame(tick);
    };
    tick();
  });
}
