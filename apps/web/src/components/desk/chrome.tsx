import { createContext, useContext, type PointerEvent, type ReactNode } from "react";

/**
 * What the desk adds to a workspace frame: unique ids (several panels can be
 * open at once), extra header controls (pin, move, close), focus, and a
 * tighter header. Outside the desk the frame looks and behaves as before.
 */
export interface PanelChrome {
  /** Prefix for element ids, unique per panel. */
  idPrefix: string;
  controls?: ReactNode;
  compact?: boolean;
  focused?: boolean;
  onFocus?: () => void;
  /** Floating windows (conversation mode): the header moves the window. */
  onDragStart?: (e: PointerEvent<HTMLElement>) => void;
  /** Floating windows put their own close in `controls`. */
  hideClose?: boolean;
}

const Ctx = createContext<PanelChrome | null>(null);

export function PanelChromeProvider({
  value,
  children,
}: {
  value: PanelChrome;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanelChrome(): PanelChrome | null {
  return useContext(Ctx);
}
