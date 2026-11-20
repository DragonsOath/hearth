import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { JOB_DONE, type Job } from "@dragon-control/core";
import { useJobs } from "../../data/jobs";
import { cx } from "../ui";

/**
 * Tells you when an approved plan finishes, wherever you are in Hearth:
 * a notice in the corner (and a system notification when this tab is in the
 * background and you allowed them). It also refreshes the conversations, so
 * the "Plan finished" message the plan posts there shows up at once.
 */

interface Notice {
  id: string;
  jobId: string;
  title: string;
  ok: boolean;
  text: string;
}

const OK = new Set<Job["status"]>(["succeeded"]);

/** Plans approved on this page: a quick plan can go from waiting to done between two looks. */
const approvedHere = new Set<string>();
export function markApproved(id: string) {
  approvedHere.add(id);
}

/** Asks once, from a click (browsers only allow it then), whether finished plans may notify. */
export function askToNotify() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default")
      void Notification.requestPermission();
  } catch {
    // Not available here; the in-app notice still shows.
  }
}

export function PlanNotices() {
  const jobs = useJobs();
  const qc = useQueryClient();
  const seen = useRef<Map<string, Job["status"]> | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    const list = jobs.data;
    if (!list) return;
    const before = seen.current;
    seen.current = new Map(list.map((j) => [j.id, j.status]));
    if (!before) return; // first look: history is not news
    const finished = list.filter((j) => {
      const was = before.get(j.id);
      if (!JOB_DONE.includes(j.status) || was === undefined || JOB_DONE.includes(was)) return false;
      return was !== "awaiting-approval" || approvedHere.has(j.id);
    });
    if (!finished.length) return;
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    const fresh = finished.map((j) => ({
      id: `${j.id}-${j.status}`,
      jobId: j.id,
      title: j.title,
      ok: OK.has(j.status),
      text: j.summary ?? (OK.has(j.status) ? "Done and verified." : "It did not finish."),
    }));

    setNotices((n) => [...n, ...fresh].slice(-3));
    if (typeof document !== "undefined" && document.hidden) {
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted")
          for (const f of fresh)
            new Notification(`Plan ${f.ok ? "finished" : "did not finish"}: ${f.title}`, {
              body: f.text,
              icon: "/icon-192.png",
            });
      } catch {
        // Some browsers only notify through a service worker; the in-app notice is there.
      }
    }
  }, [jobs.data, qc]);

  // Each notice fades after a while; it can also be closed.
  useEffect(() => {
    if (!notices.length) return;
    const t = window.setTimeout(() => setNotices((n) => n.slice(1)), 12_000);
    return () => window.clearTimeout(t);
  }, [notices]);

  if (!notices.length) return null;
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-20 z-[80] flex w-[min(92vw,380px)] flex-col gap-2 md:bottom-6"
      aria-live="polite"
      data-testid="plan-notices"
    >
      {notices.map((n) => (
        <div
          key={n.id}
          role="status"
          className={cx(
            "pointer-events-auto flex items-start gap-3 rounded-xl border bg-raised px-4 py-3 shadow-lg",
            n.ok ? "border-live/40" : "border-alert/40",
          )}
        >
          <span
            className={cx(
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
              n.ok ? "bg-live/15 text-live" : "bg-alert/15 text-alert",
            )}
          >
            {n.ok ? (
              <Check strokeWidth={2} className="h-3.5 w-3.5" />
            ) : (
              <X strokeWidth={2} className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[0.86rem] text-ink">
              Plan {n.ok ? "finished" : "did not finish"}: {n.title}
            </p>
            <p className="mt-0.5 line-clamp-3 text-[0.78rem] leading-snug text-muted">{n.text}</p>
            <Link
              to={`/jobs/${n.jobId}`}
              className="mt-1 inline-block text-[0.76rem] text-gold hover:underline"
            >
              See the plan
            </Link>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setNotices((list) => list.filter((x) => x.id !== n.id))}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-faint hover:text-ink"
          >
            <X strokeWidth={1.5} className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
