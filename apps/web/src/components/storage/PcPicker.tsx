import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { usePcs, type PcInfo } from "../../data/pcs";
import { PcBadge } from "../devices/PcBadge";
import { cx } from "../ui";

/**
 * Which PC Storage & Files shows: this one and every PC that joined your Hearth, each with its
 * own icon. A PC that is offline is listed but cannot be picked until it is back.
 */
export function PcPicker({ value, onChange }: { value: string; onChange: (pc: string) => void }) {
  const q = usePcs();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const data = q.data;
  if (!data) return null;
  const all: { id: string; pc: PcInfo; here: boolean; online: boolean }[] = [
    { id: "", pc: data.hub, here: true, online: true },
    ...data.pcs.map((p) => ({ id: p.id, pc: p, here: false, online: p.online !== false })),
  ];
  const current = all.find((x) => x.id === value) ?? all[0]!;
  const single = all.length === 1;
  return (
    <span ref={box} className="relative inline-flex">
      <button
        type="button"
        data-testid="storage-host"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Showing ${current.pc.name}. Choose a PC`}
        disabled={single}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "inline-flex min-h-10 items-center gap-2 rounded-xl border bg-raised py-1 pl-1.5 pr-3 text-[0.84rem] text-ink transition-colors",
          open ? "border-gold" : "border-line-strong",
          !single && "hover:border-gold",
        )}
      >
        <PcBadge pc={current.pc} size={26} showName={false} />
        <span className="font-medium">{current.pc.name}</span>
        {current.here && <span className="text-[0.72rem] text-muted">This PC</span>}
        {!single && (
          <ChevronDown
            className={cx("h-4 w-4 text-muted transition-transform", open && "rotate-180")}
            aria-hidden
          />
        )}
      </button>
      {open && (
        <span
          role="listbox"
          aria-label="PCs"
          data-testid="storage-host-menu"
          className="absolute left-0 top-full z-30 mt-1.5 flex min-w-60 flex-col gap-0.5 rounded-xl border border-line-strong bg-panel p-1.5 shadow-xl"
        >
          {all.map((x) => (
            <button
              key={x.id || "here"}
              type="button"
              role="option"
              aria-selected={x.id === current.id}
              disabled={!x.online}
              onClick={() => {
                onChange(x.id);
                setOpen(false);
              }}
              className={cx(
                "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[0.84rem] text-ink",
                x.id === current.id ? "bg-gold/10" : "hover:bg-raised",
                !x.online && "cursor-not-allowed",
              )}
            >
              <PcBadge pc={x.pc} size={30} showName={false} offline={!x.online} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{x.pc.name}</span>
                <span className="block text-[0.72rem] text-muted">
                  {x.here ? "This PC" : x.online ? x.pc.os || "Joined PC" : "Offline"}
                </span>
              </span>
              {x.id === current.id && <Check className="h-4 w-4 text-gold" aria-hidden />}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
