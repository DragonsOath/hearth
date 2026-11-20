import { useState } from "react";
import { Link } from "react-router";
import { ChevronDown, TriangleAlert } from "lucide-react";
import type {
  WorkspaceItemPlanStatus,
  WorkspacePlanView,
  WorkspaceView,
} from "@dragon-control/core";
import { Button, cx } from "../ui";
import { bytes } from "../../lib/format";

/**
 * The plan made from this workspace's submitted decisions (feature request 20.6): its status,
 * which submission it reflects, and each item's own result. Space freed is only shown when
 * verified deletes report it.
 */

export const ITEM_STATUS: Record<WorkspaceItemPlanStatus, { label: string; cls: string }> = {
  planned: { label: "Planned", cls: "border-gold/50 text-gold" },
  running: { label: "Running", cls: "border-gold bg-gold/15 text-gold" },
  done: { label: "Done", cls: "border-ok/60 bg-ok/10 text-ok" },
  skipped: { label: "Skipped", cls: "border-amber/60 bg-amber/10 text-amber" },
  failed: { label: "Failed", cls: "border-bad/60 bg-bad/10 text-bad" },
  "not-run": { label: "Not run", cls: "border-line-strong text-faint" },
};

const PLAN_STATUS: Record<string, string> = {
  "awaiting-approval": "Waiting for your approval",
  running: "Running",
  succeeded: "Done, every item verified",
  partial: "Partly done",
  failed: "Not done",
  refused: "Not allowed",
  cancelled: "Not carried out",
  expired: "Expired",
  interrupted: "Interrupted",
  "rolled-back": "Undone",
};

export function ItemBadge({
  status,
  result,
}: {
  status: WorkspaceItemPlanStatus;
  result?: string;
}) {
  const s = ITEM_STATUS[status];
  return (
    <span
      className={cx(
        "inline-flex min-h-6 items-center rounded-full border px-2 text-[0.7rem] whitespace-nowrap",
        s.cls,
      )}
      title={result}
      data-testid="item-plan-status"
    >
      {s.label}
    </span>
  );
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function PlanCard({
  view,
  nameOf,
  onReplace,
  replacing,
}: {
  view: WorkspaceView;
  nameOf: (itemId: string) => string;
  /** Submits the current choices again, so Ember can make a replacement plan. */
  onReplace: () => void;
  replacing: boolean;
}) {
  const plans = view.plans ?? [];
  const plan: WorkspacePlanView | undefined = plans[0];
  // Results open once the plan has run; while it waits, each row already says Planned.
  const ran = plan ? plan.status !== "awaiting-approval" : false;
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  if (!plan) return null;
  const showResults = open ?? ran;
  const entries = Object.entries(plan.items);
  const revised = view.revised?.jobId === plan.jobId ? view.revised : undefined;
  const waiting = plan.status === "awaiting-approval";
  return (
    <section
      aria-label="Plan from your decisions"
      className="mx-4 mb-3 rounded-xl border border-gold/30 bg-raised/40 p-3"
      data-testid="workspace-plan"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-[0.72rem] tracking-[0.1em] text-faint uppercase">Plan</p>
          <p className="truncate text-[0.92rem] text-ink">{plan.title}</p>
          <p className="text-[0.76rem] text-muted" data-testid="workspace-plan-status">
            {PLAN_STATUS[plan.status] ?? plan.status} · made from your submission at{" "}
            {time(plan.snapshotAt)}
          </p>
        </div>
        <Link
          to={`/jobs/${plan.jobId}`}
          className={cx(
            "inline-flex min-h-9 items-center rounded-lg px-3 text-[0.8rem]",
            waiting
              ? "bg-gold text-bg hover:bg-gold-bright"
              : "border border-line-strong text-ink hover:border-gold",
          )}
        >
          {waiting ? "Review and approve" : "Open the plan"}
        </Link>
      </div>

      {revised && (
        <div
          className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber/10 p-2.5 text-[0.8rem] text-amber"
          role="status"
          data-testid="workspace-revised"
        >
          <TriangleAlert strokeWidth={1.5} className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            You changed {revised.changed.length} choice{revised.changed.length === 1 ? "" : "s"}{" "}
            after this plan was made. It still reflects your submission at{" "}
            {time(revised.snapshotAt)}
            {waiting
              ? " and will not change."
              : ". Items it has not reached yet that you changed to Keep will be skipped; items already done or in progress are not affected."}
          </span>
          <Button
            tone="outline"
            className="min-h-9 px-3 text-[0.78rem]"
            disabled={replacing}
            onClick={onReplace}
          >
            {replacing ? "Sending..." : "Ask for a replacement plan"}
          </Button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.74rem]">
        {(Object.keys(ITEM_STATUS) as WorkspaceItemPlanStatus[])
          .filter((k) => plan.counts[k])
          .map((k) => (
            <span
              key={k}
              className={cx("fit-pill rounded-full border px-2 py-0.5", ITEM_STATUS[k].cls)}
            >
              {ITEM_STATUS[k].label} {plan.counts[k]}
            </span>
          ))}
        {plan.freedBytes ? (
          <span className="text-ok" data-testid="workspace-plan-freed">
            Verified space freed: {bytes(plan.freedBytes)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(!showResults)}
          aria-expanded={showResults}
          className="ml-auto flex min-h-8 items-center gap-1 text-faint hover:text-gold"
        >
          {showResults ? "Hide results" : "Show results"}
          <ChevronDown
            strokeWidth={1.5}
            className={cx("h-3.5 w-3.5", showResults && "rotate-180")}
          />
        </button>
      </div>

      {showResults && (
        <ul
          className="mt-2 max-h-48 space-y-1.5 overflow-y-auto pr-1"
          data-testid="workspace-plan-items"
        >
          {entries.map(([itemId, r]) => (
            <li key={itemId} className="text-[0.78rem]" data-item={itemId}>
              <div className="flex items-center gap-2">
                <ItemBadge status={r.status} />
                <span className="min-w-0 truncate text-ink" title={itemId}>
                  {nameOf(itemId)}
                </span>
              </div>
              {r.result && <p className="mt-0.5 pl-1 text-[0.74rem] text-muted">{r.result}</p>}
            </li>
          ))}
        </ul>
      )}
      {plans.length > 1 && (
        <p className="mt-2 text-[0.72rem] text-faint">
          Earlier plans from this workspace:{" "}
          {plans.slice(1).map((p, i) => (
            <span key={p.jobId}>
              {i ? ", " : ""}
              <Link
                to={`/jobs/${p.jobId}`}
                className="underline underline-offset-2 hover:text-gold"
              >
                {PLAN_STATUS[p.status] ?? p.status}
              </Link>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
