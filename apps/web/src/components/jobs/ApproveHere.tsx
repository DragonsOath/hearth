import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { ActionKind, StepParams } from "@dragon-control/core";
import { useJob, useJobDecision, usePlanJob } from "../../data/jobs";
import { Button } from "../ui";
import { ApprovalError } from "./ApprovalError";
import { useOnScreen } from "./onScreen";

/**
 * Approve a change where you asked for it: a panel's button plans the change (the same plan,
 * approval, and audit as the Jobs page), and a pop-up shows exactly what it does with Approve and
 * Cancel. Cancel, the X, Escape, or a click outside all decline it, so nothing changes.
 */

type Step = { kind: ActionKind; serviceId?: string; params: StepParams };

export function useApproveHere(
  serviceId: string,
  reason = "Proposed from the dashboard.",
  /** Another PC: the plan is made, approved and run there. */
  pc?: string,
) {
  const plan = usePlanJob();
  const decide = useJobDecision();
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  const [approveError, setApproveError] = useState<Error | null>(null);
  // Sent now (a confirm sheet's Request was the approval): no pop-up unless something goes wrong.
  const [quiet, setQuiet] = useState(false);
  const job = useJob(jobId, pc);
  const status = job.data?.status;
  const finished = status === "succeeded" || status === "failed" || status === "refused";
  useEffect(() => {
    if (!finished) return;
    // The panel shows the result now, and again once the server's short cache has passed.
    const refresh = () => void qc.invalidateQueries({ queryKey: ["dashboard"] });
    refresh();
    // Not cancelled when the pop-up closes: closing it right away must not leave the panel
    // showing what the server had cached just before the change.
    setTimeout(refresh, 1_700);
  }, [finished, qc]);

  const proposeMany = async (steps: Step[], title: string, now = false) => {
    setError(undefined);
    setApproveError(null);
    setQuiet(now);
    try {
      const j = await plan.mutateAsync({
        ...(pc ? { pc } : {}),
        title: title.slice(0, 120),
        reason,
        steps: steps.map((s) => ({
          kind: s.kind,
          serviceId: s.serviceId ?? serviceId,
          params: s.params,
        })),
      });
      if (j.status === "refused") setError(j.summary ?? "Not allowed.");
      else {
        setJobId(j.id);
        // The same plan, audit and checks; the tap that sent it is the approval. Anything more
        // the server asks for (confirm it's you) opens the usual pop-up instead.
        if (now && j.status === "awaiting-approval" && j.approval)
          await decide
            .mutateAsync({
              ...(pc ? { pc } : {}),
              id: j.id,
              decision: "approve",
              fingerprint: j.approval.fingerprint,
            })
            .catch((e: unknown) => {
              setQuiet(false);
              if (e instanceof Error) setApproveError(e);
              else setError(String(e));
            });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return {
    job: job.data,
    open: Boolean(jobId) && (!quiet || status === "failed" || status === "refused"),
    /** Sent and not turned down (a request shows Requested at once). */
    sent: Boolean(jobId) && status !== "failed" && status !== "refused",
    error,
    approveError,
    pending: plan.isPending,
    busy: plan.isPending || decide.isPending || status === "running",
    proposeMany,
    propose: (kind: ActionKind, params: StepParams, title: string, target?: string) =>
      proposeMany([{ kind, params, ...(target ? { serviceId: target } : {}) }], title),
    /** Sends now: the owner's tap on a confirm sheet was the approval (Request, 11-14). */
    sendNow: (steps: Step[], title: string) => proposeMany(steps, title, true),
    approve: async () => {
      const j = job.data;
      if (!j?.approval) return;
      setApproveError(null);
      try {
        await decide.mutateAsync({
          ...(pc ? { pc } : {}),
          id: j.id,
          decision: "approve",
          fingerprint: j.approval.fingerprint,
        });
      } catch (e) {
        if (e instanceof Error) setApproveError(e);
        else setError(String(e));
      }
    },
    /** Closes the pop-up; a plan still waiting for you is declined, so nothing changes. */
    close: async () => {
      const j = job.data;
      setJobId(undefined);
      setApproveError(null);
      if (j?.status === "awaiting-approval")
        await decide
          .mutateAsync({ ...(pc ? { pc } : {}), id: j.id, decision: "decline" })
          .catch(() => undefined);
    },
  };
}

export type ApproveHere = ReturnType<typeof useApproveHere>;

export function ApproveDialog({ c }: { c: ApproveHere }) {
  const j = c.job;
  useOnScreen(j?.id, c.open);
  useEffect(() => {
    if (!c.open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") void c.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [c]);
  if (!c.open) return null;
  const waiting = j?.status === "awaiting-approval";
  const done = j?.status === "succeeded";
  const failed = j?.status === "failed" || j?.status === "refused";
  const results = (j?.steps ?? []).map((s) => s.result).filter(Boolean);
  // Above an open modal (a title's details sheet): a native modal sits over the whole page, so
  // the pop-up goes inside the top one, or it would open behind it and could not be clicked.
  const modals = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => {
    try {
      return d.matches(":modal");
    } catch {
      return false;
    }
  });
  const host = modals.at(-1) ?? document.body;
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) void c.close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="approve-here-title"
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl border border-gold/50 bg-panel p-4 shadow-2xl"
        data-testid="approve-here"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="eyebrow text-gold">
            {waiting ? "Your approval" : done ? "Done" : failed ? "Not done" : "Working on it"}
          </p>
          <button
            type="button"
            aria-label={waiting ? "Cancel" : "Close"}
            onClick={() => void c.close()}
            className="rounded-md p-1 text-muted hover:text-ink"
          >
            <X strokeWidth={1.5} className="h-4 w-4" />
          </button>
        </div>
        <h2 id="approve-here-title" className="mt-1 text-[1.05rem] text-ink">
          {j?.title ?? "Planning..."}
        </h2>

        {j && j.steps.length > 1 && !waiting && (
          // A plan of several steps (a big batch) shows how far it has got.
          <div className="mt-3" data-testid="approve-here-progress">
            <div
              role="progressbar"
              aria-label="Steps done"
              aria-valuemin={0}
              aria-valuemax={j.steps.length}
              aria-valuenow={j.steps.filter((s) => s.status === "succeeded").length}
              className="h-1.5 overflow-hidden rounded-full bg-raised"
            >
              <div
                className="h-full bg-gold transition-[width] duration-300"
                style={{
                  width: `${(100 * j.steps.filter((s) => s.status === "succeeded").length) / j.steps.length}%`,
                }}
              />
            </div>
            <p className="mt-1 text-[0.76rem] text-muted">
              {j.steps.filter((s) => s.status === "succeeded").length} of {j.steps.length} steps
              done
            </p>
          </div>
        )}
        {j && (
          <ol className="mt-3 space-y-3">
            {j.steps.map((s) => (
              <li key={s.seq} className="rounded-xl border border-line p-3 text-[0.84rem]">
                <p className="text-ink">{s.label}</p>
                {s.change?.settings.length ? (
                  <dl className="mt-2 space-y-1.5">
                    {s.change.settings.map((x) => (
                      <div key={x.name} className="grid gap-0.5">
                        <dt className="text-[0.74rem] text-muted">{x.name}</dt>
                        <dd className="text-muted">
                          <span className="break-words">{x.before}</span>
                          <span className="mx-1.5 text-faint">→</span>
                          <span className="break-words text-gold">{x.after}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {!waiting && s.result && <p className="mt-1.5 text-muted">{s.result}</p>}
              </li>
            ))}
          </ol>
        )}

        {c.error && <p className="mt-3 text-[0.84rem] text-amber">{c.error}</p>}
        {done && !results.length && <p className="mt-3 text-live">Done and checked.</p>}
        {failed && !results.length && (
          <p className="mt-3 text-amber">{j?.summary || "It did not work."}</p>
        )}
        <ApprovalError
          error={c.approveError}
          onConfirmed={() => void c.approve()}
          className="mt-3"
        />

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {waiting ? (
            <>
              <Button tone="quiet" onClick={() => void c.close()} data-testid="approve-here-cancel">
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={c.busy}
                onClick={() => void c.approve()}
                data-testid="approve-here-approve"
              >
                Approve
              </Button>
            </>
          ) : (
            <Button
              tone="quiet"
              disabled={j?.status === "running"}
              onClick={() => void c.close()}
              data-testid="approve-here-close"
            >
              {j?.status === "running" ? "Working..." : "Close"}
            </Button>
          )}
        </div>
      </div>
    </div>,
    host,
  );
}
