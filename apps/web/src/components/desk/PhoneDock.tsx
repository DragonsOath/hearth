import { useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { ChevronDown, PanelsTopLeft } from "lucide-react";
import { useWorkspace } from "../../data/api";
import { usePhone } from "../../lib/media";
import { cx } from "../ui";
import { LairSystems } from "./Desk";
import { WorkspaceDock } from "./groups";
import { deskSearch, keyOf, panelsFrom, withPanel } from "./layout";
import { panelOf } from "./links";

/**
 * The row under the top bar. On a phone (11-15, the owner) it also has a Panels drop-down: the
 * same bubbles as the desktop Lair (Ember's panels, then your systems), wrapping down the screen
 * instead of running off the side. Tapping one opens it and folds the list away again.
 */
export function PhoneDock() {
  const phone = usePhone();
  const ws = useWorkspace().data;
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  if (!phone || !ws || !ws.services.length) return <WorkspaceDock />;
  const current = pathname === "/" ? panelsFrom(params) : [];
  const openKeys = current.map(keyOf);
  // Joins the phone's ring of panels (swipe between them) and comes to the front.
  const hrefOf = (key: string) => {
    const panel = panelOf(key);
    if (!panel) return "/";
    const base = pathname === "/" ? new URLSearchParams(params) : new URLSearchParams();
    base.delete("view");
    return `/${deskSearch(base, withPanel(current, panel), keyOf(panel))}`;
  };
  return (
    <WorkspaceDock
      panelsButton={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="phone-panels"
          className={cx(
            "flex min-h-9 items-center gap-2 rounded-full border px-3 text-[0.8rem]",
            open ? "border-gold bg-gold/15 text-gold" : "border-gold/40 text-gold",
          )}
          data-testid="phone-panels-toggle"
        >
          <PanelsTopLeft strokeWidth={1.35} className="h-4 w-4" aria-hidden />
          Panels
          <ChevronDown
            strokeWidth={1.5}
            className={cx("h-4 w-4 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      }
      panelsList={
        open ? (
          <div id="phone-panels" className="mt-2" data-testid="phone-panels">
            <LairSystems
              ws={ws}
              open={openKeys}
              wrap
              hrefOf={hrefOf}
              onPick={() => setOpen(false)}
            />
          </div>
        ) : null
      }
    />
  );
}
