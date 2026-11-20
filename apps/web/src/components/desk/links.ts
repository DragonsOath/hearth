import { useCallback } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useMedia } from "../../lib/media";
import { deskSearch, keyOf, panelsFrom, withPanel, type Panel } from "./layout";

/**
 * The desk (several panels beside the conversation): a desktop-width window, or any tablet,
 * upright or sideways (11-15, the owner: "desktop period when on tablet"). A tablet is a touch
 * screen at least 600px both ways, so a phone on its side keeps the phone's layout.
 */
export const DESK_QUERY =
  "(min-width: 1024px), (pointer: coarse) and (min-width: 600px) and (min-height: 600px)";

export function useDesk(): boolean {
  return useMedia(DESK_QUERY, true);
}

/** Where an evidence or progress reference opens when it is not a panel. */
export function pageOf(ref?: string): string | undefined {
  if (!ref) return undefined;
  const i = ref.indexOf(":");
  const [kind, id] = [ref.slice(0, i), ref.slice(i + 1)];
  if (kind === "incident") return `/incidents/${id}`;
  if (kind === "job") return `/jobs/${id}`;
  if (kind === "memory") return "/memory";
  if (kind === "draft") return "/memory/import";
  if (kind === "host") return "/systems";
  if (ref === "backups") return "/backups";
  return undefined;
}

export function panelOf(ref?: string): Panel | undefined {
  if (!ref) return undefined;
  const i = ref.indexOf(":");
  const kind = ref.slice(0, i);
  const id = ref.slice(i + 1);
  return (kind === "service" || kind === "project" || kind === "workspace" || kind === "tool") && id
    ? { kind, id }
    : undefined;
}

/**
 * The link for a reference. A service or project opens as a panel: on the
 * desk it joins what is already open (and becomes the focus); on smaller
 * screens it replaces the single panel, as before. Anything else opens its page.
 */
export function usePanelHref(): (ref?: string, tab?: string) => string | undefined {
  const desk = useDesk();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  return useCallback(
    (ref?: string, tab?: string) => {
      const panel = panelOf(ref);
      if (!panel) return pageOf(ref);
      const add = tab ? { ...panel, tab } : panel;
      // A workspace has no single-panel link of its own: it opens as the one panel.
      if (!desk && (add.kind === "workspace" || add.kind === "tool")) {
        const k = `${add.kind}:${encodeURIComponent(add.id)}`;
        const withTab = tab ? `${k}@${encodeURIComponent(tab)}` : k;
        return `/?panels=${encodeURIComponent(withTab)}&focus=${encodeURIComponent(k)}`;
      }
      if (!desk) {
        return `/?${add.kind}=${encodeURIComponent(add.id)}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`;
      }
      const base = pathname === "/" ? params : new URLSearchParams();
      const current = pathname === "/" ? panelsFrom(params) : [];
      return `/${deskSearch(base, withPanel(current, add), keyOf(add))}`;
    },
    [desk, pathname, params],
  );
}

/**
 * In the Lair, a system's link is an on/off switch: on opens its panel and brings it to the
 * front, off closes it. Turning the last one off keeps you in the Lair. Elsewhere it simply
 * opens the system, as usePanelHref does.
 */
export function usePanelToggle(): (ref: string) => { href: string; open: boolean } {
  const desk = useDesk();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const add = usePanelHref();
  return useCallback(
    (ref: string) => {
      const panel = panelOf(ref);
      const inLair = desk && pathname === "/" && params.has("panels");
      const current = inLair ? panelsFrom(params) : [];
      const open = Boolean(panel) && current.some((p) => keyOf(p) === keyOf(panel!));
      if (!panel || !open) return { href: add(ref) ?? "/", open: false };
      const rest = current.filter((p) => keyOf(p) !== keyOf(panel));
      if (!rest.length) {
        const next = new URLSearchParams(params);
        next.set("panels", "");
        next.delete("focus");
        return { href: `/?${next.toString()}`, open: true };
      }
      return { href: `/${deskSearch(params, rest, keyOf(rest.at(-1)!))}`, open: true };
    },
    [desk, pathname, params, add],
  );
}
