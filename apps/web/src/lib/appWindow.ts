/**
 * Hearth's own app window (the desktop icon and app menu entry the installer makes, 11-22: the
 * beginner never left Chrome). The installer's launcher opens Hearth with window=app; this
 * window remembers it (its own browser profile, so a normal browser tab never does).
 */
const KEY = "hearth-app-window";

/** At start: notes the app window from its address, and takes the marker out of the address. */
export function noteAppWindow(loc: Location = window.location) {
  try {
    const url = new URL(loc.href);
    if (url.searchParams.get("window") !== "app") return;
    localStorage.setItem(KEY, "1");
    url.searchParams.delete("window");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch {
    /* storage or history blocked: nothing to remember */
  }
}

/** This is Hearth's own app window (or an installed app), not a browser tab. */
export function inAppWindow(): boolean {
  try {
    if (localStorage.getItem(KEY) === "1") return true;
  } catch {
    /* storage blocked */
  }
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}
