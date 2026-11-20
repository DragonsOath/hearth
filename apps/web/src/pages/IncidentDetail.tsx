import { useParams } from "react-router";
import { WithWorkspace } from "../components/WithWorkspace";
import { Button, EmptyState, Panel, Section, Tag, cx } from "../components/ui";
import type { Incident, TimelineKind, Workspace } from "@dragon-control/core";
import { useIncidentDecision } from "../data/api";
import { ago, clockTime, dateTime, minutesBetween } from "../lib/format";
import { BackLink } from "./ServiceDetail";
import { RemoveItem } from "../components/findings/RemoveItem";
import { handledLabel, statusTag, subjectOf } from "./Incidents";

const kindLabel: Record<TimelineKind, string> = {
  detected: "Detected",
  check: "Check",
  action: "Action",
  agent: "AI agent",
  approval: "Approval",
  resolved: "Resolved",
  notified: "Notified",
  escalated: "Escalated",
};

const kindTone: Partial<Record<TimelineKind, string>> = {
  detected: "border-warn bg-warn",
  resolved: "border-ok bg-ok",
  approval: "border-gold bg-gold",
  escalated: "border-warn bg-transparent",
};

type Entry = Incident["timeline"][number] & { repeats?: number; firstAt?: string };

/**
 * Repeated checks that read the same (numbers aside) shown as one line: the latest reading, how
 * many there were and since when. Older incidents stored one line per check.
 */
export function collapseChecks(timeline: Incident["timeline"]): Entry[] {
  const shape = (x: string) => x.replace(/[\d.,]+/g, "#");
  const out: Entry[] = [];
  for (const e of timeline) {
    const last = out[out.length - 1];
    if (last && e.kind === "check" && last.kind === "check" && shape(last.text) === shape(e.text))
      out[out.length - 1] = {
        ...e,
        repeats: (last.repeats ?? 1) + 1,
        firstAt: last.firstAt ?? last.at,
      };
    else out.push(e);
  }
  return out;
}

const dayOf = (at: string) => new Date(at).toDateString();

/**
 * A line's time. When the incident runs over more than one day (11-11: INC-004727 read out of
 * order without dates), the first line of each day carries its date too, and so does a span of
 * checks that crosses midnight.
 */
export function lineTime(
  entry: { at: string; firstAt?: string },
  prevAt: string | undefined,
  multiDay: boolean,
): string {
  const start = entry.firstAt ?? entry.at;
  const newDay = multiDay && (!prevAt || dayOf(prevAt) !== dayOf(start));
  const from = entry.firstAt
    ? `${newDay ? dateTime(entry.firstAt) : clockTime(entry.firstAt)} to `
    : "";
  const crosses = entry.firstAt && dayOf(entry.firstAt) !== dayOf(entry.at);
  const to = (newDay && !entry.firstAt) || crosses ? dateTime(entry.at) : clockTime(entry.at);
  return from + to;
}

function Timeline({ incident }: { incident: Incident }) {
  const entries = collapseChecks(incident.timeline); // chronological, as stored
  const multiDay =
    entries.length > 1 &&
    dayOf(entries[0]!.firstAt ?? entries[0]!.at) !== dayOf(entries[entries.length - 1]!.at);
  return (
    <ol className="relative">
      {entries.map((entry, i) => (
        <li key={i} className="relative flex gap-5 pb-7 last:pb-0">
          {i < entries.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute top-3 bottom-0 left-[4.5px] w-px bg-line"
            />
          )}
          <span
            aria-hidden="true"
            className={cx(
              "relative mt-1.5 h-2.5 w-2.5 shrink-0 rotate-45 border",
              kindTone[entry.kind] ?? "border-line-strong bg-panel",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[0.75rem] tracking-wide text-faint">
              <span className="tabular">
                {lineTime(entry, i > 0 ? entries[i - 1]!.at : undefined, multiDay)}
              </span>{" "}
              · {kindLabel[entry.kind]}
              {entry.repeats ? ` · ${entry.repeats} checks` : ""}
            </p>
            <p className="mt-1 text-[0.92rem] leading-relaxed text-ink">{entry.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Approval({ incident, repairing }: { incident: Incident; repairing: boolean }) {
  const decide = useIncidentDecision();
  if (!incident.proposedAction) return null;

  if (incident.status === "approved") {
    return (
      <Panel className="mb-12 border-gold/30 p-6 sm:p-8">
        <p className="eyebrow mb-3 text-gold">Repair approved</p>
        <p className="font-display text-[1.5rem] leading-snug text-ink">
          {incident.proposedAction}
        </p>
        <p className="mt-3 text-[0.85rem] leading-relaxed text-muted" aria-live="polite">
          {repairing
            ? "Carrying it out now. Hearth checks the result itself before closing the incident; the timeline below fills in as it goes."
            : "Your approval is recorded. This kind of change cannot be carried out automatically yet, so it is kept here for your records."}
        </p>
      </Panel>
    );
  }
  if (incident.status !== "awaiting-approval") return null;

  return (
    <Panel className="mb-12 border-gold/30 p-6 sm:p-8">
      <p className="eyebrow mb-3 text-gold">Proposed repair</p>
      <p className="font-display text-[1.5rem] leading-snug text-ink">{incident.proposedAction}</p>
      <p className="mt-3 text-[0.85rem] leading-relaxed text-muted">
        Your autonomy settings ask for approval here, so nothing changes until you decide. Your
        approval covers exactly this repair, once. After the change, Hearth verifies the result
        itself before closing the incident.
      </p>
      {incident.approval && (
        <p className="mt-2 text-[0.8rem] text-faint" data-testid="approval-expiry">
          Can be approved until {dateTime(incident.approval.expiresAt)}. After that it lapses and
          nothing changes.
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          tone="primary"
          disabled={decide.isPending || !incident.approval}
          onClick={() =>
            decide.mutate({
              incidentId: incident.id,
              decision: "approve",
              fingerprint: incident.approval?.fingerprint,
            })
          }
        >
          Approve repair
        </Button>
        <Button
          tone="outline"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ incidentId: incident.id, decision: "decline" })}
        >
          Decline
        </Button>
      </div>
      {decide.error && (
        <p role="alert" className="mt-4 text-[0.85rem] text-bad">
          {decide.error.message}
        </p>
      )}
    </Panel>
  );
}

function IncidentDetailContent({ ws, id }: { ws: Workspace; id: string }) {
  const incident = ws.incidents.find((i) => i.id === id);
  if (!incident) {
    return (
      <>
        <BackLink to="/incidents">Incidents</BackLink>
        <EmptyState title="Incident not found">
          It may belong to a different environment.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <BackLink to="/incidents">Incidents</BackLink>
      <header className="mb-10">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {statusTag(incident)}
          <Tag tone={incident.severity === "critical" ? "warn" : "neutral"}>
            {incident.severity === "critical"
              ? "Critical"
              : incident.severity === "warning"
                ? "Warning"
                : "Information"}
          </Tag>
        </div>
        <h1 className="font-display text-[2.3rem] leading-[1.08] text-ink sm:text-[2.9rem]">
          {incident.title}
        </h1>
        <p className="mt-3 text-[0.85rem] text-faint">
          {subjectOf(ws, incident)} · opened {ago(incident.openedAt)}
          {incident.resolvedAt !== undefined &&
            ` · resolved in ${Math.max(1, Math.round(minutesBetween(incident.openedAt, incident.resolvedAt)))} min`}
        </p>
        {incident.status !== "resolved" && (
          <div className="mt-4 flex">
            <RemoveItem incident={incident} />
          </div>
        )}
      </header>

      <div className="grid gap-12 lg:grid-cols-[1fr_320px]">
        <div>
          <Section title="What happened">
            <p className="text-[0.98rem] leading-relaxed text-ink">{incident.summary}</p>
            {incident.resolution && (
              <p className="mt-4 text-[0.98rem] leading-relaxed text-muted">
                {incident.resolution}
              </p>
            )}
          </Section>
          <Approval
            incident={incident}
            repairing={ws.actions.some(
              (a) => a.incidentId === incident.id && a.status === "running",
            )}
          />
          <Section title="Timeline">
            <Timeline incident={incident} />
          </Section>
        </div>
        <aside>
          <Panel className="p-6">
            <dl className="space-y-5">
              <div>
                <dt className="eyebrow">Handled by</dt>
                <dd className="mt-1.5 text-[0.9rem] text-ink">{handledLabel(incident)}</dd>
              </div>
              <div>
                <dt className="eyebrow">Reference</dt>
                <dd className="mt-1.5 text-[0.9rem] text-ink tabular">
                  {incident.id.toUpperCase()}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">Record</dt>
                <dd className="mt-1.5 text-[0.85rem] leading-relaxed text-muted">
                  Every check, action, and decision is kept here for your review. AI reasoning is
                  stored as a short summary.
                </dd>
              </div>
            </dl>
          </Panel>
        </aside>
      </div>
    </>
  );
}

export function IncidentDetailPage() {
  const { id = "" } = useParams();
  return <WithWorkspace>{(ws) => <IncidentDetailContent ws={ws} id={id} />}</WithWorkspace>;
}
