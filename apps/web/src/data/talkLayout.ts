import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Conversation mode's workstation layout: which panels are open beside one
 * conversation, where, how big, which is on top, and which are minimized. Kept on the server per
 * conversation, so leaving, a refresh, or another browser brings them back. Positions are
 * fractions of the workspace, so a smaller window still shows every panel. Saved a moment after a
 * change (not on every pixel of a drag) and once more when you leave.
 */

export type TalkPanelKind = "service" | "project" | "todo" | "plans" | "storage";

export interface TalkWindow {
  kind: TalkPanelKind;
  id: string;
  /** The tab it shows (services and projects). */
  tab?: string;
  /** Left, top, width, height as fractions of the workspace (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order: higher is on top. */
  z: number;
  minimized?: boolean;
}

export interface TalkLayout {
  v: 1;
  windows: TalkWindow[];
  /** The panel list on the left: open or folded away. */
  rail?: boolean;
  /** On phones: which panel is showing (one at a time). */
  mobile?: string;
}

export const windowKey = (w: Pick<TalkWindow, "kind" | "id">) => `${w.kind}:${w.id}`;

const EMPTY: TalkLayout = { v: 1, windows: [], rail: true };
const MAX_WINDOWS = 12;

/** Keeps a layout sane: known kinds, on screen, at least a usable size, no duplicates. */
export function clean(raw: unknown): TalkLayout {
  const l = (raw && typeof raw === "object" ? raw : {}) as Partial<TalkLayout>;
  const seen = new Set<string>();
  const clamp = (n: unknown, lo: number, hi: number, d: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  const windows: TalkWindow[] = [];
  for (const w of Array.isArray(l.windows) ? l.windows : []) {
    if (!w || !["service", "project", "todo", "plans", "storage"].includes(w.kind) || typeof w.id !== "string") continue;
    const key = windowKey(w);
    if (seen.has(key)) continue;
    seen.add(key);
    const wd = clamp(w.w, 0.18, 1, 0.3);
    const ht = clamp(w.h, 0.2, 1, 0.5);
    windows.push({
      kind: w.kind,
      id: w.id,
      ...(typeof w.tab === "string" ? { tab: w.tab } : {}),
      w: wd,
      h: ht,
      x: clamp(w.x, 0, 1 - wd, 0),
      y: clamp(w.y, 0, 1 - ht, 0),
      z: clamp(w.z, 0, 1e6, windows.length + 1),
      ...(w.minimized ? { minimized: true } : {}),
    });
  }
  return {
    v: 1,
    windows: windows.slice(0, MAX_WINDOWS),
    rail: l.rail !== false,
    ...(typeof l.mobile === "string" ? { mobile: l.mobile } : {}),
  };
}

/**
 * The layout for `key` (a conversation id, or "draft:..." before the first message). When the
 * key changes from a draft to a real conversation, the open panels move with it.
 */
export function useTalkLayout(key: string) {
  const [layout, setLayout] = useState<TalkLayout>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ key: string; layout: TalkLayout } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const current = useRef({ key, layout });
  useEffect(() => {
    current.current = { key, layout };
  }, [key, layout]);
  const prevKey = useRef(key);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    void api("PUT", `/api/talk/layouts/${encodeURIComponent(p.key)}`, { layout: p.layout }).then(
      () => setError(null),
      (e: unknown) => {
        // Kept on screen; the next change tries again.
        setError(e instanceof Error ? e.message : "Could not save the layout.");
      },
    );
  }, []);

  // Load (and, when a draft became a conversation, carry its panels over).
  useEffect(() => {
    const from = prevKey.current;
    prevKey.current = key;
    if (from !== key && from.startsWith("draft:") && current.current.layout.windows.length) {
      pending.current = { key, layout: current.current.layout };
      flush();
      setLoaded(true);
      return;
    }
    let live = true;
    setLoaded(false);
    api<{ layout: unknown }>("GET", `/api/talk/layouts/${encodeURIComponent(key)}`)
      .then((r) => {
        if (!live) return;
        setLayout(r.layout ? clean(r.layout) : EMPTY);
        setLoaded(true);
      })
      .catch(() => {
        if (!live) return;
        // Not saved yet, or the server is restarting: start empty, nothing is erased.
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [key, flush]);

  const update = useCallback(
    (fn: (l: TalkLayout) => TalkLayout, opts: { now?: boolean } = {}) => {
      setLayout((l) => {
        const next = clean(fn(l));
        pending.current = { key: current.current.key, layout: next };
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, opts.now ? 0 : 700);
        return next;
      });
    },
    [flush],
  );

  // Saved once more when leaving the screen or the page.
  useEffect(() => {
    const leave = () => flush();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      flush();
    };
  }, [flush]);

  return { layout, loaded, error, update };
}
