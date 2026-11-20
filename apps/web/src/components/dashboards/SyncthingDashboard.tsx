import { MessageCircle, Pause, Play, RefreshCw } from "lucide-react";
import type { SyncthingDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { EmberMark } from "../ember/EmberMark";

/**
 * Syncthing from Hearth: every folder (up to date, how much is left, or the files that failed
 * and why), every other machine (connected, from where, last seen), and rescanning a folder or
 * pausing and resuming a folder or a machine, each a plan confirmed here.
 */

type Folder = Data["folders"][number];
type Device = Data["devices"][number];

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
const icon = (I: typeof Play) => <I strokeWidth={1.5} className="h-3.5 w-3.5" />;

function FolderRow({ serviceId, f }: { serviceId: string; f: Folder }) {
  const c = useConfirmedChange(serviceId);
  const cave = useCave();
  const tone =
    f.errors || f.state === "error" ? "bad" : f.paused ? "off" : f.needMb ? "busy" : "ok";
  const say = (op: string, label: string) =>
    void c.propose("app-syncthing-control", { op, folderId: f.id }, `${label} ${f.name}`);
  return (
    <li
      className={cx(
        "space-y-2 rounded-xl border bg-bg/50 p-3",
        tone === "bad" ? "border-alert/40" : "border-line",
      )}
      data-testid="sync-folder"
      data-capture-item
      data-capture-label={f.name}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-[0.92rem] break-words text-ink">{f.name}</span>
        <span
          className={cx(
            "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
            tone === "bad"
              ? "border-alert/50 text-alert"
              : tone === "busy"
                ? "border-gold/50 text-gold"
                : tone === "ok"
                  ? "border-live/40 text-live"
                  : "border-line-strong text-faint",
          )}
          data-testid="sync-state"
        >
          {tone === "bad"
            ? `${f.errors} failed`
            : f.paused
              ? "Paused"
              : f.needMb
                ? `Syncing ${f.syncedPct}%`
                : "Up to date"}
        </span>
        <span className="text-[0.74rem] text-faint">
          {f.kind} · {f.sizeGb} GB
        </span>
      </p>
      {f.needMb > 0 && !f.paused && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-valuenow={f.syncedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${f.name} synced`}
        >
          <div className="h-full rounded-full bg-gold" style={{ width: `${f.syncedPct}%` }} />
        </div>
      )}
      <p className="text-[0.76rem] break-words text-faint">
        {[
          f.needFiles ? `${f.needFiles} files, ${f.needMb} MB to go` : "",
          f.sharedWith.length ? `shared with ${f.sharedWith.join(", ")}` : "not shared",
          f.path ?? "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {f.failed.length > 0 && (
        <ul className="space-y-0.5 text-[0.78rem] text-alert" data-testid="sync-failed">
          {f.failed.map((e) => (
            <li key={e.path} className="break-words">
              {e.path}: {e.why}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {!f.paused && (
          <button
            type="button"
            className={btn}
            data-testid="sync-rescan"
            onClick={() => say("rescan", "Rescan")}
          >
            {icon(RefreshCw)} Rescan
          </button>
        )}
        <button
          type="button"
          className={btn}
          data-testid={f.paused ? "sync-resume-folder" : "sync-pause-folder"}
          onClick={() =>
            say(f.paused ? "resume-folder" : "pause-folder", f.paused ? "Resume" : "Pause")
          }
        >
          {icon(f.paused ? Play : Pause)} {f.paused ? "Resume" : "Pause"}
        </button>
        {f.failed.length > 0 && (
          <button
            type="button"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `Syncthing's folder ${f.name} (${f.path ?? f.id}) failed to sync these files: ${f.failed
                  .map((e) => `${e.path} (${e.why})`)
                  .join("; ")}. Why, and how do I fix it?`,
              )
            }
          >
            {icon(MessageCircle)} Ask why
            <EmberMark />
          </button>
        )}
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

function DeviceRow({ serviceId, d }: { serviceId: string; d: Device }) {
  const c = useConfirmedChange(serviceId);
  const op = d.paused ? "resume-device" : "pause-device";
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid="sync-device"
      data-capture-item
      data-capture-label={d.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[0.88rem] text-ink">{d.name}</span>
        <span
          className={cx(
            "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
            d.paused
              ? "border-line-strong text-faint"
              : d.connected
                ? "border-live/40 text-live"
                : "border-amber/50 text-amber",
          )}
          data-testid="sync-device-state"
        >
          {d.paused ? "Paused" : d.connected ? "Connected" : "Offline"}
        </span>
        <button
          type="button"
          className={btn}
          data-testid={`sync-${op}`}
          onClick={() =>
            void c.propose(
              "app-syncthing-control",
              { op, deviceId: d.id },
              `${d.paused ? "Resume" : "Pause"} syncing with ${d.name}`,
            )
          }
        >
          {icon(d.paused ? Play : Pause)} {d.paused ? "Resume" : "Pause"}
        </button>
      </div>
      <p className="text-[0.76rem] text-faint">
        {[
          d.address ? `from ${d.address}` : "",
          d.lastSeen ? `last seen ${ago(d.lastSeen)}` : "never seen",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <ChangeCard c={c} />
    </li>
  );
}

export function SyncthingDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 15_000);
  const d: Data | undefined = q.data?.data?.app === "syncthing" ? q.data.data : undefined;
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
        data-testid="sync-error"
      >
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const failing = d.folders.filter((f) => f.errors || f.state === "error").length;
  const syncing = d.folders.filter((f) => f.needMb > 0 && !f.paused);
  const online = d.devices.filter((x) => x.connected).length;
  return (
    <section
      className="@container space-y-4"
      data-testid="sync-dashboard"
      aria-label={`${name}: syncing`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            [
              "Folders",
              `${d.folders.length}`,
              `${d.folders.filter((f) => f.paused).length} paused`,
            ],
            [
              "Syncing",
              `${syncing.length}`,
              syncing.length
                ? `${syncing.reduce((n, f) => n + f.needMb, 0)} MB to go`
                : "all up to date",
            ],
            ["With errors", `${failing}`, failing ? "need a look" : "none"],
            ["Machines online", `${online}`, `of ${d.devices.length}`],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "With errors" && failing > 0 && "text-alert",
              )}
              data-testid={
                label === "With errors"
                  ? "sync-failing"
                  : label === "Machines online"
                    ? "sync-online"
                    : undefined
              }
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>
      {d.folders.length ? (
        <ul className="grid gap-3 @2xl:grid-cols-2">
          {d.folders.map((f) => (
            <FolderRow key={f.id} serviceId={serviceId} f={f} />
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">{name} has no folders yet.</p>
      )}
      <div>
        <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Other machines</p>
        {d.devices.length ? (
          <ul className="divide-y divide-line">
            {d.devices.map((x) => (
              <DeviceRow key={x.id} serviceId={serviceId} d={x} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">No other machines yet.</p>
        )}
      </div>
      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 15 s
      </p>
    </section>
  );
}
