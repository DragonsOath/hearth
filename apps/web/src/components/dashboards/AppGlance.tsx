import { useState } from "react";
import { ExternalLink, MessageCircle, ScrollText, Sparkles } from "lucide-react";
import type { AppKind, Service } from "@dragon-control/core";
import { useAiName, useDiagnostics, useLogs } from "../../data/api";
import { useOpenTarget } from "../command/ServiceLogo";
import { useCave } from "../shell/cave-context";
import { NeedsCredential, STATUS, Stamp } from "../command/Diagnostics";
import { Skeleton, cx } from "../ui";
import { canImprovePanel, coverageOf } from "@dragon-control/core";
import { ago } from "../../lib/format";
import { EmberMark } from "../ember/EmberMark";

/**
 * The application-aware panel standard (10-12) for apps without a dashboard of their own: at a
 * glance (the app's few key facts), health (its own warnings, apart from the container's), what it
 * is working on, what happened lately, and what it connects to. It distinguishes loading, a
 * missing key, an app that cannot be reached, and no activity. Read only; the data is the app's
 * report, refreshed while open (the server limits how often it reads the app itself).
 */

/** Opens a basic panel's Improve menu from elsewhere in the panel (detail: the service id). */
export const IMPROVE_EVENT = "hearth:improve-panel";

export function AppGlance({ service, kind }: { service: Service; kind: AppKind }) {
  const diag = useDiagnostics(service.id);
  const r = diag.data?.report;
  if (diag.isLoading) return <Skeleton className="h-40" />;
  if (diag.error)
    return (
      <p role="alert" className="text-[0.86rem] text-amber">
        Hearth could not get {service.name}'s report: {diag.error.message}
      </p>
    );
  if (!r)
    return (
      <p className="text-[0.86rem] text-muted">Nothing has been read from {service.name} yet.</p>
    );
  if (r.status === "needs-key")
    return (
      <NeedsCredential kind={kind} name={service.name} detail={r.detail} serviceId={service.id} />
    );
  if (r.status === "unreachable")
    return (
      <div className="rounded-xl border border-amber/40 p-4" data-testid="glance-unreachable">
        <p className="text-[0.9rem] text-ink">{service.name} could not be read just now.</p>
        <p className="mt-1 text-[0.82rem] text-muted">{r.detail}</p>
        <p className="mt-1 text-[0.76rem] text-faint">
          Last tried {ago(r.checkedAt).toLowerCase()}. The container view below still works.
        </p>
      </div>
    );
  const queue = r.queue ?? [];
  const activity = r.activity ?? [];
  return (
    <div className="space-y-5" data-testid="app-glance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={cx("text-[0.88rem]", STATUS[r.status].cls)}>
          {STATUS[r.status].text}
          {r.version && <span className="text-faint"> · version {r.version}</span>}
        </p>
        <Stamp live={Boolean(diag.data?.live)} at={r.checkedAt} />
      </div>
      {r.facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-2 @lg:grid-cols-3">
          {r.facts.map((f) => (
            <div key={f.label} className="rounded-xl border border-line bg-bg/50 px-3 py-2.5">
              <dt className="text-[0.7rem] tracking-wide text-faint uppercase">{f.label}</dt>
              <dd className="mt-1 text-[1.05rem] leading-snug break-words text-ink">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {r.issues.length > 0 && (
        <section>
          <h3 className="eyebrow mb-2">Needs attention</h3>
          <ul className="space-y-1.5">
            {r.issues.slice(0, 8).map((i) => (
              <li
                key={i.key}
                className={cx("text-[0.84rem]", i.level === "error" ? "text-alert" : "text-amber")}
              >
                {i.text}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="eyebrow mb-2">Working on</h3>
        {queue.length === 0 ? (
          <p className="text-[0.84rem] text-faint">Nothing right now.</p>
        ) : (
          <ul className="space-y-2.5">
            {queue.slice(0, 8).map((q, i) => (
              <li key={`${q.title}-${i}`}>
                <div className="flex items-baseline justify-between gap-3 text-[0.86rem]">
                  <span className="min-w-0 truncate text-ink">{q.title}</span>
                  <span className="shrink-0 text-[0.76rem] text-muted">
                    {q.status}
                    {q.timeLeft ? ` · ${q.timeLeft}` : ""}
                  </span>
                </div>
                {q.progressPct !== undefined && (
                  <div
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-line"
                    aria-hidden="true"
                  >
                    <div
                      className="h-full rounded-full bg-gold"
                      style={{ width: `${Math.max(0, Math.min(100, q.progressPct))}%` }}
                    />
                  </div>
                )}
                {(q.problem || q.via) && (
                  <p
                    className={cx("mt-0.5 text-[0.74rem]", q.problem ? "text-amber" : "text-faint")}
                  >
                    {q.problem ?? q.via}
                  </p>
                )}
              </li>
            ))}
            {(r.queueTotal ?? 0) > queue.length && (
              <li className="text-[0.76rem] text-faint">
                and {(r.queueTotal ?? 0) - Math.min(queue.length, 8)} more
              </li>
            )}
          </ul>
        )}
      </section>
      {activity.length > 0 && (
        <section>
          <h3 className="eyebrow mb-2">Lately</h3>
          <ul className="space-y-1">
            {activity.slice(0, 6).map((a, i) => (
              <li
                key={i}
                className={cx(
                  "flex justify-between gap-3 text-[0.82rem]",
                  a.tone === "error"
                    ? "text-alert"
                    : a.tone === "good"
                      ? "text-live"
                      : "text-muted",
                )}
              >
                <span className="min-w-0 truncate">{a.text}</span>
                {a.at && <span className="shrink-0 text-[0.72rem] text-faint">{ago(a.at)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {(r.connections ?? []).length > 0 && (
        <section>
          <h3 className="eyebrow mb-2">Connected to</h3>
          <ul className="flex flex-wrap gap-2">
            {r.connections!.map((c) => (
              <li
                key={c.name}
                title={c.detail}
                className={cx(
                  "rounded-full border px-3 py-1 text-[0.76rem]",
                  c.ok ? "border-live/40 text-live" : "border-alert/40 text-alert",
                )}
              >
                {c.ok ? "" : "Not working: "}
                {c.name}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Where people ask for a full panel: the panel request board (GitHub Discussions). */
export const PANEL_REQUESTS = "https://github.com/DragonsOath/hearth/discussions/new";

/** How requests are chosen and what each label means (docs/HOW_REQUESTS_WORK.md). */
export const HOW_REQUESTS_WORK =
  "https://github.com/DragonsOath/hearth/blob/main/docs/HOW_REQUESTS_WORK.md";

/** The app's name as people know it ("Gizmo 2" from a second copy reads "Gizmo"). */
const appName = (service: Pick<Service, "name">) => service.name.replace(/\s+\d{3,}$/, "");

/** A prefilled request for a full panel for this app. */
export function requestPanelHref(service: Pick<Service, "name" | "image">): string {
  const app = appName(service);
  const q = new URLSearchParams({
    category: "panel-requests",
    title: `Panel: ${app}`,
    ...(service.image ? { "app-name": `${app} (${service.image})` } : { "app-name": app }),
  });
  return `${PANEL_REQUESTS}?${q.toString()}`;
}

/** A prefilled request for a feature on this app's hand-built panel (How requests work, 11-10). */
export function requestFeatureHref(service: Pick<Service, "name" | "image">): string {
  const app = appName(service);
  const q = new URLSearchParams({
    category: "panel-requests",
    title: `Feature: ${app} panel`,
    ...(service.image ? { "app-name": `${app} (${service.image})` } : { "app-name": app }),
  });
  return `${PANEL_REQUESTS}?${q.toString()}`;
}

/**
 * Request a feature, quietly, on every hand-built panel: the same board and votes as a full panel
 * request, so a person who wants more from a panel finds a fair next step right where they are.
 */
export function RequestFeatureLine({ service }: { service: Service }) {
  return (
    <p className="text-[0.76rem] text-faint" data-testid="panel-request-feature">
      Missing something here?{" "}
      <a
        href={requestFeatureHref(service)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-muted underline-offset-2 hover:text-gold hover:underline"
      >
        Request a feature <ExternalLink strokeWidth={1.5} className="h-3 w-3" />
      </a>{" "}
      (
      <a
        href={HOW_REQUESTS_WORK}
        target="_blank"
        rel="noreferrer"
        className="underline-offset-2 hover:text-gold hover:underline"
      >
        how requests work
      </a>
      )
    </p>
  );
}

const CHECK: Record<NonNullable<Service["lastCheck"]>["status"], { text: string; cls: string }> = {
  ok: { text: "Answering", cls: "text-live" },
  slow: { text: "Answering slowly", cls: "text-amber" },
  failing: { text: "Not answering", cls: "text-alert" },
};

/** The latest lines of its log, read when asked (each read is recorded). */
function LogTail({ service }: { service: Service }) {
  const logs = useLogs(service.id, { limit: 20 });
  if (logs.isLoading) return <Skeleton className="h-24" />;
  if (logs.error)
    return (
      <p className="text-[0.8rem] text-muted" data-testid="generic-logs-error">
        Its log could not be read: {logs.error.message}
      </p>
    );
  const lines = logs.data ?? [];
  return lines.length ? (
    <pre
      className="max-h-64 overflow-auto rounded-lg border border-line bg-bg/60 p-2 font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap break-all text-muted"
      data-testid="generic-logs"
    >
      {lines.slice(-20).join("\n")}
    </pre>
  ) : (
    <p className="text-[0.8rem] text-faint">Nothing in its log lately.</p>
  );
}

/**
 * The generic panel (panel roadmap, "Fewer issues and pull requests") for an app Hearth has no
 * panel of its own for: whether it answers and since when, its version and Open web UI, the
 * latest log lines on request, Ask Ember (which reaches the app's own API with its vault key,
 * under the usual approvals), and a link to ask for a full panel. The container's state,
 * restarts and resources follow below it on the Overview. An app that gets its own panel
 * replaces this automatically: the panel registry is checked first.
 */
export function GenericPanel({ service }: { service: Service }) {
  const c = coverageOf(service);
  const cave = useCave();
  const ai = useAiName();
  const href = useOpenTarget(service)?.href;
  const [logs, setLogs] = useState(false);
  const [question, setQuestion] = useState("");
  const check = service.lastCheck ? CHECK[service.lastCheck.status] : undefined;
  const about = `${service.name}${service.image ? ` (${service.image})` : ""}${service.localUrl ? ` at ${service.localUrl}` : ""}`;
  // `typed`: the owner's own question from the box (no first-press note; they are asking).
  const ask = (q: string, typed?: boolean) =>
    cave.ask(
      `About ${about}, an app Hearth has no panel of its own for: ${q} Read its own API with app_api (it reaches the app with its vault key; for an app Hearth has no reader for, say how the key is sent with auth, from its API documentation), and its logs if they help. Any change is a plan I approve.`,
      typed ? { typed } : undefined,
    );
  const btn =
    "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.8rem] text-ink hover:border-gold hover:text-gold";
  return (
    <section
      className="space-y-4"
      data-testid="generic-panel"
      aria-label={`${service.name}: at a glance`}
    >
      <div className="rounded-xl border border-line bg-bg/50 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[0.9rem] text-ink" data-testid="generic-status">
            {check ? (
              <span className={check.cls}>{check.text}</span>
            ) : (
              <span className="text-muted">Not checked yet</span>
            )}
            {service.version && <span className="text-faint"> · version {service.version}</span>}
            {service.responseMs !== undefined && check?.text !== "Not answering" && (
              <span className="text-faint"> · {service.responseMs} ms</span>
            )}
          </p>
          {service.lastCheck && (
            <span className="text-[0.74rem] text-faint">
              checked {ago(service.lastCheck.at).toLowerCase()}
            </span>
          )}
        </div>
        {service.lastCheck?.status === "failing" && (
          <p className="mt-1 text-[0.8rem] text-alert">{service.lastCheck.detail}</p>
        )}
        <p className="mt-2 text-[0.82rem] text-muted">
          <span className="text-ink">{c.role}.</span> Hearth has no panel of its own for it yet: its
          container, restarts and resources are below, and {ai} can read and use its own API for
          you.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className={btn}
              data-testid="generic-open"
            >
              <ExternalLink strokeWidth={1.5} className="h-4 w-4" /> Open web UI
            </a>
          )}
          <button
            type="button"
            className={cx(btn, "border-gold/50 text-gold")}
            onClick={() =>
              ask(
                "What can you see and do in it? Tell me what it is doing now and anything that needs attention.",
              )
            }
            data-testid="generic-ask"
          >
            <MessageCircle strokeWidth={1.5} className="h-4 w-4" /> Ask {ai} what is in it
            <EmberMark />
          </button>
          {service.container && (
            <button
              type="button"
              className={btn}
              aria-expanded={logs}
              onClick={() => setLogs((v) => !v)}
              data-testid="generic-logs-toggle"
            >
              <ScrollText strokeWidth={1.5} className="h-4 w-4" /> {logs ? "Hide" : "Recent"} log
              lines
            </button>
          )}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!question.trim()) return;
            ask(question.trim(), true);
            setQuestion("");
          }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={`Ask ${ai} to do something in ${service.name}`}
            aria-label={`Ask ${ai} about ${service.name}`}
            className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
            data-testid="generic-question"
          />
          <button type="submit" className={btn} disabled={!question.trim()}>
            Ask
          </button>
        </form>
      </div>
      {logs && <LogTail service={service} />}
      <p className="text-[0.78rem] text-faint">
        This is a basic panel. Want a full one for {appName(service)}?{" "}
        {canImprovePanel(service) && (
          <>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent(IMPROVE_EVENT, { detail: service.id }))
              }
              className="inline-flex items-center gap-1 font-medium text-gold underline-offset-2 hover:underline"
              data-testid="generic-improve"
            >
              <Sparkles strokeWidth={1.5} className="h-3.5 w-3.5" aria-hidden />
              Have Ember build it
            </button>{" "}
            (it works on your Hearth right away), or{" "}
          </>
        )}
        <a
          href={requestPanelHref(service)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="generic-request"
        >
          Request it <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>{" "}
        (
        <a
          href={HOW_REQUESTS_WORK}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-2 hover:text-gold hover:underline"
          data-testid="generic-how-requests"
        >
          how requests work
        </a>
        ).
      </p>
    </section>
  );
}

/** For a service with no app reader: what it is, and why its panel is the container view. */
export function IntegrationGap({ service }: { service: Service }) {
  const c = coverageOf(service);
  return (
    <div
      className="rounded-xl border border-dashed border-line-strong p-4"
      data-testid="integration-gap"
    >
      <p className="text-[0.9rem] text-ink">{c.role}</p>
      <p className="mt-1 text-[0.82rem] leading-relaxed text-muted">{c.note}</p>
    </div>
  );
}
