import { useAiName } from "../../data/api";
import { useState } from "react";
import { Film, MessageCircle, Tv } from "lucide-react";
import type { PlexDashboard as Data, PlexItem, PlexSession } from "@dragon-control/core";
import { plexArt, useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { Skeleton, cx } from "../ui";
import { useCave } from "../shell/cave-context";
import { LinkPlex } from "./LinkPlex";
import { ScanLibraries } from "./ScanLibraries";

/**
 * Plex's live dashboard (feature request section 6): library totals, who is
 * watching what on which device, direct play or transcoding, quality, buffering,
 * recently added, and scans, with a button that scans every library. Refreshed every five
 * seconds on screen.
 */

const PLEX_REFRESH_MS = 5_000;

function clock(ms?: number) {
  if (ms === undefined) return "";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

const label = (i: PlexItem) =>
  i.type === "episode" && i.show
    ? `${i.show} · S${String(i.season ?? 0).padStart(2, "0")}E${String(i.episode ?? 0).padStart(2, "0")} · ${i.title}`
    : `${i.title}${i.year ? ` (${i.year})` : ""}`;

function Art({
  serviceId,
  item,
  className,
}: {
  serviceId: string;
  item: PlexItem;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!item.thumb || failed) {
    const Icon = item.type === "movie" ? Film : Tv;
    return (
      <div
        className={cx(
          "flex shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.03]",
          className,
        )}
      >
        <Icon strokeWidth={1.25} className="h-6 w-6 text-faint" />
      </div>
    );
  }
  return (
    <img
      src={plexArt(serviceId, item.thumb)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cx("shrink-0 rounded-lg border border-line object-cover", className)}
    />
  );
}

function Session({ serviceId, s }: { serviceId: string; s: PlexSession }) {
  const aiName = useAiName();
  const cave = useCave();
  const asking = cave.item?.kind === "plex-session" && cave.item.id === s.sessionId;
  const decisionCls =
    s.decision === "direct play"
      ? "border-live/40 text-live"
      : s.decision === "direct stream"
        ? "border-gold/40 text-gold"
        : "border-amber/50 text-amber";
  return (
    <li
      className="flex gap-3 rounded-xl border border-line p-3"
      data-testid="plex-session"
      data-state={s.state}
    >
      <Art serviceId={serviceId} item={s} className="h-28 w-[4.6rem]" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[0.9rem] leading-snug break-words text-ink">{label(s)}</p>
        <p className="text-[0.78rem] text-muted">
          <span className="text-ink">{s.user}</span> on {s.player}
          {s.device ? ` (${s.device})` : ""}
          {s.local === false ? " · remote" : s.local ? " · at home" : ""}
        </p>
        <div className="flex items-center gap-2">
          <div
            className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.07]"
            role="progressbar"
            aria-label={`${s.title}: ${s.progressPct}% watched`}
            aria-valuenow={s.progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cx(
                "h-full rounded-full transition-[width] duration-700",
                s.state === "buffering"
                  ? "bg-amber"
                  : s.state === "paused"
                    ? "bg-muted/50"
                    : "bg-gold",
              )}
              style={{ width: `${Math.min(100, s.progressPct)}%` }}
            />
          </div>
          <span className="text-[0.74rem] text-faint tabular">
            {clock(s.offsetMs)} / {clock(s.durationMs)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[0.72rem]">
          <span
            className={cx(
              "fit-pill rounded-full border px-2 py-0.5",
              s.state === "buffering"
                ? "border-amber/60 text-amber"
                : "border-line-strong text-muted",
            )}
          >
            {s.state === "other" ? "Playing" : s.state.charAt(0).toUpperCase() + s.state.slice(1)}
          </span>
          <span className={cx("fit-pill rounded-full border px-2 py-0.5", decisionCls)}>
            {s.decision.charAt(0).toUpperCase() + s.decision.slice(1)}
            {s.decision === "transcode" && s.hardwareTranscode !== undefined
              ? ` (${s.hardwareTranscode ? "hardware" : "software"})`
              : ""}
          </span>
          {s.resolution && (
            <span className="rounded-full border border-line px-2 py-0.5 text-muted">
              {/^\d+$/.test(s.resolution) ? `${s.resolution}p` : s.resolution.toUpperCase()}
            </span>
          )}
          {s.bitrateKbps && (
            <span className="rounded-full border border-line px-2 py-0.5 text-muted tabular">
              {(s.bitrateKbps / 1000).toFixed(1)} Mbps
            </span>
          )}
          {s.transcodeSpeed !== undefined && (
            <span
              className={cx(
                "fit-pill rounded-full border px-2 py-0.5 tabular",
                s.transcodeSpeed < 1 ? "border-amber/60 text-amber" : "border-line text-muted",
              )}
            >
              Transcoder {s.transcodeSpeed}x
            </span>
          )}
        </div>
        {s.problem && <p className="text-[0.8rem] text-amber">{s.problem}</p>}
        <button
          type="button"
          onClick={() => {
            cave.selectItem({
              serviceId,
              kind: "plex-session",
              id: s.sessionId,
              label: `${s.user} watching ${s.title}`,
            });
            requestAnimationFrame(() =>
              document.querySelector<HTMLTextAreaElement>('textarea[id$="-input"]')?.focus(),
            );
          }}
          className={cx(
            "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[0.78rem]",
            asking
              ? "border-gold bg-gold/10 text-gold"
              : "border-gold/40 text-gold hover:bg-gold/10",
          )}
          data-testid="plex-ask"
        >
          <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" />
          {asking ? `${aiName} is looking at this stream` : `Ask ${aiName} about this stream`}
        </button>
      </div>
    </li>
  );
}

function Totals({ d }: { d: Data }) {
  const tiles = [
    ["Movies", d.totals.movies],
    ["Shows", d.totals.shows],
    ["Seasons", d.totals.seasons],
    ["Episodes", d.totals.episodes],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-2 @md:grid-cols-4" data-testid="plex-totals">
      {tiles.map(([k, v]) => (
        <div key={k} className="stat-tile rounded-xl border border-line px-3 py-2.5">
          <dt className="text-[0.72rem] tracking-wide text-faint uppercase">{k}</dt>
          <dd className="stat-value font-display leading-tight text-ink tabular">
            {v.toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PlexDashboard({ serviceId }: { serviceId: string }) {
  const q = useDashboard(serviceId, true, PLEX_REFRESH_MS);
  const d = q.data?.data?.app === "plex" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return <p className="text-[0.88rem] text-alert">Could not read Plex: {q.error.message}</p>;
  if (q.data?.error?.kind === "needs-key") {
    return <LinkPlex serviceId={serviceId} />;
  }
  if (q.data?.error?.kind === "rejected") {
    return (
      <LinkPlex
        serviceId={serviceId}
        why={`Plex refused the stored token: ${q.data.error.message}`}
      />
    );
  }
  if (q.data?.error) {
    return (
      <div
        className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
        data-testid="plex-error"
      >
        <p className="text-amber">Plex could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  }
  if (!d) return null;
  const transcoding = d.sessions.filter((s) => s.decision === "transcode").length;
  return (
    <section className="@container space-y-5" aria-label="Plex" data-testid="plex-dashboard">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.78rem]">
        <span className="text-ink">{d.serverName?.replace(/ \(sample data\)$/, "") ?? "Plex"}</span>
        <span className="ml-auto text-faint" data-testid="plex-freshness">
          {q.data!.sample ? "Sample data · " : ""}Live · read {ago(q.data!.at).toLowerCase()}
          {d.version ? ` · v${d.version.replace(/ \(sample data\)$/, "")}` : ""}
        </span>
      </div>
      <ScanLibraries
        serviceId={serviceId}
        kind="app-plex-control"
        name="Plex"
        testId="plex-scan-libraries"
      />
      <Totals d={d} />
      <div>
        <h3 className="eyebrow mb-2">
          Watching now: {d.sessions.length}
          {transcoding ? ` · ${transcoding} transcoding` : ""}
        </h3>
        {d.sessions.length ? (
          <ul className="grid gap-2 @2xl:grid-cols-2">
            {d.sessions.map((s) => (
              <Session key={s.sessionId} serviceId={serviceId} s={s} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nobody is watching right now.</p>
        )}
      </div>
      {d.activities.length > 0 && (
        <div>
          <h3 className="eyebrow mb-2">Library activity</h3>
          <ul className="space-y-2" data-testid="plex-activities">
            {d.activities.map((a, i) => (
              <li key={i} className="text-[0.82rem]">
                <p className="text-ink">
                  {a.title}
                  {a.subtitle ? <span className="text-muted"> · {a.subtitle}</span> : null}
                </p>
                {a.progressPct !== undefined && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                    <div className="h-full bg-gold/70" style={{ width: `${a.progressPct}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-5 @2xl:grid-cols-2">
        <div>
          <h3 className="eyebrow mb-2">Libraries</h3>
          <ul className="divide-y divide-line" data-testid="plex-libraries">
            {d.libraries.map((l) => (
              <li
                key={l.key}
                className="flex items-baseline justify-between gap-3 py-2 text-[0.84rem]"
              >
                <span className="text-ink">{l.title}</span>
                <span className="text-muted tabular">
                  {l.type === "show"
                    ? `${l.count.toLocaleString()} shows · ${l.seasons?.toLocaleString() ?? 0} seasons · ${l.episodes?.toLocaleString() ?? 0} episodes`
                    : `${l.count.toLocaleString()} ${l.type === "movie" ? "movies" : l.type === "artist" ? "artists" : "items"}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="eyebrow mb-2">Recently added</h3>
          <ul className="space-y-2" data-testid="plex-recent">
            {d.recentlyAdded.map((i) => (
              <li key={i.id} className="flex items-center gap-3 text-[0.82rem]">
                <Art serviceId={serviceId} item={i} className="h-14 w-10" />
                <span className="min-w-0 flex-1 break-words text-ink">{label(i)}</span>
                {i.addedAt && <span className="shrink-0 text-faint">{ago(i.addedAt)}</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
