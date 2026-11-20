import { RefreshCw } from "lucide-react";
import {
  APP_INTEGRATIONS,
  appKindOf as coreAppKindOf,
  type AppKind,
  type AppReport,
  type Service,
} from "@dragon-control/core";
import { Skeleton, cx } from "../ui";
import { useDiagnostics, useServiceRuntime } from "../../data/api";
import { ago } from "../../lib/format";
import { CredentialButton } from "../credentials/AddCredential";

/**
 * A service's native diagnostics, read only: what the app itself says (its
 * health messages, queue, recent activity, connections) next to the container
 * and Hearth's own check. Every block says whether it is Live (read
 * just now) or Recorded (an earlier read), and when. While the panel is open
 * the app is read again every 20 seconds.
 */

/** Which app a service is (the shared check in core). */
export function appKindOf(service: Pick<Service, "image" | "name">): AppKind | undefined {
  return coreAppKindOf(service);
}

export function Stamp({ live, at }: { live: boolean; at?: string }) {
  return (
    <span
      className={cx(
        "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem] whitespace-nowrap",
        live ? "border-live/40 text-live" : "border-line-strong text-muted",
      )}
      data-testid="diag-stamp"
    >
      {live ? "Live" : "Recorded"}
      {at ? ` · read ${ago(at).toLowerCase()}` : ""}
    </span>
  );
}

export const STATUS: Record<AppReport["status"], { text: string; cls: string }> = {
  ok: { text: "No problems reported", cls: "text-live" },
  attention: { text: "Needs a look", cls: "text-amber" },
  failing: { text: "Reporting errors", cls: "text-alert" },
  unreachable: { text: "Could not be read", cls: "text-amber" },
  "needs-key": { text: "Needs its credential", cls: "text-muted" },
};

function Block({
  title,
  stamp,
  children,
  testId,
}: {
  title: string;
  stamp?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {stamp}
      </div>
      {children}
    </section>
  );
}

/** What to add to the vault, in plain steps (or import with Find my keys in Secure Vault). */
export function NeedsCredential({
  kind,
  name,
  detail,
  serviceId,
}: {
  kind: AppKind;
  name: string;
  detail?: string;
  serviceId: string;
}) {
  const def = APP_INTEGRATIONS[kind];
  return (
    <div className="rounded-xl border border-line p-4" data-testid="diag-needs-key">
      <p className="text-[0.9rem] text-ink">
        {detail ??
          `Hearth needs ${name}'s ${def.credential === "login" ? "login" : "API key"} to read it.`}
      </p>
      <p className="mt-2 text-[0.84rem] text-muted">Find it in {def.where}.</p>
      <CredentialButton serviceId={serviceId} className="mt-3" />
      <p className="mt-3 text-[0.78rem] text-faint">
        It goes straight into the Secure Vault, never into a conversation. Hearth then uses it here
        and in Ember without asking again: reads on its own, changes only with your approval.
      </p>
    </div>
  );
}

export function Diagnostics({ service, kind }: { service: Service; kind: AppKind }) {
  const diag = useDiagnostics(service.id);
  const runtime = useServiceRuntime(service.id);
  const r = diag.data?.report;
  const live = Boolean(diag.data?.live);
  const name = service.name;
  const rt = runtime.data;

  return (
    <div className="@container space-y-7" data-testid="diagnostics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.84rem] text-muted">
          Read only. {APP_INTEGRATIONS[kind].reads.charAt(0).toUpperCase()}
          {APP_INTEGRATIONS[kind].reads.slice(1)}.
        </p>
        <button
          type="button"
          onClick={() => void diag.refetch()}
          disabled={diag.isFetching}
          className="flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-[0.8rem] text-muted hover:border-gold/50 hover:text-gold disabled:opacity-50"
        >
          <RefreshCw
            strokeWidth={1.5}
            className={cx(
              "h-3.5 w-3.5",
              diag.isFetching && "animate-spin motion-reduce:animate-none",
            )}
          />
          {diag.isFetching ? "Reading" : "Read now"}
        </button>
      </div>
      {diag.data?.note && <p className="text-[0.78rem] text-faint">{diag.data.note}</p>}

      <div className="grid gap-3 @lg:grid-cols-2">
        <div className="rounded-xl border border-line px-4 py-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[0.76rem] text-faint">Container</p>
            {rt?.available && <Stamp live at={rt.at} />}
          </div>
          <p className="text-[0.9rem] text-ink">
            {runtime.isLoading
              ? "Reading"
              : !rt?.available
                ? `Not available: ${rt?.reason ?? "it could not be read."}`
                : rt.running
                  ? `Running${rt.cpuPct !== undefined ? ` · CPU ${rt.cpuPct}%` : ""}${rt.memoryMb !== undefined ? ` · ${rt.memoryMb} MB` : ""}`
                  : "Not running"}
          </p>
        </div>
        <div className="rounded-xl border border-line px-4 py-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[0.76rem] text-faint">Hearth's check</p>
            {service.lastCheck && <Stamp live={false} at={service.lastCheck.at} />}
          </div>
          <p className="text-[0.9rem] text-ink">
            {service.stopped
              ? "Not checked: stopped on request"
              : service.lastCheck
                ? `${name} ${service.lastCheck.detail}`
                : "Not checked yet"}
          </p>
        </div>
      </div>

      {diag.isLoading ? (
        <Skeleton className="h-40" />
      ) : !r ? (
        <p className="text-[0.86rem] text-muted">Nothing has been read from {name} yet.</p>
      ) : r.status === "needs-key" ? (
        <NeedsCredential kind={kind} name={name} detail={r.detail} serviceId={service.id} />
      ) : (
        <>
          <Block
            title={`Inside ${name}`}
            stamp={<Stamp live={live} at={r.checkedAt} />}
            testId="diag-app"
          >
            <p className={cx("text-[0.92rem]", STATUS[r.status].cls)}>
              {STATUS[r.status].text}
              {r.version ? <span className="text-faint"> · version {r.version}</span> : null}
            </p>
            {r.detail && <p className="mt-1 text-[0.84rem] text-muted">{r.detail}</p>}
            {r.facts.length > 0 && (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {r.facts.map((f) => (
                  <div key={f.label}>
                    <dt className="text-[0.72rem] text-faint">{f.label}</dt>
                    <dd className="text-[0.88rem] text-ink tabular">{f.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {r.issues.length > 0 && (
              <ul className="mt-3 space-y-2" aria-label={`${name} reports`}>
                {r.issues.map((i) => (
                  <li
                    key={i.key}
                    className={cx(
                      "rounded-lg border px-3 py-2 text-[0.84rem] leading-relaxed",
                      i.level === "error" ? "border-alert/40 text-ink" : "border-amber/40 text-ink",
                    )}
                  >
                    <span className={i.level === "error" ? "text-alert" : "text-amber"}>
                      {i.level === "error" ? "Error" : "Warning"}:{" "}
                    </span>
                    {i.text}
                    {i.link && (
                      <a
                        href={i.link}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-1 text-gold underline underline-offset-4"
                      >
                        Help
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Block>

          {r.queue && (
            <Block
              title={`Queue${r.queueTotal !== undefined ? ` · ${r.queueTotal}` : ""}`}
              stamp={<Stamp live={live} at={r.checkedAt} />}
              testId="diag-queue"
            >
              {r.queue.length ? (
                <ul className="divide-y divide-line">
                  {r.queue.map((q, i) => (
                    <li key={`${q.title}-${i}`} className="py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 truncate text-[0.86rem] text-ink" title={q.title}>
                          {q.title}
                        </p>
                        <p
                          className={cx(
                            "shrink-0 text-[0.76rem]",
                            q.problem ? "text-amber" : "text-muted",
                          )}
                        >
                          {q.status}
                        </p>
                      </div>
                      {q.progressPct !== undefined && (
                        <div
                          className="mt-1.5 h-1 overflow-hidden rounded-full bg-line"
                          role="progressbar"
                          aria-label={`${q.title} progress`}
                          aria-valuenow={q.progressPct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className="h-full bg-gold/70"
                            style={{ width: `${q.progressPct}%` }}
                          />
                        </div>
                      )}
                      <p className="mt-1 text-[0.74rem] text-faint tabular">
                        {[
                          q.progressPct !== undefined ? `${q.progressPct}%` : undefined,
                          q.sizeMb !== undefined
                            ? q.sizeMb >= 1024
                              ? `${(q.sizeMb / 1024).toFixed(1)} GB`
                              : `${q.sizeMb} MB`
                            : undefined,
                          q.timeLeft ? `${q.timeLeft} left` : undefined,
                          q.via,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {q.problem && <p className="mt-1 text-[0.8rem] text-amber">{q.problem}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[0.86rem] text-muted">The queue is empty.</p>
              )}
              {r.queueTotal !== undefined && r.queueTotal > r.queue.length && (
                <p className="mt-2 text-[0.76rem] text-faint">
                  Showing {r.queue.length} of {r.queueTotal}.
                </p>
              )}
            </Block>
          )}

          {r.connections && r.connections.length > 0 && (
            <Block
              title="Connections"
              stamp={<Stamp live={live} at={r.checkedAt} />}
              testId="diag-connections"
            >
              <ul className="space-y-1.5">
                {r.connections.map((c) => (
                  <li key={c.name} className="flex items-start gap-2.5 text-[0.84rem]">
                    <span
                      className={cx(
                        "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                        c.ok ? "bg-live" : "bg-alert",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="sr-only">{c.ok ? "OK: " : "Problem: "}</span>
                      <span className="text-ink">{c.name}</span>
                      {c.detail && (
                        <span className="block text-[0.76rem] text-muted">{c.detail}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          )}

          {r.activity && r.activity.length > 0 && (
            <Block
              title="Recent activity"
              stamp={<Stamp live={live} at={r.checkedAt} />}
              testId="diag-activity"
            >
              <ul className="space-y-1.5">
                {r.activity.map((a, i) => (
                  <li key={i} className="flex gap-3 text-[0.82rem]">
                    <span className="w-20 shrink-0 text-faint tabular">
                      {a.at ? ago(a.at) : ""}
                    </span>
                    <span
                      className={cx(
                        "min-w-0",
                        a.tone === "error"
                          ? "text-alert"
                          : a.tone === "good"
                            ? "text-ink"
                            : "text-muted",
                      )}
                    >
                      {a.text}
                    </span>
                  </li>
                ))}
              </ul>
            </Block>
          )}
        </>
      )}
    </div>
  );
}
