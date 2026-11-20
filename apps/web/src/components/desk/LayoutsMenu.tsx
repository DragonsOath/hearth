import { useEffect, useRef, useState } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import {
  useDeleteDeskLayout,
  useDeskLayouts,
  useSaveDeskLayout,
  type DeskLayout,
} from "../../data/desk";
import { parsePanels, serializePanels, type Panel } from "./layout";

/**
 * Save the current arrangement under a name, or return to one saved earlier.
 * Saved on the server, so another computer finds the same layouts. Opening a
 * layout restores its panels and dock; the conversation stays what it is.
 */
export function LayoutsMenu({
  panels,
  dock,
  onOpen,
}: {
  panels: Panel[];
  dock: { width: number; mode: "docked" | "min" | "wide" };
  onOpen: (panels: Panel[], dock?: DeskLayout["dock"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const layouts = useDeskLayouts();
  const save = useSaveDeskLayout();
  const remove = useDeleteDeskLayout();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-8 items-center gap-1.5 rounded-full border border-line px-3 text-[0.76rem] text-muted hover:border-gold/50 hover:text-gold"
      >
        <Bookmark strokeWidth={1.5} className="h-3.5 w-3.5" /> Layouts
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Saved layouts"
          className="absolute top-10 right-0 z-30 w-80 rounded-xl border border-line-strong bg-panel p-3 shadow-2xl"
        >
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (!n || !panels.length) return;
              save.mutate(
                { name: n, panels: serializePanels(panels), dock },
                { onSuccess: () => setName("") },
              );
            }}
          >
            <label className="sr-only" htmlFor="desk-layout-name">
              Layout name
            </label>
            <input
              id="desk-layout-name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              placeholder={panels.length ? "Name this layout" : "Open a panel first"}
              disabled={!panels.length}
              className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-bg/60 px-3 text-[0.84rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!name.trim() || !panels.length || save.isPending}
              className="min-h-9 rounded-lg bg-gold px-3 text-[0.82rem] text-bg disabled:opacity-40"
            >
              Save
            </button>
          </form>
          {save.error && (
            <p role="alert" className="mt-2 text-[0.76rem] text-bad">
              {save.error.message}
            </p>
          )}
          <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto" aria-label="Layouts">
            {(layouts.data ?? []).map((l) => {
              const count = parsePanels(l.panels).length;
              return (
                <li key={l.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(parsePanels(l.panels), l.dock);
                      setOpen(false);
                    }}
                    className="flex min-h-10 min-w-0 flex-1 flex-col justify-center rounded-lg px-2 text-left hover:bg-raised"
                  >
                    <span className="truncate text-[0.86rem] text-ink">{l.name}</span>
                    <span className="text-[0.72rem] text-faint">
                      {count} {count === 1 ? "panel" : "panels"}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(l.id)}
                    aria-label={`Delete layout ${l.name}`}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-faint hover:text-bad"
                  >
                    <Trash2 strokeWidth={1.5} className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
            {layouts.data && !layouts.data.length && (
              <li className="px-2 py-1 text-[0.8rem] text-faint">No saved layouts yet.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
