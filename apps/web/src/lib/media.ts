import { useSyncExternalStore } from "react";

/**
 * A phone: narrower than the narrowest tablet held upright (11-13: no War Room on a phone).
 * Tablets, upright or sideways, get the desktop layout (11-15). Matches Tailwind's md (index.css).
 */
export const PHONE_QUERY = "(max-width: 599.98px)";

/**
 * A phone as a device, for its own look (Settings > Themes, 11-16): a touch screen whose shorter
 * side is phone-sized. Read from the screen, not the window, so turning the phone sideways keeps
 * the phone's look, and a narrow desktop window keeps the desktop's.
 */
export function isPhoneDevice(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  const short = Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0);
  return window.matchMedia("(pointer: coarse)").matches && short > 0 && short < 600;
}

/** Whether this is a phone (tablets and up are not). */
export function usePhone(): boolean {
  return useMedia(PHONE_QUERY, false);
}

/** Whether a media query matches now, kept current as the window changes. */
export function useMedia(query: string, fallback = true): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      // Some browsers (and remote-desktop shims) hand back a list without change events: the
      // value is then read once, never followed, instead of the page failing to start.
      if (typeof m.addEventListener !== "function") return () => undefined;
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

/**
 * True only when the device has a touchscreen and no mouse or trackpad (a phone or tablet
 * on its own keyboard). A browser that reports no pointer at all, as Chrome does inside a
 * remote desktop session, is a desktop with a physical keyboard, not a phone.
 */
export function isTouchOnly(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return (
    window.matchMedia("(any-pointer: coarse)").matches &&
    !window.matchMedia("(any-pointer: fine)").matches
  );
}
