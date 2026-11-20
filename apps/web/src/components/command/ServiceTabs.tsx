import { useAiName } from "../../data/api";
import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { MessageCircle, RefreshCw, Search } from "lucide-react";
import type { ContainerEventView, Service, TimelineEvent } from "@dragon-control/core";
import { useLogs, type LogWindow } from "../../data/api";
import {
  useResourceHistory,
  useServiceResources,
  useServiceRestarts,
  useServiceTimeline,
  type ResourcePoint,
} from "../../data/history";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Segmented, Skeleton, cx } from "../ui";
import { Unavailable } from "./WorkspaceFrame";
import { EmberMark } from "../ember/EmberMark";

/**
 * The Logs, Health (restarts and resource trends), and History tabs (feature
 * request 4.3, 4.4, 4.9, 12.1 to 12.3). Everything shown is read from Docker or
 * Hearth's records; every problem has an "Ask Ember" action
 * that hands the exact question over, so investigating and fixing happen in
 * the conversation, with its operations, not somewhere else.
 */

const local = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A small "Ask Ember" button that sends one precise question. */
function AskButton({
  question,
  label = "Ask",
  testId,
}: {
  question: string;
  label?: string;
  testId?: string;
}) {
  const cave = useCave();
  return (
    <button
      type="button"
      onClick={() => cave.ask(question)}
      className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
      title={question}
      data-testid={testId}
    >
      <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" />
      {label}
      <EmberMark />
    </button>
  );
}

/* ---------------- Logs ---------------- */

type Range = "latest" | "1h" | "6h" | "24h" | "3d" | "7d" | "custom";
const RANGES: { value: Range; label: string }[] = [
  { value: "latest", label: "Latest" },
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
  { value: "3d", label: "3 days" },
  { value: "7d", label: "7 days" },
  { value: "custom", label: "Custom" },
];
const RANGE_WORDS: Record<Exclude<Range, "latest" | "custom">, string> = {
  "1h": "from the last hour",
  "6h": "from the last 6 hours",
  "24h": "from the last 24 hours",
  "3d": "from the last 3 days",
  "7d": "from the last 7 days",
};

/** "2026-10-10T14:30" from a datetime-local input, as an ISO time. */
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

const ALARM =
  /\b(error|fatal|fail(ed|ure)?|exception|panic|critical|denied|refused|timed? ?out)\b/i;
const WARN = /\b(warn(ing)?|retry(ing)?|slow|stalled?)\b/i;
const STAMP = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s(.*)$/;

export function LogsTab({ service }: { service: Service }) {
  const aiName = useAiName();
  const [range, setRange] = useState<Range>("latest");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filterText, setFilterText] = useState("");
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(200);
  const logWindow = useMemo<LogWindow | undefined>(() => {
    if (range === "latest" && !filter) return undefined;
    const w: LogWindow = { limit };
    if (range === "custom") {
      const since = fromLocalInput(from);
      const until = fromLocalInput(to);
      if (since) w.since = since;
      if (until) w.until = until;
      if (!since && !until) w.since = "24h";
    } else if (range !== "latest") w.since = range;
    else w.since = "24h";
    if (filter) w.filter = filter;
    return w;
  }, [range, from, to, filter, limit]);
  const logs = useLogs(service.id, logWindow);

  if (service.kind !== "container") {
    return (
      <Unavailable
        what="Logs"
        why={`${service.name} is not a container, so Hearth cannot read its logs.`}
      />
    );
  }
  const all = logs.data ?? [];
  const summary = all[0]?.startsWith("(") ? all[0] : undefined;
  const lines = summary ? all.slice(1) : all;
  const words =
    range === "custom"
      ? `between ${from ? local(new Date(from).toISOString()) : "24 hours ago"} and ${to ? local(new Date(to).toISOString()) : "now"}`
      : range === "latest"
        ? filter
          ? "from the last 24 hours"
          : "(the latest lines)"
        : RANGE_WORDS[range];
  const question = `Look at ${service.name}'s logs ${words}${filter ? ` containing "${filter}"` : ""}, tell me what's going on, and fix it if something needs fixing.`;
  const search = (e: FormEvent) => {
    e.preventDefault();
    setFilter(filterText.trim());
  };

  return (
    <div className="space-y-3" data-testid="logs-tab">
      <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
      {range === "custom" && (
        <div className="flex flex-wrap items-end gap-3 text-[0.8rem]">
          <label className="flex flex-col gap-1 text-muted">
            From
            <input
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="min-h-10 rounded-lg border border-line bg-bg px-2 text-ink"
              data-testid="logs-from"
            />
          </label>
          <label className="flex flex-col gap-1 text-muted">
            To
            <input
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="min-h-10 rounded-lg border border-line bg-bg px-2 text-ink"
              data-testid="logs-to"
            />
          </label>
        </div>
      )}
      <form onSubmit={search} className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Only lines containing</span>
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder='Only lines containing, e.g. "error" or "timeout"'
            className="min-h-10 w-full rounded-lg border border-line bg-bg pr-3 pl-9 text-[0.84rem] text-ink placeholder:text-faint"
            data-testid="logs-filter"
          />
        </label>
        <Button tone="quiet" type="submit">
          Search
        </Button>
        <label className="flex items-center gap-2 text-[0.8rem] text-muted">
          Lines
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="min-h-10 rounded-lg border border-line bg-bg px-2 text-ink"
          >
            {[100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.78rem] text-faint" data-testid="logs-summary">
          {summary ? summary.replace(/^\(|\)$/g, "") + ". " : ""}
          Read live from Docker (secrets hidden, never stored)
          {logs.dataUpdatedAt ? ` · ${new Date(logs.dataUpdatedAt).toLocaleTimeString()}` : ""}.
        </p>
        <div className="flex items-center gap-2">
          <AskButton
            question={question}
            label={`Ask ${aiName} about these logs`}
            testId="logs-ask"
          />
          <Button
            tone="quiet"
            onClick={() => void logs.refetch()}
            disabled={logs.isFetching}
            aria-label="Read the logs again"
          >
            <RefreshCw
              strokeWidth={1.5}
              className={cx(
                "h-4 w-4",
                logs.isFetching && "animate-spin motion-reduce:animate-none",
              )}
            />
          </Button>
        </div>
      </div>
      {logs.isLoading ? (
        <Skeleton className="h-60" />
      ) : logs.error ? (
        <p className="text-[0.88rem] text-bad">{logs.error.message}</p>
      ) : (
        <div
          className="max-h-[60vh] overflow-auto rounded-xl border border-line bg-black/70 p-4 font-mono text-[0.76rem] leading-relaxed text-ink/85"
          data-testid="service-logs"
        >
          {lines.length ? (
            lines.map((line, i) => {
              const m = STAMP.exec(line);
              const text = m ? m[2]! : line;
              return (
                <div
                  key={i}
                  className={cx(
                    "break-words whitespace-pre-wrap",
                    ALARM.test(text) ? "text-alert" : WARN.test(text) ? "text-amber" : undefined,
                  )}
                >
                  {m && <span className="mr-2 text-faint">{local(m[1]!)}</span>}
                  {text}
                </div>
              );
            })
          ) : (
            <p className="text-muted">
              No log lines {logWindow ? "in that window" : "yet"}. Docker only keeps what its log
              settings allow, so an empty window can mean they were rotated away.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Health: restarts and resource trends ---------------- */

export function RestartTimeline({ service }: { service: Service }) {
  const q = useServiceRestarts(service.id);
  if (service.kind !== "container") return null;
  const events = q.data?.events ?? [];
  const unexpected = (e: ContainerEventView) =>
    (e.kind === "stop" &&
      (e.oomKilled || (e.exitCode !== undefined && ![0, 143].includes(e.exitCode)))) ||
    (e.kind === "start" && (e.cause === "docker" || e.cause === "outside"));
  return (
    <div data-testid="restart-history">
      <h3 className="eyebrow mb-2">Restarts and stops</h3>
      {q.isLoading ? (
        <Skeleton className="h-20" />
      ) : events.length ? (
        <ul className="divide-y divide-line">
          {events.slice(0, 20).map((e) => (
            <li
              key={`${e.at}-${e.kind}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[0.86rem]"
            >
              <span
                className={cx(
                  "h-2 w-2 shrink-0 rounded-full",
                  unexpected(e) ? (e.kind === "stop" ? "bg-alert" : "bg-amber") : "bg-line-strong",
                )}
              />
              <span className="min-w-0 flex-1 text-ink">{e.text}</span>
              <span className="text-[0.76rem] text-faint tabular" title={e.at}>
                {local(e.at)}
              </span>
              {unexpected(e) && (
                <AskButton
                  question={`Why did ${service.name} ${e.kind === "stop" ? "stop" : "restart"} at ${local(e.at)} (${e.text.toLowerCase()})? Check its logs around then and its restart history, and fix the cause if you can.`}
                  testId="restart-ask"
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">
          None recorded yet. Hearth records starts and stops from Docker every few minutes (Settings
          &gt; Restart history).
        </p>
      )}
    </div>
  );
}

function Chart({
  points,
  avg,
  max,
  unit,
  label,
}: {
  points: ResourcePoint[];
  avg: (p: ResourcePoint) => number | undefined;
  max: (p: ResourcePoint) => number | undefined;
  unit: string;
  label: string;
}) {
  const W = 600;
  const H = 120;
  const values = points.map((p) => ({ a: avg(p), m: max(p) }));
  const top = Math.max(1, ...values.map((v) => v.m ?? v.a ?? 0));
  const x = (i: number) => (points.length <= 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v: number) => H - (v / top) * (H - 8) - 4;
  const line = (pick: (v: { a?: number; m?: number }) => number | undefined) =>
    values
      .map((v, i) => {
        const n = pick(v);
        return n === undefined ? "" : `${x(i).toFixed(1)},${y(n).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  const avgs = values.map((v) => v.a).filter((n): n is number => n !== undefined);
  const mean = avgs.length ? avgs.reduce((s, n) => s + n, 0) / avgs.length : undefined;
  const fmt = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  return (
    <figure className="space-y-1">
      <figcaption className="flex items-baseline justify-between text-[0.8rem]">
        <span className="text-ink">{label}</span>
        <span className="text-faint tabular">
          {mean !== undefined
            ? `average ${fmt(mean)} ${unit} · peak ${fmt(top)} ${unit}`
            : "no samples"}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-28 w-full rounded-lg border border-line bg-bg/50"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${mean !== undefined ? `average ${fmt(mean)} ${unit}, peak ${fmt(top)} ${unit}` : "no samples"}`}
      >
        <polyline
          points={line((v) => v.m)}
          fill="none"
          className="stroke-amber/50"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={line((v) => v.a)}
          fill="none"
          className="stroke-gold"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </figure>
  );
}

export function ResourceTrends({ service }: { service: Service }) {
  const [hours, setHours] = useState<"24" | "72" | "168">("24");
  const settings = useResourceHistory();
  const q = useServiceResources(service.id, Number(hours));
  if (service.kind !== "container") return null;
  const points = (q.data?.points ?? []).filter((p) => p.samples > 0);
  const off = settings.data && !settings.data.enabled;
  return (
    <div data-testid="resource-trends">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="eyebrow">Resource use over time</h3>
        <Segmented
          label="Period"
          value={hours}
          options={[
            { value: "24", label: "24 h" },
            { value: "72", label: "3 days" },
            { value: "168", label: "7 days" },
          ]}
          onChange={setHours}
        />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-28" />
      ) : points.length ? (
        <div className="grid gap-4 @lg:grid-cols-2">
          <Chart
            points={points}
            avg={(p) => p.cpuAvgPct}
            max={(p) => p.cpuMaxPct}
            unit="% CPU"
            label="CPU (gold: hourly average, amber: peak)"
          />
          <Chart
            points={points}
            avg={(p) => p.memoryAvgMb}
            max={(p) => p.memoryMaxMb}
            unit="MB"
            label="Memory"
          />
        </div>
      ) : (
        <p className="text-[0.86rem] text-muted">
          {off ? (
            <>
              Resource history is off, so there is nothing to chart yet. It records CPU and memory
              every few minutes once you switch it on in{" "}
              <Link to="/settings#monitoring" className="text-gold underline underline-offset-4">
                Settings
              </Link>{" "}
              (it shows what it will store first).
            </>
          ) : (
            "No samples for this period yet."
          )}
        </p>
      )}
    </div>
  );
}

/* ---------------- History ---------------- */

type Filter = "all" | "problems" | "repairs" | "restarts" | "investigations" | "memory";
const FILTER_KINDS: Record<Exclude<Filter, "all" | "problems">, TimelineEvent["kind"][]> = {
  repairs: ["action", "job", "change"],
  restarts: ["restart", "stop"],
  investigations: ["investigation"],
  memory: ["memory"],
};
const KIND_LABEL: Record<TimelineEvent["kind"], string> = {
  incident: "Incident",
  resolved: "Resolved",
  action: "Action",
  job: "Plan",
  change: "Change",
  restart: "Start",
  stop: "Stop",
  investigation: "Investigation",
  memory: "Journal",
};

export function HistoryTab({ service }: { service: Service }) {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [filter, setFilter] = useState<Filter>("all");
  const q = useServiceTimeline(service.id, Number(days));
  const events = q.data?.events ?? [];
  const shown = events.filter((e) =>
    filter === "all"
      ? true
      : filter === "problems"
        ? e.tone === "attention"
        : FILTER_KINDS[filter].includes(e.kind),
  );
  const count = (f: Filter) =>
    f === "all"
      ? events.length
      : f === "problems"
        ? events.filter((e) => e.tone === "attention").length
        : events.filter((e) => FILTER_KINDS[f].includes(e.kind)).length;
  return (
    <div className="space-y-3" data-testid="history-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Show"
          value={filter}
          options={(
            [
              ["all", "All"],
              ["problems", "Problems"],
              ["repairs", "Repairs and changes"],
              ["restarts", "Restarts"],
              ["investigations", "Investigations"],
              ["memory", "Journal"],
            ] as [Filter, string][]
          ).map(([value, label]) => ({ value, label, count: count(value) }))}
          onChange={setFilter}
        />
        <Segmented
          label="Period"
          value={days}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
          onChange={setDays}
        />
      </div>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : shown.length ? (
        <ul className="divide-y divide-line">
          {shown.map((e, i) => (
            <li
              key={`${e.at}-${i}`}
              className="flex gap-3 py-3 text-[0.86rem]"
              data-testid="history-event"
              data-kind={e.kind}
            >
              <span
                className={cx(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  e.tone === "attention"
                    ? "bg-alert"
                    : e.tone === "good"
                      ? "bg-live"
                      : "bg-line-strong",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-ink">
                  <span className="mr-2 text-[0.72rem] tracking-wide text-faint uppercase">
                    {KIND_LABEL[e.kind]}
                  </span>
                  {e.link ? (
                    <Link to={e.link} className="hover:text-gold">
                      {e.title}
                    </Link>
                  ) : (
                    e.title
                  )}
                </p>
                {e.detail && (
                  <p className="mt-0.5 line-clamp-2 text-[0.8rem] text-muted">{e.detail}</p>
                )}
                <p className="mt-0.5 text-[0.74rem] text-faint">
                  {e.by ? `${e.by} · ` : ""}
                  <span title={e.at}>
                    {local(e.at)} ({ago(e.at).toLowerCase()})
                  </span>
                </p>
              </div>
              {e.kind !== "memory" && e.kind !== "investigation" && (
                <AskButton
                  question={`About ${service.name}: "${e.title}" (${local(e.at)}). What happened, is it still a problem, and what should we do about it?`}
                />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">
          {events.length
            ? "Nothing of that kind in this period."
            : "No history recorded in this period."}
        </p>
      )}
    </div>
  );
}
