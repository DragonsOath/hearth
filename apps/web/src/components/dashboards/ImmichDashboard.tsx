import { DatabaseBackup, Eraser, Pause, Play, PlayCircle } from "lucide-react";
import type { ImmichDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { RecentPhotos } from "./immich/photos";
import type { AppViewProps } from "../panels/registry";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { PasteKey } from "./PasteKey";

/**
 * Immich from Hearth: photos and videos, storage, how much each person uses (and their quota),
 * and the job queues (busy, waiting, failed). Pausing or resuming a queue, processing what is
 * missing, clearing failed jobs, and backing up the database are plans confirmed here.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
const icon = (I: typeof Play) => <I strokeWidth={1.5} className="h-3.5 w-3.5" />;

function QueueRow({ serviceId, q }: { serviceId: string; q: Data["queues"][number] }) {
  const c = useConfirmedChange(serviceId);
  const say = (op: string, title: string) =>
    void c.propose("app-immich-control", { op, queue: q.name }, `${title} ${q.label}`);
  const busy = q.active + q.waiting;
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid="im-queue"
      data-capture-item
      data-capture-label={q.label}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[0.88rem] text-ink">{q.label}</span>
        <span
          className={cx(
            "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
            q.failed
              ? "border-alert/50 text-alert"
              : q.paused
                ? "border-line-strong text-faint"
                : busy
                  ? "border-gold/50 text-gold"
                  : "border-live/40 text-live",
          )}
          data-testid="im-queue-state"
        >
          {q.failed ? `${q.failed} failed` : q.paused ? "Paused" : busy ? `${busy} to do` : "Idle"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btn}
          data-testid={q.paused ? "im-resume" : "im-pause"}
          onClick={() =>
            say(q.paused ? "resume-queue" : "pause-queue", q.paused ? "Resume" : "Pause")
          }
        >
          {icon(q.paused ? Play : Pause)} {q.paused ? "Resume" : "Pause"}
        </button>
        {q.runnable && (
          <button
            type="button"
            className={btn}
            data-testid="im-run"
            onClick={() => say("run-missing", "Run")}
          >
            {icon(PlayCircle)} Process missing
          </button>
        )}
        {q.failed > 0 && (
          <button
            type="button"
            className={btn}
            data-testid="im-clear"
            onClick={() => say("clear-failed", "Clear failed")}
          >
            {icon(Eraser)} Clear failed
          </button>
        )}
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

export function ImmichDashboard({ serviceId, name, onGo }: AppViewProps) {
  const q = useDashboard(serviceId, true, 15_000);
  const all = useConfirmedChange(serviceId);
  const d: Data | undefined = q.data?.data?.app === "immich" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
      <PasteKey
        serviceId={serviceId}
        name={name}
        where="your account (signed in as an administrator), then Account Settings, then API Keys, then New API Key with all permissions"
        message={q.data.error.message}
      />
    ) : (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="im-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const failed = d.queues.reduce((n, x) => n + x.failed, 0);
  const busy = d.queues.reduce((n, x) => n + x.active + x.waiting, 0);
  return (
    <section
      className="@container space-y-4"
      data-testid="im-dashboard"
      aria-label={`${name}: photos`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["Photos", d.photos.toLocaleString(), `${d.videos.toLocaleString()} videos`],
            ["Storage", `${d.disk.pct}%`, `${d.disk.used} of ${d.disk.size}, ${d.disk.free} free`],
            ["Working on", `${busy}`, "jobs active or waiting"],
            ["Failed jobs", `${failed}`, failed ? "need a look" : "none"],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Failed jobs" && failed > 0 && "text-alert",
                label === "Storage" && d.disk.pct >= 90 && "text-alert",
              )}
              data-testid={
                label === "Photos" ? "im-photos" : label === "Failed jobs" ? "im-failed" : undefined
              }
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      {d.recent && (
        <RecentPhotos
          serviceId={serviceId}
          name={name}
          photos={d.recent}
          {...(onGo ? { onAll: () => onGo("photos") } : {})}
        />
      )}

      <div className="grid gap-4 @2xl:grid-cols-2">
        <div>
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Jobs</p>
          <ul className="divide-y divide-line">
            {d.queues.map((x) => (
              <QueueRow key={x.name} serviceId={serviceId} q={x} />
            ))}
          </ul>
        </div>
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">
              Who uses the space
            </p>
            <ul className="divide-y divide-line" data-testid="im-people">
              {d.people.map((u) => (
                <li key={u.name} className="py-2 text-[0.84rem]">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="flex-1 text-ink">{u.name}</span>
                    <span className="text-faint tabular-nums">
                      {u.usageGb} GB{u.quotaGb ? ` of ${u.quotaGb} GB` : ""}
                    </span>
                  </div>
                  <p className="text-[0.76rem] text-faint">
                    {u.photos.toLocaleString()} photos · {u.videos.toLocaleString()} videos
                  </p>
                  {u.quotaGb ? (
                    <div
                      className="mt-1 h-1.5 overflow-hidden rounded-full bg-line"
                      role="progressbar"
                      aria-valuenow={Math.round((u.usageGb / u.quotaGb) * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${u.name}'s quota used`}
                    >
                      <div
                        className={cx(
                          "h-full rounded-full",
                          u.usageGb / u.quotaGb > 0.9 ? "bg-alert" : "bg-gold",
                        )}
                        style={{
                          width: `${Math.min(100, Math.round((u.usageGb / u.quotaGb) * 100))}%`,
                        }}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <Button
              tone="outline"
              data-testid="im-backup"
              onClick={() =>
                void all.propose(
                  "app-immich-control",
                  { op: "backup-database" },
                  "Back up Immich's database",
                )
              }
            >
              <DatabaseBackup className="h-4 w-4" /> Back up the database now
            </Button>
            <ChangeCard c={all} />
          </div>
        </div>
      </div>
      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 15 s
      </p>
    </section>
  );
}
