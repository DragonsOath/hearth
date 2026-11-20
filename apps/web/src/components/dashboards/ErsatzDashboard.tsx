import { useState } from "react";
import { RotateCcw, Square, Tv } from "lucide-react";
import type { ErsatzDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";

/**
 * ErsatzTV from Hearth: every channel with what is on now (and until when) and what is next, from
 * ErsatzTV's own guide, and which channels someone is streaming. Rebuilding a channel's schedule
 * and stopping a channel's stream are plans confirmed here.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
const clock = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

function ChannelCard({ serviceId, c }: { serviceId: string; c: Data["channels"][number] }) {
  const ch = useConfirmedChange(serviceId);
  return (
    <li
      className={cx(
        "space-y-1.5 rounded-xl border bg-bg/50 p-3",
        c.streaming ? "border-live/40" : "border-line",
      )}
      data-testid="etv-channel"
      data-capture-item
      data-capture-label={c.name}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-line-strong px-1.5 text-[0.74rem] text-faint tabular-nums">
          {c.number}
        </span>
        <span className="min-w-0 flex-1 text-[0.9rem] text-ink">{c.name}</span>
        {c.streaming && (
          <span
            className="rounded-full border border-live/40 px-2 py-0.5 text-[0.7rem] text-live"
            data-testid="etv-streaming"
          >
            Streaming
          </span>
        )}
      </p>
      {c.now ? (
        <p className="text-[0.84rem] text-ink" data-testid="etv-now">
          <span className="text-faint">Now: </span>
          {c.now.title}
          {c.now.until ? <span className="text-faint"> · until {clock(c.now.until)}</span> : null}
        </p>
      ) : (
        <p className="text-[0.82rem] text-amber" data-testid="etv-now">
          Nothing scheduled right now
        </p>
      )}
      {c.next && (
        <p className="text-[0.78rem] text-muted">
          <span className="text-faint">Next: </span>
          {c.next.title}
          {c.next.at ? <span className="text-faint"> · {clock(c.next.at)}</span> : null}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btn}
          data-testid="etv-reset"
          onClick={() =>
            void ch.propose(
              "app-ersatztv-control",
              { op: "reset-playout", channel: c.number },
              `Rebuild ${c.name}`,
            )
          }
        >
          <RotateCcw strokeWidth={1.5} className="h-3.5 w-3.5" /> Rebuild schedule
        </button>
        {c.streaming && (
          <button
            type="button"
            className={cx(btn, "hover:border-alert/60 hover:text-alert")}
            data-testid="etv-stop"
            onClick={() =>
              void ch.propose(
                "app-ersatztv-control",
                { op: "stop-stream", channel: c.number },
                `Stop ${c.name}`,
              )
            }
          >
            <Square strokeWidth={1.5} className="h-3.5 w-3.5" /> Stop stream
          </button>
        )}
      </div>
      <ChangeCard c={ch} />
    </li>
  );
}

export function ErsatzDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 30_000);
  const [filter, setFilter] = useState("");
  const d: Data | undefined = q.data?.data?.app === "ersatztv" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="etv-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data?.error?.message ?? q.error?.message}</p>
      </div>
    );
  if (!d) return null;
  const f = filter.trim().toLowerCase();
  const shown = f
    ? d.channels.filter((c) => c.name.toLowerCase().includes(f) || c.number.includes(f))
    : d.channels;
  const empty = d.channels.filter((c) => !c.now).length;
  return (
    <section
      className="@container space-y-4"
      data-testid="etv-dashboard"
      aria-label={`${name}: channels`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-3">
        {(
          [
            ["Channels", `${d.channels.length}`, "on the guide"],
            [
              "Streaming now",
              `${d.streams}`,
              d.streams ? "someone is tuned in" : "nobody tuned in",
            ],
            [
              "Nothing on",
              `${d.guideRead ? empty : "?"}`,
              d.guideRead
                ? empty
                  ? "check their schedules"
                  : "every channel has a show"
                : "guide not read",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Nothing on" && empty > 0 && "text-amber",
              )}
              data-testid={label === "Streaming now" ? "etv-streams" : undefined}
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>
      {d.channels.length > 8 && (
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Find a channel"
          placeholder="Find a channel"
          className="min-h-10 w-full rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
        />
      )}
      {shown.length ? (
        <ul className="grid gap-3 @2xl:grid-cols-2">
          {shown.map((c) => (
            <ChannelCard key={c.number} serviceId={serviceId} c={c} />
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-[0.86rem] text-muted">
          <Tv className="h-4 w-4" aria-hidden /> No channels yet.
        </p>
      )}
      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 30 s
      </p>
    </section>
  );
}
