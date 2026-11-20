import { Link, useParams } from "react-router";
import type { Job, JobStep, JobStepStatus } from "@dragon-control/core";
import { Button, EmptyState, PageSkeleton, Panel, Section, Tag, cx } from "../components/ui";
import { useJob, useJobDecision, useStopJob } from "../data/jobs";
import { ago, dateTime, fullDateTime } from "../lib/format";
import { BackLink } from "./ServiceDetail";
import { usePanelHref } from "../components/desk/links";
import { WHO, jobTag } from "./Jobs";
import { askToNotify, markApproved } from "../components/shell/PlanNotices";
import { ApprovalError } from "../components/jobs/ApprovalError";

const STEP_LABEL: Record<JobStepStatus, string> = {
  pending: "Waiting",
  running: "Running now",
  succeeded: "Done and verified",
  failed: "Failed",
  skipped: "Not run",
  "rolled-back": "Undone",
  interrupted: "Interrupted",
};

const stepMark: Record<JobStepStatus, string> = {
  pending: "border-line-strong bg-panel",
  running: "border-gold bg-gold animate-pulse",
  succeeded: "border-ok bg-ok",
  failed: "border-bad bg-bad",
  skipped: "border-line-strong bg-transparent",
  "rolled-back": "border-gold bg-transparent",
  interrupted: "border-warn bg-transparent",
};

const POLICY_LABEL: Record<JobStep["policy"], string> = {
  allow: "Allowed",
  "approve-first": "Needs approval",
  refuse: "Not allowed",
};

/** A plan made from a workspace: frozen decisions, independent items, the workspace one click away. */
function FromWorkspace({ job }: { job: Job }) {
  const href = usePanelHref();
  return (
    <div data-testid="job-from-workspace">
      <Panel className="mb-10 p-5">
        <p className="text-[0.9rem] leading-relaxed text-muted">
          Made from your workspace decisions as you submitted them (a frozen snapshot: later edits
          to the workspace do not change this plan). Each item runs on its own: a target that
          changed is skipped, and a failure does not stop or undo the others.{" "}
          <Link
            to={href(`workspace:${job.workspace!.id}`)!}
            className="text-gold underline underline-offset-4"
          >
            Open the workspace
          </Link>
        </p>
      </Panel>
    </div>
  );
}

function Steps({ job }: { job: Job }) {
  return (
    <ol className="relative" aria-label="Steps" data-testid="job-steps">
      {job.steps.map((step, i) => (
        <li key={step.seq} className="relative flex gap-5 pb-8 last:pb-0">
          {i < job.steps.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute top-3 bottom-0 left-[4.5px] w-px bg-line"
            />
          )}
          <span
            aria-hidden="true"
            className={cx(
              "relative mt-1.5 h-2.5 w-2.5 shrink-0 rotate-45 border",
              stepMark[step.status],
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[0.75rem] tracking-wide text-faint">
              Step {step.seq} · {STEP_LABEL[step.status]}
              {step.changes && " · Changes something"}
            </p>
            {step.itemId && (
              <p className="mt-0.5 font-mono text-[0.74rem] break-all text-faint">
                Item: {step.itemId}
              </p>
            )}
            <p className="mt-1 text-[0.98rem] text-ink">
              {step.label}{" "}
              <Link to={`/services/${step.serviceId}`} className="sr-only">
                (open {step.serviceName})
              </Link>
            </p>
            {step.change && (
              <table className="mt-2 w-full text-left text-[0.84rem]" data-testid="job-step-change">
                <caption className="sr-only">Exact change</caption>
                <thead>
                  <tr className="text-[0.72rem] tracking-[0.1em] text-faint uppercase">
                    <th className="py-1 pr-3 font-normal">Setting</th>
                    <th className="py-1 pr-3 font-normal">Before</th>
                    <th className="py-1 font-normal">After</th>
                  </tr>
                </thead>
                <tbody>
                  {step.change.settings.map((c) => (
                    <tr key={c.name} className="border-t border-line">
                      <td className="py-1.5 pr-3 text-muted">{c.name}</td>
                      <td className="py-1.5 pr-3 text-ink">{c.before}</td>
                      <td className="py-1.5 text-gold">{c.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {step.result && (
              <p className="mt-1 text-[0.88rem] leading-relaxed text-muted">{step.result}</p>
            )}
            <dl className="mt-2 grid gap-1 text-[0.8rem] leading-relaxed text-faint">
              <div>
                <dt className="inline text-muted">Checked by: </dt>
                <dd className="inline">{step.verify}</dd>
              </div>
              {job.workspace ? (
                <div>
                  <dt className="inline text-muted">On its own: </dt>
                  <dd className="inline">
                    if this item is skipped or fails, nothing else is undone and the other items
                    still run.
                  </dd>
                </div>
              ) : (
                <div>
                  <dt className="inline text-muted">If a later step fails: </dt>
                  <dd className="inline">{step.rollback}</dd>
                </div>
              )}
              <div>
                <dt className="inline text-muted">Policy when planned: </dt>
                <dd className="inline">
                  {POLICY_LABEL[step.policy]}. {step.policyReason}
                </dd>
              </div>
            </dl>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Decision({ job }: { job: Job }) {
  const decide = useJobDecision();
  const stop = useStopJob();
  if (job.status === "running") {
    return (
      <Panel className="mb-12 p-6 sm:p-8">
        <p className="eyebrow mb-3 text-gold">Running</p>
        <p className="text-[0.9rem] leading-relaxed text-muted" aria-live="polite">
          Carrying out the steps in order. Each step is checked before the next one starts.
        </p>
        <div className="mt-5">
          <Button disabled={stop.isPending} onClick={() => stop.mutate(job.id)}>
            Stop after this step
          </Button>
        </div>
      </Panel>
    );
  }
  if (job.status !== "awaiting-approval") return null;
  const approve = () => {
    askToNotify();
    markApproved(job.id);
    decide.mutate({ id: job.id, decision: "approve", fingerprint: job.approval?.fingerprint });
  };
  const changes = job.steps.filter((s) => s.changes).length;
  return (
    <Panel className="mb-12 border-gold/30 p-6 sm:p-8">
      <p className="eyebrow mb-3 text-gold">Your approval</p>
      <p className="font-display text-[1.5rem] leading-snug text-ink">
        {job.steps.length} {job.steps.length === 1 ? "step" : "steps"},{" "}
        {changes
          ? `${changes} that ${changes === 1 ? "changes" : "change"} something`
          : "none change anything"}
        .
      </p>
      <p className="mt-3 text-[0.85rem] leading-relaxed text-muted">
        Your approval covers exactly this plan, once. Each step is checked against your autonomy
        settings again when it runs, and the job stops at the first problem.
      </p>
      {job.approval && (
        <p className="mt-2 text-[0.8rem] text-faint" data-testid="job-approval-expiry">
          Can be approved until {dateTime(job.approval.expiresAt)}. After that it lapses and nothing
          changes.
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <Button tone="primary" disabled={decide.isPending || !job.approval} onClick={approve}>
          Approve and run
        </Button>
        <Button
          disabled={decide.isPending}
          onClick={() => decide.mutate({ id: job.id, decision: "decline" })}
        >
          Decline
        </Button>
      </div>
      <ApprovalError error={decide.error} onConfirmed={approve} className="mt-4 text-[0.85rem]" />
    </Panel>
  );
}

export function JobDetailPage() {
  const { id } = useParams();
  const job = useJob(id);
  if (job.isLoading) return <PageSkeleton />;
  if (!job.data) {
    return (
      <>
        <BackLink to="/jobs">Jobs</BackLink>
        <EmptyState title="Job not found">
          It may have been planned on another installation.
        </EmptyState>
      </>
    );
  }
  const j = job.data;
  const finished = j.steps.filter((s) => s.status !== "pending" && s.status !== "running").length;
  return (
    <>
      <BackLink to="/jobs">Jobs</BackLink>
      <header className="mb-10">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {jobTag(j.status)}
          <Tag>{WHO[j.requestedBy]}</Tag>
        </div>
        <h1 className="font-display text-[2.3rem] leading-[1.08] text-ink sm:text-[2.9rem]">
          {j.title}
        </h1>
        {j.reason && (
          <p className="mt-3 max-w-xl text-[0.95rem] leading-relaxed text-muted">{j.reason}</p>
        )}
        <p className="mt-3 text-[0.8rem] text-faint">
          Planned {ago(j.createdAt)}
          {j.approvedAt && ` · approved ${fullDateTime(j.approvedAt)}`}
          {j.finishedAt && ` · finished ${fullDateTime(j.finishedAt)}`}
          {j.incidentId && (
            <>
              {" · "}
              <Link to={`/incidents/${j.incidentId}`} className="text-gold hover:text-gold-bright">
                the incident it serves
              </Link>
            </>
          )}
        </p>
      </header>

      <Decision job={j} />
      {j.summary && (
        <Panel className="mb-12 p-6 sm:p-8">
          <p className="eyebrow mb-3">Outcome</p>
          <p className="text-[0.95rem] leading-relaxed text-ink" data-testid="job-summary">
            {j.summary}
          </p>
        </Panel>
      )}
      {j.workspace && <FromWorkspace job={j} />}
      <Section title="Steps">
        {j.status === "running" && (
          <div className="mb-6">
            <div
              role="progressbar"
              aria-label="Progress"
              aria-valuenow={finished}
              aria-valuemin={0}
              aria-valuemax={j.steps.length}
              aria-valuetext={`${finished} of ${j.steps.length} steps`}
              className="h-[3px] w-full overflow-hidden rounded-full bg-line"
            >
              <div
                className="h-full rounded-full bg-gold/80 transition-[width] duration-300"
                style={{ width: `${(finished / j.steps.length) * 100}%` }}
              />
            </div>
          </div>
        )}
        <Steps job={j} />
      </Section>
    </>
  );
}
