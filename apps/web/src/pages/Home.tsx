import { useCallback, useState } from "react";
import { GettingStartedList } from "../components/GettingStarted";
import { useBriefing } from "../data/memory";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import {
  ArrowRight,
  Box,
  ChevronRight,
  Clock,
  Cpu,
  DatabaseBackup,
  HardDrive,
  MemoryStick,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useBackups } from "../data/memory";
import { CommandHub } from "../components/command/Hub";
import { SplitView } from "../components/command/SplitView";
import { Desk } from "../components/desk/Desk";
import { GroupScope } from "../components/desk/groups";
import { useDesk } from "../components/desk/links";
import { useCave } from "../components/shell/cave-context";
import { MinimizedWorkspaces, useAutoOpenWorkspaces } from "../components/workspace/dock";
import { WithWorkspace } from "../components/WithWorkspace";
import {
  LinkButton,
  EmptyState,
  Meter,
  Rows,
  RowLink,
  Section,
  SeeAll,
  Sheet,
  Status,
  StatusDot,
  Tag,
  cx,
} from "../components/ui";
import {
  aiDisplayName,
  type DashboardBriefing,
  type Finding,
  type Workspace,
} from "@dragon-control/core";
import { useDashboardBriefing } from "../data/findings";
import { attentionItems } from "../lib/attention";
import { FindingCard, refLink } from "../components/findings/FindingCard";
import { AddToTodo } from "../components/todos/AddToTodo";
import { RemoveItem } from "../components/findings/RemoveItem";
import { CoverageList } from "./Findings";
import { statusTag } from "./Incidents";
import { attentionIncidents, greeting, pct, shortAgo, storageTotals } from "../lib/format";
import { usePcs } from "../data/pcs";
import { useViewingPcId } from "../lib/viewingPc";

const numberWords = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** When this browser last opened Home: a convenience only, so "since you were last here" means something. */
let visitedBefore: { at: string | undefined } | undefined;
function lastVisit(): string | undefined {
  // Read once per page load: Home can mount more than once while the page settles, and a second
  // read would find the time the first one just stored (so nothing would look new).
  if (visitedBefore) return visitedBefore.at;
  try {
    visitedBefore = { at: localStorage.getItem("dc-home-visited") ?? undefined };
    localStorage.setItem("dc-home-visited", new Date().toISOString());
  } catch {
    visitedBefore = { at: undefined };
  }
  return visitedBefore.at;
}

const POINT_LABEL = {
  "needs-you": "Needs you",
  since: "Since you were last here",
  win: "Win",
  "in-progress": "In progress",
  idea: "An idea",
} as const;

/**
 * What a friend keeping an eye on things would mention: the same points
 * an AI companion opens with, so they are here even with no AI connected.
 * Incidents already have their own section above, so they are not repeated.
 */
function WhatsUp({ since }: { since: string | undefined }) {
  const { data } = useBriefing(since);
  // What needs you, and ideas about the setup, are findings now (above); this keeps what only
  // memory knows: what was done, open threads, and wins you recorded.
  const points = (data?.opening ?? []).filter(
    (p) =>
      // Resolved problems are in "Since you were last here"; memory's own notes stay.
      (p.kind === "since" && p.ref?.startsWith("memory:")) ||
      p.kind === "in-progress" ||
      (p.kind === "win" && p.ref?.startsWith("memory:")),
  );
  if (!points.length) return null;
  return (
    <Section title="What's up">
      <ul className="space-y-4" data-testid="whats-up">
        {points.map((p, i) => (
          <li key={i} className="flex flex-col gap-1">
            <span
              className={cx(
                "shrink-0 text-[0.78rem] tracking-wide",
                p.kind === "needs-you"
                  ? "text-warn"
                  : p.kind === "win"
                    ? "text-gold"
                    : "text-faint",
              )}
            >
              {POINT_LABEL[p.kind]}
            </span>
            <span className="text-[0.95rem] leading-relaxed text-ink">
              {p.ref?.startsWith("memory:") ? (
                <Link to="/memory" className="hover:text-gold">
                  {p.text}
                </Link>
              ) : (
                p.text
              )}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------- What needs you: pills and their sheet ---------- */

type Group = "critical" | "warnings" | "approvals" | "ideas";

const GROUPS: { id: Group; label: string; tone: string; dot: string }[] = [
  {
    id: "critical",
    label: "Critical",
    tone: "border-alert/60 bg-alert/15 text-alert font-medium",
    dot: "bg-alert",
  },
  {
    id: "warnings",
    label: "Warnings",
    tone: "border-warn/50 bg-warn/10 text-warn",
    dot: "bg-warn",
  },
  {
    id: "approvals",
    label: "Approvals",
    tone: "border-gold/50 bg-gold/10 text-gold",
    dot: "bg-gold",
  },
  { id: "ideas", label: "Worth knowing", tone: "border-line bg-panel text-muted", dot: "bg-faint" },
];

/**
 * What needs the owner, sorted into the groups Home's pills show. The same items and the same
 * count as everywhere else (attentionItems); only the grouping is Home's.
 */
function attentionGroups(ws: Workspace, briefing: DashboardBriefing | undefined) {
  const a = attentionItems(ws, briefing);
  const critical = a.incidents.filter((i) => i.severity === "critical");
  const rest = a.incidents.filter((i) => i.severity !== "critical");
  const none: Workspace["pendingJobs"] = [];
  return {
    ...a,
    groups: {
      critical: {
        incidents: critical,
        findings: a.findings.filter((f) => f.severity === "critical"),
        jobs: none,
      },
      warnings: {
        incidents: rest.filter((i) => i.status !== "awaiting-approval"),
        findings: a.findings.filter((f) => f.severity !== "critical"),
        jobs: none,
      },
      approvals: {
        incidents: rest.filter((i) => i.status === "awaiting-approval"),
        findings: [] as Finding[],
        jobs: a.jobs,
      },
    },
    ideas: briefing?.worthKnowing ?? [],
    ideasTotal: briefing?.worthKnowingTotal ?? 0,
    /** Findings that need you beyond the ones the briefing carries. */
    more: (briefing?.attentionTotal ?? 0) - (briefing?.attention.length ?? 0),
  };
}
type Groups = ReturnType<typeof attentionGroups>;
type Items = Groups["groups"]["critical"];

function groupCount(g: Groups, id: Group) {
  if (id === "ideas") return g.ideasTotal;
  const x = g.groups[id];
  return x.incidents.length + x.findings.length + x.jobs.length;
}

function Pill({
  p,
  count,
  onOpen,
}: {
  p: (typeof GROUPS)[number];
  count: number;
  onOpen: (id: Group | "all") => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(p.id)}
      className={cx(
        "inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-[0.86rem] transition-[filter] hover:brightness-125",
        p.tone,
        p.id === "critical" && "cc-alert-glow",
      )}
      data-testid={`pill-${p.id}`}
    >
      <span className={cx("h-2 w-2 rounded-full", p.dot)} aria-hidden="true" />
      <span className="tabular">{count}</span>
      {p.label}
      <ChevronRight strokeWidth={1.75} className="h-4 w-4 opacity-70" aria-hidden="true" />
    </button>
  );
}

/**
 * Home's alert band, under Ember: one pill per kind of thing that needs you, what is offline,
 * and the whole list. Critical stays the loudest; nothing that needs you is ever left out.
 */
function AlertBand({
  g,
  ws,
  onOpen,
  onBriefing,
}: {
  g: Groups;
  ws: Workspace;
  onOpen: (id: Group | "all") => void;
  onBriefing: () => void;
}) {
  const shown = GROUPS.filter((p) => p.id !== "ideas" && groupCount(g, p.id) > 0);
  const offline =
    ws.hosts.filter((h) => h.health === "offline").length +
    ws.services.filter((s) => !s.stopped && s.health === "offline").length;
  return (
    <section
      aria-label="Alerts"
      className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-line bg-panel/50 px-3 py-2.5"
      data-testid="attention-pills"
    >
      {!shown.length && (
        <span className="inline-flex min-h-10 items-center gap-2 rounded-full border border-live/40 bg-live/10 px-4 text-[0.86rem] text-live">
          <span className="h-2 w-2 rounded-full bg-live" aria-hidden="true" />
          All clear
        </span>
      )}
      {shown.map((p) => (
        <Pill key={p.id} p={p} count={groupCount(g, p.id)} onOpen={onOpen} />
      ))}
      {offline > 0 && (
        <Link
          to="/services"
          className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line bg-bg/60 px-4 text-[0.86rem] text-ink hover:border-gold/50"
          data-testid="pill-offline"
        >
          <span className="h-2 w-2 rounded-full bg-faint" aria-hidden="true" />
          <span className="tabular">{offline}</span>
          Offline
          <ChevronRight strokeWidth={1.75} className="h-4 w-4 text-faint" aria-hidden="true" />
        </Link>
      )}
      <button
        type="button"
        onClick={onBriefing}
        className="ml-auto hidden min-h-10 items-center gap-2 rounded-full border border-line px-4 text-[0.86rem] text-muted hover:text-ink lg:inline-flex 2xl:hidden"
        data-testid="band-briefing"
      >
        <Clock strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
        Briefing
      </button>
      <button
        type="button"
        onClick={() => onOpen(g.ideasTotal && !g.count ? "ideas" : "all")}
        className="ml-auto lg:ml-0 2xl:ml-auto inline-flex min-h-10 items-center gap-2 rounded-full border border-gold/40 px-4 text-[0.86rem] text-gold hover:bg-gold/10"
        data-testid="view-all-alerts"
      >
        View all alerts
        {g.ideasTotal > 0 && <span className="text-faint">· {g.ideasTotal} worth knowing</span>}
        <ArrowRight strokeWidth={1.75} className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}

/** Compact entries: what it is, a line on why, and the same actions as before. */
function AttentionList({ items, byIncident }: { items: Items; byIncident: Groups["byIncident"] }) {
  return (
    <ul className="space-y-2">
      {items.jobs.map((job) => (
        <li
          key={job.id}
          className="rounded-xl border border-gold/25 bg-panel px-4 py-3 transition-colors hover:border-gold/50"
        >
          <Link to={`/jobs/${job.id}`} className="group block">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Tag tone="gold">Job awaiting your approval</Tag>
              <span className="text-[0.76rem] text-faint">{shortAgo(job.createdAt)} ago</span>
            </div>
            <p className="text-[0.98rem] font-medium text-ink group-hover:text-gold">{job.title}</p>
            <p className="mt-0.5 text-[0.82rem] text-muted">
              {job.steps} {job.steps === 1 ? "step" : "steps"},{" "}
              {job.requestedBy === "agent"
                ? "proposed by the AI"
                : job.requestedBy === "you"
                  ? "planned by you"
                  : "proposed by Hearth"}
              . Review it before anything runs.
            </p>
          </Link>
          <div className="mt-1.5 flex justify-end">
            <AddToTodo
              draft={{
                category: "task",
                title: `Review the plan: ${job.title}`,
                description: `A plan waiting for your approval (${job.steps} ${job.steps === 1 ? "step" : "steps"}). Open it from Jobs to review it.`,
                nextAction: "Review and approve or decline the plan.",
              }}
            />
          </div>
        </li>
      ))}
      {items.incidents.map((incident) => (
        <li
          key={incident.id}
          className={cx(
            "rounded-xl border bg-panel px-4 py-3 transition-colors",
            incident.severity === "critical"
              ? "border-alert/40 hover:border-alert/70"
              : "border-warn/25 hover:border-warn/50",
          )}
        >
          <Link to={`/incidents/${incident.id}`} className="group block">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              {statusTag(incident)}
              <span className="text-[0.76rem] text-faint">{shortAgo(incident.openedAt)} ago</span>
            </div>
            <p className="text-[0.98rem] font-medium text-ink group-hover:text-gold">
              {incident.title}
            </p>
            <p className="mt-0.5 line-clamp-2 text-[0.82rem] text-muted">
              {incident.proposedAction ?? incident.summary}
            </p>
            {byIncident.get(incident.id) && (
              <p className="mt-0.5 line-clamp-1 text-[0.8rem] text-faint">
                {byIncident.get(incident.id)!.why}
              </p>
            )}
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center justify-end gap-3">
            <RemoveItem incident={incident} />
            <AddToTodo
              draft={{
                category: "issue",
                title: incident.title,
                description: incident.proposedAction ?? incident.summary,
                priority: "high",
                ...(incident.serviceId ? { services: [incident.serviceId] } : {}),
              }}
            />
          </div>
        </li>
      ))}
      {items.findings.map((f) => (
        <FindingCard key={f.id} finding={f} compact />
      ))}
    </ul>
  );
}

/**
 * Everything the pills count, in a side sheet: one group or all of them. "N things need you" in
 * the top bar and the bell open it here, on All.
 */
function AttentionSheet({
  g,
  initial,
  onClose,
}: {
  g: Groups;
  initial: Group | "all";
  onClose: () => void;
}) {
  const [group, setGroup] = useState<Group | "all">(initial);
  const tabs: { id: Group | "all"; label: string; count: number }[] = [
    { id: "all", label: "All", count: g.count },
    ...GROUPS.map((p) => ({ id: p.id, label: p.label, count: groupCount(g, p.id) })),
  ];
  const all: Items = {
    incidents: [
      ...g.groups.critical.incidents,
      ...g.groups.warnings.incidents,
      ...g.groups.approvals.incidents,
    ],
    findings: [...g.groups.critical.findings, ...g.groups.warnings.findings],
    jobs: g.jobs,
  };
  const moreIdeas = g.ideasTotal - g.ideas.length;
  return (
    <Sheet
      label="Requires your attention"
      eyebrow="Needs you"
      title={
        group === "all"
          ? g.count
            ? `${g.count} ${g.count === 1 ? "thing needs" : "things need"} you`
            : "Nothing needs you"
          : (GROUPS.find((p) => p.id === group)?.label ?? "")
      }
      onClose={onClose}
      wide
    >
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={group === t.id}
            onClick={() => setGroup(t.id)}
            className={cx(
              "min-h-8 rounded-full border px-3 text-[0.8rem]",
              group === t.id
                ? "border-gold/60 bg-gold/15 text-gold"
                : "border-line text-muted hover:text-ink",
            )}
          >
            {t.label} <span className="tabular">{t.count}</span>
          </button>
        ))}
      </div>
      {group === "ideas" ? (
        <section aria-label="Worth knowing">
          {g.ideas.length ? (
            <Rows>
              {g.ideas.map((f) => (
                <RowLink key={f.id} to={`/findings/${f.id}`} label={f.title}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.92rem] text-ink">{f.title}</p>
                    <p className="line-clamp-2 text-[0.8rem] leading-relaxed text-faint">{f.why}</p>
                  </div>
                  <Tag tone={f.kind === "recommendation" ? "gold" : "neutral"}>
                    {f.kind === "recommendation"
                      ? "Idea"
                      : f.kind === "observation"
                        ? "Note"
                        : "Low"}
                  </Tag>
                </RowLink>
              ))}
            </Rows>
          ) : (
            <p className="text-[0.88rem] text-faint">Nothing new worth knowing.</p>
          )}
          <div className="mt-4">
            <SeeAll to="/findings">{moreIdeas > 0 ? `${moreIdeas} more` : "All findings"}</SeeAll>
          </div>
        </section>
      ) : (
        <section id="needs-you" aria-label="Requires your attention">
          {groupCountOf(g, group) === 0 ? (
            <p className="text-[0.88rem] text-faint">Nothing here needs you.</p>
          ) : (
            <AttentionList
              items={group === "all" ? all : g.groups[group]}
              byIncident={g.byIncident}
            />
          )}
          {g.more > 0 && (
            <div className="mt-4">
              <SeeAll to="/findings">{`${g.more} more`}</SeeAll>
            </div>
          )}
        </section>
      )}
    </Sheet>
  );
}

const groupCountOf = (g: Groups, id: Group | "all") => (id === "all" ? g.count : groupCount(g, id));

/* ---------- The briefing: everything that used to make Home long ---------- */

const TONE = { good: "text-ok", neutral: "text-faint", attention: "text-warn" } as const;

/** What changed since you were last here: found, fixed, updated, done. */
function Changes({ briefing, since }: { briefing: DashboardBriefing; since?: string }) {
  if (!briefing.changes.length) return null;
  return (
    <Section title={since ? "Since you were last here" : "In the last day"}>
      <Rows>
        {briefing.changes.map((c, i) => {
          const to = refLink(c.ref);
          return (
            <li key={i} className="flex min-h-12 items-center gap-4 py-3" data-testid="change">
              <span className={cx("text-[0.7rem]", TONE[c.tone])} aria-hidden="true">
                ◆
              </span>
              {to ? (
                <Link to={to} className="flex-1 text-[0.9rem] text-ink hover:text-gold">
                  {c.text}
                </Link>
              ) : (
                <span className="flex-1 text-[0.9rem] text-ink">{c.text}</span>
              )}
              <span className="text-[0.78rem] text-faint tabular">{shortAgo(c.at)}</span>
            </li>
          );
        })}
      </Rows>
    </Section>
  );
}

/** Real evidence that things work: imports, quiet fixes, backups, healthy services. */
function WorkingWell({ briefing }: { briefing: DashboardBriefing }) {
  if (!briefing.working.length) return null;
  return (
    <Section title="Working well">
      <ul className="space-y-3" data-testid="working-well">
        {briefing.working.map((w, i) => {
          const to = refLink(w.ref);
          return (
            <li key={i} className="flex gap-3 text-[0.9rem] leading-relaxed">
              <span className="text-ok" aria-hidden="true">
                ✓
              </span>
              {to ? (
                <Link to={to} className="text-ink hover:text-gold">
                  {w.text}
                </Link>
              ) : (
                <span className="text-ink">{w.text}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** What Ember is investigating or handling, and what waits for you. */
function EmberNow({ briefing, aiName }: { briefing: DashboardBriefing; aiName: string }) {
  return (
    <Section title="Being handled">
      {briefing.ember.length ? (
        <Rows>
          {briefing.ember.map((e, i) => (
            <RowLink key={i} to={refLink(e.ref) ?? "/"} label={e.text}>
              <span
                className={cx(
                  "h-2 w-2 shrink-0 rounded-full",
                  e.status === "awaiting-approval" ? "bg-amber" : "bg-gold",
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 text-[0.9rem] text-ink">{e.text}</span>
            </RowLink>
          ))}
        </Rows>
      ) : (
        <p className="text-[0.88rem] leading-relaxed text-faint">
          {aiName} is not working on anything. Ask about a finding to start an investigation.
        </p>
      )}
    </Section>
  );
}

function Trends({ briefing }: { briefing: DashboardBriefing }) {
  if (!briefing.trends.length) return null;
  return (
    <Section title="This week">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2" data-testid="trends">
        {briefing.trends.map((t) => (
          <div key={t.label}>
            <dt className="text-[0.78rem] text-faint">{t.label}</dt>
            <dd className={cx("text-[0.95rem]", t.tone === "attention" ? "text-warn" : "text-ink")}>
              {t.text}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Systems({ ws }: { ws: Workspace }) {
  return (
    <Section title="Systems" action={<SeeAll to="/systems" />}>
      <Rows>
        {ws.hosts.map((host) => (
          <RowLink key={host.id} to={`/systems#${host.id}`} label={`${host.name}, ${host.role}`}>
            <StatusDot health={host.health} />
            <div className="min-w-0 flex-1">
              <p className="text-[0.95rem] text-ink">{host.name}</p>
              <p className="text-[0.8rem] text-faint">{host.role}</p>
            </div>
            <div className="hidden w-32 sm:block">
              <p className="mb-1.5 text-right text-[0.75rem] text-faint tabular">
                Memory {pct(host.memory.usedGb, host.memory.totalGb)}%
              </p>
              <Meter
                value={pct(host.memory.usedGb, host.memory.totalGb)}
                label={`${host.name} memory`}
              />
            </div>
            <Status health={host.health} />
          </RowLink>
        ))}
      </Rows>
    </Section>
  );
}

/**
 * What happened and what was done. A warning still open is in "Requires your attention", so it is
 * not repeated here; its recovery or repair shows here when it happens.
 */
function Activity({ ws }: { ws: Workspace }) {
  const open = new Set(attentionIncidents(ws).map((i) => i.id));
  const items = ws.activity.filter(
    (a) => !(a.tone === "attention" && a.incidentId && open.has(a.incidentId)),
  );
  if (!items.length) return null;
  return (
    <Section title="Recent activity" action={<SeeAll to="/incidents">History</SeeAll>}>
      <Rows>
        {items.slice(0, 6).map((a) => (
          <li key={a.id} className="flex min-h-12 items-center gap-4 py-3">
            <span className={cx("text-[0.7rem]", TONE[a.tone])} aria-hidden="true">
              ◆
            </span>
            {a.incidentId ? (
              <Link
                to={`/incidents/${a.incidentId}`}
                className="flex-1 text-[0.9rem] text-ink hover:text-gold"
              >
                {a.text}
              </Link>
            ) : (
              <span className="flex-1 text-[0.9rem] text-ink">{a.text}</span>
            )}
            <span className="text-[0.78rem] text-faint tabular">{shortAgo(a.at)}</span>
          </li>
        ))}
      </Rows>
    </Section>
  );
}

/** The longer read, one click from Home: what changed, what works, what Ember is doing, more. */
function BriefingSheet({
  ws,
  briefing,
  since,
  onClose,
}: {
  ws: Workspace;
  briefing: DashboardBriefing | undefined;
  since?: string;
  onClose: () => void;
}) {
  return (
    <Sheet label="Briefing" eyebrow="Briefing" title="What's been happening" onClose={onClose} wide>
      {briefing && <EmberNow briefing={briefing} aiName={aiDisplayName(ws.aiName)} />}
      {briefing && <Changes briefing={briefing} since={since} />}
      {briefing && <WorkingWell briefing={briefing} />}
      <WhatsUp since={since} />
      {briefing && <Trends briefing={briefing} />}
      <Activity ws={ws} />
      <Systems ws={ws} />
      {briefing && (
        <Section title="What Hearth can see" action={<SeeAll to="/findings">Findings</SeeAll>}>
          <CoverageList coverage={briefing.coverage} />
        </Section>
      )}
    </Sheet>
  );
}

/* ---------- The row along the bottom ---------- */

/** A value as ten small blocks (the current value, not a history). */
function Blocks({ value, tone }: { value: number; tone: string }) {
  const on = Math.round(Math.max(0, Math.min(100, value)) / 10);
  return (
    <span className="mt-2 flex gap-[3px]" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <span key={i} className={cx("h-2 flex-1 rounded-[2px]", i < on ? tone : "bg-line")} />
      ))}
    </span>
  );
}

function Tile({
  icon: Icon,
  title,
  value,
  unit,
  sub,
  to,
  bar,
  tone = "bg-gold",
  iconTone = "text-gold",
}: {
  icon: typeof Server;
  title: string;
  value: string;
  unit?: string;
  sub?: string;
  to: string;
  bar?: number;
  tone?: string;
  iconTone?: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-w-0 flex-col rounded-xl border border-line bg-panel/70 px-3.5 py-2.5 transition-colors hover:border-gold/50"
    >
      <span className="flex items-center gap-2 text-[0.8rem] text-muted">
        <Icon strokeWidth={1.5} className={cx("h-4 w-4 shrink-0", iconTone)} aria-hidden="true" />
        <span className="truncate">{title}</span>
      </span>
      <span className="mt-1 font-display text-[1.35rem] leading-tight text-ink tabular">
        {value}
        {unit && <span className="ml-1 text-[0.8rem] text-faint">{unit}</span>}
      </span>
      {sub && <span className="truncate text-[0.74rem] text-faint">{sub}</span>}
      {bar !== undefined && <Blocks value={bar} tone={tone} />}
    </Link>
  );
}

/**
 * Whose numbers the row shows (10-30): the PC you are sitting at by default (a window opened
 * from a joined PC says which), any one PC, or all of them. "hub": your main Hearth's own.
 */
type Scope = "hub" | "all" | string;

function inScope<T extends { pcId?: string }>(list: T[], scope: Scope): T[] {
  if (scope === "all") return list;
  return list.filter((x) => (scope === "hub" ? !x.pcId : x.pcId === scope));
}

/** Pick whose numbers to show; only when there is more than one PC. */
function ScopePicker({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  const pcs = usePcs();
  if (!pcs.data?.pcs.length) return null;
  return (
    <label className="ml-auto flex items-center gap-2 text-[0.8rem] text-muted">
      Stats for
      <select
        value={scope}
        onChange={(e) => onScope(e.target.value)}
        className="min-h-8 rounded-lg border border-line-strong bg-panel px-2 text-[0.8rem] text-ink focus:border-gold focus:outline-none"
        data-testid="vitals-scope"
      >
        <option value="hub">{pcs.data.hub.name}</option>
        {pcs.data.pcs.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.online ? "" : " (offline)"}
          </option>
        ))}
        <option value="all">All PCs</option>
      </select>
    </label>
  );
}

/** The state of things in one row: each tile opens its page for the detail. */
function Vitals({
  ws,
  scope,
  onScope,
}: {
  ws: Workspace;
  scope: Scope;
  onScope: (s: Scope) => void;
}) {
  const backups = useBackups();
  const pcs = usePcs();
  const hosts = inScope(ws.hosts, scope);
  const services = inScope(ws.services, scope);
  // A PC with nothing to show yet (offline, or still on sample data until it scans itself).
  if (!hosts.length && scope !== "all") {
    const name = pcs.data?.pcs.find((p) => p.id === scope)?.name ?? "This PC";
    return (
      <section
        aria-label="At a glance"
        className="flex min-h-[74px] flex-wrap items-center gap-3 rounded-xl border border-line bg-panel/70 px-4 py-3 text-[0.85rem] text-muted"
        data-testid="vitals-empty"
      >
        <span className="min-w-0 flex-1">
          No numbers from {name} yet: it has not looked at its own machine.
        </span>
        <Link
          to={`/discover?pc=${encodeURIComponent(scope)}`}
          className="flex min-h-9 items-center rounded-lg bg-gold px-3 font-medium text-bg hover:bg-gold-bright"
          data-testid="vitals-discover"
        >
          Discover {name}
        </Link>
        <button
          type="button"
          onClick={() => onScope("all")}
          className="min-h-9 rounded-lg border border-line-strong px-3 text-ink hover:border-gold"
        >
          Show all PCs
        </button>
      </section>
    );
  }
  const online = hosts.filter((h) => h.health !== "offline");
  const cpu = online.length
    ? Math.round(online.reduce((n, h) => n + h.cpu.usagePct, 0) / online.length)
    : 0;
  const memUsed = online.reduce((n, h) => n + h.memory.usedGb, 0);
  const memTotal = online.reduce((n, h) => n + h.memory.totalGb, 0);
  const storage = storageTotals(hosts);
  const containers = services.filter((s) => s.kind === "container");
  const running = containers.filter((s) => !s.stopped && s.health !== "offline").length;
  const watched = services.filter((s) => !s.stopped);
  const healthy = watched.filter((s) => s.health === "healthy").length;
  const last = backups.data?.lastOk;
  const lastFailed = backups.data?.recent[0] && !backups.data.recent[0].ok;
  const warn = (bad: boolean) => (bad ? "bg-warn" : "bg-live");
  return (
    <section
      aria-label="At a glance"
      className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6"
      data-testid="vitals"
      data-scope={scope}
    >
      <Tile
        icon={Cpu}
        title="CPU"
        value={`${cpu}%`}
        sub={`average of ${online.length} ${online.length === 1 ? "system" : "systems"}`}
        to="/systems"
        bar={cpu}
        tone={cpu >= 85 ? "bg-warn" : "bg-tint-blue"}
        iconTone="text-tint-blue"
      />
      <Tile
        icon={MemoryStick}
        title="Memory"
        value={`${pct(memUsed, memTotal)}%`}
        sub={`${memUsed.toFixed(0)} of ${memTotal.toFixed(0)} GB`}
        to="/systems"
        bar={pct(memUsed, memTotal)}
        tone={pct(memUsed, memTotal) >= 90 ? "bg-warn" : "bg-tint-violet"}
        iconTone="text-tint-violet"
      />
      <Tile
        icon={HardDrive}
        title="Storage"
        value={storage.used.toFixed(1)}
        unit="TB"
        sub={`of ${storage.total.toFixed(1)} TB`}
        to="/?panels=tool%3Astorage&focus=tool%3Astorage"
        bar={storage.percent}
        tone={storage.percent >= 90 ? "bg-warn" : "bg-gold"}
      />
      <Tile
        icon={Box}
        title="Containers"
        value={`${running}`}
        unit={`/ ${containers.length}`}
        sub="running"
        to="/services"
        bar={pct(running, containers.length)}
        tone={warn(running < containers.length)}
        iconTone="text-tint-teal"
      />
      <Tile
        icon={ShieldCheck}
        title="Services"
        value={`${healthy}`}
        unit={`/ ${watched.length}`}
        sub="healthy"
        to="/services"
        bar={pct(healthy, watched.length)}
        tone={warn(healthy < watched.length)}
        iconTone="text-live"
      />
      <Tile
        icon={DatabaseBackup}
        title="Backups"
        value={last ? `${shortAgo(last.at)} ago` : "None yet"}
        sub={lastFailed ? "The latest backup failed" : last ? "Last good backup" : "Not backed up"}
        to="/settings#backups"
        iconTone={lastFailed || !last ? "text-warn" : "text-live"}
      />
    </section>
  );
}

/** The latest few things that happened, with the full briefing a click away. */
function RecentActivity({ ws, onBriefing }: { ws: Workspace; onBriefing: () => void }) {
  const open = new Set(attentionIncidents(ws).map((i) => i.id));
  const items = ws.activity
    .filter((a) => !(a.tone === "attention" && a.incidentId && open.has(a.incidentId)))
    .slice(0, 4);
  return (
    <section
      aria-label="Latest activity"
      // Beside the tiles on wide screens; on laptops the band's Briefing button opens it all.
      className="flex min-w-0 flex-col rounded-xl border border-line bg-panel/70 px-3.5 py-2.5 lg:hidden 2xl:flex"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[0.8rem] text-muted">
          <Clock strokeWidth={1.5} className="h-4 w-4 text-gold" aria-hidden="true" />
          Recent activity
        </span>
        <button
          type="button"
          onClick={onBriefing}
          className="text-[0.76rem] text-gold hover:text-gold-bright"
          data-testid="open-briefing"
        >
          Briefing →
        </button>
      </div>
      {items.length ? (
        <ul className="mt-1.5 space-y-1">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-[0.78rem]">
              <span className={cx("text-[0.55rem]", TONE[a.tone])} aria-hidden="true">
                ●
              </span>
              {a.incidentId ? (
                <Link
                  to={`/incidents/${a.incidentId}`}
                  className="min-w-0 flex-1 truncate text-ink hover:text-gold"
                >
                  {a.text}
                </Link>
              ) : (
                <span className="min-w-0 flex-1 truncate text-ink">{a.text}</span>
              )}
              <span className="shrink-0 text-faint tabular">{shortAgo(a.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[0.78rem] text-faint">Nothing has happened yet.</p>
      )}
    </section>
  );
}

function FreshHome() {
  return (
    <>
      <GettingStartedList />
      <header className="mb-12">
        <p className="eyebrow mb-3">Welcome</p>
        <h1 className="font-display text-[2.6rem] leading-[1.05] text-ink sm:text-[3.4rem]">
          Let's see what you're running.
        </h1>
        <p className="mt-4 max-w-lg text-[0.95rem] leading-relaxed text-muted">
          Hearth will look at this machine, find your containers and services, and ask before
          connecting anything.
        </p>
      </header>
      <EmptyState
        title="Nothing connected yet"
        action={
          <LinkButton to="/discover" tone="primary">
            Discover this machine
          </LinkButton>
        }
      >
        Discovery only reads. Nothing on your systems changes, and you choose what to keep.
      </EmptyState>
    </>
  );
}

/**
 * A workspace Ember opens while you talk on Home opens beside the conversation (the
 * desk); minimized ones wait here to be reopened.
 */
function HubWorkspaces() {
  const cave = useCave();
  const { setExpanded } = cave;
  const [, setParams] = useSearchParams();
  const open = useCallback(
    (ids: string[]) => {
      const s = new URLSearchParams();
      s.set("panels", ids.map((id) => `workspace:${encodeURIComponent(id)}`).join(","));
      s.set("focus", `workspace:${ids.at(-1)}`);
      setParams(s);
      // The same conversation is docked beside the panel.
      setExpanded(false);
    },
    [setParams, setExpanded],
  );
  useAutoOpenWorkspaces(cave.conversationId, [], open);
  return (
    <div className="flex justify-end empty:hidden">
      <MinimizedWorkspaces conversationId={cave.conversationId} onOpen={(id) => open([id])} />
    </div>
  );
}

function HomeContent({ ws }: { ws: Workspace }) {
  const [params] = useSearchParams();
  const desk = useDesk();
  const split = params.has("project") || params.has("service") || params.has("panels");
  // Desktop: several panels beside the conversation. Smaller screens: one at a time, as before.
  if (split)
    return <GroupScope ws={ws}>{desk ? <Desk ws={ws} /> : <SplitView ws={ws} />}</GroupScope>;
  if (ws.services.length === 0) return <FreshHome />;
  return <Dashboard ws={ws} />;
}

/**
 * Home's command center: what needs you as pills along the top, Ember in the middle with the
 * active projects around it, and the state of things in one strip along the bottom. On a desktop
 * it fits the window exactly (no page scrolling); the longer reads open in sheets.
 */
function Dashboard({ ws }: { ws: Workspace }) {
  const [since] = useState(lastVisit);
  const { data: briefing, isError } = useDashboardBriefing(since);
  const g = attentionGroups(ws, briefing);
  const open = g.count;
  // The count waits for the briefing, so it never says fewer things than there are.
  const ready = briefing !== undefined || isError;
  const [chosen, setSheet] = useState<Group | "all" | "briefing" | null>(null);
  const navigate = useNavigate();
  // From "N things need you" (the top bar, the bell): straight to the list, once it is there.
  const { hash } = useLocation();
  const sheet = chosen ?? (hash === "#needs-you" && ready ? "all" : null);
  // The numbers follow the PC this window is on, until you pick another.
  const viewing = useViewingPcId();
  const [picked, setScope] = useState<Scope | null>(null);
  const scope: Scope = picked ?? viewing ?? "hub";
  const close = () => {
    setSheet(null);
    if (hash === "#needs-you") void navigate({ hash: "" }, { replace: true });
  };

  return (
    <div
      // Exactly the window on a computer: a pixel of rounding never becomes a scrollbar.
      className="mx-auto flex w-full max-w-[1480px] flex-col gap-3 lg:h-full lg:min-h-0 lg:overflow-hidden"
      data-testid="command-center"
    >
      <header className="flex shrink-0 flex-wrap items-baseline gap-x-4 gap-y-0.5">
        <h1 className="font-display text-[1.4rem] leading-tight font-normal text-ink sm:text-[1.55rem]">
          {greeting()}
          {ws.ownerName ? `, ${ws.ownerName}` : ""}.
        </h1>
        <p
          className={cx(
            "font-display text-[1.05rem] leading-snug italic sm:text-[1.15rem]",
            open ? "text-warn" : "text-gold",
          )}
          data-testid="headline"
        >
          {!ready
            ? "Looking at what needs you..."
            : open === 0
              ? "Nothing requires your attention."
              : `${numberWords[open] ?? open} ${open === 1 ? "matter needs" : "matters need"} your attention.`}
        </p>
        <ScopePicker scope={scope} onScope={setScope} />
      </header>

      {/* While setup is unfinished; on a desktop it scrolls inside its own box, never the page. */}
      <div className="shrink-0 empty:hidden lg:max-h-[20vh] lg:overflow-y-auto [&>section]:mb-0">
        <GettingStartedList />
      </div>
      <HubWorkspaces />
      <CommandHub className="lg:min-h-0 lg:flex-1" />
      {ready && (
        <AlertBand g={g} ws={ws} onOpen={setSheet} onBriefing={() => setSheet("briefing")} />
      )}
      <div className="grid shrink-0 gap-2 2xl:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <Vitals ws={ws} scope={scope} onScope={setScope} />
        <RecentActivity ws={ws} onBriefing={() => setSheet("briefing")} />
      </div>

      {sheet === "briefing" ? (
        <BriefingSheet ws={ws} briefing={briefing} since={since} onClose={close} />
      ) : sheet ? (
        <AttentionSheet key={sheet} g={g} initial={sheet} onClose={close} />
      ) : null}
    </div>
  );
}

export function HomePage() {
  return <WithWorkspace>{(ws) => <HomeContent ws={ws} />}</WithWorkspace>;
}
