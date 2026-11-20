import { useQuery } from "@tanstack/react-query";
import { api } from "../../data/api";
import type { EmberUsage, UsageWindow } from "../ember/engine";
import { cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * How much of the AI plan is left, small, beside the AI's name in the Lair (10-26): the
 * same reading the War Room's usage panel shows, as a percentage, never as money. Answers on a
 * subscription aren't charged per use, so Hearth doesn't show prices in conversations. Shows the
 * tightest of the plan's windows (the 5-hour and the weekly), and nothing until there is a reading.
 */
/** The plan's tightest window, rounded, or nothing without a reading. */
export function planLeft(usage: EmberUsage | undefined) {
  const claude = usage?.engines.find((e) => e.engine === "claude-code");
  const windows = (claude?.windows ?? []).filter(
    (w): w is UsageWindow & { remaining_pct: number } => w.remaining_pct != null && !w.reset_passed,
  );
  if (!claude || claude.status === "not_installed" || !windows.length) return null;
  const tight = windows.reduce((a, b) => (b.remaining_pct < a.remaining_pct ? b : a));
  return {
    claude,
    tight,
    left: Math.round(tight.remaining_pct),
    detail: windows.map((w) => `${w.label}: ${Math.round(w.remaining_pct)}% left`).join(" · "),
  };
}

export function PlanUsage({ className }: { className?: string }) {
  const usage = useQuery({
    queryKey: ["engine-usage"],
    queryFn: () => api<EmberUsage>("GET", "/api/engine/usage"),
    refetchInterval: 60_000,
    retry: false,
  });
  const plan = planLeft(usage.data);
  if (!plan) return null;
  const { claude, tight, left, detail } = plan;
  const tone =
    tight.level === "critical" ? "bg-bad" : tight.level === "low" ? "bg-warn" : "bg-gold";
  return (
    <div
      className={cx("flex items-center gap-1.5 text-[0.7rem] text-faint", className)}
      title={`${claude.label} plan · ${detail}${claude.status === "stale" ? " (last reading)" : ""}. Buttons with this mark start Ember and use this plan.`}
      data-testid="plan-usage"
    >
      {/* The key to the Ember mark (11-12): the mark beside the plan it uses. */}
      <EmberMark />
      <div
        role="progressbar"
        aria-label={`${claude.label} plan left (${tight.label})`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
        className="h-1 w-16 overflow-hidden rounded-full bg-line"
      >
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${left}%` }} />
      </div>
      <span className="tabular">{left}% left</span>
    </div>
  );
}
