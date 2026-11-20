import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import {
  FINDING_KIND_LABEL,
  FINDING_NATURE_LABEL,
  FINDING_PATTERN_LABEL,
  FINDING_STATUS_LABEL,
  type Finding,
  type FindingSeverity,
} from "@dragon-control/core";
import { Button, Tag, cx } from "../ui";
import { shortAgo } from "../../lib/format";
import { useInvestigate } from "../../data/findings";
import { useCave } from "../shell/cave-context";
import { AddToTodo } from "../todos/AddToTodo";
import { RemoveItem } from "./RemoveItem";
import { EmberMark } from "../ember/EmberMark";

/** Where a dashboard reference leads ("finding:<id>", "incident:<id>", "job:<id>", "service:<id>"). */
export function refLink(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  if (kind === "page") return `/${id}`;
  const path = {
    finding: "/findings/",
    incident: "/incidents/",
    job: "/jobs/",
    service: "/services/",
  }[kind];
  return path ? `${path}${encodeURIComponent(id)}` : undefined;
}

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** Problems in the warning color, recommendations in the accent, observations quiet. */
export function kindTone(f: Pick<Finding, "kind" | "severity">): "warn" | "gold" | "neutral" {
  if (f.kind === "problem" || f.kind === "suspected")
    return f.severity === "low" || f.severity === "info" ? "neutral" : "warn";
  return f.kind === "recommendation" ? "gold" : "neutral";
}

/** "Ember is investigating", "Plan waiting for your approval", or nothing for a plain open one. */
export function statusLine(f: Finding): string | undefined {
  if (f.status === "open") return undefined;
  if (f.status === "planned") return "A plan is proposed. Open it to review.";
  return FINDING_STATUS_LABEL[f.status];
}

/** Ask Ember about a finding: marks it, then hands the question to the conversation. */
export function InvestigateButton({ finding, compact }: { finding: Finding; compact?: boolean }) {
  const investigate = useInvestigate();
  const cave = useCave();
  return (
    <Button
      tone={compact ? "quiet" : "outline"}
      disabled={investigate.isPending}
      onClick={() =>
        investigate.mutate(finding.id, { onSuccess: ({ prompt }) => cave.ask(prompt) })
      }
      className={compact ? "px-2" : undefined}
    >
      {finding.status === "investigating" ? "Ask Ember again" : "Investigate with Ember"}
      <EmberMark />
    </Button>
  );
}

/**
 * A finding on the dashboard: how sure and how serious, what was seen, why it matters, and
 * the next step, with Ember one click away. The card links to the finding (or its incident).
 */
export function FindingCard({
  finding: f,
  compact = false,
}: {
  finding: Finding;
  compact?: boolean;
}) {
  const to = f.incidentId ? `/incidents/${f.incidentId}` : `/findings/${f.id}`;
  const status = statusLine(f);
  const tone = kindTone(f);
  return (
    <li
      className={cx(
        "rounded-xl border bg-panel",
        compact ? "px-4 py-3" : "px-5 py-5 sm:px-6",
        tone === "warn" ? "border-warn/25" : tone === "gold" ? "border-gold/25" : "border-line",
      )}
      data-testid="finding-card"
    >
      <Link to={to} className="group block">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Tag tone={tone}>{FINDING_KIND_LABEL[f.kind]}</Tag>
          <span className="text-[0.78rem] text-faint">
            {FINDING_NATURE_LABEL[f.nature]} · {SEVERITY_LABEL[f.severity]} · F-{f.number} ·{" "}
            {shortAgo(f.firstSeenAt)} ago
          </span>
          {f.pattern !== "new" && (
            <span
              className={cx(
                "text-[0.78rem]",
                f.pattern === "returned-after-repair" ? "text-warn" : "text-faint",
              )}
              data-testid="finding-pattern"
            >
              {FINDING_PATTERN_LABEL[f.pattern]}
              {f.occurrences > 1 ? ` (${f.occurrences}×)` : ""}
            </span>
          )}
        </div>
        <div className="flex items-start justify-between gap-4">
          <p
            className={cx(
              "leading-snug text-ink group-hover:text-gold",
              compact ? "text-[0.98rem] font-medium" : "font-display text-[1.3rem]",
            )}
          >
            {f.title}
          </p>
          <ArrowUpRight
            strokeWidth={1.25}
            aria-hidden="true"
            className="mt-1 h-5 w-5 shrink-0 text-faint transition-colors group-hover:text-gold"
          />
        </div>
      </Link>
      <p
        className={cx(
          "text-muted",
          compact
            ? "mt-1 line-clamp-2 text-[0.82rem] leading-snug"
            : "mt-2 text-[0.88rem] leading-relaxed",
        )}
      >
        {f.why}
      </p>
      {f.nextSteps[0] && (
        <p
          className={cx(
            "text-ink",
            compact ? "mt-1 line-clamp-1 text-[0.82rem]" : "mt-2 text-[0.88rem] leading-relaxed",
          )}
        >
          <span className="text-faint">Next: </span>
          {f.nextSteps[0]}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {status && (
          <span className="text-[0.8rem] text-gold" data-testid="finding-status">
            {status}
          </span>
        )}
        {f.resources.slice(0, 3).map((r) => (
          <span key={`${r.kind}:${r.name}`} className="text-[0.78rem] text-faint">
            {r.name}
          </span>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-3">
          <AddToTodo
            draft={{
              category: "issue",
              title: f.title,
              description: [
                f.why,
                f.nextSteps[0] && `Next: ${f.nextSteps[0]}`,
                `Finding F-${f.number}.`,
              ]
                .filter(Boolean)
                .join("\n\n"),
              priority:
                f.severity === "critical" || f.severity === "high"
                  ? "high"
                  : f.severity === "medium"
                    ? "medium"
                    : "low",
              ...(f.serviceId ? { services: [f.serviceId] } : {}),
            }}
          />
          {f.plannable && f.status !== "planned" && <InvestigateButton finding={f} compact />}
          <RemoveItem finding={f} />
        </span>
      </div>
    </li>
  );
}
