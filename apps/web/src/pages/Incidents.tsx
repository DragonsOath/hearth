import { useState } from "react";
import { WithWorkspace } from "../components/WithWorkspace";
import { EmptyState, PageHeader, RowLink, Rows, Segmented, StatusDot, Tag } from "../components/ui";
import { UpdateCard } from "../components/updates/UpdateNotice";
import { needsYou, type Incident, type Workspace } from "@dragon-control/core";
import { ago } from "../lib/format";
import { Link } from "react-router";
import { useDashboardBriefing } from "../data/findings";
import { NEEDS_YOU_HREF, attentionItems } from "../lib/attention";
import { MonitoringTabs } from "../components/shell/MonitoringTabs";

type View = "open" | "resolved";

/** Who is handling (or handled) an incident, in words that fit its current state. */
export function handledLabel(incident: Pick<Incident, "handledBy" | "status">): string {
  if (incident.status === "resolved") {
    return {
      runbook: "Fixed automatically",
      agent: "Resolved by AI",
      you: "Resolved by you",
      pending: "Resolved",
      recovered: "Recovered on its own",
    }[incident.handledBy];
  }
  if (incident.status === "approved") return "Approved by you";
  return {
    runbook: "Known fix proposed",
    agent: "Investigated by AI",
    you: "Awaiting you",
    pending: "Awaiting you",
    recovered: "Awaiting you",
  }[incident.handledBy];
}

/** One consistent label for an incident's state, used on every screen. */
export function statusTag(incident: Pick<Incident, "status">, short = false) {
  switch (incident.status) {
    case "awaiting-approval":
      return <Tag tone="gold">{short ? "Awaiting approval" : "Awaiting your approval"}</Tag>;
    case "approved":
      return <Tag tone="gold">{short ? "Approved" : "Approved by you"}</Tag>;
    case "open":
      return <Tag tone="warn">Open</Tag>;
    default:
      return <Tag>Resolved</Tag>;
  }
}

export function subjectOf(ws: Workspace, incident: Incident): string {
  const service = ws.services.find((s) => s.id === incident.serviceId);
  const host = ws.hosts.find((h) => h.id === incident.hostId);
  return [service?.name, host?.name].filter(Boolean).join(" on ");
}

function IncidentsContent({ ws }: { ws: Workspace }) {
  const open = ws.incidents.filter((i) => i.status !== "resolved");
  const resolved = ws.incidents.filter((i) => i.status === "resolved");
  const [view, setView] = useState<View>(open.length ? "open" : "resolved");
  const list = view === "open" ? open : resolved;
  // Findings and plans waiting for approval need you too, but live on Home, not here.
  const { data: briefing } = useDashboardBriefing(undefined);
  const items = attentionItems(ws, briefing);
  const elsewhere = items.findings.length + items.jobs.length;

  return (
    <>
      <MonitoringTabs />
      <PageHeader
        eyebrow="Monitoring"
        title="Incidents"
        subtitle={
          open.length
            ? `${open.length} open. ${resolved.length} resolved in the last week.`
            : "Nothing open. Everything below was handled."
        }
      />
      {elsewhere > 0 && (
        <Link
          to={NEEDS_YOU_HREF}
          className="mb-6 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-amber/40 bg-amber/5 px-4 py-3 text-[0.88rem] text-ink hover:border-amber"
          data-testid="needs-you-elsewhere"
        >
          <span>
            {elsewhere} {elsewhere === 1 ? "other thing needs" : "other things need"} you: findings
            and plans waiting for your approval.
          </span>
          <span className="shrink-0 text-amber">See them on Home</span>
        </Link>
      )}
      {/* A new Hearth is news for the bell too: it opens this page. */}
      <UpdateCard />
      <div className="mb-8">
        <Segmented
          label="Incident view"
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: "Open", count: open.length },
            { value: "resolved", label: "Resolved", count: resolved.length },
          ]}
        />
      </div>

      {list.length === 0 ? (
        <EmptyState title={view === "open" ? "All quiet" : "No history yet"}>
          {view === "open"
            ? "There are no open incidents. Hearth will tell you if that changes."
            : "Resolved incidents and what was done about them will be kept here."}
        </EmptyState>
      ) : (
        <Rows>
          {list.map((incident) => (
            <RowLink key={incident.id} to={`/incidents/${incident.id}`} label={incident.title}>
              <StatusDot health={needsYou(incident) ? "attention" : "healthy"} />
              <div className="min-w-0 flex-1">
                <p className="text-[0.95rem] text-ink">{incident.title}</p>
                <p className="mt-0.5 truncate text-[0.8rem] text-faint">
                  {subjectOf(ws, incident)} · {handledLabel(incident)}
                </p>
              </div>
              <div className="hidden text-right sm:block">
                {incident.status === "awaiting-approval" || incident.status === "approved" ? (
                  statusTag(incident, true)
                ) : (
                  <span className="text-[0.8rem] text-faint">{ago(incident.openedAt)}</span>
                )}
              </div>
            </RowLink>
          ))}
        </Rows>
      )}
    </>
  );
}

export function IncidentsPage() {
  return <WithWorkspace>{(ws) => <IncidentsContent ws={ws} />}</WithWorkspace>;
}
