import { DownloadHealthLine } from "../downloads/DownloadHealthPanel";
import { SourceBadge } from "./SourceBadge";
import { Plus } from "lucide-react";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { Button, Skeleton, cx } from "../ui";
import { NZBGET, UsenetProvider, useUsenet, type UsenetData as Data } from "./sabnzbd/client";
import { SabDownloads } from "./sabnzbd/SabDownloads";
import { SabControls, SabWarnings, size } from "./sabnzbd/parts";

/**
 * SABnzbd's Overview: how it is doing at a glance (status, speed, what is left, free disk space),
 * pausing everything, pausing for a while and the speed limit, its warnings, what needs you (failed
 * downloads), what is downloading now, and the way into the Downloads tab, where everything is
 * managed (adding NZBs, each download's controls and files, the history).
 */
type Props = {
  serviceId: string;
  name: string;
  onGo?: (tab: string, sub?: string | null) => void;
};

/** NZBGet's Overview: the same at-a-glance view, read from NZBGet. */
export function NzbgetDashboard(props: Props) {
  return (
    <UsenetProvider value={NZBGET}>
      <SabnzbdDashboard {...props} />
    </UsenetProvider>
  );
}

export function SabnzbdDashboard({
  serviceId,
  name,
  onGo,
}: {
  serviceId: string;
  name: string;
  /** Opens another tab of the panel (Downloads), at a place inside it. */
  onGo?: (tab: string, sub?: string | null) => void;
}) {
  const client = useUsenet();
  const q = useDashboard(serviceId, true, 5_000);
  const d: Data | undefined = q.data?.data?.app === client.app ? (q.data.data as Data) : undefined;
  // Outside a panel (no other tabs to open), the whole Downloads view shows here.
  if (!onGo) return <SabDownloads serviceId={serviceId} name={name} />;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="sab-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const go = (sub?: string) => onGo("downloads", sub ?? null);
  const failed = d.history.filter((h) => h.failed);
  const diskPct =
    d.diskFreeGb !== undefined && d.diskTotalGb
      ? Math.round((d.diskFreeGb / d.diskTotalGb) * 100)
      : undefined;
  return (
    <section
      className="@container space-y-4"
      data-testid="sab-dashboard"
      aria-label={`${name} at a glance`}
    >
      <DownloadHealthLine serviceId={serviceId} />
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["Status", d.status, d.queue.length === 1 ? "1 job" : `${d.queue.length} jobs`],
            [
              "Speed",
              `${(d.speedKbps / 1024).toFixed(1)} MB/s`,
              d.timeLeft ? `${d.timeLeft} left` : "nothing left",
            ],
            ["Left to get", d.sizeLeft ?? "0", "in the queue"],
            [
              "Free disk",
              d.diskFreeGb !== undefined ? `${Math.round(d.diskFreeGb)} GB` : "?",
              diskPct !== undefined ? `${diskPct}% free` : "download folder",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "Status" && d.paused && "text-amber",
                label === "Free disk" && diskPct !== undefined && diskPct < 10 && "text-alert",
              )}
              data-testid={label === "Status" ? "sab-status" : undefined}
            >
              {value}
            </p>
            <p className="text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          onClick={() => go("add")}
          data-hearth-target="overview:add"
          data-testid="sab-overview-add"
        >
          <Plus strokeWidth={1.75} className="h-4 w-4" /> Add NZB
        </Button>
        <Button tone="outline" onClick={() => go()} data-testid="sab-all">
          All downloads ({d.queue.length})
        </Button>
      </div>
      <SabControls serviceId={serviceId} d={d} />
      <SabWarnings serviceId={serviceId} d={d} />

      {failed.length > 0 && (
        <div data-testid="sab-needs-you">
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">
            Needs you · {failed.length} failed
          </p>
          <ul className="divide-y divide-line">
            {failed.slice(0, 3).map((h) => (
              <li key={h.id} className="py-2">
                <p className="text-[0.86rem] break-words text-ink">{h.name}</p>
                <SourceBadge source={h.source} />
                {h.why && <p className="text-[0.78rem] break-words text-alert">{h.why}</p>}
                <p className="text-[0.74rem] text-faint">
                  {[size(h.sizeMb), h.category ?? "", h.at ? ago(h.at) : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
          <Button tone="outline" onClick={() => go("history/failed")}>
            Retry or remove them
          </Button>
        </div>
      )}

      <div data-testid="sab-downloading">
        <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Downloading now</p>
        {d.queue.length ? (
          <ul className="divide-y divide-line">
            {d.queue.slice(0, 3).map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  className="w-full space-y-1.5 py-2 text-left"
                  onClick={() => go(j.id)}
                >
                  <span className="block text-[0.86rem] break-words text-ink">{j.name}</span>
                  {j.source && (
                    <span className="block">
                      <SourceBadge source={j.source} />
                    </span>
                  )}
                  <span
                    className="block h-1.5 overflow-hidden rounded-full bg-line"
                    role="progressbar"
                    aria-valuenow={j.progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${j.name} progress`}
                  >
                    <span
                      className={cx(
                        "block h-full rounded-full",
                        /paused/i.test(j.status) ? "bg-amber" : "bg-gold",
                      )}
                      style={{ width: `${j.progressPct}%` }}
                    />
                  </span>
                  <span className="block text-[0.74rem] text-faint">
                    {[j.status, `${j.progressPct}%`, size(j.sizeMb), j.category ?? ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">Nothing is downloading.</p>
        )}
      </div>

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 5 s
      </p>
    </section>
  );
}
