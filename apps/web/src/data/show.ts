import { useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SHOW_DEFAULTS, type ShowAck, type ShowEvent, type ShowSettings } from "@dragon-control/core";
import { api, ApiError } from "./api";

/** Show & Tell (checklist 45): its settings, and the screen's side of the conversation. */

/**
 * Whether Ember is showing something on this screen right now. While it is, the desk shows at
 * most TOUR_PANELS panels beside the chat (11-13, the owner: "side by side, but 3 panels plus
 * the chat box at most").
 */
export const TOUR_PANELS = 3;
let touring = false;
const tourListeners = new Set<() => void>();
export const tour = {
  set(on: boolean) {
    if (touring === on) return;
    touring = on;
    for (const l of tourListeners) l();
  },
  subscribe(l: () => void) {
    tourListeners.add(l);
    return () => tourListeners.delete(l);
  },
  get on() {
    return touring;
  },
};
export function useTouring(): boolean {
  return useSyncExternalStore(tour.subscribe, () => tour.on);
}

export function useShowSettings() {
  return useQuery({
    queryKey: ["show-settings"],
    // Without the Premium package there is no Show & Tell: off, the same as switched off.
    queryFn: () =>
      api<ShowSettings & { premium?: boolean; locked?: boolean }>("GET", "/api/show/settings").catch(
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 404)
            return { ...SHOW_DEFAULTS, mode: "off" as const, premium: false };
          throw e;
        },
      ),
    staleTime: 30_000,
  });
}

export function useSetShowSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<ShowSettings>) =>
      api<ShowSettings>("PUT", "/api/show/settings", patch),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["show-settings"] }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["audit"] }),
  });
}

/** This window's name while it presents (one per tab, so two tabs never both present). */
export const SCREEN_ID = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `screen-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
})();

/** This window in words ("Chrome on Windows"), for "Showing on ..." in another window. */
export function screenLabel(): string {
  if (typeof navigator === "undefined") return "another Hearth window";
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone or iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "a device";
  const app = /HearthApp|Electron/.test(ua)
    ? "the Hearth app"
    : /Edg\//.test(ua)
      ? "Edge"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "a browser";
  return `${app} on ${os}`;
}

/**
 * Following paused or not, and which window shows the answer under way (11-13). Read every few
 * seconds while Show & Tell is on.
 */
export function useShowState(on: boolean) {
  return useQuery({
    queryKey: ["show-state"],
    queryFn: () =>
      api<{ paused: boolean; showing?: { here: boolean; label: string } }>(
        "GET",
        `/api/show/state?client=${encodeURIComponent(SCREEN_ID)}`,
      ),
    enabled: on,
    refetchInterval: on ? 3000 : false,
  });
}

function useShowAction(path: string, body?: () => Record<string, string>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("POST", path, body ? body() : {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["show-state"] }),
  });
}

/** Stop following: pauses only the walkthrough under way. */
export const usePauseShow = () => useShowAction("/api/show/pause");
/** Resume following (also: a Show me or Teach me choice, or a new question). */
export const useResumeShow = () => useShowAction("/api/show/resume");
/** "Show here instead": this window takes over. */
export const useClaimShow = () => useShowAction("/api/show/claim", () => ({ client: SCREEN_ID }));

/** Waits for the next thing to show (up to 25 s). Null when nothing came. */
export async function nextShowEvent(signal: AbortSignal): Promise<ShowEvent | null> {
  const res = await fetch(
    `/api/show/next?client=${encodeURIComponent(SCREEN_ID)}&wait=25&label=${encodeURIComponent(screenLabel())}`,
    { signal, credentials: "same-origin" },
  );
  if (!res.ok) throw new Error(`show ${res.status}`);
  return ((await res.json()) as { event: ShowEvent | null }).event;
}

export async function ackShow(id: string, ack: ShowAck) {
  await api("POST", `/api/show/${encodeURIComponent(id)}/ack`, { client: SCREEN_ID, ...ack });
}

let lastActive = 0;
/**
 * This window is the one in use (a click or a key, at most every few seconds): Show & Tell
 * presents here rather than in another open Hearth window (11-07).
 */
export function markActive() {
  const now = Date.now();
  if (now - lastActive < 4_000) return;
  lastActive = now;
  void fetch("/api/show/active", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: SCREEN_ID }),
  }).catch(() => undefined);
}
