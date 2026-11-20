import { createContext, useContext, useEffect, useState, type RefObject } from "react";

/**
 * How much room a panel has (native panels Phase 1, refinement C). Each panel measures itself, so
 * the same panel can be a narrow column beside two others, the only panel, or expanded over the
 * whole desk. What a class means for layout:
 *
 * - compact: a narrow desk column. Essentials and a sections menu; no squeezed desktop views.
 * - normal: the everyday overview with a row of tabs.
 * - expanded: room for wider tables and forms.
 * - maximized: the full management view, with side navigation.
 * - mobile: a phone, one panel at a time; stacked layouts and a scrolling tab row.
 */
export type PanelSize = "compact" | "normal" | "expanded" | "maximized" | "mobile";

/** Widths in CSS pixels where a desk panel moves to the next class. */
export const PANEL_WIDTHS = { normal: 340, expanded: 760, maximized: 1180 } as const;
/** Below this window width Hearth is on a phone (matches the desk's own breakpoint idea). */
export const PHONE_WIDTH = 640;

export function sizeFor(panelWidth: number, windowWidth: number): PanelSize {
  if (windowWidth < PHONE_WIDTH) return "mobile";
  if (panelWidth < PANEL_WIDTHS.normal) return "compact";
  if (panelWidth < PANEL_WIDTHS.expanded) return "normal";
  if (panelWidth < PANEL_WIDTHS.maximized) return "expanded";
  return "maximized";
}

/** Measures an element and keeps its size class current as it is resized. */
export function useMeasuredSize(ref: RefObject<HTMLElement | null>): PanelSize {
  const [size, setSize] = useState<PanelSize>("normal");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setSize(sizeFor(el.getBoundingClientRect().width, window.innerWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [ref]);
  return size;
}

const SizeContext = createContext<PanelSize>("normal");
export const PanelSizeProvider = SizeContext.Provider;

/** The size class of the panel this component is in ("normal" outside a panel). */
export function usePanelSize(): PanelSize {
  return useContext(SizeContext);
}
