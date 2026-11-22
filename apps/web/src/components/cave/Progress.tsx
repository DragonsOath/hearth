import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Check, ChevronDown, Clock3, Eye, Minus, X } from "lucide-react";
import type { CaveActivity, Job, JobStep } from "@dragon-control/core";
import { cx } from "../ui";
import { useJob, useJobDecision, useJobs } from "../../data/jobs";
import { useOnScreen } from "../jobs/onScreen";
import { useDesk, usePanelHref } from "../desk/links";
import { askToNotify, markApproved } from "../shell/PlanNotices";
import { ApprovalError } from "../jobs/ApprovalError";
import { showAgain } from "../show/bus";
import { clockTime } from "../../lib/format";

/**
 * What Ember actually did to answer a message, as it happened:
 * gathering facts, asking the AI, each tool it used, plans it proposed.
 * Nothing here is predicted; a step appears when it starts. Plans show the
 * job as it is now (waiting for you, running step by step, done, failed).
 */

/** Plans whose Home rows panel was opened already (once per plan, 11-06: "you watch it"). */
const ROWS_OPENED = new Set<string>();

/** A plan that builds or changes Plex home-screen rows. */
const isRowsPlan = (j: Job) =>
  j.steps.some(
    (s) => s.kind === "app-plex-control" && /^home-(row|layout)-/.test(String(s.params?.op ?? "")),
  );

type Tone = "running" | "done" | "failed" | "waiting" | "stopped" | "pending";

const TONE_TEXT: Record<Tone, string> = {
  running: "In progress",
  done: "Done",
  failed: "Did not work",
  waiting: "Waiting for you",
  stopped: "Stopped",
  pending: "Not started",
};

function Mark({ tone }: { tone: Tone }) {
  const base = "flex h-5 w-5 shrink-0 items-center justify-center rounded-full";
  if (tone === "running") {
    return (
      <span className={cx(base, "border border-gold/60")}>
        <span className="h-2 w-2 animate-pulse rounded-full bg-gold motion-reduce:animate-none" />
      </span>
    );
  }
  if (tone === "done")
    return (
      <span className={cx(base, "bg-live/15 text-live")}>
        <Check strokeWidth={2} className="h-3 w-3" />
      </span>
    );
  if (tone === "failed")
    return (
      <span className={cx(base, "bg-alert/15 text-alert")}>
        <X strokeWidth={2} className="h-3 w-3" />
      </span>
    );
  if (tone === "waiting")
    return (
      <span className={cx(base, "bg-amber/15 text-amber")}>
        <Clock3 strokeWidth={2} className="h-3 w-3" />
      </span>
    );
  return (
    <span className={cx(base, "border border-line text-faint")}>
      <Minus strokeWidth={2} className="h-3 w-3" />
    </span>
  );
}

function stepTone(s: JobStep): Tone {
  switch (s.status) {
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "rolled-back":
    case "interrupted":
    case "skipped":
      return "stopped";
    default:
      return "pending";
  }
}

const STEP_TEXT: Partial<Record<JobStep["status"], string>> = {
  "rolled-back": "Undone",
  skipped: "Skipped",
  interrupted: "Interrupted",
};

/**
 * How long a running step has been going, ticking every second (11-12, the owner: "I need an
 * indicator it's still working").
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return (
    <span className="text-faint tabular-nums" data-testid="activity-elapsed">
      {" "}
      · still working,{" "}
      {s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}
    </span>
  );
}

function seconds(from: string, to: string) {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/**
 * A plan the AI proposed, live: approve or decline it here, then watch each step. With Show &
 * Tell it also sits beside the setting it changes (`beside`), and "Show me" puts that setting
 * back on screen from the conversation.
 */
export function JobCard({
  id,
  fallback,
  beside,
  inRows,
  dock,
}: {
  id: string;
  fallback?: CaveActivity;
  /** Shown on screen next to the setting it changes (Show & Tell): no "Show me" needed. */
  beside?: boolean;
  /** Shown inside the Home rows panel itself (no link to it). */
  inRows?: boolean;
  /** In the approval prompt (ApprovalDock), which shows the plans not on screen elsewhere. */
  dock?: boolean;
}) {
  // This plan's approval is on screen here, so the approval prompt leaves it alone.
  useOnScreen(id, !dock);
  const job = useJob(id);
  const decide = useJobDecision();
  const j: Job | undefined = job.data;
  const desk = useDesk();
  const href = usePanelHref();
  const navigate = useNavigate();
  const rows = Boolean(j && !inRows && isRowsPlan(j));
  const live = Boolean(j && ["awaiting-approval", "running"].includes(j.status));
  // A new home-row plan opens Home rows beside the chat, so the row is watched being built.
  useEffect(() => {
    if (!rows || !live || !desk || !j || ROWS_OPENED.has(j.id)) return;
    ROWS_OPENED.add(j.id);
    const to = href("tool:home-rows");
    if (to) void navigate(to);
  }, [rows, live, desk, j, href, navigate]);
  if (!j) {
    return (
      <div className="rounded-xl border border-line px-3 py-2 text-[0.84rem] text-muted">
        {fallback?.label ?? "Plan"}
      </div>
    );
  }
  const waiting = j.status === "awaiting-approval";
  const approve = () => {
    askToNotify();
    markApproved(j.id);
    decide.mutate({ id: j.id, decision: "approve", fingerprint: j.approval!.fingerprint });
  };
  const guarded = j.steps.some((s) => s.params?.protected === "yes");
  const shown = !beside ? fallback?.show : undefined;
  return (
    <div
      className={cx(
        "rounded-xl border px-3 py-3",
        waiting ? "border-amber/50 bg-amber/5" : "border-line bg-bg/40",
      )}
      data-testid="cave-job"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[0.86rem] text-ink">
          <span className="text-faint">Plan: </span>
          {j.title}
        </p>
        <span className="flex items-baseline gap-3">
          {shown && (
            <button
              type="button"
              data-testid="job-show-me"
              onClick={() =>
                showAgain({
                  place: shown.place,
                  ...(shown.target ? { target: shown.target } : {}),
                  caption: `What this plan changes: ${j.title}`,
                })
              }
              className="inline-flex min-h-8 items-center gap-1 text-[0.76rem] text-gold hover:underline"
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} /> Show me
            </button>
          )}
          {rows && (
            <Link
              to={href("tool:home-rows") ?? "/"}
              className="text-[0.76rem] text-gold hover:underline"
              data-testid="job-home-rows"
            >
              Watch it in Home rows
            </Link>
          )}
          <Link to={`/jobs/${j.id}`} className="text-[0.76rem] text-gold hover:underline">
            Full plan
          </Link>
        </span>
      </div>
      {(j.reason || j.impact) && (
        <div className="mt-1.5 space-y-0.5 text-[0.78rem] text-muted" data-testid="job-why">
          {j.reason && (
            <p>
              <span className="text-faint">Why: </span>
              {j.reason}
            </p>
          )}
          {j.impact && (
            <p>
              <span className="text-faint">If you approve: </span>
              {j.impact}
            </p>
          )}
        </div>
      )}
      <ol className="mt-2 space-y-1.5">
        {j.steps.map((s) => {
          const tone = stepTone(s);
          return (
            <li key={s.seq} className="flex items-start gap-2 text-[0.82rem]">
              <Mark tone={tone} />
              <span className="min-w-0 flex-1">
                <span className={tone === "pending" ? "text-muted" : "text-ink"}>{s.label}</span>
                <span className="text-faint"> · {STEP_TEXT[s.status] ?? TONE_TEXT[tone]}</span>
                {s.verified && (
                  <span className="text-live" data-testid="step-verified">
                    {" "}
                    · Verified by reading it back
                  </span>
                )}
                {s.change && (
                  <span
                    className="mt-1 block space-y-0.5 [overflow-wrap:anywhere]"
                    data-testid="step-change"
                  >
                    {s.change.settings.map((c) =>
                      waiting ? (
                        <span key={c.name} className="block text-[0.76rem] text-muted">
                          {c.name}: now <span className="text-ink">{c.before}</span>, proposed{" "}
                          <span className="text-gold">{c.after}</span>
                        </span>
                      ) : (
                        <span key={c.name} className="block text-[0.76rem] text-muted">
                          {c.name}: <span className="text-ink">{c.before}</span>
                          {" to "}
                          <span className="text-gold">{c.after}</span>
                        </span>
                      ),
                    )}
                    {waiting && (
                      <span className="block text-[0.72rem] text-faint">
                        Current values read from {s.serviceName} when the plan was made,{" "}
                        {clockTime(j.createdAt)}. Hearth checks them again before it changes
                        anything.
                      </span>
                    )}
                  </span>
                )}
                {s.result && tone !== "pending" && (
                  <span className="block text-[0.76rem] text-muted">{s.result}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {j.status === "running" && (
        <p
          role="status"
          className="mt-2 flex items-center gap-2 text-[0.78rem] text-gold"
          data-testid="job-running"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-gold motion-reduce:animate-none" />
          Approved. Running now; you'll get a notice when it finishes.
        </p>
      )}
      {j.summary && !waiting && (
        <p className="mt-2 text-[0.78rem] leading-relaxed text-muted">{j.summary}</p>
      )}
      {j.approvedAt && (
        <p className="mt-1 text-[0.74rem] text-faint" data-testid="job-approved">
          Approved by you at {clockTime(j.approvedAt)}.
        </p>
      )}
      {waiting && j.approval && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="w-full text-[0.78rem] text-amber">
            Nothing has run. It waits for your approval of exactly these steps.
            {guarded && " It changes a protected system, so you'll confirm it's you."}
          </p>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={approve}
            className="dc-primary min-h-10 rounded-lg bg-gold px-4 text-[0.84rem] text-bg hover:bg-gold-bright disabled:opacity-50"
          >
            Approve and run
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ id: j.id, decision: "decline" })}
            className="min-h-10 rounded-lg border border-line px-4 text-[0.84rem] text-muted hover:text-ink disabled:opacity-50"
          >
            Decline
          </button>
          <ApprovalError
            error={decide.error}
            onConfirmed={approve}
            className="w-full text-[0.78rem]"
          />
        </div>
      )}
    </div>
  );
}

/** A Show & Tell step: what Ember pointed at, whether it was on screen, and Show again. */
function ShowRow({ a }: { a: CaveActivity }) {
  const shown = a.show;
  return (
    <li className="flex items-start gap-2.5 text-[0.82rem]" data-testid="show-step">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gold/10 text-gold">
        <Eye strokeWidth={1.75} className="h-3 w-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={a.status === "running" ? "text-ink" : "text-muted"}>
          {shown?.action === "click"
            ? "Clicked for you"
            : shown?.action === "type"
              ? "Typed for you"
              : "Showed you"}
          : {a.label}
        </span>
        {a.status === "running" && <span className="text-faint"> · putting it on screen</span>}
        {a.status === "stopped" && <span className="text-faint"> · not shown</span>}
        {a.detail && <span className="block text-[0.76rem] text-faint">{a.detail}</span>}
        {shown && a.status !== "running" && (
          <button
            type="button"
            onClick={() =>
              showAgain({
                place: shown.place,
                ...(shown.target ? { target: shown.target } : {}),
                caption: a.label,
              })
            }
            className="mt-0.5 block min-h-8 text-[0.76rem] text-gold hover:underline"
          >
            Show again
          </button>
        )}
      </span>
    </li>
  );
}

function Row({ a }: { a: CaveActivity }) {
  if (a.kind === "show") return <ShowRow a={a} />;
  return <PlainRow a={a} />;
}

function PlainRow({ a }: { a: CaveActivity }) {
  const href = usePanelHref()(a.ref);
  const label = href ? (
    <Link to={href} className="hover:text-gold">
      {a.label}
    </Link>
  ) : (
    a.label
  );
  return (
    <li className="flex items-start gap-2.5 text-[0.82rem]">
      <Mark tone={a.status} />
      <span className="min-w-0 flex-1">
        <span className={a.status === "running" ? "text-ink" : "text-muted"}>{label}</span>
        {a.status === "running" && <Elapsed since={a.at} />}
        {a.status === "failed" || a.status === "stopped" ? (
          <span className="text-faint"> · {TONE_TEXT[a.status]}</span>
        ) : null}
        {a.detail && <span className="block text-[0.76rem] text-faint">{a.detail}</span>}
        {a.evidence && <EvidenceCard e={a.evidence} />}
      </span>
    </li>
  );
}

/**
 * Where what a step read came from, as the tool itself reported it on the server (never the
 * AI's words): a web page's address with a short excerpt, or the app and API path it read.
 */
function EvidenceCard({ e }: { e: NonNullable<CaveActivity["evidence"]> }) {
  const web = e.kind === "web" && /^https?:\/\//.test(e.source);
  return (
    <span
      className="mt-1 block rounded-lg border border-line bg-bg/50 px-2.5 py-1.5 text-[0.76rem]"
      data-testid="evidence-card"
      data-kind={e.kind}
    >
      <span className="block text-faint">
        {web ? "From the web" : "From the app"} · read {clockTime(e.at)}
      </span>
      {web ? (
        <a
          href={e.source}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-gold hover:underline"
        >
          {e.title || e.source}
        </a>
      ) : (
        <span className="block truncate text-ink">{e.source}</span>
      )}
      {web && e.title && <span className="block truncate text-faint">{e.source}</span>}
      {e.excerpt && <span className="mt-0.5 block text-muted">&ldquo;{e.excerpt}&rdquo;</span>}
    </span>
  );
}

/**
 * Under your message: the steps, open while the answer is being worked on,
 * folded into one line afterwards. Plans stay visible, since they may need you.
 */
/**
 * The plans a turn proposed, each with its Approve button. Shown under Ember's answer, so the
 * button is the last thing in the conversation (11-06: "that approve button needs to be
 * visible").
 */
export function PlanCards({ activity }: { activity: CaveActivity[] }) {
  const jobs = activity.filter((a) => a.kind === "job" && a.ref?.startsWith("job:"));
  if (!jobs.length) return null;
  return (
    <li className="max-w-[96%] space-y-2 pl-11" data-testid="cave-plans">
      {jobs.map((a) => (
        <JobCard key={a.id} id={a.ref!.slice(4)} fallback={a} />
      ))}
    </li>
  );
}

/** The plans a conversation's turns recorded (their cards are drawn with those turns). */
export function plansIn(messages: { activity?: CaveActivity[] }[]) {
  return new Set(
    messages.flatMap((m) =>
      (m.activity ?? [])
        .filter((a) => a.kind === "job" && a.ref?.startsWith("job:"))
        .map((a) => a.ref!.slice(4)),
    ),
  );
}

/**
 * Plans proposed in this conversation whose card no turn drew (11-22: the next build step was
 * planned in an automatic follow-up, so its card attached nowhere the owner could see, and Ember
 * said "the approval card is just below" over nothing). Any tool, any AI agent: if a plan was
 * made in this chat and is waiting or running, its card is here, at the end of the chat.
 */
export function ConversationPlans({
  conversationId,
  drawn,
}: {
  conversationId: string;
  drawn: ReadonlySet<string>;
}) {
  const jobs = useJobs();
  const mine = (jobs.data ?? [])
    .filter(
      (j) =>
        j.conversationId === conversationId &&
        !drawn.has(j.id) &&
        (j.status === "awaiting-approval" || j.status === "running"),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!mine.length) return null;
  return (
    <li className="max-w-[96%] space-y-2 pl-11" data-testid="conversation-plans">
      {mine.map((j) => (
        <JobCard key={j.id} id={j.id} />
      ))}
    </li>
  );
}

export function Progress({
  activity,
  live,
  plans = true,
}: {
  activity: CaveActivity[];
  live: boolean;
  /** Its plans here (while Ember is still answering); otherwise they go under the answer. */
  plans?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const steps = activity.filter((a) => a.kind !== "job");
  const jobs = activity.filter((a) => a.kind === "job" && a.ref?.startsWith("job:"));
  const first = activity[0];
  const last = [...activity].reverse().find((a) => a.finishedAt)?.finishedAt;
  const failed = steps.filter((a) => a.status === "failed").length;
  const shown = live || open;
  return (
    <li className="max-w-[96%] pl-11" data-testid="cave-progress">
      {live ? (
        <p className="mb-2 text-[0.72rem] tracking-[0.12em] text-gold uppercase" role="status">
          Working on it
        </p>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="mb-1 flex min-h-9 items-center gap-1.5 text-[0.78rem] text-muted hover:text-gold"
        >
          <ChevronDown
            strokeWidth={1.5}
            className={cx("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
          />
          {steps.length} {steps.length === 1 ? "step" : "steps"}
          {first && last ? ` · ${seconds(first.at, last)}` : ""}
          {failed ? ` · ${failed} did not work` : ""}
        </button>
      )}
      {shown && (
        <ol className="space-y-1.5" aria-label="What Ember did">
          {steps.map((a) => (
            <Row key={a.id} a={a} />
          ))}
        </ol>
      )}
      {plans && jobs.length > 0 && (
        <div className="mt-2 space-y-2">
          {jobs.map((a) => (
            <JobCard key={a.id} id={a.ref!.slice(4)} fallback={a} />
          ))}
        </div>
      )}
    </li>
  );
}
