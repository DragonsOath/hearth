import { useState } from "react";
import { Film, Home, MessageCircle, Pause, Play, Square, Wifi } from "lucide-react";
import type { TautulliDashboard as Data, TautulliStream } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { EmberMark } from "../ember/EmberMark";

/**
 * Tautulli from Hearth: who is watching right now (poster, progress, device, quality, whether Plex
 * plays it as it is or converts it, and why), this week's top people and titles, and recent
 * history. Stopping a stream is a plan confirmed here (with a message to the viewer if wanted).
 */

const mbps = (kbps?: number) => (kbps === undefined ? "" : `${(kbps / 1000).toFixed(1)} Mbps`);

function Poster({ serviceId, thumb }: { serviceId: string; thumb?: string }) {
  const [failed, setFailed] = useState(false);
  return thumb && !failed ? (
    <img
      src={`/api/services/${serviceId}/dashboard/tautulli-image?img=${encodeURIComponent(thumb)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="aspect-[2/3] w-16 shrink-0 rounded-lg bg-raised object-cover @md:w-20"
    />
  ) : (
    <div
      aria-hidden="true"
      className="flex aspect-[2/3] w-16 shrink-0 items-center justify-center rounded-lg bg-raised text-faint @md:w-20"
    >
      <Film strokeWidth={1.2} className="h-6 w-6" />
    </div>
  );
}

function StreamCard({ serviceId, s }: { serviceId: string; s: TautulliStream }) {
  const c = useConfirmedChange(serviceId);
  const cave = useCave();
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState("");
  const converted = s.decision === "transcode";
  return (
    <li
      className={cx(
        "flex gap-3 rounded-xl border bg-bg/50 p-3",
        converted ? "border-amber/40" : "border-line",
      )}
      data-testid="tautulli-stream"
      data-capture-item
      data-capture-label={`${s.user}: ${s.title}`}
    >
      <Poster serviceId={serviceId} thumb={s.thumb} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[0.92rem] leading-snug text-ink">
          {s.title}
          {s.year ? ` (${s.year})` : ""}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 text-[0.78rem] text-muted">
          <span className="text-ink">{s.user}</span>
          <span>· {s.player}</span>
          <span className="inline-flex items-center gap-1">
            ·{" "}
            {s.location === "wan" ? (
              <Wifi className="h-3 w-3" aria-hidden />
            ) : (
              <Home className="h-3 w-3" aria-hidden />
            )}
            {s.location === "wan" ? "away from home" : "at home"}
          </span>
        </p>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-valuenow={s.progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${s.title} progress`}
        >
          <div className="h-full rounded-full bg-gold" style={{ width: `${s.progressPct}%` }} />
        </div>
        <p className="flex flex-wrap items-center gap-2 text-[0.76rem]">
          <span className="inline-flex items-center gap-1 text-faint">
            {s.state === "paused" ? (
              <Pause className="h-3 w-3" aria-hidden />
            ) : (
              <Play className="h-3 w-3" aria-hidden />
            )}
            {s.state} · {s.progressPct}%
          </span>
          {s.quality && <span className="text-faint">· {s.quality}</span>}
          {s.bandwidthKbps !== undefined && (
            <span className="text-faint">· {mbps(s.bandwidthKbps)}</span>
          )}
          <span
            className={cx(
              "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
              converted ? "border-amber/50 text-amber" : "border-live/40 text-live",
            )}
            data-testid="tautulli-decision"
          >
            {converted ? "Converting" : s.decision === "copy" ? "Direct stream" : "Direct play"}
          </span>
        </p>
        {s.why && (
          <p className="text-[0.78rem] text-amber" data-testid="tautulli-why">
            {s.why}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-0.5">
          {converted && (
            <button
              type="button"
              onClick={() =>
                cave.ask(
                  `${s.user} is watching ${s.title} on ${s.player} (${s.location === "wan" ? "away from home" : "at home"}) and Plex is converting it: ${s.why ?? ""} Why, and can we avoid it (player settings, a version that plays directly, remote quality limits)?`,
                )
              }
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            >
              <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why
              <EmberMark />
            </button>
          )}
          <button
            type="button"
            onClick={() => setStopping((v) => !v)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-alert/60 hover:text-alert"
            data-testid="tautulli-stop"
          >
            <Square strokeWidth={1.5} className="h-3.5 w-3.5" /> Stop
          </button>
        </div>
        {stopping && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setStopping(false);
              void c.propose(
                "app-tautulli-stop-stream",
                { sessionId: s.sessionId, ...(message.trim() ? { message: message.trim() } : {}) },
                `Stop ${s.user}'s stream`,
              );
            }}
          >
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={200}
              aria-label="Message to show them (optional)"
              placeholder="Message to show them (optional)"
              className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.82rem] text-ink"
            />
            <Button tone="primary" type="submit" data-testid="tautulli-stop-plan">
              Stop stream
            </Button>
          </form>
        )}
        <ChangeCard c={c} />
      </div>
    </li>
  );
}

export function TautulliDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 10_000);
  const d: Data | undefined = q.data?.data?.app === "tautulli" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div
        className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
        data-testid="tautulli-error"
      >
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const list = (title: string, rows: { label: string; plays: number }[]) => (
    <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
      <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">{title}</p>
      {rows.length ? (
        <ol className="space-y-1 text-[0.84rem]">
          {rows.map((r, i) => (
            <li key={`${r.label}-${i}`} className="flex justify-between gap-2">
              <span className="truncate text-ink">{r.label}</span>
              <span className="shrink-0 text-faint tabular-nums">{r.plays}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[0.8rem] text-muted">Nothing yet.</p>
      )}
    </div>
  );
  return (
    <section
      className="@container space-y-4"
      data-testid="tautulli-dashboard"
      aria-label={`${name}: who is watching`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["Watching now", `${d.totals.streams}`, d.totals.streams === 1 ? "stream" : "streams"],
            ["Converting", `${d.totals.transcoding}`, "not playing directly"],
            ["Bandwidth", mbps(d.totals.bandwidthKbps), "all streams"],
            ["Away from home", mbps(d.totals.remoteKbps), "of your upload"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Converting" && d.totals.transcoding > 0 && "text-amber",
              )}
              data-testid={label === "Watching now" ? "tautulli-count" : undefined}
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>
      {d.streams.length ? (
        <ul className="grid gap-3 @2xl:grid-cols-2">
          {d.streams.map((s) => (
            <StreamCard key={s.sessionId} serviceId={serviceId} s={s} />
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">Nobody is watching right now.</p>
      )}
      <div className="grid gap-3 @md:grid-cols-3">
        {list(
          "Most active this week",
          d.top.users.map((u) => ({ label: u.name, plays: u.plays })),
        )}
        {list(
          "Top movies this week",
          d.top.movies.map((m) => ({ label: m.title, plays: m.plays })),
        )}
        {list(
          "Top shows this week",
          d.top.shows.map((m) => ({ label: m.title, plays: m.plays })),
        )}
      </div>
      {d.history.length > 0 && (
        <div>
          <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
            Recently watched
          </p>
          <ul className="divide-y divide-line" data-testid="tautulli-history">
            {d.history.map((h, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 py-2 text-[0.84rem]">
                <span className="min-w-0 flex-1 text-ink">{h.title}</span>
                <span className="text-[0.76rem] text-faint">
                  {[
                    h.user,
                    h.player,
                    h.watchedPct !== undefined ? `${h.watchedPct}% watched` : "",
                    h.at ? ago(h.at) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 10 s
      </p>
    </section>
  );
}
