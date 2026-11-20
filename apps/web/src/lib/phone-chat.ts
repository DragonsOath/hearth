import { useLayoutEffect, type RefObject } from "react";

/**
 * A phone's chat (11-16, the owner: "more like Claude itself"): the conversation fits the screen
 * between the header and the tab bar, with the box fixed at the bottom and the thread scrolling by
 * itself (the down arrow and "start at the newest" need that). While it fits, the rows marked
 * `data-phone-collapse` (Saved workspaces, Panels, the panel arrows) live in the chat's menu.
 */
const FIT = "chatFit";

/** Gives `ref` the height left on the screen below it, while `on`. */
export function useFitToScreen(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const root = document.documentElement;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      // The space kept below it: the tab bar and a small gap (11-18, the owner: the chat needs
      // every bit of the screen), else the page's bottom padding, which clears the tab bar.
      const bar = document.querySelector<HTMLElement>('[data-testid="tab-bar"]');
      // (A fixed bar has no offsetParent; hidden, it measures 0.)
      const barHeight = bar ? bar.getBoundingClientRect().height : 0;
      let padding = 0;
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n);
        padding += parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
      }
      const below = barHeight ? barHeight + 8 : padding;
      el.style.height = `${Math.max(320, Math.floor(window.innerHeight - top - below))}px`;
      // The page's own bottom padding (it clears the tab bar for pages that scroll) would add
      // a little scroll under the chat: take back what the chat already leaves.
      el.style.marginBottom = padding > below ? `${below - padding}px` : "";
    };
    root.dataset[FIT] = "1";
    fit();
    window.addEventListener("resize", fit);
    const sized = new ResizeObserver(fit);
    sized.observe(document.body);
    return () => {
      window.removeEventListener("resize", fit);
      sized.disconnect();
      el.style.height = "";
      el.style.marginBottom = "";
      delete root.dataset[FIT];
    };
  }, [ref, on]);
}
