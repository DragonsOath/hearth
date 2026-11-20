import { useEffect, useRef, useState } from "react";
import { ExternalLink, Sparkles } from "lucide-react";
import type { Service } from "@dragon-control/core";
import { IMPROVE_EVENT, requestPanelHref } from "../dashboards/AppGlance";
import { PremiumCard } from "../AddonSlot";
import { Modal } from "../workspace/dialogs";

/**
 * A basic panel's Improve menu without the Premium package (11-14): Request it (free, the panel
 * request board) and Custom panels, which says what Panel Builder is. The Premium package puts
 * its own menu in this place (slot panel.improve).
 */
export function FreePanelMenu({ service }: { service: Service }) {
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // "Improve this panel" in the basic panel's own text opens this menu.
  useEffect(() => {
    const onAsk = (e: Event) => {
      if ((e as CustomEvent<string>).detail === service.id) setOpen(true);
    };
    window.addEventListener(IMPROVE_EVENT, onAsk);
    return () => window.removeEventListener(IMPROVE_EVENT, onAsk);
  }, [service.id]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const item =
    "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left hover:bg-raised focus-visible:bg-raised";
  return (
    <div className="relative shrink-0" ref={box} data-capture-skip>
      {about && (
        <Modal title="Custom panels" onCancel={() => setAbout(false)}>
          <PremiumCard feature="panel_builder" />
        </Modal>
      )}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Improve this panel"
        title="Improve this panel"
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-gold/45 px-2.5 text-[0.82rem] font-medium text-gold hover:border-gold hover:bg-gold/10"
        data-testid="improve-panel"
      >
        <Sparkles strokeWidth={1.5} className="h-[1.1rem] w-[1.1rem]" aria-hidden />
        <span className="hidden sm:inline">Improve</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Improve this panel"
          className="absolute top-11 right-0 z-30 w-[min(17rem,calc(100vw-2rem))] rounded-xl border border-gold/35 bg-panel p-1.5 shadow-xl"
          data-testid="improve-panel-menu"
        >
          <a
            role="menuitem"
            href={requestPanelHref(service)}
            target="_blank"
            rel="noreferrer"
            className={item}
            onClick={() => setOpen(false)}
            data-testid="improve-panel-request"
          >
            <ExternalLink strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" />
            <span>
              <span className="block text-[0.86rem] text-ink">Request it</span>
              <span className="block text-[0.72rem] text-faint">
                Ask for a full {service.name} panel on the request board
              </span>
            </span>
          </a>
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              setAbout(true);
            }}
            data-testid="improve-panel-custom"
          >
            <Sparkles strokeWidth={1.5} className="h-4 w-4 shrink-0 text-gold" />
            <span>
              <span className="block text-[0.86rem] text-ink">Custom panels</span>
              <span className="block text-[0.72rem] text-faint">
                Build, load or share your own panel: part of Hearth Premium
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
