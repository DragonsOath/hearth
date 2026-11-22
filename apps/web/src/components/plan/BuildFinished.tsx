import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { PartyPopper } from "lucide-react";
import { buildDoneText, type HomelabBuild } from "@dragon-control/core";
import { api } from "../../data/api";
import { useHomelabBuild } from "../../data/plan";
import { openApp } from "./BuildNext";

/**
 * The build is finished (11-22, the owner: "have Ember say congratulations, everything is built.
 * I got nothing, I built it"). On whatever page they are on, once: Ember's congratulations, what
 * was built, and the first thing to try. Ember says the same in the build's chat.
 */

/** A build finished in the last few days that they have not closed the card for. */
export function showFinished(b: HomelabBuild | undefined, now = Date.now()): b is HomelabBuild {
  return Boolean(
    b?.done &&
    b.finishedAt &&
    !b.celebrated &&
    now - Date.parse(b.finishedAt) < 3 * 24 * 60 * 60 * 1000,
  );
}

export function BuildFinished() {
  const build = useHomelabBuild();
  const qc = useQueryClient();
  const close = useMutation({
    mutationFn: () => api<{ ok: boolean }>("POST", "/api/plan/build/celebrated", {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["plan-build"] }),
  });
  const b = build.data;
  const show = showFinished(b) && !close.isPending && !close.isSuccess;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (show) first.current?.focus();
  }, [show]);
  if (!show) return null;
  const media = b.steps.find((s) => (s.id === "jellyfin" || s.id === "plex") && s.url);
  const apps = b.steps.filter((s) => !["docker", "connect", "tailscale"].includes(s.id));
  return (
    <div
      className="fixed inset-0 z-[85] grid place-items-center bg-bg/80 p-4 backdrop-blur-sm"
      data-testid="build-finished"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="build-finished-title"
        className="w-full max-w-lg rounded-2xl border border-gold/50 bg-panel p-6 shadow-2xl"
        onKeyDown={(e) => e.key === "Escape" && close.mutate()}
      >
        <span className="grid h-12 w-12 place-items-center rounded-full bg-gold/15 text-gold">
          <PartyPopper className="h-6 w-6" aria-hidden />
        </span>
        <h2
          id="build-finished-title"
          className="mt-3 font-display text-[1.5rem] leading-tight font-bold text-ink"
        >
          Congratulations, everything is built!
        </h2>
        <p className="mt-2 text-[0.95rem] text-muted">
          {buildDoneText(b).replace(/^Congratulations, everything is built! /, "")}
        </p>
        {apps.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-1.5" aria-label="What was built">
            {apps.map((s) => (
              <li
                key={s.id}
                className="rounded-full border border-live/40 bg-live/10 px-3 py-1 text-[0.8rem] font-semibold text-live"
              >
                {s.name}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {media?.url ? (
            <button
              ref={first}
              type="button"
              onClick={() => {
                openApp(media.url!, media.id);
                close.mutate();
              }}
              className="inline-flex min-h-11 items-center rounded-lg bg-gold px-4 text-[0.92rem] font-semibold text-bg hover:bg-gold-bright"
              data-testid="build-finished-open"
            >
              Open {media.name}
            </button>
          ) : null}
          <Link
            to="/plan"
            onClick={() => close.mutate()}
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-[0.92rem] font-semibold text-ink hover:border-gold/60"
          >
            See your homelab
          </Link>
          <button
            ref={media?.url ? undefined : first}
            type="button"
            onClick={() => close.mutate()}
            className="inline-flex min-h-11 items-center rounded-lg px-4 text-[0.92rem] font-semibold text-muted hover:text-ink"
            data-testid="build-finished-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
