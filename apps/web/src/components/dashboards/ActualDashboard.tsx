import { ExternalLink, Lock, LockOpen, Wallet } from "lucide-react";
import type { ActualDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { keyPageHref } from "../../lib/keyPage";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";

/**
 * Actual Budget from Hearth, a light read-only panel. It answers "is the budget server fine?":
 * healthy or not, the version, memory and uptime, how people sign in, and which budget files it
 * holds (by name, with whether each is encrypted). Budgets are opened and changed in Actual; Hearth
 * never reads what is in them.
 */

const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";

/** Seconds as "3 days" or "5 h". */
function upFor(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return days === 1 ? "1 day" : `${days} days`;
  const hours = Math.floor(seconds / 3600);
  return hours >= 1 ? `${hours} h` : `${Math.max(1, Math.round(seconds / 60))} min`;
}

export function ActualDashboard({ serviceId, name }: AppViewProps) {
  const q = useDashboard(serviceId, true, 60_000);
  const d: Data | undefined = q.data?.data?.app === "actual" ? q.data.data : undefined;
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  if (!d) {
    if (q.isLoading) return <Skeleton className="h-48" />;
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="ac-error">
        <p className="text-amber">{name} could not be read right now.</p>
        {(q.error ?? q.data?.error) && (
          <p className="mt-1 text-muted">{(q.error ?? q.data?.error)?.message}</p>
        )}
        <p className="mt-1 text-[0.8rem] text-faint">
          Add Actual's server password to Secure Vault, for this service: the one you set when you
          first opened Actual.
        </p>
      </div>
    );
  }
  const web = keyPageHref(service, "/");
  return (
    <section
      className="@container space-y-4"
      data-testid="ac-dashboard"
      aria-label={`${name}: health`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Server</p>
          <p
            className={cx("stat-value text-[1rem]", d.healthy ? "text-ok" : "text-alert")}
            data-testid="ac-health"
          >
            {d.healthy ? "Healthy" : "Not healthy"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.uptime !== undefined ? `up ${upFor(d.uptime)}` : ""}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Version</p>
          <p className="stat-value text-ink tabular" data-testid="ac-version">
            {d.version ?? "?"}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.memoryMb !== undefined ? `${d.memoryMb} MB memory` : ""}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Budgets</p>
          <p className="stat-value text-ink tabular" data-testid="ac-budgets">
            {d.budgets.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.deleted ? `${d.deleted} in the trash` : "none in the trash"}
          </p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Sign-in</p>
          <p className="stat-value text-[1rem] text-ink">{d.loginMethods.join(", ") || "?"}</p>
          <p className="text-[0.74rem] text-faint">
            {d.multiuser ? "several people" : "one shared password"}
          </p>
        </div>
      </div>

      <div data-hearth-target="actual:budgets" data-testid="ac-budget-list">
        <p className={eyebrow}>Budget files</p>
        {d.budgets.length === 0 ? (
          <p className="text-[0.84rem] text-faint">No budgets on this server yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.budgets.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-x-2 py-2"
                data-testid="ac-budget"
              >
                <Wallet strokeWidth={1.5} className="h-3.5 w-3.5 text-gold" />
                <span className="text-[0.88rem] text-ink">{b.name}</span>
                <span
                  className={cx(
                    "inline-flex items-center gap-1 text-[0.76rem]",
                    b.encrypted ? "text-ok" : "text-faint",
                  )}
                >
                  {b.encrypted ? (
                    <Lock strokeWidth={1.5} className="h-3 w-3" />
                  ) : (
                    <LockOpen strokeWidth={1.5} className="h-3 w-3" />
                  )}
                  {b.encrypted ? "encrypted" : "not encrypted"}
                </span>
                <span className="ml-auto text-[0.74rem] text-faint">
                  {b.people === 1 ? "1 person" : `${b.people} people`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-[0.74rem] text-faint">
          An encrypted budget can only be opened with its own password, so even the server cannot
          read it. Turn it on in Actual: Settings, Encryption.
        </p>
      </div>

      <p className="text-[0.74rem] text-faint">
        {q.data?.sample ? "Sample data · " : ""}
        live, every minute. Hearth reads only the server, never what is in a budget.{" "}
        {web && (
          <a
            href={web}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          >
            Open Actual <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}
