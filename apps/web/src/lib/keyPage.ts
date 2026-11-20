import type { Service } from "@dragon-control/core";
import { openTarget } from "./format";

/**
 * The page inside an app where its key is made or shown, at the address "Open" uses (the
 * reverse proxy first, then the app on your network). Without a known key page, the app's
 * own address: you still land in the right app.
 */
export function keyPageHref(
  service: Pick<Service, "name" | "publicUrl" | "localUrl"> | undefined,
  keyPage: string | undefined,
): string | undefined {
  if (!service) return undefined;
  const base = openTarget(service)?.href;
  if (!base) return undefined;
  if (!keyPage) return base;
  try {
    return new URL(keyPage, base).toString();
  } catch {
    return base;
  }
}

/** Wide enough to put the app and Hearth side by side. Phones, tablets and the app open a tab. */
export function canOpenBeside(win: Pick<Window, "innerWidth" | "navigator"> = window): boolean {
  return win.innerWidth >= 1024 && !/HearthApp\//.test(win.navigator.userAgent);
}

/**
 * Opens an app in its own window over the left half of the screen, so Hearth's form (on the
 * right) stays in view while you copy the key. The app is another site, so it cannot read
 * Hearth's page. Returns the window, so Hearth can close it once the key is saved; on narrow screens, a new tab.
 */
export function openBeside(url: string): Window | null {
  if (!canOpenBeside()) {
    window.open(url, "_blank", "noopener");
    return null;
  }
  const s = window.screen as Screen & { availLeft?: number; availTop?: number };
  const width = Math.floor(s.availWidth / 2);
  const win = window.open(
    url,
    "hearth-key-page",
    `popup,width=${width},height=${s.availHeight},left=${s.availLeft ?? 0},top=${s.availTop ?? 0}`,
  );
  win?.focus();
  return win;
}
