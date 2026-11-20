import { Check } from "lucide-react";
import { cx } from "../ui";

/**
 * The whole first-run setup at a glance: creating the account, connecting Ember's AI, making it
 * your own, and finishing. A later stage (connecting your homelab's services, say) is one more
 * entry here; the screens that use it pass their own stage.
 */
export const ONBOARDING_STAGES = [
  { id: "account", label: "Your account" },
  { id: "ai", label: "Connect your AI" },
  { id: "yours", label: "Make it yours" },
  { id: "finish", label: "Finish" },
] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number]["id"];

export function OnboardingStages({
  current,
  className,
}: {
  current: OnboardingStage;
  className?: string;
}) {
  const at = ONBOARDING_STAGES.findIndex((s) => s.id === current);
  return (
    <ol
      aria-label="Setup"
      className={cx("grid grid-cols-4 gap-2", className)}
      data-testid="onboarding-stages"
    >
      {ONBOARDING_STAGES.map((s, i) => {
        const done = i < at;
        const now = i === at;
        return (
          <li
            key={s.id}
            aria-current={now ? "step" : undefined}
            className="flex min-w-0 flex-col items-center gap-1.5 text-center"
          >
            <span
              aria-hidden="true"
              className={cx(
                "flex h-7 w-7 items-center justify-center rounded-full border text-[0.76rem]",
                done
                  ? "border-gold bg-gold text-bg"
                  : now
                    ? "border-gold text-gold"
                    : "border-line-strong text-faint",
              )}
            >
              {done ? <Check strokeWidth={2.5} className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span
              className={cx(
                "text-[0.72rem] leading-tight sm:text-[0.78rem]",
                now ? "text-ink" : done ? "text-muted" : "text-faint",
              )}
            >
              {s.label}
              <span className="sr-only">{done ? " (done)" : now ? " (current)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
