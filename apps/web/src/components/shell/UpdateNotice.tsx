import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { HealthReport } from "@dragon-control/core";

/**
 * Hearth updated while this page was open: the server now serves a different build than the one
 * running here, so new screens and fixes would not show until a reload. Says so and offers the
 * reload, and (the owner, 11-13: "detect a new version and reload itself") reloads by itself at a
 * safe moment only: moving to another page, while the tab is in the background, or after two
 * idle minutes with nothing typed and no window open. Never in the middle of something (a reload
 * mid-task cost the owner his place on 10-28).
 *
 * The reload waits until the server really serves the new page: pressed while Hearth is still
 * restarting after an update, a plain reload would get the saved offline copy, the old version.
 */

/** Reloads once the server answers with the new page; tries again for a while if it is restarting. */
async function reloadWhenReady(want: string, onWait: () => void) {
  for (let i = 0; i < 40; i++) {
    try {
      const html = await (await fetch("/", { cache: "no-store" })).text();
      if (html.includes(want)) {
        window.location.reload();
        return;
      }
    } catch {
      /* restarting */
    }
    onWait();
    await new Promise((r) => setTimeout(r, 1500));
  }
  window.location.reload();
}

/** The build this page runs: its main script's file name, which changes with every build. */
function thisBuild(): string | undefined {
  const src = document
    .querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
    ?.getAttribute("src");
  return src?.split("/").pop();
}

export function UpdateNotice() {
  const mine = thisBuild();
  const q = useQuery({
    queryKey: ["health", "build"],
    queryFn: async () =>
      (await (
        await fetch("/api/health", { headers: { accept: "application/json" } })
      ).json()) as HealthReport,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    enabled: Boolean(mine),
  });
  const served = q.data?.webBuild;
  const outdated = Boolean(mine && served && served !== mine);
  const [waiting, setWaiting] = useState(false);
  useSafeReload(outdated ? served : undefined);
  if (!outdated || !served) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-center gap-3 border-t border-gold/50 bg-raised px-4 py-2.5 text-[0.86rem] text-ink shadow-lg"
      data-testid="update-notice"
    >
      <span>
        {waiting
          ? "Hearth is restarting with the new version..."
          : "A new version of Hearth is ready. It loads by itself when you move to another page or step away, or press Reload now."}
      </span>
      <button
        type="button"
        disabled={waiting}
        onClick={() => void reloadWhenReady(served, () => setWaiting(true))}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold px-3 text-gold hover:bg-gold/10"
      >
        <RefreshCw className="h-4 w-4" aria-hidden /> Reload
      </button>
    </div>
  );
}

/** Something is being typed or a window (dialog) is open: not a safe moment to reload. */
function busy(): boolean {
  if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return true;
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && "value" in el && el.value)
    return true;
  for (const f of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "textarea, input[type=text], input:not([type])",
  ))
    if (f.value.trim() && f.dataset.draft !== "ignore") return true;
  return false;
}

/** Reloads into the new version at the first safe moment (see UpdateNotice). */
function useSafeReload(want: string | undefined) {
  const { pathname } = useLocation();
  const first = useRef(pathname);
  const lastInput = useRef(0);
  // Another page: a natural moment, nothing of this one is lost.
  useEffect(() => {
    if (want && pathname !== first.current) void reloadWhenReady(want, () => undefined);
    first.current = pathname;
  }, [pathname, want]);
  useEffect(() => {
    if (!want) return;
    // Idle time counts from when the new version was noticed.
    lastInput.current = Date.now();
    const touched = () => (lastInput.current = Date.now());
    const hidden = () => {
      if (document.visibilityState === "hidden" && !busy())
        void reloadWhenReady(want, () => undefined);
    };
    const idle = setInterval(() => {
      if (Date.now() - lastInput.current > 120_000 && !busy())
        void reloadWhenReady(want, () => undefined);
    }, 15_000);
    window.addEventListener("pointerdown", touched);
    window.addEventListener("keydown", touched);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearInterval(idle);
      window.removeEventListener("pointerdown", touched);
      window.removeEventListener("keydown", touched);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [want]);
}
