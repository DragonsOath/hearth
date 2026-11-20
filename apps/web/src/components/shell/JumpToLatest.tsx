import { useEffect, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";

/** How far up (pixels) before the arrow shows: a little scroll is not "away from the bottom". */
const AWAY_PX = 160;

/**
 * The down arrow in a conversation (10-27): shown while you have scrolled up from the newest
 * message; clicking it goes back to the bottom. It sits at the bottom of the scrolling list
 * itself (sticky), so it works in the Lair and in the War Room alike. `as="li"` inside a list.
 */
export function JumpToLatest({
  target,
  as = "div",
  className,
}: {
  target: RefObject<HTMLElement | null>;
  as?: "div" | "li";
  className?: string;
}) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const check = () => setAway(el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX);
    check();
    el.addEventListener("scroll", check, { passive: true });
    // New messages change the height without a scroll event.
    const watch = new ResizeObserver(check);
    watch.observe(el);
    for (const child of Array.from(el.children)) watch.observe(child);
    const added = new MutationObserver(() => {
      for (const child of Array.from(el.children)) watch.observe(child);
      check();
    });
    added.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", check);
      watch.disconnect();
      added.disconnect();
    };
  }, [target]);
  const Tag = as;
  return (
    <Tag
      className={`pointer-events-none sticky bottom-2 z-10 flex justify-end pr-1 sm:justify-center sm:pr-0 ${className ?? ""}`}
      style={{ marginTop: away ? undefined : 0, height: away ? undefined : 0 }}
    >
      {away && (
        <button
          type="button"
          onClick={() => {
            const el = target.current;
            if (!el) return;
            el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            // The bottom can move while it scrolls (this arrow goes away, a message arrives), so
            // finish at the real bottom once the scroll ends.
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              el.scrollTop = el.scrollHeight;
            };
            el.addEventListener("scrollend", finish, { once: true });
            setTimeout(finish, 1000);
          }}
          aria-label="Go to the newest message"
          title="Go to the newest message"
          className="jump-latest pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-gold bg-panel text-gold shadow-[0_6px_20px_rgba(0,0,0,0.55)] hover:bg-gold/15 sm:h-10 sm:w-10 sm:border-gold/50 sm:bg-panel/90 sm:backdrop-blur"
          data-testid="jump-latest"
        >
          <ArrowDown strokeWidth={2.25} className="h-6 w-6 sm:h-5 sm:w-5" aria-hidden />
        </button>
      )}
    </Tag>
  );
}
