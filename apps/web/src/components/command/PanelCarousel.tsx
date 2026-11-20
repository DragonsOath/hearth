import {
  Activity,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";
import { cx } from "../ui";
import { busyWithText, lockDirection, ownsHorizontal, swipeStep, wrapIndex } from "../../lib/swipe";

/**
 * The phone's Lair as a ring: Ember, then every open panel in the address's order. Swipe sideways
 * (or use the arrows, the dots or the list) to move round it; it wraps both ways. What is open and
 * which one shows stay in the address, so back, refresh and links land in the same place.
 *
 * Ember's conversation is always kept (hidden with CSS, never paused), so an answer being written
 * carries on while you look at a panel. The panels you visited last are kept too (React's
 * Activity: hidden, their effects and polling paused, their scroll, tabs and forms kept); older
 * ones are let go and load again when you come back to them.
 */

/** Ember's place in the ring. */
export const CHAT = "chat";
/** Panels kept alive besides the one showing: enough for a loop of four without reloading. */
export const KEEP_ALIVE = 4;

export interface CarouselItem {
  key: string;
  label: string;
}

export function PanelCarousel({
  items,
  active,
  onGo,
  chat,
  renderPanel,
  trailing,
}: {
  items: CarouselItem[];
  active: string;
  /** Show this item (`step`: the way it was reached, for the slide; 0 for a jump). */
  onGo: (key: string, step: -1 | 0 | 1) => void;
  /** Ember's side: always mounted. */
  chat: ReactNode;
  renderPanel: (key: string) => ReactNode;
  /** Shown at the end of the bar (Minimize all). */
  trailing?: ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    items.findIndex((i) => i.key === active),
  );
  const current = items[index];
  const count = items.length;

  // The panels visited last, newest first: they stay mounted (hidden) so coming back is instant.
  const [recent, setRecent] = useState<string[]>([]);
  if (active !== CHAT && recent[0] !== active)
    setRecent((prev) => [active, ...prev.filter((k) => k !== active)].slice(0, KEEP_ALIVE));
  const open = new Set(items.map((i) => i.key));
  const alive = recent.filter((k) => open.has(k));

  // The slide in: which way the new one comes from, until its animation ends.
  const [slide, setSlide] = useState<{ key: string; from: "left" | "right" }>();
  const [list, setList] = useState(false);

  // The gesture: where it started, which way it locked, and whether it may switch at all.
  const gesture = useRef<{
    x: number;
    y: number;
    id: number;
    lock?: "x" | "y";
    ok: boolean;
  } | null>(null);
  const swiped = useRef(false);
  const shownItem = () =>
    area.current?.querySelector<HTMLElement>(`[data-carousel-item="${CSS.escape(active)}"]`);
  const resetDrag = () => {
    const el = shownItem();
    if (el) el.style.transform = "";
  };

  // One gesture, from a finger (touch events: they keep coming while the browser scrolls, where
  // pointer events would be cancelled inside a scrolling panel) or from a mouse or pen.
  const start = (x: number, y: number, id: number, target: EventTarget | null) => {
    swiped.current = false;
    if (count < 2) return;
    gesture.current = {
      x,
      y,
      id,
      ok: !ownsHorizontal(target, area.current) && !busyWithText(),
    };
  };
  const move = (x: number, y: number, id: number) => {
    const g = gesture.current;
    if (!g || !g.ok || g.id !== id) return;
    const dx = x - g.x;
    g.lock ??= lockDirection(dx, y - g.y);
    if (g.lock !== "x") return;
    // A short, damped follow so the panel feels attached to the finger; never far.
    const el = shownItem();
    if (el && !reducedMotion()) el.style.transform = `translateX(${Math.round(dx * 0.35)}px)`;
  };
  const end = (x: number, id: number) => {
    const g = gesture.current;
    gesture.current = null;
    resetDrag();
    if (!g || !g.ok || g.lock !== "x" || g.id !== id) return;
    const step = swipeStep(x - g.x);
    if (step === 0 || busyWithText()) return;
    swiped.current = true;
    go(step);
  };
  const cancel = () => {
    gesture.current = null;
    resetDrag();
  };
  const notTouch = (e: PointerEvent<HTMLDivElement>) =>
    e.pointerType !== "touch" && (e.pointerType !== "mouse" || e.button === 0);

  // Once a finger is clearly moving sideways, the move is the ring's: the browser must not also
  // scroll, or treat it as "swipe to go back" (React's touch listeners cannot prevent that).
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const hold = (e: TouchEvent) => {
      if (gesture.current?.ok && gesture.current.lock === "x" && e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", hold, { passive: false });
    return () => el.removeEventListener("touchmove", hold);
  }, []);

  // Hiding (display: none) loses where a list was scrolled, so the ring keeps it: each item's
  // scrolled areas and the page's own scroll when it was left, put back when it shows again.
  const scrolls = useRef(new Map<string, { page: number; areas: [Element, number][] }>());
  const remember = (key: string) => {
    const item = area.current?.querySelector(`[data-carousel-item="${CSS.escape(key)}"]`);
    if (!item) return;
    const areas: [Element, number][] = [];
    for (const el of item.querySelectorAll("*"))
      if (el.scrollTop > 0) areas.push([el, el.scrollTop]);
    scrolls.current.set(key, { page: window.scrollY, areas });
  };
  useLayoutEffect(() => {
    const saved = scrolls.current.get(active);
    if (!saved) return;
    // A panel shown again may refresh its content first; wait (briefly) until it is tall enough.
    let frame = 0;
    let tries = 0;
    const restore = () => {
      for (const [el, top] of saved.areas) if (el.isConnected) el.scrollTop = top;
      const doc = document.scrollingElement;
      if (doc && (doc.scrollHeight - doc.clientHeight >= saved.page || tries > 60)) {
        window.scrollTo({ top: saved.page, behavior: "instant" });
        return;
      }
      tries += 1;
      frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // A different item showing: slide it in from the side it came from.
  const lastStep = useRef<-1 | 0 | 1>(0);
  const goWith = (key: string, step: -1 | 0 | 1) => {
    lastStep.current = step;
    remember(active);
    onGo(key, step);
  };
  const go = (step: -1 | 1) => {
    if (count > 1) goWith(items[wrapIndex(index, step, count)]!.key, step);
  };
  const shown = useRef(active);
  useEffect(() => {
    if (shown.current === active) return;
    shown.current = active;
    if (lastStep.current !== 0 && !reducedMotion())
      setSlide({ key: active, from: lastStep.current > 0 ? "right" : "left" });
    lastStep.current = 0;
  }, [active]);

  const position = `${index + 1}/${count}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center gap-1.5" role="group" aria-label="Open panels">
        <button
          type="button"
          onClick={() => active !== CHAT && goWith(CHAT, 0)}
          aria-pressed={active === CHAT}
          aria-label={`Show ${items[0]?.label ?? "Ember"}`}
          className={cx(
            "flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[0.84rem]",
            active === CHAT
              ? "border-gold/60 bg-gold/10 text-gold"
              : "border-line text-muted hover:text-ink",
          )}
          data-testid="carousel-ember"
          {...(active === CHAT ? { "data-phone-collapse": "" } : {})}
        >
          <MessageCircle strokeWidth={1.5} className="h-4 w-4" aria-hidden />
          <span className="max-w-[5.5rem] truncate">{items[0]?.label ?? "Ember"}</span>
        </button>
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={count < 2}
          aria-label="Previous panel"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line text-muted hover:text-ink disabled:opacity-40"
          data-testid="carousel-prev"
        >
          <ChevronLeft strokeWidth={1.5} className="h-5 w-5" />
        </button>
        <div className="relative min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setList((o) => !o)}
            aria-haspopup="dialog"
            aria-expanded={list}
            aria-label={`${current?.label ?? ""}, ${index + 1} of ${count}. Choose a panel`}
            className="flex h-11 w-full min-w-0 flex-col items-center justify-center rounded-lg border border-gold/40 px-2 text-[0.84rem] text-ink"
            data-testid="carousel-current"
          >
            <span className="flex w-full min-w-0 items-center justify-center gap-1.5">
              <span className="truncate">{current?.label}</span>
              <span className="shrink-0 text-faint tabular-nums">{position}</span>
            </span>
            <span className="mt-0.5 flex gap-1" aria-hidden>
              {items.map((item, i) => (
                <span
                  key={item.key}
                  className={cx(
                    "h-1.5 w-1.5 rounded-full",
                    i === index ? "bg-gold" : "bg-line-strong",
                  )}
                />
              ))}
            </span>
          </button>
          {list && (
            <QuickList
              items={items}
              active={active}
              onPick={(key) => {
                setList(false);
                if (key !== active) goWith(key, 0);
              }}
              onClose={() => setList(false)}
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={count < 2}
          aria-label="Next panel"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-line text-muted hover:text-ink disabled:opacity-40"
          data-testid="carousel-next"
        >
          <ChevronRight strokeWidth={1.5} className="h-5 w-5" />
        </button>
        {trailing && (
          // With the chat in front, Minimize all is in the chat's menu instead (11-18).
          <span className="contents" {...(active === CHAT ? { "data-phone-collapse": "" } : {})}>
            {trailing}
          </span>
        )}
      </div>
      {/* Which panel shows, for screen readers, each time it changes. */}
      <p className="sr-only" aria-live="polite" data-testid="carousel-announce">
        {current ? `Showing ${current.label}, ${index + 1} of ${count}` : ""}
      </p>
      <div
        ref={area}
        className="relative flex min-h-0 flex-1 touch-pan-y flex-col"
        onTouchStart={(e) => {
          const t = e.changedTouches[0];
          if (t && e.touches.length === 1) start(t.clientX, t.clientY, t.identifier, e.target);
          else cancel();
        }}
        onTouchMove={(e) => {
          const t = e.changedTouches[0];
          if (t) move(t.clientX, t.clientY, t.identifier);
        }}
        onTouchEnd={(e) => {
          const t = e.changedTouches[0];
          if (t) end(t.clientX, t.identifier);
        }}
        onTouchCancel={cancel}
        onPointerDown={(e) => notTouch(e) && start(e.clientX, e.clientY, e.pointerId, e.target)}
        onPointerMove={(e) => notTouch(e) && move(e.clientX, e.clientY, e.pointerId)}
        onPointerUp={(e) => notTouch(e) && end(e.clientX, e.pointerId)}
        onPointerCancel={(e) => notTouch(e) && cancel()}
        // A swipe that ends on a button is not also a tap on it.
        onClickCapture={(e) => {
          if (!swiped.current) return;
          swiped.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
        data-testid="carousel"
      >
        <div
          data-carousel-item={CHAT}
          className={cx(
            "min-h-0 flex-1 flex-col",
            active === CHAT ? "flex" : "hidden",
            slide?.key === CHAT && `lair-slide-from-${slide.from}`,
          )}
          onAnimationEnd={() => setSlide(undefined)}
        >
          {chat}
        </div>
        {alive.map((key) => (
          <Activity key={key} mode={key === active ? "visible" : "hidden"}>
            <div
              data-carousel-item={key}
              className={cx(
                "flex min-h-0 flex-1 flex-col",
                slide?.key === key && `lair-slide-from-${slide.from}`,
              )}
              onAnimationEnd={() => setSlide(undefined)}
            >
              {renderPanel(key)}
            </div>
          </Activity>
        ))}
      </div>
    </div>
  );
}

function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Every open panel, to jump straight to one. Escape or a tap outside closes it. */
function QuickList({
  items,
  active,
  onPick,
  onClose,
}: {
  items: CarouselItem[];
  active: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);
  return (
    <div
      ref={box}
      role="dialog"
      aria-label="Open panels"
      className="absolute inset-x-0 top-12 z-40 rounded-xl border border-gold/40 bg-panel p-1.5 shadow-xl"
      data-testid="carousel-list"
    >
      <ul className="flex max-h-[60dvh] flex-col gap-0.5 overflow-y-auto">
        {items.map((item, i) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onPick(item.key)}
              aria-current={item.key === active ? "true" : undefined}
              className={cx(
                "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[0.9rem]",
                item.key === active ? "bg-gold/10 text-gold" : "text-ink hover:bg-raised",
              )}
            >
              <span className="w-5 shrink-0 text-faint tabular-nums">{i + 1}</span>
              <span className="truncate">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
