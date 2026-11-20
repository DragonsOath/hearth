import { useEffect } from "react";
import { LAYOUT_BROWSER_KEYS } from "@dragon-control/core";
import { api } from "../data/api";

/**
 * The layout arranged in this browser (the Lair's strip order and dock, the home dashboard, the
 * sidebar) kept on this Hearth too, so another Hearth can copy it (Settings, PCs and devices, Copy
 * layout). Sent when it changes: checked every half minute and when the page is hidden.
 */

let lastSent = "";

function read(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    for (const k of LAYOUT_BROWSER_KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) values[k] = v;
    }
  } catch {
    /* storage blocked: nothing to keep */
  }
  return values;
}

async function keep() {
  const values = read();
  const text = JSON.stringify(values);
  if (text === lastSent || text === "{}") return;
  try {
    await api("PUT", "/api/layout/browser", { values });
    lastSent = text;
  } catch {
    /* tried again next time */
  }
}

export function useLayoutKeeper(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    void keep();
    const timer = window.setInterval(() => void keep(), 30_000);
    const hidden = () => {
      if (document.visibilityState === "hidden") void keep();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [enabled]);
}

/** Puts a copied layout's browser parts in place (null removes one). */
export function applyBrowserLayout(values: Record<string, string | null>) {
  try {
    for (const [k, v] of Object.entries(values)) {
      if (!(LAYOUT_BROWSER_KEYS as readonly string[]).includes(k)) continue;
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    }
  } catch {
    /* storage blocked */
  }
  // The Lair's order is kept on Hearth for every device (11-16): a copied one goes there too.
  if ("hearth-lair-order" in values) {
    let order: string[] | null = null;
    try {
      const v = values["hearth-lair-order"];
      const parsed = v ? (JSON.parse(v) as unknown) : null;
      if (Array.isArray(parsed) && parsed.every((k) => typeof k === "string")) order = parsed;
    } catch {
      /* not an order: most used first */
    }
    void api("PATCH", "/api/settings", { lairOrder: order }).catch(() => undefined);
  }
  // What was just put in place is what this Hearth keeps from now on.
  lastSent = "";
}
