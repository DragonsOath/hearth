import { useEffect, useRef, useState, type RefObject } from "react";

interface Box {
  top: number;
  height: number;
  show: boolean;
}

/** Where the handle sits for this element's scroll. */
function boxOf(el: HTMLElement): Box {
  const ch = el.clientHeight;
  const sh = el.scrollHeight;
  const show = ch > 0 && sh > ch * 1.5;
  const height = show ? Math.max(48, Math.round((ch * ch) / sh)) : 0;
  const top = show ? Math.round((el.scrollTop / (sh - ch)) * (ch - height)) : 0;
  return { top, height, show };
}

/** Scrolls `el` so a handle of `height` sits `y` pixels down its track. */
function scrollToTrack(el: HTMLElement | null, y: number, height: number): void {
  if (!el) return;
  const room = el.clientHeight - height;
  if (room <= 0) return;
  el.scrollTop = (Math.max(0, Math.min(room, y)) / room) * (el.scrollHeight - el.clientHeight);
}

/**
 * A scroll handle you can hold and drag (11-16, the owner: "tap and hold the scroll bar and move
 * quickly through the chat"). A phone's own scroll bar only shows and cannot be grabbed, so this
 * one sits on the right edge of the conversation: drag it to fly through, or tap the track to
 * jump there. Shown only when the conversation is longer than the screen.
 */
export function ScrollHandle({ target }: { target: RefObject<HTMLElement | null> }) {
  const [box, setBox] = useState({ top: 0, height: 0, show: false });
  const [held, setHeld] = useState(false);
  const drag = useRef<{ y: number; scroll: number } | null>(null);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const measure = () => {
      const next = boxOf(el);
      setBox((b) =>
        b.top === next.top && b.height === next.height && b.show === next.show ? b : next,
      );
    };
    const first = requestAnimationFrame(measure);
    el.addEventListener("scroll", measure, { passive: true });
    const sized = new ResizeObserver(measure);
    sized.observe(el);
    const grown = new MutationObserver(measure);
    grown.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", measure);
      cancelAnimationFrame(first);
      sized.disconnect();
      grown.disconnect();
    };
  }, [target]);

  if (!box.show) return null;
  return (
    <div
      ref={track}
      className="absolute top-0 right-0 bottom-0 z-10 w-6 touch-none"
      onPointerDown={(e) => {
        // A tap on the track (not the handle) jumps there, centring the handle on the finger.
        if (e.target !== track.current) return;
        const r = track.current.getBoundingClientRect();
        scrollToTrack(target.current, e.clientY - r.top - box.height / 2, box.height);
      }}
      data-testid="scroll-track"
    >
      <div
        role="scrollbar"
        aria-label="Scroll the conversation"
        aria-orientation="vertical"
        aria-controls={target.current?.id}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(
          (box.top / Math.max(1, (target.current?.clientHeight ?? 1) - box.height)) * 100,
        )}
        className="absolute right-0.5 flex w-5 cursor-grab touch-none justify-center active:cursor-grabbing"
        style={{ top: box.top, height: box.height }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, scroll: box.top };
          setHeld(true);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          scrollToTrack(
            target.current,
            drag.current.scroll + e.clientY - drag.current.y,
            box.height,
          );
        }}
        onPointerUp={() => {
          drag.current = null;
          setHeld(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setHeld(false);
        }}
        data-testid="scroll-handle"
      >
        <span
          className={`block h-full rounded-full transition-[width,background-color] duration-150 ${
            held ? "w-2.5 bg-gold" : "w-1.5 bg-gold/45"
          }`}
        />
      </div>
    </div>
  );
}
