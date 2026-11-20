import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Send } from "lucide-react";
import type { ActionKind, StepParams } from "@dragon-control/core";
import { useJob, useJobDecision, usePlanJob } from "../../data/jobs";
import { api } from "../../data/api";
import type { CredentialStatus } from "@dragon-control/core";
import { Button } from "../ui";
import { ApprovalError } from "../jobs/ApprovalError";

/**
 * A change made from an app's panel: Hearth plans it (you see exactly what it does), you
 * confirm it right there, Hearth makes it in the app and reads it back, and the result (a new
 * invitation's link, say) is shown in place. Same plans, approvals, and audit as anywhere else.
 */

/** Plan, confirm, run, and wait for the result, all in the panel. */
export function useConfirmedChange(serviceId: string) {
  const plan = usePlanJob();
  const decide = useJobDecision();
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string>();
  const [error, setError] = useState<string>();
  // A protected change (the VPN) answers 403 until you confirm it is you; shown as that step.
  const [approveError, setApproveError] = useState<Error | null>(null);
  const job = useJob(jobId);
  const status = job.data?.status;
  const finished = status === "succeeded" || status === "failed" || status === "refused";
  useEffect(() => {
    if (!finished) return;
    // Now, and again once the server's short dashboard cache (1.5 s) has passed.
    // Home rows and the Plex panel's Manage tab show the same rows: a change in one shows in the
    // other right away (11-08).
    const refresh = () => {
      for (const key of [
        ["dashboard", serviceId],
        ["home-rows-options"],
        ["home-rows"],
        ["home-rows-posters"],
      ])
        void qc.invalidateQueries({ queryKey: key });
    };
    refresh();
    const t = setTimeout(refresh, 1_700);
    return () => clearTimeout(t);
  }, [finished, qc, serviceId]);
  return {
    job: job.data,
    error,
    approveError,
    busy: plan.isPending || decide.isPending || status === "running",
    /** A plan for this panel's app, or (target) another app it works with, such as Radarr. */
    propose: async (
      kind: ActionKind,
      params: StepParams,
      title: string,
      target?: string,
      /** More steps in the same plan, approved together (such as Radarr's, for Stop tracking). */
      more: { kind: ActionKind; serviceId: string; params: StepParams }[] = [],
    ) => {
      setError(undefined);
      try {
        const j = await plan.mutateAsync({
          title,
          reason: "From the app's panel in Hearth.",
          steps: [{ kind, serviceId: target ?? serviceId, params }, ...more],
        });
        if (j.status === "refused") setError(j.summary ?? "Not allowed.");
        else setJobId(j.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    confirm: async () => {
      if (!job.data?.approval) return;
      setApproveError(null);
      try {
        await decide.mutateAsync({
          id: job.data.id,
          decision: "approve",
          fingerprint: job.data.approval.fingerprint,
        });
      } catch (e) {
        if (e instanceof Error) setApproveError(e);
        else setError(String(e));
      }
    },
    cancel: async () => {
      if (job.data?.status === "awaiting-approval")
        await decide.mutateAsync({ id: job.data.id, decision: "decline" }).catch(() => undefined);
      setJobId(undefined);
      setError(undefined);
      setApproveError(null);
    },
  };
}

export function CopyLink({ url, label = "Copy link" }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const share = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <span className="inline-flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold"
        data-testid="panel-copy"
      >
        {copied ? (
          <Check strokeWidth={1.5} className="h-3.5 w-3.5" />
        ) : (
          <Copy strokeWidth={1.5} className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : label}
      </button>
      {share && (
        <button
          type="button"
          onClick={() =>
            void navigator.share({ title: "An invitation", url }).catch(() => undefined)
          }
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold"
        >
          <Send strokeWidth={1.5} className="h-3.5 w-3.5" /> Share
        </button>
      )}
    </span>
  );
}

/** The plan waiting for your OK, then its outcome (with the new link to send). */
export function ChangeCard({
  c,
  confirmLabel = "Confirm",
}: {
  c: ReturnType<typeof useConfirmedChange>;
  /** The approving button's words, naming what it does (Home rows: "Apply to Plex"). */
  confirmLabel?: string;
}) {
  const j = c.job;
  if (!j && !c.error) return null;
  // Every step's outcome, in order (a plan can change two apps, such as Stop tracking).
  const result =
    (j?.steps ?? [])
      .map((s) => s.result)
      .filter(Boolean)
      .join(" ") ||
    j?.summary ||
    "";
  const link = /Send this link: (\S+)/.exec(result)?.[1];
  return (
    <div
      className="rounded-xl border border-gold/50 bg-gold/5 p-3 text-[0.84rem]"
      data-testid="panel-change"
    >
      {c.error && <p className="text-amber">{c.error}</p>}
      {c.error && /limited to diagnostics/.test(c.error) && <AllowChanges message={c.error} />}
      {j?.status === "awaiting-approval" && (
        <>
          {j.steps.length > 1 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-ink">
              {j.steps.map((s, i) => (
                <li key={i}>{s.label}</li>
              ))}
            </ul>
          ) : (
            <p className="text-ink">{j.steps[0]?.label ?? j.title}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              tone="primary"
              disabled={c.busy}
              onClick={() => void c.confirm()}
              data-testid="panel-confirm"
            >
              {confirmLabel}
            </Button>
            <Button tone="quiet" onClick={() => void c.cancel()}>
              Cancel
            </Button>
          </div>
          <ApprovalError
            error={c.approveError}
            onConfirmed={() => void c.confirm()}
            className="mt-2"
          />
        </>
      )}
      {j?.status === "running" && <p className="text-muted">Working on it…</p>}
      {j?.status === "succeeded" && (
        <div data-testid="panel-done">
          <p className="text-live">{link ? "Invitation ready. Send this link:" : result}</p>
          {link && (
            <div className="mt-1.5 space-y-2">
              <p
                className="font-mono text-[0.8rem] break-all text-ink"
                data-testid="panel-new-link"
              >
                {link}
              </p>
              <CopyLink url={link} />
            </div>
          )}
        </div>
      )}
      {(j?.status === "failed" || j?.status === "refused") && (
        <p className="text-amber">{result || "It did not work."}</p>
      )}
    </div>
  );
}

/**
 * A key Hearth may only read with: allowing approved changes on it is the owner's choice, made
 * here in one step (every change still waits for its own confirmation).
 */
function AllowChanges({ message }: { message: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  // "Not allowed: Overseerr's credential is limited to diagnostics..."
  const name = /^(?:Not allowed: )?(.+?)'s credential/.exec(message)?.[1];
  if (!name) return null;
  const allow = async () => {
    setState("busy");
    try {
      const all = await api<CredentialStatus[]>("GET", "/api/credentials");
      const secret = all.find((c) => c.serviceName === name)?.secret;
      if (!secret) throw new Error(`No key for ${name} in Secure Vault.`);
      await api("PATCH", `/api/vault/secrets/${encodeURIComponent(secret.id)}`, {
        scope: "approved-changes",
      });
      setState("done");
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="mt-2 space-y-1.5" data-testid="panel-allow-changes">
      <p className="text-muted">
        Hearth can only read {name} so far. Allow changes you confirm, like this one? Nothing
        changes without your OK each time.
      </p>
      {state === "done" ? (
        <p className="text-live">Allowed. Try it again.</p>
      ) : (
        <Button tone="outline" disabled={state === "busy"} onClick={() => void allow()}>
          Allow confirmed changes in {name}
        </Button>
      )}
      {state !== "idle" && state !== "busy" && state !== "done" && (
        <p className="text-amber">{state}</p>
      )}
    </div>
  );
}
