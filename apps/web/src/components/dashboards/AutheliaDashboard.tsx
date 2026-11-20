import { ExternalLink, ShieldCheck } from "lucide-react";
import type { AutheliaDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Authelia from Hearth, a light read-only panel. It answers "is sign-in working, and is anyone
 * trying to get in?": healthy or not, and from Authelia's metrics, sign-ins, failed and banned
 * sign-ins since it started, how long a sign-in takes and server errors. Authelia has no admin API:
 * people and rules are changed in its files. When its metrics are off, the panel says how to turn
 * them on.
 */

const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";

export function AutheliaDashboard({ serviceId, name }: AppViewProps) {
  const q = useDashboard(serviceId, true, 60_000);
  const d: Data | undefined = q.data?.data?.app === "authelia" ? q.data.data : undefined;
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  if (!d) {
    if (q.isLoading) return <Skeleton className="h-48" />;
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="au-error">
        <p className="text-amber">{name} could not be read right now.</p>
        {(q.error ?? q.data?.error) && (
          <p className="mt-1 text-muted">{(q.error ?? q.data?.error)?.message}</p>
        )}
      </div>
    );
  }
  const web = keyPageHref(service, "/");
  return (
    <section
      className="@container space-y-4"
      data-testid="au-dashboard"
      aria-label={`${name}: sign-in`}
    >
      <div
        className="grid grid-cols-2 gap-3 @md:grid-cols-4"
        data-hearth-target="authelia:sign-ins"
      >
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Sign-in</p>
          <p
            className={cx("stat-value text-[1rem]", d.healthy ? "text-ok" : "text-alert")}
            data-testid="au-health"
          >
            {d.healthy ? "Working" : "Not working"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.since ? `up since ${ago(d.since).toLowerCase()}` : ""}
          </p>
        </div>
        {d.metrics ? (
          <>
            <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
              <p className={eyebrow}>Sign-ins</p>
              <p className="stat-value text-ink tabular" data-testid="au-signins">
                {d.signIns ?? 0}
              </p>
              <p className="text-[0.74rem] text-faint">
                {d.signInMs ? `${d.signInMs} ms each` : "since it started"}
              </p>
            </div>
            <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
              <p className={eyebrow}>Failed</p>
              <p className="stat-value text-ink tabular" data-testid="au-failed">
                {d.failed ?? 0}
              </p>
              <p className="text-[0.74rem] text-faint">wrong password or user</p>
            </div>
            <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
              <p className={eyebrow}>Banned</p>
              <p
                className={cx("stat-value tabular", d.banned ? "text-amber" : "text-ink")}
                data-testid="au-banned"
              >
                {d.banned ?? 0}
              </p>
              <p className="text-[0.74rem] text-faint">refused after too many tries</p>
            </div>
          </>
        ) : (
          <div
            className="rounded-xl border border-line bg-bg/50 p-3 @md:col-span-3"
            data-testid="au-metrics-off"
          >
            <p className={eyebrow}>Sign-in counts</p>
            <p className="text-[0.84rem] text-muted">
              Authelia's metrics are off, or Hearth cannot reach them at{" "}
              <span className="font-mono text-[0.78rem]">{d.metricsAddress}</span>. Turn them on in
              Authelia's configuration (telemetry, metrics, enabled: true) and let Hearth reach port
              9959.
            </p>
          </div>
        )}
      </div>

      {d.metrics && (
        <ul className="space-y-1 text-[0.82rem]" data-testid="au-facts">
          <li className="text-muted">
            <ShieldCheck strokeWidth={1.5} className="mr-1 inline h-3.5 w-3.5 text-gold" />
            Counts since Authelia started{d.since ? ` (${ago(d.since).toLowerCase()})` : ""}; they
            start again when it restarts.
          </li>
          {d.serverErrors ? (
            <li className="text-amber">
              {d.serverErrors === 1 ? "1 request" : `${d.serverErrors} requests`} answered with a
              server error: look at Authelia's log.
            </li>
          ) : (
            <li className="text-faint">No server errors.</li>
          )}
          {d.memoryMb !== undefined && <li className="text-faint">{d.memoryMb} MB of memory.</li>}
        </ul>
      )}

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        live, every minute. Authelia has no admin API: people, groups and access rules are changed
        in its configuration files.{" "}
        {web && (
          <a
            href={web}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          >
            Open Authelia <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}
