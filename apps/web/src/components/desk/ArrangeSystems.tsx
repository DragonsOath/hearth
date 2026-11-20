import { useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { Button, cx } from "../ui";
import { Modal } from "../workspace/dialogs";
import { moveTo } from "../../lib/lairUsage";

export interface ArrangeEntry {
  key: string;
  name: string;
  icon: ReactNode;
}

/**
 * Arrange (11-04): one box with the whole list. Drag a system by its handle (mouse or
 * touch; arrow keys on the handle move it too), then Done puts that order on the bar. Most used
 * first goes back to the automatic order; Cancel keeps the bar as it was.
 */
export function ArrangeSystems({
  entries,
  automatic,
  onDone,
  onCancel,
}: {
  entries: ArrangeEntry[];
  /** The most-used-first order, for the reset button. */
  automatic: string[];
  /** The chosen order, or undefined for most used first. */
  onDone: (order: string[] | undefined) => void;
  onCancel: () => void;
}) {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const [order, setOrder] = useState(() => entries.map((e) => e.key));
  const [auto, setAuto] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  const place = (key: string, index: number) => {
    setOrder((o) => moveTo(o, key, index));
    setAuto(false);
  };

  // Which row the pointer is over; near the list's top or bottom edge, scroll it along.
  const follow = (y: number) => {
    const el = list.current;
    if (!el || !dragging) return;
    const box = el.getBoundingClientRect();
    if (y < box.top + 32) el.scrollBy(0, -12);
    else if (y > box.bottom - 32) el.scrollBy(0, 12);
    const rows = [...el.querySelectorAll<HTMLElement>("[data-key]")];
    let index = rows.findIndex((r) => y < r.getBoundingClientRect().bottom);
    if (index < 0) index = rows.length - 1;
    if (index !== order.indexOf(dragging)) place(dragging, index);
  };

  return (
    <Modal title="Arrange the systems" onCancel={onCancel}>
      <p className="mt-1 text-[0.85rem] text-muted">
        Drag them into the order you want on the bar, then press Done.
      </p>
      <ol
        ref={list}
        className="mt-4 flex max-h-[min(60vh,32rem)] flex-col gap-1.5 overflow-y-auto pr-1"
        aria-label="Systems, in order"
        data-testid="lair-arrange-list"
      >
        {order.map((key, i) => {
          const e = byKey.get(key);
          if (!e) return null;
          return (
            <li
              key={key}
              data-key={key}
              data-testid="lair-arrange-item"
              // A mouse can grab the whole row; a finger uses the handle, so the list still scrolls.
              onPointerDown={(ev) => {
                const onHandle = (ev.target as HTMLElement).closest("[data-handle]");
                if (ev.pointerType !== "mouse" && !onHandle) return;
                ev.currentTarget.setPointerCapture(ev.pointerId);
                setDragging(key);
              }}
              onPointerMove={(ev) => follow(ev.clientY)}
              onPointerUp={() => setDragging(null)}
              onPointerCancel={() => setDragging(null)}
              className={cx(
                "flex min-h-11 cursor-grab items-center gap-2 rounded-xl border bg-bg px-2 text-[0.88rem] text-ink transition-colors select-none active:cursor-grabbing",
                dragging === key ? "border-gold bg-gold/15 shadow-lg" : "border-line",
              )}
            >
              <button
                type="button"
                aria-label={`Move ${e.name}: drag, or use the up and down arrow keys`}
                className="flex h-9 w-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted hover:text-gold focus-visible:text-gold active:cursor-grabbing"
                data-testid="lair-arrange-handle"
                data-handle
                onKeyDown={(ev) => {
                  if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
                  ev.preventDefault();
                  place(key, ev.key === "ArrowUp" ? i - 1 : i + 1);
                  const btn = ev.currentTarget;
                  requestAnimationFrame(() => btn.focus());
                }}
              >
                <GripVertical className="h-4 w-4" />
              </button>
              <span className="w-5 shrink-0 text-right text-[0.75rem] text-muted tabular-nums">
                {i + 1}
              </span>
              {e.icon}
              <span className="min-w-0 truncate">{e.name}</span>
            </li>
          );
        })}
      </ol>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setOrder(automatic);
            setAuto(true);
          }}
          className="min-h-9 rounded-full px-2 text-[0.8rem] text-gold underline-offset-2 hover:underline"
          data-testid="lair-arrange-reset"
        >
          Most used first
        </button>
        <span className="flex-1" />
        <Button tone="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          tone="primary"
          onClick={() => onDone(auto ? undefined : order)}
          data-testid="lair-arrange-done"
        >
          Done
        </Button>
      </div>
    </Modal>
  );
}
