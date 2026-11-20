import { useEffect, useRef, type KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { cx } from "../ui";

/**
 * Monitoring's four pages as tabs, like Settings' (the owner, 11-13). Each tab is still its own
 * page and address (/findings, /incidents, /autonomy, /notifications), so links keep working.
 */
const TABS = [
  { to: "/findings", label: "Findings" },
  { to: "/incidents", label: "Incidents" },
  { to: "/autonomy", label: "Autonomy" },
  { to: "/notifications", label: "Notifications" },
] as const;

export const MONITORING_PATHS = TABS.map((t) => t.to);

/** Each tab is its own page, so the bar is drawn again: keyboard focus follows it there. */
let focusAfterMove = false;

export function MonitoringTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(
    0,
    TABS.findIndex((t) => pathname === t.to || pathname.startsWith(`${t.to}/`)),
  );
  useEffect(() => {
    void refs.current[at]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusAfterMove) {
      focusAfterMove = false;
      refs.current[at]?.focus();
    }
  }, [at]);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowRight"
        ? (at + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (at - 1 + TABS.length) % TABS.length
          : -1;
    if (next < 0) return;
    e.preventDefault();
    focusAfterMove = true;
    navigate(TABS[next]!.to);
  };
  return (
    <div
      role="tablist"
      aria-label="Monitoring"
      onKeyDown={onKey}
      className="mb-8 flex gap-1 overflow-x-auto border-b border-line"
      data-testid="monitoring-tabs"
    >
      {TABS.map((t, i) => (
        <button
          key={t.to}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={i === at}
          tabIndex={i === at ? 0 : -1}
          onClick={() => navigate(t.to)}
          className={cx(
            "relative min-h-11 shrink-0 scroll-mx-4 px-3 text-[0.9rem] transition-colors",
            i === at
              ? "text-gold after:absolute after:inset-x-2 after:bottom-0 after:h-[2px] after:rounded-full after:bg-gold"
              : "text-muted hover:text-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
