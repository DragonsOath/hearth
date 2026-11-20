import { Pause, Play } from "lucide-react";
import { useUsenet, type UsenetData as Data } from "./client";
import { Button } from "../../ui";
import { ChangeCard, useConfirmedChange } from "../ConfirmedChange";

/** The Usenet panel pieces (SABnzbd, NZBGet) shared by Overview and the Downloads tab. */

export type SabOp =
  "pause-all" | "resume-all" | "pause" | "resume" | "retry" | "remove" | "remove-history";

export const PRIORITIES = ["force", "high", "normal", "low"] as const;
export const sel =
  "min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.78rem] text-ink disabled:opacity-50";
export const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-50";

export const size = (mb?: number) =>
  mb === undefined ? "" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;

const PAUSE_FOR = [
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "1 hour"],
  [120, "2 hours"],
  [360, "6 hours"],
] as const;

/** Everything at once: pause or resume all, pause for a while, and the speed limit. */
export function SabControls({ serviceId, d }: { serviceId: string; d: Data }) {
  const all = useConfirmedChange(serviceId);
  const client = useUsenet();
  const now = client.limitNow(d);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        tone={d.paused ? "primary" : "outline"}
        data-testid={d.paused ? "sab-resume-all" : "sab-pause-all"}
        onClick={() => {
          const op: SabOp = d.paused ? "resume-all" : "pause-all";
          void all.propose(
            client.kind,
            { op },
            d.paused ? "Resume all downloads" : "Pause all downloads",
          );
        }}
      >
        {d.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        {d.paused ? "Resume all" : "Pause all"}
      </Button>
      {!d.paused && (
        <select
          className={sel}
          value=""
          aria-label="Pause for a while"
          data-hearth-target="sab:pause-for"
          onChange={(e) => {
            const minutes = Number(e.target.value);
            if (minutes)
              void all.propose(
                client.kind,
                { op: "pause-for", value: String(minutes) },
                "Pause downloads for a while",
              );
          }}
        >
          <option value="">Pause for...</option>
          {PAUSE_FOR.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
      )}
      <select
        className={sel}
        value={now}
        aria-label="Speed limit"
        data-hearth-target="sab:speed-limit"
        onChange={(e) =>
          void all.propose(
            client.kind,
            { op: "speed-limit", value: e.target.value },
            "Change the download speed limit",
          )
        }
      >
        {client.limits.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
        {!client.limits.some((l) => l.value === now) && (
          <option value={now}>
            {d.speedLimit ? `Limit to ${d.speedLimit}` : `Limit (${now})`}
          </option>
        )}
      </select>
      {d.paused && d.pausedMinutes ? (
        <span className="text-[0.78rem] text-amber" data-testid="sab-paused-for">
          Resumes by itself in about {d.pausedMinutes} min
        </span>
      ) : null}
      {d.speedLimit && <span className="text-[0.78rem] text-faint">({d.speedLimit})</span>}
      <ChangeCard c={all} />
    </div>
  );
}

/** Its warnings, newest last, with the way to clear them where it can (a plan, confirmed here). */
export function SabWarnings({ serviceId, d }: { serviceId: string; d: Data }) {
  const c = useConfirmedChange(serviceId);
  const client = useUsenet();
  // Once cleared, the card stays to show the result; with nothing to show, nothing at all.
  if (!d.warnings.length && !c.job && !c.error) return null;
  return (
    <div className="space-y-2 rounded-xl border border-amber/40 p-3" data-testid="sab-warnings">
      {d.warnings.length > 0 ? (
        <ul className="space-y-1 text-[0.8rem] text-amber">
          {d.warnings.map((w, i) => (
            <li key={i} className="break-words">
              {w}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.8rem] text-muted">No warnings.</p>
      )}
      {d.warnings.length > 0 && client.clearWarnings && (
        <button
          type="button"
          className={btn}
          disabled={c.busy}
          data-hearth-target="warnings:clear"
          data-testid="sab-clear-warnings"
          onClick={() =>
            void c.propose(client.kind, { op: "clear-warnings" }, "Clear the warnings")
          }
        >
          Clear warnings
        </button>
      )}
      <ChangeCard c={c} />
    </div>
  );
}
