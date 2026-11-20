import { useState } from "react";
import {
  Film,
  Home,
  MessageCircle,
  Music,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  Square,
  Tv,
  Wifi,
} from "lucide-react";
import type { JellyfinDashboard as Data } from "@dragon-control/core";
import { useServerWord } from "./jellyfin/brand";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { PasteKey } from "./PasteKey";
import { ScanLibraries } from "./ScanLibraries";
import { EmberMark } from "../ember/EmberMark";

/**
 * Jellyfin from Hearth: who is watching and how (converting, and why in plain words), libraries
 * and what is in them, and what was just added (Overview); scheduled tasks (the Tasks tab).
 * Scanning, stopping a stream (with a message), and running a task are plans confirmed here.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
const icon = (I: typeof Play) => <I strokeWidth={1.5} className="h-3.5 w-3.5" />;

function StreamRow({ serviceId, s }: { serviceId: string; s: Data["streams"][number] }) {
  const server = useServerWord(serviceId);
  const c = useConfirmedChange(serviceId);
  const cave = useCave();
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <li
      className={cx(
        "space-y-1.5 rounded-xl border bg-bg/50 p-3",
        s.converting ? "border-amber/40" : "border-line",
      )}
      data-testid="jf-stream"
      data-capture-item
      data-capture-label={`${s.user}: ${s.title}`}
    >
      <p className="text-[0.9rem] text-ink">{s.title}</p>
      <p className="flex flex-wrap items-center gap-x-2 text-[0.78rem] text-muted">
        <span className="text-ink">{s.user}</span>
        <span>· {s.device}</span>
        <span className="inline-flex items-center gap-1">
          ·{" "}
          {s.away ? (
            <Wifi className="h-3 w-3" aria-hidden />
          ) : (
            <Home className="h-3 w-3" aria-hidden />
          )}
          {s.away ? "away from home" : "at home"}
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
        <span className="text-faint">
          {s.paused ? "paused" : "playing"} · {s.progressPct}%
        </span>
        <span
          className={cx(
            "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
            s.converting ? "border-amber/50 text-amber" : "border-live/40 text-live",
          )}
          data-testid="jf-decision"
        >
          {s.converting ? "Converting" : "Direct play"}
        </span>
      </p>
      {s.why && (
        <p className="text-[0.78rem] text-amber" data-testid="jf-why">
          {s.why}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {s.converting && (
          <button
            type="button"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `${s.user} is watching ${s.title} on ${s.device} in ${server} and it is converting: ${s.why ?? ""} How can it play directly?`,
              )
            }
          >
            {icon(MessageCircle)} Ask why
            <EmberMark />
          </button>
        )}
        <button
          type="button"
          className={cx(btn, "hover:border-alert/60 hover:text-alert")}
          data-testid="jf-stop"
          onClick={() => setStopping((v) => !v)}
        >
          {icon(Square)} Stop stream
        </button>
      </div>
      {stopping && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setStopping(false);
            void c.propose(
              "app-jellyfin-control",
              {
                op: "stop-stream",
                sessionId: s.sessionId,
                ...(message.trim() ? { message: message.trim() } : {}),
              },
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
          <Button tone="primary" type="submit" data-testid="jf-stop-plan">
            Stop stream
          </Button>
        </form>
      )}
      <ChangeCard c={c} />
    </li>
  );
}

function Row({
  serviceId,
  testId,
  children,
  actions,
}: {
  serviceId: string;
  testId: string;
  children: React.ReactNode;
  actions: {
    label: string;
    params: Record<string, string>;
    title: string;
    icon: React.ReactNode;
    testId: string;
  }[];
}) {
  const c = useConfirmedChange(serviceId);
  return (
    <li className="space-y-1.5 py-2.5" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {actions.map((action) => (
          <button
            key={action.testId}
            type="button"
            className={btn}
            data-testid={action.testId}
            onClick={() => void c.propose("app-jellyfin-control", action.params, action.title)}
          >
            {action.icon} {action.label}
          </button>
        ))}
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

/** The panel's data, or what to show instead while it loads or cannot be read. */
function useJellyfin(serviceId: string, name: string) {
  const q = useDashboard(serviceId, true, 10_000);
  const d: Data | undefined = q.data?.data?.app === "jellyfin" ? q.data.data : undefined;
  let blocked: React.ReactNode = null;
  if (q.isLoading) blocked = <Skeleton className="h-64" />;
  else if (q.error)
    blocked = (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  else if (q.data?.error)
    blocked =
      q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
        <PasteKey
          serviceId={serviceId}
          name={name}
          where="Dashboard, then API Keys, then the + button"
          message={q.data.error.message}
        />
      ) : (
        <div
          className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
          data-testid="jf-error"
        >
          <p className="text-amber">{name} could not be read right now.</p>
          <p className="mt-1 text-muted">{q.data.error.message}</p>
        </div>
      );
  return { q, d, blocked };
}

/** A poster through Hearth (the key stays on the server), or an icon when there is none. */
function Poster({ serviceId, item }: { serviceId: string; item: Data["recent"][number] }) {
  const [failed, setFailed] = useState(false);
  if (!item.poster || failed) {
    const Icon = item.kind === "Episode" ? Tv : item.kind === "MusicAlbum" ? Music : Film;
    return (
      <div className="flex h-14 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.03]">
        <Icon strokeWidth={1.25} className="h-5 w-5 text-faint" />
      </div>
    );
  }
  return (
    <img
      src={`/api/services/${encodeURIComponent(serviceId)}/dashboard/jellyfin-poster?item=${encodeURIComponent(item.poster)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-14 w-10 shrink-0 rounded-lg border border-line object-cover"
    />
  );
}

/** "812 movies", "140 shows · 6,123 episodes", or the kind and folders when it cannot be counted. */
const sizeOf = (l: Data["libraries"][number]) =>
  l.size?.length
    ? l.size.map((x) => `${x.n.toLocaleString()} ${x.label}`).join(" · ")
    : `${l.kind} · ${l.folders} ${l.folders === 1 ? "folder" : "folders"}`;

/**
 * Overview, laid out like Plex's (the owner, 2026-11-02: recently added and your library belong
 * here): totals, who is watching, libraries with what is in them, and what was just added with
 * posters. Scheduled tasks have their own tab; a failed one is still flagged here.
 */
export function JellyfinDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const server = useServerWord(serviceId);
  const { q, d, blocked } = useJellyfin(serviceId, name);
  if (blocked) return blocked;
  if (!d) return null;
  const failed = d.tasks.filter((t) => t.failed);
  const converting = d.streams.filter((s) => s.converting).length;
  const tiles = [
    ["Movies", d.counts.movies],
    ["Shows", d.counts.shows],
    ["Episodes", d.counts.episodes],
    d.counts.albums ? ["Albums", d.counts.albums] : ["Users", d.users.length],
  ] as const;
  return (
    <section
      className="@container space-y-5"
      data-testid="jf-dashboard"
      aria-label={`${name}: who is watching`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[0.78rem]">
        <span className="text-ink">{d.server ?? name}</span>
        <span className="ml-auto text-faint">
          {q.data?.sample ? "Sample data · " : ""}Live · read {ago(q.data!.at).toLowerCase()}
          {d.version ? ` · v${d.version}` : ""}
        </span>
      </div>
      <ScanLibraries
        serviceId={serviceId}
        kind="app-jellyfin-control"
        name={name}
        testId="jf-scan-libraries"
      />
      <dl className="grid grid-cols-2 gap-2 @md:grid-cols-4" data-testid="jf-totals">
        {tiles.map(([k, v]) => (
          <div key={k} className="stat-tile rounded-xl border border-line px-3 py-2.5">
            <dt className="text-[0.72rem] tracking-wide text-faint uppercase">{k}</dt>
            <dd className="stat-value font-display leading-tight text-ink tabular">
              {v.toLocaleString()}
            </dd>
          </div>
        ))}
      </dl>
      {(d.needsRestart || d.updateAvailable) && (
        <p className="rounded-xl border border-amber/40 p-3 text-[0.82rem] text-amber">
          {d.needsRestart ? `${server} is waiting for a restart. ` : ""}
          {d.updateAvailable ? `A ${server} update is available.` : ""}
        </p>
      )}
      {failed.length > 0 && (
        <p
          className="rounded-xl border border-alert/40 p-3 text-[0.82rem] text-alert"
          data-testid="jf-failed"
        >
          {failed.length === 1
            ? `The scheduled task "${failed[0]!.name}" failed.`
            : `${failed.length} scheduled tasks failed.`}{" "}
          <span className="text-muted">
            See the Tasks tab to run {failed.length === 1 ? "it" : "them"} again or turn{" "}
            {failed.length === 1 ? "it" : "them"} off.
          </span>
        </p>
      )}

      <div>
        <h3 className="eyebrow mb-2">
          Watching now: <span data-testid="jf-count">{d.streams.length}</span>
          {converting ? ` · ${converting} converting` : ""}
        </h3>
        {d.streams.length ? (
          <ul className="grid gap-3 @2xl:grid-cols-2">
            {d.streams.map((s) => (
              <StreamRow key={s.sessionId} serviceId={serviceId} s={s} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nobody is watching right now.</p>
        )}
      </div>

      <div className="grid gap-5 @2xl:grid-cols-2">
        <div>
          <h3 className="eyebrow mb-1">Libraries</h3>
          <ul className="divide-y divide-line">
            {d.libraries.map((l) => (
              <Row
                key={l.id}
                serviceId={serviceId}
                testId="jf-library"
                actions={[
                  {
                    label: "Scan",
                    params: { op: "scan-library", libraryId: l.id },
                    title: `Scan ${l.name}`,
                    icon: icon(RefreshCw),
                    testId: "jf-scan",
                  },
                ]}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-[0.88rem] text-ink">{l.name}</span>
                  <span className="text-[0.8rem] text-muted tabular" data-testid="jf-library-size">
                    {sizeOf(l)}
                    {l.scanning ? " · scanning now" : ""}
                  </span>
                </div>
              </Row>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="eyebrow mb-2">Recently added</h3>
          {d.recent.length ? (
            <ul className="space-y-2" data-testid="jf-recent">
              {d.recent.map((r, i) => (
                <li key={r.id ?? i} className="flex items-center gap-3 text-[0.82rem]">
                  <Poster serviceId={serviceId} item={r} />
                  <span className="min-w-0 flex-1 break-words text-ink">{r.title}</span>
                  {r.at && <span className="shrink-0 text-faint">{ago(r.at)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.84rem] text-muted">Nothing added lately.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** The Tasks tab: Jellyfin's scheduled tasks, failed first, each run, stopped, or turned off. */
export function JellyfinTasks({ serviceId, name }: { serviceId: string; name: string }) {
  const server = useServerWord(serviceId);
  const { d, blocked } = useJellyfin(serviceId, name);
  if (blocked) return blocked;
  if (!d) return null;
  return (
    <section className="space-y-2" data-testid="jf-tasks" aria-label={`${name}: scheduled tasks`}>
      <p className="text-[0.82rem] text-muted">
        Jobs {server} runs on its own (scans, images, clean-ups). Failed ones are first.
      </p>
      <ul className="divide-y divide-line">
        {d.tasks.map((t) => (
          <Row
            key={t.id}
            serviceId={serviceId}
            testId="jf-task"
            actions={[
              t.running
                ? {
                    label: "Stop",
                    params: { op: "stop-task", taskId: t.id },
                    title: `Stop ${t.name}`,
                    icon: icon(Square),
                    testId: "jf-stop-task",
                  }
                : {
                    label: "Run now",
                    params: { op: "run-task", taskId: t.id },
                    title: `Run ${t.name}`,
                    icon: icon(Play),
                    testId: "jf-run-task",
                  },
              // Off means it no longer runs on its own; Hearth keeps its schedule to put back.
              t.scheduled === false
                ? {
                    label: "Turn on",
                    params: { op: "turn-on-task", taskId: t.id },
                    title: `Turn ${t.name} back on`,
                    icon: icon(Power),
                    testId: "jf-task-on",
                  }
                : {
                    label: "Turn off",
                    params: { op: "turn-off-task", taskId: t.id },
                    title: `Turn off ${t.name}`,
                    icon: icon(PowerOff),
                    testId: "jf-task-off",
                  },
            ]}
          >
            <p className={cx("text-[0.88rem]", t.failed ? "text-alert" : "text-ink")}>{t.name}</p>
            <p className="text-[0.76rem] break-words text-faint">
              {t.scheduled === false ? "off, runs only when started · " : ""}
              {t.running
                ? "running now"
                : t.failed
                  ? `failed${t.error ? `: ${t.error}` : ""}`
                  : t.lastRan
                    ? `ran ${ago(t.lastRan)}`
                    : "has not run"}
            </p>
          </Row>
        ))}
      </ul>
    </section>
  );
}
