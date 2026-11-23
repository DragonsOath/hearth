import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import {
  PREMIUM_FEATURES,
  PREMIUM_INFO,
  type PremiumPackageState,
  type PremiumStatus,
} from "@dragon-control/core";
import { api } from "../../data/api";

/**
 * Premium turning on (11-22, launch-critical: a redeemed code unlocked nothing). After a redeem,
 * Hearth fetches the Premium package, checks its signature, installs it and reloads itself once
 * nothing is running; this says where that stands on every page, reloads the page when Hearth is
 * back, and then says "Welcome to Premium", once.
 */

const MOVING: PremiumPackageState["state"][] = [
  "downloading",
  "installing",
  "waiting",
  "reloading",
];

/** Where the Premium package stands, in plain words (also on Settings, Premium). */
export function packageWords(p: PremiumPackageState | undefined): string | null {
  switch (p?.state) {
    case "downloading":
      return "Setting up Premium: getting the Premium package...";
    case "installing":
      return "Setting up Premium: checking its signature and installing it...";
    case "waiting":
      return `Premium is installed. Hearth reloads to turn it on once this is done: ${p.busy.join(", ")}.`;
    case "reloading":
      return "Turning on Premium: Hearth is reloading (a few seconds)...";
    case "restart-needed":
      return `Premium is installed. ${p.detail}`;
    case "failed":
      return `Premium couldn't be set up yet: ${p.detail}`;
    default:
      return null;
  }
}

/** Waits for Hearth to come back from its reload, then reloads this page. */
async function reloadWhenBack(signal: AbortSignal) {
  let wentAway = false;
  let firstUptime: number | undefined;
  const started = Date.now();
  while (!signal.aborted && Date.now() - started < 5 * 60_000) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) {
        wentAway = true;
        continue;
      }
      const h = (await res.json()) as { uptimeSeconds?: number };
      const up = h.uptimeSeconds ?? 0;
      firstUptime ??= up;
      // Back after being away, or started afresh since we first looked.
      if (wentAway || up < firstUptime) {
        window.location.reload();
        return;
      }
    } catch {
      wentAway = true;
    }
  }
}

export function PremiumSetup() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["premium"],
    queryFn: () => api<PremiumStatus>("GET", "/api/premium"),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) =>
      MOVING.includes((query.state.data as PremiumStatus | undefined)?.package?.state ?? "idle")
        ? 2000
        : false,
  });
  const pkg = q.data?.package;
  const reloading = pkg?.state === "reloading";
  useEffect(() => {
    if (!reloading) return;
    const ctl = new AbortController();
    void reloadWhenBack(ctl.signal);
    return () => ctl.abort();
  }, [reloading]);

  const welcomed = useMutation({
    mutationFn: () => api<PremiumStatus>("POST", "/api/premium/welcomed", {}),
    onSuccess: (s) => qc.setQueryData(["premium"], s),
  });
  const navigate = useNavigate();
  // "Learn about Premium": a new conversation where Ember shows each extra on screen (11-22).
  const tour = useMutation({
    mutationFn: () => api<{ conversationId: string }>("POST", "/api/premium/tour", {}),
    onSuccess: (r) => {
      setClosed(true);
      void qc.invalidateQueries({ queryKey: ["premium"] });
      void qc.invalidateQueries({ queryKey: ["show-settings"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      navigate(`/ask/${encodeURIComponent(r.conversationId)}`);
    },
  });
  const [closed, setClosed] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const welcome = Boolean(q.data?.welcome) && !closed;
  useEffect(() => {
    if (welcome) first.current?.focus();
  }, [welcome]);

  const words = packageWords(pkg);
  const close = () => {
    setClosed(true);
    welcomed.mutate();
  };
  return (
    <>
      {words && MOVING.includes(pkg!.state) && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 border-t border-gold/50 bg-raised px-4 py-2.5 text-[0.86rem] text-ink shadow-lg"
          data-testid="premium-setup"
          data-state={pkg!.state}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-gold" aria-hidden />
          <span>{words}</span>
        </div>
      )}
      {welcome && (
        <div
          className="fixed inset-0 z-[86] grid place-items-center bg-bg/80 p-4 backdrop-blur-sm"
          data-testid="premium-welcome"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="premium-welcome-title"
            className="w-full max-w-lg rounded-2xl border border-gold/50 bg-panel p-6 shadow-2xl"
            onKeyDown={(e) => e.key === "Escape" && close()}
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-gold/15 text-gold">
              <Sparkles className="h-6 w-6" aria-hidden />
            </span>
            <h2
              id="premium-welcome-title"
              className="mt-3 font-display text-[1.5rem] leading-tight font-bold text-ink"
            >
              Welcome to Premium
            </h2>
            <p className="mt-2 text-[0.92rem] text-muted">
              Everything Premium has is turned on for this Hearth, and Ember knows it too.
            </p>
            <ul className="mt-4 space-y-3" aria-label="What Premium adds">
              {PREMIUM_FEATURES.filter(
                (f) => q.data?.features.find((x) => x.feature === f)?.state === "active",
              ).map((f) => (
                <li key={f} className="rounded-xl border border-line p-3">
                  <p className="text-[0.95rem] font-semibold text-ink">{PREMIUM_INFO[f].name}</p>
                  <p className="mt-1 text-[0.84rem] text-muted">{PREMIUM_INFO[f].what}</p>
                </li>
              ))}
            </ul>
            {tour.error ? (
              <p className="mt-4 text-[0.84rem] text-bad" role="alert">
                {tour.error.message}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-[0.92rem] font-semibold text-muted hover:text-ink"
                data-testid="premium-welcome-close"
              >
                Let&apos;s go
              </button>
              <button
                ref={first}
                type="button"
                disabled={tour.isPending}
                onClick={() => tour.mutate()}
                className="inline-flex min-h-11 items-center rounded-lg bg-gold px-5 text-[0.92rem] font-semibold text-bg hover:bg-gold-bright"
                data-testid="premium-welcome-tour"
              >
                {tour.isPending ? "Starting…" : "Learn about Premium"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
