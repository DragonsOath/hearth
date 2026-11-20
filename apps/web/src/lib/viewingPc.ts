import { usePcs } from "../data/pcs";

/**
 * Which PC this window belongs to. A linked PC opens your Hearth (on your main PC) with
 * `?from=<its id>`; that is remembered here so the title and sidebar name the PC you are at,
 * not the PC your Hearth lives on.
 */
const KEY = "hearth.viewingPc";

/** Runs once at startup: keeps `?from=` and takes it out of the address. */
export function captureViewingPc() {
  try {
    const url = new URL(window.location.href);
    const from = url.searchParams.get("from");
    if (!from) return;
    window.localStorage.setItem(KEY, from);
    url.searchParams.delete("from");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch {
    // Storage blocked: the window just shows your Hearth's name.
  }
}

export function viewingPcId(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The id of the linked PC this window was opened from, or null (your main Hearth's window). */
export function useViewingPcId(): string | null {
  const id = viewingPcId();
  const { data } = usePcs();
  if (!id || !data) return null;
  return data.pcs.some((p) => p.id === id) ? id : null;
}

/** The name of the linked PC this window was opened from, or null (your main Hearth's window). */
export function useViewingPcName(): string | null {
  const id = viewingPcId();
  const { data } = usePcs();
  if (!id || !data) return null;
  return data.pcs.find((p) => p.id === id)?.name ?? null;
}
