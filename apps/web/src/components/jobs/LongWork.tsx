import { WORK_STATUS_TEXT, type TrackedWork } from "@dragon-control/core";
import { useLongWork } from "../../data/jobs";
import { Section, StatusDot, Tag } from "../ui";

const ago = (iso: string) => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

const at = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/**
 * Jobs > Long work: what scripts on your machines report (a key with the "work" scope). Shown
 * only when there is some. A stalled one is amber: Hearth has not heard from it.
 */
export function LongWork() {
  const work = useLongWork();
  const list = work.data ?? [];
  if (!list.length) return null;
  return (
    <Section title="Long work">
      <ul className="divide-y divide-line" data-testid="long-work">
        {list.map((w) => (
          <LongWorkRow key={w.id} w={w} />
        ))}
      </ul>
    </Section>
  );
}

function LongWorkRow({ w }: { w: TrackedWork }) {
  const health =
    w.status === "stalled" || w.overdue
      ? "attention"
      : w.status === "failed"
        ? "offline"
        : "healthy";
  return (
    <li className="flex items-start gap-4 py-3">
      <StatusDot health={health} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <p className="text-[0.95rem] text-ink">{w.title}</p>
          <p className="text-[0.8rem] text-faint">{w.machine}</p>
        </div>
        {w.progress !== undefined && (
          <div
            role="progressbar"
            aria-label={`${w.title} progress`}
            aria-valuenow={Math.round(w.progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-2 h-[3px] w-full max-w-md overflow-hidden rounded-full bg-line"
          >
            <div className="h-full rounded-full bg-gold/80" style={{ width: `${w.progress}%` }} />
          </div>
        )}
        <p className="mt-1 text-[0.8rem] text-faint">
          {w.progress !== undefined ? `${Math.round(w.progress)}% · ` : ""}
          {w.status === "running" || w.status === "stalled"
            ? `last report ${ago(w.heartbeatAt)}`
            : `${WORK_STATUS_TEXT[w.status].toLowerCase()} ${ago(w.finishedAt ?? w.heartbeatAt)}`}
          {w.stopBy && (w.status === "running" || w.status === "stalled")
            ? ` · must stop by ${at(w.stopBy)}`
            : ""}
        </p>
        {w.detail && <p className="mt-0.5 truncate text-[0.8rem] text-muted">{w.detail}</p>}
      </div>
      <div className="shrink-0">
        <Tag tone={health === "healthy" ? (w.status === "running" ? "gold" : "neutral") : "warn"}>
          {w.overdue ? "Past its stop time" : WORK_STATUS_TEXT[w.status]}
        </Tag>
      </div>
    </li>
  );
}
