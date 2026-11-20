import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  FINDING_ACTIVE,
  FINDING_KIND_LABEL,
  FINDING_NATURE_LABEL,
  FINDING_PATTERN_LABEL,
  FINDING_STATUS_LABEL,
  needsAttention,
  type AnalyzerCoverage,
  type Finding,
} from "@dragon-control/core";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  PageSkeleton,
  Rows,
  RowLink,
  Section,
  Segmented,
  Tag,
  cx,
} from "../components/ui";
import {
  FindingCard,
  InvestigateButton,
  SEVERITY_LABEL,
  kindTone,
} from "../components/findings/FindingCard";
import {
  useCoverage,
  useFinding,
  useFindingAction,
  useFindings,
  useFindingToTodo,
  useRefreshFindings,
} from "../data/findings";
import { shortAgo } from "../lib/format";
import { BackLink } from "./ServiceDetail";
import { MonitoringTabs } from "../components/shell/MonitoringTabs";

const COVERAGE_DOT: Record<AnalyzerCoverage["status"], string> = {
  ok: "bg-ok",
  partial: "bg-warn",
  unavailable: "bg-bad",
  off: "bg-line-strong",
};
const COVERAGE_WORD: Record<AnalyzerCoverage["status"], string> = {
  ok: "Sees it",
  partial: "Partly",
  unavailable: "Cannot see",
  off: "Off",
};

/** What each analyzer could see last time: gaps shown, never hidden as "healthy". */
export function CoverageList({ coverage }: { coverage: AnalyzerCoverage[] }) {
  return (
    <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2" data-testid="coverage">
      {coverage.map((c) => (
        <li key={c.id} className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", COVERAGE_DOT[c.status])}
          />
          <span className="min-w-0 text-[0.85rem] leading-relaxed">
            <span className="text-ink">{c.label}</span>
            <span className="text-faint"> · {COVERAGE_WORD[c.status]}</span>
            {c.note && <span className="block break-words text-faint">{c.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <RowLink to={`/findings/${f.id}`} label={`F-${f.number}: ${f.title}`}>
      <div className="min-w-0 flex-1">
        <p className="text-[0.95rem] text-ink">{f.title}</p>
        <p className="text-[0.8rem] text-faint">
          {FINDING_NATURE_LABEL[f.nature]} · {FINDING_KIND_LABEL[f.kind]} ·{" "}
          {SEVERITY_LABEL[f.severity]} · F-{f.number} ·{" "}
          {f.status === "resolved" && f.resolvedAt
            ? `resolved ${shortAgo(f.resolvedAt)} ago`
            : `${shortAgo(f.firstSeenAt)} ago`}
        </p>
      </div>
      {f.status !== "open" && f.status !== "resolved" && (
        <span className="hidden text-[0.78rem] text-gold sm:block">
          {FINDING_STATUS_LABEL[f.status]}
        </span>
      )}
    </RowLink>
  );
}

export function FindingsPage() {
  const [tab, setTab] = useState<"active" | "resolved" | "dismissed" | "accepted">("active");
  const list = useFindings(tab);
  const coverage = useCoverage();
  const refresh = useRefreshFindings();
  const items = list.data ?? [];
  const attention = tab === "active" ? items.filter(needsAttention) : [];
  const rest = tab === "active" ? items.filter((f) => !needsAttention(f)) : items;
  return (
    <div className="mx-auto max-w-[1100px]">
      <MonitoringTabs />
      <PageHeader
        eyebrow="Monitoring"
        title="What Hearth has found"
        subtitle="Problems, risks, and improvements across your homelab, from Hearth's checks and Ember's investigations. Each one closes itself when a recheck shows it is gone."
        actions={
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Checking..." : "Check again now"}
          </Button>
        }
      />
      <div className="mb-8">
        <Segmented
          label="Which findings"
          value={tab}
          onChange={setTab}
          options={[
            { value: "active", label: "Open" },
            { value: "resolved", label: "Resolved" },
            { value: "accepted", label: "Accepted" },
            { value: "dismissed", label: "Dismissed" },
          ]}
        />
      </div>
      {list.isPending ? (
        <PageSkeleton />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={tab === "active" ? "Nothing open" : "Nothing here yet"}>
          {tab === "active"
            ? "Hearth's checks found nothing that needs you. See below for what it can and cannot see."
            : tab === "accepted"
              ? "Conditions you accept as they are show here. Hearth keeps checking them and raises one again if it changes."
              : "Findings move here when they are resolved or dismissed."}
        </EmptyState>
      ) : (
        <>
          {attention.length > 0 && (
            <Section title="Needs your attention">
              <ul className="space-y-3">
                {attention.map((f) => (
                  <FindingCard key={f.id} finding={f} />
                ))}
              </ul>
            </Section>
          )}
          {rest.length > 0 && (
            <Section
              title={
                tab === "active"
                  ? "Worth knowing"
                  : tab === "resolved"
                    ? "Resolved"
                    : tab === "accepted"
                      ? "Accepted"
                      : "Dismissed"
              }
            >
              <Rows>
                {rest.map((f) => (
                  <FindingRow key={f.id} f={f} />
                ))}
              </Rows>
            </Section>
          )}
        </>
      )}
      {coverage.data && (
        <Section title="What Hearth can see">
          <CoverageList coverage={coverage.data} />
        </Section>
      )}
    </div>
  );
}

export function FindingDetailPage() {
  const { id } = useParams();
  const q = useFinding(id);
  const act = useFindingAction();
  const toTodo = useFindingToTodo();
  const [accepting, setAccepting] = useState(false);
  const [note, setNote] = useState("");
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  const f = q.data;
  const active = FINDING_ACTIVE.includes(f.status);
  const run = (action: Parameters<typeof act.mutate>[0]["action"]) =>
    act.mutate({ id: f.id, action });
  return (
    <div className="mx-auto max-w-[900px]">
      <BackLink to="/findings">Findings</BackLink>
      <PageHeader
        eyebrow={`Finding F-${f.number} · ${FINDING_NATURE_LABEL[f.nature]} · ${FINDING_KIND_LABEL[f.kind]} · ${SEVERITY_LABEL[f.severity]}`}
        title={f.title}
        subtitle={
          f.status === "resolved"
            ? `Resolved ${f.resolvedAt ? `${shortAgo(f.resolvedAt)} ago` : ""}. ${f.resolution ?? ""}`
            : `${FINDING_STATUS_LABEL[f.status]}${f.acceptedNote ? ` (${f.acceptedNote})` : ""}. ${FINDING_PATTERN_LABEL[f.pattern]}: first seen ${shortAgo(f.firstSeenAt)} ago, last checked ${shortAgo(f.checkedAt)} ago${f.occurrences > 1 ? `, seen ${f.occurrences} times` : ""}.`
        }
      />
      <div className="mb-10 flex flex-wrap gap-3">
        {active && f.plannable && <InvestigateButton finding={f} />}
        {!f.todoId && (
          <Button onClick={() => toTodo.mutate(f.id)} disabled={toTodo.isPending}>
            Add to my list
          </Button>
        )}
        {f.status === "open" && (
          <Button tone="quiet" onClick={() => run({ type: "acknowledge" })}>
            Mark as seen
          </Button>
        )}
        {active && (
          <Button tone="quiet" onClick={() => run({ type: "snooze", hours: 24 * 7 })}>
            Snooze a week
          </Button>
        )}
        {(active || f.status === "dismissed") && !accepting && (
          <Button tone="quiet" onClick={() => setAccepting(true)}>
            Accept as it is
          </Button>
        )}
        {f.status === "accepted" && (
          <Button tone="quiet" onClick={() => run({ type: "unaccept" })}>
            Stop accepting
          </Button>
        )}
        {active && (
          <Button tone="quiet" onClick={() => run({ type: "dismiss" })}>
            Dismiss
          </Button>
        )}
        {!active && (
          <Button tone="quiet" onClick={() => run({ type: "reopen" })}>
            Reopen
          </Button>
        )}
      </div>
      {accepting && (
        <form
          className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            act.mutate(
              { id: f.id, action: { type: "accept", note: note.trim() || undefined } },
              { onSuccess: () => setAccepting(false) },
            );
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[0.82rem] text-muted">
            Why it is fine as it is (optional)
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              className="min-h-11 rounded-lg border border-line-strong bg-panel px-3 text-[0.9rem] text-ink"
              placeholder="Reason (optional)"
            />
          </label>
          <Button type="submit" tone="primary">
            Accept
          </Button>
          <Button tone="quiet" onClick={() => setAccepting(false)}>
            Cancel
          </Button>
        </form>
      )}
      {act.isError && (
        <p role="alert" className="mb-6 text-[0.88rem] text-bad">
          {act.error.message}
        </p>
      )}

      <Section title="What Hearth saw">
        <p className="text-[0.95rem] leading-relaxed text-ink">{f.summary}</p>
      </Section>
      <Section title="Why it matters">
        <p className="text-[0.95rem] leading-relaxed text-ink">{f.why}</p>
      </Section>
      {f.nextSteps.length > 0 && (
        <Section title="What to do next">
          <ol className="list-decimal space-y-2 pl-5 text-[0.95rem] leading-relaxed text-ink">
            {f.nextSteps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Section>
      )}
      {f.evidence.length > 0 && (
        <Section title="Evidence">
          <dl className="divide-y divide-line" data-testid="evidence">
            {f.evidence.map((e, i) => (
              <div key={i} className="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-6">
                <dt className="text-[0.82rem] text-faint">{e.label}</dt>
                <dd className="text-[0.9rem] break-words text-ink">
                  {e.value}
                  {e.at && (
                    <span className="ml-2 text-[0.78rem] text-faint">{shortAgo(e.at)} ago</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {(f.resources.length > 0 || f.incidentId || f.jobId || f.todoId) && (
        <Section title="Linked">
          <div className="flex flex-wrap gap-2">
            {f.resources.map((r) =>
              r.kind === "service" && r.id ? (
                <Link key={`s:${r.id}`} to={`/services/${r.id}`} className="hover:text-gold">
                  <Tag>{r.name}</Tag>
                </Link>
              ) : (
                <Tag key={`${r.kind}:${r.name}`}>{r.name}</Tag>
              ),
            )}
            {f.incidentId && (
              <Link to={`/incidents/${f.incidentId}`}>
                <Tag tone="warn">The incident</Tag>
              </Link>
            )}
            {f.jobId && (
              <Link to={`/jobs/${f.jobId}`}>
                <Tag tone="gold">The plan</Tag>
              </Link>
            )}
            {f.todoId && (
              <Link to="/todo">
                <Tag>On your list</Tag>
              </Link>
            )}
          </div>
        </Section>
      )}
      <Section title="History">
        <ol className="space-y-3" data-testid="finding-history">
          {f.events.map((e, i) => (
            <li key={i} className="flex gap-4 text-[0.88rem]">
              <span className="w-14 shrink-0 text-faint tabular">{shortAgo(e.at)}</span>
              <span className="text-ink">
                <span className={cx("mr-2", kindTone(f) === "warn" ? "text-warn" : "text-faint")}>
                  {e.actor === "you" ? "You" : e.actor === "ember" ? "Ember" : "Hearth"}
                </span>
                {e.text}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
