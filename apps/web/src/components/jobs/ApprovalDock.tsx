import { useState } from "react";
import { useLocation } from "react-router";
import { X } from "lucide-react";
import { JOB_DONE, type Job } from "@dragon-control/core";
import { useJobs } from "../../data/jobs";
import { JobCard } from "../cave/Progress";
import { useShownPlans } from "./onScreen";

/**
 * A plan Ember or Hearth proposed that is not on screen (11-22, the owner: "on any other page: a
 * clear prompt ... so they never have to leave the page"): it slides in on whatever page you are
 * on, with the same card as in the chat, Approve and Decline included, and stays to show how it
 * went once approved. Plans you start from a panel's own button already show their approval
 * there, and the Jobs pages have their own buttons, so those are left alone. Approvals do not
 * change: the same plan, protected-step check and expiry.
 */
export function needsPrompt(j: Job, shown: ReadonlySet<string>) {
  return (
    j.status === "awaiting-approval" &&
    Boolean(j.approval) &&
    j.requestedBy !== "you" &&
    !shown.has(j.id)
  );
}

export function ApprovalDock() {
  const jobs = useJobs();
  const shown = useShownPlans();
  const { pathname } = useLocation();
  // The plans in the prompt, in the order they arrived; each stays until it is closed.
  const [ids, setIds] = useState<string[]>([]);
  const [later, setLater] = useState<Set<string>>(() => new Set());
  const list = jobs.data ?? [];
  const onJobs = pathname === "/jobs" || pathname.startsWith("/jobs/");
  // A plan newly waiting and not on screen joins the prompt (set while rendering, as React
  // allows for state that follows other data; it settles at once).
  const fresh = list
    .filter((j) => needsPrompt(j, shown) && !later.has(j.id) && !ids.includes(j.id))
    .map((j) => j.id);
  if (fresh.length) setIds([...ids, ...fresh]);
  const byId = new Map(list.map((j) => [j.id, j]));
  const visible = ids.filter((id) => {
    const j = byId.get(id);
    if (!j || later.has(id)) return false;
    // Shown elsewhere now (you opened its chat): only once it has been decided here.
    return !(j.status === "awaiting-approval" && shown.has(id));
  });
  if (onJobs || !visible.length) return null;
  const close = (id: string, waiting: boolean) => {
    if (waiting) setLater((s) => new Set(s).add(id));
    setIds((x) => x.filter((y) => y !== id));
  };
  return (
    <aside
      className="fixed inset-x-0 bottom-0 z-[75] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-t-2xl border-t border-gold/50 bg-panel p-3 shadow-2xl md:inset-x-auto md:right-4 md:bottom-4 md:w-[420px] md:rounded-2xl md:border"
      aria-label="Needs your approval"
      data-testid="approval-dock"
    >
      <p className="mb-1 px-1 text-[0.72rem] tracking-[0.12em] text-gold uppercase">
        {visible.some((id) => byId.get(id)?.status === "awaiting-approval")
          ? "Needs your approval"
          : "Your plans"}
      </p>
      <div className="space-y-3">
        {visible.map((id) => {
          const j = byId.get(id)!;
          const waiting = j.status === "awaiting-approval";
          const done = JOB_DONE.includes(j.status);
          return (
            <div key={id} className="relative" data-testid="approval-dock-plan">
              {/* Close sits at the top, so it is never below the fold on a laptop (11-22). */}
              <div className="mb-1 flex justify-end">
                <button
                  type="button"
                  onClick={() => close(id, waiting)}
                  className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[0.78rem] text-muted hover:text-ink"
                  data-testid="approval-dock-later"
                >
                  <X strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden />
                  {waiting ? "Later (it stays in Jobs)" : done ? "Close" : "Hide"}
                </button>
              </div>
              <JobCard id={id} dock />
            </div>
          );
        })}
      </div>
    </aside>
  );
}
