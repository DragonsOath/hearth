import { useEffect, useSyncExternalStore } from "react";

/**
 * Which plans' approval cards are on screen right now (11-22, the owner: "any time something needs
 * the owner's approval, the approval shows on the screen they're on"). Every place that shows a
 * plan with its Approve button says so while it is mounted; the approval prompt (ApprovalDock)
 * shows the rest, so a plan is never only on the Jobs page, and never shown twice.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let snapshot = new Set<string>();

function changed() {
  version += 1;
  snapshot = new Set([...counts].filter(([, n]) => n > 0).map(([id]) => id));
  for (const l of listeners) l();
}

/** While mounted (and `on`), the plan's approval is on screen here. */
export function useOnScreen(id: string | undefined, on = true) {
  useEffect(() => {
    if (!id || !on) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    changed();
    return () => {
      const n = (counts.get(id) ?? 1) - 1;
      if (n > 0) counts.set(id, n);
      else counts.delete(id);
      changed();
    };
  }, [id, on]);
}

/** The plans whose approval cards are on screen now. */
export function useShownPlans(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** For tests: how many times the store changed. */
export const onScreenVersion = () => version;
