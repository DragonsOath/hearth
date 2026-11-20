import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Search, X } from "lucide-react";
import { useMedia } from "../../lib/media";
import { cx } from "../ui";

/**
 * Hearth's own picker for every drop-down on a touch screen (11-15, the owner: "get rid of the
 * generic Android pop ups and make Hearth themed ones"). The page keeps its ordinary <select>
 * elements, so forms, labels, keyboards and tests behave as before; a tap on one opens this sheet
 * instead of the phone's own list, and a choice is handed back to the <select> exactly as if it
 * had been picked there (its change event fires, so every existing handler runs).
 *
 * A <select multiple>, a disabled one, or one marked data-native-picker keeps the phone's own.
 */

const TOUCH = "(pointer: coarse)";
/** A finger that moves this far is scrolling, not tapping. */
const SLOP = 10;
/** Longer lists get a filter box. */
const FILTER_FROM = 12;

interface Item {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
}

function itemsOf(sel: HTMLSelectElement): Item[] {
  return Array.from(sel.options).map((o) => ({
    value: o.value,
    label: o.label || o.text,
    disabled: o.disabled || Boolean((o.parentElement as HTMLOptGroupElement | null)?.disabled),
    group:
      o.parentElement instanceof HTMLOptGroupElement
        ? o.parentElement.label || undefined
        : undefined,
  }));
}

/** What the drop-down is for, as its label says: aria-label, a <label>, or aria-labelledby. */
function titleOf(sel: HTMLSelectElement): string {
  const aria = sel.getAttribute("aria-label");
  if (aria) return aria;
  const by = sel.getAttribute("aria-labelledby");
  if (by) {
    const t = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");
    if (t) return t;
  }
  // A <label> wrapped round the drop-down holds its options' text too: only its own words count.
  const owner = sel.labels?.[0];
  if (owner) {
    const copy = owner.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("select, option").forEach((n) => n.remove());
    const label = copy.textContent?.replace(/\s+/g, " ").trim();
    if (label) return label.slice(0, 80);
  }
  return sel.title || "Choose one";
}

/** Gives the <select> a value as if it were picked there: React's onChange sees it. */
function choose(sel: HTMLSelectElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (set) set.call(sel, value);
  else sel.value = value;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

export function TouchPicker() {
  const touch = useMedia(TOUCH, false);
  const [open, setOpen] = useState<HTMLSelectElement>();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!touch) return;
    let start: { sel: HTMLSelectElement; x: number; y: number } | undefined;
    const pick = (e: TouchEvent) => {
      const t = e.target instanceof Element ? e.target.closest("select") : null;
      if (!t || t.disabled || t.multiple || t.hasAttribute("data-native-picker")) return;
      // Stops the phone's own list (and the tap's click), so only Hearth's sheet opens.
      e.preventDefault();
      const p = e.touches[0];
      start = p ? { sel: t, x: p.clientX, y: p.clientY } : undefined;
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      if (start && p && Math.hypot(p.clientX - start.x, p.clientY - start.y) > SLOP)
        start = undefined;
    };
    const end = () => {
      if (!start) return;
      const sel = start.sel;
      start = undefined;
      sel.focus({ preventScroll: true });
      setFilter("");
      setOpen(sel);
    };
    // Not passive: preventDefault must work. Capture: before any of the page's own handlers.
    document.addEventListener("touchstart", pick, { capture: true, passive: false });
    document.addEventListener("touchmove", move, { capture: true, passive: true });
    document.addEventListener("touchend", end, { capture: true });
    document.addEventListener("touchcancel", () => (start = undefined), { capture: true });
    return () => {
      document.removeEventListener("touchstart", pick, { capture: true });
      document.removeEventListener("touchmove", move, { capture: true });
      document.removeEventListener("touchend", end, { capture: true });
    };
  }, [touch]);

  if (!open) return null;
  return createPortal(
    <Sheet
      sel={open}
      filter={filter}
      onFilter={setFilter}
      onClose={() => {
        open.focus({ preventScroll: true });
        setOpen(undefined);
      }}
    />,
    hostFor(open),
  );
}

/**
 * Where the picker is drawn. A modal <dialog> (a Sheet: a title's details, a request) sits in the
 * browser's top layer, above everything else on the page whatever its z-index, so a picker drawn
 * on the page opened behind it, unseen (11-16, the owner: the root folder and quality drop-downs
 * in Seerr's request sheet "won't open"). Inside the drop-down's own open dialog, or else the
 * topmost modal one, it shows on top.
 */
function hostFor(sel: HTMLSelectElement): Element {
  const own = sel.closest("dialog[open]");
  if (own) return own;
  const modals = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => {
    try {
      return d.matches(":modal");
    } catch {
      return false;
    }
  });
  return modals.at(-1) ?? document.body;
}

function Sheet({
  sel,
  filter,
  onFilter,
  onClose,
}: {
  sel: HTMLSelectElement;
  filter: string;
  onFilter: (f: string) => void;
  onClose: () => void;
}) {
  const items = itemsOf(sel);
  const title = titleOf(sel);
  const current = sel.value;
  const listRef = useRef<HTMLUListElement>(null);
  const shown = filter
    ? items.filter((i) => i.label.toLowerCase().includes(filter.trim().toLowerCase()))
    : items;

  // The chosen one in view when the sheet opens; Escape (or Back on a keyboard) closes it.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[aria-selected='true']")
      ?.scrollIntoView({ block: "center" });
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end bg-black/60 backdrop-blur-[2px]"
      onClick={onClose}
      data-testid="touch-picker"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85dvh] w-full flex-col rounded-t-2xl border-t border-gold/50 bg-panel shadow-[0_-12px_40px_rgba(0,0,0,0.5)]"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="flex justify-center pt-2" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-gold/60" />
        </div>
        <div className="flex items-center gap-3 border-b border-line px-4 pt-1 pb-3">
          <p className="min-w-0 flex-1 truncate text-[0.95rem] font-semibold text-ink">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-muted hover:text-gold"
            data-testid="touch-picker-close"
          >
            <X strokeWidth={1.5} className="h-5 w-5" />
          </button>
        </div>
        {items.length >= FILTER_FROM && (
          <label className="mx-4 mt-3 flex min-h-11 items-center gap-2 rounded-xl border border-line-strong bg-bg/60 px-3">
            <Search strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" aria-hidden />
            <input
              type="search"
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
              placeholder="Filter"
              aria-label={`Filter ${title}`}
              className="min-w-0 flex-1 bg-transparent text-[0.95rem] text-ink outline-none placeholder:text-faint"
            />
          </label>
        )}
        <ul ref={listRef} role="listbox" aria-label={title} className="overflow-y-auto p-2">
          {shown.map((i, n) => {
            const head = i.group && i.group !== shown[n - 1]?.group ? i.group : undefined;
            const on = i.value === current;
            return (
              <li key={`${i.value}-${n}`} role="none" className="contents">
                {head && (
                  <p className="px-3 pt-3 pb-1 text-[0.72rem] font-semibold tracking-[0.12em] text-faint uppercase">
                    {head}
                  </p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={i.disabled}
                  onClick={() => {
                    if (!on) choose(sel, i.value);
                    onClose();
                  }}
                  className={cx(
                    "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[0.95rem] transition-colors disabled:opacity-40",
                    on ? "bg-gold/15 text-gold" : "text-ink active:bg-raised",
                  )}
                  data-testid="touch-picker-option"
                >
                  <span className="min-w-0 flex-1">{i.label || " "}</span>
                  {on && <Check strokeWidth={2} className="h-4 w-4 shrink-0" aria-hidden />}
                </button>
              </li>
            );
          })}
          {!shown.length && (
            <li className="px-3 py-4 text-[0.88rem] text-faint">Nothing matches that.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
