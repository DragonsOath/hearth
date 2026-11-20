import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BrowserOwnerInput, BrowserState } from "@dragon-control/core";
import { api } from "./api";
import { useLiveQuery } from "../components/panels/lifecycle";

/** Ember's Browser as it is now: running or not, its tabs, where Ember last clicked. */
export function useBrowserState() {
  return useLiveQuery({
    queryKey: ["browser"],
    queryFn: () => api<BrowserState>("GET", "/api/browser/state"),
    // Live while it runs, so the click marker and the address follow Ember closely.
    refetchInterval: (q) => (q.state.data?.status === "live" ? 700 : 1000),
  });
}

/** What you do in the panel: open an address, back, forward, reload, close the browser. */
export function useBrowserAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      action:
        | "open"
        | "back"
        | "forward"
        | "reload"
        | "close"
        | "take-over"
        | "give-back"
        | "visible-yes"
        | "visible-always"
        | "visible-no"
        | "forget-site";
      url?: string;
      host?: string;
      tab?: string;
      newTab?: boolean;
    }) => api<BrowserState>("POST", "/api/browser/owner", body),
    onSuccess: (s, body) => {
      qc.setQueryData(["browser"], s);
      // Given back: Ember carries on in her conversation, so the chat looks again (and once more
      // a moment later, when her run has surely started) and then follows it as it works.
      if (body.action === "give-back" || body.action.startsWith("visible-")) {
        void qc.invalidateQueries({ queryKey: ["conversations"] });
        window.setTimeout(() => void qc.invalidateQueries({ queryKey: ["conversations"] }), 1500);
      }
    },
  });
}

/** What you do on the page while you have it: a click, typing, a key, scrolling. */
export function useBrowserInput() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: BrowserOwnerInput & { tab?: string }) =>
      api<BrowserState>("POST", "/api/browser/owner/input", body),
    onSuccess: (s) => qc.setQueryData(["browser"], s),
  });
}

/**
 * The page's size for the panel's free space (11-04: fill the panel, no empty space). The
 * shape is kept and scaled into what a page needs: a narrow phone panel gets a wider page shown
 * smaller, a huge screen a page no bigger than the browser allows.
 */
export function pageSizeFor(width: number, height: number) {
  if (width < 1 || height < 1) return null;
  const up = Math.max(1, 800 / width, 500 / height);
  const down = Math.min(1, 2560 / (width * up), 1600 / (height * up));
  return { width: Math.round(width * up * down), height: Math.round(height * up * down) };
}

/** Tells the browser the panel's shape, so the page fills it. */
export function useBrowserViewport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { width: number; height: number }) =>
      api<{ viewport: BrowserState["viewport"] }>("POST", "/api/browser/viewport", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["browser"] }),
  });
}
