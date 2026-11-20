import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "../../ui";

/**
 * A row of posters or faces that moves with arrows, not a scrollbar (11-19, the owner: "no
 * sliders just arrows in the gaps of the rows"). The row still scrolls by touch, trackpad and
 * keyboard; the arrows sit in the gap under it, one at each end, and dim at the ends.
 */
export function Rail({
  label,
  children,
  className,
  testId,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const row = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setEnds({
      start: el.scrollLeft <= 2,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
    });
  }, []);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, children]);
  const go = (dir: 1 | -1) => {
    const el = row.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };
  const arrow = (dir: 1 | -1) => {
    const off = dir < 0 ? ends.start : ends.end;
    return (
      <button
        type="button"
        onClick={() => go(dir)}
        disabled={off}
        aria-label={`${label}: ${dir < 0 ? "back" : "more"}`}
        className={cx(
          "grid h-8 w-8 place-items-center rounded-full border border-line-strong bg-panel/90 text-ink shadow-md transition-all hover:scale-105 hover:border-gold hover:bg-gold hover:text-bg",
          off && "pointer-events-none opacity-25",
        )}
        data-testid={`rail-${dir < 0 ? "back" : "more"}`}
      >
        {dir < 0 ? (
          <ChevronLeft className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden />
        )}
      </button>
    );
  };
  return (
    <div className={className} data-testid={testId}>
      <ul
        ref={row}
        onScroll={measure}
        tabIndex={0}
        aria-label={label}
        className="-mx-1 flex snap-x gap-3 overflow-x-auto scroll-smooth px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </ul>
      {!(ends.start && ends.end) && (
        <div className="mt-1 flex justify-between">
          {arrow(-1)}
          {arrow(1)}
        </div>
      )}
    </div>
  );
}
