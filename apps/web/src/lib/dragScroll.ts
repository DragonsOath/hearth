import { useEffect, useState } from "react";

/**
 * Lets a mouse scroll a sideways strip: hold the button and drag left or right, or use the
 * wheel. A drag never counts as a click on the chip under it. Touch keeps its own native swipe.
 */
export function useDragScroll<T extends HTMLElement>() {
  // A callback ref, so a strip that appears after the first render still gets the handlers.
  const [el, setEl] = useState<T | null>(null);
  useEffect(() => {
    if (!el) return;
    let start: { x: number; left: number; id: number } | null = null;
    let dragged = false;

    const down = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      start = { x: e.clientX, left: el.scrollLeft, id: e.pointerId };
      dragged = false;
    };
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      if (!dragged) {
        if (Math.abs(dx) < 6) return;
        dragged = true;
        el.setPointerCapture(e.pointerId);
        el.dataset.dragging = "true";
      }
      el.scrollLeft = start.left - dx;
      e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      start = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      delete el.dataset.dragging;
    };
    const click = (e: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // The wheel moves the strip sideways, a good step per notch. Linux and Firefox report the
    // wheel in lines (deltaMode 1), a few units each: read as pixels that barely moved (11-07).
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientWidth : 1;
      let dy = e.deltaY * unit;
      // A mouse notch (not a trackpad's small steady deltas) moves at least a chip or two.
      if (Math.abs(dy) >= 50 && Math.abs(dy) < 160) dy = Math.sign(dy) * 160;
      el.scrollBy({ left: dy, behavior: Math.abs(dy) >= 100 ? "smooth" : "auto" });
      e.preventDefault();
    };
    const noNativeDrag = (e: DragEvent) => e.preventDefault();

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", click, true);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("dragstart", noNativeDrag);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("click", click, true);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("dragstart", noNativeDrag);
    };
  }, [el]);
  return setEl;
}
