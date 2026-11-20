import {
  Bookmark,
  BookmarkMinus,
  Camera,
  ExternalLink,
  Eye,
  EyeOff,
  RotateCw,
  Trash2,
  Video,
  VideoOff,
} from "lucide-react";
import type { FrigateDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Frigate from Hearth, on one page. It answers "are the cameras watching, and did anything
 * happen?": cameras getting a picture, today's alerts, how fast the detector is and how full the
 * recordings disk is; each camera with its detection on or off; recent events to keep or delete;
 * and a restart one step further. Each change is a plan you approve. Hearth never shows a camera's
 * stream address or an image; zones, masks and cameras are set up in Frigate.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const KIND = "app-frigate-control" as const;

export function FrigateDashboard({ serviceId, name }: AppViewProps) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "frigate" ? q.data.data : undefined;
  const act = useApproveHere(serviceId, "Proposed from Frigate's panel.");
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  if (!d) {
    if (q.isLoading) return <Skeleton className="h-64" />;
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="fg-error">
        <p className="text-amber">{name} could not be read right now.</p>
        {(q.error ?? q.data?.error) && (
          <p className="mt-1 text-muted">{(q.error ?? q.data?.error)?.message}</p>
        )}
        <p className="mt-1 text-[0.8rem] text-faint">
          Add the username and password you sign in to Frigate with to Secure Vault, for this
          service, and give Hearth Frigate's signed-in address (port 8971).
        </p>
      </div>
    );
  }
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);
  const online = d.cameras.filter((c) => c.online).length;
  const slowest = d.detectors.reduce((m, x) => Math.max(m, x.inferenceMs), 0);
  const full = d.storage ? Math.round((d.storage.usedGb / d.storage.totalGb) * 100) : undefined;
  const web = keyPageHref(service, "/");
  return (
    <section
      className="@container space-y-4"
      data-testid="fg-dashboard"
      aria-label={`${name}: cameras`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Cameras</p>
          <p
            className={cx(
              "stat-value tabular",
              online < d.cameras.length ? (online ? "text-amber" : "text-alert") : "text-ok",
            )}
            data-testid="fg-online"
          >
            {online} of {d.cameras.length}
          </p>
          <p className="text-[0.74rem] text-faint">getting a picture</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Alerts today</p>
          <p className="stat-value text-ink tabular" data-testid="fg-alerts">
            {d.alertsToday}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.detectionsToday} detections · {d.unreviewed} not reviewed
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Detector</p>
          <p
            className={cx("stat-value tabular", slowest > 100 ? "text-amber" : "text-ink")}
            data-testid="fg-detector"
          >
            {d.detectors.length ? `${slowest} ms` : "None"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.detectors.map((x) => x.name).join(", ") || "per frame"}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Recordings disk</p>
          <p
            className={cx(
              "stat-value tabular",
              full !== undefined && full >= 95 ? "text-amber" : "text-ink",
            )}
            data-testid="fg-storage"
          >
            {full !== undefined ? `${full}%` : "?"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.storage ? `${d.storage.freeGb} GB free` : "not reported"}
          </p>
        </div>
      </div>

      <div data-hearth-target="frigate:cameras">
        <p className={eyebrow}>Cameras</p>
        <ul className="divide-y divide-line">
          {d.cameras.map((c) => (
            <li
              key={c.name}
              className="space-y-1.5 py-2.5"
              data-testid="fg-camera"
              data-capture-item
              data-capture-label={c.name}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Camera strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-gold" />
                <span className="text-[0.9rem] text-ink">{c.name}</span>
                <span className={cx("text-[0.76rem]", c.online ? "text-ok" : "text-alert")}>
                  {c.online ? `${c.fps} fps` : "no picture"}
                </span>
                <span className={cx("text-[0.76rem]", c.detecting ? "text-muted" : "text-amber")}>
                  {c.detecting ? "detecting" : "detection off"}
                </span>
                {c.reconnects > 0 && (
                  <span className="text-[0.74rem] text-amber">
                    {c.reconnects} reconnects this hour
                  </span>
                )}
                {c.storageMb !== undefined && (
                  <span className="ml-auto text-[0.74rem] text-faint">
                    {Math.round(c.storageMb / 1024)} GB of recordings
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    propose(
                      { op: c.detecting ? "detect-off" : "detect-on", camera: c.name },
                      `${c.detecting ? "Turn off" : "Turn on"} detection for ${c.name}`,
                    )
                  }
                  data-testid="fg-detect"
                >
                  {c.detecting ? (
                    <EyeOff strokeWidth={1.5} className="h-3.5 w-3.5" />
                  ) : (
                    <Eye strokeWidth={1.5} className="h-3.5 w-3.5" />
                  )}
                  {c.detecting ? "Turn off detection" : "Turn on detection"}
                </button>
                <details className="group">
                  <summary className={cx(btn, "cursor-pointer list-none")}>Recording</summary>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "record-on", camera: c.name },
                          `Turn on recording for ${c.name}`,
                        )
                      }
                    >
                      <Video strokeWidth={1.5} className="h-3.5 w-3.5" /> Turn on recording
                    </button>
                    <button
                      type="button"
                      className={btn}
                      onClick={() =>
                        propose(
                          { op: "record-off", camera: c.name },
                          `Turn off recording for ${c.name}`,
                        )
                      }
                    >
                      <VideoOff strokeWidth={1.5} className="h-3.5 w-3.5" /> Turn off recording
                    </button>
                  </div>
                </details>
              </div>
            </li>
          ))}
        </ul>
        {d.cameras.some((c) => !c.online) && (
          <p className="text-[0.74rem] text-faint">
            No picture means Frigate cannot reach the camera's stream: check the camera is on, and
            its address in Frigate's config.
          </p>
        )}
      </div>

      <div data-hearth-target="frigate:events" data-testid="fg-events">
        <p className={eyebrow}>Recent events</p>
        {d.events.length === 0 ? (
          <p className="text-[0.84rem] text-faint">Nothing detected yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.events.slice(0, 10).map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2"
                data-testid="fg-event"
              >
                <span className="text-[0.86rem] text-ink">{e.label}</span>
                <span className="text-[0.76rem] text-muted">{e.camera}</span>
                {e.at && (
                  <span className="text-[0.74rem] text-faint">{ago(e.at).toLowerCase()}</span>
                )}
                {e.kept && <span className="text-[0.74rem] text-gold">kept</span>}
                <span className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    className={btn}
                    onClick={() =>
                      propose(
                        { op: e.kept ? "event-unkeep" : "event-keep", eventId: e.id },
                        `${e.kept ? "Stop keeping" : "Keep"} the ${e.label} on ${e.camera}`,
                      )
                    }
                    data-testid="fg-keep"
                  >
                    {e.kept ? (
                      <BookmarkMinus strokeWidth={1.5} className="h-3.5 w-3.5" />
                    ) : (
                      <Bookmark strokeWidth={1.5} className="h-3.5 w-3.5" />
                    )}
                    {e.kept ? "Stop keeping" : "Keep"}
                  </button>
                  <button
                    type="button"
                    className={cx(btn, "hover:border-alert/60 hover:text-alert")}
                    onClick={() =>
                      propose(
                        { op: "event-delete", eventId: e.id },
                        `Delete the ${e.label} on ${e.camera}`,
                      )
                    }
                  >
                    <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[0.74rem] text-faint">
          A kept event stays after Frigate cleans up old ones. Watch clips and snapshots in Frigate.
        </p>
      </div>

      <details>
        <summary className={cx(eyebrow, "cursor-pointer")}>More</summary>
        <button
          type="button"
          className={btn}
          onClick={() => propose({ op: "restart" }, `Restart ${name}`)}
          data-testid="fg-restart"
        >
          <RotateCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Restart Frigate
        </button>
        <p className="mt-1 text-[0.74rem] text-faint">
          Cameras stop recording for about a minute while it restarts.
        </p>
      </details>

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version
          ? `Frigate ${d.version.split("-")[0]}${d.latest && !d.version.startsWith(d.latest) ? ` (${d.latest} is out)` : ""} · `
          : ""}
        live, every 30 s. Hearth never shows a camera's stream address or an image.{" "}
        {web && (
          <a
            href={web}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          >
            Open Frigate <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}
